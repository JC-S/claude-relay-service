const winston = require('winston')
const DailyRotateFile = require('winston-daily-rotate-file')
const config = require('../../config/config')
const { formatDateWithTimezone } = require('../utils/dateHelper')
const path = require('path')
const fs = require('fs')
const os = require('os')
const {
  sanitizeLogString,
  sanitizeLogValue,
  stringifyLogValue,
  summarizeErrorForLog,
  summarizeOAuthTokenData
} = require('./logSanitizer')

// 安全的 JSON 序列化函数，处理循环引用和特殊字符
const safeStringify = (obj, maxDepth = Infinity, options = {}) =>
  stringifyLogValue(obj, { maxDepth, ...options })

// 控制台不显示的 metadata 字段（已在 message 中或低价值）
const CONSOLE_SKIP_KEYS = new Set(['type', 'level', 'message', 'timestamp', 'stack'])

// 控制台格式: 树形展示 metadata
const createConsoleFormat = () =>
  winston.format.combine(
    winston.format.timestamp({ format: () => formatDateWithTimezone(new Date(), false) }),
    winston.format.errors({ stack: true }),
    winston.format.colorize(),
    winston.format.printf(({ level: _level, message, timestamp, stack, ...rest }) => {
      // 时间戳只取时分秒
      const shortTime = timestamp ? timestamp.split(' ').pop() : ''

      let logMessage = `${shortTime} ${sanitizeLogString(message)}`

      // 收集要显示的 metadata
      const entries = Object.entries(rest).filter(([k]) => !CONSOLE_SKIP_KEYS.has(k))

      if (entries.length > 0) {
        const indent = ' '.repeat(shortTime.length + 1)
        entries.forEach(([key, value], i) => {
          const isLast = i === entries.length - 1
          const branch = isLast ? '└─' : '├─'
          const displayValue =
            value !== null && typeof value === 'object'
              ? safeStringify(value)
              : sanitizeLogString(String(value))
          logMessage += `\n${indent}${branch} ${sanitizeLogString(key)}: ${displayValue}`
        })
      }

      if (stack) {
        logMessage += `\n${sanitizeLogString(stack)}`
      }
      return logMessage
    })
  )

// 文件格式: NDJSON（完整结构化数据）
const createFileFormat = (stringifyOptions = {}) =>
  winston.format.combine(
    winston.format.timestamp({ format: () => formatDateWithTimezone(new Date(), false) }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ level, message, timestamp, stack, ...rest }) => {
      const entry = { ts: timestamp, lvl: level, msg: message }
      // 合并所有 metadata
      for (const [k, v] of Object.entries(rest)) {
        if (k !== 'level' && k !== 'message' && k !== 'timestamp' && k !== 'stack') {
          entry[k] = v
        }
      }
      if (stack) {
        entry.stack = stack
      }
      return safeStringify(entry, Infinity, stringifyOptions)
    })
  )

const fileFormat = createFileFormat()
const fullFileFormat = createFileFormat({ truncate: false })
const consoleFormat = createConsoleFormat()
const isTestEnv = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID

// 📁 确保日志目录存在并设置权限
if (!fs.existsSync(config.logging.dirname)) {
  fs.mkdirSync(config.logging.dirname, { recursive: true, mode: 0o700 })
}

// 🔄 增强的日志轮转配置
const createRotateTransport = (filename, level = null, format = fileFormat) => {
  const transport = new DailyRotateFile({
    filename: path.join(config.logging.dirname, filename),
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: config.logging.maxSize,
    maxFiles: config.logging.maxFiles,
    auditFile: path.join(config.logging.dirname, `.${filename.replace('%DATE%', 'audit')}.json`),
    options: { flags: 'a', mode: 0o600 },
    format
  })

  if (level) {
    transport.level = level
  }

  // 监听轮转事件（测试环境关闭以避免 Jest 退出后输出）
  if (!isTestEnv) {
    transport.on('rotate', (oldFilename, newFilename) => {
      console.log(`📦 Log rotated: ${oldFilename} -> ${newFilename}`)
    })

    transport.on('new', (newFilename) => {
      console.log(`📄 New log file created: ${newFilename}`)
    })

    transport.on('archive', (zipFilename) => {
      console.log(`🗜️ Log archived: ${zipFilename}`)
    })
  }

  return transport
}

const dailyRotateFileTransport = createRotateTransport('claude-relay-%DATE%.log')
const errorFileTransport = createRotateTransport('claude-relay-error-%DATE%.log', 'error')

// 🔒 创建专门的安全日志记录器
const securityLogger = winston.createLogger({
  level: 'warn',
  format: fileFormat,
  transports: [createRotateTransport('claude-relay-security-%DATE%.log', 'warn')],
  silent: false
})

// 🧾 专门保存完整上游错误响应，不做体积截断，便于排查 429/529 等问题
const upstreamErrorLogger = winston.createLogger({
  level: 'error',
  format: fullFileFormat,
  transports: [
    createRotateTransport('claude-relay-upstream-error-%DATE%.log', 'error', fullFileFormat)
  ],
  silent: false
})

// 🔐 创建专门的认证详细日志记录器（只记录不含凭据的认证摘要）
const authDetailFormat = winston.format.combine(
  winston.format.timestamp({ format: () => formatDateWithTimezone(new Date(), false) }),
  winston.format.printf(({ level, message, timestamp, data }) => {
    const jsonData = JSON.stringify(sanitizeLogValue(data || {}), null, 2)
    return `[${timestamp}] ${level.toUpperCase()}: ${sanitizeLogString(message)}\n${jsonData}\n${'='.repeat(80)}`
  })
)

const authDetailLogger = winston.createLogger({
  level: 'info',
  format: authDetailFormat,
  transports: [
    createRotateTransport('claude-relay-auth-detail-%DATE%.log', 'info', authDetailFormat)
  ],
  silent: false
})

// 🌟 增强的 Winston logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || config.logging.level,
  format: fileFormat,
  transports: [
    // 📄 文件输出
    dailyRotateFileTransport,
    errorFileTransport,

    // 🖥️ 控制台输出
    new winston.transports.Console({
      format: consoleFormat,
      handleExceptions: false,
      handleRejections: false
    })
  ],

  // 🚨 异常处理
  exceptionHandlers: [
    new winston.transports.File({
      filename: path.join(config.logging.dirname, 'exceptions.log'),
      format: fileFormat,
      maxsize: 10485760, // 10MB
      maxFiles: 5,
      options: { flags: 'a', mode: 0o600 }
    }),
    new winston.transports.Console({
      format: consoleFormat
    })
  ],

  // 🔄 未捕获异常处理
  rejectionHandlers: [
    new winston.transports.File({
      filename: path.join(config.logging.dirname, 'rejections.log'),
      format: fileFormat,
      maxsize: 10485760, // 10MB
      maxFiles: 5,
      options: { flags: 'a', mode: 0o600 }
    }),
    new winston.transports.Console({
      format: consoleFormat
    })
  ],

  // 防止进程退出
  exitOnError: false
})

// 🎯 增强的自定义方法
logger.success = (message, metadata = {}) => {
  logger.info(`✅ ${message}`, { type: 'success', ...metadata })
}

logger.start = (message, metadata = {}) => {
  logger.info(`🚀 ${message}`, { type: 'startup', ...metadata })
}

logger.request = (method, url, status, duration, metadata = {}) => {
  const emoji = status >= 400 ? '🔴' : status >= 300 ? '🟡' : '🟢'
  const level = status >= 400 ? 'error' : status >= 300 ? 'warn' : 'info'

  logger[level](`${emoji} ${method} ${url} - ${status} (${duration}ms)`, {
    type: 'request',
    method,
    url,
    status,
    duration,
    ...metadata
  })
}

logger.api = (message, metadata = {}) => {
  logger.info(`🔗 ${message}`, { type: 'api', ...metadata })
}

logger.security = (message, metadata = {}) => {
  const securityData = {
    type: 'security',
    timestamp: new Date().toISOString(),
    pid: process.pid,
    hostname: os.hostname(),
    ...metadata
  }

  // 记录到主日志
  logger.warn(`🔒 ${message}`, securityData)

  // 记录到专门的安全日志文件
  try {
    securityLogger.warn(`🔒 ${message}`, securityData)
  } catch (error) {
    // 如果安全日志文件不可用，只记录到主日志
    console.warn('Security logger not available:', error.message)
  }
}

logger.database = (message, metadata = {}) => {
  logger.debug(`💾 ${message}`, { type: 'database', ...metadata })
}

logger.performance = (message, metadata = {}) => {
  logger.info(`⚡ ${message}`, { type: 'performance', ...metadata })
}

logger.audit = (message, metadata = {}) => {
  logger.info(`📋 ${message}`, {
    type: 'audit',
    timestamp: new Date().toISOString(),
    pid: process.pid,
    ...metadata
  })
}

logger.upstreamError = (message, metadata = {}) => {
  const upstreamErrorData = {
    type: 'upstream-error',
    timestamp: new Date().toISOString(),
    pid: process.pid,
    hostname: os.hostname(),
    ...metadata
  }

  logger.error(`🧾 ${message}`, upstreamErrorData)

  try {
    upstreamErrorLogger.error(`🧾 ${message}`, upstreamErrorData)
  } catch (error) {
    logger.error('Failed to log upstream error response:', error)
  }
}

// 🔧 性能监控方法
logger.timer = (label) => {
  const start = Date.now()
  return {
    end: (message = '', metadata = {}) => {
      const duration = Date.now() - start
      logger.performance(`${label} ${message}`, { duration, ...metadata })
      return duration
    }
  }
}

// 📊 日志统计
logger.stats = {
  requests: 0,
  errors: 0,
  warnings: 0
}

// 重写原始方法以统计
const originalError = logger.error
const originalWarn = logger.warn
const originalInfo = logger.info
const originalDebug = logger.debug

const prepareLogCall = (message, args) => {
  const safeArgs = args.map((arg) => (arg instanceof Error ? summarizeErrorForLog(arg) : arg))
  if (message instanceof Error) {
    const summary = summarizeErrorForLog(message)
    return [summary.errorMessage || summary.errorName || 'Unknown error', [summary, ...safeArgs]]
  }
  return [typeof message === 'string' ? sanitizeLogString(message) : message, safeArgs]
}

logger.error = function (message, ...args) {
  logger.stats.errors++
  const [safeMessage, safeArgs] = prepareLogCall(message, args)
  return originalError.call(this, safeMessage, ...safeArgs)
}

logger.warn = function (message, ...args) {
  logger.stats.warnings++
  const [safeMessage, safeArgs] = prepareLogCall(message, args)
  return originalWarn.call(this, safeMessage, ...safeArgs)
}

logger.info = function (message, ...args) {
  // 检查是否是请求类型的日志
  if (args.length > 0 && typeof args[0] === 'object' && args[0].type === 'request') {
    logger.stats.requests++
  }
  const [safeMessage, safeArgs] = prepareLogCall(message, args)
  return originalInfo.call(this, safeMessage, ...safeArgs)
}

logger.debug = function (message, ...args) {
  const [safeMessage, safeArgs] = prepareLogCall(message, args)
  return originalDebug.call(this, safeMessage, ...safeArgs)
}

// 📈 获取日志统计
logger.getStats = () => ({ ...logger.stats })

// 🧹 清理统计
logger.resetStats = () => {
  logger.stats.requests = 0
  logger.stats.errors = 0
  logger.stats.warnings = 0
}

// 📡 健康检查
logger.healthCheck = () => {
  try {
    const testMessage = 'Logger health check'
    logger.debug(testMessage)
    return { healthy: true, timestamp: new Date().toISOString() }
  } catch (error) {
    return { healthy: false, error: error.message, timestamp: new Date().toISOString() }
  }
}

// 🔐 记录认证详细信息的方法
logger.authDetail = (message, data = {}) => {
  try {
    const summary = summarizeOAuthTokenData(data)

    logger.info(`🔐 ${message}`, {
      type: 'auth-detail',
      summary
    })

    authDetailLogger.info(message, { data: summary })
  } catch (error) {
    logger.error('Failed to log auth detail:', error)
  }
}

// 🎬 启动日志记录系统
logger.start('Logger initialized', {
  level: process.env.LOG_LEVEL || config.logging.level,
  directory: config.logging.dirname,
  maxSize: config.logging.maxSize,
  maxFiles: config.logging.maxFiles,
  envOverride: process.env.LOG_LEVEL ? true : false
})

module.exports = logger
