const REDACTED = '[REDACTED]'
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

const SENSITIVE_KEY_NAMES = new Set([
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'xapikey',
  'apikey',
  'xgoogapikey',
  'xauthtoken',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'clientsecret',
  'clientassertion',
  'password',
  'passwd',
  'secret',
  'token'
])

const SERIALIZED_SECRET_FIELD =
  'authorization|proxy[-_]?authorization|cookies?|set[-_]?cookie|x[-_]?api[-_]?key|api[-_]?key|x[-_]?goog[-_]?api[-_]?key|x[-_]?auth[-_]?token|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|client[-_]?assertion|password|passwd|secret|token'

const SERIALIZED_SECRET_PATTERN = new RegExp(
  `("(?:${SERIALIZED_SECRET_FIELD})"\\s*:\\s*")([^"]*)(")`,
  'gi'
)
const ESCAPED_SERIALIZED_SECRET_PATTERN = new RegExp(
  `(\\\\"(?:${SERIALIZED_SECRET_FIELD})\\\\"\\s*:\\s*\\\\")([^\\\\"]*)(\\\\")`,
  'gi'
)

function normalizeKey(key) {
  return typeof key === 'string' ? key.toLowerCase().replace(/[^a-z0-9]/g, '') : ''
}

function isSensitiveLogKey(key) {
  const normalized = normalizeKey(key)
  if (!normalized) {
    return false
  }

  if (SENSITIVE_KEY_NAMES.has(normalized)) {
    return true
  }

  return (
    normalized.endsWith('accesstoken') ||
    normalized.endsWith('refreshtoken') ||
    normalized.endsWith('idtoken') ||
    normalized.endsWith('clientsecret') ||
    normalized.endsWith('clientassertion')
  )
}

function sanitizeLogString(value) {
  if (typeof value !== 'string') {
    return value
  }

  return value
    .replace(CONTROL_CHARACTER_PATTERN, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(SERIALIZED_SECRET_PATTERN, `$1${REDACTED}$3`)
    .replace(ESCAPED_SERIALIZED_SECRET_PATTERN, `$1${REDACTED}$3`)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`)
    .replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}\b/g, REDACTED)
    .replace(/\b(?:sk|cr|sess)[-_][A-Za-z0-9_-]{16,}\b/gi, REDACTED)
    .replace(
      /([?&](?:access_token|refresh_token|id_token|api_key|apikey|key|token|client_secret)=)[^&#\s]*/gi,
      `$1${REDACTED}`
    )
}

function getObjectConstructorName(value) {
  try {
    return value?.constructor?.name || ''
  } catch (_) {
    return ''
  }
}

function sanitizeLogValue(value, options = {}) {
  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : Infinity
  const seen = new WeakSet()

  const walk = (current, depth) => {
    if (depth > maxDepth) {
      return '[Max Depth Reached]'
    }

    if (typeof current === 'string') {
      return sanitizeLogString(current)
    }

    if (current === null || typeof current !== 'object') {
      return current
    }

    if (current instanceof Error) {
      return walk(summarizeErrorForLog(current), depth + 1)
    }

    if (Buffer.isBuffer(current)) {
      return `[Buffer ${current.length} bytes]`
    }

    if (current instanceof Date) {
      return current.toISOString()
    }

    if (seen.has(current)) {
      return '[Circular Reference]'
    }
    seen.add(current)

    const constructorName = getObjectConstructorName(current)
    if (
      ['Socket', 'TLSSocket', 'HTTPParser', 'IncomingMessage', 'ServerResponse'].includes(
        constructorName
      )
    ) {
      return `[${constructorName} Object]`
    }

    if (Array.isArray(current)) {
      return current.map((item) => walk(item, depth + 1))
    }

    const result = {}
    for (const [key, item] of Object.entries(current)) {
      const safeKey = sanitizeLogString(key)
      if (isSensitiveLogKey(safeKey) && typeof item !== 'boolean') {
        result[safeKey] = REDACTED
        continue
      }

      try {
        result[safeKey] = walk(item, depth + 1)
      } catch (_) {
        result[safeKey] = '[Unable to serialize field]'
      }
    }
    return result
  }

  return walk(value, 0)
}

function stringifyLogValue(value, options = {}) {
  const shouldTruncate = options.truncate !== false

  try {
    const processed = sanitizeLogValue(value, { maxDepth: options.maxDepth })
    const result = JSON.stringify(processed)
    if (!shouldTruncate || result.length <= 50000 || !processed || typeof processed !== 'object') {
      return result
    }

    const truncated = { ...processed, _truncated: true, _totalChars: result.length }
    for (const [key, item] of Object.entries(truncated)) {
      if (key.startsWith('_')) {
        continue
      }
      const fieldString = typeof item === 'string' ? item : JSON.stringify(item)
      if (fieldString && fieldString.length > 10000) {
        truncated[key] = `${fieldString.substring(0, 10000)}...[truncated]`
      }
    }

    let truncatedResult = JSON.stringify(truncated)
    if (truncatedResult.length > 50000) {
      for (const [key, item] of Object.entries(truncated)) {
        if (key.startsWith('_')) {
          continue
        }
        const fieldString = typeof item === 'string' ? item : JSON.stringify(item)
        if (fieldString && fieldString.length > 2000) {
          truncated[key] = `${fieldString.substring(0, 2000)}...[truncated]`
        }
      }
      truncatedResult = JSON.stringify(truncated)
    }
    return truncatedResult
  } catch (error) {
    try {
      return JSON.stringify({
        error: 'Failed to serialize object',
        message: sanitizeLogString(error.message),
        type: typeof value,
        keys: value && typeof value === 'object' ? Object.keys(value) : undefined
      })
    } catch (_) {
      return '{"error":"Critical serialization failure","message":"Unable to serialize any data"}'
    }
  }
}

function getHeader(headers, names) {
  if (!headers) {
    return undefined
  }

  for (const name of names) {
    if (typeof headers.get === 'function') {
      try {
        const value = headers.get(name)
        if (value !== undefined && value !== null && value !== '') {
          return value
        }
      } catch (_) {
        // Fall through to object lookup.
      }
    }

    const matchedKey = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase())
    if (matchedKey) {
      return headers[matchedKey]
    }
  }

  return undefined
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}

function summarizeErrorForLog(error) {
  if (!error || typeof error !== 'object') {
    return { errorMessage: sanitizeLogString(String(error || 'Unknown error')) }
  }

  const responseHeaders = error.response?.headers
  const cause = error.cause
    ? compactObject({
        errorName: error.cause.name,
        errorMessage: error.cause.message,
        errorCode: error.cause.code
      })
    : undefined

  return sanitizeLogValue(
    compactObject({
      errorName: error.name,
      errorMessage: error.message,
      errorCode: error.code,
      status: error.statusCode || error.status || error.response?.status,
      statusText: error.response?.statusText,
      method: error.config?.method,
      url: error.config?.url,
      timeoutMs: error.config?.timeout,
      upstreamRequestId: getHeader(responseHeaders, [
        'x-request-id',
        'request-id',
        'openai-request-id'
      ]),
      retryAfter: getHeader(responseHeaders, ['retry-after']),
      cause,
      errorStack: error.stack
    })
  )
}

function pickIdentityFields(value) {
  if (!value || typeof value !== 'object') {
    return value
  }

  const allowedKeys = ['id', 'uuid', 'name', 'display_name', 'email', 'email_address']
  return compactObject(
    Object.fromEntries(
      allowedKeys.map((key) => [key, value[key]]).filter(([, item]) => item !== undefined)
    )
  )
}

function summarizeOAuthTokenData(data = {}) {
  if (!data || typeof data !== 'object') {
    return { hasData: false }
  }

  return sanitizeLogValue(
    compactObject({
      hasData: true,
      dataKeys: Object.keys(data),
      hasAccessToken: Boolean(data.access_token || data.accessToken),
      hasRefreshToken: Boolean(data.refresh_token || data.refreshToken),
      hasIdToken: Boolean(data.id_token || data.idToken),
      tokenType: data.token_type || data.tokenType,
      expiresIn: data.expires_in || data.expiresIn,
      refreshTokenExpiresIn: data.refresh_token_expires_in || data.refreshTokenExpiresIn,
      scope: data.scope || data.scopes,
      subscription: data.subscription,
      plan: data.plan,
      tier: data.tier,
      accountType: data.account_type || data.accountType,
      features: data.features,
      limits: data.limits,
      organization: pickIdentityFields(data.organization),
      account: pickIdentityFields(data.account)
    })
  )
}

module.exports = {
  REDACTED,
  isSensitiveLogKey,
  sanitizeLogString,
  sanitizeLogValue,
  stringifyLogValue,
  summarizeErrorForLog,
  summarizeOAuthTokenData
}
