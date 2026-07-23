const {
  GPT55_PHASEOUT_MESSAGE,
  createGpt55PhaseoutError,
  isGpt55PhaseoutModel
} = require('../src/utils/gpt55PhaseoutHelper')

describe('gpt-5.5 phaseout helper', () => {
  test.each(['gpt-5.5', ' GPT-5.5 ', 'GpT-5.5'])('matches normalized model %p', (model) => {
    expect(isGpt55PhaseoutModel(model)).toBe(true)
  })

  test.each(['gpt-5.6-sol', 'gpt-5.5-mini', 'gpt-5.5 (fast)', '', null, 55, {}])(
    'does not match non-target model %p',
    (model) => {
      expect(isGpt55PhaseoutModel(model)).toBe(false)
    }
  )

  test('builds the documented OpenAI-compatible migration error', () => {
    expect(createGpt55PhaseoutError()).toEqual({
      error: {
        message: GPT55_PHASEOUT_MESSAGE,
        type: 'invalid_request_error',
        code: 'model_migration_required',
        param: 'model'
      }
    })
  })
})
