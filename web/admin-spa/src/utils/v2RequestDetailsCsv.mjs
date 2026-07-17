export const normalizeBusyRetrySeconds = (value) => {
  const parsed = Math.trunc(Number(value))
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 10) : 2
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function collectV2RequestDetailPages({
  fetchPage,
  initialSnapshotId = null,
  maxPages = 100,
  sleep = wait
}) {
  let restartCount = 0
  let pinnedSnapshotId = initialSnapshotId || null

  while (restartCount <= 1) {
    let expectedSnapshotId = null
    let page = 1
    let totalPages = 1
    let totalRecords = 0
    const records = []
    let restartSnapshotId = null

    while (page <= totalPages && page <= maxPages) {
      let response
      let pageRetryCount = 0
      let requesting = true
      while (requesting) {
        response = await fetchPage({ page, pageSize: 200, snapshotId: pinnedSnapshotId })
        if (response?.success !== false || response.code !== 'V2_REQUEST_DETAILS_BUSY') {
          requesting = false
          continue
        }
        if (pageRetryCount >= 1) {
          return {
            records,
            complete: false,
            reason: 'busy',
            totalRecords,
            snapshotId: expectedSnapshotId
          }
        }
        pageRetryCount += 1
        await sleep(normalizeBusyRetrySeconds(response.retryAfterSeconds) * 1000)
      }

      if (response?.success === false) {
        return {
          records,
          complete: false,
          reason: 'request_failed',
          message: response.message,
          totalRecords,
          snapshotId: expectedSnapshotId
        }
      }

      const payload = response?.data || {}
      const responseSnapshotId = payload.snapshotId || null
      const pageRecords = Array.isArray(payload.records) ? payload.records : []

      if (page === 1) {
        if (restartCount > 0 && pinnedSnapshotId && responseSnapshotId !== pinnedSnapshotId) {
          return {
            records: [],
            complete: false,
            reason: 'snapshot_changed',
            totalRecords: Number(payload.pagination?.totalRecords) || 0,
            snapshotId: responseSnapshotId
          }
        }
        expectedSnapshotId = responseSnapshotId
        totalPages = Math.max(Number(payload.pagination?.totalPages) || 1, 1)
        totalRecords = Number(payload.pagination?.totalRecords) || 0
        records.push(...pageRecords)
        if (totalPages > 1 && !expectedSnapshotId) {
          return {
            records,
            complete: false,
            reason: 'no_snapshot',
            totalRecords,
            snapshotId: null
          }
        }
      } else {
        if (responseSnapshotId !== expectedSnapshotId) {
          if (restartCount === 0 && responseSnapshotId) {
            restartSnapshotId = responseSnapshotId
            break
          }
          return {
            records,
            complete: false,
            reason: 'snapshot_changed',
            totalRecords,
            snapshotId: expectedSnapshotId
          }
        }
        records.push(...pageRecords)
      }

      pinnedSnapshotId = expectedSnapshotId
      page += 1
    }

    if (restartSnapshotId) {
      restartCount += 1
      pinnedSnapshotId = restartSnapshotId
      continue
    }

    return {
      records,
      complete: page > totalPages,
      reason: page > totalPages ? null : 'page_limit',
      totalRecords,
      snapshotId: expectedSnapshotId,
      truncated: page <= totalPages
    }
  }

  return {
    records: [],
    complete: false,
    reason: 'request_failed',
    totalRecords: 0,
    snapshotId: null
  }
}

const escapeCsvCell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`

export function buildV2RequestDetailsCsv(records, formatters = {}) {
  const formatDate = formatters.formatDate || ((value) => value || '')
  const formatDuration = formatters.formatDuration || ((value) => Number(value || 0) / 1000)
  const headers = [
    '统计时间',
    'Request ID',
    'API Key',
    '模型',
    '推理',
    '接口',
    '方法',
    '状态',
    '输入',
    '输出',
    '缓存读取',
    '缓存创建',
    '缓存命中率',
    '费用',
    '耗时(s)'
  ]
  const rows = [headers.map(escapeCsvCell).join(',')]
  for (const record of records || []) {
    rows.push(
      [
        formatDate(record.timestamp),
        record.requestId,
        record.apiKeyName || record.apiKeyId,
        record.model,
        record.reasoningDisplay || '',
        record.endpoint,
        record.method,
        record.statusCode,
        record.inputTokens || 0,
        record.outputTokens || 0,
        record.cacheReadTokens || 0,
        record.cacheCreateNotApplicable ? '-' : record.cacheCreateTokens || 0,
        `${Number(record.cacheHitRate || 0).toFixed(2)}%`,
        Number(record.cost || 0).toFixed(6),
        formatDuration(record.durationMs)
      ]
        .map(escapeCsvCell)
        .join(',')
    )
  }
  return rows.join('\n')
}
