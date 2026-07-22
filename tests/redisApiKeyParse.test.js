jest.mock(
  '../config/config',
  () => ({
    system: {
      timezoneOffset: 8
    }
  }),
  { virtual: true }
)

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  debug: jest.fn()
}))

const redis = require('../src/models/redis')

describe('redis api key parsing', () => {
  test('parses openai responses toggle and rule fields for list data', () => {
    const parsed = redis._parseApiKeyData({
      enableOpenAIResponsesCodexAdaptation: 'false',
      enableOpenAIResponsesPayloadRules: 'true',
      enableIpWhitelist: 'true',
      disableGptFastMode: 'true',
      enableGeneralOpenAIEndpoint: 'true',
      enableGeneralOpenAIImages: 'true',
      enableGeneralPromptCacheAssist: 'true',
      enableClaudeThinkingSignatureLossyFallback: 'true',
      anthropicCacheTtl1hOverrideEnabled: 'true',
      anthropicCacheTtl1hInjectionEnabled: 'true',
      ipWhitelist: JSON.stringify(['203.0.113.10', '2001:db8::1']),
      openaiResponsesPayloadRules: JSON.stringify([
        { path: 'model', valueType: 'string', value: 'gpt-5' }
      ])
    })

    expect(parsed.enableOpenAIResponsesCodexAdaptation).toBe(false)
    expect(parsed.enableOpenAIResponsesPayloadRules).toBe(true)
    expect(parsed.enableIpWhitelist).toBe(true)
    expect(parsed.disableGptFastMode).toBe(true)
    expect(parsed.enableGeneralOpenAIEndpoint).toBe(true)
    expect(parsed.enableGeneralOpenAIImages).toBe(true)
    expect(parsed.enableGeneralPromptCacheAssist).toBe(true)
    expect(parsed.enableClaudeThinkingSignatureLossyFallback).toBe(true)
    expect(parsed.anthropicCacheTtl1hOverrideEnabled).toBe(true)
    expect(parsed.anthropicCacheTtl1hInjectionEnabled).toBe(true)
    expect(parsed.ipWhitelist).toEqual(['203.0.113.10', '2001:db8::1'])
    expect(parsed.openaiResponsesPayloadRules).toEqual([
      { path: 'model', valueType: 'string', value: 'gpt-5' }
    ])
  })

  test('strips reversible/secret fields from batch list/pagination data', () => {
    const parsed = redis._parseApiKeyData({
      name: 'k1',
      apiKey: 'hashed-value',
      encryptedApiKey: 'iv:cipher',
      v2PasswordHash: 'bcrypt-hash'
    })

    // 🔒 可逆明文副本与 v2 密码 hash 绝不经 batchGetApiKeys（列表/分页/索引/费用排序）路径返回
    expect(parsed).not.toHaveProperty('encryptedApiKey')
    expect(parsed).not.toHaveProperty('v2PasswordHash')
    // 普通字段正常透传
    expect(parsed.name).toBe('k1')
  })

  test('uses safe defaults for missing openai responses fields', () => {
    const parsed = redis._parseApiKeyData({})

    expect(parsed.enableOpenAIResponsesCodexAdaptation).toBe(true)
    expect(parsed.enableOpenAIResponsesPayloadRules).toBe(false)
    expect(parsed.enableIpWhitelist).toBe(false)
    expect(parsed.disableGptFastMode).toBe(false)
    expect(parsed.enableGeneralOpenAIEndpoint).toBe(false)
    expect(parsed.enableGeneralOpenAIImages).toBe(false)
    expect(parsed.enableGeneralPromptCacheAssist).toBe(false)
    expect(parsed.enableClaudeThinkingSignatureLossyFallback).toBe(false)
    expect(parsed.anthropicCacheTtl1hOverrideEnabled).toBe(false)
    expect(parsed.anthropicCacheTtl1hInjectionEnabled).toBe(false)
    expect(parsed.ipWhitelist).toEqual([])
    expect(parsed.openaiResponsesPayloadRules).toEqual([])
  })
})
