const { isGptFamilyModel, isPriorityServiceTier } = require('./modelVariantHelper')

function isGptFastModeBlockingEnabled(apiKeyData = {}) {
  return apiKeyData.disableGptFastMode === true || apiKeyData.disableGptFastMode === 'true'
}

function removeGptFastModeFromBody(body = {}, apiKeyData = {}) {
  if (!isGptFastModeBlockingEnabled(apiKeyData) || !body || typeof body !== 'object') {
    return false
  }

  if (!isGptFamilyModel(body.model)) {
    return false
  }

  let removed = false

  if (isPriorityServiceTier(body.service_tier)) {
    delete body.service_tier
    removed = true
  }

  if (isPriorityServiceTier(body.serviceTier)) {
    delete body.serviceTier
    removed = true
  }

  return removed
}

module.exports = {
  isGptFastModeBlockingEnabled,
  removeGptFastModeFromBody
}
