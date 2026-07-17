const crypto = require('crypto')
const { Readable } = require('stream')

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
  recordUsage: jest.fn()
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
  createRequestDetailMeta: jest.fn(() => null),
  extractOpenAICacheReadTokens: jest.fn(() => 0)
}))

const unifiedOpenAIScheduler = require('../src/services/scheduler/unifiedOpenAIScheduler')
const axios = require('axios')
const apiKeyService = require('../src/services/apiKeyService')
const openaiAccountService = require('../src/services/account/openaiAccountService')
const openaiResponsesAccountService = require('../src/services/account/openaiResponsesAccountService')
const openaiResponsesRelayService = require('../src/services/relay/openaiResponsesRelayService')
const { IncrementalSSEParser } = require('../src/utils/sseParser')
const openaiRoutes = require('../src/routes/openaiRoutes')

function createHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function createReq({
  path = '/v1/responses',
  body = {},
  userAgent = 'my-client/1.0',
  apiKeyOverrides = {},
  fromUnifiedEndpoint = false,
  extraHeaders = {}
} = {}) {
  return {
    method: 'POST',
    path,
    originalUrl: `/openai${path}`,
    headers: {
      'user-agent': userAgent,
      ...extraHeaders
    },
    body: JSON.parse(JSON.stringify(body)),
    apiKey: {
      id: 'key_1',
      permissions: ['openai'],
      disableGptFastMode: false,
      enableOpenAIResponsesCodexAdaptation: true,
      enableOpenAIResponsesPayloadRules: false,
      openaiResponsesPayloadRules: [],
      ...apiKeyOverrides
    },
    _fromUnifiedEndpoint: fromUnifiedEndpoint
  }
}

function createRes() {
  const res = {
    statusCode: 200,
    headers: {},
    destroyed: false,
    writableEnded: false,
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
    }),
    set: jest.fn((key, value) => {
      res.headers[key] = value
      return res
    })
  }
  return res
}

describe('openai responses payload toggles', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    openaiRoutes._resetGeneralOpenAIUpstreamUserAgentCacheForTest()

    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'resp-1',
      accountType: 'openai-responses'
    })

    openaiResponsesAccountService.getAccount.mockResolvedValue({
      id: 'resp-1',
      name: 'Responses Account',
      apiKey: 'sk-responses'
    })

    openaiResponsesRelayService.handleRequest.mockResolvedValue({ ok: true })
    openaiAccountService.decrypt.mockReturnValue('decrypted-token')
  })

  test('keeps standard responses payload unchanged for openai-responses when both toggles are off', async () => {
    const req = createReq({
      body: {
        model: 'gpt-5-2025-08-07',
        temperature: 0.2,
        service_tier: 'priority',
        prompt_cache_key: 'session-a'
      },
      apiKeyOverrides: {
        enableOpenAIResponsesCodexAdaptation: false,
        enableOpenAIResponsesPayloadRules: false
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(req.body).toEqual({
      model: 'gpt-5-2025-08-07',
      temperature: 0.2,
      service_tier: 'priority',
      prompt_cache_key: 'session-a'
    })
    expect(unifiedOpenAIScheduler.selectAccountForApiKey).toHaveBeenCalledWith(
      req.apiKey,
      createHash('session-a'),
      'gpt-5'
    )
  })

  test('applies Codex adaptation only when adaptation toggle is on', async () => {
    const req = createReq({
      body: {
        model: 'gpt-5-2025-08-07',
        temperature: 0.2,
        service_tier: 'priority',
        prompt_cache_key: 'session-b'
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(req.body.model).toBe('gpt-5')
    expect(req.body.instructions).toBe(openaiRoutes.CODEX_CLI_INSTRUCTIONS)
    expect(req.body.temperature).toBeUndefined()
    expect(req.body.service_tier).toBeUndefined()
    expect(unifiedOpenAIScheduler.selectAccountForApiKey).toHaveBeenCalledWith(
      req.apiKey,
      createHash('session-b'),
      'gpt-5'
    )
  })

  test('general responses use only OpenAI OAuth accounts and skip Codex adaptation', async () => {
    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValueOnce({
      accountId: 'openai-1',
      accountType: 'openai'
    })
    openaiAccountService.getAccount.mockResolvedValueOnce({
      id: 'openai-1',
      name: 'OpenAI Account',
      accessToken: 'encrypted-token',
      accountId: 'chatgpt-account-1'
    })
    openaiAccountService.decrypt.mockReturnValueOnce('decrypted-token')
    apiKeyService.recordUsage.mockResolvedValueOnce({ realCost: 0, ratedCost: 0 })
    axios.post.mockResolvedValueOnce({
      status: 200,
      data: {
        model: 'gpt-5',
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          total_tokens: 12
        }
      },
      headers: {}
    })

    const req = createReq({
      body: {
        model: 'gpt-5-2025-08-07',
        stream: false,
        temperature: 0.2,
        service_tier: 'priority',
        prompt_cache_key: 'general-session',
        prompt_cache_retention: '24h'
      }
    })
    req.originalUrl = '/general/v1/responses'
    req._generalOpenAIEndpoint = true
    req._openAISchedulerOptions = { allowedAccountTypes: ['openai'] }

    await openaiRoutes.handleResponses(req, createRes())

    expect(req.body.model).toBe('gpt-5')
    expect(req.body.instructions).toBeUndefined()
    expect(req.body.temperature).toBe(0.2)
    expect(req.body.service_tier).toBe('priority')
    expect(req.body.prompt_cache_retention).toBeUndefined()
    expect(req.body.store).toBe(false)
    expect(unifiedOpenAIScheduler.selectAccountForApiKey).toHaveBeenCalledWith(
      req.apiKey,
      createHash('general-session'),
      'gpt-5',
      { allowedAccountTypes: ['openai'] }
    )
    expect(axios.post.mock.calls[0][1].instructions).toBeUndefined()
    expect(axios.post.mock.calls[0][1].prompt_cache_retention).toBeUndefined()
    expect(axios.post.mock.calls[0][2].headers['user-agent']).toBe(
      'codex-tui/0.135.0 (Ubuntu 24.4.0; x86_64) WindowsTerminal (codex-tui; 0.135.0)'
    )
  })

  test('general responses strip prompt_cache_retention after payload rules', async () => {
    const longPromptCacheKey = 'rule-cache-key-'.repeat(8)
    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValueOnce({
      accountId: 'openai-1',
      accountType: 'openai'
    })
    openaiAccountService.getAccount.mockResolvedValueOnce({
      id: 'openai-1',
      name: 'OpenAI Account',
      accessToken: 'encrypted-token',
      accountId: 'chatgpt-account-1'
    })
    openaiAccountService.decrypt.mockReturnValueOnce('decrypted-token')
    apiKeyService.recordUsage.mockResolvedValueOnce({ realCost: 0, ratedCost: 0 })
    axios.post.mockResolvedValueOnce({
      status: 200,
      data: {
        model: 'gpt-5.4',
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          total_tokens: 12
        }
      },
      headers: {}
    })

    const req = createReq({
      body: {
        model: 'gpt-5.4',
        stream: false,
        prompt_cache_key: 'general-rule-session'
      },
      apiKeyOverrides: {
        enableOpenAIResponsesPayloadRules: true,
        openaiResponsesPayloadRules: [
          { path: 'prompt_cache_key', valueType: 'string', value: longPromptCacheKey },
          { path: 'prompt_cache_retention', valueType: 'string', value: '24h' }
        ]
      }
    })
    req.originalUrl = '/general/v1/responses'
    req._generalOpenAIEndpoint = true
    req._openAISchedulerOptions = { allowedAccountTypes: ['openai'] }

    await openaiRoutes.handleResponses(req, createRes())

    expect(req.body.prompt_cache_retention).toBeUndefined()
    expect(req.body.prompt_cache_key).not.toBe(longPromptCacheKey)
    expect(req.body.prompt_cache_key.length).toBeLessThanOrEqual(64)
    expect(axios.post.mock.calls[0][1].prompt_cache_retention).toBeUndefined()
    expect(axios.post.mock.calls[0][1].prompt_cache_key.length).toBeLessThanOrEqual(64)
  })

  test('general non-stream responses force Codex upstream stream and aggregate response', async () => {
    IncrementalSSEParser.mockImplementationOnce(() => {
      let buffer = ''
      return {
        feed: jest.fn((chunk) => {
          buffer += chunk
          const events = []
          let idx
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const raw = buffer.slice(0, idx)
            buffer = buffer.slice(idx + 2)
            for (const line of raw.split('\n')) {
              if (!line.startsWith('data: ')) {
                continue
              }
              const payload = line.slice(6).trim()
              if (payload && payload !== '[DONE]') {
                events.push({ type: 'data', data: JSON.parse(payload) })
              }
            }
          }
          return events
        }),
        getRemaining: jest.fn(() => buffer)
      }
    })

    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValueOnce({
      accountId: 'openai-1',
      accountType: 'openai'
    })
    openaiAccountService.getAccount.mockResolvedValueOnce({
      id: 'openai-1',
      name: 'OpenAI Account',
      accessToken: 'encrypted-token',
      accountId: 'chatgpt-account-1'
    })
    openaiAccountService.decrypt.mockReturnValueOnce('decrypted-token')
    apiKeyService.recordUsage.mockResolvedValueOnce({ realCost: 0, ratedCost: 0 })

    const completedEvent = {
      type: 'response.completed',
      response: {
        id: 'resp_1',
        model: 'gpt-5.4',
        output: [],
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          total_tokens: 12
        }
      }
    }
    const upstreamEvents = [
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: []
        }
      },
      {
        type: 'response.content_part.added',
        output_index: 0,
        content_index: 0,
        part: {
          type: 'output_text',
          annotations: [],
          logprobs: [],
          text: ''
        }
      },
      {
        type: 'response.output_text.delta',
        output_index: 0,
        content_index: 0,
        delta: '你好，'
      },
      {
        type: 'response.output_text.delta',
        output_index: 0,
        content_index: 0,
        delta: '世界。'
      },
      {
        type: 'response.output_text.done',
        output_index: 0,
        content_index: 0,
        text: '你好，世界。'
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: []
        }
      },
      completedEvent
    ]
    axios.post.mockResolvedValueOnce({
      status: 200,
      data: Readable.from(upstreamEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`)),
      headers: {}
    })

    const req = createReq({
      body: {
        model: 'gpt-5.4',
        instructions: '',
        input: 'Hello World.',
        stream: true,
        prompt_cache_key: 'general-aggregate-session'
      }
    })
    req.originalUrl = '/general/v1/responses'
    req._generalOpenAIEndpoint = true
    req._openAISchedulerOptions = { allowedAccountTypes: ['openai'] }
    req._downstreamStream = false
    req._forceCodexUpstreamStream = true

    const res = createRes()
    await openaiRoutes.handleResponses(req, res)

    expect(axios.post).toHaveBeenCalled()
    expect(axios.post.mock.calls[0][1]).toMatchObject({
      model: 'gpt-5.4',
      stream: true,
      instructions: '',
      store: false
    })
    expect(axios.post.mock.calls[0][2].responseType).toBe('stream')
    expect(res.headers['Content-Type']).toBe('application/json')
    expect(res.payload).toMatchObject({
      id: 'resp_1',
      model: 'gpt-5.4',
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        total_tokens: 12
      },
      output: [
        {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '你好，世界。' }]
        }
      ]
    })
    expect(apiKeyService.recordUsage).toHaveBeenCalled()
    expect(apiKeyService.recordUsage.mock.calls[0][1]).toBe(10)
    expect(apiKeyService.recordUsage.mock.calls[0][2]).toBe(2)
  })

  test('applies payload rules directly on the original payload when adaptation is off', async () => {
    const req = createReq({
      body: {
        model: 'gpt-4.1',
        temperature: 0.5,
        prompt_cache_key: 'old-key',
        text: { format: {} }
      },
      apiKeyOverrides: {
        enableOpenAIResponsesCodexAdaptation: false,
        enableOpenAIResponsesPayloadRules: true,
        openaiResponsesPayloadRules: [
          { path: 'model', valueType: 'string', value: 'gpt-5' },
          { path: 'prompt_cache_key', valueType: 'string', value: 'new-key' },
          { path: 'text.format.type', valueType: 'string', value: 'json_schema' }
        ]
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(req.body).toEqual({
      model: 'gpt-5',
      temperature: 0.5,
      prompt_cache_key: 'new-key',
      text: {
        format: {
          type: 'json_schema'
        }
      }
    })
    expect(req.body.instructions).toBeUndefined()
    expect(unifiedOpenAIScheduler.selectAccountForApiKey).toHaveBeenCalledWith(
      req.apiKey,
      createHash('new-key'),
      'gpt-5'
    )
  })

  test('applies payload rules after Codex adaptation when both toggles are on', async () => {
    const req = createReq({
      body: {
        model: 'gpt-5-2025-08-07',
        prompt_cache_key: 'legacy-key',
        temperature: 0.2,
        instructions: 'raw'
      },
      apiKeyOverrides: {
        enableOpenAIResponsesCodexAdaptation: true,
        enableOpenAIResponsesPayloadRules: true,
        openaiResponsesPayloadRules: [
          { path: 'model', valueType: 'string', value: 'gpt-5.5' },
          { path: 'instructions', valueType: 'string', value: 'custom instructions' },
          { path: 'prompt_cache_key', valueType: 'string', value: 'rule-key' }
        ]
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(req.body.model).toBe('gpt-5.5')
    expect(req.body.instructions).toBe('custom instructions')
    expect(req.body.temperature).toBeUndefined()
    expect(unifiedOpenAIScheduler.selectAccountForApiKey).toHaveBeenCalledWith(
      req.apiKey,
      createHash('rule-key'),
      'gpt-5.5'
    )
  })

  test('normalizes dated gpt-5 models only for scheduling and upstream openai requests when adaptation is off', async () => {
    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'openai-1',
      accountType: 'openai'
    })
    openaiAccountService.getAccount.mockResolvedValue({
      id: 'openai-1',
      name: 'OpenAI Account',
      accessToken: 'encrypted-token',
      accountId: 'chatgpt-account-1'
    })
    axios.post.mockResolvedValue({
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
    })

    const req = createReq({
      body: {
        model: 'gpt-5-2025-08-07',
        service_tier: 'priority',
        prompt_cache_key: 'compat-key',
        stream: false
      },
      apiKeyOverrides: {
        enableOpenAIResponsesCodexAdaptation: false,
        enableOpenAIResponsesPayloadRules: false
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(unifiedOpenAIScheduler.selectAccountForApiKey).toHaveBeenCalledWith(
      req.apiKey,
      createHash('compat-key'),
      'gpt-5'
    )
    expect(req.body.model).toBe('gpt-5')
    expect(req.body.service_tier).toBe('priority')
    expect(axios.post).toHaveBeenCalled()
    expect(axios.post.mock.calls[0][1]).toMatchObject({
      model: 'gpt-5',
      service_tier: 'priority',
      store: false
    })
  })

  test('sends Codex CLI upstream identity headers for openai oauth accounts', async () => {
    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'openai-1',
      accountType: 'openai'
    })
    openaiAccountService.getAccount.mockResolvedValue({
      id: 'openai-1',
      name: 'OpenAI Account',
      accessToken: 'encrypted-token',
      accountId: 'chatgpt-account-1'
    })
    axios.post.mockResolvedValue({
      status: 200,
      data: {
        model: 'gpt-5.4',
        usage: {
          input_tokens: 8,
          output_tokens: 2,
          total_tokens: 10
        }
      },
      headers: {}
    })

    const req = createReq({
      body: {
        model: 'gpt-5.4',
        prompt_cache_key: 'cache-session',
        stream: false
      },
      userAgent: 'openai-node/4.0',
      apiKeyOverrides: {
        enableOpenAIResponsesCodexAdaptation: false,
        enableOpenAIResponsesPayloadRules: false
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(axios.post).toHaveBeenCalled()
    expect(axios.post.mock.calls[0][2].headers).toMatchObject({
      authorization: 'Bearer decrypted-token',
      'chatgpt-account-id': 'chatgpt-account-1',
      host: 'chatgpt.com',
      accept: 'application/json',
      'content-type': 'application/json',
      connection: 'Keep-Alive',
      originator: 'codex-tui',
      'user-agent': 'openai-node/4.0',
      session_id: 'cache-session'
    })
  })

  test('general endpoint overrides upstream user-agent using shenjc Codex TUI version', async () => {
    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'openai-1',
      accountType: 'openai'
    })
    openaiAccountService.getAccount.mockResolvedValue({
      id: 'openai-1',
      name: 'OpenAI Account',
      accessToken: 'encrypted-token',
      accountId: 'chatgpt-account-1'
    })
    axios.post.mockResolvedValue({
      status: 200,
      data: {
        model: 'gpt-5.4',
        usage: {
          input_tokens: 8,
          output_tokens: 2,
          total_tokens: 10
        }
      },
      headers: {}
    })

    const sourceReq = createReq({
      body: {
        model: 'gpt-5.4',
        prompt_cache_key: 'source-session',
        stream: false
      },
      userAgent: 'codex-tui/0.136.2 (Ubuntu 22.4.0; aarch64) xterm-256color (codex-tui; 0.136.2)',
      apiKeyOverrides: {
        id: 'a6c1ab90-3dd4-4426-925b-6ca11ef76d60',
        name: 'shenjc',
        enableOpenAIResponsesCodexAdaptation: false,
        enableOpenAIResponsesPayloadRules: false
      }
    })

    await openaiRoutes.handleResponses(sourceReq, createRes())

    const generalReq = createReq({
      body: {
        model: 'gpt-5.4',
        prompt_cache_key: 'general-session',
        stream: false
      },
      userAgent: 'claude-cli/1.0.110 (external, cli, browser-fallback)',
      apiKeyOverrides: {
        enableOpenAIResponsesCodexAdaptation: false,
        enableOpenAIResponsesPayloadRules: false
      }
    })
    generalReq.originalUrl = '/general/v1/responses'
    generalReq._generalOpenAIEndpoint = true
    generalReq._openAISchedulerOptions = { allowedAccountTypes: ['openai'] }

    await openaiRoutes.handleResponses(generalReq, createRes())

    expect(axios.post.mock.calls[0][2].headers['user-agent']).toBe(
      'codex-tui/0.136.2 (Ubuntu 22.4.0; aarch64) xterm-256color (codex-tui; 0.136.2)'
    )
    expect(axios.post.mock.calls[1][2].headers['user-agent']).toBe(
      'codex-tui/0.136.2 (Ubuntu 24.4.0; x86_64) WindowsTerminal (codex-tui; 0.136.2)'
    )
  })

  test('preserves incoming Codex upstream headers for openai oauth accounts', async () => {
    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'openai-1',
      accountType: 'openai'
    })
    openaiAccountService.getAccount.mockResolvedValue({
      id: 'openai-1',
      name: 'OpenAI Account',
      accessToken: 'encrypted-token',
      accountId: 'chatgpt-account-1'
    })
    axios.post.mockResolvedValue({
      status: 200,
      data: {
        model: 'gpt-5.4',
        usage: {
          input_tokens: 9,
          output_tokens: 3,
          total_tokens: 12
        }
      },
      headers: {}
    })

    const req = createReq({
      body: {
        model: 'gpt-5.4',
        prompt_cache_key: 'body-session',
        stream: false
      },
      extraHeaders: {
        originator: 'codex_cli_rs',
        session_id: 'header-session',
        version: '0.124.0',
        'x-codex-beta-features': 'feature-a,feature-b',
        'x-codex-turn-metadata': 'turn-metadata',
        'x-client-request-id': 'client-request-id'
      },
      apiKeyOverrides: {
        enableOpenAIResponsesCodexAdaptation: false,
        enableOpenAIResponsesPayloadRules: false
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(axios.post).toHaveBeenCalled()
    expect(axios.post.mock.calls[0][2].headers).toMatchObject({
      originator: 'codex_cli_rs',
      session_id: 'header-session',
      version: '0.124.0',
      'x-codex-beta-features': 'feature-a,feature-b',
      'x-codex-turn-metadata': 'turn-metadata',
      'x-client-request-id': 'client-request-id'
    })
  })

  test('normalizes payload-rule gpt-5 aliases for openai scheduling without applying full Codex adaptation', async () => {
    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'openai-1',
      accountType: 'openai'
    })
    openaiAccountService.getAccount.mockResolvedValue({
      id: 'openai-1',
      name: 'OpenAI Account',
      accessToken: 'encrypted-token',
      accountId: 'chatgpt-account-1'
    })
    axios.post.mockResolvedValue({
      status: 200,
      data: {
        model: 'gpt-5',
        usage: {
          input_tokens: 8,
          output_tokens: 3,
          total_tokens: 11
        }
      },
      headers: {}
    })

    const req = createReq({
      body: {
        model: 'gpt-4.1',
        text: { format: {} },
        prompt_cache_key: 'rule-model-key',
        stream: false
      },
      apiKeyOverrides: {
        enableOpenAIResponsesCodexAdaptation: false,
        enableOpenAIResponsesPayloadRules: true,
        openaiResponsesPayloadRules: [
          { path: 'model', valueType: 'string', value: 'gpt-5-2025-08-07' }
        ]
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(unifiedOpenAIScheduler.selectAccountForApiKey).toHaveBeenCalledWith(
      req.apiKey,
      createHash('rule-model-key'),
      'gpt-5'
    )
    expect(req.body.model).toBe('gpt-5')
    expect(req.body.text).toEqual({ format: {} })
    expect(req.body.instructions).toBeUndefined()
    expect(axios.post.mock.calls[0][1]).toMatchObject({
      model: 'gpt-5',
      text: { format: {} },
      store: false
    })
  })

  test('records the mutated service_tier for standard responses sent through openai accounts', async () => {
    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'openai-1',
      accountType: 'openai'
    })
    openaiAccountService.getAccount.mockResolvedValue({
      id: 'openai-1',
      name: 'OpenAI Account',
      accessToken: 'encrypted-token',
      accountId: 'chatgpt-account-1'
    })
    axios.post.mockResolvedValue({
      status: 200,
      data: {
        model: 'gpt-4.1',
        usage: {
          input_tokens: 12,
          output_tokens: 6,
          total_tokens: 18
        }
      },
      headers: {}
    })

    const req = createReq({
      body: {
        model: 'gpt-4.1',
        prompt_cache_key: 'tier-rule-key',
        stream: false
      },
      apiKeyOverrides: {
        enableOpenAIResponsesCodexAdaptation: false,
        enableOpenAIResponsesPayloadRules: true,
        openaiResponsesPayloadRules: [
          { path: 'service_tier', valueType: 'string', value: 'priority' }
        ]
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(req._serviceTier).toBe('priority')
    expect(apiKeyService.recordUsage).toHaveBeenCalled()
    expect(apiKeyService.recordUsage.mock.calls[0][8]).toBe('priority')
  })

  test('keeps service_tier for codex-tui standard responses sent through openai accounts', async () => {
    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'openai-1',
      accountType: 'openai'
    })
    openaiAccountService.getAccount.mockResolvedValue({
      id: 'openai-1',
      name: 'OpenAI Account',
      accessToken: 'encrypted-token',
      accountId: 'chatgpt-account-1'
    })
    axios.post.mockResolvedValue({
      status: 200,
      data: {
        model: 'gpt-5.4',
        usage: {
          input_tokens: 12,
          output_tokens: 6,
          total_tokens: 18
        }
      },
      headers: {}
    })

    const req = createReq({
      body: {
        model: 'gpt-5.4',
        service_tier: 'priority',
        prompt_cache_key: 'codex-tui-tier-key',
        stream: false
      },
      userAgent: 'codex-tui/0.124.0 (Ubuntu 22.4.0; aarch64) xterm-256color'
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(req.body.instructions).toBeUndefined()
    expect(req.body.service_tier).toBe('priority')
    expect(req._serviceTier).toBe('priority')
    expect(axios.post).toHaveBeenCalled()
    expect(axios.post.mock.calls[0][1]).toMatchObject({
      model: 'gpt-5.4',
      service_tier: 'priority',
      store: false
    })
    expect(apiKeyService.recordUsage).toHaveBeenCalled()
    expect(apiKeyService.recordUsage.mock.calls[0][8]).toBe('priority')
  })

  test('removes gpt service_tier when fast mode is blocked for openai accounts', async () => {
    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'openai-1',
      accountType: 'openai'
    })
    openaiAccountService.getAccount.mockResolvedValue({
      id: 'openai-1',
      name: 'OpenAI Account',
      accessToken: 'encrypted-token',
      accountId: 'chatgpt-account-1'
    })
    axios.post.mockResolvedValue({
      status: 200,
      data: {
        model: 'gpt-5.4',
        usage: {
          input_tokens: 12,
          output_tokens: 6,
          total_tokens: 18
        }
      },
      headers: {}
    })

    const req = createReq({
      body: {
        model: 'gpt-5.4',
        service_tier: 'priority',
        prompt_cache_key: 'blocked-fast-key',
        stream: false
      },
      userAgent: 'codex-tui/0.124.0 (Ubuntu 22.4.0; aarch64) xterm-256color',
      apiKeyOverrides: {
        disableGptFastMode: true
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(req.body.service_tier).toBeUndefined()
    expect(req._serviceTier).toBeNull()
    expect(axios.post).toHaveBeenCalled()
    expect(axios.post.mock.calls[0][1]).toMatchObject({
      model: 'gpt-5.4',
      store: false
    })
    expect(axios.post.mock.calls[0][1].service_tier).toBeUndefined()
    expect(apiKeyService.recordUsage).toHaveBeenCalled()
    expect(apiKeyService.recordUsage.mock.calls[0][8]).toBeNull()
  })

  test('removes payload-rule gpt service_tier before relaying openai-responses requests', async () => {
    const req = createReq({
      body: {
        model: 'gpt-4.1',
        prompt_cache_key: 'blocked-relay-tier-key'
      },
      apiKeyOverrides: {
        disableGptFastMode: true,
        enableOpenAIResponsesCodexAdaptation: false,
        enableOpenAIResponsesPayloadRules: true,
        openaiResponsesPayloadRules: [
          { path: 'service_tier', valueType: 'string', value: 'priority' }
        ]
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(req.body.service_tier).toBeUndefined()
    expect(req._serviceTier).toBeNull()
    expect(openaiResponsesRelayService.handleRequest).toHaveBeenCalled()
    expect(
      openaiResponsesRelayService.handleRequest.mock.calls[0][0].body.service_tier
    ).toBeUndefined()
    expect(openaiResponsesRelayService.handleRequest.mock.calls[0][0]._serviceTier).toBeNull()
  })

  test('records null service_tier after Codex adaptation removes it for openai accounts', async () => {
    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'openai-1',
      accountType: 'openai'
    })
    openaiAccountService.getAccount.mockResolvedValue({
      id: 'openai-1',
      name: 'OpenAI Account',
      accessToken: 'encrypted-token',
      accountId: 'chatgpt-account-1'
    })
    axios.post.mockResolvedValue({
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
    })

    const req = createReq({
      body: {
        model: 'gpt-5-2025-08-07',
        temperature: 0.2,
        service_tier: 'priority',
        prompt_cache_key: 'adapt-tier-key',
        stream: false
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(req.body.service_tier).toBeUndefined()
    expect(req._serviceTier).toBeNull()
    expect(apiKeyService.recordUsage).toHaveBeenCalled()
    expect(apiKeyService.recordUsage.mock.calls[0][8]).toBeNull()
  })

  test('captures the post-rule service_tier before relaying openai-responses requests', async () => {
    const req = createReq({
      body: {
        model: 'gpt-4.1',
        prompt_cache_key: 'relay-tier-key'
      },
      apiKeyOverrides: {
        enableOpenAIResponsesCodexAdaptation: false,
        enableOpenAIResponsesPayloadRules: true,
        openaiResponsesPayloadRules: [
          { path: 'service_tier', valueType: 'string', value: 'priority' }
        ]
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(req._serviceTier).toBe('priority')
    expect(openaiResponsesRelayService.handleRequest).toHaveBeenCalled()
    expect(openaiResponsesRelayService.handleRequest.mock.calls[0][0]._serviceTier).toBe('priority')
  })

  test('does not apply the new rule flow to compact responses routes', async () => {
    const req = createReq({
      path: '/v1/responses/compact',
      body: {
        model: 'o1-mini',
        prompt_cache_key: 'compact-key',
        temperature: 0.1
      },
      apiKeyOverrides: {
        enableOpenAIResponsesCodexAdaptation: false,
        enableOpenAIResponsesPayloadRules: true,
        openaiResponsesPayloadRules: [
          { path: 'model', valueType: 'string', value: 'gpt-5' },
          { path: 'prompt_cache_key', valueType: 'string', value: 'rule-key' }
        ]
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(req.body.model).toBe('o1-mini')
    expect(req.body.prompt_cache_key).toBe('compact-key')
    expect(req.body.instructions).toBe(openaiRoutes.CODEX_CLI_INSTRUCTIONS)
  })

  test('keeps the exact Lite model and sends the normalized Lite protocol', async () => {
    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'openai-1',
      accountType: 'openai'
    })
    openaiAccountService.getAccount.mockResolvedValue({
      id: 'openai-1',
      name: 'OpenAI Account',
      accessToken: 'encrypted-token',
      accountId: 'chatgpt-account-1'
    })
    axios.post.mockResolvedValue({
      status: 200,
      data: {
        model: 'gpt-5.6-sol',
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      },
      headers: {}
    })
    const req = createReq({
      body: {
        model: 'gpt-5.6-sol',
        instructions: 'Use tools',
        input: 'hello',
        tools: [{ type: 'custom', name: 'exec' }],
        stream: false
      },
      extraHeaders: {
        'x-openai-internal-codex-responses-lite': 'true'
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(unifiedOpenAIScheduler.selectAccountForApiKey).toHaveBeenCalledWith(
      req.apiKey,
      null,
      'gpt-5.6-sol',
      { allowedAccountTypes: ['openai'] }
    )
    expect(axios.post.mock.calls[0][1]).toMatchObject({
      model: 'gpt-5.6-sol',
      reasoning: { context: 'all_turns' },
      parallel_tool_calls: false,
      store: false
    })
    expect(axios.post.mock.calls[0][1].instructions).toBeUndefined()
    expect(axios.post.mock.calls[0][1].tools).toBeUndefined()
    expect(axios.post.mock.calls[0][1].input[0]).toMatchObject({
      type: 'additional_tools',
      role: 'developer'
    })
    expect(axios.post.mock.calls[0][2].headers['x-openai-internal-codex-responses-lite']).toBe(
      'true'
    )
  })

  test('does not recognize or forward non-exact Lite header values', async () => {
    const req = createReq({
      body: {
        model: 'gpt-5-preview',
        input: 'hello'
      },
      apiKeyOverrides: {
        enableOpenAIResponsesCodexAdaptation: false
      },
      extraHeaders: {
        'x-openai-internal-codex-responses-lite': 'TRUE'
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(req._responsesLite).toBe(false)
    expect(unifiedOpenAIScheduler.selectAccountForApiKey).toHaveBeenCalledWith(
      req.apiKey,
      null,
      'gpt-5'
    )
    expect(openaiResponsesRelayService.handleRequest).toHaveBeenCalled()
  })
})
