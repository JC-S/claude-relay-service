const QUOTA_HEADER_ALLOWLIST = Object.freeze([
  'x-ratelimit-limit-requests',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-reset-requests',
  'x-ratelimit-limit-tokens',
  'x-ratelimit-remaining-tokens',
  'x-ratelimit-reset-tokens',
  'retry-after',
  'x-subscription-tier',
  'xai-subscription-tier',
  'x-entitlement-status',
  'xai-entitlement-status'
])

const getHeader = (headers, name) => {
  if (!headers) {
    return ''
  }
  const value = headers[name] ?? headers[name.toLowerCase()]
  if (Array.isArray(value)) {
    return value.length ? String(value[0]).trim() : ''
  }
  return value === undefined || value === null ? '' : String(value).trim()
}

const parseResetAt = (value) => {
  const raw = String(value || '').trim()
  if (!raw) {
    return null
  }
  if (/^\d+$/.test(raw)) {
    const numeric = Number(raw)
    const milliseconds = numeric > 1e12 ? numeric : numeric * 1000
    return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null
  }
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

const parseNonNegativeNumber = (value) => {
  if (value === '' || value === undefined || value === null) {
    return null
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

const parseRetryAfterSeconds = (value, nowMs = Date.now()) => {
  const numeric = parseNonNegativeNumber(value)
  if (numeric !== null) {
    return numeric
  }

  const retryAt = Date.parse(String(value || '').trim())
  if (!Number.isFinite(retryAt) || retryAt <= nowMs) {
    return null
  }
  return Math.ceil((retryAt - nowMs) / 1000)
}

const parseQuotaHeaders = (headers, statusCode = 0, source = 'response') => {
  const captured = {}
  for (const name of QUOTA_HEADER_ALLOWLIST) {
    const value = getHeader(headers, name)
    if (value) {
      captured[name] = value
    }
  }
  if (!Object.keys(captured).length) {
    return null
  }
  const buildWindow = (dimension) => {
    const limit = parseNonNegativeNumber(captured[`x-ratelimit-limit-${dimension}`])
    const remaining = parseNonNegativeNumber(captured[`x-ratelimit-remaining-${dimension}`])
    const resetAt = parseResetAt(captured[`x-ratelimit-reset-${dimension}`])
    return limit === null && remaining === null && !resetAt ? null : { limit, remaining, resetAt }
  }
  return {
    requests: buildWindow('requests'),
    tokens: buildWindow('tokens'),
    retryAfterSeconds: parseRetryAfterSeconds(captured['retry-after']),
    subscriptionTier: captured['xai-subscription-tier'] || captured['x-subscription-tier'] || '',
    entitlementStatus: captured['xai-entitlement-status'] || captured['x-entitlement-status'] || '',
    headers: captured,
    observedAt: new Date().toISOString(),
    source,
    statusCode
  }
}

const getQuotaCooldownSeconds = (snapshot, nowMs = Date.now(), fallbackSeconds = 120) => {
  const candidates = []
  if (Number.isFinite(snapshot?.retryAfterSeconds)) {
    candidates.push(snapshot.retryAfterSeconds)
  }
  for (const window of [snapshot?.requests, snapshot?.tokens]) {
    const resetMs = Date.parse(window?.resetAt || '')
    if (Number.isFinite(resetMs) && resetMs > nowMs) {
      candidates.push(Math.ceil((resetMs - nowMs) / 1000))
    }
  }
  return candidates.length ? Math.max(...candidates) : fallbackSeconds
}

module.exports = {
  QUOTA_HEADER_ALLOWLIST,
  parseResetAt,
  parseRetryAfterSeconds,
  parseQuotaHeaders,
  getQuotaCooldownSeconds
}
