// 路由测试：POST /admin/api-keys/:keyId/secret/reveal（管理员显示 API Key 明文，
// 响应不缓存；明文绝不入日志）。
// harness 克隆自 adminApiKeysV2ImpersonateRoute.test.js：apiKeys.js 的 require 面全部 mock，
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
  getApiKeyPlaintextById: jest.fn()
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
    headers: {},
    json: jest.fn((payload) => {
      res.body = payload
      return res
    }),
    status: jest.fn((code) => {
      res.statusCode = code
      return res
    }),
    set: jest.fn((name, value) => {
      res.headers[name] = value
      return res
    })
  }

  return res
}

function findRevealHandler() {
  const route = mockRouter.post.mock.calls.find(
    (call) => call[0] === '/api-keys/:keyId/secret/reveal'
  )
  return route?.[2]
}

describe('admin api keys route secret reveal', () => {
  beforeEach(() => {
    apiKeyService.getApiKeyPlaintextById.mockReset()
  })

  test('returns the plaintext key with no-store cache header', async () => {
    apiKeyService.getApiKeyPlaintextById.mockResolvedValue('cr_plain_xxx')

    const handler = findRevealHandler()
    const res = createResponse()

    await handler(
      {
        params: { keyId: 'key-1' },
        admin: { username: 'admin-user' }
      },
      res
    )

    expect(apiKeyService.getApiKeyPlaintextById).toHaveBeenCalledWith('key-1')
    expect(res.status).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(200)
    expect(res.headers['Cache-Control']).toBe('no-store')
    expect(res.body).toEqual({
      success: true,
      data: { apiKey: 'cr_plain_xxx' }
    })
  })

  test('maps service error codes to the expected status codes', async () => {
    const cases = [
      ['NOT_FOUND', 404],
      ['V2_PARENT_NO_SECRET', 400],
      ['PLAINTEXT_UNAVAILABLE', 409],
      ['PLAINTEXT_DECRYPT_FAILED', 500]
    ]

    for (const [code, expectedStatus] of cases) {
      const error = new Error(`failed: ${code}`)
      error.code = code
      apiKeyService.getApiKeyPlaintextById.mockRejectedValue(error)

      const handler = findRevealHandler()
      const res = createResponse()

      await handler(
        {
          params: { keyId: 'key-1' },
          admin: { username: 'admin-user' }
        },
        res
      )

      expect(res.status).toHaveBeenCalledWith(expectedStatus)
      expect(res.statusCode).toBe(expectedStatus)
      expect(res.body.error).toBeDefined()
    }
  })
})
