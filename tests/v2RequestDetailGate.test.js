const {
  V2RequestDetailGate,
  V2RequestDetailBusyError
} = require('../src/utils/v2RequestDetailGate')

describe('V2RequestDetailGate', () => {
  test('serializes cold queries globally', async () => {
    const gate = new V2RequestDetailGate({ concurrency: 1, maxQueue: 2, waitTimeoutMs: 1000 })
    const order = []
    let releaseFirst
    const first = gate.run(
      () =>
        new Promise((resolve) => {
          order.push('first-start')
          releaseFirst = () => {
            order.push('first-end')
            resolve()
          }
        })
    )
    const second = gate.run(async () => {
      order.push('second-start')
    })

    await Promise.resolve()
    expect(order).toEqual(['first-start'])
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['first-start', 'first-end', 'second-start'])
  })

  test('rejects a full queue with the stable busy error', async () => {
    const gate = new V2RequestDetailGate({ concurrency: 1, maxQueue: 1, waitTimeoutMs: 1000 })
    const release = await gate.acquire()
    const queued = gate.acquire()
    await expect(gate.acquire()).rejects.toBeInstanceOf(V2RequestDetailBusyError)
    release()
    const releaseQueued = await queued
    releaseQueued()
  })

  test('releases capacity after task failure', async () => {
    const gate = new V2RequestDetailGate({ concurrency: 1, maxQueue: 1, waitTimeoutMs: 100 })
    await expect(
      gate.run(async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    await expect(gate.run(async () => 'ok')).resolves.toBe('ok')
  })
})
