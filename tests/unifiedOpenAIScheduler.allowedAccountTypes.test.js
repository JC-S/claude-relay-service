jest.mock('../src/services/account/openaiAccountService', () => ({
  getAccount: jest.fn(),
  getAllAccounts: jest.fn(),
  isTokenExpired: jest.fn(() => false),
  refreshAccountToken: jest.fn(),
  recordUsage: jest.fn()
}))

jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  getAccount: jest.fn(),
  getAllAccounts: jest.fn(),
  checkAndClearRateLimit: jest.fn(),
  isSubscriptionExpired: jest.fn(() => false),
  markAccountRateLimited: jest.fn(),
  updateAccount: jest.fn(),
  recordUsage: jest.fn()
}))

jest.mock('../src/services/accountGroupService', () => ({
  getGroup: jest.fn(),
  getGroupMembers: jest.fn()
}))

jest.mock('../src/models/redis', () => ({
  getClientSafe: jest.fn(() => ({
    get: jest.fn(),
    setex: jest.fn(),
    del: jest.fn(),
    ttl: jest.fn()
  }))
}))

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}))

jest.mock('../src/utils/commonHelper', () => ({
  isSchedulable: jest.fn((value) => value === undefined || value === true || value === 'true'),
  sortAccountsByPriority: jest.fn((accounts) => accounts)
}))

jest.mock('../src/utils/upstreamErrorHelper', () => ({
  isTempUnavailable: jest.fn(() => false)
}))

const openaiAccountService = require('../src/services/account/openaiAccountService')
const openaiResponsesAccountService = require('../src/services/account/openaiResponsesAccountService')
const scheduler = require('../src/services/scheduler/unifiedOpenAIScheduler')

describe('unifiedOpenAIScheduler allowed account types', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('rejects dedicated OpenAI-Responses accounts when only OpenAI OAuth is allowed', async () => {
    openaiResponsesAccountService.getAccount.mockResolvedValue({
      id: 'resp-1',
      name: 'Responses Account',
      isActive: 'true',
      status: 'active',
      schedulable: 'true'
    })

    await expect(
      scheduler.selectAccountForApiKey(
        { name: 'Key', openaiAccountId: 'responses:resp-1' },
        null,
        'gpt-5',
        { allowedAccountTypes: ['openai'] }
      )
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'account_type_not_allowed'
    })
  })

  test('filters shared OpenAI-Responses accounts when only OpenAI OAuth is allowed', async () => {
    const openaiAccount = {
      id: 'openai-1',
      name: 'OpenAI Account',
      isActive: true,
      status: 'active',
      accountType: 'shared',
      schedulable: 'true'
    }
    openaiAccountService.getAllAccounts.mockResolvedValue([openaiAccount])
    openaiAccountService.getAccount.mockResolvedValue(openaiAccount)

    const result = await scheduler.selectAccountForApiKey(
      { name: 'Key', openaiAccountId: '' },
      null,
      'gpt-5',
      { allowedAccountTypes: ['openai'] }
    )

    expect(result).toEqual({
      accountId: 'openai-1',
      accountType: 'openai'
    })
    expect(openaiResponsesAccountService.getAllAccounts).not.toHaveBeenCalled()
  })

  test('does not touch lastUsedAt when touchLastUsed is false', async () => {
    const openaiAccount = {
      id: 'openai-1',
      name: 'OpenAI Account',
      isActive: true,
      status: 'active',
      accountType: 'shared',
      schedulable: 'true'
    }
    openaiAccountService.getAllAccounts.mockResolvedValue([openaiAccount])

    await scheduler.selectAccountForApiKey({ name: 'Key', openaiAccountId: '' }, null, null, {
      allowedAccountTypes: ['openai'],
      touchLastUsed: false
    })

    expect(openaiAccountService.recordUsage).not.toHaveBeenCalled()
  })

  test('excludes failed shared accounts and selects the next candidate', async () => {
    const accounts = [
      {
        id: 'openai-1',
        name: 'First',
        isActive: true,
        status: 'active',
        accountType: 'shared',
        schedulable: 'true'
      },
      {
        id: 'openai-2',
        name: 'Second',
        isActive: true,
        status: 'active',
        accountType: 'shared',
        schedulable: 'true'
      }
    ]
    openaiAccountService.getAllAccounts.mockResolvedValue(accounts)

    const result = await scheduler.selectAccountForApiKey(
      { name: 'Key', openaiAccountId: '' },
      null,
      null,
      { allowedAccountTypes: ['openai'], excludedAccountIds: ['openai-1'] }
    )

    expect(result).toEqual({ accountId: 'openai-2', accountType: 'openai' })
  })

  test('does not fall back to shared pool when an excluded dedicated account is bound', async () => {
    openaiAccountService.getAccount.mockResolvedValue({
      id: 'dedicated-1',
      name: 'Dedicated',
      isActive: 'true',
      status: 'active',
      schedulable: 'true'
    })
    openaiAccountService.getAllAccounts.mockResolvedValue([
      {
        id: 'shared-1',
        name: 'Shared',
        isActive: true,
        status: 'active',
        accountType: 'shared',
        schedulable: 'true'
      }
    ])

    await expect(
      scheduler.selectAccountForApiKey(
        { name: 'Key', openaiAccountId: 'dedicated-1' },
        null,
        null,
        { allowedAccountTypes: ['openai'], excludedAccountIds: ['dedicated-1'] }
      )
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'dedicated_account_excluded'
    })
    expect(openaiAccountService.getAllAccounts).not.toHaveBeenCalled()
  })
})

describe('unifiedOpenAIScheduler OpenAI Responses auto protection', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('does not force-disable scheduling when auto protection is disabled', async () => {
    openaiResponsesAccountService.getAccount.mockResolvedValue({
      id: 'resp-1',
      disableAutoProtection: 'true'
    })

    await scheduler.markAccountRateLimited('resp-1', 'openai-responses', null, 120)

    expect(openaiResponsesAccountService.markAccountRateLimited).toHaveBeenCalledWith('resp-1', 2)
    expect(openaiResponsesAccountService.updateAccount).not.toHaveBeenCalled()
  })

  test('keeps force-disabling scheduling when auto protection is enabled', async () => {
    openaiResponsesAccountService.getAccount.mockResolvedValue({
      id: 'resp-1',
      disableAutoProtection: 'false'
    })

    await scheduler.markAccountRateLimited('resp-1', 'openai-responses', null, 120)

    expect(openaiResponsesAccountService.markAccountRateLimited).toHaveBeenCalledWith('resp-1', 2)
    expect(openaiResponsesAccountService.updateAccount).toHaveBeenCalledWith(
      'resp-1',
      expect.objectContaining({
        schedulable: 'false'
      })
    )
  })
})
