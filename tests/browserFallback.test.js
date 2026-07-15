jest.mock('../src/utils/logger', () => ({ api: jest.fn() }))

const { browserFallbackMiddleware, isApiRelayPath } = require('../src/middleware/browserFallback')

const RELAY_PATHS = [
  '/api/v1/messages',
  '/claude/v1/messages',
  '/antigravity/api/v1',
  '/gemini-cli/api/v1',
  '/gemini/v1beta',
  '/openai/v1/responses',
  '/general/v1/responses',
  '/droid/v1/messages',
  '/grok/responses',
  '/azure/openai/deployments/test'
]

describe('browser fallback relay path guard', () => {
  test.each(RELAY_PATHS)('recognizes relay path %s', (originalUrl) => {
    expect(isApiRelayPath({ originalUrl })).toBe(true)
  })

  test.each([
    '/apiStats',
    '/admin/api-keys',
    '/admin-next/api-stats',
    '/users/profile',
    '/web/auth/login',
    '/assets/app.js',
    '/unknown'
  ])('rejects non-relay path %s', (originalUrl) => {
    expect(isApiRelayPath({ originalUrl })).toBe(false)
  })

  test('supports a short custom key only on relay routes', () => {
    const req = {
      originalUrl: '/general//v1/responses?debug=1',
      headers: {
        'user-agent': 'Mozilla/5.0 Chrome/125.0',
        authorization: 'x'
      }
    }
    const next = jest.fn()

    browserFallbackMiddleware(req, {}, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(req.isBrowserFallback).toBe(true)
    expect(req.headers['user-agent']).toContain('claude-cli/')
  })

  test('does not modify browser requests to admin routes', () => {
    const req = {
      originalUrl: '/admin/api-keys',
      headers: {
        'user-agent': 'Mozilla/5.0 Chrome/125.0',
        authorization: 'custom key'
      }
    }

    browserFallbackMiddleware(req, {}, jest.fn())

    expect(req.isBrowserFallback).toBeUndefined()
    expect(req.headers['user-agent']).toBe('Mozilla/5.0 Chrome/125.0')
  })
})
