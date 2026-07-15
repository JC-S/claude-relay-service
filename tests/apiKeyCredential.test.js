const {
  API_KEY_MAX_LENGTH,
  validateApiKeyCredential,
  validateCustomApiKey
} = require('../src/utils/apiKeyCredential')

describe('API key credential validation', () => {
  test.each(['x', 'custom key with spaces', 'A'.repeat(API_KEY_MAX_LENGTH)])(
    'accepts a valid credential: %p',
    (value) => {
      expect(validateApiKeyCredential(value)).toMatchObject({ valid: true })
      expect(validateCustomApiKey(value)).toMatchObject({ valid: true })
    }
  )

  test.each([
    ['', 'EMPTY'],
    ['A'.repeat(API_KEY_MAX_LENGTH + 1), 'TOO_LONG'],
    [' leading', 'EDGE_WHITESPACE'],
    ['trailing ', 'EDGE_WHITESPACE'],
    ['Bearer secret', 'BEARER_PREFIX'],
    ['bearer\tsecret', 'NON_ASCII'],
    ['unicode-密钥', 'NON_ASCII'],
    ['line\nbreak', 'NON_ASCII']
  ])('rejects invalid custom credential %p as %s', (value, code) => {
    expect(validateCustomApiKey(value)).toMatchObject({ valid: false, code })
  })
})
