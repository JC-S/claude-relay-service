jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  debug: jest.fn(),
  database: jest.fn(),
  api: jest.fn(),
  security: jest.fn()
}))

const redis = require('../src/models/redis')
const pricingService = require('../src/services/pricingService')
const CostCalculator = require('../src/utils/costCalculator')

describe('Redis aggregated gpt-5.4 service tier cost', () => {
  let previousPricingData

  beforeEach(() => {
    previousPricingData = pricingService.pricingData
    pricingService.pricingData = {
      'gpt-5.4': {
        input_cost_per_token: 0.0000025,
        output_cost_per_token: 0.000015,
        cache_read_input_token_cost: 0.00000025,
        litellm_provider: 'openai'
      }
    }
  })

  afterEach(() => {
    pricingService.pricingData = previousPricingData
  })

  test('adds standard usage at 1x and priority usage at 2x', () => {
    const result = redis.calculateModelCostFromStats(
      CostCalculator,
      {
        inputTokens: 2000000,
        outputTokens: 2000000,
        cacheCreateTokens: 2000000,
        cacheReadTokens: 2000000,
        priorityInputTokens: 1000000,
        priorityOutputTokens: 1000000,
        priorityCacheCreateTokens: 1000000,
        priorityCacheReadTokens: 1000000
      },
      'gpt-5.4'
    )

    expect(result.hasServiceTierSplit).toBe(true)
    expect(result.costs.input).toBeCloseTo(7.5, 10)
    expect(result.costs.output).toBeCloseTo(45, 10)
    expect(result.costs.cacheWrite).toBeCloseTo(7.5, 10)
    expect(result.costs.cacheRead).toBeCloseTo(0.75, 10)
    expect(result.costs.total).toBeCloseTo(60.75, 10)
  })
})
