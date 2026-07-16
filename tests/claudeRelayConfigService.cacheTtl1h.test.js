const mockRedisClient = {
  get: jest.fn(),
  set: jest.fn()
}

jest.mock('../src/models/redis', () => ({
  getClient: jest.fn(() => mockRedisClient),
  getClientSafe: jest.fn(() => mockRedisClient)
}))

jest.mock('../src/utils/logger', () => ({
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn()
}))

const redis = require('../src/models/redis')
const service = require('../src/services/claudeRelayConfigService')

describe('Claude relay Anthropic cache TTL 1h config', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    service.clearCache()
    redis.getClient.mockReturnValue(mockRedisClient)
    redis.getClientSafe.mockReturnValue(mockRedisClient)
    mockRedisClient.get.mockResolvedValue(null)
    mockRedisClient.set.mockResolvedValue('OK')
  })

  test('defaults to disabled for old, unavailable, or invalid Redis data', async () => {
    mockRedisClient.get.mockResolvedValue(JSON.stringify({ claudeCodeOnlyEnabled: true }))
    expect((await service.getConfig()).anthropicCacheTtl1hInjectionEnabled).toBe(false)
    expect(await service.isAnthropicCacheTtl1hInjectionEnabled()).toBe(false)

    service.clearCache()
    redis.getClient.mockReturnValue(null)
    expect(await service.isAnthropicCacheTtl1hInjectionEnabled()).toBe(false)

    service.clearCache()
    redis.getClient.mockReturnValue(mockRedisClient)
    mockRedisClient.get.mockResolvedValue('{invalid-json')
    expect(await service.isAnthropicCacheTtl1hInjectionEnabled()).toBe(false)
  })

  test('only treats strict boolean true as enabled', async () => {
    mockRedisClient.get.mockResolvedValue(
      JSON.stringify({ anthropicCacheTtl1hInjectionEnabled: 'true' })
    )
    expect(await service.isAnthropicCacheTtl1hInjectionEnabled()).toBe(false)

    service.clearCache()
    mockRedisClient.get.mockResolvedValue(
      JSON.stringify({ anthropicCacheTtl1hInjectionEnabled: true })
    )
    expect(await service.isAnthropicCacheTtl1hInjectionEnabled()).toBe(true)
  })

  test('persists updates and refreshes the process cache', async () => {
    const updated = await service.updateConfig(
      { anthropicCacheTtl1hInjectionEnabled: true },
      'admin'
    )
    const persisted = JSON.parse(mockRedisClient.set.mock.calls[0][1])

    expect(updated.anthropicCacheTtl1hInjectionEnabled).toBe(true)
    expect(persisted.anthropicCacheTtl1hInjectionEnabled).toBe(true)
    expect(await service.isAnthropicCacheTtl1hInjectionEnabled()).toBe(true)
    expect(mockRedisClient.get).toHaveBeenCalledTimes(1)
  })
})
