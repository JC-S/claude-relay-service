jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  success: jest.fn()
}))

const modelService = require('../src/services/modelService')

describe('OpenAI model discovery', () => {
  test('publishes current GPT models without advertising legacy gpt-5-codex', () => {
    const modelIds = modelService.getModelsByProvider('openai').map((model) => model.id)

    expect(modelIds).toEqual(
      expect.arrayContaining(['gpt-5.5', 'gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])
    )
    expect(modelIds).not.toContain('gpt-5-codex')
  })
})
