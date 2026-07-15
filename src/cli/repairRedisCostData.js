#!/usr/bin/env node

const redis = require('../models/redis')
const logger = require('../utils/logger')
const CostCalculator = require('../utils/costCalculator')
const serviceRatesService = require('../services/serviceRatesService')
const pricingService = require('../services/pricingService')

const APPLY_MODE = process.argv.includes('--apply')

function toInt(value) {
  const num = parseInt(value, 10)
  return Number.isFinite(num) ? num : 0
}

function toFixedAmount(microAmount) {
  return (microAmount / 1000000).toFixed(6)
}

function buildUsageKeyMatch(key) {
  const match = key.match(
    /^usage:([^:]+):model:(daily|monthly|hourly):(.+):(\d{4}-\d{2}(?:-\d{2})?(?::\d{2})?)$/
  )

  if (!match) {
    return null
  }

  const [, keyId, period, model, timeBucket] = match
  if (keyId === 'model') {
    return null
  }

  return { keyId, period, model, timeBucket }
}

function buildAlltimeKeyMatch(key) {
  const match = key.match(/^usage:([^:]+):model:alltime:(.+)$/)
  if (!match) {
    return null
  }

  const [, keyId, model] = match
  if (keyId === 'model') {
    return null
  }

  return { keyId, period: 'alltime', model, timeBucket: 'alltime' }
}

async function scanKeys(client, pattern) {
  const keys = []
  let cursor = '0'

  do {
    const [nextCursor, batch] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 500)
    cursor = nextCursor
    keys.push(...batch)
  } while (cursor !== '0')

  return keys
}

async function loadHashBatch(client, keys) {
  const pipeline = client.pipeline()
  for (const key of keys) {
    pipeline.hgetall(key)
  }

  const results = await pipeline.exec()
  return keys.map((key, index) => ({
    key,
    data: results[index]?.[1] || {}
  }))
}

function getExistingMultiplier(data) {
  const realCostMicro = toInt(data.realCostMicro)
  const ratedCostMicro = toInt(data.ratedCostMicro)

  if (realCostMicro > 0 && ratedCostMicro >= 0) {
    return ratedCostMicro / realCostMicro
  }

  return null
}

function inferAccountTypeFromKey(keyData = {}) {
  const hints = [
    ['openaiResponsesAccountId', 'openai-responses'],
    ['openaiAccountId', 'openai'],
    ['azureOpenaiAccountId', 'azure-openai'],
    ['claudeConsoleAccountId', 'claude-console'],
    ['claudeAccountId', 'claude'],
    ['geminiAccountId', 'gemini'],
    ['bedrockAccountId', 'bedrock'],
    ['droidAccountId', 'droid'],
    ['grokAccountId', 'grok']
  ]

  const matchedTypes = hints
    .filter(([field]) => keyData[field] && String(keyData[field]).trim())
    .map(([, accountType]) => accountType)

  if (matchedTypes.length === 1) {
    return matchedTypes[0]
  }

  return null
}

async function inferMultiplierFromKey(keyData, model, multiplierCache) {
  const cacheKey = `${keyData?.id || 'unknown'}:${model}`
  if (multiplierCache.has(cacheKey)) {
    return multiplierCache.get(cacheKey)
  }

  const accountType = inferAccountTypeFromKey(keyData)
  const service = serviceRatesService.getService(accountType, model)

  let keyRates = {}
  try {
    keyRates = JSON.parse(keyData?.serviceRates || '{}')
  } catch (error) {
    keyRates = {}
  }

  const globalRate = await serviceRatesService.getServiceRate(service)
  const keyRate = keyRates[service] ?? 1.0
  const multiplier = globalRate * keyRate
  multiplierCache.set(cacheKey, multiplier)
  return multiplier
}

function accumulateCost(map, key, realCostMicro, ratedCostMicro) {
  const current = map.get(key) || { realCostMicro: 0, ratedCostMicro: 0 }
  current.realCostMicro += realCostMicro
  current.ratedCostMicro += ratedCostMicro
  map.set(key, current)
}

async function main() {
  try {
    await redis.connect()
    await pricingService.loadPricingData()

    const client = redis.getClientSafe()

    const [periodKeys, alltimeKeys] = await Promise.all([
      Promise.all([
        scanKeys(client, 'usage:*:model:daily:*'),
        scanKeys(client, 'usage:*:model:monthly:*'),
        scanKeys(client, 'usage:*:model:hourly:*')
      ]).then((groups) => groups.flat()),
      scanKeys(client, 'usage:*:model:alltime:*')
    ])

    const matchedPeriodKeys = periodKeys
      .map((key) => ({ key, meta: buildUsageKeyMatch(key) }))
      .filter((entry) => entry.meta)
    const matchedAlltimeKeys = alltimeKeys
      .map((key) => ({ key, meta: buildAlltimeKeyMatch(key) }))
      .filter((entry) => entry.meta)

    const allEntries = [...matchedPeriodKeys, ...matchedAlltimeKeys]
    const keyIds = [...new Set(allEntries.map((entry) => entry.meta.keyId))]

    const keyDataPipeline = client.pipeline()
    for (const keyId of keyIds) {
      keyDataPipeline.hgetall(`apikey:${keyId}`)
    }
    const keyDataResults = await keyDataPipeline.exec()
    const keyDataMap = new Map(
      keyIds.map((keyId, index) => [keyId, { id: keyId, ...(keyDataResults[index]?.[1] || {}) }])
    )

    const globalModelCosts = new Map()
    const dailyCosts = new Map()
    const monthlyCosts = new Map()
    const hourlyCosts = new Map()
    const totalCosts = new Map()
    const multiplierCache = new Map()

    let updatedKeyModelCostCount = 0
    let mismatchedStoredCostCount = 0
    const sampleMismatches = []

    const entriesByKey = new Map(allEntries.map((entry) => [entry.key, entry.meta]))
    const allKeys = allEntries.map((entry) => entry.key)
    const writePipeline = client.pipeline()

    for (let i = 0; i < allKeys.length; i += 100) {
      const batchKeys = allKeys.slice(i, i + 100)
      const batchHashes = await loadHashBatch(client, batchKeys)

      for (const { key, data } of batchHashes) {
        const meta = entriesByKey.get(key)
        if (!meta || !data || Object.keys(data).length === 0) {
          continue
        }

        const existingRealCostMicro = toInt(data.realCostMicro)
        const existingRatedCostMicro = toInt(data.ratedCostMicro)

        const calculated = redis.calculateModelCostFromStats(CostCalculator, data, meta.model)
        const correctedRealCostMicro = Math.round((calculated?.costs?.total || 0) * 1000000)

        let multiplier = getExistingMultiplier(data)
        if (!(multiplier > 0)) {
          multiplier = await inferMultiplierFromKey(
            keyDataMap.get(meta.keyId),
            meta.model,
            multiplierCache
          )
        }

        const correctedRatedCostMicro = Math.round(correctedRealCostMicro * multiplier)

        if (
          correctedRealCostMicro !== existingRealCostMicro ||
          correctedRatedCostMicro !== existingRatedCostMicro
        ) {
          updatedKeyModelCostCount++
          mismatchedStoredCostCount++

          if (sampleMismatches.length < 10) {
            sampleMismatches.push({
              key,
              oldRealCostMicro: existingRealCostMicro,
              newRealCostMicro: correctedRealCostMicro,
              oldRatedCostMicro: existingRatedCostMicro,
              newRatedCostMicro: correctedRatedCostMicro
            })
          }
        }

        if (APPLY_MODE) {
          writePipeline.hset(key, 'realCostMicro', correctedRealCostMicro)
          writePipeline.hset(key, 'ratedCostMicro', correctedRatedCostMicro)
        }

        if (meta.period === 'daily' || meta.period === 'monthly' || meta.period === 'hourly') {
          const globalKey = `usage:model:${meta.period}:${meta.model}:${meta.timeBucket}`
          accumulateCost(
            globalModelCosts,
            globalKey,
            correctedRealCostMicro,
            correctedRatedCostMicro
          )
        }

        if (meta.period === 'daily') {
          accumulateCost(
            dailyCosts,
            `usage:cost:daily:${meta.keyId}:${meta.timeBucket}`,
            correctedRealCostMicro,
            correctedRatedCostMicro
          )
          accumulateCost(
            dailyCosts,
            `usage:cost:real:daily:${meta.keyId}:${meta.timeBucket}`,
            correctedRealCostMicro,
            correctedRealCostMicro
          )
        } else if (meta.period === 'monthly') {
          accumulateCost(
            monthlyCosts,
            `usage:cost:monthly:${meta.keyId}:${meta.timeBucket}`,
            correctedRealCostMicro,
            correctedRatedCostMicro
          )
        } else if (meta.period === 'hourly') {
          accumulateCost(
            hourlyCosts,
            `usage:cost:hourly:${meta.keyId}:${meta.timeBucket}`,
            correctedRealCostMicro,
            correctedRatedCostMicro
          )
        } else if (meta.period === 'alltime') {
          accumulateCost(
            totalCosts,
            `usage:cost:total:${meta.keyId}`,
            correctedRealCostMicro,
            correctedRatedCostMicro
          )
          accumulateCost(
            totalCosts,
            `usage:cost:real:total:${meta.keyId}`,
            correctedRealCostMicro,
            correctedRealCostMicro
          )
        }
      }
    }

    if (APPLY_MODE) {
      for (const [key, costs] of globalModelCosts) {
        writePipeline.hset(key, 'realCostMicro', costs.realCostMicro)
        writePipeline.hset(key, 'ratedCostMicro', costs.ratedCostMicro)
      }

      for (const [key, costs] of dailyCosts) {
        const value = key.includes(':real:')
          ? toFixedAmount(costs.realCostMicro)
          : toFixedAmount(costs.ratedCostMicro)
        writePipeline.set(key, value)
        writePipeline.expire(key, 86400 * 30)
      }

      for (const [key, costs] of monthlyCosts) {
        writePipeline.set(key, toFixedAmount(costs.ratedCostMicro))
        writePipeline.expire(key, 86400 * 90)
      }

      for (const [key, costs] of hourlyCosts) {
        writePipeline.set(key, toFixedAmount(costs.ratedCostMicro))
        writePipeline.expire(key, 86400 * 7)
      }

      for (const [key, costs] of totalCosts) {
        const value = key.includes(':real:')
          ? toFixedAmount(costs.realCostMicro)
          : toFixedAmount(costs.ratedCostMicro)
        writePipeline.set(key, value)
      }

      await writePipeline.exec()
    }

    const summary = {
      applyMode: APPLY_MODE,
      scannedKeyModelHashes: allKeys.length,
      updatedKeyModelCostCount,
      correctedGlobalModelHashes: globalModelCosts.size,
      correctedDailyCostKeys: [...dailyCosts.keys()].filter((key) => !key.includes(':real:'))
        .length,
      correctedRealDailyCostKeys: [...dailyCosts.keys()].filter((key) => key.includes(':real:'))
        .length,
      correctedMonthlyCostKeys: monthlyCosts.size,
      correctedHourlyCostKeys: hourlyCosts.size,
      correctedTotalCostKeys: [...totalCosts.keys()].filter((key) => !key.includes(':real:'))
        .length,
      correctedRealTotalCostKeys: [...totalCosts.keys()].filter((key) => key.includes(':real:'))
        .length,
      mismatchedStoredCostCount,
      sampleMismatches
    }

    console.log(JSON.stringify(summary, null, 2))

    await redis.disconnect()
    throw new Error('REDIS_COST_REPAIR_SUCCESS')
  } catch (error) {
    if (error.message === 'REDIS_COST_REPAIR_SUCCESS') {
      return
    }

    console.error('❌ Failed to repair Redis cost data:', error.message)
    logger.error('Failed to repair Redis cost data:', error)
    try {
      await redis.disconnect()
    } catch (_) {
      // ignore disconnect errors
    }
    process.exit(1)
  }
}

main()
