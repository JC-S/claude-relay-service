const config = require('../../config/config')
const redis = require('../models/redis')
const logger = require('./logger')

const BINDING_PREFIX = 'openai:nic_binding:'
const COOLDOWN_PREFIX = 'openai:nic_cooldown:'
const RR_KEY = 'openai:nic_rr'
const DEFAULT_TTL_HOURS = 24
const MIN_TTL_HOURS = 1
const MAX_TTL_HOURS = 72
const DEFAULT_COOLDOWN_SECONDS = 3600
const MIN_COOLDOWN_SECONDS = 60
const MAX_COOLDOWN_SECONDS = 24 * 3600

function getConfiguredLocalAddresses() {
  const configured = config.openaiNicInterleave?.localAddresses || []
  const envConfigured = (
    process.env.OPENAI_UPSTREAM_LOCAL_ADDRESSES ||
    process.env.NIC_INTERLEAVE_IPS ||
    ''
  )
    .split(',')
    .map((address) => address.trim())
    .filter(Boolean)
  const addresses = configured.length > 0 ? configured : envConfigured

  return Array.from(
    new Set(addresses.map((address) => String(address || '').trim()).filter(Boolean))
  )
}

function isAvailable() {
  return getConfiguredLocalAddresses().length >= 2
}

function normalizeTtlHours(value) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) {
    return DEFAULT_TTL_HOURS
  }
  return Math.min(Math.max(parsed, MIN_TTL_HOURS), MAX_TTL_HOURS)
}

function normalizeCooldownSeconds(value) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) {
    return DEFAULT_COOLDOWN_SECONDS
  }
  return Math.min(Math.max(parsed, MIN_COOLDOWN_SECONDS), MAX_COOLDOWN_SECONDS)
}

function buildBindingKey(accountId, sessionHash) {
  return `${BINDING_PREFIX}${accountId}:${sessionHash}`
}

function buildCooldownKey(accountId, localAddress) {
  return `${COOLDOWN_PREFIX}${accountId}:${encodeURIComponent(localAddress)}`
}

async function chooseByRoundRobin(client, addresses) {
  const counter = await client.incr(RR_KEY)
  return addresses[(counter - 1) % addresses.length]
}

async function getCooldownStates(client, accountId, addresses) {
  if (!accountId || addresses.length === 0) {
    return new Map()
  }

  const pipeline = client.pipeline()
  for (const address of addresses) {
    pipeline.ttl(buildCooldownKey(accountId, address))
  }
  const results = await pipeline.exec()
  const states = new Map()

  for (let index = 0; index < addresses.length; index++) {
    const [error, ttl] = results[index] || []
    states.set(addresses[index], {
      active: !error && ttl > 0,
      ttl: !error && ttl > 0 ? ttl : 0
    })
  }

  return states
}

async function getSelectableAddresses(client, accountId, addresses) {
  const cooldownStates = await getCooldownStates(client, accountId, addresses)
  const selectableAddresses = addresses.filter((address) => !cooldownStates.get(address)?.active)

  if (selectableAddresses.length > 0) {
    return selectableAddresses
  }

  logger.warn(
    `⚠️ All OpenAI NIC addresses are cooling down for account ${accountId}; using full address pool to avoid outage`
  )
  return addresses
}

async function getCooldownSnapshot({ accountId } = {}) {
  const addresses = getConfiguredLocalAddresses()
  const baseSnapshot = {
    configured: addresses.length >= 2,
    totalCount: addresses.length,
    availableCount: addresses.length,
    addresses: addresses.map((address) => ({
      localAddress: address,
      status: 'available',
      active: false,
      ttlSeconds: 0,
      expiresAt: null
    }))
  }

  if (!accountId || addresses.length === 0) {
    return baseSnapshot
  }

  const client = redis.getClient()
  if (!client) {
    return {
      ...baseSnapshot,
      redisAvailable: false
    }
  }

  try {
    const now = Date.now()
    const cooldownStates = await getCooldownStates(client, accountId, addresses)
    const cooldownAddresses = addresses.map((address) => {
      const state = cooldownStates.get(address) || { active: false, ttl: 0 }
      const ttlSeconds = Math.max(0, Number(state.ttl) || 0)

      return {
        localAddress: address,
        status: state.active ? 'cooldown' : 'available',
        active: Boolean(state.active),
        ttlSeconds,
        expiresAt: state.active ? new Date(now + ttlSeconds * 1000).toISOString() : null
      }
    })

    return {
      configured: addresses.length >= 2,
      totalCount: addresses.length,
      availableCount: cooldownAddresses.filter((address) => !address.active).length,
      addresses: cooldownAddresses,
      redisAvailable: true
    }
  } catch (error) {
    logger.warn(`⚠️ Failed to read OpenAI NIC cooldown snapshot: ${error.message}`)
    return {
      ...baseSnapshot,
      redisAvailable: false,
      error: error.message
    }
  }
}

async function chooseLocalAddress({ accountId, sessionHash, ttlHours } = {}) {
  const addresses = getConfiguredLocalAddresses()
  if (addresses.length < 2 || !accountId) {
    return null
  }

  const client = redis.getClient()
  if (!client) {
    return null
  }

  try {
    const selectableAddresses = await getSelectableAddresses(client, accountId, addresses)

    if (!sessionHash) {
      return await chooseByRoundRobin(client, selectableAddresses)
    }

    const ttlSeconds = normalizeTtlHours(ttlHours) * 3600
    const bindingKey = buildBindingKey(accountId, sessionHash)
    const boundAddress = await client.get(bindingKey)

    if (boundAddress && selectableAddresses.includes(boundAddress)) {
      await client.expire(bindingKey, ttlSeconds)
      return boundAddress
    }

    if (boundAddress && addresses.includes(boundAddress)) {
      await client.del(bindingKey)
    }

    const selectedAddress = await chooseByRoundRobin(client, selectableAddresses)
    const setResult = await client.set(bindingKey, selectedAddress, 'NX', 'EX', ttlSeconds)

    if (setResult === 'OK') {
      return selectedAddress
    }

    const winningAddress = await client.get(bindingKey)
    if (winningAddress && selectableAddresses.includes(winningAddress)) {
      await client.expire(bindingKey, ttlSeconds)
      return winningAddress
    }

    await client.set(bindingKey, selectedAddress, 'EX', ttlSeconds)
    return selectedAddress
  } catch (error) {
    logger.warn(`⚠️ OpenAI NIC selector failed: ${error.message}`)
    return null
  }
}

async function markCooldown({ accountId, localAddress, cooldownSeconds } = {}) {
  const addresses = getConfiguredLocalAddresses()
  const normalizedAddress = String(localAddress || '').trim()

  if (addresses.length < 2 || !accountId || !normalizedAddress) {
    return { marked: false, reason: 'not_available' }
  }

  if (!addresses.includes(normalizedAddress)) {
    return { marked: false, reason: 'unknown_address' }
  }

  const client = redis.getClient()
  if (!client) {
    return { marked: false, reason: 'redis_unavailable' }
  }

  try {
    const cooldownStates = await getCooldownStates(client, accountId, addresses)
    const availableOtherAddresses = addresses.filter(
      (address) => address !== normalizedAddress && !cooldownStates.get(address)?.active
    )

    if (availableOtherAddresses.length === 0) {
      return { marked: false, reason: 'last_available' }
    }

    const ttlSeconds = normalizeCooldownSeconds(cooldownSeconds)
    const now = Date.now()
    const expiresAt = new Date(now + ttlSeconds * 1000).toISOString()
    await client.set(
      buildCooldownKey(accountId, normalizedAddress),
      JSON.stringify({
        accountId,
        localAddress: normalizedAddress,
        markedAt: new Date(now).toISOString(),
        ttlSeconds,
        expiresAt
      }),
      'EX',
      ttlSeconds
    )

    return {
      marked: true,
      localAddress: normalizedAddress,
      ttlSeconds,
      expiresAt,
      remainingAddresses: availableOtherAddresses.length
    }
  } catch (error) {
    logger.warn(`⚠️ Failed to mark OpenAI NIC cooldown: ${error.message}`)
    return { marked: false, reason: 'error', error }
  }
}

async function clearBinding({ accountId, sessionHash } = {}) {
  if (!accountId || !sessionHash) {
    return
  }

  const client = redis.getClient()
  if (!client) {
    return
  }

  try {
    await client.del(buildBindingKey(accountId, sessionHash))
  } catch (error) {
    logger.warn(`⚠️ Failed to clear OpenAI NIC binding: ${error.message}`)
  }
}

module.exports = {
  getConfiguredLocalAddresses,
  isAvailable,
  normalizeTtlHours,
  normalizeCooldownSeconds,
  getCooldownSnapshot,
  chooseLocalAddress,
  markCooldown,
  clearBinding,
  buildBindingKey,
  buildCooldownKey
}
