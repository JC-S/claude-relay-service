/**
 * v2 账号专用路由（/admin/v2/*）
 * 仅放行 v2 角色；所有响应均不含任何上游账户身份信息（数据最小化）
 */

const express = require('express')
const apiKeyService = require('../../services/apiKeyService')
const redis = require('../../models/redis')
const { authenticateV2Account } = require('../../middleware/auth')
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

// 📝 更新子 key（先校验归属；硬白名单，仅允许受限字段，防止借道改继承/提权）
router.put('/keys/:keyId', async (req, res) => {
  try {
    const { keyId } = req.params
    await apiKeyService.assertV2ChildOwnership(req.v2Account.parentKeyId, keyId)

    const updates = {}
    const allowed = ['name', 'description', 'dailyCostLimit', 'totalCostLimit', 'isActive']
    for (const field of allowed) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field]
      }
    }

    await apiKeyService.updateApiKey(keyId, updates)
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
