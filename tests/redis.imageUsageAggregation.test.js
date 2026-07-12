jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  debug: jest.fn()
}))

const redis = require('../src/models/redis')
const pricingService = require('../src/services/pricingService')
const CostCalculator = require('../src/utils/costCalculator')

function createPipeline() {
  const pipeline = {}
  for (const method of ['hincrby', 'expire', 'sadd', 'del']) {
    pipeline[method] = jest.fn(() => pipeline)
  }
  pipeline.exec = jest.fn(async () => [])
  return pipeline
}

describe('Redis GPT-Image-2 usage aggregation', () => {
  let previousClient
  let previousPricingData

  beforeEach(() => {
    previousClient = redis.client
    previousPricingData = pricingService.pricingData
    pricingService.pricingData = {
      'gpt-image-2': {
        input_cost_per_token: 0.000005,
        input_cost_per_image_token: 0.000008,
        output_cost_per_token: 0.00001,
        output_cost_per_image_token: 0.00003,
        cache_read_input_token_cost: 0.00000125,
        litellm_provider: 'openai'
      }
    }
  })

  afterEach(() => {
    redis.client = previousClient
    pricingService.pricingData = previousPricingData
  })

  test('rebuilds image usage from model stats for account and repair cost calculations', () => {
    const result = redis.calculateModelCostFromStats(
      CostCalculator,
      {
        inputTokens: 120,
        outputTokens: 4000,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
        textInputTokens: 20,
        imageInputTokens: 100,
        imageOutputTokens: 4000
      },
      'gpt-image-2'
    )

    expect(result.costs.textInput).toBeCloseTo(0.0001, 12)
    expect(result.costs.imageInput).toBeCloseTo(0.0008, 12)
    expect(result.costs.imageOutput).toBeCloseTo(0.12, 12)
    expect(result.costs.total).toBeCloseTo(0.1209, 12)
  })

  test('writes image fields to global and API-key model hashes', async () => {
    const pipeline = createPipeline()
    redis.client = { pipeline: jest.fn(() => pipeline) }

    await redis.incrementTokenUsage(
      'key-image',
      4120,
      120,
      4000,
      0,
      0,
      'gpt-image-2',
      0,
      0,
      false,
      0.1209,
      0.1209,
      null,
      { textInputTokens: 20, imageInputTokens: 100, imageOutputTokens: 4000 }
    )

    const calls = pipeline.hincrby.mock.calls
    expect(
      calls.some(
        ([key, field, value]) =>
          key.startsWith('usage:model:daily:gpt-image-2:') &&
          field === 'imageInputTokens' &&
          value === 100
      )
    ).toBe(true)
    expect(
      calls.some(
        ([key, field, value]) =>
          key === 'usage:key-image:model:alltime:gpt-image-2' &&
          field === 'imageOutputTokens' &&
          value === 4000
      )
    ).toBe(true)
    expect(pipeline.exec).toHaveBeenCalledTimes(1)
  })

  test('writes image fields to account model and hourly embedded hashes', async () => {
    const client = {}
    for (const method of ['hincrby', 'expire', 'sadd', 'del']) {
      client[method] = jest.fn(async () => 1)
    }
    redis.client = client

    await redis.incrementAccountUsage(
      'account-image',
      4120,
      120,
      4000,
      0,
      0,
      0,
      0,
      'gpt-image-2',
      false,
      null,
      { textInputTokens: 20, imageInputTokens: 100, imageOutputTokens: 4000 }
    )

    expect(
      client.hincrby.mock.calls.some(
        ([key, field, value]) =>
          key.startsWith('account_usage:model:daily:account-image:gpt-image-2:') &&
          field === 'textInputTokens' &&
          value === 20
      )
    ).toBe(true)
    expect(
      client.hincrby.mock.calls.some(
        ([key, field, value]) =>
          key.startsWith('account_usage:hourly:account-image:') &&
          field === 'model:gpt-image-2:imageInputTokens' &&
          value === 100
      )
    ).toBe(true)
  })
})
