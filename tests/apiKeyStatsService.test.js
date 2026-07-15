jest.mock('../src/models/redis', () => ({
  getClientSafe: jest.fn(),
  getDateInTimezone: jest.fn(),
  getDateStringInTimezone: jest.fn(),
  getApiKey: jest.fn(),
  getV2ParentSourceKeyIds: jest.fn(),
  getV2ParentLedgerCostStats: jest.fn(),
  getDailyCost: jest.fn(),
  getWeeklyOpusCost: jest.fn(),
  getWeeklyFableCost: jest.fn(),
  getV2ParentWeeklyOpusCost: jest.fn(),
  getV2ParentWeeklyFableCost: jest.fn()
}))

jest.mock('../src/utils/costCalculator', () => ({
  formatCost: jest.fn((cost) => `$${Number(cost || 0).toFixed(2)}`),
  calculateCost: jest.fn(() => ({
    costs: { total: 0 }
  }))
}))

jest.mock('../src/utils/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn()
}))

const redis = require('../src/models/redis')
const {
  ApiKeyStatsNotFoundError,
  calculateKeyDetailStats,
  calculateKeyStats,
  validateStatsTimeRange
} = require('../src/services/apiKeyStatsService')

function globToRegex(pattern) {
  return new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
}

describe('apiKeyStatsService', () => {
  let dataByKey
  let client

  beforeEach(() => {
    jest.clearAllMocks()
    dataByKey = new Map()

    client = {
      scan: jest.fn(async (_cursor, _match, pattern) => {
        const regex = globToRegex(pattern)
        const keys = [...dataByKey.keys()].filter((key) => regex.test(key))
        return ['0', keys]
      }),
      get: jest.fn(async () => '0'),
      pipeline: jest.fn(() => {
        const keys = []
        return {
          hgetall: jest.fn((key) => {
            keys.push(key)
          }),
          exec: jest.fn(async () => keys.map((key) => [null, dataByKey.get(key) || {}]))
        }
      })
    }

    redis.getClientSafe.mockReturnValue(client)
    redis.getDateInTimezone.mockReturnValue(new Date(Date.UTC(2026, 5, 2, 12, 0, 0)))
    redis.getDateStringInTimezone.mockImplementation((date) => {
      if (!date) {
        return '2026-06-02'
      }
      return new Date(date).toISOString().slice(0, 10)
    })
    redis.getApiKey.mockResolvedValue({
      id: 'key-1',
      isV2Parent: 'false',
      dailyCostLimit: '0',
      weeklyOpusCostLimit: '0',
      weeklyFableCostLimit: '0',
      rateLimitWindow: '0'
    })
    redis.getWeeklyFableCost.mockResolvedValue(0)
    redis.getV2ParentWeeklyFableCost.mockResolvedValue(0)
  })

  function addDaily(date, { requests, inputTokens, outputTokens, ratedCostMicro }) {
    dataByKey.set(`usage:key-1:model:daily:gpt-5.5:${date}`, {
      totalRequests: String(requests),
      totalInputTokens: String(inputTokens),
      totalOutputTokens: String(outputTokens),
      totalCacheCreateTokens: '0',
      totalCacheReadTokens: '0',
      ratedCostMicro: String(ratedCostMicro),
      realCostMicro: String(ratedCostMicro)
    })
  }

  test('30days uses daily keys across month boundaries instead of falling back to alltime', async () => {
    addDaily('2026-05-30', {
      requests: 1,
      inputTokens: 100,
      outputTokens: 50,
      ratedCostMicro: 1000000
    })
    addDaily('2026-06-01', {
      requests: 2,
      inputTokens: 200,
      outputTokens: 100,
      ratedCostMicro: 2000000
    })
    dataByKey.set('usage:key-1:model:alltime:gpt-5.5', {
      totalRequests: '99',
      totalInputTokens: '9900',
      totalOutputTokens: '9900',
      ratedCostMicro: '99000000',
      realCostMicro: '99000000'
    })

    const stats = await calculateKeyStats('key-1', '30days')

    expect(stats.requests).toBe(3)
    expect(stats.inputTokens).toBe(300)
    expect(stats.outputTokens).toBe(150)
    expect(stats.cost).toBe(3)
    expect(stats.formattedCost).toBe('$3.00')
    expect(client.scan).not.toHaveBeenCalledWith(
      expect.anything(),
      'MATCH',
      'usage:key-1:model:alltime:*',
      'COUNT',
      expect.anything()
    )
  })

  test('7days and custom include previous-month daily keys', async () => {
    addDaily('2026-05-30', {
      requests: 1,
      inputTokens: 100,
      outputTokens: 50,
      ratedCostMicro: 1000000
    })
    addDaily('2026-06-01', {
      requests: 2,
      inputTokens: 200,
      outputTokens: 100,
      ratedCostMicro: 2000000
    })

    const sevenDays = await calculateKeyStats('key-1', '7days')
    expect(sevenDays.requests).toBe(3)
    expect(sevenDays.cost).toBe(3)

    const custom = await calculateKeyStats(
      'key-1',
      'custom',
      '2026-05-29T00:00:00.000Z',
      '2026-06-01T23:59:59.000Z'
    )
    expect(custom.requests).toBe(3)
    expect(custom.cost).toBe(3)
  })

  test('returns weeklyFableCost when Fable weekly limit is enabled', async () => {
    redis.getApiKey.mockResolvedValue({
      id: 'key-1',
      isV2Parent: 'false',
      dailyCostLimit: '0',
      weeklyOpusCostLimit: '0',
      weeklyFableCostLimit: '100',
      weeklyResetDay: '3',
      weeklyResetHour: '10',
      rateLimitWindow: '0'
    })
    redis.getWeeklyFableCost.mockResolvedValue(12.34)

    const stats = await calculateKeyStats('key-1', 'today')

    expect(redis.getWeeklyFableCost).toHaveBeenCalledWith('key-1', 3, 10)
    expect(stats.weeklyFableCost).toBe(12.34)
  })

  test('v2 child stats use parent Fable weekly limit config and child counter', async () => {
    redis.getApiKey.mockImplementation(async (id) => {
      if (id === 'child-1') {
        return {
          id: 'child-1',
          parentKeyId: 'parent-1',
          isV2Parent: 'false',
          dailyCostLimit: '0',
          weeklyOpusCostLimit: '0',
          weeklyFableCostLimit: '0',
          weeklyResetDay: '1',
          weeklyResetHour: '0',
          rateLimitWindow: '0'
        }
      }
      if (id === 'parent-1') {
        return {
          id: 'parent-1',
          isV2Parent: 'true',
          isActive: 'true',
          isDeleted: 'false',
          weeklyOpusCostLimit: '0',
          weeklyFableCostLimit: '200',
          weeklyResetDay: '5',
          weeklyResetHour: '6'
        }
      }
      return null
    })
    redis.getWeeklyFableCost.mockResolvedValue(56.78)

    const stats = await calculateKeyStats('child-1', 'today')

    expect(redis.getWeeklyFableCost).toHaveBeenCalledWith('child-1', 5, 6)
    expect(redis.getV2ParentWeeklyFableCost).not.toHaveBeenCalled()
    expect(stats.weeklyFableCost).toBe(56.78)
  })

  test('detail stats separate all-time and today and include today cost without a daily limit', async () => {
    redis.getApiKey.mockResolvedValue({
      id: 'key-1',
      createdAt: '2026-06-02T11:00:00.000Z',
      isV2Parent: 'false',
      dailyCostLimit: '0',
      weeklyOpusCostLimit: '0',
      weeklyFableCostLimit: '0',
      rateLimitWindow: '0'
    })
    client.get.mockImplementation(async (key) => (key === 'usage:cost:total:key-1' ? '12.5' : '0'))
    dataByKey.set('usage:key-1:model:alltime:gpt-5.5', {
      totalRequests: '10',
      totalInputTokens: '1000',
      totalOutputTokens: '500',
      totalCacheCreateTokens: '200',
      totalCacheReadTokens: '300',
      ratedCostMicro: '10000000',
      realCostMicro: '10000000'
    })
    dataByKey.set('usage:key-1:model:daily:gpt-5.5:2026-06-02', {
      totalRequests: '2',
      totalInputTokens: '100',
      totalOutputTokens: '50',
      totalCacheCreateTokens: '20',
      totalCacheReadTokens: '30',
      ratedCostMicro: '2500000',
      realCostMicro: '2500000'
    })

    const stats = await calculateKeyDetailStats('key-1', {
      now: new Date('2026-06-02T12:00:00.000Z')
    })

    expect(redis.getDailyCost).not.toHaveBeenCalled()
    expect(stats.total).toMatchObject({ requests: 10, tokens: 2000, cost: 12.5 })
    expect(stats.today).toMatchObject({ requests: 2, tokens: 200, cost: 2.5 })
    expect(stats.averages).toEqual({ rpm: 0.17, tpm: 33.33 })
  })

  test('detail stats fall back to aggregated model cost and keep invalid dates finite', async () => {
    redis.getApiKey.mockResolvedValue({
      id: 'key-1',
      createdAt: 'invalid',
      isV2Parent: 'false',
      dailyCostLimit: '0',
      weeklyOpusCostLimit: '0',
      weeklyFableCostLimit: '0',
      rateLimitWindow: '0'
    })
    dataByKey.set('usage:key-1:model:alltime:gpt-5.5', {
      totalRequests: '1',
      totalInputTokens: '10',
      totalOutputTokens: '5',
      ratedCostMicro: '1500000',
      realCostMicro: '1500000'
    })

    const stats = await calculateKeyDetailStats('key-1', { now: 0 })

    expect(stats.total.cost).toBe(1.5)
    expect(stats.averages).toEqual({ rpm: 1, tpm: 15 })
    expect(Number.isFinite(stats.averages.rpm)).toBe(true)
    expect(Number.isFinite(stats.averages.tpm)).toBe(true)
  })

  test('detail stats preserve v2 parent usage aggregation and ledger costs', async () => {
    redis.getApiKey.mockResolvedValue({
      id: 'parent-1',
      createdAt: '2026-06-02T11:00:00.000Z',
      isV2Parent: 'true',
      dailyCostLimit: '0',
      weeklyOpusCostLimit: '0',
      weeklyFableCostLimit: '0',
      rateLimitWindow: '0'
    })
    redis.getV2ParentSourceKeyIds.mockResolvedValue(['parent-1', 'child-1'])
    redis.getV2ParentLedgerCostStats.mockImplementation(async (_keyId, options) => ({
      total: 50,
      daily: options.timeRange === 'today' ? 5 : 0,
      period: options.timeRange === 'today' ? 5 : 50
    }))
    dataByKey.set('usage:parent-1:model:alltime:claude-opus-4-7', {
      totalRequests: '2',
      totalInputTokens: '100',
      totalOutputTokens: '50',
      ratedCostMicro: '1000000',
      realCostMicro: '1000000'
    })
    dataByKey.set('usage:child-1:model:alltime:claude-opus-4-7', {
      totalRequests: '3',
      totalInputTokens: '200',
      totalOutputTokens: '100',
      ratedCostMicro: '2000000',
      realCostMicro: '2000000'
    })
    dataByKey.set('usage:child-1:model:daily:claude-opus-4-7:2026-06-02', {
      totalRequests: '1',
      totalInputTokens: '20',
      totalOutputTokens: '10',
      ratedCostMicro: '500000',
      realCostMicro: '500000'
    })

    const stats = await calculateKeyDetailStats('parent-1', {
      now: new Date('2026-06-02T12:00:00.000Z')
    })

    expect(stats.total).toMatchObject({ requests: 5, tokens: 450, cost: 50 })
    expect(stats.today).toMatchObject({ requests: 1, tokens: 30, cost: 5 })
    expect(redis.getV2ParentLedgerCostStats).toHaveBeenCalledWith('parent-1', {
      timeRange: 'all',
      startDate: undefined,
      endDate: undefined
    })
    expect(redis.getV2ParentLedgerCostStats).toHaveBeenCalledWith('parent-1', {
      timeRange: 'today',
      startDate: undefined,
      endDate: undefined
    })
  })

  test('detail stats reject missing API keys', async () => {
    redis.getApiKey.mockResolvedValue({})

    await expect(calculateKeyDetailStats('missing')).rejects.toBeInstanceOf(
      ApiKeyStatsNotFoundError
    )
    expect(client.scan).not.toHaveBeenCalled()
  })

  test('validates supported time ranges and custom ranges', () => {
    expect(() => validateStatsTimeRange({ timeRange: '30days' })).not.toThrow()
    expect(() => validateStatsTimeRange({ timeRange: 'monthly' })).toThrow(/Invalid timeRange/)
    expect(() =>
      validateStatsTimeRange({
        timeRange: 'custom',
        startDate: '2026-06-02',
        endDate: '2026-06-01'
      })
    ).toThrow(/startDate/)
  })
})
