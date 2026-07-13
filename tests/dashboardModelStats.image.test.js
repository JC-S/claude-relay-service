const mockRouter = { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() }

jest.mock('express', () => ({ Router: () => mockRouter }), { virtual: true })
jest.mock('../src/middleware/auth', () => ({
  authenticateAdmin: jest.fn((_req, _res, next) => next())
}))
jest.mock('../src/services/apiKeyService', () => ({}))
jest.mock('../src/services/account/claudeAccountService', () => ({}))
jest.mock('../src/services/account/claudeConsoleAccountService', () => ({}))
jest.mock('../src/services/account/bedrockAccountService', () => ({}))
jest.mock('../src/services/account/ccrAccountService', () => ({}))
jest.mock('../src/services/account/geminiAccountService', () => ({}))
jest.mock('../src/services/account/droidAccountService', () => ({}))
jest.mock('../src/services/account/openaiResponsesAccountService', () => ({}))
jest.mock('../src/utils/upstreamErrorHelper', () => ({}))
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  success: jest.fn(),
  warn: jest.fn()
}))
jest.mock('../src/services/pricingService', () => ({
  calculateCost: jest.fn(),
  getModelPricing: jest.fn()
}))
jest.mock('../src/models/redis', () => ({
  calculateModelCostFromStats: jest.fn(),
  getDateInTimezone: jest.fn(),
  getDateStringInTimezone: jest.fn(),
  scanAndGetAllChunked: jest.fn()
}))

const redis = require('../src/models/redis')
const pricingService = require('../src/services/pricingService')
const { buildUsagePayloadFromStats } = require('../src/utils/modelUsageStatsHelper')
require('../src/routes/admin/dashboard')

const route = mockRouter.get.mock.calls.find((call) => call[0] === '/model-stats')
const handler = route[route.length - 1]

const IMAGE_PRICING = {
  input_cost_per_token: 0.000005,
  input_cost_per_image_token: 0.000008,
  output_cost_per_token: 0.00001,
  output_cost_per_image_token: 0.00003,
  cache_read_input_token_cost: 0.00000125,
  litellm_provider: 'openai'
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

describe('dashboard image model costs', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    redis.getDateInTimezone.mockReturnValue(new Date('2026-07-13T00:00:00.000Z'))
    redis.getDateStringInTimezone.mockReturnValue('2026-07-13')
    redis.calculateModelCostFromStats.mockImplementation((Calculator, stats, model) =>
      Calculator.calculateCost(buildUsagePayloadFromStats(stats), model)
    )
    pricingService.getModelPricing.mockImplementation((model) => {
      if (model === 'gpt-image-2') {
        return IMAGE_PRICING
      }
      return {
        input_cost_per_token: 0.000002,
        output_cost_per_token: 0.00001,
        cache_read_input_token_cost: 0.000001,
        input_cost_per_token_priority: 0.000005,
        output_cost_per_token_priority: 0.000025,
        cache_read_input_token_cost_priority: 0.0000025,
        supports_service_tier: true,
        litellm_provider: model.startsWith('gpt-') ? 'openai' : 'anthropic'
      }
    })
  })

  test('returns image-aware cost, consistent token totals, and cost ordering', async () => {
    redis.scanAndGetAllChunked.mockResolvedValue([
      {
        key: 'usage:model:monthly:gpt-5.5:2026-07',
        data: {
          requests: '2',
          priorityRequests: '1',
          inputTokens: '100',
          outputTokens: '20',
          allTokens: '999999',
          priorityInputTokens: '40',
          priorityOutputTokens: '10'
        }
      },
      {
        key: 'usage:model:monthly:claude-sonnet-4-6:2026-07',
        data: { requests: '1', inputTokens: '80', outputTokens: '10' }
      },
      {
        key: 'usage:model:monthly:gpt-image-2:2026-07',
        data: {
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
      }
    ])

    const res = createResponse()
    await handler({ query: { period: 'monthly' } }, res)

    expect(res.statusCode).toBe(200)
    const stats = res.body.data
    const image = stats.find((stat) => stat.model === 'gpt-image-2')
    expect(image.costs.total).toBeCloseTo(0.1209, 12)
    expect(image).toEqual(
      expect.objectContaining({
        textInputTokens: 20,
        imageInputTokens: 100,
        imageOutputTokens: 4000,
        allTokens: 4120
      })
    )
    expect(image.usage.totalTokens).toBe(4120)
    expect(image.usage.allTokens).toBe(4120)

    expect(stats[0].model).toBe('gpt-image-2')
    expect(stats.map((stat) => stat.model)).toEqual(
      expect.arrayContaining(['gpt-5.5', 'gpt-5.5 (fast)', 'claude-sonnet-4-6'])
    )

    const standard = stats.find((stat) => stat.model === 'gpt-5.5')
    const fast = stats.find((stat) => stat.model === 'gpt-5.5 (fast)')
    const claude = stats.find((stat) => stat.model === 'claude-sonnet-4-6')
    expect(standard.costs.total).toBeCloseTo(0.00022, 12)
    expect(fast.costs.total).toBeCloseTo(0.00045, 12)
    expect(claude.costs.total).toBeCloseTo(0.00026, 12)

    for (const stat of [standard, fast, claude]) {
      expect(stat).not.toHaveProperty('textInputTokens')
      expect(stat).not.toHaveProperty('imageInputTokens')
      expect(stat).not.toHaveProperty('imageOutputTokens')
    }
  })
})
