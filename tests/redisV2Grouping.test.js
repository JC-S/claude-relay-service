// redis v2 分组相关方法单测（见 plan_tmp/v2-account-ui-grouping-plan_final.md §六）：
// - getAllV2ChildKeyIds：扫 v2:children:* 取所有子 id 并集；空 keyspace→空 Set；单 set 异常跳过；整体异常→空 Set
// - getV2ParentsLastUsed：每父取未删除子 key 中 lastUsedAt 最大者；默认排除软删；全无使用→不返回；异常→空 Map
// - getApiKeysPaginated({ excludeV2Children })：扫描路径排除子 key、pagination.total 不计子
// - 分组 + sortBy:'lastUsedAt'：排序前用子聚合覆盖父 lastUsedAt（清升级前残留），位次与聚合值一致
// 设计：require 真实 redis 单例（同 redisV2ParentLedgerCost.test.js），注入 mock client + 方法桩；
//       mock apiKeyIndexService 使 isIndexReady=false → 走扫描路径。

jest.mock('../config/config', () => ({ system: { timezoneOffset: 8 } }), { virtual: true })

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  debug: jest.fn()
}))

jest.mock('../src/services/apiKeyIndexService', () => ({
  isIndexReady: jest.fn(async () => false),
  queryWithIndex: jest.fn()
}))

const redis = require('../src/models/redis')
const logger = require('../src/utils/logger')

// 注入式 mock client：smembers + pipeline(smembers/hmget).exec()
// sets:    { 'v2:children:p1': ['c1','c2'], ... }
// hashes:  { 'apikey:c1': { lastUsedAt, isDeleted }, ... }
// errKeys: pipeline 中对这些 key 的操作返回 [Error, null]（模拟单条失败）
function makeClient({ sets = {}, hashes = {}, errKeys = [] } = {}) {
  const errSet = new Set(errKeys)
  return {
    smembers: jest.fn(async (key) => (sets[key] ? sets[key].slice() : [])),
    pipeline: jest.fn(() => {
      const ops = []
      const api = {
        smembers(key) {
          ops.push({ type: 'smembers', key })
          return api
        },
        hmget(key, ...fields) {
          ops.push({ type: 'hmget', key, fields })
          return api
        },
        get(key) {
          ops.push({ type: 'get', key })
          return api
        },
        exec: jest.fn(async () =>
          ops.map((op) => {
            if (errSet.has(op.key)) {
              return [new Error('redis op boom'), null]
            }
            if (op.type === 'smembers') {
              return [null, sets[op.key] ? sets[op.key].slice() : []]
            }
            if (op.type === 'hmget') {
              const h = hashes[op.key] || {}
              return [null, op.fields.map((f) => (f in h ? h[f] : null))]
            }
            return [null, null]
          })
        )
      }
      return api
    })
  }
}

afterEach(() => {
  jest.clearAllMocks()
  redis.client = null
})

describe('redis.getAllV2ChildKeyIds', () => {
  test('空 keyspace → 空 Set', async () => {
    redis.client = makeClient({ sets: {} })
    redis.scanKeys = jest.fn(async () => [])
    const ids = await redis.getAllV2ChildKeyIds()
    expect(ids).toBeInstanceOf(Set)
    expect(ids.size).toBe(0)
  })

  test('多父 → 子 id 并集', async () => {
    const sets = { 'v2:children:p1': ['c1', 'c2'], 'v2:children:p2': ['c3'] }
    redis.client = makeClient({ sets })
    redis.scanKeys = jest.fn(async () => Object.keys(sets))
    const ids = await redis.getAllV2ChildKeyIds()
    expect([...ids].sort()).toEqual(['c1', 'c2', 'c3'])
  })

  test('单个 set 读取异常 → 跳过不抛，仅并入正常集合', async () => {
    const sets = { 'v2:children:p1': ['c1', 'c2'], 'v2:children:p2': ['c3'] }
    redis.client = makeClient({ sets, errKeys: ['v2:children:p2'] })
    redis.scanKeys = jest.fn(async () => Object.keys(sets))
    const ids = await redis.getAllV2ChildKeyIds()
    expect([...ids].sort()).toEqual(['c1', 'c2'])
  })

  test('整体异常（scanKeys 抛）→ 空 Set + logger.warn', async () => {
    redis.client = makeClient()
    redis.scanKeys = jest.fn(async () => {
      throw new Error('scan boom')
    })
    const ids = await redis.getAllV2ChildKeyIds()
    expect(ids.size).toBe(0)
    expect(logger.warn).toHaveBeenCalled()
  })
})

describe('redis.getV2ParentsLastUsed', () => {
  test('多子取 lastUsedAt 最新者 + 对应 lastUsedChildId；默认排除软删子', async () => {
    const sets = { 'v2:children:p1': ['c1', 'c2', 'c3'] }
    const hashes = {
      'apikey:c1': { lastUsedAt: '2026-06-10T00:00:00Z', isDeleted: 'false' },
      'apikey:c2': { lastUsedAt: '2026-06-12T00:00:00Z', isDeleted: 'false' },
      // c3 时间最新但已软删 → 必须被排除
      'apikey:c3': { lastUsedAt: '2026-06-14T00:00:00Z', isDeleted: 'true' }
    }
    redis.client = makeClient({ sets, hashes })
    const map = await redis.getV2ParentsLastUsed(['p1'])
    expect(map.get('p1')).toEqual({
      lastUsedAt: '2026-06-12T00:00:00Z',
      lastUsedChildId: 'c2'
    })
  })

  test('父账号无任何子使用记录 → 不写入该父', async () => {
    const sets = { 'v2:children:p2': ['c4'] }
    const hashes = { 'apikey:c4': { lastUsedAt: '', isDeleted: 'false' } }
    redis.client = makeClient({ sets, hashes })
    const map = await redis.getV2ParentsLastUsed(['p2'])
    expect(map.has('p2')).toBe(false)
  })

  test('includeDeletedChildren:true → 软删子也参与（取真正最新）', async () => {
    const sets = { 'v2:children:p1': ['c1', 'c3'] }
    const hashes = {
      'apikey:c1': { lastUsedAt: '2026-06-10T00:00:00Z', isDeleted: 'false' },
      'apikey:c3': { lastUsedAt: '2026-06-14T00:00:00Z', isDeleted: 'true' }
    }
    redis.client = makeClient({ sets, hashes })
    const map = await redis.getV2ParentsLastUsed(['p1'], { includeDeletedChildren: true })
    expect(map.get('p1').lastUsedChildId).toBe('c3')
  })

  test('空入参 → 空 Map（不触达 client）', async () => {
    redis.client = makeClient()
    const map = await redis.getV2ParentsLastUsed([])
    expect(map.size).toBe(0)
    expect(redis.client.pipeline).not.toHaveBeenCalled()
  })

  test('异常 → 空 Map + logger.warn', async () => {
    redis.client = {
      pipeline: jest.fn(() => {
        throw new Error('pipeline boom')
      })
    }
    const map = await redis.getV2ParentsLastUsed(['p1'])
    expect(map.size).toBe(0)
    expect(logger.warn).toHaveBeenCalled()
  })
})

describe('redis.getApiKeysPaginated({ excludeV2Children })', () => {
  test('扫描路径：排除子 key，父/普通保留，pagination.total 不计子', async () => {
    redis.client = makeClient()
    redis.scanApiKeyIds = jest.fn(async () => ['p1', 'c1', 'n1'])
    redis.batchGetApiKeys = jest.fn(async () => [
      { id: 'p1', name: 'parent', isV2Parent: true, createdAt: '2026-06-01T00:00:00Z' },
      { id: 'c1', name: 'child', parentKeyId: 'p1', createdAt: '2026-06-02T00:00:00Z' },
      { id: 'n1', name: 'normal', createdAt: '2026-06-03T00:00:00Z' }
    ])

    const res = await redis.getApiKeysPaginated({ excludeV2Children: true, sortBy: 'createdAt' })
    const ids = res.items.map((k) => k.id).sort()
    expect(ids).toEqual(['n1', 'p1'])
    expect(res.items.some((k) => k.id === 'c1')).toBe(false)
    expect(res.pagination.total).toBe(2)
  })

  test('不传 excludeV2Children 时子 key 照常平铺（向后兼容）', async () => {
    redis.client = makeClient()
    redis.scanApiKeyIds = jest.fn(async () => ['p1', 'c1', 'n1'])
    redis.batchGetApiKeys = jest.fn(async () => [
      { id: 'p1', name: 'parent', isV2Parent: true, createdAt: '2026-06-01T00:00:00Z' },
      { id: 'c1', name: 'child', parentKeyId: 'p1', createdAt: '2026-06-02T00:00:00Z' },
      { id: 'n1', name: 'normal', createdAt: '2026-06-03T00:00:00Z' }
    ])
    const res = await redis.getApiKeysPaginated({ sortBy: 'createdAt' })
    expect(res.pagination.total).toBe(3)
  })

  test('分组 + sortBy:lastUsedAt：排序前用子聚合覆盖父 lastUsedAt（清升级前残留），位次一致', async () => {
    const sets = { 'v2:children:p1': ['c1', 'c2'], 'v2:children:p2': ['c3'] }
    const hashes = {
      'apikey:c1': { lastUsedAt: '2026-06-10T00:00:00Z', isDeleted: 'false' },
      'apikey:c2': { lastUsedAt: '2026-06-12T00:00:00Z', isDeleted: 'false' },
      'apikey:c3': { lastUsedAt: '', isDeleted: 'false' } // p2 无子使用 → 置 null
    }
    redis.client = makeClient({ sets, hashes })
    redis.scanApiKeyIds = jest.fn(async () => ['p1', 'p2', 'c1', 'c2', 'c3', 'n1'])
    redis.batchGetApiKeys = jest.fn(async () => [
      // p1 自身残留升级前旧时间，必须被聚合值覆盖
      { id: 'p1', name: 'P1', isV2Parent: true, lastUsedAt: '2020-01-01T00:00:00Z' },
      { id: 'p2', name: 'P2', isV2Parent: true, lastUsedAt: '2019-01-01T00:00:00Z' },
      { id: 'c1', name: 'C1', parentKeyId: 'p1', lastUsedAt: '2026-06-10T00:00:00Z' },
      { id: 'c2', name: 'C2', parentKeyId: 'p1', lastUsedAt: '2026-06-12T00:00:00Z' },
      { id: 'c3', name: 'C3', parentKeyId: 'p2', lastUsedAt: '' },
      { id: 'n1', name: 'N1', lastUsedAt: '2026-06-11T00:00:00Z' }
    ])

    const res = await redis.getApiKeysPaginated({
      excludeV2Children: true,
      sortBy: 'lastUsedAt',
      sortOrder: 'desc'
    })

    // 排除子后剩 p1 / p2 / n1；按聚合后 lastUsedAt 降序：p1(06-12) > n1(06-11) > p2(null)
    expect(res.items.map((k) => k.id)).toEqual(['p1', 'n1', 'p2'])

    const p1 = res.items.find((k) => k.id === 'p1')
    expect(p1.lastUsedAt).toBe('2026-06-12T00:00:00Z') // 覆盖了 2020 残留
    expect(p1.lastUsedChildId).toBe('c2')

    const p2 = res.items.find((k) => k.id === 'p2')
    expect(p2.lastUsedAt).toBeNull() // 无子使用 → null（清 2019 残留）
    expect(p2.lastUsedChildId).toBeNull()
  })
})
