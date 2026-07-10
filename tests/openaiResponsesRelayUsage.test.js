const { PassThrough } = require('stream')

jest.mock('../config/config', () => ({ requestTimeout: 1000 }), { virtual: true })
jest.mock('axios')
jest.mock('../src/utils/proxyHelper', () => ({}))
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  api: jest.fn(),
  security: jest.fn()
}))
jest.mock('../src/utils/headerFilter', () => ({ filterForOpenAI: jest.fn(() => ({})) }))
jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  updateAccountUsage: jest.fn(),
  updateUsageQuota: jest.fn()
}))
jest.mock('../src/services/apiKeyService', () => ({
  recordUsage: jest.fn()
}))
jest.mock('../src/services/scheduler/unifiedOpenAIScheduler', () => ({
  markAccountRateLimited: jest.fn()
}))
jest.mock('../src/utils/upstreamErrorHelper', () => ({}))
jest.mock('../src/utils/requestDetailHelper', () => ({
  createRequestDetailMeta: jest.fn((_req, overrides) => overrides)
}))
jest.mock('../src/utils/costCalculator', () => ({
  calculateCost: jest.fn()
}))

const openaiResponsesAccountService = require('../src/services/account/openaiResponsesAccountService')
const apiKeyService = require('../src/services/apiKeyService')
const CostCalculator = require('../src/utils/costCalculator')
const openaiResponsesRelayService = require('../src/services/relay/openaiResponsesRelayService')

function createReq() {
  return {
    body: { model: 'gpt-5.6-sol', stream: false },
    _serviceTier: 'priority',
    removeListener: jest.fn(),
    on: jest.fn()
  }
}

function createRes() {
  const res = {
    statusCode: 200,
    destroyed: false,
    status: jest.fn(() => res),
    json: jest.fn(() => res),
    setHeader: jest.fn(),
    write: jest.fn(),
    end: jest.fn(),
    removeListener: jest.fn()
  }
  return res
}

function createUsage() {
  return {
    input_tokens: 100000,
    output_tokens: 10000,
    total_tokens: 110000,
    input_tokens_details: {
      cached_tokens: 20000,
      cache_write_tokens: 30000
    }
  }
}

describe('OpenAIResponsesRelayService usage recording', () => {
  const account = { id: 'account_1', dailyQuota: '100' }
  const apiKeyData = { id: 'key_1' }
  const usageCosts = { realCost: 0.7475, ratedCost: 1.495 }

  beforeEach(() => {
    jest.clearAllMocks()
    apiKeyService.recordUsage.mockResolvedValue(usageCosts)
    openaiResponsesAccountService.updateAccountUsage.mockResolvedValue()
    openaiResponsesAccountService.updateUsageQuota.mockResolvedValue()
  })

  test('non-stream responses use normalized usage and recordUsage realCost for daily quota', async () => {
    const req = createReq()
    const res = createRes()

    await openaiResponsesRelayService._handleNormalResponse(
      {
        status: 200,
        data: { model: 'gpt-5.6-sol', usage: createUsage() }
      },
      res,
      account,
      apiKeyData,
      'gpt-5.6',
      req
    )

    expect(apiKeyService.recordUsage).toHaveBeenCalledWith(
      'key_1',
      50000,
      10000,
      30000,
      20000,
      'gpt-5.6-sol',
      'account_1',
      'openai-responses',
      'priority',
      expect.objectContaining({ stream: false, statusCode: 200 })
    )
    expect(openaiResponsesAccountService.updateAccountUsage).toHaveBeenCalledWith(
      'account_1',
      110000
    )
    expect(openaiResponsesAccountService.updateUsageQuota).toHaveBeenCalledWith(
      'account_1',
      usageCosts.realCost
    )
    expect(CostCalculator.calculateCost).not.toHaveBeenCalled()
  })

  test('stream responses record the final usage once and reuse realCost for daily quota', async () => {
    const req = createReq()
    req.body.stream = true
    const res = createRes()
    const upstreamStream = new PassThrough()
    let usageRecorded
    const usageRecordedPromise = new Promise((resolve) => {
      usageRecorded = resolve
    })
    apiKeyService.recordUsage.mockImplementation(async (...args) => {
      usageRecorded(args)
      return usageCosts
    })

    await openaiResponsesRelayService._handleStreamResponse(
      { data: upstreamStream },
      res,
      account,
      apiKeyData,
      'gpt-5.6',
      jest.fn(),
      req
    )

    const completedEvent = `data: ${JSON.stringify({
      type: 'response.completed',
      response: { model: 'gpt-5.6-sol', usage: createUsage() }
    })}\n\n`
    upstreamStream.write(completedEvent)
    upstreamStream.end(completedEvent)

    const recordedArgs = await usageRecordedPromise
    await new Promise((resolve) => setImmediate(resolve))

    expect(recordedArgs.slice(0, 9)).toEqual([
      'key_1',
      50000,
      10000,
      30000,
      20000,
      'gpt-5.6-sol',
      'account_1',
      'openai-responses',
      'priority'
    ])
    expect(apiKeyService.recordUsage).toHaveBeenCalledTimes(1)
    expect(openaiResponsesAccountService.updateAccountUsage).toHaveBeenCalledWith(
      'account_1',
      110000
    )
    expect(openaiResponsesAccountService.updateUsageQuota).toHaveBeenCalledWith(
      'account_1',
      usageCosts.realCost
    )
    expect(CostCalculator.calculateCost).not.toHaveBeenCalled()
  })
})
