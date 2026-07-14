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

  test('splits gpt-5.6 cache writes into standard and 2.5x priority prices', () => {
    pricingService.pricingData = {
      'gpt-5.6': {
        input_cost_per_token: 0.000005,
        input_cost_per_token_priority: 0.00001,
        output_cost_per_token: 0.00003,
        output_cost_per_token_priority: 0.00006,
        cache_creation_input_token_cost: 0.00000625,
        cache_creation_input_token_cost_priority: 0.0000125,
        cache_read_input_token_cost: 0.0000005,
        cache_read_input_token_cost_priority: 0.000001,
        litellm_provider: 'openai'
      }
    }

    const result = redis.calculateModelCostFromStats(
      CostCalculator,
      {
        cacheCreateTokens: 2000000,
        priorityCacheCreateTokens: 1000000
      },
      'gpt-5.6'
    )

    expect(result.hasServiceTierSplit).toBe(true)
    expect(result.costs.cacheWrite).toBeCloseTo(21.875, 10)
    expect(result.costs.total).toBeCloseTo(21.875, 10)
  })
})
