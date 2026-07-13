const BASE_STAT_FIELDS = [
  'requests',
  'priorityRequests',
  'inputTokens',
  'outputTokens',
  'cacheCreateTokens',
  'cacheReadTokens',
  'ephemeral5mTokens',
  'ephemeral1hTokens',
  'allTokens',
  'priorityInputTokens',
  'priorityOutputTokens',
  'priorityCacheCreateTokens',
  'priorityCacheReadTokens',
  'priorityEphemeral5mTokens',
  'priorityEphemeral1hTokens'
]

const IMAGE_STAT_FIELDS = [
  'textInputTokens',
  'imageInputTokens',
  'imageOutputTokens',
  'priorityTextInputTokens',
  'priorityImageInputTokens',
  'priorityImageOutputTokens'
]

const STANDARD_IMAGE_STAT_FIELDS = ['textInputTokens', 'imageInputTokens', 'imageOutputTokens']

function toInteger(value) {
  const parsed = parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

function hasOwn(stats, field) {
  return Object.prototype.hasOwnProperty.call(stats, field)
}

function createModelUsageStats() {
  const stats = {}
  for (const field of BASE_STAT_FIELDS) {
    stats[field] = 0
  }
  stats.realCostMicro = 0
  stats.ratedCostMicro = 0
  stats.hasStoredCost = false
  return stats
}

function mergeModelUsageStats(target, source = {}) {
  for (const field of BASE_STAT_FIELDS) {
    target[field] = toInteger(target[field]) + toInteger(source[field])
  }

  for (const field of IMAGE_STAT_FIELDS) {
    if (!hasOwn(source, field)) {
      continue
    }
    target[field] = toInteger(target[field]) + toInteger(source[field])
  }

  if (hasOwn(source, 'realCostMicro') || hasOwn(source, 'ratedCostMicro')) {
    target.realCostMicro = toInteger(target.realCostMicro) + toInteger(source.realCostMicro)
    target.ratedCostMicro = toInteger(target.ratedCostMicro) + toInteger(source.ratedCostMicro)
    target.hasStoredCost = true
  }

  return target
}

function hasImageUsageBreakdown(stats = {}) {
  return STANDARD_IMAGE_STAT_FIELDS.some((field) => hasOwn(stats, field))
}

function buildUsagePayloadFromStats(stats = {}) {
  const usage = {
    input_tokens: toInteger(stats.inputTokens),
    output_tokens: toInteger(stats.outputTokens),
    cache_creation_input_tokens: toInteger(stats.cacheCreateTokens),
    cache_read_input_tokens: toInteger(stats.cacheReadTokens)
  }

  const ephemeral5mTokens = toInteger(stats.ephemeral5mTokens)
  const ephemeral1hTokens = toInteger(stats.ephemeral1hTokens)
  if (ephemeral5mTokens > 0 || ephemeral1hTokens > 0) {
    usage.cache_creation = {
      ephemeral_5m_input_tokens: ephemeral5mTokens,
      ephemeral_1h_input_tokens: ephemeral1hTokens
    }
  }

  if (hasImageUsageBreakdown(stats)) {
    usage.image_usage = {
      textInputTokens: toInteger(stats.textInputTokens),
      imageInputTokens: toInteger(stats.imageInputTokens),
      imageOutputTokens: toInteger(stats.imageOutputTokens),
      estimated: false
    }
  }

  return usage
}

function sumModelUsageTokens(stats = {}) {
  return (
    toInteger(stats.inputTokens) +
    toInteger(stats.outputTokens) +
    toInteger(stats.cacheCreateTokens) +
    toInteger(stats.cacheReadTokens)
  )
}

module.exports = {
  buildUsagePayloadFromStats,
  createModelUsageStats,
  hasImageUsageBreakdown,
  mergeModelUsageStats,
  sumModelUsageTokens
}
