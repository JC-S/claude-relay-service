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
})
