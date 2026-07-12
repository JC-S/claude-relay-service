const { EventEmitter } = require('events')
const { PassThrough } = require('stream')

const mockRouter = { get: jest.fn(), post: jest.fn() }

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
  recordUsage: jest.fn(async () => ({ realCost: 0.12, ratedCost: 0.12 }))
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
  updateRateLimitCounters: jest.fn(async () => ({ totalTokens: 0, totalCost: 0 }))
}))

jest.mock('../src/utils/errorSanitizer', () => ({
  getSafeMessage: jest.fn((error) => error?.message || String(error || 'error'))
}))

jest.mock('../src/utils/requestDetailHelper', () => {
  const actual = jest.requireActual('../src/utils/requestDetailHelper')
  return {
    createRequestDetailMeta: jest.fn((_req, overrides) => overrides),
    sanitizeImageData: actual.sanitizeImageData
  }
})

jest.mock('../src/utils/openaiNicSelector', () => ({
  chooseLocalAddress: jest.fn(),
  clearBinding: jest.fn(),
  markCooldown: jest.fn(),
  getEnabledLocalAddresses: jest.fn(() => [])
}))

jest.mock('../src/utils/upstreamErrorHelper', () => ({
  classifyError: jest.fn((status) => (status === 529 ? 'overload' : null)),
  logUpstreamErrorResponse: jest.fn((params) => params),
  recordErrorHistory: jest.fn(async () => {})
}))

jest.mock('../src/utils/performanceOptimizer', () => ({
  getHttpsAgentForLocalAddress: jest.fn()
}))

const axios = require('axios')
const scheduler = require('../src/services/scheduler/unifiedOpenAIScheduler')
const openaiAccountService = require('../src/services/account/openaiAccountService')
const apiKeyService = require('../src/services/apiKeyService')
const upstreamErrorHelper = require('../src/utils/upstreamErrorHelper')
const openaiRoutes = require('../src/routes/openaiRoutes')

function createReq(endpoint = 'generations', stream = false) {
  const req = new EventEmitter()
  Object.assign(req, {
    method: 'POST',
    path: `/v1/images/${endpoint}`,
    originalUrl: `/general/v1/images/${endpoint}`,
    headers: { 'user-agent': 'downstream-client/1.0' },
    body: {
      model: 'gpt-image-2',
      prompt: 'A lighthouse',
      ...(stream ? { stream: true } : {})
    },
    apiKey: { id: 'key-image', name: 'image-key', permissions: ['openai'] },
    _generalOpenAIEndpoint: true,
    _openAISchedulerOptions: { allowedAccountTypes: ['openai'] },
    _openAIImageEndpoint: endpoint,
    _openAIImageRequestSnapshot: { model: 'gpt-image-2', prompt: 'A lighthouse' },
    _downstreamStream: stream,
    requestId: 'request-image-1'
  })
  return req
}

function createRes() {
  const res = new EventEmitter()
  Object.assign(res, {
    statusCode: 200,
    headers: {},
    headersSent: false,
    destroyed: false,
    writableEnded: false,
    chunks: [],
    status(code) {
      this.statusCode = code
      return this
    },
    setHeader(key, value) {
      this.headers[key] = value
    },
    json(payload) {
      this.payload = payload
      this.headersSent = true
      this.writableEnded = true
      return this
    },
    send(payload) {
      this.payload = payload
      this.headersSent = true
      this.writableEnded = true
      return this
    },
    write(chunk) {
      this.headersSent = true
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk))
      return true
    },
    end(chunk) {
      if (chunk) {
        this.write(chunk)
      }
      this.writableEnded = true
      return this
    },
    flushHeaders() {
      this.headersSent = true
    }
  })
  return res
}

function setupAccount() {
  scheduler.selectAccountForApiKey.mockResolvedValue({
    accountId: 'openai-image-1',
    accountType: 'openai'
  })
  openaiAccountService.getAccount.mockResolvedValue({
    id: 'openai-image-1',
    name: 'OpenAI Image Account',
    accessToken: 'encrypted-token',
    accountId: 'chatgpt-account-1',
    interleaveNicEnabled: false
  })
  openaiAccountService.decrypt.mockReturnValue('decrypted-token')
}

describe('openaiRoutes.handleImages', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    setupAccount()
    scheduler.isAccountRateLimited.mockResolvedValue(false)
  })

  test('uses the direct Codex images endpoint, dynamic General UA, and records image usage', async () => {
    axios.post.mockResolvedValue({
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'upstream-image-1'
      },
      data: {
        created: 1,
        data: [{ b64_json: 'AAAA' }],
        usage: {
          input_tokens: 120,
          output_tokens: 4000,
          input_tokens_details: { text_tokens: 20, image_tokens: 100 }
        }
      }
    })
    const req = createReq('generations', false)
    const res = createRes()

    await openaiRoutes.handleImages(req, res)

    expect(scheduler.selectAccountForApiKey).toHaveBeenCalledWith(req.apiKey, null, 'gpt-image-2', {
      allowedAccountTypes: ['openai']
    })
    expect(axios.post).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/codex/images/generations',
      req.body,
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer decrypted-token',
          'chatgpt-account-id': 'chatgpt-account-1',
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent':
            'codex-tui/0.135.0 (Ubuntu 24.4.0; x86_64) WindowsTerminal (codex-tui; 0.135.0)'
        }),
        maxBodyLength: 140 * 1024 * 1024,
        maxContentLength: 200 * 1024 * 1024
      })
    )
    expect(apiKeyService.recordUsage).toHaveBeenCalledWith(
      'key-image',
      120,
      4000,
      0,
      0,
      'gpt-image-2',
      'openai-image-1',
      'openai',
      null,
      expect.objectContaining({ requestBody: req._openAIImageRequestSnapshot, stream: false }),
      {
        textInputTokens: 20,
        imageInputTokens: 100,
        imageOutputTokens: 4000,
        estimated: false
      }
    )
    expect(res.statusCode).toBe(200)
    expect(res.payload.data[0].b64_json).toBe('AAAA')
    expect(res.headers['x-request-id']).toBe('upstream-image-1')
  })

  test('extracts usage from a completed edit stream and records it once', async () => {
    const stream = new PassThrough()
    axios.post.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      data: stream
    })
    const req = createReq('edits', true)
    const res = createRes()

    setImmediate(() => {
      stream.write(
        'event: image_edit.partial_image\ndata: {"type":"image_edit.partial_image","b64_json":"AAAA"}\n\n'
      )
      stream.end(
        'event: image_edit.completed\ndata: {"type":"image_edit.completed","b64_json":"BBBB","usage":{"input_tokens":25,"output_tokens":50}}\n\n'
      )
    })

    await openaiRoutes.handleImages(req, res)

    expect(apiKeyService.recordUsage).toHaveBeenCalledTimes(1)
    expect(apiKeyService.recordUsage).toHaveBeenCalledWith(
      'key-image',
      25,
      50,
      0,
      0,
      'gpt-image-2',
      'openai-image-1',
      'openai',
      null,
      expect.objectContaining({ stream: true }),
      {
        textInputTokens: 0,
        imageInputTokens: 25,
        imageOutputTokens: 50,
        estimated: true
      }
    )
    expect(res.chunks.join('')).toContain('image_edit.completed')
    expect(res.writableEnded).toBe(true)
  })

  test('records completed usage once when the downstream closes before a later chunk', async () => {
    const stream = new PassThrough()
    axios.post.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      data: stream
    })
    const req = createReq('generations', true)
    const res = createRes()

    setImmediate(() => {
      stream.write(
        'event: image_generation.completed\ndata: {"type":"image_generation.completed","usage":{"input_tokens":3,"output_tokens":5}}\n\n'
      )
      res.destroyed = true
      stream.write('data: [DONE]\n\n')
    })

    await openaiRoutes.handleImages(req, res)

    expect(apiKeyService.recordUsage).toHaveBeenCalledTimes(1)
    expect(apiKeyService.recordUsage).toHaveBeenCalledWith(
      'key-image',
      3,
      5,
      0,
      0,
      'gpt-image-2',
      'openai-image-1',
      'openai',
      null,
      expect.objectContaining({ stream: true }),
      expect.any(Object)
    )
  })

  test('records completed usage once when the upstream errors before ending', async () => {
    const stream = new PassThrough()
    axios.post.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      data: stream
    })
    const req = createReq('generations', true)
    const res = createRes()

    setImmediate(() => {
      stream.write(
        'event: image_generation.completed\ndata: {"type":"image_generation.completed","usage":{"input_tokens":11,"output_tokens":13}}\n\n'
      )
      stream.destroy(new Error('upstream reset'))
    })

    await openaiRoutes.handleImages(req, res)

    expect(apiKeyService.recordUsage).toHaveBeenCalledTimes(1)
    expect(apiKeyService.recordUsage).toHaveBeenCalledWith(
      'key-image',
      11,
      13,
      0,
      0,
      'gpt-image-2',
      'openai-image-1',
      'openai',
      null,
      expect.objectContaining({ stream: true }),
      expect.any(Object)
    )
  })

  test.each(['close', 'error'])(
    'does not record usage when the upstream terminates via %s before completion',
    async (termination) => {
      const stream = new PassThrough()
      axios.post.mockResolvedValue({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        data: stream
      })
      const req = createReq('generations', true)
      const res = createRes()

      setImmediate(() => {
        stream.write(
          'event: image_generation.partial_image\ndata: {"type":"image_generation.partial_image","b64_json":"AAAA"}\n\n'
        )
        stream.destroy(termination === 'error' ? new Error('upstream reset') : undefined)
      })

      await openaiRoutes.handleImages(req, res)

      expect(apiKeyService.recordUsage).not.toHaveBeenCalled()
    }
  )

  test('pauses the upstream image stream until a slow downstream drains', async () => {
    const stream = new PassThrough()
    const pauseSpy = jest.spyOn(stream, 'pause')
    const resumeSpy = jest.spyOn(stream, 'resume')
    axios.post.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      data: stream
    })
    const req = createReq('generations', true)
    const res = createRes()
    let firstWrite = true
    res.write = jest.fn((chunk) => {
      res.headersSent = true
      res.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk))
      if (firstWrite) {
        firstWrite = false
        return false
      }
      return true
    })

    setImmediate(() => {
      stream.write(
        'event: image_generation.partial_image\ndata: {"type":"image_generation.partial_image","b64_json":"AAAA"}\n\n'
      )
      setImmediate(() => {
        res.emit('drain')
        stream.end(
          'event: image_generation.completed\ndata: {"type":"image_generation.completed","usage":{"input_tokens":1,"output_tokens":2}}\n\n'
        )
      })
    })

    await openaiRoutes.handleImages(req, res)

    expect(pauseSpy).toHaveBeenCalled()
    expect(resumeSpy).toHaveBeenCalled()
    expect(apiKeyService.recordUsage).toHaveBeenCalledTimes(1)
  })

  test('keeps a non-2xx stream response as JSON and sanitizes error history', async () => {
    const stream = new PassThrough()
    axios.post.mockResolvedValue({
      status: 529,
      statusText: 'Overloaded',
      headers: { 'content-type': 'application/json' },
      data: stream
    })
    const req = createReq('generations', true)
    const res = createRes()
    setImmediate(() =>
      stream.end(
        JSON.stringify({
          error: { message: 'overloaded' },
          b64_json: 'SENSITIVE-IMAGE-DATA'
        })
      )
    )

    await openaiRoutes.handleImages(req, res)

    expect(res.statusCode).toBe(529)
    expect(res.headers['Content-Type']).toBe('application/json')
    expect(res.payload.b64_json).toBe('SENSITIVE-IMAGE-DATA')
    expect(upstreamErrorHelper.logUpstreamErrorResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          b64_json: '[image data omitted, 20 chars]'
        })
      })
    )
    expect(apiKeyService.recordUsage).not.toHaveBeenCalled()
  })

  test('marks the account rate limited when a 429 has no alternate NIC', async () => {
    axios.post.mockResolvedValue({
      status: 429,
      headers: { 'content-type': 'application/json' },
      data: { error: { type: 'usage_limit_reached', resets_in_seconds: 90 } }
    })
    const req = createReq('generations', false)
    const res = createRes()

    await openaiRoutes.handleImages(req, res)

    expect(scheduler.markAccountRateLimited).toHaveBeenCalledWith(
      'openai-image-1',
      'openai',
      null,
      90
    )
    expect(res.statusCode).toBe(429)
    expect(res.payload.error.type).toBe('usage_limit_reached')
  })
})
