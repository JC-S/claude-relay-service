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
  assertV2ChildOwnership: jest.fn(),
  getV2ChildPlaintext: jest.fn(),
  validateApiKeyForStats: jest.fn(),
  hasPermission: jest.fn()
}))
jest.mock('../src/services/apiKeyConnectivityTestService', () => ({
  validateV2ConnectivityTestParams: jest.fn(),
  runApiKeyConnectivityTest: jest.fn()
}))
jest.mock('../src/utils/ipWhitelistHelper', () => ({ getRequestIp: jest.fn() }))
jest.mock('../src/models/redis', () => ({ getUsageRecords: jest.fn(), deleteSession: jest.fn() }))
jest.mock('../src/utils/logger', () => ({
  api: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  database: jest.fn()
}))

const apiKeyService = require('../src/services/apiKeyService')
const {
  validateV2ConnectivityTestParams,
  runApiKeyConnectivityTest
} = require('../src/services/apiKeyConnectivityTestService')
const { getRequestIp } = require('../src/utils/ipWhitelistHelper')
require('../src/routes/admin/v2Account')

const PATH = '/keys/:keyId/connectivity-test'
const handler = mockRouter.post.mock.calls.find((call) => call[0] === PATH)[1]

function createReq(body = {}) {
  return {
    params: { keyId: 'child-1' },
    body,
    v2Account: { parentKeyId: 'parent-1', email: 'tenant@example.com' }
  }
}

function createRes() {
  const res = {
    statusCode: 200,
    body: null,
    headersSent: false,
    destroyed: false,
    writableEnded: false,
    status: jest.fn((code) => {
      res.statusCode = code
      return res
    }),
    json: jest.fn((body) => {
      res.body = body
      return res
    }),
    write: jest.fn(),
    end: jest.fn()
  }
  return res
}

describe('POST /admin/v2/keys/:keyId/connectivity-test', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    apiKeyService.assertV2ChildOwnership.mockResolvedValue({
      id: 'child-1',
      isActive: 'true'
    })
    apiKeyService.getV2ChildPlaintext.mockResolvedValue('cr_plain_secret')
    apiKeyService.validateApiKeyForStats.mockResolvedValue({
      valid: true,
      keyData: { permissions: ['claude', 'gemini', 'openai'] }
    })
    apiKeyService.hasPermission.mockReturnValue(true)
    validateV2ConnectivityTestParams.mockImplementation((params) => ({
      service: params.service,
      model: params.model || 'gpt-5.4',
      prompt: params.prompt ?? 'hi',
      maxTokens: 1000
    }))
    getRequestIp.mockReturnValue('203.0.113.10')
    runApiKeyConnectivityTest.mockResolvedValue()
  })

  test.each(['claude', 'gemini', 'openai'])(
    'runs a %s test with the server-decrypted key and server-derived IP',
    async (service) => {
      const res = createRes()
      await handler(
        createReq({
          service,
          model: service === 'claude' ? 'claude-sonnet-4-6[1m]' : 'model',
          apiKey: 'attacker-key',
          clientIp: '198.51.100.66'
        }),
        res
      )

      expect(apiKeyService.assertV2ChildOwnership).toHaveBeenCalledWith('parent-1', 'child-1')
      expect(apiKeyService.getV2ChildPlaintext).toHaveBeenCalledWith('parent-1', 'child-1')
      expect(runApiKeyConnectivityTest).toHaveBeenCalledWith(
        expect.objectContaining({
          service,
          apiKey: 'cr_plain_secret',
          clientIp: '203.0.113.10',
          responseStream: res
        })
      )
      expect(runApiKeyConnectivityTest.mock.calls[0][0]).not.toHaveProperty(
        'apiKey',
        'attacker-key'
      )
      expect(res.body).toBeNull()
    }
  )

  test('returns 409 for a disabled child before decrypting it', async () => {
    apiKeyService.assertV2ChildOwnership.mockResolvedValue({ isActive: 'false' })
    const res = createRes()

    await handler(createReq({ service: 'claude' }), res)

    expect(res.statusCode).toBe(409)
    expect(apiKeyService.getV2ChildPlaintext).not.toHaveBeenCalled()
  })

  test.each([
    ['NOT_FOUND', 404],
    ['PLAINTEXT_UNAVAILABLE', 409],
    ['PLAINTEXT_DECRYPT_FAILED', 500]
  ])('maps %s to a safe response', async (code, status) => {
    const error = new Error('secret internal detail')
    error.code = code
    if (code === 'NOT_FOUND') {
      apiKeyService.assertV2ChildOwnership.mockRejectedValue(error)
    } else {
      apiKeyService.getV2ChildPlaintext.mockRejectedValue(error)
    }
    const res = createRes()

    await handler(createReq({ service: 'claude' }), res)

    expect(res.statusCode).toBe(status)
    expect(JSON.stringify(res.body)).not.toContain('secret internal detail')
  })

  test('returns 400 for strict V2 parameter validation errors', async () => {
    const error = new Error('Invalid model')
    error.code = 'VALIDATION_ERROR'
    validateV2ConnectivityTestParams.mockImplementation(() => {
      throw error
    })
    const res = createRes()

    await handler(createReq({ service: 'claude', model: '../bad' }), res)

    expect(res.statusCode).toBe(400)
    expect(apiKeyService.getV2ChildPlaintext).not.toHaveBeenCalled()
  })

  test('rejects invalid keys and missing service permission before starting SSE', async () => {
    apiKeyService.validateApiKeyForStats.mockResolvedValueOnce({
      valid: false,
      error: 'API key unavailable'
    })
    const invalidRes = createRes()
    await handler(createReq({ service: 'claude' }), invalidRes)
    expect(invalidRes.statusCode).toBe(409)

    apiKeyService.validateApiKeyForStats.mockResolvedValueOnce({
      valid: true,
      keyData: { permissions: ['claude'] }
    })
    apiKeyService.hasPermission.mockReturnValueOnce(false)
    const forbiddenRes = createRes()
    await handler(createReq({ service: 'openai' }), forbiddenRes)
    expect(forbiddenRes.statusCode).toBe(403)
    expect(runApiKeyConnectivityTest).not.toHaveBeenCalled()
  })
})
