const axios = require('axios')
const unifiedOpenAIScheduler = require('./scheduler/unifiedOpenAIScheduler')
const openaiAccountService = require('./account/openaiAccountService')
const apiKeyService = require('./apiKeyService')
const ProxyHelper = require('../utils/proxyHelper')
const openaiNicSelector = require('../utils/openaiNicSelector')
const { getHttpsAgentForLocalAddress } = require('../utils/performanceOptimizer')
const { updateRateLimitCounters } = require('../utils/rateLimitHelper')
const { createRequestDetailMeta } = require('../utils/requestDetailHelper')
const { isModelRestricted } = require('../utils/apiKeyModelRestriction')
const { getSafeMessage } = require('../utils/errorSanitizer')
const { summarizeErrorForLog } = require('../utils/logSanitizer')
const upstreamErrorHelper = require('../utils/upstreamErrorHelper')
const logger = require('../utils/logger')
const config = require('../../config/config')

const SEARCH_URL = 'https://chatgpt.com/backend-api/codex/alpha/search'
const SEARCH_MODEL = 'codex-web-search'
const SEARCH_REAL_COST = 0.01

function parseProxy(proxyValue) {
  if (!proxyValue) {
    return null
  }
  if (typeof proxyValue === 'object') {
    return proxyValue
  }
  try {
    return JSON.parse(proxyValue)
  } catch (_) {
    return null
  }
}

function getHeader(headers, name) {
  const value = headers?.[name.toLowerCase()] ?? headers?.[name]
  return Array.isArray(value) ? value[0] : value
}

function sendError(res, status, message, type = 'api_error', code = 'upstream_error') {
  return res.status(status).json({
    error: {
      message,
      type,
      code
    }
  })
}

class OpenAIAlphaSearchService {
  async _selectAccount(apiKeyData) {
    const selection = await unifiedOpenAIScheduler.selectAccountForApiKey(apiKeyData, null, null, {
      allowedAccountTypes: ['openai']
    })
    let account = await openaiAccountService.getAccount(selection.accountId)
    if (!account) {
      const error = new Error('Selected OpenAI OAuth account was not found')
      error.statusCode = 503
      throw error
    }
    if (openaiAccountService.isTokenExpired(account)) {
      await openaiAccountService.refreshAccountToken(selection.accountId)
      account = await openaiAccountService.getAccount(selection.accountId)
    }
    const accessToken = openaiAccountService.decrypt(account.accessToken)
    if (!accessToken) {
      const error = new Error('Selected OpenAI OAuth account has no usable access token')
      error.statusCode = 503
      throw error
    }
    return { account, accessToken }
  }

  _buildHeaders(req, account, accessToken) {
    const incoming = req.headers || {}
    const headers = {
      authorization: `Bearer ${accessToken}`,
      'chatgpt-account-id': account.accountId || account.chatgptUserId || account.id,
      host: 'chatgpt.com',
      accept: 'application/json',
      'content-type': 'application/json',
      connection: 'Keep-Alive',
      originator: getHeader(incoming, 'originator') || 'codex-tui',
      'user-agent':
        getHeader(incoming, 'user-agent') || 'codex-tui/0.144.0 (Ubuntu 24.04; x86_64) codex-tui'
    }
    for (const name of ['version', 'x-codex-turn-metadata']) {
      const value = getHeader(incoming, name)
      if (value) {
        headers[name] = value
      }
    }
    return headers
  }

  async _captureFailure(req, { accountId, model, statusCode, startedAt, error, localAddress }) {
    const requestDetailService = require('./requestDetailService')
    await requestDetailService.captureRequestDetail({
      ...createRequestDetailMeta(req, {
        statusCode,
        durationMs: Date.now() - startedAt,
        requestBody: req.body,
        upstreamNicIp: localAddress,
        usageType: 'openai_web_search',
        webSearchCalls: 0,
        responsesLite: false
      }),
      apiKeyId: req.apiKey?.id || null,
      accountId: accountId || null,
      accountType: 'openai',
      model: model || SEARCH_MODEL,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      totalTokens: 0,
      cost: 0,
      realCost: 0,
      errorType: error?.type || 'upstream_error',
      errorCode: error?.code || null,
      upstreamHttpStatus: statusCode
    })
  }

  async _handleNicRateLimit(req, account, localAddress, model, upstream) {
    const cooldown = await openaiNicSelector.markCooldown({
      accountId: account.id,
      localAddress,
      disabledAddresses: account.interleaveNicDisabledAddresses
    })
    await upstreamErrorHelper.recordErrorHistory(account.id, 'openai', 429, 'rate_limit', {
      model,
      path: req.originalUrl || req.path,
      apiKeyName: req.apiKey?.name || null,
      source: 'alpha_search',
      interleaveNic: true,
      localAddress,
      upstreamNicIp: localAddress,
      cooldownApplied: Boolean(cooldown.marked),
      cooldownReason: cooldown.reason || (cooldown.marked ? 'cooldown_applied' : null),
      cooldownSeconds: cooldown.ttlSeconds || null,
      cooldownExpiresAt: cooldown.expiresAt || null,
      remainingNicAddresses:
        cooldown.remainingAddresses === undefined ? null : cooldown.remainingAddresses,
      errorBody: upstream.data || null
    })
    return {
      handled: Boolean(cooldown.marked) || cooldown.reason === 'last_available',
      retryable: Boolean(cooldown.marked),
      cooldown
    }
  }

  async handle(req, res) {
    const startedAt = Date.now()
    let account = null
    let localAddress = null
    let upstreamCompleted = false
    const abortController = new AbortController()
    const cancelBeforeCompletion = () => {
      if (!upstreamCompleted) {
        abortController.abort()
      }
    }
    req.once('aborted', cancelBeforeCompletion)
    res.once('close', cancelBeforeCompletion)

    try {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        return sendError(
          res,
          400,
          'A JSON object request body is required',
          'invalid_request_error',
          'invalid_request'
        )
      }
      const model = typeof req.body.model === 'string' ? req.body.model.trim() : ''
      if (!model) {
        return sendError(res, 400, 'Model is required', 'invalid_request_error', 'model_required')
      }
      if (isModelRestricted(req.apiKey, model)) {
        return sendError(
          res,
          403,
          `Model ${model} is not allowed for this API key`,
          'invalid_request_error',
          'model_not_allowed'
        )
      }

      const selected = await this._selectAccount(req.apiKey)
      ;({ account } = selected)
      const body = { ...req.body }
      delete body.prompt_cache_key
      delete body.prompt_cache_retention

      const proxy = parseProxy(account.proxy)
      const proxyAgent = ProxyHelper.createProxyAgent(proxy)
      const axiosConfig = {
        headers: this._buildHeaders(req, account, selected.accessToken),
        timeout: config.requestTimeout || 600000,
        validateStatus: () => true,
        signal: abortController.signal
      }
      if (proxyAgent) {
        axiosConfig.httpAgent = proxyAgent
        axiosConfig.httpsAgent = proxyAgent
        axiosConfig.proxy = false
      } else if (account.interleaveNicEnabled === true || account.interleaveNicEnabled === 'true') {
        localAddress = await openaiNicSelector.chooseLocalAddress({
          accountId: account.id,
          sessionHash: null,
          ttlHours: account.interleaveNicTtlHours,
          disabledAddresses: account.interleaveNicDisabledAddresses
        })
        if (localAddress) {
          axiosConfig.httpsAgent = getHttpsAgentForLocalAddress(localAddress, { stream: false })
          axiosConfig.proxy = false
          req.upstreamNicIp = localAddress
        }
      }

      const sendUpstream = () => axios.post(SEARCH_URL, body, axiosConfig)
      let upstream = await sendUpstream()
      let nicRateLimitHandled = false
      if (upstream.status === 429 && localAddress) {
        const firstDecision = await this._handleNicRateLimit(
          req,
          account,
          localAddress,
          model,
          upstream
        )
        nicRateLimitHandled = firstDecision.handled
        if (firstDecision.retryable) {
          await openaiNicSelector.clearBinding({ accountId: account.id, sessionHash: null })
          const previousLocalAddress = localAddress
          localAddress = await openaiNicSelector.chooseLocalAddress({
            accountId: account.id,
            sessionHash: null,
            ttlHours: account.interleaveNicTtlHours,
            disabledAddresses: account.interleaveNicDisabledAddresses
          })
          if (localAddress && localAddress !== previousLocalAddress) {
            axiosConfig.httpsAgent = getHttpsAgentForLocalAddress(localAddress, { stream: false })
            req.upstreamNicIp = localAddress
            upstream = await sendUpstream()
            if (upstream.status === 429) {
              const retryDecision = await this._handleNicRateLimit(
                req,
                account,
                localAddress,
                model,
                upstream
              )
              nicRateLimitHandled = retryDecision.handled
            }
          }
        }
      }
      upstreamCompleted = true

      if (upstream.status < 200 || upstream.status >= 300) {
        if (upstream.status === 429 && !nicRateLimitHandled) {
          await unifiedOpenAIScheduler.markAccountRateLimited(account.id, 'openai', null, null)
        }
        await this._captureFailure(req, {
          accountId: account.id,
          model,
          statusCode: upstream.status,
          startedAt,
          error: upstream.data?.error,
          localAddress
        })
        const payload =
          upstream.data && typeof upstream.data === 'object'
            ? upstream.data
            : {
                error: {
                  message: getSafeMessage(upstream.data || `Upstream returned ${upstream.status}`)
                }
              }
        return res.status(upstream.status).json(payload)
      }

      const requestMeta = createRequestDetailMeta(req, {
        statusCode: upstream.status,
        durationMs: Date.now() - startedAt,
        requestBody: body,
        upstreamNicIp: localAddress,
        usageType: 'openai_web_search',
        webSearchCalls: 1,
        responsesLite: false
      })
      try {
        const costs = await apiKeyService.recordFixedCostUsage(req.apiKey.id, {
          realCost: SEARCH_REAL_COST,
          service: 'codex',
          model: SEARCH_MODEL,
          accountId: account.id,
          accountType: 'openai',
          requestMeta,
          usageType: 'openai_web_search',
          webSearchCalls: 1
        })
        if (req.rateLimitInfo) {
          await updateRateLimitCounters(
            req.rateLimitInfo,
            {
              inputTokens: 0,
              outputTokens: 0,
              cacheCreateTokens: 0,
              cacheReadTokens: 0
            },
            SEARCH_MODEL,
            req.apiKey.id,
            'openai',
            costs
          )
        }
      } catch (billingError) {
        logger.error('OpenAI alpha/search succeeded but billing failed', {
          requestId: req.requestId,
          accountId: account.id,
          ...summarizeErrorForLog(billingError)
        })
      }

      const contentType = upstream.headers?.['content-type']
      if (contentType) {
        res.setHeader('Content-Type', contentType)
      }
      return res.status(upstream.status).send(upstream.data)
    } catch (error) {
      const status =
        error.code === 'account_type_not_allowed'
          ? 503
          : error.statusCode ||
            error.response?.status ||
            (error.code === 'ERR_CANCELED' ? 499 : 500)
      logger.error('OpenAI alpha/search failed', {
        requestId: req.requestId,
        accountId: account?.id || null,
        ...summarizeErrorForLog(error)
      })
      if (status !== 499) {
        await this._captureFailure(req, {
          accountId: account?.id || null,
          model: req.body?.model || SEARCH_MODEL,
          statusCode: status,
          startedAt,
          error,
          localAddress
        }).catch(() => {})
      }
      if (!res.headersSent && status !== 499) {
        return sendError(
          res,
          status,
          error.code === 'account_type_not_allowed'
            ? 'Codex private endpoints require a native OpenAI OAuth account'
            : getSafeMessage(error),
          status >= 500 ? 'server_error' : 'invalid_request_error',
          error.code || 'search_failed'
        )
      }
      return undefined
    } finally {
      req.removeListener('aborted', cancelBeforeCompletion)
      res.removeListener('close', cancelBeforeCompletion)
    }
  }
}

module.exports = new OpenAIAlphaSearchService()
module.exports.SEARCH_MODEL = SEARCH_MODEL
module.exports.SEARCH_REAL_COST = SEARCH_REAL_COST
