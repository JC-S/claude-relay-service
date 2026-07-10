jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn()
}))

jest.mock('../src/utils/upstreamErrorHelper', () => ({
  markTempUnavailable: jest.fn(() => Promise.resolve())
}))

const bedrockRelayService = require('../src/services/relay/bedrockRelayService')

describe('Bedrock user-facing English messages', () => {
  test.each([
    [
      'ValidationException',
      'invalid payload',
      'Bedrock request validation failed: invalid payload'
    ],
    [
      'ThrottlingException',
      'upstream detail',
      'Bedrock request was throttled. Please try again later.'
    ],
    [
      'AccessDeniedException',
      'upstream detail',
      'Bedrock access denied. Check the IAM permissions.'
    ],
    [
      'ModelNotReadyException',
      'upstream detail',
      'Bedrock model is not ready. Please try again later.'
    ],
    ['InternalServerException', 'unavailable', 'Bedrock service error: unavailable']
  ])('maps %s without changing the upstream error category', (name, message, expected) => {
    const handled = bedrockRelayService._handleBedrockError({ name, message })

    expect(handled).toBeInstanceOf(Error)
    expect(handled.message).toBe(expected)
    expect(handled.message).not.toMatch(/\p{Script=Han}/u)
  })

  test('uses the English default detail for an error without a message', () => {
    expect(bedrockRelayService._handleBedrockError({ name: 'UnknownError' }).message).toBe(
      'Bedrock service error: Unknown Bedrock error'
    )
  })

  test('reports missing AWS credentials in English', () => {
    const oldAccessKey = process.env.AWS_ACCESS_KEY_ID
    const oldSecretKey = process.env.AWS_SECRET_ACCESS_KEY
    delete process.env.AWS_ACCESS_KEY_ID
    delete process.env.AWS_SECRET_ACCESS_KEY
    bedrockRelayService.clients.clear()

    try {
      expect(() =>
        bedrockRelayService._getBedrockClient('us-east-1', { id: 'missing_credentials' })
      ).toThrow(
        'AWS credentials are not configured. Configure the AWS access key or Bearer Token on the Bedrock account, or set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (or AWS_BEARER_TOKEN_BEDROCK).'
      )
    } finally {
      if (oldAccessKey === undefined) delete process.env.AWS_ACCESS_KEY_ID
      else process.env.AWS_ACCESS_KEY_ID = oldAccessKey
      if (oldSecretKey === undefined) delete process.env.AWS_SECRET_ACCESS_KEY
      else process.env.AWS_SECRET_ACCESS_KEY = oldSecretKey
    }
  })
})
