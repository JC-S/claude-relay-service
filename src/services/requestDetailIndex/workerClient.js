const path = require('path')
const { Worker } = require('worker_threads')

class RequestDetailIndexWorkerClient {
  constructor(options = {}) {
    this.workerPath = options.workerPath || path.join(__dirname, 'worker.js')
    this.defaultTimeoutMs = options.defaultTimeoutMs || 3000
    this.worker = null
    this.nextId = 1
    this.pending = new Map()
    this.exitPromise = null
    this.resolveExit = null
  }

  async start(config) {
    if (this.worker) {
      return this.call('status')
    }
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve
    })
    const worker = new Worker(this.workerPath)
    this.worker = worker
    worker.on('message', (message) => this._onMessage(message))
    worker.on('error', (error) => this._failAll(error))
    worker.on('exit', (code) => {
      const error = code === 0 ? null : new Error(`Request detail index Worker exited with ${code}`)
      if (error) {
        this._failAll(error)
      }
      if (this.worker === worker) {
        this.worker = null
      }
      this.resolveExit?.({ code })
    })
    return this.call('init', config, 10000)
  }

  _onMessage(message) {
    const pending = this.pending.get(message.id)
    if (!pending) {
      return
    }
    clearTimeout(pending.timer)
    this.pending.delete(message.id)
    if (message.ok) {
      pending.resolve(message.result)
      return
    }
    const error = new Error(message.error?.message || 'Request detail index Worker error')
    error.code = message.error?.code
    error.stack = message.error?.stack || error.stack
    pending.reject(error)
  }

  _failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  call(operation, payload = {}, timeoutMs = this.defaultTimeoutMs) {
    if (!this.worker) {
      return Promise.reject(new Error('Request detail index Worker is not running'))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        const error = new Error(`Request detail index Worker ${operation} timed out`)
        error.code = 'REQUEST_DETAIL_INDEX_TIMEOUT'
        reject(error)
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, operation })
      this.worker.postMessage({ id, operation, payload })
    })
  }

  async stop(timeoutMs = 3000) {
    const { worker } = this
    if (!worker) {
      return
    }
    try {
      await this.call('close', {}, Math.min(timeoutMs, 2500))
    } catch (_error) {
      // terminate() below guarantees that no stale Worker survives shutdown.
    }
    if (this.worker) {
      await worker.terminate()
    }
    let timeout
    try {
      await Promise.race([
        this.exitPromise,
        new Promise((resolve) => {
          timeout = setTimeout(resolve, timeoutMs)
        })
      ])
    } finally {
      clearTimeout(timeout)
    }
  }
}

module.exports = RequestDetailIndexWorkerClient
