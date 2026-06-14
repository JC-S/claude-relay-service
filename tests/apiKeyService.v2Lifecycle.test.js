// v2 账号生命周期修复回归测试（apiKeyService）
// 覆盖（对应 plan_tmp/v2-account-review-fix-plan_revised.md）：
// F1 upgradeToV2Parent 清 expiresAt / cleanupExpiredKeys 跳过 v2 父账号；
// F3 resetV2Password/changeV2Password 写 v2PasswordChangedAt；
// F4 getAllApiKeysFast(keyIds) 局部加载、getV2Children 走 children 集合 + 脏数据过滤、
//    子 key 上限按未软删除数量、addV2Child 失败回滚软删除；
// F5 updateV2Child 白名单 + 数值/状态规范化；
// F6 findV2ByEmail 邮箱索引一致性 fail-closed；
// F7 clearAllDeletedApiKeys 子先父后。
// 以及 v2 IP 白名单（账号级默认 + 子 key 覆盖，对应 plan_tmp/v2-account-ip-whitelist-plan_revised.md）：
// getV2IpWhitelist/updateV2IpWhitelist 定点 hset、updateV2Child 三态状态机与旧值防误激活、
// validateApiKey/_overlayV2ParentConfigForStats 的 override 跳过继承口径。
// 以及管理员模拟登录（plan_tmp/v2-account-admin-impersonation-plan_final.md）：
// createV2ImpersonationSession 铸造与 web 登录同构的会话 + impersonatedBy 审计 + 非 active 父拒绝。
//
// harness 镜像 apiKeyService.v2Billing.test.js（模块级 mock 同集）；service 方法间的
// 协作用 jest.spyOn 隔离，afterEach restoreAllMocks 防 spy 泄漏到其它用例。
// 注意：redis 模块整体被 mock，_parseApiKeyData 的 boolFields 变更不在此测（视图层
// _toV2ChildView/isV2IpWhitelistOverrideEnabled 均自行防御性解析 bool/'true' 两种形态）。

jest.mock(
  '../config/config',
  () => ({
    security: {
      apiKeyPrefix: 'cr_',
      encryptionKey: 'test-encryption-key-0000000000000',
      adminSessionTimeout: 86400000
    }
  }),
  { virtual: true }
)

jest.mock('../src/models/redis', () => ({
  getApiKey: jest.fn(),
  setApiKey: jest.fn(),
  deleteApiKeyHash: jest.fn(),
  getSession: jest.fn(),
  setSession: jest.fn(),
  setV2EmailIndex: jest.fn(),
  getV2KeyIdByEmail: jest.fn(),
  deleteV2EmailIndex: jest.fn(),
  getV2ChildIds: jest.fn(),
  addV2Child: jest.fn(),
  scanApiKeyIds: jest.fn(),
  batchGetApiKeys: jest.fn(),
  batchGetApiKeyStats: jest.fn(),
  findApiKeyByHash: jest.fn(), // validateApiKey 端到端用
  getV2ParentTotalCost: jest.fn(), // validateApiKey 子 key 总账信息用
  setV2ParentTotalCost: jest.fn(),
  deleteV2ParentTotalCost: jest.fn(),
  getCostStats: jest.fn(),
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
  info: jest.fn(),
  api: jest.fn(), // validateApiKey 成功路径
  security: jest.fn()
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
    redis.setV2ParentTotalCost.mockResolvedValue()
    redis.deleteV2ParentTotalCost.mockResolvedValue()
    redis.getCostStats.mockResolvedValue({ total: 0 })
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
      totalCostLimit: '125.5',
      expiresAt: '2026-07-01T00:00:00.000Z',
      tags: '[]'
    })
    redis.getSession.mockResolvedValue({ username: 'admin' })
    redis.setV2EmailIndex.mockResolvedValue(true)
    redis.getCostStats.mockResolvedValue({ total: 17.25 })

    const result = await apiKeyService.upgradeToV2Parent('key-1', {
      email: 'tenant@example.com',
      password: 'password123'
    })

    expect(result.success).toBe(true)
    expect(result.v2TotalBudget).toBe(125.5)
    expect(redis.setV2ParentTotalCost).toHaveBeenCalledWith('key-1', 17.25)
    expect(redis.setApiKey).toHaveBeenCalledWith(
      'key-1',
      expect.objectContaining({ isV2Parent: 'true', expiresAt: '', v2TotalBudget: '125.5' })
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

// ── v2 IP 白名单（账号级默认 + 子 key 覆盖）────────────────────────────────────

describe('apiKeyService v2 IP whitelist', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    redis.setApiKey.mockResolvedValue()
    redis.deleteApiKeyHash.mockResolvedValue()
    redis.client.hset.mockResolvedValue()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('getV2IpWhitelist', () => {
    // 1. 原始 hash 字符串形态 → bool + 规范化数组；字段缺省安全退化为 false + []
    test('returns normalized bool and list from the parent raw hash', async () => {
      mockActiveParent({ enableIpWhitelist: 'true', ipWhitelist: '["1.2.3.4","10.0.0.0/8"]' })
      await expect(apiKeyService.getV2IpWhitelist(PARENT_ID)).resolves.toEqual({
        enableIpWhitelist: true,
        ipWhitelist: ['1.2.3.4', '10.0.0.0/8']
      })

      mockActiveParent()
      await expect(apiKeyService.getV2IpWhitelist(PARENT_ID)).resolves.toEqual({
        enableIpWhitelist: false,
        ipWhitelist: []
      })
    })

    // 2. 非 v2 / 停用 / 已删除父账号一律拒绝
    test('rejects non-v2, disabled and deleted parents', async () => {
      redis.getApiKey.mockResolvedValue({ id: PARENT_ID, isActive: 'true' })
      await expect(apiKeyService.getV2IpWhitelist(PARENT_ID)).rejects.toThrow(
        'Not an active v2 parent account'
      )
      mockActiveParent({ isActive: 'false' })
      await expect(apiKeyService.getV2IpWhitelist(PARENT_ID)).rejects.toThrow(
        'Not an active v2 parent account'
      )
      mockActiveParent({ isDeleted: 'true' })
      await expect(apiKeyService.getV2IpWhitelist(PARENT_ID)).rejects.toThrow(
        'Not an active v2 parent account'
      )
    })
  })

  describe('updateV2IpWhitelist', () => {
    // 3. 合法更新：定点 hset 写父 hash（同族 resetV2Password），绝不全量回写、绝不触碰 hash 映射
    test('persists via targeted hset without touching setApiKey or the hash map', async () => {
      mockActiveParent()

      const result = await apiKeyService.updateV2IpWhitelist(PARENT_ID, {
        enableIpWhitelist: true,
        ipWhitelist: ['1.2.3.4', '10.0.0.0/8']
      })

      expect(result).toEqual({ enableIpWhitelist: true, ipWhitelist: ['1.2.3.4', '10.0.0.0/8'] })
      expect(redis.client.hset).toHaveBeenCalledWith(`apikey:${PARENT_ID}`, {
        enableIpWhitelist: 'true',
        ipWhitelist: '["1.2.3.4","10.0.0.0/8"]',
        updatedAt: expect.stringMatching(ISO_RE)
      })
      expect(redis.setApiKey).not.toHaveBeenCalled()
      expect(redis.deleteApiKeyHash).not.toHaveBeenCalled()
    })

    // 4-7. 入参口径：非数组拒绝、非法条目拒绝、启用空列表拒绝、布尔收 'true'/'false' 拒 'yes'
    test('validates array shape, entries, enable+empty and boolean forms', async () => {
      mockActiveParent()
      await expect(
        apiKeyService.updateV2IpWhitelist(PARENT_ID, { enableIpWhitelist: false, ipWhitelist: 'x' })
      ).rejects.toThrow('ipWhitelist must be an array')
      await expect(
        apiKeyService.updateV2IpWhitelist(PARENT_ID, {
          enableIpWhitelist: true,
          ipWhitelist: ['not-an-ip']
        })
      ).rejects.toThrow('Invalid IP whitelist entry: not-an-ip')
      await expect(
        apiKeyService.updateV2IpWhitelist(PARENT_ID, { enableIpWhitelist: true, ipWhitelist: [] })
      ).rejects.toThrow('启用 IP 白名单时至少需要一个 IP 或 CIDR')
      await expect(
        apiKeyService.updateV2IpWhitelist(PARENT_ID, { enableIpWhitelist: 'yes', ipWhitelist: [] })
      ).rejects.toThrow('enableIpWhitelist must be a boolean')
      expect(redis.client.hset).not.toHaveBeenCalled()

      await expect(
        apiKeyService.updateV2IpWhitelist(PARENT_ID, {
          enableIpWhitelist: 'false',
          ipWhitelist: []
        })
      ).resolves.toEqual({ enableIpWhitelist: false, ipWhitelist: [] })
    })

    // 8. 规范化：去重 + IPv4-mapped 还原为 IPv4
    test('deduplicates and normalizes IPv4-mapped addresses', async () => {
      mockActiveParent()

      const result = await apiKeyService.updateV2IpWhitelist(PARENT_ID, {
        enableIpWhitelist: true,
        ipWhitelist: ['1.2.3.4', ' 1.2.3.4 ', '::ffff:5.6.7.8']
      })

      expect(result.ipWhitelist).toEqual(['1.2.3.4', '5.6.7.8'])
    })

    // 9. 超过 100 条上限拒绝；父校验与 GET 同口径
    test('rejects more than 100 entries and disabled parents', async () => {
      mockActiveParent()
      const tooMany = Array.from(
        { length: 101 },
        (_, i) => `10.0.${Math.floor(i / 256)}.${i % 256}`
      )
      await expect(
        apiKeyService.updateV2IpWhitelist(PARENT_ID, {
          enableIpWhitelist: true,
          ipWhitelist: tooMany
        })
      ).rejects.toThrow('IP whitelist cannot exceed 100 entries')

      mockActiveParent({ isActive: 'false' })
      await expect(
        apiKeyService.updateV2IpWhitelist(PARENT_ID, { enableIpWhitelist: false, ipWhitelist: [] })
      ).rejects.toThrow('Not an active v2 parent account')
    })
  })

  describe('updateV2Child IP whitelist', () => {
    let updateSpy

    // assertV2ChildOwnership 返回 redis 原始字符串形态（与真实实现一致）
    const mockChild = (overrides = {}) => {
      apiKeyService.assertV2ChildOwnership.mockResolvedValue({
        id: 'child-1',
        parentKeyId: PARENT_ID,
        ...overrides
      })
    }

    beforeEach(() => {
      jest.spyOn(apiKeyService, 'assertV2ChildOwnership')
      mockChild()
      updateSpy = jest.spyOn(apiKeyService, 'updateApiKey').mockResolvedValue({ success: true })
    })

    // 10. 切回跟随默认：清空三件套（请求未提供 enable/list 也清）
    test('switching back to inherit clears the whole trio', async () => {
      mockChild({
        v2IpWhitelistOverride: 'true',
        enableIpWhitelist: 'true',
        ipWhitelist: '["1.2.3.4"]'
      })

      await apiKeyService.updateV2Child(PARENT_ID, 'child-1', { ipWhitelistOverride: false })

      expect(updateSpy).toHaveBeenCalledWith('child-1', {
        v2IpWhitelistOverride: false,
        enableIpWhitelist: false,
        ipWhitelist: []
      })
    })

    // 11. 关键防误激活：当前 override=false 且 Redis 残留旧原始白名单（管理员后台写入）时，
    //     仅提交 { ipWhitelistOverride: true } 拒绝——沉睡旧名单不能被静默激活
    test('rejects bare override=true so stale raw whitelists can never silently activate', async () => {
      mockChild({ enableIpWhitelist: 'true', ipWhitelist: '["9.9.9.9"]' })

      await expect(
        apiKeyService.updateV2Child(PARENT_ID, 'child-1', { ipWhitelistOverride: true })
      ).rejects.toThrow('请指定自定义白名单状态')
      expect(updateSpy).not.toHaveBeenCalled()
    })

    // 12. 当前 override=false：单独提交 enable=true / 非空 list / 矛盾组合一律拒绝
    test('rejects enable/list submissions while override stays false', async () => {
      await expect(
        apiKeyService.updateV2Child(PARENT_ID, 'child-1', { enableIpWhitelist: true })
      ).rejects.toThrow('请先开启自定义白名单')
      await expect(
        apiKeyService.updateV2Child(PARENT_ID, 'child-1', { ipWhitelist: ['1.2.3.4'] })
      ).rejects.toThrow('请先开启自定义白名单')
      await expect(
        apiKeyService.updateV2Child(PARENT_ID, 'child-1', {
          ipWhitelistOverride: false,
          enableIpWhitelist: true,
          ipWhitelist: ['1.2.3.4']
        })
      ).rejects.toThrow('请先开启自定义白名单')
      expect(updateSpy).not.toHaveBeenCalled()
    })

    // 13. 切到 custom：必须非空 list；合法时写入完整三件套
    test('switching to custom requires an explicit non-empty whitelist', async () => {
      await expect(
        apiKeyService.updateV2Child(PARENT_ID, 'child-1', {
          ipWhitelistOverride: true,
          enableIpWhitelist: true,
          ipWhitelist: []
        })
      ).rejects.toThrow('启用 IP 白名单时至少需要一个 IP 或 CIDR')

      await apiKeyService.updateV2Child(PARENT_ID, 'child-1', {
        ipWhitelistOverride: true,
        enableIpWhitelist: true,
        ipWhitelist: ['1.2.3.4']
      })
      expect(updateSpy).toHaveBeenCalledWith('child-1', {
        v2IpWhitelistOverride: true,
        enableIpWhitelist: true,
        ipWhitelist: ['1.2.3.4']
      })
    })

    // 14. 切到 disabled：写 override=true + enable=false + 空 list
    test('switching to disabled writes override with an empty list', async () => {
      await apiKeyService.updateV2Child(PARENT_ID, 'child-1', {
        ipWhitelistOverride: true,
        enableIpWhitelist: false
      })

      expect(updateSpy).toHaveBeenCalledWith('child-1', {
        v2IpWhitelistOverride: true,
        enableIpWhitelist: false,
        ipWhitelist: []
      })
    })

    // 15. 已是 custom 时只关 enable → list 一并清空（disabled 状态不留旧名单）
    test('disabling while overridden clears the stored list', async () => {
      mockChild({
        v2IpWhitelistOverride: 'true',
        enableIpWhitelist: 'true',
        ipWhitelist: '["1.2.3.4"]'
      })

      await apiKeyService.updateV2Child(PARENT_ID, 'child-1', { enableIpWhitelist: false })

      expect(updateSpy).toHaveBeenCalledWith('child-1', {
        v2IpWhitelistOverride: true,
        enableIpWhitelist: false,
        ipWhitelist: []
      })
    })

    // 15b. 已是 custom 时省略 list 重申 enable=true：沿用当前名单不丢失
    test('keeps the current list when re-enabling without a new list', async () => {
      mockChild({
        v2IpWhitelistOverride: 'true',
        enableIpWhitelist: 'true',
        ipWhitelist: '["1.2.3.4"]'
      })

      await apiKeyService.updateV2Child(PARENT_ID, 'child-1', {
        ipWhitelistOverride: true,
        enableIpWhitelist: true
      })

      expect(updateSpy).toHaveBeenCalledWith('child-1', {
        v2IpWhitelistOverride: true,
        enableIpWhitelist: true,
        ipWhitelist: ['1.2.3.4']
      })
    })

    // 16. 只改名称等无关字段：白名单三件套绝不写入（不误清）
    test('does not touch the trio when whitelist fields are absent', async () => {
      mockChild({
        v2IpWhitelistOverride: 'true',
        enableIpWhitelist: 'true',
        ipWhitelist: '["1.2.3.4"]'
      })

      await apiKeyService.updateV2Child(PARENT_ID, 'child-1', { name: 'renamed' })

      expect(updateSpy).toHaveBeenCalledWith('child-1', { name: 'renamed' })
    })

    // 入参口径：override 拒 'yes'，list 拒非数组/非法条目/超上限
    test('validates whitelist argument shapes', async () => {
      await expect(
        apiKeyService.updateV2Child(PARENT_ID, 'child-1', { ipWhitelistOverride: 'yes' })
      ).rejects.toThrow('ipWhitelistOverride must be a boolean')
      await expect(
        apiKeyService.updateV2Child(PARENT_ID, 'child-1', { ipWhitelist: 'x' })
      ).rejects.toThrow('ipWhitelist must be an array')
      await expect(
        apiKeyService.updateV2Child(PARENT_ID, 'child-1', {
          ipWhitelistOverride: true,
          enableIpWhitelist: true,
          ipWhitelist: ['bad-entry']
        })
      ).rejects.toThrow('Invalid IP whitelist entry: bad-entry')
      const tooMany = Array.from(
        { length: 101 },
        (_, i) => `10.1.${Math.floor(i / 256)}.${i % 256}`
      )
      await expect(
        apiKeyService.updateV2Child(PARENT_ID, 'child-1', {
          ipWhitelistOverride: true,
          enableIpWhitelist: true,
          ipWhitelist: tooMany
        })
      ).rejects.toThrow('IP whitelist cannot exceed 100 entries')
      expect(updateSpy).not.toHaveBeenCalled()
    })
  })

  describe('validateApiKey end-to-end inheritance', () => {
    const CHILD_SECRET = 'cr_test-child-secret'

    // findApiKeyByHash 返回子 key 原始数据；getApiKey 按入参分发（父）；限额全 0 跳过费用查询
    function mockChildAndParent(childOverrides = {}, parentOverrides = {}) {
      redis.findApiKeyByHash.mockResolvedValue({
        id: 'child-1',
        name: 'child',
        isActive: 'true',
        parentKeyId: PARENT_ID,
        ...childOverrides
      })
      redis.getApiKey.mockImplementation(async (id) =>
        id === PARENT_ID
          ? {
              id: PARENT_ID,
              isV2Parent: 'true',
              isActive: 'true',
              isDeleted: 'false',
              enableIpWhitelist: 'false',
              ipWhitelist: '[]',
              ...parentOverrides
            }
          : null
      )
      redis.getV2ParentTotalCost.mockResolvedValue(0)
    }

    // 17. 未 override：父账号白名单生效
    test('inherits the parent whitelist when not overridden', async () => {
      mockChildAndParent({}, { enableIpWhitelist: 'true', ipWhitelist: '["8.8.8.8"]' })

      const result = await apiKeyService.validateApiKey(CHILD_SECRET)

      expect(result.valid).toBe(true)
      expect(result.keyData.enableIpWhitelist).toBe(true)
      expect(result.keyData.ipWhitelist).toEqual(['8.8.8.8'])
    })

    // 18. 未 override 但子 key 残留旧原始白名单：父值仍覆盖（旧值不参与真实调用判定）
    test('parent values still win over stale child raw fields without override', async () => {
      mockChildAndParent(
        { enableIpWhitelist: 'true', ipWhitelist: '["9.9.9.9"]' },
        { enableIpWhitelist: 'false', ipWhitelist: '[]' }
      )

      const result = await apiKeyService.validateApiKey(CHILD_SECRET)

      expect(result.valid).toBe(true)
      expect(result.keyData.enableIpWhitelist).toBe(false)
      expect(result.keyData.ipWhitelist).toEqual([])
    })

    // 19. override + disabled：父账号启用白名单也不限制该子 key
    test('override=disabled beats an enabled parent whitelist', async () => {
      mockChildAndParent(
        { v2IpWhitelistOverride: 'true', enableIpWhitelist: 'false', ipWhitelist: '[]' },
        { enableIpWhitelist: 'true', ipWhitelist: '["8.8.8.8"]' }
      )

      const result = await apiKeyService.validateApiKey(CHILD_SECRET)

      expect(result.valid).toBe(true)
      expect(result.keyData.enableIpWhitelist).toBe(false)
      expect(result.keyData.ipWhitelist).toEqual([])
    })

    // 20. override + custom：只按子 key 名单判定，父名单不混入
    test('override=custom uses only the child list', async () => {
      mockChildAndParent(
        { v2IpWhitelistOverride: 'true', enableIpWhitelist: 'true', ipWhitelist: '["9.9.9.9"]' },
        { enableIpWhitelist: 'true', ipWhitelist: '["8.8.8.8"]' }
      )

      const result = await apiKeyService.validateApiKey(CHILD_SECRET)

      expect(result.keyData.enableIpWhitelist).toBe(true)
      expect(result.keyData.ipWhitelist).toEqual(['9.9.9.9'])
    })

    // 21. override 时账户绑定与其余配置仍从父继承（证明 skip 范围未过宽）
    test('override still inherits account bindings and other config from the parent', async () => {
      mockChildAndParent(
        { v2IpWhitelistOverride: 'true', enableIpWhitelist: 'true', ipWhitelist: '["9.9.9.9"]' },
        {
          claudeAccountId: 'acct-parent',
          permissions: '["claude"]',
          enableIpWhitelist: 'true',
          ipWhitelist: '["8.8.8.8"]'
        }
      )

      const result = await apiKeyService.validateApiKey(CHILD_SECRET)

      expect(result.keyData.claudeAccountId).toBe('acct-parent')
      expect(result.keyData.permissions).toEqual(['claude'])
      expect(result.keyData.ipWhitelist).toEqual(['9.9.9.9'])
    })
  })

  describe('_overlayV2ParentConfigForStats', () => {
    const STATS_PARENT = {
      id: PARENT_ID,
      isV2Parent: 'true',
      isActive: 'true',
      isDeleted: 'false',
      enableIpWhitelist: 'true',
      ipWhitelist: '["8.8.8.8"]',
      permissions: '["claude"]'
    }

    // 22. 未 override：父白名单覆盖子残留原始值（stats 与真实调用同口径）
    test('overlays the parent whitelist when not overridden', async () => {
      redis.getApiKey.mockResolvedValue(STATS_PARENT)
      const keyData = {
        id: 'child-1',
        parentKeyId: PARENT_ID,
        enableIpWhitelist: 'true',
        ipWhitelist: '["9.9.9.9"]'
      }

      await apiKeyService._overlayV2ParentConfigForStats(keyData)

      expect(keyData.enableIpWhitelist).toBe('true')
      expect(keyData.ipWhitelist).toBe('["8.8.8.8"]')
      expect(keyData.permissions).toBe('["claude"]')
    })

    // 23. override=true：保留子白名单，其余配置字段仍继承父
    test('keeps the child whitelist but inherits other config when overridden', async () => {
      redis.getApiKey.mockResolvedValue(STATS_PARENT)
      const keyData = {
        id: 'child-1',
        parentKeyId: PARENT_ID,
        v2IpWhitelistOverride: 'true',
        enableIpWhitelist: 'false',
        ipWhitelist: '[]'
      }

      await apiKeyService._overlayV2ParentConfigForStats(keyData)

      expect(keyData.enableIpWhitelist).toBe('false')
      expect(keyData.ipWhitelist).toBe('[]')
      expect(keyData.permissions).toBe('["claude"]')
    })
  })

  // 24. _toV2ChildView：返回子 key 自身 override 状态（原始字符串/已解析两种形态都防御）
  test('_toV2ChildView exposes the child own override state', async () => {
    const rawView = apiKeyService._toV2ChildView({
      id: 'c1',
      v2IpWhitelistOverride: 'true',
      enableIpWhitelist: 'true',
      ipWhitelist: '["1.2.3.4"]'
    })
    expect(rawView).toMatchObject({
      ipWhitelistOverride: true,
      enableIpWhitelist: true,
      ipWhitelist: ['1.2.3.4']
    })

    const parsedView = apiKeyService._toV2ChildView({
      id: 'c2',
      v2IpWhitelistOverride: false,
      enableIpWhitelist: false,
      ipWhitelist: []
    })
    expect(parsedView).toMatchObject({
      ipWhitelistOverride: false,
      enableIpWhitelist: false,
      ipWhitelist: []
    })
  })
})

describe('apiKeyService v2 impersonation session', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    redis.setSession.mockResolvedValue()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  // 25. 成功：铸造与 web.js v2 登录同构的会话 + impersonatedBy 审计字段
  test('mints a login-shaped v2 session with the impersonatedBy audit field', async () => {
    mockActiveParent({ v2Email: ' Tenant@Example.com ' })

    const result = await apiKeyService.createV2ImpersonationSession(PARENT_ID, 'admin-user')

    expect(redis.setSession).toHaveBeenCalledTimes(1)
    const [sessionId, sessionData, ttl] = redis.setSession.mock.calls[0]
    expect(sessionId).toMatch(/^[0-9a-f]{64}$/)
    expect(sessionData).toEqual({
      username: 'tenant@example.com',
      role: 'v2',
      v2KeyId: PARENT_ID,
      v2Email: 'tenant@example.com',
      loginTime: expect.stringMatching(ISO_RE),
      lastActivity: expect.stringMatching(ISO_RE),
      impersonatedBy: 'admin-user'
    })
    // 毫秒值当秒传——刻意镜像 web.js 登录现状（实际安全边界是中间件 24h 不活跃检查）
    expect(ttl).toBe(86400000)
    expect(result).toEqual({
      token: sessionId,
      username: 'tenant@example.com',
      expiresIn: 86400000
    })
    expect(logger.security).toHaveBeenCalledWith(
      expect.stringContaining(`impersonated v2 account ${PARENT_ID}`)
    )
  })

  // 26. 拒绝：六种无效父数据全部 throw，且绝不写会话
  test('rejects every non-active-v2-parent shape without minting a session', async () => {
    const base = { id: PARENT_ID, isV2Parent: 'true', isActive: 'true', isDeleted: 'false' }
    const invalidParents = [
      null,
      {},
      { ...base, isV2Parent: 'false', v2Email: 'a@b.c' },
      { ...base, isDeleted: 'true', v2Email: 'a@b.c' },
      { ...base, isActive: 'false', v2Email: 'a@b.c' },
      { ...base, v2Email: '' } // active 但无邮箱：会铸出空 username、过不了 authenticateV2Account
    ]

    for (const parent of invalidParents) {
      redis.getApiKey.mockResolvedValueOnce(parent)
      await expect(
        apiKeyService.createV2ImpersonationSession(PARENT_ID, 'admin-user')
      ).rejects.toThrow('Not an active v2 parent account')
    }

    expect(redis.setSession).not.toHaveBeenCalled()
  })
})

// ── 显示 API Key 明文（reveal）─────────────────────────────────────────────────
// commonHelper 未被 mock，encrypt/decrypt 为真实实现（配合 mock 的 encryptionKey 可真实
// 加解密），故对密文做 roundtrip 断言；错误用例统一断言 err.code。

describe('apiKeyService 明文 reveal', () => {
  const { encrypt, decrypt } = require('../src/utils/commonHelper')

  beforeEach(() => {
    jest.clearAllMocks()
    redis.setApiKey.mockResolvedValue()
    redis.deleteApiKeyHash.mockResolvedValue()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  // 1. generateApiKey 把可逆明文副本写入 redis.setApiKey 的 keyData；密文可解回返回的明文；
  //    手工白名单返回对象不含 encryptedApiKey
  test('generateApiKey persists a reversible encryptedApiKey copy that decrypts to the returned key', async () => {
    const result = await apiKeyService.generateApiKey({ name: 'reveal-me' })

    expect(redis.setApiKey).toHaveBeenCalledTimes(1)
    const [keyId, keyData, hashedKey] = redis.setApiKey.mock.calls[0]
    expect(keyId).toBe(result.id)
    expect(typeof hashedKey).toBe('string')
    expect(keyData.encryptedApiKey).toEqual(expect.any(String))
    expect(keyData.encryptedApiKey).not.toBe(result.apiKey) // 落库的是密文而非明文
    expect(decrypt(keyData.encryptedApiKey, false)).toBe(result.apiKey)
    expect(result.apiKey.startsWith('cr_')).toBe(true)
    expect(result).not.toHaveProperty('encryptedApiKey')
  })

  // 2. regenerateApiKey（非父 key）刷新 encryptedApiKey；新密文解回返回的新 key
  test('regenerateApiKey refreshes encryptedApiKey and the new ciphertext decrypts to the new key', async () => {
    redis.getApiKey.mockResolvedValue({
      id: 'key-1',
      name: 'old-name',
      apiKey: 'old-hashed',
      isV2Parent: 'false'
    })

    const result = await apiKeyService.regenerateApiKey('key-1')

    expect(result).toMatchObject({ id: 'key-1', name: 'old-name' })
    expect(result.key.startsWith('cr_')).toBe(true)
    expect(redis.deleteApiKeyHash).toHaveBeenCalledWith('old-hashed')
    expect(redis.setApiKey).toHaveBeenCalledTimes(1)
    const [, updatedKeyData] = redis.setApiKey.mock.calls[0]
    expect(updatedKeyData.encryptedApiKey).toEqual(expect.any(String))
    expect(decrypt(updatedKeyData.encryptedApiKey, false)).toBe(result.key)
    expect(result).not.toHaveProperty('encryptedApiKey')
  })

  // getApiKeyPlaintextById ────────────────────────────────────────────────────

  // 3. 正常：用 encrypt('cr_xxx') 造数据 → 解密后原样返回；并写审计日志（不含明文）
  test('getApiKeyPlaintextById returns the decrypted plaintext and writes a security audit', async () => {
    const secret = 'cr_plain-secret-123'
    redis.getApiKey.mockResolvedValue({
      id: 'key-1',
      isDeleted: 'false',
      encryptedApiKey: encrypt(secret)
    })

    const plaintext = await apiKeyService.getApiKeyPlaintextById('key-1', 'admin-user')

    expect(plaintext).toBe(secret)
    expect(logger.security).toHaveBeenCalledTimes(1)
    expect(logger.security.mock.calls[0][0]).not.toContain(secret) // 审计不落明文
  })

  // 4. NOT_FOUND：getApiKey 返回 null / 空对象 / isDeleted
  test('getApiKeyPlaintextById throws NOT_FOUND for missing, empty or soft-deleted keys', async () => {
    redis.getApiKey.mockResolvedValueOnce(null)
    await expect(apiKeyService.getApiKeyPlaintextById('key-1')).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })

    redis.getApiKey.mockResolvedValueOnce({})
    await expect(apiKeyService.getApiKeyPlaintextById('key-1')).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })

    redis.getApiKey.mockResolvedValueOnce({ id: 'key-1', isDeleted: 'true' })
    await expect(apiKeyService.getApiKeyPlaintextById('key-1')).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })

    expect(logger.security).not.toHaveBeenCalled()
  })

  // 5. V2_PARENT_NO_SECRET：v2 父账号无可调用 secret
  test('getApiKeyPlaintextById throws V2_PARENT_NO_SECRET for a v2 parent', async () => {
    redis.getApiKey.mockResolvedValue({
      id: PARENT_ID,
      isDeleted: 'false',
      isV2Parent: 'true',
      encryptedApiKey: encrypt('cr_should-not-matter')
    })

    await expect(apiKeyService.getApiKeyPlaintextById(PARENT_ID)).rejects.toMatchObject({
      code: 'V2_PARENT_NO_SECRET'
    })
    expect(logger.security).not.toHaveBeenCalled()
  })

  // 6. PLAINTEXT_UNAVAILABLE：旧 key 无 encryptedApiKey 副本
  test('getApiKeyPlaintextById throws PLAINTEXT_UNAVAILABLE when no encrypted copy exists', async () => {
    redis.getApiKey.mockResolvedValue({ id: 'legacy-key', isDeleted: 'false' })

    await expect(apiKeyService.getApiKeyPlaintextById('legacy-key')).rejects.toMatchObject({
      code: 'PLAINTEXT_UNAVAILABLE'
    })
    expect(logger.security).not.toHaveBeenCalled()
  })

  // 7. PLAINTEXT_DECRYPT_FAILED：密文解出的明文不以 cr_ 开头（如 encrypt('garbage')）
  test('getApiKeyPlaintextById throws PLAINTEXT_DECRYPT_FAILED when the decrypted value lacks the prefix', async () => {
    redis.getApiKey.mockResolvedValue({
      id: 'key-1',
      isDeleted: 'false',
      encryptedApiKey: encrypt('garbage-without-prefix')
    })

    await expect(apiKeyService.getApiKeyPlaintextById('key-1')).rejects.toMatchObject({
      code: 'PLAINTEXT_DECRYPT_FAILED'
    })
    // 审计在解密之前已写出（reveal 意图已记录），此处不对其断言
  })

  // getV2ChildPlaintext ────────────────────────────────────────────────────────

  // 8. 归属内正常：返回解密明文 + 写审计（含 parent/child id，不含明文）
  test('getV2ChildPlaintext returns the decrypted plaintext for an owned child', async () => {
    const secret = 'cr_child-secret-xyz'
    redis.getApiKey.mockResolvedValue({
      id: 'child-1',
      parentKeyId: PARENT_ID,
      isDeleted: 'false',
      encryptedApiKey: encrypt(secret)
    })

    const plaintext = await apiKeyService.getV2ChildPlaintext(PARENT_ID, 'child-1', 'tenant')

    expect(plaintext).toBe(secret)
    expect(logger.security).toHaveBeenCalledTimes(1)
    expect(logger.security.mock.calls[0][0]).not.toContain(secret)
  })

  // 9. NOT_FOUND：不存在 / 非归属 / 已软删（assertV2ChildOwnership 统一按 404）
  test('getV2ChildPlaintext throws NOT_FOUND for missing, mismatched-parent or deleted children', async () => {
    redis.getApiKey.mockResolvedValueOnce(null)
    await expect(apiKeyService.getV2ChildPlaintext(PARENT_ID, 'child-1')).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })

    redis.getApiKey.mockResolvedValueOnce({ id: 'child-1', parentKeyId: 'other-parent' })
    await expect(apiKeyService.getV2ChildPlaintext(PARENT_ID, 'child-1')).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })

    redis.getApiKey.mockResolvedValueOnce({
      id: 'child-1',
      parentKeyId: PARENT_ID,
      isDeleted: 'true'
    })
    await expect(apiKeyService.getV2ChildPlaintext(PARENT_ID, 'child-1')).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })

    expect(logger.security).not.toHaveBeenCalled()
  })

  // 10. PLAINTEXT_UNAVAILABLE：归属内但无 encryptedApiKey 副本
  test('getV2ChildPlaintext throws PLAINTEXT_UNAVAILABLE when the owned child has no encrypted copy', async () => {
    redis.getApiKey.mockResolvedValue({
      id: 'child-1',
      parentKeyId: PARENT_ID,
      isDeleted: 'false'
    })

    await expect(apiKeyService.getV2ChildPlaintext(PARENT_ID, 'child-1')).rejects.toMatchObject({
      code: 'PLAINTEXT_UNAVAILABLE'
    })
    expect(logger.security).not.toHaveBeenCalled()
  })

  // strip：列表/恢复返回对象绝不含 encryptedApiKey（也不含 apiKey）─────────────────

  // 11. getAllApiKeysFast 剥离 encryptedApiKey / apiKey
  test('getAllApiKeysFast strips encryptedApiKey and apiKey from returned objects', async () => {
    redis.batchGetApiKeys.mockResolvedValue([
      { id: 'c1', isDeleted: false, apiKey: 'hashed', encryptedApiKey: encrypt('cr_secret') }
    ])
    redis.batchGetApiKeyStats.mockResolvedValue(new Map())

    const keys = await apiKeyService.getAllApiKeysFast(false, ['c1'])

    expect(keys).toHaveLength(1)
    expect(keys[0]).not.toHaveProperty('encryptedApiKey')
    expect(keys[0]).not.toHaveProperty('apiKey')
  })

  // 12. restoreApiKey 返回的安全副本剥离 encryptedApiKey / apiKey（hash）
  //     （返回结构为 { success, apiKey: <safeKey> }，故对内层 safeKey 断言）
  test('restoreApiKey strips encryptedApiKey and the hashed apiKey from the safe copy', async () => {
    redis.getApiKey.mockResolvedValue({
      id: 'key-1',
      name: 'restored',
      apiKey: 'hashed',
      encryptedApiKey: encrypt('cr_secret'),
      isDeleted: 'true',
      tags: '[]'
    })
    redis.client.hdel = jest.fn().mockResolvedValue()
    redis.setApiKeyHash = jest.fn().mockResolvedValue()

    const restored = await apiKeyService.restoreApiKey('key-1')

    expect(restored.success).toBe(true)
    expect(restored.apiKey).not.toHaveProperty('encryptedApiKey')
    expect(restored.apiKey.apiKey).toBeUndefined() // hash 也已剥离
    expect(restored.apiKey).not.toHaveProperty('v2PasswordHash')
  })
})
