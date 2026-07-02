function loadService(initialAccount = {}) {
  jest.resetModules()

  let accountData = { id: 'acct_1', ...initialAccount }
  const redisMock = {
    getClaudeAccount: jest.fn(async () => accountData),
    setClaudeAccount: jest.fn(async (_accountId, data) => {
      accountData = { ...data }
    }),
    client: {
      hdel: jest.fn()
    }
  }

  jest.isolateModules(() => {
    jest.doMock('../src/models/redis', () => redisMock)
    jest.doMock('../src/utils/logger', () => ({
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      success: jest.fn()
    }))
    jest.doMock(
      '../config/config',
      () => ({
        system: { timezoneOffset: 8 },
        claude: {
          fiveHourWarning: { maxNotificationsPerWindow: 1 }
        }
      }),
      { virtual: true }
    )
  })

  const service = require('../src/services/account/claudeAccountService')
  return {
    service,
    redisMock,
    getAccountData: () => accountData
  }
}

describe('Claude OAuth usage snapshot', () => {
  let dateNowSpy

  beforeEach(() => {
    dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-02T00:00:00.000Z'))
  })

  afterEach(() => {
    dateNowSpy.mockRestore()
    jest.restoreAllMocks()
    jest.resetModules()
  })

  test('stores and exposes the new seven day Fable quota window', async () => {
    const { service, redisMock, getAccountData } = loadService()

    await service.updateClaudeUsageSnapshot('acct_1', {
      seven_day_fable: {
        utilization: 42,
        resets_at: '2026-07-09T00:00:00.000Z'
      }
    })

    expect(redisMock.setClaudeAccount).toHaveBeenCalledWith(
      'acct_1',
      expect.objectContaining({
        claudeSevenDayFableUtilization: '42',
        claudeSevenDayFableResetsAt: '2026-07-09T00:00:00.000Z',
        claudeSevenDaySpecialLimitType: 'fable',
        claudeSevenDaySpecialLimitKey: 'seven_day_fable'
      })
    )

    const snapshot = service.buildClaudeUsageSnapshot(getAccountData())
    expect(snapshot.sevenDayFable).toMatchObject({
      utilization: 42,
      resetsAt: '2026-07-09T00:00:00.000Z',
      type: 'fable',
      label: 'Fable'
    })
    expect(snapshot.sevenDaySpecial).toBe(snapshot.sevenDayFable)
    expect(snapshot.sevenDayOpus).toBe(snapshot.sevenDayFable)
  })

  test('keeps accepting the legacy seven day Sonnet quota window', async () => {
    const { service, getAccountData } = loadService()

    await service.updateClaudeUsageSnapshot('acct_1', {
      seven_day_sonnet: {
        utilization: 18,
        resets_at: '2026-07-08T00:00:00.000Z'
      }
    })

    const stored = getAccountData()
    expect(stored).toMatchObject({
      claudeSevenDayFableUtilization: '18',
      claudeSevenDayFableResetsAt: '2026-07-08T00:00:00.000Z',
      claudeSevenDaySpecialLimitType: 'sonnet',
      claudeSevenDaySpecialLimitKey: 'seven_day_sonnet'
    })

    expect(service.buildClaudeUsageSnapshot(stored).sevenDayFable).toMatchObject({
      utilization: 18,
      type: 'sonnet',
      label: 'Sonnet'
    })
  })

  test('reads existing legacy Redis fields as the current Fable quota window', () => {
    const { service } = loadService()

    const snapshot = service.buildClaudeUsageSnapshot({
      claudeUsageUpdatedAt: '2026-07-02T00:00:00.000Z',
      claudeSevenDayOpusUtilization: '77',
      claudeSevenDayOpusResetsAt: '2026-07-08T00:00:00.000Z'
    })

    expect(snapshot.sevenDayFable).toMatchObject({
      utilization: 77,
      resetsAt: '2026-07-08T00:00:00.000Z',
      type: 'fable',
      label: 'Fable'
    })
  })
})
