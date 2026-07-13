const mockRouter = { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() }

jest.mock('express', () => ({ Router: () => mockRouter }), { virtual: true })
jest.mock('../src/services/apiKeyService', () => ({
  getApiKeyForPublicStatsById: jest.fn(),
  hasPermission: jest.fn(),
  validateApiKey: jest.fn(),
  validateApiKeyForStats: jest.fn()
}))
jest.mock('../src/services/account/claudeAccountService', () => ({}))
jest.mock('../src/services/account/openaiAccountService', () => ({}))
jest.mock('../src/services/serviceRatesService', () => ({}))
jest.mock('../src/services/apiKeyConnectivityTestService', () => ({
  sanitizeMaxTokens: jest.fn((value) => Number(value) || 1000),
  runClaudeKeyTest: jest.fn(),
  runGeminiKeyTest: jest.fn(),
  runOpenAIKeyTest: jest.fn()
}))
jest.mock('../src/utils/logger', () => ({
  api: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  security: jest.fn(),
  warn: jest.fn()
}))
jest.mock('../src/services/pricingService', () => ({
  calculateCost: jest.fn(),
  getModelPricing: jest.fn()
}))
jest.mock('../src/models/redis', () => ({
  calculateModelCostFromStats: jest.fn(),
  getClientSafe: jest.fn(() => ({})),
  getDateInTimezone: jest.fn(),
  getDateStringInTimezone: jest.fn(),
  scanAndGetAllChunked: jest.fn()
}))

const redis = require('../src/models/redis')
const apiKeyService = require('../src/services/apiKeyService')
const pricingService = require('../src/services/pricingService')
const { buildUsagePayloadFromStats } = require('../src/utils/modelUsageStatsHelper')
require('../src/routes/apiStats')

const userRoute = mockRouter.post.mock.calls.find((call) => call[0] === '/api/user-model-stats')
const batchRoute = mockRouter.post.mock.calls.find((call) => call[0] === '/api/batch-model-stats')
const userHandler = userRoute[userRoute.length - 1]
const batchHandler = batchRoute[batchRoute.length - 1]

const IMAGE_PRICING = {
  input_cost_per_token: 0.000005,
  input_cost_per_image_token: 0.000008,
  output_cost_per_token: 0.00001,
  output_cost_per_image_token: 0.00003,
  cache_read_input_token_cost: 0.00000125,
  litellm_provider: 'openai'
}

const IMAGE_DATA = {
  requests: '1',
  inputTokens: '120',
  outputTokens: '4000',
  cacheCreateTokens: '0',
  cacheReadTokens: '0',
  allTokens: '999999',
  textInputTokens: '20',
  imageInputTokens: '100',
  imageOutputTokens: '4000',
  realCostMicro: '120900',
  ratedCostMicro: '120900'
}

function createResponse() {
  const res = {
    statusCode: 200,
    body: null,
    status: jest.fn((code) => {
      res.statusCode = code
      return res
    }),
    json: jest.fn((body) => {
      res.body = body
      return res
    })
  }
  return res
}

describe('public API stats image model costs', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    redis.getDateInTimezone.mockReturnValue(new Date('2026-07-13T00:00:00.000Z'))
    redis.getDateStringInTimezone.mockReturnValue('2026-07-13')
    redis.scanAndGetAllChunked.mockResolvedValue([
      {
        key: 'usage:key-image:model:monthly:gpt-image-2:2026-07',
        data: { ...IMAGE_DATA }
      }
    ])
    redis.calculateModelCostFromStats.mockImplementation((Calculator, stats, model) =>
      Calculator.calculateCost(buildUsagePayloadFromStats(stats), model)
    )
    apiKeyService.validateApiKey.mockResolvedValue({
      valid: true,
      keyData: { id: 'key-image', name: 'Image key' }
    })
    pricingService.getModelPricing.mockImplementation((model) =>
      model === 'gpt-image-2'
        ? IMAGE_PRICING
        : {
            input_cost_per_token: 0.000002,
            output_cost_per_token: 0.00001,
            cache_read_input_token_cost: 0.000001,
            litellm_provider: model.startsWith('gpt-') ? 'openai' : 'anthropic'
          }
    )
  })

  test('/api/user-model-stats returns the image-aware cost', async () => {
    const res = createResponse()
    await userHandler({ body: { apiKey: 'cr_valid_image_key', period: 'monthly' } }, res)

    expect(res.statusCode).toBe(200)
    const [stat] = res.body.data
    expect(stat.costs.total).toBeCloseTo(0.1209, 12)
    expect(stat.costs.textInput).toBeCloseTo(0.0001, 12)
    expect(stat.costs.imageInput).toBeCloseTo(0.0008, 12)
    expect(stat.costs.imageOutput).toBeCloseTo(0.12, 12)
    expect(stat).toEqual(
      expect.objectContaining({
        textInputTokens: 20,
        imageInputTokens: 100,
        imageOutputTokens: 4000,
        allTokens: 4120
      })
    )
  })

  test('/api/batch-model-stats uses the same image-aware cost', async () => {
    const res = createResponse()
    await batchHandler({ body: { apiIds: ['key-image'], period: 'monthly' } }, res)

    expect(res.statusCode).toBe(200)
    const [stat] = res.body.data
    expect(stat.costs.total).toBeCloseTo(0.1209, 12)
    expect(stat).toEqual(
      expect.objectContaining({
        textInputTokens: 20,
        imageInputTokens: 100,
        imageOutputTokens: 4000,
        allTokens: 4120
      })
    )
  })

  test('ordinary models do not gain image usage or trust inconsistent allTokens', async () => {
    redis.scanAndGetAllChunked.mockResolvedValue([
      {
        key: 'usage:key-image:model:monthly:gpt-5.5:2026-07',
        data: {
          requests: '1',
          inputTokens: '100',
          outputTokens: '20',
          cacheCreateTokens: '5',
          cacheReadTokens: '7',
          allTokens: '999999'
        }
      }
    ])

    const res = createResponse()
    await userHandler({ body: { apiKey: 'cr_valid_image_key', period: 'monthly' } }, res)

    expect(res.statusCode).toBe(200)
    const [stat] = res.body.data
    expect(stat.allTokens).toBe(132)
    expect(stat).not.toHaveProperty('textInputTokens')
    expect(stat).not.toHaveProperty('imageInputTokens')
    expect(stat).not.toHaveProperty('imageOutputTokens')
  })
})
