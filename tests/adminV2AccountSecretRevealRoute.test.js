// v2 子 key 明文显示端点测试：POST /admin/v2/keys/:keyId/secret/reveal
// 覆盖：成功返回明文 + Cache-Control: no-store + 入参断言；错误码映射（404/409/500）。
//
// 路由 harness（同 adminV2AccountUsageRecordsRoute.test.js）：
// - mockRouter 必须含 use（本文件用 router.use(authenticateV2Account)）。
// - 本路由注册为 router.post(path, handler)，无内联中间件 → handler 在 call[1]（不是 call[2]）。

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
  getV2ChildPlaintext: jest.fn()
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

const REVEAL_PATH = '/keys/:keyId/secret/reveal'
const handler = mockRouter.post.mock.calls.find((call) => call[0] === REVEAL_PATH)[1]

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

function createReq(overrides = {}) {
  return {
    params: { keyId: 'child-1' },
    v2Account: { parentKeyId: 'parent-1', email: 'tenant@example.com' },
    ...overrides
  }
}

describe('POST /admin/v2/keys/:keyId/secret/reveal', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('returns the plaintext key with no-store cache header', async () => {
    apiKeyService.getV2ChildPlaintext.mockResolvedValue('cr_plain_xxx')

    const res = createResponse()
    await handler(createReq(), res)

    expect(apiKeyService.getV2ChildPlaintext).toHaveBeenCalledWith('parent-1', 'child-1')
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
      ['PLAINTEXT_UNAVAILABLE', 409],
      ['PLAINTEXT_DECRYPT_FAILED', 500]
    ]

    for (const [code, expectedStatus] of cases) {
      apiKeyService.getV2ChildPlaintext.mockReset()
      const error = new Error(`failed: ${code}`)
      error.code = code
      apiKeyService.getV2ChildPlaintext.mockRejectedValue(error)

      const res = createResponse()
      await handler(createReq(), res)

      expect(res.status).toHaveBeenCalledWith(expectedStatus)
      expect(res.statusCode).toBe(expectedStatus)
      expect(res.body.error).toBeDefined()
    }
  })
})
