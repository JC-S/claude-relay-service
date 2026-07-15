const axios = require('axios')
const { v4: uuidv4 } = require('uuid')
const redis = require('../../models/redis')
const config = require('../../../config/config')
const ProxyHelper = require('../../utils/proxyHelper')
const { createEncryptor, isTruthy } = require('../../utils/commonHelper')
const tokenRefreshService = require('../tokenRefreshService')
const grokOAuthService = require('../grokOAuthService')
const upstreamErrorHelper = require('../../utils/upstreamErrorHelper')
const { buildGrokUpstreamHeaders } = require('../../utils/grokRequestHelper')

const encryptor = createEncryptor('grok-account-salt')
const JSON_FIELDS = new Set([
  'proxy',
  'supportedModels',
  'modelMapping',
  'groupIds',
  'rateLimitSnapshot',
  'billingSnapshot'
])
const BOOLEAN_FIELDS = new Set(['isActive', 'schedulable'])
const SENSITIVE_FIELDS = new Set(['accessToken', 'refreshToken', 'idToken', 'apiKey'])

const parseJson = (value, fallback) => {
  if (!value) {
    return fallback
  }
  if (typeof value === 'object') {
    return value
  }
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

class GrokAccountService {
  _serialize(values) {
    const result = {}
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) {
        continue
      }
      if (SENSITIVE_FIELDS.has(key)) {
        result[key] = value ? encryptor.encrypt(String(value)) : ''
      } else if (JSON_FIELDS.has(key)) {
        result[key] = value ? JSON.stringify(value) : ''
      } else if (BOOLEAN_FIELDS.has(key)) {
        result[key] = String(value === true || value === 'true')
      } else if (value === null) {
        result[key] = ''
      } else {
        result[key] = String(value)
      }
    }
    return result
  }

  _deserialize(account, includeSecrets = false) {
    if (!account || !Object.keys(account).length) {
      return null
    }
    const result = { ...account }
    for (const field of JSON_FIELDS) {
      const fallback = ['supportedModels', 'groupIds'].includes(field)
        ? []
        : field === 'modelMapping'
          ? {}
          : null
      result[field] = parseJson(result[field], fallback)
    }
    for (const field of BOOLEAN_FIELDS) {
      result[field] = field === 'schedulable' ? result[field] !== 'false' : isTruthy(result[field])
    }
    for (const field of SENSITIVE_FIELDS) {
      const encrypted = result[field]
      if (includeSecrets) {
        result[field] = encryptor.decrypt(encrypted)
      } else {
        result[`has${field[0].toUpperCase()}${field.slice(1)}`] = Boolean(encrypted)
        delete result[field]
      }
    }
    result.priority = Number(result.priority) || 50
    result.concurrency = Math.max(1, Number(result.concurrency) || 1)
    result.platform = 'grok'
    return result
  }

  async createAccount(options = {}) {
    const authType = options.authType === 'api_key' ? 'api_key' : 'oauth'
    if (authType === 'api_key' && !options.apiKey) {
      throw new Error('xAI API key is required')
    }
    if (authType === 'oauth' && (!options.accessToken || !options.refreshToken)) {
      throw new Error('OAuth access token and refresh token are required')
    }
    const accountType = ['shared', 'dedicated', 'group'].includes(options.accountType)
      ? options.accountType
      : 'shared'
    const id = uuidv4()
    const now = new Date().toISOString()
    const data = this._serialize({
      id,
      platform: 'grok',
      name: options.name || 'Grok Account',
      description: options.description || '',
      authType,
      accountType,
      accessToken: authType === 'oauth' ? options.accessToken : '',
      refreshToken: authType === 'oauth' ? options.refreshToken : '',
      idToken: authType === 'oauth' ? options.idToken || '' : '',
      apiKey: authType === 'api_key' ? options.apiKey : '',
      tokenType: options.tokenType || 'Bearer',
      expiresAt: options.expiresAt || '',
      scope: options.scope || '',
      email: options.email || options.accountInfo?.email || '',
      subject: options.subject || options.accountInfo?.subject || '',
      teamId: options.teamId || options.accountInfo?.teamId || '',
      subscriptionTier: options.subscriptionTier || options.accountInfo?.subscriptionTier || '',
      entitlementStatus: options.entitlementStatus || options.accountInfo?.entitlementStatus || '',
      priority: Number(options.priority) || 50,
      concurrency: Math.max(1, Number(options.concurrency) || (authType === 'oauth' ? 1 : 5)),
      proxy: options.proxy || null,
      supportedModels: options.supportedModels || [],
      modelMapping: options.modelMapping || {},
      groupIds: options.groupIds || [],
      isActive: options.isActive !== false,
      schedulable: options.schedulable !== false,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      lastUsedAt: '',
      lastRefreshAt: '',
      lastErrorAt: '',
      lastErrorMessage: '',
      rateLimitStatus: '',
      rateLimitResetAt: '',
      tempUnavailableUntil: '',
      tempUnavailableReason: '',
      totalUsedTokens: '0',
      rateLimitSnapshot: null,
      billingSnapshot: null
    })
    await redis.setGrokAccount(id, data)
    return this.getSafeAccount(id)
  }

  async getAccount(accountId) {
    return this._deserialize(await redis.getGrokAccount(accountId), true)
  }

  async getSafeAccount(accountId) {
    return this._deserialize(await redis.getGrokAccount(accountId), false)
  }

  async getAllAccounts(includeInactive = false) {
    const accounts = await redis.getAllGrokAccounts()
    return accounts
      .map((account) => this._deserialize(account, false))
      .filter((account) => account && (includeInactive || account.isActive))
  }

  async updateAccount(accountId, updates = {}) {
    const existing = await redis.getGrokAccount(accountId)
    if (!existing || !Object.keys(existing).length) {
      throw new Error('Grok account not found')
    }
    const allowed = [
      'name',
      'description',
      'accountType',
      'accessToken',
      'refreshToken',
      'idToken',
      'apiKey',
      'tokenType',
      'expiresAt',
      'scope',
      'email',
      'subject',
      'teamId',
      'subscriptionTier',
      'entitlementStatus',
      'priority',
      'concurrency',
      'proxy',
      'supportedModels',
      'modelMapping',
      'groupIds',
      'isActive',
      'schedulable',
      'status',
      'lastUsedAt',
      'lastRefreshAt',
      'lastErrorAt',
      'lastErrorMessage',
      'rateLimitStatus',
      'rateLimitResetAt',
      'tempUnavailableUntil',
      'tempUnavailableReason',
      'totalUsedTokens',
      'rateLimitSnapshot',
      'billingSnapshot'
    ]
    const filtered = {}
    for (const field of allowed) {
      if (updates[field] !== undefined && !(SENSITIVE_FIELDS.has(field) && !updates[field])) {
        filtered[field] = updates[field]
      }
    }
    filtered.updatedAt = new Date().toISOString()
    await redis.setGrokAccount(accountId, this._serialize(filtered))
    if (Object.keys(filtered).some((field) => SENSITIVE_FIELDS.has(field))) {
      encryptor.clearCache()
    }
    return this.getSafeAccount(accountId)
  }

  async deleteAccount(accountId) {
    encryptor.clearCache()
    await upstreamErrorHelper.clearTempUnavailable(accountId, 'grok').catch(() => {})
    return redis.deleteGrokAccount(accountId)
  }

  async getSchedulableAccounts(mappedModel = '') {
    const accounts = await this.getAllAccounts(false)
    return accounts.filter((account) => {
      const modelAllowed =
        !mappedModel ||
        !account.supportedModels?.length ||
        account.supportedModels.includes(mappedModel)
      return (
        account.schedulable &&
        account.status !== 'error' &&
        account.status !== 'blocked' &&
        modelAllowed
      )
    })
  }

  async getValidAccessToken(accountId, forceRefresh = false) {
    let account = await this.getAccount(accountId)
    if (!account) {
      throw new Error('Grok account not found')
    }
    if (account.authType === 'api_key') {
      if (!account.apiKey) {
        throw new Error('Grok API key is missing')
      }
      return account.apiKey
    }
    const expiresAt = Date.parse(account.expiresAt || '')
    if (!forceRefresh && account.accessToken && expiresAt - Date.now() > 5 * 60 * 1000) {
      return account.accessToken
    }

    const acquired = await tokenRefreshService.acquireRefreshLock(accountId, 'grok')
    if (!acquired) {
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        account = await this.getAccount(accountId)
        const refreshedExpiry = Date.parse(account?.expiresAt || '')
        if (account?.accessToken && refreshedExpiry - Date.now() > 5 * 60 * 1000) {
          return account.accessToken
        }
      }
      throw new Error('Grok token refresh is already in progress')
    }

    try {
      account = await this.getAccount(accountId)
      const refreshedExpiry = Date.parse(account?.expiresAt || '')
      if (!forceRefresh && account.accessToken && refreshedExpiry - Date.now() > 5 * 60 * 1000) {
        return account.accessToken
      }
      const tokens = await grokOAuthService.refreshTokens(account.refreshToken, account.proxy)
      await this.updateAccount(accountId, {
        ...tokens,
        ...tokens.accountInfo,
        lastRefreshAt: new Date().toISOString(),
        status: 'active',
        lastErrorMessage: ''
      })
      return tokens.accessToken
    } catch (error) {
      const invalidGrant =
        error.response?.data?.error === 'invalid_grant' || /invalid[_ ]grant/i.test(error.message)
      if (invalidGrant) {
        await this.updateAccount(accountId, {
          status: 'unauthorized',
          schedulable: false,
          lastErrorAt: new Date().toISOString(),
          lastErrorMessage: 'OAuth refresh token is no longer valid'
        })
        error.code = 'GROK_REAUTH_REQUIRED'
        error.statusCode = 401
      }
      throw error
    } finally {
      await tokenRefreshService.releaseRefreshLock(accountId, 'grok')
    }
  }

  async reauthorize(accountId, tokens) {
    const existing = await this.getAccount(accountId)
    if (!existing) {
      throw new Error('Grok account not found')
    }
    await this.updateAccount(accountId, {
      ...tokens,
      ...tokens.accountInfo,
      schedulable: existing.schedulable,
      status: 'active',
      lastRefreshAt: new Date().toISOString(),
      lastErrorAt: '',
      lastErrorMessage: '',
      rateLimitStatus: '',
      rateLimitResetAt: '',
      tempUnavailableUntil: '',
      tempUnavailableReason: ''
    })
    await upstreamErrorHelper.clearTempUnavailable(accountId, 'grok')
    return this.getSafeAccount(accountId)
  }

  async toggleSchedulable(accountId) {
    const account = await this.getAccount(accountId)
    if (!account) {
      throw new Error('Grok account not found')
    }
    return this.updateAccount(accountId, { schedulable: !account.schedulable })
  }

  async resetAccountStatus(accountId) {
    await upstreamErrorHelper.clearTempUnavailable(accountId, 'grok')
    return this.updateAccount(accountId, {
      status: 'active',
      rateLimitStatus: '',
      rateLimitResetAt: '',
      tempUnavailableUntil: '',
      tempUnavailableReason: '',
      lastErrorAt: '',
      lastErrorMessage: ''
    })
  }

  async markTemporaryStatus(accountId, statusCode, expiresAt, reason, options = {}) {
    const persistentCredentialError = options.persistentCredentialError === true
    return this.updateAccount(accountId, {
      status: statusCode === 401 ? 'unauthorized' : statusCode === 402 ? 'billing_error' : 'active',
      ...(persistentCredentialError ? { schedulable: false } : {}),
      rateLimitStatus: statusCode === 429 ? 'limited' : '',
      rateLimitResetAt: statusCode === 429 ? expiresAt : '',
      tempUnavailableUntil: expiresAt || '',
      tempUnavailableReason: reason || '',
      lastErrorAt: new Date().toISOString(),
      lastErrorMessage: reason || `Upstream returned ${statusCode}`
    })
  }

  async clearExpiredTemporaryStatus(accountId) {
    const account = await this.getAccount(accountId)
    if (!account) {
      return false
    }
    const expiresAt = Date.parse(account.tempUnavailableUntil || account.rateLimitResetAt || '')
    if (!Number.isFinite(expiresAt) || expiresAt > Date.now()) {
      return false
    }
    await this.updateAccount(accountId, {
      status: account.status === 'unauthorized' && !account.schedulable ? 'unauthorized' : 'active',
      rateLimitStatus: '',
      rateLimitResetAt: '',
      tempUnavailableUntil: '',
      tempUnavailableReason: '',
      lastErrorMessage:
        account.status === 'unauthorized' && !account.schedulable ? account.lastErrorMessage : ''
    })
    return true
  }

  async touchUsage(accountId, tokenCount = 0) {
    const account = await this.getAccount(accountId)
    if (!account) {
      return
    }
    await this.updateAccount(accountId, {
      lastUsedAt: new Date().toISOString(),
      totalUsedTokens: (
        Number(account.totalUsedTokens) + Math.max(0, Number(tokenCount) || 0)
      ).toString()
    })
  }

  async updateRateLimitSnapshot(accountId, snapshot) {
    if (snapshot) {
      await this.updateAccount(accountId, { rateLimitSnapshot: snapshot })
    }
  }

  async updateBillingSnapshot(accountId, snapshot) {
    if (snapshot) {
      await this.updateAccount(accountId, { billingSnapshot: snapshot })
    }
  }

  async syncModels(accountId) {
    const account = await this.getAccount(accountId)
    if (!account || account.authType !== 'api_key') {
      throw new Error('Model sync is only available for xAI API key accounts')
    }
    const headers = buildGrokUpstreamHeaders({ authType: 'api_key', token: account.apiKey })
    const options = {
      headers,
      timeout: 30000,
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 300
    }
    const agent = ProxyHelper.createProxyAgent(account.proxy)
    if (agent) {
      options.httpAgent = agent
      options.httpsAgent = agent
      options.proxy = false
    }
    const base = new URL(config.grok.apiBaseUrl)
    base.pathname = `${base.pathname.replace(/\/$/, '')}/models`
    const response = await axios.get(base.toString(), options)
    const models = (response.data?.data || [])
      .map((model) => model?.id)
      .filter(
        (id) =>
          typeof id === 'string' &&
          id.startsWith('grok-') &&
          !/(imagine|image|video|vision)/i.test(id)
      )
    const supportedModels = [...new Set(models)]
    if (!supportedModels.length) {
      throw new Error('xAI returned no supported Grok text models')
    }
    await this.updateAccount(accountId, { supportedModels })
    return supportedModels
  }
}

module.exports = new GrokAccountService()
