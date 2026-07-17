#!/usr/bin/env node

const fs = require('fs')
const os = require('os')
const path = require('path')
const { randomUUID } = require('crypto')
const { monitorEventLoopDelay, performance } = require('perf_hooks')
const RequestDetailIndexWorkerClient = require('../src/services/requestDetailIndex/workerClient')

function parseRecordCount() {
  const index = process.argv.indexOf('--records')
  const parsed = index >= 0 ? Number(process.argv[index + 1]) : 70000
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('--records must be a positive integer')
  }
  return parsed
}

function createRow(index, now) {
  const model = index % 3 === 0 ? 'gpt-5.6 (fast)' : index % 3 === 1 ? 'claude-opus-4-7' : 'grok-4'
  const endpoint = index % 2 === 0 ? '/v1/responses' : '/v1/messages'
  return {
    request_id: `perf_${String(index).padStart(8, '0')}`,
    source_version: 'perf',
    timestamp_ms: now - index * 30000,
    expires_at_ms: now + 3600000,
    api_key_id: `key_${index % 100}`,
    account_id: `account_${index % 20}`,
    account_type: model.startsWith('gpt') ? 'openai' : 'claude',
    model,
    endpoint,
    method: 'POST',
    input_tokens: 1000 + index,
    output_tokens: 100,
    cache_read_tokens: index % 1000,
    cache_create_tokens: 0,
    cost_micros: 1000 + index,
    duration_ms: 1000 + (index % 5000),
    cache_hit_numerator: index % 1000,
    cache_hit_denominator: 2000 + index,
    cache_create_not_applicable: model.startsWith('gpt') ? 1 : 0,
    pricing_recompute_eligible: 0,
    search_text: `perf_${String(index).padStart(8, '0')}\nkey_${index % 100}\naccount_${index % 20}\n${model}\n${endpoint}\npost`
  }
}

async function main() {
  const records = parseRecordCount()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'request-detail-index-perf-'))
  const sqlitePath = path.join(directory, 'index.sqlite3')
  const client = new RequestDetailIndexWorkerClient({ defaultTimeoutMs: 30000 })
  const now = Date.now()
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 })
  eventLoopDelay.enable()
  const initialMemory = process.memoryUsage()
  try {
    await client.start({ sqlitePath, cacheMb: 128, mmapMb: 256 })
    const sessionId = randomUUID()
    await client.call('beginRebuild', { sessionId })
    const buildStarted = performance.now()
    let batchId = 0
    let walPeakBytes = 0
    for (let offset = 0; offset < records; offset += 200) {
      const rows = Array.from({ length: Math.min(200, records - offset) }, (_, itemIndex) =>
        createRow(offset + itemIndex, now)
      )
      batchId += 1
      await client.call('appendRebuildBatch', { sessionId, batchId, rows }, 30000)
      try {
        walPeakBytes = Math.max(walPeakBytes, fs.statSync(`${sqlitePath}-wal`).size)
      } catch (_error) {
        // The WAL can be absent before the first dirty page is flushed.
      }
    }
    await client.call(
      'commitRebuild',
      { sessionId, generation: randomUUID(), buildSummary: { records } },
      30000
    )
    await client.call('markVerified', { summary: { records } })
    const buildMs = performance.now() - buildStarted

    const standardSamples = []
    const keywordSamples = []
    for (let iteration = 0; iteration < 30; iteration += 1) {
      const started = performance.now()
      const phaseA = await client.call('phaseA', {
        startMs: now - records * 30000,
        endMs: now,
        snapshotCreatedAt: now,
        sortOrder: 'desc',
        hasKeyword: true
      })
      await client.call('phaseB', {
        startMs: now - records * 30000,
        endMs: now,
        snapshotCreatedAt: phaseA.snapshotCreatedAt,
        snapshotSequence: phaseA.snapshotSequence,
        filters: iteration % 2 === 0 ? { keyword: 'gpt-5.6', model: 'gpt-5.6 (fast)' } : {},
        dynamicKeyIds: [],
        dynamicAccounts: [],
        page: iteration + 1,
        pageSize: 50,
        sortOrder: 'desc',
        recomputeLimit: 256
      })
      const elapsed = performance.now() - started
      ;(iteration % 2 === 0 ? keywordSamples : standardSamples).push(elapsed)
    }
    standardSamples.sort((left, right) => left - right)
    keywordSamples.sort((left, right) => left - right)
    const percentile = (samples, value) =>
      samples[Math.min(samples.length - 1, Math.ceil(samples.length * value) - 1)]
    const finalMemory = process.memoryUsage()
    const result = {
      records,
      buildMs: Number(buildMs.toFixed(2)),
      standard: {
        p50Ms: Number(percentile(standardSamples, 0.5).toFixed(2)),
        p95Ms: Number(percentile(standardSamples, 0.95).toFixed(2)),
        p99Ms: Number(percentile(standardSamples, 0.99).toFixed(2))
      },
      keyword: {
        p50Ms: Number(percentile(keywordSamples, 0.5).toFixed(2)),
        p95Ms: Number(percentile(keywordSamples, 0.95).toFixed(2)),
        p99Ms: Number(percentile(keywordSamples, 0.99).toFixed(2))
      },
      databaseBytes: fs.statSync(sqlitePath).size,
      walPeakBytes,
      eventLoopDelayP99Ms: Number((eventLoopDelay.percentile(99) / 1e6).toFixed(2)),
      heapDeltaBytes: finalMemory.heapUsed - initialMemory.heapUsed,
      rssDeltaBytes: finalMemory.rss - initialMemory.rss
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (
      result.standard.p95Ms > 500 ||
      result.standard.p99Ms > 800 ||
      result.keyword.p95Ms > 800 ||
      result.keyword.p99Ms > 1000
    ) {
      process.exitCode = 1
    }
  } finally {
    eventLoopDelay.disable()
    await client.stop()
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`)
  process.exit(1)
})
