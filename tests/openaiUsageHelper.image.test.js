jest.mock('../src/utils/logger', () => ({
  warn: jest.fn()
}))

const { normalizeOpenAIImageUsage } = require('../src/utils/openaiUsageHelper')

describe('normalizeOpenAIImageUsage', () => {
  test('preserves a complete text/image breakdown', () => {
    const result = normalizeOpenAIImageUsage(
      {
        input_tokens: 120,
        output_tokens: 4000,
        input_tokens_details: { text_tokens: 20, image_tokens: 100 }
      },
      { endpoint: 'edits' }
    )

    expect(result).toEqual(
      expect.objectContaining({
        inputTokens: 120,
        outputTokens: 4000,
        textInputTokens: 20,
        imageInputTokens: 100,
        imageOutputTokens: 4000,
        imageUsageBreakdownEstimated: false
      })
    )
    expect(result.image_usage).toEqual({
      textInputTokens: 20,
      imageInputTokens: 100,
      imageOutputTokens: 4000,
      estimated: false
    })
  })

  test('deducts included cache tokens from text before image input', () => {
    const result = normalizeOpenAIImageUsage(
      {
        input_tokens: 120,
        output_tokens: 10,
        input_tokens_details: {
          text_tokens: 20,
          image_tokens: 100,
          cached_tokens: 15
        }
      },
      { endpoint: 'edits' }
    )

    expect(result.inputTokens).toBe(105)
    expect(result.cacheReadTokens).toBe(15)
    expect(result.textInputTokens).toBe(5)
    expect(result.imageInputTokens).toBe(100)
    expect(result.textInputTokens + result.imageInputTokens).toBe(result.inputTokens)
  })

  test('treats missing generation input details as estimated text input', () => {
    const result = normalizeOpenAIImageUsage(
      { input_tokens: 30, output_tokens: 100 },
      { endpoint: 'generations' }
    )

    expect(result.textInputTokens).toBe(30)
    expect(result.imageInputTokens).toBe(0)
    expect(result.imageUsageBreakdownEstimated).toBe(true)
  })

  test('treats missing edit input details as estimated image input', () => {
    const result = normalizeOpenAIImageUsage(
      { input_tokens: 30, output_tokens: 100 },
      { endpoint: 'edits' }
    )

    expect(result.textInputTokens).toBe(0)
    expect(result.imageInputTokens).toBe(30)
    expect(result.imageUsageBreakdownEstimated).toBe(true)
  })

  test('uses total input as authoritative when the upstream breakdown mismatches', () => {
    const result = normalizeOpenAIImageUsage(
      {
        input_tokens: 100,
        output_tokens: 1,
        input_tokens_details: { text_tokens: 90, image_tokens: 80 }
      },
      { endpoint: 'edits' }
    )

    expect(result.textInputTokens).toBe(20)
    expect(result.imageInputTokens).toBe(80)
    expect(result.isConsistent).toBe(false)
  })
})
