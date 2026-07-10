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
  hasPermission: jest.fn(),
  recordUsage: jest.fn()
}))

jest.mock('../src/services/relay/claudeRelayService', () => ({
  relayRequest: jest.fn(),
  relayStreamRequestWithUsageCapture: jest.fn(),
  _buildStandardRateLimitMessage: jest.fn(
    () => "This dedicated account has hit Anthropic's rate limit."
  ),
  _buildOpusLimitMessage: jest.fn(
    () =>
      'This dedicated account has reached the weekly usage limit for Opus models. Please switch to another model and try again.'
  )
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
  isGlobalSessionBindingEnabled: jest.fn(),
  isExportControlledClaudeModelBlockEnabled: jest.fn(),
  extractOriginalSessionId: jest.fn(),
  validateNewSession: jest.fn(),
  getSessionBindingErrorMessage: jest.fn(),
  getConfig: jest.fn(),
  setOriginalSessionBinding: jest.fn()
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

const apiKeyService = require('../src/services/apiKeyService')
const claudeRelayConfigService = require('../src/services/claudeRelayConfigService')
const unifiedClaudeScheduler = require('../src/services/scheduler/unifiedClaudeScheduler')
const apiRoutes = require('../src/routes/api')

const CLAUDE_PERMISSION_MESSAGE =
  'This API key does not have permission to access the Claude service.'
const GEMINI_PERMISSION_MESSAGE =
  'This API key does not have permission to access the Gemini service.'
const MODEL_RESTRICTION_MESSAGE =
  'This API key does not have permission to access the requested model.'
const SESSION_MESSAGE = 'Your local session is no longer valid. Please clear it and try again.'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    if (req.headers['x-test-vendor']) {
      req._anthropicVendor = req.headers['x-test-vendor']
    }
    next()
  })
  app.use('/api', apiRoutes)
  return app
}

function messagesBody(overrides = {}) {
  return {
    model: 'claude-sonnet-4-5',
    max_tokens: 8,
    messages: [{ role: 'user', content: 'test' }],
    ...overrides
  }
}

function responseBody(response) {
  if (response.body && Object.keys(response.body).length > 0) {
    return response.body
  }
  return JSON.parse(response.text)
}

describe('user-facing English messages from Anthropic-compatible routes', () => {
  let app

  beforeEach(() => {
    jest.clearAllMocks()
    app = buildApp()
    mockApiKeyData = {
      id: 'key_1',
      name: 'test key',
      permissions: ['claude'],
      enableModelRestriction: false,
      restrictedModels: []
    }
    apiKeyService.hasPermission.mockImplementation((permissions, service) =>
      Array.isArray(permissions) ? permissions.includes(service) : false
    )
    claudeRelayConfigService.isGlobalSessionBindingEnabled.mockResolvedValue(false)
    claudeRelayConfigService.isExportControlledClaudeModelBlockEnabled.mockResolvedValue(false)
    claudeRelayConfigService.extractOriginalSessionId.mockReturnValue(null)
    claudeRelayConfigService.validateNewSession.mockResolvedValue({ valid: true })
    claudeRelayConfigService.getSessionBindingErrorMessage.mockResolvedValue(SESSION_MESSAGE)
    claudeRelayConfigService.getConfig.mockResolvedValue({
      sessionBindingErrorMessage: SESSION_MESSAGE
    })
  })

  test('returns the Claude permission message from /v1/messages', async () => {
    mockApiKeyData.permissions = ['gemini']

    const response = await request(app).post('/api/v1/messages').send(messagesBody())

    expect(response.status).toBe(403)
    expect(response.body.error).toEqual({
      type: 'permission_error',
      message: CLAUDE_PERMISSION_MESSAGE
    })
  })

  test('returns the Gemini permission message for a forced Gemini request', async () => {
    const response = await request(app)
      .post('/api/v1/messages')
      .set('x-test-vendor', 'antigravity')
      .send(messagesBody({ model: 'gemini-2.5-pro' }))

    expect(response.status).toBe(403)
    expect(response.body.error).toEqual({
      type: 'permission_error',
      message: GEMINI_PERMISSION_MESSAGE
    })
  })

  test('returns the model restriction message without changing the error type', async () => {
    mockApiKeyData.enableModelRestriction = true
    mockApiKeyData.restrictedModels = ['claude-sonnet-4-5']

    const response = await request(app).post('/api/v1/messages').send(messagesBody())

    expect(response.status).toBe(403)
    expect(response.body.error).toEqual({
      type: 'forbidden',
      message: MODEL_RESTRICTION_MESSAGE
    })
  })

  test('returns the Gemini permission message from the Antigravity model list', async () => {
    const response = await request(app).get('/api/v1/models').set('x-test-vendor', 'antigravity')

    expect(response.status).toBe(403)
    expect(response.body.error).toEqual({
      type: 'permission_error',
      message: GEMINI_PERMISSION_MESSAGE
    })
  })

  test.each([
    { vendor: null, permissions: ['gemini'], message: CLAUDE_PERMISSION_MESSAGE },
    { vendor: 'gemini-cli', permissions: ['claude'], message: GEMINI_PERMISSION_MESSAGE }
  ])(
    'uses the same permission contract for count_tokens',
    async ({ vendor, permissions, message }) => {
      mockApiKeyData.permissions = permissions
      let pending = request(app).post('/api/v1/messages/count_tokens')
      if (vendor) pending = pending.set('x-test-vendor', vendor)

      const response = await pending.send(messagesBody())

      expect(response.status).toBe(403)
      expect(response.body.error).toEqual({ type: 'permission_error', message })
    }
  )

  test.each([false, true])(
    'returns the English session binding error for stream=%s',
    async (stream) => {
      claudeRelayConfigService.isGlobalSessionBindingEnabled.mockResolvedValue(true)
      claudeRelayConfigService.extractOriginalSessionId.mockReturnValue('session_1')
      claudeRelayConfigService.validateNewSession.mockResolvedValue({
        valid: false,
        error: SESSION_MESSAGE,
        code: 'SESSION_BINDING_INVALID'
      })

      const response = await request(app).post('/api/v1/messages').send(messagesBody({ stream }))
      const body = responseBody(response)

      expect(response.status).toBe(403)
      expect(body.error).toEqual({ type: 'session_binding_error', message: SESSION_MESSAGE })
    }
  )

  test('returns the English validation message from count_tokens', async () => {
    claudeRelayConfigService.extractOriginalSessionId.mockReturnValue('session_1')
    claudeRelayConfigService.validateNewSession.mockResolvedValue({
      valid: false,
      error: SESSION_MESSAGE,
      code: 'SESSION_BINDING_INVALID'
    })

    const response = await request(app).post('/api/v1/messages/count_tokens').send(messagesBody())

    expect(response.status).toBe(400)
    expect(response.body.error).toEqual({
      type: 'session_binding_error',
      message: SESSION_MESSAGE
    })
  })

  test('returns the normalized config message when count_tokens detects an old session', async () => {
    claudeRelayConfigService.extractOriginalSessionId.mockReturnValue('session_1')
    claudeRelayConfigService.validateNewSession.mockResolvedValue({
      valid: true,
      isNewSession: true
    })

    const response = await request(app).post('/api/v1/messages/count_tokens').send(messagesBody())

    expect(response.status).toBe(400)
    expect(response.body.error).toEqual({
      type: 'session_binding_error',
      message: SESSION_MESSAGE
    })
  })

  test('keeps the dedicated account rate-limit machine code', async () => {
    const error = new Error('dedicated account limited')
    error.code = 'CLAUDE_DEDICATED_RATE_LIMITED'
    unifiedClaudeScheduler.selectAccountForApiKey.mockRejectedValue(error)

    const response = await request(app).post('/api/v1/messages').send(messagesBody())

    expect(response.status).toBe(403)
    expect(response.body).toEqual({
      error: 'upstream_rate_limited',
      message: "This dedicated account has hit Anthropic's rate limit."
    })
  })
})
