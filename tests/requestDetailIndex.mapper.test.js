const {
  createSearchText,
  isPricingRecomputeEligible,
  mapRequestDetailToIndexRow
} = require('../src/services/requestDetailIndex/mapper')

describe('request detail SQLite mapper', () => {
  test('maps display model, cache contributions, micro-dollars and static search fields', () => {
    const row = mapRequestDetailToIndexRow(
      {
        requestId: 'req_1',
        timestamp: '2026-07-17T00:00:00.000Z',
        apiKeyId: 'key_1',
        accountId: 'account_1',
        accountType: 'openai',
        model: 'gpt-5.5',
        serviceTier: 'priority',
        endpoint: '/v1/responses',
        method: 'POST',
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 80,
        cacheCreateTokens: 0,
        cost: 1.2345674,
        durationMs: 1234,
        requestBodySnapshot: { authorization: 'secret' },
        accessToken: 'secret'
      },
      {
        sourceVersion: 'version_1',
        expiresAtMs: Date.parse('2026-07-18T00:00:00.000Z')
      }
    )

    expect(row).toMatchObject({
      request_id: 'req_1',
      source_version: 'version_1',
      model: 'gpt-5.5 (fast)',
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 80,
      cache_create_tokens: 0,
      cost_micros: 1234567,
      cache_create_not_applicable: 1,
      pricing_recompute_eligible: 0
    })
    expect(row.search_text).toContain('req_1\nkey_1\naccount_1')
    expect(JSON.stringify(row)).not.toContain('secret')
    expect(row).not.toHaveProperty('requestBodySnapshot')
  })

  test('marks zero-cost token records eligible independently of current pricing', () => {
    expect(isPricingRecomputeEligible({ cost: 0, realCost: 0, inputTokens: 1 })).toBe(true)
    expect(isPricingRecomputeEligible({ cost: 0.01, realCost: 0, inputTokens: 1 })).toBe(false)
    expect(isPricingRecomputeEligible({ cost: 0, realCost: 0, inputTokens: -1 })).toBe(false)
  })

  test('recovers priority service tier from a legacy request-body preview', () => {
    const row = mapRequestDetailToIndexRow(
      {
        requestId: 'legacy_fast',
        timestamp: '2026-07-17T00:00:00.000Z',
        accountType: 'openai',
        model: 'gpt-5.5',
        requestBodySnapshot: {
          preview: '{"model":"gpt-5.5","service_tier":"priority"}'
        }
      },
      { expiresAtMs: Date.parse('2026-07-18T00:00:00.000Z') }
    )
    expect(row.model).toBe('gpt-5.5 (fast)')
  })

  test('treats search control characters and wildcard characters as plain text', () => {
    const text = createSearchText({
      request_id: 'REQ_%_1\nline',
      api_key_id: 'KEY',
      account_id: 'ACCOUNT',
      account_type: 'unknown',
      model: 'MODEL',
      endpoint: '/ENDPOINT',
      method: 'POST'
    })
    expect(text).toContain('req_%_1\nline')
  })
})
