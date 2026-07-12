const express = require('express')
const request = require('supertest')

let mockApiKeyData

jest.mock('../src/middleware/auth', () => ({
  authenticateApiKey: jest.fn((req, _res, next) => {
    req.apiKey = { ...mockApiKeyData }
    next()
  })
}))

jest.mock('../src/services/apiKeyService', () => ({
  hasPermission: jest.fn(() => true)
}))

jest.mock('../src/services/relay/claudeRelayService', () => ({
  relayRequest: jest.fn(),
  relayStreamRequestWithUsageCapture: jest.fn(),
  _buildStandardRateLimitMessage: jest.fn(() => 'rate limited')
}))

jest.mock('../src/services/relay/claudeConsoleRelayService', () => ({
  relayRequest: jest.fn(),
  relayStreamRequestWithUsageCapture: jest.fn()
}))

jest.mock('../src/services/relay/bedrockRelayService', () => ({
  handleStreamRequest: jest.fn(),
  handleNonStreamRequest: jest.fn()
}))

jest.mock('../src/services/relay/ccrRelayService', () => ({
  relayRequest: jest.fn(),
  relayStreamRequestWithUsageCapture: jest.fn()
}))

jest.mock('../src/services/account/bedrockAccountService', () => ({
  getAccount: jest.fn()
}))

jest.mock('../src/services/account/claudeAccountService', () => ({
  getAccount: jest.fn()
}))

jest.mock('../src/services/account/claudeConsoleAccountService', () => ({
  getAccount: jest.fn(),
  isCountTokensUnavailable: jest.fn(),
  markCountTokensUnavailable: jest.fn()
}))

jest.mock('../src/services/scheduler/unifiedClaudeScheduler', () => ({
  selectAccountForApiKey: jest.fn(),
  clearSessionMapping: jest.fn()
}))

jest.mock('../src/services/claudeRelayConfigService', () => ({
  isGlobalSessionBindingEnabled: jest.fn(() => Promise.resolve(false)),
  isExportControlledClaudeModelBlockEnabled: jest.fn(() => Promise.resolve(true)),
  extractOriginalSessionId: jest.fn(() => null),
  validateNewSession: jest.fn(() => Promise.resolve({ valid: true, isNewSession: false })),
  getSessionBindingErrorMessage: jest.fn(() => Promise.resolve('session binding error'))
}))

jest.mock('../src/services/claudeCodeHeadersService', () => ({
  getAccountHeaders: jest.fn(() => Promise.resolve({}))
}))

jest.mock('../src/services/pricingService', () => ({
  getModelPricing: jest.fn()
}))

jest.mock('../src/services/anthropicGeminiBridgeService', () => ({
  handleAnthropicMessagesToGemini: jest.fn(),
  handleAnthropicCountTokensToGemini: jest.fn()
}))

jest.mock('../src/utils/rateLimitHelper', () => ({
  updateRateLimitCounters: jest.fn(() => Promise.resolve({ totalTokens: 0, totalCost: 0 }))
}))

jest.mock('../src/utils/anthropicRequestDump', () => ({
  dumpAnthropicMessagesRequest: jest.fn()
}))

jest.mock('../src/utils/requestDetailHelper', () => ({
  createRequestDetailMeta: jest.fn(() => ({}))
}))

jest.mock('../src/utils/errorSanitizer', () => ({
  sanitizeUpstreamError: jest.fn((error) => error),
  getSafeMessage: jest.fn((error) => error.message)
}))

jest.mock('../src/utils/logger', () => ({
  api: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn()
}))

const apiRoutes = require('../src/routes/api')
const openaiClaudeRoutes = require('../src/routes/openaiClaudeRoutes')
const claudeRelayService = require('../src/services/relay/claudeRelayService')
const claudeRelayConfigService = require('../src/services/claudeRelayConfigService')
const unifiedClaudeScheduler = require('../src/services/scheduler/unifiedClaudeScheduler')
const {
  EXPORT_CONTROLLED_CLAUDE_MODEL_MESSAGE,
  isExportControlledClaudeModel,
  isClaudeFableModel
} = require('../src/utils/modelHelper')
const {
  CLAUDE_FAST_MODE_BETA,
  CLAUDE_FAST_MODE_DISABLED_MESSAGE
} = require('../src/utils/claudeFastModeGuard')

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api', apiRoutes)
  app.use('/openai/claude', openaiClaudeRoutes)
  return app
}

function claudeMessagesBody(model) {
  return {
    model,
    max_tokens: 8,
    messages: [{ role: 'user', content: 'test' }]
  }
}

function successfulClaudeResponse() {
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-fable-5',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn'
    }),
    accountId: 'account_1'
  }
}

describe('export-controlled Claude model block', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    claudeRelayConfigService.isExportControlledClaudeModelBlockEnabled.mockResolvedValue(true)
    unifiedClaudeScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'account_1',
      accountType: 'claude-official'
    })
    claudeRelayService.relayRequest.mockResolvedValue(successfulClaudeResponse())
    mockApiKeyData = {
      id: 'key_1',
      name: 'test key',
      permissions: ['claude'],
      enableModelRestriction: false,
      restrictedModels: []
    }
  })

  test('detects claude-fable-5 and its 1m variant after vendor-prefix normalization', () => {
    expect(isExportControlledClaudeModel('claude-fable-5')).toBe(true)
    expect(isExportControlledClaudeModel('claude-fable-5[1m]')).toBe(true)
    expect(isExportControlledClaudeModel('ccr,CLAUDE-FABLE-5[1m]')).toBe(true)
    expect(isExportControlledClaudeModel('claude-opus-4-7')).toBe(false)
    expect(isClaudeFableModel('claude-fable-5')).toBe(true)
    expect(isClaudeFableModel('claude-fable-5[1m]')).toBe(true)
    expect(isClaudeFableModel('ccr,CLAUDE-FABLE-5[1m]')).toBe(true)
    expect(isClaudeFableModel('claude-opus-4-7')).toBe(false)
    expect(isClaudeFableModel('fable')).toBe(false)
  })

  test('blocks Anthropic messages requests before scheduler or relay', async () => {
    const app = buildApp()

    const response = await request(app)
      .post('/api/v1/messages')
      .send(claudeMessagesBody('claude-fable-5'))

    expect(response.status).toBe(404)
    expect(response.body.error).toEqual({
      type: 'not_found_error',
      message: EXPORT_CONTROLLED_CLAUDE_MODEL_MESSAGE
    })
    expect(unifiedClaudeScheduler.selectAccountForApiKey).not.toHaveBeenCalled()
    expect(claudeRelayService.relayRequest).not.toHaveBeenCalled()
    expect(claudeRelayService.relayStreamRequestWithUsageCapture).not.toHaveBeenCalled()
  })

  test('allows Anthropic messages requests to continue when the system toggle is off', async () => {
    claudeRelayConfigService.isExportControlledClaudeModelBlockEnabled.mockResolvedValue(false)
    const app = buildApp()

    const response = await request(app)
      .post('/api/v1/messages')
      .send(claudeMessagesBody('claude-fable-5'))

    expect(response.status).toBe(200)
    expect(response.body.content).toEqual([{ type: 'text', text: 'ok' }])
    expect(unifiedClaudeScheduler.selectAccountForApiKey).toHaveBeenCalled()
    expect(claudeRelayService.relayRequest).toHaveBeenCalled()
  })

  test('blocks Anthropic count_tokens requests before scheduler or relay', async () => {
    const app = buildApp()

    const response = await request(app)
      .post('/api/v1/messages/count_tokens')
      .send(claudeMessagesBody('claude-fable-5[1m]'))

    expect(response.status).toBe(404)
    expect(response.body.error).toEqual({
      type: 'not_found_error',
      message: EXPORT_CONTROLLED_CLAUDE_MODEL_MESSAGE
    })
    expect(unifiedClaudeScheduler.selectAccountForApiKey).not.toHaveBeenCalled()
    expect(claudeRelayService.relayRequest).not.toHaveBeenCalled()
  })

  test('blocks OpenAI-compatible Claude requests before scheduler or relay', async () => {
    const app = buildApp()

    const response = await request(app)
      .post('/openai/claude/v1/chat/completions')
      .send({
        model: 'claude-fable-5[1m]',
        messages: [{ role: 'user', content: 'test' }]
      })

    expect(response.status).toBe(404)
    expect(response.body.error).toEqual({
      message: EXPORT_CONTROLLED_CLAUDE_MODEL_MESSAGE,
      type: 'invalid_request_error',
      code: 'model_not_found'
    })
    expect(unifiedClaudeScheduler.selectAccountForApiKey).not.toHaveBeenCalled()
    expect(claudeRelayService.relayRequest).not.toHaveBeenCalled()
    expect(claudeRelayService.relayStreamRequestWithUsageCapture).not.toHaveBeenCalled()
  })

  test('allows OpenAI-compatible Claude requests to continue when the system toggle is off', async () => {
    claudeRelayConfigService.isExportControlledClaudeModelBlockEnabled.mockResolvedValue(false)
    const app = buildApp()

    const response = await request(app)
      .post('/openai/claude/v1/chat/completions')
      .send({
        model: 'claude-fable-5[1m]',
        messages: [{ role: 'user', content: 'test' }]
      })

    expect(response.status).toBe(200)
    expect(response.body.choices?.[0]?.message?.content).toBe('ok')
    expect(unifiedClaudeScheduler.selectAccountForApiKey).toHaveBeenCalled()
    expect(claudeRelayService.relayRequest).toHaveBeenCalled()
  })
})

describe('Claude Fast Mode block', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    claudeRelayConfigService.isExportControlledClaudeModelBlockEnabled.mockResolvedValue(false)
    unifiedClaudeScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'account_1',
      accountType: 'claude-official'
    })
    claudeRelayService.relayRequest.mockResolvedValue(successfulClaudeResponse())
    mockApiKeyData = {
      id: 'key_1',
      name: 'test key',
      permissions: ['claude'],
      enableModelRestriction: false,
      restrictedModels: []
    }
  })

  function expectFastModeError(response) {
    expect(response.status).toBe(400)
    expect(response.body).toEqual({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: CLAUDE_FAST_MODE_DISABLED_MESSAGE
      }
    })
    expect(unifiedClaudeScheduler.selectAccountForApiKey).not.toHaveBeenCalled()
    expect(claudeRelayService.relayRequest).not.toHaveBeenCalled()
    expect(claudeRelayService.relayStreamRequestWithUsageCapture).not.toHaveBeenCalled()
  }

  test('blocks an Anthropic request with speed=fast before scheduling', async () => {
    const response = await request(buildApp())
      .post('/api/v1/messages')
      .send({ ...claudeMessagesBody('claude-opus-4-8'), speed: 'fast', stream: true })

    expectFastModeError(response)
    expect(response.headers['content-type']).toMatch(/^application\/json/)
  })

  test('blocks an Anthropic request with the Fast Mode beta before scheduling', async () => {
    const response = await request(buildApp())
      .post('/api/v1/messages')
      .set('anthropic-beta', `context-1m-2025-08-07,${CLAUDE_FAST_MODE_BETA}`)
      .send(claudeMessagesBody('claude-opus-4-8'))

    expectFastModeError(response)
  })

  test('blocks Fast Mode on count_tokens before scheduling', async () => {
    const response = await request(buildApp())
      .post('/api/v1/messages/count_tokens')
      .send({ ...claudeMessagesBody('claude-opus-4-8'), speed: 'fast' })

    expectFastModeError(response)
  })

  test('blocks Fast Mode on the OpenAI-compatible Claude route', async () => {
    const response = await request(buildApp())
      .post('/openai/claude/v1/chat/completions')
      .send({
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'test' }],
        speed: 'fast'
      })

    expectFastModeError(response)
  })

  test('blocks Fast Mode on the legacy OpenAI-compatible completions route', async () => {
    const response = await request(buildApp()).post('/openai/claude/v1/completions').send({
      model: 'claude-opus-4-8',
      prompt: 'test',
      speed: 'fast'
    })

    expectFastModeError(response)
  })

  test('allows a standard Claude request to continue', async () => {
    const response = await request(buildApp())
      .post('/api/v1/messages')
      .set('anthropic-beta', 'context-1m-2025-08-07')
      .send({ ...claudeMessagesBody('claude-opus-4-8'), speed: 'standard' })

    expect(response.status).toBe(200)
    expect(unifiedClaudeScheduler.selectAccountForApiKey).toHaveBeenCalledTimes(1)
    expect(claudeRelayService.relayRequest).toHaveBeenCalledTimes(1)
  })
})
