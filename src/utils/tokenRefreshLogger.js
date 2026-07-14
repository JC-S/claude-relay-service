const winston = require('winston')
const path = require('path')
const fs = require('fs')
const { sanitizeLogValue } = require('./logSanitizer')

// 确保日志目录存在
const logDir = path.join(process.cwd(), 'logs')
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 })
}

const sanitizeTokenRefreshFormat = winston.format((info) => {
  const sanitized = sanitizeLogValue(info)
  for (const key of Object.keys(info)) {
    delete info[key]
  }
  Object.assign(info, sanitized)
  return info
})()

// 创建专用的 token 刷新日志记录器
const tokenRefreshLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    sanitizeTokenRefreshFormat,
    winston.format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss.SSS'
    }),
    winston.format.json(),
    winston.format.printf((info) => JSON.stringify(info, null, 2))
  ),
  transports: [
    // 文件传输 - 每日轮转
    new winston.transports.File({
      filename: path.join(logDir, 'token-refresh.log'),
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 30, // 保留30天
      tailable: true,
      options: { flags: 'a', mode: 0o600 }
    }),
    // 错误单独记录
    new winston.transports.File({
      filename: path.join(logDir, 'token-refresh-error.log'),
      level: 'error',
      maxsize: 10 * 1024 * 1024,
      maxFiles: 30,
      options: { flags: 'a', mode: 0o600 }
    })
  ],
  // 错误处理
  exitOnError: false
})

// 在开发环境添加控制台输出
if (process.env.NODE_ENV !== 'production') {
  tokenRefreshLogger.add(
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), winston.format.simple())
    })
  )
}

function writeTokenRefreshLog(level, payload) {
  tokenRefreshLogger[level](sanitizeLogValue(payload))
}

/**
 * 记录 token 刷新开始
 */
function logRefreshStart(accountId, accountName, platform = 'claude', reason = '') {
  writeTokenRefreshLog('info', {
    event: 'token_refresh_start',
    accountId,
    accountName,
    platform,
    reason,
    timestamp: new Date().toISOString()
  })
}

/**
 * 记录 token 刷新成功
 */
function logRefreshSuccess(accountId, accountName, platform = 'claude', tokenData = {}) {
  const tokenSummary = {
    hasAccessToken: Boolean(tokenData.accessToken),
    hasRefreshToken: Boolean(tokenData.refreshToken),
    expiresAt: tokenData.expiresAt || tokenData.expiry_date || '[NOT_PROVIDED]',
    scopes: tokenData.scopes || tokenData.scope || '[NOT_PROVIDED]'
  }

  writeTokenRefreshLog('info', {
    event: 'token_refresh_success',
    accountId,
    accountName,
    platform,
    tokenData: tokenSummary,
    timestamp: new Date().toISOString()
  })
}

/**
 * 记录 token 刷新失败
 */
function logRefreshError(accountId, accountName, platform = 'claude', error, attemptNumber = 1) {
  const errorInfo = {
    message: error.message || error.toString(),
    code: error.code || 'UNKNOWN',
    statusCode: error.response?.status || 'N/A',
    responseData: error.response?.data || 'N/A'
  }

  writeTokenRefreshLog('error', {
    event: 'token_refresh_error',
    accountId,
    accountName,
    platform,
    error: errorInfo,
    attemptNumber,
    timestamp: new Date().toISOString()
  })
}

/**
 * 记录 token 刷新跳过（由于并发锁）
 */
function logRefreshSkipped(accountId, accountName, platform = 'claude', reason = 'locked') {
  writeTokenRefreshLog('info', {
    event: 'token_refresh_skipped',
    accountId,
    accountName,
    platform,
    reason,
    timestamp: new Date().toISOString()
  })
}

/**
 * 记录 token 使用情况
 */
function logTokenUsage(accountId, accountName, platform = 'claude', expiresAt, isExpired) {
  writeTokenRefreshLog('debug', {
    event: 'token_usage_check',
    accountId,
    accountName,
    platform,
    expiresAt,
    isExpired,
    remainingMinutes: expiresAt ? Math.floor((new Date(expiresAt) - Date.now()) / 60000) : 'N/A',
    timestamp: new Date().toISOString()
  })
}

/**
 * 记录批量刷新任务
 */
function logBatchRefreshStart(totalAccounts, platform = 'all') {
  writeTokenRefreshLog('info', {
    event: 'batch_refresh_start',
    totalAccounts,
    platform,
    timestamp: new Date().toISOString()
  })
}

/**
 * 记录批量刷新结果
 */
function logBatchRefreshComplete(results) {
  writeTokenRefreshLog('info', {
    event: 'batch_refresh_complete',
    results: {
      total: results.total || 0,
      success: results.success || 0,
      failed: results.failed || 0,
      skipped: results.skipped || 0
    },
    timestamp: new Date().toISOString()
  })
}

module.exports = {
  logger: tokenRefreshLogger,
  logRefreshStart,
  logRefreshSuccess,
  logRefreshError,
  logRefreshSkipped,
  logTokenUsage,
  logBatchRefreshStart,
  logBatchRefreshComplete
}
