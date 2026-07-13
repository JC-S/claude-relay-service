const FAST_MODEL_SUFFIX = ' (fast)'
const IMAGE_PRIORITY_STAT_FIELDS = [
  ['textInputTokens', 'priorityTextInputTokens'],
  ['imageInputTokens', 'priorityImageInputTokens'],
  ['imageOutputTokens', 'priorityImageOutputTokens']
]

function toNumber(value) {
  const num = Number(value)
  return Number.isFinite(num) ? num : 0
}

function normalizeBaseModelName(model) {
  if (typeof model !== 'string') {
    return 'unknown'
  }

  const trimmed = model.trim()
  if (!trimmed) {
    return 'unknown'
  }

  return trimmed.endsWith(FAST_MODEL_SUFFIX) ? trimmed.slice(0, -FAST_MODEL_SUFFIX.length) : trimmed
}

function isPriorityServiceTier(serviceTier) {
  return typeof serviceTier === 'string' && serviceTier.toLowerCase() === 'priority'
}

function isGptFamilyModel(model) {
  return /^gpt-/i.test(normalizeBaseModelName(model))
}

function formatDisplayModelName(model, serviceTier = null) {
  const baseModel = normalizeBaseModelName(model)
  return isGptFamilyModel(baseModel) && isPriorityServiceTier(serviceTier)
    ? `${baseModel}${FAST_MODEL_SUFFIX}`
    : baseModel
}

function applyDisplayModelToRecord(record = {}) {
  const rawModel = normalizeBaseModelName(record.rawModel || record.model || 'unknown')
  return {
    ...record,
    rawModel,
    model: formatDisplayModelName(rawModel, record.serviceTier)
  }
}

function sumBillableTokens(stats = {}) {
  return (
    toNumber(stats.inputTokens) +
    toNumber(stats.outputTokens) +
    toNumber(stats.cacheCreateTokens) +
    toNumber(stats.cacheReadTokens)
  )
}

function hasPriorityUsageStats(stats = {}) {
  return (
    toNumber(stats.priorityRequests) > 0 ||
    toNumber(stats.priorityInputTokens) > 0 ||
    toNumber(stats.priorityOutputTokens) > 0 ||
    toNumber(stats.priorityCacheCreateTokens) > 0 ||
    toNumber(stats.priorityCacheReadTokens) > 0 ||
    toNumber(stats.priorityEphemeral5mTokens) > 0 ||
    toNumber(stats.priorityEphemeral1hTokens) > 0 ||
    toNumber(stats.priorityTextInputTokens) > 0 ||
    toNumber(stats.priorityImageInputTokens) > 0 ||
    toNumber(stats.priorityImageOutputTokens) > 0
  )
}

function hasAnyUsageStats(stats = {}) {
  return toNumber(stats.requests) > 0 || sumBillableTokens(stats) > 0
}

function splitModelStatsByFastMode(model, stats = {}, createEmptyStats) {
  const baseModel = normalizeBaseModelName(model)
  if (!isGptFamilyModel(baseModel) || !hasPriorityUsageStats(stats)) {
    return [
      {
        model: baseModel,
        rawModel: baseModel,
        serviceTier: null,
        stats: { ...stats }
      }
    ]
  }

  const standardStats = createEmptyStats()
  const fastStats = createEmptyStats()

  const totalRequests = toNumber(stats.requests)
  const priorityRequests = toNumber(stats.priorityRequests)
  standardStats.requests = Math.max(0, totalRequests - priorityRequests)
  fastStats.requests = Math.max(0, priorityRequests)
  fastStats.priorityRequests = Math.max(0, priorityRequests)

  const statFields = [
    ['inputTokens', 'priorityInputTokens'],
    ['outputTokens', 'priorityOutputTokens'],
    ['cacheCreateTokens', 'priorityCacheCreateTokens'],
    ['cacheReadTokens', 'priorityCacheReadTokens'],
    ['ephemeral5mTokens', 'priorityEphemeral5mTokens'],
    ['ephemeral1hTokens', 'priorityEphemeral1hTokens']
  ]

  for (const fields of IMAGE_PRIORITY_STAT_FIELDS) {
    if (fields.some((field) => Object.prototype.hasOwnProperty.call(stats, field))) {
      statFields.push(fields)
    }
  }

  for (const [field, priorityField] of statFields) {
    const total = toNumber(stats[field])
    const priority = toNumber(stats[priorityField])
    standardStats[field] = Math.max(0, total - priority)
    fastStats[field] = priority
  }

  if ('allTokens' in stats || 'allTokens' in standardStats || 'allTokens' in fastStats) {
    const totalAllTokens = toNumber(stats.allTokens) || sumBillableTokens(stats)
    const fastAllTokens = sumBillableTokens(fastStats)
    standardStats.allTokens = Math.max(0, totalAllTokens - fastAllTokens)
    fastStats.allTokens = fastAllTokens
  }

  if (
    'realCostMicro' in standardStats ||
    'realCostMicro' in fastStats ||
    'realCostMicro' in stats
  ) {
    standardStats.realCostMicro = 0
    fastStats.realCostMicro = 0
  }

  if (
    'ratedCostMicro' in standardStats ||
    'ratedCostMicro' in fastStats ||
    'ratedCostMicro' in stats
  ) {
    standardStats.ratedCostMicro = 0
    fastStats.ratedCostMicro = 0
  }

  if (
    'hasStoredCost' in standardStats ||
    'hasStoredCost' in fastStats ||
    'hasStoredCost' in stats
  ) {
    standardStats.hasStoredCost = false
    fastStats.hasStoredCost = false
  }

  return [
    {
      model: baseModel,
      rawModel: baseModel,
      serviceTier: null,
      stats: standardStats
    },
    {
      model: `${baseModel}${FAST_MODEL_SUFFIX}`,
      rawModel: baseModel,
      serviceTier: 'priority',
      stats: fastStats
    }
  ].filter((entry) => hasAnyUsageStats(entry.stats))
}

module.exports = {
  FAST_MODEL_SUFFIX,
  applyDisplayModelToRecord,
  formatDisplayModelName,
  hasPriorityUsageStats,
  isGptFamilyModel,
  isPriorityServiceTier,
  normalizeBaseModelName,
  splitModelStatsByFastMode
}
