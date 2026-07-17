jest.mock('axios', () => ({ get: jest.fn() }))

jest.mock('../src/services/scheduler/unifiedOpenAIScheduler', () => ({
  selectAccountForApiKey: jest.fn()
}))

jest.mock('../src/services/account/openaiAccountService', () => ({
  getAccount: jest.fn(),
  isTokenExpired: jest.fn(() => false),
  refreshAccountToken: jest.fn(),
  decrypt: jest.fn(() => 'access-token')
}))

jest.mock('../src/utils/proxyHelper', () => ({
  createProxyAgent: jest.fn(() => null)
}))

jest.mock('../src/utils/openaiNicSelector', () => ({
  chooseLocalAddress: jest.fn()
}))

jest.mock('../src/utils/performanceOptimizer', () => ({
  getHttpsAgentForLocalAddress: jest.fn()
}))

jest.mock('../src/utils/logger', () => ({
  warn: jest.fn()
}))

jest.mock('../src/utils/logSanitizer', () => ({
  summarizeErrorForLog: jest.fn((error) => ({ message: error.message }))
}))

const axios = require('axios')
const scheduler = require('../src/services/scheduler/unifiedOpenAIScheduler')
const openaiAccountService = require('../src/services/account/openaiAccountService')
const service = require('../src/services/openaiCodexModelsService')

function request({ query = {}, headers = {} } = {}) {
  return {
    query,
    headers,
    apiKey: { id: 'key-1', name: 'Key', openaiAccountId: '' }
  }
}

function setupAccount(id = 'account-1') {
  scheduler.selectAccountForApiKey.mockResolvedValue({
    accountId: id,
    accountType: 'openai'
  })
  openaiAccountService.getAccount.mockResolvedValue({
    id,
    name: id,
    accessToken: 'encrypted',
    accountId: `chatgpt-${id}`,
    accountType: 'shared',
    isActive: true
  })
}

describe('openaiCodexModelsService', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    service.resetForTest()
    setupAccount()
  })

  test('uses the default client version and does not touch lastUsedAt', async () => {
    axios.get.mockResolvedValue({
      status: 200,
      headers: { etag: '"models-1"' },
      data: Buffer.from('{"models":[{"slug":"gpt-5.6-sol","use_responses_lite":true}]}')
    })

    const result = await service.getManifest(request())

    expect(result.status).toBe(200)
    expect(result.body.models[0].slug).toBe('gpt-5.6-sol')
    expect(scheduler.selectAccountForApiKey).toHaveBeenCalledWith(expect.any(Object), null, null, {
      allowedAccountTypes: ['openai'],
      touchLastUsed: false,
      excludedAccountIds: []
    })
    expect(axios.get).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/codex/models',
      expect.objectContaining({
        params: { client_version: service.CODEX_MODELS_DEFAULT_CLIENT_VERSION }
      })
    )
  })

  test('does not forward a downstream ETag on a cold miss and serves local 304 later', async () => {
    axios.get.mockResolvedValue({
      status: 200,
      headers: { etag: '"models-1"' },
      data: Buffer.from('{"models":[]}')
    })

    await service.getManifest(request({ headers: { 'if-none-match': '"models-1"' } }))
    const upstreamHeaders = axios.get.mock.calls[0][1].headers
    expect(upstreamHeaders['if-none-match']).toBeUndefined()

    const second = await service.getManifest(
      request({ headers: { 'if-none-match': '"models-1"' } })
    )
    expect(second.status).toBe(304)
    expect(axios.get).toHaveBeenCalledTimes(1)
  })

  test('rejects invalid client versions before scheduling', async () => {
    await expect(
      service.getManifest(request({ query: { client_version: 'latest' } }))
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'invalid_client_version'
    })
    expect(scheduler.selectAccountForApiKey).not.toHaveBeenCalled()
  })

  test('excludes a failed shared account and selects another account', async () => {
    scheduler.selectAccountForApiKey
      .mockResolvedValueOnce({ accountId: 'account-1', accountType: 'openai' })
      .mockResolvedValueOnce({ accountId: 'account-2', accountType: 'openai' })
    openaiAccountService.getAccount.mockImplementation(async (id) => ({
      id,
      name: id,
      accessToken: 'encrypted',
      accountId: `chatgpt-${id}`,
      accountType: 'shared',
      isActive: true
    }))
    axios.get
      .mockResolvedValueOnce({
        status: 500,
        headers: {},
        data: Buffer.from('{"error":{"message":"overloaded"}}')
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        data: Buffer.from('{"models":[{"slug":"gpt-5.6-terra"}]}')
      })

    const result = await service.getManifest(request())

    expect(result.body.models[0].slug).toBe('gpt-5.6-terra')
    expect(scheduler.selectAccountForApiKey.mock.calls[1][3].excludedAccountIds).toEqual([
      'account-1'
    ])
  })

  test('excludes an account when its token refresh fails', async () => {
    scheduler.selectAccountForApiKey
      .mockResolvedValueOnce({ accountId: 'account-1', accountType: 'openai' })
      .mockResolvedValueOnce({ accountId: 'account-2', accountType: 'openai' })
    openaiAccountService.getAccount.mockImplementation(async (id) => ({
      id,
      name: id,
      accessToken: 'encrypted',
      accountId: `chatgpt-${id}`,
      accountType: 'shared',
      isActive: true
    }))
    openaiAccountService.isTokenExpired.mockImplementation((account) => account.id === 'account-1')
    openaiAccountService.refreshAccountToken.mockRejectedValueOnce(new Error('refresh failed'))
    axios.get.mockResolvedValue({
      status: 200,
      headers: {},
      data: Buffer.from('{"models":[{"slug":"gpt-5.6-luna"}]}')
    })

    const result = await service.getManifest(request())

    expect(result.body.models[0].slug).toBe('gpt-5.6-luna')
    expect(scheduler.selectAccountForApiKey.mock.calls[1][3].excludedAccountIds).toEqual([
      'account-1'
    ])
  })
})
