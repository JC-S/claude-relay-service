// v2 子 key 请求时间线端点测试：GET /admin/v2/keys/:keyId/usage-records
// 覆盖：归属校验(404)、字段最小化(白名单)、GPT priority→fast 展示、costBreakdown 倍率缩放、
// realTotal<=0 不返回分项、legacy 记录形态也能正确缩放、ephemeral 当前不展示、limit clamp。
//
// 路由 harness 差异（见 plan_tmp/v2-account-billing-edge-test-plan_revised.md C8）：
// - mockRouter 必须含 use（本文件用 router.use(authenticateV2Account)）。
// - 本路由注册为 router.get(path, handler)，无内联中间件 → handler 在 call[1]（不是 call[2]）。
// - 不 mock modelVariantHelper：用真实 applyDisplayModelToRecord，fast 展示断言才有意义。

const mockRouter = {
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  delete: jest.fn(),
  use: jest.fn()
}

jest.mock(
  'express',
  () => ({
    Router: () => mockRouter
  }),
  { virtual: true }
)

jest.mock('../src/middleware/auth', () => ({
  authenticateV2Account: jest.fn((_req, _res, next) => next())
}))

jest.mock('../src/services/apiKeyService', () => ({
  assertV2ChildOwnership: jest.fn()
}))

jest.mock('../src/models/redis', () => ({
  getUsageRecords: jest.fn(),
  deleteSession: jest.fn()
}))

jest.mock('../src/utils/logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  success: jest.fn(),
  database: jest.fn()
}))

const apiKeyService = require('../src/services/apiKeyService')
const redis = require('../src/models/redis')
require('../src/routes/admin/v2Account')

const RECORDS_PATH = '/keys/:keyId/usage-records'
const handler = mockRouter.get.mock.calls.find((call) => call[0] === RECORDS_PATH)[1]

// 白名单输出键（端点 fail-closed 只返回这些）
const ALLOWED_KEYS = [
  'timestamp',
  'model',
  'inputTokens',
  'outputTokens',
  'cacheCreateTokens',
  'cacheReadTokens',
  'totalTokens',
  'cost',
  'costBreakdown'
]
// 绝不能出现的上游/敏感字段
const FORBIDDEN_KEYS = [
  'accountId',
  'accountType',
  'parentKeyId',
  'upstreamNicIp',
  'requestId',
  'endpoint',
  'method',
  'statusCode',
  'durationMs',
  'realCost',
  'realCostBreakdown',
  'serviceTier'
]

function createResponse() {
  const res = {
    statusCode: 200,
    body: null,
    json: jest.fn((payload) => {
      res.body = payload
      return res
    }),
    status: jest.fn((code) => {
      res.statusCode = code
      return res
    })
  }
  return res
}

function createReq(overrides = {}) {
  return {
    params: { keyId: 'child-1' },
    query: {},
    v2Account: { parentKeyId: 'parent-1' },
    ...overrides
  }
}

describe('GET /admin/v2/keys/:keyId/usage-records', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    apiKeyService.assertV2ChildOwnership.mockResolvedValue(undefined)
    redis.getUsageRecords.mockResolvedValue([])
  })

  // 1. 归属校验：成功 → 200；NOT_FOUND → 404
  test('checks ownership: resolves to 200, NOT_FOUND yields 404', async () => {
    const okRes = createResponse()
    await handler(createReq(), okRes)
    expect(apiKeyService.assertV2ChildOwnership).toHaveBeenCalledWith('parent-1', 'child-1')
    expect(okRes.status).not.toHaveBeenCalled()
    expect(okRes.body.success).toBe(true)
    expect(Array.isArray(okRes.body.data)).toBe(true)

    apiKeyService.assertV2ChildOwnership.mockRejectedValue({ code: 'NOT_FOUND' })
    const notFoundRes = createResponse()
    await handler(createReq(), notFoundRes)
    expect(notFoundRes.status).toHaveBeenCalledWith(404)
    expect(notFoundRes.body.error).toBeDefined()
  })

  // 2. 字段最小化：上游/敏感字段一律不出现，只保留白名单
  test('minimizes fields: only whitelist keys are returned', async () => {
    redis.getUsageRecords.mockResolvedValue([
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        model: 'claude-sonnet-4-5',
        inputTokens: 10,
        outputTokens: 20,
        cacheCreateTokens: 5,
        cacheReadTokens: 2,
        totalTokens: 37,
        cost: 2,
        costBreakdown: { total: 1, input: 0.5, output: 0.5, cacheCreate: 0, cacheRead: 0 },
        // 以下全部应被剥离
        accountId: 'acc-secret',
        accountType: 'claude-console',
        parentKeyId: 'parent-1',
        upstreamNicIp: '10.0.0.1',
        requestId: 'req-1',
        endpoint: '/api/v1/messages',
        method: 'POST',
        statusCode: 200,
        durationMs: 1234,
        realCost: 1,
        realCostBreakdown: { total: 1 },
        serviceTier: 'standard'
      }
    ])

    const res = createResponse()
    await handler(createReq(), res)
    const item = res.body.data[0]

    for (const key of FORBIDDEN_KEYS) {
      expect(item).not.toHaveProperty(key)
    }
    for (const key of ALLOWED_KEYS) {
      expect(item).toHaveProperty(key)
    }
    expect(Object.keys(item).sort()).toEqual([...ALLOWED_KEYS].sort())
    // costBreakdown 子字段也最小化
    expect(Object.keys(item.costBreakdown).sort()).toEqual(
      ['cacheCreate', 'cacheRead', 'input', 'output', 'total'].sort()
    )
  })

  test('returns image token details without exposing upstream account fields', async () => {
    redis.getUsageRecords.mockResolvedValue([
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        model: 'gpt-image-2',
        inputTokens: 120,
        outputTokens: 4000,
        textInputTokens: 20,
        imageInputTokens: 100,
        imageOutputTokens: 4000,
        imageUsageBreakdownEstimated: true,
        totalTokens: 4120,
        cost: 0.1209,
        costBreakdown: { total: 0.1209, input: 0.0009, output: 0.12 },
        accountId: 'must-not-leak',
        accountType: 'openai'
      }
    ])

    const res = createResponse()
    await handler(createReq(), res)
    const item = res.body.data[0]

    expect(item).toEqual(
      expect.objectContaining({
        textInputTokens: 20,
        imageInputTokens: 100,
        imageOutputTokens: 4000,
        imageUsageBreakdownEstimated: true
      })
    )
    expect(item).not.toHaveProperty('accountId')
    expect(item).not.toHaveProperty('accountType')
  })

  // 3. GPT priority → 展示为 "xxx (fast)"，且不返回 serviceTier
  test('GPT priority record is displayed as fast model name without serviceTier', async () => {
    redis.getUsageRecords.mockResolvedValue([
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        model: 'gpt-5.5',
        serviceTier: 'priority',
        cost: 0,
        costBreakdown: { total: 0 }
      }
    ])

    const res = createResponse()
    await handler(createReq(), res)
    const item = res.body.data[0]

    expect(item.model).toBe('gpt-5.5 (fast)')
    expect(item).not.toHaveProperty('serviceTier')
  })

  // 4. costBreakdown 按倍率缩放（干净比例 ratio=2）
  test('scales costBreakdown by rated ratio', async () => {
    redis.getUsageRecords.mockResolvedValue([
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        model: 'claude-sonnet-4-5',
        cost: 2.0,
        costBreakdown: { total: 1.0, input: 0.4, output: 0.6, cacheCreate: 0, cacheRead: 0 }
      }
    ])

    const res = createResponse()
    await handler(createReq(), res)
    const cb = res.body.data[0].costBreakdown

    expect(cb.input).toBeCloseTo(0.8, 6)
    expect(cb.output).toBeCloseTo(1.2, 6)
    expect(cb.cacheCreate).toBeCloseTo(0, 6)
    expect(cb.cacheRead).toBeCloseTo(0, 6)
    expect(cb.total).toBe(2.0) // 端点直接把 total 设为 cost（精确）
  })

  // 5. realTotal <= 0：不返回分项（costBreakdown=null），其余字段正常
  test('returns null costBreakdown when real total is zero', async () => {
    redis.getUsageRecords.mockResolvedValue([
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        model: 'claude-sonnet-4-5',
        inputTokens: 3,
        totalTokens: 3,
        cost: 0,
        costBreakdown: { total: 0, input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }
      }
    ])

    const res = createResponse()
    await handler(createReq(), res)
    const item = res.body.data[0]

    expect(item.costBreakdown).toBeNull()
    expect(item.cost).toBe(0)
    expect(item.inputTokens).toBe(3)
    expect(item.totalTokens).toBe(3)
  })

  // 6. legacy 记录形态（同时含 cacheCreate 与 cacheWrite、无 ephemeral）也能正确缩放（C6）
  test('scales legacy-shaped costBreakdown correctly (reads cacheCreate, not cacheWrite)', async () => {
    redis.getUsageRecords.mockResolvedValue([
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        model: 'claude-sonnet-4-5',
        cost: 3.0,
        // legacy：cacheCreate 与 cacheWrite 同值并存（见 costCalculator）；端点读 cacheCreate
        costBreakdown: {
          total: 1.5,
          input: 0.5,
          output: 0.4,
          cacheCreate: 0.6,
          cacheWrite: 0.6,
          cacheRead: 0
        }
      }
    ])

    const res = createResponse()
    await handler(createReq(), res)
    const cb = res.body.data[0].costBreakdown

    // ratio = 3.0 / 1.5 = 2
    expect(cb.input).toBeCloseTo(1.0, 6)
    expect(cb.output).toBeCloseTo(0.8, 6)
    expect(cb.cacheCreate).toBeCloseTo(1.2, 6) // 读到了 cacheCreate（未漏缓存成本）
    expect(cb.cacheRead).toBeCloseTo(0, 6)
    expect(cb.total).toBe(3.0)
    // 四个分项之和 ≈ total（非精确 toBe）
    expect(cb.input + cb.output + cb.cacheCreate + cb.cacheRead).toBeCloseTo(3.0, 6)
    // 输出里不应出现 legacy 的 cacheWrite 键
    expect(cb).not.toHaveProperty('cacheWrite')
  })

  // 7. ephemeral 当前不单独展示（固定现状），但其成本已含在缩放后的 cacheCreate 内
  test('does not expose ephemeral subitems; their cost is folded into cacheCreate', async () => {
    redis.getUsageRecords.mockResolvedValue([
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        model: 'claude-sonnet-4-5',
        cost: 4.0,
        costBreakdown: {
          total: 2.0,
          input: 0,
          output: 0,
          cacheCreate: 2.0, // 真实 cacheCreate 已含 5m+1h
          cacheRead: 0,
          ephemeral5m: 1.2,
          ephemeral1h: 0.8
        }
      }
    ])

    const res = createResponse()
    await handler(createReq(), res)
    const cb = res.body.data[0].costBreakdown

    expect(cb).not.toHaveProperty('ephemeral5m')
    expect(cb).not.toHaveProperty('ephemeral1h')
    expect(cb.cacheCreate).toBeCloseTo(4.0, 6) // ratio=2，含 ephemeral 成本
    expect(cb.total).toBe(4.0)
  })

  // 8. limit clamp 精确行为
  test('clamps limit to 1..200 with default 100', async () => {
    const cases = [
      [undefined, 100],
      ['0', 100],
      ['abc', 100],
      ['5000', 200],
      ['-5', 1],
      ['30', 30]
    ]

    for (const [input, expected] of cases) {
      redis.getUsageRecords.mockClear()
      const query = input === undefined ? {} : { limit: input }
      const res = createResponse()
      await handler(createReq({ query }), res)
      expect(redis.getUsageRecords).toHaveBeenCalledWith('child-1', expected)
    }
  })
})
