const mockConfig = { upstreamError: {} }
let mockAccountData = {}

const mockSetex = jest.fn(async () => 'OK')
const mockDel = jest.fn(async () => 1)
const mockPipeline = {
  lpush: jest.fn().mockReturnThis(),
  ltrim: jest.fn().mockReturnThis(),
  expire: jest.fn().mockReturnThis(),
  exec: jest.fn(async () => [])
}

jest.mock('../config/config', () => mockConfig)
jest.mock('../src/models/redis', () => ({
  getClientSafe: () => ({
    setex: mockSetex,
    del: mockDel,
    hgetall: jest.fn(async () => mockAccountData),
    pipeline: jest.fn(() => mockPipeline)
  })
}))
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  upstreamError: jest.fn()
}))

const upstreamErrorHelper = require('../src/utils/upstreamErrorHelper')

describe('temp-unavailable custom TTL cap', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockConfig.upstreamError = {}
    mockAccountData = {}
  })

  test('clamps a weekly retry-after to 30 minutes by default', async () => {
    const result = await upstreamErrorHelper.markTempUnavailable(
      'acct-1',
      'claude-official',
      429,
      443300
    )

    expect(result.ttlSeconds).toBe(1800)
    expect(mockSetex).toHaveBeenCalledWith(expect.any(String), 1800, expect.any(String))
  })

  test('leaves a short custom TTL unchanged', async () => {
    const result = await upstreamErrorHelper.markTempUnavailable(
      'acct-1',
      'claude-official',
      429,
      600
    )

    expect(result.ttlSeconds).toBe(600)
  })

  test('uses the error default when no custom TTL is supplied', async () => {
    const result = await upstreamErrorHelper.markTempUnavailable('acct-1', 'claude-official', 429)

    expect(result.ttlSeconds).toBe(300)
  })

  test('honors a configured global cap', async () => {
    mockConfig.upstreamError = { maxCustomTtlSeconds: 900 }

    const result = await upstreamErrorHelper.markTempUnavailable(
      'acct-1',
      'claude-official',
      429,
      7200
    )

    expect(result.ttlSeconds).toBe(900)
  })

  test('applies an explicit account TTL override after the global cap', async () => {
    mockAccountData = { tempUnavailable503TtlSeconds: '3600' }

    const result = await upstreamErrorHelper.markTempUnavailable(
      'acct-1',
      'claude-official',
      503,
      7200
    )

    expect(result.ttlSeconds).toBe(3600)
    const historyEntry = JSON.parse(mockPipeline.lpush.mock.calls[0][1])
    expect(historyEntry.context.tempUnavailable).toEqual(
      expect.objectContaining({
        ttlSeconds: 3600,
        policyReason: 'account_503_ttl_override'
      })
    )
  })

  test('keeps the account-level disable switch authoritative', async () => {
    mockAccountData = { disableTempUnavailable: 'true' }

    const result = await upstreamErrorHelper.markTempUnavailable(
      'acct-1',
      'claude-official',
      429,
      7200
    )

    expect(result).toMatchObject({ success: true, skipped: true })
    expect(mockSetex).not.toHaveBeenCalled()
  })
})
