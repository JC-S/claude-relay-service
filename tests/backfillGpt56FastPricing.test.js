const {
  MIGRATION_VERSION,
  addDecimalStrings,
  applyCapturedFields,
  applyOperation,
  buildMigrationManifest,
  buildScaledFieldSnapshot,
  buildTimeBuckets,
  captureFields,
  classifyRequestDetail,
  runManifestOperations,
  sealManifest,
  verifyManifestChecksum
} = require('../src/cli/backfillGpt56FastPricing')
const config = require('../config/config')

const MODEL = 'gpt-5.6-sol'
const KEY_ID = 'key-1'
const REQUEST_ID = 'request-1'
const TIMESTAMP = '2026-07-14T00:15:00.000Z'
const TIMESTAMP_MS = new Date(TIMESTAMP).getTime()

function createPricingMock() {
  return {
    calculateCost: jest.fn((usage) => {
      const inputCost = (usage.input_tokens || 0) * 0.000005
      const outputCost = (usage.output_tokens || 0) * 0.00003
      const cacheCreateCost = (usage.cache_creation_input_tokens || 0) * 0.00000625
      const cacheReadCost = (usage.cache_read_input_tokens || 0) * 0.0000005
      return {
        inputCost,
        outputCost,
        cacheCreateCost,
        cacheReadCost,
        totalCost: inputCost + outputCost + cacheCreateCost + cacheReadCost
      }
    })
  }
}

function createDetail(overrides = {}) {
  const input = 0.01
  const output = 0.006
  const cacheCreate = 0.0025
  const cacheRead = 0.0002
  const total = input + output + cacheCreate + cacheRead
  const breakdown = {
    input,
    output,
    cacheCreate,
    cacheWrite: cacheCreate,
    cacheRead,
    ephemeral5m: cacheCreate,
    ephemeral1h: 0,
    total
  }
  return {
    requestId: REQUEST_ID,
    timestamp: TIMESTAMP,
    apiKeyId: KEY_ID,
    accountId: 'account-1',
    accountType: 'openai',
    model: `${MODEL} (fast)`,
    rawModel: MODEL,
    serviceTier: 'priority',
    inputTokens: 1000,
    outputTokens: 100,
    cacheCreateTokens: 200,
    cacheReadTokens: 200,
    cost: total * 1.5,
    realCost: total,
    costBreakdown: { ...breakdown },
    realCostBreakdown: { ...breakdown },
    requestBodySnapshot: { prompt: 'must never enter the manifest' },
    ...overrides
  }
}

function createMemoryClient({ detail = createDetail(), parentKeyId = null } = {}) {
  const buckets = buildTimeBuckets(TIMESTAMP_MS)
  const strings = new Map()
  const hashes = new Map()
  const lists = new Map()
  const sets = new Map()
  const pttls = new Map()
  const writes = []

  strings.set(`request_detail:item:${REQUEST_ID}`, JSON.stringify(detail))
  pttls.set(`request_detail:item:${REQUEST_ID}`, 10 * 86400000)

  const priorityStats = {
    requests: '1',
    priorityRequests: '1',
    priorityInputTokens: String(detail.inputTokens),
    priorityOutputTokens: String(detail.outputTokens),
    priorityCacheCreateTokens: String(detail.cacheCreateTokens),
    priorityCacheReadTokens: String(detail.cacheReadTokens),
    realCostMicro: String(Math.round(detail.realCost * 1000000)),
    ratedCostMicro: String(Math.round(detail.cost * 1000000))
  }
  const costOnlyStats = {
    realCostMicro: String(Math.round(detail.realCost * 1000000)),
    ratedCostMicro: String(Math.round(detail.cost * 1000000))
  }
  const hashKeys = [
    `usage:model:daily:${MODEL}:${buckets.date}`,
    `usage:model:monthly:${MODEL}:${buckets.month}`,
    `usage:model:hourly:${MODEL}:${buckets.hour}`,
    `usage:${KEY_ID}:model:daily:${MODEL}:${buckets.date}`,
    `usage:${KEY_ID}:model:monthly:${MODEL}:${buckets.month}`,
    `usage:${KEY_ID}:model:hourly:${MODEL}:${buckets.hour}`,
    `usage:${KEY_ID}:model:alltime:${MODEL}`
  ]
  hashKeys.forEach((key) => {
    hashes.set(
      key,
      key.includes(':model:daily:') || key.includes(':model:hourly:')
        ? priorityStats
        : costOnlyStats
    )
    pttls.set(key, key.includes(':alltime:') ? -1 : 30 * 86400000)
  })
  hashes.set(`apikey:${KEY_ID}`, {
    id: KEY_ID,
    rateLimitWindow: '0',
    rateLimitCost: '0',
    tokenLimit: '0',
    ...(parentKeyId ? { parentKeyId, isDeleted: 'true' } : {})
  })
  pttls.set(`apikey:${KEY_ID}`, 365 * 86400000)

  const costKeys = [
    `usage:cost:daily:${KEY_ID}:${buckets.date}`,
    `usage:cost:monthly:${KEY_ID}:${buckets.month}`,
    `usage:cost:hourly:${KEY_ID}:${buckets.hour}`,
    `usage:cost:total:${KEY_ID}`,
    `usage:cost:real:daily:${KEY_ID}:${buckets.date}`,
    `usage:cost:real:total:${KEY_ID}`
  ]
  costKeys.forEach((key) => {
    strings.set(key, String(key.includes(':real:') ? detail.realCost : detail.cost))
    pttls.set(key, key.includes(':total:') ? -1 : 30 * 86400000)
  })
  if (parentKeyId) {
    hashes.set(`apikey:${parentKeyId}`, {
      id: parentKeyId,
      isV2Parent: 'true',
      v2TotalBudget: '0'
    })
    pttls.set(`apikey:${parentKeyId}`, 365 * 86400000)
    strings.set(`usage:cost:v2:total:${parentKeyId}`, '10')
    pttls.set(`usage:cost:v2:total:${parentKeyId}`, -1)
  }

  lists.set(`usage:records:${KEY_ID}`, [JSON.stringify(detail)])
  pttls.set(`usage:records:${KEY_ID}`, 90 * 86400000)
  sets.set(`usage:keymodel:daily:index:${buckets.date}`, [`${KEY_ID}:${MODEL}`])

  function pipeline() {
    const commands = []
    const api = {
      get(key) {
        commands.push(['get', key])
        return api
      },
      hgetall(key) {
        commands.push(['hgetall', key])
        return api
      },
      lrange(key, start, end) {
        commands.push(['lrange', key, start, end])
        return api
      },
      pttl(key) {
        commands.push(['pttl', key])
        return api
      },
      async exec() {
        return commands.map(([command, key]) => {
          if (command === 'get') return [null, strings.get(key) ?? null]
          if (command === 'hgetall') return [null, { ...(hashes.get(key) || {}) }]
          if (command === 'lrange') return [null, [...(lists.get(key) || [])]]
          if (command === 'pttl') return [null, pttls.get(key) ?? -2]
          return [new Error(`Unsupported command: ${command}`), null]
        })
      }
    }
    return api
  }

  return {
    writes,
    strings,
    hashes,
    lists,
    pttls,
    pipeline,
    async scan(cursor, matchKeyword, pattern) {
      expect(matchKeyword).toBe('MATCH')
      return [
        '0',
        pattern === 'request_detail:index:day:*' ? ['request_detail:index:day:2026-07-14'] : []
      ]
    },
    async zrangebyscore() {
      return [REQUEST_ID, String(TIMESTAMP_MS)]
    },
    async mget(keys) {
      return keys.map((key) => strings.get(key) ?? null)
    },
    async smembers(key) {
      return [...(sets.get(key) || [])]
    },
    async get(key) {
      return strings.get(key) ?? null
    },
    async lindex(key, index) {
      return lists.get(key)?.[index] ?? null
    },
    async hmget(key, ...fields) {
      const hash = hashes.get(key) || {}
      return fields.map((field) => hash[field] ?? null)
    }
  }
}

function createAtomicClient() {
  const strings = new Map([
    ['persistent', '1'],
    ['expiring', 'old']
  ])
  const hashes = new Map([['hash', { present: 'old' }]])
  const lists = new Map([['list', [JSON.stringify({ cost: 1, realCost: 1, private: 'keep' })]]])

  return {
    strings,
    hashes,
    lists,
    async get(key) {
      return strings.get(key) ?? null
    },
    async lindex(key, index) {
      return lists.get(key)?.[index] ?? null
    },
    async hmget(key, ...fields) {
      const hash = hashes.get(key) || {}
      return fields.map((field) => hash[field] ?? null)
    },
    async eval(script, keyCount, key, ...args) {
      expect(keyCount).toBe(1)
      if (script.includes("redis.call('LINDEX'")) {
        const [indexRaw, oldValue, targetValue, expiresAtRaw] = args
        const index = Number(indexRaw)
        const current = lists.get(key)?.[index]
        if (current === undefined) return 'missing'
        if (current === targetValue) return 'target'
        if (current !== oldValue) return 'conflict'
        if (Number(expiresAtRaw) > 0 && Number(expiresAtRaw) <= Date.now()) return 'expired'
        lists.get(key)[index] = targetValue
        return 'applied'
      }
      if (script.includes("redis.call('HGET'")) {
        if (!hashes.has(key)) return 'missing'
        const [expiresAtRaw, countRaw, ...fieldArgs] = args
        if (Number(expiresAtRaw) > 0 && Number(expiresAtRaw) <= Date.now()) return 'expired'
        const hash = hashes.get(key)
        let allOld = true
        let allTarget = true
        const fields = []
        for (let index = 0; index < Number(countRaw); index += 1) {
          const [field, oldValue, targetValue] = fieldArgs.slice(index * 3, index * 3 + 3)
          const current = hash[field] ?? '__gpt56_fast_backfill_null__'
          allOld = allOld && current === oldValue
          allTarget = allTarget && current === targetValue
          fields.push([field, targetValue])
        }
        if (allTarget) return 'target'
        if (!allOld) return 'conflict'
        fields.forEach(([field, value]) => {
          if (value === '__gpt56_fast_backfill_null__') delete hash[field]
          else hash[field] = value
        })
        return 'applied'
      }
      const [oldValue, targetValue, expiresAtRaw] = args
      const current = strings.get(key)
      if (current === undefined) return 'missing'
      if (current === targetValue) return 'target'
      if (current !== oldValue) return 'conflict'
      if (Number(expiresAtRaw) > 0 && Number(expiresAtRaw) <= Date.now()) return 'expired'
      strings.set(key, targetValue)
      return 'applied'
    }
  }
}

describe('GPT-5.6 fast pricing backfill', () => {
  test('classifies only unmarked 2x priority records as pending', () => {
    const pricing = createPricingMock()
    expect(classifyRequestDetail(createDetail(), pricing).status).toBe('pending-2x')
    expect(classifyRequestDetail(createDetail({ serviceTier: null }), pricing).status).toBe(
      'standard'
    )
    expect(
      classifyRequestDetail(
        createDetail({ rawModel: undefined, model: `${MODEL} (fast)` }),
        pricing
      ).status
    ).toBe('pending-2x')

    const migrated = createDetail({
      realCost: createDetail().realCost * 1.25,
      cost: createDetail().cost * 1.25,
      realCostBreakdown: buildScaledFieldSnapshot(createDetail(), TIMESTAMP).values
        .realCostBreakdown,
      costBreakdown: buildScaledFieldSnapshot(createDetail(), TIMESTAMP).values.costBreakdown,
      pricingBackfillVersion: MIGRATION_VERSION
    })
    expect(classifyRequestDetail(migrated, pricing).status).toBe('migrated-2.5x')
    expect(
      classifyRequestDetail(createDetail({ realCost: createDetail().realCost * 1.1 }), pricing)
        .status
    ).toBe('unexpected')
  })

  test('scales real and rated totals independently while preserving the real-cost breakdown shape', () => {
    const record = createDetail()
    const oldFields = captureFields(record)
    const targetFields = buildScaledFieldSnapshot(record, TIMESTAMP)
    const target = applyCapturedFields(record, targetFields)

    expect(target.realCost).toBeCloseTo(record.realCost * 1.25, 6)
    expect(target.cost).toBe(0.035063)
    expect(target.realCostBreakdown.total).toBeCloseTo(record.realCost * 1.25, 10)
    expect(target.costBreakdown.total).not.toBeCloseTo(target.cost, 6)
    expect(target.pricingBackfillVersion).toBe(MIGRATION_VERSION)
    expect(applyCapturedFields(target, oldFields)).toEqual(record)
  })

  test('adds Redis decimal strings without binary floating-point drift', () => {
    expect(addDecimalStrings('237.63296375000000038', '0.00000025')).toBe('237.63296400000000038')
  })

  test('builds a read-only exact manifest for detail, record, hashes, and ledgers', async () => {
    const client = createMemoryClient()
    const manifest = await buildMigrationManifest({
      client,
      pricing: createPricingMock(),
      cutoffMs: TIMESTAMP_MS + 1000,
      nowMs: TIMESTAMP_MS + 2000
    })

    expect(manifest.report.canApply).toBe(true)
    expect(manifest.report.pendingRecords).toBe(1)
    expect(manifest.report.coverage.issueCount).toBe(0)
    expect(manifest.report.operationCounts).toEqual({
      'hash-fields': 7,
      'json-fields': 1,
      'list-json-fields': 1,
      string: 6
    })
    expect(manifest.report.realCostDelta).toBe('0.004675')
    expect(JSON.stringify(manifest)).not.toContain('must never enter the manifest')
    expect(client.writes).toEqual([])
    expect(() => verifyManifestChecksum(manifest)).not.toThrow()
  })

  test('includes soft-deleted v2 child cost in the parent absolute ledger target', async () => {
    const client = createMemoryClient({ parentKeyId: 'parent-1' })
    const manifest = await buildMigrationManifest({
      client,
      pricing: createPricingMock(),
      cutoffMs: TIMESTAMP_MS + 1000,
      nowMs: TIMESTAMP_MS + 2000
    })

    expect(manifest.report.canApply).toBe(true)
    expect(manifest.report.v2RatedCostDelta).toBe('0.0070125')
    expect(
      manifest.operations.find((operation) => operation.key === 'usage:cost:v2:total:parent-1')
    ).toMatchObject({ old: '10', target: '10.0070125' })
  })

  test('updates only an active cost-based rate-limit window with an absolute target', async () => {
    const client = createMemoryClient()
    Object.assign(client.hashes.get(`apikey:${KEY_ID}`), {
      rateLimitWindow: '60',
      rateLimitCost: '100',
      tokenLimit: '0'
    })
    client.strings.set(`rate_limit:window_start:${KEY_ID}`, String(TIMESTAMP_MS - 1000))
    client.pttls.set(`rate_limit:window_start:${KEY_ID}`, 3600000)
    client.strings.set(`rate_limit:cost:${KEY_ID}`, String(createDetail().cost))
    client.pttls.set(`rate_limit:cost:${KEY_ID}`, 3600000)

    const manifest = await buildMigrationManifest({
      client,
      pricing: createPricingMock(),
      cutoffMs: TIMESTAMP_MS + 1000,
      nowMs: TIMESTAMP_MS + 2000
    })

    expect(manifest.report.canApply).toBe(true)
    expect(
      manifest.operations.find((operation) => operation.key === `rate_limit:cost:${KEY_ID}`)
    ).toMatchObject({ old: '0.02805', target: '0.0350625' })
  })

  test('writes an absolute Responses daily usage target and quota state', async () => {
    const detail = createDetail({ accountType: 'openai-responses' })
    const client = createMemoryClient({ detail })
    client.hashes.set('openai_responses_account:account-1', {
      id: 'account-1',
      dailyUsage: '9.998',
      dailyQuota: '10',
      lastResetDate: buildTimeBuckets(TIMESTAMP_MS).date,
      status: 'active',
      quotaStoppedAt: '',
      errorMessage: ''
    })
    client.pttls.set('openai_responses_account:account-1', -1)

    const manifest = await buildMigrationManifest({
      client,
      pricing: createPricingMock(),
      cutoffMs: TIMESTAMP_MS + 1000,
      nowMs: TIMESTAMP_MS + 2000
    })
    const operation = manifest.operations.find(
      (entry) => entry.key === 'openai_responses_account:account-1'
    )

    expect(manifest.report.canApply).toBe(true)
    expect(operation.fields.dailyUsage).toEqual({ old: '9.998', target: '10.002675' })
    expect(operation.fields.status).toEqual({ old: 'active', target: 'quotaExceeded' })
  })

  test('does not recreate hourly buckets that have passed their seven-day retention', async () => {
    const client = createMemoryClient()
    const buckets = buildTimeBuckets(TIMESTAMP_MS)
    client.hashes.delete(`usage:model:hourly:${MODEL}:${buckets.hour}`)
    client.hashes.delete(`usage:${KEY_ID}:model:hourly:${MODEL}:${buckets.hour}`)
    client.strings.delete(`usage:cost:hourly:${KEY_ID}:${buckets.hour}`)

    const manifest = await buildMigrationManifest({
      client,
      pricing: createPricingMock(),
      cutoffMs: TIMESTAMP_MS + 1000,
      nowMs: TIMESTAMP_MS + 8 * 86400000
    })

    expect(manifest.report.canApply).toBe(true)
    expect(manifest.report.expectedMissing.length).toBeGreaterThanOrEqual(3)
    expect(manifest.operations.some((operation) => operation.key.includes(buckets.hour))).toBe(
      false
    )
  })

  test('reports a monotonic current-bucket mismatch as live tail only in preview mode', async () => {
    const client = createMemoryClient()
    const buckets = buildTimeBuckets(TIMESTAMP_MS)
    for (const key of [
      `usage:${KEY_ID}:model:daily:${MODEL}:${buckets.date}`,
      `usage:${KEY_ID}:model:hourly:${MODEL}:${buckets.hour}`
    ]) {
      const stats = client.hashes.get(key)
      stats.priorityRequests = '2'
      stats.priorityInputTokens = String(Number(stats.priorityInputTokens) + 10)
    }

    const preview = await buildMigrationManifest({
      client,
      pricing: createPricingMock(),
      cutoffMs: TIMESTAMP_MS + 1000,
      nowMs: TIMESTAMP_MS + 2000,
      strictCoverage: false
    })
    const strict = await buildMigrationManifest({
      client,
      pricing: createPricingMock(),
      cutoffMs: TIMESTAMP_MS + 1000,
      nowMs: TIMESTAMP_MS + 2000,
      strictCoverage: true
    })

    expect(preview.report.canApply).toBe(true)
    expect(preview.report.applyReady).toBe(false)
    expect(preview.report.coverage.liveTailCount).toBe(2)
    expect(strict.report.canApply).toBe(false)
    expect(strict.report.applyReady).toBe(false)
  })

  test('applies absolute targets idempotently and rolls them back', async () => {
    const client = createAtomicClient()
    const manifest = sealManifest({
      version: MIGRATION_VERSION,
      report: { canApply: true },
      operations: [
        {
          type: 'string',
          key: 'persistent',
          old: '1',
          target: '1.25',
          expiresAt: null
        },
        {
          type: 'hash-fields',
          key: 'hash',
          fields: {
            present: { old: 'old', target: 'new' },
            added: { old: null, target: 'value' }
          },
          expiresAt: null
        },
        {
          type: 'list-json-fields',
          key: 'list',
          index: 0,
          oldFields: captureFields({ cost: 1, realCost: 1 }),
          targetFields: captureFields({
            cost: 1.25,
            realCost: 1.25,
            pricingBackfillVersion: MIGRATION_VERSION,
            pricingBackfilledAt: TIMESTAMP
          }),
          expiresAt: Date.now() + 60000
        }
      ]
    })

    await expect(runManifestOperations(client, manifest, 'apply')).resolves.toMatchObject({
      applied: 3,
      conflicts: []
    })
    await expect(runManifestOperations(client, manifest, 'apply')).resolves.toMatchObject({
      alreadyTarget: 3,
      conflicts: []
    })
    await expect(runManifestOperations(client, manifest, 'rollback')).resolves.toMatchObject({
      applied: 3,
      conflicts: []
    })
    expect(client.strings.get('persistent')).toBe('1')
    expect(client.hashes.get('hash')).toEqual({ present: 'old' })
    expect(JSON.parse(client.lists.get('list')[0])).toEqual({
      cost: 1,
      realCost: 1,
      private: 'keep'
    })
  })

  test('never recreates an expired or missing key during apply', async () => {
    const client = createAtomicClient()
    client.strings.delete('expiring')
    await expect(
      applyOperation(client, {
        type: 'string',
        key: 'expiring',
        old: 'old',
        target: 'new',
        expiresAt: Date.now() - 1
      })
    ).resolves.toBe('missing')
    expect(client.strings.has('expiring')).toBe(false)
  })

  test('atomically enqueues changed request details when the SQLite index is enabled', async () => {
    const original = config.requestDetailIndex?.enabled
    config.requestDetailIndex ||= {}
    config.requestDetailIndex.enabled = true
    const record = createDetail()
    const client = {
      get: jest.fn().mockResolvedValue(JSON.stringify(record)),
      eval: jest.fn().mockResolvedValue('applied')
    }
    try {
      await applyOperation(client, {
        type: 'json-fields',
        key: `request_detail:item:${REQUEST_ID}`,
        oldFields: captureFields(record),
        targetFields: buildScaledFieldSnapshot(record, TIMESTAMP),
        expiresAt: Date.now() + 60000,
        metadata: { requestId: REQUEST_ID }
      })
      expect(client.eval).toHaveBeenCalledWith(
        expect.any(String),
        3,
        `request_detail:item:${REQUEST_ID}`,
        'request_detail:sqlite_index:pending_version',
        'request_detail:sqlite_index:pending_age',
        expect.any(String),
        expect.any(String),
        expect.any(String),
        REQUEST_ID,
        expect.any(String),
        expect.any(String)
      )
    } finally {
      config.requestDetailIndex.enabled = original
    }
  })
})
