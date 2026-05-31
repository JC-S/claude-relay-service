const express = require('express')
const request = require('supertest')

let mockApiKeyData

jest.mock('../src/middleware/auth', () => ({
  authenticateApiKey: jest.fn((req, _res, next) => {
    req.apiKey = {
      ...mockApiKeyData
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
    mockApiKeyData = {
      id: 'key-1',
      permissions: ['openai'],
      enableGeneralOpenAIEndpoint: true,
      enableGeneralPromptCacheAssist: false,
      enableModelRestriction: false,
      restrictedModels: []
    }
  })

  test('chat completions add empty instructions like CLIProxyAPI when missing', async () => {
    const app = buildApp()

    const response = await request(app)
      .post('/general/v1/chat/completions')
      .send({
        model: 'gpt-5.4',
        stream: false,
        prompt_cache_retention: '24h',
        messages: [
          { role: 'system', content: 'Translate to Simplified Chinese only.' },
          { role: 'user', content: 'Hello World.' }
        ]
      })

    expect(response.status).toBe(200)
    expect(openaiRoutes.handleResponses).toHaveBeenCalledTimes(1)
    expect(response.body.requestBody.instructions).toBe('')
    expect(response.body.requestBody.stream).toBe(true)
    expect(response.body.requestBody.prompt_cache_retention).toBeUndefined()
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

  test('prompt cache assist is disabled by default', async () => {
    const app = buildApp()

    const response = await request(app).post('/general/v1/responses').send({
      model: 'gpt-5.4',
      input: 'Hello World.'
    })

    expect(response.status).toBe(200)
    expect(response.body.requestBody.prompt_cache_key).toBeUndefined()
    expect(response.body.requestBody.prompt_cache_retention).toBeUndefined()
  })

  test('prompt cache assist preserves existing key and strips unsupported retention', async () => {
    mockApiKeyData.enableGeneralPromptCacheAssist = true
    const app = buildApp()

    const response = await request(app).post('/general/v1/responses').send({
      model: 'gpt-5.5',
      prompt_cache_key: 'client-cache-key',
      prompt_cache_retention: '24h',
      input: 'Hello World.'
    })

    expect(response.status).toBe(200)
    expect(response.body.requestBody.prompt_cache_key).toBe('client-cache-key')
    expect(response.body.requestBody.prompt_cache_retention).toBeUndefined()
  })

  test('prompt cache assist compresses existing keys over upstream limit', async () => {
    mockApiKeyData.enableGeneralPromptCacheAssist = true
    const app = buildApp()
    const longPromptCacheKey = 'client-cache-key-'.repeat(6)

    const response = await request(app).post('/general/v1/responses').send({
      model: 'gpt-5.5',
      prompt_cache_key: longPromptCacheKey,
      input: 'Hello World.'
    })

    expect(response.status).toBe(200)
    expect(response.body.requestBody.prompt_cache_key).not.toBe(longPromptCacheKey)
    expect(response.body.requestBody.prompt_cache_key.length).toBeLessThanOrEqual(64)
    expect(response.body.requestBody.prompt_cache_key).toMatch(
      /^g:[a-f0-9]{10}:gpt-5\.5:p:[a-f0-9]{16}$/
    )
  })

  test('prompt cache assist derives stable key from x-session-id', async () => {
    mockApiKeyData.enableGeneralPromptCacheAssist = true
    const app = buildApp()
    const payload = {
      model: 'gpt-5.4',
      input: 'Hello World.'
    }

    const first = await request(app)
      .post('/general/v1/responses')
      .set('x-session-id', 'session-a')
      .send(payload)
    const second = await request(app)
      .post('/general/v1/responses')
      .set('x-session-id', 'session-a')
      .send(payload)

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(first.body.requestBody.prompt_cache_key.length).toBeLessThanOrEqual(64)
    expect(first.body.requestBody.prompt_cache_key).toMatch(
      /^g:[a-f0-9]{10}:gpt-5\.4:x:[a-f0-9]{16}$/
    )
    expect(second.body.requestBody.prompt_cache_key).toBe(first.body.requestBody.prompt_cache_key)
  })

  test('prompt cache assist fallback key is stable for static prefix and scoped by API key', async () => {
    mockApiKeyData.enableGeneralPromptCacheAssist = true
    const app = buildApp()
    const payload = {
      model: 'gpt-5.4',
      instructions: 'Use the tools when needed.',
      tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
      input: 'First user message.'
    }

    const first = await request(app).post('/general/v1/responses').send(payload)
    const second = await request(app)
      .post('/general/v1/responses')
      .send({ ...payload, input: 'Different user message.' })

    mockApiKeyData.id = 'key-2'
    const third = await request(app).post('/general/v1/responses').send(payload)

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(third.status).toBe(200)
    expect(first.body.requestBody.prompt_cache_key.length).toBeLessThanOrEqual(64)
    expect(first.body.requestBody.prompt_cache_key).toMatch(
      /^g:[a-f0-9]{10}:gpt-5\.4:f:[a-f0-9]{16}$/
    )
    expect(second.body.requestBody.prompt_cache_key).toBe(first.body.requestBody.prompt_cache_key)
    expect(third.body.requestBody.prompt_cache_key).toMatch(
      /^g:[a-f0-9]{10}:gpt-5\.4:f:[a-f0-9]{16}$/
    )
    expect(third.body.requestBody.prompt_cache_key).not.toBe(
      first.body.requestBody.prompt_cache_key
    )
  })
})
