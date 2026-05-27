const crypto = require('crypto')

const mockRouter = {
  get: jest.fn(),
  post: jest.fn()
}

jest.mock(
  'express',
  () => ({
    Router: () => mockRouter
  }),
  { virtual: true }
)

jest.mock(
  '../config/config',
  () => ({
    requestTimeout: 1000
  }),
  { virtual: true }
)

jest.mock('../src/middleware/auth', () => ({
  authenticateApiKey: jest.fn((_req, _res, next) => next())
}))

jest.mock('axios', () => ({
  post: jest.fn()
}))

jest.mock('../src/services/scheduler/unifiedOpenAIScheduler', () => ({
  selectAccountForApiKey: jest.fn(),
  markAccountRateLimited: jest.fn(),
  isAccountRateLimited: jest.fn().mockResolvedValue(false),
  removeAccountRateLimit: jest.fn(),
  markAccountUnauthorized: jest.fn()
}))

jest.mock('../src/services/account/openaiAccountService', () => ({
  getAccount: jest.fn(),
  decrypt: jest.fn(),
  isTokenExpired: jest.fn(() => false),
  refreshAccountToken: jest.fn(),
  updateCodexUsageSnapshot: jest.fn()
}))

jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  getAccount: jest.fn()
}))

jest.mock('../src/services/relay/openaiResponsesRelayService', () => ({
  handleRequest: jest.fn()
}))

jest.mock('../src/services/apiKeyService', () => ({
  hasPermission: jest.fn(() => true),
  recordUsage: jest.fn(async () => ({ realCost: 0, ratedCost: 0 }))
}))

jest.mock('../src/models/redis', () => ({
  getUsageStats: jest.fn()
}))

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  api: jest.fn(),
  security: jest.fn()
}))

jest.mock('../src/utils/proxyHelper', () => ({
  createProxyAgent: jest.fn(() => null),
  getProxyDescription: jest.fn(() => 'none')
}))

jest.mock('../src/utils/rateLimitHelper', () => ({
  updateRateLimitCounters: jest.fn()
}))

jest.mock('../src/utils/sseParser', () => ({
  IncrementalSSEParser: jest.fn().mockImplementation(() => ({
    feed: jest.fn(() => []),
    getRemaining: jest.fn(() => '')
  }))
}))

jest.mock('../src/utils/errorSanitizer', () => ({
  getSafeMessage: jest.fn((error) => error?.message || 'error')
}))

jest.mock('../src/utils/requestDetailHelper', () => ({
  createRequestDetailMeta: jest.fn((_req, overrides) => overrides),
  extractOpenAICacheReadTokens: jest.fn(() => 0)
}))

jest.mock('../src/utils/openaiNicSelector', () => ({
  chooseLocalAddress: jest.fn(),
  clearBinding: jest.fn()
}))

jest.mock('../src/utils/performanceOptimizer', () => ({
  getHttpsAgentForLocalAddress: jest.fn()
}))

const axios = require('axios')
const unifiedOpenAIScheduler = require('../src/services/scheduler/unifiedOpenAIScheduler')
const openaiAccountService = require('../src/services/account/openaiAccountService')
const openaiNicSelector = require('../src/utils/openaiNicSelector')
const { getHttpsAgentForLocalAddress } = require('../src/utils/performanceOptimizer')
const openaiRoutes = require('../src/routes/openaiRoutes')

function createHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function createReq() {
  return {
    method: 'POST',
    path: '/v1/responses',
    originalUrl: '/openai/v1/responses',
    headers: {
      'user-agent': 'codex-tui/0.118.0'
    },
    body: {
      model: 'gpt-5',
      prompt_cache_key: 'nic-session',
      stream: false
    },
    apiKey: {
      id: 'key_1',
      permissions: ['openai'],
      enableOpenAIResponsesCodexAdaptation: true,
      enableOpenAIResponsesPayloadRules: false,
      openaiResponsesPayloadRules: []
    },
    on: jest.fn()
  }
}

function createRes() {
  const res = {
    statusCode: 200,
    headers: {},
    headersSent: false,
    status: jest.fn((code) => {
      res.statusCode = code
      return res
    }),
    json: jest.fn((payload) => {
      res.payload = payload
      return res
    }),
    setHeader: jest.fn((key, value) => {
      res.headers[key] = value
    })
  }
  return res
}

function setupOpenAIAccount(overrides = {}) {
  unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValue({
    accountId: 'openai-1',
    accountType: 'openai'
  })
  openaiAccountService.getAccount.mockResolvedValue({
    id: 'openai-1',
    name: 'OpenAI Account',
    accessToken: 'encrypted-token',
    accountId: 'chatgpt-account-1',
    interleaveNicEnabled: 'true',
    interleaveNicTtlHours: '12',
    ...overrides
  })
  openaiAccountService.decrypt.mockReturnValue('decrypted-token')
}

function createSuccessResponse() {
  return {
    status: 200,
    data: {
      model: 'gpt-5',
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        total_tokens: 14
      }
    },
    headers: {}
  }
}

describe('openaiRoutes NIC interleave', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    setupOpenAIAccount()
    openaiNicSelector.chooseLocalAddress.mockResolvedValue('10.0.0.191')
    getHttpsAgentForLocalAddress.mockReturnValue({
      options: {
        localAddress: '10.0.0.191'
      }
    })
  })

  test('injects a local-address https agent for enabled OpenAI accounts without proxy', async () => {
    axios.post.mockResolvedValue(createSuccessResponse())
    const req = createReq()

    await openaiRoutes.handleResponses(req, createRes())

    expect(openaiNicSelector.chooseLocalAddress).toHaveBeenCalledWith({
      accountId: 'openai-1',
      sessionHash: createHash('nic-session'),
      ttlHours: '12'
    })
    expect(getHttpsAgentForLocalAddress).toHaveBeenCalledWith('10.0.0.191', { stream: false })
    expect(req.upstreamNicIp).toBe('10.0.0.191')
    expect(axios.post.mock.calls[0][2].httpsAgent.options.localAddress).toBe('10.0.0.191')
    expect(axios.post.mock.calls[0][2].proxy).toBe(false)
  })

  test('clears binding and retries once with default route on local-address bind errors', async () => {
    const capturedConfigs = []
    axios.post.mockImplementation(async (_url, _body, axiosConfig) => {
      capturedConfigs.push({ ...axiosConfig })
      if (capturedConfigs.length === 1) {
        const error = new Error('cannot assign requested address')
        error.code = 'EADDRNOTAVAIL'
        throw error
      }
      return createSuccessResponse()
    })

    const req = createReq()
    await openaiRoutes.handleResponses(req, createRes())

    expect(openaiNicSelector.clearBinding).toHaveBeenCalledWith({
      accountId: 'openai-1',
      sessionHash: createHash('nic-session')
    })
    expect(capturedConfigs).toHaveLength(2)
    expect(capturedConfigs[0].httpsAgent.options.localAddress).toBe('10.0.0.191')
    expect(capturedConfigs[1].httpsAgent).toBeUndefined()
    expect(capturedConfigs[1].proxy).toBeUndefined()
    expect(req.upstreamNicIp).toBeUndefined()
  })
})
