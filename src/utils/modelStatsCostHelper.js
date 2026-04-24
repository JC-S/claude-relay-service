function toFiniteNumber(value) {
  const num = Number(value)
  return Number.isFinite(num) ? num : 0
}

function getStoredCosts(stats = {}) {
  const hasStoredCost =
    stats.hasStoredCost === true || 'realCostMicro' in stats || 'ratedCostMicro' in stats

  return {
    hasStoredCost,
    realCost: toFiniteNumber(stats.realCostMicro) / 1000000,
    ratedCost: toFiniteNumber(stats.ratedCostMicro) / 1000000
  }
}

function shouldUseStoredCost(computedTotal, storedRealCost, options = {}) {
  const absoluteTolerance = toFiniteNumber(options.absoluteTolerance) || 0.01
  const relativeTolerance = toFiniteNumber(options.relativeTolerance) || 0.02

  const computed = toFiniteNumber(computedTotal)
  const stored = toFiniteNumber(storedRealCost)

  if (stored <= 0) {
    return computed <= 0
  }

  if (computed <= 0) {
    return true
  }

  const diff = Math.abs(stored - computed)
  const allowedDiff = Math.max(absoluteTolerance, Math.max(stored, computed) * relativeTolerance)

  return diff <= allowedDiff
}

function reconcileStoredModelCost(costData, stats = {}, options = {}) {
  if (!costData || typeof costData !== 'object') {
    return costData
  }

  const { hasStoredCost, realCost, ratedCost } = getStoredCosts(stats)
  if (!hasStoredCost) {
    return costData
  }

  const nextCostData = {
    ...costData,
    costs: { ...(costData.costs || {}) },
    formatted: { ...(costData.formatted || {}) }
  }

  const computedTotal = toFiniteNumber(nextCostData.costs.total)
  const useStoredCost = shouldUseStoredCost(computedTotal, realCost, options)

  if (useStoredCost) {
    nextCostData.costs.real = realCost
    nextCostData.costs.rated = ratedCost
    nextCostData.costs.total = realCost

    if (typeof options.formatCost === 'function') {
      nextCostData.formatted.total = options.formatCost(realCost)
    }

    nextCostData.usingStoredCost = true
    return nextCostData
  }

  nextCostData.usingStoredCost = false
  nextCostData.storedCostMismatch = true
  nextCostData.storedCosts = {
    real: realCost,
    rated: ratedCost
  }

  return nextCostData
}

module.exports = {
  getStoredCosts,
  reconcileStoredModelCost,
  shouldUseStoredCost
}
