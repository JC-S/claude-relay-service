jest.mock('axios', () => jest.fn())

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn()
}))

const mockSetInterval = jest
  .spyOn(global, 'setInterval')
  .mockImplementation(() => ({ unref: jest.fn() }))
const axios = require('axios')
const geminiAccountService = require('../src/services/account/geminiAccountService')
mockSetInterval.mockRestore()

describe('Gemini internal user-facing English messages', () => {
  const client = {
    getAccessToken: jest.fn().mockResolvedValue({ token: 'access_token' })
  }

  beforeEach(() => {
    jest.clearAllMocks()
    client.getAccessToken.mockResolvedValue({ token: 'access_token' })
  })

  test('reports onboardUser polling timeout in English without a real wait', async () => {
    jest.useFakeTimers()
    axios.mockResolvedValue({ data: { done: false } })

    const pending = geminiAccountService.onboardUser(client, 'PRO', null, {})
    const expectation = expect(pending).rejects.toThrow('onboardUser operation timed out.')
    await jest.runAllTimersAsync()
    await expectation
    jest.useRealTimers()
  })

  test('reports the required project configuration in English', async () => {
    const oldProject = process.env.GOOGLE_CLOUD_PROJECT
    delete process.env.GOOGLE_CLOUD_PROJECT
    axios.mockImplementation(async (config) => {
      if (config.url.includes(':loadCodeAssist')) {
        return {
          data: {
            currentTier: {
              id: 'PRO',
              userDefinedCloudaiCompanionProject: true
            }
          }
        }
      }
      return { data: {} }
    })

    try {
      await expect(geminiAccountService.setupUser(client)).rejects.toThrow(
        'This account requires GOOGLE_CLOUD_PROJECT to be set or a projectId to be provided.'
      )
    } finally {
      if (oldProject === undefined) delete process.env.GOOGLE_CLOUD_PROJECT
      else process.env.GOOGLE_CLOUD_PROJECT = oldProject
    }
  })
})
