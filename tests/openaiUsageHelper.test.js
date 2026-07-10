jest.mock('../src/utils/logger', () => ({
  warn: jest.fn()
}))

const { normalizeOpenAIUsage } = require('../src/utils/openaiUsageHelper')

describe('normalizeOpenAIUsage', () => {
  test('normalizes Responses cache read and cache write as input subsets', () => {
    expect(
      normalizeOpenAIUsage({
        input_tokens: 100000,
        output_tokens: 10000,
        total_tokens: 110000,
        input_tokens_details: {
          cached_tokens: 20000,
          cache_write_tokens: 30000
        }
      })
    ).toEqual(
      expect.objectContaining({
        totalInputTokens: 100000,
        inputTokens: 50000,
        outputTokens: 10000,
        cacheReadTokens: 20000,
        cacheCreateTokens: 30000,
        totalTokens: 110000,
        upstreamTotalTokens: 110000,
        cacheReadSource: 'input_tokens_details.cached_tokens',
        cacheCreateSource: 'input_tokens_details.cache_write_tokens',
        cacheReadIncludedInInput: true,
        cacheWriteIncludedInInput: true,
        isConsistent: true
      })
    )
  })

  test('normalizes Chat Completions cache fields', () => {
    const result = normalizeOpenAIUsage({
      prompt_tokens: 100,
      completion_tokens: 10,
      prompt_tokens_details: {
        cached_token: 20,
        cache_write_tokens: 30
      }
    })

    expect(result.inputTokens).toBe(50)
    expect(result.cacheReadTokens).toBe(20)
    expect(result.cacheCreateTokens).toBe(30)
    expect(result.outputTokens).toBe(10)
    expect(result.totalTokens).toBe(110)
  })

  test.each(['cache_creation_tokens', 'cache_creation_input_tokens'])(
    'supports nested %s cache-write compatibility field',
    (field) => {
      const result = normalizeOpenAIUsage({
        input_tokens: 50,
        output_tokens: 5,
        input_tokens_details: { [field]: 15 }
      })

      expect(result.inputTokens).toBe(35)
      expect(result.cacheCreateTokens).toBe(15)
      expect(result.cacheWriteIncludedInInput).toBe(true)
    }
  )

  test('treats Anthropic-style top-level cache fields as independent components', () => {
    const result = normalizeOpenAIUsage({
      input_tokens: 50,
      output_tokens: 10,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 30
    })

    expect(result.inputTokens).toBe(50)
    expect(result.cacheReadTokens).toBe(20)
    expect(result.cacheCreateTokens).toBe(30)
    expect(result.cacheReadIncludedInInput).toBe(false)
    expect(result.cacheWriteIncludedInInput).toBe(false)
    expect(result.totalTokens).toBe(110)
  })

  test('treats top-level cache_write_tokens as an input subset', () => {
    const result = normalizeOpenAIUsage({
      input_tokens: 100,
      output_tokens: 10,
      cache_write_tokens: 30
    })

    expect(result.inputTokens).toBe(70)
    expect(result.cacheCreateTokens).toBe(30)
    expect(result.cacheWriteIncludedInInput).toBe(true)
    expect(result.totalTokens).toBe(110)
  })

  test('tracks mixed cache field inclusion independently', () => {
    const result = normalizeOpenAIUsage({
      input_tokens: 100,
      output_tokens: 10,
      cache_creation_input_tokens: 30,
      input_tokens_details: { cached_tokens: 20 }
    })

    expect(result.inputTokens).toBe(80)
    expect(result.cacheReadIncludedInInput).toBe(true)
    expect(result.cacheWriteIncludedInInput).toBe(false)
    expect(result.totalTokens).toBe(140)
  })

  test('does not replace a high-priority zero with a lower-priority value', () => {
    const result = normalizeOpenAIUsage({
      input_tokens: 100,
      output_tokens: 0,
      cache_creation_input_tokens: 40,
      input_tokens_details: {
        cached_tokens: 0,
        cache_write_tokens: 0
      },
      prompt_tokens_details: {
        cached_tokens: 20,
        cache_write_tokens: 30
      }
    })

    expect(result.cacheReadTokens).toBe(0)
    expect(result.cacheCreateTokens).toBe(0)
    expect(result.inputTokens).toBe(100)
  })

  test('accepts numeric strings and skips invalid higher-priority values', () => {
    const result = normalizeOpenAIUsage({
      input_tokens: '100',
      output_tokens: '10',
      input_tokens_details: {
        cached_tokens: -5,
        cache_write_tokens: Infinity
      },
      prompt_tokens_details: {
        cached_tokens: '20',
        cache_write_tokens: '30'
      }
    })

    expect(result.inputTokens).toBe(50)
    expect(result.outputTokens).toBe(10)
    expect(result.cacheReadTokens).toBe(20)
    expect(result.cacheCreateTokens).toBe(30)
  })

  test.each([null, '', 'not-a-number', NaN, Infinity, -1])(
    'normalizes an invalid standalone token value (%s) to zero',
    (value) => {
      const result = normalizeOpenAIUsage({ input_tokens: value })

      expect(result.totalInputTokens).toBe(0)
      expect(result.inputTokens).toBe(0)
      expect(result.totalTokens).toBe(0)
    }
  )

  test('clamps regular input to zero when cache subsets exceed total input', () => {
    const result = normalizeOpenAIUsage({
      input_tokens: 40,
      output_tokens: 10,
      input_tokens_details: {
        cached_tokens: 30,
        cache_write_tokens: 20
      }
    })

    expect(result.inputTokens).toBe(0)
    expect(result.totalTokens).toBe(60)
    expect(result.isConsistent).toBe(false)
  })

  test('uses normalized totals when upstream total_tokens is absent or inconsistent', () => {
    const withoutUpstreamTotal = normalizeOpenAIUsage({
      input_tokens: 100,
      output_tokens: 10
    })
    const mismatchedUpstreamTotal = normalizeOpenAIUsage({
      input_tokens: 100,
      output_tokens: 10,
      total_tokens: 999
    })

    expect(withoutUpstreamTotal.totalTokens).toBe(110)
    expect(withoutUpstreamTotal.upstreamTotalTokens).toBeNull()
    expect(withoutUpstreamTotal.isConsistent).toBe(true)
    expect(mismatchedUpstreamTotal.totalTokens).toBe(110)
    expect(mismatchedUpstreamTotal.upstreamTotalTokens).toBe(999)
    expect(mismatchedUpstreamTotal.isConsistent).toBe(false)
  })
})
