const config = require('../../config/config')
const redis = require('../models/redis')
const logger = require('./logger')

const BINDING_PREFIX = 'openai:nic_binding:'
const RR_KEY = 'openai:nic_rr'
const DEFAULT_TTL_HOURS = 24
const MIN_TTL_HOURS = 1
const MAX_TTL_HOURS = 72

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

function buildBindingKey(accountId, sessionHash) {
  return `${BINDING_PREFIX}${accountId}:${sessionHash}`
}

async function chooseByRoundRobin(client, addresses) {
  const counter = await client.incr(RR_KEY)
  return addresses[(counter - 1) % addresses.length]
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
    if (!sessionHash) {
      return await chooseByRoundRobin(client, addresses)
    }

    const ttlSeconds = normalizeTtlHours(ttlHours) * 3600
    const bindingKey = buildBindingKey(accountId, sessionHash)
    const boundAddress = await client.get(bindingKey)

    if (boundAddress && addresses.includes(boundAddress)) {
      await client.expire(bindingKey, ttlSeconds)
      return boundAddress
    }

    const selectedAddress = await chooseByRoundRobin(client, addresses)
    const setResult = await client.set(bindingKey, selectedAddress, 'NX', 'EX', ttlSeconds)

    if (setResult === 'OK') {
      return selectedAddress
    }

    const winningAddress = await client.get(bindingKey)
    if (winningAddress && addresses.includes(winningAddress)) {
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
  chooseLocalAddress,
  clearBinding,
  buildBindingKey
}
