const express = require('express')
const config = require('../../config/config')
const { authenticateApiKey } = require('../middleware/auth')
const apiKeyService = require('../services/apiKeyService')
const modelService = require('../services/modelService')
const grokRelayService = require('../services/relay/grokRelayService')
const {
  resolveGrokModel,
  isSupportedGrokModel,
  hasValidGrokPricing
} = require('../utils/grokModelHelper')

const router = express.Router()

const sendError = (res, status, message, type, code) =>
  res.status(status).json({ error: { message, type, code } })

const requireProviderEnabled = (_req, res, next) => {
  if (config.grok?.enabled !== true) {
    return sendError(
      res,
      503,
      'The Grok provider is currently disabled',
      'server_error',
      'provider_disabled'
    )
  }
  return next()
}

const requireGrokAccess = (req, res, next) => {
  if (req.apiKey?.enableGrokEndpoint !== true) {
    return sendError(
      res,
      403,
      'This API key is not allowed to access the Grok Responses endpoint',
      'permission_denied',
      'grok_endpoint_disabled'
    )
  }
  if (!apiKeyService.hasPermission(req.apiKey.permissions, 'grok')) {
    return sendError(
      res,
      403,
      'This API key does not have permission to access Grok',
      'permission_denied',
      'permission_denied'
    )
  }
  return next()
}

router.use(requireProviderEnabled, authenticateApiKey, requireGrokAccess)

const handleModels = (req, res) => {
  let models = modelService
    .getModelsByProvider('xai')
    .filter((model) => hasValidGrokPricing(model.id))
  if (req.apiKey.enableModelRestriction && req.apiKey.restrictedModels?.length) {
    models = models.filter((model) => !req.apiKey.restrictedModels.includes(model.id))
  }
  return res.json({ object: 'list', data: models })
}

const handleResponses = async (req, res) => {
  const { body } = req
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return sendError(
      res,
      400,
      'Request body must be a JSON object',
      'invalid_request_error',
      'invalid_body'
    )
  }
  if (typeof body.model !== 'string' || !body.model.trim()) {
    return sendError(res, 400, 'Model is required', 'invalid_request_error', 'model_required')
  }
  if (!Object.prototype.hasOwnProperty.call(body, 'input')) {
    return sendError(res, 400, 'Input is required', 'invalid_request_error', 'input_required')
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    return sendError(
      res,
      400,
      'Stream must be a boolean',
      'invalid_request_error',
      'invalid_stream'
    )
  }
  const requestedModel = body.model.trim()
  if (
    req.apiKey.enableModelRestriction === true &&
    req.apiKey.restrictedModels?.includes(requestedModel)
  ) {
    return sendError(
      res,
      403,
      `Model ${requestedModel} is not allowed for this API key`,
      'invalid_request_error',
      'model_not_allowed'
    )
  }
  const defaultMappedModel = resolveGrokModel(requestedModel)
  if (
    req.apiKey.enableModelRestriction === true &&
    req.apiKey.restrictedModels?.includes(defaultMappedModel)
  ) {
    return sendError(
      res,
      403,
      `Model ${requestedModel} is not allowed for this API key`,
      'invalid_request_error',
      'model_not_allowed'
    )
  }
  if (isSupportedGrokModel(defaultMappedModel) && !hasValidGrokPricing(defaultMappedModel)) {
    return sendError(
      res,
      503,
      `Pricing is temporarily unavailable for ${defaultMappedModel}`,
      'server_error',
      'pricing_unavailable'
    )
  }
  try {
    return await grokRelayService.handle(req, res, { requestedModel, defaultMappedModel })
  } catch (error) {
    if (!res.headersSent) {
      return sendError(res, 500, 'Internal server error', 'server_error', 'internal_error')
    }
    if (!res.writableEnded) {
      return res.end()
    }
    return undefined
  }
}

router.get(['/models', '/v1/models'], handleModels)
router.post(['/responses', '/v1/responses'], handleResponses)

module.exports = router
module.exports.handleResponses = handleResponses
