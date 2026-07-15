jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }))
jest.mock('../src/services/account/grokAccountService', () => ({
  getAccount: jest.fn(),
  getSafeAccount: jest.fn(),
  getValidAccessToken: jest.fn(),
  updateRateLimitSnapshot: jest.fn(),
  updateBillingSnapshot: jest.fn()
}))
jest.mock('../src/utils/proxyHelper', () => ({ createProxyAgent: jest.fn(() => null) }))

const axios = require('axios')
const grokAccountService = require('../src/services/account/grokAccountService')
const grokQuotaService = require('../src/services/grokQuotaService')

describe('grokQuotaService', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers().setSystemTime(new Date('2026-07-14T08:00:00.000Z'))
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test('throttles a non-critical passive snapshot observed within 60 seconds', async () => {
    grokAccountService.getSafeAccount.mockResolvedValue({
      rateLimitSnapshot: {
        observedAt: '2026-07-14T07:59:30.000Z',
        tokens: { limit: 1000, remaining: 900, resetAt: null },
        headers: { 'x-ratelimit-limit-tokens': '1000' }
      }
    })
    const snapshot = await grokQuotaService.observeResponse(
      'account',
      {
        'x-ratelimit-limit-requests': '100',
        'x-ratelimit-remaining-requests': '90'
      },
      200
    )
    expect(snapshot.tokens).toEqual({ limit: 1000, remaining: 900, resetAt: null })
    expect(snapshot.requests).toEqual({ limit: 100, remaining: 90, resetAt: null })
    expect(grokAccountService.updateRateLimitSnapshot).not.toHaveBeenCalled()
  })

  test('persists a 429 snapshot immediately even inside the throttle window', async () => {
    grokAccountService.getSafeAccount.mockResolvedValue({
      rateLimitSnapshot: { observedAt: '2026-07-14T07:59:59.000Z' }
    })
    const snapshot = await grokQuotaService.observeResponse(
      'account',
      { 'retry-after': '120' },
      429
    )
    expect(snapshot.retryAfterSeconds).toBe(120)
    expect(grokAccountService.updateRateLimitSnapshot).toHaveBeenCalledWith('account', snapshot)
  })

  test('reports the failing upstream status when the other billing payload is unusable', async () => {
    grokAccountService.getAccount.mockResolvedValue({
      id: 'account',
      authType: 'oauth',
      proxy: null,
      billingSnapshot: null
    })
    grokAccountService.getValidAccessToken.mockResolvedValue('access-token')
    axios.get
      .mockResolvedValueOnce({ status: 200, data: { config: {} } })
      .mockResolvedValueOnce({ status: 503, data: { error: 'unavailable' } })

    await expect(grokQuotaService.queryBilling('account')).rejects.toMatchObject({
      statusCode: 503
    })
  })
})
