function finiteNonNegative(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function round6(value) {
  return Number(Number(value || 0).toFixed(6))
}

function projectRatedCostBreakdown(record = {}) {
  const ratedCost = finiteNonNegative(record.cost)
  if (ratedCost === null) {
    return null
  }

  const source = record.realCostBreakdown || record.costBreakdown
  if (!source || typeof source !== 'object') {
    return null
  }

  const input = finiteNonNegative(source.input) || 0
  const output = finiteNonNegative(source.output) || 0
  const cacheCreate =
    finiteNonNegative(source.cacheCreate) ?? finiteNonNegative(source.cacheWrite) ?? 0
  const cacheRead = finiteNonNegative(source.cacheRead) || 0
  const baseTotal = input + output + cacheCreate + cacheRead
  if (baseTotal <= 0) {
    return null
  }

  const ratio = ratedCost / baseTotal
  return {
    input: round6(input * ratio),
    output: round6(output * ratio),
    cacheCreate: round6(cacheCreate * ratio),
    cacheRead: round6(cacheRead * ratio),
    total: round6(ratedCost)
  }
}

function projectV2RequestDetailRecord(record = {}) {
  const normalizedCost = finiteNonNegative(record.cost)
  const cost = normalizedCost ?? 0
  const projected = {
    requestId: record.requestId || null,
    timestamp: record.timestamp || null,
    apiKeyId: record.apiKeyId || null,
    apiKeyName: record.apiKeyName || record.apiKeyId || null,
    model: record.model || 'unknown',
    endpoint: record.endpoint || null,
    method: record.method || null,
    statusCode: Number(record.statusCode) || 0,
    stream: record.stream === true,
    reasoningDisplay: record.reasoningDisplay || null,
    inputTokens: Number(record.inputTokens) || 0,
    outputTokens: Number(record.outputTokens) || 0,
    cacheReadTokens: Number(record.cacheReadTokens) || 0,
    cacheCreateTokens: Number(record.cacheCreateTokens) || 0,
    totalTokens: Number(record.totalTokens) || 0,
    cacheCreateNotApplicable: record.cacheCreateNotApplicable === true,
    cacheHitRate: Number(record.cacheHitRate) || 0,
    cacheHitNumerator: Number(record.cacheHitNumerator) || 0,
    cacheHitDenominator: Number(record.cacheHitDenominator) || 0,
    cost,
    durationMs: Number(record.durationMs) || 0,
    isLongContextRequest: record.isLongContextRequest === true
  }

  if (
    record.textInputTokens !== undefined ||
    record.imageInputTokens !== undefined ||
    record.imageOutputTokens !== undefined
  ) {
    projected.textInputTokens = Number(record.textInputTokens) || 0
    projected.imageInputTokens = Number(record.imageInputTokens) || 0
    projected.imageOutputTokens = Number(record.imageOutputTokens) || 0
    projected.imageUsageBreakdownEstimated = record.imageUsageBreakdownEstimated === true
  }

  const costBreakdown =
    normalizedCost === null ? null : projectRatedCostBreakdown({ ...record, cost })
  if (costBreakdown) {
    projected.costBreakdown = costBreakdown
  }

  return projected
}

function projectV2Pagination(pagination = {}) {
  return {
    currentPage: Number(pagination.currentPage) || 1,
    pageSize: Number(pagination.pageSize) || 50,
    totalRecords: Number(pagination.totalRecords) || 0,
    totalPages: Number(pagination.totalPages) || 0,
    hasNextPage: pagination.hasNextPage === true,
    hasPreviousPage: pagination.hasPreviousPage === true
  }
}

function projectV2Summary(summary = {}) {
  return {
    totalRequests: Number(summary.totalRequests) || 0,
    inputTokens: Number(summary.inputTokens) || 0,
    outputTokens: Number(summary.outputTokens) || 0,
    cacheReadTokens: Number(summary.cacheReadTokens) || 0,
    cacheCreateTokens: Number(summary.cacheCreateTokens) || 0,
    totalCost: Number(summary.totalCost) || 0,
    avgDurationMs: Number(summary.avgDurationMs) || 0,
    cacheHitRate: Number(summary.cacheHitRate) || 0,
    cacheHitNumerator: Number(summary.cacheHitNumerator) || 0,
    cacheHitDenominator: Number(summary.cacheHitDenominator) || 0,
    cacheCreateNotApplicable: summary.cacheCreateNotApplicable === true
  }
}

function projectV2AvailableFilters(filters = {}) {
  return {
    apiKeys: Array.isArray(filters.apiKeys)
      ? filters.apiKeys.map((item) => ({ id: item.id, name: item.name }))
      : [],
    models: Array.isArray(filters.models) ? [...filters.models] : [],
    endpoints: Array.isArray(filters.endpoints) ? [...filters.endpoints] : [],
    dateRange: {
      earliest: filters.dateRange?.earliest || null,
      latest: filters.dateRange?.latest || null
    }
  }
}

module.exports = {
  projectRatedCostBreakdown,
  projectV2RequestDetailRecord,
  projectV2Pagination,
  projectV2Summary,
  projectV2AvailableFilters
}
