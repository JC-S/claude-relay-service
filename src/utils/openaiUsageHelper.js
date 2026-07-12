const logger = require('./logger')

const warnedUsageIssues = new Set()
const MAX_WARNED_USAGE_ISSUES = 100

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key)
}

function parseTokenCount(value) {
  if (value === null || value === undefined || typeof value === 'boolean') {
    return null
  }

  if (typeof value === 'string' && value.trim() === '') {
    return null
  }

  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null
  }

  return Math.trunc(parsed)
}

function selectTokenField(candidates, invalidSources) {
  for (const candidate of candidates) {
    if (!hasOwn(candidate.container, candidate.key)) {
      continue
    }

    const value = parseTokenCount(candidate.container[candidate.key])
    if (value === null) {
      invalidSources.push(candidate.source)
      continue
    }

    return {
      value,
      source: candidate.source,
      includedInInput: candidate.includedInInput === true
    }
  }

  return {
    value: 0,
    source: null,
    includedInInput: false
  }
}

function warnOnce(key, message) {
  if (warnedUsageIssues.has(key)) {
    return
  }

  if (warnedUsageIssues.size >= MAX_WARNED_USAGE_ISSUES) {
    const oldestKey = warnedUsageIssues.values().next().value
    warnedUsageIssues.delete(oldestKey)
  }

  warnedUsageIssues.add(key)
  logger.warn(message)
}

function normalizeOpenAIUsage(usageData = {}, options = {}) {
  const usage = usageData && typeof usageData === 'object' ? usageData : {}
  const inputDetails =
    usage.input_tokens_details && typeof usage.input_tokens_details === 'object'
      ? usage.input_tokens_details
      : {}
  const promptDetails =
    usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object'
      ? usage.prompt_tokens_details
      : {}
  const invalidSources = []

  const totalInput = selectTokenField(
    [
      { container: usage, key: 'input_tokens', source: 'input_tokens' },
      { container: usage, key: 'prompt_tokens', source: 'prompt_tokens' }
    ],
    invalidSources
  )
  const output = selectTokenField(
    [
      { container: usage, key: 'output_tokens', source: 'output_tokens' },
      { container: usage, key: 'completion_tokens', source: 'completion_tokens' }
    ],
    invalidSources
  )
  const cacheRead = selectTokenField(
    [
      {
        container: inputDetails,
        key: 'cached_tokens',
        source: 'input_tokens_details.cached_tokens',
        includedInInput: true
      },
      {
        container: inputDetails,
        key: 'cached_token',
        source: 'input_tokens_details.cached_token',
        includedInInput: true
      },
      {
        container: promptDetails,
        key: 'cached_tokens',
        source: 'prompt_tokens_details.cached_tokens',
        includedInInput: true
      },
      {
        container: promptDetails,
        key: 'cached_token',
        source: 'prompt_tokens_details.cached_token',
        includedInInput: true
      },
      {
        container: usage,
        key: 'cache_read_input_tokens',
        source: 'cache_read_input_tokens',
        includedInInput: false
      }
    ],
    invalidSources
  )
  const cacheCreate = selectTokenField(
    [
      {
        container: inputDetails,
        key: 'cache_write_tokens',
        source: 'input_tokens_details.cache_write_tokens',
        includedInInput: true
      },
      {
        container: inputDetails,
        key: 'cache_creation_tokens',
        source: 'input_tokens_details.cache_creation_tokens',
        includedInInput: true
      },
      {
        container: inputDetails,
        key: 'cache_creation_input_tokens',
        source: 'input_tokens_details.cache_creation_input_tokens',
        includedInInput: true
      },
      {
        container: promptDetails,
        key: 'cache_write_tokens',
        source: 'prompt_tokens_details.cache_write_tokens',
        includedInInput: true
      },
      {
        container: promptDetails,
        key: 'cache_creation_tokens',
        source: 'prompt_tokens_details.cache_creation_tokens',
        includedInInput: true
      },
      {
        container: promptDetails,
        key: 'cache_creation_input_tokens',
        source: 'prompt_tokens_details.cache_creation_input_tokens',
        includedInInput: true
      },
      {
        container: usage,
        key: 'cache_write_tokens',
        source: 'cache_write_tokens',
        includedInInput: true
      },
      {
        container: usage,
        key: 'cache_creation_input_tokens',
        source: 'cache_creation_input_tokens',
        includedInInput: false
      },
      {
        container: usage,
        key: 'cache_creation_tokens',
        source: 'cache_creation_tokens',
        includedInInput: false
      }
    ],
    invalidSources
  )

  const upstreamTotal = selectTokenField(
    [{ container: usage, key: 'total_tokens', source: 'total_tokens' }],
    invalidSources
  )
  const hasUpstreamTotal = upstreamTotal.source !== null
  const includedCacheTokens =
    (cacheRead.includedInInput ? cacheRead.value : 0) +
    (cacheCreate.includedInInput ? cacheCreate.value : 0)
  const inputTokens = Math.max(0, totalInput.value - includedCacheTokens)
  const totalTokens = inputTokens + cacheRead.value + cacheCreate.value + output.value
  const inputBreakdownConsistent = includedCacheTokens <= totalInput.value
  const upstreamTotalConsistent = !hasUpstreamTotal || upstreamTotal.value === totalTokens
  const isConsistent = inputBreakdownConsistent && upstreamTotalConsistent

  const shouldLogDiagnostics = options.logDiagnostics !== false

  if (shouldLogDiagnostics && invalidSources.length > 0) {
    const uniqueInvalidSources = [...new Set(invalidSources)]
    warnOnce(
      `invalid:${uniqueInvalidSources.join(',')}`,
      `Invalid OpenAI usage token fields ignored: ${uniqueInvalidSources.join(', ')}`
    )
  }

  if (shouldLogDiagnostics && !inputBreakdownConsistent) {
    warnOnce(
      `input-overflow:${cacheRead.source || 'none'}:${cacheCreate.source || 'none'}`,
      `OpenAI usage cache components exceed total input; regular input clamped to 0 ` +
        `(input=${totalInput.value}, cacheRead=${cacheRead.value}, cacheWrite=${cacheCreate.value})`
    )
  }

  if (shouldLogDiagnostics && !upstreamTotalConsistent) {
    warnOnce(
      `total-mismatch:${cacheRead.source || 'none'}:${cacheCreate.source || 'none'}`,
      `OpenAI usage total mismatch (normalized=${totalTokens}, upstream=${upstreamTotal.value})`
    )
  }

  return {
    totalInputTokens: totalInput.value,
    inputTokens,
    outputTokens: output.value,
    cacheReadTokens: cacheRead.value,
    cacheCreateTokens: cacheCreate.value,
    totalTokens,
    upstreamTotalTokens: hasUpstreamTotal ? upstreamTotal.value : null,
    inputSource: totalInput.source,
    outputSource: output.source,
    cacheReadSource: cacheRead.source,
    cacheCreateSource: cacheCreate.source,
    cacheReadIncludedInInput: cacheRead.includedInInput,
    cacheWriteIncludedInInput: cacheCreate.includedInInput,
    isConsistent
  }
}

function normalizeOpenAIImageUsage(usageData = {}, options = {}) {
  const endpoint = options.endpoint === 'edits' ? 'edits' : 'generations'
  const normalized = normalizeOpenAIUsage(usageData, options)
  const usage = usageData && typeof usageData === 'object' ? usageData : {}
  const inputDetails =
    usage.input_tokens_details && typeof usage.input_tokens_details === 'object'
      ? usage.input_tokens_details
      : {}
  const invalidSources = []

  const readDetail = (key) => {
    if (!hasOwn(inputDetails, key)) {
      return { present: false, value: 0 }
    }
    const value = parseTokenCount(inputDetails[key])
    if (value === null) {
      invalidSources.push(`input_tokens_details.${key}`)
      return { present: false, value: 0 }
    }
    return { present: true, value }
  }

  const textDetail = readDetail('text_tokens')
  const imageDetail = readDetail('image_tokens')
  const hasBreakdown = textDetail.present || imageDetail.present
  let rawTextTokens = 0
  let rawImageTokens = 0
  let estimated = false

  if (!hasBreakdown) {
    estimated = true
    if (endpoint === 'edits') {
      rawImageTokens = normalized.totalInputTokens
    } else {
      rawTextTokens = normalized.totalInputTokens
    }
    warnOnce(
      `image-breakdown-missing:${endpoint}`,
      `OpenAI image ${endpoint} usage omitted text/image input details; using the configured estimated breakdown`
    )
  } else if (imageDetail.present) {
    estimated = !textDetail.present
    rawImageTokens = Math.min(imageDetail.value, normalized.totalInputTokens)
    rawTextTokens = Math.max(0, normalized.totalInputTokens - rawImageTokens)
  } else {
    estimated = true
    rawTextTokens = Math.min(textDetail.value, normalized.totalInputTokens)
    rawImageTokens = Math.max(0, normalized.totalInputTokens - rawTextTokens)
  }

  const upstreamBreakdownTotal = textDetail.value + imageDetail.value
  const breakdownConsistent =
    !hasBreakdown || upstreamBreakdownTotal === normalized.totalInputTokens
  if (hasBreakdown && !breakdownConsistent) {
    estimated = true
    warnOnce(
      `image-breakdown-mismatch:${endpoint}`,
      `OpenAI image input breakdown mismatch; total input remains authoritative ` +
        `(input=${normalized.totalInputTokens}, text=${textDetail.value}, image=${imageDetail.value})`
    )
  }
  if (options.logDiagnostics !== false && invalidSources.length > 0) {
    warnOnce(
      `invalid-image:${invalidSources.join(',')}`,
      `Invalid OpenAI image usage token fields ignored: ${invalidSources.join(', ')}`
    )
  }

  const includedCacheTokens = Math.max(0, normalized.totalInputTokens - normalized.inputTokens)
  const textCacheTokens = Math.min(rawTextTokens, includedCacheTokens)
  const imageCacheTokens = Math.min(
    rawImageTokens,
    Math.max(0, includedCacheTokens - textCacheTokens)
  )
  let textInputTokens = Math.max(0, rawTextTokens - textCacheTokens)
  let imageInputTokens = Math.max(0, rawImageTokens - imageCacheTokens)

  const netBreakdownTotal = textInputTokens + imageInputTokens
  if (netBreakdownTotal !== normalized.inputTokens) {
    imageInputTokens = Math.min(imageInputTokens, normalized.inputTokens)
    textInputTokens = Math.max(0, normalized.inputTokens - imageInputTokens)
  }

  const imageUsage = {
    textInputTokens,
    imageInputTokens,
    imageOutputTokens: normalized.outputTokens,
    estimated
  }

  return {
    ...normalized,
    textInputTokens,
    imageInputTokens,
    imageOutputTokens: normalized.outputTokens,
    imageUsageBreakdownEstimated: estimated,
    image_usage: imageUsage,
    isConsistent: normalized.isConsistent && breakdownConsistent
  }
}

function formatOpenAIUsageForLog(normalizedUsage = {}) {
  const upstreamTotal =
    normalizedUsage.upstreamTotalTokens === null ||
    normalizedUsage.upstreamTotalTokens === undefined
      ? 'n/a'
      : normalizedUsage.upstreamTotalTokens

  return (
    `regular=${normalizedUsage.inputTokens || 0}, ` +
    `cacheRead=${normalizedUsage.cacheReadTokens || 0}, ` +
    `cacheWrite=${normalizedUsage.cacheCreateTokens || 0}, ` +
    `output=${normalizedUsage.outputTokens || 0}, ` +
    `total=${normalizedUsage.totalTokens || 0}, ` +
    `upstreamTotal=${upstreamTotal}, ` +
    `sources(cacheRead=${normalizedUsage.cacheReadSource || 'none'}, ` +
    `cacheWrite=${normalizedUsage.cacheCreateSource || 'none'})`
  )
}

module.exports = {
  formatOpenAIUsageForLog,
  normalizeOpenAIUsage,
  normalizeOpenAIImageUsage
}
