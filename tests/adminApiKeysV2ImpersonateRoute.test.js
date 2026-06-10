// 路由测试：POST /api-keys/:keyId/v2-impersonate（管理员模拟登录 v2 账号，
// 对应 plan_tmp/v2-account-admin-impersonation-plan_final.md）。
// harness 克隆自 adminApiKeysPayloadRulesRoute.test.js：apiKeys.js 的 require 面全部 mock，
// apiKeyService 只 mock 本路由用到的方法；路由为逐路由内联 authenticateAdmin，handler 在 call[2]。

const mockRouter = {
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  patch: jest.fn(),
  delete: jest.fn()
}

jest.mock(
  'express',
  () => ({
    Router: () => mockRouter
  }),
  { virtual: true }
)

jest.mock('../src/middleware/auth', () => ({
  authenticateAdmin: jest.fn((_req, _res, next) => next())
}))

jest.mock('../src/services/apiKeyService', () => ({
  createV2ImpersonationSession: jest.fn()
}))

jest.mock('../src/models/redis', () => ({}))

jest.mock('../src/utils/logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  success: jest.fn()
}))

jest.mock('../src/utils/costCalculator', () => ({
  calculateCost: jest.fn(),
  formatCost: jest.fn()
}))

jest.mock(
  '../config/config',
  () => ({
    system: {
      timezoneOffset: 8
    }
  }),
  { virtual: true }
)

jest.mock('../src/services/requestBodyRuleService', () => ({
  validateAndNormalizeRules: jest.fn()
}))

const apiKeyService = require('../src/services/apiKeyService')
require('../src/routes/admin/apiKeys')

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

function findImpersonateHandler() {
  const route = mockRouter.post.mock.calls.find(
    (call) => call[0] === '/api-keys/:keyId/v2-impersonate'
  )
  return route?.[2]
}

describe('admin api keys route v2 impersonation', () => {
  beforeEach(() => {
    apiKeyService.createV2ImpersonationSession.mockReset()
  })

  test('delegates to the service and returns a login-shaped response', async () => {
    const token = 'a'.repeat(64)
    apiKeyService.createV2ImpersonationSession.mockResolvedValue({
      token,
      username: 'tenant@example.com',
      expiresIn: 86400000
    })

    const handler = findImpersonateHandler()
    const res = createResponse()

    await handler(
      {
        params: { keyId: 'parent-1' },
        admin: { username: 'admin-user' }
      },
      res
    )

    expect(apiKeyService.createV2ImpersonationSession).toHaveBeenCalledWith(
      'parent-1',
      'admin-user'
    )
    expect(res.status).not.toHaveBeenCalled()
    expect(res.body).toEqual({
      success: true,
      token,
      role: 'v2',
      expiresIn: 86400000,
      username: 'tenant@example.com'
    })
  })

  test('maps a service rejection to 400 with the message passed through', async () => {
    apiKeyService.createV2ImpersonationSession.mockRejectedValue(
      new Error('Not an active v2 parent account')
    )

    const handler = findImpersonateHandler()
    const res = createResponse()

    await handler(
      {
        params: { keyId: 'parent-bad' },
        admin: { username: 'admin-user' }
      },
      res
    )

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.body).toEqual({
      error: 'Impersonation failed',
      message: 'Not an active v2 parent account'
    })
  })
})
