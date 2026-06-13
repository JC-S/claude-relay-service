const { OAUTH_CONFIG, parseCallbackUrl } = require('../src/utils/oauthHelper')

describe('oauthHelper.parseCallbackUrl', () => {
  test('uses current Anthropic OAuth token endpoint', () => {
    expect(OAUTH_CONFIG.TOKEN_URL).toBe('https://platform.claude.com/v1/oauth/token')
  })

  test('extracts code from arbitrary callback URL', () => {
    expect(parseCallbackUrl('https://claude.ai/oauth/callback?state=s1&code=abc_DEF-123')).toBe(
      'abc_DEF-123'
    )
  })

  test('extracts code from query string input', () => {
    expect(parseCallbackUrl('code=abc_DEF-123&state=s1')).toBe('abc_DEF-123')
    expect(parseCallbackUrl('?code=abc_DEF-123&state=s1')).toBe('abc_DEF-123')
  })

  test('accepts common OAuth token characters in direct authorization code', () => {
    expect(parseCallbackUrl('abc.DEF_123-456~789+/=')).toBe('abc.DEF_123-456~789+/=')
  })

  test('rejects direct code with invalid characters', () => {
    expect(() => parseCallbackUrl('abc DEF 123')).toThrow('授权码包含无效字符')
  })
})
