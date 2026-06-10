// v2 改密后旧会话失效测试（authenticateV2Account 中间件）
// 覆盖：无 v2PasswordChangedAt 的存量账号放行（向后兼容）、changedAt 晚于 loginTime 时
// 401 且删除 session、changedAt 早于 loginTime（改密后新登录）放行、正常会话滑动续期。
//
// harness 镜像 auth.v2Budget.test.js：auth.js 顶层 require 的 service 全部 mock 掉，
// redis 按 authenticateV2Account 用到的 getSession/getApiKey/setSession/deleteSession mock。

jest.mock('../src/services/apiKeyService', () => ({
  validateApiKey: jest.fn()
}))

jest.mock('../src/services/userService', () => ({}))

jest.mock('../src/models/redis', () => ({
  getSession: jest.fn(),
  getApiKey: jest.fn(),
  setSession: jest.fn(),
  deleteSession: jest.fn(),
  client: { get: jest.fn() },
  getNextResetTime: jest.fn(() => new Date('2026-01-01T00:00:00.000Z'))
}))

jest.mock('../src/services/claudeRelayConfigService', () => ({
  isClaudeCodeOnlyEnabled: jest.fn().mockResolvedValue(false)
}))

jest.mock('../src/utils/logger', () => ({
  api: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  security: jest.fn(),
  warn: jest.fn()
}))

const redis = require('../src/models/redis')
const { authenticateV2Account } = require('../src/middleware/auth')

const TOKEN = 'v2-session-token'
const PARENT_ID = 'parent-key-1'
const LOGIN_TIME = '2026-06-10T10:00:00.000Z'

function createReq() {
  return {
    ip: '127.0.0.1',
    headers: { authorization: `Bearer ${TOKEN}` },
    cookies: {}
  }
}

function createRes() {
  const res = {
    statusCode: 200,
    body: null,
    status: jest.fn((code) => {
      res.statusCode = code
      return res
    }),
    json: jest.fn((payload) => {
      res.body = payload
      return res
    })
  }
  return res
}

function mockSession(overrides = {}) {
  redis.getSession.mockResolvedValue({
    role: 'v2',
    v2KeyId: PARENT_ID,
    username: 'tenant@example.com',
    v2Email: 'tenant@example.com',
    loginTime: LOGIN_TIME,
    // 最近活跃，确保不触发 24 小时不活跃登出分支
    lastActivity: new Date().toISOString(),
    ...overrides
  })
}

function mockParent(overrides = {}) {
  redis.getApiKey.mockResolvedValue({
    id: PARENT_ID,
    isV2Parent: 'true',
    isActive: 'true',
    isDeleted: 'false',
    ...overrides
  })
}

describe('authenticateV2Account password-change session invalidation', () => {
  beforeEach(() => {
    // authenticateV2Account 的会话查询是 Promise.race + setTimeout(5000) 兜底；
    // 用假定时器避免真实 5s 定时器悬挂导致 jest worker 强退告警（race 经 mock 立即胜出）
    jest.useFakeTimers()
    jest.clearAllMocks()
    mockSession()
    mockParent()
    redis.setSession.mockResolvedValue()
    redis.deleteSession.mockResolvedValue()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  // 1. 存量父账号无 v2PasswordChangedAt → 向后兼容放行，并滑动续期
  test('allows legacy parents without v2PasswordChangedAt and renews the session', async () => {
    const req = createReq()
    const res = createRes()
    const next = jest.fn()

    await authenticateV2Account(req, res, next)

    expect(next).toHaveBeenCalled()
    expect(redis.deleteSession).not.toHaveBeenCalled()
    expect(redis.setSession).toHaveBeenCalledWith(TOKEN, expect.any(Object), 86400)
    expect(req.v2Account).toEqual({
      parentKeyId: PARENT_ID,
      email: 'tenant@example.com',
      sessionId: TOKEN
    })
  })

  // 2. 密码在登录之后被修改/重置 → 401、删除当前 session、不放行、不续期
  test('rejects sessions older than v2PasswordChangedAt and deletes them', async () => {
    mockParent({ v2PasswordChangedAt: '2026-06-10T11:00:00.000Z' })
    const req = createReq()
    const res = createRes()
    const next = jest.fn()

    await authenticateV2Account(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.body.error).toBe('Session expired')
    expect(redis.deleteSession).toHaveBeenCalledWith(TOKEN)
    expect(redis.setSession).not.toHaveBeenCalled()
  })

  // 3. 改密后重新登录（loginTime 晚于 changedAt）→ 放行
  test('allows sessions created after the password change', async () => {
    mockParent({ v2PasswordChangedAt: '2026-06-10T09:00:00.000Z' })
    const req = createReq()
    const res = createRes()
    const next = jest.fn()

    await authenticateV2Account(req, res, next)

    expect(next).toHaveBeenCalled()
    expect(redis.deleteSession).not.toHaveBeenCalled()
  })

  // 4. 父账号被禁用时仍优先走 403（改密检查不改变既有保护顺序）
  test('still returns 403 for disabled parents before the password-change check', async () => {
    mockParent({ isActive: 'false', v2PasswordChangedAt: '2026-06-10T11:00:00.000Z' })
    const req = createReq()
    const res = createRes()
    const next = jest.fn()

    await authenticateV2Account(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(403)
    expect(redis.deleteSession).not.toHaveBeenCalled()
  })
})
