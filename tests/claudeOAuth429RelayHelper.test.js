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
  getPricingData: jest.fn(() => ({}))
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
  recordClaudeOAuth429AndShouldPause: jest.fn(),
  markAccountModelRateLimited: jest.fn()
}))
jest.mock('../src/services/scheduler/unifiedClaudeScheduler', () => ({
  markAccountRateLimited: jest.fn()
}))
jest.mock('../src/utils/upstreamErrorHelper', () => ({
  markTempUnavailable: jest.fn(() => Promise.resolve({ success: true })),
  recordErrorHistory: jest.fn(() => Promise.resolve()),
  parseRetryAfter: jest.fn(() => 120)
}))

const claudeRelayService = require('../src/services/relay/claudeRelayService')
const claudeAccountService = require('../src/services/account/claudeAccountService')
const unifiedClaudeScheduler = require('../src/services/scheduler/unifiedClaudeScheduler')
const upstreamErrorHelper = require('../src/utils/upstreamErrorHelper')

function rollingDecision(overrides = {}) {
  return {
    enabled: true,
    shouldPause: false,
    count: 1,
    threshold: 3,
    windowSeconds: 900,
    firstEventAt: '2026-06-09T01:00:00.000Z',
    latestEventAt: '2026-06-09T01:00:00.000Z',
    action: 'not_paused',
    ...overrides
  }
}

describe('Claude OAuth 429 relay auto-protection helper', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('records history and skips account pause before the rolling threshold', async () => {
    claudeAccountService.recordClaudeOAuth429AndShouldPause.mockResolvedValue(
      rollingDecision({ count: 2 })
    )

    const result = await claudeRelayService._handleClaude429AutoProtection({
      accountId: 'acct_1',
      accountType: 'claude-official',
      account: { authType: 'oauth' },
      sessionHash: 'session_1',
      rateLimitResetTimestamp: 1_780_000_000,
      responseHeaders: { 'retry-after': '120' },
      upstreamErrorContext: { requestId: 'req_1' },
      phase: 'non_stream',
      model: 'unknown-claude-model'
    })

    expect(result.paused).toBe(false)
    expect(unifiedClaudeScheduler.markAccountRateLimited).not.toHaveBeenCalled()
    expect(upstreamErrorHelper.markTempUnavailable).not.toHaveBeenCalled()
    expect(upstreamErrorHelper.recordErrorHistory).toHaveBeenCalledWith(
      'acct_1',
      'claude-official',
      429,
      'rate_limit',
      expect.objectContaining({
        requestId: 'req_1',
        rollingWindow: expect.objectContaining({
          count: 2,
          threshold: 3,
          action: 'not_paused'
        })
      })
    )
  })

  test('skips rate-limit marking and rolling counter when authoritative reset header is missing', async () => {
    const result = await claudeRelayService._handleClaude429AutoProtection({
      accountId: 'acct_1',
      accountType: 'claude-official',
      account: { authType: 'oauth' },
      sessionHash: 'session_1',
      responseHeaders: { 'retry-after': '120' },
      upstreamErrorContext: { requestId: 'req_1' },
      phase: 'non_stream',
      model: 'claude-opus-4-8'
    })

    expect(result).toMatchObject({
      paused: false,
      skipped: true,
      reason: 'missing_authoritative_reset_header',
      rollingWindow: null
    })
    expect(claudeAccountService.recordClaudeOAuth429AndShouldPause).not.toHaveBeenCalled()
    expect(unifiedClaudeScheduler.markAccountRateLimited).not.toHaveBeenCalled()
    expect(upstreamErrorHelper.markTempUnavailable).not.toHaveBeenCalled()
    expect(upstreamErrorHelper.recordErrorHistory).toHaveBeenCalledWith(
      'acct_1',
      'claude-official',
      429,
      'rate_limit',
      expect.objectContaining({
        requestId: 'req_1',
        rateLimit: expect.objectContaining({
          authoritativeResetHeader: false,
          action: 'skipped_missing_reset_header',
          phase: 'non_stream',
          model: 'claude-opus-4-8'
        })
      })
    )
  })

  test('keeps original pause and temp-unavailable behavior after the threshold', async () => {
    claudeAccountService.recordClaudeOAuth429AndShouldPause.mockResolvedValue(
      rollingDecision({ count: 3, shouldPause: true, action: 'paused' })
    )

    const result = await claudeRelayService._handleClaude429AutoProtection({
      accountId: 'acct_1',
      accountType: 'claude-official',
      account: { authType: 'oauth' },
      sessionHash: 'session_1',
      rateLimitResetTimestamp: 1_780_000_000,
      responseHeaders: { 'retry-after': '120' },
      upstreamErrorContext: { requestId: 'req_1' },
      phase: 'stream',
      model: 'unknown-claude-model'
    })

    expect(result.paused).toBe(true)
    expect(unifiedClaudeScheduler.markAccountRateLimited).toHaveBeenCalledWith(
      'acct_1',
      'claude-official',
      'session_1',
      1_780_000_000
    )
    expect(upstreamErrorHelper.markTempUnavailable).toHaveBeenCalledWith(
      'acct_1',
      'claude-official',
      429,
      120,
      expect.objectContaining({
        requestId: 'req_1',
        rollingWindow: expect.objectContaining({
          count: 3,
          action: 'paused'
        })
      })
    )
    expect(upstreamErrorHelper.recordErrorHistory).not.toHaveBeenCalled()
  })

  test('records threshold 429 history when temp-unavailable is skipped by account policy', async () => {
    claudeAccountService.recordClaudeOAuth429AndShouldPause.mockResolvedValue(
      rollingDecision({ count: 3, shouldPause: true, action: 'paused' })
    )
    upstreamErrorHelper.markTempUnavailable.mockResolvedValueOnce({
      success: true,
      skipped: true,
      reason: 'account_temp_unavailable_disabled'
    })

    await claudeRelayService._handleClaude429AutoProtection({
      accountId: 'acct_1',
      accountType: 'claude-official',
      account: { authType: 'oauth' },
      sessionHash: null,
      rateLimitResetTimestamp: 1_780_000_000,
      responseHeaders: {},
      upstreamErrorContext: { requestId: 'req_1' },
      model: 'unknown-claude-model'
    })

    expect(upstreamErrorHelper.recordErrorHistory).toHaveBeenCalledWith(
      'acct_1',
      'claude-official',
      429,
      'rate_limit',
      expect.objectContaining({
        requestId: 'req_1',
        rollingWindow: expect.objectContaining({
          action: 'paused'
        })
      })
    )
  })

  test('keeps immediate pause behavior when rolling window is not applicable', async () => {
    claudeAccountService.recordClaudeOAuth429AndShouldPause.mockResolvedValue(
      rollingDecision({ enabled: false, shouldPause: true, action: 'not_applicable' })
    )

    await claudeRelayService._handleClaude429AutoProtection({
      accountId: 'acct_setup',
      accountType: 'claude-official',
      account: { scopes: 'user:inference' },
      sessionHash: null,
      rateLimitResetTimestamp: 1_780_000_000,
      responseHeaders: {},
      upstreamErrorContext: null,
      model: 'unknown-claude-model'
    })

    expect(unifiedClaudeScheduler.markAccountRateLimited).toHaveBeenCalledWith(
      'acct_setup',
      'claude-official',
      null,
      1_780_000_000
    )
    expect(upstreamErrorHelper.markTempUnavailable).toHaveBeenCalled()
    expect(upstreamErrorHelper.recordErrorHistory).not.toHaveBeenCalled()
  })

  test.each([
    ['claude-opus-4-8', 'opus'],
    ['claude-sonnet-4-6', 'sonnet'],
    ['claude-3-5-haiku-20241022', 'haiku'],
    ['claude-fable-5[1m]', 'fable']
  ])(
    'marks only the %s model family when an authoritative reset is present',
    async (model, family) => {
      const result = await claudeRelayService._handleClaude429AutoProtection({
        accountId: 'acct_1',
        accountType: 'claude-official',
        account: { authType: 'oauth' },
        sessionHash: 'session_1',
        rateLimitResetTimestamp: 1_780_000_000,
        responseHeaders: { 'retry-after': '120' },
        upstreamErrorContext: { requestId: `req_${family}`, errorBody: 'full upstream body' },
        phase: 'stream',
        model
      })

      expect(result).toMatchObject({
        paused: false,
        modelRateLimited: true,
        modelFamily: family
      })
      expect(claudeAccountService.markAccountModelRateLimited).toHaveBeenCalledWith(
        'acct_1',
        family,
        1_780_000_000
      )
      expect(claudeAccountService.recordClaudeOAuth429AndShouldPause).not.toHaveBeenCalled()
      expect(unifiedClaudeScheduler.markAccountRateLimited).not.toHaveBeenCalled()
      expect(upstreamErrorHelper.markTempUnavailable).not.toHaveBeenCalled()
      expect(upstreamErrorHelper.recordErrorHistory).toHaveBeenCalledWith(
        'acct_1',
        'claude-official',
        429,
        'rate_limit',
        expect.objectContaining({
          requestId: `req_${family}`,
          errorBody: 'full upstream body',
          modelFamily: family,
          rateLimit: expect.objectContaining({
            action: 'model_family_limited',
            modelFamily: family
          })
        })
      )
    }
  )

  test('a known family without a reset only records complete history', async () => {
    await claudeRelayService._handleClaude429AutoProtection({
      accountId: 'acct_1',
      accountType: 'claude-official',
      account: { authType: 'oauth' },
      sessionHash: 'session_1',
      upstreamErrorContext: { requestId: 'req_no_reset', errorBody: 'full upstream body' },
      phase: 'non_stream',
      model: 'claude-sonnet-4-6'
    })

    expect(claudeAccountService.markAccountModelRateLimited).not.toHaveBeenCalled()
    expect(claudeAccountService.recordClaudeOAuth429AndShouldPause).not.toHaveBeenCalled()
    expect(unifiedClaudeScheduler.markAccountRateLimited).not.toHaveBeenCalled()
    expect(upstreamErrorHelper.markTempUnavailable).not.toHaveBeenCalled()
    expect(upstreamErrorHelper.recordErrorHistory).toHaveBeenCalledWith(
      'acct_1',
      'claude-official',
      429,
      'rate_limit',
      expect.objectContaining({
        requestId: 'req_no_reset',
        errorBody: 'full upstream body',
        modelFamily: 'sonnet',
        rateLimit: expect.objectContaining({
          authoritativeResetHeader: false,
          modelFamily: 'sonnet'
        })
      })
    )
  })
})
