jest.mock(
  '../config/config',
  () => ({
    security: {
      apiKeyPrefix: 'cr_'
    }
  }),
  { virtual: true }
)

jest.mock('../src/models/redis', () => ({
  setApiKey: jest.fn(),
  getApiKey: jest.fn(),
  findApiKeyByHash: jest.fn(),
  getDailyCost: jest.fn(),
  getCostStats: jest.fn(),
  getUsageStats: jest.fn(),
  getWeeklyOpusCost: jest.fn()
}))

jest.mock('../src/services/costRankService', () => ({
  addKeyToIndexes: jest.fn()
}))

jest.mock('../src/services/apiKeyIndexService', () => ({
  addToIndex: jest.fn(),
  updateIndex: jest.fn()
}))

jest.mock('../src/utils/logger', () => ({
  success: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

jest.mock('../src/services/serviceRatesService', () => ({}))
jest.mock('../src/services/requestDetailService', () => ({}))
jest.mock('../src/utils/modelHelper', () => ({
  isClaudeFamilyModel: jest.fn(() => false)
}))
jest.mock('../src/utils/requestDetailHelper', () => ({
  finalizeRequestDetailMeta: jest.fn((value) => value)
}))

const redis = require('../src/models/redis')
const apiKeyService = require('../src/services/apiKeyService')

describe('apiKeyService openai responses config', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('generateApiKey stores default toggle values', async () => {
    redis.setApiKey.mockResolvedValue()

    const result = await apiKeyService.generateApiKey({ name: 'Test Key' })
    const [, storedKeyData] = redis.setApiKey.mock.calls[0]

    expect(storedKeyData.enableOpenAIResponsesCodexAdaptation).toBe('true')
    expect(storedKeyData.enableOpenAIResponsesPayloadRules).toBe('false')
    expect(storedKeyData.openaiResponsesPayloadRules).toBe('[]')

    expect(result.enableOpenAIResponsesCodexAdaptation).toBe(true)
    expect(result.enableOpenAIResponsesPayloadRules).toBe(false)
    expect(result.openaiResponsesPayloadRules).toEqual([])
  })

  test('updateApiKey serializes toggle and payload rule fields', async () => {
    redis.getApiKey.mockResolvedValue({
      id: 'key-1',
      apiKey: 'hashed-key',
      name: 'Old Key',
      isActive: 'true',
      tags: '[]'
    })
    redis.setApiKey.mockResolvedValue()

    await apiKeyService.updateApiKey('key-1', {
      enableOpenAIResponsesCodexAdaptation: false,
      enableOpenAIResponsesPayloadRules: true,
      openaiResponsesPayloadRules: [{ path: 'model', valueType: 'string', value: 'gpt-5' }]
    })

    const [, storedKeyData] = redis.setApiKey.mock.calls[0]
    expect(storedKeyData.enableOpenAIResponsesCodexAdaptation).toBe('false')
    expect(storedKeyData.enableOpenAIResponsesPayloadRules).toBe('true')
    expect(storedKeyData.openaiResponsesPayloadRules).toBe(
      JSON.stringify([{ path: 'model', valueType: 'string', value: 'gpt-5' }])
    )
  })

  test('getApiKeyById returns parsed toggle and rule values', async () => {
    redis.getApiKey.mockResolvedValue({
      id: 'key-1',
      name: 'Key',
      apiKey: 'hashed-key',
      tokenLimit: '0',
      isActive: 'true',
      createdAt: '2025-01-01T00:00:00.000Z',
      lastUsedAt: '',
      expiresAt: '',
      userId: '',
      userUsername: '',
      createdBy: 'admin',
      permissions: '[]',
      dailyCostLimit: '0',
      totalCostLimit: '0',
      claudeAccountId: '',
      claudeConsoleAccountId: '',
      geminiAccountId: '',
      openaiAccountId: '',
      bedrockAccountId: '',
      droidAccountId: '',
      azureOpenaiAccountId: '',
      ccrAccountId: '',
      enableOpenAIResponsesCodexAdaptation: 'false',
      enableOpenAIResponsesPayloadRules: 'true',
      openaiResponsesPayloadRules: JSON.stringify([
        { path: 'model', valueType: 'string', value: 'gpt-5' }
      ])
    })

    const result = await apiKeyService.getApiKeyById('key-1')

    expect(result.enableOpenAIResponsesCodexAdaptation).toBe(false)
    expect(result.enableOpenAIResponsesPayloadRules).toBe(true)
    expect(result.openaiResponsesPayloadRules).toEqual([
      { path: 'model', valueType: 'string', value: 'gpt-5' }
    ])
  })

  test('validateApiKeyForStats returns custom Claude weekly reset config', async () => {
    redis.findApiKeyByHash.mockResolvedValue({
      id: 'key-1',
      name: 'Key',
      description: '',
      isActive: 'true',
      isActivated: 'true',
      expiresAt: '',
      createdAt: '2025-01-01T00:00:00.000Z',
      activationDays: '0',
      activationUnit: 'days',
      activatedAt: '2025-01-01T00:00:00.000Z',
      claudeAccountId: '',
      claudeConsoleAccountId: '',
      geminiAccountId: '',
      openaiAccountId: '',
      azureOpenaiAccountId: '',
      bedrockAccountId: '',
      droidAccountId: '',
      permissions: '[]',
      tokenLimit: '0',
      concurrencyLimit: '0',
      rateLimitWindow: '0',
      rateLimitRequests: '0',
      rateLimitCost: '0',
      enableModelRestriction: 'false',
      enableClientRestriction: 'false',
      dailyCostLimit: '0',
      totalCostLimit: '0',
      weeklyOpusCostLimit: '100',
      weeklyResetDay: '3',
      weeklyResetHour: '19',
      tags: '[]',
      enableOpenAIResponsesCodexAdaptation: 'true',
      enableOpenAIResponsesPayloadRules: 'false',
      openaiResponsesPayloadRules: '[]'
    })
    redis.getDailyCost.mockResolvedValue(12.34)
    redis.getCostStats.mockResolvedValue({ total: 56.78 })
    redis.getUsageStats.mockResolvedValue({ total: { requests: 1 } })
    redis.getWeeklyOpusCost.mockResolvedValue(23.45)

    const result = await apiKeyService.validateApiKeyForStats('cr_test_key')

    expect(result.valid).toBe(true)
    expect(result.keyData.weeklyResetDay).toBe(3)
    expect(result.keyData.weeklyResetHour).toBe(19)
    expect(result.keyData.weeklyOpusCostLimit).toBe(100)
    expect(result.keyData.weeklyOpusCost).toBe(23.45)
    expect(redis.getWeeklyOpusCost).toHaveBeenCalledWith('key-1', 3, 19)
  })
})
