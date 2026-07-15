const axios = require('axios')
const config = require('../../config/config')
const ProxyHelper = require('../utils/proxyHelper')
const grokAccountService = require('./account/grokAccountService')
const { buildGrokUpstreamUrl, buildGrokUpstreamHeaders } = require('../utils/grokRequestHelper')
const { parseQuotaHeaders } = require('../utils/grokQuotaHelper')

const parseFinite = (value) => {
  if (value === undefined || value === null || value === '') {
    return null
  }
  if (typeof value === 'object') {
    value = value.cents ?? value.amount ?? value.value
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const normalizeBillingPayload = (payload) => {
  const data = payload?.config
  if (!data || typeof data !== 'object') {
    return null
  }
  const period = data.currentPeriod || {}
  const usagePercent = parseFinite(data.creditUsagePercent)
  const monthlyLimitCents = parseFinite(data.monthlyLimit)
  const usedCents = parseFinite(data.used)
  const includedUsedCents =
    usedCents === null
      ? null
      : monthlyLimitCents !== null && monthlyLimitCents > 0
        ? Math.min(usedCents, monthlyLimitCents)
        : usedCents
  const usedPercent =
    monthlyLimitCents !== null && monthlyLimitCents > 0 && includedUsedCents !== null
      ? (includedUsedCents / monthlyLimitCents) * 100
      : null
  const productUsage = Array.isArray(data.productUsage)
    ? data.productUsage
        .filter((item) => item?.product)
        .map((item) => ({
          product: String(item.product),
          usagePercent: parseFinite(item.usagePercent)
        }))
    : []
  if (
    usagePercent === null &&
    monthlyLimitCents === null &&
    usedCents === null &&
    !productUsage.length &&
    !period.start &&
    !data.billingPeriodEnd
  ) {
    return null
  }
  let plan = ''
  if (monthlyLimitCents === 15000) {
    plan = 'SuperGrok'
  } else if (monthlyLimitCents === 150000) {
    plan = 'SuperGrok Heavy'
  }
  return {
    periodType: period.type || (usagePercent !== null ? 'weekly' : 'monthly'),
    usagePercent,
    periodStart: period.start || data.billingPeriodStart || '',
    periodEnd: period.end || data.billingPeriodEnd || '',
    productUsage,
    monthlyLimitCents,
    usedCents,
    includedUsedCents,
    billingPeriodStart: data.billingPeriodStart || '',
    billingPeriodEnd: data.billingPeriodEnd || '',
    usedPercent,
    plan
  }
}

const mergeBilling = (previous, weekly, monthly, weeklyOk, monthlyOk) => {
  const result = { ...(previous || {}) }
  const now = new Date().toISOString()
  if (weeklyOk && weekly) {
    Object.assign(result, {
      periodType: weekly.periodType,
      usagePercent: weekly.usagePercent,
      periodStart: weekly.periodStart,
      periodEnd: weekly.periodEnd,
      productUsage: weekly.productUsage,
      weeklyUpdatedAt: now
    })
  }
  if (monthlyOk && monthly) {
    Object.assign(result, {
      monthlyLimitCents: monthly.monthlyLimitCents,
      usedCents: monthly.usedCents,
      includedUsedCents: monthly.includedUsedCents,
      billingPeriodStart: monthly.billingPeriodStart,
      billingPeriodEnd: monthly.billingPeriodEnd,
      usedPercent: monthly.usedPercent,
      plan: monthly.plan,
      monthlyUpdatedAt: now
    })
  }
  result.partial = !weeklyOk || !monthlyOk
  result.failedWindows = [!weeklyOk ? 'weekly' : null, !monthlyOk ? 'monthly' : null].filter(
    Boolean
  )
  result.source = 'billing_probe'
  result.observedAt = now
  return result
}

class GrokQuotaService {
  _axiosOptions(account, token, responseType = 'json') {
    const options = {
      headers: buildGrokUpstreamHeaders({ authType: account.authType, token }),
      timeout: Math.min(30000, config.requestTimeout),
      maxRedirects: 0,
      responseType,
      validateStatus: () => true
    }
    const agent = ProxyHelper.createProxyAgent(account.proxy)
    if (agent) {
      options.httpAgent = agent
      options.httpsAgent = agent
      options.proxy = false
    }
    return options
  }

  async observeResponse(accountId, headers, statusCode, source = 'inference') {
    const snapshot = parseQuotaHeaders(headers, statusCode, source)
    if (!snapshot) {
      return null
    }
    const account = await grokAccountService.getSafeAccount(accountId)
    const previous = account?.rateLimitSnapshot || null
    const merged = {
      ...(previous || {}),
      ...snapshot,
      requests: snapshot.requests || previous?.requests || null,
      tokens: snapshot.tokens || previous?.tokens || null,
      headers: { ...(previous?.headers || {}), ...(snapshot.headers || {}) }
    }
    const previousObservedAt = Date.parse(previous?.observedAt || '')
    const resetIsActive = [merged.requests, merged.tokens].some((window) => {
      const resetAt = Date.parse(window?.resetAt || '')
      return Number.isFinite(resetAt) && resetAt > Date.now()
    })
    const exhausted = [merged.requests, merged.tokens].some((window) => window?.remaining === 0)
    const critical = statusCode === 429 || exhausted || resetIsActive
    const stale = !Number.isFinite(previousObservedAt) || Date.now() - previousObservedAt >= 60000
    if (critical || stale) {
      await grokAccountService.updateRateLimitSnapshot(accountId, merged)
    }
    return merged
  }

  async queryBilling(accountId) {
    const account = await grokAccountService.getAccount(accountId)
    if (!account) {
      throw new Error('Grok account not found')
    }
    if (account.authType !== 'oauth') {
      return {
        billing: null,
        rateLimit: account.rateLimitSnapshot,
        source: 'passive_headers'
      }
    }
    const token = await grokAccountService.getValidAccessToken(accountId)
    const options = this._axiosOptions(account, token)
    options.headers.Accept = 'application/json'
    const base = new URL(config.grok.cliBaseUrl)
    base.pathname = `${base.pathname.replace(/\/$/, '')}/billing`
    const monthlyUrl = base.toString()
    base.searchParams.set('format', 'credits')
    const weeklyUrl = base.toString()
    const [weeklyResult, monthlyResult] = await Promise.allSettled([
      axios.get(weeklyUrl, options),
      axios.get(monthlyUrl, options)
    ])
    const weeklyResponse = weeklyResult.status === 'fulfilled' ? weeklyResult.value : null
    const monthlyResponse = monthlyResult.status === 'fulfilled' ? monthlyResult.value : null
    const weeklyOk = Boolean(weeklyResponse && weeklyResponse.status < 400)
    const monthlyOk = Boolean(monthlyResponse && monthlyResponse.status < 400)
    const weekly = weeklyOk ? normalizeBillingPayload(weeklyResponse.data) : null
    const monthly = monthlyOk ? normalizeBillingPayload(monthlyResponse.data) : null
    if (!weekly && !monthly) {
      const status =
        [weeklyResponse?.status, monthlyResponse?.status].find((value) => value >= 400) || 502
      const error = new Error(`xAI billing endpoints returned no usable data (${status})`)
      error.statusCode = status
      throw error
    }
    const billing = mergeBilling(
      account.billingSnapshot,
      weekly,
      monthly,
      Boolean(weekly),
      Boolean(monthly)
    )
    await grokAccountService.updateBillingSnapshot(accountId, billing)
    return {
      billing,
      rateLimit: account.rateLimitSnapshot,
      source: billing.partial ? 'partial_billing' : 'billing'
    }
  }

  async queryQuota(accountId) {
    return this.queryBilling(accountId)
  }

  async testAccount(accountId, model = 'grok-4.5') {
    const account = await grokAccountService.getAccount(accountId)
    if (!account) {
      throw new Error('Grok account not found')
    }
    const token = await grokAccountService.getValidAccessToken(accountId)
    const response = await axios.post(
      buildGrokUpstreamUrl(account.authType),
      { model, input: '.', max_output_tokens: 1, store: false, stream: false },
      this._axiosOptions(account, token)
    )
    const rateLimit = await this.observeResponse(
      accountId,
      response.headers,
      response.status,
      'active_probe'
    )
    if (response.status >= 400) {
      const error = new Error(
        response.data?.error?.message || response.data?.detail || `xAI returned ${response.status}`
      )
      error.statusCode = response.status
      error.responseData = response.data
      throw error
    }
    return {
      statusCode: response.status,
      model: response.data?.model || model,
      responseId: response.data?.id || '',
      rateLimit
    }
  }
}

module.exports = new GrokQuotaService()
module.exports.normalizeBillingPayload = normalizeBillingPayload
module.exports.mergeBilling = mergeBilling
