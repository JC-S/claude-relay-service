const express = require('express')
const bcrypt = require('bcryptjs')
const crypto = require('crypto')
const path = require('path')
const fs = require('fs')
const redis = require('../models/redis')
const logger = require('../utils/logger')
const config = require('../../config/config')
const loginRateLimiter = require('../services/loginRateLimiter')
const { getRequestIp } = require('../utils/ipWhitelistHelper')

// 模块级 dummy hash：v2 邮箱未命中时也执行一次 bcrypt.compare 拉平耗时（防邮箱枚举）
const DUMMY_BCRYPT_HASH = bcrypt.hashSync('v2-login-timing-equalizer', 10)

const router = express.Router()

// 🏠 服务静态文件
router.use('/assets', express.static(path.join(__dirname, '../../web/assets')))

// 🌐 页面路由重定向到新版 admin-spa
router.get('/', (req, res) => {
  res.redirect(301, '/admin-next/api-stats')
})

// 🔐 管理员登录
router.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body

    if (!username || !password) {
      return res.status(400).json({
        error: 'Missing credentials',
        message: 'Username and password are required'
      })
    }

    // 登录失败限流（failure-only；维度与阈值见 loginRateLimiter）。
    // 反代/隧道场景必须用 getRequestIp 取真实客户端 IP，req.ip 会失真
    const clientIp = getRequestIp(req)
    const blockState = await loginRateLimiter.checkBlocked(clientIp, username)
    if (blockState.blocked) {
      logger.security(
        `🚫 Login blocked by rate limiter (${blockState.reason}) for username: ${username}, ip: ${clientIp}`
      )
      res.set('Retry-After', String(blockState.retryAfterSeconds))
      return res.status(429).json({
        error: 'Too many failed login attempts',
        message: 'Too many failed login attempts, please try again later'
      })
    }

    // 所有最终 401 出口统一走这里：先记失败计数，再返回统一文案（不泄漏具体原因）
    const failLogin = async () => {
      await loginRateLimiter.recordFailure(clientIp, username)
      return res.status(401).json({
        error: 'Invalid credentials',
        message: 'Invalid username or password'
      })
    }

    // 从Redis获取管理员信息
    let adminData = await redis.getSession('admin_credentials')

    // 如果Redis中没有管理员凭据，尝试从init.json重新加载
    if (!adminData || Object.keys(adminData).length === 0) {
      const initFilePath = path.join(__dirname, '../../data/init.json')

      if (fs.existsSync(initFilePath)) {
        try {
          const initData = JSON.parse(fs.readFileSync(initFilePath, 'utf8'))
          const saltRounds = 10
          const passwordHash = await bcrypt.hash(initData.adminPassword, saltRounds)

          adminData = {
            username: initData.adminUsername,
            passwordHash,
            createdAt: initData.initializedAt || new Date().toISOString(),
            lastLogin: null,
            updatedAt: initData.updatedAt || null
          }

          // 重新存储到Redis，不设置过期时间
          await redis.getClient().hset('session:admin_credentials', adminData)

          logger.info('✅ Admin credentials reloaded from init.json')
        } catch (error) {
          logger.error('❌ Failed to reload admin credentials:', error)
          return await failLogin()
        }
      } else {
        return await failLogin()
      }
    }

    // 验证用户名和密码（管理员）
    const isValidUsername = adminData.username === username
    const isValidPassword = await bcrypt.compare(password, adminData.passwordHash)

    if (isValidUsername && isValidPassword) {
      // 生成会话token
      const sessionId = crypto.randomBytes(32).toString('hex')

      // 存储会话（标记 admin 角色）
      const sessionData = {
        username: adminData.username,
        role: 'admin',
        loginTime: new Date().toISOString(),
        lastActivity: new Date().toISOString()
      }

      await redis.setSession(sessionId, sessionData, config.security.adminSessionTimeout)

      // 不再更新 Redis 中的最后登录时间，因为 Redis 只是缓存
      // init.json 是唯一真实数据源

      await loginRateLimiter.clearFailureForPrincipal(clientIp, username)
      logger.success(`Admin login successful: ${username}`)

      return res.json({
        success: true,
        token: sessionId,
        role: 'admin',
        expiresIn: config.security.adminSessionTimeout,
        username: adminData.username // 返回真实用户名
      })
    }

    // 🆕 管理员校验失败后，回退尝试 v2 账号登录（邮箱 + 密码，不走 LDAP）
    try {
      const apiKeyService = require('../services/apiKeyService')
      const v2Parent = await apiKeyService.findV2ByEmail(username)
      // 无论邮箱是否命中都执行一次 compare（未命中用 dummy hash），拉平耗时防邮箱枚举
      const v2PasswordValid = await bcrypt.compare(
        password,
        v2Parent && v2Parent.v2PasswordHash ? v2Parent.v2PasswordHash : DUMMY_BCRYPT_HASH
      )
      if (v2Parent && v2Parent.v2PasswordHash && v2PasswordValid) {
        const sessionId = crypto.randomBytes(32).toString('hex')
        const v2Email = v2Parent.v2Email || username.trim().toLowerCase()
        const sessionData = {
          username: v2Email,
          role: 'v2',
          v2KeyId: v2Parent.id,
          v2Email,
          loginTime: new Date().toISOString(),
          lastActivity: new Date().toISOString()
        }
        await redis.setSession(sessionId, sessionData, config.security.adminSessionTimeout)
        await loginRateLimiter.clearFailureForPrincipal(clientIp, username)
        logger.success(`v2 account login successful: ${v2Email}`)
        return res.json({
          success: true,
          token: sessionId,
          role: 'v2',
          expiresIn: config.security.adminSessionTimeout,
          username: v2Email
        })
      }
    } catch (v2Error) {
      logger.error('❌ v2 login attempt error:', v2Error)
    }

    logger.security(`Failed login attempt for username: ${username}`)
    return await failLogin()
  } catch (error) {
    logger.error('❌ Login error:', error)
    return res.status(500).json({
      error: 'Login failed',
      message: 'Internal server error'
    })
  }
})

// 🚪 管理员登出
router.post('/auth/logout', async (req, res) => {
  try {
    const token = req.headers['authorization']?.replace('Bearer ', '') || req.cookies?.adminToken

    if (token) {
      await redis.deleteSession(token)
      logger.success('🚪 Admin logout successful')
    }

    return res.json({ success: true, message: 'Logout successful' })
  } catch (error) {
    logger.error('❌ Logout error:', error)
    return res.status(500).json({
      error: 'Logout failed',
      message: 'Internal server error'
    })
  }
})

// 🔑 修改账户信息
router.post('/auth/change-password', async (req, res) => {
  try {
    const token = req.headers['authorization']?.replace('Bearer ', '') || req.cookies?.adminToken

    if (!token) {
      return res.status(401).json({
        error: 'No token provided',
        message: 'Authentication required'
      })
    }

    const { newUsername, currentPassword, newPassword } = req.body

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'Current password and new password are required'
      })
    }

    // 验证新密码长度
    if (newPassword.length < 8) {
      return res.status(400).json({
        error: 'Password too short',
        message: 'New password must be at least 8 characters long'
      })
    }

    // 获取当前会话
    const sessionData = await redis.getSession(token)

    // 🔒 安全修复：检查空对象
    if (!sessionData || Object.keys(sessionData).length === 0) {
      return res.status(401).json({
        error: 'Invalid token',
        message: 'Session expired or invalid'
      })
    }

    // 🔒 安全修复：验证会话完整性
    if (!sessionData.username || !sessionData.loginTime) {
      logger.security(
        `🔒 Invalid session structure in /auth/change-password from ${req.ip || 'unknown'}`
      )
      await redis.deleteSession(token)
      return res.status(401).json({
        error: 'Invalid session',
        message: 'Session data corrupted or incomplete'
      })
    }

    // 🆕 v2 会话：仅允许改密码（不允许自助改邮箱），成功后失效当前 session
    if (sessionData.role === 'v2') {
      try {
        const apiKeyService = require('../services/apiKeyService')
        await apiKeyService.changeV2Password(sessionData.v2KeyId, currentPassword, newPassword)
      } catch (v2Error) {
        if (v2Error.code === 'INVALID_PASSWORD') {
          return res.status(401).json({
            error: 'Invalid current password',
            message: 'Current password is incorrect'
          })
        }
        return res.status(400).json({
          error: 'Change password failed',
          message: v2Error.message || 'Failed to change password'
        })
      }
      await redis.deleteSession(token)
      logger.success(`v2 account password changed: ${sessionData.v2Email || sessionData.username}`)
      return res.json({
        success: true,
        message: 'Password changed successfully. Please login again.'
      })
    }

    // 获取当前管理员信息
    const adminData = await redis.getSession('admin_credentials')
    if (!adminData) {
      return res.status(500).json({
        error: 'Admin data not found',
        message: 'Administrator credentials not found'
      })
    }

    // 验证当前密码
    const isValidPassword = await bcrypt.compare(currentPassword, adminData.passwordHash)
    if (!isValidPassword) {
      logger.security(`Invalid current password attempt for user: ${sessionData.username}`)
      return res.status(401).json({
        error: 'Invalid current password',
        message: 'Current password is incorrect'
      })
    }

    // 准备更新的数据
    const updatedUsername =
      newUsername && newUsername.trim() ? newUsername.trim() : adminData.username

    // 先更新 init.json（唯一真实数据源）
    const initFilePath = path.join(__dirname, '../../data/init.json')
    if (!fs.existsSync(initFilePath)) {
      return res.status(500).json({
        error: 'Configuration file not found',
        message: 'init.json file is missing'
      })
    }

    try {
      const initData = JSON.parse(fs.readFileSync(initFilePath, 'utf8'))
      // const oldData = { ...initData }; // 备份旧数据

      // 更新 init.json
      initData.adminUsername = updatedUsername
      initData.adminPassword = newPassword // 保存明文密码到init.json
      initData.updatedAt = new Date().toISOString()

      // 先写入文件（如果失败则不会影响 Redis）
      fs.writeFileSync(initFilePath, JSON.stringify(initData, null, 2))

      // 文件写入成功后，更新 Redis 缓存
      const saltRounds = 10
      const newPasswordHash = await bcrypt.hash(newPassword, saltRounds)

      const updatedAdminData = {
        username: updatedUsername,
        passwordHash: newPasswordHash,
        createdAt: adminData.createdAt,
        lastLogin: adminData.lastLogin,
        updatedAt: new Date().toISOString()
      }

      await redis.setSession('admin_credentials', updatedAdminData)
    } catch (fileError) {
      logger.error('❌ Failed to update init.json:', fileError)
      return res.status(500).json({
        error: 'Update failed',
        message: 'Failed to update configuration file'
      })
    }

    // 清除当前会话（强制用户重新登录）
    await redis.deleteSession(token)

    logger.success(`Admin password changed successfully for user: ${updatedUsername}`)

    return res.json({
      success: true,
      message: 'Password changed successfully. Please login again.',
      newUsername: updatedUsername
    })
  } catch (error) {
    logger.error('❌ Change password error:', error)
    return res.status(500).json({
      error: 'Change password failed',
      message: 'Internal server error'
    })
  }
})

// 👤 获取当前用户信息
router.get('/auth/user', async (req, res) => {
  try {
    const token = req.headers['authorization']?.replace('Bearer ', '') || req.cookies?.adminToken

    if (!token) {
      return res.status(401).json({
        error: 'No token provided',
        message: 'Authentication required'
      })
    }

    // 获取当前会话
    const sessionData = await redis.getSession(token)

    // 🔒 安全修复：检查空对象
    if (!sessionData || Object.keys(sessionData).length === 0) {
      return res.status(401).json({
        error: 'Invalid token',
        message: 'Session expired or invalid'
      })
    }

    // 🔒 安全修复：验证会话完整性
    if (!sessionData.username || !sessionData.loginTime) {
      logger.security(`Invalid session structure in /auth/user from ${req.ip || 'unknown'}`)
      await redis.deleteSession(token)
      return res.status(401).json({
        error: 'Invalid session',
        message: 'Session data corrupted or incomplete'
      })
    }

    // 🆕 v2 会话：直接返回 v2 角色信息，不读 admin_credentials
    // 注意：不返回 v2KeyId（即父账号 keyId），避免前端据此调用公开统计接口反查上游账户绑定
    if (sessionData.role === 'v2') {
      return res.json({
        success: true,
        user: {
          username: sessionData.v2Email || sessionData.username,
          role: 'v2',
          loginTime: sessionData.loginTime,
          lastActivity: sessionData.lastActivity
        }
      })
    }

    // 获取管理员信息
    const adminData = await redis.getSession('admin_credentials')
    if (!adminData) {
      return res.status(500).json({
        error: 'Admin data not found',
        message: 'Administrator credentials not found'
      })
    }

    return res.json({
      success: true,
      user: {
        username: adminData.username,
        role: 'admin',
        loginTime: sessionData.loginTime,
        lastActivity: sessionData.lastActivity
      }
    })
  } catch (error) {
    logger.error('❌ Get user info error:', error)
    return res.status(500).json({
      error: 'Get user info failed',
      message: 'Internal server error'
    })
  }
})

// 🔄 刷新token
router.post('/auth/refresh', async (req, res) => {
  try {
    const token = req.headers['authorization']?.replace('Bearer ', '') || req.cookies?.adminToken

    if (!token) {
      return res.status(401).json({
        error: 'No token provided',
        message: 'Authentication required'
      })
    }

    const sessionData = await redis.getSession(token)

    // 🔒 安全修复：检查空对象（hgetall 对不存在的 key 返回 {}）
    if (!sessionData || Object.keys(sessionData).length === 0) {
      return res.status(401).json({
        error: 'Invalid token',
        message: 'Session expired or invalid'
      })
    }

    // 🔒 安全修复：验证会话完整性（必须有 username 和 loginTime）
    if (!sessionData.username || !sessionData.loginTime) {
      logger.security(`Invalid session structure detected from ${req.ip || 'unknown'}`)
      await redis.deleteSession(token) // 清理无效/伪造的会话
      return res.status(401).json({
        error: 'Invalid session',
        message: 'Session data corrupted or incomplete'
      })
    }

    // 更新最后活动时间
    sessionData.lastActivity = new Date().toISOString()
    await redis.setSession(token, sessionData, config.security.adminSessionTimeout)

    return res.json({
      success: true,
      token,
      expiresIn: config.security.adminSessionTimeout
    })
  } catch (error) {
    logger.error('❌ Token refresh error:', error)
    return res.status(500).json({
      error: 'Token refresh failed',
      message: 'Internal server error'
    })
  }
})

module.exports = router
