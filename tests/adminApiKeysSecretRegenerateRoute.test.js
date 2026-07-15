const mockRouter = {
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  patch: jest.fn(),
  delete: jest.fn()
}

jest.mock('express', () => ({ Router: () => mockRouter }), { virtual: true })
jest.mock('../src/middleware/auth', () => ({
  authenticateAdmin: jest.fn((_req, _res, next) => next())
}))
jest.mock('../src/services/apiKeyService', () => ({ rotateApiKeySecret: jest.fn() }))
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
jest.mock('../config/config', () => ({ system: { timezoneOffset: 8 } }), { virtual: true })
jest.mock('../src/services/requestBodyRuleService', () => ({
  validateAndNormalizeRules: jest.fn()
}))

const apiKeyService = require('../src/services/apiKeyService')
require('../src/routes/admin/apiKeys')

const route = mockRouter.post.mock.calls.find(
  (call) => call[0] === '/api-keys/:keyId/secret/regenerate'
)
const handler = route[2]

function createResponse() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    set: jest.fn((name, value) => {
      res.headers[name] = value
      return res
    }),
    status: jest.fn((code) => {
      res.statusCode = code
      return res
    }),
    json: jest.fn((body) => {
      res.body = body
      return res
    })
  }
  return res
}

describe('POST /admin/api-keys/:keyId/secret/regenerate', () => {
  beforeEach(() => jest.clearAllMocks())

  test('passes only the accepted request fields and returns the new secret with no-store', async () => {
    apiKeyService.rotateApiKeySecret.mockResolvedValue({
      id: 'key-1',
      name: 'test',
      apiKey: 'custom value',
      updatedAt: '2026-07-15T00:00:00.000Z',
      generationMode: 'custom'
    })
    const res = createResponse()

    await handler(
      {
        params: { keyId: 'key-1' },
        body: { mode: 'custom', apiKey: 'custom value', expectedOldHash: 'forged' }
      },
      res
    )

    expect(apiKeyService.rotateApiKeySecret).toHaveBeenCalledWith(
      'key-1',
      { mode: 'custom', apiKey: 'custom value' },
      'admin'
    )
    expect(res.headers['Cache-Control']).toBe('no-store')
    expect(res.body).toMatchObject({ success: true, data: { apiKey: 'custom value' } })
  })

  test.each([
    ['INVALID_MODE', 400],
    ['V2_PARENT_NO_SECRET', 400],
    ['NOT_FOUND', 404],
    ['SAME_VALUE', 409],
    ['CONFLICT', 409],
    ['STATE_CHANGED', 409],
    ['REGISTRY_CONFLICT', 409],
    ['REGISTRY_NOT_READY', 503],
    ['UNEXPECTED', 500]
  ])('maps %s to HTTP %d', async (code, status) => {
    const error = new Error('safe failure')
    error.code = code
    apiKeyService.rotateApiKeySecret.mockRejectedValue(error)
    const res = createResponse()

    await handler({ params: { keyId: 'key-1' }, body: { mode: 'system' } }, res)

    expect(res.statusCode).toBe(status)
    expect(res.headers['Cache-Control']).toBe('no-store')
    expect(res.body.success).toBe(false)
  })
})
