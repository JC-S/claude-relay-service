// v2 子 key 更新路由测试：PUT /admin/v2/keys/:keyId
// 覆盖：路由只透传白名单 5 字段给 service 层 updateV2Child（额外字段绝不透传）、
// 非法值经 service 校验返回 400（message 透传）、非归属 NOT_FOUND 返回 404、成功 200。
//
// 路由 harness 同 adminV2AccountUsageRecordsRoute.test.js：
// - mockRouter 必须含 use（router.use(authenticateV2Account)）。
// - 路由注册为 router.put(path, handler)，无内联中间件 → handler 在 call[1]。

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
  getV2AccountSummary: jest.fn(),
  changeV2Password: jest.fn(),
  deleteApiKey: jest.fn()
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
const handler = mockRouter.put.mock.calls.find((call) => call[0] === PUT_PATH)[1]

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

  // 1. 成功路径：调用 service 层 updateV2Child 并返回 200
  test('delegates to updateV2Child and returns success', async () => {
    const res = createRes()
    await handler(createReq({ name: 'renamed', dailyCostLimit: 5 }), res)

    expect(apiKeyService.updateV2Child).toHaveBeenCalledWith('parent-1', 'child-1', {
      name: 'renamed',
      dailyCostLimit: 5
    })
    expect(res.status).not.toHaveBeenCalled()
    expect(res.body).toEqual({ success: true, message: 'API key updated successfully' })
  })

  // 2. 白名单之外的字段绝不透传（防借道改继承/提权）
  test('never forwards non-whitelisted fields to the service layer', async () => {
    const res = createRes()
    await handler(
      createReq({
        name: 'n',
        permissions: ['claude'],
        claudeAccountId: 'steal-binding',
        parentKeyId: 'other-parent',
        isV2Parent: true,
        expiresAt: '2099-01-01'
      }),
      res
    )

    const forwarded = apiKeyService.updateV2Child.mock.calls[0][2]
    expect(Object.keys(forwarded).sort()).toEqual([
      'dailyCostLimit',
      'description',
      'isActive',
      'name',
      'totalCostLimit'
    ])
    for (const field of [
      'permissions',
      'claudeAccountId',
      'parentKeyId',
      'isV2Parent',
      'expiresAt'
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
