const express = require('express')
const { authenticateAdmin } = require('../../middleware/auth')
const logger = require('../../utils/logger')
const redis = require('../../models/redis')
const apiKeyService = require('../../services/apiKeyService')
const accountGroupService = require('../../services/accountGroupService')
const grokOAuthService = require('../../services/grokOAuthService')
const grokQuotaService = require('../../services/grokQuotaService')
const grokAccountService = require('../../services/account/grokAccountService')
const accountTestSchedulerService = require('../../services/accountTestSchedulerService')
const { GROK_TEST_MODELS } = require('../../../config/models')

const router = express.Router()

const normalizeOAuthTokens = (body = {}) => {
  const source = body.tokens || body.grokOauth || body.oauth || body
  return {
    accessToken: source.accessToken || source.access_token || '',
    refreshToken: source.refreshToken || source.refresh_token || '',
    idToken: source.idToken || source.id_token || '',
    tokenType: source.tokenType || source.token_type || 'Bearer',
    expiresAt:
      source.expiresAt ||
      (Number(source.expires_in) > 0
        ? new Date(Date.now() + Number(source.expires_in) * 1000).toISOString()
        : ''),
    scope: source.scope || '',
    accountInfo: source.accountInfo || body.accountInfo || {}
  }
}

router.post('/grok-accounts/generate-auth-url', authenticateAdmin, async (req, res) => {
  try {
    const data = await grokOAuthService.generateAuthorizationSession(req.body?.proxy || null)
    return res.json({ success: true, data })
  } catch (error) {
    logger.error('Failed to generate Grok OAuth URL:', error.message)
    return res.status(500).json({ success: false, error: 'Failed to generate authorization URL' })
  }
})

router.post('/grok-accounts/exchange-code', authenticateAdmin, async (req, res) => {
  try {
    const { sessionId } = req.body || {}
    const input = req.body?.code || req.body?.callbackUrl || req.body?.input
    if (!sessionId || !input) {
      return res.status(400).json({ success: false, error: 'Session ID and code are required' })
    }
    const tokens = await grokOAuthService.exchangeCode(sessionId, input)
    return res.json({ success: true, data: { tokens, accountInfo: tokens.accountInfo } })
  } catch (error) {
    logger.warn(`Grok OAuth exchange failed: ${error.message}`)
    return res.status(400).json({ success: false, error: error.message })
  }
})

router.post('/grok-accounts/validate-refresh-token', authenticateAdmin, async (req, res) => {
  try {
    const { refreshToken, proxy } = req.body || {}
    const tokens = await grokOAuthService.validateRefreshToken(refreshToken, proxy || null)
    return res.json({ success: true, data: { tokens, accountInfo: tokens.accountInfo } })
  } catch (error) {
    logger.warn(`Grok refresh token validation failed: ${error.message}`)
    return res.status(400).json({ success: false, error: 'Refresh token validation failed' })
  }
})

router.get('/grok-accounts', authenticateAdmin, async (req, res) => {
  try {
    const accounts = await grokAccountService.getAllAccounts(true)
    const accountIds = accounts.map((account) => account.id)
    const [apiKeys, groupMap, dailyCostMap] = await Promise.all([
      apiKeyService.getAllApiKeysLite(),
      accountGroupService.batchGetAccountGroupsByIndex(accountIds, 'grok'),
      redis.batchGetAccountDailyCost(accountIds)
    ])
    const directBindings = new Map()
    const groupBindings = new Map()
    for (const key of apiKeys) {
      const binding = key.grokAccountId
      if (!binding) {
        continue
      }
      if (binding.startsWith('group:')) {
        const groupId = binding.slice('group:'.length)
        groupBindings.set(groupId, (groupBindings.get(groupId) || 0) + 1)
      } else {
        directBindings.set(binding, (directBindings.get(binding) || 0) + 1)
      }
    }
    const client = redis.getClientSafe()
    const today = redis.getDateStringInTimezone()
    const pipeline = client.pipeline()
    accountIds.forEach((id) => {
      pipeline.hgetall(`account_usage:${id}`)
      pipeline.hgetall(`account_usage:daily:${id}:${today}`)
    })
    const stats = await pipeline.exec()
    const parseUsage = (value) => ({
      requests: Number(value?.totalRequests || value?.requests) || 0,
      tokens: Number(value?.totalTokens || value?.tokens) || 0,
      inputTokens: Number(value?.totalInputTokens || value?.inputTokens) || 0,
      outputTokens: Number(value?.totalOutputTokens || value?.outputTokens) || 0,
      cacheCreateTokens: Number(value?.totalCacheCreateTokens || value?.cacheCreateTokens) || 0,
      cacheReadTokens: Number(value?.totalCacheReadTokens || value?.cacheReadTokens) || 0
    })
    const data = accounts.map((account, index) => {
      const groups = groupMap.get(account.id) || []
      let boundApiKeysCount = directBindings.get(account.id) || 0
      groups.forEach((group) => {
        boundApiKeysCount += groupBindings.get(group.id) || 0
      })
      return {
        ...account,
        groupInfos: groups,
        boundApiKeysCount,
        usage: {
          total: parseUsage(stats[index * 2]?.[1]),
          daily: {
            ...parseUsage(stats[index * 2 + 1]?.[1]),
            cost: dailyCostMap.get(account.id) || 0
          }
        }
      }
    })
    return res.json({ success: true, data })
  } catch (error) {
    logger.error('Failed to list Grok accounts:', error)
    return res.status(500).json({ success: false, error: 'Failed to list Grok accounts' })
  }
})

router.get('/grok-accounts/:id', authenticateAdmin, async (req, res) => {
  const account = await grokAccountService.getSafeAccount(req.params.id)
  if (!account) {
    return res.status(404).json({ success: false, error: 'Grok account not found' })
  }
  return res.json({ success: true, data: account })
})

router.post('/grok-accounts', authenticateAdmin, async (req, res) => {
  try {
    const body = { ...(req.body || {}) }
    if (
      body.priority !== undefined &&
      !(Number(body.priority) >= 1 && Number(body.priority) <= 100)
    ) {
      return res.status(400).json({ success: false, error: 'Priority must be between 1 and 100' })
    }
    if (
      body.concurrency !== undefined &&
      !(
        Number.isFinite(Number(body.concurrency)) &&
        Number.isInteger(Number(body.concurrency)) &&
        Number(body.concurrency) >= 1
      )
    ) {
      return res.status(400).json({ success: false, error: 'Concurrency must be at least 1' })
    }
    if (body.authType !== 'api_key') {
      Object.assign(body, normalizeOAuthTokens(body))
    }
    const account = await grokAccountService.createAccount(body)
    const groupIds = Array.isArray(body.groupIds)
      ? body.groupIds
      : body.groupId
        ? [body.groupId]
        : []
    if (groupIds.length) {
      await accountGroupService.setAccountGroups(account.id, groupIds, 'grok')
    }
    return res.status(201).json({ success: true, data: account })
  } catch (error) {
    logger.warn(`Failed to create Grok account: ${error.message}`)
    return res.status(400).json({ success: false, error: error.message })
  }
})

router.put('/grok-accounts/:id', authenticateAdmin, async (req, res) => {
  try {
    const updates = { ...(req.body || {}) }
    const groupIds = Array.isArray(updates.groupIds)
      ? updates.groupIds
      : updates.groupId
        ? [updates.groupId]
        : updates.accountType !== undefined && updates.accountType !== 'group'
          ? []
          : undefined
    delete updates.groupId
    if (Array.isArray(groupIds)) {
      updates.groupIds = groupIds
    } else {
      delete updates.groupIds
    }
    delete updates.tokens
    delete updates.grokOauth
    if (
      updates.priority !== undefined &&
      !(Number(updates.priority) >= 1 && Number(updates.priority) <= 100)
    ) {
      return res.status(400).json({ success: false, error: 'Priority must be between 1 and 100' })
    }
    if (
      updates.concurrency !== undefined &&
      !(
        Number.isFinite(Number(updates.concurrency)) &&
        Number.isInteger(Number(updates.concurrency)) &&
        Number(updates.concurrency) >= 1
      )
    ) {
      return res.status(400).json({ success: false, error: 'Concurrency must be at least 1' })
    }
    const account = await grokAccountService.updateAccount(req.params.id, updates)
    if (groupIds) {
      await accountGroupService.setAccountGroups(req.params.id, groupIds, 'grok')
    }
    return res.json({ success: true, data: account })
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message })
  }
})

router.delete('/grok-accounts/:id', authenticateAdmin, async (req, res) => {
  try {
    const account = await grokAccountService.getSafeAccount(req.params.id)
    if (!account) {
      return res.status(404).json({ success: false, error: 'Grok account not found' })
    }
    const unboundKeys = await apiKeyService.unbindAccountFromAllKeys(req.params.id, 'grok')
    await accountGroupService.removeAccountFromAllGroups(req.params.id, 'grok')
    await grokAccountService.deleteAccount(req.params.id)
    return res.json({ success: true, unboundKeys })
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message })
  }
})

router.post('/grok-accounts/:id/toggle-schedulable', authenticateAdmin, async (req, res) => {
  try {
    const account = await grokAccountService.toggleSchedulable(req.params.id)
    return res.json({
      success: true,
      schedulable: account.schedulable,
      data: account
    })
  } catch (error) {
    return res.status(404).json({ success: false, error: error.message })
  }
})

router.post('/grok-accounts/:id/reset-status', authenticateAdmin, async (req, res) => {
  try {
    return res.json({
      success: true,
      data: await grokAccountService.resetAccountStatus(req.params.id)
    })
  } catch (error) {
    return res.status(404).json({ success: false, error: error.message })
  }
})

router.post('/grok-accounts/:id/test', authenticateAdmin, async (req, res) => {
  try {
    const model = req.body?.model || GROK_TEST_MODELS[0].value
    const result = await accountTestSchedulerService.triggerTest(req.params.id, 'grok', model)
    if (!result?.success) {
      return res.status(502).json({ success: false, error: result?.error || 'Grok test failed' })
    }
    return res.json({ success: true, data: result })
  } catch (error) {
    return res.status(error.statusCode || 502).json({ success: false, error: error.message })
  }
})

router.get('/grok-accounts/:id/test-history', authenticateAdmin, async (req, res) => {
  try {
    const history = await accountTestSchedulerService.getTestHistory(req.params.id, 'grok')
    return res.json({
      success: true,
      data: { accountId: req.params.id, platform: 'grok', history }
    })
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message })
  }
})

router.get('/grok-accounts/:id/test-config', authenticateAdmin, async (req, res) => {
  try {
    const account = await grokAccountService.getSafeAccount(req.params.id)
    if (!account) {
      return res.status(404).json({ success: false, error: 'Grok account not found' })
    }
    const testConfig = await accountTestSchedulerService.getTestConfig(req.params.id, 'grok')
    return res.json({
      success: true,
      data: {
        accountId: req.params.id,
        platform: 'grok',
        config: testConfig || {
          enabled: false,
          cronExpression: '0 8 * * *',
          model: GROK_TEST_MODELS[0].value
        }
      }
    })
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message })
  }
})

router.put('/grok-accounts/:id/test-config', authenticateAdmin, async (req, res) => {
  try {
    const account = await grokAccountService.getSafeAccount(req.params.id)
    if (!account) {
      return res.status(404).json({ success: false, error: 'Grok account not found' })
    }
    const { enabled, cronExpression, model } = req.body || {}
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ success: false, error: 'enabled must be a boolean' })
    }
    if (typeof cronExpression !== 'string' || !cronExpression.trim()) {
      return res.status(400).json({ success: false, error: 'cronExpression is required' })
    }
    if (typeof model !== 'string' || !model.trim()) {
      return res.status(400).json({ success: false, error: 'model is required' })
    }
    await accountTestSchedulerService.setTestConfig(req.params.id, 'grok', {
      enabled,
      cronExpression: cronExpression.trim(),
      model: model.trim()
    })
    return res.json({ success: true })
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message })
  }
})

router.post('/grok-accounts/:id/sync-models', authenticateAdmin, async (req, res) => {
  try {
    return res.json({ success: true, data: await grokAccountService.syncModels(req.params.id) })
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message })
  }
})

router.post('/grok-accounts/:id/query-quota', authenticateAdmin, async (req, res) => {
  try {
    return res.json({ success: true, data: await grokQuotaService.queryQuota(req.params.id) })
  } catch (error) {
    return res.status(error.statusCode || 502).json({ success: false, error: error.message })
  }
})

router.post('/grok-accounts/:id/refresh-token', authenticateAdmin, async (req, res) => {
  try {
    await grokAccountService.getValidAccessToken(req.params.id, true)
    return res.json({ success: true, message: 'Token refreshed' })
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message })
  }
})

router.post('/grok-accounts/:id/reauth', authenticateAdmin, async (req, res) => {
  try {
    const tokens = normalizeOAuthTokens(req.body || {})
    if (!tokens.accessToken || !tokens.refreshToken) {
      return res.status(400).json({ success: false, error: 'OAuth tokens are required' })
    }
    const account = await grokAccountService.reauthorize(req.params.id, tokens)
    return res.json({ success: true, data: account })
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message })
  }
})

module.exports = router
