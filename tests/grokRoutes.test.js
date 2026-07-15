const express = require('express')
const request = require('supertest')

let mockApiKeyData

jest.mock('../src/middleware/auth', () => ({
  authenticateApiKey: (req, _res, next) => {
    req.apiKey = mockApiKeyData
    next()
  }
}))
jest.mock('../src/services/apiKeyService', () => ({
  hasPermission: jest.fn(
    (permissions, service) => !permissions?.length || permissions.includes(service)
  )
}))
jest.mock('../src/services/modelService', () => ({
  getModelsByProvider: jest.fn(() => [
    { id: 'grok-4.5', object: 'model', owned_by: 'xai' },
    { id: 'grok-4.3', object: 'model', owned_by: 'xai' }
  ])
}))
jest.mock('../src/services/relay/grokRelayService', () => ({
  handle: jest.fn(async (_req, res) => res.json({ id: 'response', object: 'response' }))
}))
jest.mock('../src/utils/grokModelHelper', () => ({
  resolveGrokModel: jest.fn((model) =>
    model === 'grok-latest' ? 'grok-4.5' : String(model).toLowerCase()
  ),
  isSupportedGrokModel: jest.fn((model) => ['grok-4.5', 'grok-4.3'].includes(model)),
  hasValidGrokPricing: jest.fn(() => true)
}))

const config = require('../config/config')
const grokRelayService = require('../src/services/relay/grokRelayService')
const grokRoutes = require('../src/routes/grokRoutes')

const makeApp = () => {
  const app = express()
  app.use(express.json())
  app.use('/grok', grokRoutes)
  return app
}

describe('grokRoutes', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    config.grok.enabled = true
    mockApiKeyData = {
      id: 'key',
      enableGrokEndpoint: true,
      permissions: ['grok'],
      enableModelRestriction: false,
      restrictedModels: []
    }
  })

  test('keeps the provider behind the environment kill switch', async () => {
    config.grok.enabled = false
    const response = await request(makeApp()).get('/grok/models')
    expect(response.status).toBe(503)
    expect(response.body.error.code).toBe('provider_disabled')
  })

  test('requires both the per-key toggle and Grok permission', async () => {
    mockApiKeyData.enableGrokEndpoint = false
    expect((await request(makeApp()).get('/grok/models')).status).toBe(403)
    mockApiKeyData.enableGrokEndpoint = true
    mockApiKeyData.permissions = ['openai']
    expect((await request(makeApp()).get('/grok/models')).status).toBe(403)
  })

  test('supports /v1 aliases and applies model restrictions', async () => {
    mockApiKeyData.enableModelRestriction = true
    mockApiKeyData.restrictedModels = ['grok-4.3']
    const response = await request(makeApp()).get('/grok/v1/models')
    expect(response.status).toBe(200)
    expect(response.body.data.map((model) => model.id)).toEqual(['grok-4.5'])
  })

  test('validates the Responses request and dispatches known aliases', async () => {
    const missingInput = await request(makeApp())
      .post('/grok/responses')
      .send({ model: 'grok-4.5' })
    expect(missingInput.status).toBe(400)

    const valid = await request(makeApp())
      .post('/grok/v1/responses')
      .send({ model: 'grok-latest', input: 'hello', stream: false })
    expect(valid.status).toBe(200)
    expect(grokRelayService.handle).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), {
      requestedModel: 'grok-latest',
      defaultMappedModel: 'grok-4.5'
    })
  })

  test('does not expose compact or chat completions routes', async () => {
    expect((await request(makeApp()).post('/grok/responses/compact').send({})).status).toBe(404)
    expect((await request(makeApp()).post('/grok/chat/completions').send({})).status).toBe(404)
  })
})
