/**
 * v2 账号专用路由（/admin/v2/*）
 * 仅放行 v2 角色；所有响应均不含任何上游账户身份信息（数据最小化）
 */

const express = require('express')
const apiKeyService = require('../../services/apiKeyService')
const redis = require('../../models/redis')
const { authenticateV2Account } = require('../../middleware/auth')
const { applyDisplayModelToRecord } = require('../../utils/modelVariantHelper')
const {
  validateStatsTimeRange,
  ApiKeyStatsValidationError
} = require('../../services/apiKeyStatsService')
const logger = require('../../utils/logger')

const router = express.Router()

// 全部接口仅放行 v2 账号
router.use(authenticateV2Account)

// 📊 获取当前 v2 账号总账信息（额度 / 已用 / 剩余 / 是否不限额，无上游账户信息）
router.get('/account', async (req, res) => {
  try {
    const summary = await apiKeyService.getV2AccountSummary(req.v2Account.parentKeyId)
    return res.json({ success: true, data: summary })
  } catch (error) {
    logger.error('❌ Failed to get v2 account summary:', error)
    return res.status(500).json({ error: 'Failed to load account', message: error.message })
  }
})

// 🔑 v2 自助修改密码（成功后失效当前会话，需重新登录）
router.post('/account/password', async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body
    if (!currentPassword || !newPassword) {
      return res
        .status(400)
        .json({ error: 'Missing fields', message: '当前密码和新密码均为必填项' })
    }
    await apiKeyService.changeV2Password(req.v2Account.parentKeyId, currentPassword, newPassword)
    await redis.deleteSession(req.v2Account.sessionId)
    logger.success(`🔑 v2 account changed password: ${req.v2Account.email}`)
    return res.json({
      success: true,
      message: 'Password changed successfully. Please login again.'
    })
  } catch (error) {
    if (error.code === 'INVALID_PASSWORD') {
      return res
        .status(401)
        .json({ error: 'Invalid current password', message: 'Current password is incorrect' })
    }
    logger.error('❌ Failed to change v2 password:', error)
    return res.status(400).json({ error: 'Change password failed', message: error.message })
  }
})

// 🌐 获取账号级 IP 白名单（父 key 白名单即账号级默认；仅白名单配置，无上游账户信息）
router.get('/account/ip-whitelist', async (req, res) => {
  try {
    const data = await apiKeyService.getV2IpWhitelist(req.v2Account.parentKeyId)
    return res.json({ success: true, data })
  } catch (error) {
    logger.error('❌ Failed to get v2 IP whitelist:', error)
    return res.status(500).json({ error: 'Failed to load IP whitelist', message: error.message })
  }
})

// 🌐 更新账号级 IP 白名单（校验全部收敛在 service 层，路由只做参数提取）
router.put('/account/ip-whitelist', async (req, res) => {
  try {
    const { enableIpWhitelist, ipWhitelist } = req.body || {}
    const data = await apiKeyService.updateV2IpWhitelist(req.v2Account.parentKeyId, {
      enableIpWhitelist,
      ipWhitelist
    })
    return res.json({ success: true, data, message: 'IP whitelist updated successfully' })
  } catch (error) {
    logger.error('❌ Failed to update v2 IP whitelist:', error)
    return res.status(400).json({ error: 'Update failed', message: error.message })
  }
})

// 📋 获取自己创建的子 key 列表（已最小化）
router.get('/keys', async (req, res) => {
  try {
    const includeDeleted = req.query.includeDeleted === 'true'
    const keys = await apiKeyService.getV2Children(req.v2Account.parentKeyId, includeDeleted)
    return res.json({ success: true, data: keys })
  } catch (error) {
    logger.error('❌ Failed to list v2 child keys:', error)
    return res.status(500).json({ error: 'Failed to load keys', message: error.message })
  }
})

// 📊 v2 自助端子 key 区间统计（不接受客户端 keyIds，只统计当前父账号未删除子 key）
router.post('/keys/usage-stats', async (req, res) => {
  try {
    const { timeRange = 'today', startDate, endDate } = req.body || {}
    validateStatsTimeRange({ timeRange, startDate, endDate })
    const stats = await apiKeyService.getV2ChildrenUsageStats(req.v2Account.parentKeyId, {
      timeRange,
      startDate,
      endDate
    })
    return res.json({ success: true, data: stats })
  } catch (error) {
    if (error instanceof ApiKeyStatsValidationError) {
      return res.status(400).json({ error: 'Invalid time range', message: error.message })
    }
    logger.error('❌ Failed to load v2 child key usage stats:', error)
    return res.status(500).json({ error: 'Failed to load usage stats', message: error.message })
  }
})

// 📈 子 key 请求时间线（先校验归属；fail-closed 最小化：每条仅返回该 key 自身的
// 时间/模型/token/计费字段，绝不透传账户类与上游成本基准字段——见下方 map 注释）
router.get('/keys/:keyId/usage-records', async (req, res) => {
  try {
    const { keyId } = req.params
    await apiKeyService.assertV2ChildOwnership(req.v2Account.parentKeyId, keyId)

    // limit 默认 100，clamp 到 1~200（与单 key 请求明细最多保留 200 条一致）
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200)
    const records = await redis.getUsageRecords(keyId, limit)

    // 先经 applyDisplayModelToRecord 得到展示用模型名（GPT priority → "xxx (fast)"，与管理员一致），
    // 再用 fail-closed 白名单只取「该 key 自身」的时间/模型/token/计费字段。
    // 账户类与上游成本基准字段一律不返回：accountId/accountType/parentKeyId/upstreamNicIp/
    // endpoint/method/requestId/statusCode/durationMs/realCost/realCostBreakdown/serviceTier 等。
    //
    // 计费口径：record.cost 是倍率后计费成本，而 record.costBreakdown 是原始成本分解（与已剥离的
    // realCostBreakdown 同值）。直接透传分项既会让分项加不齐倍率总额，也会泄漏真实成本与倍率。
    // 这里按 ratio = cost / realTotal 把分项同比缩放为倍率口径——calculateRatedCost 为纯乘法，
    // 且 total === input+output+cacheCreate+cacheRead（cacheCreate 已含 ephemeral 5m/1h），
    // 故缩放后分项精确加齐 cost；realTotal<=0（免费请求）时不返回分项，只给倍率总额。
    const round6 = (n) => Number((Number(n) || 0).toFixed(6))
    const timeline = (Array.isArray(records) ? records : []).map((record) => {
      const displayRecord = applyDisplayModelToRecord(record)
      const cb = record.costBreakdown || {}
      const cost = Number(record.cost) || 0
      const realTotal = Number(cb.total) || 0
      let costBreakdown = null
      if (realTotal > 0) {
        const ratio = cost / realTotal
        costBreakdown = {
          input: round6((cb.input || 0) * ratio),
          output: round6((cb.output || 0) * ratio),
          cacheCreate: round6((cb.cacheCreate || 0) * ratio),
          cacheRead: round6((cb.cacheRead || 0) * ratio),
          total: cost
        }
      }
      return {
        timestamp: displayRecord.timestamp || null,
        model: displayRecord.model || 'unknown',
        inputTokens: Number(record.inputTokens) || 0,
        outputTokens: Number(record.outputTokens) || 0,
        cacheCreateTokens: Number(record.cacheCreateTokens) || 0,
        cacheReadTokens: Number(record.cacheReadTokens) || 0,
        totalTokens: Number(record.totalTokens) || 0,
        cost,
        costBreakdown
      }
    })

    return res.json({ success: true, data: timeline })
  } catch (error) {
    if (error.code === 'NOT_FOUND') {
      return res.status(404).json({ error: 'Not found', message: 'API key not found' })
    }
    logger.error('❌ Failed to load v2 child key usage records:', error)
    return res.status(500).json({ error: 'Failed to load records', message: error.message })
  }
})

// 🔓 v2 自助显示自己子 key 的明文（先归属校验；只返回该 key 明文，无上游信息）
router.post('/keys/:keyId/secret/reveal', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store')
    const apiKey = await apiKeyService.getV2ChildPlaintext(
      req.v2Account.parentKeyId,
      req.params.keyId
    )
    return res.json({ success: true, data: { apiKey } })
  } catch (error) {
    if (error.code === 'NOT_FOUND') {
      return res.status(404).json({ error: 'Not found', message: 'API key not found' })
    }
    if (error.code === 'PLAINTEXT_UNAVAILABLE') {
      return res
        .status(409)
        .json({ error: 'Plaintext unavailable', message: '该 Key 创建于功能上线前，无法显示明文' })
    }
    if (error.code === 'PLAINTEXT_DECRYPT_FAILED') {
      return res
        .status(500)
        .json({ error: 'Decrypt failed', message: 'API Key 明文解密失败，请联系管理员' })
    }
    logger.error('Failed to reveal v2 child API key secret:', error)
    return res.status(500).json({ error: 'Reveal failed', message: error.message })
  }
})

// 🔑 创建子 key（只接受 name/description/dailyCostLimit/totalCostLimit，其余实时继承父账号）
router.post('/keys', async (req, res) => {
  try {
    const { name, description, dailyCostLimit, totalCostLimit } = req.body
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Missing name', message: 'API key 名称为必填项' })
    }
    const newKey = await apiKeyService.createV2Child(req.v2Account.parentKeyId, {
      name,
      description,
      dailyCostLimit,
      totalCostLimit
    })
    logger.success(`🔑 v2 account created child key: ${newKey.id}`)
    return res.json({
      success: true,
      data: {
        id: newKey.id,
        name: newKey.name,
        description: newKey.description,
        apiKey: newKey.apiKey, // 仅创建时返回完整 secret
        dailyCostLimit: newKey.dailyCostLimit,
        totalCostLimit: newKey.totalCostLimit,
        createdAt: newKey.createdAt
      }
    })
  } catch (error) {
    logger.error('❌ Failed to create v2 child key:', error)
    return res.status(400).json({ error: 'Create failed', message: error.message })
  }
})

// 📝 更新子 key（归属校验 / 字段白名单 / 数值规范化全部收敛在 service 层 updateV2Child，
// 路由只做参数提取，防止借道改继承/提权或存入非法额度）
router.put('/keys/:keyId', async (req, res) => {
  try {
    const { keyId } = req.params
    const {
      name,
      description,
      dailyCostLimit,
      totalCostLimit,
      isActive,
      ipWhitelistOverride,
      enableIpWhitelist,
      ipWhitelist
    } = req.body
    await apiKeyService.updateV2Child(req.v2Account.parentKeyId, keyId, {
      name,
      description,
      dailyCostLimit,
      totalCostLimit,
      isActive,
      ipWhitelistOverride,
      enableIpWhitelist,
      ipWhitelist
    })
    logger.success(`📝 v2 account updated child key: ${keyId}`)
    return res.json({ success: true, message: 'API key updated successfully' })
  } catch (error) {
    if (error.code === 'NOT_FOUND') {
      return res.status(404).json({ error: 'Not found', message: 'API key not found' })
    }
    logger.error('❌ Failed to update v2 child key:', error)
    return res.status(400).json({ error: 'Update failed', message: error.message })
  }
})

// 🗑️ 删除子 key（软删除；先校验归属）
router.delete('/keys/:keyId', async (req, res) => {
  try {
    const { keyId } = req.params
    await apiKeyService.assertV2ChildOwnership(req.v2Account.parentKeyId, keyId)
    await apiKeyService.deleteApiKey(keyId, req.v2Account.email, 'v2')
    logger.success(`🗑️ v2 account deleted child key: ${keyId}`)
    return res.json({ success: true, message: 'API key deleted successfully' })
  } catch (error) {
    if (error.code === 'NOT_FOUND') {
      return res.status(404).json({ error: 'Not found', message: 'API key not found' })
    }
    logger.error('❌ Failed to delete v2 child key:', error)
    return res.status(400).json({ error: 'Delete failed', message: error.message })
  }
})

module.exports = router
