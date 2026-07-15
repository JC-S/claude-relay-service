const API_KEY_MAX_LENGTH = 512

const API_KEY_CREDENTIAL_ERROR_MESSAGES = {
  EMPTY: 'API key cannot be empty',
  TOO_LONG: `API key cannot exceed ${API_KEY_MAX_LENGTH} characters`,
  NON_ASCII: 'Custom API key may only contain printable ASCII characters',
  EDGE_WHITESPACE: 'Custom API key cannot start or end with whitespace',
  BEARER_PREFIX: 'Custom API key cannot start with Bearer'
}

function invalid(code) {
  return {
    valid: false,
    code,
    message: API_KEY_CREDENTIAL_ERROR_MESSAGES[code]
  }
}

function validateApiKeyCredential(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return invalid('EMPTY')
  }
  if (value.length > API_KEY_MAX_LENGTH) {
    return invalid('TOO_LONG')
  }
  return { valid: true }
}

function validateCustomApiKey(value) {
  const baseValidation = validateApiKeyCredential(value)
  if (!baseValidation.valid) {
    return baseValidation
  }
  if (!/^[\x20-\x7E]+$/.test(value)) {
    return invalid('NON_ASCII')
  }
  if (value.trim() !== value) {
    return invalid('EDGE_WHITESPACE')
  }
  if (/^Bearer\s/i.test(value)) {
    return invalid('BEARER_PREFIX')
  }
  return { valid: true }
}

module.exports = {
  API_KEY_MAX_LENGTH,
  API_KEY_CREDENTIAL_ERROR_MESSAGES,
  validateApiKeyCredential,
  validateCustomApiKey
}
