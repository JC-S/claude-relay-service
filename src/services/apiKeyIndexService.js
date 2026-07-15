/**
 * API Key 索引服务
 * 维护 Sorted Set 索引以支持高效分页查询
 */

const { randomUUID } = require('crypto')
const logger = require('../utils/logger')

class ApiKeyIndexService {
  constructor() {
    this.redis = null
    this.INDEX_VERSION_KEY = 'apikey:index:version'
    this.CURRENT_VERSION = 2 // 版本升级，触发重建
    this.isBuilding = false
    this.buildProgress = { current: 0, total: 0 }

    // 索引键名
    this.INDEX_KEYS = {
      CREATED_AT: 'apikey:idx:createdAt',
      LAST_USED_AT: 'apikey:idx:lastUsedAt',
      NAME: 'apikey:idx:name',
      ACTIVE_SET: 'apikey:set:active',
      DELETED_SET: 'apikey:set:deleted',
      ALL_SET: 'apikey:idx:all',
      TAGS_ALL: 'apikey:tags:all' // 所有标签的集合
    }
  }

  /**
   * 初始化服务
   */
  init(redis) {
    this.redis = redis
    return this
  }

  /**
   * 启动时检查并重建索引
   */
  async checkAndRebuild() {
    if (!this.redis) {
      logger.warn('⚠️ ApiKeyIndexService: Redis not initialized')
      return
    }

    try {
      const client = this.redis.getClientSafe()
      const version = await client.get(this.INDEX_VERSION_KEY)

      // 始终检查并回填 hash_map（幂等操作，确保升级兼容）
      this.rebuildHashMap().catch((err) => {
        logger.error('❌ API Key hash_map 回填失败:', err)
      })
      this.rebuildSecretRegistry().catch((err) => {
        logger.error('❌ API Key secret registry 回填失败:', err)
      })

      if (parseInt(version) >= this.CURRENT_VERSION) {
        logger.info('✅ API Key 索引已是最新版本')
        return
      }

      // 后台异步重建，不阻塞启动
      this.rebuildIndexes().catch((err) => {
        logger.error('❌ API Key 索引重建失败:', err)
      })
    } catch (error) {
      logger.error('❌ 检查 API Key 索引版本失败:', error)
    }
  }

  /**
   * 回填 apikey:hash_map（升级兼容）
   * 扫描所有 API Key，确保 hash -> keyId 映射存在
   */
  async rebuildHashMap() {
    if (!this.redis) {
      return
    }

    try {
      const keyIds = await this.redis.scanApiKeyIds()

      let rebuilt = 0
      let conflicts = 0
      const BATCH_SIZE = 100

      for (let i = 0; i < keyIds.length; i += BATCH_SIZE) {
        const batch = keyIds.slice(i, i + BATCH_SIZE)
        const results = await Promise.all(
          batch.map((keyId) => this.redis.repairApiKeyHashMapping(keyId))
        )
        for (const result of results) {
          if (result === 'REPAIRED') {
            rebuilt++
          } else if (result === 'CONFLICT') {
            conflicts++
          }
        }
      }

      if (rebuilt > 0) {
        logger.info(`🔧 回填了 ${rebuilt} 个 API Key 到 hash_map`)
      }
      if (conflicts > 0) {
        logger.error(`❌ 检测到 ${conflicts} 个 API Key hash_map 所有权冲突`)
      }
    } catch (error) {
      logger.error('❌ 回填 hash_map 失败:', error)
      throw error
    }
  }

  async rebuildSecretRegistry() {
    if (!this.redis) {
      return
    }

    const client = this.redis.getClientSafe()
    const registryKey = 'apikey_secret_registry'
    if ((await client.hget(registryKey, '__ready__')) === 'v1') {
      return
    }

    const lockKey = 'lock:apikey_secret_registry_backfill'
    const lockValue = randomUUID()
    const acquired = await this.redis.setAccountLock(lockKey, lockValue, 10 * 60 * 1000)
    if (!acquired) {
      logger.info('API Key secret registry is being initialized by another worker')
      return
    }

    try {
      if ((await client.hget(registryKey, '__ready__')) === 'v1') {
        return
      }

      const keyIds = await this.redis.scanApiKeyIds()
      const BATCH_SIZE = 200
      for (let i = 0; i < keyIds.length; i += BATCH_SIZE) {
        const batch = keyIds.slice(i, i + BATCH_SIZE)
        const readPipeline = client.pipeline()
        for (const keyId of batch) {
          readPipeline.hget(`apikey:${keyId}`, 'apiKey')
        }
        const hashes = await readPipeline.exec()
        const candidates = []
        const reservePipeline = client.pipeline()
        for (let j = 0; j < batch.length; j++) {
          const hashedKey = hashes[j]?.[1]
          if (!/^[a-f0-9]{64}$/i.test(hashedKey || '')) {
            continue
          }
          candidates.push({ keyId: batch[j], hashedKey })
          reservePipeline.hsetnx(registryKey, hashedKey, batch[j])
        }

        if (candidates.length === 0) {
          continue
        }
        const reservations = await reservePipeline.exec()
        const ownerPipeline = client.pipeline()
        const ownerChecks = []
        for (let j = 0; j < candidates.length; j++) {
          if (reservations[j]?.[1] === 0) {
            ownerChecks.push(candidates[j])
            ownerPipeline.hget(registryKey, candidates[j].hashedKey)
          }
        }
        if (ownerChecks.length > 0) {
          const owners = await ownerPipeline.exec()
          for (let j = 0; j < ownerChecks.length; j++) {
            if (owners[j]?.[1] !== ownerChecks[j].keyId) {
              throw new Error(
                `Duplicate API key secret detected for records ${owners[j]?.[1]} and ${ownerChecks[j].keyId}`
              )
            }
          }
        }
      }

      await client.hset(registryKey, '__ready__', 'v1')
      logger.info(`API Key secret registry initialized with ${keyIds.length} records scanned`)
    } finally {
      await this.redis.releaseAccountLock(lockKey, lockValue)
    }
  }

  /**
   * 检查索引是否可用
   */
  async isIndexReady() {
    if (!this.redis || this.isBuilding) {
      return false
    }

    try {
      const client = this.redis.getClientSafe()
      const version = await client.get(this.INDEX_VERSION_KEY)
      return parseInt(version) >= this.CURRENT_VERSION
    } catch {
      return false
    }
  }

  /**
   * 重建所有索引
   */
  async rebuildIndexes() {
    if (this.isBuilding) {
      logger.warn('⚠️ API Key 索引正在重建中，跳过')
      return
    }

    this.isBuilding = true
    const startTime = Date.now()

    try {
      const client = this.redis.getClientSafe()
      logger.info('🔨 开始重建 API Key 索引...')

      // 0. 先删除版本号，让 _checkIndexReady 返回 false，查询回退到 SCAN
      await client.del(this.INDEX_VERSION_KEY)

      // 1. 清除旧索引
      const indexKeys = Object.values(this.INDEX_KEYS)
      for (const key of indexKeys) {
        await client.del(key)
      }
      // 清除标签索引（用 SCAN 避免阻塞）
      let cursor = '0'
      do {
        const [newCursor, keys] = await client.scan(cursor, 'MATCH', 'apikey:tag:*', 'COUNT', 100)
        cursor = newCursor
        if (keys.length > 0) {
          await client.del(...keys)
        }
      } while (cursor !== '0')

      // 2. 扫描所有 API Key
      const keyIds = await this.redis.scanApiKeyIds()
      this.buildProgress = { current: 0, total: keyIds.length }

      logger.info(`📊 发现 ${keyIds.length} 个 API Key，开始建立索引...`)

      // 3. 批量处理（每批 500 个）
      const BATCH_SIZE = 500
      for (let i = 0; i < keyIds.length; i += BATCH_SIZE) {
        const batch = keyIds.slice(i, i + BATCH_SIZE)
        const apiKeys = await this.redis.batchGetApiKeys(batch)

        const pipeline = client.pipeline()

        for (const apiKey of apiKeys) {
          if (!apiKey || !apiKey.id) {
            continue
          }

          const keyId = apiKey.id
          const createdAt = apiKey.createdAt ? new Date(apiKey.createdAt).getTime() : 0
          const lastUsedAt = apiKey.lastUsedAt ? new Date(apiKey.lastUsedAt).getTime() : 0
          const name = (apiKey.name || '').toLowerCase()
          const isActive = apiKey.isActive === true || apiKey.isActive === 'true'
          const isDeleted = apiKey.isDeleted === true || apiKey.isDeleted === 'true'

          // 创建时间索引
          pipeline.zadd(this.INDEX_KEYS.CREATED_AT, createdAt, keyId)

          // 最后使用时间索引
          pipeline.zadd(this.INDEX_KEYS.LAST_USED_AT, lastUsedAt, keyId)

          // 名称索引（用于排序，存储格式：name\0keyId）
          pipeline.zadd(this.INDEX_KEYS.NAME, 0, `${name}\x00${keyId}`)

          // 全部集合
          pipeline.sadd(this.INDEX_KEYS.ALL_SET, keyId)

          // 状态集合
          if (isDeleted) {
            pipeline.sadd(this.INDEX_KEYS.DELETED_SET, keyId)
          } else if (isActive) {
            pipeline.sadd(this.INDEX_KEYS.ACTIVE_SET, keyId)
          }

          // 标签索引
          const tags = Array.isArray(apiKey.tags) ? apiKey.tags : []
          for (const tag of tags) {
            if (tag && typeof tag === 'string') {
              pipeline.sadd(`apikey:tag:${tag}`, keyId)
              pipeline.sadd(this.INDEX_KEYS.TAGS_ALL, tag) // 维护标签集合
            }
          }
        }

        await pipeline.exec()
        this.buildProgress.current = Math.min(i + BATCH_SIZE, keyIds.length)

        // 每批次后短暂让出 CPU
        await new Promise((resolve) => setTimeout(resolve, 10))
      }

      // 4. 更新版本号
      await client.set(this.INDEX_VERSION_KEY, this.CURRENT_VERSION)

      const duration = ((Date.now() - startTime) / 1000).toFixed(2)
      logger.success(`✅ API Key 索引重建完成，共 ${keyIds.length} 条，耗时 ${duration}s`)
    } catch (error) {
      logger.error('❌ API Key 索引重建失败:', error)
      throw error
    } finally {
      this.isBuilding = false
    }
  }

  /**
   * 添加单个 API Key 到索引
   */
  async addToIndex(apiKey) {
    if (!this.redis || !apiKey || !apiKey.id) {
      return
    }

    try {
      const client = this.redis.getClientSafe()
      const keyId = apiKey.id
      const createdAt = apiKey.createdAt ? new Date(apiKey.createdAt).getTime() : Date.now()
      const lastUsedAt = apiKey.lastUsedAt ? new Date(apiKey.lastUsedAt).getTime() : 0
      const name = (apiKey.name || '').toLowerCase()
      const isActive = apiKey.isActive === true || apiKey.isActive === 'true'
      const isDeleted = apiKey.isDeleted === true || apiKey.isDeleted === 'true'

      const pipeline = client.pipeline()

      pipeline.zadd(this.INDEX_KEYS.CREATED_AT, createdAt, keyId)
      pipeline.zadd(this.INDEX_KEYS.LAST_USED_AT, lastUsedAt, keyId)
      pipeline.zadd(this.INDEX_KEYS.NAME, 0, `${name}\x00${keyId}`)
      pipeline.sadd(this.INDEX_KEYS.ALL_SET, keyId)

      if (isDeleted) {
        pipeline.sadd(this.INDEX_KEYS.DELETED_SET, keyId)
        pipeline.srem(this.INDEX_KEYS.ACTIVE_SET, keyId)
      } else if (isActive) {
        pipeline.sadd(this.INDEX_KEYS.ACTIVE_SET, keyId)
        pipeline.srem(this.INDEX_KEYS.DELETED_SET, keyId)
      } else {
        pipeline.srem(this.INDEX_KEYS.ACTIVE_SET, keyId)
        pipeline.srem(this.INDEX_KEYS.DELETED_SET, keyId)
      }

      // 标签索引
      const tags = Array.isArray(apiKey.tags) ? apiKey.tags : []
      for (const tag of tags) {
        if (tag && typeof tag === 'string') {
          pipeline.sadd(`apikey:tag:${tag}`, keyId)
          pipeline.sadd(this.INDEX_KEYS.TAGS_ALL, tag)
        }
      }

      await pipeline.exec()
    } catch (error) {
      logger.error(`❌ 添加 API Key ${apiKey.id} 到索引失败:`, error)
    }
  }

  /**
   * 更新索引（状态、名称、标签变化时调用）
   */
  async updateIndex(keyId, updates, oldData = {}) {
    if (!this.redis || !keyId) {
      return
    }

    try {
      const client = this.redis.getClientSafe()
      const pipeline = client.pipeline()

      // 更新名称索引
      if (updates.name !== undefined) {
        const oldName = (oldData.name || '').toLowerCase()
        const newName = (updates.name || '').toLowerCase()
        if (oldName !== newName) {
          pipeline.zrem(this.INDEX_KEYS.NAME, `${oldName}\x00${keyId}`)
          pipeline.zadd(this.INDEX_KEYS.NAME, 0, `${newName}\x00${keyId}`)
        }
      }

      // 更新最后使用时间索引
      if (updates.lastUsedAt !== undefined) {
        const lastUsedAt = updates.lastUsedAt ? new Date(updates.lastUsedAt).getTime() : 0
        pipeline.zadd(this.INDEX_KEYS.LAST_USED_AT, lastUsedAt, keyId)
      }

      // 更新状态集合
      if (updates.isActive !== undefined || updates.isDeleted !== undefined) {
        const isActive = updates.isActive ?? oldData.isActive
        const isDeleted = updates.isDeleted ?? oldData.isDeleted

        if (isDeleted === true || isDeleted === 'true') {
          pipeline.sadd(this.INDEX_KEYS.DELETED_SET, keyId)
          pipeline.srem(this.INDEX_KEYS.ACTIVE_SET, keyId)
        } else if (isActive === true || isActive === 'true') {
          pipeline.sadd(this.INDEX_KEYS.ACTIVE_SET, keyId)
          pipeline.srem(this.INDEX_KEYS.DELETED_SET, keyId)
        } else {
          pipeline.srem(this.INDEX_KEYS.ACTIVE_SET, keyId)
          pipeline.srem(this.INDEX_KEYS.DELETED_SET, keyId)
        }
      }

      // 更新标签索引
      const removedTags = []
      if (updates.tags !== undefined) {
        const oldTags = Array.isArray(oldData.tags) ? oldData.tags : []
        const newTags = Array.isArray(updates.tags) ? updates.tags : []

        // 移除旧标签
        for (const tag of oldTags) {
          if (tag && !newTags.includes(tag)) {
            pipeline.srem(`apikey:tag:${tag}`, keyId)
            removedTags.push(tag)
          }
        }
        // 添加新标签
        for (const tag of newTags) {
          if (tag && typeof tag === 'string') {
            pipeline.sadd(`apikey:tag:${tag}`, keyId)
            pipeline.sadd(this.INDEX_KEYS.TAGS_ALL, tag)
          }
        }
      }

      await pipeline.exec()

      // 检查被移除的标签集合是否为空，为空则从 tags:all 移除
      for (const tag of removedTags) {
        const count = await client.scard(`apikey:tag:${tag}`)
        if (count === 0) {
          await client.srem(this.INDEX_KEYS.TAGS_ALL, tag)
        }
      }
    } catch (error) {
      logger.error(`❌ 更新 API Key ${keyId} 索引失败:`, error)
    }
  }

  /**
   * 从索引中移除 API Key
   */
  async removeFromIndex(keyId, oldData = {}) {
    if (!this.redis || !keyId) {
      return
    }

    try {
      const client = this.redis.getClientSafe()
      const pipeline = client.pipeline()

      const name = (oldData.name || '').toLowerCase()

      pipeline.zrem(this.INDEX_KEYS.CREATED_AT, keyId)
      pipeline.zrem(this.INDEX_KEYS.LAST_USED_AT, keyId)
      pipeline.zrem(this.INDEX_KEYS.NAME, `${name}\x00${keyId}`)
      pipeline.srem(this.INDEX_KEYS.ALL_SET, keyId)
      pipeline.srem(this.INDEX_KEYS.ACTIVE_SET, keyId)
      pipeline.srem(this.INDEX_KEYS.DELETED_SET, keyId)

      // 移除标签索引
      const tags = Array.isArray(oldData.tags) ? oldData.tags : []
      for (const tag of tags) {
        if (tag) {
          pipeline.srem(`apikey:tag:${tag}`, keyId)
        }
      }

      await pipeline.exec()

      // 检查标签集合是否为空，为空则从 tags:all 移除
      for (const tag of tags) {
        if (tag) {
          const count = await client.scard(`apikey:tag:${tag}`)
          if (count === 0) {
            await client.srem(this.INDEX_KEYS.TAGS_ALL, tag)
          }
        }
      }
    } catch (error) {
      logger.error(`❌ 从索引移除 API Key ${keyId} 失败:`, error)
    }
  }

  /**
   * 使用索引进行分页查询
   * 使用 ZINTERSTORE 优化，避免全量拉回内存
   */
  async queryWithIndex(options = {}) {
    const {
      page = 1,
      pageSize = 20,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      isActive,
      tag,
      excludeDeleted = true,
      excludeV2Children = false
    } = options

    const client = this.redis.getClientSafe()
    const tempSets = []

    try {
      // 1. 构建筛选集合
      let filterSet = this.INDEX_KEYS.ALL_SET

      // 状态筛选
      if (isActive === true || isActive === 'true') {
        // 筛选活跃的
        filterSet = this.INDEX_KEYS.ACTIVE_SET
      } else if (isActive === false || isActive === 'false') {
        // 筛选未激活的 = ALL - ACTIVE (- DELETED if excludeDeleted)
        const tempKey = `apikey:tmp:inactive:${randomUUID()}`
        if (excludeDeleted) {
          await client.sdiffstore(
            tempKey,
            this.INDEX_KEYS.ALL_SET,
            this.INDEX_KEYS.ACTIVE_SET,
            this.INDEX_KEYS.DELETED_SET
          )
        } else {
          await client.sdiffstore(tempKey, this.INDEX_KEYS.ALL_SET, this.INDEX_KEYS.ACTIVE_SET)
        }
        await client.expire(tempKey, 60)
        filterSet = tempKey
        tempSets.push(tempKey)
      } else if (excludeDeleted) {
        // 排除已删除：ALL - DELETED
        const tempKey = `apikey:tmp:notdeleted:${randomUUID()}`
        await client.sdiffstore(tempKey, this.INDEX_KEYS.ALL_SET, this.INDEX_KEYS.DELETED_SET)
        await client.expire(tempKey, 60)
        filterSet = tempKey
        tempSets.push(tempKey)
      }

      // 标签筛选
      if (tag) {
        const tagSet = `apikey:tag:${tag}`
        const tempKey = `apikey:tmp:tag:${randomUUID()}`
        await client.sinterstore(tempKey, filterSet, tagSet)
        await client.expire(tempKey, 60)
        filterSet = tempKey
        tempSets.push(tempKey)
      }

      // 2. 获取筛选后的 keyId 集合
      let filterMembers = await client.smembers(filterSet)
      // 管理端分组浏览：在排序/分页前剔除 v2 子 key，保证 pagination.total 不计子 API
      if (excludeV2Children) {
        const childIds = await this.redis.getAllV2ChildKeyIds()
        if (childIds.size > 0) {
          filterMembers = filterMembers.filter((id) => !childIds.has(id))
        }
      }
      if (filterMembers.length === 0) {
        // 没有匹配的数据
        return {
          items: [],
          pagination: { page: 1, pageSize, total: 0, totalPages: 1 },
          availableTags: await this._getAvailableTags(client)
        }
      }

      // 3. 排序
      let sortedKeyIds

      if (sortBy === 'name') {
        // 优化：只拉筛选后 keyId 的 name 字段，避免全量扫描 name 索引
        const pipeline = client.pipeline()
        for (const keyId of filterMembers) {
          pipeline.hget(`apikey:${keyId}`, 'name')
        }
        const results = await pipeline.exec()

        // 组装并排序
        const items = filterMembers.map((keyId, i) => ({
          keyId,
          name: (results[i]?.[1] || '').toLowerCase()
        }))
        items.sort((a, b) =>
          sortOrder === 'desc' ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name)
        )
        sortedKeyIds = items.map((item) => item.keyId)
      } else {
        // createdAt / lastUsedAt 索引成员是 keyId，可以用 ZINTERSTORE
        const sortIndex = this._getSortIndex(sortBy)
        const tempSortedKey = `apikey:tmp:sorted:${randomUUID()}`
        tempSets.push(tempSortedKey)

        // 将 filterSet 转换为 Sorted Set（所有分数为 0）
        const filterZsetKey = `apikey:tmp:filter:${randomUUID()}`
        tempSets.push(filterZsetKey)

        const zaddArgs = []
        for (const member of filterMembers) {
          zaddArgs.push(0, member)
        }
        await client.zadd(filterZsetKey, ...zaddArgs)
        await client.expire(filterZsetKey, 60)

        // ZINTERSTORE：取交集，使用排序索引的分数（WEIGHTS 0 1）
        await client.zinterstore(tempSortedKey, 2, filterZsetKey, sortIndex, 'WEIGHTS', 0, 1)
        await client.expire(tempSortedKey, 60)

        // 获取排序后的 keyId
        sortedKeyIds =
          sortOrder === 'desc'
            ? await client.zrevrange(tempSortedKey, 0, -1)
            : await client.zrange(tempSortedKey, 0, -1)
      }

      // 4. 分页
      const total = sortedKeyIds.length
      const totalPages = Math.max(Math.ceil(total / pageSize), 1)
      const validPage = Math.min(Math.max(1, page), totalPages)
      const start = (validPage - 1) * pageSize
      const pageKeyIds = sortedKeyIds.slice(start, start + pageSize)

      // 5. 获取数据
      const items = await this.redis.batchGetApiKeys(pageKeyIds)

      // 6. 获取所有标签
      const availableTags = await this._getAvailableTags(client)

      return {
        items,
        pagination: {
          page: validPage,
          pageSize,
          total,
          totalPages
        },
        availableTags
      }
    } finally {
      // 7. 清理临时集合
      for (const tempKey of tempSets) {
        client.del(tempKey).catch(() => {})
      }
    }
  }

  /**
   * 获取排序索引键名
   */
  _getSortIndex(sortBy) {
    switch (sortBy) {
      case 'createdAt':
        return this.INDEX_KEYS.CREATED_AT
      case 'lastUsedAt':
        return this.INDEX_KEYS.LAST_USED_AT
      case 'name':
        return this.INDEX_KEYS.NAME
      default:
        return this.INDEX_KEYS.CREATED_AT
    }
  }

  /**
   * 获取所有可用标签（从 tags:all 集合）
   */
  async _getAvailableTags(client) {
    try {
      const tags = await client.smembers(this.INDEX_KEYS.TAGS_ALL)
      return tags.sort()
    } catch {
      return []
    }
  }

  /**
   * 更新 lastUsedAt 索引（供 recordUsage 调用）
   */
  async updateLastUsedAt(keyId, lastUsedAt) {
    if (!this.redis || !keyId) {
      return
    }

    try {
      const client = this.redis.getClientSafe()
      const timestamp = lastUsedAt ? new Date(lastUsedAt).getTime() : Date.now()
      await client.zadd(this.INDEX_KEYS.LAST_USED_AT, timestamp, keyId)
    } catch (error) {
      logger.error(`❌ 更新 API Key ${keyId} lastUsedAt 索引失败:`, error)
    }
  }

  /**
   * 获取索引状态
   */
  async getStatus() {
    if (!this.redis) {
      return { ready: false, building: false }
    }

    try {
      const client = this.redis.getClientSafe()
      const version = await client.get(this.INDEX_VERSION_KEY)
      const totalCount = await client.scard(this.INDEX_KEYS.ALL_SET)

      return {
        ready: parseInt(version) >= this.CURRENT_VERSION,
        building: this.isBuilding,
        progress: this.buildProgress,
        version: parseInt(version) || 0,
        currentVersion: this.CURRENT_VERSION,
        totalIndexed: totalCount
      }
    } catch {
      return { ready: false, building: this.isBuilding }
    }
  }
}

// 单例
const apiKeyIndexService = new ApiKeyIndexService()

module.exports = apiKeyIndexService
