// costRankService 费用排序 v2 父账号口径测试（plan_final 步骤 3 / S1）
// 覆盖 _calculateBatchCosts：
// - all（useTotal）：v2 父账号读 usage:cost:v2:total（ledger），非 v2 仍读 usage:cost:total
// - 按日范围：v2 父账号用 redis.getV2ParentLedgerCostStats 的 period 覆盖自身 daily 求和
// - 纯非 v2：完全不触发 ledger helper，行为不变
// 设计：mock redis（getClient / getV2ParentLedgerCostStats）+ logger，直接调被测私有方法。

jest.mock('../src/models/redis', () => ({
  getClient: jest.fn(),
  getV2ParentLedgerCostStats: jest.fn()
}))

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  debug: jest.fn()
}))

const redis = require('../src/models/redis')
const costRankService = require('../src/services/costRankService')

// 注入式 mock client：pipeline().get(key).exec() 按入参顺序返回 [null, value]
function makeClient(kv = {}) {
  const read = (key) => (key in kv ? String(kv[key]) : null)
  return {
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

describe('costRankService._calculateBatchCosts（v2 父账号口径）', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  test('all：v2 父账号读 v2 ledger 总账键，非 v2 读普通 total', async () => {
    const kv = {
      'usage:cost:total:normal1': 12,
      'usage:cost:v2:total:parent1': 500, // v2 父账号应读到它
      'usage:cost:total:parent1': 999 // 干扰值：绝不能读到
    }
    redis.getClient.mockReturnValue(makeClient(kv))

    const activeKeys = [
      { id: 'normal1', isV2Parent: false },
      { id: 'parent1', isV2Parent: true }
    ]
    const costs = await costRankService._calculateBatchCosts(activeKeys, { useTotal: true })

    expect(costs.get('normal1')).toBeCloseTo(12, 6)
    expect(costs.get('parent1')).toBeCloseTo(500, 6) // ledger，不是 999
    expect(redis.getV2ParentLedgerCostStats).not.toHaveBeenCalled() // all 分支不需 helper
  })

  test('按日范围：v2 父账号用 ledger helper 的 period 覆盖；非 v2 走 daily 求和', async () => {
    const startDate = '2026-06-13'
    const endDate = '2026-06-14'
    // 用被测实例自身的日期枚举，规避宿主时区差异
    const dates = costRankService._getDatesBetween(startDate, endDate)

    const kv = {}
    dates.forEach((d) => {
      kv[`usage:cost:daily:normal1:${d}`] = 7
      kv[`usage:cost:daily:parent1:${d}`] = 3 // 父自身（会被 ledger period 覆盖）
    })
    redis.getClient.mockReturnValue(makeClient(kv))
    redis.getV2ParentLedgerCostStats.mockResolvedValue({ period: 333 })

    const activeKeys = [
      { id: 'normal1', isV2Parent: false },
      { id: 'parent1', isV2Parent: true }
    ]
    const costs = await costRankService._calculateBatchCosts(activeKeys, { startDate, endDate })

    expect(costs.get('normal1')).toBeCloseTo(7 * dates.length, 6)
    expect(costs.get('parent1')).toBeCloseTo(333, 6) // 被 ledger period 覆盖，而非 3*dates.length
    expect(redis.getV2ParentLedgerCostStats).toHaveBeenCalledWith('parent1', {
      dateRange: { startDate, endDate }
    })
  })

  test('纯非 v2 批次：完全不触发 ledger helper', async () => {
    redis.getClient.mockReturnValue(
      makeClient({ 'usage:cost:total:a': 1, 'usage:cost:total:b': 2 })
    )
    const activeKeys = [
      { id: 'a', isV2Parent: false },
      { id: 'b', isV2Parent: false }
    ]
    const costs = await costRankService._calculateBatchCosts(activeKeys, { useTotal: true })

    expect(costs.get('a')).toBeCloseTo(1, 6)
    expect(costs.get('b')).toBeCloseTo(2, 6)
    expect(redis.getV2ParentLedgerCostStats).not.toHaveBeenCalled()
  })
})
