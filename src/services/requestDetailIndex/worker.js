const fs = require('fs')
const path = require('path')
const { parentPort } = require('worker_threads')
const Database = require('better-sqlite3')
const { randomUUID } = require('crypto')
const { MAPPER_VERSION, SCHEMA_VERSION } = require('./constants')

const ROW_COLUMNS = [
  'request_id',
  'source_version',
  'timestamp_ms',
  'expires_at_ms',
  'api_key_id',
  'account_id',
  'account_type',
  'model',
  'endpoint',
  'method',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_create_tokens',
  'cost_micros',
  'duration_ms',
  'cache_hit_numerator',
  'cache_hit_denominator',
  'cache_create_not_applicable',
  'pricing_recompute_eligible',
  'search_text'
]
const QUERY_COLUMNS = ROW_COLUMNS.filter((column) => column !== 'source_version')

let database = null
let databasePath = null
let statements = null
let workerState = 'idle'
let rebuildSession = null
let jsonEachAvailable = false

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS request_detail_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS request_detail_records (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL UNIQUE,
      source_version TEXT NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      api_key_id TEXT,
      account_id TEXT,
      account_type TEXT NOT NULL,
      model TEXT NOT NULL,
      endpoint TEXT,
      method TEXT,
      input_tokens REAL NOT NULL DEFAULT 0,
      output_tokens REAL NOT NULL DEFAULT 0,
      cache_read_tokens REAL NOT NULL DEFAULT 0,
      cache_create_tokens REAL NOT NULL DEFAULT 0,
      cost_micros INTEGER NOT NULL DEFAULT 0,
      duration_ms REAL NOT NULL DEFAULT 0,
      cache_hit_numerator REAL NOT NULL DEFAULT 0,
      cache_hit_denominator REAL NOT NULL DEFAULT 0,
      cache_create_not_applicable INTEGER NOT NULL DEFAULT 0,
      pricing_recompute_eligible INTEGER NOT NULL DEFAULT 0,
      search_text TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_request_detail_timestamp
      ON request_detail_records(timestamp_ms, request_id);
    CREATE INDEX IF NOT EXISTS idx_request_detail_api_key
      ON request_detail_records(api_key_id, timestamp_ms, request_id);
    CREATE INDEX IF NOT EXISTS idx_request_detail_account
      ON request_detail_records(account_id, account_type, timestamp_ms, request_id);
    CREATE INDEX IF NOT EXISTS idx_request_detail_model
      ON request_detail_records(model, timestamp_ms, request_id);
    CREATE INDEX IF NOT EXISTS idx_request_detail_endpoint
      ON request_detail_records(endpoint, timestamp_ms, request_id);
    CREATE INDEX IF NOT EXISTS idx_request_detail_expiry
      ON request_detail_records(expires_at_ms);
  `)
}

function createMetaSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS request_detail_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `)
}

function tableExists(db, tableName) {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName)
  )
}

function hasCurrentRecordColumns(db) {
  if (!tableExists(db, 'request_detail_records')) {
    return false
  }
  const columns = db.pragma('table_info(request_detail_records)')
  return ROW_COLUMNS.every((column) => columns.some((entry) => entry.name === column))
}

function hasCurrentMetaColumns(db) {
  if (!tableExists(db, 'request_detail_meta')) {
    return false
  }
  const columns = db.pragma('table_info(request_detail_meta)')
  return ['key', 'value'].every((column) => columns.some((entry) => entry.name === column))
}

function readMeta() {
  if (!database || !hasCurrentMetaColumns(database)) {
    return {}
  }
  const rows = database.prepare('SELECT key, value FROM request_detail_meta').all()
  return Object.fromEntries(rows.map((row) => [row.key, row.value]))
}

function writeMeta(values) {
  const statement = database.prepare(`
    INSERT INTO request_detail_meta(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `)
  for (const [key, value] of Object.entries(values)) {
    statement.run(key, String(value))
  }
}

function prepareStatements() {
  const updateAssignments = QUERY_COLUMNS.map((column) => `${column} = @${column}`).join(', ')
  const changedConditions = QUERY_COLUMNS.map((column) => `${column} IS NOT @${column}`).join(
    ' OR '
  )
  const insertColumns = ROW_COLUMNS.join(', ')
  const insertValues = ROW_COLUMNS.map((column) => `@${column}`).join(', ')

  statements = {
    updateChanged: database.prepare(`
      UPDATE request_detail_records SET ${updateAssignments}, source_version = @source_version
      WHERE request_id = @request_id AND (${changedConditions})
    `),
    insertIgnore: database.prepare(`
      INSERT INTO request_detail_records(${insertColumns}) VALUES (${insertValues})
      ON CONFLICT(request_id) DO NOTHING
    `),
    updateVersion: database.prepare(`
      UPDATE request_detail_records SET source_version = @source_version
      WHERE request_id = @request_id AND source_version IS NOT @source_version
    `),
    rebuildInsert: database.prepare(`
      INSERT INTO request_detail_records(${insertColumns}) VALUES (${insertValues})
      ON CONFLICT(request_id) DO NOTHING
    `),
    rebuildUpdate: database.prepare(`
      UPDATE request_detail_records SET
        ${ROW_COLUMNS.filter((column) => column !== 'request_id')
          .map((column) => `${column} = @${column}`)
          .join(', ')}
      WHERE request_id = @request_id
    `),
    deleteExpired: database.prepare(`
      DELETE FROM request_detail_records WHERE sequence IN (
        SELECT sequence FROM request_detail_records WHERE expires_at_ms <= ? LIMIT 1000
      )
    `),
    maxSequence: database.prepare(
      'SELECT COALESCE(MAX(sequence), 0) AS value FROM request_detail_records'
    )
  }
}

function reprepareStatementsIfCompatible() {
  statements = null
  if (hasCurrentRecordColumns(database)) {
    prepareStatements()
  }
}

function configureDatabase(options) {
  database.pragma('journal_mode = WAL')
  database.pragma('synchronous = NORMAL')
  database.pragma('foreign_keys = ON')
  database.pragma('busy_timeout = 3000')
  database.pragma('temp_store = MEMORY')
  database.pragma(`cache_size = ${-Math.max(8, options.cacheMb) * 1024}`)
  database.pragma(`mmap_size = ${Math.max(0, options.mmapMb) * 1024 * 1024}`)
  database.pragma('wal_autocheckpoint = 1000')
  database.pragma('journal_size_limit = 67108864')
}

function initialize(options) {
  if (database) {
    return getStatus()
  }
  fs.mkdirSync(path.dirname(options.sqlitePath), { recursive: true })
  databasePath = options.sqlitePath
  database = new Database(options.sqlitePath)
  configureDatabase(options)
  try {
    database.prepare("SELECT count(*) AS count FROM json_each('[]')").get()
    jsonEachAvailable = true
  } catch (_error) {
    jsonEachAvailable = false
  }
  createMetaSchema(database)
  if (!tableExists(database, 'request_detail_records')) {
    createSchema(database)
  } else if (hasCurrentRecordColumns(database)) {
    // Idempotently restore any missing target indexes without mutating record data.
    createSchema(database)
  }
  if (hasCurrentRecordColumns(database)) {
    reprepareStatementsIfCompatible()
  }

  const meta = readMeta()
  if (hasCurrentMetaColumns(database) && !meta.schema_version) {
    writeMeta({
      schema_version: SCHEMA_VERSION,
      mapper_version: MAPPER_VERSION,
      generation: randomUUID(),
      mutation_epoch: 0,
      full_rebuild_status: 'empty',
      rebuild_complete: 0,
      created_at: new Date().toISOString()
    })
  }
  database.prepare('SELECT COUNT(*) FROM request_detail_records').get()
  return getStatus()
}

function getStatus() {
  const meta = database ? readMeta() : {}
  let integrity = 'closed'
  if (database) {
    integrity = database.pragma('quick_check', { simple: true })
  }
  const expectedIndexes = [
    'idx_request_detail_timestamp',
    'idx_request_detail_api_key',
    'idx_request_detail_account',
    'idx_request_detail_model',
    'idx_request_detail_endpoint',
    'idx_request_detail_expiry'
  ]
  const indexes = database
    ? database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'request_detail_records'"
        )
        .all()
        .map((row) => row.name)
    : []
  const columns = database ? database.pragma('table_info(request_detail_records)') : []
  const schemaValid =
    hasCurrentMetaColumns(database) &&
    ROW_COLUMNS.every((column) => columns.some((entry) => entry.name === column)) &&
    expectedIndexes.every((index) => indexes.includes(index))
  const fileBytes = {}
  if (databasePath) {
    for (const [name, suffix] of [
      ['database', ''],
      ['wal', '-wal'],
      ['shm', '-shm']
    ]) {
      try {
        fileBytes[name] = fs.statSync(`${databasePath}${suffix}`).size
      } catch (_error) {
        fileBytes[name] = 0
      }
    }
  }
  return {
    state: workerState,
    healthy: Boolean(database) && integrity === 'ok',
    integrity,
    schemaValid,
    fileBytes,
    memory: process.memoryUsage(),
    meta,
    rebuild: rebuildSession
      ? {
          sessionId: rebuildSession.sessionId,
          startedAt: rebuildSession.startedAt,
          lastBatchAt: rebuildSession.lastBatchAt,
          batches: rebuildSession.batches,
          rows: rebuildSession.rows
        }
      : null
  }
}

function upsertBatch({ rows }) {
  if (workerState !== 'idle' || !statements) {
    throw new Error(`Worker is ${workerState}; ordinary writes are unavailable`)
  }
  let changedExisting = false
  let inserted = 0
  let versionOnly = 0
  const transaction = database.transaction((batch) => {
    for (const row of batch) {
      const update = statements.updateChanged.run(row)
      if (update.changes > 0) {
        changedExisting = true
        continue
      }
      const insert = statements.insertIgnore.run(row)
      if (insert.changes > 0) {
        inserted += 1
        continue
      }
      versionOnly += statements.updateVersion.run(row).changes
    }
    if (changedExisting) {
      const epoch = Number(readMeta().mutation_epoch || 0) + 1
      writeMeta({ mutation_epoch: epoch })
    }
  })
  transaction(rows || [])
  return { changedExisting, inserted, versionOnly, meta: readMeta() }
}

function beginRebuild({ sessionId, destructive = false }) {
  if (workerState !== 'idle') {
    throw new Error(`Cannot begin rebuild while worker is ${workerState}`)
  }
  workerState = 'rebuilding'
  database.exec('BEGIN IMMEDIATE')
  try {
    if (destructive) {
      statements = null
      database.exec(
        'DROP TABLE IF EXISTS request_detail_records; DROP TABLE IF EXISTS request_detail_meta;'
      )
      createSchema(database)
      reprepareStatementsIfCompatible()
    } else if (statements) {
      database.exec('DELETE FROM request_detail_records')
    } else {
      throw new Error('An incompatible schema requires a destructive rebuild')
    }
    rebuildSession = {
      sessionId,
      startedAt: Date.now(),
      lastBatchAt: Date.now(),
      batches: 0,
      rows: 0,
      duplicateRows: 0
    }
    return getStatus()
  } catch (error) {
    database.exec('ROLLBACK')
    workerState = 'idle'
    rebuildSession = null
    reprepareStatementsIfCompatible()
    throw error
  }
}

function assertRebuildSession(sessionId) {
  if (workerState !== 'rebuilding' || !rebuildSession || rebuildSession.sessionId !== sessionId) {
    throw new Error('Stale or invalid rebuild session')
  }
}

function appendRebuildBatch({ sessionId, batchId, rows }) {
  assertRebuildSession(sessionId)
  if (batchId <= rebuildSession.batches) {
    return { duplicateBatch: true, ...rebuildSession }
  }
  if (batchId !== rebuildSession.batches + 1) {
    throw new Error('Out-of-order rebuild batch')
  }
  for (const row of rows || []) {
    const insert = statements.rebuildInsert.run(row)
    if (insert.changes > 0) {
      rebuildSession.rows += 1
    } else {
      statements.rebuildUpdate.run(row)
      rebuildSession.duplicateRows += 1
    }
  }
  rebuildSession.batches = batchId
  rebuildSession.lastBatchAt = Date.now()
  return { ...rebuildSession }
}

function commitRebuild({ sessionId, generation, buildSummary }) {
  assertRebuildSession(sessionId)
  workerState = 'committing'
  try {
    const expiredDeleted = database
      .prepare('DELETE FROM request_detail_records WHERE expires_at_ms <= ?')
      .run(Date.now()).changes
    const rowCount = database
      .prepare('SELECT COUNT(*) AS count FROM request_detail_records')
      .get().count
    const { duplicateRows } = rebuildSession
    const finalSummary = { ...buildSummary, rowCount, duplicateRows, expiredDeleted }
    writeMeta({
      schema_version: SCHEMA_VERSION,
      mapper_version: MAPPER_VERSION,
      generation,
      mutation_epoch: 0,
      full_rebuild_status: 'built_unverified',
      rebuild_complete: 1,
      build_summary: JSON.stringify(finalSummary),
      built_at: new Date().toISOString()
    })
    database.exec('COMMIT')
    workerState = 'idle'
    rebuildSession = null
    reprepareStatementsIfCompatible()
    database.exec('ANALYZE')
    database.pragma('wal_checkpoint(PASSIVE)')
    return {
      rowCount,
      duplicateRows,
      expiredDeleted,
      buildSummary: finalSummary,
      meta: readMeta()
    }
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch (_rollbackError) {
      // The transaction may already have ended; the coordinator will restart the Worker.
    }
    workerState = 'idle'
    rebuildSession = null
    reprepareStatementsIfCompatible()
    throw error
  }
}

function rollbackRebuild({ sessionId }) {
  assertRebuildSession(sessionId)
  database.exec('ROLLBACK')
  workerState = 'idle'
  rebuildSession = null
  reprepareStatementsIfCompatible()
  return getStatus()
}

function buildBaseWhere(input, { includeFilters = true } = {}) {
  const clauses = ['timestamp_ms >= ?', 'timestamp_ms <= ?', 'sequence <= ?', 'expires_at_ms > ?']
  const params = [input.startMs, input.endMs, input.snapshotSequence, input.snapshotCreatedAt]
  const isV2Scope = input.scopeType === 'v2'
  if (isV2Scope) {
    if (!jsonEachAvailable) {
      const error = new Error('SQLite JSON1 is unavailable for scoped request detail queries')
      error.code = 'REQUEST_DETAIL_SQLITE_JSON1_UNAVAILABLE'
      throw error
    }
    let childIds
    try {
      childIds = JSON.parse(input.apiKeyScopeJson)
    } catch (_error) {
      childIds = null
    }
    if (
      !Array.isArray(childIds) ||
      childIds.some((value) => typeof value !== 'string' || value.length === 0)
    ) {
      const error = new Error('Invalid V2 request detail scope')
      error.code = 'REQUEST_DETAIL_SQLITE_INVALID_SCOPE'
      throw error
    }
    clauses.push('api_key_id IN (SELECT value FROM json_each(?))')
    params.push(input.apiKeyScopeJson)
  }
  if (!includeFilters) {
    return { sql: clauses.join(' AND '), params }
  }

  const filters = input.filters || {}
  for (const [field, column] of [
    ['apiKeyId', 'api_key_id'],
    ['accountId', 'account_id'],
    ['model', 'model'],
    ['endpoint', 'endpoint']
  ]) {
    if (filters[field]) {
      clauses.push(`${column} = ?`)
      params.push(filters[field])
    }
  }

  const keyword = String(filters.keyword || '')
    .trim()
    .toLowerCase()
  if (keyword) {
    if (isV2Scope) {
      const keywordClauses = [
        "instr(lower(COALESCE(request_id, '')), ?) > 0",
        "instr(lower(COALESCE(api_key_id, '')), ?) > 0",
        "instr(lower(COALESCE(model, '')), ?) > 0",
        "instr(lower(COALESCE(endpoint, '')), ?) > 0",
        "instr(lower(COALESCE(method, '')), ?) > 0"
      ]
      params.push(keyword, keyword, keyword, keyword, keyword)
      let dynamicKeyIds = []
      try {
        dynamicKeyIds = JSON.parse(input.dynamicKeyIdsJson || '[]')
      } catch (_error) {
        dynamicKeyIds = null
      }
      if (!Array.isArray(dynamicKeyIds)) {
        const error = new Error('Invalid V2 request detail keyword scope')
        error.code = 'REQUEST_DETAIL_SQLITE_INVALID_SCOPE'
        throw error
      }
      if (dynamicKeyIds.length > 0) {
        keywordClauses.push('api_key_id IN (SELECT value FROM json_each(?))')
        params.push(input.dynamicKeyIdsJson)
      }
      clauses.push(`(${keywordClauses.join(' OR ')})`)
    } else {
      const keywordClauses = ['instr(search_text, ?) > 0']
      params.push(keyword)
      const dynamicKeyIds = Array.isArray(input.dynamicKeyIds) ? input.dynamicKeyIds : []
      if (dynamicKeyIds.length > 0) {
        keywordClauses.push(`api_key_id IN (${dynamicKeyIds.map(() => '?').join(',')})`)
        params.push(...dynamicKeyIds)
      }
      const dynamicAccounts = Array.isArray(input.dynamicAccounts) ? input.dynamicAccounts : []
      for (const account of dynamicAccounts) {
        keywordClauses.push('(account_id = ? AND account_type = ?)')
        params.push(account.accountId, account.accountType)
      }
      clauses.push(`(${keywordClauses.join(' OR ')})`)
    }
  }
  return { sql: clauses.join(' AND '), params }
}

function phaseA(input) {
  if (workerState !== 'idle') {
    throw new Error(`Worker is ${workerState}; queries are unavailable`)
  }
  const meta = readMeta()
  const snapshotCreatedAt = Number(input.snapshotCreatedAt || Date.now())
  const snapshotSequence = statements.maxSequence.get().value
  const base = {
    startMs: input.startMs,
    endMs: input.endMs,
    snapshotCreatedAt,
    snapshotSequence,
    scopeType: input.scopeType,
    apiKeyScopeJson: input.apiKeyScopeJson
  }
  const where = buildBaseWhere(base, { includeFilters: false })
  const source = database
    .prepare(
      `
      SELECT COUNT(*) AS count, MIN(timestamp_ms) AS earliest, MAX(timestamp_ms) AS latest
      FROM request_detail_records WHERE ${where.sql}
    `
    )
    .get(...where.params)
  if (!source.count) {
    return { source, snapshotCreatedAt, snapshotSequence, meta }
  }

  const apiKeyIds = database
    .prepare(
      `SELECT DISTINCT api_key_id AS value FROM request_detail_records WHERE ${where.sql} AND api_key_id IS NOT NULL`
    )
    .all(...where.params)
    .map((row) => row.value)
  let accounts = []
  let accountRepresentatives = []
  if (input.scopeType !== 'v2') {
    accounts = database
      .prepare(
        `SELECT DISTINCT account_id AS accountId, account_type AS accountType FROM request_detail_records WHERE ${where.sql} AND account_id IS NOT NULL`
      )
      .all(...where.params)
    const representativeDirection =
      input.hasKeyword === true
        ? input.sortOrder === 'asc'
          ? 'DESC'
          : 'ASC'
        : input.sortOrder === 'asc'
          ? 'ASC'
          : 'DESC'
    accountRepresentatives = database
      .prepare(
        `
        SELECT accountId, accountType FROM (
          SELECT account_id AS accountId, account_type AS accountType,
            ROW_NUMBER() OVER (
              PARTITION BY account_id
              ORDER BY timestamp_ms ${representativeDirection}, request_id ASC
            ) AS rank
          FROM request_detail_records
          WHERE ${where.sql} AND account_id IS NOT NULL
        ) WHERE rank = 1
      `
      )
      .all(...where.params)
  }
  const models = database
    .prepare(`SELECT DISTINCT model AS value FROM request_detail_records WHERE ${where.sql}`)
    .all(...where.params)
    .map((row) => row.value)
  const endpoints = database
    .prepare(
      `SELECT DISTINCT endpoint AS value FROM request_detail_records WHERE ${where.sql} AND endpoint IS NOT NULL`
    )
    .all(...where.params)
    .map((row) => row.value)
  return {
    source,
    snapshotCreatedAt,
    snapshotSequence,
    meta,
    apiKeyIds,
    accounts,
    accountRepresentatives,
    models,
    endpoints
  }
}

function phaseB(input) {
  if (workerState !== 'idle') {
    throw new Error(`Worker is ${workerState}; queries are unavailable`)
  }
  const where = buildBaseWhere(input)
  const aggregate = database
    .prepare(
      `
      SELECT
        COUNT(*) AS total_requests,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_create_tokens), 0) AS cache_create_tokens,
        COALESCE(SUM(cost_micros), 0) AS cost_micros,
        COALESCE(SUM(duration_ms), 0) AS duration_ms,
        COALESCE(SUM(cache_hit_numerator), 0) AS cache_hit_numerator,
        COALESCE(SUM(cache_hit_denominator), 0) AS cache_hit_denominator,
        COALESCE(SUM(cache_create_not_applicable), 0) AS cache_na_count,
        COALESCE(SUM(pricing_recompute_eligible), 0) AS eligible_count
      FROM request_detail_records WHERE ${where.sql}
    `
    )
    .get(...where.params)
  const totalRecords = Number(aggregate.total_requests || 0)
  const totalPages = totalRecords > 0 ? Math.ceil(totalRecords / input.pageSize) : 0
  const currentPage = totalPages > 0 ? Math.min(input.page, totalPages) : 1
  const offset = (currentPage - 1) * input.pageSize
  const direction = input.sortOrder === 'asc' ? 'ASC' : 'DESC'
  const pointers = database
    .prepare(
      `
      SELECT request_id AS requestId, timestamp_ms AS timestampMs
      FROM request_detail_records WHERE ${where.sql}
      ORDER BY timestamp_ms ${direction}, request_id ASC LIMIT ? OFFSET ?
    `
    )
    .all(...where.params, input.pageSize, offset)

  let eligible = []
  if (aggregate.eligible_count > 0 && aggregate.eligible_count <= input.recomputeLimit) {
    eligible = database
      .prepare(
        `SELECT request_id AS requestId, cost_micros AS costMicros FROM request_detail_records WHERE ${where.sql} AND pricing_recompute_eligible = 1`
      )
      .all(...where.params)
  }
  return { aggregate, totalRecords, totalPages, currentPage, pointers, eligible }
}

function pageQuery(input) {
  const meta = readMeta()
  if (
    meta.generation !== input.generation ||
    Number(meta.mutation_epoch || 0) !== Number(input.mutationEpoch)
  ) {
    return { stale: true }
  }
  if (Date.now() >= input.expiresAt) {
    return { stale: true }
  }
  const where = buildBaseWhere(input)
  const totalPages = input.totalRecords > 0 ? Math.ceil(input.totalRecords / input.pageSize) : 0
  const currentPage = totalPages > 0 ? Math.min(input.page, totalPages) : 1
  const direction = input.sortOrder === 'asc' ? 'ASC' : 'DESC'
  const pointers = database
    .prepare(
      `
      SELECT request_id AS requestId, timestamp_ms AS timestampMs
      FROM request_detail_records WHERE ${where.sql}
      ORDER BY timestamp_ms ${direction}, request_id ASC LIMIT ? OFFSET ?
    `
    )
    .all(...where.params, input.pageSize, (currentPage - 1) * input.pageSize)
  return { stale: false, pointers, currentPage, totalPages }
}

function verifySummary({ expiresAfterMs }) {
  return database
    .prepare(
      `
      SELECT COUNT(*) AS count,
        MIN(timestamp_ms) AS earliest,
        MAX(timestamp_ms) AS latest,
        COALESCE(SUM(input_tokens), 0) AS inputTokens,
        COALESCE(SUM(output_tokens), 0) AS outputTokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
        COALESCE(SUM(cache_create_tokens), 0) AS cacheCreateTokens,
        COALESCE(SUM(cost_micros), 0) AS costMicros,
        COALESCE(SUM(duration_ms), 0) AS durationMs,
        COALESCE(SUM(cache_hit_numerator), 0) AS cacheHitNumerator,
        COALESCE(SUM(cache_hit_denominator), 0) AS cacheHitDenominator,
        COALESCE(SUM(cache_create_not_applicable), 0) AS cacheNaCount
      FROM request_detail_records WHERE expires_at_ms > ?
    `
    )
    .get(expiresAfterMs)
}

function verifyRows({ expiresAfterMs, offset = 0, limit = 500 }) {
  return database
    .prepare(
      `
      SELECT request_id AS requestId,
        timestamp_ms AS timestampMs,
        api_key_id AS apiKeyId,
        account_id AS accountId,
        account_type AS accountType,
        model,
        endpoint,
        method,
        input_tokens AS inputTokens,
        output_tokens AS outputTokens,
        cache_read_tokens AS cacheReadTokens,
        cache_create_tokens AS cacheCreateTokens,
        cost_micros AS costMicros,
        duration_ms AS durationMs,
        cache_hit_numerator AS cacheHitNumerator,
        cache_hit_denominator AS cacheHitDenominator,
        cache_create_not_applicable AS cacheNa,
        pricing_recompute_eligible AS pricingEligible,
        search_text AS searchText
      FROM request_detail_records
      WHERE expires_at_ms > ?
      ORDER BY request_id ASC LIMIT ? OFFSET ?
    `
    )
    .all(expiresAfterMs, limit, offset)
}

function markVerified({ summary }) {
  writeMeta({
    full_rebuild_status: 'verified',
    verified_at: new Date().toISOString(),
    verify_summary: JSON.stringify(summary)
  })
  return readMeta()
}

function cleanup({ nowMs }) {
  if (workerState !== 'idle') {
    return { changes: 0 }
  }
  const result = statements.deleteExpired.run(nowMs)
  return { changes: result.changes }
}

function optimize() {
  database.pragma('optimize')
  database.pragma('wal_checkpoint(PASSIVE)')
  return getStatus()
}

function close() {
  workerState = 'closing'
  if (database) {
    if (rebuildSession) {
      try {
        database.exec('ROLLBACK')
      } catch (_error) {
        // Closing the connection is the final rollback fallback.
      }
    }
    database.close()
    database = null
  }
  return { closed: true }
}

const operations = {
  init: initialize,
  status: getStatus,
  upsertBatch,
  beginRebuild,
  appendRebuildBatch,
  commitRebuild,
  rollbackRebuild,
  phaseA,
  phaseB,
  page: pageQuery,
  verifySummary,
  verifyRows,
  markVerified,
  cleanup,
  optimize,
  close
}

parentPort.on('message', async (message) => {
  const { id, operation, payload } = message
  try {
    if (!operations[operation]) {
      throw new Error(`Unknown request detail index operation: ${operation}`)
    }
    const result = await operations[operation](payload || {})
    parentPort.postMessage({ id, ok: true, result })
  } catch (error) {
    parentPort.postMessage({
      id,
      ok: false,
      error: {
        message: error.message,
        stack: error.stack,
        code: error.code || null
      }
    })
  }
})
