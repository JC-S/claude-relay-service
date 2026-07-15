const pricingService = require('../services/pricingService')

const GROK_MODELS = Object.freeze([
  'grok-4.5',
  'grok-4.3',
  'grok-build-0.1',
  'grok-composer-2.5-fast',
  'grok-4.20-0309-reasoning',
  'grok-4.20-0309-non-reasoning',
  'grok-4.20-multi-agent-0309'
])

const GROK_MODEL_ALIASES = Object.freeze({
  grok: 'grok-4.5',
  'grok-latest': 'grok-4.5',
  'grok-4.5-latest': 'grok-4.5',
  'grok-build': 'grok-build-0.1',
  'grok-build-latest': 'grok-4.5',
  'grok-composer': 'grok-composer-2.5-fast',
  'composer-2.5': 'grok-composer-2.5-fast',
  'grok-4.20-reasoning': 'grok-4.20-0309-reasoning',
  'grok-4.20-non-reasoning': 'grok-4.20-0309-non-reasoning'
})

const normalizeGrokModelName = (model) => {
  let normalized = typeof model === 'string' ? model.trim().toLowerCase() : ''
  if (normalized.startsWith('xai/')) {
    normalized = normalized.slice(4)
  }
  return GROK_MODEL_ALIASES[normalized] || normalized
}

const parseModelMapping = (mapping) => {
  if (!mapping) {
    return {}
  }
  if (typeof mapping === 'object' && !Array.isArray(mapping)) {
    return mapping
  }
  try {
    const parsed = JSON.parse(mapping)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

const resolveGrokModel = (requestedModel, accountMapping = null) => {
  const requested = typeof requestedModel === 'string' ? requestedModel.trim() : ''
  if (!requested) {
    return ''
  }
  const mapping = parseModelMapping(accountMapping)
  const explicit = mapping[requested] || mapping[requested.toLowerCase()]
  return normalizeGrokModelName(explicit || requested)
}

const isSupportedGrokModel = (model) => GROK_MODELS.includes(normalizeGrokModelName(model))

const isAccountSupportedGrokModel = (model, account = null) => {
  const normalized = normalizeGrokModelName(model)
  if (isSupportedGrokModel(normalized)) {
    return true
  }
  if (account?.authType !== 'api_key' || !Array.isArray(account.supportedModels)) {
    return false
  }
  return account.supportedModels.some(
    (supportedModel) => normalizeGrokModelName(supportedModel) === normalized
  )
}

const hasValidGrokPricing = (model) => {
  const pricing = pricingService.getModelPricing(normalizeGrokModelName(model))
  return Boolean(
    pricing &&
      Number.isFinite(pricing.input_cost_per_token) &&
      pricing.input_cost_per_token >= 0 &&
      Number.isFinite(pricing.output_cost_per_token) &&
      pricing.output_cost_per_token >= 0
  )
}

const resolveGrokBillingModel = (actualModel, mappedModel) => {
  const normalizedActual = normalizeGrokModelName(actualModel)
  const normalizedMapped = normalizeGrokModelName(mappedModel)
  if (normalizedActual && hasValidGrokPricing(normalizedActual)) {
    return normalizedActual
  }
  return hasValidGrokPricing(normalizedMapped) ? normalizedMapped : ''
}

module.exports = {
  GROK_MODELS,
  GROK_MODEL_ALIASES,
  normalizeGrokModelName,
  resolveGrokModel,
  resolveGrokBillingModel,
  isSupportedGrokModel,
  isAccountSupportedGrokModel,
  hasValidGrokPricing
}
