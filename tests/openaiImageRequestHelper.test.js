const { PassThrough } = require('stream')
const FormData = require('form-data')
const fs = require('fs')
const os = require('os')
const path = require('path')

jest.mock('../src/utils/logger', () => ({
  warn: jest.fn(),
  debug: jest.fn()
}))

const {
  OpenAIImageSSEObserver,
  cleanupStaleTempDirectories,
  createImageStreamKeepAlive,
  prepareOpenAIImageRequest
} = require('../src/utils/openaiImageRequestHelper')

function createKeepAliveResponse() {
  return {
    statusCode: 0,
    headers: {},
    headersSent: false,
    destroyed: false,
    writableEnded: false,
    writableNeedDrain: false,
    chunks: [],
    setHeader: jest.fn(function (key, value) {
      this.headers[key] = value
    }),
    flushHeaders: jest.fn(function () {
      this.headersSent = true
    }),
    flush: jest.fn(),
    write: jest.fn(function (chunk) {
      this.headersSent = true
      this.chunks.push(String(chunk))
      return true
    }),
    end: jest.fn(function () {
      this.writableEnded = true
    })
  }
}

function createPngBuffer() {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('test-image')
  ])
}

describe('openaiImageRequestHelper', () => {
  const originalRequestMaxSize = process.env.REQUEST_MAX_SIZE_MB

  afterEach(() => {
    if (originalRequestMaxSize === undefined) {
      delete process.env.REQUEST_MAX_SIZE_MB
    } else {
      process.env.REQUEST_MAX_SIZE_MB = originalRequestMaxSize
    }
  })

  test('preserves JSON generation fields and removes false stream', async () => {
    const result = await prepareOpenAIImageRequest(
      {
        headers: { 'content-type': 'application/json' },
        body: {
          model: 'gpt-image-2',
          prompt: 'A lighthouse',
          stream: false,
          size: '1024x1024',
          extra: { preserve: true }
        }
      },
      { endpoint: 'generations' }
    )

    expect(result.body).toEqual({
      model: 'gpt-image-2',
      prompt: 'A lighthouse',
      size: '1024x1024',
      extra: { preserve: true }
    })
    expect(result.stream).toBe(false)
  })

  test('converts multipart edit images to data URLs and keeps a metadata-only snapshot', async () => {
    const form = new FormData()
    form.append('model', 'gpt-image-2')
    form.append('prompt', 'Replace the sky')
    form.append('n', '2')
    form.append('image[]', createPngBuffer(), {
      filename: 'source.png',
      contentType: 'image/png'
    })
    const request = new PassThrough()
    request.headers = { ...form.getHeaders(), 'content-length': String(form.getLengthSync()) }

    const preparedPromise = prepareOpenAIImageRequest(request, { endpoint: 'edits' })
    request.end(form.getBuffer())
    const result = await preparedPromise

    expect(result.body.model).toBe('gpt-image-2')
    expect(result.body.prompt).toBe('Replace the sky')
    expect(result.body.n).toBe(2)
    expect(result.body.images[0].image_url).toMatch(/^data:image\/png;base64,/)
    expect(result.requestSnapshot).toEqual(
      expect.objectContaining({
        _multipart: true,
        files: [expect.objectContaining({ field: 'image[]', mime: 'image/png' })]
      })
    )
    expect(JSON.stringify(result.requestSnapshot)).not.toContain('base64')
    expect(request.listenerCount('error')).toBe(0)
    await result.cleanup()
  })

  test('rejects a multipart request stream error and removes request listeners', async () => {
    const form = new FormData()
    form.append('model', 'gpt-image-2')
    form.append('prompt', 'Replace the sky')
    form.append('image', createPngBuffer(), {
      filename: 'source.png',
      contentType: 'image/png'
    })
    const request = new PassThrough()
    request.headers = form.getHeaders()

    const preparedPromise = prepareOpenAIImageRequest(request, { endpoint: 'edits' })
    request.write(form.getBuffer().subarray(0, 32))
    request.destroy(new Error('socket reset'))

    await expect(preparedPromise).rejects.toMatchObject({
      statusCode: 400,
      code: 'upload_error'
    })
    expect(request.listenerCount('error')).toBe(0)
  })

  test('rejects a declared MIME type that does not match file bytes', async () => {
    const form = new FormData()
    form.append('model', 'gpt-image-2')
    form.append('prompt', 'Replace the sky')
    form.append('image', createPngBuffer(), {
      filename: 'source.jpg',
      contentType: 'image/jpeg'
    })
    const request = new PassThrough()
    request.headers = { ...form.getHeaders(), 'content-length': String(form.getLengthSync()) }

    const preparedPromise = prepareOpenAIImageRequest(request, { endpoint: 'edits' })
    request.end(form.getBuffer())
    await expect(preparedPromise).rejects.toMatchObject({
      statusCode: 400,
      code: 'invalid_image_data'
    })
  })

  test('sanitizes JSON edit data URLs in the request snapshot', async () => {
    const dataUrl = `data:image/png;base64,${'A'.repeat(256)}`
    const result = await prepareOpenAIImageRequest(
      {
        headers: { 'content-type': 'application/json' },
        body: {
          model: 'gpt-image-2',
          prompt: 'Replace the sky',
          images: [{ image_url: dataUrl }]
        }
      },
      { endpoint: 'edits' }
    )

    expect(result.body.images[0].image_url).toBe(dataUrl)
    expect(result.requestSnapshot.images[0].image_url).toBe(
      `[image data omitted, ${dataUrl.length} chars]`
    )
  })

  test('enforces the aggregate request limit even without Content-Length', async () => {
    process.env.REQUEST_MAX_SIZE_MB = '1'
    const form = new FormData()
    form.append('model', 'gpt-image-2')
    form.append('prompt', 'Replace the sky')
    form.append('image', Buffer.concat([createPngBuffer(), Buffer.alloc(1024 * 1024)]), {
      filename: 'large.png',
      contentType: 'image/png'
    })
    const request = new PassThrough()
    request.headers = form.getHeaders()

    const preparedPromise = prepareOpenAIImageRequest(request, { endpoint: 'edits' })
    request.end(form.getBuffer())

    await expect(preparedPromise).rejects.toMatchObject({
      statusCode: 413,
      code: 'payload_too_large'
    })
  })

  test('cleans only stale image temp directories', async () => {
    const staleDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'claude-relay-openai-images-stale-test-')
    )
    const freshDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'claude-relay-openai-images-fresh-test-')
    )
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000)
    await fs.promises.utimes(staleDir, oldTime, oldTime)

    try {
      await cleanupStaleTempDirectories()
      await expect(fs.promises.stat(staleDir)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(fs.promises.stat(freshDir)).resolves.toBeDefined()
    } finally {
      await fs.promises.rm(staleDir, { recursive: true, force: true })
      await fs.promises.rm(freshDir, { recursive: true, force: true })
    }
  })

  test('extracts usage only from a completed SSE event across chunks', () => {
    const observer = new OpenAIImageSSEObserver({
      maxEventBytes: 1024 * 1024,
      maxStreamBytes: 2 * 1024 * 1024
    })
    expect(
      observer.feed(
        'event: image_generation.partial_image\ndata: {"type":"image_generation.partial_image","b64_json":"AAAA"}\n\n'
      )
    ).toEqual([])
    expect(
      observer.feed(
        'event: image_generation.completed\ndata: {"type":"image_generation.completed","b64_json":"BBBB",'
      )
    ).toEqual([])
    expect(observer.feed('"usage":{"input_tokens":4,"output_tokens":6}}\n\n')).toEqual([
      expect.objectContaining({
        type: 'image_generation.completed',
        usage: { input_tokens: 4, output_tokens: 6 }
      })
    ])
  })

  test('handles UTF-8 and CRLF boundaries split across SSE chunks', () => {
    const observer = new OpenAIImageSSEObserver()
    const event = Buffer.from(
      'event: image_generation.completed\r\ndata: {"type":"image_generation.completed","revised_prompt":"灯塔","usage":{"input_tokens":2,"output_tokens":3}}\r\n\r\n'
    )
    const splitAt = event.indexOf(Buffer.from('塔')) + 1

    expect(observer.feed(event.subarray(0, splitAt))).toEqual([])
    expect(observer.feed(event.subarray(splitAt))).toEqual([
      expect.objectContaining({ usage: { input_tokens: 2, output_tokens: 3 } })
    ])
  })

  test('finds a completed type in a bounded event tail when the event header is absent', () => {
    const observer = new OpenAIImageSSEObserver({
      maxEventBytes: 32 * 1024,
      maxStreamBytes: 64 * 1024
    })
    const largeImage = 'A'.repeat(12 * 1024)
    const event =
      `data: {"b64_json":"${largeImage}",` +
      '"type":"image_generation.completed","usage":{"input_tokens":7,"output_tokens":9}}\n\n'

    expect(observer.feed(event)).toEqual([
      expect.objectContaining({
        type: 'image_generation.completed',
        usage: { input_tokens: 7, output_tokens: 9 }
      })
    ])
  })

  test('bounds individual SSE events and the total image stream', () => {
    const eventObserver = new OpenAIImageSSEObserver({
      maxEventBytes: 32,
      maxStreamBytes: 1024
    })
    expect(() =>
      eventObserver.feed('data: {"type":"image_generation.partial_image","b64_json":"AAAA"}\n\n')
    ).toThrow(expect.objectContaining({ code: 'event_too_large' }))

    const streamObserver = new OpenAIImageSSEObserver({
      maxEventBytes: 1024,
      maxStreamBytes: 16
    })
    expect(() => streamObserver.feed('12345678901234567')).toThrow(
      expect.objectContaining({ code: 'stream_too_large' })
    )
  })
})

describe('createImageStreamKeepAlive', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test('establishes exact SSE headers after the delay and sends periodic comments', () => {
    const res = createKeepAliveResponse()
    const keepAlive = createImageStreamKeepAlive({ res, delayMs: 20000, intervalMs: 15000 })

    keepAlive.armEarlyStart()
    jest.advanceTimersByTime(19999)
    expect(res.chunks).toEqual([])

    jest.advanceTimersByTime(1)
    expect(res.statusCode).toBe(200)
    expect(res.headers).toEqual({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
    expect(res.chunks).toEqual([': connected\n\n'])
    expect(keepAlive.isEstablished()).toBe(true)
    expect(keepAlive.wasEstablishedEarly()).toBe(true)

    jest.advanceTimersByTime(15000)
    expect(res.chunks).toEqual([': connected\n\n', ': keep-alive\n\n'])

    keepAlive.stop()
    keepAlive.stop()
    jest.advanceTimersByTime(30000)
    expect(res.chunks).toHaveLength(2)
  })

  test.each(['\n\n', '\r\n\r\n', '\r\n\n', '\n\r\n'])(
    'recognizes the %p SSE event boundary',
    (boundary) => {
      const res = createKeepAliveResponse()
      const keepAlive = createImageStreamKeepAlive({ res, intervalMs: 100 })
      keepAlive.onClassicSseEstablished()
      keepAlive.noteBytesWritten(`data: {}${boundary}`)

      jest.advanceTimersByTime(100)

      expect(res.chunks).toEqual([': keep-alive\n\n'])
      keepAlive.stop()
    }
  )

  test('does not insert a heartbeat into an event split across chunks', () => {
    const res = createKeepAliveResponse()
    const keepAlive = createImageStreamKeepAlive({ res, intervalMs: 100 })
    keepAlive.onClassicSseEstablished()

    keepAlive.noteBytesWritten('data: {"b64_json":"AAAA')
    jest.advanceTimersByTime(100)
    expect(res.chunks).toEqual([])

    keepAlive.noteBytesWritten('"}\r')
    jest.advanceTimersByTime(100)
    expect(res.chunks).toEqual([])

    keepAlive.noteBytesWritten('\n\r\n')
    jest.advanceTimersByTime(100)
    expect(res.chunks).toEqual([': keep-alive\n\n'])
    keepAlive.stop()
  })

  test('skips heartbeats while the downstream needs drain or is closed', () => {
    const res = createKeepAliveResponse()
    const keepAlive = createImageStreamKeepAlive({ res, intervalMs: 100 })
    keepAlive.onClassicSseEstablished()

    res.writableNeedDrain = true
    jest.advanceTimersByTime(100)
    expect(res.chunks).toEqual([])

    res.writableNeedDrain = false
    res.destroyed = true
    jest.advanceTimersByTime(100)
    expect(res.chunks).toEqual([])
    keepAlive.stop()
  })

  test('ends with a structured error only at a clean event boundary', () => {
    const res = createKeepAliveResponse()
    const keepAlive = createImageStreamKeepAlive({ res })
    keepAlive.onClassicSseEstablished()

    expect(
      keepAlive.endWithErrorEvent({
        error: { message: 'Rate limit exceeded', type: 'rate_limit_error', code: 'rate_limit' }
      })
    ).toBe(true)
    expect(res.chunks).toEqual([
      'event: error\ndata: {"error":{"message":"Rate limit exceeded","type":"rate_limit_error","code":"rate_limit"}}\n\n'
    ])
    expect(res.end).toHaveBeenCalledTimes(1)
  })

  test('ends a partial event without appending bytes', () => {
    const res = createKeepAliveResponse()
    const keepAlive = createImageStreamKeepAlive({ res })
    keepAlive.onClassicSseEstablished()
    keepAlive.noteBytesWritten('data: {"b64_json":"AAAA')

    expect(
      keepAlive.endAfterPartialEvent({
        requestId: 'request-1',
        endpoint: 'generations',
        phase: 'upstream_error'
      })
    ).toBe(true)
    expect(res.chunks).toEqual([])
    expect(res.end).toHaveBeenCalledTimes(1)
  })
})
