jest.mock('../src/utils/logger', () => ({
  api: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  security: jest.fn(),
  warn: jest.fn()
}))

const ClientValidator = require('../src/validators/clientValidator')

const codexInstructions =
  'You are Codex, based on GPT-5. You are running as a coding agent in the Codex CLI.'

function createCodexTuiRequest(overrides = {}) {
  const path = overrides.path || '/openai/responses'
  return {
    path,
    originalUrl: overrides.originalUrl || path,
    ip: '127.0.0.1',
    headers: {
      'user-agent':
        overrides.userAgent ||
        'codex-tui/0.124.0 (Ubuntu 22.4.0; aarch64) xterm-256color (codex-tui; 0.124.0)',
      originator: overrides.originator || 'codex-tui',
      session_id: overrides.sessionId || 'session_123456789012345678901234567890',
      ...(overrides.headers || {})
    },
    body: {
      instructions: overrides.instructions || codexInstructions,
      model: overrides.model || 'gpt-5.5',
      ...(overrides.body || {})
    }
  }
}

describe('Codex CLI client validation', () => {
  test('allows codex-tui requests when codex_cli is allowed', () => {
    const result = ClientValidator.validateRequest(['codex_cli'], createCodexTuiRequest())

    expect(result.allowed).toBe(true)
    expect(result.matchedClient).toBe('codex_cli')
  })

  test('rejects codex-tui requests with mismatched originator', () => {
    const result = ClientValidator.validateRequest(
      ['codex_cli'],
      createCodexTuiRequest({ originator: 'codex_cli_rs' })
    )

    expect(result.allowed).toBe(false)
  })
})
