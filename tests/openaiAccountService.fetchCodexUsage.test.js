function createLoggerMock() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    success: jest.fn()
  }
}

function createRedisMock(initialAccount = {}) {
  let accountData = { ...initialAccount }

  const client = {
    hgetall: jest.fn(async (key) => {
      if (key === 'openai:account:acct-1') {
        return { ...accountData }
      }
      return {}
    }),
    hset: jest.fn(async (_key, updates) => {
      accountData = {
        ...accountData,
        ...updates
      }
      return Object.keys(updates).length
    }),
    sadd: jest.fn(),
    srem: jest.fn(),
    del: jest.fn(),
    smembers: jest.fn(async () => []),
    setex: jest.fn(),
    expire: jest.fn(),
    pipeline: jest.fn(() => ({
      del: jest.fn(),
      exec: jest.fn()
    }))
  }

  return {
    getClientSafe: jest.fn(() => client),
    addToIndex: jest.fn(),
    removeFromIndex: jest.fn(),
    getAllIdsByIndex: jest.fn(async () => []),
    batchHgetallChunked: jest.fn(async () => []),
    __setAccount: (updates) => {
      accountData = {
        ...accountData,
        ...updates
      }
    },
    __getAccount: () => ({ ...accountData }),
    __client: client
  }
}

function loadOpenAIAccountService(initialAccount = {}) {
  jest.resetModules()
  jest.useFakeTimers()
  jest.setSystemTime(new Date('2026-06-17T10:00:00.000Z'))

  const axiosMock = jest.fn()
  axiosMock.get = jest.fn()
  const redisMock = createRedisMock(initialAccount)
  const tokenRefreshServiceMock = {
    acquireRefreshLock: jest.fn(async () => true),
    releaseRefreshLock: jest.fn(async () => true)
  }
  const proxyHelperMock = {
    createProxyAgent: jest.fn(() => null),
    getProxyDescription: jest.fn(() => 'none')
  }

  let service
  jest.isolateModules(() => {
    jest.doMock('axios', () => axiosMock)
    jest.doMock('../src/models/redis', () => redisMock)
    jest.doMock('../src/utils/proxyHelper', () => proxyHelperMock)
    jest.doMock('../src/utils/logger', () => createLoggerMock())
    jest.doMock('../src/utils/tokenRefreshLogger', () => ({
      logRefreshStart: jest.fn(),
      logRefreshSuccess: jest.fn(),
      logRefreshError: jest.fn(),
      logTokenUsage: jest.fn(),
      logRefreshSkipped: jest.fn()
    }))
    jest.doMock('../src/services/tokenRefreshService', () => tokenRefreshServiceMock)
    jest.doMock('../src/utils/upstreamErrorHelper', () => ({
      recordErrorHistory: jest.fn(async () => undefined)
    }))
    jest.doMock(
      '../config/config',
      () => ({
        security: {
          encryptionKey: 'test-encryption-key-0000000000000'
        },
        oauthUsageRefresh: {
          requestTimeoutMs: 7777
        },
        requestTimeout: 600000,
        proxy: {
          useIPv4: true
        },
        system: {
          timezoneOffset: 8
        }
      }),
      { virtual: true }
    )

    service = require('../src/services/account/openaiAccountService')
  })

  return {
    service,
    axiosMock,
    redisMock,
    tokenRefreshServiceMock,
    proxyHelperMock
  }
}

describe('openaiAccountService.fetchCodexUsage', () => {
  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
    jest.restoreAllMocks()
    jest.resetModules()
  })

  test('fetches both 5-hour and weekly windows with decrypted access token', async () => {
    const { service, axiosMock, redisMock } = loadOpenAIAccountService({
      id: 'acct-1',
      name: 'Codex Account',
      accountId: 'chatgpt-account-1',
      expiresAt: '2099-01-01T00:00:00.000Z'
    })
    redisMock.__setAccount({
      accessToken: service.encrypt('plain-access-token'),
      refreshToken: service.encrypt('plain-refresh-token')
    })

    const nowSeconds = Math.floor(Date.now() / 1000)
    axiosMock.get.mockResolvedValue({
      status: 200,
      data: {
        rate_limit: {
          primary_window: {
            used_percent: 12.5,
            limit_window_seconds: 5 * 60 * 60,
            reset_at: nowSeconds + 3600
          },
          secondary_window: {
            used_percent: 34.5,
            limit_window_seconds: 7 * 24 * 60 * 60,
            reset_at: nowSeconds + 7200
          }
        }
      }
    })

    await expect(service.fetchCodexUsage('acct-1', { timeoutMs: 1234 })).resolves.toEqual({
      primaryUsedPercent: 12.5,
      primaryResetAfterSeconds: 3600,
      primaryWindowMinutes: 300,
      secondaryUsedPercent: 34.5,
      secondaryResetAfterSeconds: 7200,
      secondaryWindowMinutes: 10080
    })

    expect(axiosMock.get).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/wham/usage',
      expect.objectContaining({
        timeout: 1234,
        headers: expect.objectContaining({
          Authorization: 'Bearer plain-access-token',
          'chatgpt-account-id': 'chatgpt-account-1',
          accept: '*/*',
          host: 'chatgpt.com',
          connection: 'close'
        })
      })
    )
    expect(axiosMock.get.mock.calls[0][1].headers.Authorization).not.toContain(
      redisMock.__getAccount().accessToken
    )

    expect(redisMock.__client.hset).toHaveBeenCalledWith(
      'openai:account:acct-1',
      expect.objectContaining({
        codexPrimaryUsedPercent: '12.5',
        codexPrimaryResetAfterSeconds: '3600',
        codexPrimaryWindowMinutes: '300',
        codexSecondaryUsedPercent: '34.5',
        codexSecondaryResetAfterSeconds: '7200',
        codexSecondaryWindowMinutes: '10080',
        codexUsageUpdatedAt: expect.any(String)
      })
    )
  })

  test('maps a weekly-only primary window to weekly usage and clears stale 5-hour data', async () => {
    const { service, axiosMock, redisMock } = loadOpenAIAccountService({
      id: 'acct-1',
      name: 'Codex Account',
      accountId: 'chatgpt-account-1',
      expiresAt: '2099-01-01T00:00:00.000Z',
      codexPrimaryUsedPercent: '88',
      codexPrimaryResetAfterSeconds: '900',
      codexPrimaryWindowMinutes: '300'
    })
    redisMock.__setAccount({
      accessToken: service.encrypt('plain-access-token'),
      refreshToken: service.encrypt('plain-refresh-token')
    })

    axiosMock.get.mockResolvedValue({
      status: 200,
      data: {
        rate_limit: {
          primary_window: {
            used_percent: 41.25,
            limit_window_seconds: 7 * 24 * 60 * 60,
            reset_after_seconds: 345600
          },
          secondary_window: {
            used_percent: 0,
            limit_window_seconds: 0,
            reset_after_seconds: 0
          }
        }
      }
    })

    await expect(service.fetchCodexUsage('acct-1')).resolves.toEqual({
      secondaryUsedPercent: 41.25,
      secondaryResetAfterSeconds: 345600,
      secondaryWindowMinutes: 10080
    })

    expect(redisMock.__client.hset).toHaveBeenCalledWith(
      'openai:account:acct-1',
      expect.objectContaining({
        codexPrimaryUsedPercent: '',
        codexPrimaryResetAfterSeconds: '',
        codexPrimaryWindowMinutes: '',
        codexSecondaryUsedPercent: '41.25',
        codexSecondaryResetAfterSeconds: '345600',
        codexSecondaryWindowMinutes: '10080',
        codexUsageUpdatedAt: expect.any(String)
      })
    )
    expect(redisMock.__getAccount()).toEqual(
      expect.objectContaining({
        codexPrimaryUsedPercent: '',
        codexPrimaryResetAfterSeconds: '',
        codexPrimaryWindowMinutes: '',
        codexSecondaryUsedPercent: '41.25',
        codexSecondaryResetAfterSeconds: '345600',
        codexSecondaryWindowMinutes: '10080'
      })
    )
  })

  test('normalizes duration-aware response-header snapshots before persisting them', async () => {
    const { service, redisMock } = loadOpenAIAccountService({
      id: 'acct-1',
      name: 'Codex Account'
    })

    await service.updateCodexUsageSnapshot('acct-1', {
      primaryUsedPercent: 27,
      primaryResetAfterSeconds: 86400,
      primaryWindowMinutes: 10080
    })

    expect(redisMock.__client.hset).toHaveBeenCalledWith(
      'openai:account:acct-1',
      expect.objectContaining({
        codexSecondaryUsedPercent: '27',
        codexSecondaryResetAfterSeconds: '86400',
        codexSecondaryWindowMinutes: '10080',
        codexUsageUpdatedAt: expect.any(String)
      })
    )
    expect(redisMock.__client.hset.mock.calls[0][1]).not.toHaveProperty('codexPrimaryUsedPercent')
  })

  test('replaces disabled windows when response headers contain a complete window layout', async () => {
    const { service, redisMock } = loadOpenAIAccountService({
      id: 'acct-1',
      name: 'Codex Account',
      codexPrimaryUsedPercent: '88',
      codexPrimaryResetAfterSeconds: '900',
      codexPrimaryWindowMinutes: '300'
    })

    await service.updateCodexUsageSnapshot('acct-1', {
      primaryUsedPercent: 27,
      primaryResetAfterSeconds: 86400,
      primaryWindowMinutes: 10080,
      secondaryUsedPercent: 0,
      secondaryResetAfterSeconds: 0,
      secondaryWindowMinutes: 0
    })

    expect(redisMock.__client.hset).toHaveBeenCalledWith(
      'openai:account:acct-1',
      expect.objectContaining({
        codexPrimaryUsedPercent: '',
        codexPrimaryResetAfterSeconds: '',
        codexPrimaryWindowMinutes: '',
        codexSecondaryUsedPercent: '27',
        codexSecondaryResetAfterSeconds: '86400',
        codexSecondaryWindowMinutes: '10080',
        codexUsageUpdatedAt: expect.any(String)
      })
    )
  })

  test('keeps an unrelated long window in its original slot', async () => {
    const { service, redisMock } = loadOpenAIAccountService({
      id: 'acct-1',
      name: 'Codex Account'
    })

    await service.updateCodexUsageSnapshot('acct-1', {
      primaryUsedPercent: 6,
      primaryResetAfterSeconds: 2592000,
      primaryWindowMinutes: 43200
    })

    expect(redisMock.__client.hset).toHaveBeenCalledWith(
      'openai:account:acct-1',
      expect.objectContaining({
        codexPrimaryUsedPercent: '6',
        codexPrimaryResetAfterSeconds: '2592000',
        codexPrimaryWindowMinutes: '43200',
        codexUsageUpdatedAt: expect.any(String)
      })
    )
    expect(redisMock.__client.hset.mock.calls[0][1]).not.toHaveProperty('codexSecondaryUsedPercent')
  })

  test('normalizes an existing weekly-only Redis snapshot and ignores a zero disabled slot', async () => {
    const { service } = loadOpenAIAccountService({
      id: 'acct-1',
      name: 'Codex Account',
      isActive: 'true',
      codexPrimaryUsedPercent: '6',
      codexPrimaryResetAfterSeconds: '585867',
      codexPrimaryWindowMinutes: '10080',
      codexSecondaryUsedPercent: '0',
      codexSecondaryResetAfterSeconds: '0',
      codexSecondaryWindowMinutes: '0',
      codexUsageUpdatedAt: '2026-06-17T10:00:00.000Z'
    })

    const overview = await service.getAccountOverview('acct-1')

    expect(overview.codexUsage).toEqual({
      updatedAt: '2026-06-17T10:00:00.000Z',
      primary: null,
      secondary: {
        usedPercent: 6,
        resetAfterSeconds: 585867,
        windowMinutes: 10080,
        resetAt: '2026-06-24T04:44:27.000Z',
        remainingSeconds: 585867
      },
      primaryOverSecondaryPercent: null
    })
  })

  test('returns null without calling upstream when chatgpt account id is missing', async () => {
    const { service, axiosMock, redisMock } = loadOpenAIAccountService({
      id: 'acct-1',
      name: 'Codex Account',
      expiresAt: '2099-01-01T00:00:00.000Z'
    })
    redisMock.__setAccount({
      accessToken: service.encrypt('plain-access-token'),
      refreshToken: service.encrypt('plain-refresh-token')
    })

    await expect(service.fetchCodexUsage('acct-1')).resolves.toBeNull()

    expect(axiosMock.get).not.toHaveBeenCalled()
    expect(redisMock.__client.hset).not.toHaveBeenCalled()
  })

  test('refreshes token silently and retries once on 401', async () => {
    const { service, axiosMock, redisMock, tokenRefreshServiceMock } = loadOpenAIAccountService({
      id: 'acct-1',
      name: 'Codex Account',
      accountId: 'chatgpt-account-1',
      expiresAt: '2099-01-01T00:00:00.000Z'
    })
    redisMock.__setAccount({
      accessToken: service.encrypt('old-access-token'),
      refreshToken: service.encrypt('old-refresh-token')
    })

    const nowSeconds = Math.floor(Date.now() / 1000)
    axiosMock.get
      .mockResolvedValueOnce({
        status: 401,
        data: {
          error: 'expired'
        }
      })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          rate_limit: {
            primary_window: {
              used_percent: 9,
              reset_at: nowSeconds + 1800
            }
          }
        }
      })
    axiosMock.mockResolvedValue({
      status: 200,
      data: {
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600
      }
    })

    await expect(service.fetchCodexUsage('acct-1')).resolves.toEqual({
      primaryUsedPercent: 9,
      primaryResetAfterSeconds: 1800
    })

    expect(tokenRefreshServiceMock.acquireRefreshLock).toHaveBeenCalledWith('acct-1', 'openai')
    expect(tokenRefreshServiceMock.releaseRefreshLock).toHaveBeenCalledWith('acct-1', 'openai')
    expect(axiosMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: 'https://auth.openai.com/oauth/token'
      })
    )
    expect(axiosMock.get).toHaveBeenCalledTimes(2)
    expect(axiosMock.get.mock.calls[0][1].headers.Authorization).toBe('Bearer old-access-token')
    expect(axiosMock.get.mock.calls[1][1].headers.Authorization).toBe('Bearer new-access-token')
  })
})
