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

const service = require('../src/services/claudeRelayConfigService')

const DEFAULT_MESSAGE = 'Your local session is no longer valid. Please clear it and try again.'
const LEGACY_MESSAGE = '你的本地session已污染，请清理后使用。'

describe('Claude relay session message normalization', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    service.clearCache()
  })

  test('uses the English default when Redis has no config', async () => {
    mockRedisClient.get.mockResolvedValue(null)

    const config = await service.getConfig()

    expect(config.sessionBindingErrorMessage).toBe(DEFAULT_MESSAGE)
    expect(await service.getSessionBindingErrorMessage()).toBe(DEFAULT_MESSAGE)
  })

  test('normalizes the legacy Redis default for getters and validation', async () => {
    mockRedisClient.get.mockResolvedValue(
      JSON.stringify({
        globalSessionBindingEnabled: true,
        sessionBindingErrorMessage: LEGACY_MESSAGE
      })
    )
    jest.spyOn(service, 'getOriginalSessionBinding').mockResolvedValue({
      accountId: 'account_1',
      accountType: 'claude-official'
    })
    jest.spyOn(service, 'validateBoundAccount').mockResolvedValue(false)

    expect((await service.getConfig()).sessionBindingErrorMessage).toBe(DEFAULT_MESSAGE)
    expect(await service.getSessionBindingErrorMessage()).toBe(DEFAULT_MESSAGE)
    await expect(service.validateNewSession({}, 'session_1')).resolves.toEqual({
      valid: false,
      error: DEFAULT_MESSAGE,
      code: 'SESSION_BINDING_INVALID'
    })
  })

  test.each([undefined, null, '', '   ', LEGACY_MESSAGE])(
    'normalizes invalid update value %p before writing Redis',
    async (sessionBindingErrorMessage) => {
      mockRedisClient.get.mockResolvedValue(null)

      const updated = await service.updateConfig({ sessionBindingErrorMessage }, 'admin')
      const persisted = JSON.parse(mockRedisClient.set.mock.calls[0][1])

      expect(updated.sessionBindingErrorMessage).toBe(DEFAULT_MESSAGE)
      expect(persisted.sessionBindingErrorMessage).toBe(DEFAULT_MESSAGE)
      expect((await service.getConfig()).sessionBindingErrorMessage).toBe(DEFAULT_MESSAGE)
    }
  )

  test('normalizes a legacy value reintroduced into the live cache', async () => {
    mockRedisClient.get.mockResolvedValue(null)
    const config = await service.getConfig()
    config.sessionBindingErrorMessage = LEGACY_MESSAGE

    expect((await service.getConfig()).sessionBindingErrorMessage).toBe(DEFAULT_MESSAGE)
  })

  test('preserves administrator-defined messages across cache clears', async () => {
    const customMessage = 'Start a new session before retrying.'
    mockRedisClient.get.mockResolvedValue(
      JSON.stringify({ sessionBindingErrorMessage: customMessage })
    )

    expect((await service.getConfig()).sessionBindingErrorMessage).toBe(customMessage)
    service.clearCache()
    expect((await service.getConfig()).sessionBindingErrorMessage).toBe(customMessage)
  })
})
