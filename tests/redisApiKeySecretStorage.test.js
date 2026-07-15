jest.mock('../config/config', () => ({ system: { timezoneOffset: 8 } }), { virtual: true })
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  debug: jest.fn()
}))

const fs = require('fs')
const path = require('path')
const redis = require('../src/models/redis')

describe('redis API key credential storage boundaries', () => {
  let originalClient
  let originalConnected

  beforeEach(() => {
    originalClient = redis.client
    originalConnected = redis.isConnected
    redis.isConnected = true
  })

  afterEach(() => {
    redis.client = originalClient
    redis.isConnected = originalConnected
  })

  test('targeted updates refresh the rolling TTL', async () => {
    const evalMock = jest.fn().mockResolvedValue(1)
    redis.client = { eval: evalMock }

    const updated = await redis.updateApiKeyFields('key-1', { lastUsedAt: 'now' })

    expect(updated).toBe(true)
    expect(evalMock.mock.calls[0]).toEqual(
      expect.arrayContaining(['apikey:key-1', 'lastUsedAt', 'now', String(86400 * 365)])
    )
    expect(evalMock.mock.calls[0][0]).toContain("redis.call('EXPIRE'")
  })

  test.each(['apiKey', 'encryptedApiKey', 'apiKeyGenerationMode', 'apiKeyHint'])(
    'targeted updates reject credential field %s',
    async (field) => {
      await expect(
        redis.updateApiKeyFields('key-1', { [field]: 'forbidden' })
      ).rejects.toMatchObject({ code: 'API_KEY_CREDENTIAL_WRITE_FORBIDDEN' })
    }
  )

  test('targeted updates do not recreate a physically deleted record', async () => {
    redis.client = { eval: jest.fn().mockResolvedValue(0) }

    await expect(
      redis.updateApiKeyFields('deleted-key', { lastUsedAt: 'now' })
    ).rejects.toMatchObject({ code: 'API_KEY_NOT_FOUND' })
  })

  test('rotation delegates all credential changes to one Lua script without changing TTL', async () => {
    const evalMock = jest.fn().mockResolvedValue('OK')
    redis.client = { eval: evalMock }

    const result = await redis.rotateApiKeySecret({
      keyId: 'key-1',
      expectedOldHash: 'a'.repeat(64),
      newHash: 'b'.repeat(64),
      encryptedApiKey: 'iv:cipher',
      generationMode: 'system',
      apiKeyHint: 'abcd',
      updatedAt: 'now'
    })

    expect(result).toBe('OK')
    const script = evalMock.mock.calls[0][0]
    expect(script).toContain("'encryptedApiKey'")
    expect(script).not.toMatch(/redis\.call\(['"]EXPIRE/i)
  })

  test('findApiKeyByHash safely repairs a completely missing mapping from the registry', async () => {
    const hashedKey = 'd'.repeat(64)
    redis.client = {
      hget: jest.fn((key) => {
        if (key === 'apikey:hash_map') {
          return Promise.resolve(null)
        }
        if (key === 'apikey_secret_registry') {
          return Promise.resolve('key-1')
        }
        return Promise.resolve(null)
      }),
      hgetall: jest.fn((key) => {
        if (key === 'apikey:key-1') {
          return Promise.resolve({ apiKey: hashedKey, isActive: 'true' })
        }
        return Promise.resolve({})
      }),
      eval: jest.fn().mockResolvedValue('REPAIRED')
    }

    await expect(redis.findApiKeyByHash(hashedKey)).resolves.toEqual({
      id: 'key-1',
      apiKey: hashedKey,
      isActive: 'true'
    })
    expect(redis.client.eval.mock.calls[0]).toEqual(expect.arrayContaining(['key-1', hashedKey]))
  })

  test('sanitized imports atomically blank the credential and never register a callable hash', async () => {
    const evalMock = jest.fn().mockResolvedValue('OK')
    redis.client = { eval: evalMock }

    await redis.importApiKeyRecord(
      'key-1',
      { id: 'key-1', apiKey: 'a'.repeat(64), name: 'sanitized' },
      { hashedKey: 'a'.repeat(64), sanitized: true }
    )

    const call = evalMock.mock.calls[0]
    const apiKeyFieldIndex = call.indexOf('apiKey')
    expect(call).toEqual(expect.arrayContaining(['key-1', '', '1']))
    expect(call[apiKeyFieldIndex + 1]).toBe('')
    expect(evalMock).toHaveBeenCalledTimes(1)
  })

  test('non-sanitized imports reject malformed hashes before writing', async () => {
    redis.client = { eval: jest.fn() }

    await expect(
      redis.importApiKeyRecord(
        'key-1',
        { id: 'key-1', apiKey: 'not-a-hash' },
        { hashedKey: 'not-a-hash' }
      )
    ).rejects.toMatchObject({ code: 'INVALID_API_KEY_HASH' })
    expect(redis.client.eval).not.toHaveBeenCalled()
  })

  test('imports surface historical-secret reuse as a conflict', async () => {
    redis.client = { eval: jest.fn().mockResolvedValue('HISTORY_CONFLICT') }

    await expect(
      redis.importApiKeyRecord(
        'key-1',
        { id: 'key-1', apiKey: 'e'.repeat(64) },
        { hashedKey: 'e'.repeat(64) }
      )
    ).rejects.toMatchObject({ code: 'HISTORY_CONFLICT' })
  })

  test('the creation-only full record writer has one production call site', () => {
    const srcRoot = path.join(__dirname, '..', 'src')
    const serviceSource = fs.readFileSync(
      path.join(srcRoot, 'services', 'apiKeyService.js'),
      'utf8'
    )
    expect((serviceSource.match(/redis\.setApiKey\(/g) || []).length).toBe(1)
  })
})
