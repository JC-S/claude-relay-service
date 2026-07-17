jest.mock('../src/models/redis', () => ({ getClient: jest.fn(() => null) }))
jest.mock('../src/services/claudeRelayConfigService', () => ({ getConfig: jest.fn() }))
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn()
}))

const { RequestDetailIndexCoordinator } = require('../src/services/requestDetailIndex/coordinator')
const redis = require('../src/models/redis')
const claudeRelayConfigService = require('../src/services/claudeRelayConfigService')
const fs = require('fs')
const os = require('os')
const path = require('path')

describe('request detail SQLite coordinator admission and fairness', () => {
  function createCoordinator(call) {
    const coordinator = new RequestDetailIndexCoordinator({
      config: {
        enabled: true,
        queryBackend: 'sqlite',
        recomputeLimit: 256,
        slowQueryMs: 500,
        pendingBatchSize: 200
      }
    })
    coordinator.worker = { call }
    coordinator.started = true
    coordinator.ready = true
    coordinator.state = 'ready'
    return coordinator
  }

  test('caps two-phase query sessions at two', () => {
    const coordinator = createCoordinator(jest.fn())
    const first = coordinator.beginQuerySession()
    const second = coordinator.beginQuerySession()
    expect(first).toBeTruthy()
    expect(second).toBeTruthy()
    expect(coordinator.beginQuerySession()).toBeNull()
    coordinator.endQuerySession(first)
    expect(coordinator.beginQuerySession()).toBeTruthy()
  })

  test('forces a waiting write after the configured read burst', async () => {
    const operations = []
    const coordinator = createCoordinator(
      jest.fn(async (operation) => {
        operations.push(operation)
        return operation
      })
    )
    const reads = Array.from({ length: 9 }, () => coordinator._schedule('read', 'status', {}))
    const write = coordinator._schedule('write', 'cleanup', {})
    await Promise.all([...reads, write])

    expect(operations.indexOf('cleanup')).toBeGreaterThanOrEqual(1)
    expect(operations.indexOf('cleanup')).toBeLessThan(operations.length - 1)
    expect(coordinator.metrics.forcedWrites).toBe(1)
  })

  test('does not create a Worker or database when the index is disabled', async () => {
    const workerFactory = jest.fn()
    const coordinator = new RequestDetailIndexCoordinator({
      config: { enabled: false, queryBackend: 'redis' },
      workerFactory
    })
    await coordinator.start()
    expect(workerFactory).not.toHaveBeenCalled()
    expect(coordinator.getHealth()).toMatchObject({ state: 'disabled', ready: false })
  })

  test('clears maintenance admission when read draining fails', async () => {
    const coordinator = createCoordinator(jest.fn())
    coordinator._waitForReadsToDrain = jest.fn().mockRejectedValue(new Error('drain timeout'))
    await expect(coordinator.rebuild()).rejects.toThrow('drain timeout')
    expect(coordinator.maintenancePending).toBe(false)
    expect(coordinator.maintenanceActive).toBe(false)
    expect(coordinator.state).toBe('degraded')
  })

  test('automatically builds and verifies an empty index after explicit start', async () => {
    const values = new Map()
    const fakeRedis = {
      set: jest.fn(async (key, value) => {
        values.set(key, value)
        return 'OK'
      }),
      get: jest.fn(async (key) => values.get(key) || null),
      del: jest.fn(async (key) => values.delete(key)),
      hlen: jest.fn().mockResolvedValue(0),
      zcard: jest.fn().mockResolvedValue(0),
      zrange: jest.fn().mockResolvedValue([]),
      zrangebyscore: jest.fn().mockResolvedValue([]),
      hkeys: jest.fn().mockResolvedValue([]),
      pipeline: jest.fn(() => ({ exec: jest.fn().mockResolvedValue([]) })),
      multi: jest.fn(() => {
        const operations = []
        const transaction = {
          set: jest.fn((...args) => {
            operations.push(args)
            return transaction
          }),
          exec: jest.fn(async () => {
            operations.forEach(([key, value]) => values.set(key, value))
            return []
          })
        }
        return transaction
      }),
      eval: jest.fn().mockResolvedValue(1)
    }
    redis.getClient.mockReturnValue(fakeRedis)
    claudeRelayConfigService.getConfig.mockResolvedValue({ requestDetailRetentionHours: 6 })
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coordinator-bootstrap-'))
    const coordinator = new RequestDetailIndexCoordinator({
      config: {
        enabled: true,
        queryBackend: 'redis',
        sqlitePath: path.join(directory, 'index.sqlite3'),
        cacheMb: 16,
        mmapMb: 0,
        pendingBatchSize: 200,
        recomputeLimit: 256,
        slowQueryMs: 500
      }
    })
    try {
      await coordinator.start()
      await coordinator.bootstrapPromise
      expect(coordinator.getHealth()).toMatchObject({ state: 'ready', ready: true })
      const status = await coordinator.worker.call('status')
      expect(status.meta.full_rebuild_status).toBe('verified')
      expect(status.meta.rebuild_complete).toBe('1')
    } finally {
      await coordinator.stop()
      fs.rmSync(directory, { recursive: true, force: true })
      redis.getClient.mockReturnValue(null)
    }
  })
})
