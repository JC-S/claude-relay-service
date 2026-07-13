const mockAccounts = new Map()

jest.mock('../src/models/redis', () => ({
  getClaudeAccount: jest.fn(async (id) => mockAccounts.get(id) || {}),
  getAllClaudeAccounts: jest.fn(async () => Array.from(mockAccounts.values())),
  setClaudeAccount: jest.fn(async (id, data) => {
    mockAccounts.set(id, { ...data })
  }),
  client: {
    hdel: jest.fn(async () => 1)
  }
}))

jest.mock('axios', () => ({
  post: jest.fn()
}))

jest.mock('../src/utils/proxyHelper', () => ({
  createProxyAgent: jest.fn(() => null),
  getProxyDescription: jest.fn(() => 'proxy')
}))

jest.mock('../src/utils/logger', () => ({
  authDetail: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))

jest.mock('../src/utils/tokenRefreshLogger', () => ({
  logRefreshStart: jest.fn(),
  logRefreshSuccess: jest.fn(),
  logRefreshError: jest.fn(),
  logTokenUsage: jest.fn(),
  logRefreshSkipped: jest.fn()
}))

jest.mock('../src/services/tokenRefreshService', () => ({
  acquireRefreshLock: jest.fn(async () => true),
  releaseRefreshLock: jest.fn(async () => true)
}))

jest.mock('../src/utils/upstreamErrorHelper', () => ({
  recordErrorHistory: jest.fn(async () => undefined)
}))

jest.mock('../src/utils/webhookNotifier', () => ({
  sendAccountAnomalyNotification: jest.fn(async () => undefined)
}))

const axios = require('axios')
const redis = require('../src/models/redis')
const claudeAccountService = require('../src/services/account/claudeAccountService')

const normalizeEncryptedValue = (value) => {
  if (!value) return ''
  return String(value).startsWith('encrypted:') ? String(value).slice('encrypted:'.length) : value
}

const seedRefreshableAccount = (overrides = {}) => {
  const account = {
    id: 'claude-refresh-1',
    name: 'Claude OAuth',
    refreshToken: 'encrypted:old-refresh-token',
    accessToken: 'encrypted:old-access-token',
    refreshTokenExpiresAt: '2026-08-01T00:00:00.000Z',
    expiresAt: '0',
    scopes: 'user:inference',
    proxy: '',
    status: 'active',
    ...overrides
  }
  mockAccounts.set(account.id, account)
  return account
}

describe('Claude account Refresh Token expiry persistence', () => {
  const nowMs = Date.parse('2026-07-13T00:00:00.000Z')

  beforeEach(() => {
    jest.clearAllMocks()
    mockAccounts.clear()
    jest
      .spyOn(claudeAccountService, '_encryptSensitiveData')
      .mockImplementation((value) => (value ? `encrypted:${value}` : ''))
    jest
      .spyOn(claudeAccountService, '_decryptSensitiveData')
      .mockImplementation(normalizeEncryptedValue)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('stores a normalized expiry for OAuth accounts and an empty value otherwise', async () => {
    const withExpiry = await claudeAccountService.createAccount({
      name: 'OAuth with expiry',
      claudeAiOauth: {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: nowMs + 3600000,
        refreshTokenExpiresAt: '2026-08-01T08:00:00+08:00',
        scopes: ['user:inference']
      }
    })
    const withoutExpiry = await claudeAccountService.createAccount({
      name: 'OAuth without expiry',
      claudeAiOauth: {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: nowMs + 3600000,
        scopes: ['user:inference']
      }
    })
    const legacy = await claudeAccountService.createAccount({
      name: 'Legacy account',
      refreshToken: 'legacy-refresh-token'
    })

    expect(mockAccounts.get(withExpiry.id).refreshTokenExpiresAt).toBe('2026-08-01T00:00:00.000Z')
    expect(withExpiry.refreshTokenExpiresAt).toBe('2026-08-01T00:00:00.000Z')
    expect(mockAccounts.get(withoutExpiry.id).refreshTokenExpiresAt).toBe('')
    expect(withoutExpiry.refreshTokenExpiresAt).toBeNull()
    expect(mockAccounts.get(legacy.id).refreshTokenExpiresAt).toBe('')
  })

  test('updates or clears the expiry only through a complete OAuth authorization update', async () => {
    seedRefreshableAccount()

    await claudeAccountService.updateAccount('claude-refresh-1', {
      refreshTokenExpiresAt: '2026-09-01T00:00:00.000Z'
    })
    expect(mockAccounts.get('claude-refresh-1').refreshTokenExpiresAt).toBe(
      '2026-08-01T00:00:00.000Z'
    )

    await claudeAccountService.updateAccount('claude-refresh-1', {
      claudeAiOauth: {
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        expiresAt: nowMs + 3600000,
        refreshTokenExpiresAt: '2026-09-01T08:00:00+08:00',
        scopes: ['user:profile', 'user:inference']
      }
    })
    expect(mockAccounts.get('claude-refresh-1').refreshTokenExpiresAt).toBe(
      '2026-09-01T00:00:00.000Z'
    )

    await claudeAccountService.updateAccount('claude-refresh-1', {
      claudeAiOauth: {
        accessToken: 'third-access-token',
        refreshToken: 'third-refresh-token',
        expiresAt: nowMs + 3600000,
        scopes: ['user:profile', 'user:inference']
      }
    })
    expect(mockAccounts.get('claude-refresh-1').refreshTokenExpiresAt).toBe('')
  })

  test('overwrites the expiry when a refresh response contains a valid lifetime', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(nowMs)
    seedRefreshableAccount()
    axios.post.mockResolvedValue({
      status: 200,
      data: {
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
        refresh_token_expires_in: 86400
      }
    })

    await claudeAccountService.refreshAccountToken('claude-refresh-1')

    expect(mockAccounts.get('claude-refresh-1')).toEqual(
      expect.objectContaining({
        refreshToken: 'encrypted:new-refresh-token',
        refreshTokenExpiresAt: '2026-07-14T00:00:00.000Z'
      })
    )
  })

  test('preserves the stored token and expiry when both fields are omitted', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(nowMs)
    seedRefreshableAccount()
    axios.post.mockResolvedValue({
      status: 200,
      data: {
        access_token: 'new-access-token',
        expires_in: 3600
      }
    })

    await claudeAccountService.refreshAccountToken('claude-refresh-1')

    expect(mockAccounts.get('claude-refresh-1')).toEqual(
      expect.objectContaining({
        refreshToken: 'encrypted:old-refresh-token',
        refreshTokenExpiresAt: '2026-08-01T00:00:00.000Z'
      })
    )
  })

  test('preserves the expiry when the response repeats the existing token without a lifetime', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(nowMs)
    seedRefreshableAccount()
    axios.post.mockResolvedValue({
      status: 200,
      data: {
        access_token: 'new-access-token',
        refresh_token: 'old-refresh-token',
        expires_in: 3600
      }
    })

    await claudeAccountService.refreshAccountToken('claude-refresh-1')

    expect(mockAccounts.get('claude-refresh-1').refreshTokenExpiresAt).toBe(
      '2026-08-01T00:00:00.000Z'
    )
  })

  test('clears the expiry when the token actually rotates without a lifetime', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(nowMs)
    seedRefreshableAccount()
    axios.post.mockResolvedValue({
      status: 200,
      data: {
        access_token: 'new-access-token',
        refresh_token: 'rotated-refresh-token',
        expires_in: 3600
      }
    })

    await claudeAccountService.refreshAccountToken('claude-refresh-1')

    expect(mockAccounts.get('claude-refresh-1')).toEqual(
      expect.objectContaining({
        refreshToken: 'encrypted:rotated-refresh-token',
        refreshTokenExpiresAt: ''
      })
    )
  })

  test('lists the normalized expiry without exposing Refresh Token plaintext', async () => {
    seedRefreshableAccount({
      scopes: 'user:profile user:inference',
      subscriptionExpiresAt: ''
    })
    mockAccounts.set('claude-refresh-2', {
      id: 'claude-refresh-2',
      name: 'Unknown expiry',
      refreshToken: 'encrypted:another-secret-token',
      refreshTokenExpiresAt: '',
      scopes: 'user:profile user:inference',
      proxy: '',
      subscriptionExpiresAt: ''
    })
    jest.spyOn(claudeAccountService, 'getAccountRateLimitInfo').mockResolvedValue(null)
    jest.spyOn(claudeAccountService, 'getSessionWindowInfo').mockResolvedValue(null)
    jest.spyOn(claudeAccountService, 'getAccountModelRateLimitInfo').mockResolvedValue(null)
    jest.spyOn(claudeAccountService, 'isAccountOverloaded').mockResolvedValue(false)

    const accounts = await claudeAccountService.getAllAccounts()

    expect(accounts).toHaveLength(2)
    expect(accounts[0]).toEqual(
      expect.objectContaining({
        refreshTokenExpiresAt: '2026-08-01T00:00:00.000Z',
        hasRefreshToken: true
      })
    )
    expect(accounts[1].refreshTokenExpiresAt).toBeNull()
    expect(accounts[0]).not.toHaveProperty('refreshToken')
    expect(accounts[1]).not.toHaveProperty('refreshToken')
    expect(JSON.stringify(accounts)).not.toContain('another-secret-token')
    expect(redis.getAllClaudeAccounts).toHaveBeenCalledTimes(1)
  })
})
