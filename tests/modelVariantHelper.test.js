const {
  applyDisplayModelToRecord,
  formatDisplayModelName,
  splitModelStatsByFastMode
} = require('../src/utils/modelVariantHelper')

describe('modelVariantHelper', () => {
  test('formats gpt priority models with a fast suffix', () => {
    expect(formatDisplayModelName('gpt-5.4', 'priority')).toBe('gpt-5.4 (fast)')
    expect(formatDisplayModelName('gpt-5.4', 'standard')).toBe('gpt-5.4')
    expect(formatDisplayModelName('claude-sonnet-4-6', 'priority')).toBe('claude-sonnet-4-6')
  })

  test('applies display model names to request records while preserving the raw model', () => {
    const record = applyDisplayModelToRecord({
      model: 'gpt-5.5',
      serviceTier: 'priority'
    })

    expect(record.rawModel).toBe('gpt-5.5')
    expect(record.model).toBe('gpt-5.5 (fast)')
  })

  test('splits gpt model stats into standard and fast entries', () => {
    const createStats = () => ({
      requests: 0,
      priorityRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
      allTokens: 0,
      ephemeral5mTokens: 0,
      ephemeral1hTokens: 0,
      priorityInputTokens: 0,
      priorityOutputTokens: 0,
      priorityCacheCreateTokens: 0,
      priorityCacheReadTokens: 0,
      priorityEphemeral5mTokens: 0,
      priorityEphemeral1hTokens: 0,
      realCostMicro: 0,
      ratedCostMicro: 0,
      hasStoredCost: false
    })

    const entries = splitModelStatsByFastMode(
      'gpt-5.4',
      {
        requests: 10,
        priorityRequests: 4,
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreateTokens: 200,
        cacheReadTokens: 300,
        allTokens: 2000,
        priorityInputTokens: 400,
        priorityOutputTokens: 200,
        priorityCacheCreateTokens: 80,
        priorityCacheReadTokens: 120
      },
      createStats
    )

    expect(entries).toHaveLength(2)
    expect(entries[0].model).toBe('gpt-5.4')
    expect(entries[0].stats.requests).toBe(6)
    expect(entries[0].stats.inputTokens).toBe(600)
    expect(entries[1].model).toBe('gpt-5.4 (fast)')
    expect(entries[1].serviceTier).toBe('priority')
    expect(entries[1].stats.requests).toBe(4)
    expect(entries[1].stats.inputTokens).toBe(400)
  })

  test('preserves image breakdown fields when splitting standard and fast usage', () => {
    const createStats = () => ({
      requests: 0,
      priorityRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
      priorityInputTokens: 0,
      priorityOutputTokens: 0,
      priorityCacheCreateTokens: 0,
      priorityCacheReadTokens: 0
    })

    const entries = splitModelStatsByFastMode(
      'gpt-image-2',
      {
        requests: 3,
        priorityRequests: 1,
        inputTokens: 120,
        outputTokens: 4000,
        priorityInputTokens: 35,
        priorityOutputTokens: 1000,
        textInputTokens: 20,
        imageInputTokens: 100,
        imageOutputTokens: 4000,
        priorityTextInputTokens: 5,
        priorityImageInputTokens: 30,
        priorityImageOutputTokens: 1000
      },
      createStats
    )

    expect(entries).toHaveLength(2)
    expect(entries[0].stats).toEqual(
      expect.objectContaining({
        textInputTokens: 15,
        imageInputTokens: 70,
        imageOutputTokens: 3000
      })
    )
    expect(entries[1].stats).toEqual(
      expect.objectContaining({
        textInputTokens: 5,
        imageInputTokens: 30,
        imageOutputTokens: 1000
      })
    )
  })

  test('does not add empty image fields when splitting ordinary GPT usage', () => {
    const createStats = () => ({
      requests: 0,
      priorityRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
      priorityInputTokens: 0,
      priorityOutputTokens: 0,
      priorityCacheCreateTokens: 0,
      priorityCacheReadTokens: 0
    })

    const entries = splitModelStatsByFastMode(
      'gpt-5.5',
      {
        requests: 2,
        priorityRequests: 1,
        inputTokens: 100,
        outputTokens: 20,
        priorityInputTokens: 40,
        priorityOutputTokens: 10
      },
      createStats
    )

    for (const entry of entries) {
      expect(entry.stats).not.toHaveProperty('textInputTokens')
      expect(entry.stats).not.toHaveProperty('imageInputTokens')
      expect(entry.stats).not.toHaveProperty('imageOutputTokens')
    }
  })
})
