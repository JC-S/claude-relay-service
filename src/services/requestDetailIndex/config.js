const path = require('path')

const DEFAULT_RECOMPUTE_LIMIT = 256

function parsePositiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || value === '') {
    return fallback
  }
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback
}

function parseBackend(value) {
  return value === 'sqlite' ? 'sqlite' : 'redis'
}

function loadRequestDetailIndexConfig(env = process.env) {
  const enabled = env.REQUEST_DETAIL_SQLITE_INDEX_ENABLED === 'true'
  const requestedBackend = parseBackend(env.REQUEST_DETAIL_QUERY_BACKEND)

  return {
    enabled,
    queryBackend: enabled ? requestedBackend : 'redis',
    sqlitePath:
      env.REQUEST_DETAIL_SQLITE_PATH ||
      path.resolve(__dirname, '../../../data/request-details-index.sqlite3'),
    cacheMb: parsePositiveInteger(env.REQUEST_DETAIL_SQLITE_CACHE_MB, 128, {
      min: 8,
      max: 2048
    }),
    mmapMb: parsePositiveInteger(env.REQUEST_DETAIL_SQLITE_MMAP_MB, 256, {
      min: 0,
      max: 4096
    }),
    pendingBatchSize: parsePositiveInteger(env.REQUEST_DETAIL_SQLITE_PENDING_BATCH_SIZE, 200, {
      min: 10,
      max: 1000
    }),
    slowQueryMs: parsePositiveInteger(env.REQUEST_DETAIL_SQLITE_SLOW_QUERY_MS, 500, {
      min: 50,
      max: 60000
    }),
    recomputeLimit: parsePositiveInteger(
      env.REQUEST_DETAIL_SQLITE_RECOMPUTE_LIMIT,
      DEFAULT_RECOMPUTE_LIMIT,
      { min: 0, max: 2000 }
    )
  }
}

module.exports = {
  DEFAULT_RECOMPUTE_LIMIT,
  loadRequestDetailIndexConfig,
  parseBackend,
  parsePositiveInteger
}
