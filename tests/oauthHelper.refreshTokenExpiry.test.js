jest.mock('axios', () => ({
  post: jest.fn()
}))

jest.mock('../src/utils/proxyHelper', () => ({
  createProxyAgent: jest.fn(() => null),
  maskProxyInfo: jest.fn(() => 'masked-proxy')
}))

jest.mock('../src/utils/logger', () => ({
  authDetail: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))

const axios = require('axios')
const {
  exchangeCodeForTokens,
  exchangeSetupTokenCode,
  formatClaudeCredentials,
  resolveRefreshTokenExpiresAt
} = require('../src/utils/oauthHelper')

describe('Claude OAuth Refresh Token expiry parsing', () => {
  const receivedAtMs = Date.parse('2026-07-13T00:00:00.000Z')

  beforeEach(() => {
    jest.clearAllMocks()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  test.each([
    [60, '2026-07-13T00:01:00.000Z'],
    ['3600', '2026-07-13T01:00:00.000Z'],
    [0, '2026-07-13T00:00:00.000Z']
  ])('converts %p seconds to an absolute ISO timestamp', (expiresIn, expected) => {
    expect(resolveRefreshTokenExpiresAt(expiresIn, receivedAtMs)).toBe(expected)
  })

  test.each([
    undefined,
    null,
    '',
    '   ',
    true,
    false,
    -1,
    '-1',
    Number.NaN,
    Number.POSITIVE_INFINITY,
    'Infinity',
    'not-a-number',
    1e20,
    {}
  ])('rejects invalid expiry value %p', (value) => {
    expect(resolveRefreshTokenExpiresAt(value, receivedAtMs)).toBeNull()
  })

  test('rejects an invalid response receipt time', () => {
    expect(resolveRefreshTokenExpiresAt(60, Number.NaN)).toBeNull()
  })

  test('includes the absolute expiry in an OAuth code exchange result', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(receivedAtMs)
    axios.post.mockResolvedValue({
      status: 200,
      data: {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 3600,
        refresh_token_expires_in: '86400',
        scope: 'user:profile user:inference'
      }
    })

    const result = await exchangeCodeForTokens('authorization-code', 'verifier', 'state')

    expect(result.refreshTokenExpiresAt).toBe('2026-07-14T00:00:00.000Z')
  })

  test('omits the expiry when the OAuth response has no valid lifetime', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(receivedAtMs)
    axios.post.mockResolvedValue({
      status: 200,
      data: {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 3600,
        refresh_token_expires_in: ' ',
        scope: 'user:profile user:inference'
      }
    })

    const result = await exchangeCodeForTokens('authorization-code', 'verifier', 'state')

    expect(result).not.toHaveProperty('refreshTokenExpiresAt')
  })

  test('never adds a Refresh Token expiry to Setup Token exchange results', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(receivedAtMs)
    axios.post.mockResolvedValue({
      status: 200,
      data: {
        access_token: 'setup-token',
        expires_in: 3600,
        refresh_token_expires_in: 86400,
        scope: 'user:inference'
      }
    })

    const result = await exchangeSetupTokenCode('authorization-code', 'verifier', 'state')

    expect(result).not.toHaveProperty('refreshTokenExpiresAt')
  })

  test('formatClaudeCredentials preserves the normalized expiry only when present', () => {
    const baseTokenData = {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: receivedAtMs,
      scopes: ['user:profile', 'user:inference'],
      isMax: true
    }

    expect(
      formatClaudeCredentials({
        ...baseTokenData,
        refreshTokenExpiresAt: '2026-08-01T00:00:00.000Z'
      }).claudeAiOauth.refreshTokenExpiresAt
    ).toBe('2026-08-01T00:00:00.000Z')
    expect(formatClaudeCredentials(baseTokenData).claudeAiOauth).not.toHaveProperty(
      'refreshTokenExpiresAt'
    )
  })
})
