jest.mock('../src/services/apiKeyService', () => ({
  validateApiKey: jest.fn()
}))

jest.mock('../src/services/userService', () => ({}))

const mockRedisClient = {
  get: jest.fn(),
  set: jest.fn(),
  incr: jest.fn()
}

jest.mock('../src/models/redis', () => ({
  client: {
    get: jest.fn()
  },
  getClient: jest.fn(() => mockRedisClient),
  getNextResetTime: jest.fn(() => new Date('2026-01-12T00:00:00.000Z'))
}))

jest.mock('../src/services/claudeRelayConfigService', () => ({
  isClaudeCodeOnlyEnabled: jest.fn().mockResolvedValue(false)
}))

jest.mock('../src/utils/logger', () => ({
  api: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  security: jest.fn(),
  warn: jest.fn()
}))

const apiKeyService = require('../src/services/apiKeyService')
const { authenticateApiKey } = require('../src/middleware/auth')

const NOW = Date.parse('2026-01-10T00:00:00.000Z')
const WINDOW_START = NOW - 30 * 60 * 1000

function createReq(model = 'claude-sonnet-4-5') {
  return {
    ip: '127.0.0.1',
    path: '/test',
    originalUrl: '/test',
    headers: { 'x-api-key': 'cr_test_key_123456' },
    body: {
      model,
      messages: [{ role: 'user', content: 'test' }]
    },
    connection: { remoteAddress: '127.0.0.1' }
  }
}

function createRes() {
  const res = {
    statusCode: 200,
    body: null,
    status: jest.fn((statusCode) => {
      res.statusCode = statusCode
      return res
    }),
    json: jest.fn((body) => {
      res.body = body
      return res
    })
  }
  return res
}

function mockKey(overrides = {}) {
  apiKeyService.validateApiKey.mockResolvedValue({
    valid: true,
    keyData: {
      id: 'key_1',
      name: 'English response contract',
      enableIpWhitelist: false,
      enableClientRestriction: false,
      concurrencyLimit: 0,
      rateLimitWindow: 0,
      rateLimitRequests: 0,
      rateLimitCost: 0,
      tokenLimit: 0,
      dailyCostLimit: 0,
      totalCostLimit: 0,
      weeklyOpusCostLimit: 0,
      weeklyFableCostLimit: 0,
      permissions: ['claude'],
      ...overrides
    }
  })
}

function mockWindowCounters({ requests = 0, tokens = 0, cost = 0 }) {
  mockRedisClient.get.mockImplementation(async (key) => {
    if (key.includes('window_start')) return String(WINDOW_START)
    if (key.includes('requests')) return String(requests)
    if (key.includes('tokens')) return String(tokens)
    if (key.includes('cost')) return String(cost)
    return null
  })
}

async function authenticate({ overrides, model, counters }) {
  mockKey(overrides)
  if (counters) mockWindowCounters(counters)

  const req = createReq(model)
  const res = createRes()
  const next = jest.fn()
  await authenticateApiKey(req, res, next)
  return { req, res, next }
}

function expectEnglish(message) {
  expect(message).not.toMatch(/\p{Script=Han}/u)
}

describe('authenticateApiKey user-facing English messages', () => {
  let dateNowSpy

  beforeEach(() => {
    jest.clearAllMocks()
    dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW)
  })

  afterEach(() => {
    dateNowSpy.mockRestore()
  })

  test.each([
    {
      name: 'request window limit',
      overrides: { rateLimitWindow: 60, rateLimitRequests: 20 },
      counters: { requests: 20 },
      message: 'Request limit reached (20 requests). The limit resets in 30 minutes.',
      fields: { currentRequests: 20, requestLimit: 20 }
    },
    {
      name: 'token window limit',
      overrides: { rateLimitWindow: 60, tokenLimit: 5000 },
      counters: { tokens: 5000 },
      message: 'Token usage limit reached (5000 tokens). The limit resets in 30 minutes.',
      fields: { currentTokens: 5000, tokenLimit: 5000 }
    },
    {
      name: 'cost window limit',
      overrides: { rateLimitWindow: 60, rateLimitCost: 12.5 },
      counters: { cost: 12.5 },
      message: 'Cost limit reached ($12.5). The limit resets in 30 minutes.',
      fields: { currentCost: 12.5, costLimit: 12.5 }
    }
  ])('keeps the 429 contract for $name', async ({ overrides, counters, message, fields }) => {
    const { res, next } = await authenticate({ overrides, counters })

    expect(res.statusCode).toBe(429)
    expect(res.body).toEqual(
      expect.objectContaining({
        error: 'Rate limit exceeded',
        message,
        remainingMinutes: 30,
        resetAt: new Date(WINDOW_START + 60 * 60 * 1000).toISOString(),
        ...fields
      })
    )
    expect(res.body).not.toHaveProperty('code')
    expectEnglish(res.body.message)
    expect(next).not.toHaveBeenCalled()
  })

  test.each([
    {
      name: 'daily cost limit',
      overrides: { dailyCostLimit: 10, dailyCost: 10 },
      code: 'daily_cost_limit_exceeded',
      message: 'Daily cost limit reached ($10).',
      currentCost: 10,
      costLimit: 10,
      hasResetAt: true
    },
    {
      name: 'total cost limit',
      overrides: { totalCostLimit: 100, totalCost: 100 },
      code: 'total_cost_limit_exceeded',
      message: 'Total cost limit reached ($100).',
      currentCost: 100,
      costLimit: 100,
      hasResetAt: false
    },
    {
      name: 'v2 parent budget',
      overrides: {
        parentKeyId: 'parent_1',
        v2TotalBudget: 200,
        v2ParentTotalCost: 200
      },
      code: 'account_total_budget_exhausted',
      message: 'Account total budget exhausted ($200).',
      currentCost: 200,
      costLimit: 200,
      hasResetAt: false
    },
    {
      name: 'Claude weekly cost limit',
      overrides: { weeklyOpusCostLimit: 30, weeklyOpusCost: 30 },
      model: 'claude-opus-4-7',
      code: 'weekly_opus_cost_limit_exceeded',
      message: 'Claude weekly cost limit reached ($30).',
      currentCost: 30,
      costLimit: 30,
      hasResetAt: true
    },
    {
      name: 'Claude Fable weekly cost limit',
      overrides: { weeklyFableCostLimit: 40, weeklyFableCost: 40 },
      model: 'claude-fable-5',
      code: 'weekly_fable_cost_limit_exceeded',
      message: 'Claude Fable weekly cost limit reached ($40).',
      currentCost: 40,
      costLimit: 40,
      hasResetAt: true
    }
  ])(
    'keeps the 402 contract for $name',
    async ({ overrides, model, code, message, currentCost, costLimit, hasResetAt }) => {
      const { res, next } = await authenticate({ overrides, model })

      expect(res.statusCode).toBe(402)
      expect(res.body.error).toEqual({
        type: 'insufficient_quota',
        message,
        code
      })
      expect(res.body.currentCost).toBe(currentCost)
      expect(res.body.costLimit).toBe(costLimit)
      expect(Object.prototype.hasOwnProperty.call(res.body, 'resetAt')).toBe(hasResetAt)
      expectEnglish(res.body.error.message)
      expect(next).not.toHaveBeenCalled()
    }
  )
})
