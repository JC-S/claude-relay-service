jest.mock('../src/models/redis', () => ({
  client: { get: jest.fn() }
}))

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn()
}))

const serviceRatesService = require('../src/services/serviceRatesService')

describe('serviceRatesService.calculateRatedCostWithKeyRates', () => {
  beforeEach(() => {
    jest.spyOn(serviceRatesService, 'getServiceRate').mockResolvedValue(1.5)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  test.each([
    [{ codex: 2 }, 6],
    [{ codex: '2' }, 6],
    [{ codex: 0 }, 0],
    [{}, 3],
    [{ codex: -1 }, 3],
    [{ codex: 'bad' }, 3]
  ])('normalizes key rates %#', async (keyRates, expected) => {
    await expect(
      serviceRatesService.calculateRatedCostWithKeyRates(2, 'codex', keyRates)
    ).resolves.toBe(expected)
  })

  test('returns zero for invalid real cost', async () => {
    await expect(
      serviceRatesService.calculateRatedCostWithKeyRates('bad', 'codex', { codex: 2 })
    ).resolves.toBe(0)
  })

  test('defends against an invalid global rate', async () => {
    serviceRatesService.getServiceRate.mockResolvedValue(0)
    await expect(
      serviceRatesService.calculateRatedCostWithKeyRates(2, 'codex', { codex: 2 })
    ).resolves.toBe(4)
  })
})
