const redis = require('../models/redis')
const logger = require('../utils/logger')
const claudeAccountService = require('./account/claudeAccountService')
const openaiAccountService = require('./account/openaiAccountService')

const DEFAULT_INTERVAL_MINUTES = 30
const DEFAULT_MAX_STALENESS_MINUTES = 120
const DEFAULT_BATCH_SIZE = 5
const DEFAULT_REQUEST_TIMEOUT_MS = 30000

function normalizePositiveInteger(value, defaultValue, minValue = 1) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < minValue) {
    return defaultValue
  }
  return parsed
}

function parseUpdatedAt(updatedAt) {
  if (!updatedAt) {
    return null
  }

  const timestamp = Date.parse(updatedAt)
  return Number.isNaN(timestamp) ? null : timestamp
}

function isSnapshotStale(updatedAt, refreshThresholdMs, now = Date.now()) {
  const timestamp = parseUpdatedAt(updatedAt)
  if (!timestamp) {
    return true
  }
  return now - timestamp >= refreshThresholdMs
}

function isClaudeOAuthAccount(account) {
  const scopes = account.scopes && account.scopes.trim() ? account.scopes.split(' ') : []
  return scopes.includes('user:profile') && scopes.includes('user:inference')
}

function isActiveOpenAIAccount(account) {
  return account.isActive === true || account.isActive === 'true'
}

class OAuthUsageRefreshService {
  constructor() {
    this.refreshInterval = null
    this.isRunning = false
    this.intervalMs = DEFAULT_INTERVAL_MINUTES * 60 * 1000
    this.maxStalenessMs = DEFAULT_MAX_STALENESS_MINUTES * 60 * 1000
    this.refreshThresholdMs = (DEFAULT_MAX_STALENESS_MINUTES - DEFAULT_INTERVAL_MINUTES) * 60 * 1000
    this.batchSize = DEFAULT_BATCH_SIZE
    this.requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
  }

  start(options = {}) {
    this.stop()

    const maxStalenessMinutes = normalizePositiveInteger(
      options.maxStalenessMinutes,
      DEFAULT_MAX_STALENESS_MINUTES,
      5
    )
    let intervalMinutes = normalizePositiveInteger(
      options.intervalMinutes,
      DEFAULT_INTERVAL_MINUTES,
      1
    )

    if (intervalMinutes > maxStalenessMinutes) {
      logger.warn(
        `⚠️ OAuth usage refresh interval (${intervalMinutes}m) exceeds max staleness (${maxStalenessMinutes}m); clamping interval`
      )
      intervalMinutes = maxStalenessMinutes
    }

    this.intervalMs = intervalMinutes * 60 * 1000
    this.maxStalenessMs = maxStalenessMinutes * 60 * 1000
    this.refreshThresholdMs = Math.max(0, this.maxStalenessMs - this.intervalMs)
    this.batchSize = normalizePositiveInteger(options.batchSize, DEFAULT_BATCH_SIZE, 1)
    this.requestTimeoutMs = normalizePositiveInteger(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      1000
    )

    this.refreshInterval = setInterval(() => {
      this.performRefresh().catch((error) => {
        logger.error('❌ OAuth usage refresh failed:', error)
      })
    }, this.intervalMs)

    if (typeof this.refreshInterval.unref === 'function') {
      this.refreshInterval.unref()
    }

    logger.info(
      `📊 OAuth usage refresh scheduled every ${intervalMinutes} minutes (max staleness ${maxStalenessMinutes} minutes, batch size ${this.batchSize})`
    )

    this.performRefresh().catch((error) => {
      logger.error('❌ Initial OAuth usage refresh failed:', error)
    })
  }

  stop() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval)
      this.refreshInterval = null
    }
  }

  async performRefresh() {
    if (this.isRunning) {
      logger.debug('📊 OAuth usage refresh skipped: previous run still in progress')
      return {
        skipped: true
      }
    }

    this.isRunning = true
    const startedAt = Date.now()

    try {
      const claude = await this.refreshClaudeAccounts()
      const openai = await this.refreshOpenAIAccounts()
      const refreshed = claude.refreshed + openai.refreshed
      const failed = claude.failed + openai.failed

      if (refreshed > 0 || failed > 0) {
        logger.info(
          `📊 OAuth usage refresh completed: Claude ${claude.refreshed}/${claude.stale} refreshed, OpenAI ${openai.refreshed}/${openai.stale} refreshed, failed ${failed}, elapsed ${Date.now() - startedAt}ms`
        )
      } else {
        logger.debug(
          `📊 OAuth usage refresh completed: no stale accounts (Claude scanned ${claude.scanned}, OpenAI scanned ${openai.scanned})`
        )
      }

      return {
        skipped: false,
        claude,
        openai
      }
    } finally {
      this.isRunning = false
    }
  }

  async refreshClaudeAccounts() {
    const accounts = await redis.getAllClaudeAccounts()
    const now = Date.now()
    const candidates = accounts.filter((account) => {
      if (
        !isClaudeOAuthAccount(account) ||
        account.isActive !== 'true' ||
        account.status !== 'active' ||
        !account.accessToken
      ) {
        return false
      }

      return isSnapshotStale(account.claudeUsageUpdatedAt, this.refreshThresholdMs, now)
    })

    const summary = {
      scanned: accounts.length,
      stale: candidates.length,
      refreshed: 0,
      failed: 0
    }

    await this.processInBatches(candidates, async (account) => {
      try {
        const usageData = await claudeAccountService.fetchOAuthUsage(account.id)
        if (usageData) {
          await claudeAccountService.updateClaudeUsageSnapshot(account.id, usageData)
          summary.refreshed += 1
        } else {
          summary.failed += 1
        }
      } catch (error) {
        summary.failed += 1
        logger.warn(
          `⚠️ Claude OAuth usage refresh failed for ${account.name || account.id}: ${error.message}`
        )
      }
    })

    return summary
  }

  async refreshOpenAIAccounts() {
    const accounts = await openaiAccountService.getAllAccounts()
    const now = Date.now()
    const candidates = accounts.filter((account) => {
      if (!isActiveOpenAIAccount(account) || !account.hasRefreshToken || !account.accountId) {
        return false
      }

      return isSnapshotStale(account.codexUsage?.updatedAt, this.refreshThresholdMs, now)
    })

    const summary = {
      scanned: accounts.length,
      stale: candidates.length,
      refreshed: 0,
      failed: 0
    }

    await this.processInBatches(candidates, async (account) => {
      try {
        const snapshot = await openaiAccountService.fetchCodexUsage(account.id, {
          timeoutMs: this.requestTimeoutMs
        })
        if (snapshot) {
          summary.refreshed += 1
        } else {
          summary.failed += 1
        }
      } catch (error) {
        summary.failed += 1
        logger.warn(
          `⚠️ OpenAI OAuth usage refresh failed for ${account.name || account.id}: ${error.message}`
        )
      }
    })

    return summary
  }

  async processInBatches(items, handler) {
    for (let i = 0; i < items.length; i += this.batchSize) {
      const batch = items.slice(i, i + this.batchSize)
      await Promise.all(batch.map((item) => handler(item)))
    }
  }
}

const oauthUsageRefreshService = new OAuthUsageRefreshService()

module.exports = oauthUsageRefreshService
module.exports.OAuthUsageRefreshService = OAuthUsageRefreshService
