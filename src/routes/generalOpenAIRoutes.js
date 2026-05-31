const express = require('express')
const { authenticateApiKey } = require('../middleware/auth')
const apiKeyService = require('../services/apiKeyService')
const modelService = require('../services/modelService')
const CodexToOpenAIConverter = require('../services/codexToOpenAI')
const openaiRoutes = require('./openaiRoutes')
const logger = require('../utils/logger')

const router = express.Router()
const OPENAI_OAUTH_ONLY_OPTIONS = { allowedAccountTypes: ['openai'] }
const GENERAL_CHAT_COMPLETIONS_PATH = '/v1/chat/completions'
const GENERAL_RESPONSES_PATH = '/v1/responses'
const GENERAL_CHAT_COMPLETIONS_COMPAT_PATHS = [
  GENERAL_CHAT_COMPLETIONS_PATH,
  `${GENERAL_CHAT_COMPLETIONS_PATH}${GENERAL_CHAT_COMPLETIONS_PATH}`
]
const GENERAL_RESPONSES_COMPAT_PATHS = [
  GENERAL_RESPONSES_PATH,
  `${GENERAL_RESPONSES_PATH}${GENERAL_RESPONSES_PATH}`
]

function sendOpenAIError(
  res,
  status,
  message,
  type = 'permission_denied',
  code = 'permission_denied'
) {
  return res.status(status).json({
    error: {
      message,
      type,
      code
    }
  })
}

function hasGeneralOpenAIAccess(apiKeyData = {}) {
  return (
    apiKeyData.enableGeneralOpenAIEndpoint === true &&
    apiKeyService.hasPermission(apiKeyData.permissions, 'openai')
  )
}

function isModelRestricted(apiKeyData = {}, model) {
  return (
    Boolean(model) &&
    apiKeyData.enableModelRestriction === true &&
    Array.isArray(apiKeyData.restrictedModels) &&
    apiKeyData.restrictedModels.includes(model)
  )
}

function requireGeneralOpenAIAccess(req, res, next) {
  const apiKeyData = req.apiKey || {}

  if (apiKeyData.enableGeneralOpenAIEndpoint !== true) {
    return sendOpenAIError(
      res,
      403,
      'This API key is not allowed to access the general OpenAI-compatible endpoint'
    )
  }

  if (!apiKeyService.hasPermission(apiKeyData.permissions, 'openai')) {
    return sendOpenAIError(res, 403, 'This API key does not have permission to access OpenAI')
  }

  req._generalOpenAIEndpoint = true
  req._openAISchedulerOptions = OPENAI_OAUTH_ONLY_OPTIONS
  return next()
}

function patchChatCompletionsResponse(req, res, requestedModel, converter, downstreamStream) {
  const originalJson = res.json.bind(res)

  if (downstreamStream) {
    const streamState = converter.createStreamState()
    const sseBuffer = { data: '' }
    const originalWrite = res.write.bind(res)
    const originalEnd = res.end.bind(res)

    const flushBufferedEvents = () => {
      let idx
      while ((idx = sseBuffer.data.indexOf('\n\n')) !== -1) {
        const event = sseBuffer.data.slice(0, idx)
        sseBuffer.data = sseBuffer.data.slice(idx + 2)
        if (!event.trim()) {
          continue
        }

        const lines = event.split('\n')
        for (const line of lines) {
          if (!line.startsWith('data: ')) {
            continue
          }
          const jsonStr = line.slice(6)
          if (!jsonStr || jsonStr === '[DONE]') {
            continue
          }

          try {
            const eventData = JSON.parse(jsonStr)
            if (eventData.error) {
              originalWrite(`data: ${jsonStr}\n\n`)
              continue
            }
            const chunks = converter.convertStreamChunk(eventData, requestedModel, streamState)
            for (const chunk of chunks) {
              originalWrite(chunk)
            }
          } catch (error) {
            originalWrite(`data: ${jsonStr}\n\n`)
          }
        }
      }
    }

    res.write = function writeOpenAIChatChunk(chunk, encoding, callback) {
      if (res.statusCode >= 400) {
        return originalWrite(chunk, encoding, callback)
      }

      sseBuffer.data += (typeof chunk === 'string' ? chunk : chunk.toString()).replace(
        /\r\n/g,
        '\n'
      )
      flushBufferedEvents()

      if (typeof callback === 'function') {
        callback()
      }
      return true
    }

    res.end = function endOpenAIChatStream(chunk, encoding, callback) {
      if (res.statusCode < 400) {
        if (chunk) {
          sseBuffer.data += (typeof chunk === 'string' ? chunk : chunk.toString()).replace(
            /\r\n/g,
            '\n'
          )
          chunk = undefined
        }

        if (sseBuffer.data.trim()) {
          sseBuffer.data += '\n\n'
          flushBufferedEvents()
        }

        originalWrite('data: [DONE]\n\n')
      }
      return originalEnd(chunk, encoding, callback)
    }
  }

  res.json = function jsonOpenAIChatResponse(data) {
    if (res.statusCode >= 400) {
      return originalJson(data)
    }
    if (data && (data.type === 'response.completed' || data.object === 'response')) {
      try {
        return originalJson(converter.convertResponse(data, requestedModel))
      } catch (error) {
        logger.debug('General OpenAI chat response conversion failed, passing through:', error)
        return originalJson(data)
      }
    }
    return originalJson(data)
  }
}

function prepareGeneralResponsesRequest(req) {
  req._generalOpenAIEndpoint = true
  req._openAISchedulerOptions = OPENAI_OAUTH_ONLY_OPTIONS
  req._downstreamStream = req.body?.stream === true
  req._forceCodexUpstreamStream = true
  if (req.body && (req.body.instructions === undefined || req.body.instructions === null)) {
    // CLIProxyAPI always sends an instructions field to ChatGPT Codex, even when empty.
    req.body.instructions = ''
  }
  if (req.body) {
    req.body.stream = true
  }
}

function normalizeGeneralRequestPath(req, mountedPath) {
  const query = req.originalUrl?.includes('?')
    ? req.originalUrl.slice(req.originalUrl.indexOf('?'))
    : ''
  req.url = `${mountedPath}${query}`
  req.originalUrl = `/general${mountedPath}${query}`
}

router.use(authenticateApiKey, requireGeneralOpenAIAccess)

router.get('/v1/models', (req, res) => {
  let models = modelService.getModelsByProvider('openai')

  if (req.apiKey.enableModelRestriction && req.apiKey.restrictedModels?.length > 0) {
    models = models.filter((model) => !req.apiKey.restrictedModels.includes(model.id))
  }

  return res.json({
    object: 'list',
    data: models
  })
})

router.post(GENERAL_RESPONSES_COMPAT_PATHS, async (req, res) => {
  try {
    normalizeGeneralRequestPath(req, GENERAL_RESPONSES_PATH)
    const requestedModel = req.body?.model
    if (isModelRestricted(req.apiKey, requestedModel)) {
      return sendOpenAIError(
        res,
        403,
        `Model ${requestedModel} is not allowed for this API key`,
        'invalid_request_error',
        'model_not_allowed'
      )
    }

    prepareGeneralResponsesRequest(req)
    return await openaiRoutes.handleResponses(req, res)
  } catch (error) {
    logger.error('❌ General OpenAI responses error:', error)
    if (!res.headersSent) {
      return sendOpenAIError(res, 500, 'Internal server error', 'server_error', 'internal_error')
    }
    return undefined
  }
})

router.post(GENERAL_CHAT_COMPLETIONS_COMPAT_PATHS, async (req, res) => {
  try {
    normalizeGeneralRequestPath(req, GENERAL_CHAT_COMPLETIONS_PATH)
    if (!req.body.messages || !Array.isArray(req.body.messages) || req.body.messages.length === 0) {
      return sendOpenAIError(
        res,
        400,
        'Messages array is required and cannot be empty',
        'invalid_request_error',
        'invalid_request'
      )
    }

    const requestedModel = req.body.model || 'gpt-5'
    req.body.model = requestedModel

    if (isModelRestricted(req.apiKey, requestedModel)) {
      return sendOpenAIError(
        res,
        403,
        `Model ${requestedModel} is not allowed for this API key`,
        'invalid_request_error',
        'model_not_allowed'
      )
    }

    const converter = new CodexToOpenAIConverter()
    const downstreamStream = req.body.stream === true
    patchChatCompletionsResponse(req, res, requestedModel, converter, downstreamStream)

    req.body = converter.buildRequestFromOpenAI(req.body)
    req._generalOpenAIChatCompletions = true
    prepareGeneralResponsesRequest(req)
    req.url = '/v1/responses'

    return await openaiRoutes.handleResponses(req, res)
  } catch (error) {
    logger.error('❌ General OpenAI chat/completions error:', error)
    if (!res.headersSent) {
      return sendOpenAIError(res, 500, 'Internal server error', 'server_error', 'internal_error')
    }
    return undefined
  }
})

module.exports = router
module.exports.hasGeneralOpenAIAccess = hasGeneralOpenAIAccess
