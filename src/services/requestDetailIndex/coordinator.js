const fs = require('fs')
const { randomUUID } = require('crypto')
const redis = require('../../models/redis')
const logger = require('../../utils/logger')
const claudeRelayConfigService = require('../claudeRelayConfigService')
const RequestDetailIndexWorkerClient = require('./workerClient')
const { loadRequestDetailIndexConfig } = require('./config')
const { mapRequestDetailToIndexRow } = require('./mapper')
const {
  MAINTENANCE_COMMAND_KEY,
  MAINTENANCE_CURRENT_KEY,
  MAINTENANCE_LAST_KEY,
  MAINTENANCE_STATUS_PREFIX,
  MAPPER_VERSION,
  PENDING_AGE_KEY,
  PENDING_VERSION_KEY,
  REQUEST_DETAIL_DAY_INDEX_PREFIX,
  REQUEST_DETAIL_ITEM_PREFIX,
  SERVICE_HEARTBEAT_KEY,
  SCHEMA_VERSION
} = require('./constants')

const MAX_RETENTION_HOURS = 30 * 24
const QUERY_SESSION_LIMIT = 2
const QUERY_SESSION_DEADLINE_MS = 3000
const PAGE_QUEUE_TIMEOUT_MS = 1000
const READ_BURST_LIMIT = 8
const MAX_READ_QUEUE = 32
const MAX_WRITE_QUEUE = 1000
const REBUILD_BATCH_ROWS = 200
const REBUILD_BATCH_BYTES = 4 * 1024 * 1024
const REBUILD_TOTAL_DEADLINE_MS = 15 * 60 * 1000
const REBUILD_IDLE_DEADLINE_MS = 30 * 1000
const FIXED_DISK_LOW_WATER_BYTES = 512 * 1024 * 1024
const COMMAND_TTL_MS = 20 * 60 * 1000
const VERIFY_EXPIRY_GUARD_MS = 120 * 1000

const ACK_PENDING_SCRIPT = `
if redis.call('HGET', KEYS[1], ARGV[1]) == ARGV[2] then
  redis.call('HDEL', KEYS[1], ARGV[1])
  redis.call('ZREM', KEYS[2], ARGV[1])
  return 1
end
return 0
`

const RENEW_COMMAND_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, value = pcall(cjson.decode, raw)
if not ok or value.token ~= ARGV[1] then return 0 end
return redis.call('PEXPIRE', KEYS[1], ARGV[2])
`

const COMPLETE_COMMAND_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, value = pcall(cjson.decode, raw)
if not ok or value.token ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseJson(value) {
  try {
    return value ? JSON.parse(value) : null
  } catch (_error) {
    return null
  }
}

function formatDayKey(date) {
  return date.toISOString().slice(0, 10)
}

function listDayKeys(startDate, endDate) {
  const keys = []
  const cursor = new Date(
    Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate())
  )
  const end = new Date(
    Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate())
  )
  while (cursor <= end) {
    keys.push(`${REQUEST_DETAIL_DAY_INDEX_PREFIX}${formatDayKey(cursor)}`)
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return keys
}

function rowsEqual(left, right) {
  const fields = [
    'timestampMs',
    'apiKeyId',
    'accountId',
    'accountType',
    'model',
    'endpoint',
    'method',
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheCreateTokens',
    'costMicros',
    'durationMs',
    'cacheHitNumerator',
    'cacheHitDenominator',
    'cacheNa',
    'pricingEligible',
    'searchText'
  ]
  return fields.every((field) => {
    if (typeof left[field] === 'number' || typeof right[field] === 'number') {
      return Number(left[field] || 0) === Number(right[field] || 0)
    }
    return (left[field] ?? null) === (right[field] ?? null)
  })
}

class RequestDetailIndexCoordinator {
  constructor(options = {}) {
    this.config = options.config || loadRequestDetailIndexConfig()
    this.workerFactory = options.workerFactory || (() => new RequestDetailIndexWorkerClient())
    this.worker = null
    this.state = 'disabled'
    this.ready = false
    this.started = false
    this.stopping = false
    this.maintenancePending = false
    this.maintenanceActive = false
    this.activeSessions = new Map()
    this.readQueue = []
    this.writeQueue = []
    this.phaseBQueue = []
    this.processingQueue = false
    this.readBurst = 0
    this.timers = new Set()
    this.bootstrapPromise = null
    this.restartAttempts = 0
    this.restarting = false
    this.runtimeTimersStarted = false
    this.restartTimer = null
    this.lastWorkerStatus = null
    this.metrics = {
      fallbacks: {},
      forcedWrites: 0,
      workerRestarts: 0,
      pageQueueTimeouts: 0,
      slowQueries: 0,
      rebuildPendingPeak: 0
    }
  }

  isEnabled() {
    return this.config.enabled === true
  }

  shouldUseSqlite() {
    return this.config.queryBackend === 'sqlite' && this.canQuery()
  }

  async prepareForQuery(budgetMs = 100) {
    if (!this.shouldUseSqlite()) {
      return false
    }
    try {
      let timer
      try {
        await Promise.race([
          this._dispatchPending({ drain: true }),
          new Promise((resolve) => {
            timer = setTimeout(resolve, budgetMs)
          })
        ])
      } finally {
        clearTimeout(timer)
      }
      const client = redis.getClient()
      if (!client) {
        return false
      }
      const [pendingVersions, pendingAges] = await Promise.all([
        client.hlen(PENDING_VERSION_KEY),
        client.zcard(PENDING_AGE_KEY)
      ])
      if (Number(pendingVersions) > 0 || Number(pendingAges) > 0) {
        this.recordFallback('pending_not_caught_up')
        return false
      }
      return this.canQuery()
    } catch (error) {
      this.recordFallback('pending_catchup_error')
      logger.debug(`Request detail SQLite pre-query catch-up failed: ${error.message}`)
      return false
    }
  }

  canQuery() {
    return (
      this.isEnabled() &&
      this.ready &&
      this.state === 'ready' &&
      !this.stopping &&
      !this.maintenancePending &&
      !this.maintenanceActive &&
      Boolean(this.worker)
    )
  }

  recordFallback(reason) {
    this.metrics.fallbacks[reason] = (this.metrics.fallbacks[reason] || 0) + 1
  }

  async start() {
    if (this.started || !this.isEnabled()) {
      this.state = this.isEnabled() ? this.state : 'disabled'
      return this.getHealth()
    }
    this.started = true
    this.stopping = false
    this.state = 'starting'
    this._startRuntimeTimers()
    try {
      await this._startWorker()
      await this._writeHeartbeat()
      this.bootstrapPromise = this._bootstrap().catch((error) => this._degrade(error))
    } catch (error) {
      this._degrade(error)
      this._scheduleWorkerRestart(error, 1000)
    }
    return this.getHealth()
  }

  async _startWorker() {
    const worker = this.workerFactory()
    let status
    try {
      status = await worker.start(this.config)
    } catch (error) {
      await worker.stop().catch(() => {})
      if (/malformed|corrupt|not a database/i.test(error.message)) {
        for (const suffix of ['', '-wal', '-shm']) {
          try {
            fs.unlinkSync(`${this.config.sqlitePath}${suffix}`)
          } catch (unlinkError) {
            if (unlinkError.code !== 'ENOENT') {
              throw unlinkError
            }
          }
        }
        const replacement = this.workerFactory()
        status = await replacement.start(this.config)
        this.worker = replacement
        this.lastWorkerStatus = status
        return status
      }
      throw error
    }
    if (!status.healthy) {
      await worker.stop()
      throw new Error(`Request detail index quick_check failed: ${status.integrity}`)
    }
    this.worker = worker
    this.lastWorkerStatus = status
    return status
  }

  _startTimer(callback, intervalMs) {
    const timer = setInterval(callback, intervalMs)
    timer.unref?.()
    this.timers.add(timer)
    return timer
  }

  _startRuntimeTimers() {
    if (this.runtimeTimersStarted) {
      return
    }
    this.runtimeTimersStarted = true
    this._startTimer(() => this._writeHeartbeat().catch(() => {}), 2000)
    this._startTimer(() => this._dispatchPending().catch((error) => this._degrade(error)), 1000)
    this._startTimer(
      () => this._pollMaintenanceCommand().catch((error) => this._degrade(error)),
      2000
    )
    this._startTimer(
      () => this._healthCheck().catch((error) => this._handleWorkerFailure(error)),
      10000
    )
    this._startTimer(() => this._cleanup().catch((error) => this._degrade(error)), 60 * 60 * 1000)
    this._startTimer(
      () => this._runPeriodicVerify().catch((error) => this._degrade(error)),
      6 * 60 * 60 * 1000
    )
  }

  async _bootstrap() {
    const status = await this.worker.call('status')
    const meta = status.meta || {}
    const compatible =
      status.schemaValid === true &&
      Number(meta.schema_version) === SCHEMA_VERSION &&
      Number(meta.mapper_version) === MAPPER_VERSION &&
      meta.rebuild_complete === '1'
    if (compatible && meta.full_rebuild_status === 'verified') {
      await this._dispatchPending({ drain: true })
      this.ready = true
      this.state = 'ready'
      logger.info('Request detail SQLite index is ready')
      return
    }
    if (compatible && meta.full_rebuild_status === 'built_unverified') {
      await this._dispatchPending({ drain: true })
      if (await this._verify()) {
        this.ready = true
        this.state = 'ready'
        return
      }
    }
    await this.rebuild({ automatic: true, destructive: !compatible })
  }

  async stop() {
    if (this.stopping) {
      return
    }
    this.stopping = true
    this.ready = false
    this.state = 'stopping'
    this.maintenancePending = true
    for (const timer of this.timers) {
      clearInterval(timer)
      clearTimeout(timer)
    }
    this.timers.clear()
    this.runtimeTimersStarted = false
    this.restartTimer = null
    this._rejectQueues(new Error('Request detail index is stopping'))
    const { worker } = this
    this.worker = null
    if (worker) {
      await worker.stop(3000)
    }
    const client = redis.getClient()
    if (client) {
      await client.del(SERVICE_HEARTBEAT_KEY).catch(() => {})
    }
    this.started = false
    this.state = 'stopped'
  }

  _rejectQueues(error) {
    for (const queue of [this.phaseBQueue, this.readQueue, this.writeQueue]) {
      while (queue.length > 0) {
        const task = queue.shift()
        clearTimeout(task.queueTimer)
        task.reject(error)
      }
    }
  }

  async _restartWorker() {
    const oldWorker = this.worker
    this.worker = null
    this.ready = false
    if (oldWorker) {
      await oldWorker.stop(3000)
    }
    if (this.stopping) {
      return
    }
    const delays = [1000, 5000, 30000]
    const delay = delays[Math.min(this.restartAttempts, delays.length - 1)]
    this.restartAttempts += 1
    await sleep(delay)
    await this._startWorker()
    this.metrics.workerRestarts += 1
    this.restartAttempts = 0
    await this._bootstrap()
  }

  async _handleWorkerFailure(error) {
    if (this.restarting || this.stopping) {
      return
    }
    this.restarting = true
    this._degrade(error)
    try {
      await this._restartWorker()
    } catch (restartError) {
      this._degrade(restartError)
      this._scheduleWorkerRestart(restartError, 30000)
    } finally {
      this.restarting = false
    }
  }

  async _healthCheck() {
    if (!this.worker || this.stopping || this.maintenanceActive) {
      return
    }
    const status = await this.worker.call('status', {}, QUERY_SESSION_DEADLINE_MS)
    this.lastWorkerStatus = status
    if (!status.healthy) {
      throw new Error(`Request detail SQLite Worker is unhealthy: ${status.integrity}`)
    }
    if (this.state === 'degraded' && !this.maintenancePending && !this.maintenanceActive) {
      await this._bootstrap()
    }
  }

  _scheduleWorkerRestart(error, delayMs) {
    if (this.restartTimer || this.stopping) {
      return
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      this.restartTimer = null
      this._handleWorkerFailure(error).catch(() => {})
    }, delayMs)
    timer.unref?.()
    this.restartTimer = timer
    this.timers.add(timer)
  }

  async _writeHeartbeat() {
    const client = redis.getClient()
    if (client && this.isEnabled() && !this.stopping) {
      await client.set(SERVICE_HEARTBEAT_KEY, String(process.pid), 'PX', 7000)
    }
  }

  _degrade(error) {
    this.ready = false
    if (!this.stopping) {
      this.state = 'degraded'
    }
    logger.warn(`Request detail SQLite index degraded: ${error.message}`)
  }

  getHealth() {
    return {
      enabled: this.isEnabled(),
      queryBackend: this.config.queryBackend,
      state: this.state,
      ready: this.ready,
      maintenancePending: this.maintenancePending,
      maintenanceActive: this.maintenanceActive,
      activeSessions: this.activeSessions.size,
      readQueue: this.readQueue.length,
      writeQueue: this.writeQueue.length,
      worker: this.lastWorkerStatus
        ? {
            healthy: this.lastWorkerStatus.healthy,
            schemaValid: this.lastWorkerStatus.schemaValid,
            state: this.lastWorkerStatus.state,
            generation: this.lastWorkerStatus.meta?.generation || null,
            mutationEpoch: Number(this.lastWorkerStatus.meta?.mutation_epoch || 0),
            rebuildStatus: this.lastWorkerStatus.meta?.full_rebuild_status || null,
            fileBytes: this.lastWorkerStatus.fileBytes || null,
            memory: this.lastWorkerStatus.memory || null
          }
        : null,
      metrics: { ...this.metrics }
    }
  }

  async status() {
    const workerStatus = this.worker ? await this.worker.call('status') : null
    const client = redis.getClient()
    let pendingCount = 0
    let oldestPendingMs = null
    if (client && this.isEnabled()) {
      const [versionCount, ageCount] = await Promise.all([
        client.hlen(PENDING_VERSION_KEY),
        client.zcard(PENDING_AGE_KEY)
      ])
      pendingCount = Math.max(Number(versionCount), Number(ageCount))
      const oldest = await client.zrange(PENDING_AGE_KEY, 0, 0, 'WITHSCORES')
      oldestPendingMs = oldest?.length >= 2 ? Number(oldest[1]) : null
    }
    return { ...this.getHealth(), worker: workerStatus, pendingCount, oldestPendingMs }
  }

  beginQuerySession() {
    if (!this.canQuery() || this.writeQueue.length > 0) {
      this.recordFallback('not_ready_or_write_waiting')
      return null
    }
    if (this.activeSessions.size >= QUERY_SESSION_LIMIT) {
      this.recordFallback('session_limit')
      return null
    }
    const sessionId = randomUUID()
    this.activeSessions.set(sessionId, {
      deadline: Date.now() + QUERY_SESSION_DEADLINE_MS,
      phase: 'phase_a'
    })
    return sessionId
  }

  endQuerySession(sessionId) {
    this.activeSessions.delete(sessionId)
    this._pumpQueue()
  }

  async phaseA(sessionId, payload) {
    const session = this.activeSessions.get(sessionId)
    if (!session || session.deadline <= Date.now()) {
      this.endQuerySession(sessionId)
      throw new Error('Request detail SQLite query session expired')
    }
    const result = await this._schedule('read', 'phaseA', payload, {
      sessionId,
      deadline: session.deadline
    })
    session.phase = 'phase_b'
    return result
  }

  async phaseB(sessionId, payload) {
    const session = this.activeSessions.get(sessionId)
    if (!session || session.deadline <= Date.now()) {
      this.endQuerySession(sessionId)
      throw new Error('Request detail SQLite query session expired')
    }
    try {
      return await this._schedule('phaseB', 'phaseB', payload, {
        sessionId,
        deadline: session.deadline
      })
    } finally {
      this.endQuerySession(sessionId)
    }
  }

  async page(payload) {
    if (!this.canQuery()) {
      throw new Error('Request detail SQLite index is not ready')
    }
    return this._schedule('read', 'page', payload, {
      queueTimeoutMs: PAGE_QUEUE_TIMEOUT_MS
    })
  }

  _schedule(kind, operation, payload, options = {}) {
    return new Promise((resolve, reject) => {
      if (kind === 'read' && this.readQueue.length >= MAX_READ_QUEUE) {
        reject(new Error('Request detail SQLite read queue is overloaded'))
        return
      }
      if (kind === 'write' && this.writeQueue.length >= MAX_WRITE_QUEUE) {
        reject(new Error('Request detail SQLite write queue is overloaded'))
        return
      }
      const task = {
        kind,
        operation,
        payload,
        options,
        resolve,
        reject,
        enqueuedAt: Date.now(),
        queueTimer: null
      }
      if (options.queueTimeoutMs) {
        task.queueTimer = setTimeout(() => {
          const queue = kind === 'phaseB' ? this.phaseBQueue : this.readQueue
          const index = queue.indexOf(task)
          if (index >= 0) {
            queue.splice(index, 1)
            this.metrics.pageQueueTimeouts += 1
            reject(new Error('Request detail SQLite page queue timed out'))
          }
        }, options.queueTimeoutMs)
      }
      if (kind === 'phaseB') {
        this.phaseBQueue.push(task)
      } else if (kind === 'write') {
        this.writeQueue.push(task)
      } else {
        this.readQueue.push(task)
      }
      this._pumpQueue()
    })
  }

  async _pumpQueue() {
    if (this.processingQueue || !this.worker || this.stopping || this.maintenanceActive) {
      return
    }
    let task = this.phaseBQueue.shift()
    if (!task) {
      const canWrite = this.activeSessions.size === 0
      if (canWrite && this.writeQueue.length > 0 && this.readBurst >= READ_BURST_LIMIT) {
        task = this.writeQueue.shift()
        this.readBurst = 0
        this.metrics.forcedWrites += 1
      } else if (this.readQueue.length > 0) {
        task = this.readQueue.shift()
        this.readBurst += 1
      } else if (canWrite && this.writeQueue.length > 0) {
        task = this.writeQueue.shift()
        this.readBurst = 0
      }
    }
    if (!task) {
      return
    }
    clearTimeout(task.queueTimer)
    if (task.options.deadline && task.options.deadline <= Date.now()) {
      task.reject(new Error('Request detail SQLite query session expired'))
      this._pumpQueue()
      return
    }

    this.processingQueue = true
    const startedAt = Date.now()
    try {
      const timeout = task.options.deadline
        ? Math.max(1, task.options.deadline - Date.now())
        : QUERY_SESSION_DEADLINE_MS
      const result = await this.worker.call(task.operation, task.payload, timeout)
      if (Date.now() - startedAt >= this.config.slowQueryMs) {
        this.metrics.slowQueries += 1
      }
      task.resolve(result)
    } catch (error) {
      task.reject(error)
      if (
        error.code === 'REQUEST_DETAIL_INDEX_TIMEOUT' ||
        /Worker.*(?:not running|exited)|worker.*(?:not running|exited)/i.test(error.message)
      ) {
        this._handleWorkerFailure(error).catch(() => {})
      }
    } finally {
      this.processingQueue = false
      setImmediate(() => this._pumpQueue())
    }
  }

  async notifyCapture(row, sourceVersion) {
    if (!this.isEnabled() || !this.worker || !row || this.stopping) {
      return
    }
    const mapped = mapRequestDetailToIndexRow(row, {
      requestId: row.requestId,
      timestampMs: new Date(row.timestamp).getTime(),
      expiresAtMs: row.expiresAtMs,
      sourceVersion
    })
    if (!mapped) {
      return
    }
    try {
      await this._schedule('write', 'upsertBatch', { rows: [mapped] })
      await this._ackPending(mapped.request_id, sourceVersion)
    } catch (error) {
      logger.debug(`Request detail SQLite immediate index write deferred: ${error.message}`)
    }
  }

  async _ackPending(requestId, token) {
    const client = redis.getClient()
    if (!client || this.maintenanceActive) {
      return false
    }
    return (
      Number(
        await client.eval(
          ACK_PENDING_SCRIPT,
          2,
          PENDING_VERSION_KEY,
          PENDING_AGE_KEY,
          requestId,
          token
        )
      ) === 1
    )
  }

  async _loadPendingBatch() {
    const client = redis.getClient()
    if (!client) {
      return []
    }
    const ids = await client.zrange(PENDING_AGE_KEY, 0, this.config.pendingBatchSize - 1)
    if (!ids.length) {
      return []
    }
    const versions = await client.hmget(PENDING_VERSION_KEY, ...ids)
    const pipeline = client.pipeline()
    ids.forEach((id) => {
      pipeline.get(`${REQUEST_DETAIL_ITEM_PREFIX}${id}`)
      pipeline.pttl(`${REQUEST_DETAIL_ITEM_PREFIX}${id}`)
    })
    const results = await pipeline.exec()
    const now = Date.now()
    return ids.map((requestId, index) => ({
      requestId,
      sourceVersion: versions[index],
      raw: results[index * 2]?.[1] || null,
      pttl: Number(results[index * 2 + 1]?.[1] || -1),
      now
    }))
  }

  async _resolvePendingTimestamp(requestId, record) {
    const storedTimestamp = record?.timestamp ? new Date(record.timestamp).getTime() : Number.NaN
    if (Number.isFinite(storedTimestamp)) {
      return storedTimestamp
    }
    const client = redis.getClient()
    if (!client || typeof client.pipeline !== 'function') {
      return null
    }
    const now = new Date()
    const start = new Date(now.getTime() - MAX_RETENTION_HOURS * 3600 * 1000)
    const dayKeys = listDayKeys(start, now)
    const pipeline = client.pipeline()
    dayKeys.forEach((dayKey) => pipeline.zscore(dayKey, requestId))
    const results = await pipeline.exec()
    for (const result of results) {
      if (result?.[1] === null || result?.[1] === undefined) {
        continue
      }
      const timestampMs = Number(result[1])
      if (Number.isFinite(timestampMs)) {
        return timestampMs
      }
    }
    return null
  }

  async _dispatchPending(options = {}) {
    if (
      !this.worker ||
      this.stopping ||
      this.maintenanceActive ||
      this.maintenancePending ||
      this.processingPending
    ) {
      return
    }
    this.processingPending = true
    try {
      let passes = 0
      do {
        const pending = await this._loadPendingBatch()
        if (pending.length === 0) {
          break
        }
        const rows = []
        const expired = []
        const unindexable = []
        for (const item of pending) {
          if (!item.sourceVersion) {
            if (!item.raw || item.pttl <= 0) {
              await redis.getClient().zrem(PENDING_AGE_KEY, item.requestId)
              continue
            }
            item.sourceVersion = `${Date.now()}-${randomUUID()}`
            await redis.getClient().hset(PENDING_VERSION_KEY, item.requestId, item.sourceVersion)
          }
          if (!item.raw || item.pttl <= 0) {
            expired.push(item)
            continue
          }
          const parsed = parseJson(item.raw)
          const timestampMs = await this._resolvePendingTimestamp(item.requestId, parsed)
          const row = mapRequestDetailToIndexRow(parsed, {
            requestId: item.requestId,
            timestampMs,
            expiresAtMs: item.now + item.pttl,
            sourceVersion: item.sourceVersion
          })
          if (row) {
            rows.push(row)
          } else {
            unindexable.push(item)
          }
        }
        if (rows.length > 0) {
          await this._schedule('write', 'upsertBatch', { rows })
          for (const row of rows) {
            await this._ackPending(row.request_id, row.source_version)
          }
        }
        for (const item of expired) {
          await this._ackPending(item.requestId, item.sourceVersion)
        }
        for (const item of unindexable) {
          await this._ackPending(item.requestId, item.sourceVersion)
        }
        passes += 1
      } while (options.drain && passes < 10000 && !this.stopping)
    } finally {
      this.processingPending = false
    }
  }

  async *_iterateRebuildPointerBatches(retentionHours) {
    const client = redis.getClient()
    const now = new Date()
    const start = new Date(now.getTime() - retentionHours * 3600 * 1000)
    for (const dayKey of listDayKeys(start, now)) {
      let offset = 0
      let hasMore = true
      while (hasMore) {
        const entries = await client.zrangebyscore(
          dayKey,
          start.getTime(),
          now.getTime(),
          'WITHSCORES',
          'LIMIT',
          offset,
          REBUILD_BATCH_ROWS
        )
        const pointers = []
        for (let index = 0; index < entries.length; index += 2) {
          const requestId = entries[index]
          const timestampMs = Number(entries[index + 1])
          if (requestId && Number.isFinite(timestampMs)) {
            pointers.push({ requestId, timestampMs })
          }
        }
        if (pointers.length > 0) {
          yield pointers
        }
        const entryCount = Math.floor(entries.length / 2)
        offset += entryCount
        hasMore = entryCount === REBUILD_BATCH_ROWS
        await new Promise((resolve) => setImmediate(resolve))
      }
    }
  }

  async _loadVerificationPointers(retentionHours) {
    const pointers = new Map()
    for await (const batch of this._iterateRebuildPointerBatches(retentionHours)) {
      for (const pointer of batch) {
        pointers.set(pointer.requestId, pointer.timestampMs)
      }
    }
    return [...pointers].map(([requestId, timestampMs]) => ({ requestId, timestampMs }))
  }

  _assertDiskSpace() {
    const stats = fs.statfsSync(require('path').dirname(this.config.sqlitePath))
    const available = Number(stats.bavail) * Number(stats.bsize)
    let currentSize = 0
    try {
      currentSize = fs.statSync(this.config.sqlitePath).size
    } catch (_error) {
      currentSize = 0
    }
    const required = Math.max(FIXED_DISK_LOW_WATER_BYTES, currentSize * 3)
    if (available < required) {
      throw new Error(
        `Insufficient disk space for request detail index rebuild (${available} < ${required})`
      )
    }
    return { available, required }
  }

  async _assertCommandOwnership(token) {
    if (!token) {
      return
    }
    const client = redis.getClient()
    const renewed = await client.eval(
      RENEW_COMMAND_SCRIPT,
      1,
      MAINTENANCE_COMMAND_KEY,
      token,
      String(COMMAND_TTL_MS)
    )
    if (Number(renewed) !== 1) {
      throw new Error('Request detail maintenance command ownership was lost')
    }
  }

  async _waitForReadsToDrain() {
    const deadline = Date.now() + QUERY_SESSION_DEADLINE_MS
    while (
      (this.activeSessions.size > 0 || this.processingQueue || this.readQueue.length > 0) &&
      Date.now() < deadline
    ) {
      await sleep(20)
    }
    if (this.processingQueue) {
      throw new Error('Timed out draining request detail SQLite reads for maintenance')
    }
    if (this.activeSessions.size > 0) {
      this.activeSessions.clear()
    }
    for (const queue of [this.phaseBQueue, this.readQueue]) {
      while (queue.length > 0) {
        const task = queue.shift()
        clearTimeout(task.queueTimer)
        task.reject(new Error('Request detail SQLite query yielded to maintenance'))
      }
    }
  }

  async rebuild(options = {}) {
    if (!this.worker || this.stopping || this.maintenanceActive) {
      throw new Error('Request detail SQLite rebuild is unavailable')
    }
    this.maintenancePending = true
    this.ready = false
    this.state = 'maintenance_pending'
    try {
      await this._waitForReadsToDrain()
    } catch (error) {
      this.maintenancePending = false
      this._degrade(error)
      throw error
    }
    this.maintenanceActive = true
    this.maintenancePending = false
    this.state = 'rebuilding'
    const startedAt = Date.now()
    let lastBatchAt = startedAt
    const sessionId = randomUUID()
    let terminal = false
    let batchId = 0
    const buildSummary = {
      scannedPointers: 0,
      validItems: 0,
      expiredItems: 0,
      malformedItems: 0,
      duplicatePointers: 0,
      startedAt: new Date(startedAt).toISOString()
    }
    try {
      this._assertDiskSpace()
      await this._assertCommandOwnership(options.commandToken)
      const settings = await claudeRelayConfigService.getConfig()
      const retentionHours = Math.min(
        Math.max(Number(settings.requestDetailRetentionHours) || 6, 1),
        MAX_RETENTION_HOURS
      )
      await this.worker.call(
        'beginRebuild',
        { sessionId, destructive: options.destructive === true },
        10000
      )
      const client = redis.getClient()
      for await (const pointerBatch of this._iterateRebuildPointerBatches(retentionHours)) {
        await this._assertCommandOwnership(options.commandToken)
        if (this.stopping || Date.now() - startedAt > REBUILD_TOTAL_DEADLINE_MS) {
          throw new Error('Request detail index rebuild deadline or shutdown reached')
        }
        if (Date.now() - lastBatchAt > REBUILD_IDLE_DEADLINE_MS) {
          throw new Error('Request detail index rebuild batch idle deadline reached')
        }
        if (batchId % 10 === 0) {
          this._assertDiskSpace()
          const pendingCount = Number(await client.hlen(PENDING_VERSION_KEY))
          this.metrics.rebuildPendingPeak = Math.max(this.metrics.rebuildPendingPeak, pendingCount)
          if (options.commandToken) {
            await this._writeMaintenanceStatus(options.commandToken, {
              op: 'rebuild',
              state: 'running',
              phase: 'scanning',
              progress: {
                scannedPointers: buildSummary.scannedPointers,
                validItems: buildSummary.validItems,
                pendingBacklog: pendingCount
              }
            })
          }
        }
        buildSummary.scannedPointers += pointerBatch.length
        const pipeline = client.pipeline()
        pointerBatch.forEach(({ requestId }) => {
          pipeline.get(`${REQUEST_DETAIL_ITEM_PREFIX}${requestId}`)
          pipeline.pttl(`${REQUEST_DETAIL_ITEM_PREFIX}${requestId}`)
        })
        const results = await pipeline.exec()
        const nowMs = Date.now()
        let rows = []
        let bytes = 0
        for (let index = 0; index < pointerBatch.length; index += 1) {
          const pointer = pointerBatch[index]
          const raw = results[index * 2]?.[1]
          const pttl = Number(results[index * 2 + 1]?.[1] || -1)
          if (!raw || pttl <= 0) {
            buildSummary.expiredItems += 1
            continue
          }
          const parsed = parseJson(raw)
          if (!parsed) {
            buildSummary.malformedItems += 1
            continue
          }
          const row = mapRequestDetailToIndexRow(parsed, {
            requestId: pointer.requestId,
            timestampMs: pointer.timestampMs,
            expiresAtMs: nowMs + pttl,
            sourceVersion: 'rebuild'
          })
          if (!row) {
            buildSummary.malformedItems += 1
            continue
          }
          const rowBytes = Buffer.byteLength(JSON.stringify(row))
          if (rows.length > 0 && bytes + rowBytes > REBUILD_BATCH_BYTES) {
            batchId += 1
            await this.worker.call(
              'appendRebuildBatch',
              { sessionId, batchId, rows },
              REBUILD_IDLE_DEADLINE_MS
            )
            lastBatchAt = Date.now()
            rows = []
            bytes = 0
          }
          rows.push(row)
          bytes += rowBytes
          buildSummary.validItems += 1
        }
        if (rows.length > 0) {
          batchId += 1
          await this.worker.call(
            'appendRebuildBatch',
            { sessionId, batchId, rows },
            REBUILD_IDLE_DEADLINE_MS
          )
          lastBatchAt = Date.now()
        }
        await new Promise((resolve) => setImmediate(resolve))
        await this._assertCommandOwnership(options.commandToken)
      }
      this._assertDiskSpace()
      await this._assertCommandOwnership(options.commandToken)
      const generation = randomUUID()
      const commitResult = await this.worker.call(
        'commitRebuild',
        { sessionId, generation, buildSummary },
        REBUILD_IDLE_DEADLINE_MS
      )
      terminal = true
      buildSummary.duplicatePointers = Number(commitResult.duplicateRows || 0)
      buildSummary.expiredItems += Number(commitResult.expiredDeleted || 0)
      if (
        Number(commitResult.rowCount) !==
        buildSummary.validItems -
          buildSummary.duplicatePointers -
          Number(commitResult.expiredDeleted || 0)
      ) {
        throw new Error('Request detail index rebuild row-count invariant failed')
      }
      this.maintenanceActive = false
      await this._dispatchPending({ drain: true })
      this.maintenanceActive = true
      if (!(await this._verify({ commandToken: options.commandToken }))) {
        throw new Error('Request detail SQLite verification failed after rebuild')
      }
      this.ready = true
      this.state = 'ready'
      logger.info(`Request detail SQLite index rebuilt with ${buildSummary.validItems} rows`)
      return buildSummary
    } catch (error) {
      if (!terminal && this.worker) {
        try {
          await this.worker.call('rollbackRebuild', { sessionId }, 3000)
        } catch (_rollbackError) {
          await this._restartWorker().catch((restartError) => this._degrade(restartError))
        }
      }
      this._degrade(error)
      throw error
    } finally {
      this.maintenanceActive = false
      this.maintenancePending = false
      this._pumpQueue()
    }
  }

  async _collectRedisVerificationRows(expiresAfterMs, excludedIds, commandToken = null) {
    const settings = await claudeRelayConfigService.getConfig()
    const retentionHours = Math.min(
      Math.max(Number(settings.requestDetailRetentionHours) || 6, 1),
      MAX_RETENTION_HOURS
    )
    const pointers = await this._loadVerificationPointers(retentionHours)
    const client = redis.getClient()
    const rows = new Map()
    for (let offset = 0; offset < pointers.length; offset += REBUILD_BATCH_ROWS) {
      await this._assertCommandOwnership(commandToken)
      const batch = pointers.slice(offset, offset + REBUILD_BATCH_ROWS)
      const pipeline = client.pipeline()
      batch.forEach(({ requestId }) => {
        pipeline.get(`${REQUEST_DETAIL_ITEM_PREFIX}${requestId}`)
        pipeline.pttl(`${REQUEST_DETAIL_ITEM_PREFIX}${requestId}`)
      })
      const results = await pipeline.exec()
      const now = Date.now()
      batch.forEach((pointer, index) => {
        if (excludedIds.has(pointer.requestId)) {
          return
        }
        const raw = results[index * 2]?.[1]
        const pttl = Number(results[index * 2 + 1]?.[1] || -1)
        if (!raw || pttl <= 0 || now + pttl <= expiresAfterMs) {
          return
        }
        const mapped = mapRequestDetailToIndexRow(parseJson(raw), {
          requestId: pointer.requestId,
          timestampMs: pointer.timestampMs,
          expiresAtMs: now + pttl,
          sourceVersion: 'verify'
        })
        if (mapped) {
          rows.set(pointer.requestId, {
            requestId: pointer.requestId,
            timestampMs: mapped.timestamp_ms,
            apiKeyId: mapped.api_key_id,
            accountId: mapped.account_id,
            accountType: mapped.account_type,
            model: mapped.model,
            endpoint: mapped.endpoint,
            method: mapped.method,
            inputTokens: mapped.input_tokens,
            outputTokens: mapped.output_tokens,
            cacheReadTokens: mapped.cache_read_tokens,
            cacheCreateTokens: mapped.cache_create_tokens,
            costMicros: mapped.cost_micros,
            durationMs: mapped.duration_ms,
            cacheHitNumerator: mapped.cache_hit_numerator,
            cacheHitDenominator: mapped.cache_hit_denominator,
            cacheNa: mapped.cache_create_not_applicable,
            pricingEligible: mapped.pricing_recompute_eligible,
            searchText: mapped.search_text
          })
        }
      })
      await new Promise((resolve) => setImmediate(resolve))
    }
    return rows
  }

  async _pendingIds() {
    const client = redis.getClient()
    const [hashIds, ageIds] = await Promise.all([
      client.hkeys(PENDING_VERSION_KEY),
      client.zrange(PENDING_AGE_KEY, 0, -1)
    ])
    return new Set([...hashIds, ...ageIds])
  }

  async _verify(options = {}) {
    const priorMaintenance = this.maintenanceActive
    this.maintenancePending = true
    this.ready = false
    if (!priorMaintenance) {
      try {
        await this._waitForReadsToDrain()
      } catch (error) {
        this.maintenancePending = false
        this._degrade(error)
        throw error
      }
      this.maintenanceActive = true
    }
    const client = redis.getClient()
    try {
      await this._assertCommandOwnership(options.commandToken)
      const beforePending = await this._pendingIds()
      const expiresAfterMs = Date.now() + VERIFY_EXPIRY_GUARD_MS
      const redisRows = await this._collectRedisVerificationRows(
        expiresAfterMs,
        beforePending,
        options.commandToken
      )
      const afterPending = await this._pendingIds()
      const excluded = new Set([...beforePending, ...afterPending])
      for (const id of excluded) {
        redisRows.delete(id)
      }

      const sqliteRows = new Map()
      let offset = 0
      let hasMoreRows = true
      while (hasMoreRows) {
        await this._assertCommandOwnership(options.commandToken)
        const batch = await this.worker.call(
          'verifyRows',
          { expiresAfterMs, offset, limit: 500 },
          QUERY_SESSION_DEADLINE_MS
        )
        if (!batch.length) {
          hasMoreRows = false
          continue
        }
        for (const row of batch) {
          if (!excluded.has(row.requestId)) {
            sqliteRows.set(row.requestId, row)
          }
        }
        offset += batch.length
      }

      let mismatch = redisRows.size !== sqliteRows.size
      if (!mismatch) {
        for (const [requestId, expected] of redisRows) {
          const actual = sqliteRows.get(requestId)
          if (!actual || !rowsEqual(expected, actual)) {
            mismatch = true
            break
          }
        }
      }
      if (mismatch) {
        logger.warn(
          `Request detail SQLite verify mismatch: redis=${redisRows.size}, sqlite=${sqliteRows.size}, pending=${excluded.size}`
        )
        this.ready = false
        this.state = 'degraded'
        return false
      }
      const summary = {
        count: redisRows.size,
        pendingExcluded: excluded.size,
        expiresAfterMs,
        verifiedAt: new Date().toISOString()
      }
      await this._assertCommandOwnership(options.commandToken)
      await this.worker.call('markVerified', { summary })
      return true
    } finally {
      this.maintenancePending = false
      this.maintenanceActive = false
      // Capture continues during verification; do not reopen query admission until it is replayed.
      await this._dispatchPending({ drain: true }).catch((error) => this._degrade(error))
      if (client) {
        this._pumpQueue()
      }
    }
  }

  async _cleanup() {
    if (!this.canQuery() || this.activeSessions.size > 0) {
      return
    }
    let changes = 0
    do {
      const result = await this._schedule('write', 'cleanup', { nowMs: Date.now() })
      ;({ changes } = result)
      if (changes > 0) {
        await new Promise((resolve) => setImmediate(resolve))
      }
    } while (changes >= 1000 && !this.stopping)
    await this._schedule('write', 'optimize', {})
    await this._gcPending()
  }

  async _runPeriodicVerify() {
    if (!this.canQuery()) {
      return
    }
    const verified = await this._verify()
    if (verified) {
      this.ready = true
      this.state = 'ready'
      return
    }
    await this.rebuild({ automatic: true })
  }

  async _gcPending() {
    const client = redis.getClient()
    if (!client) {
      return
    }
    const cutoff = Date.now() - (MAX_RETENTION_HOURS + 24) * 3600 * 1000
    const ids = await client.zrangebyscore(PENDING_AGE_KEY, 0, cutoff, 'LIMIT', 0, 500)
    for (const id of ids) {
      const exists = await client.exists(`${REQUEST_DETAIL_ITEM_PREFIX}${id}`)
      if (!exists) {
        const version = await client.hget(PENDING_VERSION_KEY, id)
        if (version) {
          await this._ackPending(id, version)
        } else {
          await client.zrem(PENDING_AGE_KEY, id)
        }
      }
    }
    const hashIds = await client.hkeys(PENDING_VERSION_KEY)
    for (const id of hashIds.slice(0, 500)) {
      if ((await client.zscore(PENDING_AGE_KEY, id)) === null) {
        const exists = await client.exists(`${REQUEST_DETAIL_ITEM_PREFIX}${id}`)
        if (!exists) {
          await client.hdel(PENDING_VERSION_KEY, id)
        } else {
          await client.zadd(PENDING_AGE_KEY, Date.now(), id)
        }
      }
    }
  }

  async _writeMaintenanceStatus(token, status) {
    const client = redis.getClient()
    const key = `${MAINTENANCE_STATUS_PREFIX}${token}`
    const payload = JSON.stringify({ token, ...status, updatedAt: new Date().toISOString() })
    await client
      .multi()
      .set(key, payload, 'EX', 24 * 3600)
      .set(MAINTENANCE_CURRENT_KEY, token, 'EX', 24 * 3600)
      .exec()
  }

  async _pollMaintenanceCommand() {
    if (!this.isEnabled() || this.maintenanceActive || this.stopping) {
      return
    }
    const client = redis.getClient()
    const raw = await client.get(MAINTENANCE_COMMAND_KEY)
    const command = parseJson(raw)
    if (!command?.token || !['rebuild', 'verify'].includes(command.op)) {
      return
    }
    await this._writeMaintenanceStatus(command.token, {
      op: command.op,
      state: 'running',
      phase: command.op,
      requestedAt: command.requestedAt
    })
    const renewTimer = setInterval(() => {
      client
        .eval(
          RENEW_COMMAND_SCRIPT,
          1,
          MAINTENANCE_COMMAND_KEY,
          command.token,
          String(COMMAND_TTL_MS)
        )
        .catch(() => {})
    }, 30000)
    renewTimer.unref?.()
    try {
      if (command.op === 'rebuild') {
        await this.rebuild({ commandToken: command.token })
      } else {
        const verified = await this._verify({ commandToken: command.token })
        if (!verified) {
          throw new Error('Verification mismatch')
        }
        this.ready = true
        this.state = 'ready'
      }
      await this._writeMaintenanceStatus(command.token, {
        op: command.op,
        state: 'completed',
        phase: 'complete'
      })
      await client.set(MAINTENANCE_LAST_KEY, command.token, 'EX', 7 * 24 * 3600)
    } catch (error) {
      await this._writeMaintenanceStatus(command.token, {
        op: command.op,
        state: 'failed',
        phase: 'terminal',
        error: error.message
      })
      if (command.op === 'verify' && !this.stopping) {
        setImmediate(() => this.rebuild({ automatic: true }).catch((err) => this._degrade(err)))
      }
    } finally {
      clearInterval(renewTimer)
      await client.eval(COMPLETE_COMMAND_SCRIPT, 1, MAINTENANCE_COMMAND_KEY, command.token)
    }
  }
}

module.exports = new RequestDetailIndexCoordinator()
module.exports.RequestDetailIndexCoordinator = RequestDetailIndexCoordinator
module.exports.constants = {
  COMMAND_TTL_MS,
  PAGE_QUEUE_TIMEOUT_MS,
  QUERY_SESSION_DEADLINE_MS,
  QUERY_SESSION_LIMIT,
  READ_BURST_LIMIT,
  MAX_READ_QUEUE,
  MAX_WRITE_QUEUE,
  REBUILD_IDLE_DEADLINE_MS,
  REBUILD_TOTAL_DEADLINE_MS,
  VERIFY_EXPIRY_GUARD_MS
}
