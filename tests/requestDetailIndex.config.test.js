const { loadRequestDetailIndexConfig } = require('../src/services/requestDetailIndex/config')

describe('request detail SQLite configuration', () => {
  test('defaults to a disabled Redis backend', () => {
    expect(loadRequestDetailIndexConfig({})).toMatchObject({
      enabled: false,
      queryBackend: 'redis',
      cacheMb: 128,
      mmapMb: 256,
      pendingBatchSize: 200,
      slowQueryMs: 500,
      recomputeLimit: 256
    })
  })

  test('accepts bounded values and permits recompute limit zero', () => {
    expect(
      loadRequestDetailIndexConfig({
        REQUEST_DETAIL_SQLITE_INDEX_ENABLED: 'true',
        REQUEST_DETAIL_QUERY_BACKEND: 'sqlite',
        REQUEST_DETAIL_SQLITE_CACHE_MB: '64',
        REQUEST_DETAIL_SQLITE_MMAP_MB: '0',
        REQUEST_DETAIL_SQLITE_PENDING_BATCH_SIZE: '500',
        REQUEST_DETAIL_SQLITE_SLOW_QUERY_MS: '250',
        REQUEST_DETAIL_SQLITE_RECOMPUTE_LIMIT: '0'
      })
    ).toMatchObject({
      enabled: true,
      queryBackend: 'sqlite',
      cacheMb: 64,
      mmapMb: 0,
      pendingBatchSize: 500,
      slowQueryMs: 250,
      recomputeLimit: 0
    })
  })

  test('falls back to safe defaults for invalid values', () => {
    expect(
      loadRequestDetailIndexConfig({
        REQUEST_DETAIL_SQLITE_INDEX_ENABLED: 'true',
        REQUEST_DETAIL_QUERY_BACKEND: 'invalid',
        REQUEST_DETAIL_SQLITE_CACHE_MB: '-1',
        REQUEST_DETAIL_SQLITE_PENDING_BATCH_SIZE: '100000',
        REQUEST_DETAIL_SQLITE_RECOMPUTE_LIMIT: '2001'
      })
    ).toMatchObject({
      enabled: true,
      queryBackend: 'redis',
      cacheMb: 128,
      pendingBatchSize: 200,
      recomputeLimit: 256
    })
  })
})
