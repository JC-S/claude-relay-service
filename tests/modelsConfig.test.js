const { CLAUDE_MODELS } = require('../config/models')

describe('models config', () => {
  it('includes the latest Claude Opus and Sonnet options', () => {
    expect(CLAUDE_MODELS[0]).toEqual({
      value: 'claude-opus-4-7',
      label: 'Claude Opus 4.7'
    })
    expect(CLAUDE_MODELS).toContainEqual({
      value: 'claude-sonnet-4-6',
      label: 'Claude Sonnet 4.6'
    })
  })
})
