const { getRateLimitModelFamily, RATE_LIMITED_MODEL_FAMILIES } = require('../src/utils/modelHelper')

describe('getRateLimitModelFamily', () => {
  test.each([
    ['claude-opus-4-8', 'opus'],
    ['claude-sonnet-4-6', 'sonnet'],
    ['claude-3-5-haiku-20241022', 'haiku'],
    ['claude-fable-5', 'fable'],
    ['claude-fable-5[1m]', 'fable'],
    ['CCR,CLAUDE-SONNET-4-6', 'sonnet']
  ])('maps %s to %s', (model, family) => {
    expect(getRateLimitModelFamily(model)).toBe(family)
  })

  test.each(['deepseek-chat', '', null, undefined, 123])(
    'returns null for unknown or invalid model %p',
    (model) => {
      expect(getRateLimitModelFamily(model)).toBeNull()
    }
  )

  test('exports the supported independent rate-limit families', () => {
    expect(RATE_LIMITED_MODEL_FAMILIES).toEqual(['opus', 'sonnet', 'haiku', 'fable'])
  })
})
