const express = require('express')
const request = require('supertest')

let mockApiKeyData
const mockModels = []
const mockGetValidatedImagePricing = jest.fn()

jest.mock('../src/middleware/auth', () => ({
  authenticateApiKey: jest.fn((req, _res, next) => {
    req.apiKey = { ...mockApiKeyData }
    next()
  })
}))

jest.mock('../src/services/apiKeyService', () => ({
  hasPermission: jest.fn((permissions, target) => permissions.includes(target))
}))

jest.mock('../src/services/modelService', () => ({
  getModelsByProvider: jest.fn(() => [...mockModels])
}))

jest.mock('../src/utils/costCalculator', () => ({
  getValidatedImagePricing: (...args) => mockGetValidatedImagePricing(...args)
}))

jest.mock('../src/routes/openaiRoutes', () => ({
  handleResponses: jest.fn(),
  handleImages: jest.fn(async (req, res) =>
    res.json({
      body: req.body,
      endpoint: req._openAIImageEndpoint,
      stream: req._downstreamStream,
      schedulerOptions: req._openAISchedulerOptions,
      snapshot: req._openAIImageRequestSnapshot
    })
  )
}))

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn()
}))

const openaiRoutes = require('../src/routes/openaiRoutes')
const generalOpenAIRoutes = require('../src/routes/generalOpenAIRoutes')

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/general', generalOpenAIRoutes)
  return app
}

describe('/general GPT-Image-2 routes', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockModels.splice(0)
    mockGetValidatedImagePricing.mockReturnValue({ pricingData: {} })
    mockApiKeyData = {
      id: 'key-image',
      name: 'image-key',
      permissions: ['openai'],
      enableGeneralOpenAIEndpoint: true,
      enableGeneralOpenAIImages: true,
      enableModelRestriction: false,
      restrictedModels: []
    }
  })

  test('requires the per-key image permission', async () => {
    mockApiKeyData.enableGeneralOpenAIImages = false
    const response = await request(buildApp()).post('/general/v1/images/generations').send({
      model: 'gpt-image-2',
      prompt: 'A lighthouse'
    })

    expect(response.status).toBe(403)
    expect(openaiRoutes.handleImages).not.toHaveBeenCalled()
  })

  test('forwards a validated generation request to native OpenAI OAuth scheduling', async () => {
    const response = await request(buildApp()).post('/general/v1/images/generations').send({
      model: 'gpt-image-2',
      prompt: 'A lighthouse',
      stream: false,
      size: '1024x1024'
    })

    expect(response.status).toBe(200)
    expect(response.body.body).toEqual({
      model: 'gpt-image-2',
      prompt: 'A lighthouse',
      size: '1024x1024'
    })
    expect(response.body.endpoint).toBe('generations')
    expect(response.body.stream).toBe(false)
    expect(response.body.schedulerOptions).toEqual({ allowedAccountTypes: ['openai'] })
    expect(openaiRoutes.handleImages).toHaveBeenCalledTimes(1)
  })

  test.each(['codex/gpt-image-2', 'gpt-image-1.5', 'GPT-IMAGE-2'])(
    'rejects unsupported model id %s before dispatch',
    async (model) => {
      const response = await request(buildApp()).post('/general/v1/images/generations').send({
        model,
        prompt: 'A lighthouse'
      })

      expect(response.status).toBe(400)
      expect(response.body.error.code).toBe('model_not_supported')
      expect(openaiRoutes.handleImages).not.toHaveBeenCalled()
    }
  )

  test('blocks a restricted GPT-Image-2 model', async () => {
    mockApiKeyData.enableModelRestriction = true
    mockApiKeyData.restrictedModels = ['gpt-image-2']
    const response = await request(buildApp()).post('/general/v1/images/generations').send({
      model: 'gpt-image-2',
      prompt: 'A lighthouse'
    })

    expect(response.status).toBe(403)
    expect(response.body.error.code).toBe('model_not_allowed')
    expect(openaiRoutes.handleImages).not.toHaveBeenCalled()
  })

  test('returns pricing_unavailable before dispatch', async () => {
    mockGetValidatedImagePricing.mockImplementation(() => {
      const error = new Error('missing image price')
      error.statusCode = 503
      throw error
    })
    const response = await request(buildApp()).post('/general/v1/images/generations').send({
      model: 'gpt-image-2',
      prompt: 'A lighthouse'
    })

    expect(response.status).toBe(503)
    expect(response.body.error.code).toBe('pricing_unavailable')
    expect(openaiRoutes.handleImages).not.toHaveBeenCalled()
  })

  test('adds GPT-Image-2 to models only when enabled and allowed, without duplicates', async () => {
    mockModels.push({ id: 'gpt-5.5', object: 'model' })
    const enabled = await request(buildApp()).get('/general/v1/models')
    expect(enabled.body.data.map((model) => model.id)).toEqual(['gpt-5.5', 'gpt-image-2'])

    mockModels.push({ id: 'gpt-image-2', object: 'model' })
    const deduplicated = await request(buildApp()).get('/general/v1/models')
    expect(deduplicated.body.data.filter((model) => model.id === 'gpt-image-2')).toHaveLength(1)

    mockApiKeyData.enableGeneralOpenAIImages = false
    mockModels.splice(1)
    const disabled = await request(buildApp()).get('/general/v1/models')
    expect(disabled.body.data.map((model) => model.id)).toEqual(['gpt-5.5'])
  })
})
