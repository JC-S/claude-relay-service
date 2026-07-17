class V2RequestDetailBusyError extends Error {
  constructor(message = 'V2 request detail query is busy') {
    super(message)
    this.name = 'V2RequestDetailBusyError'
    this.code = 'V2_REQUEST_DETAILS_BUSY'
    this.retryAfterSeconds = 2
  }
}

class V2RequestDetailGate {
  constructor({ concurrency = 1, maxQueue = 8, waitTimeoutMs = 3000 } = {}) {
    this.concurrency = concurrency
    this.maxQueue = maxQueue
    this.waitTimeoutMs = waitTimeoutMs
    this.active = 0
    this.queue = []
  }

  async run(task) {
    const release = await this.acquire()
    try {
      return await task()
    } finally {
      release()
    }
  }

  acquire() {
    if (this.active < this.concurrency) {
      this.active += 1
      return Promise.resolve(this._makeRelease())
    }
    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(new V2RequestDetailBusyError())
    }

    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.queue.indexOf(entry)
          if (index !== -1) {
            this.queue.splice(index, 1)
          }
          reject(new V2RequestDetailBusyError())
        }, this.waitTimeoutMs)
      }
      this.queue.push(entry)
    })
  }

  _makeRelease() {
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      const next = this.queue.shift()
      if (next) {
        clearTimeout(next.timer)
        next.resolve(this._makeRelease())
        return
      }
      this.active = Math.max(0, this.active - 1)
    }
  }
}

module.exports = {
  V2RequestDetailBusyError,
  V2RequestDetailGate,
  v2RequestDetailGate: new V2RequestDetailGate()
}
