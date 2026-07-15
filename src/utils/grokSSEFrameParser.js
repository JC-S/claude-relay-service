class GrokSSEFrameParser {
  constructor() {
    this.buffer = Buffer.alloc(0)
    this.discardingFrame = false
  }

  feed(chunk) {
    if (chunk && chunk.length) {
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, next]) : next
    }

    if (this.discardingFrame) {
      const delimiter = this._findDelimiter(this.buffer)
      if (!delimiter) {
        this.buffer = this.buffer.subarray(Math.max(0, this.buffer.length - 3))
        return []
      }
      this.buffer = this.buffer.subarray(delimiter.index + delimiter.length)
      this.discardingFrame = false
    }

    const frames = []
    while (this.buffer.length) {
      const delimiter = this._findDelimiter(this.buffer)
      if (!delimiter) {
        break
      }
      const raw = this.buffer.subarray(0, delimiter.index + delimiter.length)
      const content = this.buffer.subarray(0, delimiter.index)
      this.buffer = this.buffer.subarray(delimiter.index + delimiter.length)
      frames.push(this._parseFrame(raw, content, delimiter.bytes))
    }
    return frames
  }

  get bufferedBytes() {
    return this.buffer.length
  }

  takeBuffered() {
    const value = this.buffer
    this.buffer = Buffer.alloc(0)
    return value
  }

  peekBuffered() {
    return this.buffer
  }

  discardCurrentFrame() {
    this.discardingFrame = true
    this.buffer = this.buffer.subarray(Math.max(0, this.buffer.length - 3))
  }

  _findDelimiter(buffer) {
    const lfIndex = buffer.indexOf(Buffer.from('\n\n'))
    const crlfIndex = buffer.indexOf(Buffer.from('\r\n\r\n'))
    if (lfIndex === -1 && crlfIndex === -1) {
      return null
    }
    if (crlfIndex !== -1 && (lfIndex === -1 || crlfIndex < lfIndex)) {
      return { index: crlfIndex, length: 4, bytes: Buffer.from('\r\n\r\n') }
    }
    return { index: lfIndex, length: 2, bytes: Buffer.from('\n\n') }
  }

  _parseFrame(raw, content, delimiter) {
    const text = content.toString('utf8')
    let event = ''
    const dataLines = []
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('event:')) {
        event = line.slice(6).trim()
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''))
      }
    }
    const data = dataLines.join('\n')
    let payload = null
    if (data && data !== '[DONE]') {
      try {
        payload = JSON.parse(data)
      } catch {
        payload = null
      }
    }
    const payloadType = typeof payload?.type === 'string' ? payload.type : ''
    return {
      raw,
      content,
      delimiter,
      event,
      data,
      payload,
      type: payloadType || event,
      typeConflict: Boolean(payloadType && event && payloadType !== event)
    }
  }
}

module.exports = GrokSSEFrameParser
