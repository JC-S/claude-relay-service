jest.mock('axios', () => ({ get: jest.fn() }))
jest.mock('../src/models/redis', () => ({
  setGrokAccount: jest.fn(),
  getGrokAccount: jest.fn(),
  getAllGrokAccounts: jest.fn(),
  deleteGrokAccount: jest.fn()
}))
jest.mock('../src/services/tokenRefreshService', () => ({
  acquireRefreshLock: jest.fn(),
  releaseRefreshLock: jest.fn()
}))
jest.mock('../src/services/grokOAuthService', () => ({ refreshTokens: jest.fn() }))
jest.mock('../src/utils/upstreamErrorHelper', () => ({ clearTempUnavailable: jest.fn() }))
jest.mock('../src/utils/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  success: jest.fn()
}))

const axios = require('axios')
const redis = require('../src/models/redis')
const tokenRefreshService = require('../src/services/tokenRefreshService')
const grokOAuthService = require('../src/services/grokOAuthService')
const grokAccountService = require('../src/services/account/grokAccountService')

describe('grokAccountService', () => {
  let stored

  beforeEach(() => {
    jest.clearAllMocks()
    stored = null
    redis.setGrokAccount.mockImplementation(async (_id, values) => {
      stored = { ...(stored || {}), ...values }
    })
    redis.getGrokAccount.mockImplementation(async () => stored || {})
  })

  test('encrypts credentials and only returns presence flags from safe APIs', async () => {
    const account = await grokAccountService.createAccount({
      authType: 'oauth',
      name: 'OAuth',
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      expiresAt: new Date(Date.now() + 3600000).toISOString()
    })
    expect(stored.accessToken).not.toContain('access-secret')
    expect(account).toEqual(
      expect.objectContaining({ hasAccessToken: true, hasRefreshToken: true })
    )
    expect(account).not.toHaveProperty('accessToken')
  })

  test('uses the API key directly without entering OAuth refresh', async () => {
    await grokAccountService.createAccount({ authType: 'api_key', apiKey: 'xai-key' })
    await expect(grokAccountService.getValidAccessToken(stored.id)).resolves.toBe('xai-key')
    expect(tokenRefreshService.acquireRefreshLock).not.toHaveBeenCalled()
  })

  test('refreshes an expiring OAuth token under the shared refresh lock', async () => {
    await grokAccountService.createAccount({
      authType: 'oauth',
      accessToken: 'old-access',
      refreshToken: 'refresh',
      expiresAt: new Date(Date.now() + 1000).toISOString()
    })
    tokenRefreshService.acquireRefreshLock.mockResolvedValue(true)
    grokOAuthService.refreshTokens.mockResolvedValue({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      accountInfo: {}
    })
    await expect(grokAccountService.getValidAccessToken(stored.id)).resolves.toBe('new-access')
    expect(tokenRefreshService.acquireRefreshLock).toHaveBeenCalledWith(stored.id, 'grok')
    expect(tokenRefreshService.releaseRefreshLock).toHaveBeenCalledWith(stored.id, 'grok')
  })

  test('classifies invalid_grant as reauthorization-required and keeps the account stopped', async () => {
    await grokAccountService.createAccount({
      authType: 'oauth',
      accessToken: 'old-access',
      refreshToken: 'invalid-refresh',
      expiresAt: new Date(Date.now() + 1000).toISOString()
    })
    tokenRefreshService.acquireRefreshLock.mockResolvedValue(true)
    grokOAuthService.refreshTokens.mockRejectedValue(
      Object.assign(new Error('invalid_grant'), {
        response: { status: 400, data: { error: 'invalid_grant' } }
      })
    )

    await expect(grokAccountService.getValidAccessToken(stored.id)).rejects.toMatchObject({
      code: 'GROK_REAUTH_REQUIRED',
      statusCode: 401
    })
    expect(await grokAccountService.getSafeAccount(stored.id)).toEqual(
      expect.objectContaining({ status: 'unauthorized', schedulable: false })
    )
  })

  test('restores an OAuth account after a temporary 401 cooldown expires', async () => {
    await grokAccountService.createAccount({
      authType: 'oauth',
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: new Date(Date.now() + 3600000).toISOString()
    })
    await grokAccountService.markTemporaryStatus(
      stored.id,
      401,
      new Date(Date.now() - 1000).toISOString(),
      'temporary unauthorized'
    )
    expect((await grokAccountService.getSafeAccount(stored.id)).schedulable).toBe(true)
    await expect(grokAccountService.clearExpiredTemporaryStatus(stored.id)).resolves.toBe(true)
    expect(await grokAccountService.getSafeAccount(stored.id)).toEqual(
      expect.objectContaining({ status: 'active', schedulable: true, lastErrorMessage: '' })
    )
  })

  test('keeps an API key account stopped after a persistent 401 credential error', async () => {
    await grokAccountService.createAccount({ authType: 'api_key', apiKey: 'xai-key' })
    await grokAccountService.markTemporaryStatus(
      stored.id,
      401,
      new Date(Date.now() - 1000).toISOString(),
      'invalid API key',
      { persistentCredentialError: true }
    )
    await expect(grokAccountService.clearExpiredTemporaryStatus(stored.id)).resolves.toBe(true)
    expect(await grokAccountService.getSafeAccount(stored.id)).toEqual(
      expect.objectContaining({ status: 'unauthorized', schedulable: false })
    )
  })

  test('keeps the existing model whitelist when model sync returns no text models', async () => {
    await grokAccountService.createAccount({
      authType: 'api_key',
      apiKey: 'xai-key',
      supportedModels: ['grok-4.5']
    })
    axios.get.mockResolvedValue({
      data: { data: [{ id: 'grok-imagine-1' }, { id: 'video-generation' }] }
    })

    await expect(grokAccountService.syncModels(stored.id)).rejects.toThrow(
      'xAI returned no supported Grok text models'
    )
    expect((await grokAccountService.getSafeAccount(stored.id)).supportedModels).toEqual([
      'grok-4.5'
    ])
  })
})
