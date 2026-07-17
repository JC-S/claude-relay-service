const path = require('path')
require('dotenv').config()

const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT, 10) || 600000
const DEFAULT_GROK_DRAIN_IDLE_MS = 90000
const DEFAULT_GROK_CLI_VERSION = '0.2.93'

const parseGrokCliVersion = () => {
  const candidate = process.env.XAI_GROK_CLI_VERSION || DEFAULT_GROK_CLI_VERSION
  const match = candidate.match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!match) {
    process.emitWarning(`Invalid XAI_GROK_CLI_VERSION; using ${DEFAULT_GROK_CLI_VERSION}`)
    return DEFAULT_GROK_CLI_VERSION
  }
  const parts = match.slice(1).map(Number)
  const minimum = DEFAULT_GROK_CLI_VERSION.split('.').map(Number)
  const belowMinimum = parts.some((part, index) => {
    const prefixEqual = parts.slice(0, index).every((value, i) => value === minimum[i])
    return prefixEqual && part < minimum[index]
  })
  if (belowMinimum) {
    process.emitWarning(
      `XAI_GROK_CLI_VERSION must be >= ${DEFAULT_GROK_CLI_VERSION}; using the default`
    )
    return DEFAULT_GROK_CLI_VERSION
  }
  return candidate
}

const parseGrokDrainIdleMs = () => {
  const parsed = Number(process.env.GROK_DISCONNECT_DRAIN_IDLE_MS)
  if (process.env.GROK_DISCONNECT_DRAIN_IDLE_MS === undefined) {
    return Math.min(DEFAULT_GROK_DRAIN_IDLE_MS, REQUEST_TIMEOUT)
  }
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    process.emitWarning(
      `Invalid GROK_DISCONNECT_DRAIN_IDLE_MS; using ${DEFAULT_GROK_DRAIN_IDLE_MS}`
    )
    return Math.min(DEFAULT_GROK_DRAIN_IDLE_MS, REQUEST_TIMEOUT)
  }
  if (parsed === 0) {
    return 0
  }
  return Math.min(Math.max(parsed, 5000), REQUEST_TIMEOUT)
}

const config = {
  // 🌐 服务器配置
  server: {
    port: parseInt(process.env.PORT) || 3000,
    host: process.env.HOST || '0.0.0.0',
    nodeEnv: process.env.NODE_ENV || 'development',
    trustProxy: process.env.TRUST_PROXY === 'true'
  },

  // 🔐 安全配置
  security: {
    jwtSecret: process.env.JWT_SECRET || 'CHANGE-THIS-JWT-SECRET-IN-PRODUCTION',
    adminSessionTimeout: parseInt(process.env.ADMIN_SESSION_TIMEOUT) || 86400000, // 24小时
    apiKeyPrefix: process.env.API_KEY_PREFIX || 'cr_',
    encryptionKey: process.env.ENCRYPTION_KEY || 'CHANGE-THIS-32-CHARACTER-KEY-NOW'
  },

  // 📊 Redis配置
  redis: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || '',
    db: parseInt(process.env.REDIS_DB) || 0,
    connectTimeout: 10000,
    commandTimeout: 5000,
    retryDelayOnFailover: 100,
    maxRetriesPerRequest: 3,
    lazyConnect: true,
    enableTLS: process.env.REDIS_ENABLE_TLS === 'true'
  },

  // 🔗 会话管理配置
  session: {
    // 粘性会话TTL配置（小时），默认1小时
    stickyTtlHours: parseFloat(process.env.STICKY_SESSION_TTL_HOURS) || 1,
    // 续期阈值（分钟），默认0分钟（不续期）
    renewalThresholdMinutes: parseInt(process.env.STICKY_SESSION_RENEWAL_THRESHOLD_MINUTES) || 0
  },

  // 🎯 Claude API配置
  claude: {
    apiUrl: process.env.CLAUDE_API_URL || 'https://api.anthropic.com/v1/messages',
    apiVersion: process.env.CLAUDE_API_VERSION || '2023-06-01',
    // Keep the existing shared-pool fallback unless strict binding is explicitly requested.
    dedicatedAccountFallback: process.env.CLAUDE_DEDICATED_ACCOUNT_FALLBACK !== 'false',
    betaHeader:
      process.env.CLAUDE_BETA_HEADER ||
      'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14',
    overloadHandling: {
      enabled: (() => {
        const minutes = parseInt(process.env.CLAUDE_OVERLOAD_HANDLING_MINUTES) || 0
        // 验证配置值：限制在0-1440分钟(24小时)内
        return Math.max(0, Math.min(minutes, 1440))
      })()
    }
  },

  // ☁️ Bedrock API配置
  bedrock: {
    enabled: process.env.CLAUDE_CODE_USE_BEDROCK === '1',
    defaultRegion: process.env.AWS_REGION || 'us-east-1',
    smallFastModelRegion: process.env.ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION,
    defaultModel: process.env.ANTHROPIC_MODEL || 'us.anthropic.claude-sonnet-4-20250514-v1:0',
    smallFastModel:
      process.env.ANTHROPIC_SMALL_FAST_MODEL || 'us.anthropic.claude-3-5-haiku-20241022-v1:0',
    maxOutputTokens: parseInt(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS) || 4096,
    maxThinkingTokens: parseInt(process.env.MAX_THINKING_TOKENS) || 1024,
    enablePromptCaching: process.env.DISABLE_PROMPT_CACHING !== '1'
  },

  // 🌐 代理配置
  proxy: {
    timeout: parseInt(process.env.DEFAULT_PROXY_TIMEOUT) || 600000, // 10分钟
    maxRetries: parseInt(process.env.MAX_PROXY_RETRIES) || 3,
    // 连接池与 Keep-Alive 配置（默认关闭，需要显式开启）
    keepAlive: (() => {
      if (process.env.PROXY_KEEP_ALIVE === undefined || process.env.PROXY_KEEP_ALIVE === '') {
        return false
      }
      return process.env.PROXY_KEEP_ALIVE === 'true'
    })(),
    maxSockets: (() => {
      if (process.env.PROXY_MAX_SOCKETS === undefined || process.env.PROXY_MAX_SOCKETS === '') {
        return undefined
      }
      const parsed = parseInt(process.env.PROXY_MAX_SOCKETS)
      return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
    })(),
    maxFreeSockets: (() => {
      if (
        process.env.PROXY_MAX_FREE_SOCKETS === undefined ||
        process.env.PROXY_MAX_FREE_SOCKETS === ''
      ) {
        return undefined
      }
      const parsed = parseInt(process.env.PROXY_MAX_FREE_SOCKETS)
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
    })(),
    // IP协议族配置：true=IPv4, false=IPv6, 默认IPv4（兼容性更好）
    useIPv4: process.env.PROXY_USE_IPV4 !== 'false' // 默认 true，只有明确设置为 'false' 才使用 IPv6
  },

  // 🌐 OpenAI/Codex 多网卡出口配置
  openaiNicInterleave: {
    localAddresses: Array.from(
      new Set(
        (process.env.OPENAI_UPSTREAM_LOCAL_ADDRESSES || process.env.NIC_INTERLEAVE_IPS || '')
          .split(',')
          .map((address) => address.trim())
          .filter(Boolean)
      )
    )
  },

  // 📊 OAuth 账户额度/用量后台兜底刷新（Claude + OpenAI）
  oauthUsageRefresh: {
    enabled: process.env.OAUTH_USAGE_REFRESH_ENABLED !== 'false',
    intervalMinutes:
      parseInt(
        process.env.OAUTH_USAGE_REFRESH_INTERVAL_MINUTES ||
          process.env.OAUTH_USAGE_REFRESH_INTERVAL,
        10
      ) || 30,
    maxStalenessMinutes:
      parseInt(
        process.env.OAUTH_USAGE_REFRESH_MAX_STALENESS_MINUTES ||
          process.env.OAUTH_USAGE_MAX_STALENESS,
        10
      ) || 120,
    batchSize: parseInt(process.env.OAUTH_USAGE_REFRESH_BATCH_SIZE, 10) || 5,
    requestTimeoutMs: parseInt(process.env.OAUTH_USAGE_REFRESH_REQUEST_TIMEOUT_MS, 10) || 30000
  },

  // 请求明细 SQLite 仅作为可重建读索引；Redis 始终是权威数据源。
  requestDetailIndex: {
    enabled: process.env.REQUEST_DETAIL_SQLITE_INDEX_ENABLED === 'true',
    queryBackend: process.env.REQUEST_DETAIL_QUERY_BACKEND === 'sqlite' ? 'sqlite' : 'redis',
    sqlitePath:
      process.env.REQUEST_DETAIL_SQLITE_PATH ||
      path.join(__dirname, '..', 'data', 'request-details-index.sqlite3'),
    cacheMb: parseInt(process.env.REQUEST_DETAIL_SQLITE_CACHE_MB, 10) || 128,
    mmapMb: parseInt(process.env.REQUEST_DETAIL_SQLITE_MMAP_MB, 10) || 256,
    pendingBatchSize: parseInt(process.env.REQUEST_DETAIL_SQLITE_PENDING_BATCH_SIZE, 10) || 200,
    slowQueryMs: parseInt(process.env.REQUEST_DETAIL_SQLITE_SLOW_QUERY_MS, 10) || 500,
    recomputeLimit:
      process.env.REQUEST_DETAIL_SQLITE_RECOMPUTE_LIMIT === '0'
        ? 0
        : parseInt(process.env.REQUEST_DETAIL_SQLITE_RECOMPUTE_LIMIT, 10) || 256
  },

  // xAI Grok Responses provider
  grok: {
    enabled: process.env.GROK_PROVIDER_ENABLED === 'true',
    oauthClientId: process.env.XAI_OAUTH_CLIENT_ID || 'b1a00492-073a-47ea-816f-4c329264a828',
    oauthScope:
      process.env.XAI_OAUTH_SCOPE ||
      'openid profile email offline_access grok-cli:access api:access',
    oauthRedirectUri: process.env.XAI_OAUTH_REDIRECT_URI || 'http://127.0.0.1:56121/callback',
    oauthAuthorizeUrl: process.env.XAI_OAUTH_AUTHORIZE_URL || 'https://auth.x.ai/oauth2/authorize',
    oauthTokenUrl: process.env.XAI_OAUTH_TOKEN_URL || 'https://auth.x.ai/oauth2/token',
    apiBaseUrl: process.env.XAI_API_BASE_URL || 'https://api.x.ai/v1',
    cliBaseUrl: process.env.XAI_CLI_BASE_URL || 'https://cli-chat-proxy.grok.com/v1',
    cliVersion: parseGrokCliVersion(),
    directApiUserAgent: process.env.XAI_GROK_DIRECT_API_USER_AGENT || 'crs-grok/1.0',
    oauthCacheNativeTools: process.env.GROK_OAUTH_CACHE_NATIVE_TOOLS !== 'false',
    disconnectDrainIdleMs: parseGrokDrainIdleMs()
  },

  // ⏱️ 请求超时配置
  requestTimeout: REQUEST_TIMEOUT, // 默认 10 分钟

  // 📈 使用限制
  limits: {
    defaultTokenLimit: parseInt(process.env.DEFAULT_TOKEN_LIMIT) || 1000000
  },

  // 📝 日志配置
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    dirname: path.join(__dirname, '..', 'logs'),
    maxSize: process.env.LOG_MAX_SIZE || '10m',
    maxFiles: parseInt(process.env.LOG_MAX_FILES) || 5
  },

  // 🔧 系统配置
  system: {
    cleanupInterval: parseInt(process.env.CLEANUP_INTERVAL) || 3600000, // 1小时
    tokenUsageRetention: parseInt(process.env.TOKEN_USAGE_RETENTION) || 2592000000, // 30天
    healthCheckInterval: parseInt(process.env.HEALTH_CHECK_INTERVAL) || 60000, // 1分钟
    timezone: process.env.SYSTEM_TIMEZONE || 'Asia/Shanghai', // 默认UTC+8（中国时区）
    timezoneOffset: parseInt(process.env.TIMEZONE_OFFSET) || 8, // UTC偏移小时数，默认+8
    metricsWindow: parseInt(process.env.METRICS_WINDOW) || 5 // 实时指标统计窗口（分钟）
  },

  // 🎨 Web界面配置
  web: {
    title: process.env.WEB_TITLE || 'Claude Relay Service',
    description:
      process.env.WEB_DESCRIPTION ||
      'Multi-account Claude API relay service with beautiful management interface',
    logoUrl: process.env.WEB_LOGO_URL || '/assets/logo.png',
    enableCors: process.env.ENABLE_CORS === 'true',
    sessionSecret: process.env.WEB_SESSION_SECRET || 'CHANGE-THIS-SESSION-SECRET'
  },

  // 🔐 LDAP 认证配置
  ldap: {
    enabled: process.env.LDAP_ENABLED === 'true',
    server: {
      url: process.env.LDAP_URL || 'ldap://localhost:389',
      bindDN: process.env.LDAP_BIND_DN || 'cn=admin,dc=example,dc=com',
      bindCredentials: process.env.LDAP_BIND_PASSWORD || 'admin',
      searchBase: process.env.LDAP_SEARCH_BASE || 'dc=example,dc=com',
      searchFilter: process.env.LDAP_SEARCH_FILTER || '(uid={{username}})',
      searchAttributes: process.env.LDAP_SEARCH_ATTRIBUTES
        ? process.env.LDAP_SEARCH_ATTRIBUTES.split(',')
        : ['dn', 'uid', 'cn', 'mail', 'givenName', 'sn'],
      timeout: parseInt(process.env.LDAP_TIMEOUT) || 5000,
      connectTimeout: parseInt(process.env.LDAP_CONNECT_TIMEOUT) || 10000,
      // TLS/SSL 配置
      tls: {
        // 是否忽略证书错误 (用于自签名证书)
        rejectUnauthorized: process.env.LDAP_TLS_REJECT_UNAUTHORIZED !== 'false', // 默认验证证书，设置为false则忽略
        // CA证书文件路径 (可选，用于自定义CA证书)
        ca: process.env.LDAP_TLS_CA_FILE
          ? require('fs').readFileSync(process.env.LDAP_TLS_CA_FILE)
          : undefined,
        // 客户端证书文件路径 (可选，用于双向认证)
        cert: process.env.LDAP_TLS_CERT_FILE
          ? require('fs').readFileSync(process.env.LDAP_TLS_CERT_FILE)
          : undefined,
        // 客户端私钥文件路径 (可选，用于双向认证)
        key: process.env.LDAP_TLS_KEY_FILE
          ? require('fs').readFileSync(process.env.LDAP_TLS_KEY_FILE)
          : undefined,
        // 服务器名称 (用于SNI，可选)
        servername: process.env.LDAP_TLS_SERVERNAME || undefined
      }
    },
    userMapping: {
      username: process.env.LDAP_USER_ATTR_USERNAME || 'uid',
      displayName: process.env.LDAP_USER_ATTR_DISPLAY_NAME || 'cn',
      email: process.env.LDAP_USER_ATTR_EMAIL || 'mail',
      firstName: process.env.LDAP_USER_ATTR_FIRST_NAME || 'givenName',
      lastName: process.env.LDAP_USER_ATTR_LAST_NAME || 'sn'
    }
  },

  // 👥 用户管理配置
  userManagement: {
    enabled: process.env.USER_MANAGEMENT_ENABLED === 'true',
    defaultUserRole: process.env.DEFAULT_USER_ROLE || 'user',
    userSessionTimeout: parseInt(process.env.USER_SESSION_TIMEOUT) || 86400000, // 24小时
    maxApiKeysPerUser: parseInt(process.env.MAX_API_KEYS_PER_USER) || 1,
    allowUserDeleteApiKeys: process.env.ALLOW_USER_DELETE_API_KEYS === 'true' // 默认不允许用户删除自己的API Keys
  },

  // 📢 Webhook通知配置
  webhook: {
    enabled: process.env.WEBHOOK_ENABLED !== 'false', // 默认启用
    urls: process.env.WEBHOOK_URLS
      ? process.env.WEBHOOK_URLS.split(',').map((url) => url.trim())
      : [],
    timeout: parseInt(process.env.WEBHOOK_TIMEOUT) || 10000, // 10秒超时
    retries: parseInt(process.env.WEBHOOK_RETRIES) || 3 // 重试3次
  },

  // 🛠️ 开发配置
  development: {
    debug: process.env.DEBUG === 'true',
    hotReload: process.env.HOT_RELOAD === 'true'
  },

  // 💰 账户余额相关配置
  accountBalance: {
    // 是否允许执行自定义余额脚本（安全开关）
    // 说明：脚本能力可发起任意 HTTP 请求并在服务端执行 extractor 逻辑，建议仅在受控环境开启
    // 默认保持开启；如需禁用请显式设置：BALANCE_SCRIPT_ENABLED=false
    enableBalanceScript: process.env.BALANCE_SCRIPT_ENABLED !== 'false'
  },

  // 📬 用户消息队列配置
  // 优化说明：锁在请求发送成功后立即释放（而非请求完成后），因为 Claude API 限流基于请求发送时刻计算
  userMessageQueue: {
    enabled: process.env.USER_MESSAGE_QUEUE_ENABLED === 'true', // 默认关闭
    delayMs: parseInt(process.env.USER_MESSAGE_QUEUE_DELAY_MS) || 200, // 请求间隔（毫秒）
    timeoutMs: parseInt(process.env.USER_MESSAGE_QUEUE_TIMEOUT_MS) || 5000, // 队列等待超时（毫秒），锁持有时间短，无需长等待
    lockTtlMs: parseInt(process.env.USER_MESSAGE_QUEUE_LOCK_TTL_MS) || 5000 // 锁TTL（毫秒），5秒足以覆盖请求发送
  },

  // 🎫 额度卡兑换上限配置（防盗刷）
  quotaCardLimits: {
    enabled: process.env.QUOTA_CARD_LIMITS_ENABLED !== 'false', // 默认启用
    maxExpiryDays: parseInt(process.env.QUOTA_CARD_MAX_EXPIRY_DAYS) || 90, // 最大有效期距今天数
    maxTotalCostLimit: parseFloat(process.env.QUOTA_CARD_MAX_TOTAL_COST_LIMIT) || 1000 // 最大总额度（美元）
  },

  // ⏱️ 上游错误自动暂停配置
  // 说明：此处是全局默认值。Claude 官方 OAuth 账号可在后台做账号级 503/5xx 覆盖，
  // 且可通过账号设置禁用 temp_unavailable（账号级策略优先于全局默认值）。
  upstreamError: {
    serviceUnavailableTtlSeconds: parseInt(process.env.UPSTREAM_ERROR_503_TTL_SECONDS) || 60, // 503错误暂停秒数
    serverErrorTtlSeconds: parseInt(process.env.UPSTREAM_ERROR_5XX_TTL_SECONDS) || 300, // 5xx错误暂停秒数
    overloadTtlSeconds: parseInt(process.env.UPSTREAM_ERROR_OVERLOAD_TTL_SECONDS) || 600, // 529过载暂停秒数
    authErrorTtlSeconds: parseInt(process.env.UPSTREAM_ERROR_AUTH_TTL_SECONDS) || 1800, // 401/403认证错误暂停秒数
    timeoutTtlSeconds: parseInt(process.env.UPSTREAM_ERROR_TIMEOUT_TTL_SECONDS) || 300, // 504超时暂停秒数
    // Cap upstream retry-after values used for transient temp-unavailable keys.
    maxCustomTtlSeconds: parseInt(process.env.UPSTREAM_ERROR_MAX_CUSTOM_TTL_SECONDS) || 1800
  }
}

module.exports = config
