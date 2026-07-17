const {
  projectRatedCostBreakdown,
  projectV2RequestDetailRecord,
  projectV2AvailableFilters
} = require('../src/utils/v2RequestDetailProjection')

describe('v2 request detail projection', () => {
  test('keeps only the explicit safe record fields', () => {
    const projected = projectV2RequestDetailRecord({
      requestId: 'req_1',
      apiKeyId: 'child_1',
      apiKeyName: 'Child',
      model: 'gpt-5.6 (fast)',
      cost: 2,
      clientIp: '203.0.113.1',
      upstreamNicIp: '10.0.0.2',
      accountId: 'account_1',
      realCost: 1,
      requestBodySnapshot: { secret: true },
      reasoningSource: 'request'
    })

    expect(projected).toMatchObject({
      requestId: 'req_1',
      apiKeyId: 'child_1',
      apiKeyName: 'Child',
      model: 'gpt-5.6 (fast)',
      cost: 2
    })
    expect(projected).not.toHaveProperty('clientIp')
    expect(projected).not.toHaveProperty('upstreamNicIp')
    expect(projected).not.toHaveProperty('accountId')
    expect(projected).not.toHaveProperty('realCost')
    expect(projected).not.toHaveProperty('requestBodySnapshot')
    expect(projected).not.toHaveProperty('reasoningSource')
  })

  test('normalizes mutually exclusive rated cost components', () => {
    const breakdown = projectRatedCostBreakdown({
      cost: 4,
      realCostBreakdown: {
        input: 0.5,
        output: 0.25,
        cacheCreate: 0.15,
        cacheWrite: 99,
        cacheRead: 0.1,
        ephemeral5m: 5,
        imageInput: 6
      }
    })

    expect(Object.keys(breakdown)).toEqual(['input', 'output', 'cacheCreate', 'cacheRead', 'total'])
    expect(
      breakdown.input + breakdown.output + breakdown.cacheCreate + breakdown.cacheRead
    ).toBeCloseTo(4, 6)
  })

  test('does not expose a breakdown for invalid or zero-base costs', () => {
    expect(
      projectV2RequestDetailRecord({ cost: 'invalid', costBreakdown: { input: 1 } })
    ).not.toHaveProperty('costBreakdown')
    expect(projectRatedCostBreakdown({ cost: 1, costBreakdown: { input: 0 } })).toBeNull()
  })

  test('zero rated cost does not leak the real component amounts', () => {
    expect(
      projectRatedCostBreakdown({
        cost: 0,
        realCostBreakdown: { input: 1, output: 2, cacheCreate: 3, cacheRead: 4 }
      })
    ).toEqual({ input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 })
  })

  test('available filters omit account dimensions', () => {
    const projected = projectV2AvailableFilters({
      apiKeys: [{ id: 'child_1', name: 'Child' }],
      accounts: [{ id: 'secret', name: 'Secret' }],
      models: ['gpt-5.6'],
      endpoints: ['/v1/responses']
    })
    expect(projected).not.toHaveProperty('accounts')
  })
})
