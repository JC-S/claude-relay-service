jest.mock('../src/models/redis', () => ({
  getAllClaudeAccounts: jest.fn()
}))

jest.mock('../src/services/account/claudeAccountService', () => ({
  fetchOAuthUsage: jest.fn(),
  updateClaudeUsageSnapshot: jest.fn()
}))

jest.mock('../src/services/account/openaiAccountService', () => ({
  getAllAccounts: jest.fn(),
  fetchCodexUsage: jest.fn()
}))

jest.mock('../src/services/account/grokAccountService', () => ({
  getAllAccounts: jest.fn()
}))

jest.mock('../src/services/grokQuotaService', () => ({
  queryBilling: jest.fn()
}))

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

const redis = require('../src/models/redis')
const claudeAccountService = require('../src/services/account/claudeAccountService')
const openaiAccountService = require('../src/services/account/openaiAccountService')
const grokAccountService = require('../src/services/account/grokAccountService')
const grokQuotaService = require('../src/services/grokQuotaService')
const { OAuthUsageRefreshService } = require('../src/services/oauthUsageRefreshService')

describe('oauthUsageRefreshService', () => {
  let dateNowSpy

  beforeEach(() => {
    jest.clearAllMocks()
    grokAccountService.getAllAccounts.mockResolvedValue([])
    grokQuotaService.queryBilling.mockResolvedValue({ billing: {} })
    dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-06-17T10:00:00.000Z'))
  })

  afterEach(() => {
    dateNowSpy.mockRestore()
    jest.useRealTimers()
  })

  test('refreshes stale active Claude OAuth and OpenAI OAuth accounts', async () => {
    const service = new OAuthUsageRefreshService()
    service.refreshThresholdMs = 90 * 60 * 1000
    service.batchSize = 2
    service.requestTimeoutMs = 12345

    const staleUpdatedAt = new Date(Date.now() - 100 * 60 * 1000).toISOString()
    const freshUpdatedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString()

    redis.getAllClaudeAccounts.mockResolvedValue([
      {
        id: 'claude-stale',
        name: 'Claude Stale',
        scopes: 'user:profile user:inference',
        isActive: 'true',
        status: 'active',
        accessToken: 'encrypted-token',
        claudeUsageUpdatedAt: staleUpdatedAt
      },
      {
        id: 'claude-fresh',
        scopes: 'user:profile user:inference',
        isActive: 'true',
        status: 'active',
        accessToken: 'encrypted-token',
        claudeUsageUpdatedAt: freshUpdatedAt
      },
      {
        id: 'claude-setup-token',
        scopes: 'user:inference',
        isActive: 'true',
        status: 'active',
        accessToken: 'encrypted-token',
        claudeUsageUpdatedAt: staleUpdatedAt
      },
      {
        id: 'claude-stopped',
        scopes: 'user:profile user:inference',
        isActive: 'true',
        status: 'active',
        schedulable: 'false',
        accessToken: 'encrypted-token',
        claudeUsageUpdatedAt: staleUpdatedAt
      }
    ])

    claudeAccountService.fetchOAuthUsage.mockResolvedValue({
      five_hour: {
        utilization: 0.12
      }
    })
    claudeAccountService.updateClaudeUsageSnapshot.mockResolvedValue()

    openaiAccountService.getAllAccounts.mockResolvedValue([
      {
        id: 'openai-stale',
        name: 'OpenAI Stale',
        isActive: true,
        hasRefreshToken: true,
        accountId: 'chatgpt-account-1',
        codexUsage: {
          updatedAt: staleUpdatedAt
        }
      },
      {
        id: 'openai-fresh',
        isActive: true,
        hasRefreshToken: true,
        accountId: 'chatgpt-account-2',
        codexUsage: {
          updatedAt: freshUpdatedAt
        }
      },
      {
        id: 'openai-no-account-id',
        isActive: true,
        hasRefreshToken: true,
        codexUsage: {
          updatedAt: staleUpdatedAt
        }
      },
      {
        id: 'openai-stopped',
        isActive: true,
        schedulable: false,
        hasRefreshToken: true,
        accountId: 'chatgpt-account-stopped',
        codexUsage: {
          updatedAt: staleUpdatedAt
        }
      }
    ])
    openaiAccountService.fetchCodexUsage.mockResolvedValue({
      primaryUsedPercent: 12.5
    })
    grokAccountService.getAllAccounts.mockResolvedValue([
      {
        id: 'grok-stale',
        authType: 'oauth',
        isActive: true,
        schedulable: true,
        status: 'active',
        hasRefreshToken: true,
        billingSnapshot: { observedAt: staleUpdatedAt }
      },
      {
        id: 'grok-fresh',
        authType: 'oauth',
        isActive: true,
        schedulable: true,
        status: 'active',
        hasRefreshToken: true,
        billingSnapshot: { observedAt: freshUpdatedAt }
      },
      {
        id: 'grok-api-key',
        authType: 'api_key',
        isActive: true,
        schedulable: true,
        status: 'active',
        billingSnapshot: { observedAt: staleUpdatedAt }
      },
      {
        id: 'grok-stopped',
        authType: 'oauth',
        isActive: true,
        schedulable: false,
        status: 'active',
        hasRefreshToken: true,
        billingSnapshot: { observedAt: staleUpdatedAt }
      },
      {
        id: 'grok-unauthorized',
        authType: 'oauth',
        isActive: true,
        schedulable: true,
        status: 'unauthorized',
        hasRefreshToken: true,
        billingSnapshot: { observedAt: staleUpdatedAt }
      }
    ])

    const result = await service.performRefresh()

    expect(result.claude).toMatchObject({
      scanned: 4,
      stale: 1,
      refreshed: 1,
      failed: 0
    })
    expect(result.openai).toMatchObject({
      scanned: 4,
      stale: 1,
      refreshed: 1,
      failed: 0
    })
    expect(result.grok).toMatchObject({
      scanned: 5,
      stale: 1,
      refreshed: 1,
      failed: 0
    })
    expect(claudeAccountService.fetchOAuthUsage).toHaveBeenCalledWith('claude-stale')
    expect(claudeAccountService.updateClaudeUsageSnapshot).toHaveBeenCalledWith(
      'claude-stale',
      expect.any(Object)
    )
    expect(openaiAccountService.fetchCodexUsage).toHaveBeenCalledWith('openai-stale', {
      timeoutMs: 12345
    })
    expect(claudeAccountService.fetchOAuthUsage).not.toHaveBeenCalledWith('claude-stopped')
    expect(openaiAccountService.fetchCodexUsage).not.toHaveBeenCalledWith(
      'openai-stopped',
      expect.any(Object)
    )
    expect(grokQuotaService.queryBilling).toHaveBeenCalledTimes(1)
    expect(grokQuotaService.queryBilling).toHaveBeenCalledWith('grok-stale')
  })

  test('single account refresh failures do not stop the whole run', async () => {
    const service = new OAuthUsageRefreshService()
    service.refreshThresholdMs = 90 * 60 * 1000
    service.batchSize = 1

    redis.getAllClaudeAccounts.mockResolvedValue([
      {
        id: 'claude-fails',
        scopes: 'user:profile user:inference',
        isActive: 'true',
        status: 'active',
        accessToken: 'encrypted-token',
        claudeUsageUpdatedAt: ''
      },
      {
        id: 'claude-succeeds',
        scopes: 'user:profile user:inference',
        isActive: 'true',
        status: 'active',
        accessToken: 'encrypted-token',
        claudeUsageUpdatedAt: ''
      }
    ])
    claudeAccountService.fetchOAuthUsage
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({
        seven_day: {
          utilization: 0.4
        }
      })
    claudeAccountService.updateClaudeUsageSnapshot.mockResolvedValue()
    openaiAccountService.getAllAccounts.mockResolvedValue([])

    const result = await service.performRefresh()

    expect(result.claude).toMatchObject({
      stale: 2,
      refreshed: 1,
      failed: 1
    })
    expect(claudeAccountService.updateClaudeUsageSnapshot).toHaveBeenCalledWith(
      'claude-succeeds',
      expect.any(Object)
    )
  })

  test('performRefresh skips re-entry while a previous run is active', async () => {
    const service = new OAuthUsageRefreshService()
    service.isRunning = true

    await expect(service.performRefresh()).resolves.toEqual({
      skipped: true
    })

    expect(redis.getAllClaudeAccounts).not.toHaveBeenCalled()
    expect(openaiAccountService.getAllAccounts).not.toHaveBeenCalled()
  })

  test('start schedules an immediate refresh and stop clears the interval', () => {
    jest.useFakeTimers()
    const service = new OAuthUsageRefreshService()
    const performRefreshSpy = jest.spyOn(service, 'performRefresh').mockResolvedValue({
      skipped: false,
      claude: {
        scanned: 0,
        stale: 0,
        refreshed: 0,
        failed: 0
      },
      openai: {
        scanned: 0,
        stale: 0,
        refreshed: 0,
        failed: 0
      }
    })

    service.start({
      intervalMinutes: 1,
      maxStalenessMinutes: 5,
      batchSize: 2,
      requestTimeoutMs: 5000
    })

    expect(performRefreshSpy).toHaveBeenCalledTimes(1)

    jest.advanceTimersByTime(60 * 1000)
    expect(performRefreshSpy).toHaveBeenCalledTimes(2)

    service.stop()
    expect(service.refreshInterval).toBeNull()
  })
})
