const mockRouter = {
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  delete: jest.fn(),
  use: jest.fn()
}

jest.mock('express', () => ({ Router: () => mockRouter }), { virtual: true })
jest.mock('../src/middleware/auth', () => ({
  authenticateV2Account: jest.fn((_req, _res, next) => next())
}))
jest.mock('../src/services/apiKeyService', () => ({
  rotateV2ChildApiKeySecret: jest.fn()
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

const route = mockRouter.post.mock.calls.find(
  (call) => call[0] === '/keys/:keyId/secret/regenerate'
)
const handler = route[1]

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

describe('POST /admin/v2/keys/:keyId/secret/regenerate', () => {
  beforeEach(() => jest.clearAllMocks())

  test('uses the authenticated parent id and ignores a forged parent id', async () => {
    apiKeyService.rotateV2ChildApiKeySecret.mockResolvedValue({
      id: 'child-1',
      apiKey: 'new-key',
      generationMode: 'system'
    })
    const res = createResponse()

    await handler(
      {
        params: { keyId: 'child-1' },
        v2Account: { parentKeyId: 'parent-1' },
        body: { mode: 'system', parentKeyId: 'other-parent' }
      },
      res
    )

    expect(apiKeyService.rotateV2ChildApiKeySecret).toHaveBeenCalledWith('parent-1', 'child-1', {
      mode: 'system',
      apiKey: undefined
    })
    expect(res.headers['Cache-Control']).toBe('no-store')
    expect(res.body).toMatchObject({ success: true, data: { apiKey: 'new-key' } })
  })

  test.each([
    ['NOT_FOUND', 404],
    ['EMPTY', 400],
    ['CONFLICT', 409],
    ['REGISTRY_NOT_READY', 503],
    ['UNEXPECTED', 500]
  ])('maps %s to HTTP %d', async (code, status) => {
    const error = new Error('safe failure')
    error.code = code
    apiKeyService.rotateV2ChildApiKeySecret.mockRejectedValue(error)
    const res = createResponse()

    await handler(
      {
        params: { keyId: 'child-1' },
        v2Account: { parentKeyId: 'parent-1' },
        body: { mode: 'system' }
      },
      res
    )

    expect(res.statusCode).toBe(status)
    expect(res.headers['Cache-Control']).toBe('no-store')
    expect(res.body.success).toBe(false)
  })
})
