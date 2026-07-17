import test from 'node:test'
import assert from 'node:assert/strict'
import {
  collectV2RequestDetailPages,
  normalizeBusyRetrySeconds
} from '../src/utils/v2RequestDetailsCsv.mjs'

const success = (snapshotId, page, totalPages = 2) => ({
  success: true,
  data: {
    snapshotId,
    records: [{ requestId: `${snapshotId || 'none'}-${page}` }],
    pagination: { totalPages, totalRecords: totalPages }
  }
})

test('normalizes busy retry seconds from the JSON body', () => {
  assert.equal(normalizeBusyRetrySeconds(undefined), 2)
  assert.equal(normalizeBusyRetrySeconds(0), 1)
  assert.equal(normalizeBusyRetrySeconds(99), 10)
})

test('retries a busy page once with the same snapshot', async () => {
  const calls = []
  let busy = true
  const result = await collectV2RequestDetailPages({
    sleep: async () => {},
    fetchPage: async ({ page, snapshotId }) => {
      calls.push({ page, snapshotId })
      if (page === 2 && busy) {
        busy = false
        return {
          success: false,
          code: 'V2_REQUEST_DETAILS_BUSY',
          retryAfterSeconds: 1
        }
      }
      return success('snap-a', page)
    }
  })
  assert.equal(result.complete, true)
  assert.deepEqual(calls, [
    { page: 1, snapshotId: null },
    { page: 2, snapshotId: 'snap-a' },
    { page: 2, snapshotId: 'snap-a' }
  ])
})

test('stops a multi-page export when no snapshot can be established', async () => {
  const result = await collectV2RequestDetailPages({
    fetchPage: async ({ page }) => success(null, page)
  })
  assert.equal(result.complete, false)
  assert.equal(result.reason, 'no_snapshot')
  assert.equal(result.records.length, 1)
})

test('restarts from page one once when the snapshot changes', async () => {
  const calls = []
  const result = await collectV2RequestDetailPages({
    fetchPage: async ({ page, snapshotId }) => {
      calls.push({ page, snapshotId })
      if (!snapshotId && page === 1) return success('snap-a', 1)
      if (snapshotId === 'snap-a' && page === 2) return success('snap-b', 2)
      return success('snap-b', page)
    }
  })
  assert.equal(result.complete, true)
  assert.deepEqual(
    result.records.map((record) => record.requestId),
    ['snap-b-1', 'snap-b-2']
  )
  assert.deepEqual(calls, [
    { page: 1, snapshotId: null },
    { page: 2, snapshotId: 'snap-a' },
    { page: 1, snapshotId: 'snap-b' },
    { page: 2, snapshotId: 'snap-b' }
  ])
})

test('never mixes records after a second snapshot change', async () => {
  const result = await collectV2RequestDetailPages({
    fetchPage: async ({ page, snapshotId }) => {
      if (!snapshotId) return success('snap-a', page)
      if (snapshotId === 'snap-a') return success('snap-b', page)
      if (page === 1) return success('snap-b', 1)
      return success('snap-c', 2)
    }
  })
  assert.equal(result.complete, false)
  assert.equal(result.reason, 'snapshot_changed')
  assert.deepEqual(
    result.records.map((record) => record.requestId),
    ['snap-b-1']
  )
})

test('allows a single page without a snapshot', async () => {
  const result = await collectV2RequestDetailPages({
    fetchPage: async ({ page }) => success(null, page, 1)
  })
  assert.equal(result.complete, true)
  assert.equal(result.records.length, 1)
})
