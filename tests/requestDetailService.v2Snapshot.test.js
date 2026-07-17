jest.mock('../src/models/redis', () => ({
  getClient: jest.fn(),
  getApiKey: jest.fn()
}))
jest.mock('../src/services/claudeRelayConfigService', () => ({ getConfig: jest.fn() }))
jest.mock('../src/utils/logger', () => ({
  warn: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn()
}))
jest.mock('../src/services/account/claudeAccountService', () => ({ getAccount: jest.fn() }))
jest.mock('../src/services/account/claudeConsoleAccountService', () => ({ getAccount: jest.fn() }))
jest.mock('../src/services/account/ccrAccountService', () => ({ getAccount: jest.fn() }))
jest.mock('../src/services/account/geminiAccountService', () => ({ getAccount: jest.fn() }))
jest.mock('../src/services/account/geminiApiAccountService', () => ({ getAccount: jest.fn() }))
jest.mock('../src/services/account/openaiAccountService', () => ({ getAccount: jest.fn() }))
jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  getAccount: jest.fn()
}))
jest.mock('../src/services/account/azureOpenaiAccountService', () => ({ getAccount: jest.fn() }))
jest.mock('../src/services/account/droidAccountService', () => ({ getAccount: jest.fn() }))
jest.mock('../src/services/account/grokAccountService', () => ({ getAccount: jest.fn() }))
jest.mock('../src/services/account/bedrockAccountService', () => ({ getAccount: jest.fn() }))

const {
  createRequestDetailFilterSignature,
  requestDetailFilterSignaturesMatch
} = require('../src/services/requestDetailService')

const boundaries = {
  startBoundary: { mode: 'fixed', value: '2026-07-17T00:00:00.000Z' },
  endBoundary: { mode: 'fixed', value: '2026-07-17T01:00:00.000Z' }
}

describe('V2 request detail snapshot signatures', () => {
  test('keeps legacy admin signatures compatible with admin/null', () => {
    const legacy = createRequestDetailFilterSignature({}, boundaries, 6)
    delete legacy.scopeType
    delete legacy.scopeFingerprint
    const current = createRequestDetailFilterSignature({}, boundaries, 6, {
      scopeType: 'admin',
      scopeFingerprint: null
    })
    expect(requestDetailFilterSignaturesMatch(legacy, current)).toBe(true)
  })

  test('does not allow admin and V2 snapshots to mix', () => {
    const admin = createRequestDetailFilterSignature({}, boundaries, 6)
    const v2 = createRequestDetailFilterSignature({}, boundaries, 6, {
      scopeType: 'v2',
      scopeFingerprint: 'scope-a'
    })
    expect(requestDetailFilterSignaturesMatch(admin, v2)).toBe(false)
  })

  test('invalidates a snapshot when the parent or child membership fingerprint changes', () => {
    const scopeA = createRequestDetailFilterSignature({}, boundaries, 6, {
      scopeType: 'v2',
      scopeFingerprint: 'scope-a'
    })
    const scopeB = createRequestDetailFilterSignature({}, boundaries, 6, {
      scopeType: 'v2',
      scopeFingerprint: 'scope-b'
    })
    expect(requestDetailFilterSignaturesMatch(scopeA, scopeB)).toBe(false)
  })
})
