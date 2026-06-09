function createRedisMock(accountData) {
  const zsets = new Map()
  const client = {
    eval: jest.fn(async (_script, _keyCount, key, cutoffMs, nowMs, member, _ttlSeconds) => {
      const cutoff = Number(cutoffMs)
      const now = Number(nowMs)
      const entries = (zsets.get(key) || []).filter((entry) => entry.score > cutoff)
      entries.push({ score: now, member })
      entries.sort((a, b) => a.score - b.score)
      zsets.set(key, entries)
      return [entries.length, String(entries[0]?.score || ''), String(now)]
    }),
    del: jest.fn(async (key) => {
      const existed = zsets.delete(key)
      return existed ? 1 : 0
    })
  }

  return {
    client,
    getClientSafe: jest.fn(() => client),
    getClaudeAccount: jest.fn(async () => accountData)
  }
}

function loadService(accountData) {
  jest.resetModules()
  jest.useFakeTimers()

  const redisMock = createRedisMock(accountData)
  let service

  jest.isolateModules(() => {
    jest.doMock('../src/models/redis', () => redisMock)
    jest.doMock('../src/utils/logger', () => ({
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      success: jest.fn()
    }))
    jest.doMock(
      '../config/config',
      () => ({
        system: { timezoneOffset: 8 },
        claude: {
          fiveHourWarning: { maxNotificationsPerWindow: 1 }
        }
      }),
      { virtual: true }
    )
    service = require('../src/services/account/claudeAccountService')
  })

  return { service, redisMock }
}

describe('Claude OAuth 429 rolling window', () => {
  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
    jest.resetModules()
  })

  test('pauses only on the third OAuth 429 inside 15 minutes', async () => {
    const { service } = loadService({
      scopes: 'user:profile user:inference'
    })

    jest.spyOn(Date, 'now').mockReturnValue(1_000_000)
    await expect(service.recordClaudeOAuth429AndShouldPause('acct_1')).resolves.toMatchObject({
      enabled: true,
      shouldPause: false,
      count: 1,
      threshold: 3,
      windowSeconds: 900,
      action: 'not_paused'
    })

    Date.now.mockReturnValue(1_001_000)
    await expect(service.recordClaudeOAuth429AndShouldPause('acct_1')).resolves.toMatchObject({
      enabled: true,
      shouldPause: false,
      count: 2,
      action: 'not_paused'
    })

    Date.now.mockReturnValue(1_002_000)
    await expect(service.recordClaudeOAuth429AndShouldPause('acct_1')).resolves.toMatchObject({
      enabled: true,
      shouldPause: true,
      count: 3,
      action: 'paused'
    })
  })

  test('does not count OAuth 429 events outside the 15 minute window', async () => {
    const { service } = loadService({
      authType: 'oauth'
    })

    jest.spyOn(Date, 'now').mockReturnValue(10_000)
    await service.recordClaudeOAuth429AndShouldPause('acct_1')

    Date.now.mockReturnValue(10_000 + 16 * 60 * 1000)
    await expect(service.recordClaudeOAuth429AndShouldPause('acct_1')).resolves.toMatchObject({
      enabled: true,
      shouldPause: false,
      count: 1,
      action: 'not_paused'
    })
  })

  test('leaves non-OAuth claude-official accounts on the original immediate pause behavior', async () => {
    const { service, redisMock } = loadService({
      scopes: 'user:inference'
    })

    jest.spyOn(Date, 'now').mockReturnValue(1_000_000)
    await expect(service.recordClaudeOAuth429AndShouldPause('acct_1')).resolves.toMatchObject({
      enabled: false,
      shouldPause: true,
      action: 'not_applicable'
    })
    expect(redisMock.client.eval).not.toHaveBeenCalled()
  })

  test('clears the rolling window key for account recovery paths', async () => {
    const { service, redisMock } = loadService({
      authType: 'oauth'
    })

    await service.clearClaudeOAuth429RollingWindow('acct_1')

    expect(redisMock.client.del).toHaveBeenCalledWith('claude_oauth_429_window:acct_1')
  })
})
