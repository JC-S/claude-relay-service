jest.mock('../src/services/pricingService', () => ({
  calculateCost: jest.fn(),
  getModelPricing: jest.fn()
}))

jest.mock('../src/utils/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  success: jest.fn(),
  database: jest.fn(),
  api: jest.fn(),
  security: jest.fn()
}))

describe('CostCalculator', () => {
  let CostCalculator
  let pricingService
  let logger

  beforeEach(() => {
    jest.resetModules()

    pricingService = require('../src/services/pricingService')
    logger = require('../src/utils/logger')
    CostCalculator = require('../src/utils/costCalculator')

    jest.clearAllMocks()
    pricingService.calculateCost.mockReset()
    pricingService.getModelPricing.mockReset()
  })

  it('uses detailed pricing when pricingService returns a complete result', () => {
    pricingService.calculateCost.mockReturnValue({
      hasPricing: true,
      isLongContextRequest: false,
      inputCost: 0.003,
      outputCost: 0.0075,
      cacheCreateCost: 0.00075,
      cacheReadCost: 0.00003,
      totalCost: 0.01128,
      pricing: {
        input: 0.000003,
        output: 0.000015,
        cacheCreate: 0.00000375,
        cacheRead: 0.0000003
      }
    })

    const result = CostCalculator.calculateCost(
      {
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 100,
        cache_creation: {
          ephemeral_5m_input_tokens: 200,
          ephemeral_1h_input_tokens: 0
        }
      },
      'claude-sonnet-4-20250514'
    )

    expect(result.usingDynamicPricing).toBe(true)
    expect(result.pricing.input).toBe(3)
    expect(result.pricing.cacheWrite).toBe(3.75)
    expect(result.costs.total).toBeCloseTo(0.01128, 10)
    expect(result.debug.usedFallbackPricing).toBe(false)
    expect(result.debug.pricingSource).toBe('dynamic')
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('falls back to unknown pricing for detailed-cache requests with missing model pricing', () => {
    pricingService.calculateCost.mockReturnValue({
      hasPricing: false,
      totalCost: 0,
      isLongContextRequest: false
    })
    pricingService.getModelPricing.mockReturnValue(null)

    const usage = {
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 100,
      cache_creation: {
        ephemeral_5m_input_tokens: 100,
        ephemeral_1h_input_tokens: 100
      }
    }

    const first = CostCalculator.calculateCost(usage, 'kimi-k2.5')
    const second = CostCalculator.calculateCost(usage, 'kimi-k2.5')

    expect(first.usingDynamicPricing).toBe(false)
    expect(first.pricing.input).toBe(3)
    expect(first.pricing.cacheWrite).toBe(3.75)
    expect(first.costs.total).toBeCloseTo(0.01128, 10)
    expect(first.debug.usedFallbackPricing).toBe(true)
    expect(first.debug.pricingSource).toBe('unknown-fallback')
    expect(second.costs.total).toBeCloseTo(first.costs.total, 10)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn.mock.calls[0][0]).toContain('kimi-k2.5')
  })

  it('falls back instead of throwing for unknown long-context models', () => {
    pricingService.calculateCost.mockReturnValue({
      hasPricing: false,
      totalCost: 0,
      isLongContextRequest: false
    })
    pricingService.getModelPricing.mockReturnValue(null)

    const result = CostCalculator.calculateCost(
      {
        input_tokens: 250000,
        output_tokens: 1000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      },
      'mystery-model[1m]'
    )

    expect(result.usingDynamicPricing).toBe(false)
    expect(result.costs.total).toBeCloseTo(0.765, 10)
    expect(result.debug.usedFallbackPricing).toBe(true)
    expect(result.debug.isLongContextModel).toBe(true)
    expect(result.debug.pricingSource).toBe('unknown-fallback')
  })

  it('keeps the legacy dynamic-pricing path for regular requests', () => {
    pricingService.getModelPricing.mockReturnValue({
      input_cost_per_token: 0.000002,
      output_cost_per_token: 0.000008,
      cache_creation_input_token_cost: 0.0000025,
      cache_read_input_token_cost: 0.0000002
    })

    const result = CostCalculator.calculateCost(
      {
        input_tokens: 2000,
        output_tokens: 1000,
        cache_creation_input_tokens: 500,
        cache_read_input_tokens: 250
      },
      'glm-5'
    )

    expect(pricingService.calculateCost).not.toHaveBeenCalled()
    expect(result.usingDynamicPricing).toBe(true)
    expect(result.pricing.input).toBe(2)
    expect(result.pricing.output).toBe(8)
    expect(result.costs.total).toBeCloseTo(0.0133, 10)
    expect(result.debug.usedFallbackPricing).toBe(false)
    expect(result.debug.pricingSource).toBe('dynamic')
  })

  it('uses gpt-5.5 priority prices when service_tier is priority', () => {
    pricingService.getModelPricing.mockReturnValue({
      input_cost_per_token: 0.000005,
      input_cost_per_token_priority: 0.0000125,
      output_cost_per_token: 0.00003,
      output_cost_per_token_priority: 0.000075,
      cache_read_input_token_cost: 0.0000005,
      cache_read_input_token_cost_priority: 0.00000125,
      supports_service_tier: true,
      litellm_provider: 'openai'
    })

    const result = CostCalculator.calculateCost(
      {
        input_tokens: 1000,
        output_tokens: 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 200
      },
      'gpt-5.5',
      'priority'
    )

    expect(result.pricing.input).toBe(12.5)
    expect(result.pricing.output).toBe(75)
    expect(result.pricing.cacheRead).toBe(1.25)
    expect(result.costs.total).toBeCloseTo(0.02025, 10)
  })

  describe('gpt-5.6 cache-write pricing', () => {
    const modelPricing = {
      'gpt-5.6': [5, 10, 30, 60, 6.25, 12.5, 0.5, 1],
      'gpt-5.6-sol': [5, 10, 30, 60, 6.25, 12.5, 0.5, 1],
      'gpt-5.6-terra': [2.5, 5, 15, 30, 3.125, 6.25, 0.25, 0.5],
      'gpt-5.6-luna': [1, 2, 6, 12, 1.25, 2.5, 0.1, 0.2]
    }

    it.each(Object.entries(modelPricing))(
      'uses explicit standard and priority cache-write prices for %s',
      (model, prices) => {
        const [input, priorityInput, output, priorityOutput, cacheWrite, priorityCacheWrite] =
          prices
        pricingService.getModelPricing.mockReturnValue({
          input_cost_per_token: input / 1000000,
          input_cost_per_token_priority: priorityInput / 1000000,
          output_cost_per_token: output / 1000000,
          output_cost_per_token_priority: priorityOutput / 1000000,
          cache_creation_input_token_cost: cacheWrite / 1000000,
          cache_creation_input_token_cost_priority: priorityCacheWrite / 1000000,
          supports_service_tier: true,
          litellm_provider: 'openai'
        })

        const usage = {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 1000000,
          cache_read_input_tokens: 0
        }
        const standard = CostCalculator.calculateCost(usage, model)
        const priority = CostCalculator.calculateCost(usage, model, 'priority')

        expect(standard.pricing.cacheWrite).toBe(cacheWrite)
        expect(standard.costs.cacheWrite).toBeCloseTo(cacheWrite, 10)
        expect(priority.pricing.cacheWrite).toBe(priorityCacheWrite)
        expect(priority.costs.cacheWrite).toBeCloseTo(priorityCacheWrite, 10)
      }
    )

    it('calculates the representative Sol standard and priority totals', () => {
      pricingService.getModelPricing.mockReturnValue({
        input_cost_per_token: 0.000005,
        input_cost_per_token_priority: 0.00001,
        output_cost_per_token: 0.00003,
        output_cost_per_token_priority: 0.00006,
        cache_creation_input_token_cost: 0.00000625,
        cache_creation_input_token_cost_priority: 0.0000125,
        cache_read_input_token_cost: 0.0000005,
        cache_read_input_token_cost_priority: 0.000001,
        supports_service_tier: true,
        litellm_provider: 'openai'
      })
      const usage = {
        input_tokens: 50000,
        output_tokens: 10000,
        cache_creation_input_tokens: 30000,
        cache_read_input_tokens: 20000
      }

      const standard = CostCalculator.calculateCost(usage, 'gpt-5.6-sol')
      const priority = CostCalculator.calculateCost(usage, 'gpt-5.6-sol', 'priority')

      expect(standard.costs.total).toBeCloseTo(0.7475, 10)
      expect(priority.costs.total).toBeCloseTo(1.495, 10)
    })

    it('does not activate 272K pricing fields in the legacy path', () => {
      pricingService.getModelPricing.mockReturnValue({
        input_cost_per_token: 0.000005,
        input_cost_per_token_above_272k_tokens: 0.00001,
        output_cost_per_token: 0.00003,
        output_cost_per_token_above_272k_tokens: 0.000045,
        cache_creation_input_token_cost: 0.00000625,
        cache_creation_input_token_cost_above_272k_tokens: 0.0000125,
        cache_read_input_token_cost: 0.0000005,
        cache_read_input_token_cost_above_272k_tokens: 0.000001,
        litellm_provider: 'openai'
      })

      const result = CostCalculator.calculateCost(
        {
          input_tokens: 300000,
          output_tokens: 1000,
          cache_creation_input_tokens: 1000,
          cache_read_input_tokens: 1000
        },
        'gpt-5.6'
      )

      expect(result.pricing.input).toBe(5)
      expect(result.pricing.output).toBe(30)
      expect(result.pricing.cacheWrite).toBe(6.25)
      expect(result.pricing.cacheRead).toBe(0.5)
    })
  })

  describe('gpt-5.4 service_tier pricing', () => {
    const gpt54Pricing = {
      input_cost_per_token: 0.0000025,
      input_cost_per_token_priority: 0.000005,
      output_cost_per_token: 0.000015,
      output_cost_per_token_priority: 0.00003,
      cache_read_input_token_cost: 0.00000025,
      cache_read_input_token_cost_priority: 0.0000005,
      supports_service_tier: true,
      litellm_provider: 'openai'
    }

    beforeEach(() => {
      pricingService.getModelPricing.mockReturnValue(gpt54Pricing)
    })

    it('uses standard prices without priority service_tier', () => {
      const result = CostCalculator.calculateCost(
        {
          input_tokens: 1000000,
          output_tokens: 1000000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0
        },
        'gpt-5.4'
      )

      expect(result.pricing.input).toBe(2.5)
      expect(result.pricing.output).toBe(15)
      expect(result.costs.total).toBeCloseTo(17.5, 10)
    })

    it('uses 2x input, output and cache-read prices for priority service_tier', () => {
      const result = CostCalculator.calculateCost(
        {
          input_tokens: 1000000,
          output_tokens: 1000000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 1000000
        },
        'gpt-5.4',
        'priority'
      )

      expect(result.pricing.input).toBe(5)
      expect(result.pricing.output).toBe(30)
      expect(result.pricing.cacheRead).toBe(0.5)
      expect(result.costs.total).toBeCloseTo(35.5, 10)
    })

    it('uses the priority input price for legacy cache creation fallback', () => {
      const result = CostCalculator.calculateCost(
        {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 1000000,
          cache_read_input_tokens: 0
        },
        'gpt-5.4',
        'priority'
      )

      expect(result.pricing.cacheWrite).toBe(5)
      expect(result.costs.cacheWrite).toBeCloseTo(5, 10)
      expect(result.costs.total).toBeCloseTo(5, 10)
    })

    it.each([null, 'standard', 'PRIORITY', 'Priority', 'fast'])(
      'does not use priority prices for service_tier=%s',
      (serviceTier) => {
        const result = CostCalculator.calculateCost(
          {
            input_tokens: 1000000,
            output_tokens: 1000000,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0
          },
          'gpt-5.4',
          serviceTier
        )

        expect(result.costs.total).toBeCloseTo(17.5, 10)
      }
    )
  })
})
