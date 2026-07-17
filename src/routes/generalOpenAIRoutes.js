const express = require('express')
const crypto = require('crypto')
const { authenticateApiKey } = require('../middleware/auth')
const apiKeyService = require('../services/apiKeyService')
const modelService = require('../services/modelService')
const CodexToOpenAIConverter = require('../services/codexToOpenAI')
const openaiRoutes = require('./openaiRoutes')
const logger = require('../utils/logger')
const CostCalculator = require('../utils/costCalculator')
const { IMAGE_MODEL, prepareOpenAIImageRequest } = require('../utils/openaiImageRequestHelper')
const { isModelRestricted } = require('../utils/apiKeyModelRestriction')

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
const GENERAL_PROMPT_CACHE_KEY_MAX_LENGTH = 64
const GENERAL_PROMPT_CACHE_API_KEY_HASH_LENGTH = 10
const GENERAL_PROMPT_CACHE_MODEL_SEGMENT_MAX_LENGTH = 16
const GENERAL_PROMPT_CACHE_VALUE_HASH_LENGTH = 16
const GENERAL_PROMPT_CACHE_SOURCE_CODES = {
  session_id: 's',
  'x-session-id': 'x',
  conversation_id: 'c',
  fallback: 'f',
  preserved: 'p'
}

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

function getHeaderValue(headers = {}, key) {
  const direct = headers[key]
  if (direct !== undefined) {
    return Array.isArray(direct) ? direct.find((item) => item) : direct
  }

  const lowerKey = key.toLowerCase()
  const lower = headers[lowerKey]
  if (lower !== undefined) {
    return Array.isArray(lower) ? lower.find((item) => item) : lower
  }

  return undefined
}

function normalizeNonEmptyString(value) {
  if (value === undefined || value === null) {
    return ''
  }
  const str = String(value).trim()
  return str || ''
}

function normalizeModelFamily(model) {
  const value = normalizeNonEmptyString(model).toLowerCase()
  if (!value) {
    return 'unknown'
  }

  const match = value.match(/^gpt-\d+(?:\.\d+)?/)
  if (match) {
    return match[0]
  }

  return value.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown'
}

function stableNormalize(value) {
  if (Array.isArray(value)) {
    return value.map((item) => stableNormalize(item))
  }

  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        if (value[key] !== undefined) {
          acc[key] = stableNormalize(value[key])
        }
        return acc
      }, {})
  }

  return value
}

function stableHash(value, length = 16) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stableNormalize(value)))
    .digest('hex')
    .slice(0, length)
}

function getPromptCacheModelSegment(modelFamily) {
  const normalized = normalizeModelFamily(modelFamily)
  if (normalized.length <= GENERAL_PROMPT_CACHE_MODEL_SEGMENT_MAX_LENGTH) {
    return normalized
  }

  return `m${stableHash(normalized, 8)}`
}

function getPromptCacheSourceCode(source) {
  return GENERAL_PROMPT_CACHE_SOURCE_CODES[source] || 'u'
}

function buildGeneralPromptCacheKey(apiKeyId, modelFamily, source, value) {
  const candidate = [
    'g',
    stableHash(apiKeyId || 'unknown', GENERAL_PROMPT_CACHE_API_KEY_HASH_LENGTH),
    getPromptCacheModelSegment(modelFamily),
    getPromptCacheSourceCode(source),
    stableHash(value, GENERAL_PROMPT_CACHE_VALUE_HASH_LENGTH)
  ].join(':')

  if (candidate.length <= GENERAL_PROMPT_CACHE_KEY_MAX_LENGTH) {
    return candidate
  }

  return `g:${stableHash(
    { apiKeyId, modelFamily, source, value },
    GENERAL_PROMPT_CACHE_KEY_MAX_LENGTH - 2
  )}`
}

function enforcePromptCacheKeyLimit(req, source = 'preserved') {
  if (!req.body || typeof req.body !== 'object') {
    return false
  }

  const currentKey = normalizeNonEmptyString(req.body.prompt_cache_key)
  if (!currentKey || currentKey.length <= GENERAL_PROMPT_CACHE_KEY_MAX_LENGTH) {
    return false
  }

  const apiKeyId = normalizeNonEmptyString(req.apiKey?.id) || 'unknown'
  const modelFamily = normalizeModelFamily(req.body.model)
  req.body.prompt_cache_key = buildGeneralPromptCacheKey(apiKeyId, modelFamily, source, currentKey)
  logger.debug(
    `General OpenAI prompt_cache_key exceeded ${GENERAL_PROMPT_CACHE_KEY_MAX_LENGTH} chars; compressed for API key ${apiKeyId}`
  )
  return true
}

function extractLeadingSystemInput(input) {
  if (!Array.isArray(input)) {
    return []
  }

  const leading = []
  for (const item of input) {
    if (!item || item.type !== 'message' || !['developer', 'system'].includes(item.role)) {
      break
    }
    leading.push(item)
  }
  return leading
}

function buildStaticPrefixFingerprint(body = {}, modelFamily) {
  return {
    modelFamily,
    instructions: body.instructions,
    tools: body.tools,
    tool_choice: body.tool_choice,
    text: body.text,
    reasoning: body.reasoning,
    parallel_tool_calls: body.parallel_tool_calls,
    leadingSystemInput: extractLeadingSystemInput(body.input)
  }
}

function getSessionSource(req) {
  const sessionIdHeader = normalizeNonEmptyString(getHeaderValue(req.headers, 'session_id'))
  if (sessionIdHeader) {
    return { source: 'session_id', value: sessionIdHeader }
  }

  const sessionIdBody = normalizeNonEmptyString(req.body?.session_id)
  if (sessionIdBody) {
    return { source: 'session_id', value: sessionIdBody }
  }

  const xSessionId = normalizeNonEmptyString(getHeaderValue(req.headers, 'x-session-id'))
  if (xSessionId) {
    return { source: 'x-session-id', value: xSessionId }
  }

  const conversationId = normalizeNonEmptyString(req.body?.conversation_id)
  if (conversationId) {
    return { source: 'conversation_id', value: conversationId }
  }

  return null
}

function applyGeneralPromptCacheAssist(req) {
  if (
    req?._generalOpenAIEndpoint !== true ||
    req?.apiKey?.enableGeneralPromptCacheAssist !== true ||
    !req.body ||
    typeof req.body !== 'object'
  ) {
    return { applied: false, reason: 'disabled' }
  }

  const { body } = req
  const apiKeyId = normalizeNonEmptyString(req.apiKey.id) || 'unknown'
  const modelFamily = normalizeModelFamily(body.model)
  const existingPromptCacheKey = normalizeNonEmptyString(body.prompt_cache_key)
  let keySource = 'preserved'

  if (!existingPromptCacheKey) {
    const sessionSource = getSessionSource(req)
    if (sessionSource) {
      keySource = sessionSource.source
      body.prompt_cache_key = buildGeneralPromptCacheKey(
        apiKeyId,
        modelFamily,
        sessionSource.source,
        sessionSource.value
      )
    } else {
      keySource = 'fallback'
      body.prompt_cache_key = buildGeneralPromptCacheKey(
        apiKeyId,
        modelFamily,
        'fallback',
        buildStaticPrefixFingerprint(body, modelFamily)
      )
    }

    logger.debug(
      `General OpenAI prompt cache assist set prompt_cache_key via ${keySource} for API key ${apiKeyId}`
    )
  } else {
    logger.debug(`General OpenAI prompt cache assist preserved prompt_cache_key for ${apiKeyId}`)
    if (enforcePromptCacheKeyLimit(req, 'preserved')) {
      keySource = 'preserved-compressed'
    }
  }

  return {
    applied: true,
    keySource,
    promptCacheKey: body.prompt_cache_key
  }
}

function stripUnsupportedGeneralOpenAIFields(req) {
  if (!req.body || typeof req.body !== 'object') {
    return
  }

  if (Object.prototype.hasOwnProperty.call(req.body, 'prompt_cache_retention')) {
    delete req.body.prompt_cache_retention
    logger.debug('General OpenAI request removed unsupported prompt_cache_retention field')
  }
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
  stripUnsupportedGeneralOpenAIFields(req)
  applyGeneralPromptCacheAssist(req)
  enforcePromptCacheKeyLimit(req, 'preserved')
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

  if (
    req.apiKey.enableGeneralOpenAIImages === true &&
    !isModelRestricted(req.apiKey, IMAGE_MODEL) &&
    !models.some((model) => model.id === IMAGE_MODEL)
  ) {
    models = [
      ...models,
      {
        id: IMAGE_MODEL,
        object: 'model',
        created: 1776729600,
        owned_by: 'openai'
      }
    ]
  }

  return res.json({
    object: 'list',
    data: models
  })
})

async function handleGeneralImageRequest(req, res, endpoint) {
  let cleanup = async () => {}
  try {
    if (req.apiKey.enableGeneralOpenAIImages !== true) {
      return sendOpenAIError(
        res,
        403,
        'This API key is not allowed to access GPT-Image-2 endpoints'
      )
    }

    const prepared = await prepareOpenAIImageRequest(req, { endpoint })
    ;({ cleanup } = prepared)
    if (isModelRestricted(req.apiKey, IMAGE_MODEL)) {
      return sendOpenAIError(
        res,
        403,
        `Model ${IMAGE_MODEL} is not allowed for this API key`,
        'invalid_request_error',
        'model_not_allowed'
      )
    }

    try {
      CostCalculator.getValidatedImagePricing(IMAGE_MODEL)
    } catch (error) {
      logger.warn(`GPT-Image-2 pricing preflight failed: ${error.message}`)
      return sendOpenAIError(
        res,
        503,
        'Pricing is temporarily unavailable for GPT-Image-2',
        'server_error',
        'pricing_unavailable'
      )
    }

    req.body = prepared.body
    req._downstreamStream = prepared.stream
    req._openAIImageEndpoint = endpoint
    req._openAIImageRequestSnapshot = prepared.requestSnapshot
    return await openaiRoutes.handleImages(req, res)
  } catch (error) {
    const status = Number(error.statusCode) || 500
    logger.warn(`General OpenAI image request failed (${endpoint}, ${status}): ${error.message}`)
    if (!res.headersSent) {
      return sendOpenAIError(
        res,
        status,
        status >= 500 && !error.statusCode ? 'Internal server error' : error.message,
        error.type || (status >= 500 ? 'server_error' : 'invalid_request_error'),
        error.code || (status >= 500 ? 'internal_error' : 'invalid_request')
      )
    }
    return undefined
  } finally {
    await cleanup()
  }
}

router.post('/v1/images/generations', (req, res) =>
  handleGeneralImageRequest(req, res, 'generations')
)
router.post('/v1/images/edits', (req, res) => handleGeneralImageRequest(req, res, 'edits'))

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
module.exports.applyGeneralPromptCacheAssist = applyGeneralPromptCacheAssist
module.exports._normalizeModelFamilyForTest = normalizeModelFamily
