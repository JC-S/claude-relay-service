const {
  getRequestIp,
  isIpAllowed,
  normalizeIpWhitelist,
  validateIpWhitelist
} = require('../src/utils/ipWhitelistHelper')

describe('ip whitelist helper', () => {
  test('validates and normalizes exact IPs and CIDR ranges', () => {
    const result = validateIpWhitelist([
      '203.0.113.10',
      '203.0.113.0/24',
      '2001:db8::1',
      '2001:db8::/32',
      '::ffff:198.51.100.7'
    ])

    expect(result.valid).toBe(true)
    expect(result.entries).toEqual([
      '203.0.113.10',
      '203.0.113.0/24',
      '2001:db8::1',
      '2001:db8::/32',
      '198.51.100.7'
    ])
  })

  test('rejects invalid whitelist entries', () => {
    const result = validateIpWhitelist(['203.0.113.999'])

    expect(result.valid).toBe(false)
    expect(result.error).toContain('203.0.113.999')
  })

  test('matches exact IPs, IPv4-mapped addresses and CIDR ranges', () => {
    const whitelist = normalizeIpWhitelist(['203.0.113.10', '198.51.100.0/24'])

    expect(isIpAllowed('203.0.113.10', whitelist)).toBe(true)
    expect(isIpAllowed('::ffff:203.0.113.10', whitelist)).toBe(true)
    expect(isIpAllowed('198.51.100.88', whitelist)).toBe(true)
    expect(isIpAllowed('192.0.2.1', whitelist)).toBe(false)
  })

  test('extracts normalized request IP from express request data', () => {
    expect(
      getRequestIp({
        ip: '::ffff:203.0.113.10',
        socket: { remoteAddress: '127.0.0.1' }
      })
    ).toBe('203.0.113.10')
  })

  test('prefers Cloudflare connecting IP from local tunnel requests', () => {
    expect(
      getRequestIp({
        headers: {
          'cf-connecting-ip': '203.0.113.42',
          'x-forwarded-for': '198.51.100.20'
        },
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' }
      })
    ).toBe('203.0.113.42')
  })

  test('falls back to X-Forwarded-For from local proxy requests', () => {
    expect(
      getRequestIp({
        headers: {
          'x-forwarded-for': '198.51.100.20, 127.0.0.1'
        },
        connection: { remoteAddress: '127.0.0.1' }
      })
    ).toBe('198.51.100.20')
  })

  test('does not trust forwarded headers from direct non-local requests', () => {
    expect(
      getRequestIp({
        headers: {
          'cf-connecting-ip': '203.0.113.42'
        },
        ip: '198.51.100.20',
        socket: { remoteAddress: '198.51.100.20' }
      })
    ).toBe('198.51.100.20')
  })
})
