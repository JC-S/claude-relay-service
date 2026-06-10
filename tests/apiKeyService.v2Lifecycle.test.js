// v2 账号生命周期修复回归测试（apiKeyService）
// 覆盖（对应 plan_tmp/v2-account-review-fix-plan_revised.md）：
// F1 upgradeToV2Parent 清 expiresAt / cleanupExpiredKeys 跳过 v2 父账号；
// F3 resetV2Password/changeV2Password 写 v2PasswordChangedAt；
// F4 getAllApiKeysFast(keyIds) 局部加载、getV2Children 走 children 集合 + 脏数据过滤、
//    子 key 上限按未软删除数量、addV2Child 失败回滚软删除；
// F5 updateV2Child 白名单 + 数值/状态规范化；
// F6 findV2ByEmail 邮箱索引一致性 fail-closed；
// F7 clearAllDeletedApiKeys 子先父后。
//
// harness 镜像 apiKeyService.v2Billing.test.js（模块级 mock 同集）；service 方法间的
// 协作用 jest.spyOn 隔离，afterEach restoreAllMocks 防 spy 泄漏到其它用例。

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
  deleteApiKeyHash: jest.fn(),
  getSession: jest.fn(),
  setV2EmailIndex: jest.fn(),
  getV2KeyIdByEmail: jest.fn(),
  deleteV2EmailIndex: jest.fn(),
  getV2ChildIds: jest.fn(),
  addV2Child: jest.fn(),
  scanApiKeyIds: jest.fn(),
  batchGetApiKeys: jest.fn(),
  batchGetApiKeyStats: jest.fn(),
  client: { hset: jest.fn() }
}))

jest.mock('../src/services/costRankService', () => ({
  addKeyToIndexes: jest.fn(),
  removeKeyFromIndexes: jest.fn()
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
jest.mock('../src/utils/modelHelper', () => ({
  isClaudeFamilyModel: jest.fn(() => false)
}))
jest.mock('../src/utils/requestDetailHelper', () => ({
  finalizeRequestDetailMeta: jest.fn((value) => value)
}))

const bcrypt = require('bcryptjs')
const redis = require('../src/models/redis')
const logger = require('../src/utils/logger')
const apiKeyService = require('../src/services/apiKeyService')

const PARENT_ID = 'parent-key-1'
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function mockActiveParent(overrides = {}) {
  redis.getApiKey.mockResolvedValue({
    id: PARENT_ID,
    isV2Parent: 'true',
    isActive: 'true',
    isDeleted: 'false',
    ...overrides
  })
}

describe('apiKeyService v2 lifecycle fixes', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    redis.setApiKey.mockResolvedValue()
    redis.deleteApiKeyHash.mockResolvedValue()
    redis.client.hset.mockResolvedValue()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  // ── F1 ──────────────────────────────────────────────────────────────────────

  // 1. 升级时清除原 expiresAt，防止 cleanup 定时任务日后禁用父账号
  test('upgradeToV2Parent clears expiresAt on the upgraded key', async () => {
    redis.getApiKey.mockResolvedValue({
      name: 'legacy-key',
      apiKey: 'hashed-secret',
      isActive: 'true',
      expiresAt: '2026-07-01T00:00:00.000Z',
      tags: '[]'
    })
    redis.getSession.mockResolvedValue({ username: 'admin' })
    redis.setV2EmailIndex.mockResolvedValue(true)

    const result = await apiKeyService.upgradeToV2Parent('key-1', {
      email: 'tenant@example.com',
      password: 'password123',
      totalBudget: 100
    })

    expect(result.success).toBe(true)
    expect(redis.setApiKey).toHaveBeenCalledWith(
      'key-1',
      expect.objectContaining({ isV2Parent: 'true', expiresAt: '' })
    )
  })

  // 2. cleanup 跳过已过期的 v2 父账号，普通过期 key 照常禁用
  test('cleanupExpiredKeys skips expired v2 parents but disables normal expired keys', async () => {
    const past = '2020-01-01T00:00:00.000Z'
    jest.spyOn(apiKeyService, 'getAllApiKeysFast').mockResolvedValue([
      { id: 'expired-parent', expiresAt: past, isActive: true, isV2Parent: true },
      { id: 'expired-normal', expiresAt: past, isActive: true, isV2Parent: false }
    ])
    const updateSpy = jest.spyOn(apiKeyService, 'updateApiKey').mockResolvedValue({ success: true })

    const cleaned = await apiKeyService.cleanupExpiredKeys()

    expect(cleaned).toBe(1)
    expect(updateSpy).toHaveBeenCalledTimes(1)
    expect(updateSpy).toHaveBeenCalledWith('expired-normal', { isActive: false })
  })

  // ── F3 ──────────────────────────────────────────────────────────────────────

  // 3. 管理员重置密码：同一 hset 写入 v2PasswordChangedAt
  test('resetV2Password writes v2PasswordChangedAt together with the new hash', async () => {
    mockActiveParent()

    await apiKeyService.resetV2Password(PARENT_ID, 'newpassword1')

    expect(redis.client.hset).toHaveBeenCalledWith(`apikey:${PARENT_ID}`, {
      v2PasswordHash: expect.any(String),
      v2PasswordChangedAt: expect.stringMatching(ISO_RE)
    })
  })

  // 4. 自助改密：校验当前密码后同样写入 v2PasswordChangedAt
  test('changeV2Password writes v2PasswordChangedAt after verifying the current password', async () => {
    mockActiveParent({ v2PasswordHash: bcrypt.hashSync('oldpassword1', 4) })

    await apiKeyService.changeV2Password(PARENT_ID, 'oldpassword1', 'newpassword1')

    expect(redis.client.hset).toHaveBeenCalledWith(`apikey:${PARENT_ID}`, {
      v2PasswordHash: expect.any(String),
      v2PasswordChangedAt: expect.stringMatching(ISO_RE)
    })
  })

  // ── F4 ──────────────────────────────────────────────────────────────────────

  // 5. getAllApiKeysFast(_, keyIds)：跳过全库 SCAN 只批量加载指定 id；空数组直接 []
  test('getAllApiKeysFast loads only the given keyIds without scanning; empty ids yield []', async () => {
    redis.batchGetApiKeys.mockResolvedValue([{ id: 'c1', isDeleted: false }])
    redis.batchGetApiKeyStats.mockResolvedValue(new Map())

    const empty = await apiKeyService.getAllApiKeysFast(false, [])
    expect(empty).toEqual([])
    expect(redis.scanApiKeyIds).not.toHaveBeenCalled()
    expect(redis.batchGetApiKeys).not.toHaveBeenCalled()

    const loaded = await apiKeyService.getAllApiKeysFast(false, ['c1'])
    expect(redis.scanApiKeyIds).not.toHaveBeenCalled()
    expect(redis.batchGetApiKeys).toHaveBeenCalledWith(['c1'])
    expect(loaded).toHaveLength(1)
    expect(loaded[0].id).toBe('c1')
  })

  // 6. 默认（不传 keyIds）保持全库 SCAN 行为不变
  test('getAllApiKeysFast still scans the whole keyspace when keyIds is not provided', async () => {
    redis.scanApiKeyIds.mockResolvedValue(['a1'])
    redis.batchGetApiKeys.mockResolvedValue([{ id: 'a1', isDeleted: false }])
    redis.batchGetApiKeyStats.mockResolvedValue(new Map())

    const keys = await apiKeyService.getAllApiKeysFast()

    expect(redis.scanApiKeyIds).toHaveBeenCalled()
    expect(keys).toHaveLength(1)
  })

  // 7. getV2Children：经 children 集合批量加载，脏数据二次过滤，createdAt 倒序
  test('getV2Children loads via the children set, filters dirty entries and sorts newest first', async () => {
    redis.getV2ChildIds.mockResolvedValue(['c1', 'c2', 'dirty'])
    const fastSpy = jest.spyOn(apiKeyService, 'getAllApiKeysFast').mockResolvedValue([
      { id: 'c2', parentKeyId: PARENT_ID, createdAt: '2026-06-01T00:00:00.000Z' },
      { id: 'c1', parentKeyId: PARENT_ID, createdAt: '2026-06-05T00:00:00.000Z' },
      { id: 'dirty', parentKeyId: 'other-parent', createdAt: '2026-06-09T00:00:00.000Z' }
    ])

    const children = await apiKeyService.getV2Children(PARENT_ID, false)

    expect(fastSpy).toHaveBeenCalledWith(false, ['c1', 'c2', 'dirty'])
    expect(children.map((c) => c.id)).toEqual(['c1', 'c2'])
  })

  // 8. children 集合为空时不做任何批量加载
  test('getV2Children returns [] without batch loading when the children set is empty', async () => {
    redis.getV2ChildIds.mockResolvedValue([])
    const fastSpy = jest.spyOn(apiKeyService, 'getAllApiKeysFast')

    const children = await apiKeyService.getV2Children(PARENT_ID)

    expect(children).toEqual([])
    expect(fastSpy).not.toHaveBeenCalled()
  })

  // 9. 子 key 上限按「未软删除」数量判断（_getV2ChildKeys 以 includeDeleted=false 调用）
  test('createV2Child rejects at the cap, counting only non-deleted children', async () => {
    mockActiveParent()
    const childSpy = jest
      .spyOn(apiKeyService, '_getV2ChildKeys')
      .mockResolvedValue(Array.from({ length: 100 }, (_, i) => ({ id: `c${i}` })))
    const generateSpy = jest.spyOn(apiKeyService, 'generateApiKey')

    await expect(apiKeyService.createV2Child(PARENT_ID, { name: 'one-too-many' })).rejects.toThrow(
      '子 key 数量已达上限 (100)'
    )

    expect(childSpy).toHaveBeenCalledWith(PARENT_ID, false)
    expect(generateSpy).not.toHaveBeenCalled()
  })

  // 10. 未达上限正常创建并登记 children 集合
  test('createV2Child creates and registers the child below the cap', async () => {
    mockActiveParent()
    jest
      .spyOn(apiKeyService, '_getV2ChildKeys')
      .mockResolvedValue(Array.from({ length: 99 }, (_, i) => ({ id: `c${i}` })))
    jest.spyOn(apiKeyService, 'generateApiKey').mockResolvedValue({ id: 'new-1' })
    redis.addV2Child.mockResolvedValue()
    const deleteSpy = jest.spyOn(apiKeyService, 'deleteApiKey')

    const newKey = await apiKeyService.createV2Child(PARENT_ID, { name: 'ok' })

    expect(newKey.id).toBe('new-1')
    expect(redis.addV2Child).toHaveBeenCalledWith(PARENT_ID, 'new-1')
    expect(deleteSpy).not.toHaveBeenCalled()
  })

  // 11. addV2Child 失败 → 软删除回滚刚创建的 key（防孤儿）并原样抛错
  test('createV2Child soft-deletes the new key and rethrows when addV2Child fails', async () => {
    mockActiveParent()
    jest.spyOn(apiKeyService, '_getV2ChildKeys').mockResolvedValue([])
    jest.spyOn(apiKeyService, 'generateApiKey').mockResolvedValue({ id: 'orphan-1' })
    redis.addV2Child.mockRejectedValue(new Error('sadd failed'))
    const deleteSpy = jest.spyOn(apiKeyService, 'deleteApiKey').mockResolvedValue({})

    await expect(apiKeyService.createV2Child(PARENT_ID, { name: 'oops' })).rejects.toThrow(
      'sadd failed'
    )

    expect(deleteSpy).toHaveBeenCalledWith('orphan-1', 'system', 'system')
  })

  // ── F5 ──────────────────────────────────────────────────────────────────────

  describe('updateV2Child', () => {
    let updateSpy

    beforeEach(() => {
      jest
        .spyOn(apiKeyService, 'assertV2ChildOwnership')
        .mockResolvedValue({ id: 'child-1', parentKeyId: PARENT_ID })
      updateSpy = jest.spyOn(apiKeyService, 'updateApiKey').mockResolvedValue({ success: true })
    })

    // 12. 非法额度：负数 / 非数字 → 抛错且不落库
    test('rejects negative or non-numeric cost limits', async () => {
      await expect(
        apiKeyService.updateV2Child(PARENT_ID, 'child-1', { dailyCostLimit: -5 })
      ).rejects.toThrow('dailyCostLimit must be a non-negative number')
      await expect(
        apiKeyService.updateV2Child(PARENT_ID, 'child-1', { totalCostLimit: 'abc' })
      ).rejects.toThrow('totalCostLimit must be a non-negative number')
      expect(updateSpy).not.toHaveBeenCalled()
    })

    // 13. ''/null 规范化为 0（与 createV2Child 口径一致），数字字符串转数字
    test('normalizes empty/null limits to 0 and numeric strings to numbers', async () => {
      await apiKeyService.updateV2Child(PARENT_ID, 'child-1', {
        dailyCostLimit: '',
        totalCostLimit: null
      })
      expect(updateSpy).toHaveBeenCalledWith('child-1', { dailyCostLimit: 0, totalCostLimit: 0 })

      await apiKeyService.updateV2Child(PARENT_ID, 'child-1', { dailyCostLimit: '5.5' })
      expect(updateSpy).toHaveBeenLastCalledWith('child-1', { dailyCostLimit: 5.5 })
    })

    // 14. name 提供时必须 trim 后非空；合法时入库 trim 值
    test('requires a non-blank name when provided and trims it', async () => {
      await expect(
        apiKeyService.updateV2Child(PARENT_ID, 'child-1', { name: '   ' })
      ).rejects.toThrow('API key name is required')

      await apiKeyService.updateV2Child(PARENT_ID, 'child-1', { name: '  renamed  ' })
      expect(updateSpy).toHaveBeenCalledWith('child-1', { name: 'renamed' })
    })

    // 15. isActive 只接受 boolean / 'true' / 'false'，统一规范化为 boolean
    test('normalizes isActive and rejects other values', async () => {
      await apiKeyService.updateV2Child(PARENT_ID, 'child-1', { isActive: 'false' })
      expect(updateSpy).toHaveBeenCalledWith('child-1', { isActive: false })

      await apiKeyService.updateV2Child(PARENT_ID, 'child-1', { isActive: true })
      expect(updateSpy).toHaveBeenLastCalledWith('child-1', { isActive: true })

      await expect(
        apiKeyService.updateV2Child(PARENT_ID, 'child-1', { isActive: 'yes' })
      ).rejects.toThrow('isActive must be a boolean')
    })

    // 16. 无任何可更新字段时不触碰存储
    test('skips persistence when no whitelisted field is provided', async () => {
      const result = await apiKeyService.updateV2Child(PARENT_ID, 'child-1', {})
      expect(result).toEqual({ success: true })
      expect(updateSpy).not.toHaveBeenCalled()
    })

    // 17. 归属校验失败（NOT_FOUND）原样向上抛
    test('propagates NOT_FOUND from ownership assertion', async () => {
      const notFound = new Error('API key not found')
      notFound.code = 'NOT_FOUND'
      apiKeyService.assertV2ChildOwnership.mockRejectedValue(notFound)

      await expect(
        apiKeyService.updateV2Child(PARENT_ID, 'child-1', { name: 'x' })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      expect(updateSpy).not.toHaveBeenCalled()
    })
  })

  // ── F6 ──────────────────────────────────────────────────────────────────────

  // 18. 邮箱索引指向的 key 与查询邮箱不一致 → fail-closed 返回 null 并告警
  test('findV2ByEmail fails closed when the index email mismatches the key v2Email', async () => {
    redis.getV2KeyIdByEmail.mockResolvedValue('k1')
    redis.getApiKey.mockResolvedValue({
      isV2Parent: 'true',
      isActive: 'true',
      isDeleted: 'false',
      v2Email: 'new@example.com'
    })

    const found = await apiKeyService.findV2ByEmail(' Old@Example.com ')

    expect(found).toBeNull()
    expect(logger.warn).toHaveBeenCalled()
  })

  // 19. 一致时正常返回（含 id）
  test('findV2ByEmail returns the parent when the email matches', async () => {
    redis.getV2KeyIdByEmail.mockResolvedValue('k1')
    redis.getApiKey.mockResolvedValue({
      isV2Parent: 'true',
      isActive: 'true',
      isDeleted: 'false',
      v2Email: 'old@example.com'
    })

    const found = await apiKeyService.findV2ByEmail('old@example.com')

    expect(found).toMatchObject({ id: 'k1', v2Email: 'old@example.com' })
  })

  // ── F7 ──────────────────────────────────────────────────────────────────────

  // 20. 清空已删除 key：子 key 最先、普通 key 居中、v2 父账号最后
  test('clearAllDeletedApiKeys deletes children first and v2 parents last', async () => {
    jest.spyOn(apiKeyService, 'getAllApiKeysFast').mockResolvedValue([
      { id: 'deleted-parent', isV2Parent: true, isDeleted: true },
      { id: 'deleted-normal', isDeleted: true },
      { id: 'deleted-child', parentKeyId: 'deleted-parent', isDeleted: true },
      { id: 'still-active', isDeleted: false }
    ])
    const order = []
    jest.spyOn(apiKeyService, 'permanentDeleteApiKey').mockImplementation((keyId) => {
      order.push(keyId)
      return Promise.resolve({ success: true })
    })

    const result = await apiKeyService.clearAllDeletedApiKeys()

    expect(order).toEqual(['deleted-child', 'deleted-normal', 'deleted-parent'])
    expect(result.successCount).toBe(3)
    expect(result.failedCount).toBe(0)
  })
})
