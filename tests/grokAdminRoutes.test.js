const mockRouter = {
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  delete: jest.fn(),
  use: jest.fn()
}

jest.mock(
  'express',
  () => ({
    Router: () => mockRouter
  }),
  { virtual: true }
)
jest.mock('../src/middleware/auth', () => ({ authenticateAdmin: jest.fn() }))
jest.mock('../src/utils/logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn()
}))
jest.mock('../src/models/redis', () => ({}))
jest.mock('../src/services/apiKeyService', () => ({}))
jest.mock('../src/services/accountGroupService', () => ({}))
jest.mock('../src/services/grokOAuthService', () => ({}))
jest.mock('../src/services/grokQuotaService', () => ({}))
jest.mock('../src/services/account/grokAccountService', () => ({
  createAccount: jest.fn(),
  getSafeAccount: jest.fn(),
  toggleSchedulable: jest.fn(),
  updateAccount: jest.fn()
}))
jest.mock('../src/services/accountTestSchedulerService', () => ({
  getTestConfig: jest.fn(),
  setTestConfig: jest.fn()
}))

const grokAccountService = require('../src/services/account/grokAccountService')
const accountTestSchedulerService = require('../src/services/accountTestSchedulerService')
const { GROK_TEST_MODELS } = require('../config/models')
require('../src/routes/admin/grokAccounts')

const getConfigHandler = mockRouter.get.mock.calls.find(
  (call) => call[0] === '/grok-accounts/:id/test-config'
)[2]
const putConfigHandler = mockRouter.put.mock.calls.find(
  (call) => call[0] === '/grok-accounts/:id/test-config'
)[2]
const toggleSchedulableHandler = mockRouter.post.mock.calls.find(
  (call) => call[0] === '/grok-accounts/:id/toggle-schedulable'
)[2]
const createAccountHandler = mockRouter.post.mock.calls.find(
  (call) => call[0] === '/grok-accounts'
)[2]
const updateAccountHandler = mockRouter.put.mock.calls.find(
  (call) => call[0] === '/grok-accounts/:id'
)[2]

function createResponse() {
  const res = {
    statusCode: 200,
    body: null,
    status: jest.fn((statusCode) => {
      res.statusCode = statusCode
      return res
    }),
    json: jest.fn((body) => {
      res.body = body
      return res
    })
  }
  return res
}

describe('Grok scheduled test configuration routes', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    grokAccountService.getSafeAccount.mockResolvedValue({ id: 'grok-account-1' })
    accountTestSchedulerService.getTestConfig.mockResolvedValue(null)
    accountTestSchedulerService.setTestConfig.mockResolvedValue()
    grokAccountService.toggleSchedulable.mockResolvedValue({
      id: 'grok-account-1',
      schedulable: false
    })
  })

  test('returns the Grok default when no scheduled test is configured', async () => {
    const res = createResponse()

    await getConfigHandler({ params: { id: 'grok-account-1' } }, res)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      success: true,
      data: {
        accountId: 'grok-account-1',
        platform: 'grok',
        config: {
          enabled: false,
          cronExpression: '0 8 * * *',
          model: GROK_TEST_MODELS[0].value
        }
      }
    })
    expect(accountTestSchedulerService.getTestConfig).toHaveBeenCalledWith(
      'grok-account-1',
      'grok'
    )
  })

  test('normalizes and stores a valid Grok scheduled test configuration', async () => {
    const res = createResponse()

    await putConfigHandler(
      {
        params: { id: 'grok-account-1' },
        body: { enabled: true, cronExpression: '  */15 * * * *  ', model: '  grok-4.5  ' }
      },
      res
    )

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ success: true })
    expect(accountTestSchedulerService.setTestConfig).toHaveBeenCalledWith(
      'grok-account-1',
      'grok',
      { enabled: true, cronExpression: '*/15 * * * *', model: 'grok-4.5' }
    )
  })

  test.each([
    [{ enabled: 'true', cronExpression: '0 8 * * *', model: 'grok-4.5' }, 'enabled'],
    [{ enabled: true, cronExpression: ' ', model: 'grok-4.5' }, 'cronExpression'],
    [{ enabled: true, cronExpression: '0 8 * * *', model: ' ' }, 'model']
  ])('rejects invalid scheduled test input %#', async (body, errorField) => {
    const res = createResponse()

    await putConfigHandler({ params: { id: 'grok-account-1' }, body }, res)

    expect(res.statusCode).toBe(400)
    expect(res.body.error).toContain(errorField)
    expect(accountTestSchedulerService.setTestConfig).not.toHaveBeenCalled()
  })

  test('returns 404 without reading or writing config for a missing account', async () => {
    grokAccountService.getSafeAccount.mockResolvedValue(null)
    const getRes = createResponse()
    const putRes = createResponse()

    await getConfigHandler({ params: { id: 'missing' } }, getRes)
    await putConfigHandler(
      {
        params: { id: 'missing' },
        body: { enabled: true, cronExpression: '0 8 * * *', model: 'grok-4.5' }
      },
      putRes
    )

    expect(getRes.statusCode).toBe(404)
    expect(putRes.statusCode).toBe(404)
    expect(accountTestSchedulerService.getTestConfig).not.toHaveBeenCalled()
    expect(accountTestSchedulerService.setTestConfig).not.toHaveBeenCalled()
  })

  test('returns schedulable at the top level for the shared account-list UI contract', async () => {
    const res = createResponse()

    await toggleSchedulableHandler({ params: { id: 'grok-account-1' } }, res)

    expect(res.body).toEqual({
      success: true,
      schedulable: false,
      data: { id: 'grok-account-1', schedulable: false }
    })
  })

  test.each([
    [{ authType: 'api_key', apiKey: 'xai-key', priority: 0 }, 'Priority'],
    [{ authType: 'api_key', apiKey: 'xai-key', priority: 101 }, 'Priority'],
    [{ authType: 'api_key', apiKey: 'xai-key', concurrency: 0 }, 'Concurrency'],
    [{ authType: 'api_key', apiKey: 'xai-key', concurrency: 1.5 }, 'Concurrency'],
    [{ authType: 'api_key', apiKey: 'xai-key', concurrency: 'Infinity' }, 'Concurrency']
  ])('rejects invalid scheduling values when creating an account %#', async (body, field) => {
    const res = createResponse()

    await createAccountHandler({ body }, res)

    expect(res.statusCode).toBe(400)
    expect(res.body.error).toContain(field)
    expect(grokAccountService.createAccount).not.toHaveBeenCalled()
  })

  test('rejects a non-integer concurrency when updating an account', async () => {
    const res = createResponse()

    await updateAccountHandler(
      { params: { id: 'grok-account-1' }, body: { concurrency: 1.5 } },
      res
    )

    expect(res.statusCode).toBe(400)
    expect(res.body.error).toContain('Concurrency')
    expect(grokAccountService.updateAccount).not.toHaveBeenCalled()
  })
})
