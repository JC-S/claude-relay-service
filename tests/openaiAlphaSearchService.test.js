const { EventEmitter } = require('events')

jest.mock(
  '../config/config',
  () => ({
    requestTimeout: 1000
  }),
  { virtual: true }
)

jest.mock('axios', () => ({ post: jest.fn() }))

jest.mock('../src/services/scheduler/unifiedOpenAIScheduler', () => ({
  selectAccountForApiKey: jest.fn(),
  markAccountRateLimited: jest.fn()
}))

jest.mock('../src/services/account/openaiAccountService', () => ({
  getAccount: jest.fn(),
  isTokenExpired: jest.fn(() => false),
  refreshAccountToken: jest.fn(),
  decrypt: jest.fn(() => 'access-token')
}))

jest.mock('../src/services/apiKeyService', () => ({
  recordFixedCostUsage: jest.fn()
}))

jest.mock('../src/services/requestDetailService', () => ({
  captureRequestDetail: jest.fn()
}))

jest.mock('../src/utils/proxyHelper', () => ({
  createProxyAgent: jest.fn(() => null)
}))

jest.mock('../src/utils/openaiNicSelector', () => ({
  chooseLocalAddress: jest.fn(),
  markCooldown: jest.fn(),
  clearBinding: jest.fn()
}))

jest.mock('../src/utils/performanceOptimizer', () => ({
  getHttpsAgentForLocalAddress: jest.fn((address) => ({ address }))
}))

jest.mock('../src/utils/rateLimitHelper', () => ({
  updateRateLimitCounters: jest.fn()
}))

jest.mock('../src/utils/requestDetailHelper', () => ({
  createRequestDetailMeta: jest.fn((_req, overrides) => overrides)
}))

jest.mock('../src/utils/errorSanitizer', () => ({
  getSafeMessage: jest.fn((error) => error?.message || String(error))
}))

jest.mock('../src/utils/logSanitizer', () => ({
  summarizeErrorForLog: jest.fn((error) => ({ message: error.message }))
}))

jest.mock('../src/utils/upstreamErrorHelper', () => ({
  recordErrorHistory: jest.fn()
}))

jest.mock('../src/utils/logger', () => ({
  error: jest.fn()
}))

const axios = require('axios')
const scheduler = require('../src/services/scheduler/unifiedOpenAIScheduler')
const openaiAccountService = require('../src/services/account/openaiAccountService')
const apiKeyService = require('../src/services/apiKeyService')
const requestDetailService = require('../src/services/requestDetailService')
const openaiNicSelector = require('../src/utils/openaiNicSelector')
const { updateRateLimitCounters } = require('../src/utils/rateLimitHelper')
const upstreamErrorHelper = require('../src/utils/upstreamErrorHelper')
const service = require('../src/services/openaiAlphaSearchService')

function createReq(body) {
  const req = new EventEmitter()
  Object.assign(req, {
    method: 'POST',
    originalUrl: '/openai/v1/alpha/search',
    headers: {
      version: '0.144.0',
      originator: 'codex-tui',
      'user-agent': 'codex-tui/0.144.0',
      'x-codex-turn-metadata': 'metadata'
    },
    body,
    apiKey: {
      id: 'key-1',
      name: 'Key',
      permissions: ['openai'],
      enableModelRestriction: false,
      restrictedModels: []
    },
    requestId: 'request-search-1',
    rateLimitInfo: { costCountKey: 'rate-cost' }
  })
  return req
}

function createRes(sequence = []) {
  const res = new EventEmitter()
  Object.assign(res, {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    status(code) {
      this.statusCode = code
      return this
    },
    setHeader(name, value) {
      this.headers ||= {}
      this.headers[name] = value
    },
    json(payload) {
      sequence.push('send')
      this.payload = payload
      this.headersSent = true
      this.writableEnded = true
      return this
    },
    send(payload) {
      sequence.push('send')
      this.payload = payload
      this.headersSent = true
      this.writableEnded = true
      return this
    }
  })
  return res
}

function setupAccount(overrides = {}) {
  scheduler.selectAccountForApiKey.mockResolvedValue({
    accountId: 'account-1',
    accountType: 'openai'
  })
  openaiAccountService.getAccount.mockResolvedValue({
    id: 'account-1',
    name: 'OpenAI',
    accessToken: 'encrypted',
    accountId: 'chatgpt-account-1',
    interleaveNicEnabled: false,
    ...overrides
  })
}

describe('openaiAlphaSearchService', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    setupAccount()
    apiKeyService.recordFixedCostUsage.mockResolvedValue({
      realCost: 0.01,
      ratedCost: 0.02,
      recorded: true
    })
  })

  test('validates the model locally', async () => {
    const res = createRes()
    await service.handle(createReq({}), res)

    expect(res.statusCode).toBe(400)
    expect(res.payload.error.code).toBe('model_required')
    expect(scheduler.selectAccountForApiKey).not.toHaveBeenCalled()
  })

  test('strips prompt-cache fields, bills before responding, and updates the cost window', async () => {
    const sequence = []
    apiKeyService.recordFixedCostUsage.mockImplementation(async () => {
      sequence.push('bill')
      return { realCost: 0.01, ratedCost: 0.02, recorded: true }
    })
    axios.post.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'application/json' },
      data: { results: [{ title: 'Result' }] }
    })
    const req = createReq({
      model: 'gpt-5.6-sol',
      id: 'search-1',
      prompt_cache_key: 'remove-me',
      prompt_cache_retention: '24h'
    })
    const res = createRes(sequence)

    await service.handle(req, res)

    expect(scheduler.selectAccountForApiKey).toHaveBeenCalledWith(req.apiKey, null, null, {
      allowedAccountTypes: ['openai']
    })
    expect(axios.post.mock.calls[0][1]).toEqual({
      model: 'gpt-5.6-sol',
      id: 'search-1'
    })
    expect(axios.post.mock.calls[0][2].headers).toMatchObject({
      version: '0.144.0',
      originator: 'codex-tui',
      'x-codex-turn-metadata': 'metadata'
    })
    expect(axios.post.mock.calls[0][2].headers['openai-beta']).toBeUndefined()
    expect(apiKeyService.recordFixedCostUsage).toHaveBeenCalledWith(
      'key-1',
      expect.objectContaining({
        realCost: 0.01,
        service: 'codex',
        model: 'codex-web-search',
        accountId: 'account-1',
        usageType: 'openai_web_search',
        webSearchCalls: 1
      })
    )
    expect(updateRateLimitCounters).toHaveBeenCalledWith(
      req.rateLimitInfo,
      expect.any(Object),
      'codex-web-search',
      'key-1',
      'openai',
      expect.objectContaining({ ratedCost: 0.02 })
    )
    expect(sequence).toEqual(['bill', 'send'])
  })

  test('retries a 429 on another NIC and does not return the first error', async () => {
    setupAccount({
      interleaveNicEnabled: true,
      interleaveNicDisabledAddresses: []
    })
    openaiNicSelector.chooseLocalAddress
      .mockResolvedValueOnce('10.0.0.1')
      .mockResolvedValueOnce('10.0.0.2')
    openaiNicSelector.markCooldown.mockResolvedValue({
      marked: true,
      ttlSeconds: 3600
    })
    axios.post
      .mockResolvedValueOnce({
        status: 429,
        headers: {},
        data: { error: { message: 'rate limited' } }
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        data: { results: [] }
      })

    const res = createRes()
    await service.handle(createReq({ model: 'gpt-5.6-sol' }), res)

    expect(axios.post).toHaveBeenCalledTimes(2)
    expect(openaiNicSelector.markCooldown).toHaveBeenCalledWith(
      expect.objectContaining({ localAddress: '10.0.0.1' })
    )
    expect(res.statusCode).toBe(200)
    expect(apiKeyService.recordFixedCostUsage).toHaveBeenCalledTimes(1)
    expect(requestDetailService.captureRequestDetail).not.toHaveBeenCalled()
  })

  test('records the retry NIC and does not disable the account when it is last available', async () => {
    setupAccount({
      interleaveNicEnabled: true,
      interleaveNicDisabledAddresses: []
    })
    openaiNicSelector.chooseLocalAddress
      .mockResolvedValueOnce('10.0.0.1')
      .mockResolvedValueOnce('10.0.0.2')
    openaiNicSelector.markCooldown
      .mockResolvedValueOnce({
        marked: true,
        ttlSeconds: 3600,
        remainingAddresses: 1
      })
      .mockResolvedValueOnce({
        marked: false,
        reason: 'last_available'
      })
    axios.post.mockResolvedValue({
      status: 429,
      headers: {},
      data: { error: { message: 'rate limited' } }
    })

    const res = createRes()
    await service.handle(createReq({ model: 'gpt-5.6-sol' }), res)

    expect(res.statusCode).toBe(429)
    expect(upstreamErrorHelper.recordErrorHistory).toHaveBeenCalledTimes(2)
    expect(upstreamErrorHelper.recordErrorHistory.mock.calls[1][4]).toMatchObject({
      localAddress: '10.0.0.2',
      cooldownApplied: false,
      cooldownReason: 'last_available'
    })
    expect(scheduler.markAccountRateLimited).not.toHaveBeenCalled()
  })

  test('records a zero-cost detail for an upstream failure', async () => {
    axios.post.mockResolvedValue({
      status: 529,
      headers: {},
      data: { error: { message: 'overloaded', type: 'server_error' } }
    })

    const res = createRes()
    await service.handle(createReq({ model: 'gpt-5.6-sol' }), res)

    expect(res.statusCode).toBe(529)
    expect(apiKeyService.recordFixedCostUsage).not.toHaveBeenCalled()
    expect(requestDetailService.captureRequestDetail).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKeyId: 'key-1',
        accountId: 'account-1',
        usageType: 'openai_web_search',
        webSearchCalls: 0,
        totalTokens: 0,
        cost: 0,
        realCost: 0
      })
    )
  })
})
