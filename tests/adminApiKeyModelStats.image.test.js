const mockRouter = { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() }

jest.mock('express', () => ({ Router: () => mockRouter }), { virtual: true })
jest.mock('../src/middleware/auth', () => ({
  authenticateAdmin: jest.fn((_req, _res, next) => next())
}))
jest.mock('../src/services/apiKeyService', () => ({ getAllApiKeysFast: jest.fn() }))
jest.mock('../src/services/account/ccrAccountService', () => ({}))
jest.mock('../src/services/account/claudeAccountService', () => ({}))
jest.mock('../src/services/account/claudeConsoleAccountService', () => ({}))
jest.mock('../src/services/account/geminiAccountService', () => ({}))
jest.mock('../src/services/account/geminiApiAccountService', () => ({}))
jest.mock('../src/services/account/openaiAccountService', () => ({}))
jest.mock('../src/services/account/openaiResponsesAccountService', () => ({}))
jest.mock('../src/services/account/droidAccountService', () => ({}))
jest.mock('../src/services/account/bedrockAccountService', () => ({}))
jest.mock('../src/utils/logger', () => ({
  api: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  security: jest.fn(),
  success: jest.fn(),
  warn: jest.fn()
}))
jest.mock('../src/services/pricingService', () => ({
  calculateCost: jest.fn(),
  getModelPricing: jest.fn()
}))
jest.mock('../src/models/redis', () => ({
  batchHgetallChunked: jest.fn(),
  calculateModelCostFromStats: jest.fn(),
  client: {
    get: jest.fn(),
    sadd: jest.fn(),
    setex: jest.fn(),
    smembers: jest.fn()
  },
  getApiKey: jest.fn(),
  getClientSafe: jest.fn(() => ({})),
  getDateInTimezone: jest.fn(),
  getDateStringInTimezone: jest.fn(),
  getV2ParentSourceKeyIds: jest.fn(),
  scanAndGetAllChunked: jest.fn(),
  scanKeys: jest.fn()
}))

const redis = require('../src/models/redis')
const pricingService = require('../src/services/pricingService')
const { buildUsagePayloadFromStats } = require('../src/utils/modelUsageStatsHelper')
require('../src/routes/admin/usageStats')

const route = mockRouter.get.mock.calls.find((call) => call[0] === '/api-keys/:keyId/model-stats')
const handler = route[route.length - 1]

const IMAGE_PRICING = {
  input_cost_per_token: 0.000005,
  input_cost_per_image_token: 0.000008,
  output_cost_per_token: 0.00001,
  output_cost_per_image_token: 0.00003,
  cache_read_input_token_cost: 0.00000125,
  litellm_provider: 'openai'
}

function imageStats(overrides = {}) {
  return {
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
    ratedCostMicro: '120900',
    ...overrides
  }
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

async function invoke(query = { period: 'monthly' }, keyId = 'key-image') {
  const res = createResponse()
  await handler({ params: { keyId }, query }, res)
  expect(res.statusCode).toBe(200)
  return res.body.data
}

describe('admin API key image model stats', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    redis.getApiKey.mockResolvedValue({ isV2Parent: 'false' })
    redis.getV2ParentSourceKeyIds.mockImplementation(async (keyId) => [keyId])
    redis.getDateInTimezone.mockReturnValue(new Date('2026-07-13T00:00:00.000Z'))
    redis.getDateStringInTimezone.mockImplementation((date) =>
      (date || new Date('2026-07-13T00:00:00.000Z')).toISOString().slice(0, 10)
    )
    redis.scanAndGetAllChunked.mockResolvedValue([])
    redis.scanKeys.mockResolvedValue([])
    redis.client.get.mockResolvedValue(null)
    redis.client.smembers.mockResolvedValue([])
    redis.calculateModelCostFromStats.mockImplementation((Calculator, stats, model) =>
      Calculator.calculateCost(buildUsagePayloadFromStats(stats), model)
    )
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

  test('returns image-aware monthly cost and optional image token fields', async () => {
    redis.scanAndGetAllChunked.mockResolvedValue([
      {
        key: 'usage:key-image:model:monthly:gpt-image-2:2026-07',
        data: imageStats()
      }
    ])

    const [stat] = await invoke()

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

  test('returns image-aware cost from the daily model index', async () => {
    redis.client.smembers.mockResolvedValue(['key-image:gpt-image-2'])
    redis.batchHgetallChunked.mockResolvedValue([imageStats()])

    const [stat] = await invoke({ period: 'daily' })

    expect(stat.costs.total).toBeCloseTo(0.1209, 12)
    expect(stat.textInputTokens).toBe(20)
    expect(stat.imageInputTokens).toBe(100)
    expect(stat.imageOutputTokens).toBe(4000)
    expect(stat.allTokens).toBe(4120)
  })

  test('aggregates image fields across a custom daily date range', async () => {
    redis.client.smembers.mockResolvedValue(['key-image:gpt-image-2'])
    redis.batchHgetallChunked.mockImplementation(async (keys) =>
      keys.map((key) =>
        key.endsWith(':2026-07-12')
          ? imageStats({
              inputTokens: '70',
              outputTokens: '1000',
              textInputTokens: '10',
              imageInputTokens: '60',
              imageOutputTokens: '1000',
              realCostMicro: '30530',
              ratedCostMicro: '30530'
            })
          : imageStats({
              inputTokens: '50',
              outputTokens: '3000',
              textInputTokens: '10',
              imageInputTokens: '40',
              imageOutputTokens: '3000',
              realCostMicro: '90370',
              ratedCostMicro: '90370'
            })
      )
    )

    const [stat] = await invoke({
      period: 'custom',
      startDate: '2026-07-12',
      endDate: '2026-07-13'
    })

    expect(stat.costs.total).toBeCloseTo(0.1209, 12)
    expect(stat.textInputTokens).toBe(20)
    expect(stat.imageInputTokens).toBe(100)
    expect(stat.imageOutputTokens).toBe(4000)
    expect(stat.allTokens).toBe(4120)
  })

  test('aggregates v2 parent and child image usage exactly once', async () => {
    redis.getApiKey.mockResolvedValue({ isV2Parent: 'true' })
    redis.getV2ParentSourceKeyIds.mockResolvedValue(['parent', 'child-a', 'child-b'])
    redis.scanAndGetAllChunked.mockImplementation(async (pattern) => {
      if (pattern.startsWith('usage:child-a:')) {
        return [
          {
            key: 'usage:child-a:model:monthly:gpt-image-2:2026-07',
            data: imageStats({
              inputTokens: '70',
              outputTokens: '1000',
              textInputTokens: '10',
              imageInputTokens: '60',
              imageOutputTokens: '1000',
              realCostMicro: '30530',
              ratedCostMicro: '30530'
            })
          }
        ]
      }
      if (pattern.startsWith('usage:child-b:')) {
        return [
          {
            key: 'usage:child-b:model:monthly:gpt-image-2:2026-07',
            data: imageStats({
              inputTokens: '50',
              outputTokens: '3000',
              textInputTokens: '10',
              imageInputTokens: '40',
              imageOutputTokens: '3000',
              realCostMicro: '90370',
              ratedCostMicro: '90370'
            })
          }
        ]
      }
      return []
    })

    const [stat] = await invoke({ period: 'monthly' }, 'parent')

    expect(stat.costs.total).toBeCloseTo(0.1209, 12)
    expect(stat).toEqual(
      expect.objectContaining({
        inputTokens: 120,
        outputTokens: 4000,
        textInputTokens: 20,
        imageInputTokens: 100,
        imageOutputTokens: 4000,
        allTokens: 4120
      })
    )
  })

  test('keeps ordinary model response shape free of image fields', async () => {
    redis.scanAndGetAllChunked.mockResolvedValue([
      {
        key: 'usage:key-image:model:monthly:gpt-5.5:2026-07',
        data: { requests: '1', inputTokens: '100', outputTokens: '20', allTokens: '9999' }
      },
      {
        key: 'usage:key-image:model:monthly:claude-sonnet-4-6:2026-07',
        data: { requests: '1', inputTokens: '80', outputTokens: '10' }
      }
    ])

    const stats = await invoke()

    expect(stats).toHaveLength(2)
    for (const stat of stats) {
      expect(stat).not.toHaveProperty('textInputTokens')
      expect(stat).not.toHaveProperty('imageInputTokens')
      expect(stat).not.toHaveProperty('imageOutputTokens')
    }
    const gpt = stats.find((stat) => stat.model === 'gpt-5.5')
    const claude = stats.find((stat) => stat.model === 'claude-sonnet-4-6')
    expect(gpt.allTokens).toBe(120)
    expect(gpt.costs.total).toBeCloseTo(0.0004, 12)
    expect(claude.costs.total).toBeCloseTo(0.00026, 12)
  })
})
