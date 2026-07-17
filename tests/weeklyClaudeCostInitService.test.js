jest.mock('../src/models/redis', () => ({
  getClientSafe: jest.fn(),
  getDateInTimezone: jest.fn(),
  getDateStringInTimezone: jest.fn(),
  getPeriodStartDate: jest.fn(),
  getPeriodString: jest.fn(),
  scanApiKeyIds: jest.fn(),
  setAccountLock: jest.fn(),
  releaseAccountLock: jest.fn(),
  getApiKey: jest.fn(),
  getV2ChildIds: jest.fn(),
  setWeeklyOpusCost: jest.fn(),
  setWeeklyFableCost: jest.fn(),
  setWeeklyClaudeCostSnapshot: jest.fn()
}))

jest.mock('../src/services/pricingService', () => ({
  pricingData: {},
  calculateCost: jest.fn()
}))

jest.mock('../src/services/serviceRatesService', () => ({
  getService: jest.fn(),
  getServiceRate: jest.fn()
}))

jest.mock('../src/utils/modelHelper', () => ({
  isClaudeFamilyModel: jest.fn((model) => String(model || '').startsWith('claude-')),
  isClaudeFableModel: jest.fn((model) => String(model || '').startsWith('claude-fable-5'))
}))

jest.mock('../src/utils/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn()
}))

const redis = require('../src/models/redis')
const pricingService = require('../src/services/pricingService')
const serviceRatesService = require('../src/services/serviceRatesService')
const weeklyClaudeCostInitService = require('../src/services/weeklyClaudeCostInitService')

function globToRegex(pattern) {
  return new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
}

function createRedisClient(dataByKey, writes = []) {
  return {
    get: jest.fn(async () => null),
    set: jest.fn(async (key, value) => {
      writes.push({ op: 'set', key, value })
      return 'OK'
    }),
    scan: jest.fn(async (_cursor, _match, pattern) => {
      const regex = globToRegex(pattern)
      const keys = [...dataByKey.keys()].filter((key) => regex.test(key))
      return ['0', keys]
    }),
    pipeline: jest.fn(() => {
      const commands = []
      const pipeline = {
        hgetall: jest.fn((key) => {
          commands.push(['hgetall', key])
          return pipeline
        }),
        set: jest.fn((key, value) => {
          commands.push(['set', key, value])
          return pipeline
        }),
        expire: jest.fn((key, ttl) => {
          commands.push(['expire', key, ttl])
          return pipeline
        }),
        exec: jest.fn(async () =>
          commands.map(([op, key, value]) => {
            if (op === 'hgetall') {
              return [null, dataByKey.get(key) || {}]
            }
            if (op === 'set') {
              writes.push({ op, key, value })
              return [null, 'OK']
            }
            return [null, 1]
          })
        )
      }
      return pipeline
    })
  }
}

describe('weeklyClaudeCostInitService', () => {
  let dataByKey
  let writes

  beforeEach(() => {
    jest.clearAllMocks()
    dataByKey = new Map()
    writes = []

    redis.getClientSafe.mockReturnValue(createRedisClient(dataByKey, writes))
    redis.getDateInTimezone.mockReturnValue(new Date(Date.UTC(2026, 5, 5, 12, 0, 0)))
    redis.getDateStringInTimezone.mockReturnValue('2026-06-05')
    redis.getPeriodStartDate.mockReturnValue(new Date(Date.UTC(2026, 5, 4, 19, 0, 0)))
    redis.getPeriodString.mockReturnValue('2026-06-04T19')
    redis.scanApiKeyIds.mockResolvedValue(['parent-key', 'child-key'])
    redis.setAccountLock.mockResolvedValue(true)
    redis.releaseAccountLock.mockResolvedValue()
    redis.setWeeklyOpusCost.mockResolvedValue()
    redis.setWeeklyFableCost.mockResolvedValue()
    redis.setWeeklyClaudeCostSnapshot.mockResolvedValue()
    redis.getV2ChildIds.mockResolvedValue([])
    serviceRatesService.getService.mockReturnValue('claude')
    serviceRatesService.getServiceRate.mockResolvedValue(1)
    pricingService.calculateCost.mockReturnValue({ totalCost: 0 })
  })

  test('backfills current week from stored cost and respects reset-hour hourly bucket', async () => {
    dataByKey.set('apikey:parent-key', {
      id: 'parent-key',
      claudeAccountId: 'claude-account',
      weeklyResetDay: '4',
      weeklyResetHour: '19',
      serviceRates: '{}'
    })
    dataByKey.set('apikey:child-key', {
      id: 'child-key',
      parentKeyId: 'parent-key',
      serviceRates: '{}'
    })
    dataByKey.set('usage:child-key:model:hourly:claude-sonnet-4-6:2026-06-04:18', {
      ratedCostMicro: '10000000',
      realCostMicro: '10000000'
    })
    dataByKey.set('usage:child-key:model:hourly:claude-sonnet-4-6:2026-06-04:19', {
      ratedCostMicro: '3000000',
      realCostMicro: '3000000'
    })
    dataByKey.set('usage:child-key:model:hourly:claude-fable-5:2026-06-04:20', {
      ratedCostMicro: '4000000',
      realCostMicro: '4000000'
    })
    dataByKey.set('usage:child-key:model:daily:claude-sonnet-4-6:2026-06-05', {
      ratedCostMicro: '2000000',
      realCostMicro: '2000000'
    })
    dataByKey.set('usage:parent-key:model:daily:claude-sonnet-4-6:2026-06-05', {
      ratedCostMicro: '1000000',
      realCostMicro: '1000000'
    })

    const result = await weeklyClaudeCostInitService.backfillCurrentWeekClaudeCosts()

    expect(result.success).toBe(true)
    expect(pricingService.calculateCost).not.toHaveBeenCalled()
    expect(writes).toEqual(
      expect.arrayContaining([
        {
          op: 'set',
          key: 'usage:opus:weekly:child-key:2026-06-04T19',
          value: '9'
        },
        {
          op: 'set',
          key: 'usage:opus:real:weekly:child-key:2026-06-04T19',
          value: '9'
        },
        {
          op: 'set',
          key: 'usage:fable:weekly:child-key:2026-06-04T19',
          value: '4'
        },
        {
          op: 'set',
          key: 'usage:fable:real:weekly:child-key:2026-06-04T19',
          value: '4'
        },
        {
          op: 'set',
          key: 'usage:opus:weekly:parent-key:2026-06-04T19',
          value: '1'
        },
        {
          op: 'set',
          key: 'usage:fable:weekly:parent-key:2026-06-04T19',
          value: '0'
        }
      ])
    )
  })

  test('single-key backfill falls back to token recomputation for legacy hashes', async () => {
    redis.scanApiKeyIds.mockResolvedValue([])
    redis.getApiKey.mockImplementation(async (id) => {
      if (id === 'child-key') {
        return { id: 'child-key', parentKeyId: 'parent-key', serviceRates: '{"claude":9}' }
      }
      if (id === 'parent-key') {
        return {
          id: 'parent-key',
          claudeAccountId: 'claude-account',
          weeklyResetDay: '4',
          weeklyResetHour: '19',
          serviceRates: '{"claude":2}'
        }
      }
      return null
    })
    pricingService.calculateCost.mockReturnValue({ totalCost: 2 })
    serviceRatesService.getServiceRate.mockResolvedValue(1.5)
    dataByKey.set('usage:child-key:model:daily:claude-sonnet-4-6:2026-06-05', {
      inputTokens: '1000',
      outputTokens: '500',
      cacheCreateTokens: '200',
      cacheReadTokens: '100',
      requests: '1'
    })

    const result = await weeklyClaudeCostInitService.backfillSingleKey('child-key')

    expect(result.success).toBe(true)
    expect(pricingService.calculateCost).toHaveBeenCalledTimes(1)
    expect(redis.setWeeklyClaudeCostSnapshot).toHaveBeenCalledWith('child-key', {
      periodString: '2026-06-04T19',
      ratedCost: 6,
      realCost: 2,
      fableRatedCost: 0,
      fableRealCost: 0
    })
  })

  test('backfills shared-pool Claude usage without a direct account binding', async () => {
    redis.scanApiKeyIds.mockResolvedValue(['shared-key'])
    dataByKey.set('apikey:shared-key', {
      id: 'shared-key',
      permissions: '["claude"]',
      weeklyOpusCostLimit: '200',
      weeklyResetDay: '4',
      weeklyResetHour: '19',
      serviceRates: '{}'
    })
    dataByKey.set('usage:shared-key:model:daily:claude-sonnet-4-6:2026-06-05', {
      ratedCostMicro: '34000000',
      realCostMicro: '17000000'
    })

    const result = await weeklyClaudeCostInitService.backfillCurrentWeekClaudeCosts()

    expect(result.success).toBe(true)
    expect(writes).toEqual(
      expect.arrayContaining([
        {
          op: 'set',
          key: 'usage:opus:weekly:shared-key:2026-06-04T19',
          value: '34'
        },
        {
          op: 'set',
          key: 'usage:opus:real:weekly:shared-key:2026-06-04T19',
          value: '17'
        }
      ])
    )
  })

  test('backfills a v2 parent and all child keys when its reset window changes', async () => {
    redis.getApiKey.mockImplementation(async (id) => {
      if (id === 'parent-key') {
        return {
          id: 'parent-key',
          isV2Parent: 'true',
          weeklyResetDay: '4',
          weeklyResetHour: '19'
        }
      }
      return {
        id,
        parentKeyId: 'parent-key'
      }
    })
    redis.getV2ChildIds.mockResolvedValue(['child-a', 'child-b'])
    const backfillSpy = jest
      .spyOn(weeklyClaudeCostInitService, 'backfillSingleKey')
      .mockResolvedValue({ success: true })

    const result = await weeklyClaudeCostInitService.backfillKeyFamily('parent-key')

    expect(result.success).toBe(true)
    expect(backfillSpy.mock.calls.map(([id]) => id)).toEqual(['parent-key', 'child-a', 'child-b'])
    backfillSpy.mockRestore()
  })
})
