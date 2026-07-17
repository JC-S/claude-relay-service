const fs = require('fs')
const os = require('os')
const path = require('path')

jest.mock('../src/models/redis', () => ({
  getClient: jest.fn(),
  getApiKey: jest.fn()
}))
jest.mock('../src/services/claudeRelayConfigService', () => ({ getConfig: jest.fn() }))
jest.mock('../src/utils/logger', () => ({
  warn: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  start: jest.fn()
}))
jest.mock('../src/services/account/claudeAccountService', () => ({ getAccount: jest.fn() }))
jest.mock('../src/services/account/claudeConsoleAccountService', () => ({ getAccount: jest.fn() }))
jest.mock('../src/services/account/ccrAccountService', () => ({ getAccount: jest.fn() }))
jest.mock('../src/services/account/geminiAccountService', () => ({ getAccount: jest.fn() }))
jest.mock('../src/services/account/geminiApiAccountService', () => ({ getAccount: jest.fn() }))
jest.mock('../src/services/account/openaiAccountService', () => ({ getAccount: jest.fn() }))
jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  getAccount: jest.fn()
}))
jest.mock('../src/services/account/azureOpenaiAccountService', () => ({ getAccount: jest.fn() }))
jest.mock('../src/services/account/droidAccountService', () => ({ getAccount: jest.fn() }))
jest.mock('../src/services/account/grokAccountService', () => ({ getAccount: jest.fn() }))
jest.mock('../src/services/account/bedrockAccountService', () => ({ getAccount: jest.fn() }))

const redis = require('../src/models/redis')
const claudeRelayConfigService = require('../src/services/claudeRelayConfigService')
const openaiAccountService = require('../src/services/account/openaiAccountService')
const requestDetailService = require('../src/services/requestDetailService')
const requestDetailIndex = require('../src/services/requestDetailIndex')
const RequestDetailIndexWorkerClient = require('../src/services/requestDetailIndex/workerClient')
const { mapRequestDetailToIndexRow } = require('../src/services/requestDetailIndex/mapper')

describe('request detail SQLite/Redis response parity', () => {
  let directory
  let worker
  let originalConfig
  let records
  let recordsByKey
  let snapshots
  let client

  beforeEach(async () => {
    const now = Date.now()
    records = [
      {
        requestId: 'req_openai_fast',
        timestamp: new Date(now - 2000).toISOString(),
        endpoint: '/openai/v1/responses',
        method: 'POST',
        apiKeyId: 'key_1',
        accountId: 'account_1',
        accountType: 'openai',
        model: 'gpt-5.5 (fast)',
        rawModel: 'gpt-5.5',
        serviceTier: 'priority',
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 80,
        cacheCreateTokens: 0,
        cost: 0.25,
        durationMs: 1200
      },
      {
        requestId: 'req_openai_standard',
        timestamp: new Date(now - 1000).toISOString(),
        endpoint: '/openai/v1/responses',
        method: 'POST',
        apiKeyId: 'key_1',
        accountId: 'account_1',
        accountType: 'openai',
        model: 'gpt-5.6',
        inputTokens: 50,
        outputTokens: 10,
        cacheReadTokens: 25,
        cacheCreateTokens: 5,
        cost: 0.125,
        durationMs: 800
      }
    ]
    recordsByKey = new Map(
      records.map((record) => [`request_detail:item:${record.requestId}`, JSON.stringify(record)])
    )
    snapshots = new Map()
    client = {
      hlen: jest.fn().mockResolvedValue(0),
      zcard: jest.fn().mockResolvedValue(0),
      zrange: jest.fn().mockResolvedValue([]),
      zrangebyscore: jest
        .fn()
        .mockResolvedValue(
          records.flatMap((record) => [
            record.requestId,
            String(new Date(record.timestamp).getTime())
          ])
        ),
      mget: jest.fn(async (keys) => keys.map((key) => recordsByKey.get(key) || null)),
      get: jest.fn(async (key) => snapshots.get(key) || recordsByKey.get(key) || null),
      set: jest.fn(async (key, value) => {
        snapshots.set(key, value)
        return 'OK'
      }),
      expire: jest.fn().mockResolvedValue(1)
    }
    redis.getClient.mockReturnValue(client)
    redis.getApiKey.mockResolvedValue({ name: 'Parity Key' })
    openaiAccountService.getAccount.mockResolvedValue({ name: 'Parity Account' })
    claudeRelayConfigService.getConfig.mockResolvedValue({
      requestDetailCaptureEnabled: true,
      requestDetailRetentionHours: 6,
      requestDetailBodyPreviewEnabled: false
    })

    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'request-detail-parity-'))
    worker = new RequestDetailIndexWorkerClient()
    await worker.start({
      sqlitePath: path.join(directory, 'index.sqlite3'),
      cacheMb: 16,
      mmapMb: 0
    })
    await worker.call('upsertBatch', {
      rows: records.map((record) =>
        mapRequestDetailToIndexRow(record, {
          sourceVersion: 'parity',
          expiresAtMs: now + 3600000
        })
      )
    })
    await worker.call('markVerified', { summary: { count: records.length } })

    originalConfig = requestDetailIndex.config
    requestDetailIndex.config = {
      enabled: true,
      queryBackend: 'sqlite',
      recomputeLimit: 256,
      pendingBatchSize: 200,
      slowQueryMs: 500
    }
    requestDetailIndex.worker = worker
    requestDetailIndex.started = true
    requestDetailIndex.stopping = false
    requestDetailIndex.ready = true
    requestDetailIndex.state = 'ready'
    requestDetailIndex.maintenancePending = false
    requestDetailIndex.maintenanceActive = false
  })

  afterEach(async () => {
    requestDetailIndex._rejectQueues(new Error('test cleanup'))
    requestDetailIndex.worker = null
    requestDetailIndex.started = false
    requestDetailIndex.ready = false
    requestDetailIndex.state = 'disabled'
    requestDetailIndex.config = originalConfig
    await worker.stop()
    fs.rmSync(directory, { recursive: true, force: true })
    jest.clearAllMocks()
  })

  test('matches the legacy response for filters, summary, ordering and page hydration', async () => {
    const startDate = new Date(Date.now() - 60000).toISOString()
    const endDate = new Date(Date.now() - 100).toISOString()
    const query = {
      startDate,
      endDate,
      page: 1,
      pageSize: 50,
      sortOrder: 'desc',
      keyword: 'parity'
    }
    const sqliteResult = await requestDetailService.listRequestDetails(query)

    requestDetailIndex.config = { ...requestDetailIndex.config, queryBackend: 'redis' }
    snapshots.clear()
    const redisResult = await requestDetailService.listRequestDetails(query)

    const normalize = (result) => ({
      records: result.records,
      pagination: result.pagination,
      filters: result.filters,
      availableFilters: result.availableFilters,
      summary: result.summary
    })
    expect(normalize(sqliteResult)).toEqual(normalize(redisResult))
  })
})
