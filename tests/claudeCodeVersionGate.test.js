const {
  extractClaudeCodeVersion,
  getMinimumAllowedVersion,
  getClaudeCodeVersionGateResult
} = require('../src/utils/claudeCodeVersionGate')

describe('claudeCodeVersionGate', () => {
  test('extracts Claude Code CLI version from user agent', () => {
    expect(extractClaudeCodeVersion('claude-cli/2.1.150 (external, cli)')).toEqual({
      raw: '2.1.150',
      parts: [2, 1, 150]
    })
  })

  test('builds minimum allowed version by subtracting 10 from cached patch version', () => {
    const cached = extractClaudeCodeVersion('claude-cli/2.1.150 (external, cli)')

    expect(getMinimumAllowedVersion(cached).raw).toBe('2.1.140')
  })

  test('blocks client versions more than 10 versions behind cached version', () => {
    const result = getClaudeCodeVersionGateResult(
      'claude-cli/2.1.139 (external, cli)',
      'claude-cli/2.1.150 (external, cli)'
    )

    expect(result).toEqual({
      blocked: true,
      clientVersion: '2.1.139',
      cachedVersion: '2.1.150',
      minimumAllowedVersion: '2.1.140'
    })
  })

  test('allows client versions exactly 10 versions behind cached version', () => {
    const result = getClaudeCodeVersionGateResult(
      'claude-cli/2.1.140 (external, cli)',
      'claude-cli/2.1.150 (external, cli)'
    )

    expect(result.blocked).toBe(false)
  })

  test('does not block when cached user agent is missing', () => {
    const result = getClaudeCodeVersionGateResult('claude-cli/2.1.139 (external, cli)', null)

    expect(result.blocked).toBe(false)
  })
})
