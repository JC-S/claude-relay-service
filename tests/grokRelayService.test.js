const { EventEmitter } = require('events')
const { Readable } = require('stream')

jest.mock('axios', () => ({ post: jest.fn() }))
jest.mock('../src/services/scheduler/grokScheduler', () => ({
  selectAccount: jest.fn(),
  releaseAccount: jest.fn(),
  clearSticky: jest.fn()
}))
jest.mock('../src/services/account/grokAccountService', () => ({
  getValidAccessToken: jest.fn(),
  touchUsage: jest.fn(),
  markTemporaryStatus: jest.fn()
}))
jest.mock('../src/services/grokQuotaService', () => ({ observeResponse: jest.fn() }))
jest.mock('../src/services/apiKeyService', () => ({ recordUsage: jest.fn() }))
jest.mock('../src/services/requestDetailService', () => ({ captureRequestDetail: jest.fn() }))
jest.mock('../src/utils/upstreamErrorHelper', () => ({
  logUpstreamErrorResponse: jest.fn((value) => value),
  recordErrorHistory: jest.fn(),
  markTempUnavailable: jest.fn(async () => ({
    expiresAt: new Date(Date.now() + 60000).toISOString()
  }))
}))
jest.mock('../src/utils/proxyHelper', () => ({ createProxyAgent: jest.fn(() => null) }))
jest.mock('../src/utils/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn()
}))
jest.mock('../src/utils/grokModelHelper', () => ({
  resolveGrokModel: jest.fn((model, mapping) => mapping?.[model] || model),
  resolveGrokBillingModel: jest.fn((actual, mapped) => actual || mapped),
  isSupportedGrokModel: jest.fn(() => true),
  isAccountSupportedGrokModel: jest.fn(() => true),
  hasValidGrokPricing: jest.fn(() => true)
}))

const axios = require('axios')
const grokScheduler = require('../src/services/scheduler/grokScheduler')
const grokAccountService = require('../src/services/account/grokAccountService')
const grokQuotaService = require('../src/services/grokQuotaService')
const apiKeyService = require('../src/services/apiKeyService')
const requestDetailService = require('../src/services/requestDetailService')
const upstreamErrorHelper = require('../src/utils/upstreamErrorHelper')
const grokRelayService = require('../src/services/relay/grokRelayService')

class FakeResponse extends EventEmitter {
  constructor() {
    super()
    this.statusCode = 200
    this.headers = {}
    this.headersSent = false
    this.destroyed = false
    this.writableEnded = false
    this.chunks = []
    this.body = null
  }

  status(code) {
    this.statusCode = code
    return this
  }

  setHeader(name, value) {
    this.headers[name.toLowerCase()] = value
  }

  write(value) {
    this.headersSent = true
    this.chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value))
    return true
  }

  json(value) {
    this.headersSent = true
    this.body = value
    this.writableEnded = true
    return this
  }

  end(value) {
    if (value) {
      this.write(value)
    }
    this.headersSent = true
    this.writableEnded = true
    return this
  }

  text() {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

const makeRequest = (body = {}) => {
  const req = new EventEmitter()
  req.body = { model: 'grok-4.5', input: 'hello', stream: true, ...body }
  req.headers = { session_id: 'session' }
  req.method = 'POST'
  req.originalUrl = '/grok/responses'
  req.apiKey = { id: 'key', name: 'key', grokAccountId: '' }
  req.ip = '127.0.0.1'
  req.connection = { remoteAddress: '127.0.0.1' }
  return req
}

const account = (id, authType = 'oauth') => ({
  id,
  name: id,
  authType,
  modelMapping: {},
  rateLimitSnapshot: null,
  billingSnapshot: null
})

const sseResponse = (events, status = 200) => ({
  status,
  headers: { 'content-type': 'text/event-stream', 'x-request-id': `upstream-${status}` },
  data: Readable.from([Buffer.from(events.join(''))])
})

const frame = (payload, event = payload.type) =>
  `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`

describe('grokRelayService', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    grokAccountService.getValidAccessToken.mockResolvedValue('token')
    grokQuotaService.observeResponse.mockResolvedValue(null)
    apiKeyService.recordUsage.mockResolvedValue({ realCost: 0.01, ratedCost: 0.01 })
    requestDetailService.captureRequestDetail.mockResolvedValue({ captured: true })
  })

  test('drops a failed account prelude and transparently fails over before downstream commit', async () => {
    const accounts = [account('first'), account('second')]
    grokScheduler.selectAccount
      .mockResolvedValueOnce({
        account: accounts[0],
        reservationKey: 'grok_account:first',
        stickyKey: 'sticky'
      })
      .mockResolvedValueOnce({
        account: accounts[1],
        reservationKey: 'grok_account:second',
        stickyKey: 'sticky'
      })
    axios.post
      .mockResolvedValueOnce(
        sseResponse([
          frame({ type: 'response.created', response: { id: 'failed-attempt' } }),
          frame({
            type: 'response.failed',
            response: {
              status: 'failed',
              error: { type: 'rate_limit_error', code: 'rate_limit_exceeded' }
            }
          })
        ])
      )
      .mockResolvedValueOnce(
        sseResponse([
          frame({ type: 'response.created', response: { id: 'successful-attempt' } }),
          frame({ type: 'response.output_text.delta', delta: 'hello' }),
          frame({
            type: 'response.completed',
            response: {
              id: 'successful-attempt',
              model: 'grok-4.5',
              usage: { input_tokens: 10, output_tokens: 2 }
            }
          })
        ])
      )

    const req = makeRequest()
    const res = new FakeResponse()
    await grokRelayService.handle(req, res, {
      requestedModel: 'grok-4.5',
      defaultMappedModel: 'grok-4.5'
    })

    expect(res.text()).not.toContain('failed-attempt')
    expect(res.text()).toContain('successful-attempt')
    expect(res.text()).toContain('hello')
    expect(apiKeyService.recordUsage).toHaveBeenCalledTimes(1)
    expect(apiKeyService.recordUsage.mock.calls[0][6]).toBe('second')
    expect(grokScheduler.clearSticky).toHaveBeenCalledTimes(1)
    expect(upstreamErrorHelper.markTempUnavailable).toHaveBeenCalledWith(
      'first',
      'grok',
      429,
      expect.any(Number),
      expect.any(Object),
      expect.any(Object)
    )
  })

  test('bills a failed terminal event with explicit usage and does not fail over', async () => {
    grokScheduler.selectAccount.mockResolvedValue({
      account: account('charged'),
      reservationKey: 'grok_account:charged'
    })
    axios.post.mockResolvedValue(
      sseResponse([
        frame({ type: 'response.created', response: { id: 'charged-failure' } }),
        frame({
          type: 'response.failed',
          response: {
            id: 'charged-failure',
            model: 'grok-4.5',
            error: { type: 'server_error', code: 'upstream_failed' },
            usage: { input_tokens: 7, output_tokens: 0 }
          }
        })
      ])
    )
    const req = makeRequest()
    const res = new FakeResponse()
    await grokRelayService.handle(req, res, {
      requestedModel: 'grok-4.5',
      defaultMappedModel: 'grok-4.5'
    })

    expect(grokScheduler.selectAccount).toHaveBeenCalledTimes(1)
    expect(apiKeyService.recordUsage).toHaveBeenCalledTimes(1)
    expect(apiKeyService.recordUsage.mock.calls[0][9]).toEqual(
      expect.objectContaining({
        terminalType: 'response.failed',
        errorType: 'server_error',
        errorCode: 'upstream_failed'
      })
    )
    expect(res.text()).toContain('charged-failure')
    expect(upstreamErrorHelper.markTempUnavailable).toHaveBeenCalled()
  })

  test('treats explicit all-zero usage as trustworthy accounting', async () => {
    grokScheduler.selectAccount.mockResolvedValue({
      account: account('zero'),
      reservationKey: 'grok_account:zero'
    })
    axios.post.mockResolvedValue(
      sseResponse([
        frame({
          type: 'response.completed',
          response: { model: 'grok-4.5', usage: { input_tokens: 0, output_tokens: 0 } }
        })
      ])
    )
    await grokRelayService.handle(makeRequest(), new FakeResponse(), {
      requestedModel: 'grok-4.5',
      defaultMappedModel: 'grok-4.5'
    })
    expect(apiKeyService.recordUsage).toHaveBeenCalledTimes(1)
    expect(requestDetailService.captureRequestDetail).not.toHaveBeenCalled()
  })

  test('aggregates an upstream SSE terminal into JSON for a non-stream client', async () => {
    grokScheduler.selectAccount.mockResolvedValue({
      account: account('json'),
      reservationKey: 'grok_account:json'
    })
    axios.post.mockResolvedValue(
      sseResponse([
        frame({ type: 'response.created', response: { id: 'json-response' } }),
        frame({
          type: 'response.completed',
          response: {
            id: 'json-response',
            object: 'response',
            model: 'grok-4.5',
            usage: { input_tokens: 3, output_tokens: 1 }
          }
        })
      ])
    )
    const req = makeRequest({ stream: false })
    const res = new FakeResponse()
    await grokRelayService.handle(req, res, {
      requestedModel: 'grok-4.5',
      defaultMappedModel: 'grok-4.5'
    })
    expect(res.body).toEqual(expect.objectContaining({ id: 'json-response', object: 'response' }))
    expect(apiKeyService.recordUsage).toHaveBeenCalledTimes(1)
  })

  test('wraps an upstream JSON response as SSE for a stream client', async () => {
    grokScheduler.selectAccount.mockResolvedValue({
      account: account('json-stream'),
      reservationKey: 'grok_account:json-stream'
    })
    axios.post.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'application/json' },
      data: Readable.from([
        Buffer.from(
          JSON.stringify({
            id: 'json-stream-response',
            object: 'response',
            model: 'grok-4.5',
            usage: { input_tokens: 2, output_tokens: 1 }
          })
        )
      ])
    })
    const res = new FakeResponse()
    await grokRelayService.handle(makeRequest(), res, {
      requestedModel: 'grok-4.5',
      defaultMappedModel: 'grok-4.5'
    })
    expect(res.text()).toContain('event: response.completed')
    expect(res.text()).toContain('json-stream-response')
    expect(apiKeyService.recordUsage).toHaveBeenCalledTimes(1)
  })

  test('preserves an incomplete JSON terminal type for a stream client', async () => {
    grokScheduler.selectAccount.mockResolvedValue({
      account: account('json-incomplete'),
      reservationKey: 'grok_account:json-incomplete'
    })
    axios.post.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'application/json' },
      data: Readable.from([
        Buffer.from(
          JSON.stringify({
            id: 'incomplete',
            object: 'response',
            status: 'incomplete',
            model: 'grok-4.5',
            usage: { input_tokens: 2, output_tokens: 1 }
          })
        )
      ])
    })
    const res = new FakeResponse()

    await grokRelayService.handle(makeRequest({ stream: true }), res, {
      requestedModel: 'grok-4.5',
      defaultMappedModel: 'grok-4.5'
    })

    expect(res.text()).toContain('event: response.incomplete')
    expect(res.text()).not.toContain('event: response.completed')
    expect(apiKeyService.recordUsage).toHaveBeenCalledTimes(1)
    expect(grokScheduler.selectAccount).toHaveBeenCalledTimes(1)
  })

  test('keeps parsing a terminal frame split after the stream is committed', async () => {
    grokScheduler.selectAccount.mockResolvedValue({
      account: account('split'),
      reservationKey: 'grok_account:split'
    })
    const created = frame({ type: 'response.created', response: { id: 'split-response' } })
    const delta = frame({ type: 'response.output_text.delta', delta: 'hello' })
    const completed = frame({
      type: 'response.completed',
      response: {
        id: 'split-response',
        model: 'grok-4.5',
        usage: { input_tokens: 4, output_tokens: 1 }
      }
    })
    const splitAt = Math.floor(completed.length / 2)
    axios.post.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      data: Readable.from([
        Buffer.from(created + delta + completed.slice(0, splitAt)),
        Buffer.from(completed.slice(splitAt))
      ])
    })
    const res = new FakeResponse()
    await grokRelayService.handle(makeRequest(), res, {
      requestedModel: 'grok-4.5',
      defaultMappedModel: 'grok-4.5'
    })
    expect(res.text()).toContain('response.completed')
    expect(res.text()).not.toContain('stream_terminated')
    expect(apiKeyService.recordUsage).toHaveBeenCalledTimes(1)
  })

  test('resumes terminal parsing after committing an oversized partial frame', async () => {
    grokScheduler.selectAccount.mockResolvedValue({
      account: account('oversized-partial'),
      reservationKey: 'grok_account:oversized-partial'
    })
    const completed = frame({
      type: 'response.completed',
      response: {
        id: 'oversized-response',
        model: 'grok-4.5',
        usage: { input_tokens: 3, output_tokens: 1 }
      }
    })
    axios.post.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      data: Readable.from([Buffer.alloc(256 * 1024, 97), Buffer.from(`\n\n${completed}`)])
    })
    const res = new FakeResponse()

    await grokRelayService.handle(makeRequest(), res, {
      requestedModel: 'grok-4.5',
      defaultMappedModel: 'grok-4.5'
    })

    expect(apiKeyService.recordUsage).toHaveBeenCalledTimes(1)
    expect(res.text()).toContain('response.completed')
    expect(res.text()).not.toContain('stream_terminated')
  })

  test('keeps a completed stream intact when accounting fails after downstream commit', async () => {
    grokScheduler.selectAccount.mockResolvedValue({
      account: account('committed'),
      reservationKey: 'grok_account:committed'
    })
    apiKeyService.recordUsage.mockRejectedValueOnce(new Error('accounting unavailable'))
    axios.post.mockResolvedValue(
      sseResponse([
        frame({ type: 'response.output_text.delta', delta: 'visible' }),
        frame({
          type: 'response.completed',
          response: {
            model: 'grok-4.5',
            usage: { input_tokens: 1, output_tokens: 1 }
          }
        })
      ])
    )
    const res = new FakeResponse()
    await grokRelayService.handle(makeRequest(), res, {
      requestedModel: 'grok-4.5',
      defaultMappedModel: 'grok-4.5'
    })
    expect(grokScheduler.selectAccount).toHaveBeenCalledTimes(1)
    expect(res.text()).toContain('visible')
    expect(res.text()).toContain('response.completed')
    expect(res.text()).not.toContain('stream_terminated')
  })

  test('treats a 2xx JSON error object as a failed response', async () => {
    grokScheduler.selectAccount
      .mockResolvedValueOnce({
        account: account('json-error'),
        reservationKey: 'grok_account:json-error'
      })
      .mockRejectedValueOnce(Object.assign(new Error('none'), { code: 'NO_GROK_ACCOUNT' }))
    axios.post.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'application/json' },
      data: Readable.from([
        Buffer.from('{"error":{"type":"rate_limit_error","message":"limited"}}')
      ])
    })
    const res = new FakeResponse()
    await grokRelayService.handle(makeRequest({ stream: false }), res, {
      requestedModel: 'grok-4.5',
      defaultMappedModel: 'grok-4.5'
    })
    expect(apiKeyService.recordUsage).not.toHaveBeenCalled()
    expect(upstreamErrorHelper.markTempUnavailable).toHaveBeenCalled()
    expect(requestDetailService.captureRequestDetail).toHaveBeenCalledTimes(1)
  })

  test('captures one zero-cost detail when all attempts fail without usage', async () => {
    grokScheduler.selectAccount
      .mockResolvedValueOnce({
        account: account('only'),
        reservationKey: 'grok_account:only'
      })
      .mockRejectedValueOnce(Object.assign(new Error('none'), { code: 'NO_GROK_ACCOUNT' }))
    axios.post.mockResolvedValue({
      status: 503,
      headers: { 'content-type': 'application/json' },
      data: Readable.from([Buffer.from('{"error":{"message":"overloaded"}}')])
    })
    const res = new FakeResponse()
    await grokRelayService.handle(makeRequest({ stream: false }), res, {
      requestedModel: 'grok-4.5',
      defaultMappedModel: 'grok-4.5'
    })
    expect(apiKeyService.recordUsage).not.toHaveBeenCalled()
    expect(requestDetailService.captureRequestDetail).toHaveBeenCalledTimes(1)
    expect(requestDetailService.captureRequestDetail).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 0, outputTokens: 0, cost: 0, accountType: 'grok' })
    )
    expect(res.statusCode).toBe(503)
  })

  test('does not retry an accepted request when local usage persistence fails', async () => {
    grokScheduler.selectAccount.mockResolvedValue({
      account: account('settled'),
      reservationKey: 'grok_account:settled'
    })
    apiKeyService.recordUsage.mockRejectedValueOnce(new Error('redis write failed'))
    axios.post.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'application/json' },
      data: Readable.from([
        Buffer.from(
          JSON.stringify({
            id: 'completed',
            object: 'response',
            model: 'grok-4.5',
            usage: { input_tokens: 1, output_tokens: 1 }
          })
        )
      ])
    })
    const res = new FakeResponse()

    await grokRelayService.handle(makeRequest({ stream: false }), res, {
      requestedModel: 'grok-4.5',
      defaultMappedModel: 'grok-4.5'
    })

    expect(axios.post).toHaveBeenCalledTimes(1)
    expect(grokScheduler.selectAccount).toHaveBeenCalledTimes(1)
    expect(upstreamErrorHelper.markTempUnavailable).not.toHaveBeenCalled()
    expect(res.body.id).toBe('completed')
  })

  test('does not retry when passive quota persistence fails after upstream acceptance', async () => {
    grokScheduler.selectAccount.mockResolvedValue({
      account: account('quota'),
      reservationKey: 'grok_account:quota'
    })
    grokQuotaService.observeResponse.mockRejectedValueOnce(new Error('redis write failed'))
    axios.post.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'application/json' },
      data: Readable.from([
        Buffer.from(
          JSON.stringify({
            id: 'completed',
            object: 'response',
            model: 'grok-4.5',
            usage: { input_tokens: 1, output_tokens: 1 }
          })
        )
      ])
    })
    const res = new FakeResponse()

    await grokRelayService.handle(makeRequest({ stream: false }), res, {
      requestedModel: 'grok-4.5',
      defaultMappedModel: 'grok-4.5'
    })

    expect(axios.post).toHaveBeenCalledTimes(1)
    expect(grokScheduler.selectAccount).toHaveBeenCalledTimes(1)
    expect(res.body.id).toBe('completed')
  })

  test('does not dispatch upstream when the client disconnects during token refresh', async () => {
    let resolveToken
    const tokenPromise = new Promise((resolve) => {
      resolveToken = resolve
    })
    grokScheduler.selectAccount.mockResolvedValue({
      account: account('disconnecting'),
      reservationKey: 'grok_account:disconnecting'
    })
    grokAccountService.getValidAccessToken.mockReturnValueOnce(tokenPromise)
    const req = makeRequest({ stream: false })
    const res = new FakeResponse()
    const relayPromise = grokRelayService.handle(req, res, {
      requestedModel: 'grok-4.5',
      defaultMappedModel: 'grok-4.5'
    })
    await Promise.resolve()
    await Promise.resolve()

    req.emit('aborted')
    resolveToken('token')
    await relayPromise

    expect(axios.post).not.toHaveBeenCalled()
    expect(grokScheduler.releaseAccount).toHaveBeenCalledTimes(1)
    expect(requestDetailService.captureRequestDetail).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 499, terminalType: 'client_disconnected' })
    )
  })

  test('still returns an upstream request error when detail persistence fails', async () => {
    grokScheduler.selectAccount.mockResolvedValue({
      account: account('bad-request'),
      reservationKey: 'grok_account:bad-request'
    })
    requestDetailService.captureRequestDetail.mockRejectedValueOnce(new Error('redis write failed'))
    axios.post.mockResolvedValue({
      status: 400,
      headers: { 'content-type': 'application/json' },
      data: Readable.from([Buffer.from('{"error":{"message":"invalid input"}}')])
    })
    const res = new FakeResponse()

    await grokRelayService.handle(makeRequest({ stream: false }), res, {
      requestedModel: 'grok-4.5',
      defaultMappedModel: 'grok-4.5'
    })

    expect(axios.post).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBe(400)
    expect(res.body.error.message).toBe('invalid input')
  })

  test('redacts credentials before an upstream failure is stored in error history', async () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJncm9rLXVzZXIifQ.signature-value-1234567890'
    grokScheduler.selectAccount
      .mockResolvedValueOnce({
        account: account('redaction'),
        reservationKey: 'grok_account:redaction'
      })
      .mockRejectedValueOnce(Object.assign(new Error('none'), { code: 'NO_GROK_ACCOUNT' }))
    upstreamErrorHelper.logUpstreamErrorResponse.mockImplementationOnce((value) => value)
    axios.post.mockResolvedValue({
      status: 429,
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      data: Readable.from([
        Buffer.from(JSON.stringify({ error: { message: `failed with Bearer ${jwt}` } }))
      ])
    })

    await grokRelayService.handle(makeRequest({ stream: false }), new FakeResponse(), {
      requestedModel: 'grok-4.5',
      defaultMappedModel: 'grok-4.5'
    })

    const storedContext = upstreamErrorHelper.markTempUnavailable.mock.calls[0][4]
    expect(JSON.stringify(storedContext)).not.toContain(jwt)
    expect(storedContext.headers.authorization).toBe('[REDACTED]')
    expect(storedContext.body.error.message).toContain('[REDACTED]')
  })

  test('returns 404 and records one zero-cost detail when no account mapping accepts a model', async () => {
    grokScheduler.selectAccount.mockRejectedValueOnce(
      Object.assign(new Error('unknown model'), { code: 'GROK_MODEL_NOT_FOUND' })
    )
    const req = makeRequest({ model: 'client-unknown', stream: false })
    const res = new FakeResponse()
    await grokRelayService.handle(req, res, {
      requestedModel: 'client-unknown',
      defaultMappedModel: 'client-unknown'
    })
    expect(axios.post).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(404)
    expect(res.body.error.code).toBe('model_not_found')
    expect(requestDetailService.captureRequestDetail).toHaveBeenCalledTimes(1)
  })

  test('refreshes once on the first OAuth 401 without leaving a cooldown on success', async () => {
    const clearAttemptTimers = jest.spyOn(grokRelayService, '_clearAttemptTimers')
    grokScheduler.selectAccount.mockResolvedValue({
      account: account('oauth'),
      reservationKey: 'grok_account:oauth'
    })
    axios.post
      .mockResolvedValueOnce({
        status: 401,
        headers: { 'content-type': 'application/json' },
        data: Readable.from([Buffer.from('{"error":{"message":"expired"}}')])
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: { 'content-type': 'application/json' },
        data: Readable.from([
          Buffer.from(
            JSON.stringify({
              id: 'refreshed',
              object: 'response',
              model: 'grok-4.5',
              usage: { input_tokens: 1, output_tokens: 1 }
            })
          )
        ])
      })
    await grokRelayService.handle(makeRequest({ stream: false }), new FakeResponse(), {
      requestedModel: 'grok-4.5',
      defaultMappedModel: 'grok-4.5'
    })
    expect(grokAccountService.getValidAccessToken).toHaveBeenNthCalledWith(1, 'oauth', false)
    expect(grokAccountService.getValidAccessToken).toHaveBeenNthCalledWith(2, 'oauth', true)
    expect(upstreamErrorHelper.recordErrorHistory).toHaveBeenCalledWith(
      'oauth',
      'grok',
      401,
      'response_failed',
      expect.any(Object)
    )
    expect(upstreamErrorHelper.markTempUnavailable).not.toHaveBeenCalled()
    expect(clearAttemptTimers).toHaveBeenCalledTimes(3)
    clearAttemptTimers.mockRestore()
  })
})
