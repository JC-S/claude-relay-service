const ipaddr = require('ipaddr.js')

function normalizeAddressText(value) {
  let address = String(value || '').trim()

  if (!address) {
    return ''
  }

  if (address.startsWith('[') && address.endsWith(']')) {
    address = address.slice(1, -1)
  }

  // Handle common remoteAddress values such as "127.0.0.1:54321".
  if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(address)) {
    address = address.replace(/:\d+$/, '')
  }

  const zoneIndex = address.indexOf('%')
  if (zoneIndex !== -1) {
    address = address.slice(0, zoneIndex)
  }

  return address
}

function parseAddress(value) {
  const address = normalizeAddressText(value)
  if (!address || !ipaddr.isValid(address)) {
    return null
  }

  const parsed = ipaddr.parse(address)
  if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) {
    return parsed.toIPv4Address()
  }

  return parsed
}

function normalizeParsedAddress(address) {
  return address.toString()
}

function getHeaderValues(req, headerName) {
  const headers = req?.headers || {}
  const expectedName = String(headerName || '').toLowerCase()
  if (!expectedName) {
    return []
  }

  for (const [name, value] of Object.entries(headers)) {
    if (String(name).toLowerCase() !== expectedName) {
      continue
    }

    if (Array.isArray(value)) {
      return value.map((item) => String(item || '').trim()).filter(Boolean)
    }

    const normalized = String(value || '').trim()
    return normalized ? [normalized] : []
  }

  return []
}

function getForwardedIpCandidates(req) {
  const candidates = [
    ...getHeaderValues(req, 'cf-connecting-ip'),
    ...getHeaderValues(req, 'true-client-ip')
  ]

  for (const value of getHeaderValues(req, 'x-forwarded-for')) {
    candidates.push(
      ...String(value)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    )
  }

  return candidates
}

function isLoopbackAddress(value) {
  const parsed = parseAddress(value)
  return Boolean(parsed && parsed.range() === 'loopback')
}

function isFromTrustedLocalProxy(req) {
  const directCandidates = [req?.connection?.remoteAddress, req?.socket?.remoteAddress].filter(
    Boolean
  )

  if (directCandidates.length > 0) {
    return directCandidates.some(isLoopbackAddress)
  }

  return isLoopbackAddress(req?.ip)
}

function parseIpWhitelistEntry(value) {
  const raw = String(value || '').trim()
  if (!raw) {
    return null
  }

  const slashIndex = raw.lastIndexOf('/')
  if (slashIndex === -1) {
    const address = parseAddress(raw)
    return address ? { address, prefix: null } : null
  }

  const addressText = raw.slice(0, slashIndex)
  const prefixText = raw.slice(slashIndex + 1)
  const address = parseAddress(addressText)
  const prefix = Number(prefixText)
  if (!address || !Number.isInteger(prefix)) {
    return null
  }

  const maxPrefix = address.kind() === 'ipv4' ? 32 : 128
  if (prefix < 0 || prefix > maxPrefix) {
    return null
  }

  return { address, prefix }
}

function splitIpWhitelist(value) {
  if (value === undefined || value === null || value === '') {
    return []
  }

  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean)
  }

  if (typeof value !== 'string') {
    return []
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return []
  }

  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item || '').trim()).filter(Boolean)
      }
    } catch (error) {
      // Fall through to delimiter parsing for partially migrated data.
    }
  }

  return trimmed
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function formatEntry(parsed) {
  const address = normalizeParsedAddress(parsed.address)
  return parsed.prefix === null ? address : `${address}/${parsed.prefix}`
}

function normalizeIpWhitelist(value) {
  const normalized = []
  const seen = new Set()

  for (const rawEntry of splitIpWhitelist(value)) {
    const parsed = parseIpWhitelistEntry(rawEntry)
    const entry = parsed ? formatEntry(parsed) : rawEntry
    if (!seen.has(entry)) {
      seen.add(entry)
      normalized.push(entry)
    }
  }

  return normalized
}

function validateIpWhitelist(value) {
  const entries = splitIpWhitelist(value)
  const normalized = []
  const seen = new Set()

  for (const rawEntry of entries) {
    const parsed = parseIpWhitelistEntry(rawEntry)
    if (!parsed) {
      return {
        valid: false,
        error: `Invalid IP whitelist entry: ${rawEntry}`
      }
    }

    const entry = formatEntry(parsed)
    if (!seen.has(entry)) {
      seen.add(entry)
      normalized.push(entry)
    }
  }

  return {
    valid: true,
    entries: normalized
  }
}

function getRequestIp(req) {
  if (isFromTrustedLocalProxy(req)) {
    for (const candidate of getForwardedIpCandidates(req)) {
      const parsed = parseAddress(candidate)
      if (parsed) {
        return normalizeParsedAddress(parsed)
      }
    }
  }

  const candidates = [req?.ip, req?.connection?.remoteAddress, req?.socket?.remoteAddress]

  for (const candidate of candidates) {
    const parsed = parseAddress(candidate)
    if (parsed) {
      return normalizeParsedAddress(parsed)
    }
  }

  return 'unknown'
}

function isIpAllowed(clientIp, whitelist) {
  const clientAddress = parseAddress(clientIp)
  if (!clientAddress) {
    return false
  }

  for (const rawEntry of splitIpWhitelist(whitelist)) {
    const entry = parseIpWhitelistEntry(rawEntry)
    if (!entry || entry.address.kind() !== clientAddress.kind()) {
      continue
    }

    if (entry.prefix === null) {
      if (normalizeParsedAddress(clientAddress) === normalizeParsedAddress(entry.address)) {
        return true
      }
      continue
    }

    if (clientAddress.match(entry.address, entry.prefix)) {
      return true
    }
  }

  return false
}

module.exports = {
  getRequestIp,
  isIpAllowed,
  normalizeIpWhitelist,
  parseAddress,
  validateIpWhitelist
}
