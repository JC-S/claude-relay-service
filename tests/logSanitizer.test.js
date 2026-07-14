const {
  REDACTED,
  isSensitiveLogKey,
  sanitizeLogString,
  sanitizeLogValue,
  stringifyLogValue,
  summarizeErrorForLog,
  summarizeOAuthTokenData
} = require('../src/utils/logSanitizer')

const JWT =
  'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMzQ1Njc4OTAifQ.signature0123456789abcdefghijklmnopqrstuvwxyz'
const API_KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789'
const REFRESH_TOKEN = 'opaque-refresh-token-abcdefghijklmnopqrstuvwxyz'

describe('logSanitizer', () => {
  test('redacts nested credentials by case-insensitive key without mutating input', () => {
    const input = {
      headers: {
        Authorization: `Bearer ${JWT}`,
        'X-API-Key': API_KEY,
        'Content-Type': 'application/json'
      },
      oauth: {
        refresh_token: REFRESH_TOKEN,
        expires_in: 3600
      },
      input_tokens: 42
    }

    const sanitized = sanitizeLogValue(input)

    expect(sanitized.headers.Authorization).toBe(REDACTED)
    expect(sanitized.headers['X-API-Key']).toBe(REDACTED)
    expect(sanitized.headers['Content-Type']).toBe('application/json')
    expect(sanitized.oauth.refresh_token).toBe(REDACTED)
    expect(sanitized.oauth.expires_in).toBe(3600)
    expect(sanitized.input_tokens).toBe(42)
    expect(input.headers.Authorization).toBe(`Bearer ${JWT}`)
    expect(input.oauth.refresh_token).toBe(REFRESH_TOKEN)
  })

  test('redacts credentials embedded in free-form and serialized strings', () => {
    const message = [
      `Authorization: Bearer ${JWT}`,
      `jwt=${JWT}`,
      `url=https://example.test/callback?access_token=${REFRESH_TOKEN}&ok=1`,
      `json={"refresh_token":"${REFRESH_TOKEN}"}`,
      `escaped={\\"access_token\\":\\"${REFRESH_TOKEN}\\"}`,
      `apiKey=${API_KEY}`
    ].join(' ')

    const sanitized = sanitizeLogString(message)

    expect(sanitized).not.toContain(JWT)
    expect(sanitized).not.toContain(REFRESH_TOKEN)
    expect(sanitized).not.toContain(API_KEY)
    expect(sanitized).toContain(REDACTED)
    expect(sanitized).toContain('&ok=1')
  })

  test('preserves valid Unicode pairs while removing isolated surrogates', () => {
    expect(sanitizeLogString('✅ 🚀 safe\uD800text\uDC00')).toBe('✅ 🚀 safetext')
  })

  test('sanitizes before truncating a large Axios-style object', () => {
    const output = stringifyLogValue({
      name: 'AxiosError',
      config: {
        headers: { authorization: `Bearer ${JWT}` },
        data: 'x'.repeat(70000),
        httpsAgent: { sessionCache: 'y'.repeat(20000) }
      },
      request: { rawHeaders: `Authorization: Bearer ${JWT}`, body: 'z'.repeat(30000) }
    })

    expect(output).not.toContain(JWT)
    expect(output).toContain(REDACTED)
    expect(JSON.parse(output)._truncated).toBe(true)
  })

  test('reduces an Axios error to diagnostic allowlisted fields', () => {
    const error = new Error(`timeout while using Bearer ${JWT}`)
    error.name = 'AxiosError'
    error.code = 'ECONNABORTED'
    error.config = {
      method: 'post',
      url: `https://chatgpt.com/backend-api/codex/responses?access_token=${REFRESH_TOKEN}`,
      timeout: 600000,
      headers: { authorization: `Bearer ${JWT}` },
      data: 'sensitive request body'
    }
    error.request = { socket: 'large internal state' }
    error.response = {
      status: 504,
      statusText: 'Gateway Timeout',
      headers: {
        'x-request-id': 'req_test_123',
        'set-cookie': 'session=secret'
      },
      data: { access_token: JWT }
    }

    const summary = summarizeErrorForLog(error)
    const serialized = JSON.stringify(summary)

    expect(summary).toMatchObject({
      errorName: 'AxiosError',
      errorCode: 'ECONNABORTED',
      status: 504,
      method: 'post',
      timeoutMs: 600000,
      upstreamRequestId: 'req_test_123'
    })
    expect(summary).not.toHaveProperty('config')
    expect(summary).not.toHaveProperty('request')
    expect(summary).not.toHaveProperty('response')
    expect(serialized).not.toContain(JWT)
    expect(serialized).not.toContain(REFRESH_TOKEN)
    expect(summary.url).toContain(`access_token=${REDACTED}`)
  })

  test('keeps OAuth diagnostics while dropping all token values', () => {
    const summary = summarizeOAuthTokenData({
      access_token: JWT,
      refresh_token: REFRESH_TOKEN,
      id_token: JWT,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token_expires_in: 2592000,
      scope: 'user:inference user:profile',
      organization: { id: 'org_1', name: 'Example', secret: 'hidden' },
      account: { id: 'account_1', email_address: 'user@example.com', token: JWT },
      plan: 'max'
    })
    const serialized = JSON.stringify(summary)

    expect(summary).toMatchObject({
      hasAccessToken: true,
      hasRefreshToken: true,
      hasIdToken: true,
      tokenType: 'Bearer',
      expiresIn: 3600,
      refreshTokenExpiresIn: 2592000,
      plan: 'max',
      organization: { id: 'org_1', name: 'Example' },
      account: { id: 'account_1', email_address: 'user@example.com' }
    })
    expect(serialized).not.toContain(JWT)
    expect(serialized).not.toContain(REFRESH_TOKEN)
  })

  test.each([
    'Authorization',
    'proxy-authorization',
    'X-API-Key',
    'access_token',
    'refreshToken',
    'client-secret',
    'password'
  ])('recognizes sensitive key %s', (key) => {
    expect(isSensitiveLogKey(key)).toBe(true)
  })
})
