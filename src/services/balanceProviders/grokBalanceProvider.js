const BaseBalanceProvider = require('./baseBalanceProvider')
const grokQuotaService = require('../grokQuotaService')

class GrokBalanceProvider extends BaseBalanceProvider {
  constructor() {
    super('grok')
  }

  async queryBalance(account) {
    if (account?.authType !== 'oauth') {
      return {
        balance: null,
        currency: 'USD',
        quota: null,
        queryMethod: 'local',
        rawData: { rateLimit: account?.rateLimitSnapshot || null }
      }
    }
    const result = await grokQuotaService.queryBilling(account.id)
    const billing = result.billing
    return {
      balance: null,
      currency: 'USD',
      quota: billing
        ? {
            percentage: billing.usagePercent,
            resetAt: billing.periodEnd || null,
            periodType: billing.periodType || null,
            monthlyPercentage: billing.usedPercent,
            monthlyResetAt: billing.billingPeriodEnd || null
          }
        : null,
      queryMethod: 'api',
      rawData: result
    }
  }
}

module.exports = GrokBalanceProvider
