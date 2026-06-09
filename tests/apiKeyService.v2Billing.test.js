// v2 父子账号计费核心测试（apiKeyService）
// 覆盖：子 key 实时继承父账号倍率、倍率后成本汇总到父总账、非 v2 不汇总、
// 父倍率无快照实时生效、父缺失回退子自身倍率、零成本不汇总、GPT fast 不重复叠加、
// ephemeral 保真、以及「每日成本 / 父总账 / 单条记录」三处计费口径一致。
//
// 设计要点（见 plan_tmp/v2-account-billing-edge-test-plan_revised.md）：
// - serviceRatesService.getService（同步）与 getServiceRate（异步）都要 mock（C2）。
// - redis.getApiKey 单次记录会被调用多次（子 + 父 + 再读子），必须按入参分发 mock（C3）。
// - 父账号查不到时 calculateRatedCost 回退到「子 key 自身 serviceRates」，而非默认 1.0（C4）。
// - ephemeral 断言只针对 recordUsageWithDetails（recordUsage 向 incrementTokenUsage 硬编码 0，C5）。

jest.mock(
  '../config/config',
  () => ({
    security: {
      apiKeyPrefix: 'cr_',
      encryptionKey: 'test-encryption-key-0000000000000'
    }
  }),
  { virtual: true }
)

jest.mock('../src/models/redis', () => ({
  getApiKey: jest.fn(),
  setApiKey: jest.fn(),
  incrementTokenUsage: jest.fn(),
  incrementDailyCost: jest.fn(),
  incrementAccountUsage: jest.fn(),
  incrementV2ParentTotalCost: jest.fn(),
  incrementWeeklyOpusCost: jest.fn(),
  addUsageRecord: jest.fn()
}))

jest.mock('../src/services/costRankService', () => ({
  addKeyToIndexes: jest.fn()
}))

jest.mock('../src/services/apiKeyIndexService', () => ({
  addToIndex: jest.fn(),
  updateIndex: jest.fn(),
  updateLastUsedAt: jest.fn()
}))

jest.mock('../src/utils/logger', () => ({
  success: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  database: jest.fn(),
  debug: jest.fn(),
  info: jest.fn()
}))

jest.mock('../src/services/serviceRatesService', () => ({
  getService: jest.fn(),
  getServiceRate: jest.fn()
}))
jest.mock('../src/services/requestDetailService', () => ({
  captureRequestDetail: jest.fn()
}))
jest.mock('../src/services/billingEventPublisher', () => ({
  publishBillingEvent: jest.fn()
}))
jest.mock('../src/utils/costCalculator', () => ({
  calculateCost: jest.fn()
}))
// isClaudeFamilyModel → false 让 recordOpusCost 直接 return，隔离无关分支
jest.mock('../src/utils/modelHelper', () => ({
  isClaudeFamilyModel: jest.fn(() => false)
}))
jest.mock('../src/utils/requestDetailHelper', () => ({
  finalizeRequestDetailMeta: jest.fn((value) => value)
}))

const redis = require('../src/models/redis')
const serviceRatesService = require('../src/services/serviceRatesService')
const requestDetailService = require('../src/services/requestDetailService')
const billingEventPublisher = require('../src/services/billingEventPublisher')
const CostCalculator = require('../src/utils/costCalculator')
const apiKeyService = require('../src/services/apiKeyService')

const CHILD_ID = 'child-key-1'
const PARENT_ID = 'parent-key-1'
const SERVICE = 'codex'

// 子 key 自身倍率故意与父不同（9 vs 1.5），确保「误用子配置」无法通过测试
const childData = () => ({
  id: CHILD_ID,
  name: 'Child',
  parentKeyId: PARENT_ID,
  serviceRates: JSON.stringify({ [SERVICE]: 9 })
})
const parentData = () => ({
  id: PARENT_ID,
  name: 'Parent',
  isV2Parent: 'true',
  serviceRates: JSON.stringify({ [SERVICE]: 1.5 })
})

// 按入参分发的默认 getApiKey（child 带 parentKeyId、parent 非空、其余 null）
function mockKeyTopology({ child = childData(), parent = parentData() } = {}) {
  redis.getApiKey.mockImplementation((id) =>
    Promise.resolve(id === CHILD_ID ? { ...child } : id === PARENT_ID ? { ...parent } : null)
  )
}

describe('apiKeyService v2 billing', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockKeyTopology()
    redis.setApiKey.mockResolvedValue()
    redis.incrementTokenUsage.mockResolvedValue()
    redis.incrementDailyCost.mockResolvedValue()
    redis.incrementAccountUsage.mockResolvedValue()
    redis.incrementV2ParentTotalCost.mockResolvedValue()
    redis.incrementWeeklyOpusCost.mockResolvedValue()
    redis.addUsageRecord.mockResolvedValue()
    serviceRatesService.getService.mockReturnValue(SERVICE)
    serviceRatesService.getServiceRate.mockResolvedValue(2)
    requestDetailService.captureRequestDetail.mockResolvedValue({ captured: true })
    billingEventPublisher.publishBillingEvent.mockResolvedValue()
  })

  // 1. 子 key 计费使用父账号倍率（而非子自身倍率）
  test('child key uses parent serviceRates, not its own', async () => {
    // global=2, parent[codex]=1.5, child[codex]=9, realCost=1 → rated = 1*2*1.5 = 3
    const rated = await apiKeyService.calculateRatedCost(CHILD_ID, SERVICE, 1)
    expect(rated).toBeCloseTo(3, 10)
    // 证明没用子的 9（否则会是 1*2*9 = 18）
    expect(rated).not.toBeCloseTo(18, 5)
  })

  // 2. recordUsage：倍率后成本写入父总账（写的是 ratedCost 而非 realCost）
  test('recordUsage rolls up rated (not real) cost to parent total', async () => {
    CostCalculator.calculateCost.mockReturnValue({
      costs: { total: 1, input: 1, output: 0, cacheCreate: 0, cacheRead: 0 }
    })

    const result = await apiKeyService.recordUsage(
      CHILD_ID,
      100,
      0,
      0,
      0,
      'gpt-5.5',
      'acct-1',
      'openai',
      null,
      null
    )

    expect(result.realCost).toBeCloseTo(1, 10)
    expect(result.ratedCost).toBeCloseTo(3, 10)
    expect(redis.incrementV2ParentTotalCost).toHaveBeenCalledTimes(1)
    const [pid, amount] = redis.incrementV2ParentTotalCost.mock.calls[0]
    expect(pid).toBe(PARENT_ID)
    expect(amount).toBeCloseTo(3, 10) // ratedCost
    expect(amount).not.toBeCloseTo(1, 5) // 不是 realCost
  })

  // 3. recordUsageWithDetails：同样把倍率后成本写入父总账
  test('recordUsageWithDetails also rolls up rated cost to parent total', async () => {
    CostCalculator.calculateCost.mockReturnValue({
      costs: {
        total: 2,
        input: 2,
        output: 0,
        cacheCreate: 0,
        cacheRead: 0,
        ephemeral5m: 0,
        ephemeral1h: 0
      }
    })

    const result = await apiKeyService.recordUsageWithDetails(
      CHILD_ID,
      { input_tokens: 200, output_tokens: 0 },
      'gpt-5.5',
      'acct-1',
      'openai',
      null
    )

    // global=2, parent[codex]=1.5, realCost=2 → rated = 2*2*1.5 = 6
    expect(result.ratedCost).toBeCloseTo(6, 10)
    expect(redis.incrementV2ParentTotalCost).toHaveBeenCalledTimes(1)
    const [pid, amount] = redis.incrementV2ParentTotalCost.mock.calls[0]
    expect(pid).toBe(PARENT_ID)
    expect(amount).toBeCloseTo(6, 10)
  })

  // 4. 非 v2 key（无 parentKeyId）不写父总账
  test('non-v2 key does not roll up to any parent total', async () => {
    mockKeyTopology({ child: { id: CHILD_ID, name: 'Plain', serviceRates: '{}' } })
    CostCalculator.calculateCost.mockReturnValue({
      costs: { total: 1, input: 1, output: 0, cacheCreate: 0, cacheRead: 0 }
    })

    await apiKeyService.recordUsage(
      CHILD_ID,
      100,
      0,
      0,
      0,
      'gpt-5.5',
      'acct-1',
      'openai',
      null,
      null
    )

    expect(redis.incrementV2ParentTotalCost).not.toHaveBeenCalled()
  })

  // 5. 父倍率实时生效（无快照）：两次调用之间改父倍率，结果随之改变
  test('parent rate change takes effect immediately (no snapshot)', async () => {
    serviceRatesService.getServiceRate.mockResolvedValue(1)

    mockKeyTopology({
      child: { id: CHILD_ID, parentKeyId: PARENT_ID, serviceRates: '{}' },
      parent: { id: PARENT_ID, serviceRates: JSON.stringify({ [SERVICE]: 1.2 }) }
    })
    const r1 = await apiKeyService.calculateRatedCost(CHILD_ID, SERVICE, 10) // 10*1*1.2 = 12

    mockKeyTopology({
      child: { id: CHILD_ID, parentKeyId: PARENT_ID, serviceRates: '{}' },
      parent: { id: PARENT_ID, serviceRates: JSON.stringify({ [SERVICE]: 2.0 }) }
    })
    const r2 = await apiKeyService.calculateRatedCost(CHILD_ID, SERVICE, 10) // 10*1*2.0 = 20

    expect(r1).toBeCloseTo(12, 10)
    expect(r2).toBeCloseTo(20, 10)
  })

  // 6. 父账号查不到 → 回退「子 key 自身倍率」（C4），不是默认 1.0、也不抛错
  test('falls back to child own serviceRates when parent is missing', async () => {
    serviceRatesService.getServiceRate.mockResolvedValue(1)
    // child 有 parentKeyId 但 getApiKey(PARENT_ID) 返回 null
    redis.getApiKey.mockImplementation((id) =>
      Promise.resolve(
        id === CHILD_ID
          ? { id: CHILD_ID, parentKeyId: PARENT_ID, serviceRates: JSON.stringify({ [SERVICE]: 9 }) }
          : null
      )
    )

    const rated = await apiKeyService.calculateRatedCost(CHILD_ID, SERVICE, 1) // 1*1*9 = 9（子自身）
    expect(rated).toBeCloseTo(9, 10)
  })

  // 7. realCost=0：不写父总账、不写每日成本（门槛 realCost>0 / ratedCost>0）
  test('zero real cost rolls up nothing and records no daily cost', async () => {
    CostCalculator.calculateCost.mockReturnValue({
      costs: { total: 0, input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }
    })

    await apiKeyService.recordUsage(CHILD_ID, 0, 0, 0, 0, 'gpt-5.5', 'acct-1', 'openai', null, null)

    expect(redis.incrementV2ParentTotalCost).not.toHaveBeenCalled()
    expect(redis.incrementDailyCost).not.toHaveBeenCalled()
  })

  // 8. GPT fast 与父倍率叠加不重复：真实成本已含 fast 价，v2 层只再乘一次服务倍率
  test('GPT fast cost is multiplied by parent rate once, not re-applied', async () => {
    // calculateCost 返回的 total 已是「含 fast 的真实成本」
    CostCalculator.calculateCost.mockReturnValue({
      costs: {
        total: 1,
        input: 1,
        output: 0,
        cacheCreate: 0,
        cacheRead: 0,
        ephemeral5m: 0,
        ephemeral1h: 0
      }
    })

    const result = await apiKeyService.recordUsageWithDetails(
      CHILD_ID,
      { input_tokens: 100, output_tokens: 0 },
      'gpt-5.5',
      'acct-1',
      'openai',
      null
    )

    // 仅 realCost * global * keyRate = 1 * 2 * 1.5 = 3，v2 层不再实现 fast 公式
    expect(result.ratedCost).toBeCloseTo(3, 10)
  })

  // 9.（仅 recordUsageWithDetails）cache / ephemeral 保真
  test('recordUsageWithDetails preserves ephemeral 5m/1h tokens and cost breakdown', async () => {
    const E5 = 1234
    const E1 = 567
    CostCalculator.calculateCost.mockReturnValue({
      costs: {
        total: 2,
        input: 1,
        output: 0,
        cacheCreate: 1,
        cacheRead: 0,
        ephemeral5m: 0.6,
        ephemeral1h: 0.4
      }
    })

    await apiKeyService.recordUsageWithDetails(
      CHILD_ID,
      {
        input_tokens: 100,
        output_tokens: 0,
        cache_creation_input_tokens: 1801,
        cache_read_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: E5, ephemeral_1h_input_tokens: E1 }
      },
      'claude-sonnet-4-5',
      'acct-1',
      'claude-console',
      null
    )

    // incrementTokenUsage 第 8/9 个实参（index 7/8）= ephemeral5m / ephemeral1h
    const itCall = redis.incrementTokenUsage.mock.calls[0]
    expect(itCall[7]).toBe(E5)
    expect(itCall[8]).toBe(E1)

    const record = redis.addUsageRecord.mock.calls[0][1]
    expect(record.ephemeral5mTokens).toBe(E5)
    expect(record.ephemeral1hTokens).toBe(E1)
    expect(record.costBreakdown).toHaveProperty('ephemeral5m')
    expect(record.costBreakdown).toHaveProperty('ephemeral1h')
    expect(record.realCostBreakdown).toHaveProperty('ephemeral5m')
    expect(record.realCostBreakdown).toHaveProperty('ephemeral1h')
  })

  // 10. 三处计费口径一致：每日成本(rated) === 父总账 === 单条记录 cost
  test('daily cost, parent total and usage record cost are the same rated value', async () => {
    CostCalculator.calculateCost.mockReturnValue({
      costs: {
        total: 2,
        input: 2,
        output: 0,
        cacheCreate: 0,
        cacheRead: 0,
        ephemeral5m: 0,
        ephemeral1h: 0
      }
    })
    serviceRatesService.getServiceRate.mockResolvedValue(2)

    await apiKeyService.recordUsageWithDetails(
      CHILD_ID,
      { input_tokens: 200, output_tokens: 0 },
      'gpt-5.5',
      'acct-1',
      'openai',
      null
    )

    // rated = 2 * 2 * 1.5 = 6
    const dailyRated = redis.incrementDailyCost.mock.calls[0][1]
    const parentAmount = redis.incrementV2ParentTotalCost.mock.calls[0][1]
    const recordCost = redis.addUsageRecord.mock.calls[0][1].cost

    expect(dailyRated).toBeCloseTo(6, 10)
    expect(parentAmount).toBeCloseTo(6, 10)
    expect(recordCost).toBe(Number(dailyRated.toFixed(6)))
    expect(recordCost).toBe(Number(parentAmount.toFixed(6)))
  })
})
