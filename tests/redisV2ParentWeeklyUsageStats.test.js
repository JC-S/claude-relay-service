// redis v2 父账号读侧聚合单元测试
// 覆盖（见 plan_tmp/v2-parent-weekly-cost-display-fix-plan_revised.md 步骤 1 / 测试计划）：
// - getV2ParentSourceKeyIds：父 + 所有（含软删）子，子集合走原始 getV2ChildIds；异常 fail-soft 返回 [parent]
// - getV2ParentWeeklyOpusCost：聚合父 + 子的 usage:opus:weekly:{id}:{periodStr}；
//     period 串必须是 YYYY-MM-DDThh（getPeriodString），绝不能是 ISO 周 YYYY-Wxx；
//     软删子计入、硬删（移出集合）不计入；异常 fail-soft 回退父账号自身周费用 + logger.warn
// - getV2ParentUsageStats：聚合父 + 子的 total/daily/monthly requests/tokens，
//     averages 以父账号 createdAt 为基准重算；旧数据（仅 totalTokens）按 30/70 拆分；异常 fail-soft 回退父自身
// 设计：require 真实 redis 单例（同 redisV2ParentLedgerCost.test.js），注入 mock client + 固定系统时间。

jest.mock(
  '../config/config',
  () => ({
    system: {
      timezoneOffset: 8
    }
  }),
  { virtual: true }
)

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  debug: jest.fn()
}))

const redis = require('../src/models/redis')
const logger = require('../src/utils/logger')

const PARENT_ID = 'parent1'

// 固定「今天」= 2026-06-14（UTC+8）：2026-06-14T03:00Z + 8h = 11:00Z 同日
const FIXED_NOW = new Date('2026-06-14T03:00:00Z')
const TODAY = '2026-06-14'
const MONTH = '2026-06'

// 周期串用真实 getPeriodString 计算（显式传入 FIXED_NOW，与 fake timers 无关）
// 默认重置 = 周一 00:00；自定义重置 = 周三 10:00，用于验证 period 串随 reset 配置变化且仍是 YYYY-MM-DDThh
const PERIOD = redis.getPeriodString(1, 0, FIXED_NOW)
const PERIOD_CUSTOM = redis.getPeriodString(3, 10, FIXED_NOW)

// 周费用：父 2 + child1 10 + child2(软删，仍在集合) 5 = 17
const WEEKLY_SUM = 2 + 10 + 5
const FABLE_WEEKLY_SUM = 1 + 4 + 2
// 用量聚合期望值（见下方 defaultKv）
const TOTAL_REQUESTS = 2 + 10 + 5 // 17
const TOTAL_ALLTOKENS = 100 + 1100 + 500 // 1700
const TOTAL_INPUT = 30 + 300 + 150 // 480
const TOTAL_OUTPUT = 70 + 700 + 350 // 1120
const TOTAL_CACHE_CREATE = 0 + 50 + 0 // 50
const TOTAL_CACHE_READ = 0 + 50 + 0 // 50
const DAILY_REQUESTS = 1 + 4 + 2 // 7
const DAILY_ALLTOKENS = 10 + 40 + 20 // 70
const MONTHLY_REQUESTS = 2 + 8 + 4 // 14
const MONTHLY_ALLTOKENS = 20 + 80 + 40 // 140

function defaultKv() {
  return {
    // 周费用（period 串键，子 key 以父 reset 配置存储；child2 软删仍在集合）
    [`usage:opus:weekly:parent1:${PERIOD}`]: 2,
    [`usage:opus:weekly:child1:${PERIOD}`]: 10,
    [`usage:opus:weekly:child2:${PERIOD}`]: 5,
    [`usage:fable:weekly:parent1:${PERIOD}`]: 1,
    [`usage:fable:weekly:child1:${PERIOD}`]: 4,
    [`usage:fable:weekly:child2:${PERIOD}`]: 2,
    // 用量 total（父自身保留升级前少量；子为主力）
    'usage:parent1': {
      totalRequests: '2',
      totalInputTokens: '30',
      totalOutputTokens: '70',
      totalAllTokens: '100'
    },
    'usage:child1': {
      totalRequests: '10',
      totalInputTokens: '300',
      totalOutputTokens: '700',
      totalCacheCreateTokens: '50',
      totalCacheReadTokens: '50',
      totalAllTokens: '1100'
    },
    'usage:child2': {
      totalRequests: '5',
      totalInputTokens: '150',
      totalOutputTokens: '350',
      totalAllTokens: '500'
    },
    // daily（当日）
    [`usage:daily:parent1:${TODAY}`]: { totalRequests: '1', totalAllTokens: '10' },
    [`usage:daily:child1:${TODAY}`]: { totalRequests: '4', totalAllTokens: '40' },
    [`usage:daily:child2:${TODAY}`]: { totalRequests: '2', totalAllTokens: '20' },
    // monthly（当月）
    [`usage:monthly:parent1:${MONTH}`]: { totalRequests: '2', totalAllTokens: '20' },
    [`usage:monthly:child1:${MONTH}`]: { totalRequests: '8', totalAllTokens: '80' },
    [`usage:monthly:child2:${MONTH}`]: { totalRequests: '4', totalAllTokens: '40' },
    // 父账号创建时间（averages 基准）：FIXED_NOW - 10 天 → daysSinceCreated=10
    'apikey:parent1': { createdAt: '2026-06-04T03:00:00Z' }
  }
}

// 注入式 mock client：get / hgetall / smembers / pipeline().get()/.hgetall().exec()
function makeClient({
  kv = defaultKv(),
  sets = { 'v2:children:parent1': ['child1', 'child2'] },
  smembersThrows = false,
  pipelineThrows = false
} = {}) {
  const read = (key) => (key in kv ? kv[key] : null)
  const client = {
    _pipelineKeys: [],
    get: jest.fn(async (key) => {
      const v = read(key)
      return v === null || v === undefined ? null : String(v)
    }),
    hgetall: jest.fn(async (key) => {
      const v = read(key)
      return v && typeof v === 'object' ? { ...v } : {}
    }),
    smembers: jest.fn(async (key) => {
      if (smembersThrows) {
        throw new Error('redis smembers boom')
      }
      return key in sets ? sets[key].slice() : []
    }),
    pipeline: jest.fn(() => {
      const ops = []
      const api = {
        get(key) {
          ops.push(key)
          client._pipelineKeys.push(key)
          return api
        },
        hgetall(key) {
          ops.push(key)
          client._pipelineKeys.push(key)
          return api
        },
        exec: jest.fn(async () => {
          if (pipelineThrows) {
            throw new Error('redis pipeline boom')
          }
          return ops.map((k) => [null, read(k)])
        })
      }
      return api
    })
  }
  return client
}

describe('redis.getV2ParentSourceKeyIds', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(FIXED_NOW)
    redis.client = makeClient()
  })
  afterEach(() => {
    jest.useRealTimers()
    jest.clearAllMocks()
    redis.client = null
  })

  test('返回 [父 + 所有（含软删）子]，子集合走原始 getV2ChildIds', async () => {
    const ids = await redis.getV2ParentSourceKeyIds(PARENT_ID)
    expect(ids).toEqual(['parent1', 'child1', 'child2'])
    expect(redis.client.smembers).toHaveBeenCalledWith('v2:children:parent1')
  })

  test('无子 key 的全新父账号：仅返回 [parent]', async () => {
    redis.client = makeClient({ sets: {} })
    const ids = await redis.getV2ParentSourceKeyIds(PARENT_ID)
    expect(ids).toEqual(['parent1'])
  })

  test('fail-soft：子集合读取异常时返回 [parent]、不抛出、logger.warn 被调', async () => {
    redis.client = makeClient({ smembersThrows: true })
    const ids = await redis.getV2ParentSourceKeyIds(PARENT_ID)
    expect(ids).toEqual(['parent1'])
    expect(logger.warn).toHaveBeenCalled()
  })
})

describe('redis.getV2ParentWeeklyOpusCost', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(FIXED_NOW)
    redis.client = makeClient()
  })
  afterEach(() => {
    jest.useRealTimers()
    jest.clearAllMocks()
    redis.client = null
  })

  test('聚合父 + 两个子（含软删）的本周期周费用之和', async () => {
    const cost = await redis.getV2ParentWeeklyOpusCost(PARENT_ID, 1, 0)
    expect(cost).toBeCloseTo(WEEKLY_SUM, 6) // 17
    expect(redis.client.smembers).toHaveBeenCalledWith('v2:children:parent1')
  })

  test('读取的 period 串是 YYYY-MM-DDThh（getPeriodString），绝不是 ISO 周 YYYY-Wxx', async () => {
    await redis.getV2ParentWeeklyOpusCost(PARENT_ID, 1, 0)
    const keys = redis.client._pipelineKeys
    expect(keys).toEqual([
      `usage:opus:weekly:parent1:${PERIOD}`,
      `usage:opus:weekly:child1:${PERIOD}`,
      `usage:opus:weekly:child2:${PERIOD}`
    ])
    for (const k of keys) {
      expect(k).toMatch(/usage:opus:weekly:.+:\d{4}-\d{2}-\d{2}T\d{2}$/)
      expect(k).not.toMatch(/\d{4}-W\d{2}$/)
    }
  })

  test('自定义 resetDay/resetHour：period 串随 reset 变化且仍是 YYYY-MM-DDThh', async () => {
    await redis.getV2ParentWeeklyOpusCost(PARENT_ID, 3, 10)
    const keys = redis.client._pipelineKeys
    expect(keys[0]).toBe(`usage:opus:weekly:parent1:${PERIOD_CUSTOM}`)
    expect(keys[0]).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}$/)
  })

  test('软删子计入、硬删（移出集合）不计入', async () => {
    // child2 已硬删（从 v2:children 集合移除）→ 周费用仅父 2 + child1 10 = 12
    redis.client = makeClient({ sets: { 'v2:children:parent1': ['child1'] } })
    const cost = await redis.getV2ParentWeeklyOpusCost(PARENT_ID, 1, 0)
    expect(cost).toBeCloseTo(2 + 10, 6)
  })

  test('fail-soft：pipeline 异常时回退父账号自身周费用 + logger.warn', async () => {
    redis.client = makeClient({ pipelineThrows: true })
    const cost = await redis.getV2ParentWeeklyOpusCost(PARENT_ID, 1, 0)
    expect(cost).toBeCloseTo(2, 6) // 仅父自身
    expect(logger.warn).toHaveBeenCalled()
  })
})

describe('redis.getV2ParentWeeklyFableCost', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(FIXED_NOW)
    redis.client = makeClient()
  })
  afterEach(() => {
    jest.useRealTimers()
    jest.clearAllMocks()
    redis.client = null
  })

  test('聚合父 + 两个子（含软删）的本周期 Fable 周费用之和', async () => {
    const cost = await redis.getV2ParentWeeklyFableCost(PARENT_ID, 1, 0)
    expect(cost).toBeCloseTo(FABLE_WEEKLY_SUM, 6)
    expect(redis.client.smembers).toHaveBeenCalledWith('v2:children:parent1')
  })

  test('读取 usage:fable:weekly 且 period 串是 YYYY-MM-DDThh', async () => {
    await redis.getV2ParentWeeklyFableCost(PARENT_ID, 1, 0)
    const keys = redis.client._pipelineKeys
    expect(keys).toEqual([
      `usage:fable:weekly:parent1:${PERIOD}`,
      `usage:fable:weekly:child1:${PERIOD}`,
      `usage:fable:weekly:child2:${PERIOD}`
    ])
    for (const k of keys) {
      expect(k).toMatch(/usage:fable:weekly:.+:\d{4}-\d{2}-\d{2}T\d{2}$/)
      expect(k).not.toMatch(/\d{4}-W\d{2}$/)
    }
  })

  test('fail-soft：pipeline 异常时回退父账号自身 Fable 周费用 + logger.warn', async () => {
    redis.client = makeClient({ pipelineThrows: true })
    const cost = await redis.getV2ParentWeeklyFableCost(PARENT_ID, 1, 0)
    expect(cost).toBeCloseTo(1, 6)
    expect(logger.warn).toHaveBeenCalled()
  })
})

describe('redis.getV2ParentUsageStats', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(FIXED_NOW)
    redis.client = makeClient()
  })
  afterEach(() => {
    jest.useRealTimers()
    jest.clearAllMocks()
    redis.client = null
  })

  test('total/daily/monthly 聚合父 + 所有（含软删）子的 requests 与各类 tokens', async () => {
    const stats = await redis.getV2ParentUsageStats(PARENT_ID)

    expect(stats.total.requests).toBe(TOTAL_REQUESTS) // 17
    expect(stats.total.allTokens).toBe(TOTAL_ALLTOKENS) // 1700
    expect(stats.total.tokens).toBe(TOTAL_ALLTOKENS) // tokens 与 allTokens 对齐
    expect(stats.total.inputTokens).toBe(TOTAL_INPUT) // 480
    expect(stats.total.outputTokens).toBe(TOTAL_OUTPUT) // 1120
    expect(stats.total.cacheCreateTokens).toBe(TOTAL_CACHE_CREATE) // 50
    expect(stats.total.cacheReadTokens).toBe(TOTAL_CACHE_READ) // 50

    expect(stats.daily.requests).toBe(DAILY_REQUESTS) // 7
    expect(stats.daily.allTokens).toBe(DAILY_ALLTOKENS) // 70
    expect(stats.monthly.requests).toBe(MONTHLY_REQUESTS) // 14
    expect(stats.monthly.allTokens).toBe(MONTHLY_ALLTOKENS) // 140

    // 子集合走原始 getV2ChildIds（含软删 child2）
    expect(redis.client.smembers).toHaveBeenCalledWith('v2:children:parent1')
  })

  test('averages 以父账号 createdAt 为基准重算（daysSinceCreated=10）', async () => {
    const stats = await redis.getV2ParentUsageStats(PARENT_ID)
    // dailyRequests = 17/10 = 1.7；dailyTokens = 1700/10 = 170
    expect(stats.averages.dailyRequests).toBeCloseTo(1.7, 6)
    expect(stats.averages.dailyTokens).toBeCloseTo(170, 6)
    expect(typeof stats.averages.rpm).toBe('number')
    expect(typeof stats.averages.tpm).toBe('number')
  })

  test('旧数据（仅 totalTokens，无 input/output 分离）按 30/70 拆分后聚合', async () => {
    // child1 改为旧数据：totalTokens 1000 → input 300 / output 700 / allTokens 1000
    const kv = defaultKv()
    kv['usage:child1'] = { totalRequests: '3', totalTokens: '1000' }
    redis.client = makeClient({ kv })

    const stats = await redis.getV2ParentUsageStats(PARENT_ID)
    // 父(input30/output70/all100) + child1 旧(input300/output700/all1000) + child2(input150/output350/all500)
    expect(stats.total.inputTokens).toBe(30 + 300 + 150) // 480
    expect(stats.total.outputTokens).toBe(70 + 700 + 350) // 1120
    expect(stats.total.allTokens).toBe(100 + 1000 + 500) // 1600
    expect(stats.total.requests).toBe(2 + 3 + 5) // 10
  })

  test('无子 key 的全新父账号：聚合仅父自身', async () => {
    redis.client = makeClient({ sets: {} })
    const stats = await redis.getV2ParentUsageStats(PARENT_ID)
    expect(stats.total.requests).toBe(2)
    expect(stats.total.allTokens).toBe(100)
  })

  test('fail-soft：pipeline 异常时回退父账号自身用量 + logger.warn', async () => {
    redis.client = makeClient({ pipelineThrows: true })
    const stats = await redis.getV2ParentUsageStats(PARENT_ID)
    // 回退 getUsageStats(parent)（不走 pipeline），仅父自身
    expect(stats.total.requests).toBe(2)
    expect(stats.total.allTokens).toBe(100)
    expect(logger.warn).toHaveBeenCalled()
  })
})
