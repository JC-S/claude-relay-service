jest.mock('../src/utils/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  success: jest.fn()
}))

const GrokSSEFrameParser = require('../src/utils/grokSSEFrameParser')
const pricingService = require('../src/services/pricingService')
const {
  sanitizeGrokResponsesBody,
  deriveGrokSessionSeed,
  buildGrokCacheIdentity,
  applyGrokCacheIdentity,
  buildGrokUpstreamUrl,
  buildGrokUpstreamHeaders,
  hasTrustworthyGrokUsage
} = require('../src/utils/grokRequestHelper')
const {
  GROK_MODELS,
  normalizeGrokModelName,
  resolveGrokModel,
  resolveGrokBillingModel,
  isAccountSupportedGrokModel
} = require('../src/utils/grokModelHelper')
const {
  QUOTA_HEADER_ALLOWLIST,
  parseResetAt,
  parseRetryAfterSeconds,
  parseQuotaHeaders,
  getQuotaCooldownSeconds
} = require('../src/utils/grokQuotaHelper')

describe('Grok protocol helpers', () => {
  test('publishes the seven text models and resolves aliases after account mapping', () => {
    expect(GROK_MODELS).toHaveLength(7)
    expect(normalizeGrokModelName('xai/GROK-LATEST')).toBe('grok-4.5')
    expect(resolveGrokModel('custom', { custom: 'grok-build' })).toBe('grok-build-0.1')
    expect(resolveGrokModel('misspelled')).toBe('misspelled')
  })

  test('accepts synchronized models only for API key accounts', () => {
    const supportedModels = ['grok-new-text-model']
    expect(
      isAccountSupportedGrokModel('grok-new-text-model', {
        authType: 'api_key',
        supportedModels
      })
    ).toBe(true)
    expect(
      isAccountSupportedGrokModel('grok-new-text-model', {
        authType: 'oauth',
        supportedModels
      })
    ).toBe(false)
  })

  test('prefers a priced actual model and falls back to the mapped model when it is unpriced', () => {
    const pricing = {
      input_cost_per_token: 0.000001,
      output_cost_per_token: 0.000002
    }
    const pricingSpy = jest
      .spyOn(pricingService, 'getModelPricing')
      .mockImplementation((model) =>
        ['grok-actual-version', 'grok-4.5'].includes(model) ? pricing : null
      )

    expect(resolveGrokBillingModel('grok-actual-version', 'grok-4.5')).toBe(
      'grok-actual-version'
    )
    expect(resolveGrokBillingModel('grok-unpriced-version', 'grok-4.5')).toBe('grok-4.5')

    pricingSpy.mockRestore()
  })

  test('sanitizes unsupported Responses fields without mutating the source', () => {
    const source = {
      model: 'grok-composer',
      reasoning: { effort: 'high' },
      prompt_cache_retention: '24h',
      external_web_access: true,
      input: [
        { type: 'additional_tools' },
        { type: 'reasoning', content: null },
        { type: 'message', role: 'user', content: 'hello', external_web_access: true }
      ],
      tools: [
        { type: 'function', name: 'kept' },
        { type: 'computer_use', name: 'removed' }
      ],
      tool_choice: { type: 'function', name: 'removed' }
    }
    const result = sanitizeGrokResponsesBody(source, 'grok-composer-2.5-fast')

    expect(result.reasoning).toBeUndefined()
    expect(result.input).toEqual([
      { type: 'reasoning' },
      { type: 'message', role: 'user', content: 'hello' }
    ])
    expect(result.tools).toEqual([{ type: 'function', name: 'kept' }])
    expect(result.tool_choice).toBeUndefined()
    expect(source.reasoning).toBeDefined()
    expect(source.input).toHaveLength(3)
  })

  test('derives stable tenant-isolated UUID cache identities', () => {
    const seed = deriveGrokSessionSeed({ session_id: 'conversation-a' }, { model: 'grok-4.5' })
    const first = buildGrokCacheIdentity('key-a', 'grok-4.5', seed)
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(buildGrokCacheIdentity('key-a', 'grok-4.5', seed)).toBe(first)
    expect(buildGrokCacheIdentity('key-b', 'grok-4.5', seed)).not.toBe(first)
  })

  test('uses prefix and anchored-content seeds without model-wide fallback', () => {
    expect(deriveGrokSessionSeed({}, { instructions: 'fixed' })).toMatch(/^prefix:/)
    expect(deriveGrokSessionSeed({}, { model: 'grok-4.5', input: 'first user message' })).toMatch(
      /^anchor:/
    )
    expect(deriveGrokSessionSeed({}, { model: 'grok-4.5', input: [] })).toBe('')
  })

  test('injects native cache tools only for tool-free OAuth intent', () => {
    const base = { model: 'grok-4.5', prompt_cache_key: 'client-value' }
    expect(applyGrokCacheIdentity(base, base, 'server-id', 'oauth')).toEqual(
      expect.objectContaining({
        prompt_cache_key: 'server-id',
        tools: [{ type: 'web_search' }, { type: 'x_search' }],
        tool_choice: 'none'
      })
    )
    const explicit = { ...base, tools: [{ type: 'unsupported' }] }
    expect(applyGrokCacheIdentity(base, explicit, 'server-id', 'oauth').tools).toBeUndefined()
    expect(applyGrokCacheIdentity(base, base, '', 'api_key').prompt_cache_key).toBeUndefined()
  })

  test('builds host-bound identity headers and never reuses downstream UA', () => {
    expect(buildGrokUpstreamUrl('oauth')).toBe('https://cli-chat-proxy.grok.com/v1/responses')
    expect(buildGrokUpstreamUrl('api_key')).toBe('https://api.x.ai/v1/responses')
    const oauthHeaders = buildGrokUpstreamHeaders({
      authType: 'oauth',
      token: 'secret',
      cacheIdentity: 'cache-id',
      downstreamHeaders: { 'openai-beta': 'feature' }
    })
    expect(oauthHeaders).toEqual(
      expect.objectContaining({
        'User-Agent': 'xai-grok-workspace/0.2.93',
        'X-XAI-Token-Auth': 'xai-grok-cli',
        'X-Grok-Conv-Id': 'cache-id',
        'OpenAI-Beta': 'feature'
      })
    )
    expect(buildGrokUpstreamHeaders({ authType: 'api_key', token: 'secret' })).not.toHaveProperty(
      'X-XAI-Token-Auth'
    )
  })

  test('distinguishes absent usage from explicit all-zero usage', () => {
    expect(hasTrustworthyGrokUsage(null)).toBe(false)
    expect(hasTrustworthyGrokUsage({})).toBe(false)
    expect(hasTrustworthyGrokUsage({ input_tokens: 0, output_tokens: 0 })).toBe(true)
    expect(hasTrustworthyGrokUsage({ input_tokens: null, output_tokens: null })).toBe(false)
    expect(hasTrustworthyGrokUsage({ input_tokens: '0' })).toBe(false)
    expect(hasTrustworthyGrokUsage({ input_tokens: -1 })).toBe(false)
  })

  test('preserves raw LF and CRLF frames across arbitrary chunks', () => {
    const parser = new GrokSSEFrameParser()
    const source = Buffer.from(
      'event: response.created\r\ndata: {"type":"response.created","text":"你"}\r\n\r\n' +
        'data: {"type":"response.output_text.delta","delta":"ok"}\n\n'
    )
    const frames = [
      ...parser.feed(source.subarray(0, 17)),
      ...parser.feed(source.subarray(17, 53)),
      ...parser.feed(source.subarray(53))
    ]
    expect(frames).toHaveLength(2)
    expect(Buffer.concat(frames.map((frame) => frame.raw))).toEqual(source)
    expect(frames[0].type).toBe('response.created')
    expect(frames[1].payload.delta).toBe('ok')
    expect(parser.bufferedBytes).toBe(0)
  })

  test('retains an incomplete raw frame for bounded-prelude handling', () => {
    const parser = new GrokSSEFrameParser()
    const partial = Buffer.from('data: {"type":"response.created"}')
    expect(parser.feed(partial)).toEqual([])
    expect(parser.bufferedBytes).toBe(partial.length)
    expect(parser.takeBuffered()).toEqual(partial)
  })

  test('bounds a discarded oversized frame and resumes parsing after its delimiter', () => {
    const parser = new GrokSSEFrameParser()
    parser.feed(Buffer.alloc(300 * 1024, 97))
    parser.discardCurrentFrame()
    expect(parser.bufferedBytes).toBeLessThanOrEqual(3)

    const frames = parser.feed(
      Buffer.from(
        '\n\nevent: response.completed\ndata: {"type":"response.completed"}\n\n'
      )
    )

    expect(frames).toHaveLength(1)
    expect(frames[0].type).toBe('response.completed')
    expect(parser.bufferedBytes).toBe(0)
  })

  test('captures exactly eleven quota headers and parses reset formats', () => {
    expect(QUOTA_HEADER_ALLOWLIST).toHaveLength(11)
    const snapshot = parseQuotaHeaders(
      {
        'x-ratelimit-limit-requests': '100',
        'x-ratelimit-remaining-requests': '0',
        'x-ratelimit-reset-requests': '1780000000000',
        'x-ignored': 'nope'
      },
      429
    )
    expect(snapshot.headers).not.toHaveProperty('x-ignored')
    expect(snapshot.requests.resetAt).toBe(new Date(1780000000000).toISOString())
    expect(parseResetAt('2026-08-01T00:00:00Z')).toBe('2026-08-01T00:00:00.000Z')
    expect(parseRetryAfterSeconds('120', 0)).toBe(120)
    expect(parseRetryAfterSeconds('Wed, 15 Jul 2026 00:02:00 GMT', Date.UTC(2026, 6, 15))).toBe(
      120
    )
    expect(getQuotaCooldownSeconds({ retryAfterSeconds: 42 }, Date.now())).toBe(42)
  })
})
