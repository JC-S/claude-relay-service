#!/usr/bin/env node

const { Command } = require('commander')
const { randomUUID } = require('crypto')
const redis = require('../models/redis')
const {
  MAINTENANCE_COMMAND_KEY,
  MAINTENANCE_CURRENT_KEY,
  MAINTENANCE_STATUS_PREFIX,
  REQUEST_DETAIL_DAY_INDEX_PREFIX,
  REQUEST_DETAIL_ITEM_PREFIX,
  SERVICE_HEARTBEAT_KEY
} = require('../services/requestDetailIndex/constants')

const COMMAND_TTL_MS = 20 * 60 * 1000

function parseJson(value) {
  try {
    return value ? JSON.parse(value) : null
  } catch (_error) {
    return null
  }
}

async function dryRun(client) {
  let cursor = '0'
  let indexKeys = 0
  let pointers = 0
  do {
    const result = await client.scan(
      cursor,
      'MATCH',
      `${REQUEST_DETAIL_DAY_INDEX_PREFIX}*`,
      'COUNT',
      200
    )
    cursor = result[0]
    for (const key of result[1]) {
      indexKeys += 1
      pointers += Number(await client.zcard(key))
    }
  } while (cursor !== '0')

  cursor = '0'
  let items = 0
  let bytes = 0
  let malformed = 0
  let earliest = null
  let latest = null
  do {
    const result = await client.scan(
      cursor,
      'MATCH',
      `${REQUEST_DETAIL_ITEM_PREFIX}*`,
      'COUNT',
      200
    )
    cursor = result[0]
    if (result[1].length > 0) {
      const values = await client.mget(result[1])
      values.forEach((value) => {
        if (!value) {
          return
        }
        items += 1
        bytes += Buffer.byteLength(value)
        const record = parseJson(value)
        if (!record) {
          malformed += 1
          return
        }
        const timestamp = new Date(record.timestamp).getTime()
        if (Number.isFinite(timestamp)) {
          earliest = earliest === null ? timestamp : Math.min(earliest, timestamp)
          latest = latest === null ? timestamp : Math.max(latest, timestamp)
        }
      })
    }
  } while (cursor !== '0')

  process.stdout.write(
    `${JSON.stringify(
      {
        indexKeys,
        pointers,
        items,
        malformed,
        sourceBytes: bytes,
        estimatedIndexBytes: Math.ceil(items * 1200),
        earliest: earliest === null ? null : new Date(earliest).toISOString(),
        latest: latest === null ? null : new Date(latest).toISOString()
      },
      null,
      2
    )}\n`
  )
}

async function printStatus(client, requestedToken) {
  const token = requestedToken || (await client.get(MAINTENANCE_CURRENT_KEY))
  const heartbeat = await client.get(SERVICE_HEARTBEAT_KEY)
  const command = parseJson(await client.get(MAINTENANCE_COMMAND_KEY))
  const status = token ? parseJson(await client.get(`${MAINTENANCE_STATUS_PREFIX}${token}`)) : null
  process.stdout.write(
    `${JSON.stringify({ serviceOnline: Boolean(heartbeat), command, status }, null, 2)}\n`
  )
}

async function submit(client, operation) {
  if (!(await client.get(SERVICE_HEARTBEAT_KEY))) {
    throw new Error('The relay service is not running with the request detail SQLite index enabled')
  }
  const token = randomUUID()
  const command = { op: operation, token, requestedAt: new Date().toISOString() }
  const accepted = await client.set(
    MAINTENANCE_COMMAND_KEY,
    JSON.stringify(command),
    'PX',
    COMMAND_TTL_MS,
    'NX'
  )
  if (accepted !== 'OK') {
    const current = parseJson(await client.get(MAINTENANCE_COMMAND_KEY))
    throw new Error(`Another maintenance command is active (${current?.token || 'unknown'})`)
  }
  process.stdout.write(`Submitted ${operation} command ${token}\n`)
  let terminal = false
  while (!terminal) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const status = parseJson(await client.get(`${MAINTENANCE_STATUS_PREFIX}${token}`))
    if (status) {
      process.stdout.write(`${status.state}: ${status.phase || operation}\n`)
      if (['completed', 'failed', 'interrupted'].includes(status.state)) {
        if (status.state !== 'completed') {
          process.exitCode = 1
        }
        terminal = true
      }
    } else if (!(await client.get(MAINTENANCE_COMMAND_KEY))) {
      process.stdout.write('interrupted: command ownership expired before a terminal status\n')
      process.exitCode = 1
      terminal = true
    }
  }
}

async function main() {
  const program = new Command()
    .option('--dry-run', 'scan Redis and estimate index size without writing')
    .option('--rebuild', 'submit an online rebuild command')
    .option('--verify', 'submit an online verification command')
    .option('--status [token]', 'show the current or requested command status')
    .parse(process.argv)
  const options = program.opts()
  const selected = [
    options.dryRun,
    options.rebuild,
    options.verify,
    options.status !== undefined
  ].filter(Boolean)
  if (selected.length !== 1) {
    throw new Error('Choose exactly one of --dry-run, --rebuild, --verify, or --status')
  }
  await redis.connect()
  const client = redis.getClient()
  try {
    if (options.dryRun) {
      await dryRun(client)
    } else if (options.rebuild) {
      await submit(client, 'rebuild')
    } else if (options.verify) {
      await submit(client, 'verify')
    } else {
      await printStatus(client, typeof options.status === 'string' ? options.status : null)
    }
  } finally {
    await redis.disconnect()
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`)
  process.exit(1)
})
