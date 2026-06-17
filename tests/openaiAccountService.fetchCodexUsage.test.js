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

  test('fetches wham usage with decrypted access token and writes relative reset seconds', async () => {
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
            reset_at: nowSeconds + 3600
          },
          secondary_window: {
            used_percent: 34.5,
            reset_at: nowSeconds + 7200
          }
        }
      }
    })

    await expect(service.fetchCodexUsage('acct-1', { timeoutMs: 1234 })).resolves.toEqual({
      primaryUsedPercent: 12.5,
      primaryResetAfterSeconds: 3600,
      secondaryUsedPercent: 34.5,
      secondaryResetAfterSeconds: 7200
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
        codexSecondaryUsedPercent: '34.5',
        codexSecondaryResetAfterSeconds: '7200',
        codexUsageUpdatedAt: expect.any(String)
      })
    )
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
