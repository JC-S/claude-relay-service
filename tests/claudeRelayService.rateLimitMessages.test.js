jest.mock('../src/utils/logger', () => ({
  api: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn()
}))

jest.mock('../src/services/account/claudeAccountService', () => ({
  clearExpiredModelRateLimit: jest.fn(),
  getAccount: jest.fn(),
  getAccountModelRateLimitInfo: jest.fn()
}))
jest.mock('../src/services/scheduler/unifiedClaudeScheduler', () => ({
  selectAccountForApiKey: jest.fn()
}))
jest.mock('../src/models/redis', () => ({}))
jest.mock('../src/services/claudeCodeHeadersService', () => ({}))
jest.mock('../src/services/requestIdentityService', () => ({}))
jest.mock('../src/services/userMessageQueueService', () => ({
  isUserMessageRequest: jest.fn(() => false)
}))

const claudeRelayService = require('../src/services/relay/claudeRelayService')
const claudeAccountService = require('../src/services/account/claudeAccountService')
const unifiedClaudeScheduler = require('../src/services/scheduler/unifiedClaudeScheduler')
const { formatDateWithTimezone } = require('../src/utils/dateHelper')

describe('Claude dedicated-account rate-limit messages', () => {
  const resetTime = Date.parse('2026-01-10T12:34:56.000Z')
  const formattedReset = formatDateWithTimezone(resetTime)

  test.each([
    {
      builder: '_buildStandardRateLimitMessage',
      resetTime: null,
      expected: "This dedicated account has hit Anthropic's rate limit."
    },
    {
      builder: '_buildStandardRateLimitMessage',
      resetTime,
      expected: `This dedicated account has hit Anthropic's rate limit. It will automatically recover at ${formattedReset}.`
    },
    {
      builder: '_buildOpusLimitMessage',
      resetTime: null,
      expected:
        'This dedicated account has reached the weekly usage limit for Opus models. Please switch to another model and try again.'
    },
    {
      builder: '_buildOpusLimitMessage',
      resetTime,
      expected: `This dedicated account has reached the weekly usage limit for Opus models. It will automatically recover at ${formattedReset}. Please switch to another model and try again.`
    }
  ])('returns the expected English message from $builder', ({ builder, resetTime, expected }) => {
    const message = claudeRelayService[builder](resetTime)

    expect(message).toBe(expected)
    expect(message).not.toMatch(/\p{Script=Han}/u)
  })

  test('returns upstream_rate_limited for an ordinary dedicated-account limit', async () => {
    const error = new Error('limited')
    error.code = 'CLAUDE_DEDICATED_RATE_LIMITED'
    error.accountId = 'account_1'
    unifiedClaudeScheduler.selectAccountForApiKey.mockRejectedValueOnce(error)

    const result = await claudeRelayService.relayRequest(
      { model: 'claude-sonnet-4-5', messages: [] },
      { id: 'key_1', name: 'key' },
      {},
      {},
      {}
    )

    expect(result.statusCode).toBe(403)
    expect(JSON.parse(result.body)).toEqual({
      error: 'upstream_rate_limited',
      message: "This dedicated account has hit Anthropic's rate limit."
    })
  })

  test('returns opus_weekly_limit for a dedicated account under its Opus limit', async () => {
    unifiedClaudeScheduler.selectAccountForApiKey.mockResolvedValueOnce({
      accountId: 'account_1',
      accountType: 'claude-official'
    })
    claudeAccountService.getAccount.mockResolvedValue({
      id: 'account_1',
      name: 'Dedicated account',
      opusRateLimitEndAt: null
    })
    claudeAccountService.getAccountModelRateLimitInfo.mockResolvedValue({
      isRateLimited: true,
      resetAt: null
    })

    const result = await claudeRelayService.relayRequest(
      { model: 'claude-opus-4-7', messages: [] },
      { id: 'key_1', name: 'key', claudeAccountId: 'account_1' },
      {},
      {},
      {}
    )

    expect(result.statusCode).toBe(403)
    expect(JSON.parse(result.body)).toEqual({
      error: 'opus_weekly_limit',
      message:
        'This dedicated account has reached the weekly usage limit for Opus models. Please switch to another model and try again.'
    })
  })

  test('returns a family-specific limit for a dedicated Sonnet account', async () => {
    const error = new Error('limited')
    error.code = 'CLAUDE_DEDICATED_RATE_LIMITED'
    error.accountId = 'account_1'
    error.modelFamily = 'sonnet'
    unifiedClaudeScheduler.selectAccountForApiKey.mockRejectedValueOnce(error)

    const result = await claudeRelayService.relayRequest(
      { model: 'claude-sonnet-4-6', messages: [] },
      { id: 'key_1', name: 'key' },
      {},
      {},
      {}
    )

    expect(result.statusCode).toBe(403)
    expect(JSON.parse(result.body)).toEqual({
      error: 'sonnet_weekly_limit',
      message:
        'This dedicated account has reached the weekly usage limit for Sonnet models. Please switch to another model and try again.'
    })
  })

  test('returns 503 when strict dedicated binding reports an unavailable account', async () => {
    const error = new Error('unavailable')
    error.code = 'CLAUDE_DEDICATED_UNAVAILABLE'
    error.accountId = 'account_1'
    error.reason = 'temporarily_unavailable'
    unifiedClaudeScheduler.selectAccountForApiKey.mockRejectedValueOnce(error)

    const result = await claudeRelayService.relayRequest(
      { model: 'claude-sonnet-4-6', messages: [] },
      { id: 'key_1', name: 'key' },
      {},
      {},
      {}
    )

    expect(result.statusCode).toBe(503)
    expect(JSON.parse(result.body)).toEqual({
      error: 'dedicated_account_unavailable',
      message:
        'The dedicated account bound to this API key is currently unavailable (temporarily_unavailable). Please try again later.'
    })
  })
})
