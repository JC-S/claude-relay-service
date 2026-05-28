const CACHE_KEY = 'claude_code_user_agent:daily'
const MAX_VERSION_LAG = 10

function extractClaudeCodeVersion(userAgent) {
  if (typeof userAgent !== 'string') {
    return null
  }

  const match = userAgent.match(/^claude-cli\/(\d+(?:\.\d+)+)/i)
  if (!match) {
    return null
  }

  const parts = match[1].split('.').map((part) => parseInt(part, 10))
  if (parts.some((part) => !Number.isFinite(part))) {
    return null
  }

  return {
    raw: match[1],
    parts
  }
}

function compareVersionParts(left, right) {
  const maxLength = Math.max(left.length, right.length)
  for (let i = 0; i < maxLength; i++) {
    const leftPart = left[i] || 0
    const rightPart = right[i] || 0
    if (leftPart > rightPart) {
      return 1
    }
    if (leftPart < rightPart) {
      return -1
    }
  }
  return 0
}

function getMinimumAllowedVersion(cachedVersion, maxLag = MAX_VERSION_LAG) {
  if (!cachedVersion?.parts?.length) {
    return null
  }

  const parts = [...cachedVersion.parts]
  const lastIndex = parts.length - 1
  parts[lastIndex] = Math.max(0, parts[lastIndex] - maxLag)

  return {
    raw: parts.join('.'),
    parts
  }
}

function getClaudeCodeVersionGateResult(
  clientUserAgent,
  cachedUserAgent,
  maxLag = MAX_VERSION_LAG
) {
  const clientVersion = extractClaudeCodeVersion(clientUserAgent)
  const cachedVersion = extractClaudeCodeVersion(cachedUserAgent)
  const minimumAllowedVersion = getMinimumAllowedVersion(cachedVersion, maxLag)

  if (!clientVersion || !cachedVersion || !minimumAllowedVersion) {
    return {
      blocked: false,
      clientVersion: clientVersion?.raw || null,
      cachedVersion: cachedVersion?.raw || null,
      minimumAllowedVersion: minimumAllowedVersion?.raw || null
    }
  }

  return {
    blocked: compareVersionParts(clientVersion.parts, minimumAllowedVersion.parts) < 0,
    clientVersion: clientVersion.raw,
    cachedVersion: cachedVersion.raw,
    minimumAllowedVersion: minimumAllowedVersion.raw
  }
}

module.exports = {
  CACHE_KEY,
  MAX_VERSION_LAG,
  extractClaudeCodeVersion,
  compareVersionParts,
  getMinimumAllowedVersion,
  getClaudeCodeVersionGateResult
}
