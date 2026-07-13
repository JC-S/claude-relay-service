const {
  CLAUDE_MODELS,
  OPENAI_CODEX_TEST_MODELS,
  PLATFORM_TEST_MODELS
} = require('../config/models')

describe('models config', () => {
  it('includes the latest Claude Opus and Sonnet options', () => {
    expect(CLAUDE_MODELS[0]).toEqual({
      value: 'claude-opus-4-8',
      label: 'Claude Opus 4.8'
    })
    expect(CLAUDE_MODELS).toContainEqual({
      value: 'claude-opus-4-7',
      label: 'Claude Opus 4.7'
    })
    expect(CLAUDE_MODELS).toContainEqual({
      value: 'claude-sonnet-4-6',
      label: 'Claude Sonnet 4.6'
    })
  })

  it('offers OpenAI test models newest first', () => {
    expect(OPENAI_CODEX_TEST_MODELS).toEqual([
      { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
      { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
      { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
      { value: 'gpt-5.5', label: 'GPT-5.5' },
      { value: 'gpt-5.4', label: 'GPT-5.4' },
      { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
      { value: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' }
    ])
    expect(PLATFORM_TEST_MODELS.openai).toBe(OPENAI_CODEX_TEST_MODELS)
  })
})
