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
  _resolveAccountByUsageRecord: jest.fn(),
  updateApiKey: jest.fn()
}))

jest.mock('../src/models/redis', () => ({
  getUsageRecords: jest.fn(),
  getClientSafe: jest.fn()
}))

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
const redis = require('../src/models/redis')
const logger = require('../src/utils/logger')

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

function findBatchLastUsageHandler() {
  const route = mockRouter.post.mock.calls.find((call) => call[0] === '/api-keys/batch-last-usage')
  return route?.[2]
}

function findUpdateApiKeyHandler() {
  const route = mockRouter.put.mock.calls.find((call) => call[0] === '/api-keys/:keyId')
  return route?.[2]
}

describe('admin api keys route batch last-usage', () => {
  const redisClient = { connected: true }

  beforeEach(() => {
    redis.getUsageRecords.mockReset()
    redis.getClientSafe.mockReset()
    redis.getClientSafe.mockReturnValue(redisClient)
    logger.debug.mockReset()
    apiKeyService._resolveAccountByUsageRecord.mockReset()
    apiKeyService._resolveAccountByUsageRecord.mockImplementation(async (record) => ({
      accountId: `resolved-${record.accountId}`,
      accountType: record.accountType || 'claude',
      accountCategory: 'claude',
      accountName: record.accountName || `Account ${record.accountId}`
    }))
  })

  test('keeps old request body behavior by reading the latest usage record', async () => {
    const latestRecord = {
      timestamp: '2026-06-14T10:00:00.000Z',
      accountId: 'acc-latest',
      accountType: 'claude'
    }
    redis.getUsageRecords.mockResolvedValue([latestRecord])

    const handler = findBatchLastUsageHandler()
    const res = createResponse()

    await handler({ body: { keyIds: ['k1'] } }, res)

    expect(redis.getUsageRecords).toHaveBeenCalledWith('k1', 1)
    expect(apiKeyService._resolveAccountByUsageRecord).toHaveBeenCalledWith(
      latestRecord,
      expect.any(Map),
      redisClient
    )
    expect(res.status).not.toHaveBeenCalled()
    expect(res.body).toEqual({
      success: true,
      data: {
        k1: {
          accountId: 'resolved-acc-latest',
          rawAccountId: 'acc-latest',
          accountType: 'claude',
          accountCategory: 'claude',
          accountName: 'Account acc-latest',
          recordedAt: '2026-06-14T10:00:00.000Z'
        }
      }
    })
  })

  test('uses the recent record matching expectedByKeyId timestamp', async () => {
    const latestRecord = {
      timestamp: '2026-06-14T10:05:00.000Z',
      accountId: 'acc-latest',
      accountType: 'claude'
    }
    const matchedRecord = {
      timestamp: '2026-06-14T10:00:00.300Z',
      accountId: 'acc-matched',
      accountType: 'claude'
    }
    redis.getUsageRecords.mockResolvedValue([latestRecord, matchedRecord])

    const handler = findBatchLastUsageHandler()
    const res = createResponse()

    await handler(
      {
        body: {
          keyIds: ['k1'],
          expectedByKeyId: { k1: '2026-06-14T10:00:00.000Z' }
        }
      },
      res
    )

    expect(redis.getUsageRecords).toHaveBeenCalledWith('k1', 20)
    expect(apiKeyService._resolveAccountByUsageRecord).toHaveBeenCalledWith(
      matchedRecord,
      expect.any(Map),
      redisClient
    )
    expect(res.body.data.k1.rawAccountId).toBe('acc-matched')
  })

  test('falls back to latest record when expected timestamp is out of tolerance', async () => {
    const latestRecord = {
      timestamp: '2026-06-14T10:05:00.000Z',
      accountId: 'acc-latest',
      accountType: 'claude'
    }
    const oldRecord = {
      timestamp: '2026-06-14T10:04:00.000Z',
      accountId: 'acc-old',
      accountType: 'claude'
    }
    redis.getUsageRecords.mockResolvedValue([latestRecord, oldRecord])

    const handler = findBatchLastUsageHandler()
    const res = createResponse()

    await handler(
      {
        body: {
          keyIds: ['k1'],
          expectedByKeyId: { k1: '2026-06-14T10:00:00.000Z' }
        }
      },
      res
    )

    expect(apiKeyService._resolveAccountByUsageRecord).toHaveBeenCalledWith(
      latestRecord,
      expect.any(Map),
      redisClient
    )
    expect(logger.debug).toHaveBeenCalledWith(
      'Batch last-usage expected timestamp did not match recent records:',
      expect.objectContaining({ keyId: 'k1', bestDiffMs: expect.any(Number) })
    )
    expect(res.body.data.k1.rawAccountId).toBe('acc-latest')
  })

  test('falls back to latest record for invalid expected timestamp', async () => {
    const latestRecord = {
      timestamp: '2026-06-14T10:05:00.000Z',
      accountId: 'acc-latest',
      accountType: 'claude'
    }
    redis.getUsageRecords.mockResolvedValue([latestRecord])

    const handler = findBatchLastUsageHandler()
    const res = createResponse()

    await handler(
      {
        body: {
          keyIds: ['k1'],
          expectedByKeyId: { k1: 'bad-date' }
        }
      },
      res
    )

    expect(redis.getUsageRecords).toHaveBeenCalledWith('k1', 20)
    expect(apiKeyService._resolveAccountByUsageRecord).toHaveBeenCalledWith(
      latestRecord,
      expect.any(Map),
      redisClient
    )
    expect(logger.debug).not.toHaveBeenCalledWith(
      'Batch last-usage expected timestamp did not match recent records:',
      expect.anything()
    )
    expect(res.body.data.k1.rawAccountId).toBe('acc-latest')
  })
})

describe('admin api keys route Anthropic cache TTL override', () => {
  beforeEach(() => {
    apiKeyService.updateApiKey.mockReset()
    apiKeyService.updateApiKey.mockResolvedValue({ success: true })
  })

  test('accepts strict booleans and forwards both fields', async () => {
    const handler = findUpdateApiKeyHandler()
    const res = createResponse()

    await handler(
      {
        params: { keyId: 'k1' },
        body: {
          anthropicCacheTtl1hOverrideEnabled: true,
          anthropicCacheTtl1hInjectionEnabled: false
        }
      },
      res
    )

    expect(apiKeyService.updateApiKey).toHaveBeenCalledWith('k1', {
      anthropicCacheTtl1hOverrideEnabled: true,
      anthropicCacheTtl1hInjectionEnabled: false
    })
    expect(res.statusCode).toBe(200)
  })

  test.each([
    ['anthropicCacheTtl1hOverrideEnabled', 'true'],
    ['anthropicCacheTtl1hOverrideEnabled', 1],
    ['anthropicCacheTtl1hOverrideEnabled', null],
    ['anthropicCacheTtl1hInjectionEnabled', 'false'],
    ['anthropicCacheTtl1hInjectionEnabled', 0],
    ['anthropicCacheTtl1hInjectionEnabled', null]
  ])('rejects non-boolean %s value %#', async (field, value) => {
    const handler = findUpdateApiKeyHandler()
    const res = createResponse()

    await handler({ params: { keyId: 'k1' }, body: { [field]: value } }, res)

    expect(res.statusCode).toBe(400)
    expect(res.body.error).toBe(`${field} must be a boolean`)
    expect(apiKeyService.updateApiKey).not.toHaveBeenCalled()
  })
})
