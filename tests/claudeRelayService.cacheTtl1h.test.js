jest.mock(
  '../config/config',
  () => ({
    requestTimeout: 1000,
    claude: {
      apiVersion: '2023-06-01',
      betaHeader: '',
      systemPrompt: '',
      overloadHandling: { enabled: 0 }
    }
  }),
  { virtual: true }
)

jest.mock('../src/utils/logger', () => ({
  api: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  performance: jest.fn(),
  warn: jest.fn()
}))
jest.mock('../src/utils/proxyHelper', () => jest.fn())
jest.mock('../src/utils/headerFilter', () => ({ filterForClaude: jest.fn((headers) => headers) }))
jest.mock('../src/models/redis', () => ({
  client: { del: jest.fn(() => Promise.resolve()) }
}))
jest.mock('../src/services/account/claudeAccountService', () => ({
  getAccount: jest.fn(() =>
    Promise.resolve({ id: 'account-1', name: 'Account', useUnifiedUserAgent: 'false' })
  ),
  clearInternalErrors: jest.fn(() => Promise.resolve()),
  isAccountOverloaded: jest.fn(() => Promise.resolve(false)),
  updateSessionWindowStatus: jest.fn(() => Promise.resolve())
}))
jest.mock('../src/services/scheduler/unifiedClaudeScheduler', () => ({
  isAccountRateLimited: jest.fn(() => Promise.resolve(false)),
  removeAccountRateLimit: jest.fn(() => Promise.resolve())
}))
jest.mock('../src/services/claudeCodeHeadersService', () => ({
  getAccountHeaders: jest.fn(() => Promise.resolve({})),
  storeAccountHeaders: jest.fn(() => Promise.resolve())
}))
jest.mock('../src/services/requestIdentityService', () => ({
  transform: jest.fn(({ body, headers }) => ({ body, headers }))
}))
jest.mock('../src/services/claudeRelayConfigService', () => ({
  isAnthropicCacheTtl1hInjectionEnabled: jest.fn(() => Promise.resolve(false))
}))
jest.mock('../src/services/userMessageQueueService', () => ({}))
jest.mock('../src/utils/upstreamErrorHelper', () => ({}))
jest.mock('../src/utils/testPayloadHelper', () => ({}))
jest.mock('../src/utils/performanceOptimizer', () => ({
  getHttpsAgentForStream: jest.fn(() => null),
  getHttpsAgentForNonStream: jest.fn(() => null),
  getPricingData: jest.fn(() => ({
    'claude-sonnet-4-6': { max_tokens: 8192 }
  }))
}))
jest.mock('../src/validators/clients/claudeCodeValidator', () => ({
  includesClaudeCodeSystemPrompt: jest.fn(() => true)
}))

const relayService = require('../src/services/relay/claudeRelayService')
const https = require('https')
const { EventEmitter } = require('events')

function ephemeral(text, ttl) {
  return {
    type: 'text',
    text,
    cache_control: ttl === undefined ? { type: 'ephemeral' } : { type: 'ephemeral', ttl }
  }
}

describe('Claude relay Anthropic cache TTL 1h helpers', () => {
  test('injects all supported existing ephemeral cache breakpoints without creating new ones', () => {
    const body = {
      cache_control: { type: 'ephemeral', ttl: '5m' },
      system: [ephemeral('system', '5m'), { type: 'text', text: 'plain' }],
      messages: [
        {
          role: 'user',
          content: [ephemeral('message'), { type: 'text', text: 'plain' }]
        }
      ],
      tools: [
        { name: 'cached', cache_control: { type: 'ephemeral', ttl: 'other' } },
        { name: 'plain' }
      ]
    }

    expect(relayService._injectAnthropicCacheTtl1h(body)).toBe(true)
    expect(body.cache_control.ttl).toBe('1h')
    expect(body.system[0].cache_control.ttl).toBe('1h')
    expect(body.messages[0].content[0].cache_control.ttl).toBe('1h')
    expect(body.tools[0].cache_control.ttl).toBe('1h')
    expect(body.system[1].cache_control).toBeUndefined()
    expect(body.messages[0].content[1].cache_control).toBeUndefined()
    expect(body.tools[1].cache_control).toBeUndefined()
    expect(relayService._injectAnthropicCacheTtl1h(body)).toBe(false)
  })

  test('skips malformed and non-ephemeral cache controls', () => {
    const body = {
      system: [
        { cache_control: null },
        { cache_control: [] },
        { cache_control: { type: 'persistent', ttl: '5m' } },
        { cache_control: { ttl: '5m' } }
      ],
      messages: [{ role: 'user', content: 'text' }],
      tools: [null, 'tool']
    }

    expect(relayService._injectAnthropicCacheTtl1h(body)).toBe(false)
    expect(body.system[2].cache_control.ttl).toBe('5m')
    expect(body.system[3].cache_control.ttl).toBe('5m')
    expect(relayService._injectAnthropicCacheTtl1h(null)).toBe(false)
    expect(relayService._injectAnthropicCacheTtl1h([])).toBe(false)
  })

  test('processes requests in strip, limit, then inject order without mutating the source', () => {
    const source = {
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      system: [
        ephemeral('system-1', '5m'),
        { type: 'text', text: 'system-2', cache_control: { type: 'persistent', ttl: '5m' } }
      ],
      messages: [
        {
          role: 'user',
          content: [
            ephemeral('message-1', '5m'),
            ephemeral('message-2', 'other'),
            ephemeral('message-3'),
            ephemeral('message-4', '1h')
          ]
        }
      ],
      tools: [{ name: 'tool', cache_control: { type: 'ephemeral', ttl: '5m' } }]
    }
    const original = structuredClone(source)

    const processed = relayService._processRequestBody(source, null, true, true)

    expect(source).toEqual(original)
    expect(processed.messages[0].content[0].cache_control).toBeUndefined()
    expect(processed.messages[0].content[1].cache_control).toBeUndefined()
    expect(processed.messages[0].content[2].cache_control.ttl).toBe('1h')
    expect(processed.messages[0].content[3].cache_control.ttl).toBe('1h')
    expect(processed.system[0].cache_control.ttl).toBe('1h')
    expect(processed.system[1].cache_control).toEqual({ type: 'persistent' })
    expect(processed.tools[0].cache_control.ttl).toBe('1h')
  })

  test('keeps the existing TTL stripping behavior when disabled', () => {
    const processed = relayService._processRequestBody(
      {
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: [ephemeral('message', '5m')] }]
      },
      null,
      true,
      false
    )

    expect(processed.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' })
  })

  test('adds and deduplicates the required beta for Haiku and non-Haiku models', () => {
    const beta = 'extended-cache-ttl-2025-04-11'
    const sonnet = relayService._getBetaHeader('claude-sonnet-4-6', beta, true).split(',')
    const haiku = relayService._getBetaHeader('claude-haiku-4-5', null, true).split(',')

    expect(sonnet.filter((value) => value === beta)).toHaveLength(1)
    expect(haiku).toContain(beta)
    expect(relayService._getBetaHeader('claude-sonnet-4-6', null, false)).not.toContain(beta)
  })

  test('reclassifies 1h cache creation tokens into 5m and remains idempotent', () => {
    const usage = {
      input_tokens: 10,
      cache_creation_input_tokens: 12,
      cache_creation: {
        ephemeral_5m_input_tokens: 5,
        ephemeral_1h_input_tokens: 7
      }
    }

    expect(relayService._reclassifyAnthropicCacheCreationUsage(usage)).toBe(true)
    expect(usage).toEqual({
      input_tokens: 10,
      cache_creation_input_tokens: 12,
      cache_creation: {
        ephemeral_5m_input_tokens: 12,
        ephemeral_1h_input_tokens: 0
      }
    })
    expect(relayService._reclassifyAnthropicCacheCreationUsage(usage)).toBe(false)
  })

  test.each([
    null,
    {},
    { cache_creation: null },
    { cache_creation: { ephemeral_5m_input_tokens: -1, ephemeral_1h_input_tokens: -2 } },
    { cache_creation: { ephemeral_5m_input_tokens: 'bad', ephemeral_1h_input_tokens: 0 } }
  ])('safely ignores unusable usage %#', (usage) => {
    expect(relayService._reclassifyAnthropicCacheCreationUsage(usage)).toBe(false)
  })

  test('rewrites only target SSE usage lines and preserves all other bytes', () => {
    const start =
      'data: {"type":"message_start","message":{"usage":{"cache_creation":{"ephemeral_5m_input_tokens":2,"ephemeral_1h_input_tokens":3}}}}'
    const delta =
      'data: {"type":"message_delta","usage":{"output_tokens":4,"cache_creation":{"ephemeral_5m_input_tokens":1,"ephemeral_1h_input_tokens":2}}}'
    const other = 'data: {"type":"content_block_delta","delta":{"text":"hello"}}'

    expect(JSON.parse(relayService._rewriteAnthropicCacheUsageSseLine(start).slice(6))).toEqual({
      type: 'message_start',
      message: {
        usage: {
          cache_creation: {
            ephemeral_5m_input_tokens: 5,
            ephemeral_1h_input_tokens: 0
          }
        }
      }
    })
    expect(JSON.parse(relayService._rewriteAnthropicCacheUsageSseLine(delta).slice(6))).toEqual({
      type: 'message_delta',
      usage: {
        output_tokens: 4,
        cache_creation: {
          ephemeral_5m_input_tokens: 3,
          ephemeral_1h_input_tokens: 0
        }
      }
    })
    expect(relayService._rewriteAnthropicCacheUsageSseLine(other)).toBe(other)
    expect(relayService._rewriteAnthropicCacheUsageSseLine('event: message_start')).toBe(
      'event: message_start'
    )
    expect(relayService._rewriteAnthropicCacheUsageSseLine('data: invalid-json')).toBe(
      'data: invalid-json'
    )
  })

  test('rewrites successful non-stream bodies while preserving invalid and error responses', () => {
    const response = {
      statusCode: 200,
      body: JSON.stringify({
        usage: {
          cache_creation: {
            ephemeral_5m_input_tokens: 4,
            ephemeral_1h_input_tokens: 6
          }
        }
      })
    }
    expect(relayService._reclassifyCacheCreationInResponse(response)).toBe(true)
    expect(JSON.parse(response.body).usage.cache_creation).toEqual({
      ephemeral_5m_input_tokens: 10,
      ephemeral_1h_input_tokens: 0
    })

    const invalid = { statusCode: 200, body: 'not-json' }
    const error = { statusCode: 400, body: response.body }
    expect(relayService._reclassifyCacheCreationInResponse(invalid)).toBe(false)
    expect(invalid.body).toBe('not-json')
    expect(relayService._reclassifyCacheCreationInResponse(error)).toBe(false)
  })

  test('forwards rewritten streaming usage and reports the same classification locally', async () => {
    const writes = []
    const responseStream = new EventEmitter()
    responseStream.writable = true
    responseStream.headersSent = true
    responseStream.write = jest.fn((value) => {
      writes.push(value)
      return true
    })
    responseStream.end = jest.fn(() => {
      responseStream.writableEnded = true
    })

    let upstreamHeaders
    const requestSpy = jest.spyOn(https, 'request').mockImplementation((options, callback) => {
      upstreamHeaders = options.headers
      const request = new EventEmitter()
      request.destroyed = false
      request.write = jest.fn()
      request.destroy = jest.fn(() => {
        request.destroyed = true
      })
      request.end = jest.fn(() => {
        const upstream = new EventEmitter()
        upstream.statusCode = 200
        upstream.statusMessage = 'OK'
        upstream.headers = {}
        callback(upstream)

        setImmediate(() => {
          const start =
            'data: {"type":"message_start","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":10,"cache_creation_input_tokens":12,"cache_read_input_tokens":2,"cache_creation":{"ephemeral_5m_input_tokens":5,"ephemeral_1h_input_tokens":7}}}}\n\n'
          const delta = 'data: {"type":"message_delta","usage":{"output_tokens":4}}'
          upstream.emit('data', start.slice(0, 50))
          upstream.emit('data', start.slice(50) + delta)
          upstream.emit('end')
        })
      })
      return request
    })

    const usageCallback = jest.fn()
    await relayService._makeClaudeStreamRequestWithUsageCapture(
      { model: 'claude-sonnet-4-6', messages: [], stream: true },
      'token',
      null,
      {},
      responseStream,
      usageCallback,
      'account-1',
      'claude-official',
      null,
      null,
      { enableCacheTtl1hInjection: true },
      false
    )

    const output = writes.join('')
    expect(output).toContain(
      '"cache_creation":{"ephemeral_5m_input_tokens":12,"ephemeral_1h_input_tokens":0}'
    )
    expect(usageCallback).toHaveBeenCalledWith({
      input_tokens: 10,
      output_tokens: 4,
      cache_creation_input_tokens: 12,
      cache_read_input_tokens: 2,
      model: 'claude-sonnet-4-6',
      cache_creation: {
        ephemeral_5m_input_tokens: 12,
        ephemeral_1h_input_tokens: 0
      }
    })
    expect(upstreamHeaders['anthropic-beta']).toContain('extended-cache-ttl-2025-04-11')
    requestSpy.mockRestore()
  })
})
