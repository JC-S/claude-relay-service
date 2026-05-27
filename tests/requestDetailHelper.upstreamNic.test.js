const { createRequestDetailMeta } = require('../src/utils/requestDetailHelper')

describe('requestDetailHelper upstream NIC metadata', () => {
  test('uses req.upstreamNicIp when present', () => {
    const meta = createRequestDetailMeta({
      method: 'POST',
      originalUrl: '/openai/v1/responses',
      upstreamNicIp: '10.0.0.191',
      body: { stream: false }
    })

    expect(meta.upstreamNicIp).toBe('10.0.0.191')
  })

  test('lets overrides take precedence over req.upstreamNicIp', () => {
    const meta = createRequestDetailMeta(
      {
        method: 'POST',
        originalUrl: '/openai/v1/responses',
        upstreamNicIp: '10.0.0.191',
        body: { stream: false }
      },
      {
        upstreamNicIp: '10.0.0.184'
      }
    )

    expect(meta.upstreamNicIp).toBe('10.0.0.184')
  })

  test('defaults upstreamNicIp to null', () => {
    const meta = createRequestDetailMeta({
      method: 'POST',
      originalUrl: '/openai/v1/responses',
      body: { stream: false }
    })

    expect(meta.upstreamNicIp).toBeNull()
  })
})
