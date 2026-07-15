jest.mock('../src/models/redis', () => ({
  incrConcurrency: jest.fn(),
  decrConcurrency: jest.fn(),
  getSessionAccountMapping: jest.fn(),
  setSessionAccountMapping: jest.fn(),
  extendSessionAccountMappingTTL: jest.fn(),
  deleteSessionAccountMapping: jest.fn()
}))
jest.mock('../src/services/account/grokAccountService', () => ({
  getSafeAccount: jest.fn(),
  getSchedulableAccounts: jest.fn()
}))
jest.mock('../src/services/accountGroupService', () => ({
  getGroup: jest.fn(),
  getGroupMembers: jest.fn()
}))
jest.mock('../src/utils/upstreamErrorHelper', () => ({
  isTempUnavailable: jest.fn()
}))
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn() }))
jest.mock('../src/utils/grokModelHelper', () => ({
  normalizeGrokModelName: jest.fn((model) => String(model || '').toLowerCase()),
  resolveGrokModel: jest.fn((model, mapping) => mapping?.[model] || model),
  isSupportedGrokModel: jest.fn((model) => ['grok-4.5', 'grok-4.3'].includes(model)),
  isAccountSupportedGrokModel: jest.fn(
    (model, value) =>
      ['grok-4.5', 'grok-4.3'].includes(model) ||
      (value?.authType === 'api_key' && value.supportedModels?.includes(model))
  ),
  hasValidGrokPricing: jest.fn(() => true)
}))

const redis = require('../src/models/redis')
const accountGroupService = require('../src/services/accountGroupService')
const grokAccountService = require('../src/services/account/grokAccountService')
const upstreamErrorHelper = require('../src/utils/upstreamErrorHelper')
const grokScheduler = require('../src/services/scheduler/grokScheduler')

const account = (id, extra = {}) => ({
  id,
  name: id,
  isActive: true,
  schedulable: true,
  status: 'active',
  accountType: 'shared',
  priority: 50,
  concurrency: 1,
  supportedModels: [],
  ...extra
})

describe('grokScheduler', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    redis.incrConcurrency.mockResolvedValue(1)
    redis.decrConcurrency.mockResolvedValue(0)
    redis.getSessionAccountMapping.mockResolvedValue(null)
    upstreamErrorHelper.isTempUnavailable.mockResolvedValue(false)
  })

  test('uses a healthy sticky shared account and reserves its concurrency slot', async () => {
    grokAccountService.getSchedulableAccounts.mockResolvedValue([account('a'), account('b')])
    redis.getSessionAccountMapping.mockResolvedValue('b')
    const result = await grokScheduler.selectAccount({
      apiKeyData: { id: 'key' },
      mappedModel: 'grok-4.5',
      sessionHash: 'session',
      requestId: 'request'
    })
    expect(result.account.id).toBe('b')
    expect(redis.incrConcurrency).toHaveBeenCalledWith('grok_account:b', 'request')
    expect(redis.extendSessionAccountMappingTTL).toHaveBeenCalledWith('grok:key:grok-4.5:session')
  })

  test('skips excluded, cooled down and full accounts', async () => {
    grokAccountService.getSchedulableAccounts.mockResolvedValue([
      account('excluded'),
      account('cooldown'),
      account('full'),
      account('available')
    ])
    upstreamErrorHelper.isTempUnavailable.mockImplementation(async (id) => id === 'cooldown')
    redis.incrConcurrency.mockImplementation(async (key) => (key.includes('full') ? 2 : 1))
    const result = await grokScheduler.selectAccount({
      apiKeyData: { id: 'key' },
      mappedModel: 'grok-4.5',
      excluded: new Set(['excluded']),
      requestId: 'request'
    })
    expect(result.account.id).toBe('available')
    expect(redis.decrConcurrency).toHaveBeenCalledWith('grok_account:full', 'request')
  })

  test('releases the reserved slot when sticky-session persistence fails', async () => {
    grokAccountService.getSchedulableAccounts.mockResolvedValue([account('selected')])
    redis.setSessionAccountMapping.mockRejectedValue(new Error('redis unavailable'))

    await expect(
      grokScheduler.selectAccount({
        apiKeyData: { id: 'key' },
        mappedModel: 'grok-4.5',
        sessionHash: 'session',
        requestId: 'request'
      })
    ).rejects.toThrow('redis unavailable')

    expect(redis.decrConcurrency).toHaveBeenCalledWith('grok_account:selected', 'request')
  })

  test('keeps a group binding inside its Grok group when no member is available', async () => {
    accountGroupService.getGroup.mockResolvedValue({ id: 'group', platform: 'grok' })
    accountGroupService.getGroupMembers.mockResolvedValue(['member'])
    grokAccountService.getSafeAccount.mockResolvedValue(account('member', { schedulable: false }))
    await expect(
      grokScheduler.selectAccount({
        apiKeyData: { id: 'key', grokAccountId: 'group:group' },
        mappedModel: 'grok-4.5',
        requestId: 'request'
      })
    ).rejects.toMatchObject({ code: 'NO_GROK_ACCOUNT' })
    expect(grokAccountService.getSchedulableAccounts).not.toHaveBeenCalled()
  })

  test('falls back from an unavailable dedicated binding to the shared pool', async () => {
    grokAccountService.getSafeAccount.mockResolvedValue(
      account('dedicated', { accountType: 'dedicated', schedulable: false })
    )
    grokAccountService.getSchedulableAccounts.mockResolvedValue([account('shared')])
    const result = await grokScheduler.selectAccount({
      apiKeyData: { id: 'key', grokAccountId: 'dedicated' },
      mappedModel: 'grok-4.5',
      requestId: 'request'
    })
    expect(result.account.id).toBe('shared')
  })

  test('filters accounts by mapped model support', async () => {
    grokAccountService.getSchedulableAccounts.mockResolvedValue([
      account('wrong', { supportedModels: ['grok-4.3'] }),
      account('right', { supportedModels: ['grok-4.5'] })
    ])
    const result = await grokScheduler.selectAccount({
      apiKeyData: { id: 'key' },
      mappedModel: 'grok-4.5',
      requestId: 'request'
    })
    expect(result.account.id).toBe('right')
  })

  test('applies account-level model mapping before model support filtering', async () => {
    grokAccountService.getSchedulableAccounts.mockResolvedValue([
      account('mapped', {
        modelMapping: { 'client-model': 'grok-4.3' },
        supportedModels: ['grok-4.3']
      })
    ])
    const result = await grokScheduler.selectAccount({
      apiKeyData: { id: 'key' },
      requestedModel: 'client-model',
      mappedModel: 'client-model',
      requestId: 'request'
    })
    expect(result.account.id).toBe('mapped')
    expect(result.mappedModel).toBe('grok-4.3')
  })

  test('allows a priced text model discovered by an API key account', async () => {
    grokAccountService.getSchedulableAccounts.mockResolvedValue([
      account('api-key', {
        authType: 'api_key',
        supportedModels: ['grok-new-text-model']
      })
    ])

    const result = await grokScheduler.selectAccount({
      apiKeyData: { id: 'key' },
      mappedModel: 'grok-new-text-model',
      requestId: 'request'
    })

    expect(result.account.id).toBe('api-key')
    expect(result.mappedModel).toBe('grok-new-text-model')
  })

  test('returns a model-not-found error when no candidate mapping accepts the model', async () => {
    grokAccountService.getSchedulableAccounts.mockResolvedValue([account('account')])
    await expect(
      grokScheduler.selectAccount({
        apiKeyData: { id: 'key' },
        requestedModel: 'unknown',
        mappedModel: 'unknown',
        requestId: 'request'
      })
    ).rejects.toMatchObject({ code: 'GROK_MODEL_NOT_FOUND' })
  })
})
