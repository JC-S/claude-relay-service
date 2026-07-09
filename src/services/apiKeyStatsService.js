const redis = require('../models/redis')
const logger = require('../utils/logger')
const CostCalculator = require('../utils/costCalculator')

const VALID_STATS_TIME_RANGES = new Set(['today', '7days', '30days', 'all', 'custom'])

class ApiKeyStatsValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ApiKeyStatsValidationError'
    this.code = 'API_KEY_STATS_VALIDATION_ERROR'
  }
}

function formatApiKeyListCost(cost) {
  const numericCost = Number(cost)
  if (!Number.isFinite(numericCost) || numericCost === 0) {
    return '$0.00'
  }
  return CostCalculator.formatCost(numericCost)
}

function validateStatsTimeRange({ timeRange = 'all', startDate, endDate } = {}) {
  if (!VALID_STATS_TIME_RANGES.has(timeRange)) {
    throw new ApiKeyStatsValidationError(
      'Invalid timeRange. Valid values are: today, 7days, 30days, all, custom'
    )
  }

  if (timeRange !== 'custom') {
    return
  }

  if (!startDate || !endDate) {
    throw new ApiKeyStatsValidationError('startDate and endDate are required for custom time range')
  }

  const start = new Date(startDate)
  const end = new Date(endDate)
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    throw new ApiKeyStatsValidationError('Invalid date format')
  }
  if (start > end) {
    throw new ApiKeyStatsValidationError('startDate must be before or equal to endDate')
  }

  const daysDiff = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1
  if (daysDiff > 365) {
    throw new ApiKeyStatsValidationError('Date range cannot exceed 365 days')
  }
}

/**
 * 计算单个 Key 的统计数据
 * @param {string} keyId - API Key ID
 * @param {string} timeRange - 时间范围
 * @param {string} startDate - 开始日期 (custom 模式)
 * @param {string} endDate - 结束日期 (custom 模式)
 * @returns {Object} 统计数据
 */
async function calculateKeyStats(keyId, timeRange = 'all', startDate, endDate) {
  const client = redis.getClientSafe()
  const tzDate = redis.getDateInTimezone()
  const today = redis.getDateStringInTimezone()

  // v2 父账号必须先展开 source key id，否则只会扫父账号自身 usage，漏掉子 key。
  let apiKey = null
  let inheritedWeeklyLimitConfig = null
  let isV2Parent = false
  let sourceKeyIds = [keyId]
  try {
    apiKey = await redis.getApiKey(keyId)
    isV2Parent = apiKey?.isV2Parent === 'true'
    if (isV2Parent) {
      sourceKeyIds = await redis.getV2ParentSourceKeyIds(keyId)
    } else if (apiKey?.parentKeyId) {
      const parentData = await redis.getApiKey(apiKey.parentKeyId)
      if (
        parentData &&
        Object.keys(parentData).length > 0 &&
        parentData.isV2Parent === 'true' &&
        parentData.isActive === 'true' &&
        parentData.isDeleted !== 'true'
      ) {
        inheritedWeeklyLimitConfig = parentData
      }
    }
  } catch (error) {
    logger.warn(`⚠️ 判定 v2 父账号失败 (key: ${keyId}):`, error.message)
  }

  // 构建搜索模式（v2 父账号展开为父 + 所有子，普通 key 即 [keyId]）
  const searchPatterns = []
  for (const sid of sourceKeyIds) {
    if (timeRange === 'custom' && startDate && endDate) {
      // 自定义日期范围
      const start = new Date(startDate)
      const end = new Date(endDate)
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = redis.getDateStringInTimezone(d)
        searchPatterns.push(`usage:${sid}:model:daily:*:${dateStr}`)
      }
    } else if (timeRange === 'today') {
      searchPatterns.push(`usage:${sid}:model:daily:*:${today}`)
    } else if (timeRange === '7days') {
      // 最近7天
      for (let i = 0; i < 7; i++) {
        const d = new Date(tzDate)
        d.setDate(d.getDate() - i)
        const dateStr = redis.getDateStringInTimezone(d)
        searchPatterns.push(`usage:${sid}:model:daily:*:${dateStr}`)
      }
    } else if (timeRange === '30days') {
      // 最近30天
      for (let i = 0; i < 30; i++) {
        const d = new Date(tzDate)
        d.setDate(d.getDate() - i)
        const dateStr = redis.getDateStringInTimezone(d)
        searchPatterns.push(`usage:${sid}:model:daily:*:${dateStr}`)
      }
    } else if (timeRange === 'monthly') {
      // 当月；保留内部兼容分支，但对外 validateStatsTimeRange 不再接受 monthly。
      const currentMonth = `${tzDate.getUTCFullYear()}-${String(tzDate.getUTCMonth() + 1).padStart(2, '0')}`
      searchPatterns.push(`usage:${sid}:model:monthly:*:${currentMonth}`)
    } else {
      // all - 使用 alltime key（无 TTL，数据完整），避免 daily/monthly 键过期导致数据丢失
      searchPatterns.push(`usage:${sid}:model:alltime:*`)
    }
  }

  // 使用 SCAN 收集所有匹配的 keys
  const allKeys = []
  for (const pattern of searchPatterns) {
    let cursor = '0'
    do {
      const [newCursor, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
      cursor = newCursor
      allKeys.push(...keys)
    } while (cursor !== '0')
  }

  // 去重
  const uniqueKeys = [...new Set(allKeys)]

  // 获取实时限制数据（窗口数据不受时间范围筛选影响，始终获取当前窗口状态）
  let dailyCost = 0
  let weeklyOpusCost = 0 // 字段名沿用 weeklyOpusCost*，语义为"Claude 周费用"
  let weeklyFableCost = 0
  let currentWindowCost = 0
  let currentWindowRequests = 0 // 当前窗口请求次数
  let currentWindowTokens = 0 // 当前窗口 Token 使用量
  let windowRemainingSeconds = null
  let windowStartTime = null
  let windowEndTime = null
  let allTimeCost = 0
  let v2ParentLedger = null

  try {
    // apiKey 已在函数开头读取（用于 v2 判定与 source id 收集），此处复用，避免二次读取
    const rateLimitWindow = parseInt(apiKey?.rateLimitWindow) || 0
    const dailyCostLimit = parseFloat(apiKey?.dailyCostLimit) || 0
    const weeklyLimitConfig = inheritedWeeklyLimitConfig || apiKey
    const weeklyOpusCostLimit = parseFloat(weeklyLimitConfig?.weeklyOpusCostLimit) || 0
    const weeklyFableCostLimit = parseFloat(weeklyLimitConfig?.weeklyFableCostLimit) || 0

    // 只在启用了每日费用限制时查询
    if (dailyCostLimit > 0) {
      dailyCost = await redis.getDailyCost(keyId)
    }

    // 始终查询 allTimeCost（用于展示和限额校验）
    const totalCostKey = `usage:cost:total:${keyId}`
    allTimeCost = parseFloat((await client.get(totalCostKey)) || '0')

    // v2 父账号：成本口径改用 v2 总账（父 key 自身 usage:cost:* 恒为 0）
    if (isV2Parent) {
      v2ParentLedger = await redis.getV2ParentLedgerCostStats(keyId, {
        timeRange,
        startDate,
        endDate
      })
      allTimeCost = v2ParentLedger.total // 总费用限制进度条恒为 ledger 总账
      dailyCost = v2ParentLedger.daily // 日费用进度条（v2 下无条件覆盖为总账今日聚合）
    }

    // 只在启用了 Claude 周费用限制时查询（字段名沿用 weeklyOpusCostLimit）
    if (weeklyOpusCostLimit > 0) {
      const resetDay = parseInt(weeklyLimitConfig?.weeklyResetDay || 1)
      const resetHour = parseInt(weeklyLimitConfig?.weeklyResetHour || 0)
      // v2 父账号周费用读侧聚合父 + 所有子；普通 key 维持原口径
      weeklyOpusCost = isV2Parent
        ? await redis.getV2ParentWeeklyOpusCost(keyId, resetDay, resetHour)
        : await redis.getWeeklyOpusCost(keyId, resetDay, resetHour)
    }

    if (weeklyFableCostLimit > 0) {
      const resetDay = parseInt(weeklyLimitConfig?.weeklyResetDay || 1)
      const resetHour = parseInt(weeklyLimitConfig?.weeklyResetHour || 0)
      weeklyFableCost = isV2Parent
        ? await redis.getV2ParentWeeklyFableCost(keyId, resetDay, resetHour)
        : await redis.getWeeklyFableCost(keyId, resetDay, resetHour)
    }

    // 只在启用了窗口限制时查询窗口数据
    if (rateLimitWindow > 0) {
      const requestCountKey = `rate_limit:requests:${keyId}`
      const tokenCountKey = `rate_limit:tokens:${keyId}`
      const costCountKey = `rate_limit:cost:${keyId}`
      const windowStartKey = `rate_limit:window_start:${keyId}`

      currentWindowRequests = parseInt((await client.get(requestCountKey)) || '0')
      currentWindowTokens = parseInt((await client.get(tokenCountKey)) || '0')
      currentWindowCost = parseFloat((await client.get(costCountKey)) || '0')

      // 获取窗口开始时间和计算剩余时间
      const windowStart = await client.get(windowStartKey)
      if (windowStart) {
        const now = Date.now()
        windowStartTime = parseInt(windowStart)
        const windowDuration = rateLimitWindow * 60 * 1000 // 转换为毫秒
        windowEndTime = windowStartTime + windowDuration

        // 如果窗口还有效
        if (now < windowEndTime) {
          windowRemainingSeconds = Math.max(0, Math.floor((windowEndTime - now) / 1000))
        } else {
          // 窗口已过期
          windowRemainingSeconds = 0
          currentWindowRequests = 0
          currentWindowTokens = 0
          currentWindowCost = 0
        }
      }
    }
  } catch (error) {
    logger.warn(`⚠️ 获取实时限制数据失败 (key: ${keyId}):`, error.message)
  }

  // 构建实时限制数据对象（各分支复用）
  const limitData = {
    dailyCost,
    weeklyOpusCost,
    weeklyFableCost,
    currentWindowCost,
    currentWindowRequests,
    currentWindowTokens,
    windowRemainingSeconds,
    windowStartTime,
    windowEndTime,
    allTimeCost
  }

  // 如果没有使用数据，返回零值但包含窗口数据
  if (uniqueKeys.length === 0) {
    // v2 父账号即使自身无 usage，费用仍来自 ledger 总账
    if (isV2Parent && v2ParentLedger) {
      return {
        requests: 0,
        tokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
        cost: v2ParentLedger.period,
        realCost: v2ParentLedger.period, // 无 v2 real-cost ledger，镜像 rated
        formattedCost: formatApiKeyListCost(v2ParentLedger.period),
        ...limitData
      }
    }
    return {
      requests: 0,
      tokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
      cost: 0,
      realCost: 0,
      formattedCost: '$0.00',
      ...limitData
    }
  }

  // 使用 Pipeline 批量获取数据
  const pipeline = client.pipeline()
  for (const key of uniqueKeys) {
    pipeline.hgetall(key)
  }
  const results = await pipeline.exec()

  // 汇总计算
  const modelStatsMap = new Map()
  let totalRequests = 0

  // alltime key 的模式：usage:{keyId}:model:alltime:{model}
  const alltimeKeyPattern = /usage:.+:model:alltime:(.+)$/
  // 用于去重：先统计月数据，避免与日数据重复
  const dailyKeyPattern = /usage:.+:model:daily:(.+):\d{4}-\d{2}-\d{2}$/
  const monthlyKeyPattern = /usage:.+:model:monthly:(.+):\d{4}-\d{2}$/
  const currentMonth = `${tzDate.getUTCFullYear()}-${String(tzDate.getUTCMonth() + 1).padStart(2, '0')}`
  const isAlltimeQuery = timeRange === 'all'
  const usesDailyOnly =
    timeRange === 'today' ||
    timeRange === '7days' ||
    timeRange === '30days' ||
    (timeRange === 'custom' && startDate && endDate)

  for (let i = 0; i < results.length; i++) {
    const [err, data] = results[i]
    if (err || !data || Object.keys(data).length === 0) {
      continue
    }

    const key = uniqueKeys[i]
    let model = null
    let isMonthly = false

    // 提取模型名称
    if (isAlltimeQuery) {
      const alltimeMatch = key.match(alltimeKeyPattern)
      if (alltimeMatch) {
        model = alltimeMatch[1]
      }
    } else {
      const dailyMatch = key.match(dailyKeyPattern)
      const monthlyMatch = key.match(monthlyKeyPattern)

      if (dailyMatch) {
        model = dailyMatch[1]
      } else if (monthlyMatch) {
        model = monthlyMatch[1]
        isMonthly = true
      }
    }

    if (!model) {
      continue
    }

    // 日/月去重只对 daily+monthly 混合查询有意义；daily-only 区间必须保留跨月 daily 键。
    if (!isAlltimeQuery && !usesDailyOnly) {
      // 跳过当前月的月数据（当前月用日数据更精确）
      if (isMonthly && key.includes(`:${currentMonth}`)) {
        continue
      }
      // 跳过非当前月的日数据（非当前月用月数据）
      if (!isMonthly && !key.includes(`:${currentMonth}-`)) {
        continue
      }
    }

    if (!modelStatsMap.has(model)) {
      modelStatsMap.set(model, {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
        ephemeral5mTokens: 0,
        ephemeral1hTokens: 0,
        requests: 0,
        realCostMicro: 0,
        ratedCostMicro: 0,
        hasStoredCost: false
      })
    }

    const stats = modelStatsMap.get(model)
    stats.inputTokens += parseInt(data.totalInputTokens) || parseInt(data.inputTokens) || 0
    stats.outputTokens += parseInt(data.totalOutputTokens) || parseInt(data.outputTokens) || 0
    stats.cacheCreateTokens +=
      parseInt(data.totalCacheCreateTokens) || parseInt(data.cacheCreateTokens) || 0
    stats.cacheReadTokens +=
      parseInt(data.totalCacheReadTokens) || parseInt(data.cacheReadTokens) || 0
    stats.ephemeral5mTokens +=
      parseInt(data.totalEphemeral5mTokens) || parseInt(data.ephemeral5mTokens) || 0
    stats.ephemeral1hTokens +=
      parseInt(data.totalEphemeral1hTokens) || parseInt(data.ephemeral1hTokens) || 0
    stats.requests += parseInt(data.totalRequests) || parseInt(data.requests) || 0

    // 累加已存储的费用（微美元）
    if ('realCostMicro' in data || 'ratedCostMicro' in data) {
      stats.realCostMicro += parseInt(data.realCostMicro) || 0
      stats.ratedCostMicro += parseInt(data.ratedCostMicro) || 0
      stats.hasStoredCost = true
    }

    totalRequests += parseInt(data.totalRequests) || parseInt(data.requests) || 0
  }

  // 汇总费用：优先使用已存储的费用，仅对无存储费用的旧数据 fallback 到 token 重算
  let totalRatedCost = 0
  let totalRealCost = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheCreateTokens = 0
  let cacheReadTokens = 0

  for (const [model, stats] of modelStatsMap) {
    inputTokens += stats.inputTokens
    outputTokens += stats.outputTokens
    cacheCreateTokens += stats.cacheCreateTokens
    cacheReadTokens += stats.cacheReadTokens

    if (stats.hasStoredCost) {
      // 使用请求时已计算并存储的费用（精确，包含 1M 上下文、特殊计费等）
      totalRatedCost += stats.ratedCostMicro / 1000000
      totalRealCost += stats.realCostMicro / 1000000
    } else {
      // Legacy fallback：旧数据没有存储费用，从 token 重算（不精确但聊胜于无）
      const costUsage = {
        input_tokens: stats.inputTokens,
        output_tokens: stats.outputTokens,
        cache_creation_input_tokens: stats.cacheCreateTokens,
        cache_read_input_tokens: stats.cacheReadTokens
      }

      if (stats.ephemeral5mTokens > 0 || stats.ephemeral1hTokens > 0) {
        costUsage.cache_creation = {
          ephemeral_5m_input_tokens: stats.ephemeral5mTokens,
          ephemeral_1h_input_tokens: stats.ephemeral1hTokens
        }
      }

      const costResult = CostCalculator.calculateCost(costUsage, model)
      totalRatedCost += costResult.costs.total
      totalRealCost += costResult.costs.total
    }
  }

  const tokens = inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens

  // v2 父账号：保留已聚合的请求数/Token，仅成本字段改用 v2 总账口径
  // （升级而来的父 key 可能保留升级前自身 usage，不应被抹掉）
  const effectiveRatedCost = isV2Parent && v2ParentLedger ? v2ParentLedger.period : totalRatedCost
  const effectiveRealCost = isV2Parent && v2ParentLedger ? v2ParentLedger.period : totalRealCost

  return {
    requests: totalRequests,
    tokens,
    inputTokens,
    outputTokens,
    cacheCreateTokens,
    cacheReadTokens,
    cost: effectiveRatedCost,
    realCost: effectiveRealCost, // 无 v2 real-cost ledger，镜像 rated
    formattedCost: formatApiKeyListCost(effectiveRatedCost),
    ...limitData
  }
}

module.exports = {
  ApiKeyStatsValidationError,
  VALID_STATS_TIME_RANGES,
  calculateKeyStats,
  formatApiKeyListCost,
  validateStatsTimeRange
}
