const crypto = require('crypto')
const { PassThrough } = require('stream')

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
  clearBinding: jest.fn(),
  markCooldown: jest.fn(),
  getConfiguredLocalAddresses: jest.fn(),
  getEnabledLocalAddresses: jest.fn()
}))

jest.mock('../src/utils/upstreamErrorHelper', () => ({
  recordErrorHistory: jest.fn(() => Promise.resolve())
}))

jest.mock('../src/utils/performanceOptimizer', () => ({
  getHttpsAgentForLocalAddress: jest.fn()
}))

const axios = require('axios')
const unifiedOpenAIScheduler = require('../src/services/scheduler/unifiedOpenAIScheduler')
const openaiAccountService = require('../src/services/account/openaiAccountService')
const apiKeyService = require('../src/services/apiKeyService')
const openaiNicSelector = require('../src/utils/openaiNicSelector')
const upstreamErrorHelper = require('../src/utils/upstreamErrorHelper')
const { getHttpsAgentForLocalAddress } = require('../src/utils/performanceOptimizer')
const { updateRateLimitCounters } = require('../src/utils/rateLimitHelper')
const { IncrementalSSEParser } = require('../src/utils/sseParser')
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
    destroyed: false,
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
    }),
    write: jest.fn(),
    end: jest.fn(),
    flushHeaders: jest.fn()
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
    openaiNicSelector.markCooldown.mockResolvedValue({
      marked: true,
      localAddress: '10.0.0.191',
      ttlSeconds: 3600,
      expiresAt: '2026-05-28T13:00:00.000Z',
      remainingAddresses: 1
    })
    openaiNicSelector.getConfiguredLocalAddresses.mockReturnValue(['10.0.0.191', '10.0.0.184'])
    openaiNicSelector.getEnabledLocalAddresses.mockReturnValue(['10.0.0.191', '10.0.0.184'])
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
      ttlHours: '12',
      disabledAddresses: undefined
    })
    expect(getHttpsAgentForLocalAddress).toHaveBeenCalledWith('10.0.0.191', { stream: false })
    expect(req.upstreamNicIp).toBe('10.0.0.191')
    expect(axios.post.mock.calls[0][2].httpsAgent.options.localAddress).toBe('10.0.0.191')
    expect(axios.post.mock.calls[0][2].proxy).toBe(false)
  })

  test('records non-stream cache writes as an input subset and reuses calculated costs', async () => {
    const usageCosts = { realCost: 0.7475, ratedCost: 0.9 }
    apiKeyService.recordUsage.mockResolvedValue(usageCosts)
    updateRateLimitCounters.mockResolvedValue({ totalTokens: 110000, totalCost: 0.9 })
    axios.post.mockResolvedValue({
      status: 200,
      data: {
        model: 'gpt-5.6-sol',
        usage: {
          input_tokens: 100000,
          output_tokens: 10000,
          total_tokens: 110000,
          input_tokens_details: {
            cached_tokens: 20000,
            cache_write_tokens: 30000
          }
        }
      },
      headers: {}
    })
    const req = createReq()
    req.body.model = 'gpt-5.6-sol'
    req.body.service_tier = 'priority'
    req.rateLimitInfo = { costLimit: 10 }

    await openaiRoutes.handleResponses(req, createRes())

    expect(apiKeyService.recordUsage).toHaveBeenCalledWith(
      'key_1',
      50000,
      10000,
      30000,
      20000,
      'gpt-5.6-sol',
      'openai-1',
      'openai',
      'priority',
      expect.objectContaining({ stream: false, statusCode: 200 })
    )
    expect(updateRateLimitCounters).toHaveBeenCalledWith(
      req.rateLimitInfo,
      {
        inputTokens: 50000,
        outputTokens: 10000,
        cacheCreateTokens: 30000,
        cacheReadTokens: 20000
      },
      'gpt-5.6-sol',
      'key_1',
      'openai',
      usageCosts
    )
  })

  test('records cache writes when aggregating an upstream stream for a non-stream client', async () => {
    const ActualSSEParser = jest.requireActual('../src/utils/sseParser').IncrementalSSEParser
    IncrementalSSEParser.mockImplementation(() => new ActualSSEParser())
    const upstreamStream = new PassThrough()
    axios.post.mockResolvedValue({ status: 200, data: upstreamStream, headers: {} })
    const req = createReq()
    req.body.model = 'gpt-5.6-terra'
    req._forceCodexUpstreamStream = true

    setImmediate(() => {
      upstreamStream.end(
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            model: 'gpt-5.6-terra',
            output: [],
            usage: {
              input_tokens: 100,
              output_tokens: 10,
              input_tokens_details: { cached_tokens: 20, cache_write_tokens: 30 }
            }
          }
        })}\n\n`
      )
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(apiKeyService.recordUsage).toHaveBeenCalledWith(
      'key_1',
      50,
      10,
      30,
      20,
      'gpt-5.6-terra',
      'openai-1',
      'openai',
      null,
      expect.objectContaining({ stream: false })
    )
    expect(apiKeyService.recordUsage).toHaveBeenCalledTimes(1)
  })

  test('records cache writes once when the downstream response is streamed', async () => {
    const ActualSSEParser = jest.requireActual('../src/utils/sseParser').IncrementalSSEParser
    IncrementalSSEParser.mockImplementation(() => new ActualSSEParser())
    const upstreamStream = new PassThrough()
    let usageRecorded
    const usageRecordedPromise = new Promise((resolve) => {
      usageRecorded = resolve
    })
    apiKeyService.recordUsage.mockImplementation(async (...args) => {
      usageRecorded(args)
      return { realCost: 0.01, ratedCost: 0.01 }
    })
    axios.post.mockResolvedValue({ status: 200, data: upstreamStream, headers: {} })
    const req = createReq()
    req.body.model = 'gpt-5.6-luna'
    req.body.stream = true

    await openaiRoutes.handleResponses(req, createRes())
    upstreamStream.end(
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          model: 'gpt-5.6-luna',
          usage: {
            input_tokens: 100,
            output_tokens: 10,
            input_tokens_details: { cached_tokens: 20, cache_write_tokens: 30 }
          }
        }
      })}\n\n`
    )
    const recordedArgs = await usageRecordedPromise

    expect(recordedArgs.slice(0, 9)).toEqual([
      'key_1',
      50,
      10,
      30,
      20,
      'gpt-5.6-luna',
      'openai-1',
      'openai',
      null
    ])
    expect(apiKeyService.recordUsage).toHaveBeenCalledTimes(1)
  })

  test('passes manually disabled local addresses to the NIC selector', async () => {
    setupOpenAIAccount({
      interleaveNicDisabledAddresses: ['10.0.0.191']
    })
    openaiNicSelector.chooseLocalAddress.mockResolvedValue('10.0.0.184')
    getHttpsAgentForLocalAddress.mockReturnValue({
      options: {
        localAddress: '10.0.0.184'
      }
    })
    axios.post.mockResolvedValue(createSuccessResponse())

    const req = createReq()
    await openaiRoutes.handleResponses(req, createRes())

    expect(openaiNicSelector.chooseLocalAddress).toHaveBeenCalledWith({
      accountId: 'openai-1',
      sessionHash: createHash('nic-session'),
      ttlHours: '12',
      disabledAddresses: ['10.0.0.191']
    })
    expect(getHttpsAgentForLocalAddress).toHaveBeenCalledWith('10.0.0.184', { stream: false })
    expect(req.upstreamNicIp).toBe('10.0.0.184')
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

  test('records failed NIC address in error history and retries with alternate NIC on 429', async () => {
    const capturedConfigs = []
    openaiNicSelector.chooseLocalAddress
      .mockResolvedValueOnce('10.0.0.191')
      .mockResolvedValueOnce('10.0.0.184')
    getHttpsAgentForLocalAddress.mockImplementation((localAddress) => ({
      options: {
        localAddress
      }
    }))
    axios.post.mockImplementation(async (_url, _body, axiosConfig) => {
      capturedConfigs.push({ ...axiosConfig })
      if (capturedConfigs.length === 1) {
        return {
          status: 429,
          data: {
            error: {
              type: 'usage_limit_reached',
              message: 'Rate limit reached',
              resets_in_seconds: 300
            }
          },
          headers: {}
        }
      }
      return createSuccessResponse()
    })

    const req = createReq()
    await openaiRoutes.handleResponses(req, createRes())

    expect(openaiNicSelector.markCooldown).toHaveBeenCalledWith({
      accountId: 'openai-1',
      localAddress: '10.0.0.191',
      disabledAddresses: undefined
    })
    expect(upstreamErrorHelper.recordErrorHistory).toHaveBeenCalledWith(
      'openai-1',
      'openai',
      429,
      'rate_limit',
      expect.objectContaining({
        model: 'gpt-5',
        path: '/openai/v1/responses',
        source: 'HTTP 429',
        interleaveNic: true,
        localAddress: '10.0.0.191',
        upstreamNicIp: '10.0.0.191',
        cooldownApplied: true,
        cooldownReason: 'cooldown_applied',
        cooldownSeconds: 3600,
        cooldownExpiresAt: '2026-05-28T13:00:00.000Z',
        remainingNicAddresses: 1,
        resetsInSeconds: 300,
        errorBody: {
          error: {
            type: 'usage_limit_reached',
            message: 'Rate limit reached',
            resets_in_seconds: 300
          }
        }
      })
    )
    expect(unifiedOpenAIScheduler.markAccountRateLimited).not.toHaveBeenCalled()
    expect(capturedConfigs).toHaveLength(2)
    expect(capturedConfigs[0].httpsAgent.options.localAddress).toBe('10.0.0.191')
    expect(capturedConfigs[1].httpsAgent.options.localAddress).toBe('10.0.0.184')
  })
})
