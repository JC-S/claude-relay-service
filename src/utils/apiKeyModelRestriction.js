function isModelRestricted(apiKeyData = {}, model) {
  return (
    Boolean(model) &&
    apiKeyData.enableModelRestriction === true &&
    Array.isArray(apiKeyData.restrictedModels) &&
    apiKeyData.restrictedModels.includes(model)
  )
}

module.exports = { isModelRestricted }
