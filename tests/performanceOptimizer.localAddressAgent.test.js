describe('performanceOptimizer local-address HTTPS agents', () => {
  beforeEach(() => {
    jest.resetModules()
  })

  test('returns a cached https agent bound to the local address', () => {
    const { getHttpsAgentForLocalAddress } = require('../src/utils/performanceOptimizer')

    const agent = getHttpsAgentForLocalAddress('10.0.0.191')
    const sameAgent = getHttpsAgentForLocalAddress('10.0.0.191')

    expect(agent).toBe(sameAgent)
    expect(agent.options.localAddress).toBe('10.0.0.191')
    expect(agent.options.family).toBe(4)
  })

  test('uses different agents for different addresses and stream modes', () => {
    const { getHttpsAgentForLocalAddress } = require('../src/utils/performanceOptimizer')

    const nonStreamAgent = getHttpsAgentForLocalAddress('10.0.0.191', { stream: false })
    const streamAgent = getHttpsAgentForLocalAddress('10.0.0.191', { stream: true })
    const otherAddressAgent = getHttpsAgentForLocalAddress('10.0.0.184', { stream: false })

    expect(nonStreamAgent).not.toBe(streamAgent)
    expect(nonStreamAgent).not.toBe(otherAddressAgent)
    expect(streamAgent.options.localAddress).toBe('10.0.0.191')
    expect(otherAddressAgent.options.localAddress).toBe('10.0.0.184')
  })
})
