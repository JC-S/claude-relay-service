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

  test('stores Fable quota from the new OAuth usage limits array', async () => {
    const { service, getAccountData } = loadService()

    await service.updateClaudeUsageSnapshot('acct_1', {
      five_hour: {
        utilization: 11,
        resets_at: '2026-07-02T03:59:59.246272+00:00'
      },
      seven_day: {
        utilization: 3,
        resets_at: '2026-07-08T10:59:59.246299+00:00'
      },
      seven_day_sonnet: null,
      seven_day_opus: null,
      limits: [
        {
          kind: 'session',
          group: 'session',
          percent: 11,
          resets_at: '2026-07-02T03:59:59.246272+00:00',
          scope: null
        },
        {
          kind: 'weekly_scoped',
          group: 'weekly',
          percent: 4,
          resets_at: '2026-07-08T10:59:59.246653+00:00',
          scope: {
            model: {
              id: null,
              display_name: 'Fable'
            },
            surface: null
          }
        }
      ]
    })

    const stored = getAccountData()
    expect(stored).toMatchObject({
      claudeSevenDayFableUtilization: '4',
      claudeSevenDayFableResetsAt: '2026-07-08T10:59:59.246653+00:00',
      claudeSevenDaySpecialLimitType: 'fable',
      claudeSevenDaySpecialLimitKey: 'limits.weekly_scoped'
    })

    expect(service.buildClaudeUsageSnapshot(stored).sevenDayFable).toMatchObject({
      utilization: 4,
      resetsAt: '2026-07-08T10:59:59.246653+00:00',
      type: 'fable',
      label: 'Fable'
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

  test('clears stale special quota fields when the latest usage response has none', async () => {
    const { service, getAccountData } = loadService({
      claudeSevenDayFableUtilization: '42',
      claudeSevenDayFableResetsAt: '2026-07-09T00:00:00.000Z',
      claudeSevenDaySpecialLimitType: 'fable',
      claudeSevenDaySpecialLimitKey: 'seven_day_fable',
      claudeSevenDayOpusUtilization: '77',
      claudeSevenDayOpusResetsAt: '2026-07-08T00:00:00.000Z'
    })

    await service.updateClaudeUsageSnapshot('acct_1', {
      five_hour: {
        utilization: 8,
        resets_at: '2026-07-02T04:00:00.000Z'
      },
      seven_day: {
        utilization: 2,
        resets_at: '2026-07-08T11:00:00.000Z'
      }
    })

    const stored = getAccountData()
    expect(stored).toMatchObject({
      claudeSevenDayFableUtilization: '',
      claudeSevenDayFableResetsAt: '',
      claudeSevenDaySpecialLimitType: '',
      claudeSevenDaySpecialLimitKey: '',
      claudeSevenDayOpusUtilization: '',
      claudeSevenDayOpusResetsAt: ''
    })

    const snapshot = service.buildClaudeUsageSnapshot(stored)
    expect(snapshot.sevenDaySpecial).toBeNull()
    expect(snapshot.sevenDayFable).toBeNull()
    expect(snapshot.sevenDayOpus).toBeNull()
  })
})
