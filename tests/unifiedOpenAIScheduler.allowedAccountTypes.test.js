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
})
