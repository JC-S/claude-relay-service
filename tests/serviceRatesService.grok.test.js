jest.mock('../src/models/redis', () => ({
  client: { get: jest.fn(), set: jest.fn() }
}))
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), error: jest.fn() }))

const serviceRatesService = require('../src/services/serviceRatesService')

describe('serviceRatesService Grok classification', () => {
  test('uses an independent Grok rate for account and model inference', () => {
    expect(serviceRatesService.getDefaultRates().rates.grok).toBe(1)
    expect(serviceRatesService.getServiceFromAccountType('grok')).toBe('grok')
    expect(serviceRatesService.getServiceFromModel('grok-composer-2.5-fast')).toBe('grok')
    expect(serviceRatesService.getService('grok', 'claude-opus-4-7')).toBe('grok')
  })
})
