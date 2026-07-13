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

  it('offers GPT-5.6 Luna for OpenAI API key and OAuth account tests', () => {
    const luna = { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' }

    expect(OPENAI_CODEX_TEST_MODELS).toContainEqual(luna)
    expect(PLATFORM_TEST_MODELS.openai).toContainEqual(luna)
  })
})
