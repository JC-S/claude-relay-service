const axios = require('axios')
const crypto = require('crypto')
const unifiedOpenAIScheduler = require('./scheduler/unifiedOpenAIScheduler')
const openaiAccountService = require('./account/openaiAccountService')
const ProxyHelper = require('../utils/proxyHelper')
const openaiNicSelector = require('../utils/openaiNicSelector')
const { getHttpsAgentForLocalAddress } = require('../utils/performanceOptimizer')
const logger = require('../utils/logger')
const { summarizeErrorForLog } = require('../utils/logSanitizer')

const CODEX_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models'
const CODEX_MODELS_DEFAULT_CLIENT_VERSION = '0.144.0'
const FRESH_TTL_MS = 30 * 1000
const STALE_TTL_MS = 5 * 60 * 1000
const MAX_CACHE_ENTRIES = 128
const MAX_BODY_BYTES = 8 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 15 * 1000
const VERSION_PATTERN = /^\d+(?:\.\d+){1,3}$/

function normalizeClientVersion(value) {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length <= 32 && VERSION_PATTERN.test(trimmed) ? trimmed : null
}

function extractCodexVersionFromUa(userAgent) {
  if (typeof userAgent !== 'string') {
    return null
  }
  const match = userAgent
    .trim()
    .match(/^(?:codex-tui|codex_cli_rs|codex_exec|codex_vscode)\/([\d.]+)\b/i)
  return match ? normalizeClientVersion(match[1]) : null
}

function resolveClientVersion(req) {
  const candidates = [
    req?.query?.client_version,
    req?.headers?.version,
    extractCodexVersionFromUa(req?.headers?.['user-agent'])
  ]
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === '') {
      continue
    }
    const normalized = normalizeClientVersion(String(candidate))
    if (!normalized) {
      const error = new Error('client_version must be a numeric dotted version')
      error.statusCode = 400
      error.code = 'invalid_client_version'
      throw error
    }
    return normalized
  }
  return CODEX_MODELS_DEFAULT_CLIENT_VERSION
}

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

function cacheProxyFingerprint(proxy) {
  if (!proxy) {
    return 'direct'
  }
  return crypto.createHash('sha256').update(JSON.stringify(proxy)).digest('hex').slice(0, 16)
}

function etagMatches(ifNoneMatch, etag) {
  if (!ifNoneMatch || !etag) {
    return false
  }
  return String(ifNoneMatch)
    .split(',')
    .map((value) => value.trim())
    .some((value) => value === '*' || value === etag)
}

class OpenAICodexModelsService {
  constructor() {
    this.cache = new Map()
    this.inflight = new Map()
  }

  _cacheKey(accountId, clientVersion, proxy) {
    return `${accountId}:${clientVersion}:${cacheProxyFingerprint(proxy)}`
  }

  _setCache(cacheKey, entry) {
    if (!this.cache.has(cacheKey) && this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = this.cache.keys().next().value
      this.cache.delete(oldestKey)
    }
    this.cache.delete(cacheKey)
    this.cache.set(cacheKey, entry)
  }

  async _selectAccount(apiKeyData, excludedAccountIds) {
    const selection = await unifiedOpenAIScheduler.selectAccountForApiKey(apiKeyData, null, null, {
      allowedAccountTypes: ['openai'],
      touchLastUsed: false,
      excludedAccountIds
    })
    try {
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
      const accessToken = openaiAccountService.decrypt(account?.accessToken)
      if (!account || !accessToken) {
        const error = new Error('Selected OpenAI OAuth account has no usable access token')
        error.statusCode = 503
        throw error
      }
      return { account, accessToken }
    } catch (error) {
      error.retryableAccount = true
      error.accountId = selection.accountId
      throw error
    }
  }

  async _fetchUpstream({
    account,
    accessToken,
    clientVersion,
    cachedEntry,
    unconditional = false
  }) {
    const proxy = parseProxy(account.proxy)
    const proxyAgent = ProxyHelper.createProxyAgent(proxy)
    const headers = {
      authorization: `Bearer ${accessToken}`,
      'chatgpt-account-id': account.accountId || account.chatgptUserId || account.id,
      accept: 'application/json',
      host: 'chatgpt.com',
      originator: 'codex-tui',
      version: clientVersion,
      'user-agent': `codex-tui/${clientVersion} (Ubuntu 24.04; x86_64) codex-tui`
    }
    if (!unconditional && cachedEntry?.etag) {
      headers['if-none-match'] = cachedEntry.etag
    }

    const requestConfig = {
      headers,
      params: { client_version: clientVersion },
      responseType: 'arraybuffer',
      timeout: REQUEST_TIMEOUT_MS,
      maxContentLength: MAX_BODY_BYTES,
      maxBodyLength: MAX_BODY_BYTES,
      validateStatus: () => true
    }
    if (proxyAgent) {
      requestConfig.httpAgent = proxyAgent
      requestConfig.httpsAgent = proxyAgent
      requestConfig.proxy = false
    } else if (account.interleaveNicEnabled === true || account.interleaveNicEnabled === 'true') {
      const localAddress = await openaiNicSelector.chooseLocalAddress({
        accountId: account.id,
        sessionHash: null,
        ttlHours: account.interleaveNicTtlHours,
        disabledAddresses: account.interleaveNicDisabledAddresses
      })
      if (localAddress) {
        requestConfig.httpsAgent = getHttpsAgentForLocalAddress(localAddress, { stream: false })
        requestConfig.proxy = false
      }
    }

    return axios.get(CODEX_MODELS_URL, requestConfig)
  }

  _parseManifest(upstream) {
    const bodyBuffer = Buffer.isBuffer(upstream.data)
      ? upstream.data
      : Buffer.from(upstream.data || '')
    if (bodyBuffer.length > MAX_BODY_BYTES) {
      const error = new Error('OpenAI Codex models manifest exceeded the size limit')
      error.statusCode = 502
      throw error
    }
    let body
    try {
      body = JSON.parse(bodyBuffer.toString('utf8'))
    } catch (_) {
      const error = new Error('OpenAI Codex models manifest was not valid JSON')
      error.statusCode = 502
      throw error
    }
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.models)) {
      const error = new Error('OpenAI Codex models manifest had an invalid envelope')
      error.statusCode = 502
      throw error
    }
    return body
  }

  async _refresh(cacheKey, params) {
    if (this.inflight.has(cacheKey)) {
      return this.inflight.get(cacheKey)
    }
    const promise = (async () => {
      const cachedEntry = this.cache.get(cacheKey)
      let upstream
      try {
        upstream = await this._fetchUpstream({ ...params, cachedEntry })
      } catch (error) {
        error.retryableAccount = true
        throw error
      }
      if (upstream.status === 304 && !cachedEntry?.body) {
        try {
          upstream = await this._fetchUpstream({
            ...params,
            cachedEntry: null,
            unconditional: true
          })
        } catch (error) {
          error.retryableAccount = true
          throw error
        }
        if (upstream.status === 304) {
          const error = new Error(
            'OpenAI Codex models upstream returned 304 without a cached manifest'
          )
          error.statusCode = 502
          error.retryableAccount = true
          throw error
        }
      }
      if (upstream.status === 304 && cachedEntry?.body) {
        const refreshed = {
          ...cachedEntry,
          fetchedAt: Date.now()
        }
        this._setCache(cacheKey, refreshed)
        return refreshed
      }
      if (upstream.status === 429 || upstream.status >= 500) {
        const error = new Error(`OpenAI Codex models upstream returned ${upstream.status}`)
        error.statusCode = upstream.status
        error.retryableAccount = true
        throw error
      }
      if (upstream.status < 200 || upstream.status >= 300) {
        const error = new Error(`OpenAI Codex models upstream rejected the request`)
        error.statusCode = upstream.status
        throw error
      }
      const body = this._parseManifest(upstream)
      const entry = {
        body,
        etag: upstream.headers?.etag || null,
        fetchedAt: Date.now()
      }
      this._setCache(cacheKey, entry)
      return entry
    })().finally(() => {
      this.inflight.delete(cacheKey)
    })
    this.inflight.set(cacheKey, promise)
    return promise
  }

  async getManifest(req) {
    const clientVersion = resolveClientVersion(req)
    const excludedAccountIds = []
    let lastError = null

    for (let attempt = 0; attempt < MAX_CACHE_ENTRIES; attempt++) {
      let selected
      try {
        selected = await this._selectAccount(req.apiKey, excludedAccountIds)
      } catch (error) {
        if (
          error.retryableAccount &&
          error.accountId &&
          !excludedAccountIds.includes(error.accountId)
        ) {
          lastError = error
          excludedAccountIds.push(error.accountId)
          continue
        }
        if (lastError) {
          throw lastError
        }
        throw error
      }

      const proxy = parseProxy(selected.account.proxy)
      const cacheKey = this._cacheKey(selected.account.id, clientVersion, proxy)
      const cachedEntry = this.cache.get(cacheKey)
      const ageMs = cachedEntry ? Date.now() - cachedEntry.fetchedAt : Infinity
      const downstreamEtag = req.headers?.['if-none-match']

      if (cachedEntry && ageMs <= FRESH_TTL_MS) {
        return {
          status: etagMatches(downstreamEtag, cachedEntry.etag) ? 304 : 200,
          body: cachedEntry.body,
          etag: cachedEntry.etag,
          cacheState: 'fresh'
        }
      }

      if (cachedEntry && ageMs <= STALE_TTL_MS) {
        void this._refresh(cacheKey, {
          account: selected.account,
          accessToken: selected.accessToken,
          clientVersion
        }).catch((error) => {
          logger.warn('OpenAI Codex models background refresh failed', {
            accountId: selected.account.id,
            ...summarizeErrorForLog(error)
          })
        })
        return {
          status: etagMatches(downstreamEtag, cachedEntry.etag) ? 304 : 200,
          body: cachedEntry.body,
          etag: cachedEntry.etag,
          cacheState: 'stale'
        }
      }

      try {
        const entry = await this._refresh(cacheKey, {
          account: selected.account,
          accessToken: selected.accessToken,
          clientVersion
        })
        return {
          status: etagMatches(downstreamEtag, entry.etag) ? 304 : 200,
          body: entry.body,
          etag: entry.etag,
          cacheState: 'miss'
        }
      } catch (error) {
        lastError = error
        if (!error.retryableAccount) {
          throw error
        }
        excludedAccountIds.push(selected.account.id)
      }
    }

    throw lastError || new Error('No OpenAI OAuth account could provide a models manifest')
  }

  resetForTest() {
    this.cache.clear()
    this.inflight.clear()
  }
}

module.exports = new OpenAICodexModelsService()
module.exports.resolveClientVersion = resolveClientVersion
module.exports.CODEX_MODELS_DEFAULT_CLIENT_VERSION = CODEX_MODELS_DEFAULT_CLIENT_VERSION
module.exports.DEFAULT_CLIENT_VERSION = CODEX_MODELS_DEFAULT_CLIENT_VERSION
