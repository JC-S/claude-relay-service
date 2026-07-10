const mockConfig = { claude: { dedicatedAccountFallback: true } }

jest.mock('../config/config', () => mockConfig)
jest.mock('../src/services/account/claudeAccountService', () => ({
  isAccountRateLimited: jest.fn(),
  getAccountRateLimitInfo: jest.fn(),
  isAccountModelRateLimited: jest.fn(),
  getAccountModelRateLimitInfo: jest.fn(),
  clearExpiredModelRateLimit: jest.fn(),
  isAccountOverloaded: jest.fn()
}))
jest.mock('../src/services/account/claudeConsoleAccountService', () => ({
  getAllAccounts: jest.fn(),
  getAccount: jest.fn()
}))
jest.mock('../src/services/account/bedrockAccountService', () => ({
  getAllAccounts: jest.fn()
}))
jest.mock('../src/services/account/ccrAccountService', () => ({}))
jest.mock('../src/services/accountGroupService', () => ({
  getGroup: jest.fn(),
  getGroupMembers: jest.fn()
}))
jest.mock('../src/models/redis', () => ({
  getClaudeAccount: jest.fn(),
  getAllClaudeAccounts: jest.fn()
}))
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))
jest.mock('../src/utils/commonHelper', () => ({
  isSchedulable: jest.fn((value) => value !== false && value !== 'false'),
  sortAccountsByPriority: jest.fn((accounts) => accounts)
}))
jest.mock('../src/utils/upstreamErrorHelper', () => ({}))

const claudeAccountService = require('../src/services/account/claudeAccountService')
const claudeConsoleAccountService = require('../src/services/account/claudeConsoleAccountService')
const bedrockAccountService = require('../src/services/account/bedrockAccountService')
const accountGroupService = require('../src/services/accountGroupService')
const redis = require('../src/models/redis')
const scheduler = require('../src/services/scheduler/unifiedClaudeScheduler')

const BOUND_ID = 'acct-bound'
const apiKeyData = { id: 'key-1', name: 'key', claudeAccountId: BOUND_ID }
const healthyAccount = {
  id: BOUND_ID,
  name: 'bound',
  isActive: 'true',
  status: 'active',
  schedulable: 'true'
}

describe('dedicated Claude account fallback policy', () => {
  let tempUnavailableSpy

  beforeEach(() => {
    jest.clearAllMocks()
    mockConfig.claude = { dedicatedAccountFallback: true }
    redis.getClaudeAccount.mockResolvedValue(healthyAccount)
    claudeAccountService.isAccountRateLimited.mockResolvedValue(false)
    claudeAccountService.isAccountModelRateLimited.mockResolvedValue(false)
    claudeAccountService.clearExpiredModelRateLimit.mockResolvedValue({ success: true })
    claudeAccountService.getAccountRateLimitInfo.mockResolvedValue({ rateLimitEndAt: null })
    claudeAccountService.getAccountModelRateLimitInfo.mockResolvedValue({ resetAt: null })
    claudeAccountService.isAccountOverloaded.mockResolvedValue(false)
    redis.getAllClaudeAccounts.mockResolvedValue([])
    claudeConsoleAccountService.getAllAccounts.mockResolvedValue([])
    claudeConsoleAccountService.getAccount.mockResolvedValue(null)
    bedrockAccountService.getAllAccounts.mockResolvedValue({ success: true, data: [] })
    tempUnavailableSpy = jest
      .spyOn(scheduler, 'isAccountTemporarilyUnavailable')
      .mockResolvedValue(false)
  })

  afterEach(() => {
    tempUnavailableSpy.mockRestore()
  })

  test('uses a healthy bound account', async () => {
    await expect(
      scheduler.selectAccountForApiKey(apiKeyData, null, 'claude-opus-4-8')
    ).resolves.toEqual({ accountId: BOUND_ID, accountType: 'claude-official' })
  })

  test('never falls back when the requested model family is limited', async () => {
    claudeAccountService.isAccountModelRateLimited.mockResolvedValue(true)
    claudeAccountService.getAccountModelRateLimitInfo.mockResolvedValue({ resetAt: 'soon' })

    await expect(
      scheduler.selectAccountForApiKey(apiKeyData, null, 'claude-sonnet-4-6')
    ).rejects.toMatchObject({
      code: 'CLAUDE_DEDICATED_RATE_LIMITED',
      accountId: BOUND_ID,
      modelFamily: 'sonnet'
    })
  })

  test('keeps the existing shared-pool fallback for a temporarily unavailable account', async () => {
    tempUnavailableSpy.mockResolvedValue(true)
    const poolSpy = jest.spyOn(scheduler, '_getAllAvailableAccounts').mockResolvedValue([
      {
        id: 'shared-1',
        accountId: 'shared-1',
        accountType: 'claude-official',
        name: 'shared',
        priority: 50
      }
    ])

    await expect(
      scheduler.selectAccountForApiKey(apiKeyData, null, 'claude-sonnet-4-6')
    ).resolves.toEqual({ accountId: 'shared-1', accountType: 'claude-official' })
    expect(poolSpy).toHaveBeenCalled()
    poolSpy.mockRestore()
  })

  test('strict mode rejects a temporarily unavailable bound account with 503 semantics', async () => {
    mockConfig.claude = { dedicatedAccountFallback: false }
    tempUnavailableSpy.mockResolvedValue(true)

    await expect(
      scheduler.selectAccountForApiKey(apiKeyData, null, 'claude-sonnet-4-6')
    ).rejects.toMatchObject({
      code: 'CLAUDE_DEDICATED_UNAVAILABLE',
      reason: 'temporarily_unavailable'
    })
  })

  test('strict mode rejects an inactive bound account', async () => {
    mockConfig.claude = { dedicatedAccountFallback: false }
    redis.getClaudeAccount.mockResolvedValue({ ...healthyAccount, isActive: 'false' })

    await expect(
      scheduler.selectAccountForApiKey(apiKeyData, null, 'claude-sonnet-4-6')
    ).rejects.toMatchObject({
      code: 'CLAUDE_DEDICATED_UNAVAILABLE',
      reason: 'inactive_or_error'
    })
  })

  test('account-wide rate limits remain explicit instead of silently falling back', async () => {
    claudeAccountService.isAccountRateLimited.mockResolvedValue(true)
    claudeAccountService.getAccountRateLimitInfo.mockResolvedValue({
      rateLimitEndAt: '2026-07-11T00:00:00.000Z'
    })
    tempUnavailableSpy.mockResolvedValue(true)

    await expect(
      scheduler.selectAccountForApiKey(apiKeyData, null, 'claude-sonnet-4-6')
    ).rejects.toMatchObject({
      code: 'CLAUDE_DEDICATED_RATE_LIMITED',
      accountId: BOUND_ID
    })
  })

  test('shared-pool selection skips only the account limited for the requested family', async () => {
    redis.getAllClaudeAccounts.mockResolvedValue([
      { ...healthyAccount, id: 'sonnet-limited', name: 'limited', accountType: 'shared' },
      { ...healthyAccount, id: 'healthy-shared', name: 'healthy', accountType: 'shared' }
    ])
    claudeAccountService.isAccountModelRateLimited.mockImplementation(
      async (accountId, family) => accountId === 'sonnet-limited' && family === 'sonnet'
    )

    const accounts = await scheduler._getAllAvailableAccounts({}, 'claude-sonnet-4-6')

    expect(accounts.map((account) => account.accountId)).toEqual(['healthy-shared'])
  })

  test('sticky-session availability rejects an account limited for the requested family', async () => {
    redis.getClaudeAccount.mockResolvedValue(healthyAccount)
    claudeAccountService.isAccountModelRateLimited.mockResolvedValue(true)

    await expect(
      scheduler._isAccountAvailable(BOUND_ID, 'claude-official', 'claude-sonnet-4-6')
    ).resolves.toBe(false)
  })

  test('group selection skips a member limited for the requested family', async () => {
    accountGroupService.getGroup.mockResolvedValue({
      id: 'group-1',
      name: 'group',
      platform: 'claude'
    })
    accountGroupService.getGroupMembers.mockResolvedValue(['sonnet-limited', 'healthy-group'])
    redis.getClaudeAccount.mockImplementation(async (accountId) => ({
      ...healthyAccount,
      id: accountId,
      name: accountId,
      accountType: 'shared'
    }))
    claudeAccountService.isAccountModelRateLimited.mockImplementation(
      async (accountId, family) => accountId === 'sonnet-limited' && family === 'sonnet'
    )

    await expect(
      scheduler.selectAccountFromGroup('group-1', null, 'claude-sonnet-4-6')
    ).resolves.toEqual({ accountId: 'healthy-group', accountType: 'claude-official' })
  })
})
