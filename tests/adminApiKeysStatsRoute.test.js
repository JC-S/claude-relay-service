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
jest.mock('../src/services/apiKeyService', () => ({}))
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
jest.mock('../src/services/apiKeyStatsService', () => {
  class ApiKeyStatsNotFoundError extends Error {
    constructor() {
      super('not found')
      this.code = 'API_KEY_STATS_NOT_FOUND'
    }
  }

  return {
    ApiKeyStatsNotFoundError,
    ApiKeyStatsValidationError: class ApiKeyStatsValidationError extends Error {},
    calculateKeyDetailStats: jest.fn(),
    calculateKeyStats: jest.fn(),
    validateStatsTimeRange: jest.fn()
  }
})

const logger = require('../src/utils/logger')
const {
  ApiKeyStatsNotFoundError,
  calculateKeyDetailStats
} = require('../src/services/apiKeyStatsService')
require('../src/routes/admin/apiKeys')

const route = mockRouter.get.mock.calls.find((call) => call[0] === '/api-keys/:keyId/stats')
const authenticate = route[1]
const handler = route[2]

function createResponse() {
  const res = {
    statusCode: 200,
    body: null,
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

describe('GET /admin/api-keys/:keyId/stats', () => {
  beforeEach(() => jest.clearAllMocks())

  test('keeps administrator authentication on the route', () => {
    expect(authenticate).toBe(require('../src/middleware/auth').authenticateAdmin)
  })

  test('returns the detail statistics contract', async () => {
    const stats = {
      total: { requests: 10, tokens: 100, cost: 2 },
      today: { requests: 2, tokens: 20, cost: 0.5 },
      averages: { rpm: 0.1, tpm: 1 },
      limits: { weeklyOpusCost: 1 }
    }
    calculateKeyDetailStats.mockResolvedValue(stats)
    const res = createResponse()

    await handler({ params: { keyId: 'key-1' } }, res)

    expect(calculateKeyDetailStats).toHaveBeenCalledWith('key-1')
    expect(res.body).toEqual({ success: true, stats })
  })

  test('returns 404 for a missing key', async () => {
    calculateKeyDetailStats.mockRejectedValue(new ApiKeyStatsNotFoundError())
    const res = createResponse()

    await handler({ params: { keyId: 'missing' } }, res)

    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ success: false, error: 'API key not found' })
  })

  test('returns a credential-free 500 response for service failures', async () => {
    calculateKeyDetailStats.mockRejectedValue(new Error('secret backend detail'))
    const res = createResponse()

    await handler({ params: { keyId: 'key-1' } }, res)

    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({
      success: false,
      error: 'Failed to calculate API key detail stats'
    })
    expect(JSON.stringify(res.body)).not.toContain('secret backend detail')
    expect(logger.error).toHaveBeenCalled()
  })
})
