const logger = require('../utils/logger')
const { validateApiKeyCredential } = require('../utils/apiKeyCredential')

// Keep this allowlist aligned with relay route mounts in app.js. Boundary matching below prevents
// similarly named admin/public routes such as /apiStats from being treated as relay traffic.
const API_RELAY_PATH_PREFIXES = [
  '/api',
  '/claude',
  '/antigravity/api',
  '/gemini-cli/api',
  '/gemini',
  '/openai',
  '/general',
  '/droid',
  '/grok',
  '/azure'
]

function normalizePath(value) {
  const path = String(value || '/')
    .split('?')[0]
    .replace(/\/{2,}/g, '/')
    .toLowerCase()
  if (path.length > 1 && path.endsWith('/')) {
    return path.slice(0, -1)
  }
  return path || '/'
}

function isApiRelayPath(req) {
  const path = normalizePath(req?.originalUrl || req?.url || '/')
  return API_RELAY_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
}

/**
 * 浏览器/Chrome插件兜底中间件
 * 专门处理第三方插件的兼容性问题
 */
const browserFallbackMiddleware = (req, res, next) => {
  const userAgent = req.headers['user-agent'] || ''
  const origin = req.headers['origin'] || ''

  const extractHeader = (value) => {
    let candidate = value

    if (Array.isArray(candidate)) {
      candidate = candidate.find((item) => typeof item === 'string' && item.trim())
    }

    if (typeof candidate !== 'string') {
      return ''
    }

    let trimmed = candidate.trim()
    if (!trimmed) {
      return ''
    }

    if (/^Bearer\s+/i.test(trimmed)) {
      trimmed = trimmed.replace(/^Bearer\s+/i, '').trim()
    }

    return trimmed
  }

  const apiKeyHeader =
    extractHeader(req.headers['x-api-key']) || extractHeader(req.headers['x-goog-api-key'])
  const normalizedKey = extractHeader(req.headers['authorization']) || apiKeyHeader

  // 检查是否为Chrome插件或浏览器请求
  const isChromeExtension = origin.startsWith('chrome-extension://')
  const isBrowserRequest = userAgent.includes('Mozilla/') && userAgent.includes('Chrome/')
  const hasApiKey = validateApiKeyCredential(normalizedKey).valid

  if ((isChromeExtension || isBrowserRequest) && hasApiKey && isApiRelayPath(req)) {
    // 为Chrome插件请求添加特殊标记
    req.isBrowserFallback = true
    req.originalUserAgent = userAgent

    // 🆕 关键修改：伪装成claude-cli请求以绕过客户端限制
    req.headers['user-agent'] = 'claude-cli/1.0.110 (external, cli, browser-fallback)'

    // 确保设置正确的认证头
    if (!req.headers['authorization'] && apiKeyHeader) {
      req.headers['authorization'] = `Bearer ${apiKeyHeader}`
    }

    // 添加必要的Anthropic头
    if (!req.headers['anthropic-version']) {
      req.headers['anthropic-version'] = '2023-06-01'
    }

    if (!req.headers['anthropic-dangerous-direct-browser-access']) {
      req.headers['anthropic-dangerous-direct-browser-access'] = 'true'
    }

    logger.api(
      `🔧 Browser fallback activated for ${isChromeExtension ? 'Chrome extension' : 'browser'} request`
    )
    logger.api(`   Original User-Agent: "${req.originalUserAgent}"`)
    logger.api(`   Origin: "${origin}"`)
    logger.api(`   Modified User-Agent: "${req.headers['user-agent']}"`)
  }

  next()
}

module.exports = {
  browserFallbackMiddleware,
  isApiRelayPath
}
