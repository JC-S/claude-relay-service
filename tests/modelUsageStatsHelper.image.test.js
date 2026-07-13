const {
  buildUsagePayloadFromStats,
  createModelUsageStats,
  hasImageUsageBreakdown,
  mergeModelUsageStats,
  sumModelUsageTokens
} = require('../src/utils/modelUsageStatsHelper')

describe('modelUsageStatsHelper image aggregation', () => {
  test('merges standard and priority image fields across hashes', () => {
    const stats = createModelUsageStats()

    mergeModelUsageStats(stats, {
      requests: '1',
      inputTokens: '70',
      outputTokens: '1000',
      textInputTokens: '10',
      imageInputTokens: '60',
      imageOutputTokens: '1000',
      priorityTextInputTokens: '3',
      priorityImageInputTokens: '20',
      priorityImageOutputTokens: '400',
      realCostMicro: '30530',
      ratedCostMicro: '30530'
    })
    mergeModelUsageStats(stats, {
      requests: '2',
      inputTokens: '50',
      outputTokens: '3000',
      textInputTokens: '10',
      imageInputTokens: '40',
      imageOutputTokens: '3000',
      priorityTextInputTokens: '2',
      priorityImageInputTokens: '10',
      priorityImageOutputTokens: '600',
      realCostMicro: '90370',
      ratedCostMicro: '90370'
    })

    expect(stats).toEqual(
      expect.objectContaining({
        requests: 3,
        inputTokens: 120,
        outputTokens: 4000,
        textInputTokens: 20,
        imageInputTokens: 100,
        imageOutputTokens: 4000,
        priorityTextInputTokens: 5,
        priorityImageInputTokens: 30,
        priorityImageOutputTokens: 1000,
        realCostMicro: 120900,
        ratedCostMicro: 120900,
        hasStoredCost: true
      })
    )
  })

  test('does not add image fields or image_usage to ordinary model stats', () => {
    const stats = createModelUsageStats()
    mergeModelUsageStats(stats, { inputTokens: '100', outputTokens: '20' })

    expect(hasImageUsageBreakdown(stats)).toBe(false)
    expect(stats).not.toHaveProperty('textInputTokens')
    expect(stats).not.toHaveProperty('imageInputTokens')
    expect(stats).not.toHaveProperty('imageOutputTokens')
    expect(buildUsagePayloadFromStats(stats)).not.toHaveProperty('image_usage')
  })

  test('preserves zero-valued image fields as image breakdown semantics', () => {
    const stats = createModelUsageStats()
    mergeModelUsageStats(stats, {
      inputTokens: '0',
      outputTokens: '0',
      textInputTokens: '0',
      imageInputTokens: '0',
      imageOutputTokens: '0'
    })

    expect(hasImageUsageBreakdown(stats)).toBe(true)
    expect(buildUsagePayloadFromStats(stats).image_usage).toEqual({
      textInputTokens: 0,
      imageInputTokens: 0,
      imageOutputTokens: 0,
      estimated: false
    })
  })

  test('builds the existing image usage and detailed cache payload shape', () => {
    const usage = buildUsagePayloadFromStats({
      inputTokens: '120',
      outputTokens: '4000',
      cacheCreateTokens: '7',
      cacheReadTokens: '11',
      ephemeral5mTokens: '3',
      ephemeral1hTokens: '4',
      textInputTokens: '20',
      imageInputTokens: '100',
      imageOutputTokens: '4000'
    })

    expect(usage).toEqual({
      input_tokens: 120,
      output_tokens: 4000,
      cache_creation_input_tokens: 7,
      cache_read_input_tokens: 11,
      cache_creation: {
        ephemeral_5m_input_tokens: 3,
        ephemeral_1h_input_tokens: 4
      },
      image_usage: {
        textInputTokens: 20,
        imageInputTokens: 100,
        imageOutputTokens: 4000,
        estimated: false
      }
    })
  })

  test('sums mutually exclusive token fields and ignores redundant allTokens and image fields', () => {
    expect(
      sumModelUsageTokens({
        inputTokens: '120',
        outputTokens: '4000',
        cacheCreateTokens: '7',
        cacheReadTokens: '11',
        allTokens: '999999',
        textInputTokens: '20',
        imageInputTokens: '100',
        imageOutputTokens: '4000'
      })
    ).toBe(4138)
  })

  test('treats missing and invalid numeric values as zero without producing NaN', () => {
    const stats = createModelUsageStats()
    mergeModelUsageStats(stats, {
      requests: 'invalid',
      inputTokens: undefined,
      outputTokens: Infinity,
      cacheCreateTokens: null,
      cacheReadTokens: '12',
      textInputTokens: 'invalid',
      imageInputTokens: '5',
      imageOutputTokens: NaN
    })

    expect(stats.requests).toBe(0)
    expect(stats.inputTokens).toBe(0)
    expect(stats.outputTokens).toBe(0)
    expect(stats.cacheReadTokens).toBe(12)
    expect(stats.textInputTokens).toBe(0)
    expect(stats.imageInputTokens).toBe(5)
    expect(stats.imageOutputTokens).toBe(0)
    expect(sumModelUsageTokens(stats)).toBe(12)
  })
})
