const redis = require('../models/redis')
const logger = require('../utils/logger')
const pricingService = require('./pricingService')
const serviceRatesService = require('./serviceRatesService')
const { isClaudeFamilyModel, isClaudeFableModel } = require('../utils/modelHelper')

function pad2(n) {
  return String(n).padStart(2, '0')
}

// 生成配置时区下的 YYYY-MM-DD 字符串。
// 注意：入参 date 必须是 redis.getDateInTimezone() 生成的"时区偏移后"的 Date。
function formatTzDateYmd(tzDate) {
  return `${tzDate.getUTCFullYear()}-${pad2(tzDate.getUTCMonth() + 1)}-${pad2(tzDate.getUTCDate())}`
}

function inferAccountType(keyData) {
  if (keyData?.ccrAccountId) {
    return 'ccr'
  }
  if (keyData?.claudeConsoleAccountId) {
    return 'claude-console'
  }
  if (keyData?.claudeAccountId) {
    return 'claude-official'
  }
  // bedrock/azure/gemini 等不计入周费用
  return null
}

function toInt(v) {
  const n = parseInt(v || '0', 10)
  return Number.isFinite(n) ? n : 0
}

function toFiniteNumber(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key)
}

class WeeklyClaudeCostInitService {
  // 获取最近 7 天的日期字符串数组（覆盖任意重置配置的完整周期）
  _getLast7DaysInTimezone() {
    const tzNow = redis.getDateInTimezone(new Date())
    const tzToday = new Date(tzNow)
    tzToday.setUTCHours(0, 0, 0, 0)

    const dates = []
    for (let i = 7; i >= 0; i--) {
      const d = new Date(tzToday)
      d.setUTCDate(tzToday.getUTCDate() - i)
      dates.push(formatTzDateYmd(d))
    }
    return dates
  }

  _buildWeeklyOpusKey(keyId, periodString) {
    return `usage:opus:weekly:${keyId}:${periodString}`
  }

  _buildWeeklyFableKey(keyId, periodString) {
    return `usage:fable:weekly:${keyId}:${periodString}`
  }

  _buildBucketId(bucket) {
    return `${bucket.type}:${bucket.bucketKey}`
  }

  _addBucketCost(map, keyId, bucketId, cost) {
    if (!map.has(keyId)) {
      map.set(keyId, new Map())
    }
    const bucketMap = map.get(keyId)
    const current = bucketMap.get(bucketId) || { ratedMicro: 0, realMicro: 0 }
    bucketMap.set(bucketId, {
      ratedMicro: current.ratedMicro + cost.ratedMicro,
      realMicro: current.realMicro + cost.realMicro
    })
  }

  _getBucketCost(map, keyId, bucket) {
    const bucketMap = map.get(keyId)
    if (!bucketMap) {
      return { ratedMicro: 0, realMicro: 0 }
    }
    return (
      bucketMap.get(this._buildBucketId(bucket)) || {
        ratedMicro: 0,
        realMicro: 0
      }
    )
  }

  _iterPeriodBuckets(periodStart, nowTz = redis.getDateInTimezone(new Date())) {
    const buckets = []
    const startDay = new Date(periodStart)
    startDay.setUTCHours(0, 0, 0, 0)

    const endDay = new Date(nowTz)
    endDay.setUTCHours(0, 0, 0, 0)

    const resetHour = periodStart.getUTCHours()
    const currentHour = nowTz.getUTCHours()

    for (const d = new Date(startDay); d <= endDay; d.setUTCDate(d.getUTCDate() + 1)) {
      const dateStr = formatTzDateYmd(d)
      const isStartDay = d.getTime() === startDay.getTime()
      const isCurrentDay = d.getTime() === endDay.getTime()

      if (isStartDay && resetHour > 0) {
        const endHour = isCurrentDay ? currentHour : 23
        for (let h = resetHour; h <= endHour; h++) {
          buckets.push({
            type: 'hourly',
            bucketKey: `${dateStr}:${pad2(h)}`,
            dateStr,
            hour: h
          })
        }
        continue
      }

      buckets.push({
        type: 'daily',
        bucketKey: dateStr,
        dateStr
      })
    }

    return buckets
  }

  _parseUsageModelKey(usageKey, bucketType) {
    if (bucketType === 'hourly') {
      const match = usageKey.match(/^usage:([^:]+):model:hourly:(.+):(\d{4}-\d{2}-\d{2}):(\d{2})$/)
      if (!match) {
        return null
      }
      return {
        keyId: match[1],
        model: match[2],
        bucket: {
          type: 'hourly',
          bucketKey: `${match[3]}:${match[4]}`,
          dateStr: match[3],
          hour: parseInt(match[4], 10)
        }
      }
    }

    const match = usageKey.match(/^usage:([^:]+):model:daily:(.+):(\d{4}-\d{2}-\d{2})$/)
    if (!match) {
      return null
    }
    return {
      keyId: match[1],
      model: match[2],
      bucket: {
        type: 'daily',
        bucketKey: match[3],
        dateStr: match[3]
      }
    }
  }

  _buildUsageFromStats(data) {
    const inputTokens = toInt(data.totalInputTokens || data.inputTokens)
    const outputTokens = toInt(data.totalOutputTokens || data.outputTokens)
    const cacheReadTokens = toInt(data.totalCacheReadTokens || data.cacheReadTokens)
    const cacheCreateTokens = toInt(data.totalCacheCreateTokens || data.cacheCreateTokens)
    const ephemeral5mTokens = toInt(data.ephemeral5mTokens)
    const ephemeral1hTokens = toInt(data.ephemeral1hTokens)

    const cacheCreationTotal =
      ephemeral5mTokens > 0 || ephemeral1hTokens > 0
        ? ephemeral5mTokens + ephemeral1hTokens
        : cacheCreateTokens

    const usage = {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: cacheCreationTotal,
      cache_read_input_tokens: cacheReadTokens
    }

    if (ephemeral5mTokens > 0 || ephemeral1hTokens > 0) {
      usage.cache_creation = {
        ephemeral_5m_input_tokens: ephemeral5mTokens,
        ephemeral_1h_input_tokens: ephemeral1hTokens
      }
    }

    return usage
  }

  async _calculateFallbackCosts(data, model, configKeyData, accountType, globalRateCache) {
    if (!pricingService || !pricingService.pricingData) {
      return { ratedMicro: 0, realMicro: 0 }
    }

    const usage = this._buildUsageFromStats(data)
    const costInfo = pricingService.calculateCost(usage, model)
    const realCost = costInfo && costInfo.totalCost ? costInfo.totalCost : 0
    if (realCost <= 0) {
      return { ratedMicro: 0, realMicro: 0 }
    }

    const service = serviceRatesService.getService(accountType || 'claude-official', model)

    let globalRate = globalRateCache.get(service)
    if (globalRate === undefined) {
      globalRate = await serviceRatesService.getServiceRate(service)
      globalRateCache.set(service, globalRate)
    }

    let keyRates = {}
    try {
      keyRates = JSON.parse(configKeyData?.serviceRates || '{}')
    } catch (e) {
      keyRates = {}
    }
    const keyRate = keyRates[service] ?? 1.0
    return {
      ratedMicro: Math.round(realCost * globalRate * keyRate * 1000000),
      realMicro: Math.round(realCost * 1000000)
    }
  }

  async _getCostsFromStats(data, model, configKeyData, accountType, globalRateCache, counters) {
    const hasRatedCost = hasOwn(data, 'ratedCostMicro')
    const hasRealCost = hasOwn(data, 'realCostMicro')

    if (hasRatedCost && hasRealCost) {
      counters.storedRatedCostHits++
      counters.storedRealCostHits++
      return {
        ratedMicro: Math.round(toFiniteNumber(data.ratedCostMicro)),
        realMicro: Math.round(toFiniteNumber(data.realCostMicro))
      }
    }

    const fallbackCosts = await this._calculateFallbackCosts(
      data,
      model,
      configKeyData,
      accountType,
      globalRateCache
    )

    if (hasRatedCost) {
      counters.storedRatedCostHits++
      counters.recomputedRealCostFallbacks++
      return {
        ratedMicro: Math.round(toFiniteNumber(data.ratedCostMicro)),
        realMicro: fallbackCosts.realMicro || Math.round(toFiniteNumber(data.ratedCostMicro))
      }
    }

    if (hasRealCost) {
      counters.storedRealCostFallbacks++
      return {
        ratedMicro: fallbackCosts.ratedMicro || Math.round(toFiniteNumber(data.realCostMicro)),
        realMicro: Math.round(toFiniteNumber(data.realCostMicro))
      }
    }

    counters.recomputedCostFallbacks++
    return fallbackCosts
  }

  async _collectBucketCosts({
    client,
    patterns,
    keyDataCache,
    globalRateCache,
    costByKeyBucket,
    fableCostByKeyBucket,
    counters
  }) {
    for (const { pattern, bucketType } of patterns) {
      let cursor = '0'

      do {
        const [nextCursor, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 1000)
        cursor = nextCursor
        counters.scannedKeys += keys.length

        const entries = []
        for (const usageKey of keys) {
          const parsed = this._parseUsageModelKey(usageKey, bucketType)
          if (!parsed || !isClaudeFamilyModel(parsed.model)) {
            continue
          }
          counters.matchedClaudeKeys++
          entries.push({ usageKey, ...parsed })
        }

        if (entries.length === 0) {
          continue
        }

        const pipeline = client.pipeline()
        for (const entry of entries) {
          pipeline.hgetall(entry.usageKey)
        }
        const results = await pipeline.exec()

        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i]
          const [, data] = results[i] || []
          if (!data || Object.keys(data).length === 0) {
            continue
          }

          const keyData = keyDataCache.get(entry.keyId)
          const configKeyData =
            keyData?.parentKeyId && keyDataCache.get(keyData.parentKeyId)
              ? keyDataCache.get(keyData.parentKeyId)
              : keyData
          const costs = await this._getCostsFromStats(
            data,
            entry.model,
            configKeyData,
            inferAccountType(configKeyData),
            globalRateCache,
            counters
          )
          if (costs.ratedMicro <= 0 && costs.realMicro <= 0) {
            continue
          }

          const bucketId = this._buildBucketId(entry.bucket)
          this._addBucketCost(costByKeyBucket, entry.keyId, bucketId, costs)

          if (isClaudeFableModel(entry.model)) {
            counters.matchedFableKeys++
            this._addBucketCost(fableCostByKeyBucket, entry.keyId, bucketId, costs)
          }
        }
      } while (cursor !== '0')
    }
  }

  /**
   * 启动回填：从"按日/按模型"统计中反算 Claude 模型费用，
   * 根据每个 API Key 的 weeklyResetDay/weeklyResetHour 计算周期，
   * 写入 `usage:opus:weekly:*`，保证周限额在重启后不归零。
   *
   * 说明：
   * - 回填最近 8 天数据（覆盖任意重置配置的完整 7 天周期）
   * - 会加分布式锁，避免多实例重复跑
   * - 每次启动都校验一次，确保 Redis 周计数可自动修复
   */
  async backfillCurrentWeekClaudeCosts() {
    const client = redis.getClientSafe()
    if (!client) {
      logger.warn('⚠️ Claude 周费用回填跳过：Redis client 不可用')
      return { success: false, reason: 'redis_unavailable' }
    }

    if (!pricingService || !pricingService.pricingData) {
      logger.warn('⚠️ Claude 周费用回填：pricing service 未初始化，旧格式 usage 将无法重算')
    }

    const todayStr = redis.getDateStringInTimezone()

    const lockKey = `lock:init:weekly_claude_cost:v2:${todayStr}`
    const lockValue = `${process.pid}:${Date.now()}`
    const lockTtlMs = 15 * 60 * 1000

    const lockAcquired = await redis.setAccountLock(lockKey, lockValue, lockTtlMs)
    if (!lockAcquired) {
      logger.info(`ℹ️ Claude 周费用回填已在运行（${todayStr}），跳过`)
      return { success: true, skipped: true, reason: 'locked' }
    }

    const startedAt = Date.now()
    try {
      logger.info(`💰 开始回填 Claude 周费用（${todayStr}）...`)

      const keyIds = await redis.scanApiKeyIds()
      const dates = this._getLast7DaysInTimezone()

      // 预加载所有 API Key 数据和全局倍率
      const keyDataCache = new Map()
      const globalRateCache = new Map()
      const batchSize = 500
      for (let i = 0; i < keyIds.length; i += batchSize) {
        const batch = keyIds.slice(i, i + batchSize)
        const pipeline = client.pipeline()
        for (const keyId of batch) {
          pipeline.hgetall(`apikey:${keyId}`)
        }
        const results = await pipeline.exec()
        for (let j = 0; j < batch.length; j++) {
          const [, data] = results[j] || []
          if (data && Object.keys(data).length > 0) {
            keyDataCache.set(batch[j], data)
          }
        }
      }
      logger.info(`💰 预加载 ${keyDataCache.size} 个 API Key 数据`)

      // 收集每个 key 每个 bucket 的费用。非 0 点 reset 的起始日只使用 hourly bucket，
      // 其他完整日期使用 daily bucket，避免把 reset 前的同日费用算入本周期。
      const costByKeyBucket = new Map()
      const fableCostByKeyBucket = new Map()
      const counters = {
        scannedKeys: 0,
        matchedClaudeKeys: 0,
        matchedFableKeys: 0,
        storedRatedCostHits: 0,
        storedRealCostHits: 0,
        storedRealCostFallbacks: 0,
        recomputedRealCostFallbacks: 0,
        recomputedCostFallbacks: 0
      }
      const patterns = []
      for (const dateStr of dates) {
        patterns.push({ bucketType: 'daily', pattern: `usage:*:model:daily:*:${dateStr}` })
        patterns.push({ bucketType: 'hourly', pattern: `usage:*:model:hourly:*:${dateStr}:*` })
      }

      await this._collectBucketCosts({
        client,
        patterns,
        keyDataCache,
        globalRateCache,
        costByKeyBucket,
        fableCostByKeyBucket,
        counters
      })

      if (counters.storedRealCostFallbacks > 0) {
        logger.warn(
          `⚠️ Claude 周费用回填：${counters.storedRealCostFallbacks} 个 usage hash 缺 ratedCostMicro，已用 realCostMicro 兜底`
        )
      }

      // 为每个 API Key 按其重置配置计算当前周期费用
      const ttlSeconds = 14 * 24 * 3600
      let filledCount = 0
      let fableFilledCount = 0
      for (let i = 0; i < keyIds.length; i += batchSize) {
        const batch = keyIds.slice(i, i + batchSize)
        const pipeline = client.pipeline()
        for (const keyId of batch) {
          const keyData = keyDataCache.get(keyId)
          const resetConfigSource =
            keyData?.parentKeyId && keyDataCache.get(keyData.parentKeyId)
              ? keyDataCache.get(keyData.parentKeyId)
              : keyData
          const resetDay = parseInt(resetConfigSource?.weeklyResetDay || 1)
          const resetHour = parseInt(resetConfigSource?.weeklyResetHour || 0)

          // 获取当前周期的起始日期
          const periodStart = redis.getPeriodStartDate(resetDay, resetHour)
          const periodString = redis.getPeriodString(resetDay, resetHour)

          // 汇总该 key 在当前周期内的费用
          const periodBuckets = this._iterPeriodBuckets(periodStart)
          let periodRatedMicro = 0
          let periodRealMicro = 0
          let periodFableRatedMicro = 0
          let periodFableRealMicro = 0
          for (const bucket of periodBuckets) {
            const costs = this._getBucketCost(costByKeyBucket, keyId, bucket)
            const fableCosts = this._getBucketCost(fableCostByKeyBucket, keyId, bucket)
            periodRatedMicro += costs.ratedMicro
            periodRealMicro += costs.realMicro
            periodFableRatedMicro += fableCosts.ratedMicro
            periodFableRealMicro += fableCosts.realMicro
          }

          if (periodRatedMicro > 0 || periodRealMicro > 0) {
            filledCount++
          }
          if (periodFableRatedMicro > 0 || periodFableRealMicro > 0) {
            fableFilledCount++
          }

          const weeklyKey = this._buildWeeklyOpusKey(keyId, periodString)
          const realWeeklyKey = `usage:opus:real:weekly:${keyId}:${periodString}`
          const weeklyFableKey = this._buildWeeklyFableKey(keyId, periodString)
          const realWeeklyFableKey = `usage:fable:real:weekly:${keyId}:${periodString}`
          pipeline.set(weeklyKey, String(periodRatedMicro / 1000000))
          pipeline.expire(weeklyKey, ttlSeconds)
          pipeline.set(realWeeklyKey, String(periodRealMicro / 1000000))
          pipeline.expire(realWeeklyKey, ttlSeconds)
          pipeline.set(weeklyFableKey, String(periodFableRatedMicro / 1000000))
          pipeline.expire(weeklyFableKey, ttlSeconds)
          pipeline.set(realWeeklyFableKey, String(periodFableRealMicro / 1000000))
          pipeline.expire(realWeeklyFableKey, ttlSeconds)
        }
        await pipeline.exec()
      }

      const durationMs = Date.now() - startedAt
      logger.info(
        `✅ Claude 周费用回填完成（${todayStr}）：keys=${keyIds.length}, scanned=${counters.scannedKeys}, matchedClaude=${counters.matchedClaudeKeys}, matchedFable=${counters.matchedFableKeys}, storedRated=${counters.storedRatedCostHits}, storedReal=${counters.storedRealCostHits}, ratedFallback=${counters.storedRealCostFallbacks}, realFallback=${counters.recomputedRealCostFallbacks}, recomputed=${counters.recomputedCostFallbacks}, filled=${filledCount}, fableFilled=${fableFilledCount}（${durationMs}ms）`
      )

      return {
        success: true,
        todayStr,
        keyCount: keyIds.length,
        scannedKeys: counters.scannedKeys,
        matchedClaudeKeys: counters.matchedClaudeKeys,
        matchedFableKeys: counters.matchedFableKeys,
        storedRatedCostHits: counters.storedRatedCostHits,
        storedRealCostHits: counters.storedRealCostHits,
        storedRealCostFallbacks: counters.storedRealCostFallbacks,
        recomputedRealCostFallbacks: counters.recomputedRealCostFallbacks,
        recomputedCostFallbacks: counters.recomputedCostFallbacks,
        filledKeys: filledCount,
        fableFilledKeys: fableFilledCount,
        durationMs
      }
    } catch (error) {
      logger.error(`❌ Claude 周费用回填失败（${todayStr}）：`, error)
      return { success: false, error: error.message }
    } finally {
      await redis.releaseAccountLock(lockKey, lockValue)
    }
  }

  /**
   * 为单个 API Key 回填当前周期费用（重置配置变更后触发）
   */
  async backfillSingleKey(keyId) {
    const client = redis.getClientSafe()
    if (!client) {
      logger.warn(`⚠️ 单 Key 回填跳过 (${keyId})：Redis client 不可用`)
      return { success: false, reason: 'redis_unavailable' }
    }

    if (!pricingService || !pricingService.pricingData) {
      try {
        await pricingService.initialize()
      } catch (e) {
        logger.warn(`⚠️ 单 Key 回填跳过 (${keyId})：pricing service 未初始化`)
        return { success: false, reason: 'pricing_uninitialized' }
      }
    }

    try {
      const keyData = await redis.getApiKey(keyId)
      if (!keyData || Object.keys(keyData).length === 0) {
        return { success: false, reason: 'key_not_found' }
      }

      let configKeyData = keyData
      if (keyData.parentKeyId) {
        const parentData = await redis.getApiKey(keyData.parentKeyId)
        if (parentData && Object.keys(parentData).length > 0) {
          configKeyData = parentData
        }
      }

      const resetDay = parseInt(configKeyData.weeklyResetDay || 1)
      const resetHour = parseInt(configKeyData.weeklyResetHour || 0)

      const periodStart = redis.getPeriodStartDate(resetDay, resetHour)
      const periodString = redis.getPeriodString(resetDay, resetHour)

      const periodBuckets = this._iterPeriodBuckets(periodStart)
      const patterns = periodBuckets.map((bucket) => ({
        bucketType: bucket.type,
        pattern: `usage:${keyId}:model:${bucket.type}:*:${bucket.bucketKey}`
      }))
      const keyDataCache = new Map([[keyId, keyData]])
      if (configKeyData !== keyData && keyData.parentKeyId) {
        keyDataCache.set(keyData.parentKeyId, configKeyData)
      }
      const globalRateCache = new Map()
      const costByKeyBucket = new Map()
      const fableCostByKeyBucket = new Map()
      const counters = {
        scannedKeys: 0,
        matchedClaudeKeys: 0,
        matchedFableKeys: 0,
        storedRatedCostHits: 0,
        storedRealCostHits: 0,
        storedRealCostFallbacks: 0,
        recomputedRealCostFallbacks: 0,
        recomputedCostFallbacks: 0
      }
      let ratedMicro = 0
      let realMicro = 0
      let fableRatedMicro = 0
      let fableRealMicro = 0

      await this._collectBucketCosts({
        client,
        patterns,
        keyDataCache,
        globalRateCache,
        costByKeyBucket,
        fableCostByKeyBucket,
        counters
      })

      for (const bucket of periodBuckets) {
        const costs = this._getBucketCost(costByKeyBucket, keyId, bucket)
        const fableCosts = this._getBucketCost(fableCostByKeyBucket, keyId, bucket)
        ratedMicro += costs.ratedMicro
        realMicro += costs.realMicro
        fableRatedMicro += fableCosts.ratedMicro
        fableRealMicro += fableCosts.realMicro
      }

      if (counters.storedRealCostFallbacks > 0) {
        logger.warn(
          `⚠️ 单 Key 回填 (${keyId})：${counters.storedRealCostFallbacks} 个 usage hash 缺 ratedCostMicro，已用 realCostMicro 兜底`
        )
      }

      const totalCost = ratedMicro / 1000000
      const realCost = realMicro / 1000000
      const fableCost = fableRatedMicro / 1000000
      const realFableCost = fableRealMicro / 1000000
      await redis.setWeeklyClaudeCostSnapshot(keyId, {
        periodString,
        ratedCost: totalCost,
        realCost,
        fableRatedCost: fableCost,
        fableRealCost: realFableCost
      })
      logger.info(
        `💰 单 Key 回填完成 (${keyId})：period=${periodString}, rated=$${totalCost.toFixed(6)}, real=$${realCost.toFixed(6)}, fableRated=$${fableCost.toFixed(6)}, fableReal=$${realFableCost.toFixed(6)}`
      )

      return {
        success: true,
        cost: totalCost,
        realCost,
        fableCost,
        realFableCost,
        periodString
      }
    } catch (error) {
      logger.error(`❌ 单 Key 回填失败 (${keyId})：`, error)
      return { success: false, error: error.message }
    }
  }

  async backfillKeyFamily(keyId) {
    const keyData = await redis.getApiKey(keyId)
    if (!keyData || Object.keys(keyData).length === 0) {
      return { success: false, reason: 'key_not_found' }
    }

    const targetIds =
      keyData.isV2Parent === 'true' || keyData.isV2Parent === true
        ? [keyId, ...(await redis.getV2ChildIds(keyId))]
        : [keyId]
    const results = []
    for (const targetId of targetIds) {
      results.push(await this.backfillSingleKey(targetId))
    }

    return {
      success: results.every((result) => result.success),
      targetIds,
      results
    }
  }
}

module.exports = new WeeklyClaudeCostInitService()
