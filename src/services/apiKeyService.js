const crypto = require('crypto')
const bcrypt = require('bcryptjs')
const { v4: uuidv4 } = require('uuid')
const config = require('../../config/config')
const redis = require('../models/redis')
const logger = require('../utils/logger')
const serviceRatesService = require('./serviceRatesService')
const requestDetailService = require('./requestDetailService')
const { isClaudeFamilyModel } = require('../utils/modelHelper')
const { finalizeRequestDetailMeta } = require('../utils/requestDetailHelper')
const requestBodyRuleService = require('./requestBodyRuleService')
const { normalizeIpWhitelist, validateIpWhitelist } = require('../utils/ipWhitelistHelper')
const { encrypt, decrypt } = require('../utils/commonHelper')

const ACCOUNT_TYPE_CONFIG = {
  claude: { prefix: 'claude:account:' },
  'claude-console': { prefix: 'claude_console_account:' },
  openai: { prefix: 'openai:account:' },
  'openai-responses': { prefix: 'openai_responses_account:' },
  'azure-openai': { prefix: 'azure_openai:account:' },
  gemini: { prefix: 'gemini_account:' },
  'gemini-api': { prefix: 'gemini_api_account:' },
  droid: { prefix: 'droid:account:' }
}

const ACCOUNT_TYPE_PRIORITY = [
  'openai',
  'openai-responses',
  'azure-openai',
  'claude',
  'claude-console',
  'gemini',
  'gemini-api',
  'droid'
]

const ACCOUNT_CATEGORY_MAP = {
  claude: 'claude',
  'claude-console': 'claude',
  openai: 'openai',
  'openai-responses': 'openai',
  'azure-openai': 'openai',
  gemini: 'gemini',
  'gemini-api': 'gemini',
  droid: 'droid'
}

/**
 * 规范化权限数据，兼容旧格式（字符串）和新格式（数组）
 * @param {string|array} permissions - 权限数据
 * @returns {array} - 权限数组，空数组表示全部服务
 */
function normalizePermissions(permissions) {
  if (!permissions) {
    return [] // 空 = 全部服务
  }
  if (Array.isArray(permissions)) {
    return permissions
  }
  // 尝试解析 JSON 字符串（新格式存储）
  if (typeof permissions === 'string') {
    if (permissions.startsWith('[')) {
      try {
        const parsed = JSON.parse(permissions)
        if (Array.isArray(parsed)) {
          return parsed
        }
      } catch (e) {
        // 解析失败，继续处理为普通字符串
      }
    }
    // 旧格式 'all' 转为空数组
    if (permissions === 'all') {
      return []
    }
    // 兼容逗号分隔格式（修复历史错误数据，如 "claude,openai"）
    if (permissions.includes(',')) {
      return permissions
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
    }
    // 旧单个字符串转为数组
    return [permissions]
  }
  return []
}

/**
 * 检查是否有访问特定服务的权限
 * @param {string|array} permissions - 权限数据
 * @param {string} service - 服务名称（claude/gemini/openai/droid）
 * @returns {boolean} - 是否有权限
 */
function hasPermission(permissions, service) {
  const perms = normalizePermissions(permissions)
  return perms.length === 0 || perms.includes(service) // 空数组 = 全部服务
}

function normalizeAccountTypeKey(type) {
  if (!type) {
    return null
  }
  const lower = String(type).toLowerCase()
  if (lower === 'claude_console') {
    return 'claude-console'
  }
  if (lower === 'openai_responses' || lower === 'openai-response' || lower === 'openai-responses') {
    return 'openai-responses'
  }
  if (lower === 'azure_openai' || lower === 'azureopenai' || lower === 'azure-openai') {
    return 'azure-openai'
  }
  if (lower === 'gemini_api' || lower === 'gemini-api') {
    return 'gemini-api'
  }
  return lower
}

function sanitizeAccountIdForType(accountId, accountType) {
  if (!accountId || typeof accountId !== 'string') {
    return accountId
  }
  if (accountType === 'openai-responses') {
    return accountId.replace(/^responses:/, '')
  }
  if (accountType === 'gemini-api') {
    return accountId.replace(/^api:/, '')
  }
  return accountId
}

function parseBooleanWithDefault(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') {
    return defaultValue
  }

  if (typeof value === 'boolean') {
    return value
  }

  if (typeof value === 'string') {
    return value === 'true'
  }

  return Boolean(value)
}

function parseOpenAIResponsesPayloadRules(rawRules) {
  if (rawRules === undefined || rawRules === null || rawRules === '') {
    return []
  }

  let parsedRules = rawRules
  if (typeof rawRules === 'string') {
    try {
      parsedRules = JSON.parse(rawRules)
    } catch (error) {
      return []
    }
  }

  if (!Array.isArray(parsedRules)) {
    return []
  }

  return parsedRules.map((rule) => requestBodyRuleService.normalizeRule(rule)).filter(Boolean)
}

// 🆕 v2 子 key 运行时从父账号继承的字段
// 账户绑定字段：仅在真实调用路径(validateApiKey)继承，绝不在公开 stats 路径暴露给前台
const V2_INHERIT_ACCOUNT_FIELDS = [
  'claudeAccountId',
  'claudeConsoleAccountId',
  'geminiAccountId',
  'openaiAccountId',
  'azureOpenaiAccountId',
  'bedrockAccountId',
  'droidAccountId'
]
// 配置字段：权限/限制/倍率/特性开关（不含账户身份），真实调用与 stats 展示都应一致继承
const V2_INHERIT_CONFIG_FIELDS = [
  'permissions',
  'enableModelRestriction',
  'restrictedModels',
  'enableClientRestriction',
  'allowedClients',
  'enableIpWhitelist',
  'ipWhitelist',
  'concurrencyLimit',
  'rateLimitWindow',
  'rateLimitRequests',
  'rateLimitCost',
  'weeklyOpusCostLimit',
  'weeklyResetDay',
  'weeklyResetHour',
  'serviceRates',
  'disableGptFastMode',
  'enableGeneralOpenAIEndpoint',
  'enableGeneralPromptCacheAssist',
  'enableClaudeThinkingSignatureLossyFallback',
  'enableOpenAIResponsesCodexAdaptation',
  'enableOpenAIResponsesPayloadRules',
  'openaiResponsesPayloadRules'
]

const V2_ADMIN_BOOLEAN_INHERIT_FIELDS = new Set([
  'enableModelRestriction',
  'enableClientRestriction',
  'enableIpWhitelist',
  'disableGptFastMode',
  'enableGeneralOpenAIEndpoint',
  'enableGeneralPromptCacheAssist',
  'enableClaudeThinkingSignatureLossyFallback',
  'enableOpenAIResponsesCodexAdaptation',
  'enableOpenAIResponsesPayloadRules'
])

const V2_ADMIN_INTEGER_INHERIT_FIELDS = new Set([
  'concurrencyLimit',
  'rateLimitWindow',
  'rateLimitRequests',
  'weeklyResetDay',
  'weeklyResetHour'
])

const V2_ADMIN_FLOAT_INHERIT_FIELDS = new Set(['rateLimitCost', 'weeklyOpusCostLimit'])

const V2_ADMIN_ARRAY_INHERIT_FIELDS = new Set(['restrictedModels', 'allowedClients'])

// 🆕 单个 v2 父账号的子 key 数量上限（按未软删除数量计，env 可覆盖；非法值回退 100）
const V2_MAX_CHILD_KEYS = (() => {
  const parsed = parseInt(process.env.V2_MAX_CHILD_KEYS || '100', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 100
})()

// 🆕 v2 自助 IP 白名单条目上限（仅约束 v2 两条自助路径，防 auth 线性扫描/hash 膨胀）
const V2_MAX_IP_WHITELIST_ENTRIES = 100

// 🆕 子 key 是否声明「自定义 IP 白名单」（覆盖账号级默认）。
// 注意：v2IpWhitelistOverride 绝不可加入 V2_INHERIT_CONFIG_FIELDS（它本身不是被继承的配置）
function isV2IpWhitelistOverrideEnabled(keyData) {
  return keyData?.v2IpWhitelistOverride === true || keyData?.v2IpWhitelistOverride === 'true'
}

// 🆕 v2 overlay 需跳过继承的字段：仅在子 key 开启自定义白名单时跳过 IP 白名单两个配置字段，
// 账户绑定等其余字段照常继承。override≠true 时返回空集——即使子 key 残留旧原始白名单
// （管理员后台编辑路径可能写过），也一律以父账号值覆盖，防止旧值参与判定
function getV2InheritSkipFields(keyData) {
  if (!isV2IpWhitelistOverrideEnabled(keyData)) {
    return new Set()
  }
  return new Set(['enableIpWhitelist', 'ipWhitelist'])
}

// 🆕 v2 自助接口布尔入参口径（与 updateV2Child 的 isActive 一致）：bool 或 'true'/'false' 字符串
function parseV2Boolean(value, fieldName) {
  if (typeof value === 'boolean') {
    return value
  }
  if (value === 'true' || value === 'false') {
    return value === 'true'
  }
  throw new Error(`${fieldName} must be a boolean`)
}

function parseJsonArrayWithDefault(value) {
  if (Array.isArray(value)) {
    return value
  }
  if (value === undefined || value === null || value === '') {
    return []
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

function parseJsonObjectWithDefault(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value
  }
  if (value === undefined || value === null || value === '') {
    return {}
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }
  return {}
}

function normalizeV2InheritedFieldForAdmin(field, value) {
  if (field === 'permissions') {
    return normalizePermissions(value)
  }
  if (V2_ADMIN_BOOLEAN_INHERIT_FIELDS.has(field)) {
    return parseBooleanWithDefault(value, field === 'enableOpenAIResponsesCodexAdaptation')
  }
  if (V2_ADMIN_INTEGER_INHERIT_FIELDS.has(field)) {
    return parseInt(value) || 0
  }
  if (V2_ADMIN_FLOAT_INHERIT_FIELDS.has(field)) {
    return parseFloat(value) || 0
  }
  if (V2_ADMIN_ARRAY_INHERIT_FIELDS.has(field)) {
    return parseJsonArrayWithDefault(value)
  }
  if (field === 'ipWhitelist') {
    return normalizeIpWhitelist(value)
  }
  if (field === 'serviceRates') {
    return parseJsonObjectWithDefault(value)
  }
  if (field === 'openaiResponsesPayloadRules') {
    return parseOpenAIResponsesPayloadRules(value)
  }
  return value
}

class ApiKeyService {
  constructor() {
    this.prefix = config.security.apiKeyPrefix
  }

  // 🔑 生成新的API Key
  async generateApiKey(options = {}) {
    const {
      name = 'Unnamed Key',
      description = '',
      tokenLimit = 0, // 默认为0，不再使用token限制
      expiresAt = null,
      claudeAccountId = null,
      claudeConsoleAccountId = null,
      geminiAccountId = null,
      openaiAccountId = null,
      azureOpenaiAccountId = null,
      bedrockAccountId = null, // 添加 Bedrock 账号ID支持
      droidAccountId = null,
      permissions = [], // 数组格式，空数组表示全部服务，如 ['claude', 'gemini']
      isActive = true,
      concurrencyLimit = 0,
      rateLimitWindow = null,
      rateLimitRequests = null,
      rateLimitCost = null, // 新增：速率限制费用字段
      enableModelRestriction = false,
      restrictedModels = [],
      enableClientRestriction = false,
      allowedClients = [],
      enableIpWhitelist = false,
      ipWhitelist = [],
      dailyCostLimit = 0,
      totalCostLimit = 0,
      weeklyOpusCostLimit = 0,
      tags = [],
      activationDays = 0, // 新增：激活后有效天数（0表示不使用此功能）
      activationUnit = 'days', // 新增：激活时间单位 'hours' 或 'days'
      expirationMode = 'fixed', // 新增：过期模式 'fixed'(固定时间) 或 'activation'(首次使用后激活)
      icon = '', // 新增：图标（base64编码）
      serviceRates = {}, // API Key 级别服务倍率覆盖
      weeklyResetDay = 1, // 周费用重置日 (1=周一 ... 7=周日)
      weeklyResetHour = 0, // 周费用重置时 (0-23)
      disableGptFastMode = false,
      enableGeneralOpenAIEndpoint = false,
      enableGeneralPromptCacheAssist = false,
      enableClaudeThinkingSignatureLossyFallback = false,
      enableOpenAIResponsesCodexAdaptation = true,
      enableOpenAIResponsesPayloadRules = false,
      openaiResponsesPayloadRules = []
    } = options

    const payloadRulesValidation = requestBodyRuleService.validateAndNormalizeRules(
      openaiResponsesPayloadRules
    )
    if (!payloadRulesValidation.valid) {
      throw new Error(payloadRulesValidation.error)
    }

    // 生成简单的API Key (64字符十六进制)
    const apiKey = `${this.prefix}${this._generateSecretKey()}`
    const keyId = uuidv4()
    const hashedKey = this._hashApiKey(apiKey)

    // 处理 permissions
    const _permissionsValue = permissions

    const keyData = {
      id: keyId,
      name,
      description,
      apiKey: hashedKey,
      encryptedApiKey: encrypt(apiKey), // 🆕 可逆明文副本，仅供 reveal，绝不随列表/详情/导出返回
      tokenLimit: String(tokenLimit ?? 0),
      concurrencyLimit: String(concurrencyLimit ?? 0),
      rateLimitWindow: String(rateLimitWindow ?? 0),
      rateLimitRequests: String(rateLimitRequests ?? 0),
      rateLimitCost: String(rateLimitCost ?? 0), // 新增：速率限制费用字段
      isActive: String(isActive),
      claudeAccountId: claudeAccountId || '',
      claudeConsoleAccountId: claudeConsoleAccountId || '',
      geminiAccountId: geminiAccountId || '',
      openaiAccountId: openaiAccountId || '',
      azureOpenaiAccountId: azureOpenaiAccountId || '',
      bedrockAccountId: bedrockAccountId || '', // 添加 Bedrock 账号ID
      droidAccountId: droidAccountId || '',
      permissions: JSON.stringify(normalizePermissions(permissions)),
      enableModelRestriction: String(enableModelRestriction),
      restrictedModels: JSON.stringify(restrictedModels || []),
      enableClientRestriction: String(enableClientRestriction || false),
      allowedClients: JSON.stringify(allowedClients || []),
      enableIpWhitelist: String(enableIpWhitelist || false),
      ipWhitelist: JSON.stringify(normalizeIpWhitelist(ipWhitelist)),
      dailyCostLimit: String(dailyCostLimit || 0),
      totalCostLimit: String(totalCostLimit || 0),
      weeklyOpusCostLimit: String(weeklyOpusCostLimit || 0),
      tags: JSON.stringify(tags || []),
      activationDays: String(activationDays || 0), // 新增：激活后有效天数
      activationUnit: activationUnit || 'days', // 新增：激活时间单位
      expirationMode: expirationMode || 'fixed', // 新增：过期模式
      isActivated: expirationMode === 'fixed' ? 'true' : 'false', // 根据模式决定激活状态
      activatedAt: expirationMode === 'fixed' ? new Date().toISOString() : '', // 激活时间
      createdAt: new Date().toISOString(),
      lastUsedAt: '',
      expiresAt: expirationMode === 'fixed' ? expiresAt || '' : '', // 固定模式才设置过期时间
      createdBy: options.createdBy || 'admin',
      userId: options.userId || '',
      userUsername: options.userUsername || '',
      icon: icon || '', // 新增：图标（base64编码）
      serviceRates: JSON.stringify(serviceRates || {}), // API Key 级别服务倍率
      weeklyResetDay: String(weeklyResetDay || 1), // 周费用重置日 (1-7)
      weeklyResetHour: String(weeklyResetHour || 0), // 周费用重置时 (0-23)
      disableGptFastMode: String(disableGptFastMode === true),
      enableGeneralOpenAIEndpoint: String(enableGeneralOpenAIEndpoint === true),
      enableGeneralPromptCacheAssist: String(enableGeneralPromptCacheAssist === true),
      enableClaudeThinkingSignatureLossyFallback: String(
        enableClaudeThinkingSignatureLossyFallback === true
      ),
      enableOpenAIResponsesCodexAdaptation: String(enableOpenAIResponsesCodexAdaptation !== false),
      enableOpenAIResponsesPayloadRules: String(enableOpenAIResponsesPayloadRules === true),
      openaiResponsesPayloadRules: JSON.stringify(payloadRulesValidation.rules)
    }

    // 🆕 v2 字段（仅在升级/子 key 创建场景写入，普通 key 不污染）
    if (options.parentKeyId) {
      keyData.parentKeyId = options.parentKeyId // v2 子 key 归属父账号
    }
    if (options.isV2Parent) {
      keyData.isV2Parent = 'true'
      keyData.v2Email = options.v2Email || ''
      keyData.v2PasswordHash = options.v2PasswordHash || ''
      keyData.v2TotalBudget = String(options.v2TotalBudget || 0)
      keyData.v2UpgradedAt = options.v2UpgradedAt || new Date().toISOString()
    }

    // 保存API Key数据并建立哈希映射
    await redis.setApiKey(keyId, keyData, hashedKey)

    // 同步添加到费用排序索引
    try {
      const costRankService = require('./costRankService')
      await costRankService.addKeyToIndexes(keyId)
    } catch (err) {
      logger.warn(`Failed to add key ${keyId} to cost rank indexes:`, err.message)
    }

    // 同步添加到 API Key 索引（用于分页查询优化）
    try {
      const apiKeyIndexService = require('./apiKeyIndexService')
      await apiKeyIndexService.addToIndex({
        id: keyId,
        name: keyData.name,
        createdAt: keyData.createdAt,
        lastUsedAt: keyData.lastUsedAt,
        isActive: keyData.isActive === 'true',
        isDeleted: false,
        tags: JSON.parse(keyData.tags || '[]')
      })
    } catch (err) {
      logger.warn(`Failed to add key ${keyId} to API Key index:`, err.message)
    }

    logger.success(`🔑 Generated new API key: ${name} (${keyId})`)

    return {
      id: keyId,
      apiKey, // 只在创建时返回完整的key
      name: keyData.name,
      description: keyData.description,
      tokenLimit: parseInt(keyData.tokenLimit),
      concurrencyLimit: parseInt(keyData.concurrencyLimit),
      rateLimitWindow: parseInt(keyData.rateLimitWindow || 0),
      rateLimitRequests: parseInt(keyData.rateLimitRequests || 0),
      rateLimitCost: parseFloat(keyData.rateLimitCost || 0), // 新增：速率限制费用字段
      isActive: keyData.isActive === 'true',
      claudeAccountId: keyData.claudeAccountId,
      claudeConsoleAccountId: keyData.claudeConsoleAccountId,
      geminiAccountId: keyData.geminiAccountId,
      openaiAccountId: keyData.openaiAccountId,
      azureOpenaiAccountId: keyData.azureOpenaiAccountId,
      bedrockAccountId: keyData.bedrockAccountId, // 添加 Bedrock 账号ID
      droidAccountId: keyData.droidAccountId,
      permissions: normalizePermissions(keyData.permissions),
      enableModelRestriction: keyData.enableModelRestriction === 'true',
      restrictedModels: JSON.parse(keyData.restrictedModels),
      enableClientRestriction: keyData.enableClientRestriction === 'true',
      allowedClients: JSON.parse(keyData.allowedClients || '[]'),
      enableIpWhitelist: keyData.enableIpWhitelist === 'true',
      ipWhitelist: normalizeIpWhitelist(keyData.ipWhitelist),
      dailyCostLimit: parseFloat(keyData.dailyCostLimit || 0),
      totalCostLimit: parseFloat(keyData.totalCostLimit || 0),
      weeklyOpusCostLimit: parseFloat(keyData.weeklyOpusCostLimit || 0),
      tags: JSON.parse(keyData.tags || '[]'),
      activationDays: parseInt(keyData.activationDays || 0),
      activationUnit: keyData.activationUnit || 'days',
      expirationMode: keyData.expirationMode || 'fixed',
      isActivated: keyData.isActivated === 'true',
      activatedAt: keyData.activatedAt,
      createdAt: keyData.createdAt,
      expiresAt: keyData.expiresAt,
      createdBy: keyData.createdBy,
      serviceRates: JSON.parse(keyData.serviceRates || '{}'), // API Key 级别服务倍率
      disableGptFastMode: parseBooleanWithDefault(keyData.disableGptFastMode, false),
      enableGeneralOpenAIEndpoint: parseBooleanWithDefault(
        keyData.enableGeneralOpenAIEndpoint,
        false
      ),
      enableGeneralPromptCacheAssist: parseBooleanWithDefault(
        keyData.enableGeneralPromptCacheAssist,
        false
      ),
      enableClaudeThinkingSignatureLossyFallback: parseBooleanWithDefault(
        keyData.enableClaudeThinkingSignatureLossyFallback,
        false
      ),
      enableOpenAIResponsesCodexAdaptation: parseBooleanWithDefault(
        keyData.enableOpenAIResponsesCodexAdaptation,
        true
      ),
      enableOpenAIResponsesPayloadRules: parseBooleanWithDefault(
        keyData.enableOpenAIResponsesPayloadRules,
        false
      ),
      openaiResponsesPayloadRules: parseOpenAIResponsesPayloadRules(
        keyData.openaiResponsesPayloadRules
      )
    }
  }

  // 🔍 验证API Key
  async validateApiKey(apiKey) {
    try {
      if (!apiKey || !apiKey.startsWith(this.prefix)) {
        return { valid: false, error: 'Invalid API key format' }
      }

      // 计算API Key的哈希值
      const hashedKey = this._hashApiKey(apiKey)

      // 通过哈希值直接查找API Key（性能优化）
      const keyData = await redis.findApiKeyByHash(hashedKey)

      if (!keyData) {
        // ⚠️ 警告：映射表查找失败，可能是竞态条件或映射表损坏
        logger.warn(
          `⚠️ API key not found in hash map: ${hashedKey.substring(0, 16)}... (possible race condition or corrupted hash map)`
        )
        return { valid: false, error: 'API key not found' }
      }

      // 检查是否激活
      if (keyData.isActive !== 'true') {
        return { valid: false, error: 'API key is disabled' }
      }

      // 🆕 已软删除的 key 一律拒绝（fail-closed，防止 hash 被意外重建后恢复调用能力）
      if (keyData.isDeleted === 'true') {
        return { valid: false, error: 'API key has been deleted' }
      }

      // 处理激活逻辑（仅在 activation 模式下）
      if (keyData.expirationMode === 'activation' && keyData.isActivated !== 'true') {
        // 首次使用，需要激活
        const now = new Date()
        const activationPeriod = parseInt(keyData.activationDays || 30) // 默认30
        const activationUnit = keyData.activationUnit || 'days' // 默认天

        // 根据单位计算过期时间
        let milliseconds
        if (activationUnit === 'hours') {
          milliseconds = activationPeriod * 60 * 60 * 1000 // 小时转毫秒
        } else {
          milliseconds = activationPeriod * 24 * 60 * 60 * 1000 // 天转毫秒
        }

        const expiresAt = new Date(now.getTime() + milliseconds)

        // 更新激活状态和过期时间
        keyData.isActivated = 'true'
        keyData.activatedAt = now.toISOString()
        keyData.expiresAt = expiresAt.toISOString()
        keyData.lastUsedAt = now.toISOString()

        // 保存到Redis
        await redis.setApiKey(keyData.id, keyData)

        logger.success(
          `🔓 API key activated: ${keyData.id} (${
            keyData.name
          }), will expire in ${activationPeriod} ${activationUnit} at ${expiresAt.toISOString()}`
        )
      }

      // 检查是否过期
      if (keyData.expiresAt && new Date() > new Date(keyData.expiresAt)) {
        return { valid: false, error: 'API key has expired' }
      }

      // 如果API Key属于某个用户，检查用户是否被禁用
      if (keyData.userId) {
        try {
          const userService = require('./userService')
          const user = await userService.getUserById(keyData.userId, false)
          if (!user || !user.isActive) {
            return { valid: false, error: 'User account is disabled' }
          }
        } catch (error) {
          logger.error('❌ Error checking user status during API key validation:', error)
          return { valid: false, error: 'Unable to validate user status' }
        }
      }

      // 🆕 v2 账号逻辑
      // 1) v2 父账号本身不可用于 API 调用（hash 已删除，此处为双保险，由 auth 层返回 403）
      if (keyData.isV2Parent === 'true') {
        return {
          valid: true,
          keyData: { id: keyData.id, name: keyData.name, isV2Parent: true }
        }
      }

      // 2) v2 子 key：实时继承父账号配置（在费用查询/字段解析之前覆盖到 keyData）
      let v2Budget = null
      if (keyData.parentKeyId) {
        const parentData = await redis.getApiKey(keyData.parentKeyId)
        if (
          !parentData ||
          Object.keys(parentData).length === 0 ||
          parentData.isV2Parent !== 'true' ||
          parentData.isActive !== 'true' ||
          parentData.isDeleted === 'true'
        ) {
          return { valid: false, error: 'Parent v2 account is disabled' }
        }
        // 覆盖可继承字段（账户绑定 + 配置）；保留子的 id/name/description/expiresAt/dailyCostLimit/totalCostLimit
        // 子 key 开启自定义 IP 白名单时跳过白名单两字段，使用子 key 自己的值
        const skipFields = getV2InheritSkipFields(keyData)
        for (const f of [...V2_INHERIT_ACCOUNT_FIELDS, ...V2_INHERIT_CONFIG_FIELDS]) {
          if (skipFields.has(f)) {
            continue
          }
          if (parentData[f] !== undefined) {
            keyData[f] = parentData[f]
          }
        }
        // 父账号总账信息（供 auth 层做总账 402 校验）
        const parentBudget = parseFloat(parentData.v2TotalBudget || 0)
        const parentUsed = await redis.getV2ParentTotalCost(keyData.parentKeyId)
        v2Budget = {
          v2TotalBudget: parentBudget,
          v2ParentTotalCost: parentUsed,
          v2ParentUnlimited: !(parentBudget > 0),
          v2ParentRemaining: parentBudget > 0 ? Math.max(0, parentBudget - parentUsed) : null
        }
      }

      // 按需获取费用统计（仅在有限制时查询，减少 Redis 调用）
      const dailyCostLimit = parseFloat(keyData.dailyCostLimit || 0)
      const totalCostLimit = parseFloat(keyData.totalCostLimit || 0)
      const weeklyOpusCostLimit = parseFloat(keyData.weeklyOpusCostLimit || 0)

      const costQueries = []
      if (dailyCostLimit > 0) {
        costQueries.push(redis.getDailyCost(keyData.id).then((v) => ({ dailyCost: v || 0 })))
      }
      if (totalCostLimit > 0) {
        costQueries.push(redis.getCostStats(keyData.id).then((v) => ({ totalCost: v?.total || 0 })))
      }
      if (weeklyOpusCostLimit > 0) {
        const resetDay = parseInt(keyData.weeklyResetDay || 1)
        const resetHour = parseInt(keyData.weeklyResetHour || 0)
        costQueries.push(
          redis
            .getWeeklyOpusCost(keyData.id, resetDay, resetHour)
            .then((v) => ({ weeklyOpusCost: v || 0 }))
        )
      }

      const costData =
        costQueries.length > 0 ? Object.assign({}, ...(await Promise.all(costQueries))) : {}

      // 更新最后使用时间（优化：只在实际API调用时更新，而不是验证时）
      // 注意：lastUsedAt的更新已移至recordUsage方法中

      logger.api(`🔓 API key validated successfully: ${keyData.id}`)

      // 解析限制模型数据
      let restrictedModels = []
      try {
        restrictedModels = keyData.restrictedModels ? JSON.parse(keyData.restrictedModels) : []
      } catch (e) {
        restrictedModels = []
      }

      // 解析允许的客户端
      let allowedClients = []
      try {
        allowedClients = keyData.allowedClients ? JSON.parse(keyData.allowedClients) : []
      } catch (e) {
        allowedClients = []
      }

      const ipWhitelist = normalizeIpWhitelist(keyData.ipWhitelist)

      // 解析标签
      let tags = []
      try {
        tags = keyData.tags ? JSON.parse(keyData.tags) : []
      } catch (e) {
        tags = []
      }

      // 解析 serviceRates
      let serviceRates = {}
      try {
        serviceRates = keyData.serviceRates ? JSON.parse(keyData.serviceRates) : {}
      } catch (e) {
        // 解析失败使用默认值
      }

      const openaiResponsesPayloadRules = parseOpenAIResponsesPayloadRules(
        keyData.openaiResponsesPayloadRules
      )
      const enableOpenAIResponsesCodexAdaptation = parseBooleanWithDefault(
        keyData.enableOpenAIResponsesCodexAdaptation,
        true
      )
      const enableOpenAIResponsesPayloadRules = parseBooleanWithDefault(
        keyData.enableOpenAIResponsesPayloadRules,
        false
      )
      const disableGptFastMode = parseBooleanWithDefault(keyData.disableGptFastMode, false)
      const enableGeneralOpenAIEndpoint = parseBooleanWithDefault(
        keyData.enableGeneralOpenAIEndpoint,
        false
      )
      const enableGeneralPromptCacheAssist = parseBooleanWithDefault(
        keyData.enableGeneralPromptCacheAssist,
        false
      )
      const enableClaudeThinkingSignatureLossyFallback = parseBooleanWithDefault(
        keyData.enableClaudeThinkingSignatureLossyFallback,
        false
      )

      return {
        valid: true,
        keyData: {
          id: keyData.id,
          name: keyData.name,
          description: keyData.description,
          createdAt: keyData.createdAt,
          expiresAt: keyData.expiresAt,
          claudeAccountId: keyData.claudeAccountId,
          claudeConsoleAccountId: keyData.claudeConsoleAccountId,
          geminiAccountId: keyData.geminiAccountId,
          openaiAccountId: keyData.openaiAccountId,
          azureOpenaiAccountId: keyData.azureOpenaiAccountId,
          bedrockAccountId: keyData.bedrockAccountId, // 添加 Bedrock 账号ID
          droidAccountId: keyData.droidAccountId,
          permissions: normalizePermissions(keyData.permissions),
          tokenLimit: parseInt(keyData.tokenLimit),
          concurrencyLimit: parseInt(keyData.concurrencyLimit || 0),
          rateLimitWindow: parseInt(keyData.rateLimitWindow || 0),
          rateLimitRequests: parseInt(keyData.rateLimitRequests || 0),
          rateLimitCost: parseFloat(keyData.rateLimitCost || 0), // 新增：速率限制费用字段
          enableModelRestriction: keyData.enableModelRestriction === 'true',
          restrictedModels,
          enableClientRestriction: keyData.enableClientRestriction === 'true',
          allowedClients,
          enableIpWhitelist: keyData.enableIpWhitelist === 'true',
          ipWhitelist,
          dailyCostLimit,
          totalCostLimit,
          weeklyOpusCostLimit,
          dailyCost: costData.dailyCost || 0,
          totalCost: costData.totalCost || 0,
          weeklyOpusCost: costData.weeklyOpusCost || 0,
          weeklyResetDay: parseInt(keyData.weeklyResetDay || 1),
          weeklyResetHour: parseInt(keyData.weeklyResetHour || 0),
          tags,
          serviceRates,
          disableGptFastMode,
          enableGeneralOpenAIEndpoint,
          enableGeneralPromptCacheAssist,
          enableClaudeThinkingSignatureLossyFallback,
          enableOpenAIResponsesCodexAdaptation,
          enableOpenAIResponsesPayloadRules,
          openaiResponsesPayloadRules,
          // 🆕 v2 字段：子 key 归属与父账号总账（父账号已在上方提前返回）
          isV2Parent: false,
          parentKeyId: keyData.parentKeyId || null,
          ...(v2Budget || {})
        }
      }
    } catch (error) {
      logger.error('❌ API key validation error:', error)
      return { valid: false, error: 'Internal validation error' }
    }
  }

  // 🔍 验证API Key（仅用于统计查询，不触发激活）
  async validateApiKeyForStats(apiKey) {
    try {
      if (!apiKey || !apiKey.startsWith(this.prefix)) {
        return { valid: false, error: 'Invalid API key format' }
      }

      // 计算API Key的哈希值
      const hashedKey = this._hashApiKey(apiKey)

      // 通过哈希值直接查找API Key（性能优化）
      const keyData = await redis.findApiKeyByHash(hashedKey)

      if (!keyData) {
        return { valid: false, error: 'API key not found' }
      }

      // 检查是否激活
      if (keyData.isActive !== 'true') {
        const keyName = keyData.name || 'Unknown'
        return { valid: false, error: `API Key "${keyName}" 已被禁用`, keyName }
      }

      // 注意：这里不处理激活逻辑，保持 API Key 的未激活状态

      // 检查是否过期（仅对已激活的 Key 检查）
      if (
        keyData.isActivated === 'true' &&
        keyData.expiresAt &&
        new Date() > new Date(keyData.expiresAt)
      ) {
        const keyName = keyData.name || 'Unknown'
        return { valid: false, error: `API Key "${keyName}" 已过期`, keyName }
      }

      // 如果API Key属于某个用户，检查用户是否被禁用
      if (keyData.userId) {
        try {
          const userService = require('./userService')
          const user = await userService.getUserById(keyData.userId, false)
          if (!user || !user.isActive) {
            return { valid: false, error: 'User account is disabled' }
          }
        } catch (userError) {
          // 如果用户服务出错，记录但不影响API Key验证
          logger.warn(`Failed to check user status for API key ${keyData.id}:`, userError)
        }
      }

      // 🆕 v2 父账号不可作为 stats key（hash 已删除，此处双保险）
      if (keyData.isV2Parent === 'true') {
        const keyName = keyData.name || 'Unknown'
        return {
          valid: false,
          error: `API Key "${keyName}" 是 v2 父账号，无法用于统计查询`,
          keyName
        }
      }

      // 🆕 v2 子 key：继承父账号的「配置」字段（权限/模型限制/客户端限制/IP白名单/serviceRates 等），
      // 使统计/测试展示与真实调用一致；但绝不继承账户绑定 ID，避免公开 stats 泄漏上游账户身份。
      await this._overlayV2ParentConfigForStats(keyData)

      // 获取当日费用
      const [dailyCost, costStats] = await Promise.all([
        redis.getDailyCost(keyData.id),
        redis.getCostStats(keyData.id)
      ])

      // 获取使用统计
      const usage = await redis.getUsageStats(keyData.id)

      // 解析限制模型数据
      let restrictedModels = []
      try {
        restrictedModels = keyData.restrictedModels ? JSON.parse(keyData.restrictedModels) : []
      } catch (e) {
        restrictedModels = []
      }

      // 解析允许的客户端
      let allowedClients = []
      try {
        allowedClients = keyData.allowedClients ? JSON.parse(keyData.allowedClients) : []
      } catch (e) {
        allowedClients = []
      }

      const ipWhitelist = normalizeIpWhitelist(keyData.ipWhitelist)

      // 解析标签
      let tags = []
      try {
        tags = keyData.tags ? JSON.parse(keyData.tags) : []
      } catch (e) {
        tags = []
      }

      const openaiResponsesPayloadRules = parseOpenAIResponsesPayloadRules(
        keyData.openaiResponsesPayloadRules
      )
      const enableOpenAIResponsesCodexAdaptation = parseBooleanWithDefault(
        keyData.enableOpenAIResponsesCodexAdaptation,
        true
      )
      const enableOpenAIResponsesPayloadRules = parseBooleanWithDefault(
        keyData.enableOpenAIResponsesPayloadRules,
        false
      )
      const disableGptFastMode = parseBooleanWithDefault(keyData.disableGptFastMode, false)
      const enableGeneralOpenAIEndpoint = parseBooleanWithDefault(
        keyData.enableGeneralOpenAIEndpoint,
        false
      )
      const enableGeneralPromptCacheAssist = parseBooleanWithDefault(
        keyData.enableGeneralPromptCacheAssist,
        false
      )
      const enableClaudeThinkingSignatureLossyFallback = parseBooleanWithDefault(
        keyData.enableClaudeThinkingSignatureLossyFallback,
        false
      )

      return {
        valid: true,
        keyData: {
          id: keyData.id,
          name: keyData.name,
          description: keyData.description,
          createdAt: keyData.createdAt,
          expiresAt: keyData.expiresAt,
          // 添加激活相关字段
          expirationMode: keyData.expirationMode || 'fixed',
          isActivated: keyData.isActivated === 'true',
          activationDays: parseInt(keyData.activationDays || 0),
          activationUnit: keyData.activationUnit || 'days',
          activatedAt: keyData.activatedAt || null,
          claudeAccountId: keyData.claudeAccountId,
          claudeConsoleAccountId: keyData.claudeConsoleAccountId,
          geminiAccountId: keyData.geminiAccountId,
          openaiAccountId: keyData.openaiAccountId,
          azureOpenaiAccountId: keyData.azureOpenaiAccountId,
          bedrockAccountId: keyData.bedrockAccountId,
          droidAccountId: keyData.droidAccountId,
          // 🆕 v2 子 key 标识（父 key id）：仅供服务端识别 v2 子 key（如拒绝其自助改继承配置）。
          // 公开 stats 响应为显式构造对象、不含该字段，不会泄漏给前台。
          parentKeyId: keyData.parentKeyId || null,
          permissions: normalizePermissions(keyData.permissions),
          tokenLimit: parseInt(keyData.tokenLimit),
          concurrencyLimit: parseInt(keyData.concurrencyLimit || 0),
          rateLimitWindow: parseInt(keyData.rateLimitWindow || 0),
          rateLimitRequests: parseInt(keyData.rateLimitRequests || 0),
          rateLimitCost: parseFloat(keyData.rateLimitCost || 0),
          enableModelRestriction: keyData.enableModelRestriction === 'true',
          restrictedModels,
          enableClientRestriction: keyData.enableClientRestriction === 'true',
          allowedClients,
          enableIpWhitelist: keyData.enableIpWhitelist === 'true',
          ipWhitelist,
          dailyCostLimit: parseFloat(keyData.dailyCostLimit || 0),
          totalCostLimit: parseFloat(keyData.totalCostLimit || 0),
          weeklyOpusCostLimit: parseFloat(keyData.weeklyOpusCostLimit || 0),
          weeklyResetDay: parseInt(keyData.weeklyResetDay || 1),
          weeklyResetHour: parseInt(keyData.weeklyResetHour || 0),
          dailyCost: dailyCost || 0,
          totalCost: costStats?.total || 0,
          weeklyOpusCost:
            (await redis.getWeeklyOpusCost(
              keyData.id,
              parseInt(keyData.weeklyResetDay || 1),
              parseInt(keyData.weeklyResetHour || 0)
            )) || 0,
          tags,
          usage,
          disableGptFastMode,
          enableGeneralOpenAIEndpoint,
          enableGeneralPromptCacheAssist,
          enableClaudeThinkingSignatureLossyFallback,
          enableOpenAIResponsesCodexAdaptation,
          enableOpenAIResponsesPayloadRules,
          openaiResponsesPayloadRules
        }
      }
    } catch (error) {
      logger.error('❌ API key validation error (stats):', error)
      return { valid: false, error: 'Internal validation error' }
    }
  }

  // 🆕 为 v2 子 key 就地继承父账号的「配置」字段（权限/限制/倍率/特性开关，不含账户绑定 ID）。
  // 供 validateApiKeyForStats 与公开 stats 的 apiId 查询路径共用，确保展示与真实调用一致，
  // 同时绝不在公开 stats 暴露上游账户身份。直接修改并返回传入的 keyData。
  async _overlayV2ParentConfigForStats(keyData) {
    if (!keyData || !keyData.parentKeyId) {
      return keyData
    }
    const parentData = await redis.getApiKey(keyData.parentKeyId)
    if (
      parentData &&
      Object.keys(parentData).length > 0 &&
      parentData.isV2Parent === 'true' &&
      parentData.isActive === 'true' &&
      parentData.isDeleted !== 'true'
    ) {
      // 与 validateApiKey 同口径：开启自定义 IP 白名单的子 key 展示自己的白名单
      const skipFields = getV2InheritSkipFields(keyData)
      for (const f of V2_INHERIT_CONFIG_FIELDS) {
        if (skipFields.has(f)) {
          continue
        }
        if (parentData[f] !== undefined) {
          keyData[f] = parentData[f]
        }
      }
    }
    return keyData
  }

  // 🛠️ 管理员子列表专用：返回“展示用”继承字段，保持 Redis 中子 key 原始存储不变。
  // 仅 admin-only /v2-children 使用；公开 stats/v2 自助接口不得暴露账户绑定字段。
  _overlayV2ParentFieldsForAdmin(keyData, parentData) {
    const displayKey = { ...keyData }
    if (
      !parentData ||
      Object.keys(parentData).length === 0 ||
      (parentData.isV2Parent !== 'true' && parentData.isV2Parent !== true) ||
      parentData.isDeleted === 'true' ||
      parentData.isDeleted === true
    ) {
      return displayKey
    }

    const skipFields = getV2InheritSkipFields(keyData)
    for (const field of [...V2_INHERIT_ACCOUNT_FIELDS, ...V2_INHERIT_CONFIG_FIELDS]) {
      if (skipFields.has(field) || parentData[field] === undefined) {
        continue
      }
      displayKey[field] = normalizeV2InheritedFieldForAdmin(field, parentData[field])
    }
    return displayKey
  }

  // 🆕 公开 stats 的 apiId 查询路径专用：按 id 取原始 keyData，拒绝 v2 父账号，
  // 并为 v2 子 key 继承父账号「配置」字段（不含账户绑定）。返回判别式结果，HTTP 响应由路由层决定。
  async getApiKeyForPublicStatsById(apiId) {
    const keyData = await redis.getApiKey(apiId)
    if (!keyData || Object.keys(keyData).length === 0) {
      return { found: false, isV2Parent: false, keyData: null }
    }
    // v2 父账号不可通过公开统计接口查询（避免泄漏其上游账户绑定/账户身份信息）
    if (keyData.isV2Parent === 'true') {
      return { found: true, isV2Parent: true, keyData: null }
    }
    await this._overlayV2ParentConfigForStats(keyData)
    return { found: true, isV2Parent: false, keyData }
  }

  // 🏷️ 获取所有标签（合并索引和全局集合）
  async getAllTags() {
    const indexTags = await redis.scanAllApiKeyTags()
    const globalTags = await redis.getGlobalTags()
    // 过滤空值和空格
    return [
      ...new Set([...indexTags, ...globalTags].map((t) => (t ? t.trim() : '')).filter((t) => t))
    ].sort()
  }

  // 🏷️ 创建新标签
  async createTag(tagName) {
    const existingTags = await this.getAllTags()
    if (existingTags.includes(tagName)) {
      return { success: false, error: '标签已存在' }
    }
    await redis.addTag(tagName)
    return { success: true }
  }

  // 🏷️ 获取标签详情（含使用数量）
  async getTagsWithCount() {
    const apiKeys = await redis.getAllApiKeys()
    const tagCounts = new Map()

    // 统计 API Key 上的标签（trim 后统计）
    for (const key of apiKeys) {
      if (key.isDeleted === 'true') {
        continue
      }
      let tags = []
      try {
        const parsed = key.tags ? JSON.parse(key.tags) : []
        tags = Array.isArray(parsed) ? parsed : []
      } catch {
        tags = []
      }
      for (const tag of tags) {
        if (typeof tag === 'string') {
          const trimmed = tag.trim()
          if (trimmed) {
            tagCounts.set(trimmed, (tagCounts.get(trimmed) || 0) + 1)
          }
        }
      }
    }

    // 直接获取全局标签集合（避免重复扫描）
    const globalTags = await redis.getGlobalTags()
    for (const tag of globalTags) {
      const trimmed = tag ? tag.trim() : ''
      if (trimmed && !tagCounts.has(trimmed)) {
        tagCounts.set(trimmed, 0)
      }
    }

    return Array.from(tagCounts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
  }

  // 🏷️ 从所有 API Key 中移除指定标签
  async removeTagFromAllKeys(tagName) {
    const normalizedName = (tagName || '').trim()
    if (!normalizedName) {
      return { affectedCount: 0 }
    }

    const apiKeys = await redis.getAllApiKeys()
    let affectedCount = 0

    for (const key of apiKeys) {
      if (key.isDeleted === 'true') {
        continue
      }
      let tags = []
      try {
        const parsed = key.tags ? JSON.parse(key.tags) : []
        tags = Array.isArray(parsed) ? parsed : []
      } catch {
        tags = []
      }

      // 匹配时 trim 比较，过滤非字符串
      const strTags = tags.filter((t) => typeof t === 'string')
      if (strTags.some((t) => t.trim() === normalizedName)) {
        const newTags = strTags.filter((t) => t.trim() !== normalizedName)
        await this.updateApiKey(key.id, { tags: newTags })
        affectedCount++
      }
    }

    // 同时从全局标签集合删除
    await redis.removeTag(normalizedName)
    await redis.removeTag(tagName) // 也删除原始值（可能带空格）

    return { affectedCount }
  }

  // 🏷️ 重命名标签
  async renameTag(oldName, newName) {
    if (!newName || !newName.trim()) {
      return { affectedCount: 0, error: '新标签名不能为空' }
    }

    const normalizedOld = (oldName || '').trim()
    const normalizedNew = newName.trim()

    if (!normalizedOld) {
      return { affectedCount: 0, error: '旧标签名不能为空' }
    }

    const apiKeys = await redis.getAllApiKeys()
    let affectedCount = 0
    let foundInKeys = false

    for (const key of apiKeys) {
      if (key.isDeleted === 'true') {
        continue
      }
      let tags = []
      try {
        const parsed = key.tags ? JSON.parse(key.tags) : []
        tags = Array.isArray(parsed) ? parsed : []
      } catch {
        tags = []
      }

      // 匹配时 trim 比较，过滤非字符串
      const strTags = tags.filter((t) => typeof t === 'string')
      if (strTags.some((t) => t.trim() === normalizedOld)) {
        foundInKeys = true
        const newTags = [
          ...new Set(strTags.map((t) => (t.trim() === normalizedOld ? normalizedNew : t)))
        ]
        await this.updateApiKey(key.id, { tags: newTags })
        affectedCount++
      }
    }

    // 检查全局集合是否有该标签
    const globalTags = await redis.getGlobalTags()
    const foundInGlobal = globalTags.some(
      (t) => typeof t === 'string' && t.trim() === normalizedOld
    )

    if (!foundInKeys && !foundInGlobal) {
      return { affectedCount: 0, error: '标签不存在' }
    }

    // 同时更新全局标签集合（删旧加新）
    await redis.removeTag(normalizedOld)
    await redis.removeTag(oldName) // 也删除原始值
    await redis.addTag(normalizedNew)

    return { affectedCount }
  }

  // 📋 获取所有API Keys
  async getAllApiKeys(includeDeleted = false) {
    try {
      let apiKeys = await redis.getAllApiKeys()
      const client = redis.getClientSafe()
      const accountInfoCache = new Map()

      // 默认过滤掉已删除的API Keys
      if (!includeDeleted) {
        apiKeys = apiKeys.filter((key) => key.isDeleted !== 'true')
      }

      // 为每个key添加使用统计和当前并发数
      for (const key of apiKeys) {
        // 🆕 v2 父账号：升级后自身不跑流量，usage/成本/周费用改用读侧聚合（父 + 所有子，含软删）
        const isV2ParentKey = key.isV2Parent === 'true' || key.isV2Parent === true
        const v2Ledger = isV2ParentKey
          ? await redis.getV2ParentLedgerCostStats(key.id, { timeRange: 'all' })
          : null

        key.usage = isV2ParentKey
          ? await redis.getV2ParentUsageStats(key.id)
          : await redis.getUsageStats(key.id)
        const costStats = isV2ParentKey ? null : await redis.getCostStats(key.id)
        const effectiveTotalCost = isV2ParentKey ? v2Ledger.total : costStats ? costStats.total : 0
        // 为前端兼容性：把费用信息同步到 usage 对象里
        if (key.usage) {
          key.usage.total = key.usage.total || {}
          key.usage.total.cost = effectiveTotalCost
          key.usage.totalCost = effectiveTotalCost
        }
        key.totalCost = effectiveTotalCost
        key.tokenLimit = parseInt(key.tokenLimit)
        key.concurrencyLimit = parseInt(key.concurrencyLimit || 0)
        key.rateLimitWindow = parseInt(key.rateLimitWindow || 0)
        key.rateLimitRequests = parseInt(key.rateLimitRequests || 0)
        key.rateLimitCost = parseFloat(key.rateLimitCost || 0) // 新增：速率限制费用字段
        // 🆕 v2 子 key 的并发池按父账号聚合（共享池），列表展示对齐到父账号池
        key.currentConcurrency = await redis.getConcurrency(key.parentKeyId || key.id)
        key.isActive = key.isActive === 'true'
        key.enableModelRestriction = key.enableModelRestriction === 'true'
        key.enableClientRestriction = key.enableClientRestriction === 'true'
        key.enableIpWhitelist = key.enableIpWhitelist === 'true'
        key.disableGptFastMode = parseBooleanWithDefault(key.disableGptFastMode, false)
        key.enableGeneralOpenAIEndpoint = parseBooleanWithDefault(
          key.enableGeneralOpenAIEndpoint,
          false
        )
        key.enableGeneralPromptCacheAssist = parseBooleanWithDefault(
          key.enableGeneralPromptCacheAssist,
          false
        )
        key.enableClaudeThinkingSignatureLossyFallback = parseBooleanWithDefault(
          key.enableClaudeThinkingSignatureLossyFallback,
          false
        )
        key.enableOpenAIResponsesCodexAdaptation = parseBooleanWithDefault(
          key.enableOpenAIResponsesCodexAdaptation,
          true
        )
        key.enableOpenAIResponsesPayloadRules = parseBooleanWithDefault(
          key.enableOpenAIResponsesPayloadRules,
          false
        )
        key.permissions = normalizePermissions(key.permissions)
        key.dailyCostLimit = parseFloat(key.dailyCostLimit || 0)
        key.totalCostLimit = parseFloat(key.totalCostLimit || 0)
        key.weeklyOpusCostLimit = parseFloat(key.weeklyOpusCostLimit || 0)
        key.dailyCost = isV2ParentKey
          ? v2Ledger.daily || 0
          : (await redis.getDailyCost(key.id)) || 0
        key.weeklyOpusCost = isV2ParentKey
          ? (await redis.getV2ParentWeeklyOpusCost(
              key.id,
              parseInt(key.weeklyResetDay || 1),
              parseInt(key.weeklyResetHour || 0)
            )) || 0
          : (await redis.getWeeklyOpusCost(
              key.id,
              parseInt(key.weeklyResetDay || 1),
              parseInt(key.weeklyResetHour || 0)
            )) || 0
        key.activationDays = parseInt(key.activationDays || 0)
        key.activationUnit = key.activationUnit || 'days'
        key.expirationMode = key.expirationMode || 'fixed'
        key.isActivated = key.isActivated === 'true'
        key.activatedAt = key.activatedAt || null

        // 获取当前时间窗口的请求次数、Token使用量和费用
        if (key.rateLimitWindow > 0) {
          const requestCountKey = `rate_limit:requests:${key.id}`
          const tokenCountKey = `rate_limit:tokens:${key.id}`
          const costCountKey = `rate_limit:cost:${key.id}` // 新增：费用计数器
          const windowStartKey = `rate_limit:window_start:${key.id}`

          key.currentWindowRequests = parseInt((await client.get(requestCountKey)) || '0')
          key.currentWindowTokens = parseInt((await client.get(tokenCountKey)) || '0')
          key.currentWindowCost = parseFloat((await client.get(costCountKey)) || '0') // 新增：当前窗口费用

          // 获取窗口开始时间和计算剩余时间
          const windowStart = await client.get(windowStartKey)
          if (windowStart) {
            const now = Date.now()
            const windowStartTime = parseInt(windowStart)
            const windowDuration = key.rateLimitWindow * 60 * 1000 // 转换为毫秒
            const windowEndTime = windowStartTime + windowDuration

            // 如果窗口还有效
            if (now < windowEndTime) {
              key.windowStartTime = windowStartTime
              key.windowEndTime = windowEndTime
              key.windowRemainingSeconds = Math.max(0, Math.floor((windowEndTime - now) / 1000))
            } else {
              // 窗口已过期，下次请求会重置
              key.windowStartTime = null
              key.windowEndTime = null
              key.windowRemainingSeconds = 0
              // 重置计数为0，因为窗口已过期
              key.currentWindowRequests = 0
              key.currentWindowTokens = 0
              key.currentWindowCost = 0 // 新增：重置费用
            }
          } else {
            // 窗口还未开始（没有任何请求）
            key.windowStartTime = null
            key.windowEndTime = null
            key.windowRemainingSeconds = null
          }
        } else {
          key.currentWindowRequests = 0
          key.currentWindowTokens = 0
          key.currentWindowCost = 0 // 新增：重置费用
          key.windowStartTime = null
          key.windowEndTime = null
          key.windowRemainingSeconds = null
        }

        try {
          key.restrictedModels = key.restrictedModels ? JSON.parse(key.restrictedModels) : []
        } catch (e) {
          key.restrictedModels = []
        }
        try {
          key.allowedClients = key.allowedClients ? JSON.parse(key.allowedClients) : []
        } catch (e) {
          key.allowedClients = []
        }
        key.ipWhitelist = normalizeIpWhitelist(key.ipWhitelist)
        try {
          key.tags = key.tags ? JSON.parse(key.tags) : []
        } catch (e) {
          key.tags = []
        }
        key.openaiResponsesPayloadRules = parseOpenAIResponsesPayloadRules(
          key.openaiResponsesPayloadRules
        )
        // 不暴露已弃用字段
        if (Object.prototype.hasOwnProperty.call(key, 'ccrAccountId')) {
          delete key.ccrAccountId
        }

        let lastUsageRecord = null
        try {
          const usageRecords = await redis.getUsageRecords(key.id, 1)
          if (Array.isArray(usageRecords) && usageRecords.length > 0) {
            lastUsageRecord = usageRecords[0]
          }
        } catch (error) {
          logger.debug(`加载 API Key ${key.id} 的使用记录失败:`, error)
        }

        if (lastUsageRecord && (lastUsageRecord.accountId || lastUsageRecord.accountType)) {
          const resolvedAccount = await this._resolveLastUsageAccount(
            key,
            lastUsageRecord,
            accountInfoCache,
            client
          )

          if (resolvedAccount) {
            key.lastUsage = {
              accountId: resolvedAccount.accountId,
              rawAccountId: lastUsageRecord.accountId || resolvedAccount.accountId,
              accountType: resolvedAccount.accountType,
              accountCategory: resolvedAccount.accountCategory,
              accountName: resolvedAccount.accountName,
              recordedAt: lastUsageRecord.timestamp || key.lastUsedAt || null
            }
          } else {
            key.lastUsage = {
              accountId: null,
              rawAccountId: lastUsageRecord.accountId || null,
              accountType: 'deleted',
              accountCategory: 'deleted',
              accountName: '已删除',
              recordedAt: lastUsageRecord.timestamp || key.lastUsedAt || null
            }
          }
        } else {
          key.lastUsage = null
        }

        delete key.apiKey // 不返回哈希后的key
        delete key.encryptedApiKey // 🔒 绝不返回可逆明文副本
        delete key.v2PasswordHash // 🔒 绝不返回 v2 密码 hash
      }

      return apiKeys
    } catch (error) {
      logger.error('❌ Failed to get API keys:', error)
      throw error
    }
  }

  /**
   * 🚀 快速获取所有 API Keys（使用 Pipeline 批量操作，性能优化版）
   * 适用于 dashboard、usage-costs 等需要大量 API Key 数据的场景
   * @param {boolean} includeDeleted - 是否包含已删除的 API Keys
   * @param {Array<string>|null} keyIds - 可选：已知 key id 列表。提供时跳过全库 SCAN，
   *   仅批量加载这些 id（用于 v2 children 等已知 id 的局部场景）；空数组直接返回 []
   * @returns {Promise<Array>} API Keys 列表
   */
  async getAllApiKeysFast(includeDeleted = false, keyIds = null) {
    try {
      // 1. 未提供 keyIds 时，使用 SCAN 获取所有 API Key IDs
      const targetIds = Array.isArray(keyIds) ? keyIds : await redis.scanApiKeyIds()
      if (targetIds.length === 0) {
        return []
      }

      // 2. 批量获取基础数据
      let apiKeys = await redis.batchGetApiKeys(targetIds)

      // 3. 过滤已删除的
      if (!includeDeleted) {
        apiKeys = apiKeys.filter((key) => !key.isDeleted)
      }

      // 4. 批量获取统计数据（单次 Pipeline）
      const activeKeyIds = apiKeys.map((k) => k.id)
      // 🆕 v2 子 key 的并发池在父账号（共享池）：构建「子 id → 父 id」映射，
      // 使 batchGetApiKeyStats 的并发 zcard 读父账号池，currentConcurrency 反映共享池实时并发
      const concurrencyPoolIds = new Map(
        apiKeys.filter((k) => k.parentKeyId).map((k) => [k.id, k.parentKeyId])
      )
      const statsMap = await redis.batchGetApiKeyStats(activeKeyIds, concurrencyPoolIds)

      // 5. 合并数据
      for (const key of apiKeys) {
        const stats = statsMap.get(key.id) || {}

        // 处理 usage 数据
        const usageTotal = stats.usageTotal || {}
        const usageDaily = stats.usageDaily || {}
        const usageMonthly = stats.usageMonthly || {}

        // 计算平均 RPM/TPM
        const createdAt = stats.createdAt ? new Date(stats.createdAt) : new Date()
        const daysSinceCreated = Math.max(
          1,
          Math.ceil((Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24))
        )
        const totalMinutes = daysSinceCreated * 24 * 60
        // 兼容旧数据格式：优先读 totalXxx，fallback 到 xxx
        const totalRequests = parseInt(usageTotal.totalRequests || usageTotal.requests) || 0
        const totalTokens = parseInt(usageTotal.totalTokens || usageTotal.tokens) || 0
        let inputTokens = parseInt(usageTotal.totalInputTokens || usageTotal.inputTokens) || 0
        let outputTokens = parseInt(usageTotal.totalOutputTokens || usageTotal.outputTokens) || 0
        let cacheCreateTokens =
          parseInt(usageTotal.totalCacheCreateTokens || usageTotal.cacheCreateTokens) || 0
        let cacheReadTokens =
          parseInt(usageTotal.totalCacheReadTokens || usageTotal.cacheReadTokens) || 0

        // 旧数据兼容：没有 input/output 分离时做 30/70 拆分
        const totalFromSeparate = inputTokens + outputTokens
        if (totalFromSeparate === 0 && totalTokens > 0) {
          inputTokens = Math.round(totalTokens * 0.3)
          outputTokens = Math.round(totalTokens * 0.7)
          cacheCreateTokens = 0
          cacheReadTokens = 0
        }

        // allTokens：优先读存储值，否则计算，最后 fallback 到 totalTokens
        const allTokens =
          parseInt(usageTotal.totalAllTokens || usageTotal.allTokens) ||
          inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens ||
          totalTokens

        key.usage = {
          total: {
            requests: totalRequests,
            tokens: allTokens, // 与 getUsageStats 语义一致：包含 cache 的总 tokens
            inputTokens,
            outputTokens,
            cacheCreateTokens,
            cacheReadTokens,
            allTokens,
            cost: stats.costStats?.total || 0
          },
          daily: {
            requests: parseInt(usageDaily.totalRequests || usageDaily.requests) || 0,
            tokens: parseInt(usageDaily.totalTokens || usageDaily.tokens) || 0
          },
          monthly: {
            requests: parseInt(usageMonthly.totalRequests || usageMonthly.requests) || 0,
            tokens: parseInt(usageMonthly.totalTokens || usageMonthly.tokens) || 0
          },
          averages: {
            rpm: Math.round((totalRequests / totalMinutes) * 100) / 100,
            tpm: Math.round((totalTokens / totalMinutes) * 100) / 100
          },
          totalCost: stats.costStats?.total || 0
        }

        // 费用统计
        key.totalCost = stats.costStats?.total || 0
        key.dailyCost = stats.dailyCost || 0
        key.weeklyOpusCost = stats.weeklyOpusCost || 0

        // 并发
        key.currentConcurrency = stats.concurrency || 0

        // 类型转换
        key.tokenLimit = parseInt(key.tokenLimit) || 0
        key.concurrencyLimit = parseInt(key.concurrencyLimit) || 0
        key.rateLimitWindow = parseInt(key.rateLimitWindow) || 0
        key.rateLimitRequests = parseInt(key.rateLimitRequests) || 0
        key.rateLimitCost = parseFloat(key.rateLimitCost) || 0
        key.dailyCostLimit = parseFloat(key.dailyCostLimit) || 0
        key.totalCostLimit = parseFloat(key.totalCostLimit) || 0
        key.weeklyOpusCostLimit = parseFloat(key.weeklyOpusCostLimit) || 0
        key.activationDays = parseInt(key.activationDays) || 0
        key.isActive = key.isActive === 'true' || key.isActive === true
        key.enableModelRestriction =
          key.enableModelRestriction === 'true' || key.enableModelRestriction === true
        key.enableClientRestriction =
          key.enableClientRestriction === 'true' || key.enableClientRestriction === true
        key.enableIpWhitelist = key.enableIpWhitelist === 'true' || key.enableIpWhitelist === true
        key.disableGptFastMode = parseBooleanWithDefault(key.disableGptFastMode, false)
        key.enableGeneralOpenAIEndpoint = parseBooleanWithDefault(
          key.enableGeneralOpenAIEndpoint,
          false
        )
        key.enableGeneralPromptCacheAssist = parseBooleanWithDefault(
          key.enableGeneralPromptCacheAssist,
          false
        )
        key.enableClaudeThinkingSignatureLossyFallback = parseBooleanWithDefault(
          key.enableClaudeThinkingSignatureLossyFallback,
          false
        )
        key.enableOpenAIResponsesCodexAdaptation = parseBooleanWithDefault(
          key.enableOpenAIResponsesCodexAdaptation,
          true
        )
        key.enableOpenAIResponsesPayloadRules = parseBooleanWithDefault(
          key.enableOpenAIResponsesPayloadRules,
          false
        )
        key.isActivated = key.isActivated === 'true' || key.isActivated === true
        key.permissions = key.permissions || 'all'
        key.activationUnit = key.activationUnit || 'days'
        key.expirationMode = key.expirationMode || 'fixed'
        key.activatedAt = key.activatedAt || null

        // Rate limit 窗口数据
        if (key.rateLimitWindow > 0) {
          const rl = stats.rateLimit || {}
          key.currentWindowRequests = rl.requests || 0
          key.currentWindowTokens = rl.tokens || 0
          key.currentWindowCost = rl.cost || 0

          if (rl.windowStart) {
            const now = Date.now()
            const windowDuration = key.rateLimitWindow * 60 * 1000
            const windowEndTime = rl.windowStart + windowDuration

            if (now < windowEndTime) {
              key.windowStartTime = rl.windowStart
              key.windowEndTime = windowEndTime
              key.windowRemainingSeconds = Math.max(0, Math.floor((windowEndTime - now) / 1000))
            } else {
              key.windowStartTime = null
              key.windowEndTime = null
              key.windowRemainingSeconds = 0
              key.currentWindowRequests = 0
              key.currentWindowTokens = 0
              key.currentWindowCost = 0
            }
          } else {
            key.windowStartTime = null
            key.windowEndTime = null
            key.windowRemainingSeconds = null
          }
        } else {
          key.currentWindowRequests = 0
          key.currentWindowTokens = 0
          key.currentWindowCost = 0
          key.windowStartTime = null
          key.windowEndTime = null
          key.windowRemainingSeconds = null
        }

        // JSON 字段解析（兼容已解析的数组和未解析的字符串）
        if (Array.isArray(key.restrictedModels)) {
          // 已解析，保持不变
        } else if (key.restrictedModels) {
          try {
            key.restrictedModels = JSON.parse(key.restrictedModels)
          } catch {
            key.restrictedModels = []
          }
        } else {
          key.restrictedModels = []
        }
        if (Array.isArray(key.allowedClients)) {
          // 已解析，保持不变
        } else if (key.allowedClients) {
          try {
            key.allowedClients = JSON.parse(key.allowedClients)
          } catch {
            key.allowedClients = []
          }
        } else {
          key.allowedClients = []
        }
        key.ipWhitelist = normalizeIpWhitelist(key.ipWhitelist)
        if (Array.isArray(key.tags)) {
          // 已解析，保持不变
        } else if (key.tags) {
          try {
            key.tags = JSON.parse(key.tags)
          } catch {
            key.tags = []
          }
        } else {
          key.tags = []
        }
        if (Array.isArray(key.openaiResponsesPayloadRules)) {
          // 已解析，保持不变
        } else if (key.openaiResponsesPayloadRules) {
          key.openaiResponsesPayloadRules = parseOpenAIResponsesPayloadRules(
            key.openaiResponsesPayloadRules
          )
        } else {
          key.openaiResponsesPayloadRules = []
        }

        // 生成掩码key后再清理敏感字段
        if (key.apiKey) {
          key.maskedKey = `${this.prefix}****${key.apiKey.slice(-4)}`
        }
        delete key.apiKey
        delete key.encryptedApiKey // 🔒 绝不返回可逆明文副本
        delete key.ccrAccountId
        delete key.v2PasswordHash // 🔒 绝不返回 v2 密码 hash

        // 不获取 lastUsage（太慢），设为 null
        key.lastUsage = null
      }

      // 🆕 v2 父账号：batchGetApiKeyStats 读的是父账号自身计数(≈0)，且其 weeklyOpusCost
      // 用 ISO 周键格式与写入周期串不一致，均不可信。用读侧聚合(父 + 所有子)覆盖。
      const v2Parents = apiKeys.filter((k) => k.isV2Parent === true || k.isV2Parent === 'true')
      await Promise.all(
        v2Parents.map(async (key) => {
          const resetDay = parseInt(key.weeklyResetDay || 1)
          const resetHour = parseInt(key.weeklyResetHour || 0)
          const [usage, ledger, weeklyOpusCost] = await Promise.all([
            redis.getV2ParentUsageStats(key.id),
            redis.getV2ParentLedgerCostStats(key.id, { timeRange: 'all' }),
            redis.getV2ParentWeeklyOpusCost(key.id, resetDay, resetHour)
          ])
          key.usage = usage
          key.usage.total = key.usage.total || {}
          key.usage.total.cost = ledger.total
          key.usage.totalCost = ledger.total
          key.totalCost = ledger.total
          key.dailyCost = ledger.daily || 0
          key.weeklyOpusCost = weeklyOpusCost || 0
        })
      )

      return apiKeys
    } catch (error) {
      logger.error('❌ Failed to get API keys (fast):', error)
      throw error
    }
  }

  /**
   * 获取所有 API Keys 的轻量版本（仅绑定字段，用于计算绑定数）
   * @returns {Promise<Array>} 包含绑定字段的 API Keys 列表
   */
  async getAllApiKeysLite() {
    try {
      const client = redis.getClientSafe()
      const keyIds = await redis.scanApiKeyIds()

      if (keyIds.length === 0) {
        return []
      }

      // Pipeline 只获取绑定相关字段
      const pipeline = client.pipeline()
      for (const keyId of keyIds) {
        pipeline.hmget(
          `apikey:${keyId}`,
          'claudeAccountId',
          'geminiAccountId',
          'openaiAccountId',
          'droidAccountId',
          'isDeleted'
        )
      }
      const results = await pipeline.exec()

      return keyIds
        .map((id, i) => {
          const [err, fields] = results[i]
          if (err) {
            return null
          }
          return {
            id,
            claudeAccountId: fields[0] || null,
            geminiAccountId: fields[1] || null,
            openaiAccountId: fields[2] || null,
            droidAccountId: fields[3] || null,
            isDeleted: fields[4] === 'true'
          }
        })
        .filter((k) => k && !k.isDeleted)
    } catch (error) {
      logger.error('❌ Failed to get API keys (lite):', error)
      return []
    }
  }

  // 📝 更新API Key
  async updateApiKey(keyId, updates) {
    try {
      const keyData = await redis.getApiKey(keyId)
      if (!keyData || Object.keys(keyData).length === 0) {
        throw new Error('API key not found')
      }

      // 允许更新的字段
      const allowedUpdates = [
        'name',
        'description',
        'tokenLimit',
        'concurrencyLimit',
        'rateLimitWindow',
        'rateLimitRequests',
        'rateLimitCost', // 新增：速率限制费用字段
        'isActive',
        'claudeAccountId',
        'claudeConsoleAccountId',
        'geminiAccountId',
        'openaiAccountId',
        'azureOpenaiAccountId',
        'bedrockAccountId', // 添加 Bedrock 账号ID
        'droidAccountId',
        'permissions',
        'expiresAt',
        'activationDays', // 新增：激活后有效天数
        'activationUnit', // 新增：激活时间单位
        'expirationMode', // 新增：过期模式
        'isActivated', // 新增：是否已激活
        'activatedAt', // 新增：激活时间
        'enableModelRestriction',
        'restrictedModels',
        'enableClientRestriction',
        'allowedClients',
        'enableIpWhitelist',
        'ipWhitelist',
        'dailyCostLimit',
        'totalCostLimit',
        'weeklyOpusCostLimit',
        'tags',
        'userId', // 新增：用户ID（所有者变更）
        'userUsername', // 新增：用户名（所有者变更）
        'createdBy', // 新增：创建者（所有者变更）
        'serviceRates', // API Key 级别服务倍率
        'weeklyResetDay', // 周费用重置日 (1-7)
        'weeklyResetHour', // 周费用重置时 (0-23)
        'disableGptFastMode',
        'enableGeneralOpenAIEndpoint',
        'enableGeneralPromptCacheAssist',
        'enableClaudeThinkingSignatureLossyFallback',
        'enableOpenAIResponsesCodexAdaptation',
        'enableOpenAIResponsesPayloadRules',
        'openaiResponsesPayloadRules',
        'v2TotalBudget', // 🆕 v2 父账号总账额度（仅管理员可改，故意不含 isV2Parent/parentKeyId）
        'v2IpWhitelistOverride' // 🆕 v2 子 key 自定义白名单标记（唯一写入方为 updateV2Child）
      ]
      const updatedData = { ...keyData }

      for (const [field, value] of Object.entries(updates)) {
        if (allowedUpdates.includes(field)) {
          // v2 子 key 专属字段：非子 key 即使被内部调用误传也不写入，避免普通 key 出现无意义字段
          if (field === 'v2IpWhitelistOverride' && !keyData.parentKeyId) {
            continue
          }
          if (
            field === 'restrictedModels' ||
            field === 'allowedClients' ||
            field === 'ipWhitelist' ||
            field === 'tags' ||
            field === 'serviceRates' ||
            field === 'openaiResponsesPayloadRules'
          ) {
            // 特殊处理数组/对象字段
            const normalizedValue =
              field === 'ipWhitelist'
                ? normalizeIpWhitelist(value)
                : value || (field === 'serviceRates' ? {} : [])
            updatedData[field] = JSON.stringify(normalizedValue)
          } else if (field === 'permissions') {
            // 权限字段：规范化后JSON序列化，与createApiKey保持一致
            updatedData[field] = JSON.stringify(normalizePermissions(value))
          } else if (
            field === 'enableModelRestriction' ||
            field === 'enableClientRestriction' ||
            field === 'enableIpWhitelist' ||
            field === 'isActivated' ||
            field === 'disableGptFastMode' ||
            field === 'enableGeneralOpenAIEndpoint' ||
            field === 'enableGeneralPromptCacheAssist' ||
            field === 'enableClaudeThinkingSignatureLossyFallback' ||
            field === 'enableOpenAIResponsesCodexAdaptation' ||
            field === 'enableOpenAIResponsesPayloadRules' ||
            field === 'v2IpWhitelistOverride'
          ) {
            // 布尔值转字符串
            updatedData[field] = String(value)
          } else if (field === 'expiresAt' || field === 'activatedAt') {
            // 日期字段保持原样，不要toString()
            updatedData[field] = value || ''
          } else {
            updatedData[field] = (value !== null && value !== undefined ? value : '').toString()
          }
        }
      }

      updatedData.updatedAt = new Date().toISOString()

      // 传递hashedKey以确保映射表一致性
      // keyData.apiKey 存储的就是 hashedKey（见generateApiKey第123行）
      // 🆕 仅对「可调用」的 key 重建 hash 映射：已软删除 / v2 父账号本就不应存在映射，
      // 否则任意管理更新（如改 v2 总额）会复活其映射，破坏 fail-closed 不变量。
      const shouldKeepHash = keyData.isDeleted !== 'true' && keyData.isV2Parent !== 'true'
      await redis.setApiKey(keyId, updatedData, shouldKeepHash ? keyData.apiKey : null)
      if (!shouldKeepHash && keyData.apiKey) {
        await redis.deleteApiKeyHash(keyData.apiKey)
      }

      // 同步更新 API Key 索引
      try {
        const apiKeyIndexService = require('./apiKeyIndexService')
        await apiKeyIndexService.updateIndex(keyId, updates, {
          name: keyData.name,
          isActive: keyData.isActive === 'true',
          isDeleted: keyData.isDeleted === 'true',
          tags: JSON.parse(keyData.tags || '[]')
        })
      } catch (err) {
        logger.warn(`Failed to update API Key index for ${keyId}:`, err.message)
      }

      logger.success(`📝 Updated API key: ${keyId}, hashMap updated`)

      return { success: true }
    } catch (error) {
      logger.error('❌ Failed to update API key:', error)
      throw error
    }
  }

  // 🗑️ 软删除API Key (保留使用统计)
  async deleteApiKey(keyId, deletedBy = 'system', deletedByType = 'system') {
    try {
      const keyData = await redis.getApiKey(keyId)
      if (!keyData || Object.keys(keyData).length === 0) {
        throw new Error('API key not found')
      }

      // 标记为已删除，保留所有数据和统计信息
      const updatedData = {
        ...keyData,
        isDeleted: 'true',
        deletedAt: new Date().toISOString(),
        deletedBy,
        deletedByType, // 'user', 'admin', 'system'
        isActive: 'false' // 同时禁用
      }

      await redis.setApiKey(keyId, updatedData)

      // 从哈希映射中移除（这样就不能再使用这个key进行API调用）
      if (keyData.apiKey) {
        await redis.deleteApiKeyHash(keyData.apiKey)
      }

      // 从费用排序索引中移除
      try {
        const costRankService = require('./costRankService')
        await costRankService.removeKeyFromIndexes(keyId)
      } catch (err) {
        logger.warn(`Failed to remove key ${keyId} from cost rank indexes:`, err.message)
      }

      // 更新 API Key 索引（标记为已删除）
      try {
        const apiKeyIndexService = require('./apiKeyIndexService')
        await apiKeyIndexService.updateIndex(
          keyId,
          { isDeleted: true, isActive: false },
          {
            name: keyData.name,
            isActive: keyData.isActive === 'true',
            isDeleted: false,
            tags: JSON.parse(keyData.tags || '[]')
          }
        )
      } catch (err) {
        logger.warn(`Failed to update API Key index for deleted key ${keyId}:`, err.message)
      }

      logger.success(`🗑️ Soft deleted API key: ${keyId} by ${deletedBy} (${deletedByType})`)

      return { success: true }
    } catch (error) {
      logger.error('❌ Failed to delete API key:', error)
      throw error
    }
  }

  // 🔄 恢复已删除的API Key
  async restoreApiKey(keyId, restoredBy = 'system', restoredByType = 'system') {
    try {
      const keyData = await redis.getApiKey(keyId)
      if (!keyData || Object.keys(keyData).length === 0) {
        throw new Error('API key not found')
      }

      // 检查是否确实是已删除的key
      if (keyData.isDeleted !== 'true') {
        throw new Error('API key is not deleted')
      }

      // 准备更新的数据
      const updatedData = { ...keyData }
      updatedData.isActive = 'true'
      updatedData.restoredAt = new Date().toISOString()
      updatedData.restoredBy = restoredBy
      updatedData.restoredByType = restoredByType

      // 从更新的数据中移除删除相关的字段
      delete updatedData.isDeleted
      delete updatedData.deletedAt
      delete updatedData.deletedBy
      delete updatedData.deletedByType

      // 保存更新后的数据
      await redis.setApiKey(keyId, updatedData)

      // 使用Redis的hdel命令删除不需要的字段
      const keyName = `apikey:${keyId}`
      await redis.client.hdel(keyName, 'isDeleted', 'deletedAt', 'deletedBy', 'deletedByType')

      // 重新建立哈希映射（恢复API Key的使用能力）
      // 🆕 v2 父账号恢复后仍不可直接 API 调用，故不重建 hash 映射
      if (keyData.apiKey && keyData.isV2Parent !== 'true') {
        await redis.setApiKeyHash(keyData.apiKey, {
          id: keyId,
          name: keyData.name,
          isActive: 'true'
        })
      }

      // 重新添加到费用排序索引
      try {
        const costRankService = require('./costRankService')
        await costRankService.addKeyToIndexes(keyId)
      } catch (err) {
        logger.warn(`Failed to add restored key ${keyId} to cost rank indexes:`, err.message)
      }

      // 更新 API Key 索引（恢复为活跃状态）
      try {
        const apiKeyIndexService = require('./apiKeyIndexService')
        await apiKeyIndexService.updateIndex(
          keyId,
          { isDeleted: false, isActive: true },
          {
            name: keyData.name,
            isActive: false,
            isDeleted: true,
            tags: JSON.parse(keyData.tags || '[]')
          }
        )
      } catch (err) {
        logger.warn(`Failed to update API Key index for restored key ${keyId}:`, err.message)
      }

      logger.success(`Restored API key: ${keyId} by ${restoredBy} (${restoredByType})`)

      // 🆕 返回前剥离敏感字段（apiKey hash、v2 密码 hash），任何响应都不得包含
      const safeApiKey = { ...updatedData }
      delete safeApiKey.apiKey
      delete safeApiKey.encryptedApiKey // 🔒 绝不返回可逆明文副本
      delete safeApiKey.v2PasswordHash

      return { success: true, apiKey: safeApiKey }
    } catch (error) {
      logger.error('❌ Failed to restore API key:', error)
      throw error
    }
  }

  // 🗑️ 彻底删除API Key（物理删除）
  async permanentDeleteApiKey(keyId) {
    try {
      const keyData = await redis.getApiKey(keyId)
      if (!keyData || Object.keys(keyData).length === 0) {
        throw new Error('API key not found')
      }

      // 确保只能彻底删除已经软删除的key
      if (keyData.isDeleted !== 'true') {
        throw new Error('只能彻底删除已经删除的API Key')
      }

      // 🆕 v2 父账号：仍有未彻底删除的子 key 时拒绝永久删除（避免产生孤儿子 key）
      if (keyData.isV2Parent === 'true') {
        const childIds = await redis.getV2ChildIds(keyId)
        let liveChildren = 0
        for (const childId of childIds) {
          const child = await redis.getApiKey(childId)
          if (child && Object.keys(child).length > 0) {
            liveChildren++
          }
        }
        if (liveChildren > 0) {
          throw new Error('请先彻底删除该 v2 父账号下的所有子 key，再永久删除父账号')
        }
      }

      // 删除所有相关的使用统计数据
      const today = new Date().toISOString().split('T')[0]
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0]

      // 删除每日统计
      await redis.client.del(`usage:daily:${today}:${keyId}`)
      await redis.client.del(`usage:daily:${yesterday}:${keyId}`)

      // 删除月度统计
      const currentMonth = today.substring(0, 7)
      await redis.client.del(`usage:monthly:${currentMonth}:${keyId}`)

      // 删除所有相关的统计键（通过模式匹配）
      const usageKeys = await redis.scanKeys(`usage:*:${keyId}*`)
      if (usageKeys.length > 0) {
        await redis.batchDelChunked(usageKeys)
      }

      // 从 API Key 索引中移除
      try {
        const apiKeyIndexService = require('./apiKeyIndexService')
        await apiKeyIndexService.removeFromIndex(keyId, {
          name: keyData.name,
          tags: JSON.parse(keyData.tags || '[]')
        })
      } catch (err) {
        logger.warn(`Failed to remove key ${keyId} from API Key index:`, err.message)
      }

      // 删除API Key本身
      await redis.deleteApiKey(keyId)

      // 🆕 v2 父账号：清理邮箱索引、子 key 集合、总账键
      if (keyData.isV2Parent === 'true') {
        if (keyData.v2Email) {
          await redis.deleteV2EmailIndex((keyData.v2Email || '').toLowerCase())
        }
        await redis.deleteV2Children(keyId)
        await redis.deleteV2ParentTotalCost(keyId)
      }
      // 🆕 v2 子 key：从父账号的子 key 集合移除
      if (keyData.parentKeyId) {
        await redis.removeV2Child(keyData.parentKeyId, keyId)
      }

      logger.success(`🗑️ Permanently deleted API key: ${keyId}`)

      return { success: true }
    } catch (error) {
      logger.error('❌ Failed to permanently delete API key:', error)
      throw error
    }
  }

  // 🧹 清空所有已删除的API Keys
  async clearAllDeletedApiKeys() {
    try {
      const allKeys = await this.getAllApiKeysFast(true)
      const deletedKeys = allKeys.filter((key) => key.isDeleted === true)

      // 子 key 先删、普通 key 居中、v2 父账号最后——父账号的永久删除受
      // 「仍有子 key 不可删」保护（permanentDeleteApiKey），顺序不对要跑两次才删干净
      const rankOf = (key) => {
        if (key.parentKeyId) {
          return 0
        }
        return key.isV2Parent ? 2 : 1
      }
      deletedKeys.sort((a, b) => rankOf(a) - rankOf(b))

      let successCount = 0
      let failedCount = 0
      const errors = []

      for (const key of deletedKeys) {
        try {
          await this.permanentDeleteApiKey(key.id)
          successCount++
        } catch (error) {
          failedCount++
          errors.push({
            keyId: key.id,
            keyName: key.name,
            error: error.message
          })
        }
      }

      logger.success(`🧹 Cleared deleted API keys: ${successCount} success, ${failedCount} failed`)

      return {
        success: true,
        total: deletedKeys.length,
        successCount,
        failedCount,
        errors
      }
    } catch (error) {
      logger.error('❌ Failed to clear all deleted API keys:', error)
      throw error
    }
  }

  // 📊 记录使用情况（支持缓存token和账户级别统计，应用服务倍率）
  async recordUsage(
    keyId,
    inputTokens = 0,
    outputTokens = 0,
    cacheCreateTokens = 0,
    cacheReadTokens = 0,
    model = 'unknown',
    accountId = null,
    accountType = null,
    serviceTier = null,
    requestMeta = null
  ) {
    try {
      const finalizedRequestMeta = finalizeRequestDetailMeta(requestMeta)
      const totalTokens = inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens

      // 计算费用
      const CostCalculator = require('../utils/costCalculator')
      const costInfo = CostCalculator.calculateCost(
        {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_creation_input_tokens: cacheCreateTokens,
          cache_read_input_tokens: cacheReadTokens
        },
        model,
        serviceTier
      )

      // 检查是否为 1M 上下文请求
      let isLongContextRequest = false
      if (model && model.includes('[1m]')) {
        const totalInputTokens = inputTokens + cacheCreateTokens + cacheReadTokens
        isLongContextRequest = totalInputTokens > 200000
      }

      // 计算费用（应用服务倍率）
      const realCost = costInfo.costs.total
      let ratedCost = realCost
      if (realCost > 0) {
        const service = serviceRatesService.getService(accountType, model)
        ratedCost = await this.calculateRatedCost(keyId, service, realCost)
      }

      // 记录API Key级别的使用统计（包含费用）
      await redis.incrementTokenUsage(
        keyId,
        totalTokens,
        inputTokens,
        outputTokens,
        cacheCreateTokens,
        cacheReadTokens,
        model,
        0, // ephemeral5mTokens - 暂时为0，后续处理
        0, // ephemeral1hTokens - 暂时为0，后续处理
        isLongContextRequest,
        realCost,
        ratedCost,
        serviceTier
      )

      // 记录费用统计到每日/每月汇总
      if (realCost > 0) {
        await redis.incrementDailyCost(keyId, ratedCost, realCost)
        logger.database(
          `💰 Recorded cost for ${keyId}: rated=$${ratedCost.toFixed(6)}, real=$${realCost.toFixed(6)}, model: ${model}`
        )

        // 记录 Opus 周费用（如果适用）
        await this.recordOpusCost(keyId, ratedCost, realCost, model, accountType)
      } else {
        logger.debug(`💰 No cost recorded for ${keyId} - zero cost for model: ${model}`)
      }

      // 获取API Key数据以确定关联的账户
      const keyData = await redis.getApiKey(keyId)
      if (keyData && Object.keys(keyData).length > 0) {
        // 🆕 v2 子 key：把倍率后成本汇总到父账号总账（与总账 402 校验同口径）
        if (keyData.parentKeyId && ratedCost > 0) {
          await redis.incrementV2ParentTotalCost(keyData.parentKeyId, ratedCost)
        }
        // 更新最后使用时间
        const lastUsedAt = new Date().toISOString()
        keyData.lastUsedAt = lastUsedAt
        await redis.setApiKey(keyId, keyData)

        // 同步更新 lastUsedAt 索引
        try {
          const apiKeyIndexService = require('./apiKeyIndexService')
          await apiKeyIndexService.updateLastUsedAt(keyId, lastUsedAt)
        } catch (err) {
          // 索引更新失败不影响主流程
        }

        // 记录账户级别的使用统计（只统计实际处理请求的账户）
        if (accountId) {
          await redis.incrementAccountUsage(
            accountId,
            totalTokens,
            inputTokens,
            outputTokens,
            cacheCreateTokens,
            cacheReadTokens,
            0, // ephemeral5mTokens - recordUsage 不含详细缓存数据
            0, // ephemeral1hTokens - recordUsage 不含详细缓存数据
            model,
            isLongContextRequest,
            serviceTier
          )
          logger.database(
            `📊 Recorded account usage: ${accountId} - ${totalTokens} tokens (API Key: ${keyId})`
          )
        } else {
          logger.debug(
            '⚠️ No accountId provided for usage recording, skipping account-level statistics'
          )
        }
      }

      // 记录单次请求的使用详情（同时保存真实成本和倍率成本）
      const usageRecord = {
        timestamp: new Date().toISOString(),
        model,
        serviceTier: serviceTier || null,
        accountId: accountId || null,
        accountType: accountType || null,
        requestId: finalizedRequestMeta?.requestId || null,
        endpoint: finalizedRequestMeta?.endpoint || null,
        method: finalizedRequestMeta?.method || null,
        statusCode: finalizedRequestMeta?.statusCode || null,
        stream: finalizedRequestMeta?.stream === true,
        durationMs: finalizedRequestMeta?.durationMs ?? null,
        upstreamNicIp: finalizedRequestMeta?.upstreamNicIp || null,
        inputTokens,
        outputTokens,
        cacheCreateTokens,
        cacheReadTokens,
        totalTokens,
        cost: Number(ratedCost.toFixed(6)),
        realCost: Number(realCost.toFixed(6)),
        costBreakdown: costInfo?.costs || undefined,
        realCostBreakdown: costInfo?.costs || undefined,
        isLongContext: isLongContextRequest,
        parentKeyId: keyData?.parentKeyId || null
      }

      await redis.addUsageRecord(keyId, usageRecord)
      this._captureRequestDetail(keyId, usageRecord, finalizedRequestMeta).catch((captureError) => {
        logger.warn(`⚠️ Failed to schedule request detail capture: ${captureError.message}`)
      })

      const logParts = [`Model: ${model}`, `Input: ${inputTokens}`, `Output: ${outputTokens}`]
      if (cacheCreateTokens > 0) {
        logParts.push(`Cache Create: ${cacheCreateTokens}`)
      }
      if (cacheReadTokens > 0) {
        logParts.push(`Cache Read: ${cacheReadTokens}`)
      }
      logParts.push(`Total: ${totalTokens} tokens`)

      logger.database(`📊 Recorded usage: ${keyId} - ${logParts.join(', ')}`)

      return { realCost, ratedCost }
    } catch (error) {
      logger.error('❌ Failed to record usage:', error)
      return { realCost: 0, ratedCost: 0 }
    }
  }

  // 📊 记录 Opus 模型费用（仅限 claude 和 claude-console 账户，支持自定义重置周期）
  // ratedCost: 倍率后的成本（用于限额校验）
  // realCost: 真实成本（用于对账），如果不传则等于 ratedCost
  async recordOpusCost(keyId, ratedCost, realCost, model, accountType) {
    try {
      // 判断是否为 Claude 系列模型（包含 Bedrock 格式等）
      if (!isClaudeFamilyModel(model)) {
        return
      }

      // 判断是否为 claude-official、claude-console 或 ccr 账户
      const opusAccountTypes = ['claude-official', 'claude-console', 'ccr']
      if (!accountType || !opusAccountTypes.includes(accountType)) {
        logger.debug(`⚠️ Skipping Opus cost recording for non-Claude account type: ${accountType}`)
        return // 不是 claude 账户，直接返回
      }

      // 获取 key 的重置配置（v2 子 key 使用父账号的周重置配置，但 weekly cost 仍记到 child）
      const keyData = await redis.getApiKey(keyId)
      let resetConfigSource = keyData
      if (keyData?.parentKeyId) {
        const parentData = await redis.getApiKey(keyData.parentKeyId)
        if (parentData && Object.keys(parentData).length > 0) {
          resetConfigSource = parentData
        }
      }
      const resetDay = parseInt(resetConfigSource?.weeklyResetDay || 1)
      const resetHour = parseInt(resetConfigSource?.weeklyResetHour || 0)

      // 记录 Opus 周费用（倍率成本和真实成本）
      await redis.incrementWeeklyOpusCost(keyId, ratedCost, realCost, resetDay, resetHour)
      logger.database(
        `💰 Recorded Opus weekly cost for ${keyId}: rated=$${ratedCost.toFixed(6)}, real=$${realCost.toFixed(6)}, model: ${model}`
      )
    } catch (error) {
      logger.error('❌ Failed to record Opus weekly cost:', error)
    }
  }

  // 📊 记录使用情况（新版本，支持详细的缓存类型）
  async recordUsageWithDetails(
    keyId,
    usageObject,
    model = 'unknown',
    accountId = null,
    accountType = null,
    requestMeta = null
  ) {
    try {
      const finalizedRequestMeta = finalizeRequestDetailMeta(requestMeta)
      // 提取 token 数量
      const inputTokens = usageObject.input_tokens || 0
      const outputTokens = usageObject.output_tokens || 0
      const cacheCreateTokens = usageObject.cache_creation_input_tokens || 0
      const cacheReadTokens = usageObject.cache_read_input_tokens || 0

      const totalTokens = inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens

      // 计算费用统一走 CostCalculator，缺少动态价格时使用内置 unknown fallback。
      let costInfo = {
        totalCost: 0,
        inputCost: 0,
        outputCost: 0,
        cacheCreateCost: 0,
        cacheReadCost: 0,
        ephemeral5mCost: 0,
        ephemeral1hCost: 0,
        isLongContextRequest: false,
        usedFallbackPricing: false,
        pricingSource: null
      }
      try {
        const CostCalculator = require('../utils/costCalculator')
        const calculatedCost = CostCalculator.calculateCost(usageObject, model)
        const costs = calculatedCost?.costs || {}
        const totalCost = Number(costs.total ?? calculatedCost?.totalCost ?? 0)

        if (!Number.isFinite(totalCost)) {
          throw new Error(`Invalid cost calculation result for model ${model}`)
        }

        costInfo = {
          totalCost,
          inputCost: Number(costs.input ?? calculatedCost?.inputCost ?? 0) || 0,
          outputCost: Number(costs.output ?? calculatedCost?.outputCost ?? 0) || 0,
          cacheCreateCost:
            Number(costs.cacheCreate ?? costs.cacheWrite ?? calculatedCost?.cacheCreateCost ?? 0) ||
            0,
          cacheReadCost: Number(costs.cacheRead ?? calculatedCost?.cacheReadCost ?? 0) || 0,
          ephemeral5mCost: Number(costs.ephemeral5m ?? calculatedCost?.ephemeral5mCost ?? 0) || 0,
          ephemeral1hCost: Number(costs.ephemeral1h ?? calculatedCost?.ephemeral1hCost ?? 0) || 0,
          isLongContextRequest:
            calculatedCost?.isLongContextRequest === true ||
            calculatedCost?.debug?.isLongContextRequest === true,
          usedFallbackPricing: calculatedCost?.debug?.usedFallbackPricing === true,
          pricingSource:
            calculatedCost?.debug?.pricingSource ||
            (calculatedCost?.usingDynamicPricing ? 'dynamic' : 'unknown-fallback')
        }
      } catch (pricingError) {
        logger.error(`❌ Failed to calculate cost for model ${model}:`, pricingError)
        logger.error(`   Usage object:`, JSON.stringify(usageObject))
      }

      // 提取详细的缓存创建数据
      let ephemeral5mTokens = 0
      let ephemeral1hTokens = 0

      if (usageObject.cache_creation && typeof usageObject.cache_creation === 'object') {
        ephemeral5mTokens = usageObject.cache_creation.ephemeral_5m_input_tokens || 0
        ephemeral1hTokens = usageObject.cache_creation.ephemeral_1h_input_tokens || 0
      }

      // 计算费用（应用服务倍率）- 需要在 incrementTokenUsage 之前计算
      const realCostWithDetails = costInfo.totalCost || 0
      let ratedCostWithDetails = realCostWithDetails
      if (realCostWithDetails > 0) {
        const service = serviceRatesService.getService(accountType, model)
        ratedCostWithDetails = await this.calculateRatedCost(keyId, service, realCostWithDetails)
      }

      // 记录API Key级别的使用统计（包含费用）
      await redis.incrementTokenUsage(
        keyId,
        totalTokens,
        inputTokens,
        outputTokens,
        cacheCreateTokens,
        cacheReadTokens,
        model,
        ephemeral5mTokens,
        ephemeral1hTokens,
        costInfo.isLongContextRequest || false,
        realCostWithDetails,
        ratedCostWithDetails
      )

      // 记录费用到每日/每月汇总
      if (realCostWithDetails > 0) {
        // 记录倍率成本和真实成本
        await redis.incrementDailyCost(keyId, ratedCostWithDetails, realCostWithDetails)
        logger.database(
          `💰 Recorded cost for ${keyId}: rated=$${ratedCostWithDetails.toFixed(6)}, real=$${realCostWithDetails.toFixed(6)}, model: ${model}`
        )

        // 记录 Opus 周费用（如果适用，也应用倍率）
        await this.recordOpusCost(
          keyId,
          ratedCostWithDetails,
          realCostWithDetails,
          model,
          accountType
        )

        // 记录详细的缓存费用（如果有）
        if (costInfo.ephemeral5mCost > 0 || costInfo.ephemeral1hCost > 0) {
          logger.database(
            `💰 Cache costs - 5m: $${costInfo.ephemeral5mCost.toFixed(
              6
            )}, 1h: $${costInfo.ephemeral1hCost.toFixed(6)}`
          )
        }
      } else {
        // 如果有 token 使用但费用为 0，记录警告
        if (totalTokens > 0) {
          logger.warn(
            `⚠️ No cost recorded for ${keyId} - zero cost for model: ${model} (tokens: ${totalTokens})`
          )
          logger.warn(`   This may indicate a pricing issue or model not found in pricing data`)
        } else {
          logger.debug(`💰 No cost recorded for ${keyId} - zero tokens for model: ${model}`)
        }
      }

      // 获取API Key数据以确定关联的账户
      const keyData = await redis.getApiKey(keyId)
      if (keyData && Object.keys(keyData).length > 0) {
        // 🆕 v2 子 key：把倍率后成本汇总到父账号总账（与总账 402 校验同口径）
        if (keyData.parentKeyId && ratedCostWithDetails > 0) {
          await redis.incrementV2ParentTotalCost(keyData.parentKeyId, ratedCostWithDetails)
        }
        // 更新最后使用时间
        const lastUsedAt = new Date().toISOString()
        keyData.lastUsedAt = lastUsedAt
        await redis.setApiKey(keyId, keyData)

        // 同步更新 lastUsedAt 索引
        try {
          const apiKeyIndexService = require('./apiKeyIndexService')
          await apiKeyIndexService.updateLastUsedAt(keyId, lastUsedAt)
        } catch (err) {
          // 索引更新失败不影响主流程
        }

        // 记录账户级别的使用统计（只统计实际处理请求的账户）
        if (accountId) {
          await redis.incrementAccountUsage(
            accountId,
            totalTokens,
            inputTokens,
            outputTokens,
            cacheCreateTokens,
            cacheReadTokens,
            ephemeral5mTokens,
            ephemeral1hTokens,
            model,
            costInfo.isLongContextRequest || false
          )
          logger.database(
            `📊 Recorded account usage: ${accountId} - ${totalTokens} tokens (API Key: ${keyId})`
          )
        } else {
          logger.debug(
            '⚠️ No accountId provided for usage recording, skipping account-level statistics'
          )
        }
      }

      const usageRecord = {
        timestamp: new Date().toISOString(),
        model,
        accountId: accountId || null,
        accountType: accountType || null,
        requestId: finalizedRequestMeta?.requestId || null,
        endpoint: finalizedRequestMeta?.endpoint || null,
        method: finalizedRequestMeta?.method || null,
        statusCode: finalizedRequestMeta?.statusCode || null,
        stream: finalizedRequestMeta?.stream === true,
        durationMs: finalizedRequestMeta?.durationMs ?? null,
        inputTokens,
        outputTokens,
        cacheCreateTokens,
        cacheReadTokens,
        ephemeral5mTokens,
        ephemeral1hTokens,
        totalTokens,
        cost: Number(ratedCostWithDetails.toFixed(6)),
        realCost: Number(realCostWithDetails.toFixed(6)),
        costBreakdown: {
          input: costInfo.inputCost || 0,
          output: costInfo.outputCost || 0,
          cacheCreate: costInfo.cacheCreateCost || 0,
          cacheRead: costInfo.cacheReadCost || 0,
          ephemeral5m: costInfo.ephemeral5mCost || 0,
          ephemeral1h: costInfo.ephemeral1hCost || 0,
          total: realCostWithDetails
        },
        realCostBreakdown: {
          input: costInfo.inputCost || 0,
          output: costInfo.outputCost || 0,
          cacheCreate: costInfo.cacheCreateCost || 0,
          cacheRead: costInfo.cacheReadCost || 0,
          ephemeral5m: costInfo.ephemeral5mCost || 0,
          ephemeral1h: costInfo.ephemeral1hCost || 0,
          total: realCostWithDetails
        },
        pricingSource: costInfo.pricingSource || null,
        usedFallbackPricing: costInfo.usedFallbackPricing === true,
        isLongContext: costInfo.isLongContextRequest || false,
        parentKeyId: keyData?.parentKeyId || null
      }

      await redis.addUsageRecord(keyId, usageRecord)
      this._captureRequestDetail(keyId, usageRecord, finalizedRequestMeta).catch((captureError) => {
        logger.warn(`⚠️ Failed to schedule request detail capture: ${captureError.message}`)
      })

      const logParts = [`Model: ${model}`, `Input: ${inputTokens}`, `Output: ${outputTokens}`]
      if (cacheCreateTokens > 0) {
        logParts.push(`Cache Create: ${cacheCreateTokens}`)

        // 如果有详细的缓存创建数据，也记录它们
        if (usageObject.cache_creation) {
          const { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens } =
            usageObject.cache_creation
          if (ephemeral_5m_input_tokens > 0) {
            logParts.push(`5m: ${ephemeral_5m_input_tokens}`)
          }
          if (ephemeral_1h_input_tokens > 0) {
            logParts.push(`1h: ${ephemeral_1h_input_tokens}`)
          }
        }
      }
      if (cacheReadTokens > 0) {
        logParts.push(`Cache Read: ${cacheReadTokens}`)
      }
      logParts.push(`Total: ${totalTokens} tokens`)

      logger.database(`📊 Recorded usage: ${keyId} - ${logParts.join(', ')}`)

      // 🔔 发布计费事件到消息队列（异步非阻塞）
      this._publishBillingEvent({
        keyId,
        keyName: keyData?.name,
        userId: keyData?.userId,
        model,
        inputTokens,
        outputTokens,
        cacheCreateTokens,
        cacheReadTokens,
        ephemeral5mTokens,
        ephemeral1hTokens,
        totalTokens,
        cost: costInfo.totalCost || 0,
        costBreakdown: {
          input: costInfo.inputCost || 0,
          output: costInfo.outputCost || 0,
          cacheCreate: costInfo.cacheCreateCost || 0,
          cacheRead: costInfo.cacheReadCost || 0,
          ephemeral5m: costInfo.ephemeral5mCost || 0,
          ephemeral1h: costInfo.ephemeral1hCost || 0
        },
        accountId,
        accountType,
        isLongContext: costInfo.isLongContextRequest || false,
        requestTimestamp: usageRecord.timestamp
      }).catch((err) => {
        // 发布失败不影响主流程，只记录错误
        logger.warn('⚠️ Failed to publish billing event:', err.message)
      })

      return { realCost: realCostWithDetails, ratedCost: ratedCostWithDetails }
    } catch (error) {
      logger.error('❌ Failed to record usage:', error)
      return { realCost: 0, ratedCost: 0 }
    }
  }

  async _captureRequestDetail(keyId, usageRecord, requestMeta = null) {
    if (!usageRecord) {
      return
    }

    await requestDetailService.captureRequestDetail({
      requestId: requestMeta?.requestId || usageRecord.requestId || null,
      timestamp: usageRecord.timestamp,
      requestStartedAt: requestMeta?.requestStartedAt || null,
      endpoint: requestMeta?.endpoint || usageRecord.endpoint || null,
      method: requestMeta?.method || usageRecord.method || null,
      statusCode: requestMeta?.statusCode ?? usageRecord.statusCode ?? 200,
      stream: requestMeta?.stream === true || usageRecord.stream === true,
      durationMs: requestMeta?.durationMs ?? usageRecord.durationMs ?? null,
      upstreamNicIp: requestMeta?.upstreamNicIp || usageRecord.upstreamNicIp || null,
      requestBody: requestMeta?.requestBody,
      apiKeyId: keyId,
      accountId: usageRecord.accountId || null,
      accountType: usageRecord.accountType || null,
      model: usageRecord.model || 'unknown',
      serviceTier: usageRecord.serviceTier || null,
      inputTokens: usageRecord.inputTokens || 0,
      outputTokens: usageRecord.outputTokens || 0,
      cacheReadTokens: usageRecord.cacheReadTokens || 0,
      cacheCreateTokens: usageRecord.cacheCreateTokens || 0,
      totalTokens: usageRecord.totalTokens || 0,
      cost: usageRecord.cost || 0,
      realCost: usageRecord.realCost || usageRecord.cost || 0,
      costBreakdown: usageRecord.costBreakdown || null,
      realCostBreakdown: usageRecord.realCostBreakdown || usageRecord.costBreakdown || null,
      pricingSource: usageRecord.pricingSource || null,
      usedFallbackPricing: usageRecord.usedFallbackPricing === true,
      isLongContextRequest:
        usageRecord.isLongContext === true || usageRecord.isLongContextRequest === true
    })
  }

  async _fetchAccountInfo(accountId, accountType, cache, client) {
    if (!client || !accountId || !accountType) {
      return null
    }

    const cacheKey = `${accountType}:${accountId}`
    if (cache.has(cacheKey)) {
      return cache.get(cacheKey)
    }

    const accountConfig = ACCOUNT_TYPE_CONFIG[accountType]
    if (!accountConfig) {
      cache.set(cacheKey, null)
      return null
    }

    const redisKey = `${accountConfig.prefix}${accountId}`
    let accountData = null
    try {
      accountData = await client.hgetall(redisKey)
    } catch (error) {
      logger.debug(`加载账号信息失败 ${redisKey}:`, error)
    }

    if (accountData && Object.keys(accountData).length > 0) {
      const displayName =
        accountData.name ||
        accountData.displayName ||
        accountData.email ||
        accountData.username ||
        accountData.description ||
        accountId

      const info = { id: accountId, name: displayName }
      cache.set(cacheKey, info)
      return info
    }

    cache.set(cacheKey, null)
    return null
  }

  async _resolveAccountByUsageRecord(usageRecord, cache, client) {
    if (!usageRecord || !client) {
      return null
    }

    const rawAccountId = usageRecord.accountId || null
    const rawAccountType = normalizeAccountTypeKey(usageRecord.accountType)
    const modelName = usageRecord.model || usageRecord.actualModel || usageRecord.service || null

    if (!rawAccountId && !rawAccountType) {
      return null
    }

    const candidateIds = new Set()
    if (rawAccountId) {
      candidateIds.add(rawAccountId)
      if (typeof rawAccountId === 'string' && rawAccountId.startsWith('responses:')) {
        candidateIds.add(rawAccountId.replace(/^responses:/, ''))
      }
      if (typeof rawAccountId === 'string' && rawAccountId.startsWith('api:')) {
        candidateIds.add(rawAccountId.replace(/^api:/, ''))
      }
    }

    if (candidateIds.size === 0) {
      return null
    }

    const typeCandidates = []
    const pushType = (type) => {
      const normalized = normalizeAccountTypeKey(type)
      if (normalized && ACCOUNT_TYPE_CONFIG[normalized] && !typeCandidates.includes(normalized)) {
        typeCandidates.push(normalized)
      }
    }

    pushType(rawAccountType)

    if (modelName) {
      const lowerModel = modelName.toLowerCase()
      if (lowerModel.includes('gpt') || lowerModel.includes('openai')) {
        pushType('openai')
        pushType('openai-responses')
        pushType('azure-openai')
      } else if (lowerModel.includes('gemini')) {
        pushType('gemini')
        pushType('gemini-api')
      } else if (lowerModel.includes('claude') || lowerModel.includes('anthropic')) {
        pushType('claude')
        pushType('claude-console')
      } else if (lowerModel.includes('droid')) {
        pushType('droid')
      }
    }

    ACCOUNT_TYPE_PRIORITY.forEach(pushType)

    for (const type of typeCandidates) {
      const accountConfig = ACCOUNT_TYPE_CONFIG[type]
      if (!accountConfig) {
        continue
      }

      for (const candidateId of candidateIds) {
        const normalizedId = sanitizeAccountIdForType(candidateId, type)
        const accountInfo = await this._fetchAccountInfo(normalizedId, type, cache, client)
        if (accountInfo) {
          return {
            accountId: normalizedId,
            accountName: accountInfo.name,
            accountType: type,
            accountCategory: ACCOUNT_CATEGORY_MAP[type] || 'other',
            rawAccountId: rawAccountId || normalizedId
          }
        }
      }
    }

    return null
  }

  async _resolveLastUsageAccount(apiKey, usageRecord, cache, client) {
    return await this._resolveAccountByUsageRecord(usageRecord, cache, client)
  }

  // 🔔 发布计费事件（内部方法）
  async _publishBillingEvent(eventData) {
    try {
      const billingEventPublisher = require('./billingEventPublisher')
      await billingEventPublisher.publishBillingEvent(eventData)
    } catch (error) {
      // 静默失败，不影响主流程
      logger.debug('Failed to publish billing event:', error.message)
    }
  }

  // 🔐 生成密钥
  _generateSecretKey() {
    return crypto.randomBytes(32).toString('hex')
  }

  // 🔒 哈希API Key
  _hashApiKey(apiKey) {
    return crypto
      .createHash('sha256')
      .update(apiKey + config.security.encryptionKey)
      .digest('hex')
  }

  // 📈 获取使用统计
  async getUsageStats(keyId, options = {}) {
    const usageStats = await redis.getUsageStats(keyId)

    // options 可能是字符串（兼容旧接口），仅当为对象时才解析
    const optionObject =
      options && typeof options === 'object' && !Array.isArray(options) ? options : {}

    if (optionObject.includeRecords === false) {
      return usageStats
    }

    const recordLimit = optionObject.recordLimit || 20
    const recentRecords = await redis.getUsageRecords(keyId, recordLimit)

    // API 兼容：同时输出 costBreakdown 和 realCostBreakdown
    const compatibleRecords = recentRecords.map((record) => {
      const breakdown = record.realCostBreakdown || record.costBreakdown
      return {
        ...record,
        costBreakdown: breakdown,
        realCostBreakdown: breakdown
      }
    })

    return {
      ...usageStats,
      recentRecords: compatibleRecords
    }
  }

  // 📊 获取账户使用统计
  async getAccountUsageStats(accountId) {
    return await redis.getAccountUsageStats(accountId)
  }

  // 📈 获取所有账户使用统计
  async getAllAccountsUsageStats() {
    return await redis.getAllAccountsUsageStats()
  }

  // === 用户相关方法 ===

  // 🔑 创建API Key（支持用户）
  async createApiKey(options = {}) {
    return await this.generateApiKey(options)
  }

  // 👤 获取用户的API Keys
  async getUserApiKeys(userId, includeDeleted = false) {
    try {
      const allKeys = await this.getAllApiKeysFast(includeDeleted)
      let userKeys = allKeys.filter((key) => key.userId === userId)

      // 默认过滤掉已删除的API Keys（Fast版本返回布尔值）
      if (!includeDeleted) {
        userKeys = userKeys.filter((key) => !key.isDeleted)
      }

      // Populate usage stats for each user's API key (same as getAllApiKeys does)
      const userKeysWithUsage = []
      for (const key of userKeys) {
        const usage = await redis.getUsageStats(key.id)
        const dailyCost = (await redis.getDailyCost(key.id)) || 0
        const costStats = await redis.getCostStats(key.id)

        userKeysWithUsage.push({
          id: key.id,
          name: key.name,
          description: key.description,
          key: key.maskedKey || null, // Fast版本已提供maskedKey
          tokenLimit: parseInt(key.tokenLimit || 0),
          isActive: key.isActive === true, // Fast版本返回布尔值
          createdAt: key.createdAt,
          lastUsedAt: key.lastUsedAt,
          expiresAt: key.expiresAt,
          usage,
          dailyCost,
          totalCost: costStats.total,
          dailyCostLimit: parseFloat(key.dailyCostLimit || 0),
          totalCostLimit: parseFloat(key.totalCostLimit || 0),
          userId: key.userId,
          userUsername: key.userUsername,
          createdBy: key.createdBy,
          droidAccountId: key.droidAccountId,
          enableIpWhitelist: key.enableIpWhitelist === true || key.enableIpWhitelist === 'true',
          ipWhitelist: normalizeIpWhitelist(key.ipWhitelist),
          // Include deletion fields for deleted keys
          isDeleted: key.isDeleted,
          deletedAt: key.deletedAt,
          deletedBy: key.deletedBy,
          deletedByType: key.deletedByType
        })
      }

      return userKeysWithUsage
    } catch (error) {
      logger.error('❌ Failed to get user API keys:', error)
      return []
    }
  }

  // 🔍 通过ID获取API Key（检查权限）
  async getApiKeyById(keyId, userId = null) {
    try {
      const keyData = await redis.getApiKey(keyId)
      if (!keyData) {
        return null
      }

      // 如果指定了用户ID，检查权限
      if (userId && keyData.userId !== userId) {
        return null
      }

      return {
        id: keyData.id,
        name: keyData.name,
        description: keyData.description,
        key: keyData.apiKey,
        tokenLimit: parseInt(keyData.tokenLimit || 0),
        isActive: keyData.isActive === 'true',
        createdAt: keyData.createdAt,
        lastUsedAt: keyData.lastUsedAt,
        expiresAt: keyData.expiresAt,
        userId: keyData.userId,
        userUsername: keyData.userUsername,
        createdBy: keyData.createdBy,
        permissions: normalizePermissions(keyData.permissions),
        dailyCostLimit: parseFloat(keyData.dailyCostLimit || 0),
        totalCostLimit: parseFloat(keyData.totalCostLimit || 0),
        // 所有平台账户绑定字段
        claudeAccountId: keyData.claudeAccountId,
        claudeConsoleAccountId: keyData.claudeConsoleAccountId,
        geminiAccountId: keyData.geminiAccountId,
        openaiAccountId: keyData.openaiAccountId,
        bedrockAccountId: keyData.bedrockAccountId,
        droidAccountId: keyData.droidAccountId,
        azureOpenaiAccountId: keyData.azureOpenaiAccountId,
        ccrAccountId: keyData.ccrAccountId,
        enableIpWhitelist: keyData.enableIpWhitelist === 'true',
        ipWhitelist: normalizeIpWhitelist(keyData.ipWhitelist),
        disableGptFastMode: parseBooleanWithDefault(keyData.disableGptFastMode, false),
        enableGeneralOpenAIEndpoint: parseBooleanWithDefault(
          keyData.enableGeneralOpenAIEndpoint,
          false
        ),
        enableGeneralPromptCacheAssist: parseBooleanWithDefault(
          keyData.enableGeneralPromptCacheAssist,
          false
        ),
        enableClaudeThinkingSignatureLossyFallback: parseBooleanWithDefault(
          keyData.enableClaudeThinkingSignatureLossyFallback,
          false
        ),
        enableOpenAIResponsesCodexAdaptation: parseBooleanWithDefault(
          keyData.enableOpenAIResponsesCodexAdaptation,
          true
        ),
        enableOpenAIResponsesPayloadRules: parseBooleanWithDefault(
          keyData.enableOpenAIResponsesPayloadRules,
          false
        ),
        openaiResponsesPayloadRules: parseOpenAIResponsesPayloadRules(
          keyData.openaiResponsesPayloadRules
        ),
        // 🆕 v2 展示字段（管理员可见，绝不含 v2PasswordHash）
        isV2Parent: keyData.isV2Parent === 'true',
        parentKeyId: keyData.parentKeyId || '',
        v2Email: keyData.v2Email || '',
        v2TotalBudget: parseFloat(keyData.v2TotalBudget || 0),
        v2UpgradedAt: keyData.v2UpgradedAt || ''
      }
    } catch (error) {
      logger.error('❌ Failed to get API key by ID:', error)
      return null
    }
  }

  // 🔄 重新生成API Key
  async regenerateApiKey(keyId) {
    try {
      const existingKey = await redis.getApiKey(keyId)
      if (!existingKey) {
        throw new Error('API key not found')
      }

      // 🆕 v2 父账号不可重新生成 API secret（保持不可直接调用）；v2 子 key 可重生成且归属不变
      if (existingKey.isV2Parent === 'true') {
        throw new Error('A v2 parent account cannot regenerate its API secret')
      }

      // 生成新的key
      const newApiKey = `${this.prefix}${this._generateSecretKey()}`
      const newHashedKey = this._hashApiKey(newApiKey)

      // 删除旧的哈希映射
      const oldHashedKey = existingKey.apiKey
      await redis.deleteApiKeyHash(oldHashedKey)

      // 更新key数据
      const updatedKeyData = {
        ...existingKey,
        apiKey: newHashedKey,
        encryptedApiKey: encrypt(newApiKey), // 🆕 同步刷新可逆明文副本
        updatedAt: new Date().toISOString()
      }

      // 保存新数据并建立新的哈希映射
      await redis.setApiKey(keyId, updatedKeyData, newHashedKey)

      logger.info(`🔄 Regenerated API key: ${existingKey.name} (${keyId})`)

      return {
        id: keyId,
        name: existingKey.name,
        key: newApiKey, // 返回完整的新key
        updatedAt: updatedKeyData.updatedAt
      }
    } catch (error) {
      logger.error('❌ Failed to regenerate API key:', error)
      throw error
    }
  }

  // 🔓 解密存储的可逆明文副本（decrypt 失败会原样返回密文，故必须前缀校验；useCache=false 不缓存明文密钥）
  _decryptStoredApiKeySecret(encryptedValue) {
    const plaintext = decrypt(encryptedValue, false)
    if (!plaintext || !plaintext.startsWith(this.prefix)) {
      const err = new Error('API key secret cannot be decrypted')
      err.code = 'PLAINTEXT_DECRYPT_FAILED'
      throw err
    }
    return plaintext
  }

  // 🔓 管理员显示 API Key 明文（只返回明文、绝不记录明文；旧 key 无副本 → PLAINTEXT_UNAVAILABLE）
  async getApiKeyPlaintextById(keyId, actor = 'admin') {
    const keyData = await redis.getApiKey(keyId)
    if (!keyData || Object.keys(keyData).length === 0 || keyData.isDeleted === 'true') {
      const err = new Error('API key not found')
      err.code = 'NOT_FOUND'
      throw err
    }
    if (keyData.isV2Parent === 'true') {
      const err = new Error('v2 parent account has no callable API secret')
      err.code = 'V2_PARENT_NO_SECRET'
      throw err
    }
    if (!keyData.encryptedApiKey) {
      const err = new Error('API key plaintext is unavailable')
      err.code = 'PLAINTEXT_UNAVAILABLE'
      throw err
    }
    logger.security(`API key secret revealed by ${actor}: ${keyId}`)
    return this._decryptStoredApiKeySecret(keyData.encryptedApiKey)
  }

  // 🗑️ 硬删除API Key (完全移除)
  async hardDeleteApiKey(keyId) {
    try {
      const keyData = await redis.getApiKey(keyId)
      if (!keyData) {
        throw new Error('API key not found')
      }

      // 删除key数据和哈希映射
      await redis.deleteApiKey(keyId)
      await redis.deleteApiKeyHash(keyData.apiKey)

      logger.info(`🗑️ Deleted API key: ${keyData.name} (${keyId})`)
      return true
    } catch (error) {
      logger.error('❌ Failed to delete API key:', error)
      throw error
    }
  }

  // 🚫 禁用用户的所有API Keys
  async disableUserApiKeys(userId) {
    try {
      const userKeys = await this.getUserApiKeys(userId)
      let disabledCount = 0

      for (const key of userKeys) {
        if (key.isActive) {
          await this.updateApiKey(key.id, { isActive: false })
          disabledCount++
        }
      }

      logger.info(`🚫 Disabled ${disabledCount} API keys for user: ${userId}`)
      return { count: disabledCount }
    } catch (error) {
      logger.error('❌ Failed to disable user API keys:', error)
      throw error
    }
  }

  // 📊 获取聚合使用统计（支持多个API Key）
  async getAggregatedUsageStats(keyIds, options = {}) {
    try {
      if (!Array.isArray(keyIds)) {
        keyIds = [keyIds]
      }

      const { period: _period = 'week', model: _model } = options
      const stats = {
        totalRequests: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCost: 0,
        dailyStats: [],
        modelStats: []
      }

      // 汇总所有API Key的统计数据
      for (const keyId of keyIds) {
        const keyStats = await redis.getUsageStats(keyId)
        const costStats = await redis.getCostStats(keyId)
        if (keyStats && keyStats.total) {
          stats.totalRequests += keyStats.total.requests || 0
          stats.totalInputTokens += keyStats.total.inputTokens || 0
          stats.totalOutputTokens += keyStats.total.outputTokens || 0
          stats.totalCost += costStats?.total || 0
        }
      }

      // TODO: 实现日期范围和模型统计
      // 这里可以根据需要添加更详细的统计逻辑

      return stats
    } catch (error) {
      logger.error('❌ Failed to get usage stats:', error)
      return {
        totalRequests: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCost: 0,
        dailyStats: [],
        modelStats: []
      }
    }
  }

  // 🔓 解绑账号从所有API Keys
  async unbindAccountFromAllKeys(accountId, accountType) {
    try {
      // 账号类型与字段的映射关系
      const fieldMap = {
        claude: 'claudeAccountId',
        'claude-console': 'claudeConsoleAccountId',
        gemini: 'geminiAccountId',
        'gemini-api': 'geminiAccountId', // 特殊处理，带 api: 前缀
        openai: 'openaiAccountId',
        'openai-responses': 'openaiAccountId', // 特殊处理，带 responses: 前缀
        azure_openai: 'azureOpenaiAccountId',
        bedrock: 'bedrockAccountId',
        droid: 'droidAccountId',
        ccr: null // CCR 账号没有对应的 API Key 字段
      }

      const field = fieldMap[accountType]
      if (!field) {
        logger.info(`账号类型 ${accountType} 不需要解绑 API Key`)
        return 0
      }

      // 获取所有API Keys
      const allKeys = await this.getAllApiKeysFast()

      // 筛选绑定到此账号的 API Keys
      let boundKeys = []
      if (accountType === 'openai-responses') {
        // OpenAI-Responses 特殊处理：查找 openaiAccountId 字段中带 responses: 前缀的
        boundKeys = allKeys.filter((key) => key.openaiAccountId === `responses:${accountId}`)
      } else if (accountType === 'gemini-api') {
        // Gemini-API 特殊处理：查找 geminiAccountId 字段中带 api: 前缀的
        boundKeys = allKeys.filter((key) => key.geminiAccountId === `api:${accountId}`)
      } else {
        // 其他账号类型正常匹配
        boundKeys = allKeys.filter((key) => key[field] === accountId)
      }

      // 批量解绑
      for (const key of boundKeys) {
        const updates = {}
        if (accountType === 'openai-responses') {
          updates.openaiAccountId = null
        } else if (accountType === 'gemini-api') {
          updates.geminiAccountId = null
        } else if (accountType === 'claude-console') {
          updates.claudeConsoleAccountId = null
        } else {
          updates[field] = null
        }

        await this.updateApiKey(key.id, updates)
        logger.info(
          `✅ 自动解绑 API Key ${key.id} (${key.name}) 从 ${accountType} 账号 ${accountId}`
        )
      }

      if (boundKeys.length > 0) {
        logger.success(
          `🔓 成功解绑 ${boundKeys.length} 个 API Key 从 ${accountType} 账号 ${accountId}`
        )
      }

      return boundKeys.length
    } catch (error) {
      logger.error(`❌ 解绑 API Keys 失败 (${accountType} 账号 ${accountId}):`, error)
      return 0
    }
  }

  // 🧹 清理过期的API Keys
  async cleanupExpiredKeys() {
    try {
      const apiKeys = await this.getAllApiKeysFast()
      const now = new Date()
      let cleanedCount = 0

      for (const key of apiKeys) {
        // v2 父账号无过期语义（升级时已清 expiresAt；这里防御存量带过期时间的父账号），
        // 不能被定时任务自动禁用，否则整个 v2 账号（登录+全部子 key）会静默瘫痪
        if (key.isV2Parent === true) {
          continue
        }
        // 检查是否已过期且仍处于激活状态（Fast版本返回布尔值）
        if (key.expiresAt && new Date(key.expiresAt) < now && key.isActive === true) {
          // 将过期的 API Key 标记为禁用状态，而不是直接删除
          await this.updateApiKey(key.id, { isActive: false })
          logger.info(`🔒 API Key ${key.id} (${key.name}) has expired and been disabled`)
          cleanedCount++
        }
      }

      if (cleanedCount > 0) {
        logger.success(`🧹 Disabled ${cleanedCount} expired API keys`)
      }

      return cleanedCount
    } catch (error) {
      logger.error('❌ Failed to cleanup expired keys:', error)
      return 0
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 服务倍率和费用限制相关方法
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 计算应用倍率后的费用
   * 公式：消费计费 = 真实消费 × 全局倍率 × Key 倍率
   * @param {string} keyId - API Key ID
   * @param {string} service - 服务类型
   * @param {number} realCost - 真实成本（USD）
   * @returns {Promise<number>} 应用倍率后的费用
   */
  async calculateRatedCost(keyId, service, realCost) {
    try {
      // 获取全局倍率
      const globalRate = await serviceRatesService.getServiceRate(service)

      // 获取 Key 倍率（v2 子 key 的倍率实时继承自父账号，一处改动覆盖全部调用点）
      const keyData = await redis.getApiKey(keyId)
      let rateSource = keyData
      if (keyData?.parentKeyId) {
        const parentData = await redis.getApiKey(keyData.parentKeyId)
        if (parentData && Object.keys(parentData).length > 0) {
          rateSource = parentData
        }
      }
      let keyRates = {}
      try {
        keyRates = JSON.parse(rateSource?.serviceRates || '{}')
      } catch (e) {
        keyRates = {}
      }
      const keyRate = keyRates[service] ?? 1.0

      // 相乘计算
      return realCost * globalRate * keyRate
    } catch (error) {
      logger.error('❌ Failed to calculate rated cost:', error)
      // 出错时返回原始费用
      return realCost
    }
  }

  /**
   * 增加 API Key 费用限制（用于核销额度卡）
   * @param {string} keyId - API Key ID
   * @param {number} amount - 要增加的金额（USD）
   * @returns {Promise<Object>} { success: boolean, newTotalCostLimit: number }
   */
  async addTotalCostLimit(keyId, amount) {
    try {
      const keyData = await redis.getApiKey(keyId)
      if (!keyData || Object.keys(keyData).length === 0) {
        throw new Error('API key not found')
      }

      const currentLimit = parseFloat(keyData.totalCostLimit || 0)
      const newLimit = currentLimit + amount

      await redis.client.hset(`apikey:${keyId}`, 'totalCostLimit', String(newLimit))

      logger.success(`💰 Added $${amount} to key ${keyId}, new limit: $${newLimit}`)

      return { success: true, previousLimit: currentLimit, newTotalCostLimit: newLimit }
    } catch (error) {
      logger.error('❌ Failed to add total cost limit:', error)
      throw error
    }
  }

  /**
   * 减少 API Key 费用限制（用于撤销核销）
   * @param {string} keyId - API Key ID
   * @param {number} amount - 要减少的金额（USD）
   * @returns {Promise<Object>} { success: boolean, newTotalCostLimit: number, actualDeducted: number }
   */
  async deductTotalCostLimit(keyId, amount) {
    try {
      const keyData = await redis.getApiKey(keyId)
      if (!keyData || Object.keys(keyData).length === 0) {
        throw new Error('API key not found')
      }

      const currentLimit = parseFloat(keyData.totalCostLimit || 0)
      const costStats = await redis.getCostStats(keyId)
      const currentUsed = costStats?.total || 0

      // 不能扣到比已使用的还少
      const minLimit = currentUsed
      const actualDeducted = Math.min(amount, currentLimit - minLimit)
      const newLimit = Math.max(currentLimit - amount, minLimit)

      await redis.client.hset(`apikey:${keyId}`, 'totalCostLimit', String(newLimit))

      logger.success(`💸 Deducted $${actualDeducted} from key ${keyId}, new limit: $${newLimit}`)

      return {
        success: true,
        previousLimit: currentLimit,
        newTotalCostLimit: newLimit,
        actualDeducted
      }
    } catch (error) {
      logger.error('❌ Failed to deduct total cost limit:', error)
      throw error
    }
  }

  /**
   * 延长 API Key 有效期（用于核销时间卡）
   * @param {string} keyId - API Key ID
   * @param {number} amount - 时间数量
   * @param {string} unit - 时间单位 'hours' | 'days' | 'months'
   * @returns {Promise<Object>} { success: boolean, newExpiresAt: string }
   */
  async extendExpiry(keyId, amount, unit = 'days') {
    try {
      const keyData = await redis.getApiKey(keyId)
      if (!keyData || Object.keys(keyData).length === 0) {
        throw new Error('API key not found')
      }

      // 计算新的过期时间
      let baseDate = keyData.expiresAt ? new Date(keyData.expiresAt) : new Date()
      // 如果已过期，从当前时间开始计算
      if (baseDate < new Date()) {
        baseDate = new Date()
      }

      let milliseconds
      switch (unit) {
        case 'hours':
          milliseconds = amount * 60 * 60 * 1000
          break
        case 'months':
          // 简化处理：1个月 = 30天
          milliseconds = amount * 30 * 24 * 60 * 60 * 1000
          break
        case 'days':
        default:
          milliseconds = amount * 24 * 60 * 60 * 1000
      }

      const newExpiresAt = new Date(baseDate.getTime() + milliseconds).toISOString()

      await this.updateApiKey(keyId, { expiresAt: newExpiresAt })

      logger.success(
        `⏰ Extended key ${keyId} expiry by ${amount} ${unit}, new expiry: ${newExpiresAt}`
      )

      return { success: true, previousExpiresAt: keyData.expiresAt, newExpiresAt }
    } catch (error) {
      logger.error('❌ Failed to extend expiry:', error)
      throw error
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 🆕 v2 账号：升级 / 配置管理 / 子 key 体系
  // ═══════════════════════════════════════════════════════════════════════════

  // 邮箱基础格式校验
  _isValidEmail(email) {
    return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  }

  // ⬆️ 将一个普通 API Key 单向升级为 v2 父账号
  async upgradeToV2Parent(keyId, { email, password } = {}) {
    const keyData = await redis.getApiKey(keyId)
    if (!keyData || Object.keys(keyData).length === 0) {
      throw new Error('API key not found')
    }
    if (keyData.isDeleted === 'true') {
      throw new Error('Cannot upgrade a deleted API key')
    }
    if (keyData.isV2Parent === 'true') {
      throw new Error('API key is already a v2 parent account')
    }
    if (keyData.parentKeyId) {
      throw new Error('A v2 child key cannot be upgraded')
    }
    // 不允许已属于用户体系的 key 升级，避免与现有用户体系混用
    if (keyData.userId) {
      throw new Error('An API key owned by a user cannot be upgraded to a v2 account')
    }

    const normalizedEmail = (email || '').trim().toLowerCase()
    if (!this._isValidEmail(normalizedEmail)) {
      throw new Error('Invalid email format')
    }

    // 拒绝与管理员用户名相同的邮箱（登录先试管理员，避免混淆）
    const adminData = await redis.getSession('admin_credentials')
    if (adminData?.username && adminData.username.toLowerCase() === normalizedEmail) {
      throw new Error('This email conflicts with the administrator account')
    }

    if (!password || password.length < 8) {
      throw new Error('Password must be at least 8 characters long')
    }

    // 升级时不单独设置 v2 总账额度：直接沿用原 API Key 的总费用上限。
    // totalCostLimit=0 保持既有语义，即不限额。
    const originalTotalLimit = Number(keyData.totalCostLimit)
    const budget =
      Number.isFinite(originalTotalLimit) && originalTotalLimit > 0 ? originalTotalLimit : 0

    // 原子抢占邮箱（HSETNX）
    const reserved = await redis.setV2EmailIndex(normalizedEmail, keyId)
    if (!reserved) {
      const err = new Error('This email is already used by another v2 account')
      err.code = 'EMAIL_CONFLICT'
      throw err
    }

    let inheritedUsageInitialized = false
    try {
      const v2PasswordHash = await bcrypt.hash(password, 10)
      const costStats = await redis.getCostStats(keyId)
      const inheritedUsed = Number(costStats?.total)
      await redis.setV2ParentTotalCost(
        keyId,
        Number.isFinite(inheritedUsed) && inheritedUsed > 0 ? inheritedUsed : 0
      )
      inheritedUsageInitialized = true

      const updatedData = {
        ...keyData,
        isV2Parent: 'true',
        v2Email: normalizedEmail,
        v2PasswordHash,
        v2TotalBudget: String(budget),
        v2UpgradedAt: new Date().toISOString(),
        // 父账号在管理列表里仍显示为启用，但 API 调用不可用（hash 已删除）
        isActive: 'true',
        // 清除原过期时间：父账号不再有过期语义（hash 已删不可直接调用），
        // 否则 cleanupExpiredKeys 定时任务会在原过期日把整个 v2 账号自动禁用
        expiresAt: ''
      }
      await redis.setApiKey(keyId, updatedData)

      // 删除父 key 的 hash 映射（同时清旧/新结构）→ 原 secret 立即不可直接调用
      if (keyData.apiKey) {
        await redis.deleteApiKeyHash(keyData.apiKey)
      }

      // 同步索引，保证管理员列表可显示
      try {
        const apiKeyIndexService = require('./apiKeyIndexService')
        await apiKeyIndexService.updateIndex(
          keyId,
          { isActive: true },
          {
            name: keyData.name,
            isActive: keyData.isActive === 'true',
            isDeleted: keyData.isDeleted === 'true',
            tags: JSON.parse(keyData.tags || '[]')
          }
        )
      } catch (err) {
        logger.warn(`Failed to update API Key index after v2 upgrade ${keyId}:`, err.message)
      }

      logger.success(`⬆️ Upgraded API key ${keyId} to v2 parent account (${normalizedEmail})`)
      return { success: true, keyId, v2Email: normalizedEmail, v2TotalBudget: budget }
    } catch (error) {
      // 失败回滚：仅当邮箱索引仍指向本 key 时删除，避免悬挂索引
      try {
        const owner = await redis.getV2KeyIdByEmail(normalizedEmail)
        if (owner === keyId) {
          await redis.deleteV2EmailIndex(normalizedEmail)
        }
        if (inheritedUsageInitialized) {
          await redis.deleteV2ParentTotalCost(keyId)
        }
      } catch (rollbackErr) {
        logger.error('❌ Failed to rollback v2 email index after upgrade error:', rollbackErr)
      }
      logger.error('❌ Failed to upgrade API key to v2 parent:', error)
      throw error
    }
  }

  // 🔎 通过邮箱查找 v2 父账号（返回 raw keyData，含 v2PasswordHash，仅供登录校验，禁止外泄）
  async findV2ByEmail(email) {
    const normalizedEmail = (email || '').trim().toLowerCase()
    if (!normalizedEmail) {
      return null
    }
    const parentKeyId = await redis.getV2KeyIdByEmail(normalizedEmail)
    if (!parentKeyId) {
      return null
    }
    const keyData = await redis.getApiKey(parentKeyId)
    if (!keyData || Object.keys(keyData).length === 0) {
      return null
    }
    if (
      keyData.isV2Parent !== 'true' ||
      keyData.isDeleted === 'true' ||
      keyData.isActive !== 'true'
    ) {
      return null
    }
    // 邮箱索引一致性 fail-closed：changeV2Email 部分失败可能残留旧邮箱索引，
    // 此时 key 内 v2Email 已不是查询邮箱——拒绝按旧邮箱登录并告警（数据修复走人工/脚本）
    if ((keyData.v2Email || '').toLowerCase() !== normalizedEmail) {
      logger.warn(
        `⚠️ v2 email index mismatch: index ${normalizedEmail} -> ${parentKeyId}, but key v2Email is ${keyData.v2Email || '(empty)'}`
      )
      return null
    }
    return { id: parentKeyId, ...keyData }
  }

  // 💰 更新 v2 父账号总账额度（仅管理员）
  async updateV2TotalBudget(parentKeyId, totalBudget) {
    const keyData = await redis.getApiKey(parentKeyId)
    if (!keyData || keyData.isV2Parent !== 'true') {
      throw new Error('Not a v2 parent account')
    }
    const budget = Number(totalBudget)
    if (!Number.isFinite(budget) || budget < 0) {
      throw new Error('Total budget must be a non-negative number')
    }
    await redis.client.hset(`apikey:${parentKeyId}`, 'v2TotalBudget', String(budget))
    logger.success(`💰 Updated v2 total budget for ${parentKeyId}: $${budget}`)
    return { success: true, v2TotalBudget: budget }
  }

  // 🔑 管理员重置 v2 密码
  async resetV2Password(parentKeyId, password) {
    const keyData = await redis.getApiKey(parentKeyId)
    if (!keyData || keyData.isV2Parent !== 'true') {
      throw new Error('Not a v2 parent account')
    }
    if (!password || password.length < 8) {
      throw new Error('Password must be at least 8 characters long')
    }
    const v2PasswordHash = await bcrypt.hash(password, 10)
    // v2PasswordChangedAt 用于 authenticateV2Account 失效所有更早登录的会话
    await redis.client.hset(`apikey:${parentKeyId}`, {
      v2PasswordHash,
      v2PasswordChangedAt: new Date().toISOString()
    })
    logger.success(`🔑 Admin reset v2 password for ${parentKeyId}`)
    return { success: true }
  }

  // 🔑 v2 自助修改密码（校验当前密码）
  async changeV2Password(parentKeyId, currentPassword, newPassword) {
    const keyData = await redis.getApiKey(parentKeyId)
    if (!keyData || keyData.isV2Parent !== 'true') {
      throw new Error('Not a v2 parent account')
    }
    const matched = await bcrypt.compare(currentPassword || '', keyData.v2PasswordHash || '')
    if (!matched) {
      const err = new Error('Current password is incorrect')
      err.code = 'INVALID_PASSWORD'
      throw err
    }
    if (!newPassword || newPassword.length < 8) {
      throw new Error('Password must be at least 8 characters long')
    }
    const v2PasswordHash = await bcrypt.hash(newPassword, 10)
    // v2PasswordChangedAt 用于 authenticateV2Account 失效所有更早登录的会话
    await redis.client.hset(`apikey:${parentKeyId}`, {
      v2PasswordHash,
      v2PasswordChangedAt: new Date().toISOString()
    })
    logger.success(`🔑 v2 account changed own password: ${parentKeyId}`)
    return { success: true }
  }

  // 📧 管理员修改 v2 邮箱（事务式维护邮箱索引一致性）
  async changeV2Email(parentKeyId, newEmail) {
    const keyData = await redis.getApiKey(parentKeyId)
    if (!keyData || keyData.isV2Parent !== 'true') {
      throw new Error('Not a v2 parent account')
    }
    const normalizedEmail = (newEmail || '').trim().toLowerCase()
    if (!this._isValidEmail(normalizedEmail)) {
      throw new Error('Invalid email format')
    }
    const oldEmail = (keyData.v2Email || '').toLowerCase()
    if (normalizedEmail === oldEmail) {
      return { success: true, v2Email: normalizedEmail }
    }
    const adminData = await redis.getSession('admin_credentials')
    if (adminData?.username && adminData.username.toLowerCase() === normalizedEmail) {
      throw new Error('This email conflicts with the administrator account')
    }
    // 先抢占新邮箱，再改 key，再删旧邮箱；失败回滚新邮箱索引
    const reserved = await redis.setV2EmailIndex(normalizedEmail, parentKeyId)
    if (!reserved) {
      const err = new Error('This email is already used by another v2 account')
      err.code = 'EMAIL_CONFLICT'
      throw err
    }
    try {
      await redis.client.hset(`apikey:${parentKeyId}`, 'v2Email', normalizedEmail)
      if (oldEmail) {
        await redis.deleteV2EmailIndex(oldEmail)
      }
      logger.success(`📧 Changed v2 email for ${parentKeyId}: ${oldEmail} -> ${normalizedEmail}`)
      return { success: true, v2Email: normalizedEmail }
    } catch (error) {
      try {
        const owner = await redis.getV2KeyIdByEmail(normalizedEmail)
        if (owner === parentKeyId) {
          await redis.deleteV2EmailIndex(normalizedEmail)
        }
      } catch (rollbackErr) {
        logger.error('❌ Failed to rollback v2 email index after email change error:', rollbackErr)
      }
      throw error
    }
  }

  // 📊 v2 账号总账摘要（不含任何上游账户信息）
  async getV2AccountSummary(parentKeyId) {
    const keyData = await redis.getApiKey(parentKeyId)
    if (!keyData || keyData.isV2Parent !== 'true') {
      throw new Error('Not a v2 parent account')
    }
    const budget = parseFloat(keyData.v2TotalBudget || 0)
    const used = await redis.getV2ParentTotalCost(parentKeyId)
    const unlimited = !(budget > 0)
    return {
      v2Email: keyData.v2Email || '',
      name: keyData.name || '',
      v2TotalBudget: budget,
      used,
      remaining: unlimited ? null : Math.max(0, budget - used),
      unlimited
    }
  }

  // 🌐 v2 账号级 IP 白名单（父 key 白名单字段即账号级默认；只返回白名单配置，不含上游账户信息）
  async getV2IpWhitelist(parentKeyId) {
    const parent = await redis.getApiKey(parentKeyId)
    if (
      !parent ||
      Object.keys(parent).length === 0 ||
      parent.isV2Parent !== 'true' ||
      parent.isDeleted === 'true' ||
      parent.isActive !== 'true'
    ) {
      throw new Error('Not an active v2 parent account')
    }

    return {
      enableIpWhitelist: parent.enableIpWhitelist === true || parent.enableIpWhitelist === 'true',
      ipWhitelist: normalizeIpWhitelist(parent.ipWhitelist)
    }
  }

  // 🌐 v2 自助更新账号级 IP 白名单。定点 hset（同族 resetV2Password/updateV2TotalBudget），
  // 不走 updateApiKey 全量回写：避免与改密码/改总额并发互踩，也天然不碰 hash 映射
  async updateV2IpWhitelist(parentKeyId, { enableIpWhitelist, ipWhitelist } = {}) {
    const parent = await redis.getApiKey(parentKeyId)
    if (
      !parent ||
      Object.keys(parent).length === 0 ||
      parent.isV2Parent !== 'true' ||
      parent.isDeleted === 'true' ||
      parent.isActive !== 'true'
    ) {
      throw new Error('Not an active v2 parent account')
    }

    const enable = parseV2Boolean(enableIpWhitelist, 'enableIpWhitelist')
    if (!Array.isArray(ipWhitelist)) {
      throw new Error('ipWhitelist must be an array')
    }

    const validation = validateIpWhitelist(ipWhitelist)
    if (!validation.valid) {
      throw new Error(validation.error)
    }
    if (validation.entries.length > V2_MAX_IP_WHITELIST_ENTRIES) {
      throw new Error(`IP whitelist cannot exceed ${V2_MAX_IP_WHITELIST_ENTRIES} entries`)
    }
    if (enable && validation.entries.length === 0) {
      throw new Error('启用 IP 白名单时至少需要一个 IP 或 CIDR')
    }

    await redis.client.hset(`apikey:${parentKeyId}`, {
      enableIpWhitelist: String(enable),
      ipWhitelist: JSON.stringify(validation.entries),
      updatedAt: new Date().toISOString()
    })

    logger.success(
      `🌐 v2 account ${parentKeyId} updated IP whitelist (enabled=${enable}, entries=${validation.entries.length})`
    )
    return {
      enableIpWhitelist: enable,
      ipWhitelist: validation.entries
    }
  }

  // 🕵️ 管理员模拟登录：为目标 v2 父账号铸造一个与 web.js v2 登录同构的真实会话，
  // 额外带 impersonatedBy 审计字段（authenticateV2Account 滑动续期用 {...session} 展开，该字段全程保留）
  async createV2ImpersonationSession(parentKeyId, adminUsername) {
    const parent = await redis.getApiKey(parentKeyId)
    if (
      !parent ||
      Object.keys(parent).length === 0 ||
      parent.isV2Parent !== 'true' ||
      parent.isDeleted === 'true' ||
      parent.isActive !== 'true' ||
      !parent.v2Email ||
      !parent.v2Email.trim()
    ) {
      // 无邮箱会铸出 username 为空的会话，过不了 authenticateV2Account——一并 fail-fast
      throw new Error('Not an active v2 parent account')
    }

    const sessionId = crypto.randomBytes(32).toString('hex')
    const now = new Date().toISOString()
    const v2Email = parent.v2Email.trim().toLowerCase()
    const sessionData = {
      username: v2Email,
      role: 'v2',
      v2KeyId: parentKeyId,
      v2Email,
      loginTime: now,
      lastActivity: now,
      impersonatedBy: adminUsername || 'unknown-admin'
    }

    // 与 web.js v2 登录完全同参（adminSessionTimeout 毫秒当秒的既有口径刻意镜像，
    // 实际安全边界是 authenticateV2Account 的 24h 不活跃检查）
    await redis.setSession(sessionId, sessionData, config.security.adminSessionTimeout)

    logger.security(
      `🕵️ Admin ${adminUsername || 'unknown-admin'} impersonated v2 account ${parentKeyId} (${v2Email})`
    )

    return {
      token: sessionId,
      username: v2Email,
      expiresIn: config.security.adminSessionTimeout
    }
  }

  // 🔑 v2 创建子 key（仅受限字段；其余配置运行时实时继承父账号）
  async createV2Child(parentKeyId, { name, description, dailyCostLimit, totalCostLimit } = {}) {
    const parent = await redis.getApiKey(parentKeyId)
    if (!parent || Object.keys(parent).length === 0 || parent.isV2Parent !== 'true') {
      throw new Error('Not a v2 parent account')
    }
    if (parent.isDeleted === 'true' || parent.isActive !== 'true') {
      throw new Error('v2 parent account is disabled')
    }
    if (!name || !name.trim()) {
      throw new Error('API key name is required')
    }
    for (const [field, val] of [
      ['dailyCostLimit', dailyCostLimit],
      ['totalCostLimit', totalCostLimit]
    ]) {
      if (
        val !== undefined &&
        val !== null &&
        val !== '' &&
        (Number.isNaN(Number(val)) || Number(val) < 0)
      ) {
        throw new Error(`${field} must be a non-negative number`)
      }
    }

    // 子 key 数量上限：按「未软删除」数量计——软删除的子 key 仍留在 children 集合中
    // （供 includeDeleted 列表展示），不应继续占用配额；并发竞态下轻微超限可接受
    const activeChildren = await this._getV2ChildKeys(parentKeyId, false)
    if (activeChildren.length >= V2_MAX_CHILD_KEYS) {
      throw new Error(`子 key 数量已达上限 (${V2_MAX_CHILD_KEYS})`)
    }

    // 只传受限字段 + 归属信息；不复制父账号绑定/权限/限制/倍率，保证实时继承
    const newKey = await this.generateApiKey({
      name: name.trim(),
      description: (description || '').trim(),
      dailyCostLimit: dailyCostLimit || 0,
      totalCostLimit: totalCostLimit || 0,
      permissions: [],
      parentKeyId,
      createdBy: 'v2'
    })

    try {
      await redis.addV2Child(parentKeyId, newKey.id)
    } catch (error) {
      // 集合登记失败会产生「可调用但列表不可见」的孤儿 key：软删除回滚（同时移除 hash）后再抛错
      try {
        await this.deleteApiKey(newKey.id, 'system', 'system')
      } catch (rollbackErr) {
        logger.error(`❌ Failed to rollback orphan v2 child key ${newKey.id}:`, rollbackErr)
      }
      throw error
    }
    logger.success(`🔑 v2 parent ${parentKeyId} created child key ${newKey.id}`)
    return newKey
  }

  // 🔒 子 key 视图（fail-closed 白名单：绝不可能出现上游账户/权限/倍率字段）
  _toV2ChildView(key) {
    if (!key || typeof key !== 'object') {
      return null
    }
    return {
      id: key.id,
      name: key.name,
      description: key.description,
      maskedKey: key.maskedKey || null,
      isActive: key.isActive === true || key.isActive === 'true',
      createdAt: key.createdAt,
      lastUsedAt: key.lastUsedAt || null,
      expiresAt: key.expiresAt || null,
      dailyCostLimit: parseFloat(key.dailyCostLimit || 0),
      totalCostLimit: parseFloat(key.totalCostLimit || 0),
      dailyCost: key.dailyCost || 0,
      totalCost: key.totalCost || 0,
      usage: key.usage || null,
      currentConcurrency: key.currentConcurrency || 0,
      currentWindowRequests: key.currentWindowRequests || 0,
      currentWindowCost: key.currentWindowCost || 0,
      // IP 白名单展示「子 key 自身 override 状态」而非父账号 overlay 后的生效值：
      // 列表接口不承载账号级配置（编辑账号级白名单走专用 GET 接口）
      ipWhitelistOverride:
        key.v2IpWhitelistOverride === true || key.v2IpWhitelistOverride === 'true',
      enableIpWhitelist: key.enableIpWhitelist === true || key.enableIpWhitelist === 'true',
      ipWhitelist: normalizeIpWhitelist(key.ipWhitelist),
      isDeleted: key.isDeleted === true || key.isDeleted === 'true'
    }
  }

  // 📦 经 v2:children 集合批量加载某父账号的子 key（不随全库 key 数线性扫描）
  async _getV2ChildKeys(parentKeyId, includeDeleted = false) {
    const childIds = await redis.getV2ChildIds(parentKeyId)
    if (!Array.isArray(childIds) || childIds.length === 0) {
      return []
    }
    const keys = await this.getAllApiKeysFast(includeDeleted, childIds)
    // 集合脏数据 fail-closed 防御：只保留 parentKeyId 确实指向本父账号的 key
    return keys.filter((k) => k.parentKeyId === parentKeyId)
  }

  // 📋 获取 v2 父账号的子 key 列表（已最小化；createdAt 倒序保证 UI 稳定）
  async getV2Children(parentKeyId, includeDeleted = false) {
    const children = await this._getV2ChildKeys(parentKeyId, includeDeleted)
    return children
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
      .map((k) => this._toV2ChildView(k))
      .filter(Boolean)
  }

  // 🛠️ 管理员视角的子 key 列表：完整 key 形状（与主列表行一致），不经 _toV2ChildView 最小化。
  // _getV2ChildKeys 经 v2:children 集合加载并已 fail-closed 过滤归属；getAllApiKeysFast 已删
  // apiKey / encryptedApiKey / v2PasswordHash，无明文/密码泄漏。createdAt 倒序保证 UI 稳定。
  async getV2ChildrenForAdmin(parentKeyId, includeDeleted = false, parentData = null) {
    const children = await this._getV2ChildKeys(parentKeyId, includeDeleted)
    const sortedChildren = children.sort(
      (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
    )
    if (sortedChildren.length === 0) {
      return []
    }

    const parent = parentData || (await redis.getApiKey(parentKeyId))
    return sortedChildren.map((child) => this._overlayV2ParentFieldsForAdmin(child, parent))
  }

  // 🔐 校验子 key 归属（不归属/不存在均按 404，避免探测其它 key 是否存在）
  async assertV2ChildOwnership(parentKeyId, childKeyId) {
    const child = await redis.getApiKey(childKeyId)
    if (
      !child ||
      Object.keys(child).length === 0 ||
      child.parentKeyId !== parentKeyId ||
      child.isDeleted === 'true' // 已软删除的子 key 不可再被 update/delete 操作（防止复活）
    ) {
      const err = new Error('API key not found')
      err.code = 'NOT_FOUND'
      throw err
    }
    return child
  }

  // 🔓 v2 自助显示子 key 明文（先归属校验；只返回该子 key 明文，无任何上游/父账号信息）
  async getV2ChildPlaintext(parentKeyId, childKeyId, actor = 'v2') {
    const child = await this.assertV2ChildOwnership(parentKeyId, childKeyId)
    if (!child.encryptedApiKey) {
      const err = new Error('API key plaintext is unavailable')
      err.code = 'PLAINTEXT_UNAVAILABLE'
      throw err
    }
    logger.security(
      `v2 child API key secret revealed by ${actor}: parent=${parentKeyId}, child=${childKeyId}`
    )
    return this._decryptStoredApiKeySecret(child.encryptedApiKey)
  }

  // 📝 v2 更新子 key（归属校验 + 硬白名单 + 数值/状态规范化全部收敛在 service 层，
  // 路由只做参数提取；防止非法值经 updateApiKey 通用 toString 分支存成 NaN 后被当作不限额）
  async updateV2Child(parentKeyId, childKeyId, updates = {}) {
    const child = await this.assertV2ChildOwnership(parentKeyId, childKeyId)

    const normalized = {}

    if (updates.name !== undefined) {
      if (typeof updates.name !== 'string' || !updates.name.trim()) {
        throw new Error('API key name is required')
      }
      normalized.name = updates.name.trim()
    }

    if (updates.description !== undefined) {
      normalized.description =
        updates.description === null ? '' : String(updates.description).trim()
    }

    for (const field of ['dailyCostLimit', 'totalCostLimit']) {
      if (updates[field] !== undefined) {
        const val = updates[field]
        if (val === null || val === '') {
          // 与 createV2Child 的 `|| 0` 口径一致：空值视为 0（不限额）
          normalized[field] = 0
        } else {
          const num = Number(val)
          if (!Number.isFinite(num) || num < 0) {
            throw new Error(`${field} must be a non-negative number`)
          }
          normalized[field] = num
        }
      }
    }

    if (updates.isActive !== undefined) {
      if (typeof updates.isActive === 'boolean') {
        normalized.isActive = updates.isActive
      } else if (updates.isActive === 'true' || updates.isActive === 'false') {
        normalized.isActive = updates.isActive === 'true'
      } else {
        throw new Error('isActive must be a boolean')
      }
    }

    // IP 白名单三字段：入参名 ipWhitelistOverride，仅此处转换为存储字段 v2IpWhitelistOverride。
    // 当前 override≠true 时把子 key 原始 enable/list 视为 false/[]——管理员后台编辑路径可能
    // 写过原始字段，不可信任；从「跟随默认」切出必须显式提交 enableIpWhitelist，
    // 防止 Redis 里沉睡的旧名单被一个裸 { ipWhitelistOverride: true } 静默激活
    const hasOverride = updates.ipWhitelistOverride !== undefined
    const hasEnable = updates.enableIpWhitelist !== undefined
    const hasList = updates.ipWhitelist !== undefined
    if (hasOverride || hasEnable || hasList) {
      let validatedEntries = null
      if (hasList) {
        if (!Array.isArray(updates.ipWhitelist)) {
          throw new Error('ipWhitelist must be an array')
        }
        const validation = validateIpWhitelist(updates.ipWhitelist)
        if (!validation.valid) {
          throw new Error(validation.error)
        }
        if (validation.entries.length > V2_MAX_IP_WHITELIST_ENTRIES) {
          throw new Error(`IP whitelist cannot exceed ${V2_MAX_IP_WHITELIST_ENTRIES} entries`)
        }
        validatedEntries = validation.entries
      }

      const currentOverride = isV2IpWhitelistOverrideEnabled(child)
      const nextOverride = hasOverride
        ? parseV2Boolean(updates.ipWhitelistOverride, 'ipWhitelistOverride')
        : currentOverride
      const nextEnable = hasEnable
        ? parseV2Boolean(updates.enableIpWhitelist, 'enableIpWhitelist')
        : currentOverride
          ? child.enableIpWhitelist === 'true' || child.enableIpWhitelist === true
          : false
      const nextEntries = hasList
        ? validatedEntries
        : currentOverride
          ? normalizeIpWhitelist(child.ipWhitelist)
          : []

      if (!nextOverride) {
        if ((hasEnable && nextEnable) || (hasList && nextEntries.length > 0)) {
          throw new Error('请先开启自定义白名单')
        }
        // 跟随账号默认：统一清空三件套，子 key 不留可被误激活的旧值
        normalized.v2IpWhitelistOverride = false
        normalized.enableIpWhitelist = false
        normalized.ipWhitelist = []
      } else {
        if (!currentOverride && !hasEnable) {
          throw new Error('请指定自定义白名单状态')
        }
        if (nextEnable && nextEntries.length === 0) {
          throw new Error('启用 IP 白名单时至少需要一个 IP 或 CIDR')
        }
        normalized.v2IpWhitelistOverride = true
        normalized.enableIpWhitelist = nextEnable
        // 覆盖为不启用时统一存空 list，避免后续再启用时误用旧列表
        normalized.ipWhitelist = nextEnable ? nextEntries : []
      }
    }

    if (Object.keys(normalized).length === 0) {
      return { success: true }
    }

    return await this.updateApiKey(childKeyId, normalized)
  }
}

// 导出实例和单独的方法
const apiKeyService = new ApiKeyService()

// 为了方便其他服务调用，导出 recordUsage 方法
apiKeyService.recordUsageMetrics = apiKeyService.recordUsage.bind(apiKeyService)

// 导出权限辅助函数供路由使用
apiKeyService.hasPermission = hasPermission
apiKeyService.normalizePermissions = normalizePermissions

module.exports = apiKeyService
