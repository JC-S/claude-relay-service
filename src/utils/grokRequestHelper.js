const crypto = require('crypto')
const config = require('../../config/config')

const SUPPORTED_TOOL_TYPES = new Set([
  'code_execution',
  'code_interpreter',
  'collections_search',
  'file_search',
  'function',
  'mcp',
  'shell',
  'web_search',
  'x_search'
])

const clone = (value) => JSON.parse(JSON.stringify(value))

const deleteRecursiveField = (value, field) => {
  if (!value || typeof value !== 'object') {
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item) => deleteRecursiveField(item, field))
    return
  }
  delete value[field]
  Object.values(value).forEach((item) => deleteRecursiveField(item, field))
}

const getToolName = (tool) => tool?.name || tool?.function?.name || ''

const sanitizeGrokResponsesBody = (requestBody, mappedModel) => {
  if (!requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody)) {
    throw new Error('Request body must be a JSON object')
  }
  const body = clone(requestBody)
  body.model = mappedModel

  if (['grok-composer', 'grok-composer-2.5-fast', 'composer-2.5'].includes(mappedModel)) {
    delete body.reasoning
    delete body.reasoning_effort
    delete body.reasoningEffort
  }
  delete body.prompt_cache_retention
  delete body.safety_identifier
  if (String(mappedModel).toLowerCase() === 'grok-4.5') {
    for (const field of [
      'presence_penalty',
      'presencePenalty',
      'frequency_penalty',
      'frequencyPenalty',
      'stop'
    ]) {
      delete body[field]
    }
  }
  deleteRecursiveField(body, 'external_web_access')

  if (Array.isArray(body.input)) {
    body.input = body.input
      .filter((item) => item?.type !== 'additional_tools')
      .map((item) => {
        if (item?.type === 'reasoning' && item.content === null) {
          const next = { ...item }
          delete next.content
          return next
        }
        return item
      })
  }

  if (Array.isArray(body.tools)) {
    body.tools = body.tools.filter((tool) => SUPPORTED_TOOL_TYPES.has(tool?.type))
    if (!body.tools.length) {
      delete body.tools
    }
  }
  if (body.tool_choice && typeof body.tool_choice === 'object') {
    const choiceType = body.tool_choice.type
    const dropUnsupported = choiceType && !SUPPORTED_TOOL_TYPES.has(choiceType)
    const dropFunction =
      choiceType === 'function' &&
      (body.tool_choice.name || body.tool_choice.function?.name) &&
      !body.tools?.some(
        (tool) =>
          tool.type === 'function' &&
          getToolName(tool) === (body.tool_choice.name || body.tool_choice.function?.name)
      )
    if (!body.tools || dropUnsupported || dropFunction) {
      delete body.tool_choice
    }
  } else if (!body.tools && body.tool_choice !== undefined) {
    delete body.tool_choice
  }
  return body
}

const stableNormalize = (value) => {
  if (Array.isArray(value)) {
    return value.map(stableNormalize)
  }
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        if (value[key] !== undefined) {
          result[key] = stableNormalize(value[key])
        }
        return result
      }, {})
  }
  return value
}

const hashValue = (value) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify(stableNormalize(value)))
    .digest('hex')

const firstNonEmptyHeader = (headers, names) => {
  for (const name of names) {
    const value = headers?.[name] ?? headers?.[name.toLowerCase()]
    const normalized = Array.isArray(value) ? value[0] : value
    if (normalized !== undefined && String(normalized).trim()) {
      return String(normalized).trim()
    }
  }
  return ''
}

const findFirstUserInput = (input) => {
  if (typeof input === 'string' && input.trim()) {
    return input
  }
  if (!Array.isArray(input)) {
    return null
  }
  return input.find((item) => item?.role === 'user') || null
}

const deriveGrokSessionSeed = (headers = {}, body = {}) => {
  const explicit =
    firstNonEmptyHeader(headers, ['session_id']) ||
    firstNonEmptyHeader(headers, ['conversation_id']) ||
    firstNonEmptyHeader(headers, ['x-grok-conv-id']) ||
    (typeof body.prompt_cache_key === 'string' ? body.prompt_cache_key.trim() : '')
  if (explicit) {
    return explicit
  }
  const leadingSystem = Array.isArray(body.input)
    ? body.input.filter(
        (item, index) =>
          index < 4 && item?.type === 'message' && ['system', 'developer'].includes(item.role)
      )
    : []
  if (body.instructions !== undefined || body.tools !== undefined || leadingSystem.length) {
    return `prefix:${hashValue({
      instructions: body.instructions,
      tools: body.tools,
      leadingSystem
    })}`
  }
  const firstUser = findFirstUserInput(body.input)
  return firstUser ? `anchor:${hashValue({ model: body.model, firstUser })}` : ''
}

const digestToUuid = (digest) => {
  const chars = digest.slice(0, 32).split('')
  chars[12] = '4'
  chars[16] = ['8', '9', 'a', 'b'][parseInt(chars[16], 16) % 4]
  const hex = chars.join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const buildGrokCacheIdentity = (apiKeyId, mappedModel, seed) => {
  if (!apiKeyId || !mappedModel || !seed) {
    return ''
  }
  const digest = crypto
    .createHash('sha256')
    .update(`grok-prompt-cache:v1:${apiKeyId}:${mappedModel}:${seed}`)
    .digest('hex')
  return digestToUuid(digest)
}

const applyGrokCacheIdentity = (body, originalBody, identity, authType) => {
  const next = clone(body)
  if (identity) {
    next.prompt_cache_key = identity
  } else {
    delete next.prompt_cache_key
  }
  if (
    identity &&
    authType === 'oauth' &&
    config.grok.oauthCacheNativeTools === true &&
    !Object.prototype.hasOwnProperty.call(originalBody, 'tools') &&
    !Object.prototype.hasOwnProperty.call(originalBody, 'tool_choice')
  ) {
    next.tools = [{ type: 'web_search' }, { type: 'x_search' }]
    next.tool_choice = 'none'
  }
  return next
}

const validateBaseUrl = (rawUrl, expectedHost) => {
  const parsed = new URL(rawUrl)
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== expectedHost ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`Invalid Grok upstream URL for ${expectedHost}`)
  }
  return parsed
}

const buildGrokUpstreamUrl = (authType, path = 'responses') => {
  const oauth = authType === 'oauth'
  const base = validateBaseUrl(
    oauth ? config.grok.cliBaseUrl : config.grok.apiBaseUrl,
    oauth ? 'cli-chat-proxy.grok.com' : 'api.x.ai'
  )
  base.pathname = `${base.pathname.replace(/\/$/, '')}/${String(path).replace(/^\//, '')}`
  return base.toString()
}

const validateHeaderValue = (value, name) => {
  if (
    [...String(value)].some((character) => {
      const codePoint = character.codePointAt(0)
      return codePoint <= 31 || codePoint === 127
    })
  ) {
    throw new Error(`Invalid control character in ${name}`)
  }
  return value
}

const buildGrokUpstreamHeaders = ({ authType, token, cacheIdentity, downstreamHeaders = {} }) => {
  const oauth = authType === 'oauth'
  const version = validateHeaderValue(config.grok.cliVersion, 'XAI_GROK_CLI_VERSION')
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'User-Agent': oauth
      ? `xai-grok-workspace/${version}`
      : validateHeaderValue(config.grok.directApiUserAgent, 'XAI_GROK_DIRECT_API_USER_AGENT'),
    'X-Grok-Client-Version': version
  }
  const beta = downstreamHeaders['openai-beta'] || downstreamHeaders['OpenAI-Beta']
  if (beta) {
    headers['OpenAI-Beta'] = validateHeaderValue(String(beta), 'OpenAI-Beta')
  }
  if (oauth) {
    headers['X-XAI-Token-Auth'] = 'xai-grok-cli'
  }
  if (cacheIdentity) {
    headers['X-Grok-Conv-Id'] = cacheIdentity
  }
  return headers
}

const hasTrustworthyGrokUsage = (usage) => {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    return false
  }
  const candidates = [
    usage.input_tokens,
    usage.output_tokens,
    usage.prompt_tokens,
    usage.completion_tokens,
    usage.cache_read_input_tokens,
    usage.cache_creation_input_tokens,
    usage.input_tokens_details?.cached_tokens,
    usage.input_tokens_details?.cache_write_tokens
  ]
  return candidates.some(
    (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
  )
}

module.exports = {
  SUPPORTED_TOOL_TYPES,
  sanitizeGrokResponsesBody,
  deriveGrokSessionSeed,
  buildGrokCacheIdentity,
  applyGrokCacheIdentity,
  buildGrokUpstreamUrl,
  buildGrokUpstreamHeaders,
  hasTrustworthyGrokUsage
}
