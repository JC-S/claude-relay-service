const redis = require('../models/redis')
const logger = require('../utils/logger')
const claudeRelayConfigService = require('./claudeRelayConfigService')
const claudeAccountService = require('./account/claudeAccountService')
const claudeConsoleAccountService = require('./account/claudeConsoleAccountService')
const ccrAccountService = require('./account/ccrAccountService')
const geminiAccountService = require('./account/geminiAccountService')
const geminiApiAccountService = require('./account/geminiApiAccountService')
const openaiAccountService = require('./account/openaiAccountService')
const openaiResponsesAccountService = require('./account/openaiResponsesAccountService')
const azureOpenaiAccountService = require('./account/azureOpenaiAccountService')
const droidAccountService = require('./account/droidAccountService')
const grokAccountService = require('./account/grokAccountService')
const bedrockAccountService = require('./account/bedrockAccountService')
const CostCalculator = require('../utils/costCalculator')
const {
  sanitizeRequestBodySnapshot,
  getRequestDetailCacheMetrics,
  extractRequestReasoningInfo,
  resolveRequestDetailReasoning,
  CACHE_HIT_FORMULA
} = require('../utils/requestDetailHelper')
const { applyDisplayModelToRecord } = require('../utils/modelVariantHelper')
const serviceRatesService = require('./serviceRatesService')
const requestDetailIndex = require('./requestDetailIndex')
const {
  projectV2RequestDetailRecord,
  projectV2AvailableFilters
} = require('../utils/v2RequestDetailProjection')
const { v2RequestDetailGate } = require('../utils/v2RequestDetailGate')
const {
  PENDING_AGE_KEY,
  PENDING_VERSION_KEY,
  REQUEST_DETAIL_DAY_INDEX_PREFIX,
  REQUEST_DETAIL_ITEM_PREFIX,
  SNAPSHOT_BACKEND
} = require('./requestDetailIndex/constants')

const REQUEST_DETAIL_QUERY_SNAPSHOT_PREFIX = 'request_detail:query_snapshot:'
const DEFAULT_RETENTION_HOURS = 6
const MAX_RETENTION_HOURS = 30 * 24
const REQUEST_DETAIL_QUERY_BATCH_SIZE = 200
const REQUEST_DETAIL_SCAN_BATCH_SIZE = 200
const REQUEST_DETAIL_QUERY_SNAPSHOT_TTL_SECONDS = 30
const REQUEST_DETAIL_SQLITE_SNAPSHOT_TTL_SECONDS = 120
const MAX_REQUEST_DETAIL_SNAPSHOT_POINTERS = 25000
const MAX_REQUEST_DETAIL_SNAPSHOT_BYTES = 2 * 1024 * 1024
const MAX_V2_SQLITE_JSON_BYTES = 1024 * 1024

const accountTypeNames = {
  claude: 'Claude官方',
  'claude-official': 'Claude官方',
  'claude-console': 'Claude Console',
  ccr: 'Claude Console Relay',
  openai: 'OpenAI',
  'openai-responses': 'OpenAI Responses',
  'azure-openai': 'Azure OpenAI',
  gemini: 'Gemini',
  'gemini-api': 'Gemini API',
  droid: 'Droid',
  grok: 'Grok',
  bedrock: 'AWS Bedrock',
  unknown: '未知渠道'
}

const accountServices = {
  claude: claudeAccountService,
  'claude-console': claudeConsoleAccountService,
  ccr: ccrAccountService,
  openai: openaiAccountService,
  'openai-responses': openaiResponsesAccountService,
  'azure-openai': azureOpenaiAccountService,
  gemini: geminiAccountService,
  'gemini-api': geminiApiAccountService,
  droid: droidAccountService,
  grok: grokAccountService,
  bedrock: bedrockAccountService
}

function clampRetentionHours(value) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) {
    return DEFAULT_RETENTION_HOURS
  }
  return Math.min(Math.max(parsed, 1), MAX_RETENTION_HOURS)
}

function normalizeNumber(value, digits = null) {
  const num = Number(value)
  if (!Number.isFinite(num)) {
    return 0
  }

  if (digits === null) {
    return num
  }

  return Number(num.toFixed(digits))
}

function normalizeTokenValue(value) {
  return Math.max(0, Math.trunc(normalizeNumber(value)))
}

function normalizeServiceTierValue(value) {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function extractServiceTierFromPayload(payload) {
  if (!payload) {
    return null
  }

  if (typeof payload === 'object') {
    const directTier =
      normalizeServiceTierValue(payload.service_tier) ||
      normalizeServiceTierValue(payload.serviceTier)
    if (directTier) {
      return directTier
    }

    if (typeof payload.preview === 'string') {
      return extractServiceTierFromPayload(payload.preview)
    }

    return null
  }

  if (typeof payload !== 'string') {
    return null
  }

  try {
    return extractServiceTierFromPayload(JSON.parse(payload))
  } catch (error) {
    const match = payload.match(/["']service_?tier["']\s*:\s*["']([^"']+)["']/i)
    return normalizeServiceTierValue(match?.[1])
  }
}

function resolveRequestDetailServiceTier(detail = {}, requestBodySource = null) {
  return (
    normalizeServiceTierValue(detail.serviceTier) ||
    normalizeServiceTierValue(detail.service_tier) ||
    extractServiceTierFromPayload(requestBodySource)
  )
}

function buildCostUsageFromRequestDetail(record = {}) {
  const inputTokens = normalizeTokenValue(record.inputTokens)
  const outputTokens = normalizeTokenValue(record.outputTokens)
  const cacheCreateTokens = normalizeTokenValue(record.cacheCreateTokens)
  const cacheReadTokens = normalizeTokenValue(record.cacheReadTokens)
  const usage = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheCreateTokens,
    cache_read_input_tokens: cacheReadTokens
  }

  if (
    record.textInputTokens !== undefined ||
    record.imageInputTokens !== undefined ||
    record.imageOutputTokens !== undefined
  ) {
    usage.image_usage = {
      textInputTokens: normalizeTokenValue(record.textInputTokens),
      imageInputTokens: normalizeTokenValue(record.imageInputTokens),
      imageOutputTokens: normalizeTokenValue(record.imageOutputTokens),
      estimated: record.imageUsageBreakdownEstimated === true
    }
  }

  const ephemeral5mTokens = normalizeTokenValue(
    record.ephemeral5mTokens ?? record.cache_creation?.ephemeral_5m_input_tokens
  )
  const ephemeral1hTokens = normalizeTokenValue(
    record.ephemeral1hTokens ?? record.cache_creation?.ephemeral_1h_input_tokens
  )

  if (ephemeral5mTokens > 0 || ephemeral1hTokens > 0) {
    usage.cache_creation = {
      ephemeral_5m_input_tokens: ephemeral5mTokens,
      ephemeral_1h_input_tokens: ephemeral1hTokens
    }
  }

  return usage
}

function getCostResultNumber(costResult, key, fallbackKey = null) {
  return normalizeNumber(costResult?.costs?.[key] ?? costResult?.[fallbackKey] ?? 0, 12)
}

function buildCostBreakdownFromResult(costResult) {
  const input = getCostResultNumber(costResult, 'input', 'inputCost')
  const output = getCostResultNumber(costResult, 'output', 'outputCost')
  const cacheCreate =
    getCostResultNumber(costResult, 'cacheCreate', 'cacheCreateCost') ||
    getCostResultNumber(costResult, 'cacheWrite', 'cacheCreateCost')
  const cacheRead = getCostResultNumber(costResult, 'cacheRead', 'cacheReadCost')
  const ephemeral5m = getCostResultNumber(costResult, 'ephemeral5m', 'ephemeral5mCost')
  const ephemeral1h = getCostResultNumber(costResult, 'ephemeral1h', 'ephemeral1hCost')
  const total = getCostResultNumber(costResult, 'total', 'totalCost')
  const textInput = getCostResultNumber(costResult, 'textInput')
  const imageInput = getCostResultNumber(costResult, 'imageInput')
  const imageOutput = getCostResultNumber(costResult, 'imageOutput')

  return {
    input,
    output,
    cacheCreate,
    cacheWrite: cacheCreate,
    cacheRead,
    ephemeral5m,
    ephemeral1h,
    textInput,
    imageInput,
    imageOutput,
    total
  }
}

function createCostRecomputePatch(record = {}) {
  const storedCost = normalizeNumber(record.cost, 6)
  const storedRealCost = normalizeNumber(record.realCost, 6)
  if (storedCost > 0 || storedRealCost > 0) {
    return null
  }

  const usage = buildCostUsageFromRequestDetail(record)
  const totalTokens =
    usage.input_tokens +
    usage.output_tokens +
    usage.cache_creation_input_tokens +
    usage.cache_read_input_tokens
  if (totalTokens <= 0) {
    return null
  }

  try {
    const costResult = CostCalculator.calculateCost(
      usage,
      record.rawModel || record.model || 'unknown',
      record.serviceTier || null
    )
    const totalCost = normalizeNumber(costResult?.costs?.total ?? costResult?.totalCost ?? 0, 6)
    if (totalCost <= 0) {
      return null
    }

    const breakdown = buildCostBreakdownFromResult(costResult)
    const pricingSource =
      costResult?.debug?.pricingSource ||
      (costResult?.usingDynamicPricing ? 'dynamic' : 'unknown-fallback')

    return {
      cost: totalCost,
      realCost: totalCost,
      costBreakdown: breakdown,
      realCostBreakdown: breakdown,
      costRecomputed: true,
      usedFallbackPricing: costResult?.debug?.usedFallbackPricing === true,
      pricingSource
    }
  } catch (error) {
    logger.debug(`⚠️ Failed to recompute request detail cost: ${error.message}`)
    return null
  }
}

function prepareRecordForDisplay(record = {}) {
  const requestBodySource = record.requestBodySnapshot ?? record.requestBody
  const displaySource = {
    ...record,
    serviceTier: resolveRequestDetailServiceTier(record, requestBodySource)
  }
  const costPatch = createCostRecomputePatch(displaySource)

  return applyDisplayModelToRecord(costPatch ? { ...displaySource, ...costPatch } : displaySource)
}

function formatDayKey(date) {
  return date.toISOString().slice(0, 10)
}

function listDayKeys(startDate, endDate) {
  const keys = []
  const cursor = new Date(
    Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate())
  )
  const endCursor = new Date(
    Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate())
  )

  while (cursor <= endCursor) {
    keys.push(`${REQUEST_DETAIL_DAY_INDEX_PREFIX}${formatDayKey(cursor)}`)
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  return keys
}

function toIsoString(value) {
  if (!value) {
    return null
  }

  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    return null
  }

  return date.toISOString()
}

function toMillis(value) {
  if (value === null || value === undefined || value === '') {
    return null
  }

  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    return null
  }

  return date.getTime()
}

function safeJsonParse(value, label = 'request detail record') {
  if (!value) {
    return null
  }

  try {
    return JSON.parse(value)
  } catch (error) {
    logger.warn(`⚠️ Failed to parse ${label}: ${error.message}`)
    return null
  }
}

function makeRequestDetailId() {
  return `rd_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

function makeRequestDetailQuerySnapshotId() {
  return `rds_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

function normalizeOptionalFilterValue(value) {
  if (value === null || value === undefined) {
    return null
  }

  const normalized = String(value).trim()
  return normalized ? normalized : null
}

function createRequestDetailDateBoundarySignature(type, rawValue, effectiveValue, boundaryValue) {
  if (!rawValue) {
    return {
      mode: 'absent',
      value: null
    }
  }

  const rawDate = rawValue instanceof Date ? rawValue : new Date(rawValue)
  const effectiveIso = toIsoString(effectiveValue)
  if (type === 'start') {
    const floorDate =
      boundaryValue instanceof Date ? boundaryValue : new Date(boundaryValue || Date.now())
    if (rawDate.getTime() <= floorDate.getTime()) {
      return {
        mode: 'retention_floor',
        value: effectiveIso
      }
    }
  }

  if (type === 'end') {
    const ceilingDate =
      boundaryValue instanceof Date ? boundaryValue : new Date(boundaryValue || Date.now())
    if (rawDate.getTime() >= ceilingDate.getTime()) {
      return {
        mode: 'now_cap',
        value: effectiveIso
      }
    }
  }

  return {
    mode: 'fixed',
    value: rawDate.toISOString()
  }
}

function normalizeRequestDetailDateBoundarySignature(boundary = {}, legacyValue = null) {
  if (!boundary || typeof boundary !== 'object' || Array.isArray(boundary)) {
    return {
      mode: legacyValue ? 'fixed' : 'absent',
      value: toIsoString(legacyValue)
    }
  }

  const allowedModes = new Set(['absent', 'fixed', 'retention_floor', 'now_cap'])
  const mode = allowedModes.has(boundary.mode) ? boundary.mode : legacyValue ? 'fixed' : 'absent'
  return {
    mode,
    value: toIsoString(boundary.value)
  }
}

function createRequestDetailFilterSignature(
  filters = {},
  dateBoundarySignature = {},
  retentionHours = null,
  { scopeType = 'admin', scopeFingerprint = null } = {}
) {
  return {
    keyword: normalizeOptionalFilterValue(filters.keyword),
    apiKeyId: normalizeOptionalFilterValue(filters.apiKeyId),
    accountId: normalizeOptionalFilterValue(filters.accountId),
    model: normalizeOptionalFilterValue(filters.model),
    endpoint: normalizeOptionalFilterValue(filters.endpoint),
    sortOrder: filters.sortOrder === 'asc' ? 'asc' : 'desc',
    retentionHours:
      retentionHours !== null && retentionHours !== undefined ? Number(retentionHours) : null,
    scopeType: scopeType === 'v2' ? 'v2' : 'admin',
    scopeFingerprint: scopeType === 'v2' ? normalizeOptionalFilterValue(scopeFingerprint) : null,
    startBoundary: normalizeRequestDetailDateBoundarySignature(dateBoundarySignature.startBoundary),
    endBoundary: normalizeRequestDetailDateBoundarySignature(dateBoundarySignature.endBoundary)
  }
}

function requestDetailDateBoundarySignaturesMatch(snapshotBoundary, currentBoundary, type) {
  if (snapshotBoundary.mode === currentBoundary.mode) {
    if (snapshotBoundary.mode === 'fixed') {
      return snapshotBoundary.value === currentBoundary.value
    }
    return true
  }

  if (type === 'end') {
    return (
      snapshotBoundary.mode === 'now_cap' &&
      currentBoundary.mode === 'fixed' &&
      snapshotBoundary.value === currentBoundary.value
    )
  }

  return false
}

function requestDetailFilterSignaturesMatch(snapshotSignature, currentSignature) {
  const normalizedSnapshot = createRequestDetailFilterSignature(
    snapshotSignature,
    {
      startBoundary: snapshotSignature?.startBoundary || {
        mode: snapshotSignature?.startDate ? 'fixed' : 'absent',
        value: snapshotSignature?.startDate || null
      },
      endBoundary: snapshotSignature?.endBoundary || {
        mode: snapshotSignature?.endDate ? 'fixed' : 'absent',
        value: snapshotSignature?.endDate || null
      }
    },
    snapshotSignature?.retentionHours,
    {
      scopeType: snapshotSignature?.scopeType || 'admin',
      scopeFingerprint: snapshotSignature?.scopeFingerprint || null
    }
  )
  const normalizedCurrent = createRequestDetailFilterSignature(
    currentSignature,
    {
      startBoundary: currentSignature?.startBoundary,
      endBoundary: currentSignature?.endBoundary
    },
    currentSignature?.retentionHours,
    {
      scopeType: currentSignature?.scopeType || 'admin',
      scopeFingerprint: currentSignature?.scopeFingerprint || null
    }
  )

  return (
    normalizedSnapshot.keyword === normalizedCurrent.keyword &&
    normalizedSnapshot.apiKeyId === normalizedCurrent.apiKeyId &&
    normalizedSnapshot.accountId === normalizedCurrent.accountId &&
    normalizedSnapshot.model === normalizedCurrent.model &&
    normalizedSnapshot.endpoint === normalizedCurrent.endpoint &&
    normalizedSnapshot.sortOrder === normalizedCurrent.sortOrder &&
    normalizedSnapshot.retentionHours === normalizedCurrent.retentionHours &&
    normalizedSnapshot.scopeType === normalizedCurrent.scopeType &&
    normalizedSnapshot.scopeFingerprint === normalizedCurrent.scopeFingerprint &&
    requestDetailDateBoundarySignaturesMatch(
      normalizedSnapshot.startBoundary,
      normalizedCurrent.startBoundary,
      'start'
    ) &&
    requestDetailDateBoundarySignaturesMatch(
      normalizedSnapshot.endBoundary,
      normalizedCurrent.endBoundary,
      'end'
    )
  )
}

function flattenMatchedPointers(pointers = []) {
  const flattened = []

  for (const pointer of pointers) {
    const requestId = pointer?.requestId || null
    const timestampMs = Number(pointer?.timestampMs)

    if (!requestId || !Number.isFinite(timestampMs)) {
      continue
    }

    flattened.push(requestId, timestampMs)
  }

  return flattened
}

function inflateMatchedPointers(flattened = []) {
  const pointers = []

  for (let index = 0; index < flattened.length; index += 2) {
    const requestId = flattened[index]
    const timestampMs = Number(flattened[index + 1])

    if (!requestId || !Number.isFinite(timestampMs)) {
      continue
    }

    pointers.push({ requestId, timestampMs })
  }

  return pointers
}

class RequestDetailValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RequestDetailValidationError'
    this.statusCode = 400
  }
}

function createAvailableFilterAccumulator() {
  return {
    apiKeyMap: new Map(),
    accountMap: new Map(),
    modelSet: new Set(),
    endpointSet: new Set(),
    earliest: null,
    latest: null
  }
}

function updateAvailableFilterAccumulator(accumulator, record) {
  if (record.apiKeyId) {
    accumulator.apiKeyMap.set(record.apiKeyId, {
      id: record.apiKeyId,
      name: record.apiKeyName || record.apiKeyId
    })
  }

  if (record.accountId) {
    accumulator.accountMap.set(record.accountId, {
      id: record.accountId,
      name: record.accountName || record.accountId,
      accountType: record.accountType || 'unknown',
      accountTypeName:
        record.accountTypeName || accountTypeNames[record.accountType] || accountTypeNames.unknown
    })
  }

  if (record.model) {
    accumulator.modelSet.add(record.model)
  }

  if (record.endpoint) {
    accumulator.endpointSet.add(record.endpoint)
  }

  const ts = toMillis(record.timestamp)
  if (ts !== null) {
    if (accumulator.earliest === null || ts < accumulator.earliest) {
      accumulator.earliest = ts
    }
    if (accumulator.latest === null || ts > accumulator.latest) {
      accumulator.latest = ts
    }
  }
}

function updateAvailableFilterAccumulatorRaw(accumulator, record) {
  if (record.apiKeyId && !accumulator.apiKeyMap.has(record.apiKeyId)) {
    accumulator.apiKeyMap.set(record.apiKeyId, {
      id: record.apiKeyId,
      name: record.apiKeyId
    })
  }

  if (record.accountId && !accumulator.accountMap.has(record.accountId)) {
    accumulator.accountMap.set(record.accountId, {
      id: record.accountId,
      name: record.accountId,
      accountType: record.accountType || 'unknown',
      accountTypeName: accountTypeNames[record.accountType] || accountTypeNames.unknown
    })
  }

  if (record.model) {
    accumulator.modelSet.add(record.model)
  }

  if (record.endpoint) {
    accumulator.endpointSet.add(record.endpoint)
  }

  const ts = toMillis(record.timestamp)
  if (ts !== null) {
    if (accumulator.earliest === null || ts < accumulator.earliest) {
      accumulator.earliest = ts
    }
    if (accumulator.latest === null || ts > accumulator.latest) {
      accumulator.latest = ts
    }
  }
}

function restoreRecordTimestamp(record, fallbackTimestampMs) {
  if (!record) {
    return null
  }

  if (toMillis(record.timestamp) !== null) {
    return record
  }

  const timestampMs = Number(fallbackTimestampMs)
  if (Number.isFinite(timestampMs)) {
    record.timestamp = new Date(timestampMs).toISOString()
  }

  return record
}

function finalizeAvailableFilters(accumulator) {
  return {
    apiKeys: Array.from(accumulator.apiKeyMap.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    ),
    accounts: Array.from(accumulator.accountMap.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    ),
    models: Array.from(accumulator.modelSet).sort((a, b) => a.localeCompare(b)),
    endpoints: Array.from(accumulator.endpointSet).sort((a, b) => a.localeCompare(b)),
    dateRange: {
      earliest: accumulator.earliest !== null ? new Date(accumulator.earliest).toISOString() : null,
      latest: accumulator.latest !== null ? new Date(accumulator.latest).toISOString() : null
    }
  }
}

function finalizeV2AvailableFilters(accumulator) {
  const filters = finalizeAvailableFilters(accumulator)
  return projectV2AvailableFilters(filters)
}

function normalizeV2Context(context) {
  if (!context) {
    return null
  }
  if (context.projection !== 'v2' || context.scopeType !== 'v2') {
    throw new RequestDetailValidationError('Invalid request detail projection context')
  }

  const scope = context.apiKeyScope
  const childIds = scope?.childIds
  const expectedChildIds = Array.isArray(childIds)
    ? [...new Set(childIds.map(String).filter(Boolean))].sort()
    : null
  if (
    !expectedChildIds ||
    expectedChildIds.length !== childIds.length ||
    childIds.some((value, index) => value !== expectedChildIds[index]) ||
    !(scope.childIdSet instanceof Set) ||
    scope.childIdSet.size !== childIds.length ||
    childIds.some((value) => !scope.childIdSet.has(value)) ||
    !(scope.childMap instanceof Map) ||
    !normalizeOptionalFilterValue(scope.scopeFingerprint)
  ) {
    throw new RequestDetailValidationError('Invalid V2 request detail scope')
  }

  return {
    projection: 'v2',
    scopeType: 'v2',
    apiKeyScope: scope
  }
}

function createSummaryAccumulator() {
  return {
    totalRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    totalCost: 0,
    totalDurationMs: 0,
    cacheHitNumerator: 0,
    cacheHitDenominator: 0,
    cacheCreateNotApplicableRequests: 0
  }
}

function updateSummaryAccumulator(accumulator, record) {
  const cacheMetrics = getRequestDetailCacheMetrics(record)

  accumulator.totalRequests += 1
  accumulator.inputTokens += normalizeNumber(record.inputTokens)
  accumulator.outputTokens += normalizeNumber(record.outputTokens)
  accumulator.cacheReadTokens += normalizeNumber(record.cacheReadTokens)
  if (!cacheMetrics.cacheCreateNotApplicable) {
    accumulator.cacheCreateTokens += normalizeNumber(record.cacheCreateTokens)
  }
  accumulator.totalCost += normalizeNumber(record.cost)
  accumulator.totalDurationMs += normalizeNumber(record.durationMs)
  accumulator.cacheHitNumerator += cacheMetrics.numerator
  accumulator.cacheHitDenominator += cacheMetrics.denominator
  if (cacheMetrics.cacheCreateNotApplicable) {
    accumulator.cacheCreateNotApplicableRequests += 1
  }
}

function finalizeSummary(accumulator) {
  return {
    totalRequests: accumulator.totalRequests,
    inputTokens: accumulator.inputTokens,
    outputTokens: accumulator.outputTokens,
    cacheReadTokens: accumulator.cacheReadTokens,
    cacheCreateTokens: accumulator.cacheCreateTokens,
    totalCost: Number(accumulator.totalCost.toFixed(6)),
    avgDurationMs:
      accumulator.totalRequests > 0
        ? Math.round(accumulator.totalDurationMs / accumulator.totalRequests)
        : 0,
    cacheHitRate:
      accumulator.cacheHitDenominator > 0
        ? Number(
            ((accumulator.cacheHitNumerator / accumulator.cacheHitDenominator) * 100).toFixed(2)
          )
        : 0,
    cacheHitNumerator: accumulator.cacheHitNumerator,
    cacheHitDenominator: accumulator.cacheHitDenominator,
    cacheHitFormula: CACHE_HIT_FORMULA,
    cacheCreateNotApplicable:
      accumulator.totalRequests > 0 &&
      accumulator.cacheCreateNotApplicableRequests === accumulator.totalRequests
  }
}

class RequestDetailService {
  async getSettings() {
    const config = await claudeRelayConfigService.getConfig()
    return {
      captureEnabled: config.requestDetailCaptureEnabled === true,
      retentionHours: clampRetentionHours(config.requestDetailRetentionHours),
      bodyPreviewEnabled: config.requestDetailBodyPreviewEnabled === true
    }
  }

  _emptyListResult(settings, filters = {}) {
    return {
      captureEnabled: settings.captureEnabled,
      retentionHours: settings.retentionHours,
      bodyPreviewEnabled: settings.bodyPreviewEnabled,
      snapshotId: null,
      records: [],
      pagination: {
        currentPage: 1,
        pageSize: Number.parseInt(filters.pageSize, 10) || 50,
        totalRecords: 0,
        totalPages: 0,
        hasNextPage: false,
        hasPreviousPage: false
      },
      filters: {
        startDate: filters.startDate || null,
        endDate: filters.endDate || null,
        keyword: filters.keyword || null,
        apiKeyId: filters.apiKeyId || null,
        accountId: filters.accountId || null,
        model: filters.model || null,
        endpoint: filters.endpoint || null,
        hasCustomDateRange: Boolean(filters.startDate || filters.endDate),
        sortOrder: filters.sortOrder === 'asc' ? 'asc' : 'desc'
      },
      availableFilters: {
        apiKeys: [],
        accounts: [],
        models: [],
        endpoints: [],
        dateRange: {
          earliest: null,
          latest: null
        }
      },
      summary: {
        totalRequests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        totalCost: 0,
        avgDurationMs: 0,
        cacheHitRate: 0,
        cacheHitNumerator: 0,
        cacheHitDenominator: 0,
        cacheHitFormula: CACHE_HIT_FORMULA,
        cacheCreateNotApplicable: false
      }
    }
  }

  _normalizeRecord(detail, requestId, options = {}) {
    const requestBodySource = detail.requestBodySnapshot ?? detail.requestBody
    const serviceTier = resolveRequestDetailServiceTier(detail, requestBodySource)
    const timestamp = toIsoString(detail.timestamp) || new Date().toISOString()
    const durationMs = normalizeNumber(detail.durationMs)
    const inputTokens = normalizeNumber(detail.inputTokens)
    const outputTokens = normalizeNumber(detail.outputTokens)
    const cacheReadTokens = normalizeNumber(detail.cacheReadTokens)
    const cacheCreateTokens = normalizeNumber(detail.cacheCreateTokens)
    const hasImageUsage =
      detail.textInputTokens !== undefined ||
      detail.imageInputTokens !== undefined ||
      detail.imageOutputTokens !== undefined
    const totalTokens =
      normalizeNumber(detail.totalTokens) ||
      inputTokens + outputTokens + cacheReadTokens + cacheCreateTokens
    const statusCode = normalizeNumber(detail.statusCode)
    const cost = normalizeNumber(detail.cost, 6)
    const realCost = normalizeNumber(detail.realCost, 6)
    const reasoningInfo = extractRequestReasoningInfo(requestBodySource)
    const normalized = applyDisplayModelToRecord({
      requestId,
      timestamp,
      requestStartedAt: toIsoString(detail.requestStartedAt),
      endpoint: detail.endpoint || null,
      method: detail.method || null,
      statusCode,
      stream: detail.stream === true,
      apiKeyId: detail.apiKeyId || null,
      accountId: detail.accountId || null,
      accountType: detail.accountType || 'unknown',
      model: detail.model || 'unknown',
      serviceTier,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreateTokens,
      ...(hasImageUsage
        ? {
            textInputTokens: normalizeNumber(detail.textInputTokens),
            imageInputTokens: normalizeNumber(detail.imageInputTokens),
            imageOutputTokens: normalizeNumber(detail.imageOutputTokens),
            imageUsageBreakdownEstimated: detail.imageUsageBreakdownEstimated === true
          }
        : {}),
      totalTokens,
      cost,
      realCost,
      costBreakdown: detail.costBreakdown || null,
      realCostBreakdown: detail.realCostBreakdown || null,
      pricingSource: detail.pricingSource || null,
      usedFallbackPricing: detail.usedFallbackPricing === true,
      costRecomputed: detail.costRecomputed === true,
      durationMs,
      upstreamNicIp: normalizeOptionalFilterValue(detail.upstreamNicIp) || null,
      clientIp: normalizeOptionalFilterValue(detail.clientIp) || null,
      upstreamRequestId: normalizeOptionalFilterValue(detail.upstreamRequestId) || null,
      downstreamHttpStatus:
        detail.downstreamHttpStatus === undefined
          ? null
          : normalizeNumber(detail.downstreamHttpStatus),
      upstreamHttpStatus:
        detail.upstreamHttpStatus === undefined ? null : normalizeNumber(detail.upstreamHttpStatus),
      upstreamSemanticStatus:
        detail.upstreamSemanticStatus === undefined
          ? null
          : normalizeNumber(detail.upstreamSemanticStatus),
      terminalType: normalizeOptionalFilterValue(detail.terminalType) || null,
      errorType: normalizeOptionalFilterValue(detail.errorType) || null,
      errorCode: normalizeOptionalFilterValue(detail.errorCode) || null,
      requestedModel: normalizeOptionalFilterValue(detail.requestedModel) || null,
      mappedModel: normalizeOptionalFilterValue(detail.mappedModel) || null,
      actualModel: normalizeOptionalFilterValue(detail.actualModel) || null,
      billingModel: normalizeOptionalFilterValue(detail.billingModel) || null,
      firstTokenLatencyMs:
        detail.firstTokenLatencyMs === undefined
          ? null
          : normalizeNumber(detail.firstTokenLatencyMs),
      isLongContextRequest: detail.isLongContextRequest === true,
      reasoningDisplay: detail.reasoningDisplay || reasoningInfo.reasoningDisplay || null,
      reasoningSource: detail.reasoningSource || reasoningInfo.reasoningSource || null
    })

    if (options.bodyPreviewEnabled && requestBodySource !== undefined) {
      normalized.requestBodySnapshot = sanitizeRequestBodySnapshot(requestBodySource)
    }

    return normalized
  }

  async captureRequestDetail(detail = {}) {
    try {
      const settings = await this.getSettings()
      if (!settings.captureEnabled) {
        return { captured: false, reason: 'disabled' }
      }

      const client = redis.getClient()
      if (!client) {
        return { captured: false, reason: 'redis_unavailable' }
      }

      const requestId = detail.requestId || makeRequestDetailId()
      const normalized = this._normalizeRecord(detail, requestId, {
        bodyPreviewEnabled: settings.bodyPreviewEnabled
      })
      const timestampMs = toMillis(normalized.timestamp) || Date.now()
      const itemKey = `${REQUEST_DETAIL_ITEM_PREFIX}${requestId}`
      const dayKey = `${REQUEST_DETAIL_DAY_INDEX_PREFIX}${formatDayKey(new Date(timestampMs))}`
      const ttlSeconds = Math.max(3600, settings.retentionHours * 3600)
      const indexTtlSeconds = ttlSeconds + 86400
      const indexEnabled = requestDetailIndex.isEnabled()
      const sourceVersion = indexEnabled
        ? `${Date.now()}-${Math.random().toString(36).slice(2, 14)}`
        : null
      const transaction = client
        .multi()
        .set(itemKey, JSON.stringify(normalized), 'EX', ttlSeconds)
        .zadd(dayKey, timestampMs, requestId)
        .expire(dayKey, indexTtlSeconds)
      if (indexEnabled) {
        transaction
          .hset(PENDING_VERSION_KEY, requestId, sourceVersion)
          .zadd(PENDING_AGE_KEY, Date.now(), requestId)
      }
      await transaction.exec()

      if (indexEnabled) {
        requestDetailIndex
          .notifyCapture(
            {
              ...normalized,
              expiresAtMs: Date.now() + ttlSeconds * 1000
            },
            sourceVersion
          )
          .catch((error) => {
            logger.debug(`Request detail SQLite notification deferred: ${error.message}`)
          })
      }

      return { captured: true, requestId }
    } catch (error) {
      logger.warn(`⚠️ Failed to capture request detail: ${error.message}`)
      return { captured: false, reason: 'error', message: error.message }
    }
  }

  async _loadRequestPointersInRange(startDate, endDate) {
    const client = redis.getClient()
    if (!client) {
      return []
    }

    const startMs = startDate.getTime()
    const endMs = endDate.getTime()
    const dayKeys = listDayKeys(startDate, endDate)
    const requestIds = []

    for (const dayKey of dayKeys) {
      try {
        const entries = await client.zrangebyscore(dayKey, startMs, endMs, 'WITHSCORES')
        if (Array.isArray(entries) && entries.length > 0) {
          for (let index = 0; index < entries.length; index += 2) {
            const requestId = entries[index]
            const timestampMs = Number(entries[index + 1])
            if (requestId && Number.isFinite(timestampMs)) {
              requestIds.push({ requestId, timestampMs })
            }
          }
        }
      } catch (error) {
        logger.warn(`⚠️ Failed to load request detail index ${dayKey}: ${error.message}`)
      }
    }

    const uniqueRequestIds = new Map()
    for (const item of requestIds) {
      uniqueRequestIds.set(item.requestId, item.timestampMs)
    }

    return Array.from(uniqueRequestIds.entries()).map(([requestId, timestampMs]) => ({
      requestId,
      timestampMs
    }))
  }

  async _scanRequestDetailItemKeys(visitor) {
    const client = redis.getClient()
    if (!client) {
      return
    }

    let cursor = '0'
    do {
      const [nextCursor, keys] = await client.scan(
        cursor,
        'MATCH',
        `${REQUEST_DETAIL_ITEM_PREFIX}*`,
        'COUNT',
        REQUEST_DETAIL_SCAN_BATCH_SIZE
      )
      cursor = nextCursor
      if (Array.isArray(keys) && keys.length > 0) {
        await visitor(keys, client)
      }
    } while (cursor !== '0')
  }

  async getRequestBodyPreviewStats() {
    const settings = await this.getSettings()
    let snapshotCount = 0

    await this._scanRequestDetailItemKeys(async (keys, client) => {
      const rawItems = await client.mget(keys)
      for (const rawItem of rawItems) {
        const parsed = safeJsonParse(rawItem)
        if (
          parsed &&
          Object.prototype.hasOwnProperty.call(parsed, 'requestBodySnapshot') &&
          parsed.requestBodySnapshot !== undefined
        ) {
          snapshotCount += 1
        }
      }
    })

    return {
      captureEnabled: settings.captureEnabled,
      retentionHours: settings.retentionHours,
      bodyPreviewEnabled: settings.bodyPreviewEnabled,
      snapshotCount,
      hasSnapshots: snapshotCount > 0
    }
  }

  async purgeRequestBodySnapshots() {
    let updatedRecords = 0

    await this._scanRequestDetailItemKeys(async (keys, client) => {
      const rawItems = await client.mget(keys)
      const pipeline = requestDetailIndex.isEnabled()
        ? client.multi()
        : typeof client.pipeline === 'function'
          ? client.pipeline()
          : client.multi()
      let hasMutations = false

      rawItems.forEach((rawItem, index) => {
        const parsed = safeJsonParse(rawItem)
        if (
          !parsed ||
          !Object.prototype.hasOwnProperty.call(parsed, 'requestBodySnapshot') ||
          parsed.requestBodySnapshot === undefined
        ) {
          return
        }

        const resolvedServiceTier = resolveRequestDetailServiceTier(
          parsed,
          parsed.requestBodySnapshot
        )
        if (resolvedServiceTier) {
          parsed.serviceTier = resolvedServiceTier
        }
        delete parsed.requestBodySnapshot
        pipeline.set(keys[index], JSON.stringify(parsed), 'KEEPTTL')
        if (requestDetailIndex.isEnabled()) {
          const requestId = parsed.requestId || keys[index].slice(REQUEST_DETAIL_ITEM_PREFIX.length)
          const sourceVersion = `${Date.now()}-${Math.random().toString(36).slice(2, 14)}`
          pipeline.hset(PENDING_VERSION_KEY, requestId, sourceVersion)
          pipeline.zadd(PENDING_AGE_KEY, Date.now(), requestId)
        }
        hasMutations = true
        updatedRecords += 1
      })

      if (hasMutations) {
        await pipeline.exec()
      }
    })

    return {
      updatedRecords
    }
  }

  async _getApiKeyName(keyId, cache) {
    if (!keyId) {
      return null
    }

    if (cache.has(keyId)) {
      return cache.get(keyId)
    }

    try {
      const keyData = await redis.getApiKey(keyId)
      const keyName = keyData?.name || keyData?.label || keyId
      cache.set(keyId, keyName)
      return keyName
    } catch (error) {
      logger.debug(`⚠️ Failed to resolve API key ${keyId}: ${error.message}`)
      cache.set(keyId, keyId)
      return keyId
    }
  }

  async _resolveAccountInfo(accountId, accountType, cache) {
    if (!accountId) {
      return null
    }

    const normalizedType = accountType || 'unknown'
    const cacheKey = `${normalizedType}:${accountId}`
    if (cache.has(cacheKey)) {
      return cache.get(cacheKey)
    }

    const preferredService = accountServices[normalizedType]
    const servicesToTry = preferredService
      ? [
          [normalizedType, preferredService],
          ...Object.entries(accountServices).filter(([type]) => type !== normalizedType)
        ]
      : Object.entries(accountServices)

    for (const [type, service] of servicesToTry) {
      try {
        let account = await service.getAccount(accountId)
        if (account && typeof account === 'object' && 'success' in account) {
          account = account.success ? account.data : null
        }
        if (account) {
          const info = {
            accountId,
            accountName: account.name || account.email || accountId,
            accountType: type,
            accountTypeName: accountTypeNames[type] || accountTypeNames.unknown
          }
          cache.set(cacheKey, info)
          return info
        }
      } catch (error) {
        logger.debug(`⚠️ Failed to resolve account ${accountId} from ${type}: ${error.message}`)
      }
    }

    const fallback = {
      accountId,
      accountName: accountId,
      accountType: normalizedType,
      accountTypeName: accountTypeNames[normalizedType] || accountTypeNames.unknown
    }
    cache.set(cacheKey, fallback)
    return fallback
  }

  async _resolveFilterDisplayNames(accumulator) {
    const apiKeyCache = new Map()
    const accountCache = new Map()

    for (const [keyId, entry] of accumulator.apiKeyMap) {
      const name = await this._getApiKeyName(keyId, apiKeyCache)
      if (name) {
        entry.name = name
      }
    }

    for (const [accountId, entry] of accumulator.accountMap) {
      const accountInfo = await this._resolveAccountInfo(accountId, entry.accountType, accountCache)
      if (accountInfo) {
        entry.name = accountInfo.accountName
        entry.accountTypeName = accountInfo.accountTypeName
      }
    }
  }

  async _findRequestTimestampInRange(requestId, startDate, endDate, client = redis.getClient()) {
    if (!requestId || !client) {
      return null
    }

    const dayKeys = listDayKeys(startDate, endDate)
    if (dayKeys.length === 0) {
      return null
    }

    const startMs = startDate.getTime()
    const endMs = endDate.getTime()

    if (typeof client.pipeline === 'function') {
      const pipeline = client.pipeline()
      dayKeys.forEach((dayKey) => {
        pipeline.zscore(dayKey, requestId)
      })

      const results = await pipeline.exec()
      if (Array.isArray(results)) {
        for (let index = 0; index < results.length; index += 1) {
          const [error, score] = results[index] || []
          if (error) {
            logger.debug(
              `⚠️ Failed to resolve request detail timestamp from ${dayKeys[index]}: ${error.message}`
            )
            continue
          }

          const timestampMs = Number(score)
          if (Number.isFinite(timestampMs) && timestampMs >= startMs && timestampMs <= endMs) {
            return timestampMs
          }
        }
      }

      return null
    }

    if (typeof client.zscore !== 'function') {
      return null
    }

    for (const dayKey of dayKeys) {
      try {
        const score = await client.zscore(dayKey, requestId)
        const timestampMs = Number(score)
        if (Number.isFinite(timestampMs) && timestampMs >= startMs && timestampMs <= endMs) {
          return timestampMs
        }
      } catch (error) {
        logger.debug(
          `⚠️ Failed to resolve request detail timestamp from ${dayKey}: ${error.message}`
        )
      }
    }

    return null
  }

  async _enrichRecords(records = [], apiKeyCache = new Map(), accountCache = new Map()) {
    const enriched = []

    for (const record of records) {
      const displayRecord = prepareRecordForDisplay(record)
      const cacheMetrics = getRequestDetailCacheMetrics(displayRecord)
      const reasoningInfo = resolveRequestDetailReasoning(displayRecord)
      const apiKeyName = await this._getApiKeyName(displayRecord.apiKeyId, apiKeyCache)
      const accountInfo = await this._resolveAccountInfo(
        displayRecord.accountId,
        displayRecord.accountType,
        accountCache
      )

      enriched.push({
        ...displayRecord,
        apiKeyName: apiKeyName || displayRecord.apiKeyId || '未知 Key',
        accountName: accountInfo?.accountName || displayRecord.accountId || '未知账户',
        accountType: accountInfo?.accountType || displayRecord.accountType || 'unknown',
        accountTypeName:
          accountInfo?.accountTypeName ||
          accountTypeNames[displayRecord.accountType] ||
          accountTypeNames.unknown,
        isOpenAIRelated: cacheMetrics.isOpenAIRelated,
        cacheCreateNotApplicable: cacheMetrics.cacheCreateNotApplicable,
        cacheHitRate: cacheMetrics.rate,
        cacheHitNumerator: cacheMetrics.numerator,
        cacheHitDenominator: cacheMetrics.denominator,
        cacheHitFormula: cacheMetrics.cacheHitFormula,
        hasRequestBodySnapshot: Boolean(displayRecord.requestBodySnapshot),
        reasoningDisplay: reasoningInfo.reasoningDisplay,
        reasoningSource: reasoningInfo.reasoningSource
      })
    }

    return enriched
  }

  async _prepareV2RecordForDisplay(record, apiKeyScope) {
    const displayRecord = prepareRecordForDisplay(record)
    const cacheMetrics = getRequestDetailCacheMetrics(displayRecord)
    const reasoningInfo = resolveRequestDetailReasoning(displayRecord)
    let { cost } = displayRecord

    if (displayRecord.costRecomputed === true) {
      const service = serviceRatesService.getService(
        displayRecord.accountType,
        displayRecord.rawModel || displayRecord.model
      )
      cost = await serviceRatesService.calculateRatedCostWithKeyRates(
        displayRecord.realCost,
        service,
        apiKeyScope.parentServiceRates
      )
    }

    return {
      ...displayRecord,
      cost: normalizeNumber(cost, 6),
      cacheCreateNotApplicable: cacheMetrics.cacheCreateNotApplicable,
      cacheHitRate: cacheMetrics.rate,
      cacheHitNumerator: cacheMetrics.numerator,
      cacheHitDenominator: cacheMetrics.denominator,
      reasoningDisplay: reasoningInfo.reasoningDisplay,
      reasoningSource: reasoningInfo.reasoningSource
    }
  }

  _getV2ApiKeyName(apiKeyScope, apiKeyId) {
    const child = apiKeyScope.childMap.get(apiKeyId)
    if (!child) {
      return apiKeyId || '未知 Key'
    }
    return child.isDeleted ? `${child.name}（已删除）` : child.name
  }

  async _prepareAndProjectV2Record(record, apiKeyScope) {
    if (!record?.apiKeyId || !apiKeyScope.childIdSet.has(record.apiKeyId)) {
      return null
    }
    const displayRecord = await this._prepareV2RecordForDisplay(record, apiKeyScope)
    if (!apiKeyScope.childIdSet.has(displayRecord.apiKeyId)) {
      return null
    }
    return projectV2RequestDetailRecord({
      ...displayRecord,
      apiKeyName: this._getV2ApiKeyName(apiKeyScope, displayRecord.apiKeyId)
    })
  }

  _matchesKeyword(record, keyword, isV2 = false) {
    if (!keyword) {
      return true
    }

    const normalizedKeyword = String(keyword).trim().toLowerCase()
    if (!normalizedKeyword) {
      return true
    }

    const haystacks = [
      record.requestId,
      record.apiKeyId,
      record.apiKeyName,
      record.model,
      record.endpoint,
      record.method
    ]
    if (!isV2) {
      haystacks.push(record.accountId, record.accountName, record.accountTypeName)
    }

    return haystacks.some((value) =>
      String(value || '')
        .toLowerCase()
        .includes(normalizedKeyword)
    )
  }

  _matchesStructuredFilters(record, filters = {}, isV2 = false) {
    if (filters.apiKeyId && record.apiKeyId !== filters.apiKeyId) {
      return false
    }
    if (!isV2 && filters.accountId && record.accountId !== filters.accountId) {
      return false
    }
    if (filters.model && record.model !== filters.model) {
      return false
    }
    if (filters.endpoint && record.endpoint !== filters.endpoint) {
      return false
    }

    return true
  }

  _buildResponseFilters(filters, effectiveStart, effectiveEnd, sortOrder) {
    return {
      startDate: effectiveStart.toISOString(),
      endDate: effectiveEnd.toISOString(),
      keyword: filters.keyword || null,
      apiKeyId: filters.apiKeyId || null,
      accountId: filters.accountId || null,
      model: filters.model || null,
      endpoint: filters.endpoint || null,
      hasCustomDateRange: Boolean(filters.startDate || filters.endDate),
      sortOrder
    }
  }

  _hydrateRawRecord(rawItem, pointer = {}) {
    const parsedRecord = restoreRecordTimestamp(
      safeJsonParse(rawItem),
      Number(pointer?.timestampMs) || Date.now()
    )

    if (!parsedRecord) {
      return null
    }

    if (!parsedRecord.requestId && pointer?.requestId) {
      parsedRecord.requestId = pointer.requestId
    }

    parsedRecord.serviceTier = resolveRequestDetailServiceTier(
      parsedRecord,
      parsedRecord.requestBodySnapshot ?? parsedRecord.requestBody
    )

    return applyDisplayModelToRecord(parsedRecord)
  }

  async _loadPointerBatchRecords(pointerBatch = [], client = redis.getClient()) {
    if (!client || !Array.isArray(pointerBatch) || pointerBatch.length === 0) {
      return []
    }

    const itemKeys = pointerBatch.map(
      ({ requestId }) => `${REQUEST_DETAIL_ITEM_PREFIX}${requestId}`
    )
    const rawItems = await client.mget(itemKeys)
    const records = []

    rawItems.forEach((rawItem, index) => {
      const pointer = pointerBatch[index]
      const record = this._hydrateRawRecord(rawItem, pointer)
      if (record) {
        records.push({ record, pointer })
      }
    })

    return records
  }

  async _loadRecordsForPointers(pointers = [], client = redis.getClient()) {
    const recordItems = await this._loadPointerBatchRecords(pointers, client)
    return recordItems.map(({ record }) => record)
  }

  _paginateMatchedPointers(matchedPointers = [], requestedPage = 1, pageSize = 50) {
    const totalRecords = matchedPointers.length
    const totalPages = totalRecords > 0 ? Math.ceil(totalRecords / pageSize) : 0
    const currentPage = totalPages > 0 ? Math.min(requestedPage, totalPages) : 1
    const pageStart = (currentPage - 1) * pageSize
    const pageEnd = pageStart + pageSize

    return {
      currentPage,
      totalRecords,
      totalPages,
      pagePointers: matchedPointers.slice(pageStart, pageEnd)
    }
  }

  async _buildPageRecords(pagePointers = [], context = null) {
    if (!Array.isArray(pagePointers) || pagePointers.length === 0) {
      return []
    }

    const rawRecords = await this._loadRecordsForPointers(pagePointers)
    if (context?.scopeType === 'v2') {
      const projected = []
      for (const record of rawRecords) {
        const safeRecord = await this._prepareAndProjectV2Record(record, context.apiKeyScope)
        if (safeRecord) {
          projected.push(safeRecord)
        }
      }
      return projected
    }
    const enrichedRecords = await this._enrichRecords(rawRecords)

    return enrichedRecords.map((record) => ({
      ...record,
      requestBodySnapshot: undefined
    }))
  }

  async _buildV2ListQueryData(filters, effectiveStart, effectiveEnd, sortOrder, context) {
    const requestPointers = await this._loadRequestPointersInRange(effectiveStart, effectiveEnd)
    if (requestPointers.length === 0) {
      return {
        hasSourceRecords: false,
        matchedPointers: [],
        availableFilters: finalizeV2AvailableFilters(createAvailableFilterAccumulator()),
        summary: finalizeSummary(createSummaryAccumulator())
      }
    }

    requestPointers.sort((a, b) =>
      sortOrder === 'asc' ? a.timestampMs - b.timestampMs : b.timestampMs - a.timestampMs
    )
    const availableFilterAccumulator = createAvailableFilterAccumulator()
    const summaryAccumulator = createSummaryAccumulator()
    const matchedPointers = []
    const client = redis.getClient()
    const { apiKeyScope } = context

    for (
      let startIndex = 0;
      startIndex < requestPointers.length;
      startIndex += REQUEST_DETAIL_QUERY_BATCH_SIZE
    ) {
      const pointerBatch = requestPointers.slice(
        startIndex,
        startIndex + REQUEST_DETAIL_QUERY_BATCH_SIZE
      )
      const recordItems = await this._loadPointerBatchRecords(pointerBatch, client)
      for (const { record, pointer } of recordItems) {
        if (!record.apiKeyId || !apiKeyScope.childIdSet.has(record.apiKeyId)) {
          continue
        }
        const displayRecord = await this._prepareV2RecordForDisplay(record, apiKeyScope)
        displayRecord.apiKeyName = this._getV2ApiKeyName(apiKeyScope, displayRecord.apiKeyId)
        updateAvailableFilterAccumulator(availableFilterAccumulator, displayRecord)
        if (
          !this._matchesStructuredFilters(displayRecord, filters, true) ||
          !this._matchesKeyword(displayRecord, filters.keyword, true)
        ) {
          continue
        }
        updateSummaryAccumulator(summaryAccumulator, displayRecord)
        matchedPointers.push({
          requestId: displayRecord.requestId,
          timestampMs: toMillis(displayRecord.timestamp) ?? pointer.timestampMs
        })
      }
    }

    return {
      hasSourceRecords: true,
      matchedPointers,
      availableFilters: finalizeV2AvailableFilters(availableFilterAccumulator),
      summary: finalizeSummary(summaryAccumulator)
    }
  }

  async _buildListQueryData(filters, effectiveStart, effectiveEnd, sortOrder, context = null) {
    if (context?.scopeType === 'v2') {
      return this._buildV2ListQueryData(filters, effectiveStart, effectiveEnd, sortOrder, context)
    }
    const requestPointers = await this._loadRequestPointersInRange(effectiveStart, effectiveEnd)
    if (requestPointers.length === 0) {
      return {
        hasSourceRecords: false,
        matchedPointers: [],
        availableFilters: {
          apiKeys: [],
          accounts: [],
          models: [],
          endpoints: [],
          dateRange: {
            earliest: null,
            latest: null
          }
        },
        summary: finalizeSummary(createSummaryAccumulator())
      }
    }

    requestPointers.sort((a, b) =>
      sortOrder === 'asc' ? a.timestampMs - b.timestampMs : b.timestampMs - a.timestampMs
    )

    const availableFilterAccumulator = createAvailableFilterAccumulator()
    const summaryAccumulator = createSummaryAccumulator()
    const matchedPointers = []
    const client = redis.getClient()
    const hasKeyword = Boolean(filters.keyword?.trim())

    if (hasKeyword) {
      const apiKeyCache = new Map()
      const accountCache = new Map()

      for (
        let startIndex = 0;
        startIndex < requestPointers.length;
        startIndex += REQUEST_DETAIL_QUERY_BATCH_SIZE
      ) {
        const pointerBatch = requestPointers.slice(
          startIndex,
          startIndex + REQUEST_DETAIL_QUERY_BATCH_SIZE
        )
        const recordItems = await this._loadPointerBatchRecords(pointerBatch, client)
        const enrichedBatch = await this._enrichRecords(
          recordItems.map(({ record }) => record),
          apiKeyCache,
          accountCache
        )

        enrichedBatch.forEach((record, index) => {
          updateAvailableFilterAccumulator(availableFilterAccumulator, record)

          if (
            !this._matchesStructuredFilters(record, filters) ||
            !this._matchesKeyword(record, filters.keyword)
          ) {
            return
          }

          updateSummaryAccumulator(summaryAccumulator, record)

          matchedPointers.push({
            requestId: record.requestId,
            timestampMs: toMillis(record.timestamp) ?? recordItems[index].pointer.timestampMs
          })
        })
      }
    } else {
      for (
        let startIndex = 0;
        startIndex < requestPointers.length;
        startIndex += REQUEST_DETAIL_QUERY_BATCH_SIZE
      ) {
        const pointerBatch = requestPointers.slice(
          startIndex,
          startIndex + REQUEST_DETAIL_QUERY_BATCH_SIZE
        )
        const recordItems = await this._loadPointerBatchRecords(pointerBatch, client)

        for (const { record, pointer } of recordItems) {
          updateAvailableFilterAccumulatorRaw(availableFilterAccumulator, record)

          if (!this._matchesStructuredFilters(record, filters)) {
            continue
          }

          const displayRecord = prepareRecordForDisplay(record)
          updateSummaryAccumulator(summaryAccumulator, displayRecord)

          matchedPointers.push({
            requestId: displayRecord.requestId,
            timestampMs: toMillis(displayRecord.timestamp) ?? pointer.timestampMs
          })
        }
      }

      await this._resolveFilterDisplayNames(availableFilterAccumulator)
    }

    return {
      hasSourceRecords: true,
      matchedPointers,
      availableFilters: finalizeAvailableFilters(availableFilterAccumulator),
      summary: finalizeSummary(summaryAccumulator)
    }
  }

  async _loadQuerySnapshot(snapshotId, filterSignature, client = redis.getClient()) {
    if (!snapshotId || !client || typeof client.get !== 'function') {
      return null
    }

    let rawSnapshot
    try {
      rawSnapshot = await client.get(`${REQUEST_DETAIL_QUERY_SNAPSHOT_PREFIX}${snapshotId}`)
    } catch (error) {
      logger.warn(`⚠️ Failed to read request detail query snapshot: ${error.message}`)
      return null
    }

    const parsedSnapshot = safeJsonParse(rawSnapshot, 'request detail query snapshot')
    if (
      !parsedSnapshot ||
      !requestDetailFilterSignaturesMatch(parsedSnapshot.filterSignature, filterSignature)
    ) {
      return null
    }

    const snapshotTtl =
      parsedSnapshot.backend === SNAPSHOT_BACKEND
        ? REQUEST_DETAIL_SQLITE_SNAPSHOT_TTL_SECONDS
        : REQUEST_DETAIL_QUERY_SNAPSHOT_TTL_SECONDS
    if (parsedSnapshot.backend === SNAPSHOT_BACKEND) {
      parsedSnapshot.expiresAt = Date.now() + snapshotTtl * 1000
    }
    if (typeof client.expire === 'function') {
      try {
        await client.expire(`${REQUEST_DETAIL_QUERY_SNAPSHOT_PREFIX}${snapshotId}`, snapshotTtl)
      } catch (error) {
        logger.warn(`⚠️ Failed to renew request detail query snapshot TTL: ${error.message}`)
      }
    }

    if (parsedSnapshot.backend === SNAPSHOT_BACKEND) {
      return {
        ...parsedSnapshot,
        snapshotId,
        filters: parsedSnapshot.filters || null
      }
    }

    return {
      snapshotId,
      matchedPointers: inflateMatchedPointers(parsedSnapshot.matchedPointers),
      availableFilters: parsedSnapshot.availableFilters || {
        apiKeys: [],
        accounts: [],
        models: [],
        endpoints: [],
        dateRange: {
          earliest: null,
          latest: null
        }
      },
      summary: parsedSnapshot.summary || finalizeSummary(createSummaryAccumulator()),
      filters: parsedSnapshot.filters || null
    }
  }

  async _storeQuerySnapshot(filterSignature, queryData, responseFilters, sortOrder) {
    const client = redis.getClient()
    if (!client || typeof client.set !== 'function') {
      return null
    }

    if (queryData.matchedPointers.length > MAX_REQUEST_DETAIL_SNAPSHOT_POINTERS) {
      return null
    }

    const snapshotPayload = {
      filterSignature,
      matchedPointers: flattenMatchedPointers(queryData.matchedPointers),
      summary: queryData.summary,
      availableFilters: queryData.availableFilters,
      filters: responseFilters,
      sortOrder,
      createdAt: new Date().toISOString()
    }

    const serializedSnapshot = JSON.stringify(snapshotPayload)
    if (Buffer.byteLength(serializedSnapshot, 'utf8') > MAX_REQUEST_DETAIL_SNAPSHOT_BYTES) {
      return null
    }

    const snapshotId = makeRequestDetailQuerySnapshotId()
    try {
      await client.set(
        `${REQUEST_DETAIL_QUERY_SNAPSHOT_PREFIX}${snapshotId}`,
        serializedSnapshot,
        'EX',
        REQUEST_DETAIL_QUERY_SNAPSHOT_TTL_SECONDS
      )
    } catch (error) {
      logger.warn(`⚠️ Failed to store request detail query snapshot: ${error.message}`)
      return null
    }

    return snapshotId
  }

  async _storeSqliteQuerySnapshot(filterSignature, queryData, responseFilters, sortOrder) {
    const client = redis.getClient()
    if (!client || typeof client.set !== 'function') {
      return null
    }
    const snapshotId = makeRequestDetailQuerySnapshotId()
    const payload = {
      backend: SNAPSHOT_BACKEND,
      filterSignature,
      generation: queryData.generation,
      mutationEpoch: queryData.mutationEpoch,
      snapshotSequence: queryData.snapshotSequence,
      snapshotCreatedAt: queryData.snapshotCreatedAt,
      expiresAt: Date.now() + REQUEST_DETAIL_SQLITE_SNAPSHOT_TTL_SECONDS * 1000,
      startMs: queryData.startMs,
      endMs: queryData.endMs,
      dynamicKeyIds: queryData.dynamicKeyIds,
      dynamicKeyIdsJson: queryData.dynamicKeyIdsJson,
      dynamicAccounts: queryData.dynamicAccounts,
      summary: queryData.summary,
      availableFilters: queryData.availableFilters,
      totalRecords: queryData.totalRecords,
      filters: responseFilters,
      sortOrder,
      createdAt: new Date().toISOString()
    }
    try {
      await client.set(
        `${REQUEST_DETAIL_QUERY_SNAPSHOT_PREFIX}${snapshotId}`,
        JSON.stringify(payload),
        'EX',
        REQUEST_DETAIL_SQLITE_SNAPSHOT_TTL_SECONDS
      )
      return snapshotId
    } catch (error) {
      logger.warn(`⚠️ Failed to store SQLite request detail query snapshot: ${error.message}`)
      return null
    }
  }

  async _resolveSqliteDimensions(phaseA, keyword, context = null) {
    const accumulator = createAvailableFilterAccumulator()
    const apiKeyCache = new Map()
    const accountCache = new Map()
    const normalizedKeyword = String(keyword || '')
      .trim()
      .toLowerCase()
    const dynamicKeyIds = []
    const dynamicAccounts = []

    for (const keyId of phaseA.apiKeyIds || []) {
      const name =
        context?.scopeType === 'v2'
          ? this._getV2ApiKeyName(context.apiKeyScope, keyId)
          : (await this._getApiKeyName(keyId, apiKeyCache)) || keyId
      accumulator.apiKeyMap.set(keyId, { id: keyId, name })
      if (normalizedKeyword && String(name).toLowerCase().includes(normalizedKeyword)) {
        dynamicKeyIds.push(keyId)
      }
    }

    if (context?.scopeType !== 'v2') {
      const representativeById = new Map(
        (phaseA.accountRepresentatives || []).map((account) => [account.accountId, account])
      )
      for (const account of phaseA.accounts || []) {
        const info = await this._resolveAccountInfo(
          account.accountId,
          account.accountType,
          accountCache
        )
        if (normalizedKeyword && info?.accountType !== account.accountType) {
          const error = new Error('Resolved request detail account type differs from stored type')
          error.code = 'REQUEST_DETAIL_SQLITE_PARITY_FALLBACK'
          throw error
        }
        const representative = representativeById.get(account.accountId) || account
        let entry = accumulator.accountMap.get(account.accountId)
        if (!entry && representative.accountType === account.accountType) {
          entry = {
            id: account.accountId,
            name: info?.accountName || account.accountId,
            accountType: info?.accountType || account.accountType || 'unknown',
            accountTypeName:
              info?.accountTypeName ||
              accountTypeNames[account.accountType] ||
              accountTypeNames.unknown
          }
          accumulator.accountMap.set(account.accountId, entry)
        }
        entry ||= {
          id: account.accountId,
          name: info?.accountName || account.accountId,
          accountType: info?.accountType || account.accountType || 'unknown',
          accountTypeName:
            info?.accountTypeName ||
            accountTypeNames[account.accountType] ||
            accountTypeNames.unknown
        }
        if (
          normalizedKeyword &&
          [entry.name, entry.accountTypeName].some((value) =>
            String(value || '')
              .toLowerCase()
              .includes(normalizedKeyword)
          )
        ) {
          dynamicAccounts.push({
            accountId: account.accountId,
            accountType: account.accountType
          })
        }
      }
    }

    for (const model of phaseA.models || []) {
      accumulator.modelSet.add(model)
    }
    for (const endpoint of phaseA.endpoints || []) {
      accumulator.endpointSet.add(endpoint)
    }
    accumulator.earliest = phaseA.source?.earliest ?? null
    accumulator.latest = phaseA.source?.latest ?? null
    if (context?.scopeType !== 'v2' && dynamicKeyIds.length + dynamicAccounts.length * 2 > 450) {
      const error = new Error('Too many dynamic request detail keyword bindings')
      error.code = 'REQUEST_DETAIL_SQLITE_PARITY_FALLBACK'
      throw error
    }
    const dynamicKeyIdsJson =
      context?.scopeType === 'v2' ? JSON.stringify(dynamicKeyIds.sort()) : null
    if (
      dynamicKeyIdsJson &&
      Buffer.byteLength(dynamicKeyIdsJson, 'utf8') > MAX_V2_SQLITE_JSON_BYTES
    ) {
      const error = new Error('V2 request detail keyword scope is too large')
      error.code = 'REQUEST_DETAIL_SQLITE_V2_SCOPE_TOO_LARGE'
      throw error
    }
    return {
      availableFilters:
        context?.scopeType === 'v2'
          ? finalizeV2AvailableFilters(accumulator)
          : finalizeAvailableFilters(accumulator),
      dynamicKeyIds,
      dynamicAccounts,
      dynamicKeyIdsJson
    }
  }

  async _applySqliteEligibleCostAdjustment(aggregate, eligible = [], context = null) {
    let totalCostMicros = Number(aggregate.cost_micros || 0)
    if (!eligible.length) {
      return totalCostMicros
    }
    const client = redis.getClient()
    const rawItems = await client.mget(
      eligible.map(({ requestId }) => `${REQUEST_DETAIL_ITEM_PREFIX}${requestId}`)
    )
    for (let index = 0; index < rawItems.length; index += 1) {
      const rawItem = rawItems[index]
      const record = safeJsonParse(rawItem)
      if (!record) {
        continue
      }
      if (context?.scopeType === 'v2' && !context.apiKeyScope.childIdSet.has(record.apiKeyId)) {
        continue
      }
      const displayRecord =
        context?.scopeType === 'v2'
          ? await this._prepareV2RecordForDisplay(record, context.apiKeyScope)
          : prepareRecordForDisplay(record)
      totalCostMicros +=
        Math.round(normalizeNumber(displayRecord.cost, 6) * 1e6) -
        Number(eligible[index].costMicros || 0)
    }
    return totalCostMicros
  }

  _finalizeSqliteSummary(aggregate, totalCostMicros) {
    const totalRequests = Number(aggregate.total_requests || 0)
    const numerator = Number(aggregate.cache_hit_numerator || 0)
    const denominator = Number(aggregate.cache_hit_denominator || 0)
    return {
      totalRequests,
      inputTokens: Number(aggregate.input_tokens || 0),
      outputTokens: Number(aggregate.output_tokens || 0),
      cacheReadTokens: Number(aggregate.cache_read_tokens || 0),
      cacheCreateTokens: Number(aggregate.cache_create_tokens || 0),
      totalCost: Number((totalCostMicros / 1e6).toFixed(6)),
      avgDurationMs:
        totalRequests > 0 ? Math.round(Number(aggregate.duration_ms || 0) / totalRequests) : 0,
      cacheHitRate: denominator > 0 ? Number(((numerator / denominator) * 100).toFixed(2)) : 0,
      cacheHitNumerator: numerator,
      cacheHitDenominator: denominator,
      cacheHitFormula: CACHE_HIT_FORMULA,
      cacheCreateNotApplicable:
        totalRequests > 0 && Number(aggregate.cache_na_count || 0) === totalRequests
    }
  }

  _getSqliteV2ScopePayload(context) {
    if (context?.scopeType !== 'v2') {
      return {}
    }
    const apiKeyScopeJson = JSON.stringify(context.apiKeyScope.childIds)
    if (Buffer.byteLength(apiKeyScopeJson, 'utf8') > MAX_V2_SQLITE_JSON_BYTES) {
      const error = new Error('V2 request detail scope is too large')
      error.code = 'REQUEST_DETAIL_SQLITE_V2_SCOPE_TOO_LARGE'
      throw error
    }
    return {
      scopeType: 'v2',
      apiKeyScopeJson
    }
  }

  async _buildSqliteListResponse({
    settings,
    filters,
    responseFilters,
    filterSignature,
    effectiveStart,
    effectiveEnd,
    page,
    pageSize,
    sortOrder,
    context = null
  }) {
    const scopePayload = this._getSqliteV2ScopePayload(context)
    const sessionId = requestDetailIndex.beginQuerySession()
    if (!sessionId) {
      throw new Error('Request detail SQLite query admission rejected')
    }
    try {
      const phaseA = await requestDetailIndex.phaseA(sessionId, {
        startMs: effectiveStart.getTime(),
        endMs: effectiveEnd.getTime(),
        snapshotCreatedAt: Date.now(),
        sortOrder,
        hasKeyword: Boolean(filters.keyword?.trim()),
        ...scopePayload
      })
      if (!phaseA.source?.count) {
        requestDetailIndex.endQuerySession(sessionId)
        return {
          ...this._emptyListResult(settings, filters),
          filters: responseFilters
        }
      }
      const dimensions = await this._resolveSqliteDimensions(phaseA, filters.keyword, context)
      const phaseB = await requestDetailIndex.phaseB(sessionId, {
        startMs: effectiveStart.getTime(),
        endMs: effectiveEnd.getTime(),
        snapshotCreatedAt: phaseA.snapshotCreatedAt,
        snapshotSequence: phaseA.snapshotSequence,
        filters,
        dynamicKeyIds: dimensions.dynamicKeyIds,
        dynamicKeyIdsJson: dimensions.dynamicKeyIdsJson,
        dynamicAccounts: dimensions.dynamicAccounts,
        page,
        pageSize,
        sortOrder,
        recomputeLimit: requestDetailIndex.config.recomputeLimit,
        ...scopePayload
      })
      if (Number(phaseB.aggregate.eligible_count || 0) > requestDetailIndex.config.recomputeLimit) {
        const error = new Error('Request detail SQLite pricing recompute limit exceeded')
        error.code = 'REQUEST_DETAIL_SQLITE_RECOMPUTE_LIMIT'
        throw error
      }
      const totalCostMicros = await this._applySqliteEligibleCostAdjustment(
        phaseB.aggregate,
        phaseB.eligible,
        context
      )
      const summary = this._finalizeSqliteSummary(phaseB.aggregate, totalCostMicros)
      const queryData = {
        generation: phaseA.meta.generation,
        mutationEpoch: Number(phaseA.meta.mutation_epoch || 0),
        snapshotSequence: phaseA.snapshotSequence,
        snapshotCreatedAt: phaseA.snapshotCreatedAt,
        startMs: effectiveStart.getTime(),
        endMs: effectiveEnd.getTime(),
        dynamicKeyIds: dimensions.dynamicKeyIds,
        dynamicKeyIdsJson: dimensions.dynamicKeyIdsJson,
        dynamicAccounts: dimensions.dynamicAccounts,
        summary,
        availableFilters: dimensions.availableFilters,
        totalRecords: phaseB.totalRecords
      }
      const snapshotId = await this._storeSqliteQuerySnapshot(
        filterSignature,
        queryData,
        responseFilters,
        sortOrder
      )
      const records = await this._buildPageRecords(phaseB.pointers, context)
      return {
        captureEnabled: settings.captureEnabled,
        retentionHours: settings.retentionHours,
        bodyPreviewEnabled: settings.bodyPreviewEnabled,
        snapshotId,
        records,
        pagination: {
          currentPage: phaseB.currentPage,
          pageSize,
          totalRecords: phaseB.totalRecords,
          totalPages: phaseB.totalPages,
          hasNextPage: phaseB.totalPages > 0 && phaseB.currentPage < phaseB.totalPages,
          hasPreviousPage: phaseB.totalPages > 0 && phaseB.currentPage > 1
        },
        filters: responseFilters,
        availableFilters: dimensions.availableFilters,
        summary
      }
    } catch (error) {
      requestDetailIndex.endQuerySession(sessionId)
      throw error
    }
  }

  async _buildSqliteSnapshotPage(
    snapshot,
    settings,
    responseFilters,
    filters,
    page,
    pageSize,
    context = null
  ) {
    const scopePayload = this._getSqliteV2ScopePayload(context)
    const result = await requestDetailIndex.page({
      generation: snapshot.generation,
      mutationEpoch: snapshot.mutationEpoch,
      expiresAt: snapshot.expiresAt,
      startMs: snapshot.startMs,
      endMs: snapshot.endMs,
      snapshotCreatedAt: snapshot.snapshotCreatedAt,
      snapshotSequence: snapshot.snapshotSequence,
      filters,
      dynamicKeyIds: snapshot.dynamicKeyIds || [],
      dynamicKeyIdsJson: snapshot.dynamicKeyIdsJson || '[]',
      dynamicAccounts: snapshot.dynamicAccounts || [],
      totalRecords: snapshot.totalRecords,
      page,
      pageSize,
      sortOrder: snapshot.sortOrder,
      ...scopePayload
    })
    if (result.stale) {
      const error = new Error('Request detail SQLite snapshot is stale')
      error.code = 'REQUEST_DETAIL_SQLITE_STALE_SNAPSHOT'
      throw error
    }
    const records = await this._buildPageRecords(result.pointers, context)
    return {
      captureEnabled: settings.captureEnabled,
      retentionHours: settings.retentionHours,
      bodyPreviewEnabled: settings.bodyPreviewEnabled,
      snapshotId: snapshot.snapshotId,
      records,
      pagination: {
        currentPage: result.currentPage,
        pageSize,
        totalRecords: snapshot.totalRecords,
        totalPages: result.totalPages,
        hasNextPage: result.totalPages > 0 && result.currentPage < result.totalPages,
        hasPreviousPage: result.totalPages > 0 && result.currentPage > 1
      },
      filters: snapshot.filters || responseFilters,
      availableFilters: snapshot.availableFilters,
      summary: snapshot.summary
    }
  }

  async _buildListResponse({
    settings,
    responseFilters,
    matchedPointers,
    availableFilters,
    summary,
    page,
    pageSize,
    snapshotId = null,
    context = null
  }) {
    const pagination = this._paginateMatchedPointers(matchedPointers, page, pageSize)
    const pageRecords = await this._buildPageRecords(pagination.pagePointers, context)

    return {
      captureEnabled: settings.captureEnabled,
      retentionHours: settings.retentionHours,
      bodyPreviewEnabled: settings.bodyPreviewEnabled,
      snapshotId,
      records: pageRecords,
      pagination: {
        currentPage: pagination.currentPage,
        pageSize,
        totalRecords: pagination.totalRecords,
        totalPages: pagination.totalPages,
        hasNextPage: pagination.totalPages > 0 && pagination.currentPage < pagination.totalPages,
        hasPreviousPage: pagination.totalPages > 0 && pagination.currentPage > 1
      },
      filters: responseFilters,
      availableFilters,
      summary
    }
  }

  async _runColdListQuery({
    settings,
    emptyResult,
    filters,
    responseFilters,
    filterSignature,
    effectiveStart,
    effectiveEnd,
    page,
    pageSize,
    sortOrder,
    context
  }) {
    if (requestDetailIndex.shouldUseSqlite() && (await requestDetailIndex.prepareForQuery())) {
      try {
        return await this._buildSqliteListResponse({
          settings,
          filters,
          responseFilters,
          filterSignature,
          effectiveStart,
          effectiveEnd,
          page,
          pageSize,
          sortOrder,
          context
        })
      } catch (error) {
        logger.debug(`Request detail SQLite query fallback: ${error.message}`)
        requestDetailIndex.recordFallback(error.code || 'query_error')
      }
    }

    const queryData = await this._buildListQueryData(
      filters,
      effectiveStart,
      effectiveEnd,
      sortOrder,
      context
    )
    if (!queryData.hasSourceRecords) {
      return {
        ...emptyResult,
        captureEnabled: settings.captureEnabled,
        retentionHours: settings.retentionHours,
        bodyPreviewEnabled: settings.bodyPreviewEnabled,
        snapshotId: null,
        filters: responseFilters,
        availableFilters:
          context?.scopeType === 'v2'
            ? projectV2AvailableFilters(emptyResult.availableFilters)
            : emptyResult.availableFilters
      }
    }

    const snapshotId = await this._storeQuerySnapshot(
      filterSignature,
      queryData,
      responseFilters,
      sortOrder
    )

    return this._buildListResponse({
      settings,
      responseFilters,
      matchedPointers: queryData.matchedPointers,
      availableFilters: queryData.availableFilters,
      summary: queryData.summary,
      page,
      pageSize,
      snapshotId,
      context
    })
  }

  async listRequestDetails(filters = {}, rawContext = null) {
    const context = normalizeV2Context(rawContext)
    filters = {
      ...filters,
      apiKeyId: normalizeOptionalFilterValue(filters.apiKeyId),
      accountId: context ? null : normalizeOptionalFilterValue(filters.accountId),
      model: normalizeOptionalFilterValue(filters.model),
      endpoint: normalizeOptionalFilterValue(filters.endpoint)
    }
    if (context && filters.apiKeyId && !context.apiKeyScope.childIdSet.has(filters.apiKeyId)) {
      throw new RequestDetailValidationError('API key is outside the V2 request detail scope')
    }
    const settings = await this.getSettings()
    const emptyResult = this._emptyListResult(settings, filters)
    if (context && context.apiKeyScope.childIds.length === 0) {
      return {
        ...emptyResult,
        captureEnabled: undefined,
        retentionHours: undefined,
        bodyPreviewEnabled: undefined,
        filters: undefined,
        availableFilters: projectV2AvailableFilters(emptyResult.availableFilters)
      }
    }

    const now = new Date()
    const retentionStart = new Date(now.getTime() - settings.retentionHours * 3600 * 1000)
    const startDate = filters.startDate ? new Date(filters.startDate) : retentionStart
    const endDate = filters.endDate ? new Date(filters.endDate) : now

    const effectiveStart = startDate < retentionStart ? retentionStart : startDate
    const effectiveEnd = endDate > now ? now : endDate

    if (Number.isNaN(effectiveStart.getTime()) || Number.isNaN(effectiveEnd.getTime())) {
      throw new RequestDetailValidationError('Invalid date range')
    }

    if (effectiveStart > effectiveEnd) {
      throw new RequestDetailValidationError('Start date must be before or equal to end date')
    }

    const page = Math.max(Number.parseInt(filters.page, 10) || 1, 1)
    const pageSize = Math.min(Math.max(Number.parseInt(filters.pageSize, 10) || 50, 1), 200)
    const sortOrder = filters.sortOrder === 'asc' ? 'asc' : 'desc'
    const responseFilters = this._buildResponseFilters(
      filters,
      effectiveStart,
      effectiveEnd,
      sortOrder
    )
    const filterSignature = createRequestDetailFilterSignature(
      filters,
      {
        startBoundary: createRequestDetailDateBoundarySignature(
          'start',
          filters.startDate,
          effectiveStart,
          retentionStart
        ),
        endBoundary: createRequestDetailDateBoundarySignature(
          'end',
          filters.endDate,
          effectiveEnd,
          now
        )
      },
      settings.retentionHours,
      context
        ? {
            scopeType: 'v2',
            scopeFingerprint: context.apiKeyScope.scopeFingerprint
          }
        : undefined
    )

    let snapshot = await this._loadQuerySnapshot(filters.snapshotId, filterSignature)
    if (snapshot) {
      if (snapshot.backend === SNAPSHOT_BACKEND) {
        if (requestDetailIndex.shouldUseSqlite() && (await requestDetailIndex.prepareForQuery())) {
          try {
            return await this._buildSqliteSnapshotPage(
              snapshot,
              settings,
              responseFilters,
              filters,
              page,
              pageSize,
              context
            )
          } catch (error) {
            logger.debug(`Request detail SQLite page fallback: ${error.message}`)
            requestDetailIndex.recordFallback(error.code || 'page_error')
          }
        }
        snapshot = null
        filters = { ...filters, snapshotId: null }
      }
    }
    if (snapshot) {
      return this._buildListResponse({
        settings,
        responseFilters: snapshot.filters || responseFilters,
        matchedPointers: snapshot.matchedPointers,
        availableFilters: snapshot.availableFilters,
        summary: snapshot.summary,
        page,
        pageSize,
        snapshotId: snapshot.snapshotId,
        context
      })
    }

    const coldQuery = () =>
      this._runColdListQuery({
        settings,
        emptyResult,
        filters,
        responseFilters,
        filterSignature,
        effectiveStart,
        effectiveEnd,
        page,
        pageSize,
        sortOrder,
        context
      })
    return context ? v2RequestDetailGate.run(coldQuery) : coldQuery()
  }

  async getV2RequestDetail(requestId, rawContext) {
    const context = normalizeV2Context(rawContext)
    const client = redis.getClient()
    if (!client) {
      return null
    }
    const raw = await client.get(`${REQUEST_DETAIL_ITEM_PREFIX}${requestId}`)
    const parsed = safeJsonParse(raw)
    if (!parsed || !parsed.apiKeyId || !context.apiKeyScope.childIdSet.has(parsed.apiKeyId)) {
      return null
    }

    const settings = await this.getSettings()
    const timestampMs = toMillis(parsed.timestamp)
    const retentionStartMs = Date.now() - settings.retentionHours * 3600 * 1000
    if (timestampMs === null || timestampMs < retentionStartMs || timestampMs > Date.now()) {
      return null
    }

    return this._prepareAndProjectV2Record(parsed, context.apiKeyScope)
  }

  async getRequestDetail(requestId) {
    const settings = await this.getSettings()
    const client = redis.getClient()
    if (!client) {
      return {
        captureEnabled: settings.captureEnabled,
        retentionHours: settings.retentionHours,
        bodyPreviewEnabled: settings.bodyPreviewEnabled,
        record: null
      }
    }

    const raw = await client.get(`${REQUEST_DETAIL_ITEM_PREFIX}${requestId}`)
    const parsed = safeJsonParse(raw)
    if (!parsed) {
      return {
        captureEnabled: settings.captureEnabled,
        retentionHours: settings.retentionHours,
        bodyPreviewEnabled: settings.bodyPreviewEnabled,
        record: null
      }
    }

    const now = new Date()
    const retentionStart = new Date(now.getTime() - settings.retentionHours * 3600 * 1000)
    let recordMs = toMillis(parsed.timestamp)
    if (recordMs === null) {
      recordMs = await this._findRequestTimestampInRange(requestId, retentionStart, now, client)
      if (recordMs === null) {
        return {
          captureEnabled: settings.captureEnabled,
          retentionHours: settings.retentionHours,
          bodyPreviewEnabled: settings.bodyPreviewEnabled,
          record: null
        }
      }

      parsed.timestamp = new Date(recordMs).toISOString()
    }

    if (recordMs < retentionStart.getTime()) {
      return {
        captureEnabled: settings.captureEnabled,
        retentionHours: settings.retentionHours,
        bodyPreviewEnabled: settings.bodyPreviewEnabled,
        record: null
      }
    }

    const [enrichedRecord] = await this._enrichRecords([parsed])
    return {
      captureEnabled: settings.captureEnabled,
      retentionHours: settings.retentionHours,
      bodyPreviewEnabled: settings.bodyPreviewEnabled,
      record: enrichedRecord || null
    }
  }
}

module.exports = new RequestDetailService()
module.exports.REQUEST_DETAIL_ITEM_PREFIX = REQUEST_DETAIL_ITEM_PREFIX
module.exports.REQUEST_DETAIL_DAY_INDEX_PREFIX = REQUEST_DETAIL_DAY_INDEX_PREFIX
module.exports.createRequestDetailFilterSignature = createRequestDetailFilterSignature
module.exports.requestDetailFilterSignaturesMatch = requestDetailFilterSignaturesMatch
