jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))

const apiKeyIndexService = require('../src/services/apiKeyIndexService')

function createFakeRedis(records) {
  const registry = new Map()

  const execute = (command, args) => {
    if (command === 'hget') {
      const [key, field] = args
      if (key === 'apikey_secret_registry') return registry.get(field) || null
      if (key.startsWith('apikey:') && field === 'apiKey') {
        return records[key.slice('apikey:'.length)] || null
      }
    }
    if (command === 'hsetnx') {
      const [, field, value] = args
      if (registry.has(field)) return 0
      registry.set(field, value)
      return 1
    }
    throw new Error(`Unsupported fake Redis command: ${command}`)
  }

  const client = {
    hget: jest.fn((...args) => Promise.resolve(execute('hget', args))),
    hset: jest.fn((_key, field, value) => {
      registry.set(field, value)
      return Promise.resolve(1)
    }),
    pipeline: jest.fn(() => {
      const commands = []
      return {
        hget: (...args) => commands.push(['hget', args]),
        hsetnx: (...args) => commands.push(['hsetnx', args]),
        exec: async () => commands.map(([command, args]) => [null, execute(command, args)])
      }
    })
  }

  return {
    registry,
    getClientSafe: () => client,
    scanApiKeyIds: jest.fn().mockResolvedValue(Object.keys(records)),
    setAccountLock: jest.fn().mockResolvedValue(true),
    releaseAccountLock: jest.fn().mockResolvedValue(true)
  }
}

describe('API key secret registry startup backfill', () => {
  afterEach(() => {
    apiKeyIndexService.redis = null
  })

  test('backfills all current hashes and marks the registry ready', async () => {
    const redis = createFakeRedis({ key1: 'a'.repeat(64), key2: 'b'.repeat(64) })
    apiKeyIndexService.init(redis)

    await apiKeyIndexService.rebuildSecretRegistry()

    expect(redis.registry.get('a'.repeat(64))).toBe('key1')
    expect(redis.registry.get('b'.repeat(64))).toBe('key2')
    expect(redis.registry.get('__ready__')).toBe('v1')
    expect(redis.releaseAccountLock).toHaveBeenCalledTimes(1)
  })

  test('does not mark ready when two records contain the same hash', async () => {
    const duplicateHash = 'c'.repeat(64)
    const redis = createFakeRedis({ key1: duplicateHash, key2: duplicateHash })
    apiKeyIndexService.init(redis)

    await expect(apiKeyIndexService.rebuildSecretRegistry()).rejects.toThrow(
      'Duplicate API key secret'
    )

    expect(redis.registry.get('__ready__')).toBeUndefined()
    expect(redis.releaseAccountLock).toHaveBeenCalledTimes(1)
  })
})
