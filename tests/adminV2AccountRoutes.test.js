// v2 路由测试：PUT /admin/v2/keys/:keyId + GET/PUT /admin/v2/account/ip-whitelist
// 覆盖：PUT /keys 只透传白名单 8 字段给 service 层 updateV2Child（额外字段、含存储名
// v2IpWhitelistOverride，绝不透传）、非法值经 service 校验返回 400（message 透传）、
// 非归属 NOT_FOUND 返回 404、成功 200；账号级白名单 GET 委托/500、PUT 只透传两字段/400。
//
// 路由 harness 同 adminV2AccountUsageRecordsRoute.test.js：
// - mockRouter 必须含 use（router.use(authenticateV2Account)）。
// - 路由注册为 router.method(path, handler)，无内联中间件 → handler 在 call[1]。
// - handler 一律按 path 查找、不按注册顺序取，新增路由不影响既有用例。

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
  updateV2Child: jest.fn(),
  assertV2ChildOwnership: jest.fn(),
  createV2Child: jest.fn(),
  getV2Children: jest.fn(),
  getV2ChildrenUsageStats: jest.fn(),
  getV2AccountSummary: jest.fn(),
  changeV2Password: jest.fn(),
  deleteApiKey: jest.fn(),
  getV2IpWhitelist: jest.fn(),
  updateV2IpWhitelist: jest.fn()
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
require('../src/routes/admin/v2Account')

const PUT_PATH = '/keys/:keyId'
const IP_WHITELIST_PATH = '/account/ip-whitelist'
const USAGE_STATS_PATH = '/keys/usage-stats'
const handler = mockRouter.put.mock.calls.find((call) => call[0] === PUT_PATH)[1]
const usageStatsHandler = mockRouter.post.mock.calls.find((call) => call[0] === USAGE_STATS_PATH)[1]
const getIpWhitelistHandler = mockRouter.get.mock.calls.find(
  (call) => call[0] === IP_WHITELIST_PATH
)[1]
const putIpWhitelistHandler = mockRouter.put.mock.calls.find(
  (call) => call[0] === IP_WHITELIST_PATH
)[1]

function createRes() {
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

function createReq(body = {}) {
  return {
    params: { keyId: 'child-1' },
    body,
    v2Account: { parentKeyId: 'parent-1', email: 'tenant@example.com' }
  }
}

describe('PUT /admin/v2/keys/:keyId', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    apiKeyService.updateV2Child.mockResolvedValue({ success: true })
  })

  // 1. 成功路径：调用 service 层 updateV2Child 并返回 200（白名单三字段以入参名透传）
  test('delegates to updateV2Child and returns success', async () => {
    const res = createRes()
    await handler(
      createReq({
        name: 'renamed',
        dailyCostLimit: 5,
        ipWhitelistOverride: true,
        enableIpWhitelist: true,
        ipWhitelist: ['1.2.3.4']
      }),
      res
    )

    expect(apiKeyService.updateV2Child).toHaveBeenCalledWith('parent-1', 'child-1', {
      name: 'renamed',
      dailyCostLimit: 5,
      ipWhitelistOverride: true,
      enableIpWhitelist: true,
      ipWhitelist: ['1.2.3.4']
    })
    expect(res.status).not.toHaveBeenCalled()
    expect(res.body).toEqual({ success: true, message: 'API key updated successfully' })
  })

  // 2. 白名单之外的字段绝不透传（防借道改继承/提权）；透传集恰好 8 字段，
  //    存储字段名 v2IpWhitelistOverride 不可经路由直接写入（入参名是 ipWhitelistOverride）
  test('never forwards non-whitelisted fields to the service layer', async () => {
    const res = createRes()
    await handler(
      createReq({
        name: 'n',
        permissions: ['claude'],
        claudeAccountId: 'steal-binding',
        parentKeyId: 'other-parent',
        isV2Parent: true,
        expiresAt: '2099-01-01',
        v2IpWhitelistOverride: true
      }),
      res
    )

    const forwarded = apiKeyService.updateV2Child.mock.calls[0][2]
    expect(Object.keys(forwarded).sort()).toEqual([
      'dailyCostLimit',
      'description',
      'enableIpWhitelist',
      'ipWhitelist',
      'ipWhitelistOverride',
      'isActive',
      'name',
      'totalCostLimit'
    ])
    for (const field of [
      'permissions',
      'claudeAccountId',
      'parentKeyId',
      'isV2Parent',
      'expiresAt',
      'v2IpWhitelistOverride'
    ]) {
      expect(forwarded).not.toHaveProperty(field)
    }
  })

  // 3. service 校验失败（非法额度等）→ 400，message 透传给前端
  test('returns 400 with the validation message for invalid values', async () => {
    apiKeyService.updateV2Child.mockRejectedValue(
      new Error('dailyCostLimit must be a non-negative number')
    )
    const res = createRes()
    await handler(createReq({ dailyCostLimit: -5 }), res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.body.message).toBe('dailyCostLimit must be a non-negative number')
  })

  // 4. 非归属 / 不存在 / 已软删除的子 key → 404（service 抛 NOT_FOUND）
  test('returns 404 when ownership assertion fails with NOT_FOUND', async () => {
    const notFound = new Error('API key not found')
    notFound.code = 'NOT_FOUND'
    apiKeyService.updateV2Child.mockRejectedValue(notFound)
    const res = createRes()
    await handler(createReq({ name: 'x' }), res)

    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.body.error).toBe('Not found')
  })
})

describe('GET /admin/v2/account/ip-whitelist', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  // 1. 委托 service 并原样返回（响应 data 只含白名单两字段，无上游账户信息）
  test('delegates to getV2IpWhitelist and returns only whitelist fields', async () => {
    apiKeyService.getV2IpWhitelist.mockResolvedValue({
      enableIpWhitelist: true,
      ipWhitelist: ['1.2.3.4']
    })
    const res = createRes()
    await getIpWhitelistHandler(createReq(), res)

    expect(apiKeyService.getV2IpWhitelist).toHaveBeenCalledWith('parent-1')
    expect(res.status).not.toHaveBeenCalled()
    expect(res.body).toEqual({
      success: true,
      data: { enableIpWhitelist: true, ipWhitelist: ['1.2.3.4'] }
    })
    expect(Object.keys(res.body.data).sort()).toEqual(['enableIpWhitelist', 'ipWhitelist'])
  })

  // 2. service 异常 → 500
  test('returns 500 when the service fails', async () => {
    apiKeyService.getV2IpWhitelist.mockRejectedValue(new Error('boom'))
    const res = createRes()
    await getIpWhitelistHandler(createReq(), res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.body.error).toBe('Failed to load IP whitelist')
  })
})

describe('POST /admin/v2/keys/usage-stats', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    apiKeyService.getV2ChildrenUsageStats.mockResolvedValue({
      'child-1': {
        requests: 2,
        tokens: 30,
        inputTokens: 10,
        outputTokens: 20,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
        cost: 1.5,
        formattedCost: '$1.50'
      }
    })
  })

  test('derives child keys from the v2 session and ignores client supplied keyIds', async () => {
    const res = createRes()
    await usageStatsHandler(
      createReq({
        keyIds: ['other-key'],
        timeRange: '7days'
      }),
      res
    )

    expect(apiKeyService.getV2ChildrenUsageStats).toHaveBeenCalledWith('parent-1', {
      timeRange: '7days',
      startDate: undefined,
      endDate: undefined
    })
    expect(res.status).not.toHaveBeenCalled()
    expect(res.body).toEqual({
      success: true,
      data: {
        'child-1': {
          requests: 2,
          tokens: 30,
          inputTokens: 10,
          outputTokens: 20,
          cacheCreateTokens: 0,
          cacheReadTokens: 0,
          cost: 1.5,
          formattedCost: '$1.50'
        }
      }
    })
  })

  test('returns 400 for invalid custom date ranges', async () => {
    const res = createRes()
    await usageStatsHandler(
      createReq({
        timeRange: 'custom',
        startDate: '2026-06-02',
        endDate: '2026-06-01'
      }),
      res
    )

    expect(apiKeyService.getV2ChildrenUsageStats).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.body.error).toBe('Invalid time range')
  })
})

describe('PUT /admin/v2/account/ip-whitelist', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    apiKeyService.updateV2IpWhitelist.mockResolvedValue({
      enableIpWhitelist: true,
      ipWhitelist: ['1.2.3.4']
    })
  })

  // 3. 只透传 enableIpWhitelist/ipWhitelist 两字段，额外字段绝不透传
  test('forwards exactly the two whitelist fields', async () => {
    const res = createRes()
    await putIpWhitelistHandler(
      createReq({
        enableIpWhitelist: true,
        ipWhitelist: ['1.2.3.4'],
        isV2Parent: true,
        v2TotalBudget: 999,
        permissions: ['claude']
      }),
      res
    )

    expect(apiKeyService.updateV2IpWhitelist).toHaveBeenCalledWith('parent-1', {
      enableIpWhitelist: true,
      ipWhitelist: ['1.2.3.4']
    })
    const forwarded = apiKeyService.updateV2IpWhitelist.mock.calls[0][1]
    expect(Object.keys(forwarded).sort()).toEqual(['enableIpWhitelist', 'ipWhitelist'])
    expect(res.body).toEqual({
      success: true,
      data: { enableIpWhitelist: true, ipWhitelist: ['1.2.3.4'] },
      message: 'IP whitelist updated successfully'
    })
  })

  // 4. service 校验错误 → 400 且 message 透传给前端
  test('returns 400 with the validation message', async () => {
    apiKeyService.updateV2IpWhitelist.mockRejectedValue(
      new Error('启用 IP 白名单时至少需要一个 IP 或 CIDR')
    )
    const res = createRes()
    await putIpWhitelistHandler(createReq({ enableIpWhitelist: true, ipWhitelist: [] }), res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.body.message).toBe('启用 IP 白名单时至少需要一个 IP 或 CIDR')
  })

  // 5. body 缺失（undefined）不崩溃，仍委托 service 做参数校验
  test('handles a missing body gracefully', async () => {
    apiKeyService.updateV2IpWhitelist.mockRejectedValue(
      new Error('enableIpWhitelist must be a boolean')
    )
    const req = createReq()
    req.body = undefined
    const res = createRes()
    await putIpWhitelistHandler(req, res)

    expect(apiKeyService.updateV2IpWhitelist).toHaveBeenCalledWith('parent-1', {
      enableIpWhitelist: undefined,
      ipWhitelist: undefined
    })
    expect(res.status).toHaveBeenCalledWith(400)
  })
})
