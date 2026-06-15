// v2 子 key 并发「父账号级共享池」测试（authenticateApiKey 中间件）
// 覆盖（见 plan_tmp/v2-parent-shared-concurrency-pool-plan.md）：
// - v2 子 key 的并发占位/释放用「父账号 id」（共享池），而非子 key 自身 id
// - 普通 key（无 parentKeyId）的并发仍用自身 id（回归保护）
// - concurrencyLimit=0 时整个并发块跳过，不触碰并发计数
//
// 设计：镜像 auth.v2Budget.test.js 的可行样板（mock validateApiKey 返回带 parentKeyId 的 v2 子
// keyData，client/version 闸门用「近版本 + Claude Code 系统提示」直接通过）。本文件额外把
// concurrencyLimit 设为 >0 并 mock redis 的并发方法，断言其首参（并发池 id）。
// 不为可测性改任何业务代码。
//
// 关键：_getConcurrencyConfig mock 返回 renewIntervalSeconds:0，使 authenticateApiKey 不创建
// 租约续期 setInterval（避免测试残留定时器）。

jest.mock('../src/services/apiKeyService', () => ({
  validateApiKey: jest.fn()
}))

jest.mock('../src/services/userService', () => ({}))

jest.mock('../src/models/redis', () => ({
  client: {
    get: jest.fn()
  },
  getNextResetTime: jest.fn(() => new Date('2026-01-01T00:00:00.000Z')),
  // 并发方法：默认不超限（incr 返回 1），释放返回 0
  incrConcurrency: jest.fn().mockResolvedValue(1),
  decrConcurrency: jest.fn().mockResolvedValue(0),
  refreshConcurrencyLease: jest.fn().mockResolvedValue(1),
  // 返回 renewIntervalSeconds:0 → 不创建续约定时器
  _getConcurrencyConfig: jest.fn(() => ({
    leaseSeconds: 300,
    renewIntervalSeconds: 0,
    cleanupGraceSeconds: 30
  }))
}))

jest.mock('../src/services/claudeRelayConfigService', () => ({
  isClaudeCodeOnlyEnabled: jest.fn().mockResolvedValue(false),
  // 排队关闭：并发超限直接 429（不进入轮询等待）
  getConfig: jest.fn().mockResolvedValue({ concurrentRequestQueueEnabled: false })
}))

jest.mock('../src/utils/logger', () => ({
  api: jest.fn(),
  database: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  security: jest.fn(),
  warn: jest.fn()
}))

const apiKeyService = require('../src/services/apiKeyService')
const redis = require('../src/models/redis')
const { authenticateApiKey } = require('../src/middleware/auth')

// 与 auth.v2Budget 样板一致：需带 Claude Code 系统提示 + metadata.user_id 通过客户端闸门
const VALID_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude."
const VALID_USER_ID =
  'user_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_account__session_17cf0fd3-d51b-4b59-977d-b899dafb3022'

function createReq() {
  return {
    ip: '127.0.0.1',
    path: '/v1/messages',
    originalUrl: '/v1/messages',
    headers: {
      'x-api-key': 'cr_test_key',
      'user-agent': 'claude-cli/2.1.150 (external, cli)',
      'x-app': 'cli',
      'anthropic-beta': 'claude-code-20250219',
      'anthropic-version': '2023-06-01'
    },
    body: {
      model: 'claude-sonnet-4-5',
      system: [{ type: 'text', text: VALID_SYSTEM_PROMPT }],
      metadata: { user_id: VALID_USER_ID },
      messages: [{ role: 'user', content: 'test' }]
    },
    connection: { remoteAddress: '127.0.0.1' },
    // 成功（未超限）路径会注册 req.once 监听器；错误路径会读 req.get，提供 no-op 即可
    once: jest.fn(),
    get: jest.fn(() => '')
  }
}

function createRes() {
  const res = {
    statusCode: 200,
    body: null,
    status: jest.fn((code) => {
      res.statusCode = code
      return res
    }),
    json: jest.fn((payload) => {
      res.body = payload
      return res
    }),
    // 429 限流路径会调用 res.set('Retry-After', ...)
    set: jest.fn(() => res),
    once: jest.fn()
  }
  return res
}

// v2 子 key：带 parentKeyId；并发上限已由 overlay 取父账号值（这里直接给定）
function mockV2Child(overrides = {}) {
  apiKeyService.validateApiKey.mockResolvedValue({
    valid: true,
    keyData: {
      id: 'child_key_1',
      name: 'v2-child',
      parentKeyId: 'parent_key_1',
      enableClientRestriction: true,
      allowedClients: ['claude_code'],
      enableIpWhitelist: false,
      concurrencyLimit: 0,
      rateLimitWindow: 0,
      rateLimitRequests: 0,
      rateLimitCost: 0,
      tokenLimit: 0,
      dailyCostLimit: 0,
      totalCostLimit: 0,
      weeklyOpusCostLimit: 0,
      permissions: ['claude'],
      v2TotalBudget: 100,
      v2ParentTotalCost: 10,
      ...overrides
    }
  })
}

// 普通 key（非 v2，无 parentKeyId）
function mockNormalKey(overrides = {}) {
  apiKeyService.validateApiKey.mockResolvedValue({
    valid: true,
    keyData: {
      id: 'normal_key_1',
      name: 'normal',
      enableClientRestriction: true,
      allowedClients: ['claude_code'],
      enableIpWhitelist: false,
      concurrencyLimit: 0,
      rateLimitWindow: 0,
      rateLimitRequests: 0,
      rateLimitCost: 0,
      tokenLimit: 0,
      dailyCostLimit: 0,
      totalCostLimit: 0,
      weeklyOpusCostLimit: 0,
      permissions: ['claude'],
      ...overrides
    }
  })
}

describe('authenticateApiKey v2 shared concurrency pool', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    redis.incrConcurrency.mockResolvedValue(1)
    redis.decrConcurrency.mockResolvedValue(0)
    redis.refreshConcurrencyLease.mockResolvedValue(1)
    redis._getConcurrencyConfig.mockReturnValue({
      leaseSeconds: 300,
      renewIntervalSeconds: 0,
      cleanupGraceSeconds: 30
    })
    // client/version 闸门：缓存版本与请求版本一致直接通过
    redis.client.get.mockResolvedValue('claude-cli/2.1.150 (external, cli)')
  })

  // 1. v2 子 key：并发占位用父账号 id（共享池），释放也用父账号 id
  test('v2 child uses the PARENT id for concurrency incr/decr (shared pool)', async () => {
    mockV2Child({ concurrencyLimit: 5 })
    const req = createReq()
    const res = createRes()
    const next = jest.fn()

    await authenticateApiKey(req, res, next)

    expect(next).toHaveBeenCalled()
    // 占位用父账号 id，绝不用子 key 自身 id
    expect(redis.incrConcurrency).toHaveBeenCalledWith(
      'parent_key_1',
      expect.any(String),
      expect.any(Number)
    )
    expect(redis.incrConcurrency).not.toHaveBeenCalledWith(
      'child_key_1',
      expect.anything(),
      expect.anything()
    )

    // 释放路径（请求结束闭包）也用父账号 id
    expect(req.concurrencyInfo).toBeDefined()
    await req.concurrencyInfo.decrementConcurrency()
    expect(redis.decrConcurrency).toHaveBeenCalledWith('parent_key_1', expect.any(String))
    expect(redis.decrConcurrency).not.toHaveBeenCalledWith('child_key_1', expect.anything())
  })

  // 2. 普通 key（无 parentKeyId）：并发仍用自身 id（回归保护）
  test('normal key (no parentKeyId) uses its own id for concurrency', async () => {
    mockNormalKey({ concurrencyLimit: 5 })
    const req = createReq()
    const res = createRes()
    const next = jest.fn()

    await authenticateApiKey(req, res, next)

    expect(next).toHaveBeenCalled()
    expect(redis.incrConcurrency).toHaveBeenCalledWith(
      'normal_key_1',
      expect.any(String),
      expect.any(Number)
    )
  })

  // 3. concurrencyLimit=0：整个并发块跳过，不触碰并发计数
  test('does not touch concurrency counters when concurrencyLimit is 0', async () => {
    mockV2Child({ concurrencyLimit: 0 })
    const req = createReq()
    const res = createRes()
    const next = jest.fn()

    await authenticateApiKey(req, res, next)

    expect(next).toHaveBeenCalled()
    expect(redis.incrConcurrency).not.toHaveBeenCalled()
    expect(redis.decrConcurrency).not.toHaveBeenCalled()
  })

  // 4. 行为测试：两个不同子 key 共享同一父账号并发池——父池占满后第二个请求被限流（429）
  test('two child keys share one parent pool: the second is rejected (429) when the pool is full', async () => {
    // 共享池：按 id 累加（两个子 key 都应落到 parent_key_1，互相挤占）
    const pools = {}
    redis.incrConcurrency.mockImplementation(async (id) => {
      pools[id] = (pools[id] || 0) + 1
      return pools[id]
    })
    redis.decrConcurrency.mockImplementation(async (id) => {
      pools[id] = Math.max(0, (pools[id] || 0) - 1)
      return pools[id]
    })

    // 第一个子 key（limit=1）：占用父池 1 个槽位且不释放（不触发 close 事件）
    mockV2Child({ id: 'child_key_1', concurrencyLimit: 1 })
    const req1 = createReq()
    const res1 = createRes()
    const next1 = jest.fn()
    await authenticateApiKey(req1, res1, next1)
    expect(next1).toHaveBeenCalled()
    // req.concurrencyInfo 暴露真实并发池 id（父账号）
    expect(req1.concurrencyInfo.concurrencyKeyId).toBe('parent_key_1')
    expect(req1.concurrencyInfo.apiKeyId).toBe('child_key_1')

    // 第二个子 key（不同 id、同一父账号，limit=1）：父池已满 → 429（队列关闭）
    mockV2Child({ id: 'child_key_2', concurrencyLimit: 1 })
    const req2 = createReq()
    const res2 = createRes()
    const next2 = jest.fn()
    await authenticateApiKey(req2, res2, next2)
    expect(next2).not.toHaveBeenCalled()
    expect(res2.status).toHaveBeenCalledWith(429)

    // 两个子 key 的并发占位都落到父账号 id（共享池），绝不用各自子 id
    expect(redis.incrConcurrency).toHaveBeenCalledWith(
      'parent_key_1',
      expect.any(String),
      expect.any(Number)
    )
    expect(redis.incrConcurrency).not.toHaveBeenCalledWith(
      'child_key_1',
      expect.anything(),
      expect.anything()
    )
    expect(redis.incrConcurrency).not.toHaveBeenCalledWith(
      'child_key_2',
      expect.anything(),
      expect.anything()
    )
    // 第二个请求超限后释放了自己的占位，父池仍被第一个子 key 占用（1）
    expect(pools.parent_key_1).toBe(1)
  })
})
