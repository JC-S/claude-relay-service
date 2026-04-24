const { reconcileStoredModelCost, shouldUseStoredCost } = require('../src/utils/modelStatsCostHelper')

describe('modelStatsCostHelper', () => {
  test('uses stored cost when it closely matches the computed total', () => {
    const result = reconcileStoredModelCost(
      {
        costs: { total: 12.345678 },
        formatted: { total: '$12.35' }
      },
      {
        hasStoredCost: true,
        realCostMicro: 12345680,
        ratedCostMicro: 12345680
      },
      {
        formatCost: (amount) => `$${amount.toFixed(6)}`
      }
    )

    expect(result.usingStoredCost).toBe(true)
    expect(result.costs.total).toBeCloseTo(12.34568, 6)
    expect(result.costs.real).toBeCloseTo(12.34568, 6)
    expect(result.formatted.total).toBe('$12.345680')
  })

  test('keeps computed total when stored cost is materially lower than recomputed cost', () => {
    const result = reconcileStoredModelCost(
      {
        costs: { total: 43.342524 },
        formatted: { total: '$43.34' }
      },
      {
        hasStoredCost: true,
        realCostMicro: 5084911,
        ratedCostMicro: 5084911
      },
      {
        formatCost: (amount) => `$${amount.toFixed(6)}`
      }
    )

    expect(result.usingStoredCost).toBe(false)
    expect(result.storedCostMismatch).toBe(true)
    expect(result.costs.total).toBeCloseTo(43.342524, 6)
    expect(result.storedCosts).toEqual({
      real: 5.084911,
      rated: 5.084911
    })
  })

  test('uses stored cost when recomputation cannot produce a positive total', () => {
    const result = reconcileStoredModelCost(
      {
        costs: { total: 0 },
        formatted: { total: '$0.000000' }
      },
      {
        hasStoredCost: true,
        realCostMicro: 250000,
        ratedCostMicro: 250000
      },
      {
        formatCost: (amount) => `$${amount.toFixed(6)}`
      }
    )

    expect(result.usingStoredCost).toBe(true)
    expect(result.costs.total).toBeCloseTo(0.25, 6)
  })

  test('rejects zero stored cost when computed total is positive', () => {
    expect(shouldUseStoredCost(12.5, 0)).toBe(false)
  })
})
