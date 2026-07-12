jest.mock('../src/services/pricingService', () => ({
  calculateCost: jest.fn(),
  getModelPricing: jest.fn()
}))

jest.mock('../src/utils/logger', () => ({
  warn: jest.fn()
}))

const pricingService = require('../src/services/pricingService')
const CostCalculator = require('../src/utils/costCalculator')

describe('CostCalculator GPT-Image-2 pricing', () => {
  const pricing = {
    input_cost_per_token: 0.000005,
    input_cost_per_image_token: 0.000008,
    output_cost_per_token: 0.00001,
    output_cost_per_image_token: 0.00003,
    cache_read_input_token_cost: 0.00000125,
    litellm_provider: 'openai'
  }

  beforeEach(() => {
    jest.clearAllMocks()
    pricingService.getModelPricing.mockReturnValue(pricing)
  })

  test('prices text input, image input, and image output independently', () => {
    const result = CostCalculator.calculateCost(
      {
        input_tokens: 120,
        output_tokens: 4000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        image_usage: {
          textInputTokens: 20,
          imageInputTokens: 100,
          imageOutputTokens: 4000,
          estimated: false
        }
      },
      'gpt-image-2'
    )

    expect(result.costs.textInput).toBeCloseTo(0.0001, 12)
    expect(result.costs.imageInput).toBeCloseTo(0.0008, 12)
    expect(result.costs.imageOutput).toBeCloseTo(0.12, 12)
    expect(result.costs.output).toBeCloseTo(0.12, 12)
    expect(result.costs.total).toBeCloseTo(0.1209, 12)
    expect(result.pricing.imageOutput).toBe(30)
  })

  test('uses the dedicated cache-read price without double counting input', () => {
    const result = CostCalculator.calculateCost(
      {
        input_tokens: 100,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 20,
        image_usage: {
          textInputTokens: 0,
          imageInputTokens: 100,
          imageOutputTokens: 0,
          estimated: true
        }
      },
      'gpt-image-2'
    )

    expect(result.costs.input).toBeCloseTo(0.0008, 12)
    expect(result.costs.cacheRead).toBeCloseTo(0.000025, 12)
    expect(result.costs.total).toBeCloseTo(0.000825, 12)
  })

  test('rejects incomplete image pricing instead of falling back to unknown text pricing', () => {
    pricingService.getModelPricing.mockReturnValue({
      input_cost_per_token: 0.000005,
      output_cost_per_image_token: 0.00003
    })

    expect(() =>
      CostCalculator.calculateCost(
        {
          input_tokens: 1,
          output_tokens: 1,
          image_usage: { textInputTokens: 1, imageInputTokens: 0, imageOutputTokens: 1 }
        },
        'gpt-image-2'
      )
    ).toThrow(expect.objectContaining({ code: 'pricing_unavailable', statusCode: 503 }))
  })

  test('keeps ordinary OpenAI requests on the legacy text-pricing path', () => {
    const result = CostCalculator.calculateCost(
      { input_tokens: 100, output_tokens: 10 },
      'gpt-image-2'
    )

    expect(result.costs.input).toBeCloseTo(0.0005, 12)
    expect(result.costs.output).toBeCloseTo(0.0001, 12)
  })
})
