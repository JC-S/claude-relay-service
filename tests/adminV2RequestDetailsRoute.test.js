const mockRouter = {
  use: jest.fn(),
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
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
  authenticateV2Account: jest.fn()
}))

jest.mock('../src/services/apiKeyService', () => ({
  getV2RequestDetailScope: jest.fn()
}))

jest.mock('../src/services/requestDetailService', () => ({
  listRequestDetails: jest.fn(),
  getV2RequestDetail: jest.fn()
}))

jest.mock('../src/models/redis', () => ({}))
jest.mock('../src/services/apiKeyStatsService', () => ({
  validateStatsTimeRange: jest.fn(),
  ApiKeyStatsValidationError: class ApiKeyStatsValidationError extends Error {}
}))
jest.mock('../src/services/apiKeyConnectivityTestService', () => ({
  validateV2ConnectivityTestParams: jest.fn(),
  runApiKeyConnectivityTest: jest.fn()
}))
jest.mock('../src/utils/ipWhitelistHelper', () => ({
  getRequestIp: jest.fn()
}))
jest.mock('../src/utils/logger', () => ({
  api: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  success: jest.fn()
}))

const apiKeyService = require('../src/services/apiKeyService')
const requestDetailService = require('../src/services/requestDetailService')
require('../src/routes/admin/v2Account')

function findGetHandler(path) {
  return mockRouter.get.mock.calls
    .find((call) => call[0] === path)
    ?.find((value) => typeof value === 'function')
}

const listRequestDetailsHandler = findGetHandler('/request-details')
const getRequestDetailHandler = findGetHandler('/request-details/:requestId')

function createResponse() {
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    status: jest.fn((statusCode) => {
      res.statusCode = statusCode
      return res
    }),
    set: jest.fn((name, value) => {
      res.headers[name] = value
      return res
    }),
    json: jest.fn((body) => {
      res.body = body
      return res
    })
  }
  return res
}

function makeScope() {
  const childMap = new Map([
    ['child_a', { id: 'child_a', name: 'A', isDeleted: false }],
    ['child_deleted', { id: 'child_deleted', name: 'Deleted', isDeleted: true }]
  ])
  return {
    parentKeyId: 'parent_a',
    childIds: [...childMap.keys()].sort(),
    childIdSet: new Set(childMap.keys()),
    childMap,
    scopeFingerprint: 'fingerprint-a',
    parentServiceRates: { codex: 2 }
  }
}

describe('v2 request detail routes', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    apiKeyService.getV2RequestDetailScope.mockResolvedValue(makeScope())
  })

  test('passes only allowed query fields and the server-side scope', async () => {
    requestDetailService.listRequestDetails.mockResolvedValue({
      records: [{ requestId: 'req_a', apiKeyId: 'child_a' }],
      pagination: { currentPage: 1, pageSize: 50, totalRecords: 1, totalPages: 1 },
      summary: { totalRequests: 1, totalCost: 2 },
      availableFilters: {
        apiKeys: [{ id: 'child_a', name: 'A' }],
        accounts: [{ id: 'secret', name: 'Secret' }],
        models: ['gpt-5.6'],
        endpoints: ['/v1/responses']
      },
      captureEnabled: true,
      retentionHours: 6,
      snapshotId: 'snap-a'
    })
    const req = {
      v2Account: { parentKeyId: 'parent_a' },
      query: {
        apiKeyId: 'child_a',
        keyword: 'test',
        accountId: 'secret',
        projection: 'admin',
        scope: 'all'
      }
    }
    const res = createResponse()

    await listRequestDetailsHandler(req, res)

    const [filters, context] = requestDetailService.listRequestDetails.mock.calls[0]
    expect(filters).toEqual({ apiKeyId: 'child_a', keyword: 'test' })
    expect(context).toMatchObject({ projection: 'v2', scopeType: 'v2' })
    expect(context.apiKeyScope.parentKeyId).toBe('parent_a')
    expect(res.body.data).not.toHaveProperty('captureEnabled')
    expect(res.body.data.availableFilters).not.toHaveProperty('accounts')
  })

  test('returns a uniform 404 for an API key outside the parent scope', async () => {
    const res = createResponse()
    await listRequestDetailsHandler(
      {
        v2Account: { parentKeyId: 'parent_a' },
        query: { apiKeyId: 'child_b' }
      },
      res
    )
    expect(res.statusCode).toBe(404)
    expect(requestDetailService.listRequestDetails).not.toHaveBeenCalled()
  })

  test('returns Retry-After and JSON retryAfterSeconds when the gate is busy', async () => {
    const error = new Error('busy')
    error.code = 'V2_REQUEST_DETAILS_BUSY'
    error.retryAfterSeconds = 2
    requestDetailService.listRequestDetails.mockRejectedValue(error)
    const res = createResponse()

    await listRequestDetailsHandler({ v2Account: { parentKeyId: 'parent_a' }, query: {} }, res)

    expect(res.statusCode).toBe(503)
    expect(res.headers['Retry-After']).toBe('2')
    expect(res.body).toMatchObject({
      code: 'V2_REQUEST_DETAILS_BUSY',
      retryAfterSeconds: 2
    })
  })

  test('uses the scoped detail method and returns only its projected record', async () => {
    requestDetailService.getV2RequestDetail.mockResolvedValue({
      requestId: 'req_a',
      apiKeyId: 'child_deleted',
      apiKeyName: 'Deleted（已删除）'
    })
    const res = createResponse()
    await getRequestDetailHandler(
      {
        v2Account: { parentKeyId: 'parent_a' },
        params: { requestId: 'req_a' }
      },
      res
    )
    expect(requestDetailService.getV2RequestDetail).toHaveBeenCalledWith(
      'req_a',
      expect.objectContaining({ projection: 'v2', scopeType: 'v2' })
    )
    expect(res.body.data.record.apiKeyName).toContain('已删除')
  })

  test('returns the same 404 for missing or foreign request IDs', async () => {
    requestDetailService.getV2RequestDetail.mockResolvedValue(null)
    const res = createResponse()
    await getRequestDetailHandler(
      {
        v2Account: { parentKeyId: 'parent_a' },
        params: { requestId: 'foreign' }
      },
      res
    )
    expect(res.statusCode).toBe(404)
    expect(res.body.code).toBe('NOT_FOUND')
  })
})
