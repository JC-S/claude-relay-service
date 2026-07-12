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

describe('Claude relay GPT-Image stream keepalive config', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    service.clearCache()
    redis.getClient.mockReturnValue(mockRedisClient)
    redis.getClientSafe.mockReturnValue(mockRedisClient)
    mockRedisClient.get.mockResolvedValue(null)
    mockRedisClient.set.mockResolvedValue('OK')
  })

  test('defaults to disabled when old Redis data omits the field', async () => {
    mockRedisClient.get.mockResolvedValue(JSON.stringify({ claudeCodeOnlyEnabled: true }))

    expect((await service.getConfig()).openAIImageStreamKeepAliveEnabled).toBe(false)
    expect(await service.isOpenAIImageStreamKeepAliveEnabled()).toBe(false)
  })

  test('defaults to disabled when Redis is unavailable or contains invalid JSON', async () => {
    redis.getClient.mockReturnValue(null)
    expect(await service.isOpenAIImageStreamKeepAliveEnabled()).toBe(false)

    service.clearCache()
    redis.getClient.mockReturnValue(mockRedisClient)
    mockRedisClient.get.mockResolvedValue('{invalid-json')
    expect(await service.isOpenAIImageStreamKeepAliveEnabled()).toBe(false)
  })

  test('only treats the strict boolean true as enabled', async () => {
    mockRedisClient.get.mockResolvedValue(
      JSON.stringify({ openAIImageStreamKeepAliveEnabled: 'true' })
    )
    expect(await service.isOpenAIImageStreamKeepAliveEnabled()).toBe(false)

    service.clearCache()
    mockRedisClient.get.mockResolvedValue(
      JSON.stringify({ openAIImageStreamKeepAliveEnabled: true })
    )
    expect(await service.isOpenAIImageStreamKeepAliveEnabled()).toBe(true)
  })

  test('persists updates and refreshes the in-process cache immediately', async () => {
    const updated = await service.updateConfig({ openAIImageStreamKeepAliveEnabled: true }, 'admin')
    const persisted = JSON.parse(mockRedisClient.set.mock.calls[0][1])

    expect(updated.openAIImageStreamKeepAliveEnabled).toBe(true)
    expect(persisted.openAIImageStreamKeepAliveEnabled).toBe(true)
    expect(await service.isOpenAIImageStreamKeepAliveEnabled()).toBe(true)
    expect(mockRedisClient.get).toHaveBeenCalledTimes(1)
  })
})
