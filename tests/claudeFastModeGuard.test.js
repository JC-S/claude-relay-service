const {
  CLAUDE_FAST_MODE_BETA,
  CLAUDE_FAST_MODE_DISABLED_MESSAGE,
  buildClaudeFastModeDisabledResponse,
  hasClaudeFastModeBeta,
  hasClaudeFastModeSpeed,
  isClaudeFastModeRequest
} = require('../src/utils/claudeFastModeGuard')

describe('Claude Fast Mode guard', () => {
  test.each(['fast', ' FAST '])('detects speed=%p', (speed) => {
    expect(hasClaudeFastModeSpeed({ speed })).toBe(true)
    expect(isClaudeFastModeRequest({ speed }, {})).toBe(true)
  })

  test.each([undefined, null, '', 'standard', 'fastest', 1])(
    'does not treat speed=%p as Fast Mode',
    (speed) => {
      expect(hasClaudeFastModeSpeed({ speed })).toBe(false)
    }
  )

  test('detects the Fast Mode beta in a mixed, case-insensitive feature list', () => {
    const headers = {
      'Anthropic-Beta': `context-1m-2025-08-07, ${CLAUDE_FAST_MODE_BETA.toUpperCase()}`
    }

    expect(hasClaudeFastModeBeta(headers)).toBe(true)
    expect(isClaudeFastModeRequest({}, headers)).toBe(true)
  })

  test('requires an exact Fast Mode beta feature', () => {
    expect(
      hasClaudeFastModeBeta({
        'anthropic-beta': `${CLAUDE_FAST_MODE_BETA}-preview`
      })
    ).toBe(false)
  })

  test('builds the agreed Anthropic error response', () => {
    expect(buildClaudeFastModeDisabledResponse()).toEqual({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: CLAUDE_FAST_MODE_DISABLED_MESSAGE
      }
    })
  })
})
