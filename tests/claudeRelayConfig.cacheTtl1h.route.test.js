const express = require('express')
const request = require('supertest')

jest.mock('../src/middleware/auth', () => ({
  authenticateAdmin: (req, _res, next) => {
    req.admin = { username: 'admin' }
    next()
  }
}))

jest.mock('../src/services/claudeRelayConfigService', () => ({
  getConfig: jest.fn(),
  updateConfig: jest.fn(),
  getSessionBindingStats: jest.fn()
}))

jest.mock('../src/services/requestDetailService', () => ({
  purgeRequestBodySnapshots: jest.fn()
}))

jest.mock('../src/utils/logger', () => ({
  error: jest.fn(),
  info: jest.fn()
}))

const configService = require('../src/services/claudeRelayConfigService')
const configRouter = require('../src/routes/admin/claudeRelayConfig')

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/admin', configRouter)
  return app
}

describe('Claude relay Anthropic cache TTL 1h admin route', () => {
  let app

  beforeEach(() => {
    jest.clearAllMocks()
    app = buildApp()
    configService.getConfig.mockResolvedValue({ anthropicCacheTtl1hInjectionEnabled: false })
    configService.updateConfig.mockImplementation(async (updates, updatedBy) => ({
      ...updates,
      updatedBy
    }))
  })

  test('returns the persisted field from GET', async () => {
    const response = await request(app).get('/admin/claude-relay-config')
    expect(response.status).toBe(200)
    expect(response.body.config.anthropicCacheTtl1hInjectionEnabled).toBe(false)
  })

  test.each([true, false])('accepts boolean value %p', async (enabled) => {
    const response = await request(app)
      .put('/admin/claude-relay-config')
      .send({ anthropicCacheTtl1hInjectionEnabled: enabled })

    expect(response.status).toBe(200)
    expect(configService.updateConfig).toHaveBeenCalledWith(
      { anthropicCacheTtl1hInjectionEnabled: enabled },
      'admin'
    )
  })

  test.each(['true', 1, null])('rejects non-boolean value %p', async (value) => {
    const response = await request(app)
      .put('/admin/claude-relay-config')
      .send({ anthropicCacheTtl1hInjectionEnabled: value })

    expect(response.status).toBe(400)
    expect(response.body.error).toBe('anthropicCacheTtl1hInjectionEnabled must be a boolean')
    expect(configService.updateConfig).not.toHaveBeenCalled()
  })

  test('does not overwrite the field when omitted', async () => {
    await request(app).put('/admin/claude-relay-config').send({ claudeCodeOnlyEnabled: true })
    expect(configService.updateConfig).toHaveBeenCalledWith(
      { claudeCodeOnlyEnabled: true },
      'admin'
    )
  })
})
