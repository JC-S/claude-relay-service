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

const claudeRelayConfigService = require('../src/services/claudeRelayConfigService')
const claudeRelayConfigRouter = require('../src/routes/admin/claudeRelayConfig')

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/admin', claudeRelayConfigRouter)
  return app
}

describe('Claude relay GPT-Image stream keepalive admin route', () => {
  let app

  beforeEach(() => {
    jest.clearAllMocks()
    app = buildApp()
    claudeRelayConfigService.getConfig.mockResolvedValue({
      openAIImageStreamKeepAliveEnabled: false
    })
    claudeRelayConfigService.updateConfig.mockImplementation(async (updates, updatedBy) => ({
      ...updates,
      updatedBy
    }))
  })

  test('returns the persisted field from the existing GET endpoint', async () => {
    const response = await request(app).get('/admin/claude-relay-config')

    expect(response.status).toBe(200)
    expect(response.body.config.openAIImageStreamKeepAliveEnabled).toBe(false)
  })

  test.each([true, false])('accepts and persists boolean value %p', async (enabled) => {
    const response = await request(app)
      .put('/admin/claude-relay-config')
      .send({ openAIImageStreamKeepAliveEnabled: enabled })

    expect(response.status).toBe(200)
    expect(claudeRelayConfigService.updateConfig).toHaveBeenCalledWith(
      { openAIImageStreamKeepAliveEnabled: enabled },
      'admin'
    )
    expect(response.body.config.openAIImageStreamKeepAliveEnabled).toBe(enabled)
  })

  test.each(['true', 1, null])('rejects non-boolean value %p', async (value) => {
    const response = await request(app)
      .put('/admin/claude-relay-config')
      .send({ openAIImageStreamKeepAliveEnabled: value })

    expect(response.status).toBe(400)
    expect(response.body.error).toBe('openAIImageStreamKeepAliveEnabled must be a boolean')
    expect(claudeRelayConfigService.updateConfig).not.toHaveBeenCalled()
  })

  test('does not overwrite the field when it is omitted from a partial update', async () => {
    const response = await request(app)
      .put('/admin/claude-relay-config')
      .send({ claudeCodeOnlyEnabled: true })

    expect(response.status).toBe(200)
    expect(claudeRelayConfigService.updateConfig).toHaveBeenCalledWith(
      { claudeCodeOnlyEnabled: true },
      'admin'
    )
  })
})
