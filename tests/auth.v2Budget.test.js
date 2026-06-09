// v2 父账号总账 402 拦截测试（authenticateApiKey 中间件）
// 覆盖：未超额放行、达额度 402、不限额(budget=0)放行、按「已用」判断不预扣。
//
// 可行性（见 plan_tmp/v2-account-billing-edge-test-plan_revised.md C10）：v2 402 判断位于
// authenticateApiKey 深处。本文件镜像既有可行样板 authClaudeCodeVersionGate.test.js：
// mock validateApiKey 返回带 parentKeyId/v2TotalBudget/v2ParentTotalCost 的 v2 子 keyData，
// 其余限额(daily/total/weekly)与并发/限流全设 0 以放行至 v2 块；client/version 闸门用与样板
// 一致的「近版本」设置直接通过。不为可测性改任何业务代码。
//
// C1 修正：402 响应体按设计本就含 currentCost/costLimit 及 message 里的预算数字（均为 v2
// 自己的额度，允许展示）。因此只断言「不泄漏上游账户字段」，绝不断言「不含预算数字」。

jest.mock('../src/services/apiKeyService', () => ({
  validateApiKey: jest.fn()
}))

jest.mock('../src/services/userService', () => ({}))

jest.mock('../src/models/redis', () => ({
  client: {
    get: jest.fn()
  },
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

const apiKeyService = require('../src/services/apiKeyService')
const redis = require('../src/models/redis')
const { authenticateApiKey } = require('../src/middleware/auth')

// 与样板一致：需带 Claude Code 系统提示 + metadata.user_id，请求才会被识别为 claude_code 客户端，
// 从而通过 enableClientRestriction:['claude_code'] 的客户端校验，进而抵达 v2 总账块。
const VALID_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude."
const VALID_USER_ID =
  'user_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_account__session_17cf0fd3-d51b-4b59-977d-b899dafb3022'

function createReq(userAgent = 'claude-cli/2.1.150 (external, cli)') {
  return {
    ip: '127.0.0.1',
    path: '/v1/messages',
    originalUrl: '/v1/messages',
    headers: {
      'x-api-key': 'cr_test_child_key',
      'user-agent': userAgent,
      'x-app': 'cli',
      'anthropic-beta': 'claude-code-20250219',
      'anthropic-version': '2023-06-01'
    },
    body: {
      model: 'claude-sonnet-4-5',
      system: [{ type: 'text', text: VALID_SYSTEM_PROMPT }],
      metadata: {
        user_id: VALID_USER_ID
      },
      messages: [{ role: 'user', content: 'test' }]
    },
    connection: {
      remoteAddress: '127.0.0.1'
    }
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

// v2 子 key：带 parentKeyId + 总账字段；其余限额/并发/限流全 0 以放行至 v2 块
function mockV2Child(overrides = {}) {
  apiKeyService.validateApiKey.mockResolvedValue({
    valid: true,
    keyData: {
      id: 'child_key_1',
      name: 'v2-child',
      parentKeyId: 'parent_key_1',
      enableClientRestriction: true,
      allowedClients: ['claude_code'],
      enableIpWhitelist: false,
      concurrencyLimit: 0,
      rateLimitWindow: 0,
      rateLimitRequests: 0,
      rateLimitCost: 0,
      tokenLimit: 0,
      dailyCostLimit: 0,
      totalCostLimit: 0,
      weeklyOpusCostLimit: 0,
      permissions: ['claude'],
      v2TotalBudget: 100,
      v2ParentTotalCost: 10,
      ...overrides
    }
  })
}

describe('authenticateApiKey v2 parent total budget gate', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockV2Child()
    // 与样板一致：缓存版本与请求版本同为 2.1.150，client/version 闸门直接通过
    redis.client.get.mockResolvedValue('claude-cli/2.1.150 (external, cli)')
  })

  // 1. 未超额 → 放行
  test('allows the request when v2 total budget is not exhausted', async () => {
    mockV2Child({ v2TotalBudget: 100, v2ParentTotalCost: 10 })
    const req = createReq()
    const res = createRes()
    const next = jest.fn()

    await authenticateApiKey(req, res, next)

    expect(next).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalledWith(402)
  })

  // 2. 达到额度 → 402（C1：断言不泄漏上游账户字段，但允许含 v2 自身的预算数字）
  test('returns 402 with account_total_budget_exhausted when budget is reached', async () => {
    mockV2Child({ v2TotalBudget: 100, v2ParentTotalCost: 100 })
    const req = createReq()
    const res = createRes()
    const next = jest.fn()

    await authenticateApiKey(req, res, next)

    expect(res.status).toHaveBeenCalledWith(402)
    expect(next).not.toHaveBeenCalled()
    expect(res.body.error.code).toBe('account_total_budget_exhausted')
    expect(res.body.error.type).toBe('insufficient_quota')
    // v2 自身额度信息按设计返回（允许）
    expect(res.body.currentCost).toBe(100)
    expect(res.body.costLimit).toBe(100)
    // 不得泄漏任何上游账户字段
    for (const key of ['accountId', 'accountType', 'parentKeyId', 'realCost', 'upstreamNicIp']) {
      expect(res.body).not.toHaveProperty(key)
    }
  })

  // 3. 不限额（v2TotalBudget=0）→ 不拦截
  test('does not block when v2 total budget is 0 (unlimited)', async () => {
    mockV2Child({ v2TotalBudget: 0, v2ParentTotalCost: 999999 })
    const req = createReq()
    const res = createRes()
    const next = jest.fn()

    await authenticateApiKey(req, res, next)

    expect(next).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalledWith(402)
  })

  // 4. 按「已用」判断、不预扣本次：略低于额度仍放行（即使本次可能超）
  test('judges on already-used cost without pre-charging the current request', async () => {
    mockV2Child({ v2TotalBudget: 100, v2ParentTotalCost: 99.9 })
    const req = createReq()
    const res = createRes()
    const next = jest.fn()

    await authenticateApiKey(req, res, next)

    expect(next).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalledWith(402)
  })
})
