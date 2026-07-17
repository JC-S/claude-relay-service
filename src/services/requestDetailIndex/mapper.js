const { getRequestDetailCacheMetrics } = require('../../utils/requestDetailHelper')
const { applyDisplayModelToRecord } = require('../../utils/modelVariantHelper')

const accountTypeNames = {
  claude: 'Claude官方',
  'claude-official': 'Claude官方',
  'claude-console': 'Claude Console',
  ccr: 'Claude Console Relay',
  openai: 'OpenAI',
  'openai-responses': 'OpenAI Responses',
  'azure-openai': 'Azure OpenAI',
  gemini: 'Gemini',
  'gemini-api': 'Gemini API',
  droid: 'Droid',
  grok: 'Grok',
  bedrock: 'AWS Bedrock',
  unknown: '未知渠道'
}

function numberOrZero(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function tokenOrZero(value) {
  return Math.max(0, Math.trunc(numberOrZero(value)))
}

function timestampOrFallback(value, fallbackTimestampMs) {
  const parsed = value ? new Date(value).getTime() : Number.NaN
  return Number.isFinite(parsed) ? parsed : Number(fallbackTimestampMs)
}

function normalizeText(value, fallback = '') {
  return value === null || value === undefined ? fallback : String(value)
}

function normalizeServiceTier(value) {
  if (typeof value !== 'string') {
    return null
  }
  const normalized = value.trim()
  return normalized || null
}

function extractServiceTier(payload) {
  if (!payload) {
    return null
  }
  if (typeof payload === 'object') {
    return (
      normalizeServiceTier(payload.service_tier) ||
      normalizeServiceTier(payload.serviceTier) ||
      (typeof payload.preview === 'string' ? extractServiceTier(payload.preview) : null)
    )
  }
  if (typeof payload !== 'string') {
    return null
  }
  try {
    return extractServiceTier(JSON.parse(payload))
  } catch (_error) {
    const match = payload.match(/["']service_?tier["']\s*:\s*["']([^"']+)["']/i)
    return normalizeServiceTier(match?.[1])
  }
}

function createSearchText(row) {
  return [
    row.request_id,
    row.api_key_id,
    row.account_id,
    accountTypeNames[row.account_type] || accountTypeNames.unknown,
    row.model,
    row.endpoint,
    row.method
  ]
    .map((value) => normalizeText(value).toLowerCase())
    .join('\n')
}

function isPricingRecomputeEligible(record) {
  const storedCost = numberOrZero(record.cost)
  const storedRealCost = numberOrZero(record.realCost)
  if (storedCost > 0 || storedRealCost > 0) {
    return false
  }
  return (
    tokenOrZero(record.inputTokens) +
      tokenOrZero(record.outputTokens) +
      tokenOrZero(record.cacheCreateTokens) +
      tokenOrZero(record.cacheReadTokens) >
    0
  )
}

function mapRequestDetailToIndexRow(record, options = {}) {
  if (!record || typeof record !== 'object') {
    return null
  }

  const requestId = normalizeText(record.requestId || options.requestId).trim()
  const timestampMs = timestampOrFallback(record.timestamp, options.timestampMs)
  const expiresAtMs = Number(options.expiresAtMs)
  if (!requestId || !Number.isFinite(timestampMs) || !Number.isFinite(expiresAtMs)) {
    return null
  }

  const serviceTier =
    normalizeServiceTier(record.serviceTier) ||
    normalizeServiceTier(record.service_tier) ||
    extractServiceTier(record.requestBodySnapshot ?? record.requestBody)
  const displayRecord = applyDisplayModelToRecord({ ...record, serviceTier })
  const metrics = getRequestDetailCacheMetrics(displayRecord)
  const cost = Number(numberOrZero(displayRecord.cost).toFixed(6))
  const row = {
    request_id: requestId,
    source_version: normalizeText(options.sourceVersion || record.sourceVersion || 'rebuild'),
    timestamp_ms: Math.trunc(timestampMs),
    expires_at_ms: Math.trunc(expiresAtMs),
    api_key_id: normalizeText(displayRecord.apiKeyId, null),
    account_id: normalizeText(displayRecord.accountId, null),
    account_type: normalizeText(displayRecord.accountType || 'unknown'),
    model: normalizeText(displayRecord.model || 'unknown'),
    endpoint: normalizeText(displayRecord.endpoint, null),
    method: normalizeText(displayRecord.method, null),
    input_tokens: numberOrZero(displayRecord.inputTokens),
    output_tokens: numberOrZero(displayRecord.outputTokens),
    cache_read_tokens: numberOrZero(displayRecord.cacheReadTokens),
    cache_create_tokens: metrics.cacheCreateNotApplicable
      ? 0
      : numberOrZero(displayRecord.cacheCreateTokens),
    cost_micros: Math.round(cost * 1e6),
    duration_ms: numberOrZero(displayRecord.durationMs),
    cache_hit_numerator: numberOrZero(metrics.numerator),
    cache_hit_denominator: numberOrZero(metrics.denominator),
    cache_create_not_applicable: metrics.cacheCreateNotApplicable ? 1 : 0,
    pricing_recompute_eligible: isPricingRecomputeEligible(displayRecord) ? 1 : 0
  }
  row.search_text = createSearchText(row)
  return row
}

module.exports = {
  accountTypeNames,
  createSearchText,
  extractServiceTier,
  isPricingRecomputeEligible,
  mapRequestDetailToIndexRow,
  numberOrZero,
  tokenOrZero
}
