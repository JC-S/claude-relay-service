/**
 * /web/auth/login 登录失败限流（管理员 + v2 账号共用同一登录端点）
 *
 * 设计要点：
 * - failure-only：只对「失败」计数，成功登录不消耗额度。区别于 userRoutes.js 的
 *   attempt-based rate-limiter-flexible 限流（那会把成功登录也计入额度）——
 *   管理后台登录频率低、误伤代价高，failure-only 对正常用户更友好。
 * - 默认两个维度：真实客户端 IP、normalizedUsername+IP。默认「不」启用纯账号维度，
 *   否则攻击者只要知道 v2 邮箱、连续输错密码就能锁死任意账号（账号锁定 DoS）。
 *   如需防分布式多 IP 撞同一账号，用 LOGIN_ACCOUNT_LIMIT_ENABLED=true 显式开启。
 * - Redis 不可用时 fail-open（放行并打 warning）：登录成功本身要写 Redis 会话，
 *   Redis 真宕机时登录流程也走不完，这里不额外阻断。
 * - 成功登录只清理该 principal（username+IP 与可选账号维度）的失败计数，
 *   不清 IP 维度——避免一个 IP 轮流撞多个账号时每次成功都重置 IP 计数。
 */

const crypto = require('crypto')
const redis = require('../models/redis')
const logger = require('../utils/logger')

const parsePositiveInt = (value, fallback) => {
  const parsed = parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const WINDOW_SECONDS = parsePositiveInt(process.env.LOGIN_FAIL_WINDOW_SECONDS, 900)
const MAX_FAILS_PER_IP = parsePositiveInt(process.env.LOGIN_MAX_FAILS_PER_IP, 30)
const MAX_FAILS_PER_ACCOUNT_IP = parsePositiveInt(process.env.LOGIN_MAX_FAILS_PER_ACCOUNT_IP, 5)
const ACCOUNT_LIMIT_ENABLED = process.env.LOGIN_ACCOUNT_LIMIT_ENABLED === 'true'
const MAX_FAILS_PER_ACCOUNT = parsePositiveInt(process.env.LOGIN_MAX_FAILS_PER_ACCOUNT, 20)

const normalizeUsername = (username) =>
  String(username || '')
    .trim()
    .toLowerCase()

// IP 经 sha256 截断后拼 key，避免把复杂 IP 字符串（IPv6 冒号等）直接拼入 Redis key
const hashIp = (ip) =>
  crypto
    .createHash('sha256')
    .update(String(ip || ''))
    .digest('hex')
    .slice(0, 16)

const ipKey = (ip) => `web_login:fail:ip:${ip}`
const acctIpKey = (username, ip) =>
  `web_login:fail:acct_ip:${normalizeUsername(username)}:${hashIp(ip)}`
const acctKey = (username) => `web_login:fail:acct:${normalizeUsername(username)}`

// 当前生效的限流维度（key 生成器 + 阈值 + 触发原因标识）
const dimensions = (ip, username) => {
  const dims = [
    { key: ipKey(ip), max: MAX_FAILS_PER_IP, reason: 'ip' },
    { key: acctIpKey(username, ip), max: MAX_FAILS_PER_ACCOUNT_IP, reason: 'account_ip' }
  ]
  if (ACCOUNT_LIMIT_ENABLED) {
    dims.push({ key: acctKey(username), max: MAX_FAILS_PER_ACCOUNT, reason: 'account' })
  }
  return dims
}

/**
 * 检查是否已被封禁（任一维度达到阈值即封禁）
 * @returns {Promise<{blocked: boolean, retryAfterSeconds?: number, reason?: string}>}
 */
const checkBlocked = async (ip, username) => {
  try {
    const client = redis.getClientSafe()
    for (const dim of dimensions(ip, username)) {
      const count = parseInt(await client.get(dim.key), 10) || 0
      if (count >= dim.max) {
        const ttl = await client.ttl(dim.key)
        return {
          blocked: true,
          retryAfterSeconds: ttl > 0 ? ttl : WINDOW_SECONDS,
          reason: dim.reason
        }
      }
    }
    return { blocked: false }
  } catch (error) {
    logger.warn('⚠️ Login rate limiter unavailable (fail-open):', error.message)
    return { blocked: false }
  }
}

/**
 * 记录一次登录失败（INCR，首次失败设置窗口 EXPIRE）
 */
const recordFailure = async (ip, username) => {
  try {
    const client = redis.getClientSafe()
    for (const dim of dimensions(ip, username)) {
      const count = await client.incr(dim.key)
      if (count === 1) {
        await client.expire(dim.key, WINDOW_SECONDS)
      }
    }
  } catch (error) {
    logger.warn('⚠️ Failed to record login failure (fail-open):', error.message)
  }
}

/**
 * 登录成功后清理该 principal 的失败计数（username+IP 与可选账号维度）；
 * 不清 IP 维度，避免同一 IP 连续撞多个账号时被成功登录重置
 */
const clearFailureForPrincipal = async (ip, username) => {
  try {
    const client = redis.getClientSafe()
    const keys = [acctIpKey(username, ip)]
    if (ACCOUNT_LIMIT_ENABLED) {
      keys.push(acctKey(username))
    }
    await client.del(...keys)
  } catch (error) {
    logger.warn('⚠️ Failed to clear login failure counters:', error.message)
  }
}

module.exports = {
  checkBlocked,
  recordFailure,
  clearFailureForPrincipal,
  // 导出常量便于测试与文案（不建议运行时修改）
  WINDOW_SECONDS,
  MAX_FAILS_PER_IP,
  MAX_FAILS_PER_ACCOUNT_IP,
  ACCOUNT_LIMIT_ENABLED,
  MAX_FAILS_PER_ACCOUNT
}
