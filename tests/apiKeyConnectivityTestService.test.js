const { EventEmitter } = require('events')

jest.mock('axios', () => ({ post: jest.fn() }))
jest.mock('../src/utils/testPayloadHelper', () => {
  const actual = jest.requireActual('../src/utils/testPayloadHelper')
  return { ...actual, sendStreamTestRequest: jest.fn() }
})

const axios = require('axios')
const { sendStreamTestRequest } = require('../src/utils/testPayloadHelper')
const {
  sanitizeMaxTokens,
  validateV2ConnectivityTestParams,
  runClaudeKeyTest,
  runGeminiKeyTest,
  runOpenAIKeyTest
} = require('../src/services/apiKeyConnectivityTestService')

function createResponseStream() {
  return {
    headersSent: false,
    destroyed: false,
    writableEnded: false,
    chunks: [],
    writeHead: jest.fn(function writeHead() {
      this.headersSent = true
    }),
    write: jest.fn(function write(chunk) {
      this.chunks.push(chunk)
    }),
    end: jest.fn(function end() {
      this.writableEnded = true
    })
  }
}

function createUpstream(status = 200) {
  return { status, data: new EventEmitter() }
}

describe('apiKeyConnectivityTestService validation', () => {
  test.each(['gpt-5.6-luna', 'claude-sonnet-4-6[1m]', 'gemini-2.5-pro'])(
    'accepts supported model syntax: %s',
    (model) => {
      expect(
        validateV2ConnectivityTestParams({ service: 'claude', model, prompt: '', maxTokens: 500 })
      ).toEqual({ service: 'claude', model, prompt: '', maxTokens: 500 })
    }
  )

  test.each([
    [{ service: 'droid' }, 'Unsupported test service'],
    [{ service: 'claude', model: '../model' }, 'Invalid model'],
    [{ service: 'claude', model: 'model?x=1' }, 'Invalid model'],
    [{ service: 'claude', model: 'a'.repeat(201) }, 'Invalid model'],
    [{ service: 'claude', prompt: 'x'.repeat(2001) }, 'Invalid prompt']
  ])('rejects invalid V2 parameters', (params, message) => {
    expect(() => validateV2ConnectivityTestParams(params)).toThrow(message)
  })

  test('uses service defaults and normalizes maxTokens without rejecting the request', () => {
    expect(validateV2ConnectivityTestParams({ service: 'openai', maxTokens: 999 })).toEqual({
      service: 'openai',
      model: 'gpt-5.4',
      prompt: 'hi',
      maxTokens: 1000
    })
    expect(sanitizeMaxTokens('4096')).toBe(4096)
  })
})

describe('apiKeyConnectivityTestService execution', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('delegates Claude SSE ownership to sendStreamTestRequest and forwards a valid client IP', async () => {
    sendStreamTestRequest.mockResolvedValue()
    const responseStream = createResponseStream()

    await runClaudeKeyTest({
      apiKey: 'cr_secret',
      model: 'claude-sonnet-4-6[1m]',
      prompt: 'hi',
      maxTokens: 100,
      responseStream,
      clientIp: '203.0.113.9'
    })

    expect(responseStream.writeHead).not.toHaveBeenCalled()
    expect(sendStreamTestRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: 'cr_secret',
        responseStream,
        timeout: 60000,
        sanitize: false,
        extraHeaders: expect.objectContaining({ 'cf-connecting-ip': '203.0.113.9' })
      })
    )
  })

  test.each([
    ['gemini', runGeminiKeyTest, '/gemini/v1/models/gemini-2.5-pro:streamGenerateContent'],
    ['openai', runOpenAIKeyTest, '/openai/responses']
  ])('keeps %s transport semantics and forwards client IP', async (service, runner, urlPart) => {
    const upstream = createUpstream()
    axios.post.mockResolvedValue(upstream)
    const responseStream = createResponseStream()

    await runner({
      apiKey: 'cr_secret',
      model: service === 'gemini' ? 'gemini-2.5-pro' : 'gpt-5.6-luna',
      prompt: 'hello',
      maxTokens: 500,
      responseStream,
      clientIp: '2001:db8::10'
    })

    const [url, , options] = axios.post.mock.calls[0]
    expect(url).toContain(urlPart)
    expect(options).toEqual(expect.objectContaining({ timeout: 60000, responseType: 'stream' }))
    expect(options.headers['x-api-key']).toBe('cr_secret')
    expect(options.headers['cf-connecting-ip']).toBe('2001:db8::10')
    expect(responseStream.chunks[0]).toContain('test_start')

    upstream.data.emit('end')
    expect(responseStream.chunks.at(-1)).toContain('test_complete')
    expect(responseStream.end).toHaveBeenCalledTimes(1)
  })

  test('does not add a source-IP header for old callers that omit clientIp', async () => {
    const upstream = createUpstream()
    axios.post.mockResolvedValue(upstream)

    await runGeminiKeyTest({
      apiKey: 'cr_secret',
      responseStream: createResponseStream()
    })

    expect(axios.post.mock.calls[0][2].headers).not.toHaveProperty('cf-connecting-ip')
  })
})
