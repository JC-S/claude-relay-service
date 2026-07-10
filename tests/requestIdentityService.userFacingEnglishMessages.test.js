const mockGetClientSafe = jest.fn()

jest.mock('../src/models/redis', () => ({
  getClientSafe: mockGetClientSafe
}))

jest.mock('../src/utils/logger', () => ({
  error: jest.fn(),
  warn: jest.fn()
}))

const requestIdentityService = require('../src/services/requestIdentityService')

describe('request identity persistence failure response', () => {
  test('returns the existing 500 machine code with an English message', () => {
    mockGetClientSafe.mockImplementation(() => {
      throw new Error('Redis unavailable')
    })

    const result = requestIdentityService.transform({
      accountId: 'account_1',
      account: { id: 'account_1' },
      body: {},
      headers: {
        'x-stainless-lang': 'js',
        'x-stainless-os': 'Linux',
        'x-stainless-arch': 'x64',
        'x-stainless-runtime': 'node'
      }
    })

    expect(result.abortResponse.statusCode).toBe(500)
    expect(result.abortResponse.headers).toEqual({ 'content-type': 'application/json' })
    expect(JSON.parse(result.abortResponse.body)).toEqual({
      error: 'fingerprint_persist_failed',
      message: 'Failed to persist request fingerprint.'
    })
  })
})
