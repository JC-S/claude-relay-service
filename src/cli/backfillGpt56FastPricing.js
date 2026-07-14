#!/usr/bin/env node

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { promisify } = require('util')
const { Command } = require('commander')

const config = require('../../config/config')
const redis = require('../models/redis')
const pricingService = require('../services/pricingService')
const logger = require('../utils/logger')
const { normalizeBaseModelName } = require('../utils/modelVariantHelper')

const gzip = promisify(zlib.gzip)
const gunzip = promisify(zlib.gunzip)

const MIGRATION_VERSION = 'gpt56-fast-2.5x-v1'
const MIGRATION_LOCK_KEY = `migration:lock:${MIGRATION_VERSION}`
const MIGRATION_STATE_KEY = `migration:${MIGRATION_VERSION}`
const TARGET_MODELS = new Set(['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])
const OLD_PRIORITY_MULTIPLIER = 2
const NEW_PRIORITY_MULTIPLIER = 2.5
const COST_SCALE_FACTOR = NEW_PRIORITY_MULTIPLIER / OLD_PRIORITY_MULTIPLIER
const DECIMAL_SCALE = 18
const DETAIL_FIELDS = [
  'cost',
  'realCost',
  'costBreakdown',
  'realCostBreakdown',
  'pricingBackfillVersion',
  'pricingBackfilledAt'
]
const BREAKDOWN_TOTAL_TOLERANCE = 0.0000015
const LOCK_TTL_SECONDS = 60 * 60
const BATCH_SIZE = 200
const NULL_SENTINEL = '__gpt56_fast_backfill_null__'
const DEFAULT_MIGRATION_DIR = path.join(process.cwd(), 'data', 'migrations')

function toFiniteNumber(value, fallback = null) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function toNonNegativeInteger(value) {
  const number = toFiniteNumber(value, 0)
  return Math.max(0, Math.trunc(number))
}

function toMicro(value) {
  return BigInt(Math.round(Number(value) * 1000000))
}

function scaleMicroForNewMultiplier(oldMicro) {
  const numerator = BigInt(oldMicro) * 5n
  return (numerator + 2n) / 4n
}

function scaleCostToSixDecimals(value) {
  return Number(scaleMicroForNewMultiplier(toMicro(value))) / 1000000
}

function round12(value) {
  return Number(Number(value).toFixed(12))
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  }

  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`
  }

  return JSON.stringify(value)
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function deepEqual(left, right) {
  return stableStringify(left) === stableStringify(right)
}

function parseIsoTimestamp(value, label) {
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid ${label}: ${value}`)
  }
  return timestamp
}

function getTimeBuckets(timestampMs) {
  const timezoneOffset = config.system?.timezoneOffset || 8
  const adjusted = new Date(timestampMs + timezoneOffset * 60 * 60 * 1000)
  const year = adjusted.getUTCFullYear()
  const month = String(adjusted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(adjusted.getUTCDate()).padStart(2, '0')
  const hour = String(adjusted.getUTCHours()).padStart(2, '0')
  const date = `${year}-${month}-${day}`

  return {
    date,
    month: `${year}-${month}`,
    hour: `${date}:${hour}`
  }
}

function getBucketEndMs(hourBucket) {
  const timezoneOffset = config.system?.timezoneOffset || 8
  const match = /^(\d{4})-(\d{2})-(\d{2}):(\d{2})$/.exec(hourBucket)
  if (!match) {
    return null
  }

  const [, year, month, day, hour] = match
  return (
    Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) + 1) -
    timezoneOffset * 60 * 60 * 1000
  )
}

function scaleBreakdown(value) {
  if (Array.isArray(value)) {
    return value.map((item) => scaleBreakdown(item))
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, scaleBreakdown(item)])
    )
  }

  return typeof value === 'number' && Number.isFinite(value)
    ? round12(value * COST_SCALE_FACTOR)
    : value
}

function captureFields(record, fields = DETAIL_FIELDS) {
  const values = {}
  const present = {}

  for (const field of fields) {
    const hasField = Object.prototype.hasOwnProperty.call(record, field)
    present[field] = hasField
    if (hasField) {
      values[field] = record[field]
    }
  }

  return { values, present }
}

function applyCapturedFields(record, snapshot) {
  const output = { ...record }
  for (const field of Object.keys(snapshot.present || {})) {
    if (snapshot.present[field]) {
      output[field] = snapshot.values[field]
    } else {
      delete output[field]
    }
  }
  return output
}

function buildScaledFieldSnapshot(record, backfilledAt) {
  const target = {
    ...captureFields(record)
  }

  target.present.cost = true
  target.present.realCost = true
  target.present.pricingBackfillVersion = true
  target.present.pricingBackfilledAt = true
  target.values.cost = scaleCostToSixDecimals(record.cost)
  target.values.realCost = scaleCostToSixDecimals(record.realCost)
  target.values.pricingBackfillVersion = MIGRATION_VERSION
  target.values.pricingBackfilledAt = backfilledAt

  for (const field of ['costBreakdown', 'realCostBreakdown']) {
    if (target.present[field]) {
      target.values[field] = scaleBreakdown(record[field])
    }
  }

  return target
}

function buildUsage(record) {
  return {
    input_tokens: toNonNegativeInteger(record.inputTokens),
    output_tokens: toNonNegativeInteger(record.outputTokens),
    cache_creation_input_tokens: toNonNegativeInteger(record.cacheCreateTokens),
    cache_read_input_tokens: toNonNegativeInteger(record.cacheReadTokens)
  }
}

function isCloseToExpected(actual, expected) {
  const tolerance = Math.max(BREAKDOWN_TOTAL_TOLERANCE, Math.abs(expected) * 0.0001)
  return Math.abs(actual - expected) <= tolerance
}

function inferStoredMultiplier(record, model, pricing) {
  const usage = buildUsage(record)
  const standard = pricing.calculateCost(usage, model)
  const standardTotal = toFiniteNumber(standard?.totalCost, 0)
  const storedBreakdownTotal = toFiniteNumber(record.realCostBreakdown?.total)
  const storedRealCost = toFiniteNumber(record.realCost)
  const storedTotal =
    storedBreakdownTotal !== null && storedBreakdownTotal > 0
      ? storedBreakdownTotal
      : storedRealCost

  if (standardTotal > 0 && storedTotal !== null) {
    return {
      multiplier: storedTotal / standardTotal,
      standardTotal,
      storedTotal,
      source: storedBreakdownTotal !== null ? 'breakdown' : 'realCost'
    }
  }

  if (standardTotal === 0 && storedTotal === 0) {
    return { multiplier: OLD_PRIORITY_MULTIPLIER, standardTotal, storedTotal, source: 'zero-cost' }
  }

  return { multiplier: null, standardTotal, storedTotal, source: 'unavailable' }
}

function validateRecordCosts(record) {
  const issues = []
  const realCost = toFiniteNumber(record.realCost)
  const ratedCost = toFiniteNumber(record.cost)
  const totalTokens = Object.values(buildUsage(record)).reduce((sum, value) => sum + value, 0)
  const breakdownTotal = toFiniteNumber(record.realCostBreakdown?.total)

  if (realCost === null || realCost < 0) {
    issues.push('realCost must be a finite non-negative number')
  }
  if (ratedCost === null || ratedCost < 0) {
    issues.push('cost must be a finite non-negative number')
  }
  if (realCost > 0 && totalTokens === 0) {
    issues.push('positive realCost with zero billable tokens')
  }
  if (
    realCost !== null &&
    breakdownTotal !== null &&
    !isCloseToExpected(breakdownTotal, realCost)
  ) {
    issues.push('realCostBreakdown.total does not match realCost')
  }
  if (
    record.costBreakdown &&
    record.realCostBreakdown &&
    !deepEqual(record.costBreakdown, record.realCostBreakdown)
  ) {
    issues.push('costBreakdown and realCostBreakdown no longer share the stored real-cost shape')
  }

  return issues
}

function classifyRequestDetail(record, pricing = pricingService) {
  const model = normalizeBaseModelName(record.rawModel || record.model || 'unknown')
  if (!TARGET_MODELS.has(model)) {
    return { status: 'not-target', model }
  }

  if (
    record.serviceTier === null ||
    record.serviceTier === undefined ||
    record.serviceTier === ''
  ) {
    return { status: 'standard', model }
  }
  if (typeof record.serviceTier !== 'string') {
    return { status: 'unexpected', model, reason: 'serviceTier is not a string or null' }
  }
  if (record.serviceTier.toLowerCase() !== 'priority') {
    return { status: 'other-tier', model, serviceTier: record.serviceTier }
  }

  const validationIssues = validateRecordCosts(record)
  if (validationIssues.length > 0) {
    return { status: 'unexpected', model, reason: validationIssues.join('; ') }
  }

  const multiplier = inferStoredMultiplier(record, model, pricing)
  if (record.pricingBackfillVersion === MIGRATION_VERSION) {
    if (
      multiplier.multiplier !== null &&
      Math.abs(multiplier.multiplier - NEW_PRIORITY_MULTIPLIER) <= 0.02
    ) {
      return { status: 'migrated-2.5x', model, multiplier }
    }
    return {
      status: 'unexpected',
      model,
      reason: `migration marker exists but implied multiplier is ${multiplier.multiplier}`
    }
  }

  if (record.pricingBackfillVersion) {
    return {
      status: 'unexpected',
      model,
      reason: `unknown pricingBackfillVersion: ${record.pricingBackfillVersion}`
    }
  }

  if (
    multiplier.multiplier !== null &&
    Math.abs(multiplier.multiplier - OLD_PRIORITY_MULTIPLIER) <= 0.02
  ) {
    return { status: 'pending-2x', model, multiplier }
  }

  return {
    status: 'unexpected',
    model,
    reason: `unmarked priority record has implied multiplier ${multiplier.multiplier}`
  }
}

function decimalToScaled(value, scale = DECIMAL_SCALE) {
  const source = String(value ?? '0').trim()
  const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(source)
  if (!match) {
    throw new Error(`Invalid decimal value: ${value}`)
  }

  const sign = match[1] === '-' ? -1n : 1n
  const integer = match[2]
  const fraction = match[3] || ''
  const exponent = Number(match[4] || 0)
  const digits = `${integer}${fraction}`.replace(/^0+(?=\d)/, '')
  const decimalPlaces = fraction.length - exponent
  const shift = scale - decimalPlaces

  if (shift >= 0) {
    return sign * BigInt(digits || '0') * 10n ** BigInt(shift)
  }

  const divisor = 10n ** BigInt(-shift)
  const raw = BigInt(digits || '0')
  const quotient = raw / divisor
  const remainder = raw % divisor
  const rounded = remainder * 2n >= divisor ? quotient + 1n : quotient
  return sign * rounded
}

function scaledToDecimal(value, scale = DECIMAL_SCALE) {
  const scaled = BigInt(value)
  const negative = scaled < 0n
  const absolute = negative ? -scaled : scaled
  const digits = absolute.toString().padStart(scale + 1, '0')
  const integer = digits.slice(0, -scale) || '0'
  const fraction = digits.slice(-scale).replace(/0+$/, '')
  return `${negative ? '-' : ''}${integer}${fraction ? `.${fraction}` : ''}`
}

function addDecimalStrings(left, right) {
  return scaledToDecimal(decimalToScaled(left) + decimalToScaled(right))
}

function costDeltaScaled(oldCost) {
  const oldMicro = toMicro(oldCost)
  return oldMicro * 250000000000n
}

function addScaledDelta(map, key, deltaScaled, metadata = {}) {
  const current = map.get(key) || { deltaScaled: 0n, ...metadata }
  current.deltaScaled += BigInt(deltaScaled)
  map.set(key, current)
}

function addHashDelta(map, key, realDeltaMicro, ratedDeltaMicro, metadata = {}) {
  const current = map.get(key) || { realDeltaMicro: 0n, ratedDeltaMicro: 0n, ...metadata }
  current.realDeltaMicro += BigInt(realDeltaMicro)
  current.ratedDeltaMicro += BigInt(ratedDeltaMicro)
  map.set(key, current)
}

async function scanKeys(client, pattern) {
  const keys = []
  let cursor = '0'
  do {
    const result = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 500)
    cursor = String(result?.[0] || '0')
    keys.push(...(result?.[1] || []))
  } while (cursor !== '0')
  return keys
}

async function loadRequestDetails(client, cutoffMs) {
  const indexKeys = (await scanKeys(client, 'request_detail:index:day:*')).sort()
  const pointers = new Map()

  for (const indexKey of indexKeys) {
    const values = await client.zrangebyscore(indexKey, '-inf', cutoffMs, 'WITHSCORES')
    for (let index = 0; index < values.length; index += 2) {
      const requestId = values[index]
      const timestampMs = Number(values[index + 1])
      if (requestId && Number.isFinite(timestampMs) && timestampMs <= cutoffMs) {
        pointers.set(requestId, timestampMs)
      }
    }
  }

  const details = []
  const missingPointers = []
  const entries = [...pointers.entries()]
  for (let index = 0; index < entries.length; index += BATCH_SIZE) {
    const batch = entries.slice(index, index + BATCH_SIZE)
    const keys = batch.map(([requestId]) => `request_detail:item:${requestId}`)
    const values = await client.mget(keys)
    values.forEach((value, itemIndex) => {
      const [requestId, indexTimestampMs] = batch[itemIndex]
      if (!value) {
        missingPointers.push({ requestId, indexTimestampMs })
        return
      }

      try {
        const record = JSON.parse(value)
        details.push({ requestId, indexTimestampMs, key: keys[itemIndex], record })
      } catch (error) {
        missingPointers.push({
          requestId,
          indexTimestampMs,
          reason: `invalid JSON: ${error.message}`
        })
      }
    })
  }

  return { details, missingPointers, scannedIndexes: indexKeys.length, pointers: pointers.size }
}

function resolveRecordTimestamp(record, indexTimestampMs) {
  const timestamp = new Date(record.timestamp).getTime()
  return Number.isFinite(timestamp) ? timestamp : indexTimestampMs
}

function buildCoverageKey(keyId, model, bucket) {
  return `${keyId}\u0000${model}\u0000${bucket}`
}

function accumulateCoverage(map, keyId, model, bucket, record) {
  const key = buildCoverageKey(keyId, model, bucket)
  const current = map.get(key) || {
    keyId,
    model,
    bucket,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreateTokens: 0,
    cacheReadTokens: 0
  }
  current.requests += 1
  current.inputTokens += toNonNegativeInteger(record.inputTokens)
  current.outputTokens += toNonNegativeInteger(record.outputTokens)
  current.cacheCreateTokens += toNonNegativeInteger(record.cacheCreateTokens)
  current.cacheReadTokens += toNonNegativeInteger(record.cacheReadTokens)
  map.set(key, current)
}

function sanitizeIssue(issue) {
  if (!issue || typeof issue !== 'object') {
    return issue
  }
  const output = { ...issue }
  delete output.requestBodySnapshot
  delete output.requestBody
  delete output.apiKey
  delete output.token
  return output
}

async function loadHashStates(client, keys) {
  const states = new Map()
  for (let offset = 0; offset < keys.length; offset += BATCH_SIZE) {
    const batch = keys.slice(offset, offset + BATCH_SIZE)
    const pipeline = client.pipeline()
    for (const key of batch) {
      pipeline.hgetall(key)
      pipeline.pttl(key)
    }
    const results = await pipeline.exec()
    const observedAt = Date.now()
    batch.forEach((key, index) => {
      const pttl = Number(results[index * 2 + 1]?.[1] ?? -2)
      states.set(key, {
        value: results[index * 2]?.[1] || {},
        pttl,
        expiresAt: pttl > 0 ? observedAt + pttl : null
      })
    })
  }
  return states
}

async function loadStringStates(client, keys) {
  const states = new Map()
  for (let offset = 0; offset < keys.length; offset += BATCH_SIZE) {
    const batch = keys.slice(offset, offset + BATCH_SIZE)
    const pipeline = client.pipeline()
    for (const key of batch) {
      pipeline.get(key)
      pipeline.pttl(key)
    }
    const results = await pipeline.exec()
    const observedAt = Date.now()
    batch.forEach((key, index) => {
      const pttl = Number(results[index * 2 + 1]?.[1] ?? -2)
      states.set(key, {
        value: results[index * 2]?.[1] ?? null,
        pttl,
        expiresAt: pttl > 0 ? observedAt + pttl : null
      })
    })
  }
  return states
}

async function loadApiKeyData(client, keyIds) {
  const states = await loadHashStates(
    client,
    keyIds.map((keyId) => `apikey:${keyId}`)
  )
  return new Map(
    keyIds.map((keyId) => {
      const state = states.get(`apikey:${keyId}`)
      return [keyId, state?.value || {}]
    })
  )
}

function compareCoverageStats(expected, actual) {
  const fieldPairs = [
    ['requests', 'priorityRequests'],
    ['inputTokens', 'priorityInputTokens'],
    ['outputTokens', 'priorityOutputTokens'],
    ['cacheCreateTokens', 'priorityCacheCreateTokens'],
    ['cacheReadTokens', 'priorityCacheReadTokens']
  ]
  const mismatches = []
  for (const [expectedField, actualField] of fieldPairs) {
    const expectedValue = toNonNegativeInteger(expected[expectedField])
    const actualValue = toNonNegativeInteger(actual[actualField])
    if (expectedValue !== actualValue) {
      mismatches.push({ field: actualField, expected: expectedValue, actual: actualValue })
    }
  }
  return mismatches
}

async function verifyCoverage(
  client,
  dailyCoverage,
  hourlyCoverage,
  nowMs,
  cutoffMs,
  strictCoverage
) {
  const issues = []
  const expectedMissing = []
  const liveTail = []
  const cutoffBuckets = getTimeBuckets(cutoffMs)
  const dailyEntries = [...dailyCoverage.values()]
  const hourlyEntries = [...hourlyCoverage.values()]
  const dailyKeys = dailyEntries.map(
    (entry) => `usage:${entry.keyId}:model:daily:${entry.model}:${entry.bucket}`
  )
  const hourlyKeys = hourlyEntries.map(
    (entry) => `usage:${entry.keyId}:model:hourly:${entry.model}:${entry.bucket}`
  )
  const states = await loadHashStates(client, [...dailyKeys, ...hourlyKeys])

  dailyEntries.forEach((entry, index) => {
    const key = dailyKeys[index]
    const state = states.get(key)
    if (!state || Object.keys(state.value).length === 0) {
      issues.push({ type: 'coverage-missing-daily-hash', key })
      return
    }
    const mismatches = compareCoverageStats(entry, state.value)
    if (mismatches.length > 0) {
      const canBeLiveTail =
        !strictCoverage &&
        entry.bucket === cutoffBuckets.date &&
        mismatches.every((mismatch) => mismatch.actual >= mismatch.expected)
      const issueTarget = canBeLiveTail ? liveTail : issues
      issueTarget.push({
        type: canBeLiveTail ? 'coverage-daily-live-tail' : 'coverage-daily-mismatch',
        key,
        mismatches
      })
    }
  })

  hourlyEntries.forEach((entry, index) => {
    const key = hourlyKeys[index]
    const state = states.get(key)
    if (!state || Object.keys(state.value).length === 0) {
      const bucketEnd = getBucketEndMs(entry.bucket)
      if (bucketEnd !== null && bucketEnd + 7 * 86400000 <= nowMs) {
        expectedMissing.push({ type: 'expired-hourly-coverage-hash', key })
      } else {
        issues.push({ type: 'coverage-missing-hourly-hash', key })
      }
      return
    }
    const mismatches = compareCoverageStats(entry, state.value)
    if (mismatches.length > 0) {
      const canBeLiveTail =
        !strictCoverage &&
        entry.bucket === cutoffBuckets.hour &&
        mismatches.every((mismatch) => mismatch.actual >= mismatch.expected)
      const issueTarget = canBeLiveTail ? liveTail : issues
      issueTarget.push({
        type: canBeLiveTail ? 'coverage-hourly-live-tail' : 'coverage-hourly-mismatch',
        key,
        mismatches
      })
    }
  })

  const dates = [...new Set(dailyEntries.map((entry) => entry.bucket))]
  for (const date of dates) {
    const members = await client.smembers(`usage:keymodel:daily:index:${date}`)
    const relevant = []
    for (const member of members || []) {
      for (const model of TARGET_MODELS) {
        const suffix = `:${model}`
        if (member.endsWith(suffix)) {
          relevant.push({ keyId: member.slice(0, -suffix.length), model })
          break
        }
      }
    }

    const indexStates = await loadHashStates(
      client,
      relevant.map(({ keyId, model }) => `usage:${keyId}:model:daily:${model}:${date}`)
    )
    for (const { keyId, model } of relevant) {
      const key = `usage:${keyId}:model:daily:${model}:${date}`
      const priorityRequests = toNonNegativeInteger(indexStates.get(key)?.value?.priorityRequests)
      if (priorityRequests <= 0) {
        continue
      }
      const coverageKey = buildCoverageKey(keyId, model, date)
      if (!dailyCoverage.has(coverageKey)) {
        const canBeLiveTail = !strictCoverage && date === cutoffBuckets.date
        const issueTarget = canBeLiveTail ? liveTail : issues
        issueTarget.push({
          type: canBeLiveTail
            ? 'coverage-index-live-tail'
            : 'coverage-index-found-unenumerated-priority-usage',
          key,
          priorityRequests
        })
      }
    }
  }

  return {
    issues,
    expectedMissing,
    liveTail,
    dailyBuckets: dailyEntries.length,
    hourlyBuckets: hourlyEntries.length
  }
}

function makeHashKeys(keyId, model, buckets) {
  return [
    {
      key: `usage:model:daily:${model}:${buckets.date}`,
      kind: 'model-daily'
    },
    {
      key: `usage:model:monthly:${model}:${buckets.month}`,
      kind: 'model-monthly'
    },
    {
      key: `usage:model:hourly:${model}:${buckets.hour}`,
      kind: 'model-hourly',
      hourBucket: buckets.hour
    },
    {
      key: `usage:${keyId}:model:daily:${model}:${buckets.date}`,
      kind: 'key-model-daily'
    },
    {
      key: `usage:${keyId}:model:monthly:${model}:${buckets.month}`,
      kind: 'key-model-monthly'
    },
    {
      key: `usage:${keyId}:model:hourly:${model}:${buckets.hour}`,
      kind: 'key-model-hourly',
      hourBucket: buckets.hour
    },
    {
      key: `usage:${keyId}:model:alltime:${model}`,
      kind: 'key-model-alltime'
    }
  ]
}

function makeCostKeys(keyId, buckets) {
  return [
    {
      key: `usage:cost:daily:${keyId}:${buckets.date}`,
      kind: 'cost-daily',
      costType: 'rated',
      keyId,
      date: buckets.date
    },
    {
      key: `usage:cost:monthly:${keyId}:${buckets.month}`,
      kind: 'cost-monthly',
      costType: 'rated',
      keyId
    },
    {
      key: `usage:cost:hourly:${keyId}:${buckets.hour}`,
      kind: 'cost-hourly',
      costType: 'rated',
      keyId,
      hourBucket: buckets.hour
    },
    {
      key: `usage:cost:total:${keyId}`,
      kind: 'cost-total',
      costType: 'rated',
      keyId
    },
    {
      key: `usage:cost:real:daily:${keyId}:${buckets.date}`,
      kind: 'cost-real-daily',
      costType: 'real',
      keyId
    },
    {
      key: `usage:cost:real:total:${keyId}`,
      kind: 'cost-real-total',
      costType: 'real',
      keyId
    }
  ]
}

function isExpectedExpiredHourly(metadata, nowMs) {
  if (!metadata?.hourBucket) {
    return false
  }
  const bucketEnd = getBucketEndMs(metadata.hourBucket)
  return bucketEnd !== null && bucketEnd + 7 * 86400000 <= nowMs
}

async function buildHashOperations(client, deltaMap, nowMs, report) {
  const keys = [...deltaMap.keys()]
  const states = await loadHashStates(client, keys)
  const operations = []

  for (const key of keys) {
    const delta = deltaMap.get(key)
    const state = states.get(key)
    const missing = !state || Object.keys(state.value).length === 0
    if (missing) {
      if (isExpectedExpiredHourly(delta, nowMs)) {
        report.expectedMissing.push({ type: 'expired-hourly-cost-hash', key })
      } else {
        report.blockingIssues.push({ type: 'missing-cost-hash', key })
      }
      continue
    }

    const oldReal = state.value.realCostMicro ?? null
    const oldRated = state.value.ratedCostMicro ?? null
    const targetReal = (BigInt(oldReal === null ? 0 : oldReal) + delta.realDeltaMicro).toString()
    const targetRated = (
      BigInt(oldRated === null ? 0 : oldRated) + delta.ratedDeltaMicro
    ).toString()
    operations.push({
      type: 'hash-fields',
      key,
      fields: {
        realCostMicro: { old: oldReal, target: targetReal },
        ratedCostMicro: { old: oldRated, target: targetRated }
      },
      expiresAt: state.expiresAt,
      metadata: { kind: delta.kind }
    })
  }

  return operations
}

async function buildStringOperations(client, deltaMap, nowMs, report) {
  const keys = [...deltaMap.keys()]
  const states = await loadStringStates(client, keys)
  const operations = []

  for (const key of keys) {
    const delta = deltaMap.get(key)
    const state = states.get(key)
    if (!state || state.value === null) {
      if (
        isExpectedExpiredHourly(delta, nowMs) ||
        (delta.kind === 'active-rate-limit-cost' && delta.windowExpiresAt <= nowMs)
      ) {
        report.expectedMissing.push({
          type:
            delta.kind === 'active-rate-limit-cost'
              ? 'expired-rate-limit-cost-key'
              : 'expired-hourly-cost-key',
          key
        })
      } else {
        report.blockingIssues.push({ type: 'missing-cost-key', key })
      }
      continue
    }

    const deltaString = scaledToDecimal(delta.deltaScaled)
    const redisExpiresAt = state.expiresAt
    const expiresAt =
      redisExpiresAt && delta.windowExpiresAt
        ? Math.min(redisExpiresAt, delta.windowExpiresAt)
        : redisExpiresAt
    const metadata = Object.fromEntries(
      Object.entries(delta).filter(
        ([field, value]) => field !== 'deltaScaled' && typeof value !== 'bigint'
      )
    )
    operations.push({
      type: 'string',
      key,
      old: state.value,
      target: addDecimalStrings(state.value, deltaString),
      delta: deltaString,
      expiresAt,
      metadata
    })
  }

  return operations
}

async function buildUsageRecordOperations(client, pendingRecords, backfilledAt, report) {
  const operations = []
  const byKey = new Map()
  for (const pending of pendingRecords) {
    const records = byKey.get(pending.keyId) || []
    records.push(pending)
    byKey.set(pending.keyId, records)
  }

  for (const [keyId, records] of byKey) {
    const key = `usage:records:${keyId}`
    const pipeline = client.pipeline()
    pipeline.lrange(key, 0, -1)
    pipeline.pttl(key)
    const result = await pipeline.exec()
    const list = result[0]?.[1] || []
    const pttl = Number(result[1]?.[1] ?? -2)
    const expiresAt = pttl > 0 ? Date.now() + pttl : null
    const byRequestId = new Map(records.map((record) => [record.requestId, record]))
    const matched = new Set()

    list.forEach((raw, index) => {
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch (error) {
        report.warnings.push({ type: 'invalid-usage-record-json', key, index })
        return
      }

      const pending = byRequestId.get(parsed.requestId)
      if (!pending) {
        return
      }
      matched.add(parsed.requestId)

      if (
        !isCloseToExpected(Number(parsed.realCost), Number(pending.record.realCost)) ||
        !isCloseToExpected(Number(parsed.cost), Number(pending.record.cost))
      ) {
        report.blockingIssues.push({
          type: 'usage-record-cost-mismatch',
          key,
          index,
          requestId: parsed.requestId
        })
        return
      }

      if (parsed.pricingBackfillVersion) {
        report.blockingIssues.push({
          type: 'usage-record-already-marked-while-detail-pending',
          key,
          index,
          requestId: parsed.requestId
        })
        return
      }

      const target = applyCapturedFields(parsed, buildScaledFieldSnapshot(parsed, backfilledAt))
      operations.push({
        type: 'list-json-fields',
        key,
        index,
        oldFields: captureFields(parsed),
        targetFields: captureFields(target),
        expiresAt,
        metadata: { keyId, requestId: parsed.requestId }
      })
    })

    for (const pending of records) {
      if (!matched.has(pending.requestId)) {
        report.missingUsageRecords.push({ keyId, requestId: pending.requestId })
      }
    }
  }

  return operations
}

async function buildResponsesQuotaOperations(client, pendingRecords, backfilledAt, report) {
  const deltas = new Map()
  for (const pending of pendingRecords) {
    if (pending.record.accountType !== 'openai-responses' || !pending.record.accountId) {
      continue
    }
    const buckets = getTimeBuckets(pending.timestampMs)
    const key = `${pending.record.accountId}\u0000${buckets.date}`
    const current = deltas.get(key) || {
      accountId: pending.record.accountId,
      date: buckets.date,
      deltaScaled: 0n
    }
    current.deltaScaled += costDeltaScaled(pending.record.realCost)
    deltas.set(key, current)
  }

  const accountIds = [...new Set([...deltas.values()].map((entry) => entry.accountId))]
  const states = await loadHashStates(
    client,
    accountIds.map((accountId) => `openai_responses_account:${accountId}`)
  )
  const operations = []

  for (const delta of deltas.values()) {
    const key = `openai_responses_account:${delta.accountId}`
    const state = states.get(key)
    if (!state || !state.value.id) {
      report.blockingIssues.push({
        type: 'missing-openai-responses-account',
        accountId: delta.accountId
      })
      continue
    }
    if (state.value.lastResetDate !== delta.date) {
      report.warnings.push({
        type: 'responses-quota-outside-current-reset-date',
        accountId: delta.accountId,
        requestDate: delta.date,
        lastResetDate: state.value.lastResetDate
      })
      continue
    }

    const deltaString = scaledToDecimal(delta.deltaScaled)
    const targetUsage = addDecimalStrings(state.value.dailyUsage || '0', deltaString)
    const fields = {
      dailyUsage: { old: state.value.dailyUsage ?? null, target: targetUsage }
    }
    const dailyQuota = toFiniteNumber(state.value.dailyQuota, 0)
    if (dailyQuota > 0 && Number(targetUsage) >= dailyQuota) {
      fields.status = { old: state.value.status ?? null, target: 'quotaExceeded' }
      fields.quotaStoppedAt = {
        old: state.value.quotaStoppedAt ?? null,
        target: backfilledAt
      }
      fields.errorMessage = {
        old: state.value.errorMessage ?? null,
        target: `Daily quota exceeded: $${Number(targetUsage).toFixed(2)} / $${dailyQuota.toFixed(2)}`
      }
    }

    operations.push({
      type: 'hash-fields',
      key,
      fields,
      expiresAt: state.expiresAt,
      metadata: { kind: 'openai-responses-daily-quota', accountId: delta.accountId }
    })
  }

  return operations
}

function buildManifestChecksum(manifest) {
  const payload = { ...manifest }
  delete payload.sha256
  return sha256(stableStringify(payload))
}

function sealManifest(manifest) {
  return { ...manifest, sha256: buildManifestChecksum(manifest) }
}

function verifyManifestChecksum(manifest) {
  if (!manifest?.sha256 || buildManifestChecksum(manifest) !== manifest.sha256) {
    throw new Error('Manifest SHA-256 verification failed')
  }
}

function sortOperations(operations) {
  return operations.sort((left, right) => {
    const typeOrder = left.type.localeCompare(right.type)
    if (typeOrder !== 0) {
      return typeOrder
    }
    const keyOrder = left.key.localeCompare(right.key)
    if (keyOrder !== 0) {
      return keyOrder
    }
    return Number(left.index || 0) - Number(right.index || 0)
  })
}

async function buildMigrationManifest({
  client,
  pricing = pricingService,
  cutoffMs,
  nowMs = Date.now(),
  allowAggregateFallback = false,
  strictCoverage = true
}) {
  const backfilledAt = new Date(nowMs).toISOString()
  const report = {
    migrationVersion: MIGRATION_VERSION,
    dryRun: true,
    cutoff: new Date(cutoffMs).toISOString(),
    generatedAt: backfilledAt,
    classifications: {
      'pending-2x': 0,
      'migrated-2.5x': 0,
      standard: 0,
      'other-tier': 0,
      unexpected: 0
    },
    blockingIssues: [],
    warnings: [],
    expectedMissing: [],
    missingUsageRecords: [],
    missingRequestDetailPointers: [],
    coverage: null,
    accountTypes: {},
    modelCounts: {},
    totalOldRealCost: '0',
    totalOldRatedCost: '0',
    realCostDelta: '0',
    ratedCostDelta: '0',
    v2RatedCostDelta: '0',
    estimatedRatedCost: false,
    allowAggregateFallback,
    strictCoverage
  }

  const loaded = await loadRequestDetails(client, cutoffMs)
  report.scannedRequestDetailIndexes = loaded.scannedIndexes
  report.scannedRequestDetailPointers = loaded.pointers
  report.missingRequestDetailPointers = loaded.missingPointers.map(sanitizeIssue)

  const pendingRecords = []
  const migratedRecords = []
  const dailyCoverage = new Map()
  const hourlyCoverage = new Map()

  for (const detail of loaded.details) {
    const timestampMs = resolveRecordTimestamp(detail.record, detail.indexTimestampMs)
    if (!Number.isFinite(timestampMs) || timestampMs > cutoffMs) {
      continue
    }

    const classification = classifyRequestDetail(detail.record, pricing)
    if (classification.status === 'not-target') {
      continue
    }
    if (Object.prototype.hasOwnProperty.call(report.classifications, classification.status)) {
      report.classifications[classification.status] += 1
    }

    if (classification.status === 'unexpected') {
      report.blockingIssues.push({
        type: 'unexpected-request-detail',
        requestId: detail.requestId,
        model: classification.model,
        reason: classification.reason
      })
      continue
    }
    if (!['pending-2x', 'migrated-2.5x'].includes(classification.status)) {
      continue
    }

    const keyId = detail.record.apiKeyId
    if (!keyId) {
      report.blockingIssues.push({
        type: 'missing-api-key-id',
        requestId: detail.requestId,
        model: classification.model
      })
      continue
    }
    if (detail.record.requestId && detail.record.requestId !== detail.requestId) {
      report.blockingIssues.push({
        type: 'request-id-mismatch',
        indexRequestId: detail.requestId,
        recordRequestId: detail.record.requestId
      })
      continue
    }

    const buckets = getTimeBuckets(timestampMs)
    accumulateCoverage(dailyCoverage, keyId, classification.model, buckets.date, detail.record)
    accumulateCoverage(hourlyCoverage, keyId, classification.model, buckets.hour, detail.record)
    report.accountTypes[detail.record.accountType || 'unknown'] =
      (report.accountTypes[detail.record.accountType || 'unknown'] || 0) + 1
    report.modelCounts[classification.model] = (report.modelCounts[classification.model] || 0) + 1

    const normalized = {
      ...detail,
      keyId,
      model: classification.model,
      timestampMs,
      buckets,
      classification
    }
    if (classification.status === 'pending-2x') {
      pendingRecords.push(normalized)
    } else {
      migratedRecords.push(normalized)
    }
  }

  const coverage = await verifyCoverage(
    client,
    dailyCoverage,
    hourlyCoverage,
    nowMs,
    cutoffMs,
    strictCoverage
  )
  report.coverage = {
    dailyBuckets: coverage.dailyBuckets,
    hourlyBuckets: coverage.hourlyBuckets,
    issueCount: coverage.issues.length,
    expectedMissingCount: coverage.expectedMissing.length,
    liveTailCount: coverage.liveTail.length
  }
  report.expectedMissing.push(...coverage.expectedMissing)
  report.warnings.push(...coverage.liveTail)
  if (coverage.issues.length > 0) {
    report.blockingIssues.push(...coverage.issues)
    if (allowAggregateFallback) {
      report.blockingIssues.push({
        type: 'aggregate-fallback-refused',
        reason:
          'Exact rated-cost history cannot be reconstructed safely from aggregate hashes; restore request details or use a separately reviewed estimate migration.'
      })
    }
  }

  if (pendingRecords.length > 0 && migratedRecords.length > 0) {
    report.blockingIssues.push({
      type: 'mixed-pending-and-migrated-records',
      reason: 'Resume or roll back with the original manifest instead of generating new deltas.'
    })
  }

  const keyIds = [...new Set(pendingRecords.map((record) => record.keyId))]
  const keyData = await loadApiKeyData(client, keyIds)
  for (const keyId of keyIds) {
    if (!keyData.get(keyId)?.id) {
      report.blockingIssues.push({
        type: 'missing-api-key-metadata',
        keyId,
        reason: 'v2 parent-ledger attribution cannot be proven'
      })
    }
  }
  const parentKeyIds = [
    ...new Set(
      [...keyData.values()].map((apiKey) => apiKey.parentKeyId).filter((parentKeyId) => parentKeyId)
    )
  ]
  const parentKeyData = await loadApiKeyData(client, parentKeyIds)
  for (const [parentKeyId, parent] of parentKeyData) {
    keyData.set(parentKeyId, parent)
    if (!parent.id) {
      report.blockingIssues.push({ type: 'missing-v2-parent-metadata', parentKeyId })
    }
  }

  const hashDeltas = new Map()
  const costDeltas = new Map()
  const v2Deltas = new Map()
  let totalOldRealMicro = 0n
  let totalOldRatedMicro = 0n
  let totalRealDeltaScaled = 0n
  let totalRatedDeltaScaled = 0n

  for (const pending of pendingRecords) {
    const oldRealMicro = toMicro(pending.record.realCost)
    const oldRatedMicro = toMicro(pending.record.cost)
    const newRealMicro = scaleMicroForNewMultiplier(oldRealMicro)
    const newRatedMicro = scaleMicroForNewMultiplier(oldRatedMicro)
    const realDeltaMicro = newRealMicro - oldRealMicro
    const ratedDeltaMicro = newRatedMicro - oldRatedMicro
    const realDeltaScaled = costDeltaScaled(pending.record.realCost)
    const ratedDeltaScaled = costDeltaScaled(pending.record.cost)

    totalOldRealMicro += oldRealMicro
    totalOldRatedMicro += oldRatedMicro
    totalRealDeltaScaled += realDeltaScaled
    totalRatedDeltaScaled += ratedDeltaScaled

    for (const metadata of makeHashKeys(pending.keyId, pending.model, pending.buckets)) {
      addHashDelta(hashDeltas, metadata.key, realDeltaMicro, ratedDeltaMicro, metadata)
    }
    for (const metadata of makeCostKeys(pending.keyId, pending.buckets)) {
      addScaledDelta(
        costDeltas,
        metadata.key,
        metadata.costType === 'real' ? realDeltaScaled : ratedDeltaScaled,
        metadata
      )
    }

    const apiKey = keyData.get(pending.keyId) || {}
    const parentKeyId = apiKey.parentKeyId || (apiKey.isV2Parent === 'true' ? pending.keyId : null)
    if (parentKeyId) {
      addScaledDelta(v2Deltas, `usage:cost:v2:total:${parentKeyId}`, ratedDeltaScaled, {
        kind: 'v2-parent-total',
        parentKeyId
      })
    }
  }

  const detailStates = await loadStringStates(
    client,
    pendingRecords.map((record) => record.key)
  )
  const detailOperations = []
  for (const pending of pendingRecords) {
    const state = detailStates.get(pending.key)
    if (!state || state.value === null || state.pttl <= 0) {
      report.blockingIssues.push({
        type: 'request-detail-expired-during-preparation',
        requestId: pending.requestId
      })
      continue
    }
    detailOperations.push({
      type: 'json-fields',
      key: pending.key,
      oldFields: captureFields(pending.record),
      targetFields: buildScaledFieldSnapshot(pending.record, backfilledAt),
      expiresAt: state.expiresAt,
      metadata: {
        requestId: pending.requestId,
        keyId: pending.keyId,
        model: pending.model,
        timestamp: new Date(pending.timestampMs).toISOString()
      }
    })
  }

  const usageRecordOperations = await buildUsageRecordOperations(
    client,
    pendingRecords,
    backfilledAt,
    report
  )
  const hashOperations = await buildHashOperations(client, hashDeltas, nowMs, report)
  const costOperations = await buildStringOperations(client, costDeltas, nowMs, report)
  const v2Operations = await buildStringOperations(client, v2Deltas, nowMs, report)
  for (const operation of v2Operations) {
    const parent = keyData.get(operation.metadata.parentKeyId) || {}
    const limit = toFiniteNumber(parent.v2TotalBudget, 0)
    if (limit > 0 && Number(operation.target) >= limit) {
      report.warnings.push({
        type: 'backfill-reaches-v2-parent-budget',
        parentKeyId: operation.metadata.parentKeyId,
        limit,
        oldCost: operation.old,
        targetCost: operation.target
      })
    }
  }
  const currentDate = getTimeBuckets(nowMs).date
  for (const operation of costOperations) {
    const apiKey = keyData.get(operation.metadata.keyId) || {}
    const isCurrentDaily =
      operation.metadata.kind === 'cost-daily' && operation.metadata.date === currentDate
    const limit =
      operation.metadata.kind === 'cost-total'
        ? toFiniteNumber(apiKey.totalCostLimit, 0)
        : isCurrentDaily
          ? toFiniteNumber(apiKey.dailyCostLimit, 0)
          : 0
    if (limit > 0 && Number(operation.target) >= limit) {
      report.warnings.push({
        type: 'backfill-reaches-api-key-cost-limit',
        keyId: operation.metadata.keyId,
        limitType: operation.metadata.kind === 'cost-total' ? 'total' : 'daily',
        limit,
        oldCost: operation.old,
        targetCost: operation.target
      })
    }
  }

  const rateWindowStates = await loadStringStates(
    client,
    keyIds.map((keyId) => `rate_limit:window_start:${keyId}`)
  )
  const rateDeltas = new Map()
  for (const pending of pendingRecords) {
    const apiKey = keyData.get(pending.keyId) || {}
    const usesCostWindow =
      toFiniteNumber(apiKey.rateLimitWindow, 0) > 0 &&
      toFiniteNumber(apiKey.rateLimitCost, 0) > 0 &&
      toFiniteNumber(apiKey.tokenLimit, 0) <= 0
    const windowState = rateWindowStates.get(`rate_limit:window_start:${pending.keyId}`)
    const windowStart = toFiniteNumber(windowState?.value)
    if (
      usesCostWindow &&
      windowStart !== null &&
      windowState.pttl > 0 &&
      pending.timestampMs >= windowStart
    ) {
      addScaledDelta(
        rateDeltas,
        `rate_limit:cost:${pending.keyId}`,
        costDeltaScaled(pending.record.cost),
        {
          kind: 'active-rate-limit-cost',
          keyId: pending.keyId,
          windowExpiresAt: windowState.expiresAt
        }
      )
    }
  }
  const rateLimitOperations = await buildStringOperations(client, rateDeltas, nowMs, report)
  for (const operation of rateLimitOperations) {
    const apiKey = keyData.get(operation.metadata.keyId) || {}
    const limit = toFiniteNumber(apiKey.rateLimitCost, 0)
    if (limit > 0 && Number(operation.target) >= limit) {
      report.warnings.push({
        type: 'backfill-reaches-active-window-cost-limit',
        keyId: operation.metadata.keyId,
        limit,
        oldCost: operation.old,
        targetCost: operation.target
      })
    }
  }
  const responsesOperations = await buildResponsesQuotaOperations(
    client,
    pendingRecords,
    backfilledAt,
    report
  )

  const operations = sortOperations([
    ...detailOperations,
    ...usageRecordOperations,
    ...hashOperations,
    ...costOperations,
    ...v2Operations,
    ...rateLimitOperations,
    ...responsesOperations
  ])

  report.totalOldRealCost = scaledToDecimal(totalOldRealMicro * 1000000000000n)
  report.totalOldRatedCost = scaledToDecimal(totalOldRatedMicro * 1000000000000n)
  report.realCostDelta = scaledToDecimal(totalRealDeltaScaled)
  report.ratedCostDelta = scaledToDecimal(totalRatedDeltaScaled)
  report.v2RatedCostDelta = scaledToDecimal(
    [...v2Deltas.values()].reduce((sum, entry) => sum + entry.deltaScaled, 0n)
  )
  report.pendingRecords = pendingRecords.length
  report.migratedRecords = migratedRecords.length
  report.operationCounts = operations.reduce((counts, operation) => {
    counts[operation.type] = (counts[operation.type] || 0) + 1
    return counts
  }, {})
  report.blockingIssueCount = report.blockingIssues.length
  report.warningCount = report.warnings.length
  report.expectedMissingCount = report.expectedMissing.length
  report.missingUsageRecordCount = report.missingUsageRecords.length
  report.missingRequestDetailPointerCount = report.missingRequestDetailPointers.length
  report.canApply = report.blockingIssues.length === 0
  report.applyReady = report.canApply && strictCoverage

  return sealManifest({
    version: MIGRATION_VERSION,
    createdAt: backfilledAt,
    cutoff: new Date(cutoffMs).toISOString(),
    oldPriorityMultiplier: OLD_PRIORITY_MULTIPLIER,
    newPriorityMultiplier: NEW_PRIORITY_MULTIPLIER,
    targetModels: [...TARGET_MODELS],
    report,
    operations
  })
}

const ATOMIC_SET_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then
  return 'missing'
end
if current == ARGV[2] then
  return 'target'
end
if current ~= ARGV[1] then
  return 'conflict'
end
local expiresAt = tonumber(ARGV[3]) or 0
if expiresAt > 0 then
  local now = redis.call('TIME')
  local nowMs = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
  local remaining = expiresAt - nowMs
  if remaining <= 0 then
    return 'expired'
  end
  redis.call('SET', KEYS[1], ARGV[2], 'PX', remaining)
else
  redis.call('SET', KEYS[1], ARGV[2])
end
return 'applied'
`

const ATOMIC_LIST_SET_SCRIPT = `
local current = redis.call('LINDEX', KEYS[1], tonumber(ARGV[1]))
if not current then
  return 'missing'
end
if current == ARGV[3] then
  return 'target'
end
if current ~= ARGV[2] then
  return 'conflict'
end
local expiresAt = tonumber(ARGV[4]) or 0
if expiresAt > 0 then
  local now = redis.call('TIME')
  local nowMs = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
  if expiresAt <= nowMs then
    return 'expired'
  end
end
redis.call('LSET', KEYS[1], tonumber(ARGV[1]), ARGV[3])
return 'applied'
`

const ATOMIC_HASH_SET_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 'missing'
end
local expiresAt = tonumber(ARGV[1]) or 0
if expiresAt > 0 then
  local now = redis.call('TIME')
  local nowMs = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
  if expiresAt <= nowMs then
    return 'expired'
  end
end
local count = tonumber(ARGV[2])
local allOld = true
local allTarget = true
for index = 0, count - 1 do
  local offset = 3 + index * 3
  local field = ARGV[offset]
  local oldValue = ARGV[offset + 1]
  local targetValue = ARGV[offset + 2]
  local current = redis.call('HGET', KEYS[1], field)
  local normalized = current or '${NULL_SENTINEL}'
  if normalized ~= oldValue then
    allOld = false
  end
  if normalized ~= targetValue then
    allTarget = false
  end
end
if allTarget then
  return 'target'
end
if not allOld then
  return 'conflict'
end
for index = 0, count - 1 do
  local offset = 3 + index * 3
  local field = ARGV[offset]
  local targetValue = ARGV[offset + 2]
  if targetValue == '${NULL_SENTINEL}' then
    redis.call('HDEL', KEYS[1], field)
  else
    redis.call('HSET', KEYS[1], field, targetValue)
  end
end
return 'applied'
`

const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`

function snapshotMatches(record, snapshot) {
  return deepEqual(captureFields(record, Object.keys(snapshot.present || {})), snapshot)
}

function normalizeHashValue(value) {
  return value === null || value === undefined ? NULL_SENTINEL : String(value)
}

async function applyJsonFieldsOperation(client, operation, direction) {
  const source = direction === 'apply' ? operation.oldFields : operation.targetFields
  const target = direction === 'apply' ? operation.targetFields : operation.oldFields
  const raw = await client.get(operation.key)
  if (!raw) {
    return operation.expiresAt && operation.expiresAt <= Date.now() ? 'expired' : 'missing'
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return 'conflict'
  }
  if (snapshotMatches(parsed, target)) {
    return 'target'
  }
  if (!snapshotMatches(parsed, source)) {
    return 'conflict'
  }

  const targetRaw = JSON.stringify(applyCapturedFields(parsed, target))
  return client.eval(
    ATOMIC_SET_SCRIPT,
    1,
    operation.key,
    raw,
    targetRaw,
    String(operation.expiresAt || 0)
  )
}

async function applyStringOperation(client, operation, direction) {
  const source = direction === 'apply' ? operation.old : operation.target
  const target = direction === 'apply' ? operation.target : operation.old
  return client.eval(
    ATOMIC_SET_SCRIPT,
    1,
    operation.key,
    String(source),
    String(target),
    String(operation.expiresAt || 0)
  )
}

async function applyListOperation(client, operation, direction) {
  const source = direction === 'apply' ? operation.old : operation.target
  const target = direction === 'apply' ? operation.target : operation.old
  return client.eval(
    ATOMIC_LIST_SET_SCRIPT,
    1,
    operation.key,
    String(operation.index),
    source,
    target,
    String(operation.expiresAt || 0)
  )
}

async function applyListJsonFieldsOperation(client, operation, direction) {
  const source = direction === 'apply' ? operation.oldFields : operation.targetFields
  const target = direction === 'apply' ? operation.targetFields : operation.oldFields
  const raw = await client.lindex(operation.key, operation.index)
  if (!raw) {
    return operation.expiresAt && operation.expiresAt <= Date.now() ? 'expired' : 'missing'
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return 'conflict'
  }
  if (snapshotMatches(parsed, target)) {
    return 'target'
  }
  if (!snapshotMatches(parsed, source)) {
    return 'conflict'
  }

  const targetRaw = JSON.stringify(applyCapturedFields(parsed, target))
  return client.eval(
    ATOMIC_LIST_SET_SCRIPT,
    1,
    operation.key,
    String(operation.index),
    raw,
    targetRaw,
    String(operation.expiresAt || 0)
  )
}

async function applyHashOperation(client, operation, direction) {
  const fields = Object.entries(operation.fields)
  const args = [String(operation.expiresAt || 0), String(fields.length)]
  for (const [field, values] of fields) {
    const source = direction === 'apply' ? values.old : values.target
    const target = direction === 'apply' ? values.target : values.old
    args.push(field, normalizeHashValue(source), normalizeHashValue(target))
  }
  return client.eval(ATOMIC_HASH_SET_SCRIPT, 1, operation.key, ...args)
}

async function applyOperation(client, operation, direction = 'apply') {
  if (operation.type === 'json-fields') {
    return applyJsonFieldsOperation(client, operation, direction)
  }
  if (operation.type === 'string') {
    return applyStringOperation(client, operation, direction)
  }
  if (operation.type === 'list-entry') {
    return applyListOperation(client, operation, direction)
  }
  if (operation.type === 'list-json-fields') {
    return applyListJsonFieldsOperation(client, operation, direction)
  }
  if (operation.type === 'hash-fields') {
    return applyHashOperation(client, operation, direction)
  }
  throw new Error(`Unsupported manifest operation: ${operation.type}`)
}

async function runManifestOperations(client, manifest, direction = 'apply') {
  verifyManifestChecksum(manifest)
  const operations =
    direction === 'rollback' ? [...manifest.operations].reverse() : manifest.operations
  const summary = { applied: 0, alreadyTarget: 0, expired: 0, conflicts: [] }

  for (const operation of operations) {
    const result = await applyOperation(client, operation, direction)
    if (result === 'applied') {
      summary.applied += 1
    } else if (result === 'target') {
      summary.alreadyTarget += 1
    } else if (result === 'expired') {
      summary.expired += 1
      if (direction === 'apply') {
        summary.conflicts.push({ type: 'expired-during-apply', key: operation.key })
      }
    } else {
      summary.conflicts.push({ type: result || 'unknown', key: operation.key })
    }
    if (summary.conflicts.length > 0) {
      const error = new Error(`${direction} stopped on a manifest conflict`)
      error.operationSummary = summary
      throw error
    }
  }
  return summary
}

async function verifyOperation(client, operation, direction = 'apply') {
  const targetDirection = direction === 'apply' ? 'apply' : 'rollback'
  if (operation.type === 'json-fields') {
    const raw = await client.get(operation.key)
    if (!raw) {
      return operation.expiresAt && operation.expiresAt <= Date.now() ? 'expired' : 'missing'
    }
    try {
      const record = JSON.parse(raw)
      const target = targetDirection === 'apply' ? operation.targetFields : operation.oldFields
      return snapshotMatches(record, target) ? 'target' : 'mismatch'
    } catch (error) {
      return 'mismatch'
    }
  }
  if (operation.type === 'string') {
    const value = await client.get(operation.key)
    if (value === null) {
      return operation.expiresAt && operation.expiresAt <= Date.now() ? 'expired' : 'missing'
    }
    const target = targetDirection === 'apply' ? operation.target : operation.old
    return value === String(target) ? 'target' : 'mismatch'
  }
  if (operation.type === 'list-entry') {
    const value = await client.lindex(operation.key, operation.index)
    if (value === null) {
      return operation.expiresAt && operation.expiresAt <= Date.now() ? 'expired' : 'missing'
    }
    const target = targetDirection === 'apply' ? operation.target : operation.old
    return value === target ? 'target' : 'mismatch'
  }
  if (operation.type === 'list-json-fields') {
    const value = await client.lindex(operation.key, operation.index)
    if (value === null) {
      return operation.expiresAt && operation.expiresAt <= Date.now() ? 'expired' : 'missing'
    }
    try {
      const record = JSON.parse(value)
      const target = targetDirection === 'apply' ? operation.targetFields : operation.oldFields
      return snapshotMatches(record, target) ? 'target' : 'mismatch'
    } catch (error) {
      return 'mismatch'
    }
  }
  if (operation.type === 'hash-fields') {
    const values = await client.hmget(operation.key, ...Object.keys(operation.fields))
    const targetValues = Object.values(operation.fields).map((entry) =>
      targetDirection === 'apply' ? entry.target : entry.old
    )
    return values.every((value, index) => value === targetValues[index]) ? 'target' : 'mismatch'
  }
  return 'mismatch'
}

async function inspectOperationState(client, operation, direction = 'apply') {
  const sourceDirection = direction === 'apply' ? 'apply' : 'rollback'
  if (operation.type === 'json-fields' || operation.type === 'list-json-fields') {
    const raw =
      operation.type === 'json-fields'
        ? await client.get(operation.key)
        : await client.lindex(operation.key, operation.index)
    if (!raw) {
      return operation.expiresAt && operation.expiresAt <= Date.now() ? 'expired' : 'missing'
    }
    try {
      const record = JSON.parse(raw)
      const source = sourceDirection === 'apply' ? operation.oldFields : operation.targetFields
      const target = sourceDirection === 'apply' ? operation.targetFields : operation.oldFields
      if (snapshotMatches(record, target)) {
        return 'target'
      }
      if (snapshotMatches(record, source)) {
        return 'source'
      }
      return 'conflict'
    } catch (error) {
      return 'conflict'
    }
  }
  if (operation.type === 'string') {
    const current = await client.get(operation.key)
    if (current === null) {
      return operation.expiresAt && operation.expiresAt <= Date.now() ? 'expired' : 'missing'
    }
    const source = sourceDirection === 'apply' ? operation.old : operation.target
    const target = sourceDirection === 'apply' ? operation.target : operation.old
    if (current === String(target)) {
      return 'target'
    }
    if (current === String(source)) {
      return 'source'
    }
    return 'conflict'
  }
  if (operation.type === 'list-entry') {
    const current = await client.lindex(operation.key, operation.index)
    if (current === null) {
      return operation.expiresAt && operation.expiresAt <= Date.now() ? 'expired' : 'missing'
    }
    const source = sourceDirection === 'apply' ? operation.old : operation.target
    const target = sourceDirection === 'apply' ? operation.target : operation.old
    if (current === target) {
      return 'target'
    }
    if (current === source) {
      return 'source'
    }
    return 'conflict'
  }
  if (operation.type === 'hash-fields') {
    const values = await client.hmget(operation.key, ...Object.keys(operation.fields))
    const sourceValues = Object.values(operation.fields).map((entry) =>
      sourceDirection === 'apply' ? entry.old : entry.target
    )
    const targetValues = Object.values(operation.fields).map((entry) =>
      sourceDirection === 'apply' ? entry.target : entry.old
    )
    if (values.every((value, index) => value === targetValues[index])) {
      return 'target'
    }
    if (values.every((value, index) => value === sourceValues[index])) {
      return 'source'
    }
    if (values.every((value) => value === null)) {
      return operation.expiresAt && operation.expiresAt <= Date.now() ? 'expired' : 'missing'
    }
    return 'conflict'
  }
  return 'conflict'
}

async function preflightManifestState(client, manifest, direction = 'apply') {
  verifyManifestChecksum(manifest)
  const summary = { source: 0, target: 0, expired: 0, missing: 0, conflicts: [] }
  for (const operation of manifest.operations) {
    const state = await inspectOperationState(client, operation, direction)
    if (state === 'source' || state === 'target' || state === 'expired' || state === 'missing') {
      summary[state] += 1
    } else {
      summary.conflicts.push({ key: operation.key, type: operation.type })
    }
  }
  return summary
}

async function verifyManifestState(client, manifest, direction = 'apply') {
  verifyManifestChecksum(manifest)
  const summary = { target: 0, expired: 0, missing: 0, mismatches: [] }
  for (const operation of manifest.operations) {
    const result = await verifyOperation(client, operation, direction)
    if (result === 'target') {
      summary.target += 1
    } else if (result === 'expired') {
      summary.expired += 1
    } else if (result === 'missing') {
      summary.missing += 1
    } else {
      summary.mismatches.push({ key: operation.key, type: operation.type })
    }
  }
  return summary
}

async function acquireMigrationLock(client) {
  const token = crypto.randomUUID()
  const acquired = await client.set(MIGRATION_LOCK_KEY, token, 'NX', 'EX', LOCK_TTL_SECONDS)
  if (acquired !== 'OK') {
    throw new Error(`Migration lock is already held: ${MIGRATION_LOCK_KEY}`)
  }
  return token
}

async function releaseMigrationLock(client, token) {
  await client.eval(RELEASE_LOCK_SCRIPT, 1, MIGRATION_LOCK_KEY, token)
}

async function saveMigrationState(client, status, manifestPath, manifest, extra = {}) {
  const state = {
    version: MIGRATION_VERSION,
    status,
    manifestPath: manifestPath || null,
    manifestSha256: manifest?.sha256 || null,
    cutoff: manifest?.cutoff || null,
    updatedAt: new Date().toISOString(),
    ...extra
  }
  await client.set(MIGRATION_STATE_KEY, JSON.stringify(state))
  return state
}

async function loadMigrationState(client) {
  const raw = await client.get(MIGRATION_STATE_KEY)
  if (!raw) {
    return null
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`Invalid migration state JSON in ${MIGRATION_STATE_KEY}`)
  }
}

function parsePersistenceInfo(rawInfo) {
  return Object.fromEntries(
    String(rawInfo || '')
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith('#') && line.includes(':'))
      .map((line) => {
        const separator = line.indexOf(':')
        return [line.slice(0, separator), line.slice(separator + 1)]
      })
  )
}

async function waitForBgsaveIdle(client, deadline) {
  while (Date.now() < deadline) {
    const info = parsePersistenceInfo(await client.info('persistence'))
    if (info.rdb_bgsave_in_progress !== '1') {
      if (info.rdb_last_bgsave_status && info.rdb_last_bgsave_status !== 'ok') {
        throw new Error(`Redis BGSAVE status is ${info.rdb_last_bgsave_status}`)
      }
      return info
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('Timed out waiting for an existing Redis BGSAVE to finish')
}

async function ensureRedisSnapshot(client, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs
  await waitForBgsaveIdle(client, deadline)
  const previousLastSave = Number(await client.lastsave())
  await client.bgsave()
  await waitForBgsaveIdle(client, deadline)
  const lastSave = Number(await client.lastsave())
  return { previousLastSave, lastSave }
}

async function writeManifest(filePath, manifest) {
  const absolutePath = path.resolve(filePath)
  await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true })
  const compressed = await gzip(Buffer.from(JSON.stringify(manifest)))
  await fs.promises.writeFile(absolutePath, compressed, { mode: 0o600 })
  return absolutePath
}

async function readManifest(filePath) {
  const absolutePath = path.resolve(filePath)
  const compressed = await fs.promises.readFile(absolutePath)
  const manifest = JSON.parse((await gunzip(compressed)).toString('utf8'))
  verifyManifestChecksum(manifest)
  if (manifest.version !== MIGRATION_VERSION) {
    throw new Error(`Unexpected manifest version: ${manifest.version}`)
  }
  return { manifest, absolutePath }
}

async function writeReport(filePath, report) {
  const absolutePath = path.resolve(filePath)
  await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true })
  await fs.promises.writeFile(absolutePath, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600
  })
  return absolutePath
}

function buildOutputPaths(reportOption, timestamp = new Date()) {
  const safeTimestamp = timestamp.toISOString().replace(/[:.]/g, '-')
  if (reportOption) {
    const reportPath = path.resolve(reportOption)
    const extension = reportPath.endsWith('.json') ? '.json' : ''
    const base = extension ? reportPath.slice(0, -extension.length) : reportPath
    return {
      reportPath: extension ? reportPath : `${reportPath}.json`,
      manifestPath: `${base}.manifest.json.gz`
    }
  }
  const base = path.join(DEFAULT_MIGRATION_DIR, `${MIGRATION_VERSION}-${safeTimestamp}`)
  return { reportPath: `${base}.report.json`, manifestPath: `${base}.manifest.json.gz` }
}

function publicReport(report) {
  return {
    ...report,
    blockingIssues: report.blockingIssues.slice(0, 100).map(sanitizeIssue),
    warnings: report.warnings.slice(0, 100).map(sanitizeIssue),
    expectedMissing: report.expectedMissing.slice(0, 100).map(sanitizeIssue),
    missingUsageRecords: report.missingUsageRecords.slice(0, 100).map(sanitizeIssue),
    missingRequestDetailPointers: report.missingRequestDetailPointers
      .slice(0, 100)
      .map(sanitizeIssue)
  }
}

async function runCli(argv = process.argv) {
  const program = new Command()
    .name('backfillGpt56FastPricing')
    .description('Backfill GPT-5.6 priority pricing from 2x to 2.5x')
    .option('--apply', 'apply the generated or supplied manifest')
    .option('--cutoff <iso>', 'only include requests at or before this ISO timestamp')
    .option('--report <path>', 'write the JSON report and adjacent compressed manifest')
    .option('--manifest <path>', 'resume apply from an existing compressed manifest')
    .option('--rollback <path>', 'roll back an existing compressed manifest')
    .option(
      '--strict-coverage',
      'require exact coverage for the cutoff day/hour (automatically enabled by --apply)'
    )
    .option(
      '--allow-aggregate-fallback',
      'acknowledge aggregate fallback review (unsafe estimates are still refused)'
    )
    .parse(argv)
  const options = program.opts()

  if (options.rollback && (options.apply || options.manifest || options.cutoff)) {
    throw new Error('--rollback cannot be combined with --apply, --manifest, or --cutoff')
  }
  if (options.manifest && !options.apply) {
    throw new Error('--manifest is only valid together with --apply')
  }
  if (options.apply && !options.manifest && !options.cutoff) {
    throw new Error('--apply requires an explicit --cutoff or an existing --manifest')
  }

  await redis.connect()
  await pricingService.loadPricingData()
  const client = redis.getClientSafe()

  if (options.rollback) {
    const { manifest, absolutePath } = await readManifest(options.rollback)
    const lockToken = await acquireMigrationLock(client)
    try {
      await ensureRedisSnapshot(client)
      await saveMigrationState(client, 'rolling_back', absolutePath, manifest)
      const operationSummary = await runManifestOperations(client, manifest, 'rollback')
      const verification = await verifyManifestState(client, manifest, 'rollback')
      if (verification.mismatches.length > 0 || verification.missing > 0) {
        throw new Error('Rollback verification failed')
      }
      await saveMigrationState(client, 'rolled_back', absolutePath, manifest, {
        operationSummary,
        verification
      })
      console.log(
        JSON.stringify({ status: 'rolled_back', operationSummary, verification }, null, 2)
      )
      return
    } catch (error) {
      await saveMigrationState(client, 'failed', absolutePath, manifest, {
        phase: 'rollback',
        error: error.message
      })
      throw error
    } finally {
      await releaseMigrationLock(client, lockToken)
    }
  }

  let manifest
  let manifestPath = null
  let reportPath = null
  if (options.manifest) {
    const { manifest: parsedManifest, absolutePath } = await readManifest(options.manifest)
    manifest = parsedManifest
    manifestPath = absolutePath
  } else {
    const cutoffMs = options.cutoff ? parseIsoTimestamp(options.cutoff, 'cutoff') : Date.now()
    manifest = await buildMigrationManifest({
      client,
      cutoffMs,
      allowAggregateFallback: options.allowAggregateFallback === true,
      strictCoverage: options.apply === true || options.strictCoverage === true
    })

    if (options.report || options.apply) {
      const outputPaths = buildOutputPaths(options.report)
      reportPath = await writeReport(outputPaths.reportPath, publicReport(manifest.report))
      manifestPath = await writeManifest(outputPaths.manifestPath, manifest)
    }
  }

  const state = await loadMigrationState(client)
  let existingVerification = null
  if (
    !options.apply &&
    state?.status === 'completed' &&
    state.manifestPath &&
    fs.existsSync(state.manifestPath)
  ) {
    const completed = await readManifest(state.manifestPath)
    existingVerification = await verifyManifestState(client, completed.manifest, 'apply')
  }

  if (!options.apply) {
    console.log(
      JSON.stringify(
        {
          mode: 'dry-run',
          report: publicReport(manifest.report),
          reportPath,
          manifestPath,
          completedManifestVerification: existingVerification
        },
        null,
        2
      )
    )
    return
  }

  if (!manifest.report?.applyReady) {
    throw new Error(
      `Manifest is not strict/apply-ready (${manifest.report?.blockingIssues?.length || 0} blocking issues)`
    )
  }
  if (!manifestPath) {
    throw new Error('Apply requires a persisted manifest')
  }

  const lockToken = await acquireMigrationLock(client)
  try {
    await saveMigrationState(client, 'prepared', manifestPath, manifest)
    const snapshot = await ensureRedisSnapshot(client)
    const preflight = await preflightManifestState(client, manifest, 'apply')
    if (preflight.expired > 0 || preflight.missing > 0 || preflight.conflicts.length > 0) {
      throw new Error('Manifest preflight failed; no cost operations were applied')
    }
    await saveMigrationState(client, 'applying', manifestPath, manifest, {
      snapshot,
      preflight
    })
    const operationSummary = await runManifestOperations(client, manifest, 'apply')
    const verification = await verifyManifestState(client, manifest, 'apply')
    if (verification.mismatches.length > 0 || verification.missing > 0) {
      throw new Error('Post-apply manifest verification failed')
    }
    await saveMigrationState(client, 'completed', manifestPath, manifest, {
      operationSummary,
      verification,
      completedAt: new Date().toISOString()
    })
    console.log(
      JSON.stringify(
        {
          status: 'completed',
          manifestPath,
          reportPath,
          operationSummary,
          verification
        },
        null,
        2
      )
    )
  } catch (error) {
    await saveMigrationState(client, 'failed', manifestPath, manifest, {
      phase: 'apply',
      error: error.message,
      operationSummary: error.operationSummary || null
    })
    throw error
  } finally {
    await releaseMigrationLock(client, lockToken)
  }
}

async function main() {
  try {
    await runCli(process.argv)
  } catch (error) {
    console.error(`Failed to backfill GPT-5.6 fast pricing: ${error.message}`)
    logger.error('GPT-5.6 fast pricing backfill failed:', error)
    process.exitCode = 1
  } finally {
    try {
      await redis.disconnect()
    } catch (error) {
      // Ignore disconnect errors during CLI shutdown.
    }
  }
}

if (require.main === module) {
  main()
}

module.exports = {
  MIGRATION_VERSION,
  TARGET_MODELS,
  addDecimalStrings,
  applyCapturedFields,
  applyOperation,
  buildMigrationManifest,
  buildOutputPaths,
  buildScaledFieldSnapshot,
  buildTimeBuckets: getTimeBuckets,
  captureFields,
  classifyRequestDetail,
  costDeltaScaled,
  decimalToScaled,
  inferStoredMultiplier,
  readManifest,
  preflightManifestState,
  runManifestOperations,
  scaledToDecimal,
  sealManifest,
  verifyManifestChecksum,
  verifyManifestState,
  writeManifest
}
