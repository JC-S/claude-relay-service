jest.mock('../src/services/apiKeyService', () => ({
  validateApiKey: jest.fn()
}))

jest.mock('../src/services/userService', () => ({}))

jest.mock('../src/models/redis', () => ({
  client: {
    get: jest.fn()
  },
  getNextResetTime: jest.fn(() => new Date('2026-01-01T00:00:00.000Z'))
}))

jest.mock('../src/services/claudeRelayConfigService', () => ({
  isClaudeCodeOnlyEnabled: jest.fn().mockResolvedValue(false)
}))

jest.mock('../src/utils/logger', () => ({
  api: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  security: jest.fn(),
  warn: jest.fn()
}))

const apiKeyService = require('../src/services/apiKeyService')
const redis = require('../src/models/redis')
const { authenticateApiKey } = require('../src/middleware/auth')

const VALID_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude."
const VALID_USER_ID =
  'user_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_account__session_17cf0fd3-d51b-4b59-977d-b899dafb3022'

function createReq(userAgent = 'claude-cli/2.1.139 (external, cli)') {
  return {
    ip: '127.0.0.1',
    path: '/v1/messages',
    originalUrl: '/v1/messages',
    headers: {
      'x-api-key': 'cr_test_key_123456',
      'user-agent': userAgent,
      'x-app': 'cli',
      'anthropic-beta': 'claude-code-20250219',
      'anthropic-version': '2023-06-01'
    },
    body: {
      model: 'claude-sonnet-4-5',
      system: [{ type: 'text', text: VALID_SYSTEM_PROMPT }],
      metadata: {
        user_id: VALID_USER_ID
      },
      messages: [{ role: 'user', content: 'test' }]
    },
    connection: {
      remoteAddress: '127.0.0.1'
    }
  }
}

function createRes() {
  const res = {
    statusCode: 200,
    body: null,
    status: jest.fn((code) => {
      res.statusCode = code
      return res
    }),
    json: jest.fn((payload) => {
      res.body = payload
      return res
    })
  }
  return res
}

function mockValidApiKey(overrides = {}) {
  apiKeyService.validateApiKey.mockResolvedValue({
    valid: true,
    keyData: {
      id: 'key_1',
      name: 'test',
      enableClientRestriction: true,
      allowedClients: ['claude_code'],
      enableIpWhitelist: false,
      concurrencyLimit: 0,
      rateLimitWindow: 0,
      rateLimitRequests: 0,
      rateLimitCost: 0,
      tokenLimit: 0,
      dailyCostLimit: 0,
      totalCostLimit: 0,
      weeklyOpusCostLimit: 0,
      permissions: ['claude'],
      ...overrides
    }
  })
}

describe('authenticateApiKey Claude Code version gate', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockValidApiKey()
    redis.client.get.mockResolvedValue('claude-cli/2.1.150 (external, cli)')
  })

  test('returns 426 when Claude Code client version is more than 10 versions behind cached version', async () => {
    const req = createReq('claude-cli/2.1.139 (external, cli)')
    const res = createRes()
    const next = jest.fn()

    await authenticateApiKey(req, res, next)

    expect(res.status).toHaveBeenCalledWith(426)
    expect(res.body).toEqual({
      error: {
        type: 'client_validation_error',
        message:
          'Your Claude Code CLI version 2.1.139 is too old for this API key. Please upgrade to 2.1.140 or newer and try again.'
      },
      clientVersion: '2.1.139',
      minimumAllowedVersion: '2.1.140',
      cachedVersion: '2.1.150'
    })
    expect(next).not.toHaveBeenCalled()
  })

  test('allows Claude Code client version exactly 10 versions behind cached version', async () => {
    const req = createReq('claude-cli/2.1.140 (external, cli)')
    const res = createRes()
    const next = jest.fn()

    await authenticateApiKey(req, res, next)

    expect(res.status).not.toHaveBeenCalledWith(426)
    expect(next).toHaveBeenCalled()
  })

  test('passes Claude thinking signature lossy fallback toggle to req.apiKey', async () => {
    mockValidApiKey({
      enableClaudeThinkingSignatureLossyFallback: true
    })
    const req = createReq('claude-cli/2.1.150 (external, cli)')
    const res = createRes()
    const next = jest.fn()

    await authenticateApiKey(req, res, next)

    expect(next).toHaveBeenCalled()
    expect(req.apiKey.enableClaudeThinkingSignatureLossyFallback).toBe(true)
  })

  test('passes general prompt cache assist toggle to req.apiKey', async () => {
    mockValidApiKey({
      enableGeneralOpenAIEndpoint: true,
      enableGeneralOpenAIImages: true,
      enableGeneralPromptCacheAssist: true
    })
    const req = createReq('claude-cli/2.1.150 (external, cli)')
    const res = createRes()
    const next = jest.fn()

    await authenticateApiKey(req, res, next)

    expect(next).toHaveBeenCalled()
    expect(req.apiKey.enableGeneralOpenAIEndpoint).toBe(true)
    expect(req.apiKey.enableGeneralOpenAIImages).toBe(true)
    expect(req.apiKey.enableGeneralPromptCacheAssist).toBe(true)
  })

  test('does not apply version gate when Claude Code is not enabled for the API key', async () => {
    mockValidApiKey({
      allowedClients: ['codex_cli']
    })
    const req = createReq('claude-cli/2.1.139 (external, cli)')
    const res = createRes()
    const next = jest.fn()

    await authenticateApiKey(req, res, next)

    expect(redis.client.get).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(403)
    expect(next).not.toHaveBeenCalled()
  })
})
