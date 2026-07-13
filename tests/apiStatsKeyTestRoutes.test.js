const mockRouter = { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() }

jest.mock('express', () => ({ Router: () => mockRouter }), { virtual: true })
jest.mock('../src/models/redis', () => ({}))
jest.mock('../src/services/apiKeyService', () => ({
  validateApiKeyForStats: jest.fn(),
  hasPermission: jest.fn()
}))
jest.mock('../src/services/account/claudeAccountService', () => ({}))
jest.mock('../src/services/account/openaiAccountService', () => ({}))
jest.mock('../src/services/serviceRatesService', () => ({}))
jest.mock('../src/services/apiKeyConnectivityTestService', () => ({
  sanitizeMaxTokens: jest.fn((value) =>
    [100, 500, 1000, 2000, 4096].includes(Number(value)) ? Number(value) : 1000
  ),
  runClaudeKeyTest: jest.fn(),
  runGeminiKeyTest: jest.fn(),
  runOpenAIKeyTest: jest.fn()
}))
jest.mock('../src/utils/logger', () => ({
  api: jest.fn(),
  error: jest.fn(),
  security: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn()
}))

const apiKeyService = require('../src/services/apiKeyService')
const connectivityService = require('../src/services/apiKeyConnectivityTestService')
require('../src/routes/apiStats')

const routes = {
  claude: mockRouter.post.mock.calls.find((call) => call[0] === '/api-key/test')[1],
  gemini: mockRouter.post.mock.calls.find((call) => call[0] === '/api-key/test-gemini')[1],
  openai: mockRouter.post.mock.calls.find((call) => call[0] === '/api-key/test-openai')[1]
}

function createRes() {
  const res = {
    statusCode: 200,
    body: null,
    headersSent: false,
    status: jest.fn((code) => {
      res.statusCode = code
      return res
    }),
    json: jest.fn((body) => {
      res.body = body
      return res
    }),
    write: jest.fn(),
    end: jest.fn()
  }
  return res
}

describe('legacy public API key connectivity routes', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    apiKeyService.validateApiKeyForStats.mockResolvedValue({
      valid: true,
      keyData: { id: 'child-1', name: 'test', permissions: [] }
    })
    apiKeyService.hasPermission.mockReturnValue(true)
    connectivityService.runClaudeKeyTest.mockResolvedValue()
    connectivityService.runGeminiKeyTest.mockResolvedValue()
    connectivityService.runOpenAIKeyTest.mockResolvedValue()
  })

  test.each(Object.entries(routes))(
    '%s keeps missing and malformed key responses',
    async (_, handler) => {
      const missing = createRes()
      await handler({ body: {} }, missing)
      expect(missing.statusCode).toBe(400)
      expect(missing.body).toEqual({
        error: 'API Key is required',
        message: 'Please provide your API Key'
      })

      const malformed = createRes()
      await handler({ body: { apiKey: 'short' } }, malformed)
      expect(malformed.statusCode).toBe(400)
      expect(malformed.body.error).toBe('Invalid API key format')
    }
  )

  test.each([
    ['claude', 'runClaudeKeyTest', 'claude-sonnet-4-5-20250929'],
    ['gemini', 'runGeminiKeyTest', 'gemini-2.5-pro'],
    ['openai', 'runOpenAIKeyTest', 'gpt-5.4']
  ])(
    '%s keeps defaults and does not apply strict V2 model/prompt validation',
    async (service, runner, defaultModel) => {
      const res = createRes()
      await routes[service]({ body: { apiKey: 'cr_valid_key_123', maxTokens: 999 } }, res)

      expect(connectivityService[runner]).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'cr_valid_key_123',
          model: defaultModel,
          prompt: 'hi',
          maxTokens: 1000,
          responseStream: res
        })
      )
    }
  )

  test('passes legacy model and prompt values through without invoking V2 validation', async () => {
    const res = createRes()
    const prompt = { legacy: true }
    await routes.claude(
      { body: { apiKey: 'cr_valid_key_123', model: '../legacy?model', prompt } },
      res
    )

    expect(connectivityService.runClaudeKeyTest).toHaveBeenCalledWith(
      expect.objectContaining({ model: '../legacy?model', prompt })
    )
  })

  test('Claude retains no explicit permission precheck while Gemini and OpenAI return 403', async () => {
    apiKeyService.hasPermission.mockReturnValue(false)
    await routes.claude({ body: { apiKey: 'cr_valid_key_123' } }, createRes())
    expect(connectivityService.runClaudeKeyTest).toHaveBeenCalled()

    for (const service of ['gemini', 'openai']) {
      const res = createRes()
      await routes[service]({ body: { apiKey: 'cr_valid_key_123' } }, res)
      expect(res.statusCode).toBe(403)
    }
  })
})
