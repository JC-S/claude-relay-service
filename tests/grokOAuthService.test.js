jest.mock('../src/models/redis', () => ({
  setOAuthSession: jest.fn(),
  getOAuthSession: jest.fn(),
  deleteOAuthSession: jest.fn()
}))
jest.mock('axios', () => ({ post: jest.fn() }))
jest.mock('../src/utils/proxyHelper', () => ({ createProxyAgent: jest.fn(() => null) }))

const axios = require('axios')
const redis = require('../src/models/redis')
const grokOAuthService = require('../src/services/grokOAuthService')
const { parseAuthorizationInput, normalizeTokens } = require('../src/services/grokOAuthService')

describe('grokOAuthService', () => {
  beforeEach(() => jest.clearAllMocks())

  test('creates a PKCE session with a 30 minute TTL', async () => {
    const result = await grokOAuthService.generateAuthorizationSession({ type: 'http' })
    expect(result.authUrl).toContain('https://auth.x.ai/oauth2/authorize?')
    expect(result.authUrl).toContain('code_challenge_method=S256')
    expect(redis.setOAuthSession).toHaveBeenCalledWith(
      result.sessionId,
      expect.objectContaining({ platform: 'grok', codeVerifier: expect.any(String) }),
      1800
    )
  })

  test('accepts callback URLs, query strings and bare authorization codes', () => {
    expect(parseAuthorizationInput('http://127.0.0.1/callback?code=abc&state=state')).toEqual({
      code: 'abc',
      state: 'state',
      requiresState: true
    })
    expect(parseAuthorizationInput('code=abc&state=state').code).toBe('abc')
    expect(parseAuthorizationInput('bare-code')).toEqual({
      code: 'bare-code',
      state: '',
      requiresState: false
    })
  })

  test('rejects a callback with missing or mismatched state before token exchange', async () => {
    redis.getOAuthSession.mockResolvedValue({
      platform: 'grok',
      state: 'expected',
      codeVerifier: 'verifier',
      redirectUri: 'http://127.0.0.1:56121/callback',
      expiresAt: new Date(Date.now() + 60000).toISOString()
    })
    await expect(grokOAuthService.exchangeCode('session', 'code=abc&state=wrong')).rejects.toThrow(
      'OAuth state mismatch'
    )
    expect(axios.post).not.toHaveBeenCalled()
  })

  test('exchanges a bare code using the server-side verifier and deletes the session', async () => {
    redis.getOAuthSession.mockResolvedValue({
      platform: 'grok',
      state: 'expected',
      codeVerifier: 'verifier',
      redirectUri: 'http://127.0.0.1:56121/callback',
      expiresAt: new Date(Date.now() + 60000).toISOString()
    })
    axios.post.mockResolvedValue({
      data: { access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }
    })
    const tokens = await grokOAuthService.exchangeCode('session', 'bare-code')
    expect(tokens.accessToken).toBe('access')
    expect(tokens.refreshToken).toBe('refresh')
    expect(axios.post.mock.calls[0][1]).toContain('code_verifier=verifier')
    expect(redis.deleteOAuthSession).toHaveBeenCalledWith('session')
  })

  test('retains a rotating refresh token when the response omits it', () => {
    expect(normalizeTokens({ access_token: 'new' }, 'old-refresh').refreshToken).toBe('old-refresh')
  })
})
