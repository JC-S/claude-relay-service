const mockStore = new Map()

jest.mock('../src/models/redis', () => ({
  getClaudeAccount: jest.fn(async (id) => mockStore.get(id) || {}),
  setClaudeAccount: jest.fn(async (id, data) => mockStore.set(id, { ...data })),
  client: { hdel: jest.fn(async () => 1) }
}))

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))
jest.mock('../src/services/tokenRefreshService', () => ({}))
jest.mock('../src/utils/tokenRefreshLogger', () => ({}))
jest.mock('../src/utils/webhookNotifier', () => ({ sendAccountAnomalyNotification: jest.fn() }))
jest.mock('../src/utils/upstreamErrorHelper', () => ({
  recordErrorHistory: jest.fn(() => Promise.resolve()),
  markTempUnavailable: jest.fn(() => Promise.resolve()),
  parseRetryAfter: jest.fn(() => null)
}))
jest.mock('../src/utils/proxyHelper', () => ({}))
jest.mock('axios', () => ({}))

const claudeAccountService = require('../src/services/account/claudeAccountService')

const ACCOUNT_ID = 'acct-model-test'
const futureTimestamp = () => Math.floor((Date.now() + 3 * 24 * 60 * 60 * 1000) / 1000)

describe('Claude model-family rate-limit buckets', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockStore.clear()
    mockStore.set(ACCOUNT_ID, {
      id: ACCOUNT_ID,
      name: 'test-account',
      isActive: 'true',
      status: 'active',
      schedulable: 'true'
    })
  })

  test.each(['opus', 'sonnet', 'haiku', 'fable'])(
    'records only the %s family bucket',
    async (family) => {
      await claudeAccountService.markAccountModelRateLimited(ACCOUNT_ID, family, futureTimestamp())

      const stored = mockStore.get(ACCOUNT_ID)
      expect(stored[`${family}RateLimitedAt`]).toBeTruthy()
      expect(stored[`${family}RateLimitEndAt`]).toBeTruthy()
      expect(stored.schedulable).toBe('true')
      expect(stored.rateLimitStatus).toBeUndefined()
      expect(stored.rateLimitAutoStopped).toBeUndefined()
    }
  )

  test('a Sonnet limit does not affect Opus or the account-wide bucket', async () => {
    await claudeAccountService.markAccountModelRateLimited(ACCOUNT_ID, 'sonnet', futureTimestamp())

    expect(await claudeAccountService.isAccountModelRateLimited(ACCOUNT_ID, 'sonnet')).toBe(true)
    expect(await claudeAccountService.isAccountModelRateLimited(ACCOUNT_ID, 'opus')).toBe(false)
    expect(await claudeAccountService.isAccountRateLimited(ACCOUNT_ID)).toBe(false)
  })

  test.each(['sonnet', 'haiku'])('clears an expired %s bucket', async (family) => {
    const expiredTimestamp = Math.floor((Date.now() - 60 * 1000) / 1000)
    await claudeAccountService.markAccountModelRateLimited(ACCOUNT_ID, family, expiredTimestamp)

    expect(await claudeAccountService.isAccountModelRateLimited(ACCOUNT_ID, family)).toBe(false)
    expect(mockStore.get(ACCOUNT_ID)[`${family}RateLimitEndAt`]).toBeUndefined()
  })

  test('keeps Opus and Fable compatibility wrappers on their original Redis fields', async () => {
    await claudeAccountService.markAccountOpusRateLimited(ACCOUNT_ID, futureTimestamp())
    await claudeAccountService.markAccountFableRateLimited(ACCOUNT_ID, futureTimestamp())

    const stored = mockStore.get(ACCOUNT_ID)
    expect(stored.opusRateLimitEndAt).toBeTruthy()
    expect(stored.fableRateLimitEndAt).toBeTruthy()
    expect(await claudeAccountService.isAccountOpusRateLimited(ACCOUNT_ID)).toBe(true)
    expect(await claudeAccountService.isAccountFableRateLimited(ACCOUNT_ID)).toBe(true)
  })
})
