// 登录失败限流（loginRateLimiter）测试
// 覆盖：failure-only 计数与首次 EXPIRE、IP / 账号+IP 维度阈值封禁与 Retry-After、
// 成功登录只清 principal 不清 IP、账号全局维度默认关闭 / env 显式开启、Redis 不可用 fail-open。
//
// harness 要点：模块在加载时读取 env 常量 → 每个用例经 loadLimiter() 用 jest.resetModules()
// 重新 require；resetModules 后 redis mock 工厂会重建，必须「先 require redis 再设
// getClientSafe 行为、再 require 限流器」。

jest.mock('../src/models/redis', () => ({
  getClientSafe: jest.fn()
}))

jest.mock('../src/utils/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  success: jest.fn(),
  security: jest.fn()
}))

const IP = '203.0.113.7'
// 故意带大写与首尾空格：key 必须按 normalize 后的小写 trim 用户名生成
const USERNAME = ' Tenant@Example.COM '
const NORMALIZED = 'tenant@example.com'

const IP_KEY = `web_login:fail:ip:${IP}`
const ACCT_IP_KEY_RE = new RegExp(`^web_login:fail:acct_ip:${NORMALIZED}:[0-9a-f]{16}$`)
const ACCT_KEY = `web_login:fail:acct:${NORMALIZED}`

const ENV_KEYS = [
  'LOGIN_FAIL_WINDOW_SECONDS',
  'LOGIN_MAX_FAILS_PER_IP',
  'LOGIN_MAX_FAILS_PER_ACCOUNT_IP',
  'LOGIN_ACCOUNT_LIMIT_ENABLED',
  'LOGIN_MAX_FAILS_PER_ACCOUNT'
]

function createMockClient(counts = {}) {
  return {
    get: jest.fn((key) => {
      const matched = Object.entries(counts).find(([pattern]) =>
        pattern instanceof RegExp ? pattern.test(key) : pattern === key
      )
      return Promise.resolve(matched ? String(matched[1]) : null)
    }),
    ttl: jest.fn().mockResolvedValue(600),
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    del: jest.fn().mockResolvedValue(1)
  }
}

// counts 支持 {字符串精确键: 数值}；acct_ip 键含 ip 哈希，用辅助函数按前缀匹配
function withCounts(client, entries) {
  client.get.mockImplementation((key) => {
    for (const [prefix, value] of entries) {
      if (key.startsWith(prefix)) {
        return Promise.resolve(String(value))
      }
    }
    return Promise.resolve(null)
  })
  return client
}

function loadLimiter(env = {}, client = createMockClient()) {
  jest.resetModules()
  for (const key of ENV_KEYS) {
    delete process.env[key]
  }
  Object.assign(process.env, env)
  const redis = require('../src/models/redis')
  redis.getClientSafe.mockReturnValue(client)
  const limiter = require('../src/services/loginRateLimiter')
  return { limiter, client, redis }
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    delete process.env[key]
  }
  jest.clearAllMocks()
})

describe('loginRateLimiter', () => {
  // 1. recordFailure：默认只有 IP 与账号+IP 两个维度，INCR 后仅首次（计数=1）设 EXPIRE
  test('recordFailure increments ip and account+ip dimensions, sets EXPIRE only on first failure', async () => {
    const { limiter, client } = loadLimiter()
    client.incr.mockImplementation((key) => Promise.resolve(key === IP_KEY ? 1 : 5))

    await limiter.recordFailure(IP, USERNAME)

    expect(client.incr).toHaveBeenCalledTimes(2)
    const incrKeys = client.incr.mock.calls.map((call) => call[0])
    expect(incrKeys).toContain(IP_KEY)
    expect(incrKeys.some((key) => ACCT_IP_KEY_RE.test(key))).toBe(true)
    // 默认不启用账号全局维度
    expect(incrKeys).not.toContain(ACCT_KEY)
    // 仅 IP 键是首次失败（incr 返回 1）→ 只为它设置窗口
    expect(client.expire).toHaveBeenCalledTimes(1)
    expect(client.expire).toHaveBeenCalledWith(IP_KEY, 900)
  })

  // 2. 未达阈值 → 不封禁
  test('checkBlocked returns not blocked below thresholds', async () => {
    const { limiter } = loadLimiter()
    const state = await limiter.checkBlocked(IP, USERNAME)
    expect(state).toEqual({ blocked: false })
  })

  // 3. IP 维度达阈值（默认 30）→ 429 封禁，Retry-After 取 TTL
  test('blocks by ip dimension with retryAfterSeconds from TTL', async () => {
    const client = withCounts(createMockClient(), [[IP_KEY, 30]])
    const { limiter } = loadLimiter({}, client)

    const state = await limiter.checkBlocked(IP, USERNAME)

    expect(state.blocked).toBe(true)
    expect(state.reason).toBe('ip')
    expect(state.retryAfterSeconds).toBe(600)
  })

  // 4. 账号+IP 维度达阈值（默认 5）→ 封禁；TTL 异常时回退窗口时长
  test('blocks by account+ip dimension, falls back to window seconds when TTL is invalid', async () => {
    const client = withCounts(createMockClient(), [['web_login:fail:acct_ip:', 5]])
    client.ttl.mockResolvedValue(-1)
    const { limiter } = loadLimiter({}, client)

    const state = await limiter.checkBlocked(IP, USERNAME)

    expect(state.blocked).toBe(true)
    expect(state.reason).toBe('account_ip')
    expect(state.retryAfterSeconds).toBe(900)
  })

  // 5. 成功登录只清 principal（账号+IP），绝不清 IP 维度
  test('clearFailureForPrincipal deletes account+ip key but never the ip key', async () => {
    const { limiter, client } = loadLimiter()

    await limiter.clearFailureForPrincipal(IP, USERNAME)

    expect(client.del).toHaveBeenCalledTimes(1)
    const delKeys = client.del.mock.calls[0]
    expect(delKeys).toHaveLength(1)
    expect(ACCT_IP_KEY_RE.test(delKeys[0])).toBe(true)
    expect(delKeys).not.toContain(IP_KEY)
  })

  // 6. 账号全局维度默认关闭：即使该账号计数极高也不封禁（防账号锁定 DoS 的默认姿态）
  test('account-global dimension is disabled by default', async () => {
    const client = withCounts(createMockClient(), [[ACCT_KEY, 9999]])
    const { limiter } = loadLimiter({}, client)

    const state = await limiter.checkBlocked(IP, USERNAME)

    expect(state.blocked).toBe(false)
  })

  // 7. env 显式开启账号全局维度后：计数、封禁、清理都包含该维度
  test('account-global dimension works when LOGIN_ACCOUNT_LIMIT_ENABLED=true', async () => {
    const client = withCounts(createMockClient(), [[ACCT_KEY, 20]])
    const { limiter } = loadLimiter({ LOGIN_ACCOUNT_LIMIT_ENABLED: 'true' }, client)

    const state = await limiter.checkBlocked(IP, USERNAME)
    expect(state.blocked).toBe(true)
    expect(state.reason).toBe('account')

    await limiter.recordFailure(IP, USERNAME)
    expect(client.incr.mock.calls.map((call) => call[0])).toContain(ACCT_KEY)

    await limiter.clearFailureForPrincipal(IP, USERNAME)
    const delKeys = client.del.mock.calls[0]
    expect(delKeys).toContain(ACCT_KEY)
    expect(delKeys).not.toContain(IP_KEY)
  })

  // 8. 阈值与窗口支持 env 覆盖
  test('thresholds and window are overridable via env', async () => {
    const client = withCounts(createMockClient(), [[IP_KEY, 3]])
    const { limiter } = loadLimiter(
      { LOGIN_MAX_FAILS_PER_IP: '3', LOGIN_FAIL_WINDOW_SECONDS: '60' },
      client
    )

    const state = await limiter.checkBlocked(IP, USERNAME)
    expect(state.blocked).toBe(true)

    client.incr.mockResolvedValue(1)
    await limiter.recordFailure(IP, USERNAME)
    expect(client.expire).toHaveBeenCalledWith(IP_KEY, 60)
  })

  // 9. Redis 不可用 → fail-open：放行、不抛错、打 warning
  test('fails open with a warning when redis is unavailable', async () => {
    const { limiter, redis } = loadLimiter()
    redis.getClientSafe.mockImplementation(() => {
      throw new Error('Redis client is not connected')
    })
    const logger = require('../src/utils/logger')

    await expect(limiter.checkBlocked(IP, USERNAME)).resolves.toEqual({ blocked: false })
    await expect(limiter.recordFailure(IP, USERNAME)).resolves.toBeUndefined()
    await expect(limiter.clearFailureForPrincipal(IP, USERNAME)).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalled()
  })
})
