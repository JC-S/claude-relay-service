const fs = require('fs')
const os = require('os')
const path = require('path')
const RequestDetailIndexWorkerClient = require('../src/services/requestDetailIndex/workerClient')

function makeRow(requestId, overrides = {}) {
  return {
    request_id: requestId,
    source_version: 'v1',
    timestamp_ms: Date.now() - 1000,
    expires_at_ms: Date.now() + 60000,
    api_key_id: 'key_1',
    account_id: 'account_1',
    account_type: 'openai',
    model: 'gpt-5.6',
    endpoint: '/v1/responses',
    method: 'POST',
    input_tokens: 10,
    output_tokens: 5,
    cache_read_tokens: 3,
    cache_create_tokens: 0,
    cost_micros: 123,
    duration_ms: 20,
    cache_hit_numerator: 3,
    cache_hit_denominator: 13,
    cache_create_not_applicable: 1,
    pricing_recompute_eligible: 0,
    search_text: `${requestId}\nkey_1\naccount_1\nopenai\ngpt-5.6\n/v1/responses\npost`,
    ...overrides
  }
}

describe('request detail SQLite Worker', () => {
  let directory
  let sqlitePath
  let client

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'request-detail-index-test-'))
    sqlitePath = path.join(directory, 'index.sqlite3')
    client = new RequestDetailIndexWorkerClient()
    await client.start({ sqlitePath, cacheMb: 16, mmapMb: 0 })
  })

  afterEach(async () => {
    await client.stop()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  test('creates compatible metadata without opening the database at module import time', async () => {
    const status = await client.call('status')
    expect(status.healthy).toBe(true)
    expect(status.meta).toMatchObject({
      schema_version: '1',
      mapper_version: '1',
      full_rebuild_status: 'empty',
      rebuild_complete: '0'
    })
  })

  test('increments mutation epoch only for existing-row query changes', async () => {
    const original = makeRow('req_1')
    await client.call('upsertBatch', { rows: [original] })
    expect((await client.call('status')).meta.mutation_epoch).toBe('0')

    await client.call('upsertBatch', {
      rows: [{ ...original, source_version: 'v2', input_tokens: 11 }]
    })
    expect((await client.call('status')).meta.mutation_epoch).toBe('1')

    await client.call('upsertBatch', {
      rows: [{ ...original, source_version: 'v3', input_tokens: 11 }]
    })
    expect((await client.call('status')).meta.mutation_epoch).toBe('1')
  })

  test('rolls back a rebuild session without changing the verified generation', async () => {
    await client.call('upsertBatch', { rows: [makeRow('old')] })
    await client.call('markVerified', { summary: { count: 1 } })
    const oldGeneration = (await client.call('status')).meta.generation

    await client.call('beginRebuild', { sessionId: 'session_1' })
    await client.call('appendRebuildBatch', {
      sessionId: 'session_1',
      batchId: 1,
      rows: [makeRow('new')]
    })
    await expect(
      client.call('appendRebuildBatch', {
        sessionId: 'wrong_session',
        batchId: 2,
        rows: []
      })
    ).rejects.toThrow('Stale or invalid rebuild session')
    await client.call('rollbackRebuild', { sessionId: 'session_1' })

    const phaseA = await client.call('phaseA', {
      startMs: 0,
      endMs: Date.now(),
      snapshotCreatedAt: Date.now(),
      sortOrder: 'desc',
      hasKeyword: false
    })
    expect(phaseA.source.count).toBe(1)
    expect((await client.call('status')).meta.generation).toBe(oldGeneration)
  })

  test('opens an incompatible schema for a transactional destructive rebuild', async () => {
    await client.stop()
    const Database = require('better-sqlite3')
    const database = new Database(sqlitePath)
    database.exec(`
      DROP TABLE request_detail_records;
      CREATE TABLE request_detail_records(request_id TEXT PRIMARY KEY);
    `)
    database.close()

    client = new RequestDetailIndexWorkerClient()
    const status = await client.start({ sqlitePath, cacheMb: 16, mmapMb: 0 })
    expect(status.healthy).toBe(true)
    expect(status.schemaValid).toBe(false)

    await client.call('beginRebuild', { sessionId: 'schema_upgrade', destructive: true })
    await client.call('appendRebuildBatch', {
      sessionId: 'schema_upgrade',
      batchId: 1,
      rows: [makeRow('upgraded')]
    })
    await client.call('commitRebuild', {
      sessionId: 'schema_upgrade',
      generation: 'upgraded_generation',
      buildSummary: { validItems: 1 }
    })
    const upgraded = await client.call('status')
    expect(upgraded.schemaValid).toBe(true)
    expect(upgraded.meta.generation).toBe('upgraded_generation')
  })

  test('atomically rejects a stale page after an existing row mutates', async () => {
    await client.call('upsertBatch', { rows: [makeRow('req_1')] })
    await client.call('markVerified', { summary: { count: 1 } })
    const phaseA = await client.call('phaseA', {
      startMs: 0,
      endMs: Date.now(),
      snapshotCreatedAt: Date.now(),
      sortOrder: 'desc',
      hasKeyword: false
    })
    await client.call('upsertBatch', {
      rows: [makeRow('req_1', { source_version: 'v2', output_tokens: 99 })]
    })

    const page = await client.call('page', {
      generation: phaseA.meta.generation,
      mutationEpoch: Number(phaseA.meta.mutation_epoch),
      expiresAt: Date.now() + 60000,
      startMs: 0,
      endMs: Date.now(),
      snapshotCreatedAt: phaseA.snapshotCreatedAt,
      snapshotSequence: phaseA.snapshotSequence,
      filters: {},
      dynamicKeyIds: [],
      dynamicAccounts: [],
      totalRecords: 1,
      page: 1,
      pageSize: 50,
      sortOrder: 'desc'
    })
    expect(page.stale).toBe(true)
  })

  test('returns exact aggregate and plain substring keyword matches', async () => {
    await client.call('upsertBatch', {
      rows: [makeRow('req_%_1'), makeRow('req_2', { model: 'gpt-5.6-luna' })]
    })
    const phaseA = await client.call('phaseA', {
      startMs: 0,
      endMs: Date.now(),
      snapshotCreatedAt: Date.now(),
      sortOrder: 'desc',
      hasKeyword: true
    })
    const phaseB = await client.call('phaseB', {
      startMs: 0,
      endMs: Date.now(),
      snapshotCreatedAt: phaseA.snapshotCreatedAt,
      snapshotSequence: phaseA.snapshotSequence,
      filters: { keyword: '%_1' },
      dynamicKeyIds: [],
      dynamicAccounts: [],
      page: 999,
      pageSize: 50,
      sortOrder: 'desc',
      recomputeLimit: 256
    })
    expect(phaseB.totalRecords).toBe(1)
    expect(phaseB.currentPage).toBe(1)
    expect(phaseB.aggregate.input_tokens).toBe(10)
    expect(phaseB.aggregate.cost_micros).toBe(123)
  })
})
