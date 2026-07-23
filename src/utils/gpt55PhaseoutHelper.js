const GPT55_PHASEOUT_MODEL = 'gpt-5.5'
const GPT55_PHASEOUT_ERROR_CODE = 'model_migration_required'
const GPT55_PHASEOUT_MESSAGE =
  'GPT-5.6 models are now available. GPT-5.6-sol offers better intelligence at the same price as GPT-5.5. Please update your model configuration.'

function isGpt55PhaseoutModel(model) {
  return typeof model === 'string' && model.trim().toLowerCase() === GPT55_PHASEOUT_MODEL
}

function createGpt55PhaseoutError() {
  return {
    error: {
      message: GPT55_PHASEOUT_MESSAGE,
      type: 'invalid_request_error',
      code: GPT55_PHASEOUT_ERROR_CODE,
      param: 'model'
    }
  }
}

module.exports = {
  GPT55_PHASEOUT_ERROR_CODE,
  GPT55_PHASEOUT_MESSAGE,
  GPT55_PHASEOUT_MODEL,
  createGpt55PhaseoutError,
  isGpt55PhaseoutModel
}
