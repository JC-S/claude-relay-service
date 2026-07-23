const express = require('express')
const axios = require('axios')
const router = express.Router()
const logger = require('../utils/logger')
const config = require('../../config/config')
const { authenticateApiKey } = require('../middleware/auth')
const unifiedOpenAIScheduler = require('../services/scheduler/unifiedOpenAIScheduler')
const openaiAccountService = require('../services/account/openaiAccountService')
const openaiResponsesAccountService = require('../services/account/openaiResponsesAccountService')
const openaiResponsesRelayService = require('../services/relay/openaiResponsesRelayService')
const apiKeyService = require('../services/apiKeyService')
const claudeRelayConfigService = require('../services/claudeRelayConfigService')
const redis = require('../models/redis')
const crypto = require('crypto')
const ProxyHelper = require('../utils/proxyHelper')
const { updateRateLimitCounters } = require('../utils/rateLimitHelper')
const { IncrementalSSEParser } = require('../utils/sseParser')
const { getSafeMessage } = require('../utils/errorSanitizer')
const { summarizeErrorForLog } = require('../utils/logSanitizer')
const { createRequestDetailMeta, sanitizeImageData } = require('../utils/requestDetailHelper')
const {
  formatOpenAIUsageForLog,
  normalizeOpenAIUsage,
  normalizeOpenAIImageUsage
} = require('../utils/openaiUsageHelper')
const {
  IMAGE_MODEL,
  MAX_UPSTREAM_BODY_BYTES,
  MAX_UPSTREAM_RESPONSE_BYTES,
  OpenAIImageSSEObserver,
  createImageStreamKeepAlive,
  prepareOpenAIImageRequest
} = require('../utils/openaiImageRequestHelper')
const requestBodyRuleService = require('../services/requestBodyRuleService')
const { removeGptFastModeFromBody } = require('../utils/gptFastModeHelper')
const openaiNicSelector = require('../utils/openaiNicSelector')
const { getHttpsAgentForLocalAddress } = require('../utils/performanceOptimizer')
const upstreamErrorHelper = require('../utils/upstreamErrorHelper')
const openaiCodexModelsService = require('../services/openaiCodexModelsService')
const openaiAlphaSearchService = require('../services/openaiAlphaSearchService')
const CostCalculator = require('../utils/costCalculator')
const { isModelRestricted } = require('../utils/apiKeyModelRestriction')
const {
  RESPONSES_LITE_HEADER,
  isResponsesLiteRequest,
  normalizeOpenAIResponsesLiteBody
} = require('../utils/openaiResponsesLiteHelper')
const {
  GPT55_PHASEOUT_ERROR_CODE,
  createGpt55PhaseoutError,
  isGpt55PhaseoutModel
} = require('../utils/gpt55PhaseoutHelper')

const CODEX_UPSTREAM_USER_AGENT =
  'codex-tui/0.118.0 (Mac OS 26.3.1; arm64) iTerm.app/3.6.9 (codex-tui; 0.118.0)'
const CODEX_UPSTREAM_ORIGINATOR = 'codex-tui'
const GENERAL_OPENAI_UPSTREAM_UA_SOURCE_API_KEY_ID = 'a6c1ab90-3dd4-4426-925b-6ca11ef76d60'
const GENERAL_OPENAI_UPSTREAM_UA_SOURCE_API_KEY_NAME = 'shenjc'
const GENERAL_OPENAI_UPSTREAM_CODEX_VERSION_REDIS_KEY = 'openai:general:upstream_codex_tui_version'
const GENERAL_OPENAI_UPSTREAM_DEFAULT_CODEX_VERSION = '0.135.0'
const GENERAL_PROMPT_CACHE_KEY_MAX_LENGTH = 64
const CODEX_IMAGE_ENDPOINTS = {
  generations: 'https://chatgpt.com/backend-api/codex/images/generations',
  edits: 'https://chatgpt.com/backend-api/codex/images/edits'
}
const MAX_IMAGE_ERROR_RESPONSE_BYTES = 2 * 1024 * 1024
const IMAGE_STREAM_EARLY_SSE_DELAY_MS = 20000
const IMAGE_STREAM_HEARTBEAT_INTERVAL_MS = 15000
let generalOpenAIUpstreamCodexVersion = null

// Codex CLI 系统提示词（非 Codex CLI 客户端请求时注入，统一端点也使用）
const CODEX_CLI_INSTRUCTIONS =
  "You are Codex, based on GPT-5. You are running as a coding agent in the Codex CLI on a user's computer.\n\n## General\n\n- When searching for text or files, prefer using `rg` or `rg --files` respectively because `rg` is much faster than alternatives like `grep`. (If the `rg` command is not found, then use alternatives.)\n\n## Editing constraints\n\n- Default to ASCII when editing or creating files. Only introduce non-ASCII or other Unicode characters when there is a clear justification and the file already uses them.\n- Add succinct code comments that explain what is going on if code is not self-explanatory. You should not add comments like \"Assigns the value to the variable\", but a brief comment might be useful ahead of a complex code block that the user would otherwise have to spend time parsing out. Usage of these comments should be rare.\n- Try to use apply_patch for single file edits, but it is fine to explore other options to make the edit if it does not work well. Do not use apply_patch for changes that are auto-generated (i.e. generating package.json or running a lint or format command like gofmt) or when scripting is more efficient (such as search and replacing a string across a codebase).\n- You may be in a dirty git worktree.\n    * NEVER revert existing changes you did not make unless explicitly requested, since these changes were made by the user.\n    * If asked to make a commit or code edits and there are unrelated changes to your work or changes that you didn't make in those files, don't revert those changes.\n    * If the changes are in files you've touched recently, you should read carefully and understand how you can work with the changes rather than reverting them.\n    * If the changes are in unrelated files, just ignore them and don't revert them.\n- Do not amend a commit unless explicitly requested to do so.\n- While you are working, you might notice unexpected changes that you didn't make. If this happens, STOP IMMEDIATELY and ask the user how they would like to proceed.\n- **NEVER** use destructive commands like `git reset --hard` or `git checkout --` unless specifically requested or approved by the user.\n\n## Plan tool\n\nWhen using the planning tool:\n- Skip using the planning tool for straightforward tasks (roughly the easiest 25%).\n- Do not make single-step plans.\n- When you made a plan, update it after having performed one of the sub-tasks that you shared on the plan.\n\n## Codex CLI harness, sandboxing, and approvals\n\nThe Codex CLI harness supports several different configurations for sandboxing and escalation approvals that the user can choose from.\n\nFilesystem sandboxing defines which files can be read or written. The options for `sandbox_mode` are:\n- **read-only**: The sandbox only permits reading files.\n- **workspace-write**: The sandbox permits reading files, and editing files in `cwd` and `writable_roots`. Editing files in other directories requires approval.\n- **danger-full-access**: No filesystem sandboxing - all commands are permitted.\n\nNetwork sandboxing defines whether network can be accessed without approval. Options for `network_access` are:\n- **restricted**: Requires approval\n- **enabled**: No approval needed\n\nApprovals are your mechanism to get user consent to run shell commands without the sandbox. Possible configuration options for `approval_policy` are\n- **untrusted**: The harness will escalate most commands for user approval, apart from a limited allowlist of safe \"read\" commands.\n- **on-failure**: The harness will allow all commands to run in the sandbox (if enabled), and failures will be escalated to the user for approval to run again without the sandbox.\n- **on-request**: Commands will be run in the sandbox by default, and you can specify in your tool call if you want to escalate a command to run without sandboxing. (Note that this mode is not always available. If it is, you'll see parameters for it in the `shell` command description.)\n- **never**: This is a non-interactive mode where you may NEVER ask the user for approval to run commands. Instead, you must always persist and work around constraints to solve the task for the user. You MUST do your utmost best to finish the task and validate your work before yielding. If this mode is paired with `danger-full-access`, take advantage of it to deliver the best outcome for the user. Further, in this mode, your default testing philosophy is overridden: Even if you don't see local patterns for testing, you may add tests and scripts to validate your work. Just remove them before yielding.\n\nWhen you are running with `approval_policy == on-request`, and sandboxing enabled, here are scenarios where you'll need to request approval:\n- You need to run a command that writes to a directory that requires it (e.g. running tests that write to /var)\n- You need to run a GUI app (e.g., open/xdg-open/osascript) to open browsers or files.\n- You are running sandboxed and need to run a command that requires network access (e.g. installing packages)\n- If you run a command that is important to solving the user's query, but it fails because of sandboxing, rerun the command with approval. ALWAYS proceed to use the `with_escalated_permissions` and `justification` parameters - do not message the user before requesting approval for the command.\n- You are about to take a potentially destructive action such as an `rm` or `git reset` that the user did not explicitly ask for\n- (for all of these, you should weigh alternative paths that do not require approval)\n\nWhen `sandbox_mode` is set to read-only, you'll need to request approval for any command that isn't a read.\n\nYou will be told what filesystem sandboxing, network sandboxing, and approval mode are active in a developer or user message. If you are not told about this, assume that you are running with workspace-write, network sandboxing enabled, and approval on-failure.\n\nAlthough they introduce friction to the user because your work is paused until the user responds, you should leverage them when necessary to accomplish important work. If the completing the task requires escalated permissions, Do not let these settings or the sandbox deter you from attempting to accomplish the user's task unless it is set to \"never\", in which case never ask for approvals.\n\nWhen requesting approval to execute a command that will require escalated privileges:\n  - Provide the `with_escalated_permissions` parameter with the boolean value true\n  - Include a short, 1 sentence explanation for why you need to enable `with_escalated_permissions` in the justification parameter\n\n## Special user requests\n\n- If the user makes a simple request (such as asking for the time) which you can fulfill by running a terminal command (such as `date`), you should do so.\n- If the user asks for a \"review\", default to a code review mindset: prioritise identifying bugs, risks, behavioural regressions, and missing tests. Findings must be the primary focus of the response - keep summaries or overviews brief and only after enumerating the issues. Present findings first (ordered by severity with file/line references), follow with open questions or assumptions, and offer a change-summary only as a secondary detail. If no findings are discovered, state that explicitly and mention any residual risks or testing gaps.\n\n## Frontend tasks\nWhen doing frontend design tasks, avoid collapsing into \"AI slop\" or safe, average-looking layouts.\nAim for interfaces that feel intentional, bold, and a bit surprising.\n- Typography: Use expressive, purposeful fonts and avoid default stacks (Inter, Roboto, Arial, system).\n- Color & Look: Choose a clear visual direction; define CSS variables; avoid purple-on-white defaults. No purple bias or dark mode bias.\n- Motion: Use a few meaningful animations (page-load, staggered reveals) instead of generic micro-motions.\n- Background: Don't rely on flat, single-color backgrounds; use gradients, shapes, or subtle patterns to build atmosphere.\n- Overall: Avoid boilerplate layouts and interchangeable UI patterns. Vary themes, type families, and visual languages across outputs.\n- Ensure the page loads properly on both desktop and mobile\n\nException: If working within an existing website or design system, preserve the established patterns, structure, and visual language.\n\n## Presenting your work and final message\n\nYou are producing plain text that will later be styled by the CLI. Follow these rules exactly. Formatting should make results easy to scan, but not feel mechanical. Use judgment to decide how much structure adds value.\n\n- Default: be very concise; friendly coding teammate tone.\n- Ask only when needed; suggest ideas; mirror the user's style.\n- For substantial work, summarize clearly; follow final‑answer formatting.\n- Skip heavy formatting for simple confirmations.\n- Don't dump large files you've written; reference paths only.\n- No \"save/copy this file\" - User is on the same machine.\n- Offer logical next steps (tests, commits, build) briefly; add verify steps if you couldn't do something.\n- For code changes:\n  * Lead with a quick explanation of the change, and then give more details on the context covering where and why a change was made. Do not start this explanation with \"summary\", just jump right in.\n  * If there are natural next steps the user may want to take, suggest them at the end of your response. Do not make suggestions if there are no natural next steps.\n  * When suggesting multiple options, use numeric lists for the suggestions so the user can quickly respond with a single number.\n- The user does not command execution outputs. When asked to show the output of a command (e.g. `git show`), relay the important details in your answer or summarize the key lines so the user understands the result.\n\n### Final answer structure and style guidelines\n\n- Plain text; CLI handles styling. Use structure only when it helps scanability.\n- Headers: optional; short Title Case (1-3 words) wrapped in **…**; no blank line before the first bullet; add only if they truly help.\n- Bullets: use - ; merge related points; keep to one line when possible; 4–6 per list ordered by importance; keep phrasing consistent.\n- Monospace: backticks for commands/paths/env vars/code ids and inline examples; use for literal keyword bullets; never combine with **.\n- Code samples or multi-line snippets should be wrapped in fenced code blocks; include an info string as often as possible.\n- Structure: group related bullets; order sections general → specific → supporting; for subsections, start with a bolded keyword bullet, then items; match complexity to the task.\n- Tone: collaborative, concise, factual; present tense, active voice; self‑contained; no \"above/below\"; parallel wording.\n- Don'ts: no nested bullets/hierarchies; no ANSI codes; don't cram unrelated keywords; keep keyword lists short—wrap/reformat if long; avoid naming formatting styles in answers.\n- Adaptation: code explanations → precise, structured with code refs; simple tasks → lead with outcome; big changes → logical walkthrough + rationale + next actions; casual one-offs → plain sentences, no headers/bullets.\n- File References: When referencing files in your response follow the below rules:\n  * Use inline code to make file paths clickable.\n  * Each reference should have a stand alone path. Even if it's the same file.\n  * Accepted: absolute, workspace‑relative, a/ or b/ diff prefixes, or bare filename/suffix.\n  * Optionally include line/column (1‑based): :line[:column] or #Lline[Ccolumn] (column defaults to 1).\n  * Do not use URIs like file://, vscode://, or https://.\n  * Do not provide range of lines\n  * Examples: src/app.ts, src/app.ts:42, b/server/index.js#L10, C:\\repo\\project\\main.rs:12:5\n"

// 创建代理 Agent（使用统一的代理工具）
function createProxyAgent(proxy) {
  return ProxyHelper.createProxyAgent(proxy)
}

// 检查 API Key 是否具备 OpenAI 权限
function checkOpenAIPermissions(apiKeyData) {
  return apiKeyService.hasPermission(apiKeyData?.permissions, 'openai')
}

function normalizeHeaders(headers = {}) {
  if (!headers || typeof headers !== 'object') {
    return {}
  }
  const normalized = {}
  for (const [key, value] of Object.entries(headers)) {
    if (!key) {
      continue
    }
    normalized[key.toLowerCase()] = Array.isArray(value) ? value[0] : value
  }
  return normalized
}

function getHeaderValue(headers = {}, key) {
  const normalized = normalizeHeaders(headers)
  const value = normalized[key.toLowerCase()]
  if (value === undefined || value === null) {
    return ''
  }
  return String(value).trim()
}

function normalizeCodexTuiVersion(version) {
  if (typeof version !== 'string') {
    return null
  }

  const trimmed = version.trim()
  return /^\d+(?:\.\d+){1,3}$/.test(trimmed) ? trimmed : null
}

function extractCodexTuiVersion(userAgent) {
  if (typeof userAgent !== 'string') {
    return null
  }

  const match = userAgent.trim().match(/^codex-tui\/(\d+(?:\.\d+){1,3})\b/i)
  return match ? normalizeCodexTuiVersion(match[1]) : null
}

function buildGeneralOpenAIUpstreamUserAgent(version) {
  const resolvedVersion =
    normalizeCodexTuiVersion(version) || GENERAL_OPENAI_UPSTREAM_DEFAULT_CODEX_VERSION
  return `codex-tui/${resolvedVersion} (Ubuntu 24.4.0; x86_64) WindowsTerminal (codex-tui; ${resolvedVersion})`
}

function isGeneralOpenAIUpstreamUserAgentSource(apiKeyData = {}) {
  return (
    apiKeyData?.id === GENERAL_OPENAI_UPSTREAM_UA_SOURCE_API_KEY_ID ||
    apiKeyData?.name === GENERAL_OPENAI_UPSTREAM_UA_SOURCE_API_KEY_NAME
  )
}

async function persistGeneralOpenAIUpstreamCodexVersion(version) {
  try {
    const client = typeof redis.getClient === 'function' ? redis.getClient() : null
    if (client && typeof client.set === 'function') {
      await client.set(GENERAL_OPENAI_UPSTREAM_CODEX_VERSION_REDIS_KEY, version)
    }
  } catch (error) {
    logger.debug(`Failed to persist general OpenAI upstream Codex UA version: ${error.message}`)
  }
}

async function learnGeneralOpenAIUpstreamCodexVersion(apiKeyData = {}, userAgent = '') {
  if (!isGeneralOpenAIUpstreamUserAgentSource(apiKeyData)) {
    return null
  }

  const version = extractCodexTuiVersion(userAgent)
  if (!version) {
    return null
  }

  if (generalOpenAIUpstreamCodexVersion === version) {
    return version
  }

  generalOpenAIUpstreamCodexVersion = version
  await persistGeneralOpenAIUpstreamCodexVersion(version)
  logger.info(`🧭 Learned general OpenAI upstream Codex UA version from shenjc: ${version}`)
  return version
}

async function getGeneralOpenAIUpstreamCodexVersion() {
  if (generalOpenAIUpstreamCodexVersion) {
    return generalOpenAIUpstreamCodexVersion
  }

  try {
    const client = typeof redis.getClient === 'function' ? redis.getClient() : null
    if (client && typeof client.get === 'function') {
      const storedVersion = normalizeCodexTuiVersion(
        await client.get(GENERAL_OPENAI_UPSTREAM_CODEX_VERSION_REDIS_KEY)
      )
      if (storedVersion) {
        generalOpenAIUpstreamCodexVersion = storedVersion
        return storedVersion
      }
    }
  } catch (error) {
    logger.debug(`Failed to load general OpenAI upstream Codex UA version: ${error.message}`)
  }

  generalOpenAIUpstreamCodexVersion = GENERAL_OPENAI_UPSTREAM_DEFAULT_CODEX_VERSION
  return generalOpenAIUpstreamCodexVersion
}

async function getGeneralOpenAIUpstreamUserAgent() {
  const version = await getGeneralOpenAIUpstreamCodexVersion()
  return buildGeneralOpenAIUpstreamUserAgent(version)
}

function copyHeaderIfPresent(target, incoming, key, targetKey = key.toLowerCase()) {
  const value = getHeaderValue(incoming, key)
  if (value) {
    target[targetKey] = value
  }
}

function getPromptCacheSessionId(body = {}) {
  const value = body?.prompt_cache_key
  if (value === undefined || value === null || value === '') {
    return ''
  }
  return String(value).trim()
}

function buildCodexUpstreamHeaders({
  incoming = {},
  accessToken,
  accountHeader,
  isStream,
  body = {},
  userAgentOverride = null,
  isResponsesLite = false
}) {
  const headers = {}

  const passthroughHeaders = [
    'version',
    'openai-beta',
    'session_id',
    'x-codex-beta-features',
    'x-codex-turn-metadata',
    'x-client-request-id'
  ]
  passthroughHeaders.forEach((key) => copyHeaderIfPresent(headers, incoming, key))
  if (isResponsesLite) {
    headers[RESPONSES_LITE_HEADER] = 'true'
  }

  const userAgent =
    (typeof userAgentOverride === 'string' && userAgentOverride.trim()) ||
    getHeaderValue(incoming, 'user-agent') ||
    CODEX_UPSTREAM_USER_AGENT
  headers['user-agent'] = userAgent

  if (!getHeaderValue(headers, 'session_id')) {
    const promptCacheSessionId = getPromptCacheSessionId(body)
    if (promptCacheSessionId) {
      headers['session_id'] = promptCacheSessionId
    } else if (userAgent.includes('Mac OS')) {
      headers['session_id'] = crypto.randomUUID()
    }
  }

  headers['authorization'] = `Bearer ${accessToken}`
  headers['chatgpt-account-id'] = accountHeader
  headers['host'] = 'chatgpt.com'
  headers['accept'] = isStream ? 'text/event-stream' : 'application/json'
  headers['content-type'] = 'application/json'
  headers['connection'] = 'Keep-Alive'
  headers['originator'] = getHeaderValue(incoming, 'originator') || CODEX_UPSTREAM_ORIGINATOR

  return headers
}

function toNumberSafe(value) {
  if (value === undefined || value === null || value === '') {
    return null
  }
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function isInterleaveNicEnabled(accountData = {}) {
  return accountData?.interleaveNicEnabled === true || accountData?.interleaveNicEnabled === 'true'
}

function isLocalAddressNetworkError(error) {
  const errorCodes = new Set(['EADDRNOTAVAIL', 'ENETUNREACH'])
  return errorCodes.has(error?.code) || errorCodes.has(error?.cause?.code)
}

async function handleOpenAINicCooldownOnRateLimit({
  account,
  accountId,
  req,
  sessionHash,
  selectedLocalAddress,
  source,
  resetsInSeconds = null,
  errorData = null
}) {
  if (!selectedLocalAddress || !isInterleaveNicEnabled(account)) {
    return { handled: false, retryable: false, reason: 'not_available' }
  }

  const cooldownResult = await openaiNicSelector.markCooldown({
    accountId,
    localAddress: selectedLocalAddress,
    disabledAddresses: account.interleaveNicDisabledAddresses
  })
  const historyContext = {
    model: req?.body?.model || null,
    path: req?.originalUrl || req?.path || null,
    apiKeyName: req?.apiKey?.name || null,
    source,
    interleaveNic: true,
    localAddress: selectedLocalAddress,
    upstreamNicIp: selectedLocalAddress,
    cooldownApplied: Boolean(cooldownResult.marked),
    cooldownReason: cooldownResult.reason || (cooldownResult.marked ? 'cooldown_applied' : null),
    cooldownSeconds: cooldownResult.ttlSeconds || null,
    cooldownExpiresAt: cooldownResult.expiresAt || null,
    remainingNicAddresses:
      cooldownResult.remainingAddresses === undefined ? null : cooldownResult.remainingAddresses,
    resetsInSeconds,
    errorBody: errorData || null
  }

  await upstreamErrorHelper
    .recordErrorHistory(accountId, 'openai', 429, 'rate_limit', historyContext)
    .catch(() => {})

  if (cooldownResult.marked) {
    await openaiNicSelector.clearBinding({ accountId, sessionHash })
    logger.warn(
      `🚫 OpenAI NIC ${selectedLocalAddress} entered ${cooldownResult.ttlSeconds}s cooldown for account ${accountId} after ${source} rate limit; ${cooldownResult.remainingAddresses} alternate NIC(s) remain`
    )
    return {
      handled: true,
      retryable: true,
      reason: 'cooldown_applied',
      historyRecorded: true,
      cooldownResult
    }
  }

  if (cooldownResult.reason === 'last_available') {
    logger.warn(
      `🚫 OpenAI NIC ${selectedLocalAddress} hit rate limit for account ${accountId}, but it is the last available NIC; skipping NIC and account cooldown`
    )
    return {
      handled: true,
      retryable: false,
      reason: 'last_available',
      historyRecorded: true,
      cooldownResult
    }
  }

  if (cooldownResult.reason === 'not_available' || cooldownResult.reason === 'unknown_address') {
    logger.warn(
      `🚫 OpenAI NIC cooldown skipped for account ${accountId}, address ${selectedLocalAddress}: ${cooldownResult.reason || 'unknown'}`
    )
    return {
      handled: false,
      retryable: false,
      reason: cooldownResult.reason || 'unknown',
      historyRecorded: true,
      cooldownResult
    }
  }

  logger.warn(
    `🚫 OpenAI NIC cooldown failed for account ${accountId}, address ${selectedLocalAddress}: ${cooldownResult.reason || 'unknown'}`
  )
  return {
    handled: false,
    retryable: false,
    reason: cooldownResult.reason || 'unknown',
    historyRecorded: true,
    cooldownResult
  }
}

function recordOpenAIRateLimitHistory(accountId, req, source, resetsInSeconds, errorData) {
  const historyContext = {
    model: req?.body?.model || null,
    path: req?.originalUrl || req?.path || null,
    apiKeyName: req?.apiKey?.name || null,
    source,
    interleaveNic: false,
    resetsInSeconds,
    errorBody: errorData || null
  }

  return upstreamErrorHelper.recordErrorHistory(
    accountId,
    'openai',
    429,
    'rate_limit',
    historyContext
  )
}

async function parseOpenAIRateLimitResponse(upstream, isStream) {
  let resetsInSeconds = null
  let errorData = null

  try {
    if (isStream && upstream.data) {
      const chunks = []
      await new Promise((resolve, reject) => {
        upstream.data.on('data', (chunk) => chunks.push(chunk))
        upstream.data.on('end', resolve)
        upstream.data.on('error', reject)
        setTimeout(resolve, 5000)
      })

      const fullResponse = Buffer.concat(chunks).toString()
      try {
        errorData = JSON.parse(fullResponse)
      } catch (e) {
        logger.error('Failed to parse 429 error response:', e)
        logger.debug('Raw response:', fullResponse)
      }
    } else {
      errorData = upstream.data
    }

    if (errorData && errorData.error && errorData.error.resets_in_seconds) {
      resetsInSeconds = errorData.error.resets_in_seconds
      logger.info(
        `🕐 Codex rate limit will reset in ${resetsInSeconds} seconds (${Math.ceil(resetsInSeconds / 60)} minutes / ${Math.ceil(resetsInSeconds / 3600)} hours)`
      )
    } else {
      logger.warn('⚠️ Could not extract resets_in_seconds from 429 response')
    }
  } catch (e) {
    logger.error('⚠️ Failed to parse rate limit error:', e)
  }

  return {
    errorData,
    resetsInSeconds
  }
}

function buildOpenAIRateLimitErrorResponse(errorData, resetsInSeconds) {
  return (
    errorData || {
      error: {
        type: 'usage_limit_reached',
        message: 'The usage limit has been reached',
        resets_in_seconds: resetsInSeconds
      }
    }
  )
}

function sendOpenAIRateLimitResponse(res, isStream, errorResponse) {
  if (isStream) {
    res.status(429)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.write(`data: ${JSON.stringify(errorResponse)}\n\n`)
    res.end()
  } else {
    res.status(429).json(errorResponse)
  }
}

function extractCodexUsageHeaders(headers) {
  const normalized = normalizeHeaders(headers)
  if (!normalized || Object.keys(normalized).length === 0) {
    return null
  }

  const snapshot = {
    primaryUsedPercent: toNumberSafe(normalized['x-codex-primary-used-percent']),
    primaryResetAfterSeconds: toNumberSafe(normalized['x-codex-primary-reset-after-seconds']),
    primaryWindowMinutes: toNumberSafe(normalized['x-codex-primary-window-minutes']),
    secondaryUsedPercent: toNumberSafe(normalized['x-codex-secondary-used-percent']),
    secondaryResetAfterSeconds: toNumberSafe(normalized['x-codex-secondary-reset-after-seconds']),
    secondaryWindowMinutes: toNumberSafe(normalized['x-codex-secondary-window-minutes']),
    primaryOverSecondaryPercent: toNumberSafe(
      normalized['x-codex-primary-over-secondary-limit-percent']
    )
  }

  const hasData = Object.values(snapshot).some((value) => value !== null)
  return hasData ? snapshot : null
}

function isCompactResponsesRoute(req) {
  return (
    req.path === '/responses/compact' ||
    req.path === '/v1/responses/compact' ||
    (req.originalUrl && req.originalUrl.includes('/responses/compact'))
  )
}

function isStandardResponsesRoute(req) {
  if (req._fromUnifiedEndpoint) {
    return false
  }

  return req.path === '/responses' || req.path === '/v1/responses'
}

function getCodexCompatibleModel(requestedModel = null) {
  const isCodexModel =
    typeof requestedModel === 'string' && requestedModel.toLowerCase().includes('codex')

  if (requestedModel && requestedModel.startsWith('gpt-5-') && !isCodexModel) {
    return 'gpt-5'
  }

  return requestedModel
}

function normalizeGpt5ModelForCodex(body = {}) {
  const requestedModel = body?.model || null
  const compatibleModel = getCodexCompatibleModel(requestedModel)

  if (compatibleModel !== requestedModel) {
    logger.info(`📝 Model ${requestedModel} detected, normalizing to gpt-5 for Codex API`)
    body.model = compatibleModel
  }

  return compatibleModel
}

function applyCodexCliAdaptation(body = {}) {
  const fieldsToRemove = [
    'temperature',
    'top_p',
    'max_output_tokens',
    'user',
    'text_formatting',
    'truncation',
    'text',
    'service_tier',
    'prompt_cache_retention',
    'safety_identifier'
  ]

  fieldsToRemove.forEach((field) => {
    delete body[field]
  })

  body.instructions = CODEX_CLI_INSTRUCTIONS
}

function buildShortGeneralPromptCacheKey(body = {}, apiKeyData = {}) {
  const key = body.prompt_cache_key
  return `g:${crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        apiKeyId: apiKeyData.id || 'unknown',
        model: body.model || 'unknown',
        promptCacheKey: key
      })
    )
    .digest('hex')
    .slice(0, GENERAL_PROMPT_CACHE_KEY_MAX_LENGTH - 2)}`
}

function stripUnsupportedGeneralOpenAIFields(body = {}, apiKeyData = {}) {
  if (!body || typeof body !== 'object') {
    return
  }

  if (Object.prototype.hasOwnProperty.call(body, 'prompt_cache_retention')) {
    delete body.prompt_cache_retention
    logger.info('📦 General OpenAI request removed unsupported prompt_cache_retention field')
  }

  const promptCacheKey =
    body.prompt_cache_key === undefined || body.prompt_cache_key === null
      ? ''
      : String(body.prompt_cache_key).trim()
  if (promptCacheKey.length > GENERAL_PROMPT_CACHE_KEY_MAX_LENGTH) {
    body.prompt_cache_key = buildShortGeneralPromptCacheKey(body, apiKeyData)
    logger.info(
      `📦 General OpenAI request compressed prompt_cache_key to ${GENERAL_PROMPT_CACHE_KEY_MAX_LENGTH} chars`
    )
  }
}

async function applyRateLimitTracking(
  req,
  usageSummary,
  model,
  context = '',
  accountType = null,
  preCalculatedCost = null
) {
  if (!req.rateLimitInfo) {
    return
  }

  const label = context ? ` (${context})` : ''

  try {
    const { totalTokens, totalCost } = await updateRateLimitCounters(
      req.rateLimitInfo,
      usageSummary,
      model,
      req.apiKey?.id,
      accountType,
      preCalculatedCost
    )

    if (totalTokens > 0) {
      logger.api(`📊 Updated rate limit token count${label}: +${totalTokens} tokens`)
    }
    if (typeof totalCost === 'number' && totalCost > 0) {
      logger.api(`💰 Updated rate limit cost count${label}: +$${totalCost.toFixed(6)}`)
    }
  } catch (error) {
    logger.error(`❌ Failed to update rate limit counters${label}:`, error)
  }
}

function cloneJson(value) {
  if (!value || typeof value !== 'object') {
    return value
  }
  return JSON.parse(JSON.stringify(value))
}

function getCodexOutputIndex(eventData = {}) {
  const index = eventData.output_index
  if (Number.isInteger(index) && index >= 0) {
    return index
  }
  const parsed = Number(index)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}

function createCodexNonStreamOutputAggregator() {
  const states = new Map()
  const fallbackItems = []

  const ensureState = (outputIndex) => {
    if (!states.has(outputIndex)) {
      states.set(outputIndex, {
        outputIndex,
        item: null,
        itemType: '',
        sawItemDone: false,
        contentParts: new Map(),
        summaryParts: new Map(),
        functionArgs: '',
        hasArgsFinal: false,
        functionDelta: ''
      })
    }
    return states.get(outputIndex)
  }

  const ensurePartState = (parts, index) => {
    const safeIndex = Number.isInteger(index) && index >= 0 ? index : 0
    if (!parts.has(safeIndex)) {
      parts.set(safeIndex, {
        raw: null,
        text: '',
        hasFinal: false,
        delta: ''
      })
    }
    return parts.get(safeIndex)
  }

  const process = (eventData = {}) => {
    const eventType = eventData.type
    let outputIndex
    let state

    switch (eventType) {
      case 'response.output_item.added':
      case 'response.output_item.done':
        if (!eventData.item || typeof eventData.item !== 'object') {
          return
        }
        outputIndex = getCodexOutputIndex(eventData)
        if (outputIndex === null) {
          if (eventType === 'response.output_item.done') {
            fallbackItems.push(cloneJson(eventData.item))
          }
          return
        }
        state = ensureState(outputIndex)
        if (!state.sawItemDone || eventType === 'response.output_item.done' || !state.item) {
          state.item = cloneJson(eventData.item)
          state.itemType = eventData.item.type || state.itemType
        }
        if (eventType === 'response.output_item.done') {
          state.sawItemDone = true
        }
        return

      case 'response.content_part.added':
      case 'response.content_part.done':
        outputIndex = getCodexOutputIndex(eventData)
        if (outputIndex === null) {
          return
        }
        state = ensureState(outputIndex)
        {
          const partState = ensurePartState(
            state.contentParts,
            Number(eventData.content_index || 0)
          )
          if (eventData.part && typeof eventData.part === 'object') {
            partState.raw = cloneJson(eventData.part)
          }
          if (eventType === 'response.content_part.done') {
            partState.text = eventData.part?.text || ''
            partState.hasFinal = true
          }
        }
        return

      case 'response.output_text.delta':
        outputIndex = getCodexOutputIndex(eventData)
        if (outputIndex === null) {
          return
        }
        state = ensureState(outputIndex)
        ensurePartState(state.contentParts, Number(eventData.content_index || 0)).delta +=
          eventData.delta || ''
        return

      case 'response.output_text.done':
        outputIndex = getCodexOutputIndex(eventData)
        if (outputIndex === null) {
          return
        }
        state = ensureState(outputIndex)
        {
          const partState = ensurePartState(
            state.contentParts,
            Number(eventData.content_index || 0)
          )
          partState.text = eventData.text || ''
          partState.hasFinal = true
        }
        return

      case 'response.reasoning_summary_part.added':
      case 'response.reasoning_summary_part.done':
        outputIndex = getCodexOutputIndex(eventData)
        if (outputIndex === null) {
          return
        }
        state = ensureState(outputIndex)
        {
          const partState = ensurePartState(
            state.summaryParts,
            Number(eventData.summary_index || 0)
          )
          if (eventData.part && typeof eventData.part === 'object') {
            partState.raw = cloneJson(eventData.part)
          }
          if (eventType === 'response.reasoning_summary_part.done') {
            partState.text = eventData.part?.text || ''
            partState.hasFinal = true
          }
        }
        return

      case 'response.reasoning_summary_text.delta':
        outputIndex = getCodexOutputIndex(eventData)
        if (outputIndex === null) {
          return
        }
        state = ensureState(outputIndex)
        ensurePartState(state.summaryParts, Number(eventData.summary_index || 0)).delta +=
          eventData.delta || ''
        return

      case 'response.reasoning_summary_text.done':
        outputIndex = getCodexOutputIndex(eventData)
        if (outputIndex === null) {
          return
        }
        state = ensureState(outputIndex)
        {
          const partState = ensurePartState(
            state.summaryParts,
            Number(eventData.summary_index || 0)
          )
          partState.text = eventData.text || ''
          partState.hasFinal = true
        }
        return

      case 'response.function_call_arguments.delta':
        outputIndex = getCodexOutputIndex(eventData)
        if (outputIndex === null) {
          return
        }
        ensureState(outputIndex).functionDelta += eventData.delta || ''
        return

      case 'response.function_call_arguments.done':
        outputIndex = getCodexOutputIndex(eventData)
        if (outputIndex === null) {
          return
        }
        state = ensureState(outputIndex)
        state.functionArgs = eventData.arguments || ''
        state.hasArgsFinal = true
        return

      default:
        return
    }
  }

  const finalizePartArray = (parts, fallbackTemplate) =>
    [...parts.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, partState]) => {
        const part = cloneJson(partState.raw) || cloneJson(fallbackTemplate)
        const text = partState.hasFinal ? partState.text : partState.delta || part.text || ''
        part.text = text
        return part
      })

  const finalizeItem = (state) => {
    const item = cloneJson(state.item) || { type: state.itemType || 'message' }
    switch (item.type) {
      case 'message': {
        const content = finalizePartArray(state.contentParts, {
          type: 'output_text',
          annotations: [],
          logprobs: [],
          text: ''
        })
        if (content.length > 0) {
          item.content = content
        }
        return item
      }
      case 'reasoning': {
        const summary = finalizePartArray(state.summaryParts, {
          type: 'summary_text',
          text: ''
        })
        if (summary.length > 0) {
          item.summary = summary
        }
        return item
      }
      case 'function_call':
        if (state.hasArgsFinal || state.functionDelta) {
          item.arguments = state.hasArgsFinal ? state.functionArgs : state.functionDelta
        }
        return item
      default:
        return item
    }
  }

  const patchCompleted = (completedEvent) => {
    if (!completedEvent?.response) {
      return completedEvent
    }

    const outputItems = [...states.values()]
      .sort((left, right) => left.outputIndex - right.outputIndex)
      .map(finalizeItem)
      .filter(Boolean)
      .concat(fallbackItems)

    if (outputItems.length === 0) {
      return completedEvent
    }

    const existingOutput = Array.isArray(completedEvent.response.output)
      ? completedEvent.response.output
      : []
    const seen = new Set(outputItems.map((item) => JSON.stringify(item)))
    const mergedOutput = outputItems.concat(
      existingOutput.filter((item) => {
        const key = JSON.stringify(item)
        if (seen.has(key)) {
          return false
        }
        seen.add(key)
        return true
      })
    )

    const patchedEvent = cloneJson(completedEvent)
    patchedEvent.response.output = mergedOutput
    return patchedEvent
  }

  return { process, patchCompleted }
}

// 使用统一调度器选择 OpenAI 账户
async function getOpenAIAuthToken(
  apiKeyData,
  sessionId = null,
  requestedModel = null,
  schedulerOptions = null
) {
  try {
    // 生成会话哈希（如果有会话ID）
    const sessionHash = sessionId
      ? crypto.createHash('sha256').update(sessionId).digest('hex')
      : null

    // 使用统一调度器选择账户
    const schedulerArgs = [apiKeyData, sessionHash, requestedModel]
    if (schedulerOptions && Object.keys(schedulerOptions).length > 0) {
      schedulerArgs.push(schedulerOptions)
    }
    const result = await unifiedOpenAIScheduler.selectAccountForApiKey(...schedulerArgs)

    if (!result || !result.accountId) {
      const error = new Error('No available OpenAI account found')
      error.statusCode = 402 // Payment Required - 资源耗尽
      throw error
    }

    // 根据账户类型获取账户详情
    let account,
      accessToken,
      proxy = null

    if (result.accountType === 'openai-responses') {
      // 处理 OpenAI-Responses 账户
      account = await openaiResponsesAccountService.getAccount(result.accountId)
      if (!account || !account.apiKey) {
        const error = new Error(`OpenAI-Responses account ${result.accountId} has no valid apiKey`)
        error.statusCode = 403 // Forbidden - 账户配置错误
        throw error
      }

      // OpenAI-Responses 账户不需要 accessToken，直接返回账户信息
      accessToken = null // OpenAI-Responses 使用账户内的 apiKey

      // 解析代理配置
      if (account.proxy) {
        try {
          proxy = typeof account.proxy === 'string' ? JSON.parse(account.proxy) : account.proxy
        } catch (e) {
          logger.warn('Failed to parse proxy configuration:', e)
        }
      }

      logger.info(`Selected OpenAI-Responses account: ${account.name} (${result.accountId})`)
    } else {
      // 处理普通 OpenAI 账户
      account = await openaiAccountService.getAccount(result.accountId)
      if (!account || !account.accessToken) {
        const error = new Error(`OpenAI account ${result.accountId} has no valid accessToken`)
        error.statusCode = 403 // Forbidden - 账户配置错误
        throw error
      }

      // 检查 token 是否过期并自动刷新（双重保护）
      if (openaiAccountService.isTokenExpired(account)) {
        if (account.refreshToken) {
          logger.info(`🔄 Token expired, auto-refreshing for account ${account.name} (fallback)`)
          try {
            await openaiAccountService.refreshAccountToken(result.accountId)
            // 重新获取更新后的账户
            account = await openaiAccountService.getAccount(result.accountId)
            logger.info(`✅ Token refreshed successfully in route handler`)
          } catch (refreshError) {
            logger.error(`Failed to refresh token for ${account.name}:`, refreshError)
            const error = new Error(`Token expired and refresh failed: ${refreshError.message}`)
            error.statusCode = 403 // Forbidden - 认证失败
            throw error
          }
        } else {
          const error = new Error(
            `Token expired and no refresh token available for account ${account.name}`
          )
          error.statusCode = 403 // Forbidden - 认证失败
          throw error
        }
      }

      // 解密 accessToken（account.accessToken 是加密的）
      accessToken = openaiAccountService.decrypt(account.accessToken)
      if (!accessToken) {
        const error = new Error('Failed to decrypt OpenAI accessToken')
        error.statusCode = 403 // Forbidden - 配置/权限错误
        throw error
      }

      // 解析代理配置
      if (account.proxy) {
        try {
          proxy = typeof account.proxy === 'string' ? JSON.parse(account.proxy) : account.proxy
        } catch (e) {
          logger.warn('Failed to parse proxy configuration:', e)
        }
      }

      logger.info(`Selected OpenAI account: ${account.name} (${result.accountId})`)
    }

    return {
      accessToken,
      accountId: result.accountId,
      accountName: account.name,
      accountType: result.accountType,
      proxy,
      account
    }
  } catch (error) {
    logger.error('Failed to get OpenAI auth token:', error)
    throw error
  }
}

// 主处理函数，供两个路由共享
const handleResponses = async (req, res) => {
  let upstream = null
  let accountId = null
  let accountType = 'openai'
  let sessionHash = null
  let account = null
  let proxy = null
  let accessToken = null

  try {
    // 从中间件获取 API Key 数据
    const apiKeyData = req.apiKey || {}

    if (!checkOpenAIPermissions(apiKeyData)) {
      logger.security(
        `🚫 API Key ${apiKeyData.id || 'unknown'} 缺少 OpenAI 权限，拒绝访问 ${req.originalUrl}`
      )
      return res.status(403).json({
        error: {
          message: 'This API key does not have permission to access OpenAI',
          type: 'permission_denied',
          code: 'permission_denied'
        }
      })
    }

    const downstreamModel = req.body?.model
    if (isGpt55PhaseoutModel(downstreamModel)) {
      logger.api('GPT-5.5 request rejected by model migration policy', {
        apiKeyId: apiKeyData.id || 'unknown',
        path: req.originalUrl || req.path || 'unknown',
        model: typeof downstreamModel === 'string' ? downstreamModel.trim() : downstreamModel,
        errorCode: GPT55_PHASEOUT_ERROR_CODE
      })
      return res.status(409).json(createGpt55PhaseoutError())
    }

    // 判断是否为 Codex CLI 的请求（基于 User-Agent）
    // 支持: codex_vscode, codex_cli_rs, codex_exec, codex-tui
    const userAgent = req.headers['user-agent'] || ''
    await learnGeneralOpenAIUpstreamCodexVersion(apiKeyData, userAgent)
    const codexCliPattern = /^(codex_vscode|codex_cli_rs|codex_exec|codex-tui)\/[\d.]+/i
    const isCodexCLI = codexCliPattern.test(userAgent)

    const standardResponsesRoute = isStandardResponsesRoute(req)
    const compactRoute = isCompactResponsesRoute(req)
    const shouldUseToggleControlledFlow = standardResponsesRoute && !compactRoute
    const isGeneralOpenAIEndpoint = req._generalOpenAIEndpoint === true
    const isNativeOpenAIResponsesRoute =
      !isGeneralOpenAIEndpoint &&
      !req._fromUnifiedEndpoint &&
      (standardResponsesRoute || compactRoute)
    const isResponsesLite =
      isNativeOpenAIResponsesRoute && isResponsesLiteRequest(req.headers || {})
    req._responsesLite = isResponsesLite
    req._responsesLiteUsageType = isResponsesLite
      ? compactRoute
        ? 'openai_responses_compact_lite'
        : 'openai_responses_lite'
      : null

    if (isGeneralOpenAIEndpoint && compactRoute) {
      return res.status(404).json({
        error: {
          message: '/general does not support responses compact',
          type: 'invalid_request_error',
          code: 'not_supported'
        }
      })
    }

    if (isResponsesLite) {
      if (shouldUseToggleControlledFlow && apiKeyData.enableOpenAIResponsesPayloadRules === true) {
        req.body = requestBodyRuleService.applyRules(
          req.body,
          apiKeyData.openaiResponsesPayloadRules
        )
        logger.info('🧩 Responses Lite request applied API key payload rules')
      }
      try {
        req.body = normalizeOpenAIResponsesLiteBody(req.body)
      } catch (error) {
        return res.status(error.statusCode || 400).json({
          error: {
            message: error.message,
            type: error.type || 'invalid_request_error',
            code: error.code || 'invalid_responses_lite_request'
          }
        })
      }
      logger.info(
        `🪶 Responses Lite request normalized for ${compactRoute ? 'compact' : 'responses'}`
      )
    } else if (isGeneralOpenAIEndpoint && shouldUseToggleControlledFlow) {
      normalizeGpt5ModelForCodex(req.body)

      if (apiKeyData.enableOpenAIResponsesPayloadRules === true) {
        req.body = requestBodyRuleService.applyRules(
          req.body,
          apiKeyData.openaiResponsesPayloadRules
        )
        logger.info('🧩 General OpenAI Responses request applied API key payload rules')
      } else {
        logger.info(
          '📦 General OpenAI Responses request is passing through without Codex adaptation'
        )
      }

      stripUnsupportedGeneralOpenAIFields(req.body, apiKeyData)
    } else if (shouldUseToggleControlledFlow) {
      const shouldApplyCodexAdaptation =
        apiKeyData.enableOpenAIResponsesCodexAdaptation === true && !isCodexCLI
      const shouldApplyPayloadRules = apiKeyData.enableOpenAIResponsesPayloadRules === true

      if (shouldApplyCodexAdaptation) {
        normalizeGpt5ModelForCodex(req.body)
        applyCodexCliAdaptation(req.body)
        logger.info('📝 Standard Responses request applied Codex CLI adaptation')
      } else if (isCodexCLI) {
        logger.info('✅ Codex CLI request detected, forwarding current payload')
      } else {
        logger.info('📦 Standard Responses request is passing through without Codex adaptation')
      }

      if (shouldApplyPayloadRules) {
        req.body = requestBodyRuleService.applyRules(
          req.body,
          apiKeyData.openaiResponsesPayloadRules
        )
        logger.info('🧩 Standard Responses request applied API key payload rules')
      }
    } else {
      normalizeGpt5ModelForCodex(req.body)

      if (!isCodexCLI && !req._fromUnifiedEndpoint) {
        applyCodexCliAdaptation(req.body)
        logger.info('📝 Non-Codex CLI request detected, applying Codex CLI adaptation')
      } else {
        logger.info('✅ Codex CLI request detected, forwarding as-is')
      }
    }

    if (removeGptFastModeFromBody(req.body, apiKeyData)) {
      logger.info(`🚫 API Key ${apiKeyData.id || 'unknown'} blocked GPT fast mode`)
    }

    // 从最终请求体中提取 service_tier，用于后续费用计算
    req._serviceTier = req.body?.service_tier || null

    // 从最终请求体中提取模型、会话 ID 和流式标志
    // NOTE: For some clients, prompt_cache_key is the only stable per-session key.
    const sessionId =
      req.headers['session_id'] ||
      req.headers['x-session-id'] ||
      req.body?.session_id ||
      req.body?.conversation_id ||
      req.body?.prompt_cache_key ||
      null

    sessionHash = sessionId ? crypto.createHash('sha256').update(sessionId).digest('hex') : null

    const requestedModel = req.body?.model || null
    const schedulerModel = isResponsesLite
      ? requestedModel
      : getCodexCompatibleModel(requestedModel)
    const downstreamIsStream =
      typeof req._downstreamStream === 'boolean'
        ? req._downstreamStream
        : req.body?.stream !== false
    const upstreamIsStream = req._forceCodexUpstreamStream === true ? true : downstreamIsStream
    if (req._forceCodexUpstreamStream === true && req.body) {
      req.body.stream = true
    }
    const isStream = downstreamIsStream

    if (schedulerModel !== requestedModel) {
      logger.info(
        `🧭 Using Codex-compatible model ${schedulerModel} for account selection (requested: ${requestedModel})`
      )
    }

    // 使用调度器选择账户
    {
      const schedulerOptions = isResponsesLite
        ? {
            ...(req._openAISchedulerOptions || {}),
            allowedAccountTypes: ['openai']
          }
        : req._openAISchedulerOptions || null
      const tokenArgs = [apiKeyData, sessionId, schedulerModel]
      if (schedulerOptions && Object.keys(schedulerOptions).length > 0) {
        tokenArgs.push(schedulerOptions)
      }
      ;({ accessToken, accountId, accountType, proxy, account } = await getOpenAIAuthToken(
        ...tokenArgs
      ))
    }

    // 如果是 OpenAI-Responses 账户，使用专门的中继服务处理
    if (accountType === 'openai-responses') {
      logger.info(`🔀 Using OpenAI-Responses relay service for account: ${account.name}`)
      return await openaiResponsesRelayService.handleRequest(req, res, account, apiKeyData)
    }

    if (!isResponsesLite && schedulerModel !== requestedModel) {
      logger.info(
        `📝 Standard Responses request normalized model ${requestedModel} -> ${schedulerModel} for OpenAI Codex backend`
      )
      req.body.model = schedulerModel
    }

    const upstreamRequestedModel = req.body?.model || requestedModel

    // 按 Codex CLI/CLIProxyAPI 的方式构造 ChatGPT Codex 上游请求头
    const incoming = req.headers || {}
    const userAgentOverride = isGeneralOpenAIEndpoint
      ? await getGeneralOpenAIUpstreamUserAgent()
      : null
    const headers = buildCodexUpstreamHeaders({
      incoming,
      accessToken,
      accountHeader: account.accountId || account.chatgptUserId || accountId,
      isStream: upstreamIsStream,
      body: req.body,
      userAgentOverride,
      isResponsesLite
    })
    if (!compactRoute) {
      req.body['store'] = false
    } else if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'store')) {
      delete req.body['store']
    }

    // 创建代理 agent
    const proxyAgent = createProxyAgent(proxy)

    // 配置请求选项
    const axiosConfig = {
      headers,
      timeout: config.requestTimeout || 600000,
      validateStatus: () => true
    }

    // 如果有代理，添加代理配置
    if (proxyAgent) {
      axiosConfig.httpAgent = proxyAgent
      axiosConfig.httpsAgent = proxyAgent
      axiosConfig.proxy = false
      logger.info(`🌐 Using proxy for OpenAI request: ${ProxyHelper.getProxyDescription(proxy)}`)
      if (isInterleaveNicEnabled(account)) {
        logger.warn(
          `⚠️ OpenAI account ${accountId} has both proxy and NIC interleave enabled; proxy takes precedence`
        )
      }
    } else {
      logger.debug('🌐 No proxy configured for OpenAI request')
    }

    const codexEndpoint = compactRoute
      ? 'https://chatgpt.com/backend-api/codex/responses/compact'
      : 'https://chatgpt.com/backend-api/codex/responses'

    let selectedLocalAddress = null
    const chooseAndApplyLocalAddress = async (reason) => {
      const localAddress = await openaiNicSelector.chooseLocalAddress({
        accountId,
        sessionHash,
        ttlHours: account.interleaveNicTtlHours,
        disabledAddresses: account.interleaveNicDisabledAddresses
      })

      if (localAddress) {
        axiosConfig.httpsAgent = getHttpsAgentForLocalAddress(localAddress, {
          stream: upstreamIsStream
        })
        axiosConfig.proxy = false
        req.upstreamNicIp = localAddress
        logger.info(
          `🌐 OpenAI NIC interleave ${reason} ${localAddress} for account ${accountId}, session ${sessionHash ? sessionHash.slice(0, 12) : 'none'}`
        )
      }

      return localAddress
    }

    if (!proxyAgent && isInterleaveNicEnabled(account)) {
      selectedLocalAddress = await chooseAndApplyLocalAddress('selected')
    }

    const sendUpstreamRequest = () => {
      if (upstreamIsStream) {
        return axios.post(codexEndpoint, req.body, {
          ...axiosConfig,
          responseType: 'stream'
        })
      }

      return axios.post(codexEndpoint, req.body, axiosConfig)
    }

    const sendUpstreamRequestWithFallback = async () => {
      try {
        return await sendUpstreamRequest()
      } catch (requestError) {
        if (selectedLocalAddress && isLocalAddressNetworkError(requestError)) {
          logger.warn(
            `⚠️ OpenAI NIC ${selectedLocalAddress} unavailable for account ${accountId}, retrying with default route: ${requestError.code || requestError.cause?.code || requestError.message}`
          )
          await openaiNicSelector.clearBinding({ accountId, sessionHash })
          selectedLocalAddress = null
          delete req.upstreamNicIp
          delete axiosConfig.httpsAgent
          delete axiosConfig.proxy
          return await sendUpstreamRequest()
        }

        throw requestError
      }
    }

    upstream = await sendUpstreamRequestWithFallback()

    let rateLimitErrorData = null
    let rateLimitResetsInSeconds = null
    let nicRateLimitRetryCount = 0
    const maxNicRateLimitRetries =
      !proxyAgent && isInterleaveNicEnabled(account)
        ? Math.max(
            0,
            openaiNicSelector.getEnabledLocalAddresses(account.interleaveNicDisabledAddresses)
              .length - 1
          )
        : 0

    while (upstream.status === 429) {
      logger.warn(`🚫 Rate limit detected for OpenAI account ${accountId} (Codex API)`)

      const rateLimitInfo = await parseOpenAIRateLimitResponse(upstream, upstreamIsStream)
      rateLimitErrorData = rateLimitInfo.errorData
      rateLimitResetsInSeconds = rateLimitInfo.resetsInSeconds

      const nicCooldownDecision = await handleOpenAINicCooldownOnRateLimit({
        account,
        accountId,
        req,
        sessionHash,
        selectedLocalAddress,
        source:
          nicRateLimitRetryCount === 0 ? 'HTTP 429' : `HTTP 429 retry ${nicRateLimitRetryCount}`,
        resetsInSeconds: rateLimitResetsInSeconds,
        errorData: rateLimitErrorData
      })

      if (!nicCooldownDecision.retryable || nicRateLimitRetryCount >= maxNicRateLimitRetries) {
        if (!nicCooldownDecision.handled) {
          if (!nicCooldownDecision.historyRecorded) {
            await recordOpenAIRateLimitHistory(
              accountId,
              req,
              'HTTP 429',
              rateLimitResetsInSeconds,
              rateLimitErrorData
            ).catch(() => {})
          }
          await unifiedOpenAIScheduler.markAccountRateLimited(
            accountId,
            'openai',
            sessionHash,
            rateLimitResetsInSeconds
          )
        }

        const errorResponse = buildOpenAIRateLimitErrorResponse(
          rateLimitErrorData,
          rateLimitResetsInSeconds
        )
        sendOpenAIRateLimitResponse(res, downstreamIsStream, errorResponse)
        return
      }

      const previousLocalAddress = selectedLocalAddress
      selectedLocalAddress = await chooseAndApplyLocalAddress(`retrying with`)
      if (!selectedLocalAddress || selectedLocalAddress === previousLocalAddress) {
        logger.warn(
          `🚫 OpenAI NIC retry skipped for account ${accountId}: no alternate NIC selected after ${previousLocalAddress || 'unknown'} was rate limited`
        )
        const errorResponse = buildOpenAIRateLimitErrorResponse(
          rateLimitErrorData,
          rateLimitResetsInSeconds
        )
        sendOpenAIRateLimitResponse(res, downstreamIsStream, errorResponse)
        return
      }

      nicRateLimitRetryCount += 1
      logger.info(
        `🔁 Retrying OpenAI request for account ${accountId} with NIC ${selectedLocalAddress} after ${previousLocalAddress} returned 429`
      )
      upstream = await sendUpstreamRequestWithFallback()
    }

    const codexUsageSnapshot = extractCodexUsageHeaders(upstream.headers)
    if (codexUsageSnapshot) {
      try {
        await openaiAccountService.updateCodexUsageSnapshot(accountId, codexUsageSnapshot)
      } catch (codexError) {
        logger.error('⚠️ 更新 Codex 使用统计失败:', codexError)
      }
    }

    if (upstream.status === 401 || upstream.status === 402) {
      const unauthorizedStatus = upstream.status
      const statusDescription = unauthorizedStatus === 401 ? 'Unauthorized' : 'Payment required'
      logger.warn(
        `🔐 ${statusDescription} error detected for OpenAI account ${accountId} (Codex API)`
      )

      let errorData = null

      try {
        if (upstreamIsStream && upstream.data && typeof upstream.data.on === 'function') {
          const chunks = []
          await new Promise((resolve, reject) => {
            upstream.data.on('data', (chunk) => chunks.push(chunk))
            upstream.data.on('end', resolve)
            upstream.data.on('error', reject)
            setTimeout(resolve, 5000)
          })

          const fullResponse = Buffer.concat(chunks).toString()
          try {
            errorData = JSON.parse(fullResponse)
          } catch (parseError) {
            logger.error(`Failed to parse ${unauthorizedStatus} error response:`, parseError)
            logger.debug(`Raw ${unauthorizedStatus} response:`, fullResponse)
            errorData = { error: { message: fullResponse || 'Unauthorized' } }
          }
        } else {
          errorData = upstream.data
        }
      } catch (parseError) {
        logger.error(`⚠️ Failed to handle ${unauthorizedStatus} error response:`, parseError)
      }

      const statusLabel = unauthorizedStatus === 401 ? '401错误' : '402错误'
      const extraHint = unauthorizedStatus === 402 ? '，可能欠费' : ''
      let reason = `OpenAI账号认证失败（${statusLabel}${extraHint}）`
      if (errorData) {
        const messageCandidate =
          errorData.error &&
          typeof errorData.error.message === 'string' &&
          errorData.error.message.trim()
            ? errorData.error.message.trim()
            : typeof errorData.message === 'string' && errorData.message.trim()
              ? errorData.message.trim()
              : null
        if (messageCandidate) {
          reason = `OpenAI账号认证失败（${statusLabel}${extraHint}）：${messageCandidate}`
        }
      }

      try {
        await unifiedOpenAIScheduler.markAccountUnauthorized(
          accountId,
          'openai',
          sessionHash,
          reason
        )
      } catch (markError) {
        logger.error(
          `❌ Failed to mark OpenAI account unauthorized after ${unauthorizedStatus}:`,
          markError
        )
      }

      let errorResponse = errorData
      if (!errorResponse || typeof errorResponse !== 'object' || Buffer.isBuffer(errorResponse)) {
        const fallbackMessage =
          typeof errorData === 'string' && errorData.trim() ? errorData.trim() : 'Unauthorized'
        errorResponse = {
          error: {
            message: fallbackMessage,
            type: 'unauthorized',
            code: 'unauthorized'
          }
        }
      }

      res.status(unauthorizedStatus).json(errorResponse)
      return
    } else if (upstream.status === 200 || upstream.status === 201) {
      // 请求成功，检查并移除限流状态
      const isRateLimited = await unifiedOpenAIScheduler.isAccountRateLimited(accountId)
      if (isRateLimited) {
        logger.info(
          `✅ Removing rate limit for OpenAI account ${accountId} after successful request`
        )
        await unifiedOpenAIScheduler.removeAccountRateLimit(accountId, 'openai')
      }
    }

    res.status(upstream.status)

    if (isStream) {
      // 流式响应头
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('X-Accel-Buffering', 'no')
    } else {
      // 非流式响应头
      res.setHeader('Content-Type', 'application/json')
    }

    // 透传关键诊断头，避免传递不安全或与传输相关的头
    const passThroughHeaderKeys = ['openai-version', 'x-request-id', 'openai-processing-ms']
    for (const key of passThroughHeaderKeys) {
      const val = upstream.headers?.[key]
      if (val !== undefined) {
        res.setHeader(key, val)
      }
    }

    if (isStream) {
      // 立即刷新响应头，开始 SSE
      if (typeof res.flushHeaders === 'function') {
        res.flushHeaders()
      }
    }

    // 处理响应并捕获 usage 数据和真实的 model
    let usageData = null
    let actualModel = null
    let usageReported = false
    let rateLimitDetected = false
    let streamRateLimitResetsInSeconds = null

    if (!isStream && !upstreamIsStream) {
      // 非流式响应处理
      try {
        logger.info(`📄 Processing OpenAI non-stream response for model: ${upstreamRequestedModel}`)

        // 直接获取完整响应
        const responseData = upstream.data

        // 从响应中获取实际的 model 和 usage
        actualModel = responseData.model || upstreamRequestedModel || 'gpt-4'
        usageData = responseData.usage

        logger.debug(`📊 Non-stream response - Model: ${actualModel}, Usage:`, usageData)

        // 记录使用统计
        if (usageData) {
          const normalizedUsage = normalizeOpenAIUsage(usageData)

          const nonStreamCosts = await apiKeyService.recordUsage(
            apiKeyData.id,
            normalizedUsage.inputTokens,
            normalizedUsage.outputTokens,
            normalizedUsage.cacheCreateTokens,
            normalizedUsage.cacheReadTokens,
            actualModel,
            accountId,
            'openai',
            req._serviceTier,
            createRequestDetailMeta(req, {
              requestBody: req.body,
              stream: false,
              statusCode: upstream.status
            })
          )

          logger.info(
            `📊 Recorded OpenAI non-stream usage - ${formatOpenAIUsageForLog(normalizedUsage)}, Model: ${actualModel}`
          )

          await applyRateLimitTracking(
            req,
            {
              inputTokens: normalizedUsage.inputTokens,
              outputTokens: normalizedUsage.outputTokens,
              cacheCreateTokens: normalizedUsage.cacheCreateTokens,
              cacheReadTokens: normalizedUsage.cacheReadTokens
            },
            actualModel,
            'openai-non-stream',
            'openai',
            nonStreamCosts
          )
        }

        // 返回响应
        res.json(responseData)
        return
      } catch (error) {
        logger.error('Failed to process non-stream response:', error)
        if (!res.headersSent) {
          res.status(500).json({ error: { message: 'Failed to process response' } })
        }
        return
      }
    }

    // 使用增量 SSE 解析器
    const sseParser = new IncrementalSSEParser()

    // 处理解析出的事件
    const processSSEEvent = (eventData) => {
      // 检查是否是 response.completed 事件
      if (eventData.type === 'response.completed' && eventData.response) {
        // 从响应中获取真实的 model
        if (eventData.response.model) {
          actualModel = eventData.response.model
          logger.debug(`📊 Captured actual model: ${actualModel}`)
        }

        // 获取 usage 数据
        if (eventData.response.usage) {
          usageData = eventData.response.usage
          logger.debug('📊 Captured OpenAI usage data:', usageData)
        }
      }

      // 检查是否有限流错误
      if (eventData.error && eventData.error.type === 'usage_limit_reached') {
        rateLimitDetected = true
        if (eventData.error.resets_in_seconds) {
          streamRateLimitResetsInSeconds = eventData.error.resets_in_seconds
          logger.warn(
            `🚫 Rate limit detected in stream, resets in ${streamRateLimitResetsInSeconds} seconds`
          )
        }
      }
    }

    if (!isStream && upstreamIsStream) {
      try {
        logger.info(
          `📄 Aggregating OpenAI Codex stream response for non-stream downstream request: ${upstreamRequestedModel}`
        )

        let completedEvent = null
        let terminalEvent = null
        const outputAggregator = createCodexNonStreamOutputAggregator()

        await new Promise((resolve, reject) => {
          upstream.data.on('data', (chunk) => {
            try {
              const events = sseParser.feed(chunk.toString())
              for (const event of events) {
                if (event.type !== 'data' || !event.data) {
                  continue
                }
                outputAggregator.process(event.data)
                processSSEEvent(event.data)
                if (event.data.type === 'response.completed' && event.data.response) {
                  completedEvent = event.data
                } else if (
                  event.data.type === 'response.failed' ||
                  event.data.type === 'error' ||
                  event.data.error
                ) {
                  terminalEvent = event.data
                }
              }
            } catch (error) {
              reject(error)
            }
          })

          upstream.data.on('end', () => {
            try {
              const remaining = sseParser.getRemaining()
              if (remaining.trim()) {
                const events = sseParser.feed('\n\n')
                for (const event of events) {
                  if (event.type !== 'data' || !event.data) {
                    continue
                  }
                  outputAggregator.process(event.data)
                  processSSEEvent(event.data)
                  if (event.data.type === 'response.completed' && event.data.response) {
                    completedEvent = event.data
                  } else if (
                    event.data.type === 'response.failed' ||
                    event.data.type === 'error' ||
                    event.data.error
                  ) {
                    terminalEvent = event.data
                  }
                }
              }
              resolve()
            } catch (error) {
              reject(error)
            }
          })

          upstream.data.on('error', reject)
        })

        if (!completedEvent) {
          const errorPayload = terminalEvent || {
            error: {
              message: 'Upstream stream closed before response.completed',
              type: 'upstream_error',
              code: 'stream_incomplete'
            }
          }
          return res.status(502).json(errorPayload)
        }

        completedEvent = outputAggregator.patchCompleted(completedEvent)

        if (!usageReported && usageData) {
          try {
            const normalizedUsage = normalizeOpenAIUsage(usageData)
            const modelToRecord = actualModel || upstreamRequestedModel || 'gpt-4'

            const aggregateCosts = await apiKeyService.recordUsage(
              apiKeyData.id,
              normalizedUsage.inputTokens,
              normalizedUsage.outputTokens,
              normalizedUsage.cacheCreateTokens,
              normalizedUsage.cacheReadTokens,
              modelToRecord,
              accountId,
              'openai',
              req._serviceTier,
              createRequestDetailMeta(req, {
                requestBody: req.body,
                stream: false,
                statusCode: res.statusCode
              })
            )

            logger.info(
              `📊 Recorded OpenAI aggregated usage - ${formatOpenAIUsageForLog(normalizedUsage)}, Model: ${modelToRecord} (actual: ${actualModel}, requested: ${upstreamRequestedModel})`
            )
            usageReported = true

            await applyRateLimitTracking(
              req,
              {
                inputTokens: normalizedUsage.inputTokens,
                outputTokens: normalizedUsage.outputTokens,
                cacheCreateTokens: normalizedUsage.cacheCreateTokens,
                cacheReadTokens: normalizedUsage.cacheReadTokens
              },
              modelToRecord,
              'openai-non-stream-aggregated',
              'openai',
              aggregateCosts
            )
          } catch (error) {
            logger.error('Failed to record OpenAI aggregated usage:', error)
          }
        }

        if (upstream.status === 200) {
          const isRateLimited = await unifiedOpenAIScheduler.isAccountRateLimited(accountId)
          if (isRateLimited) {
            logger.info(
              `✅ Removing rate limit for OpenAI account ${accountId} after successful aggregated response`
            )
            await unifiedOpenAIScheduler.removeAccountRateLimit(accountId, 'openai')
          }
        }

        const responsePayload = req._generalOpenAIChatCompletions
          ? completedEvent
          : completedEvent.response || completedEvent
        return res.json(responsePayload)
      } catch (error) {
        logger.error('Failed to aggregate OpenAI stream response:', error)
        if (!res.headersSent) {
          return res.status(502).json({ error: { message: 'Failed to process upstream stream' } })
        }
        return undefined
      }
    }

    upstream.data.on('data', (chunk) => {
      try {
        // 转发数据给客户端
        if (!res.destroyed) {
          res.write(chunk)
        }

        // 使用增量解析器处理数据
        const events = sseParser.feed(chunk.toString())
        for (const event of events) {
          if (event.type === 'data' && event.data) {
            processSSEEvent(event.data)
          }
        }
      } catch (error) {
        logger.error('Error processing OpenAI stream chunk:', error)
      }
    })

    upstream.data.on('end', async () => {
      // 处理剩余的 buffer
      const remaining = sseParser.getRemaining()
      if (remaining.trim()) {
        const events = sseParser.feed('\n\n') // 强制刷新剩余内容
        for (const event of events) {
          if (event.type === 'data' && event.data) {
            processSSEEvent(event.data)
          }
        }
      }

      // 记录使用统计
      if (!usageReported && usageData) {
        try {
          const normalizedUsage = normalizeOpenAIUsage(usageData)

          // 使用响应中的真实 model，如果没有则使用请求中的 model，最后回退到默认值
          const modelToRecord = actualModel || upstreamRequestedModel || 'gpt-4'

          const streamCosts = await apiKeyService.recordUsage(
            apiKeyData.id,
            normalizedUsage.inputTokens,
            normalizedUsage.outputTokens,
            normalizedUsage.cacheCreateTokens,
            normalizedUsage.cacheReadTokens,
            modelToRecord,
            accountId,
            'openai',
            req._serviceTier,
            createRequestDetailMeta(req, {
              requestBody: req.body,
              stream: true,
              statusCode: res.statusCode
            })
          )

          logger.info(
            `📊 Recorded OpenAI usage - ${formatOpenAIUsageForLog(normalizedUsage)}, Model: ${modelToRecord} (actual: ${actualModel}, requested: ${upstreamRequestedModel})`
          )
          usageReported = true

          await applyRateLimitTracking(
            req,
            {
              inputTokens: normalizedUsage.inputTokens,
              outputTokens: normalizedUsage.outputTokens,
              cacheCreateTokens: normalizedUsage.cacheCreateTokens,
              cacheReadTokens: normalizedUsage.cacheReadTokens
            },
            modelToRecord,
            'openai-stream',
            'openai',
            streamCosts
          )
        } catch (error) {
          logger.error('Failed to record OpenAI usage:', error)
        }
      }

      // 如果在流式响应中检测到限流
      if (rateLimitDetected) {
        logger.warn(`🚫 Processing rate limit for OpenAI account ${accountId} from stream`)
        const nicCooldownDecision = await handleOpenAINicCooldownOnRateLimit({
          account,
          accountId,
          req,
          sessionHash,
          selectedLocalAddress,
          source: 'stream',
          resetsInSeconds: streamRateLimitResetsInSeconds,
          errorData: null
        })

        if (!nicCooldownDecision.handled) {
          if (!nicCooldownDecision.historyRecorded) {
            await recordOpenAIRateLimitHistory(
              accountId,
              req,
              'stream',
              streamRateLimitResetsInSeconds,
              null
            ).catch(() => {})
          }
          await unifiedOpenAIScheduler.markAccountRateLimited(
            accountId,
            'openai',
            sessionHash,
            streamRateLimitResetsInSeconds
          )
        }
      } else if (upstream.status === 200) {
        // 流式请求成功，检查并移除限流状态
        const isRateLimited = await unifiedOpenAIScheduler.isAccountRateLimited(accountId)
        if (isRateLimited) {
          logger.info(
            `✅ Removing rate limit for OpenAI account ${accountId} after successful stream`
          )
          await unifiedOpenAIScheduler.removeAccountRateLimit(accountId, 'openai')
        }
      }

      res.end()
    })

    upstream.data.on('error', (err) => {
      logger.error('Upstream stream error:', err)
      if (!res.headersSent) {
        res.status(502).json({ error: { message: 'Upstream stream error' } })
      } else {
        res.end()
      }
    })

    // 客户端断开时清理上游流
    const cleanup = () => {
      try {
        upstream.data?.unpipe?.(res)
        upstream.data?.destroy?.()
      } catch (_) {
        //
      }
    }
    req.on('close', cleanup)
    req.on('aborted', cleanup)
  } catch (error) {
    logger.error('Proxy to ChatGPT codex/responses failed', {
      ...summarizeErrorForLog(error),
      accountId,
      accountType,
      model: req.body?.model,
      upstreamNicIp: req.upstreamNicIp || null
    })
    // 优先使用主动设置的 statusCode，然后是上游响应的状态码，最后默认 500
    const status =
      req._responsesLite === true && error.code === 'account_type_not_allowed'
        ? 503
        : error.statusCode || error.response?.status || 500

    if ((status === 401 || status === 402) && accountId) {
      const statusLabel = status === 401 ? '401错误' : '402错误'
      const extraHint = status === 402 ? '，可能欠费' : ''
      let reason = `OpenAI账号认证失败（${statusLabel}${extraHint}）`
      const errorData = error.response?.data
      if (errorData) {
        if (typeof errorData === 'string' && errorData.trim()) {
          reason = `OpenAI账号认证失败（${statusLabel}${extraHint}）：${errorData.trim()}`
        } else if (
          errorData.error &&
          typeof errorData.error.message === 'string' &&
          errorData.error.message.trim()
        ) {
          reason = `OpenAI账号认证失败（${statusLabel}${extraHint}）：${errorData.error.message.trim()}`
        } else if (typeof errorData.message === 'string' && errorData.message.trim()) {
          reason = `OpenAI账号认证失败（${statusLabel}${extraHint}）：${errorData.message.trim()}`
        }
      } else if (error.message) {
        reason = `OpenAI账号认证失败（${statusLabel}${extraHint}）：${error.message}`
      }

      try {
        await unifiedOpenAIScheduler.markAccountUnauthorized(
          accountId,
          accountType || 'openai',
          sessionHash,
          reason
        )
      } catch (markError) {
        logger.error('❌ Failed to mark OpenAI account unauthorized in catch handler:', markError)
      }
    }

    let responsePayload = error.response?.data
    if (req._responsesLite === true && error.code === 'account_type_not_allowed') {
      responsePayload = {
        error: {
          message: 'Codex Responses Lite requires a native OpenAI OAuth account',
          type: 'server_error',
          code: 'native_openai_oauth_required'
        }
      }
    } else if (!responsePayload) {
      responsePayload = { error: { message: getSafeMessage(error) } }
    } else if (typeof responsePayload === 'string') {
      responsePayload = { error: { message: getSafeMessage(responsePayload) } }
    } else if (typeof responsePayload === 'object' && !responsePayload.error) {
      responsePayload = {
        error: { message: getSafeMessage(responsePayload.message || error) }
      }
    } else if (responsePayload.error?.message) {
      responsePayload.error.message = getSafeMessage(responsePayload.error.message)
    }

    if (!res.headersSent) {
      res.status(status).json(responsePayload)
    }
  }
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

async function handleCodexModels(req, res) {
  if (!checkOpenAIPermissions(req.apiKey)) {
    return sendOpenAIError(res, 403, 'This API key does not have permission to access OpenAI')
  }
  try {
    const result = await openaiCodexModelsService.getManifest(req)
    if (result.etag) {
      res.setHeader('ETag', result.etag)
    }
    res.setHeader('Cache-Control', 'private, max-age=30, stale-if-error=300')
    res.setHeader('X-Codex-Models-Cache', result.cacheState)
    if (result.status === 304) {
      return res.status(304).end()
    }
    return res.status(200).json(result.body)
  } catch (error) {
    const status = error.code === 'account_type_not_allowed' ? 503 : Number(error.statusCode) || 502
    return sendOpenAIError(
      res,
      status,
      error.code === 'account_type_not_allowed'
        ? 'Codex private endpoints require a native OpenAI OAuth account'
        : getSafeMessage(error),
      status >= 500 ? 'server_error' : 'invalid_request_error',
      error.code || 'models_manifest_failed'
    )
  }
}

async function handleAlphaSearch(req, res) {
  if (!checkOpenAIPermissions(req.apiKey)) {
    return sendOpenAIError(res, 403, 'This API key does not have permission to access OpenAI')
  }
  return openaiAlphaSearchService.handle(req, res)
}

async function handleCodexImageRequest(req, res, endpoint) {
  let cleanup = async () => {}
  try {
    if (!checkOpenAIPermissions(req.apiKey)) {
      return sendOpenAIError(res, 403, 'This API key does not have permission to access OpenAI')
    }
    if (req.apiKey.enableOpenAICodexLiteImages !== true) {
      return sendOpenAIError(
        res,
        403,
        'This API key is not allowed to access Codex image endpoints',
        'permission_denied',
        'codex_images_not_allowed'
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
      logger.warn(`Codex image pricing preflight failed: ${error.message}`)
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
    req._openAISchedulerOptions = { allowedAccountTypes: ['openai'] }
    return await handleImages(req, res)
  } catch (error) {
    if (!res.headersSent) {
      const status = Number(error.statusCode) || 500
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

function getUpstreamContentType(upstream) {
  return String(upstream?.headers?.['content-type'] || '').toLowerCase()
}

function readBoundedImageStream(stream, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let totalBytes = 0
    let settled = false

    const cleanup = () => {
      stream.removeListener('data', onData)
      stream.removeListener('end', onEnd)
      stream.removeListener('error', onError)
    }
    const settle = (callback, value) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      callback(value)
    }
    const onData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      totalBytes += buffer.length
      if (totalBytes > maxBytes) {
        const error = new Error('Upstream image response exceeded the size limit')
        error.statusCode = 502
        error.code = 'response_too_large'
        stream.destroy()
        settle(reject, error)
        return
      }
      chunks.push(buffer)
    }
    const onEnd = () => settle(resolve, Buffer.concat(chunks))
    const onError = (error) => settle(reject, error)

    stream.on('data', onData)
    stream.once('end', onEnd)
    stream.once('error', onError)
  })
}

function parseImageResponseBuffer(buffer, contentType = '') {
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '')
  if (contentType.includes('json') || /^\s*[[{]/.test(text)) {
    try {
      return JSON.parse(text)
    } catch (_) {
      return text
    }
  }
  return text
}

async function readImageUpstreamPayload(upstream, maxBytes = MAX_IMAGE_ERROR_RESPONSE_BYTES) {
  if (upstream?.data && typeof upstream.data.on === 'function') {
    const buffer = await readBoundedImageStream(upstream.data, maxBytes)
    return parseImageResponseBuffer(buffer, getUpstreamContentType(upstream))
  }
  return upstream?.data
}

function passImageDiagnosticHeaders(res, headers = {}) {
  if (res.headersSent) {
    return
  }
  for (const key of ['openai-version', 'x-request-id', 'openai-processing-ms']) {
    if (headers[key] !== undefined) {
      res.setHeader(key, headers[key])
    }
  }
}

async function recordOpenAIImageUsage({ req, usageData, accountId, endpoint, stream, statusCode }) {
  if (!usageData || typeof usageData !== 'object') {
    return null
  }

  const normalizedUsage = normalizeOpenAIImageUsage(usageData, { endpoint })
  const imageUsage = normalizedUsage.image_usage
  const costs = await apiKeyService.recordUsage(
    req.apiKey.id,
    normalizedUsage.inputTokens,
    normalizedUsage.outputTokens,
    normalizedUsage.cacheCreateTokens,
    normalizedUsage.cacheReadTokens,
    IMAGE_MODEL,
    accountId,
    'openai',
    null,
    createRequestDetailMeta(req, {
      requestBody: req._openAIImageRequestSnapshot,
      stream,
      statusCode
    }),
    imageUsage
  )

  logger.info(
    `Recorded OpenAI image usage for ${endpoint}: ${formatOpenAIUsageForLog(normalizedUsage)}, ` +
      `textInput=${imageUsage.textInputTokens}, imageInput=${imageUsage.imageInputTokens}, ` +
      `imageOutput=${imageUsage.imageOutputTokens}, estimated=${imageUsage.estimated}`
  )

  await applyRateLimitTracking(
    req,
    {
      inputTokens: normalizedUsage.inputTokens,
      outputTokens: normalizedUsage.outputTokens,
      cacheCreateTokens: normalizedUsage.cacheCreateTokens,
      cacheReadTokens: normalizedUsage.cacheReadTokens
    },
    IMAGE_MODEL,
    'openai-image',
    'openai',
    costs
  )
  return costs
}

function forwardOpenAIImageStream({
  upstream,
  req,
  res,
  accountId,
  endpoint,
  streamKeepAlive = null
}) {
  return new Promise((resolve) => {
    const observer = new OpenAIImageSSEObserver()
    let usageData = null
    let usageReported = false
    let settled = false
    let drainListener = null

    const cleanup = () => {
      upstream.data.removeListener('data', onData)
      upstream.data.removeListener('end', onEnd)
      upstream.data.removeListener('error', onError)
      upstream.data.removeListener('close', onClose)
      if (drainListener) {
        res.removeListener('drain', drainListener)
        drainListener = null
      }
    }

    const recordUsageOnce = async () => {
      if (usageReported || !usageData) {
        return
      }
      usageReported = true
      try {
        await recordOpenAIImageUsage({
          req,
          usageData,
          accountId,
          endpoint,
          stream: true,
          statusCode: upstream.status
        })
      } catch (error) {
        logger.error(`Failed to record OpenAI image stream usage: ${getSafeMessage(error)}`)
      }
    }

    const settle = async ({
      recordUsage = false,
      endResponse = true,
      phase = 'upstream_end'
    } = {}) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      if (recordUsage) {
        await recordUsageOnce()
      }
      if (endResponse && !res.writableEnded && !res.destroyed) {
        if (streamKeepAlive && !streamKeepAlive.isAtEventBoundary()) {
          streamKeepAlive.endAfterPartialEvent({
            requestId: req.requestId,
            endpoint,
            phase
          })
        } else {
          streamKeepAlive?.stop()
          res.end()
        }
      } else {
        streamKeepAlive?.stop()
      }
      resolve()
    }

    const observeEvents = (events) => {
      for (const event of events) {
        if (event?.usage) {
          usageData = event.usage
        }
      }
    }

    const onData = (chunk) => {
      try {
        observeEvents(observer.feed(chunk))
        if (res.destroyed || res.writableEnded) {
          upstream.data.destroy()
          void settle({ recordUsage: Boolean(usageData), endResponse: false })
          return
        }

        const canContinue = res.write(chunk)
        streamKeepAlive?.noteBytesWritten(chunk)
        if (!canContinue) {
          upstream.data.pause()
          if (!drainListener) {
            drainListener = () => {
              drainListener = null
              if (!settled && !res.destroyed) {
                upstream.data.resume()
              }
            }
            res.once('drain', drainListener)
          }
        }
      } catch (error) {
        logger.error(
          `OpenAI image stream processing failed (${error.code || 'stream_error'}): ${error.message}`
        )
        upstream.data.destroy()
        void settle({
          recordUsage: Boolean(usageData),
          phase: 'stream_processing_error'
        })
      }
    }

    const onEnd = () => {
      try {
        observeEvents(observer.finish())
      } catch (error) {
        logger.error(
          `OpenAI image stream finalization failed (${error.code || 'stream_error'}): ${error.message}`
        )
      }
      void settle({ recordUsage: true, phase: 'upstream_end' })
    }
    const onError = (error) => {
      logger.error(`OpenAI image upstream stream error: ${getSafeMessage(error)}`)
      void settle({ recordUsage: Boolean(usageData), phase: 'upstream_error' })
    }
    const onClose = () => {
      void settle({ recordUsage: Boolean(usageData), phase: 'upstream_close' })
    }

    upstream.data.on('data', onData)
    upstream.data.once('end', onEnd)
    upstream.data.once('error', onError)
    upstream.data.once('close', onClose)
  })
}

async function recordOpenAIImageUpstreamError({ upstream, accountId, account, req, body }) {
  const safeBody = sanitizeImageData(body)
  const context = upstreamErrorHelper.logUpstreamErrorResponse({
    provider: 'openai',
    accountId,
    accountType: 'openai',
    accountName: account?.name || null,
    statusCode: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
    body: safeBody,
    phase: 'codex_images',
    model: IMAGE_MODEL,
    requestId: req.requestId,
    extra: {
      endpoint: req._openAIImageEndpoint,
      upstreamNicIp: req.upstreamNicIp || null
    }
  })
  await upstreamErrorHelper.recordErrorHistory(
    accountId,
    'openai',
    upstream.status,
    upstreamErrorHelper.classifyError(upstream.status) || 'upstream_error',
    context
  )
}

async function sendImageUpstreamPayload(res, upstream, payload) {
  const contentType = getUpstreamContentType(upstream)
  if (contentType) {
    res.setHeader('Content-Type', contentType)
  } else if (payload && typeof payload === 'object') {
    res.setHeader('Content-Type', 'application/json')
  } else {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  }

  if (payload && typeof payload === 'object' && !Buffer.isBuffer(payload)) {
    return res.json(payload)
  }
  return res.send(payload === undefined || payload === null ? '' : payload)
}

function buildOpenAIImageStreamErrorPayload(body, statusCode, fallbackCode = 'upstream_error') {
  const safeBody = sanitizeImageData(body)
  const sourceError =
    safeBody?.error && typeof safeBody.error === 'object' ? safeBody.error : safeBody || {}
  const rawMessage =
    sourceError.message ||
    safeBody?.message ||
    (typeof safeBody === 'string' ? safeBody : 'The upstream image request failed')
  const defaultType =
    statusCode === 429
      ? 'rate_limit_error'
      : statusCode >= 500
        ? 'server_error'
        : 'invalid_request_error'

  return {
    error: {
      message: getSafeMessage(
        { message: rawMessage, statusCode },
        { context: 'openai_image_stream', logOriginal: false }
      ),
      type:
        typeof sourceError.type === 'string' && sourceError.type.trim()
          ? sourceError.type
          : defaultType,
      code:
        typeof sourceError.code === 'string' && sourceError.code.trim()
          ? sourceError.code
          : fallbackCode
    }
  }
}

function endEstablishedOpenAIImageStreamWithError({
  streamKeepAlive,
  res,
  req,
  accountId,
  endpoint,
  statusCode,
  body,
  phase,
  fallbackCode
}) {
  if (!streamKeepAlive?.isEstablished()) {
    return false
  }

  logger.warn(
    'OpenAI image upstream error arrived after the downstream SSE response was committed',
    {
      accountId,
      endpoint,
      requestId: req.requestId,
      upstreamStatus: statusCode,
      upstreamNicIp: req.upstreamNicIp || null,
      phase
    }
  )

  if (res.destroyed || res.writableEnded) {
    streamKeepAlive.stop()
    return true
  }

  if (!streamKeepAlive.isAtEventBoundary()) {
    streamKeepAlive.endAfterPartialEvent({
      requestId: req.requestId,
      endpoint,
      phase
    })
    return true
  }

  const payload = buildOpenAIImageStreamErrorPayload(body, statusCode, fallbackCode)
  if (!streamKeepAlive.endWithErrorEvent(payload) && !res.destroyed && !res.writableEnded) {
    streamKeepAlive.stop()
    res.end()
  }
  return true
}

function buildOpenAIImageCompletedSseFrames(responseData, endpoint) {
  if (!responseData || typeof responseData !== 'object' || !Array.isArray(responseData.data)) {
    return []
  }

  const images = responseData.data
  if (
    images.length === 0 ||
    images.some(
      (image) =>
        !image ||
        typeof image !== 'object' ||
        !['b64_json', 'url', 'image_url'].some(
          (field) => typeof image[field] === 'string' && image[field].trim()
        )
    )
  ) {
    return []
  }

  const eventName = endpoint === 'edits' ? 'image_edit.completed' : 'image_generation.completed'
  return images.map((image, index) => {
    const eventData = { ...image, type: eventName }
    delete eventData.usage
    if (index === images.length - 1 && responseData.usage) {
      eventData.usage = responseData.usage
    }
    return `event: ${eventName}\ndata: ${JSON.stringify(eventData)}\n\n`
  })
}

function waitForOpenAIImageSseDrain(res) {
  return new Promise((resolve) => {
    let settled = false
    const cleanup = () => {
      res.removeListener('drain', onDrain)
      res.removeListener('close', onClose)
      res.removeListener('error', onClose)
    }
    const settle = (writable) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resolve(writable)
    }
    const onDrain = () => settle(true)
    const onClose = () => settle(false)

    res.once('drain', onDrain)
    res.once('close', onClose)
    res.once('error', onClose)
    if (res.destroyed || res.writableEnded) {
      settle(false)
    }
  })
}

async function writeOpenAIImageSseFrames(res, streamKeepAlive, frames) {
  for (const frame of frames) {
    if (res.destroyed || res.writableEnded) {
      return false
    }
    const canContinue = res.write(frame)
    streamKeepAlive.noteBytesWritten(frame)
    if (typeof res.flush === 'function') {
      res.flush()
    }
    if (!canContinue && !(await waitForOpenAIImageSseDrain(res))) {
      return false
    }
  }
  return true
}

const handleImages = async (req, res) => {
  let upstream = null
  let accountId = null
  let accountType = 'openai'
  let account = null
  let sessionHash = null
  let selectedLocalAddress = null
  let streamKeepAlive = null
  const abortController = new AbortController()

  const cancelUpstream = () => {
    if (!res.writableEnded) {
      abortController.abort()
      upstream?.data?.destroy?.()
    }
  }
  const onRequestAborted = () => cancelUpstream()
  const onResponseClosed = () => cancelUpstream()
  req.once('aborted', onRequestAborted)
  res.once('close', onResponseClosed)

  try {
    const apiKeyData = req.apiKey || {}
    if (!checkOpenAIPermissions(apiKeyData)) {
      return res.status(403).json({
        error: {
          message: 'This API key does not have permission to access OpenAI',
          type: 'permission_denied',
          code: 'permission_denied'
        }
      })
    }

    const endpoint = req._openAIImageEndpoint
    const codexEndpoint = CODEX_IMAGE_ENDPOINTS[endpoint]
    if (!codexEndpoint) {
      return res.status(404).json({
        error: {
          message: 'Unsupported image endpoint',
          type: 'invalid_request_error',
          code: 'not_found'
        }
      })
    }

    await learnGeneralOpenAIUpstreamCodexVersion(apiKeyData, req.headers?.['user-agent'] || '')
    const sessionId =
      req.headers?.['session_id'] ||
      req.headers?.['x-session-id'] ||
      req.body?.session_id ||
      req.body?.conversation_id ||
      null
    sessionHash = sessionId
      ? crypto.createHash('sha256').update(String(sessionId)).digest('hex')
      : null
    const auth = await getOpenAIAuthToken(
      apiKeyData,
      sessionId,
      IMAGE_MODEL,
      req._openAISchedulerOptions || null
    )
    ;({ accountId, accountType, account } = auth)

    if (accountType !== 'openai') {
      return res.status(403).json({
        error: {
          message: 'GPT-Image-2 requires a native OpenAI OAuth account',
          type: 'permission_denied',
          code: 'account_type_not_supported'
        }
      })
    }

    const isStream = req._downstreamStream === true
    if (isStream && (await claudeRelayConfigService.isOpenAIImageStreamKeepAliveEnabled())) {
      streamKeepAlive = createImageStreamKeepAlive({
        res,
        delayMs: IMAGE_STREAM_EARLY_SSE_DELAY_MS,
        intervalMs: IMAGE_STREAM_HEARTBEAT_INTERVAL_MS
      })
    }
    const headers = buildCodexUpstreamHeaders({
      incoming: req.headers || {},
      accessToken: auth.accessToken,
      accountHeader: account.accountId || account.chatgptUserId || accountId,
      isStream,
      body: req.body,
      userAgentOverride: await getGeneralOpenAIUpstreamUserAgent()
    })
    const proxyAgent = createProxyAgent(auth.proxy)
    const axiosConfig = {
      headers,
      timeout: config.requestTimeout || 600000,
      validateStatus: () => true,
      maxBodyLength: MAX_UPSTREAM_BODY_BYTES,
      maxContentLength: MAX_UPSTREAM_RESPONSE_BYTES,
      signal: abortController.signal
    }

    if (proxyAgent) {
      axiosConfig.httpAgent = proxyAgent
      axiosConfig.httpsAgent = proxyAgent
      axiosConfig.proxy = false
      if (isInterleaveNicEnabled(account)) {
        logger.warn(
          `OpenAI account ${accountId} has both proxy and NIC interleave enabled; proxy takes precedence`
        )
      }
    }

    const chooseAndApplyLocalAddress = async (reason) => {
      const localAddress = await openaiNicSelector.chooseLocalAddress({
        accountId,
        sessionHash,
        ttlHours: account.interleaveNicTtlHours,
        disabledAddresses: account.interleaveNicDisabledAddresses
      })
      if (localAddress) {
        axiosConfig.httpsAgent = getHttpsAgentForLocalAddress(localAddress, { stream: isStream })
        axiosConfig.proxy = false
        req.upstreamNicIp = localAddress
        logger.info(
          `OpenAI image NIC interleave ${reason} ${localAddress} for account ${accountId}`
        )
      }
      return localAddress
    }

    if (!proxyAgent && isInterleaveNicEnabled(account)) {
      selectedLocalAddress = await chooseAndApplyLocalAddress('selected')
    }

    const sendUpstreamRequest = () =>
      axios.post(codexEndpoint, req.body, {
        ...axiosConfig,
        ...(isStream ? { responseType: 'stream' } : {})
      })
    const sendUpstreamRequestWithFallback = async () => {
      try {
        return await sendUpstreamRequest()
      } catch (error) {
        if (selectedLocalAddress && isLocalAddressNetworkError(error)) {
          logger.warn(
            `OpenAI image NIC ${selectedLocalAddress} unavailable for account ${accountId}; retrying with the default route`
          )
          await openaiNicSelector.clearBinding({ accountId, sessionHash })
          selectedLocalAddress = null
          delete req.upstreamNicIp
          delete axiosConfig.httpsAgent
          delete axiosConfig.proxy
          return await sendUpstreamRequest()
        }
        throw error
      }
    }

    streamKeepAlive?.armEarlyStart()
    upstream = await sendUpstreamRequestWithFallback()
    let nicRateLimitRetryCount = 0
    const maxNicRateLimitRetries =
      !proxyAgent && isInterleaveNicEnabled(account)
        ? Math.max(
            0,
            openaiNicSelector.getEnabledLocalAddresses(account.interleaveNicDisabledAddresses)
              .length - 1
          )
        : 0

    while (upstream.status === 429) {
      const rawErrorData = await readImageUpstreamPayload(upstream)
      const errorData = sanitizeImageData(rawErrorData)
      const resetsInSeconds = Number(errorData?.error?.resets_in_seconds) || null
      const nicCooldownDecision = await handleOpenAINicCooldownOnRateLimit({
        account,
        accountId,
        req,
        sessionHash,
        selectedLocalAddress,
        source:
          nicRateLimitRetryCount === 0
            ? 'HTTP 429 image'
            : `HTTP 429 image retry ${nicRateLimitRetryCount}`,
        resetsInSeconds,
        errorData
      })

      if (!nicCooldownDecision.retryable || nicRateLimitRetryCount >= maxNicRateLimitRetries) {
        if (!nicCooldownDecision.handled) {
          if (!nicCooldownDecision.historyRecorded) {
            await recordOpenAIRateLimitHistory(
              accountId,
              req,
              'HTTP 429 image',
              resetsInSeconds,
              errorData
            ).catch(() => {})
          }
          await unifiedOpenAIScheduler.markAccountRateLimited(
            accountId,
            'openai',
            sessionHash,
            resetsInSeconds
          )
        }
        const errorResponse = buildOpenAIRateLimitErrorResponse(errorData, resetsInSeconds)
        if (
          endEstablishedOpenAIImageStreamWithError({
            streamKeepAlive,
            res,
            req,
            accountId,
            endpoint,
            statusCode: 429,
            body: errorResponse,
            phase: 'rate_limit_exhausted',
            fallbackCode: 'rate_limit_exceeded'
          })
        ) {
          return undefined
        }
        streamKeepAlive?.cancelEarlyStart()
        return res.status(429).json(errorResponse)
      }

      const previousLocalAddress = selectedLocalAddress
      selectedLocalAddress = await chooseAndApplyLocalAddress('retrying with')
      if (!selectedLocalAddress || selectedLocalAddress === previousLocalAddress) {
        const errorResponse = buildOpenAIRateLimitErrorResponse(errorData, resetsInSeconds)
        if (
          endEstablishedOpenAIImageStreamWithError({
            streamKeepAlive,
            res,
            req,
            accountId,
            endpoint,
            statusCode: 429,
            body: errorResponse,
            phase: 'rate_limit_no_alternate_nic',
            fallbackCode: 'rate_limit_exceeded'
          })
        ) {
          return undefined
        }
        streamKeepAlive?.cancelEarlyStart()
        return res.status(429).json(errorResponse)
      }
      nicRateLimitRetryCount += 1
      upstream = await sendUpstreamRequestWithFallback()
    }

    const codexUsageSnapshot = extractCodexUsageHeaders(upstream.headers)
    if (codexUsageSnapshot) {
      await openaiAccountService
        .updateCodexUsageSnapshot(accountId, codexUsageSnapshot)
        .catch((error) => logger.error(`Failed to update Codex usage snapshot: ${error.message}`))
    }

    if (upstream.status < 200 || upstream.status >= 300) {
      const errorData = await readImageUpstreamPayload(upstream)
      await recordOpenAIImageUpstreamError({
        upstream,
        accountId,
        account,
        req,
        body: errorData
      }).catch(() => {})

      if (upstream.status === 401 || upstream.status === 402) {
        const message =
          errorData?.error?.message ||
          errorData?.message ||
          (typeof errorData === 'string' ? errorData : 'OpenAI account authorization failed')
        await unifiedOpenAIScheduler
          .markAccountUnauthorized(
            accountId,
            'openai',
            sessionHash,
            `OpenAI account authorization failed (${upstream.status}): ${message}`
          )
          .catch(() => {})
      }

      if (
        endEstablishedOpenAIImageStreamWithError({
          streamKeepAlive,
          res,
          req,
          accountId,
          endpoint,
          statusCode: upstream.status,
          body: errorData,
          phase: 'upstream_non_2xx',
          fallbackCode: 'upstream_error'
        })
      ) {
        return undefined
      }

      streamKeepAlive?.cancelEarlyStart()
      res.status(upstream.status)
      passImageDiagnosticHeaders(res, upstream.headers)
      return await sendImageUpstreamPayload(res, upstream, errorData)
    }

    if (await unifiedOpenAIScheduler.isAccountRateLimited(accountId)) {
      await unifiedOpenAIScheduler.removeAccountRateLimit(accountId, 'openai')
    }

    const upstreamContentType = getUpstreamContentType(upstream)
    const upstreamIsSse = upstreamContentType.includes('text/event-stream')

    if (isStream && upstreamIsSse) {
      if (!streamKeepAlive?.isEstablished()) {
        streamKeepAlive?.cancelEarlyStart()
        res.status(upstream.status)
        passImageDiagnosticHeaders(res, upstream.headers)
        res.setHeader('Content-Type', 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')
        res.setHeader('X-Accel-Buffering', 'no')
        if (typeof res.flushHeaders === 'function') {
          res.flushHeaders()
        }
        streamKeepAlive?.onClassicSseEstablished()
      }
      await forwardOpenAIImageStream({
        upstream,
        req,
        res,
        accountId,
        endpoint,
        streamKeepAlive
      })
      return undefined
    }

    let responseData = upstream.data
    if (responseData && typeof responseData.on === 'function') {
      if (isStream && !upstreamIsSse) {
        logger.warn(
          `OpenAI image upstream returned ${upstreamContentType || 'an unknown content type'} for a stream request`
        )
      }
      const responseBuffer = await readBoundedImageStream(responseData, MAX_UPSTREAM_RESPONSE_BYTES)
      responseData = parseImageResponseBuffer(responseBuffer, upstreamContentType)
    }

    if (responseData?.usage) {
      try {
        await recordOpenAIImageUsage({
          req,
          usageData: responseData.usage,
          accountId,
          endpoint,
          stream: isStream,
          statusCode: upstream.status
        })
      } catch (error) {
        logger.error(`Failed to record OpenAI image usage: ${getSafeMessage(error)}`)
      }
    }

    if (streamKeepAlive?.isEstablished()) {
      const frames = buildOpenAIImageCompletedSseFrames(responseData, endpoint)
      if (frames.length === 0) {
        logger.warn('OpenAI image stream received an unrecognized successful upstream payload', {
          accountId,
          endpoint,
          requestId: req.requestId,
          upstreamContentType: upstreamContentType || null
        })
        endEstablishedOpenAIImageStreamWithError({
          streamKeepAlive,
          res,
          req,
          accountId,
          endpoint,
          statusCode: 502,
          body: {
            error: {
              message: 'The upstream image response could not be converted to a stream',
              type: 'server_error',
              code: 'upstream_protocol_mismatch'
            }
          },
          phase: 'upstream_protocol_mismatch',
          fallbackCode: 'upstream_protocol_mismatch'
        })
        return undefined
      }

      if (await writeOpenAIImageSseFrames(res, streamKeepAlive, frames)) {
        streamKeepAlive.stop()
        if (!res.writableEnded && !res.destroyed) {
          res.end()
        }
      } else {
        streamKeepAlive.stop()
      }
      return undefined
    }

    streamKeepAlive?.cancelEarlyStart()
    res.status(upstream.status)
    passImageDiagnosticHeaders(res, upstream.headers)
    return await sendImageUpstreamPayload(res, upstream, responseData)
  } catch (error) {
    const status = Number(error.statusCode || error.response?.status) || 500
    logger.error('Proxy to ChatGPT Codex images failed', {
      message: getSafeMessage(error),
      code: error.code || null,
      status,
      accountId,
      endpoint: req._openAIImageEndpoint,
      upstreamNicIp: req.upstreamNicIp || null
    })
    const errorResponse = {
      error: {
        message:
          status >= 500 ? 'Failed to process the upstream image request' : getSafeMessage(error),
        type: status >= 500 ? 'server_error' : 'invalid_request_error',
        code: error.code || 'upstream_error'
      }
    }
    if (
      endEstablishedOpenAIImageStreamWithError({
        streamKeepAlive,
        res,
        req,
        accountId,
        endpoint: req._openAIImageEndpoint,
        statusCode: status,
        body: errorResponse,
        phase: 'upstream_request_error',
        fallbackCode: error.code || 'upstream_error'
      })
    ) {
      return undefined
    }

    streamKeepAlive?.cancelEarlyStart()
    if (!res.headersSent && !res.destroyed) {
      return res.status(status).json(errorResponse)
    }
    if (!res.writableEnded && !res.destroyed) {
      res.end()
    }
    return undefined
  } finally {
    streamKeepAlive?.stop()
    req.removeListener('aborted', onRequestAborted)
    res.removeListener('close', onResponseClosed)
  }
}

// 注册两个路由路径，都使用相同的处理函数
router.get('/models', authenticateApiKey, handleCodexModels)
router.get('/v1/models', authenticateApiKey, handleCodexModels)
router.post('/alpha/search', authenticateApiKey, handleAlphaSearch)
router.post('/v1/alpha/search', authenticateApiKey, handleAlphaSearch)
router.post('/images/generations', authenticateApiKey, (req, res) =>
  handleCodexImageRequest(req, res, 'generations')
)
router.post('/v1/images/generations', authenticateApiKey, (req, res) =>
  handleCodexImageRequest(req, res, 'generations')
)
router.post('/images/edits', authenticateApiKey, (req, res) =>
  handleCodexImageRequest(req, res, 'edits')
)
router.post('/v1/images/edits', authenticateApiKey, (req, res) =>
  handleCodexImageRequest(req, res, 'edits')
)
router.post('/responses', authenticateApiKey, handleResponses)
router.post('/v1/responses', authenticateApiKey, handleResponses)
router.post('/responses/compact', authenticateApiKey, handleResponses)
router.post('/v1/responses/compact', authenticateApiKey, handleResponses)

// 使用情况统计端点
router.get('/usage', authenticateApiKey, async (req, res) => {
  try {
    const keyData = req.apiKey
    // 按需查询 usage 数据
    const usage = await redis.getUsageStats(keyData.id)

    res.json({
      object: 'usage',
      total_tokens: usage?.total?.tokens || 0,
      total_requests: usage?.total?.requests || 0,
      daily_tokens: usage?.daily?.tokens || 0,
      daily_requests: usage?.daily?.requests || 0,
      monthly_tokens: usage?.monthly?.tokens || 0,
      monthly_requests: usage?.monthly?.requests || 0
    })
  } catch (error) {
    logger.error('Failed to get usage stats:', error)
    res.status(500).json({
      error: {
        message: 'Failed to retrieve usage statistics',
        type: 'api_error'
      }
    })
  }
})

// API Key 信息端点
router.get('/key-info', authenticateApiKey, async (req, res) => {
  try {
    const keyData = req.apiKey
    // 按需查询 usage 数据（仅 key-info 端点需要）
    const usage = await redis.getUsageStats(keyData.id)
    const tokensUsed = usage?.total?.tokens || 0
    res.json({
      id: keyData.id,
      name: keyData.name,
      description: keyData.description,
      permissions: keyData.permissions,
      token_limit: keyData.tokenLimit,
      tokens_used: tokensUsed,
      tokens_remaining:
        keyData.tokenLimit > 0 ? Math.max(0, keyData.tokenLimit - tokensUsed) : null,
      rate_limit: {
        window: keyData.rateLimitWindow,
        requests: keyData.rateLimitRequests
      },
      usage: {
        total: usage?.total || {},
        daily: usage?.daily || {},
        monthly: usage?.monthly || {}
      }
    })
  } catch (error) {
    logger.error('Failed to get key info:', error)
    res.status(500).json({
      error: {
        message: 'Failed to retrieve API key information',
        type: 'api_error'
      }
    })
  }
})

module.exports = router
module.exports.handleResponses = handleResponses
module.exports.handleImages = handleImages
module.exports.CODEX_CLI_INSTRUCTIONS = CODEX_CLI_INSTRUCTIONS
module.exports.CODEX_MODELS_DEFAULT_CLIENT_VERSION =
  openaiCodexModelsService.CODEX_MODELS_DEFAULT_CLIENT_VERSION
module.exports._buildGeneralOpenAIUpstreamUserAgentForTest = buildGeneralOpenAIUpstreamUserAgent
module.exports._resetGeneralOpenAIUpstreamUserAgentCacheForTest = () => {
  generalOpenAIUpstreamCodexVersion = null
}
