const express = require('express')
const request = require('supertest')

jest.mock('../src/middleware/auth', () => ({
  authenticateApiKey: jest.fn((req, _res, next) => {
    req.apiKey = {
      id: 'key-1',
      permissions: ['openai'],
      enableGeneralOpenAIEndpoint: true,
      enableModelRestriction: false,
      restrictedModels: []
    }
    next()
  })
}))

jest.mock('../src/services/apiKeyService', () => ({
  hasPermission: jest.fn(() => true)
}))

jest.mock('../src/services/modelService', () => ({
  getModelsByProvider: jest.fn(() => [])
}))

jest.mock('../src/routes/openaiRoutes', () => ({
  handleResponses: jest.fn(async (req, res) =>
    res.json({
      requestBody: req.body,
      general: req._generalOpenAIEndpoint,
      schedulerOptions: req._openAISchedulerOptions,
      downstreamStream: req._downstreamStream,
      forceCodexUpstreamStream: req._forceCodexUpstreamStream,
      originalUrl: req.originalUrl,
      url: req.url,
      path: req.path
    })
  )
}))

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  error: jest.fn()
}))

const openaiRoutes = require('../src/routes/openaiRoutes')
const generalOpenAIRoutes = require('../src/routes/generalOpenAIRoutes')

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/general', generalOpenAIRoutes)
  return app
}

describe('/general OpenAI-compatible instructions handling', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('chat completions add empty instructions like CLIProxyAPI when missing', async () => {
    const app = buildApp()

    const response = await request(app)
      .post('/general/v1/chat/completions')
      .send({
        model: 'gpt-5.4',
        stream: false,
        messages: [
          { role: 'system', content: 'Translate to Simplified Chinese only.' },
          { role: 'user', content: 'Hello World.' }
        ]
      })

    expect(response.status).toBe(200)
    expect(openaiRoutes.handleResponses).toHaveBeenCalledTimes(1)
    expect(response.body.requestBody.instructions).toBe('')
    expect(response.body.requestBody.stream).toBe(true)
    expect(response.body.requestBody.input[0]).toMatchObject({
      type: 'message',
      role: 'developer'
    })
    expect(response.body.general).toBe(true)
    expect(response.body.downstreamStream).toBe(false)
    expect(response.body.forceCodexUpstreamStream).toBe(true)
    expect(response.body.schedulerOptions).toEqual({ allowedAccountTypes: ['openai'] })
    expect(response.body.originalUrl).toBe('/general/v1/chat/completions')
  })

  test('chat completions tolerate clients that append endpoint to a full endpoint URL', async () => {
    const app = buildApp()

    const response = await request(app)
      .post('/general/v1/chat/completions/v1/chat/completions')
      .query({ source: 'compat' })
      .send({
        model: 'gpt-5.4',
        stream: false,
        messages: [{ role: 'user', content: 'Hello World.' }]
      })

    expect(response.status).toBe(200)
    expect(openaiRoutes.handleResponses).toHaveBeenCalledTimes(1)
    expect(response.body.requestBody.instructions).toBe('')
    expect(response.body.requestBody.stream).toBe(true)
    expect(response.body.general).toBe(true)
    expect(response.body.originalUrl).toBe('/general/v1/chat/completions?source=compat')
    expect(response.body.url).toBe('/v1/responses')
    expect(response.body.path).toBe('/v1/responses')
  })

  test('chat completions preserve Responses-style reasoning effort', async () => {
    const app = buildApp()

    const response = await request(app)
      .post('/general/v1/chat/completions')
      .send({
        model: 'gpt-5.5',
        stream: false,
        reasoning: { effort: 'xhigh' },
        messages: [{ role: 'user', content: 'call ping' }]
      })

    expect(response.status).toBe(200)
    expect(response.body.requestBody.reasoning).toEqual({
      effort: 'xhigh',
      summary: 'auto'
    })
  })

  test('responses add empty instructions only when missing', async () => {
    const app = buildApp()

    const missingResponse = await request(app).post('/general/v1/responses').send({
      model: 'gpt-5.4',
      input: 'Hello World.'
    })

    expect(missingResponse.status).toBe(200)
    expect(missingResponse.body.requestBody.instructions).toBe('')
    expect(missingResponse.body.requestBody.stream).toBe(true)
    expect(missingResponse.body.downstreamStream).toBe(false)
    expect(missingResponse.body.forceCodexUpstreamStream).toBe(true)

    const explicitResponse = await request(app).post('/general/v1/responses').send({
      model: 'gpt-5.4',
      instructions: 'Use concise answers.',
      input: 'Hello World.'
    })

    expect(explicitResponse.status).toBe(200)
    expect(explicitResponse.body.requestBody.instructions).toBe('Use concise answers.')
    expect(explicitResponse.body.requestBody.stream).toBe(true)
  })

  test('responses tolerate clients that append endpoint to a full endpoint URL', async () => {
    const app = buildApp()

    const response = await request(app)
      .post('/general/v1/responses/v1/responses')
      .query({ source: 'compat' })
      .send({
        model: 'gpt-5.4',
        input: 'Hello World.'
      })

    expect(response.status).toBe(200)
    expect(openaiRoutes.handleResponses).toHaveBeenCalledTimes(1)
    expect(response.body.requestBody.instructions).toBe('')
    expect(response.body.requestBody.stream).toBe(true)
    expect(response.body.originalUrl).toBe('/general/v1/responses?source=compat')
    expect(response.body.url).toBe('/v1/responses?source=compat')
    expect(response.body.path).toBe('/v1/responses')
  })
})
