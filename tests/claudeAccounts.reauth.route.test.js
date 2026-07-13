const express = require('express')
const request = require('supertest')

jest.mock('../src/middleware/auth', () => ({
  authenticateAdmin: (_req, _res, next) => next()
}))

jest.mock('../src/services/account/claudeAccountService', () => ({
  getAccount: jest.fn(),
  updateAccount: jest.fn(),
  resetAccountStatus: jest.fn()
}))

jest.mock('../src/services/relay/claudeRelayService', () => ({}))
jest.mock('../src/services/accountGroupService', () => ({}))
jest.mock('../src/services/accountTestSchedulerService', () => ({}))
jest.mock('../src/services/apiKeyService', () => ({}))
jest.mock('../src/models/redis', () => ({}))
jest.mock('../src/utils/oauthHelper', () => ({}))
jest.mock('../src/utils/costCalculator', () => ({}))
jest.mock('../src/utils/webhookNotifier', () => ({}))

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  debug: jest.fn()
}))

jest.mock('../src/routes/admin/utils', () => ({
  formatAccountExpiry: jest.fn((account) => account),
  mapExpiryField: jest.fn((updates) => updates)
}))

const claudeAccountService = require('../src/services/account/claudeAccountService')
const claudeAccountsRouter = require('../src/routes/admin/claudeAccounts')

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/admin', claudeAccountsRouter)
  return app
}

function mockClaudeOAuthAccount(overrides = {}) {
  claudeAccountService.getAccount.mockResolvedValue({
    id: 'claude_1',
    name: 'Claude OAuth',
    scopes: 'user:profile user:inference',
    expiresAt: '1760000000000',
    ...overrides
  })
}

describe('Claude OAuth account reauth admin route', () => {
  let app

  beforeEach(() => {
    jest.clearAllMocks()
    app = buildApp()
    mockClaudeOAuthAccount()
    claudeAccountService.updateAccount.mockResolvedValue({ success: true })
    claudeAccountService.resetAccountStatus.mockResolvedValue({ success: true })
  })

  test('updates OAuth token and resets account status', async () => {
    const response = await request(app)
      .post('/admin/claude-accounts/claude_1/reauth')
      .send({
        claudeAiOauth: {
          accessToken: 'new_access',
          refreshToken: 'new_refresh',
          expiresAt: 1770000000000,
          refreshTokenExpiresAt: '2026-08-10T00:00:00.000Z',
          scopes: ['user:profile', 'user:inference'],
          extInfo: { org_uuid: 'org_1' }
        }
      })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      success: true,
      message: '重新授权成功，账户状态已重置'
    })
    expect(claudeAccountService.updateAccount).toHaveBeenCalledWith('claude_1', {
      claudeAiOauth: {
        accessToken: 'new_access',
        refreshToken: 'new_refresh',
        expiresAt: 1770000000000,
        refreshTokenExpiresAt: '2026-08-10T00:00:00.000Z',
        scopes: ['user:profile', 'user:inference'],
        extInfo: { org_uuid: 'org_1' }
      }
    })
    expect(claudeAccountService.resetAccountStatus).toHaveBeenCalledWith('claude_1')
  })

  test('forwards an OAuth authorization result without an expiry so the service can clear it', async () => {
    const response = await request(app)
      .post('/admin/claude-accounts/claude_1/reauth')
      .send({
        claudeAiOauth: {
          accessToken: 'new_access',
          refreshToken: 'new_refresh',
          expiresAt: 1770000000000,
          scopes: ['user:profile', 'user:inference']
        }
      })

    expect(response.status).toBe(200)
    expect(claudeAccountService.updateAccount).toHaveBeenCalledWith('claude_1', {
      claudeAiOauth: {
        accessToken: 'new_access',
        refreshToken: 'new_refresh',
        expiresAt: 1770000000000,
        scopes: ['user:profile', 'user:inference']
      }
    })
  })

  test('rejects non-OAuth target account', async () => {
    mockClaudeOAuthAccount({ scopes: 'org:create_api_key user:inference' })

    const response = await request(app)
      .post('/admin/claude-accounts/claude_1/reauth')
      .send({
        claudeAiOauth: {
          accessToken: 'new_access',
          refreshToken: 'new_refresh',
          expiresAt: 1770000000000,
          scopes: ['user:profile', 'user:inference']
        }
      })

    expect(response.status).toBe(400)
    expect(response.body.message).toBe('仅 Claude 官方 OAuth 账户支持重新授权')
    expect(claudeAccountService.updateAccount).not.toHaveBeenCalled()
    expect(claudeAccountService.resetAccountStatus).not.toHaveBeenCalled()
  })

  test('rejects non-OAuth authorization result', async () => {
    const response = await request(app)
      .post('/admin/claude-accounts/claude_1/reauth')
      .send({
        claudeAiOauth: {
          accessToken: 'new_access',
          refreshToken: 'new_refresh',
          expiresAt: 1770000000000,
          scopes: ['org:create_api_key', 'user:inference']
        }
      })

    expect(response.status).toBe(400)
    expect(response.body.message).toBe('授权结果不是 Claude 官方 OAuth 账户，请重新授权')
    expect(claudeAccountService.updateAccount).not.toHaveBeenCalled()
    expect(claudeAccountService.resetAccountStatus).not.toHaveBeenCalled()
  })

  test('rejects missing token values', async () => {
    const response = await request(app)
      .post('/admin/claude-accounts/claude_1/reauth')
      .send({
        claudeAiOauth: {
          accessToken: 'new_access',
          scopes: ['user:profile', 'user:inference']
        }
      })

    expect(response.status).toBe(400)
    expect(response.body.message).toBe('Access Token 和 Refresh Token 不能为空')
    expect(claudeAccountService.updateAccount).not.toHaveBeenCalled()
    expect(claudeAccountService.resetAccountStatus).not.toHaveBeenCalled()
  })
})
