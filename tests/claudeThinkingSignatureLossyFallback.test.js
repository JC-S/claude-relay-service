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
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  performance: jest.fn(),
  api: jest.fn()
}))

jest.mock('../src/utils/proxyHelper', () => jest.fn())
jest.mock('../src/utils/headerFilter', () => ({
  filterForClaude: jest.fn((headers) => headers || {})
}))
jest.mock('../src/models/redis', () => ({}))
jest.mock('../src/services/claudeCodeHeadersService', () => ({
  storeAccountHeaders: jest.fn()
}))
jest.mock('../src/services/requestIdentityService', () => ({
  transform: jest.fn(({ body, headers }) => ({ body, headers }))
}))
jest.mock('../src/utils/testPayloadHelper', () => ({
  createClaudeTestPayload: jest.fn()
}))
jest.mock('../src/utils/performanceOptimizer', () => ({
  getHttpsAgentForStream: jest.fn(() => null),
  getHttpsAgentForNonStream: jest.fn(() => null),
  getPricingData: jest.fn(() => ({
    'claude-sonnet-4-6': { max_tokens: 8192 }
  }))
}))
jest.mock('../src/validators/clients/claudeCodeValidator', () => ({
  includesClaudeCodeSystemPrompt: jest.fn(() => false)
}))
jest.mock('../src/services/userMessageQueueService', () => ({
  isUserMessageRequest: jest.fn(() => false),
  acquireQueueLock: jest.fn(),
  releaseQueueLock: jest.fn()
}))
jest.mock('../src/services/account/claudeAccountService', () => ({
  getAccount: jest.fn(),
  getValidAccessToken: jest.fn(),
  clearExpiredModelRateLimit: jest.fn(),
  getAccountModelRateLimitInfo: jest.fn(() =>
    Promise.resolve({ isRateLimited: false, resetAt: null })
  ),
  clearInternalErrors: jest.fn(),
  isAccountOverloaded: jest.fn(),
  removeAccountOverload: jest.fn(),
  updateSessionWindowStatus: jest.fn()
}))
jest.mock('../src/services/scheduler/unifiedClaudeScheduler', () => ({
  selectAccountForApiKey: jest.fn(),
  clearSessionMapping: jest.fn(),
  isAccountRateLimited: jest.fn(),
  removeAccountRateLimit: jest.fn(),
  markAccountRateLimited: jest.fn(),
  markAccountBlocked: jest.fn()
}))
jest.mock('../src/utils/upstreamErrorHelper', () => ({
  logUpstreamErrorResponse: jest.fn(() => ({ id: 'upstream-error-1' })),
  markTempUnavailable: jest.fn(() => Promise.resolve()),
  parseRetryAfter: jest.fn(() => null)
}))

const claudeRelayService = require('../src/services/relay/claudeRelayService')
const claudeAccountService = require('../src/services/account/claudeAccountService')
const unifiedClaudeScheduler = require('../src/services/scheduler/unifiedClaudeScheduler')
const upstreamErrorHelper = require('../src/utils/upstreamErrorHelper')

function countAssistantThinkingBlocks(body) {
  return (body.messages || []).reduce((count, message) => {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) {
      return count
    }
    return count + message.content.filter((block) => block?.type === 'thinking').length
  }, 0)
}

function createRequestBody() {
  return {
    model: 'claude-sonnet-4-6',
    max_tokens: 10,
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'start' }]
      },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'internal reasoning', signature: 'bad-signature' },
          { type: 'text', text: 'answer' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }
        ]
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'continue' }]
      }
    ]
  }
}

function invalidThinkingSignatureResponse() {
  return {
    statusCode: 400,
    statusMessage: 'Bad Request',
    headers: {},
    body: JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'messages.13.content.0: Invalid `signature` in `thinking` block'
      },
      request_id: 'req_invalid_signature'
    })
  }
}

function successResponse() {
  return {
    statusCode: 200,
    statusMessage: 'OK',
    headers: {},
    body: JSON.stringify({
      id: 'msg_1',
      type: 'message',
      usage: { input_tokens: 1, output_tokens: 2 },
      content: [{ type: 'text', text: 'ok' }]
    })
  }
}

describe('Claude official thinking signature lossy fallback', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.restoreAllMocks()
    claudeRelayService.bodyStore.clear()

    unifiedClaudeScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'official-1',
      accountType: 'claude-official'
    })
    unifiedClaudeScheduler.isAccountRateLimited.mockResolvedValue(false)

    claudeAccountService.getAccount.mockResolvedValue({
      id: 'official-1',
      name: 'Official OAuth'
    })
    claudeAccountService.getValidAccessToken.mockResolvedValue('access-token')
    claudeAccountService.clearInternalErrors.mockResolvedValue()
    claudeAccountService.isAccountOverloaded.mockResolvedValue(false)

    jest.spyOn(claudeRelayService, '_getProxyAgent').mockResolvedValue(null)
    jest.spyOn(claudeRelayService, 'clearUnauthorizedErrors').mockResolvedValue()
  })

  test('detects only invalid thinking signature 400 responses', () => {
    expect(
      claudeRelayService._isInvalidThinkingSignatureError(400, {
        error: { message: 'messages.13.content.0: Invalid `signature` in `thinking` block' }
      })
    ).toBe(true)

    expect(
      claudeRelayService._isInvalidThinkingSignatureError(400, {
        error: { message: 'prompt is too long' }
      })
    ).toBe(false)
    expect(
      claudeRelayService._isInvalidThinkingSignatureError(429, {
        error: { message: 'Invalid `signature` in `thinking` block' }
      })
    ).toBe(false)
  })

  test('strips only assistant thinking blocks and preserves other content', () => {
    const source = {
      messages: [
        {
          role: 'user',
          content: [{ type: 'thinking', thinking: 'user block should remain' }]
        },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'remove me', signature: 'bad' },
            { type: 'text', text: 'keep me' },
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }
          ]
        },
        {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'empty after strip', signature: 'bad-2' }]
        }
      ],
      thinking: { type: 'enabled', budget_tokens: 1024 }
    }

    const result = claudeRelayService._stripAssistantThinkingBlocksForOfficialFallback(source)

    expect(result.strippedCount).toBe(2)
    expect(result.removedEmptyAssistantMessages).toBe(1)
    expect(result.body.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 })
    expect(result.body.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'thinking', thinking: 'user block should remain' }]
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'keep me' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }
        ]
      }
    ])
    expect(source.messages[1].content[0].type).toBe('thinking')
  })

  test('respects toggle, account type, and one-shot retry guard', () => {
    const { body } = invalidThinkingSignatureResponse()

    expect(
      claudeRelayService._canRetryWithClaudeThinkingSignatureLossyFallback({
        apiKeyData: { enableClaudeThinkingSignatureLossyFallback: true },
        accountType: 'claude-official',
        statusCode: 400,
        body
      })
    ).toBe(true)

    expect(
      claudeRelayService._canRetryWithClaudeThinkingSignatureLossyFallback({
        apiKeyData: { enableClaudeThinkingSignatureLossyFallback: false },
        accountType: 'claude-official',
        statusCode: 400,
        body
      })
    ).toBe(false)
    expect(
      claudeRelayService._canRetryWithClaudeThinkingSignatureLossyFallback({
        apiKeyData: { enableClaudeThinkingSignatureLossyFallback: true },
        accountType: 'claude-console',
        statusCode: 400,
        body
      })
    ).toBe(false)
    expect(
      claudeRelayService._canRetryWithClaudeThinkingSignatureLossyFallback({
        apiKeyData: { enableClaudeThinkingSignatureLossyFallback: true },
        requestOptions: { claudeThinkingSignatureLossyFallbackTried: true },
        accountType: 'claude-official',
        statusCode: 400,
        body
      })
    ).toBe(false)
  })

  test('retries non-stream official OAuth once with stripped thinking blocks when enabled', async () => {
    const makeRequest = jest
      .spyOn(claudeRelayService, '_makeClaudeRequest')
      .mockResolvedValueOnce(invalidThinkingSignatureResponse())
      .mockResolvedValueOnce(successResponse())

    const response = await claudeRelayService.relayRequest(
      createRequestBody(),
      {
        id: 'key-1',
        name: 'Key 1',
        enableClaudeThinkingSignatureLossyFallback: true
      },
      null,
      null,
      { 'user-agent': 'test-client/1.0' }
    )

    expect(response.statusCode).toBe(200)
    expect(makeRequest).toHaveBeenCalledTimes(2)
    expect(makeRequest.mock.calls[0][4]).toBe('official-1')
    expect(makeRequest.mock.calls[1][4]).toBe('official-1')
    expect(countAssistantThinkingBlocks(makeRequest.mock.calls[0][0])).toBe(1)
    expect(countAssistantThinkingBlocks(makeRequest.mock.calls[1][0])).toBe(0)
    expect(upstreamErrorHelper.logUpstreamErrorResponse).not.toHaveBeenCalled()
  })

  test('does not retry when the API key toggle is disabled', async () => {
    const makeRequest = jest
      .spyOn(claudeRelayService, '_makeClaudeRequest')
      .mockResolvedValueOnce(invalidThinkingSignatureResponse())

    const response = await claudeRelayService.relayRequest(
      createRequestBody(),
      {
        id: 'key-1',
        name: 'Key 1',
        enableClaudeThinkingSignatureLossyFallback: false
      },
      null,
      null,
      { 'user-agent': 'test-client/1.0' }
    )

    expect(response.statusCode).toBe(400)
    expect(makeRequest).toHaveBeenCalledTimes(1)
    expect(upstreamErrorHelper.logUpstreamErrorResponse).toHaveBeenCalledTimes(1)
  })

  test('does not retry more than once when the stripped retry still fails', async () => {
    const makeRequest = jest
      .spyOn(claudeRelayService, '_makeClaudeRequest')
      .mockResolvedValueOnce(invalidThinkingSignatureResponse())
      .mockResolvedValueOnce(invalidThinkingSignatureResponse())

    const response = await claudeRelayService.relayRequest(
      createRequestBody(),
      {
        id: 'key-1',
        name: 'Key 1',
        enableClaudeThinkingSignatureLossyFallback: true
      },
      null,
      null,
      { 'user-agent': 'test-client/1.0' }
    )

    expect(response.statusCode).toBe(400)
    expect(makeRequest).toHaveBeenCalledTimes(2)
    expect(upstreamErrorHelper.logUpstreamErrorResponse).toHaveBeenCalledTimes(1)
  })
})
