const axios = require('axios')
const crypto = require('crypto')
const config = require('../../config/config')
const {
  createClaudeTestPayload,
  createGeminiTestPayload,
  createOpenAITestPayload,
  extractErrorMessage,
  sanitizeErrorMsg,
  sendStreamTestRequest
} = require('../utils/testPayloadHelper')
const { getSafeMessage } = require('../utils/errorSanitizer')
const { parseAddress } = require('../utils/ipWhitelistHelper')

const CONNECTIVITY_TEST_SERVICES = ['claude', 'gemini', 'openai']
const ALLOWED_MAX_TOKENS = [100, 500, 1000, 2000, 4096]
const DEFAULT_MODELS = {
  claude: 'claude-sonnet-4-5-20250929',
  gemini: 'gemini-2.5-pro',
  openai: 'gpt-5.4'
}
const MODEL_PATTERN = /^[A-Za-z0-9._:-]+(?:\[1m\])?$/
const CODEX_TEST_INSTRUCTIONS =
  'You are Codex, based on GPT-5. You are running as a coding agent in the Codex CLI.'
const CODEX_TEST_USER_AGENT =
  'codex-tui/0.137.0 (Ubuntu 24.4.0; x86_64) WindowsTerminal (codex-tui; 0.137.0)'

function sanitizeMaxTokens(value) {
  return ALLOWED_MAX_TOKENS.includes(Number(value)) ? Number(value) : 1000
}

function validationError(message) {
  const error = new Error(message)
  error.code = 'VALIDATION_ERROR'
  return error
}

function validateV2ConnectivityTestParams({ service, model, prompt, maxTokens } = {}) {
  if (!CONNECTIVITY_TEST_SERVICES.includes(service)) {
    throw validationError('Unsupported test service')
  }

  const normalizedModel = model === undefined ? DEFAULT_MODELS[service] : model
  if (
    typeof normalizedModel !== 'string' ||
    normalizedModel.length < 1 ||
    normalizedModel.length > 200 ||
    !MODEL_PATTERN.test(normalizedModel)
  ) {
    throw validationError('Invalid model')
  }

  const normalizedPrompt = prompt === undefined ? 'hi' : prompt
  if (typeof normalizedPrompt !== 'string' || normalizedPrompt.length > 2000) {
    throw validationError('Invalid prompt')
  }

  return {
    service,
    model: normalizedModel,
    prompt: normalizedPrompt,
    maxTokens: sanitizeMaxTokens(maxTokens)
  }
}

function withClientIp(headers, clientIp) {
  if (typeof clientIp === 'string' && parseAddress(clientIp)) {
    return { ...headers, 'cf-connecting-ip': clientIp }
  }
  return headers
}

function canWrite(responseStream) {
  return !responseStream.destroyed && !responseStream.writableEnded
}

function writeSSE(responseStream, data) {
  if (canWrite(responseStream)) {
    try {
      responseStream.write(`data: ${JSON.stringify(data)}\n\n`)
    } catch {
      // The downstream may disconnect between the state check and write.
    }
  }
}

function beginSSE(responseStream) {
  if (!responseStream.headersSent && canWrite(responseStream)) {
    responseStream.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
  }
  writeSSE(responseStream, { type: 'test_start', message: 'Test started' })
}

function completeSSE(responseStream, success, error) {
  if (!canWrite(responseStream)) {
    return
  }
  writeSSE(responseStream, {
    type: 'test_complete',
    success,
    error: error || undefined
  })
  responseStream.end()
}

function readUpstreamError(response, responseStream) {
  const chunks = []
  response.data.on('data', (chunk) => chunks.push(chunk))
  response.data.on('end', () => {
    const errorData = Buffer.concat(chunks).toString()
    let errorMsg = `API Error: ${response.status}`
    try {
      errorMsg = extractErrorMessage(JSON.parse(errorData), errorMsg)
    } catch {
      if (errorData.length < 200) {
        errorMsg = errorData || errorMsg
      }
    }
    completeSSE(responseStream, false, sanitizeErrorMsg(errorMsg))
  })
  response.data.on('error', (error) => completeSSE(responseStream, false, getSafeMessage(error)))
}

async function runStreamingTest({ apiUrl, payload, headers, responseStream, extractText }) {
  beginSSE(responseStream)

  try {
    const response = await axios.post(apiUrl, payload, {
      headers,
      timeout: 60000,
      responseType: 'stream',
      validateStatus: () => true
    })

    if (response.status !== 200) {
      readUpstreamError(response, responseStream)
      return
    }

    let buffer = ''
    response.data.on('data', (chunk) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data:')) {
          continue
        }
        const json = line.substring(5).trim()
        if (!json || json === '[DONE]') {
          continue
        }
        try {
          const text = extractText(JSON.parse(json))
          if (text) {
            writeSSE(responseStream, { type: 'content', text })
          }
        } catch {
          // Ignore malformed upstream SSE events.
        }
      }
    })
    response.data.on('end', () => completeSSE(responseStream, true))
    response.data.on('error', (error) => completeSSE(responseStream, false, getSafeMessage(error)))
  } catch (error) {
    completeSSE(responseStream, false, getSafeMessage(error))
  }
}

async function runClaudeKeyTest({
  apiKey,
  model = DEFAULT_MODELS.claude,
  prompt = 'hi',
  maxTokens = 1000,
  responseStream,
  clientIp
}) {
  const port = config.server.port || 3000
  return sendStreamTestRequest({
    apiUrl: `http://127.0.0.1:${port}/api/v1/messages?beta=true`,
    authorization: apiKey,
    responseStream,
    payload: createClaudeTestPayload(model, { stream: true, prompt, maxTokens }),
    timeout: 60000,
    extraHeaders: withClientIp(
      {
        'x-api-key': apiKey,
        'x-app': 'claude-code',
        'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14'
      },
      clientIp
    ),
    sanitize: false
  })
}

async function runGeminiKeyTest({
  apiKey,
  model = DEFAULT_MODELS.gemini,
  prompt = 'hi',
  maxTokens = 1000,
  responseStream,
  clientIp
}) {
  const port = config.server.port || 3000
  return runStreamingTest({
    apiUrl: `http://127.0.0.1:${port}/gemini/v1/models/${model}:streamGenerateContent?alt=sse`,
    payload: createGeminiTestPayload(model, { prompt, maxTokens }),
    headers: withClientIp(
      {
        'Content-Type': 'application/json',
        'x-api-key': apiKey
      },
      clientIp
    ),
    responseStream,
    extractText: (data) => data.candidates?.[0]?.content?.parts?.[0]?.text
  })
}

async function runOpenAIKeyTest({
  apiKey,
  model = DEFAULT_MODELS.openai,
  prompt = 'hi',
  maxTokens = 1000,
  responseStream,
  clientIp
}) {
  const port = config.server.port || 3000
  return runStreamingTest({
    apiUrl: `http://127.0.0.1:${port}/openai/responses`,
    payload: createOpenAITestPayload(model, {
      prompt,
      maxTokens,
      instructions: CODEX_TEST_INSTRUCTIONS,
      includeMaxOutputTokens: false
    }),
    headers: withClientIp(
      {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'User-Agent': CODEX_TEST_USER_AGENT,
        originator: 'codex-tui',
        session_id: crypto.randomUUID()
      },
      clientIp
    ),
    responseStream,
    extractText: (data) => {
      if (data.type === 'response.output_text.delta') {
        return data.delta
      }
      if (data.type === 'response.content_part.delta') {
        return data.delta?.text
      }
      return null
    }
  })
}

function runApiKeyConnectivityTest(options) {
  const runners = {
    claude: runClaudeKeyTest,
    gemini: runGeminiKeyTest,
    openai: runOpenAIKeyTest
  }
  const runner = runners[options.service]
  if (!runner) {
    throw validationError('Unsupported test service')
  }
  return runner(options)
}

module.exports = {
  CONNECTIVITY_TEST_SERVICES,
  sanitizeMaxTokens,
  validateV2ConnectivityTestParams,
  runClaudeKeyTest,
  runGeminiKeyTest,
  runOpenAIKeyTest,
  runApiKeyConnectivityTest
}
