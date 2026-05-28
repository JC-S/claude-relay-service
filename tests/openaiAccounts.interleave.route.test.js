const express = require('express')
const request = require('supertest')

jest.mock('../src/middleware/auth', () => ({
  authenticateAdmin: (_req, _res, next) => next()
}))

jest.mock('../src/services/account/openaiAccountService', () => ({
  createAccount: jest.fn(),
  updateAccount: jest.fn(),
  getAccount: jest.fn(),
  refreshAccountToken: jest.fn(),
  deleteAccount: jest.fn(),
  getAllAccounts: jest.fn()
}))

jest.mock('../src/services/accountGroupService', () => ({
  setAccountGroups: jest.fn(),
  addAccountToGroup: jest.fn(),
  removeAccountFromAllGroups: jest.fn(),
  getAccountGroups: jest.fn()
}))

jest.mock('../src/services/apiKeyService', () => ({}))
jest.mock('../src/models/redis', () => ({}))
jest.mock('axios', () => ({}))

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  debug: jest.fn()
}))

jest.mock('../src/utils/proxyHelper', () => ({
  validateProxyConfig: jest.fn((proxy) => {
    if (!proxy) {
      return false
    }
    const parsed = typeof proxy === 'string' ? JSON.parse(proxy) : proxy
    return Boolean(parsed.type && parsed.host && parsed.port)
  })
}))

jest.mock('../src/utils/openaiNicSelector', () => ({
  isAvailable: jest.fn(),
  getCooldownSnapshot: jest.fn()
}))

jest.mock('../src/utils/webhookNotifier', () => ({}))

jest.mock('../src/routes/admin/utils', () => ({
  formatAccountExpiry: jest.fn((account) => account),
  mapExpiryField: jest.fn((updates) => updates)
}))

const openaiAccountService = require('../src/services/account/openaiAccountService')
const openaiNicSelector = require('../src/utils/openaiNicSelector')
const openaiAccountsRouter = require('../src/routes/admin/openaiAccounts')

const VALID_PROXY = {
  type: 'socks5',
  host: '127.0.0.1',
  port: 1080
}

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/admin/openai-accounts', openaiAccountsRouter)
  return app
}

function mockCurrentAccount(overrides = {}) {
  openaiAccountService.getAccount.mockResolvedValue({
    id: 'acct_1',
    name: 'OpenAI Account',
    accountType: 'shared',
    proxy: null,
    interleaveNicEnabled: 'false',
    interleaveNicTtlHours: '24',
    ...overrides
  })
}

describe('OpenAI account NIC interleave admin route validation', () => {
  let app

  beforeEach(() => {
    jest.clearAllMocks()
    app = buildApp()
    openaiNicSelector.isAvailable.mockReturnValue(true)
    openaiNicSelector.getCooldownSnapshot.mockResolvedValue({
      configured: true,
      totalCount: 2,
      availableCount: 1,
      addresses: [
        { localAddress: '10.0.0.191', status: 'cooldown', active: true, ttlSeconds: 120 },
        { localAddress: '10.0.0.184', status: 'available', active: false, ttlSeconds: 0 }
      ]
    })
    openaiAccountService.createAccount.mockImplementation(async (data) => ({
      id: 'acct_created',
      ...data
    }))
    openaiAccountService.updateAccount.mockImplementation(async (id, data) => ({
      id,
      ...data
    }))
    mockCurrentAccount()
  })

  test('POST rejects interleave when a valid proxy is also configured', async () => {
    const response = await request(app).post('/admin/openai-accounts').send({
      name: 'OpenAI Account',
      proxy: VALID_PROXY,
      interleaveNicEnabled: true,
      interleaveNicTtlHours: 12
    })

    expect(response.status).toBe(400)
    expect(response.body.message).toContain('互斥')
    expect(openaiAccountService.createAccount).not.toHaveBeenCalled()
  })

  test.each([0, 73, 'abc'])('POST rejects invalid interleave TTL: %s', async (ttl) => {
    const response = await request(app).post('/admin/openai-accounts').send({
      name: 'OpenAI Account',
      interleaveNicEnabled: true,
      interleaveNicTtlHours: ttl
    })

    expect(response.status).toBe(400)
    expect(response.body.message).toContain('1-72')
    expect(openaiAccountService.createAccount).not.toHaveBeenCalled()
  })

  test('POST rejects interleave when the server has fewer than two local addresses', async () => {
    openaiNicSelector.isAvailable.mockReturnValue(false)

    const response = await request(app).post('/admin/openai-accounts').send({
      name: 'OpenAI Account',
      interleaveNicEnabled: true,
      interleaveNicTtlHours: 12
    })

    expect(response.status).toBe(400)
    expect(response.body.message).toContain('至少 2 个')
    expect(openaiAccountService.createAccount).not.toHaveBeenCalled()
  })

  test('POST accepts interleave when proxy is absent and server config is available', async () => {
    const response = await request(app).post('/admin/openai-accounts').send({
      name: 'OpenAI Account',
      interleaveNicEnabled: true,
      interleaveNicTtlHours: 12
    })

    expect(response.status).toBe(200)
    expect(openaiAccountService.createAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        interleaveNicEnabled: true,
        interleaveNicTtlHours: 12,
        proxy: null
      })
    )
  })

  test('PUT rejects enabling interleave when the current account already has a valid proxy', async () => {
    mockCurrentAccount({ proxy: VALID_PROXY })

    const response = await request(app).put('/admin/openai-accounts/acct_1').send({
      interleaveNicEnabled: true
    })

    expect(response.status).toBe(400)
    expect(response.body.message).toContain('互斥')
    expect(openaiAccountService.updateAccount).not.toHaveBeenCalled()
  })

  test('PUT rejects adding a valid proxy when interleave remains enabled', async () => {
    mockCurrentAccount({ interleaveNicEnabled: 'true', interleaveNicTtlHours: '12' })

    const response = await request(app).put('/admin/openai-accounts/acct_1').send({
      proxy: VALID_PROXY
    })

    expect(response.status).toBe(400)
    expect(response.body.message).toContain('互斥')
    expect(openaiAccountService.updateAccount).not.toHaveBeenCalled()
  })

  test('PUT accepts adding proxy when the same request disables interleave', async () => {
    mockCurrentAccount({ interleaveNicEnabled: 'true', interleaveNicTtlHours: '12' })

    const response = await request(app).put('/admin/openai-accounts/acct_1').send({
      interleaveNicEnabled: false,
      proxy: VALID_PROXY
    })

    expect(response.status).toBe(200)
    expect(openaiAccountService.updateAccount).toHaveBeenCalledWith(
      'acct_1',
      expect.objectContaining({
        interleaveNicEnabled: false,
        proxy: VALID_PROXY
      })
    )
  })

  test('PUT rejects invalid effective TTL', async () => {
    const response = await request(app).put('/admin/openai-accounts/acct_1').send({
      interleaveNicTtlHours: 99
    })

    expect(response.status).toBe(400)
    expect(response.body.message).toContain('1-72')
    expect(openaiAccountService.updateAccount).not.toHaveBeenCalled()
  })

  test('GET returns NIC cooldown status for an OpenAI account', async () => {
    const response = await request(app).get('/admin/openai-accounts/acct_1/nic-cooldowns')

    expect(response.status).toBe(200)
    expect(openaiAccountService.getAccount).toHaveBeenCalledWith('acct_1')
    expect(openaiNicSelector.getCooldownSnapshot).toHaveBeenCalledWith({ accountId: 'acct_1' })
    expect(response.body.data.addresses).toEqual([
      { localAddress: '10.0.0.191', status: 'cooldown', active: true, ttlSeconds: 120 },
      { localAddress: '10.0.0.184', status: 'available', active: false, ttlSeconds: 0 }
    ])
  })

  test('GET returns 404 when querying NIC cooldown status for a missing account', async () => {
    openaiAccountService.getAccount.mockResolvedValueOnce(null)

    const response = await request(app).get('/admin/openai-accounts/missing/nic-cooldowns')

    expect(response.status).toBe(404)
    expect(openaiNicSelector.getCooldownSnapshot).not.toHaveBeenCalled()
  })
})
