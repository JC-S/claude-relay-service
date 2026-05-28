function createRedisMock() {
  const store = new Map()
  const expirations = new Map()
  let counter = 0

  const redisMock = {
    store,
    get: jest.fn(async (key) => store.get(key) || null),
    set: jest.fn(async (key, value, ...args) => {
      const nx = args.includes('NX')
      if (nx && store.has(key)) {
        return null
      }
      store.set(key, value)
      const exIndex = args.indexOf('EX')
      if (exIndex !== -1) {
        expirations.set(key, Number(args[exIndex + 1]))
      }
      return 'OK'
    }),
    expire: jest.fn(async () => 1),
    ttl: jest.fn(async (key) => {
      if (!store.has(key)) {
        return -2
      }
      return expirations.has(key) ? expirations.get(key) : -1
    }),
    incr: jest.fn(async () => {
      counter += 1
      return counter
    }),
    del: jest.fn(async (key) => {
      expirations.delete(key)
      return store.delete(key) ? 1 : 0
    })
  }

  redisMock.pipeline = jest.fn(() => {
    const ttlKeys = []
    return {
      ttl: jest.fn((key) => {
        ttlKeys.push(key)
      }),
      exec: jest.fn(async () =>
        Promise.all(ttlKeys.map(async (key) => [null, await redisMock.ttl(key)]))
      )
    }
  })

  return redisMock
}

const ORIGINAL_ENV = { ...process.env }

function loadSelector({ addresses = [], redisClient = createRedisMock(), configMock = null } = {}) {
  jest.resetModules()
  jest.unmock('../config/config')
  jest.unmock('../src/models/redis')
  jest.unmock('../src/utils/logger')

  let selector
  jest.isolateModules(() => {
    jest.doMock(
      '../config/config',
      () =>
        configMock || {
          openaiNicInterleave: {
            localAddresses: addresses
          }
        }
    )
    jest.doMock('../src/models/redis', () => ({
      getClient: jest.fn(() => redisClient)
    }))
    jest.doMock('../src/utils/logger', () => ({
      warn: jest.fn()
    }))
    selector = require('../src/utils/openaiNicSelector')
  })

  return { selector, redisClient }
}

describe('openaiNicSelector', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
    jest.resetModules()
    jest.unmock('../config/config')
    jest.unmock('../src/models/redis')
    jest.unmock('../src/utils/logger')
  })

  test('requires at least two configured local addresses', async () => {
    const { selector } = loadSelector({ addresses: ['10.0.0.191'] })

    expect(selector.isAvailable()).toBe(false)
    await expect(
      selector.chooseLocalAddress({ accountId: 'acct_1', sessionHash: 'session_1' })
    ).resolves.toBeNull()
  })

  test('binds account and session hash, then renews the binding TTL', async () => {
    const { selector, redisClient } = loadSelector({
      addresses: ['10.0.0.191', '10.0.0.184']
    })

    const first = await selector.chooseLocalAddress({
      accountId: 'acct_1',
      sessionHash: 'session_hash',
      ttlHours: 12
    })
    const second = await selector.chooseLocalAddress({
      accountId: 'acct_1',
      sessionHash: 'session_hash',
      ttlHours: 12
    })

    expect(first).toBe('10.0.0.191')
    expect(second).toBe(first)
    expect(redisClient.set).toHaveBeenCalledWith(
      'openai:nic_binding:acct_1:session_hash',
      '10.0.0.191',
      'NX',
      'EX',
      43200
    )
    expect(redisClient.expire).toHaveBeenCalledWith('openai:nic_binding:acct_1:session_hash', 43200)
  })

  test('keeps identical session hashes isolated by account id', async () => {
    const { selector, redisClient } = loadSelector({
      addresses: ['10.0.0.191', '10.0.0.184']
    })

    const first = await selector.chooseLocalAddress({
      accountId: 'acct_1',
      sessionHash: 'same_hash'
    })
    const second = await selector.chooseLocalAddress({
      accountId: 'acct_2',
      sessionHash: 'same_hash'
    })

    expect(first).toBe('10.0.0.191')
    expect(second).toBe('10.0.0.184')
    expect(redisClient.store.get('openai:nic_binding:acct_1:same_hash')).toBe('10.0.0.191')
    expect(redisClient.store.get('openai:nic_binding:acct_2:same_hash')).toBe('10.0.0.184')
  })

  test('uses round-robin without writing a binding when session hash is missing', async () => {
    const { selector, redisClient } = loadSelector({
      addresses: ['10.0.0.191', '10.0.0.184']
    })

    await expect(selector.chooseLocalAddress({ accountId: 'acct_1' })).resolves.toBe('10.0.0.191')
    await expect(selector.chooseLocalAddress({ accountId: 'acct_1' })).resolves.toBe('10.0.0.184')
    expect(redisClient.set).not.toHaveBeenCalled()
  })

  test('returns null instead of throwing on redis errors', async () => {
    const redisClient = createRedisMock()
    redisClient.incr.mockRejectedValueOnce(new Error('READONLY'))
    const { selector } = loadSelector({
      addresses: ['10.0.0.191', '10.0.0.184'],
      redisClient
    })

    await expect(selector.chooseLocalAddress({ accountId: 'acct_1' })).resolves.toBeNull()
  })

  test('falls back to env addresses when config does not include the interleave section', () => {
    process.env.OPENAI_UPSTREAM_LOCAL_ADDRESSES = '10.0.0.191, 10.0.0.184'
    const { selector } = loadSelector({ configMock: {} })

    expect(selector.getConfiguredLocalAddresses()).toEqual(['10.0.0.191', '10.0.0.184'])
    expect(selector.isAvailable()).toBe(true)
  })

  test('normalizes TTL hours to default and allowed bounds', () => {
    const { selector } = loadSelector({ addresses: ['10.0.0.191', '10.0.0.184'] })

    expect(selector.normalizeTtlHours('abc')).toBe(24)
    expect(selector.normalizeTtlHours(Number.NaN)).toBe(24)
    expect(selector.normalizeTtlHours(0)).toBe(1)
    expect(selector.normalizeTtlHours(-5)).toBe(1)
    expect(selector.normalizeTtlHours(73)).toBe(72)
  })

  test('uses winning binding when SET NX loses a concurrent race', async () => {
    const redisClient = createRedisMock()
    redisClient.get = jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('10.0.0.184')
    redisClient.set = jest.fn(async () => null)
    const { selector } = loadSelector({
      addresses: ['10.0.0.191', '10.0.0.184'],
      redisClient
    })

    await expect(
      selector.chooseLocalAddress({ accountId: 'acct_1', sessionHash: 'race_hash' })
    ).resolves.toBe('10.0.0.184')
    expect(redisClient.expire).toHaveBeenCalledWith('openai:nic_binding:acct_1:race_hash', 86400)
  })

  test('rebinds when existing binding address is no longer configured', async () => {
    const redisClient = createRedisMock()
    redisClient.store.set('openai:nic_binding:acct_1:stale_hash', '10.0.0.200')
    const { selector } = loadSelector({
      addresses: ['10.0.0.191', '10.0.0.184'],
      redisClient
    })

    await expect(
      selector.chooseLocalAddress({ accountId: 'acct_1', sessionHash: 'stale_hash' })
    ).resolves.toBe('10.0.0.191')
    expect(redisClient.store.get('openai:nic_binding:acct_1:stale_hash')).toBe('10.0.0.191')
  })

  test('reports per-address cooldown snapshot', async () => {
    const { selector } = loadSelector({
      addresses: ['10.0.0.191', '10.0.0.184']
    })

    await expect(
      selector.markCooldown({
        accountId: 'acct_1',
        localAddress: '10.0.0.191',
        cooldownSeconds: 120
      })
    ).resolves.toEqual(
      expect.objectContaining({
        marked: true,
        localAddress: '10.0.0.191',
        ttlSeconds: 120
      })
    )

    await expect(selector.getCooldownSnapshot({ accountId: 'acct_1' })).resolves.toMatchObject({
      configured: true,
      totalCount: 2,
      availableCount: 1,
      addresses: [
        {
          localAddress: '10.0.0.191',
          status: 'cooldown',
          active: true,
          ttlSeconds: 120
        },
        {
          localAddress: '10.0.0.184',
          status: 'available',
          active: false,
          ttlSeconds: 0
        }
      ]
    })
  })
})
