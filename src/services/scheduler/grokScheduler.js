const redis = require('../../models/redis')
const logger = require('../../utils/logger')
const accountGroupService = require('../accountGroupService')
const grokAccountService = require('../account/grokAccountService')
const upstreamErrorHelper = require('../../utils/upstreamErrorHelper')
const { sortAccountsByPriority } = require('../../utils/commonHelper')
const {
  normalizeGrokModelName,
  resolveGrokModel,
  isAccountSupportedGrokModel,
  hasValidGrokPricing
} = require('../../utils/grokModelHelper')

class GrokScheduler {
  _stickyKey(apiKeyId, mappedModel, sessionHash) {
    return sessionHash ? `grok:${apiKeyId || 'unknown'}:${mappedModel}:${sessionHash}` : ''
  }

  async _loadBoundCandidates(apiKeyData) {
    const binding = apiKeyData?.grokAccountId
    if (!binding) {
      return { candidates: [], mode: 'shared' }
    }
    if (binding.startsWith('group:')) {
      const groupId = binding.slice('group:'.length)
      const group = await accountGroupService.getGroup(groupId)
      if (!group || group.platform !== 'grok') {
        return { candidates: [], mode: 'group' }
      }
      const ids = await accountGroupService.getGroupMembers(groupId)
      const candidates = await Promise.all(ids.map((id) => grokAccountService.getSafeAccount(id)))
      return { candidates: candidates.filter(Boolean), mode: 'group' }
    }
    const account = await grokAccountService.getSafeAccount(binding)
    return { candidates: account ? [account] : [], mode: 'dedicated' }
  }

  _evaluateModel(account, requestedModel, restrictedModels = []) {
    const mappedModel = resolveGrokModel(requestedModel, account?.modelMapping)
    const normalizedMappedModel = normalizeGrokModelName(mappedModel)
    const normalizedSupportedModels = Array.isArray(account?.supportedModels)
      ? account.supportedModels.map(normalizeGrokModelName)
      : []
    if (restrictedModels.includes(requestedModel) || restrictedModels.includes(mappedModel)) {
      return { compatible: false, mappedModel, reason: 'restricted' }
    }
    if (!isAccountSupportedGrokModel(mappedModel, account)) {
      return { compatible: false, mappedModel, reason: 'model' }
    }
    if (!hasValidGrokPricing(mappedModel)) {
      return { compatible: false, mappedModel, reason: 'pricing' }
    }
    if (
      normalizedSupportedModels.length &&
      !normalizedSupportedModels.includes(normalizedMappedModel)
    ) {
      return { compatible: false, mappedModel, reason: 'model' }
    }
    return { compatible: true, mappedModel, reason: '' }
  }

  async _isAvailable(account, excluded) {
    if (
      !account ||
      excluded.has(account.id) ||
      account.isActive !== true ||
      account.schedulable !== true ||
      ['error', 'blocked'].includes(account.status)
    ) {
      return false
    }
    return !(await upstreamErrorHelper.isTempUnavailable(account.id, 'grok'))
  }

  async _evaluateCandidates(candidates, requestedModel, restrictedModels, excluded) {
    const evaluated = candidates.map((account) => ({
      account,
      ...this._evaluateModel(account, requestedModel, restrictedModels)
    }))
    const available = (
      await Promise.all(
        evaluated.map(async (entry) =>
          entry.compatible && (await this._isAvailable(entry.account, excluded)) ? entry : null
        )
      )
    ).filter(Boolean)
    return { evaluated, available }
  }

  async _reserve(account, requestId) {
    const key = `grok_account:${account.id}`
    const count = await redis.incrConcurrency(key, requestId)
    if (count > Math.max(1, Number(account.concurrency) || 1)) {
      await redis.decrConcurrency(key, requestId)
      return false
    }
    return true
  }

  async selectAccount({
    apiKeyData,
    requestedModel,
    mappedModel,
    sessionHash,
    excluded = new Set(),
    requestId
  }) {
    const requested = requestedModel || mappedModel
    const restrictedModels =
      apiKeyData?.enableModelRestriction && Array.isArray(apiKeyData.restrictedModels)
        ? apiKeyData.restrictedModels
        : []
    const binding = await this._loadBoundCandidates(apiKeyData)
    let { candidates } = binding
    if (!candidates.length && binding.mode !== 'group') {
      const all = await grokAccountService.getSchedulableAccounts()
      candidates = all.filter((account) => account.accountType === 'shared')
    }

    let evaluation = await this._evaluateCandidates(
      candidates,
      requested,
      restrictedModels,
      excluded
    )
    let available = evaluation.available
    let evaluated = evaluation.evaluated
    if (!available.length && binding.mode === 'dedicated') {
      const shared = (await grokAccountService.getSchedulableAccounts()).filter(
        (account) => account.accountType === 'shared'
      )
      evaluation = await this._evaluateCandidates(shared, requested, restrictedModels, excluded)
      available = evaluation.available
      evaluated = [...evaluated, ...evaluation.evaluated]
    }
    if (!available.length) {
      const hasCompatibleModel = evaluated.some((entry) => entry.compatible)
      const hasRestrictedModel = evaluated.some((entry) => entry.reason === 'restricted')
      const hasPricingFailure = evaluated.some((entry) => entry.reason === 'pricing')
      if (!hasCompatibleModel && hasRestrictedModel) {
        const error = new Error(`Grok model ${requested} is not allowed for this API key`)
        error.code = 'GROK_MODEL_NOT_ALLOWED'
        throw error
      }
      if (!hasCompatibleModel && hasPricingFailure) {
        const error = new Error(`Pricing is unavailable for Grok model ${requested}`)
        error.code = 'GROK_PRICING_UNAVAILABLE'
        throw error
      }
      if (evaluated.length && !hasCompatibleModel) {
        const error = new Error(
          `Grok model ${requested} was not found for the selected account pool`
        )
        error.code = 'GROK_MODEL_NOT_FOUND'
        throw error
      }
      const error = new Error('No schedulable Grok account is available')
      error.code = 'NO_GROK_ACCOUNT'
      throw error
    }

    const routingModel = normalizeGrokModelName(requested) || String(requested || '').toLowerCase()
    const stickyKey = this._stickyKey(apiKeyData?.id, routingModel, sessionHash)
    const stickyAccountId = stickyKey ? await redis.getSessionAccountMapping(stickyKey) : ''
    const mappedByAccountId = new Map(
      available.map((entry) => [entry.account.id, entry.mappedModel])
    )
    const sorted = sortAccountsByPriority(available.map((entry) => entry.account))
    if (stickyAccountId) {
      const stickyIndex = sorted.findIndex((account) => account.id === stickyAccountId)
      if (stickyIndex > 0) {
        sorted.unshift(sorted.splice(stickyIndex, 1)[0])
      }
    }

    for (const account of sorted) {
      if (!(await this._reserve(account, requestId))) {
        continue
      }
      try {
        if (stickyKey) {
          if (stickyAccountId === account.id) {
            await redis.extendSessionAccountMappingTTL(stickyKey)
          } else {
            await redis.setSessionAccountMapping(stickyKey, account.id)
          }
        }
      } catch (error) {
        await redis.decrConcurrency(`grok_account:${account.id}`, requestId).catch(() => {})
        throw error
      }
      logger.info(
        `Selected Grok account ${account.name || account.id} for ${mappedByAccountId.get(account.id)} (${binding.mode})`
      )
      return {
        account,
        mappedModel: mappedByAccountId.get(account.id),
        stickyKey,
        reservationKey: `grok_account:${account.id}`
      }
    }

    const error = new Error('All matching Grok accounts are at their concurrency limit')
    error.code = 'GROK_CONCURRENCY_FULL'
    throw error
  }

  async releaseAccount(selection, requestId) {
    if (selection?.reservationKey) {
      await redis.decrConcurrency(selection.reservationKey, requestId).catch((error) => {
        logger.warn(`Failed to release Grok account concurrency: ${error.message}`)
      })
    }
  }

  async clearSticky(selection) {
    if (selection?.stickyKey) {
      await redis.deleteSessionAccountMapping(selection.stickyKey).catch(() => {})
    }
  }
}

module.exports = new GrokScheduler()
