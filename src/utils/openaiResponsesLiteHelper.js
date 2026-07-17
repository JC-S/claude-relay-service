const RESPONSES_LITE_HEADER = 'x-openai-internal-codex-responses-lite'

const MIGRATABLE_TOOL_TYPES = new Set(['function', 'custom', 'tool_search', 'namespace'])
const UNSUPPORTED_HOSTED_TOOL_TYPES = new Set([
  'web_search',
  'web_search_preview',
  'image_generation',
  'computer_use_preview',
  'file_search',
  'code_interpreter'
])

class OpenAIResponsesLiteError extends Error {
  constructor(message, code = 'invalid_responses_lite_request') {
    super(message)
    this.name = 'OpenAIResponsesLiteError'
    this.statusCode = 400
    this.type = 'invalid_request_error'
    this.code = code
  }
}

function isResponsesLiteRequest(headers = {}) {
  const value =
    headers[RESPONSES_LITE_HEADER] ??
    headers['X-OpenAI-Internal-Codex-Responses-Lite'] ??
    headers['x-openai-internal-codex-responses-lite']
  return value === 'true'
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function toolIdentity(tool) {
  if (typeof tool === 'string') {
    return `custom:${tool}`
  }
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
    throw new OpenAIResponsesLiteError('Responses Lite tools must be objects or non-empty strings')
  }
  const type = typeof tool.type === 'string' ? tool.type.trim() : ''
  const name = typeof tool.name === 'string' ? tool.name.trim() : ''
  if (!type) {
    throw new OpenAIResponsesLiteError('Responses Lite tools must include a type')
  }
  return `${type}:${name}`
}

function normalizeTool(tool) {
  if (typeof tool === 'string') {
    const name = tool.trim()
    if (!name) {
      throw new OpenAIResponsesLiteError('Responses Lite custom tool names cannot be empty')
    }
    return { type: 'custom', name }
  }

  const normalized = cloneJson(tool)
  const type = typeof normalized.type === 'string' ? normalized.type.trim() : ''
  if (UNSUPPORTED_HOSTED_TOOL_TYPES.has(type)) {
    throw new OpenAIResponsesLiteError(
      `Responses Lite does not support hosted tool type ${type}`,
      'unsupported_responses_lite_tool'
    )
  }
  if (!MIGRATABLE_TOOL_TYPES.has(type)) {
    throw new OpenAIResponsesLiteError(
      `Responses Lite does not support tool type ${type || 'unknown'}`,
      'unsupported_responses_lite_tool'
    )
  }
  normalized.type = type
  return normalized
}

function mergeTools(toolLists) {
  const merged = []
  const definitions = new Map()

  for (const tools of toolLists) {
    for (const rawTool of tools) {
      const tool = normalizeTool(rawTool)
      const identity = toolIdentity(tool)
      const definition = stableStringify(tool)
      const previous = definitions.get(identity)
      if (previous && previous !== definition) {
        throw new OpenAIResponsesLiteError(
          `Responses Lite contains conflicting definitions for ${identity}`,
          'conflicting_responses_lite_tool'
        )
      }
      if (!previous) {
        definitions.set(identity, definition)
        merged.push(tool)
      }
    }
  }

  return merged
}

function normalizeInput(input) {
  if (typeof input === 'string') {
    return [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: input }]
      }
    ]
  }
  if (!Array.isArray(input)) {
    throw new OpenAIResponsesLiteError('Responses Lite input must be a string or array')
  }
  return cloneJson(input)
}

function normalizeOpenAIResponsesLiteBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new OpenAIResponsesLiteError('A JSON object request body is required')
  }

  const normalized = cloneJson(body)
  if (
    normalized.reasoning !== undefined &&
    (!normalized.reasoning ||
      typeof normalized.reasoning !== 'object' ||
      Array.isArray(normalized.reasoning))
  ) {
    throw new OpenAIResponsesLiteError('Responses Lite reasoning must be an object')
  }

  normalized.reasoning = {
    ...(normalized.reasoning || {}),
    context: 'all_turns'
  }
  normalized.parallel_tool_calls = false

  const input = normalizeInput(normalized.input)
  const carrierTools = []
  const retainedInput = []
  for (const item of input) {
    if (
      item &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      item.type === 'additional_tools'
    ) {
      if (!Array.isArray(item.tools)) {
        throw new OpenAIResponsesLiteError('Responses Lite additional_tools tools must be an array')
      }
      carrierTools.push(item.tools)
      continue
    }
    retainedInput.push(item)
  }

  let topLevelTools = []
  if (normalized.tools !== undefined) {
    if (!Array.isArray(normalized.tools)) {
      throw new OpenAIResponsesLiteError('Responses Lite tools must be an array')
    }
    topLevelTools = normalized.tools
    delete normalized.tools
  }

  const tools = mergeTools([...carrierTools, topLevelTools])
  const prefix = [
    {
      type: 'additional_tools',
      role: 'developer',
      tools
    }
  ]

  if (normalized.instructions !== undefined && normalized.instructions !== null) {
    const instructions =
      typeof normalized.instructions === 'string'
        ? normalized.instructions
        : JSON.stringify(normalized.instructions)
    if (instructions) {
      prefix.push({
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: instructions }]
      })
    }
    delete normalized.instructions
  }

  normalized.input = [...prefix, ...retainedInput]
  return normalized
}

module.exports = {
  RESPONSES_LITE_HEADER,
  OpenAIResponsesLiteError,
  isResponsesLiteRequest,
  normalizeOpenAIResponsesLiteBody
}
