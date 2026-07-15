const crypto = require('crypto')
const axios = require('axios')
const config = require('../../../config/config')
const logger = require('../../utils/logger')
const ProxyHelper = require('../../utils/proxyHelper')
const GrokSSEFrameParser = require('../../utils/grokSSEFrameParser')
const grokScheduler = require('../scheduler/grokScheduler')
const grokAccountService = require('../account/grokAccountService')
const grokQuotaService = require('../grokQuotaService')
const apiKeyService = require('../apiKeyService')
const requestDetailService = require('../requestDetailService')
const upstreamErrorHelper = require('../../utils/upstreamErrorHelper')
const { normalizeOpenAIUsage } = require('../../utils/openaiUsageHelper')
const { createRequestDetailMeta } = require('../../utils/requestDetailHelper')
const { getRequestIp } = require('../../utils/ipWhitelistHelper')
const { sanitizeLogValue } = require('../../utils/logSanitizer')
const {
  resolveGrokModel,
  resolveGrokBillingModel,
  isAccountSupportedGrokModel,
  hasValidGrokPricing
} = require('../../utils/grokModelHelper')
const {
  sanitizeGrokResponsesBody,
  deriveGrokSessionSeed,
  buildGrokCacheIdentity,
  applyGrokCacheIdentity,
  buildGrokUpstreamUrl,
  buildGrokUpstreamHeaders,
  hasTrustworthyGrokUsage
} = require('../../utils/grokRequestHelper')
const { getQuotaCooldownSeconds } = require('../../utils/grokQuotaHelper')

const PRELUDE_MAX_BYTES = 256 * 1024
const PRELUDE_MAX_EVENTS = 128
const MAX_ERROR_BODY_BYTES = 16 * 1024 * 1024
const MAX_JSON_BODY_BYTES = 64 * 1024 * 1024
const PRELUDE_TYPES = new Set(['response.created', 'response.in_progress'])
const TERMINAL_TYPES = new Set([
  'response.completed',
  'response.failed',
  'response.incomplete',
  'response.cancelled',
  'response.canceled',
  'error'
])

const getResponseError = (payload) => payload?.response?.error || payload?.error || null
const getResponseUsage = (payload) => payload?.response?.usage || payload?.usage || null
const getResponseModel = (payload) => payload?.response?.model || payload?.model || ''

const inferSemanticStatus = (payload, fallback = 400) => {
  const error = getResponseError(payload) || {}
  const explicit = Number(error.status_code || error.status || payload?.status_code)
  if (Number.isInteger(explicit) && explicit >= 400 && explicit <= 599) {
    return explicit
  }
  const text = [error.type, error.code, error.message, payload?.type]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  if (/(unauthori|authentication|invalid[_ -]?token|expired[_ -]?token)/.test(text)) {
    return 401
  }
  if (/(payment|billing|credit|insufficient[_ -]?fund)/.test(text)) {
    return 402
  }
  if (/(forbidden|permission|entitlement|access[_ -]?denied)/.test(text)) {
    return 403
  }
  if (/(rate[_ -]?limit|too many requests|quota[_ -]?exhaust)/.test(text)) {
    return 429
  }
  if (/(overload|server[_ -]?error|internal[_ -]?error|unavailable|upstream)/.test(text)) {
    return 503
  }
  return fallback
}

const isRetryableAccountStatus = (status) =>
  status === 401 || status === 402 || status === 403 || status === 429 || status >= 500

const collectStream = async (stream, maxBytes, onChunk = null) => {
  const chunks = []
  let length = 0
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    length += chunk.length
    if (length > maxBytes) {
      const error = new Error('Grok upstream response exceeded the relay buffer limit')
      error.code = 'GROK_RESPONSE_TOO_LARGE'
      throw error
    }
    chunks.push(chunk)
    onChunk?.(chunk)
  }
  return Buffer.concat(chunks, length)
}

class GrokRelayService {
  async handle(req, res, { requestedModel, defaultMappedModel }) {
    const state = {
      requestId: req.requestId || crypto.randomUUID(),
      startedAt: Date.now(),
      deadlineAt: Date.now() + config.requestTimeout,
      downstreamCommitted: false,
      clientDisconnected: false,
      activeAccepted: false,
      activeController: null,
      drainTimer: null,
      accountingSettled: false,
      detailSettled: false,
      firstTokenAt: null,
      lastAccount: null,
      lastMappedModel: defaultMappedModel,
      lastUpstreamStatus: null,
      lastSemanticStatus: null,
      lastTerminalType: null,
      lastError: null,
      upstreamRequestId: ''
    }
    const sessionSeed = deriveGrokSessionSeed(req.headers, req.body)
    const sessionHash = sessionSeed
      ? crypto.createHash('sha256').update(`grok-sticky:v1:${sessionSeed}`).digest('hex')
      : ''
    const excluded = new Set()

    const handleDisconnect = () => {
      if (res.writableEnded) {
        return
      }
      state.clientDisconnected = true
      if (!state.activeAccepted || config.grok.disconnectDrainIdleMs === 0) {
        state.activeController?.abort()
        return
      }
      this._resetDrainTimer(state)
    }
    req.once('aborted', handleDisconnect)
    res.once('close', handleDisconnect)

    try {
      while (!state.clientDisconnected && Date.now() < state.deadlineAt) {
        let selection
        try {
          selection = await grokScheduler.selectAccount({
            apiKeyData: req.apiKey,
            requestedModel,
            mappedModel: defaultMappedModel,
            sessionHash,
            excluded,
            requestId: state.requestId
          })
        } catch (error) {
          state.lastError = state.lastError || error
          break
        }

        state.lastAccount = selection.account
        let outcome
        try {
          outcome = await this._attemptAccount({
            req,
            res,
            state,
            selection,
            requestedModel,
            sessionSeed,
            forceRefresh: false
          })
          if (outcome.kind === 'retry_same_account') {
            this._clearAttemptTimers(state)
            outcome = await this._attemptAccount({
              req,
              res,
              state,
              selection,
              requestedModel,
              sessionSeed,
              forceRefresh: true
            })
          }
        } catch (error) {
          state.lastError = error
          const downstreamCommitted = this._isCommitted(res, state)
          const reportedStatus = Number(error.statusCode || error.response?.status)
          const deadlineElapsed = Date.now() >= state.deadlineAt
          outcome = {
            kind: state.clientDisconnected || downstreamCommitted ? 'final' : 'retry',
            statusCode:
              Number.isInteger(reportedStatus) && reportedStatus >= 400 && reportedStatus <= 599
                ? reportedStatus
                : deadlineElapsed || error.code === 'ECONNABORTED'
                  ? 504
                  : 502,
            error
          }
          if (!state.clientDisconnected) {
            await this._recordAccountError(
              selection.account,
              outcome.statusCode,
              { error: { type: 'transport_error', message: error.message } },
              null,
              'transport'
            )
            if (downstreamCommitted) {
              await this._captureNoUsage(req, state, {
                account: selection.account,
                statusCode: outcome.statusCode,
                semanticStatus: outcome.statusCode,
                terminalType: 'relay_error',
                error: { type: 'server_error', code: error.code || 'relay_error' }
              })
              this._writeSyntheticFailure(
                res,
                state,
                'The Grok relay could not complete the stream'
              )
              if (!res.writableEnded) {
                res.end()
              }
            }
          } else {
            await this._captureNoUsage(req, state, {
              account: selection.account,
              statusCode: 499,
              semanticStatus: 499,
              terminalType: 'client_disconnected',
              error: { type: 'client_disconnected', code: error.code || 'aborted' }
            })
          }
        } finally {
          this._clearAttemptTimers(state)
          await grokScheduler.releaseAccount(selection, state.requestId)
        }

        if (outcome.kind === 'done' || outcome.kind === 'final') {
          return
        }
        if (outcome.kind === 'retry') {
          excluded.add(selection.account.id)
          await grokScheduler.clearSticky(selection)
          state.lastUpstreamStatus = outcome.statusCode || state.lastUpstreamStatus
          state.lastError = outcome.error || state.lastError
          continue
        }
        return
      }

      await this._finalizeFailure(req, res, state)
    } finally {
      this._clearAttemptTimers(state)
      req.removeListener('aborted', handleDisconnect)
      res.removeListener('close', handleDisconnect)
    }
  }

  async _attemptAccount({ req, res, state, selection, requestedModel, sessionSeed, forceRefresh }) {
    const { account } = selection
    state.firstTokenAt = null
    state.lastSemanticStatus = null
    state.lastTerminalType = null
    state.upstreamRequestId = ''
    if (state.clientDisconnected) {
      const error = new Error('Grok downstream disconnected before token acquisition')
      error.code = 'ECONNABORTED'
      throw error
    }
    const mappedModel =
      selection.mappedModel || resolveGrokModel(requestedModel, account.modelMapping)
    state.lastMappedModel = mappedModel
    if (!isAccountSupportedGrokModel(mappedModel, account)) {
      return {
        kind: 'retry',
        statusCode: 404,
        error: new Error(`Grok account does not support mapped model ${mappedModel}`)
      }
    }
    if (!hasValidGrokPricing(mappedModel)) {
      return {
        kind: 'retry',
        statusCode: 503,
        error: new Error(`Pricing is unavailable for ${mappedModel}`)
      }
    }

    const token = await grokAccountService.getValidAccessToken(account.id, forceRefresh)
    if (state.clientDisconnected) {
      const error = new Error('Grok downstream disconnected before upstream acceptance')
      error.code = 'ECONNABORTED'
      throw error
    }
    if (Date.now() >= state.deadlineAt) {
      const error = new Error('Grok request deadline elapsed before upstream dispatch')
      error.statusCode = 504
      throw error
    }
    const identity = buildGrokCacheIdentity(req.apiKey.id, mappedModel, sessionSeed)
    const sanitized = sanitizeGrokResponsesBody(req.body, mappedModel)
    const upstreamBody = applyGrokCacheIdentity(sanitized, req.body, identity, account.authType)
    const controller = new AbortController()
    state.activeController = controller
    state.activeAccepted = false
    const remaining = Math.max(1, state.deadlineAt - Date.now())
    const hardTimer = setTimeout(() => controller.abort(), remaining)
    state.hardTimer = hardTimer

    const options = {
      headers: buildGrokUpstreamHeaders({
        authType: account.authType,
        token,
        cacheIdentity: identity,
        downstreamHeaders: req.headers
      }),
      responseType: 'stream',
      timeout: remaining,
      maxRedirects: 0,
      signal: controller.signal,
      validateStatus: () => true,
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    }
    const agent = ProxyHelper.createProxyAgent(account.proxy)
    if (agent) {
      options.httpAgent = agent
      options.httpsAgent = agent
      options.proxy = false
    }
    const response = await axios.post(buildGrokUpstreamUrl(account.authType), upstreamBody, options)
    state.activeAccepted = true
    state.lastUpstreamStatus = response.status
    state.upstreamRequestId =
      response.headers?.['x-request-id'] || response.headers?.['xai-request-id'] || ''
    let quota = null
    try {
      quota = await grokQuotaService.observeResponse(
        account.id,
        response.headers,
        response.status,
        'inference'
      )
    } catch (error) {
      logger.error('Failed to persist Grok quota snapshot', {
        requestId: state.requestId,
        accountId: account.id,
        statusCode: response.status,
        error: error.message
      })
    }

    if (response.status >= 400) {
      const raw = await collectStream(response.data, MAX_ERROR_BODY_BYTES, () =>
        this._onUpstreamData(state)
      )
      const body = this._parseBody(raw)
      const firstOAuth401 = response.status === 401 && account.authType === 'oauth' && !forceRefresh
      const context = await this._recordAccountError(
        account,
        response.status,
        body,
        response.headers,
        'http_error',
        quota,
        firstOAuth401
      )
      const retryable = isRetryableAccountStatus(response.status)
      if (firstOAuth401) {
        return { kind: 'retry_same_account', statusCode: 401, context }
      }
      if (retryable && !this._isCommitted(res, state) && !state.clientDisconnected) {
        return { kind: 'retry', statusCode: response.status, context }
      }
      await this._captureNoUsage(req, state, {
        account,
        statusCode: response.status,
        semanticStatus: response.status,
        terminalType: 'http_error',
        error: body?.error || body
      })
      this._sendHttpBody(res, state, response.status, body)
      return { kind: 'done' }
    }

    const contentType = String(response.headers?.['content-type'] || '').toLowerCase()
    const upstreamIsSSE = contentType.includes('text/event-stream')
    if (req.body.stream === true) {
      if (upstreamIsSSE) {
        return await this._handleStream(
          response,
          req,
          res,
          state,
          account,
          mappedModel,
          account.authType === 'oauth' && !forceRefresh
        )
      }
      return await this._handleJsonForStreamClient(
        response,
        req,
        res,
        state,
        account,
        mappedModel,
        account.authType === 'oauth' && !forceRefresh
      )
    }
    if (upstreamIsSSE) {
      return await this._handleNonStreamSSE(
        response,
        req,
        res,
        state,
        account,
        mappedModel,
        account.authType === 'oauth' && !forceRefresh
      )
    }
    return await this._handleJsonStream(
      response,
      req,
      res,
      state,
      account,
      mappedModel,
      account.authType === 'oauth' && !forceRefresh
    )
  }

  async _handleStream(response, req, res, state, account, mappedModel, allowRefreshRetry) {
    res.status(200)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    const parser = new GrokSSEFrameParser()
    const prelude = []
    let preludeBytes = 0
    let preludeEvents = 0
    let sawTerminal = false

    const flushPrelude = () => {
      for (const raw of prelude) {
        this._writeRaw(res, state, raw)
      }
      prelude.length = 0
      preludeBytes = 0
      preludeEvents = 0
    }

    for await (const value of response.data) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
      this._onUpstreamData(state)
      if (state.clientDisconnected && state.activeController?.signal.aborted) {
        break
      }
      const committedAtChunkStart = this._isCommitted(res, state)
      if (committedAtChunkStart) {
        this._writeRaw(res, state, chunk)
      }
      const frames = parser.feed(chunk)
      for (const frame of frames) {
        if (this._isCommitted(res, state)) {
          if (!committedAtChunkStart) {
            this._writeRaw(res, state, frame.raw)
          }
          if (await this._observeCommittedFrame(frame, req, state, account, mappedModel)) {
            sawTerminal = true
          }
          continue
        }
        const { type } = frame
        if (!frame.typeConflict && PRELUDE_TYPES.has(type)) {
          prelude.push(frame.raw)
          preludeBytes += frame.raw.length
          preludeEvents += 1
          if (preludeBytes >= PRELUDE_MAX_BYTES || preludeEvents >= PRELUDE_MAX_EVENTS) {
            flushPrelude()
          }
          continue
        }

        const terminal = !frame.typeConflict && TERMINAL_TYPES.has(type)
        const usage = terminal ? getResponseUsage(frame.payload) : null
        const trustworthyUsage = terminal && hasTrustworthyGrokUsage(usage)
        const semanticStatus = terminal
          ? inferSemanticStatus(frame.payload, type === 'response.completed' ? 200 : 400)
          : null
        if (
          terminal &&
          type !== 'response.completed' &&
          isRetryableAccountStatus(semanticStatus) &&
          !trustworthyUsage &&
          !state.clientDisconnected
        ) {
          await this._recordAccountError(
            account,
            semanticStatus,
            frame.payload,
            response.headers,
            'sse_terminal',
            null,
            semanticStatus === 401 && allowRefreshRetry
          )
          response.data.destroy()
          return {
            kind: semanticStatus === 401 && allowRefreshRetry ? 'retry_same_account' : 'retry',
            statusCode: semanticStatus
          }
        }

        flushPrelude()
        this._writeRaw(res, state, frame.raw)
        if (terminal) {
          sawTerminal = true
          state.lastTerminalType = type
          state.lastSemanticStatus = semanticStatus
          if (trustworthyUsage) {
            await this._settleUsage(req, state, account, mappedModel, frame.payload, usage, 200)
          }
          if (type !== 'response.completed') {
            await this._recordAccountError(
              account,
              semanticStatus,
              frame.payload,
              response.headers,
              'sse_terminal'
            )
            if (!trustworthyUsage) {
              await this._captureNoUsage(req, state, {
                account,
                statusCode: 200,
                semanticStatus,
                terminalType: type,
                error: getResponseError(frame.payload)
              })
            }
          } else if (!trustworthyUsage) {
            await grokAccountService.touchUsage(account.id)
            await this._captureNoUsage(req, state, {
              account,
              statusCode: 200,
              semanticStatus: 200,
              terminalType: type
            })
          }
        }
      }

      if (!committedAtChunkStart && this._isCommitted(res, state) && parser.bufferedBytes > 0) {
        this._writeRaw(res, state, parser.peekBuffered())
      }

      if (!this._isCommitted(res, state) && parser.bufferedBytes >= PRELUDE_MAX_BYTES) {
        flushPrelude()
        this._writeRaw(res, state, parser.peekBuffered())
        parser.discardCurrentFrame()
      }
      if (sawTerminal) {
        response.data.destroy()
        break
      }
    }

    if (!sawTerminal) {
      if (!this._isCommitted(res, state) && !state.clientDisconnected) {
        await this._recordAccountError(
          account,
          502,
          { error: { type: 'upstream_error', code: 'unexpected_eof' } },
          response.headers,
          'unexpected_eof'
        )
        return {
          kind: 'retry',
          statusCode: 502,
          error: new Error('Grok SSE ended without a terminal event')
        }
      }
      if (this._isCommitted(res, state) && !state.clientDisconnected) {
        this._writeSyntheticFailure(res, state, 'Upstream stream ended without a terminal event')
      }
      await this._captureNoUsage(req, state, {
        account,
        statusCode: 502,
        semanticStatus: 502,
        terminalType: 'unexpected_eof',
        error: { type: 'upstream_error', code: 'unexpected_eof' }
      })
    }
    if (!state.clientDisconnected && !res.writableEnded) {
      res.end()
      state.downstreamCommitted = true
    }
    return { kind: 'done' }
  }

  async _observeCommittedFrame(frame, req, state, account, mappedModel) {
    if (frame.typeConflict || !TERMINAL_TYPES.has(frame.type)) {
      return false
    }
    const usage = getResponseUsage(frame.payload)
    const semanticStatus = inferSemanticStatus(
      frame.payload,
      frame.type === 'response.completed' ? 200 : 400
    )
    state.lastTerminalType = frame.type
    state.lastSemanticStatus = semanticStatus
    if (hasTrustworthyGrokUsage(usage)) {
      await this._settleUsage(req, state, account, mappedModel, frame.payload, usage, 200)
    }
    if (frame.type !== 'response.completed') {
      await this._recordAccountError(
        account,
        semanticStatus,
        frame.payload,
        null,
        'sse_terminal_committed'
      )
      if (!hasTrustworthyGrokUsage(usage)) {
        await this._captureNoUsage(req, state, {
          account,
          statusCode: 200,
          semanticStatus,
          terminalType: frame.type,
          error: getResponseError(frame.payload)
        })
      }
    } else if (!hasTrustworthyGrokUsage(usage)) {
      await grokAccountService.touchUsage(account.id)
      await this._captureNoUsage(req, state, {
        account,
        statusCode: 200,
        semanticStatus: 200,
        terminalType: frame.type
      })
    }
    return true
  }

  async _handleJsonForStreamClient(
    response,
    req,
    res,
    state,
    account,
    mappedModel,
    allowRefreshRetry
  ) {
    const raw = await collectStream(response.data, MAX_JSON_BODY_BYTES, () =>
      this._onUpstreamData(state)
    )
    const parsed = this._tryParseBody(raw)
    if (
      !parsed.ok ||
      !parsed.body ||
      typeof parsed.body !== 'object' ||
      Array.isArray(parsed.body)
    ) {
      await this._recordAccountError(
        account,
        502,
        parsed.body,
        response.headers,
        'invalid_json_response'
      )
      return { kind: 'retry', statusCode: 502, error: new Error('Invalid Grok JSON response') }
    }
    const payload = parsed.body
    const responseStatus = String(payload.response?.status || payload.status || '').toLowerCase()
    const inferredTerminalType =
      responseStatus === 'failed'
        ? 'response.failed'
        : responseStatus === 'incomplete'
          ? 'response.incomplete'
          : responseStatus === 'cancelled'
            ? 'response.cancelled'
            : responseStatus === 'canceled'
              ? 'response.canceled'
              : payload.error
                ? 'response.failed'
                : 'response.completed'
    const wrapped = payload.type?.startsWith('response.')
      ? payload
      : {
          type: inferredTerminalType,
          response: payload
        }
    const { type } = wrapped
    const usage = getResponseUsage(wrapped)
    const trustworthyUsage = hasTrustworthyGrokUsage(usage)
    const failure = type !== 'response.completed'
    const semanticStatus = inferSemanticStatus(wrapped, failure ? 400 : 200)
    state.lastTerminalType = type
    state.lastSemanticStatus = semanticStatus
    if (
      failure &&
      isRetryableAccountStatus(semanticStatus) &&
      !trustworthyUsage &&
      !state.clientDisconnected
    ) {
      await this._recordAccountError(
        account,
        semanticStatus,
        wrapped,
        response.headers,
        'json_terminal',
        null,
        semanticStatus === 401 && allowRefreshRetry
      )
      return {
        kind: semanticStatus === 401 && allowRefreshRetry ? 'retry_same_account' : 'retry',
        statusCode: semanticStatus
      }
    }
    if (trustworthyUsage) {
      await this._settleUsage(req, state, account, mappedModel, wrapped, usage, 200)
    } else {
      if (!failure) {
        await grokAccountService.touchUsage(account.id)
      }
      await this._captureNoUsage(req, state, {
        account,
        statusCode: 200,
        semanticStatus,
        terminalType: type,
        error: failure ? getResponseError(wrapped) : null
      })
    }
    if (failure) {
      await this._recordAccountError(
        account,
        semanticStatus,
        wrapped,
        response.headers,
        'json_terminal'
      )
    }
    res.status(200)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('X-Accel-Buffering', 'no')
    this._writeRaw(res, state, Buffer.from(`event: ${type}\ndata: ${JSON.stringify(wrapped)}\n\n`))
    if (!state.clientDisconnected && !res.writableEnded) {
      res.end()
    }
    return { kind: 'done' }
  }

  async _handleNonStreamSSE(response, req, res, state, account, mappedModel, allowRefreshRetry) {
    const raw = await collectStream(response.data, MAX_JSON_BODY_BYTES, () =>
      this._onUpstreamData(state)
    )
    const parser = new GrokSSEFrameParser()
    const frames = parser.feed(raw)
    if (parser.bufferedBytes && parser.takeBuffered().toString('utf8').trim()) {
      return { kind: 'retry', statusCode: 502, error: new Error('Malformed Grok SSE response') }
    }
    const terminalFrame = [...frames].reverse().find((frame) => TERMINAL_TYPES.has(frame.type))
    if (!terminalFrame?.payload) {
      return {
        kind: 'retry',
        statusCode: 502,
        error: new Error('Grok SSE response has no terminal event')
      }
    }
    return this._handleTerminalJsonPayload(
      terminalFrame.payload,
      req,
      res,
      state,
      account,
      mappedModel,
      response.headers,
      allowRefreshRetry
    )
  }

  async _handleJsonStream(response, req, res, state, account, mappedModel, allowRefreshRetry) {
    const raw = await collectStream(response.data, MAX_JSON_BODY_BYTES, () =>
      this._onUpstreamData(state)
    )
    const parsed = this._tryParseBody(raw)
    const payload = parsed.body
    if (!parsed.ok || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
      await this._recordAccountError(
        account,
        502,
        payload,
        response.headers,
        'invalid_json_response'
      )
      return { kind: 'retry', statusCode: 502, error: new Error('Invalid Grok JSON response') }
    }
    return this._handleTerminalJsonPayload(
      payload,
      req,
      res,
      state,
      account,
      mappedModel,
      response.headers,
      allowRefreshRetry
    )
  }

  async _handleTerminalJsonPayload(
    payload,
    req,
    res,
    state,
    account,
    mappedModel,
    headers,
    allowRefreshRetry
  ) {
    const responseError = getResponseError(payload)
    const type =
      payload.type ||
      payload.response?.type ||
      (responseError ? 'response.failed' : payload.status || 'response.completed')
    const status = payload.response?.status || payload.status
    const isFailure =
      Boolean(responseError) ||
      status === 'failed' ||
      status === 'incomplete' ||
      (TERMINAL_TYPES.has(type) && type !== 'response.completed' && type !== 'completed')
    const usage = getResponseUsage(payload)
    const trustworthyUsage = hasTrustworthyGrokUsage(usage)
    const semanticStatus = inferSemanticStatus(payload, isFailure ? 400 : 200)
    state.lastTerminalType = type
    state.lastSemanticStatus = semanticStatus

    if (
      isFailure &&
      isRetryableAccountStatus(semanticStatus) &&
      !trustworthyUsage &&
      !state.clientDisconnected
    ) {
      await this._recordAccountError(
        account,
        semanticStatus,
        payload,
        headers,
        'json_terminal',
        null,
        semanticStatus === 401 && allowRefreshRetry
      )
      return {
        kind: semanticStatus === 401 && allowRefreshRetry ? 'retry_same_account' : 'retry',
        statusCode: semanticStatus
      }
    }
    if (trustworthyUsage) {
      await this._settleUsage(req, state, account, mappedModel, payload, usage, 200)
    } else {
      if (!isFailure) {
        await grokAccountService.touchUsage(account.id)
      }
      await this._captureNoUsage(req, state, {
        account,
        statusCode: 200,
        semanticStatus,
        terminalType: type,
        error: isFailure ? getResponseError(payload) : null
      })
    }
    if (isFailure) {
      await this._recordAccountError(account, semanticStatus, payload, headers, 'json_terminal')
    }
    const responseBody =
      payload.response && TERMINAL_TYPES.has(payload.type) ? payload.response : payload
    this._sendHttpBody(res, state, 200, responseBody)
    return { kind: 'done' }
  }

  async _settleUsage(req, state, account, mappedModel, payload, usage, statusCode) {
    if (state.accountingSettled) {
      return
    }
    state.accountingSettled = true
    state.detailSettled = true
    try {
      const normalized = normalizeOpenAIUsage(usage)
      const actualModel = getResponseModel(payload)
      const billingModel = resolveGrokBillingModel(actualModel, mappedModel)
      if (!billingModel) {
        throw new Error(`Unable to resolve Grok billing model for ${actualModel || mappedModel}`)
      }
      await apiKeyService.recordUsage(
        req.apiKey.id,
        normalized.inputTokens,
        normalized.outputTokens,
        normalized.cacheCreateTokens,
        normalized.cacheReadTokens,
        billingModel,
        account.id,
        'grok',
        null,
        this._buildRequestMeta(req, state, {
          account,
          mappedModel,
          actualModel,
          billingModel,
          statusCode,
          semanticStatus: state.lastSemanticStatus,
          terminalType: state.lastTerminalType,
          error: getResponseError(payload)
        })
      )
      await grokAccountService.touchUsage(account.id, normalized.totalTokens)
    } catch (error) {
      logger.error('Failed to persist settled Grok usage', {
        requestId: state.requestId,
        accountId: account.id,
        mappedModel,
        error: error.message
      })
    }
  }

  async _captureNoUsage(req, state, values) {
    if (state.detailSettled) {
      return
    }
    state.detailSettled = true
    const meta = this._buildRequestMeta(req, state, {
      ...values,
      mappedModel: state.lastMappedModel,
      billingModel: state.lastMappedModel
    })
    try {
      await requestDetailService.captureRequestDetail({
        ...meta,
        timestamp: new Date().toISOString(),
        apiKeyId: req.apiKey.id,
        accountId: values.account?.id || null,
        accountType: 'grok',
        model: state.lastMappedModel || req.body.model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        totalTokens: 0,
        cost: 0,
        realCost: 0
      })
    } catch (error) {
      logger.error('Failed to persist Grok zero-usage request detail', {
        requestId: state.requestId,
        accountId: values.account?.id || null,
        error: error.message
      })
    }
  }

  _buildRequestMeta(req, state, values = {}) {
    return {
      ...createRequestDetailMeta(req, {
        requestId: state.requestId,
        requestStartedAt: state.startedAt,
        requestBody: req.body,
        stream: req.body.stream === true,
        statusCode: values.statusCode ?? state.lastUpstreamStatus ?? 0
      }),
      clientIp: getRequestIp(req),
      upstreamRequestId: state.upstreamRequestId || null,
      downstreamHttpStatus: values.statusCode ?? null,
      upstreamHttpStatus: state.lastUpstreamStatus,
      upstreamSemanticStatus: values.semanticStatus ?? state.lastSemanticStatus,
      terminalType: values.terminalType ?? state.lastTerminalType,
      errorType: values.error?.type || null,
      errorCode: values.error?.code || null,
      requestedModel: req.body.model,
      mappedModel: values.mappedModel || state.lastMappedModel,
      actualModel: values.actualModel || null,
      billingModel: values.billingModel || null,
      firstTokenLatencyMs: state.firstTokenAt ? state.firstTokenAt - state.startedAt : null
    }
  }

  async _recordAccountError(
    account,
    statusCode,
    body,
    headers,
    phase,
    quotaSnapshot = null,
    suppressCooldown = false
  ) {
    const context = sanitizeLogValue(
      upstreamErrorHelper.logUpstreamErrorResponse({
        provider: 'grok',
        accountId: account.id,
        accountType: 'grok',
        accountName: account.name,
        statusCode,
        headers: headers || {},
        body,
        phase,
        model: body?.model || body?.response?.model
      })
    )
    if (!isRetryableAccountStatus(statusCode) || suppressCooldown) {
      await upstreamErrorHelper.recordErrorHistory(
        account.id,
        'grok',
        statusCode,
        'response_failed',
        context
      )
      return context
    }
    let ttl = statusCode === 401 || statusCode === 402 ? 600 : statusCode === 403 ? 1800 : 120
    if (statusCode === 429) {
      ttl = getQuotaCooldownSeconds(quotaSnapshot || account.rateLimitSnapshot, Date.now(), 120)
    }
    if (statusCode === 402) {
      const periodEnd = Date.parse(account.billingSnapshot?.periodEnd || '')
      if (Number.isFinite(periodEnd) && periodEnd > Date.now()) {
        ttl = Math.ceil((periodEnd - Date.now()) / 1000)
      }
    }
    const marked = await upstreamErrorHelper.markTempUnavailable(
      account.id,
      'grok',
      statusCode,
      ttl,
      context,
      { allowBeyondGlobalCap: statusCode === 429 || statusCode === 402 }
    )
    try {
      await grokAccountService.markTemporaryStatus(
        account.id,
        statusCode,
        marked?.expiresAt || new Date(Date.now() + ttl * 1000).toISOString(),
        getResponseError(body)?.message ||
          body?.error?.message ||
          `Upstream returned ${statusCode}`,
        { persistentCredentialError: statusCode === 401 && account.authType === 'api_key' }
      )
    } catch (error) {
      logger.error('Failed to persist Grok account cooldown status', {
        accountId: account.id,
        statusCode,
        error: error.message
      })
    }
    return context
  }

  _onUpstreamData(state) {
    if (!state.firstTokenAt) {
      state.firstTokenAt = Date.now()
    }
    if (state.clientDisconnected) {
      this._resetDrainTimer(state)
    }
  }

  _resetDrainTimer(state) {
    if (state.drainTimer) {
      clearTimeout(state.drainTimer)
    }
    if (config.grok.disconnectDrainIdleMs > 0) {
      state.drainTimer = setTimeout(
        () => state.activeController?.abort(),
        config.grok.disconnectDrainIdleMs
      )
    }
  }

  _clearAttemptTimers(state) {
    if (state.hardTimer) {
      clearTimeout(state.hardTimer)
      state.hardTimer = null
    }
    if (state.drainTimer) {
      clearTimeout(state.drainTimer)
      state.drainTimer = null
    }
    state.activeController = null
    state.activeAccepted = false
  }

  _isCommitted(res, state) {
    return state.downstreamCommitted || res.headersSent
  }

  _writeRaw(res, state, raw) {
    if (state.clientDisconnected || res.destroyed || res.writableEnded || !raw?.length) {
      return false
    }
    res.write(raw)
    state.downstreamCommitted = true
    return true
  }

  _writeSyntheticFailure(res, state, message) {
    const payload = {
      type: 'response.failed',
      response: {
        id: state.requestId,
        object: 'response',
        status: 'failed',
        error: { type: 'upstream_error', code: 'stream_terminated', message }
      }
    }
    this._writeRaw(
      res,
      state,
      Buffer.from(`event: response.failed\ndata: ${JSON.stringify(payload)}\n\n`)
    )
  }

  _parseBody(raw) {
    return this._tryParseBody(raw).body
  }

  _tryParseBody(raw) {
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '')
    try {
      return { ok: true, body: JSON.parse(text) }
    } catch {
      return {
        ok: false,
        body: { error: { type: 'upstream_error', message: text || 'Empty upstream response' } }
      }
    }
  }

  _sendHttpBody(res, state, statusCode, body) {
    if (state.clientDisconnected || res.destroyed || res.writableEnded) {
      return
    }
    res.status(statusCode).json(body)
    state.downstreamCommitted = true
  }

  async _finalizeFailure(req, res, state) {
    const modelNotFound = state.lastError?.code === 'GROK_MODEL_NOT_FOUND'
    const modelNotAllowed = state.lastError?.code === 'GROK_MODEL_NOT_ALLOWED'
    const pricingUnavailable = state.lastError?.code === 'GROK_PRICING_UNAVAILABLE'
    const statusCode = modelNotAllowed
      ? 403
      : modelNotFound
        ? 404
        : pricingUnavailable
          ? 503
          : state.lastUpstreamStatus && state.lastUpstreamStatus >= 400
            ? state.lastUpstreamStatus
            : Date.now() >= state.deadlineAt
              ? 504
              : 503
    await this._captureNoUsage(req, state, {
      account: state.lastAccount,
      statusCode,
      semanticStatus: state.lastSemanticStatus || statusCode,
      terminalType: state.lastTerminalType || 'relay_failed',
      error: {
        type: 'server_error',
        code: state.lastError?.code || 'grok_unavailable'
      }
    })
    if (state.clientDisconnected) {
      return
    }
    const message = modelNotAllowed
      ? `Model ${req.body.model} is not allowed for this API key`
      : modelNotFound
        ? `Model ${req.body.model} was not found`
        : pricingUnavailable
          ? `Pricing is temporarily unavailable for ${req.body.model}`
          : statusCode === 504
            ? 'The Grok upstream request timed out'
            : 'No Grok account is currently available'
    if (this._isCommitted(res, state)) {
      this._writeSyntheticFailure(res, state, message)
      if (!res.writableEnded) {
        res.end()
      }
      return
    }
    this._sendHttpBody(res, state, statusCode, {
      error: {
        message,
        type: modelNotFound || modelNotAllowed ? 'invalid_request_error' : 'server_error',
        code: modelNotAllowed
          ? 'model_not_allowed'
          : modelNotFound
            ? 'model_not_found'
            : pricingUnavailable
              ? 'pricing_unavailable'
              : 'grok_unavailable'
      }
    })
  }
}

module.exports = new GrokRelayService()
module.exports.inferSemanticStatus = inferSemanticStatus
module.exports.isRetryableAccountStatus = isRetryableAccountStatus
