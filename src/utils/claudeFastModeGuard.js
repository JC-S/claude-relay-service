const CLAUDE_FAST_MODE_BETA = 'fast-mode-2026-02-01'
const CLAUDE_FAST_MODE_DISABLED_MESSAGE =
  'Claude Fast Mode is not supported by this service. Disable Fast Mode in your client and retry.'

function getHeaderValues(headers, headerName) {
  if (!headers || typeof headers !== 'object') {
    return []
  }

  const normalizedName = headerName.toLowerCase()
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === normalizedName)
  if (!entry) {
    return []
  }

  return Array.isArray(entry[1]) ? entry[1] : [entry[1]]
}

function hasClaudeFastModeBeta(headers) {
  return getHeaderValues(headers, 'anthropic-beta').some((value) =>
    String(value)
      .split(',')
      .some((feature) => feature.trim().toLowerCase() === CLAUDE_FAST_MODE_BETA)
  )
}

function hasClaudeFastModeSpeed(body) {
  return (
    body &&
    typeof body === 'object' &&
    typeof body.speed === 'string' &&
    body.speed.trim().toLowerCase() === 'fast'
  )
}

function isClaudeFastModeRequest(body, headers) {
  return hasClaudeFastModeSpeed(body) || hasClaudeFastModeBeta(headers)
}

function buildClaudeFastModeDisabledResponse() {
  return {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: CLAUDE_FAST_MODE_DISABLED_MESSAGE
    }
  }
}

module.exports = {
  CLAUDE_FAST_MODE_BETA,
  CLAUDE_FAST_MODE_DISABLED_MESSAGE,
  buildClaudeFastModeDisabledResponse,
  hasClaudeFastModeBeta,
  hasClaudeFastModeSpeed,
  isClaudeFastModeRequest
}
