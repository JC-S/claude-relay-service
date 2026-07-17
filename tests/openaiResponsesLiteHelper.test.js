const {
  isResponsesLiteRequest,
  normalizeOpenAIResponsesLiteBody
} = require('../src/utils/openaiResponsesLiteHelper')

describe('openaiResponsesLiteHelper', () => {
  test('recognizes only the exact true header value', () => {
    expect(isResponsesLiteRequest({ 'x-openai-internal-codex-responses-lite': 'true' })).toBe(true)
    for (const value of ['TRUE', '1', 'yes', 'false', true]) {
      expect(isResponsesLiteRequest({ 'x-openai-internal-codex-responses-lite': value })).toBe(
        false
      )
    }
  })

  test('normalizes instructions, tools, reasoning, and input order', () => {
    const body = normalizeOpenAIResponsesLiteBody({
      model: 'gpt-5.6-sol',
      instructions: 'Be concise',
      input: 'hello',
      tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }],
      reasoning: { effort: 'high' },
      parallel_tool_calls: true
    })

    expect(body.model).toBe('gpt-5.6-sol')
    expect(body.instructions).toBeUndefined()
    expect(body.tools).toBeUndefined()
    expect(body.reasoning).toEqual({ effort: 'high', context: 'all_turns' })
    expect(body.parallel_tool_calls).toBe(false)
    expect(body.input[0]).toMatchObject({
      type: 'additional_tools',
      role: 'developer'
    })
    expect(body.input[0].tools).toHaveLength(1)
    expect(body.input[1]).toEqual({
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: 'Be concise' }]
    })
    expect(body.input[2]).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'hello' }]
    })
  })

  test('merges carriers, deduplicates identical tools, and is idempotent', () => {
    const tool = { type: 'custom', name: 'exec', description: 'Run commands' }
    const initial = {
      input: [
        { type: 'additional_tools', role: 'developer', tools: [tool] },
        { type: 'message', role: 'user', content: [] },
        { type: 'additional_tools', tools: [tool] }
      ],
      tools: [tool]
    }
    const once = normalizeOpenAIResponsesLiteBody(initial)
    const twice = normalizeOpenAIResponsesLiteBody(once)

    expect(once.input.filter((item) => item.type === 'additional_tools')).toHaveLength(1)
    expect(once.input[0].tools).toEqual([tool])
    expect(twice).toEqual(once)
  })

  test('rejects conflicting and hosted tools', () => {
    expect(() =>
      normalizeOpenAIResponsesLiteBody({
        input: [{ type: 'additional_tools', tools: [{ type: 'custom', name: 'exec' }] }],
        tools: [{ type: 'custom', name: 'exec', description: 'different' }]
      })
    ).toThrow(/conflicting definitions/)

    expect(() =>
      normalizeOpenAIResponsesLiteBody({
        input: [],
        tools: [{ type: 'web_search' }]
      })
    ).toThrow(/does not support hosted tool/)
  })

  test('rejects invalid reasoning, tools, and input', () => {
    expect(() => normalizeOpenAIResponsesLiteBody({ input: [], reasoning: 'high' })).toThrow(
      /reasoning must be an object/
    )
    expect(() => normalizeOpenAIResponsesLiteBody({ input: [], tools: {} })).toThrow(
      /tools must be an array/
    )
    expect(() => normalizeOpenAIResponsesLiteBody({ input: {} })).toThrow(
      /input must be a string or array/
    )
  })
})
