// redis.getV2ParentLedgerCostStats 单元测试
// 覆盖（见 plan_tmp/v2-parent-admin-ledger-cost-display-plan_final.md 步骤 1 / 测试计划）：
// - total 取权威 ledger 键 usage:cost:v2:total，而非普通 usage:cost:total
// - daily/monthly 聚合「父 + 所有（含软删）子 key」，子集合走 getV2ChildIds（原始集合）
// - period 口径：all==total（ledger，不走 daily 求和）、today==daily、monthly==当月、
//   7days/30days/custom/dateRange==区间 daily 求和
// - 子集合读取异常时 fail-soft：total 仍为 ledger 值、不抛出、logger.warn 被调
// 设计：require 真实 redis 单例（同 redisApiKeyParse.test.js），注入 mock client + 固定系统时间。

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
const YESTERDAY = '2026-06-13'

// 默认数据：父自身今日 1.5 / 当月 3；child1 今日 10 当月 40 + 昨日 100；child2（软删，仍在集合）今日 5 当月 20
// ledger 总账 777.5（含已离场子 key 历史，故意 ≠ 普通 usage:cost:total 的 999 干扰值）
function defaultKv() {
  return {
    'usage:cost:v2:total:parent1': 777.5,
    'usage:cost:total:parent1': 999, // 干扰值：total 绝不能读到它
    'usage:cost:daily:parent1:2026-06-14': 1.5,
    'usage:cost:daily:child1:2026-06-14': 10,
    'usage:cost:daily:child2:2026-06-14': 5,
    'usage:cost:daily:child1:2026-06-13': 100,
    'usage:cost:monthly:parent1:2026-06': 3,
    'usage:cost:monthly:child1:2026-06': 40,
    'usage:cost:monthly:child2:2026-06': 20
  }
}

const DAILY_TODAY_SUM = 1.5 + 10 + 5 // 16.5
const MONTHLY_SUM = 3 + 40 + 20 // 63
const RANGE_SUM = DAILY_TODAY_SUM + 100 // 116.5（今日 + 昨日 child1）

// 注入式 mock client：get / smembers / pipeline().get().exec()
function makeClient({
  kv = defaultKv(),
  sets = { 'v2:children:parent1': ['child1', 'child2'] },
  smembersThrows = false
} = {}) {
  const read = (key) => (key in kv ? String(kv[key]) : null)
  return {
    get: jest.fn(async (key) => read(key)),
    smembers: jest.fn(async (key) => {
      if (smembersThrows) {
        throw new Error('redis smembers boom')
      }
      return key in sets ? sets[key].slice() : []
    }),
    pipeline: jest.fn(() => {
      const keys = []
      const api = {
        get(key) {
          keys.push(key)
          return api
        },
        exec: jest.fn(async () => keys.map((k) => [null, read(k)]))
      }
      return api
    })
  }
}

describe('redis.getV2ParentLedgerCostStats', () => {
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

  test('all：total 来自 v2 ledger 键（非普通 total），period==total，daily/monthly 为聚合值', async () => {
    const stats = await redis.getV2ParentLedgerCostStats(PARENT_ID, { timeRange: 'all' })

    expect(stats.source).toBe('v2-parent-ledger')
    expect(stats.total).toBeCloseTo(777.5, 6) // ledger 值，不是 999
    expect(stats.total).not.toBe(999)
    expect(stats.daily).toBeCloseTo(DAILY_TODAY_SUM, 6)
    expect(stats.monthly).toBeCloseTo(MONTHLY_SUM, 6)
    expect(stats.period).toBeCloseTo(777.5, 6) // all 走 ledger 总账，不是 daily 求和

    // total 必须读 v2 ledger 键
    expect(redis.client.get).toHaveBeenCalledWith('usage:cost:v2:total:parent1')
    expect(redis.client.get).not.toHaveBeenCalledWith('usage:cost:total:parent1')
  })

  test('today：period==daily==父+所有（含软删）子 key 今日之和', async () => {
    const stats = await redis.getV2ParentLedgerCostStats(PARENT_ID, { timeRange: 'today' })
    expect(stats.daily).toBeCloseTo(DAILY_TODAY_SUM, 6)
    expect(stats.period).toBeCloseTo(DAILY_TODAY_SUM, 6)
    // 子集合走原始集合 getV2ChildIds（含软删 child2）
    expect(redis.client.smembers).toHaveBeenCalledWith('v2:children:parent1')
  })

  test('monthly：period==当月父+子聚合', async () => {
    const stats = await redis.getV2ParentLedgerCostStats(PARENT_ID, { timeRange: 'monthly' })
    expect(stats.period).toBeCloseTo(MONTHLY_SUM, 6)
  })

  test('7days：period==最近 7 日 daily 区间求和（今日 + 昨日）', async () => {
    const stats = await redis.getV2ParentLedgerCostStats(PARENT_ID, { timeRange: '7days' })
    expect(stats.period).toBeCloseTo(RANGE_SUM, 6)
  })

  test('30days：period==最近 30 日 daily 区间求和', async () => {
    const stats = await redis.getV2ParentLedgerCostStats(PARENT_ID, { timeRange: '30days' })
    expect(stats.period).toBeCloseTo(RANGE_SUM, 6)
  })

  test('custom：period==[startDate,endDate] daily 区间求和', async () => {
    const stats = await redis.getV2ParentLedgerCostStats(PARENT_ID, {
      timeRange: 'custom',
      startDate: YESTERDAY,
      endDate: TODAY
    })
    expect(stats.period).toBeCloseTo(RANGE_SUM, 6)
  })

  test('dateRange 选项优先于命名 timeRange（供费用排序复用）', async () => {
    const stats = await redis.getV2ParentLedgerCostStats(PARENT_ID, {
      dateRange: { startDate: YESTERDAY, endDate: TODAY }
    })
    expect(stats.period).toBeCloseTo(RANGE_SUM, 6)
  })

  test('日期串与 getCostStats 同时区口径一致（today/MONTH 键名匹配）', async () => {
    const stats = await redis.getV2ParentLedgerCostStats(PARENT_ID, { timeRange: 'today' })
    // 用模块时区函数还原期望键名，确认 daily/monthly 用到的正是 TODAY / MONTH
    expect(redis.getDateStringInTimezone()).toBe(TODAY)
    expect(stats.daily).toBeGreaterThan(0)
  })

  test('无子 key 的全新父账号：daily/monthly 仅父自身，all 仍走 ledger', async () => {
    redis.client = makeClient({ sets: {} }) // getV2ChildIds 返回 []
    const stats = await redis.getV2ParentLedgerCostStats(PARENT_ID, { timeRange: 'all' })
    expect(stats.total).toBeCloseTo(777.5, 6)
    expect(stats.daily).toBeCloseTo(1.5, 6) // 仅父自身今日
    expect(stats.period).toBeCloseTo(777.5, 6)
  })

  test('fail-soft：子集合读取异常时 total 仍为 ledger 值、不抛出、logger.warn 被调', async () => {
    redis.client = makeClient({ smembersThrows: true })

    const stats = await redis.getV2ParentLedgerCostStats(PARENT_ID, { timeRange: 'all' })
    expect(stats.total).toBeCloseTo(777.5, 6) // total 在子聚合之前已取到
    expect(stats.daily).toBe(0)
    expect(stats.monthly).toBe(0)
    expect(stats.period).toBeCloseTo(777.5, 6) // all 回退 total
    expect(logger.warn).toHaveBeenCalled()
  })

  test('fail-soft：按日范围聚合异常时 period 降级为 0（不回退 total）', async () => {
    redis.client = makeClient({ smembersThrows: true })
    const stats = await redis.getV2ParentLedgerCostStats(PARENT_ID, { timeRange: '7days' })
    expect(stats.total).toBeCloseTo(777.5, 6)
    expect(stats.period).toBe(0)
    expect(logger.warn).toHaveBeenCalled()
  })
})
