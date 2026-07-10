const express = require('express')
const request = require('supertest')

let mockApiKeyData

jest.mock('axios', () => jest.fn())

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

jest.mock('../src/services/scheduler/droidScheduler', () => ({
  selectAccount: jest.fn()
}))

jest.mock('../src/models/redis', () => ({
  getSessionAccountMapping: jest.fn(),
  extendSessionAccountMappingTTL: jest.fn(),
  deleteSessionAccountMapping: jest.fn(),
  setSessionAccountMapping: jest.fn()
}))

jest.mock('../src/utils/rateLimitHelper', () => ({
  updateRateLimitCounters: jest.fn()
}))

jest.mock('../src/utils/runtimeAddon', () => ({
  emitSync: jest.fn((_event, payload) => payload)
}))

jest.mock('../src/utils/upstreamErrorHelper', () => ({
  markTempUnavailable: jest.fn(() => Promise.resolve()),
  clearTempUnavailable: jest.fn(() => Promise.resolve())
}))

jest.mock('../src/utils/logger', () => ({
  api: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  security: jest.fn(),
  success: jest.fn(),
  warn: jest.fn()
}))

const mockSetInterval = jest
  .spyOn(global, 'setInterval')
  .mockImplementation(() => ({ unref: jest.fn() }))
const axios = require('axios')
const apiKeyService = require('../src/services/apiKeyService')
const droidScheduler = require('../src/services/scheduler/droidScheduler')
const droidAccountService = require('../src/services/account/droidAccountService')
const droidRelayService = require('../src/services/relay/droidRelayService')
const droidRoutes = require('../src/routes/droidRoutes')
mockSetInterval.mockRestore()

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/droid', droidRoutes)
  return app
}

function parseRelayBody(result) {
  return JSON.parse(result.body)
}

describe('Droid user-facing English messages', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockApiKeyData = { id: 'key_1', name: 'test key', permissions: [] }
    apiKeyService.hasPermission.mockImplementation((permissions, service) =>
      Array.isArray(permissions) ? permissions.includes(service) : false
    )
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  test.each([
    ['/droid/claude/v1/messages', { model: 'claude-sonnet-4-5', messages: [] }],
    ['/droid/comm/v1/chat/completions', { model: 'gpt-5', messages: [] }],
    ['/droid/openai/v1/responses', { model: 'gpt-5', input: 'test' }]
  ])('uses one permission response for %s', async (path, body) => {
    const response = await request(buildApp()).post(path).send(body)

    expect(response.status).toBe(403)
    expect(response.body).toEqual({
      error: 'permission_denied',
      message: 'Droid access is not enabled for this API key.'
    })
  })

  test('returns 424 when an API-key account has no configured keys', async () => {
    droidScheduler.selectAccount.mockResolvedValue({
      id: 'droid_1',
      authenticationMethod: 'api_key'
    })
    jest.spyOn(droidAccountService, 'getDecryptedApiKeyEntries').mockResolvedValue([])

    const result = await droidRelayService.relayRequest(
      { model: 'gpt-5', input: 'test' },
      { id: 'key_1', name: 'test key' },
      {},
      {},
      {},
      { endpointType: 'openai' }
    )

    expect(result.statusCode).toBe(424)
    expect(parseRelayBody(result)).toEqual({
      error: 'relay_upstream_failure',
      message: 'Droid account droid_1 has no API keys configured.'
    })
  })

  test('returns 424 when every configured upstream key is in error', async () => {
    droidScheduler.selectAccount.mockResolvedValue({
      id: 'droid_1',
      authenticationMethod: 'api_key'
    })
    jest
      .spyOn(droidAccountService, 'getDecryptedApiKeyEntries')
      .mockResolvedValue([{ id: 'upstream_1', key: 'secret', status: 'error' }])

    const result = await droidRelayService.relayRequest(
      { model: 'gpt-5', input: 'test' },
      { id: 'key_1', name: 'test key' },
      {},
      {},
      {},
      { endpointType: 'openai' }
    )

    expect(result.statusCode).toBe(424)
    expect(parseRelayBody(result)).toEqual({
      error: 'relay_upstream_failure',
      message:
        'Droid account droid_1 has no available API keys (all configured API keys are in an error state).'
    })
  })

  test('uses the defensive no-selection message', async () => {
    jest.spyOn(droidAccountService, 'getDecryptedApiKeyEntries').mockResolvedValue({
      length: 1,
      filter: () => ({ length: 1 })
    })

    await expect(
      droidRelayService._selectApiKey({ id: 'droid_1' }, 'openai', null)
    ).rejects.toThrow('Droid account droid_1 has no available API keys.')
  })

  test('uses the English network fallback and preserves timeout status mapping', () => {
    expect(droidRelayService._mapNetworkErrorStatus({ code: 'ETIMEDOUT' })).toBe(408)
    expect(droidRelayService._mapNetworkErrorStatus({ code: 'ECONNRESET' })).toBe(424)
    expect(droidRelayService._buildNetworkErrorBody({})).toEqual({
      error: 'relay_upstream_failure',
      message: 'Upstream request failed.'
    })
  })

  test('rejects an invalid refresh token in English', async () => {
    await expect(droidAccountService._refreshTokensWithWorkOS(null)).rejects.toThrow(
      'Refresh token is invalid.'
    )
  })

  test('rejects a WorkOS response without an access token in English', async () => {
    axios.mockResolvedValue({ data: {} })

    await expect(droidAccountService._refreshTokensWithWorkOS('refresh_token')).rejects.toThrow(
      'WorkOS OAuth returned an invalid response.'
    )
  })

  test('rejects access-token lookup for an API-key account in English', async () => {
    jest.spyOn(droidAccountService, 'getAccount').mockResolvedValue({
      id: 'droid_1',
      authenticationMethod: 'api_key'
    })

    await expect(droidAccountService.getValidAccessToken('droid_1')).rejects.toThrow(
      'Droid account droid_1 is configured for API key authentication and cannot provide an access token.'
    )
  })

  test('surfaces an OAuth refresh failure through the existing 424 relay contract', async () => {
    droidScheduler.selectAccount.mockResolvedValue({
      id: 'droid_1',
      authenticationMethod: 'oauth'
    })
    jest
      .spyOn(droidAccountService, 'getValidAccessToken')
      .mockRejectedValue(new Error('Refresh token is invalid.'))

    const result = await droidRelayService.relayRequest(
      { model: 'gpt-5', input: 'test' },
      { id: 'key_1', name: 'test key' },
      {},
      {},
      {},
      { endpointType: 'openai' }
    )

    expect(result.statusCode).toBe(424)
    expect(parseRelayBody(result)).toEqual({
      error: 'relay_upstream_failure',
      message: 'Refresh token is invalid.'
    })
  })
})
