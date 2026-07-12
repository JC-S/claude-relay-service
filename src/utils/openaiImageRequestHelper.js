const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { StringDecoder } = require('string_decoder')
const Busboy = require('busboy')
const logger = require('./logger')
const { sanitizeImageData } = require('./requestDetailHelper')

const IMAGE_MODEL = 'gpt-image-2'
const TEMP_DIR_PREFIX = 'claude-relay-openai-images-'
const STALE_TEMP_DIR_AGE_MS = 24 * 60 * 60 * 1000
const DEFAULT_MAX_REQUEST_BYTES = 100 * 1024 * 1024
const MAX_FILE_BYTES = 50 * 1024 * 1024
const MAX_IMAGE_FILES = 16
const MAX_TOTAL_FILES = MAX_IMAGE_FILES + 1
const MAX_FIELDS = 64
const MAX_FIELD_BYTES = 1024 * 1024
const MAX_PARTS = MAX_TOTAL_FILES + MAX_FIELDS
const MAX_UPSTREAM_BODY_BYTES = 140 * 1024 * 1024
const MAX_UPSTREAM_RESPONSE_BYTES = 200 * 1024 * 1024
const MAX_SSE_EVENT_BYTES = 100 * 1024 * 1024
const MAX_SSE_STREAM_BYTES = 200 * 1024 * 1024
const INTEGER_FIELDS = new Set(['n', 'output_compression', 'partial_images'])
const INTERNAL_FIELDS = new Set(['store', 'prompt_cache_key'])
const ALLOWED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

let staleCleanupPromise = null

class OpenAIImageRequestError extends Error {
  constructor(message, statusCode = 400, code = 'invalid_request') {
    super(message)
    this.name = 'OpenAIImageRequestError'
    this.statusCode = statusCode
    this.type = statusCode >= 500 ? 'server_error' : 'invalid_request_error'
    this.code = code
  }
}

function getMaxRequestBytes() {
  const configuredMb = Number.parseInt(process.env.REQUEST_MAX_SIZE_MB || '100', 10)
  if (!Number.isFinite(configuredMb) || configuredMb <= 0) {
    return DEFAULT_MAX_REQUEST_BYTES
  }
  return configuredMb * 1024 * 1024
}

function isMultipartRequest(req) {
  return /^multipart\/form-data\s*(?:;|$)/i.test(String(req?.headers?.['content-type'] || ''))
}

function isJsonRequest(req) {
  const contentType = String(req?.headers?.['content-type'] || '').toLowerCase()
  return !contentType || contentType.includes('application/json') || contentType.includes('+json')
}

function createRequestError(message, statusCode = 400, code = 'invalid_request') {
  return new OpenAIImageRequestError(message, statusCode, code)
}

function normalizeMimeType(value) {
  const normalized = String(value || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase()
  return normalized === 'image/jpg' ? 'image/jpeg' : normalized
}

function detectImageMimeType(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    return null
  }
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png'
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

function parseIntegerField(name, value) {
  const normalized = String(value || '').trim()
  if (!/^-?\d+$/.test(normalized)) {
    throw createRequestError(`${name} must be an integer`, 400, 'invalid_integer')
  }
  const parsed = Number(normalized)
  if (!Number.isSafeInteger(parsed)) {
    throw createRequestError(
      `${name} is outside the supported integer range`,
      400,
      'invalid_integer'
    )
  }
  return parsed
}

function setMultipartField(target, name, values) {
  if (!name || name === 'model' || name === 'stream' || values.length === 0) {
    return
  }

  const mappedName =
    name === 'mask[file_id]' ? 'mask.file_id' : name === 'mask[image_url]' ? 'mask.image_url' : name
  const normalizedValues = values.map((value) =>
    INTEGER_FIELDS.has(name) ? parseIntegerField(name, value) : String(value).trim()
  )
  const normalizedValue = normalizedValues.length === 1 ? normalizedValues[0] : normalizedValues

  if (mappedName === 'mask.file_id') {
    target.mask = { ...(target.mask || {}), file_id: normalizedValue }
  } else if (mappedName === 'mask.image_url') {
    target.mask = { ...(target.mask || {}), image_url: normalizedValue }
  } else if (!INTERNAL_FIELDS.has(mappedName)) {
    target[mappedName] = normalizedValue
  }
}

function normalizeJsonPayload(body, { endpoint }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw createRequestError('A JSON request body is required')
  }

  const payload = { ...body, model: IMAGE_MODEL }
  for (const field of INTERNAL_FIELDS) {
    delete payload[field]
  }
  if (body.stream === true) {
    payload.stream = true
  } else {
    delete payload.stream
  }

  validateImagePayload(payload, { endpoint, requestedModel: body.model })
  return {
    body: payload,
    stream: payload.stream === true,
    requestSnapshot: sanitizeImageData(body),
    cleanup: async () => {}
  }
}

function validateImagePayload(payload, { endpoint, requestedModel = payload?.model }) {
  if (requestedModel !== IMAGE_MODEL) {
    throw createRequestError(
      `Only ${IMAGE_MODEL} is supported by this endpoint`,
      400,
      'model_not_supported'
    )
  }
  if (typeof payload.prompt !== 'string' || !payload.prompt.trim()) {
    throw createRequestError('Prompt is required', 400, 'invalid_prompt')
  }
  payload.prompt = payload.prompt.trim()

  if (endpoint === 'edits') {
    const images = Array.isArray(payload.images) ? payload.images : []
    const hasSourceImage = images.some(
      (image) =>
        image &&
        typeof image === 'object' &&
        ((typeof image.image_url === 'string' && image.image_url.trim()) ||
          (typeof image.file_id === 'string' && image.file_id.trim()))
    )
    if (!hasSourceImage) {
      throw createRequestError(
        'At least one source image is required for image edits',
        400,
        'image_required'
      )
    }
  }
}

async function cleanupStaleTempDirectories() {
  const tmpRoot = os.tmpdir()
  const now = Date.now()
  let entries = []
  try {
    entries = await fs.promises.readdir(tmpRoot, { withFileTypes: true })
  } catch (error) {
    logger.debug(`Failed to scan stale OpenAI image temp directories: ${error.message}`)
    return
  }

  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(TEMP_DIR_PREFIX))
      .map(async (entry) => {
        const target = path.join(tmpRoot, entry.name)
        try {
          const stat = await fs.promises.stat(target)
          if (now - stat.mtimeMs >= STALE_TEMP_DIR_AGE_MS) {
            await fs.promises.rm(target, { recursive: true, force: true })
          }
        } catch (error) {
          logger.debug(`Failed to clean stale OpenAI image temp directory: ${error.message}`)
        }
      })
  )
}

function ensureStaleCleanupStarted() {
  if (!staleCleanupPromise) {
    staleCleanupPromise = cleanupStaleTempDirectories().catch(() => {})
  }
  return staleCleanupPromise
}

async function fileToDataUrl(file) {
  const buffer = await fs.promises.readFile(file.path)
  const detectedMime = detectImageMimeType(buffer)
  const declaredMime = normalizeMimeType(file.mimeType)
  if (!ALLOWED_IMAGE_MIME_TYPES.has(declaredMime)) {
    throw createRequestError(
      `Unsupported image MIME type for ${file.fieldName}`,
      400,
      'unsupported_image_type'
    )
  }
  if (!detectedMime || detectedMime !== declaredMime) {
    throw createRequestError(
      `Image content does not match its declared MIME type for ${file.fieldName}`,
      400,
      'invalid_image_data'
    )
  }
  return `data:${detectedMime};base64,${buffer.toString('base64')}`
}

async function parseMultipartEditRequest(req) {
  const maxRequestBytes = getMaxRequestBytes()
  const contentLength = Number.parseInt(req.headers['content-length'] || '0', 10)
  if (Number.isFinite(contentLength) && contentLength > maxRequestBytes) {
    throw createRequestError(
      'Request body exceeds the configured size limit',
      413,
      'payload_too_large'
    )
  }

  let setupError = null
  const onSetupError = () => {
    setupError = createRequestError('Request upload failed', 400, 'upload_error')
  }
  const onSetupAborted = () => {
    setupError = createRequestError('Request upload was aborted', 400, 'upload_aborted')
  }
  req.once('error', onSetupError)
  req.once('aborted', onSetupAborted)

  let tempDir
  try {
    await ensureStaleCleanupStarted()
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), TEMP_DIR_PREFIX))
  } finally {
    req.removeListener('error', onSetupError)
    req.removeListener('aborted', onSetupAborted)
  }

  let cleaned = false
  const cleanup = async () => {
    if (cleaned) {
      return
    }
    cleaned = true
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }

  if (setupError) {
    await cleanup()
    throw setupError
  }

  try {
    const parsed = await new Promise((resolve, reject) => {
      let busboy
      try {
        busboy = Busboy({
          headers: req.headers,
          limits: {
            fileSize: MAX_FILE_BYTES,
            files: MAX_TOTAL_FILES,
            fields: MAX_FIELDS,
            fieldSize: MAX_FIELD_BYTES,
            parts: MAX_PARTS
          }
        })
      } catch (error) {
        reject(createRequestError(`Invalid multipart request: ${error.message}`))
        return
      }

      const fields = new Map()
      const files = []
      const fileWrites = []
      let totalBytes = 0
      let settled = false

      const removeRequestListeners = () => {
        req.removeListener('data', onData)
        req.removeListener('end', onEnd)
        req.removeListener('aborted', onAborted)
        req.removeListener('error', onRequestError)
      }

      const finishWithError = (error) => {
        if (settled) {
          return
        }
        settled = true
        req.pause()
        removeRequestListeners()
        try {
          busboy.destroy(error)
        } catch (_) {
          // Busboy may already be closed after a limit event.
        }
        req.resume()
        reject(error)
      }

      const onAborted = () =>
        finishWithError(createRequestError('Request upload was aborted', 400, 'upload_aborted'))
      const onRequestError = () =>
        finishWithError(createRequestError('Request upload failed', 400, 'upload_error'))
      const onData = (chunk) => {
        totalBytes += chunk.length
        if (totalBytes > maxRequestBytes) {
          finishWithError(
            createRequestError(
              'Request body exceeds the configured size limit',
              413,
              'payload_too_large'
            )
          )
          return
        }
        if (!busboy.write(chunk)) {
          req.pause()
          busboy.once('drain', () => {
            if (!settled) {
              req.resume()
            }
          })
        }
      }
      const onEnd = () => {
        if (!settled) {
          busboy.end()
        }
      }

      busboy.on('field', (name, value, info) => {
        if (info?.valueTruncated) {
          finishWithError(
            createRequestError(`Multipart field ${name} is too large`, 413, 'field_too_large')
          )
          return
        }
        const values = fields.get(name) || []
        values.push(value)
        fields.set(name, values)
      })

      busboy.on('file', (fieldName, stream, info) => {
        if (!['image', 'image[]', 'mask'].includes(fieldName)) {
          stream.resume()
          finishWithError(
            createRequestError(
              `Unsupported multipart file field: ${fieldName}`,
              400,
              'invalid_file_field'
            )
          )
          return
        }

        const filePath = path.join(tempDir, crypto.randomUUID())
        const file = {
          fieldName,
          filename: info?.filename || '',
          mimeType: info?.mimeType || '',
          path: filePath,
          size: 0
        }
        files.push(file)
        const output = fs.createWriteStream(filePath, { flags: 'wx' })
        const writePromise = new Promise((resolveWrite, rejectWrite) => {
          stream.on('data', (chunk) => {
            file.size += chunk.length
          })
          stream.once('limit', () => {
            rejectWrite(
              createRequestError(
                `Uploaded file ${file.filename || fieldName} exceeds the 50MB limit`,
                413,
                'file_too_large'
              )
            )
          })
          stream.once('error', rejectWrite)
          output.once('error', rejectWrite)
          output.once('finish', resolveWrite)
        })
        writePromise.catch((error) => finishWithError(error))
        fileWrites.push(writePromise)
        stream.pipe(output)
      })

      busboy.once('filesLimit', () =>
        finishWithError(createRequestError('Too many uploaded image files', 413, 'too_many_files'))
      )
      busboy.once('fieldsLimit', () =>
        finishWithError(createRequestError('Too many multipart fields', 413, 'too_many_fields'))
      )
      busboy.once('partsLimit', () =>
        finishWithError(createRequestError('Too many multipart parts', 413, 'too_many_parts'))
      )
      busboy.once('error', (error) => {
        if (!settled) {
          finishWithError(
            error instanceof OpenAIImageRequestError
              ? error
              : createRequestError(`Invalid multipart request: ${error.message}`)
          )
        }
      })
      busboy.once('close', async () => {
        if (settled) {
          return
        }
        try {
          await Promise.all(fileWrites)
          settled = true
          removeRequestListeners()
          resolve({ fields, files, totalBytes })
        } catch (error) {
          finishWithError(
            error instanceof OpenAIImageRequestError
              ? error
              : createRequestError(
                  `Failed to store uploaded image: ${error.message}`,
                  500,
                  'upload_failed'
                )
          )
        }
      })

      req.on('data', onData)
      req.once('end', onEnd)
      req.once('aborted', onAborted)
      req.once('error', onRequestError)
    })

    const imageArrayFiles = parsed.files.filter((file) => file.fieldName === 'image[]')
    const imageFiles = imageArrayFiles.length
      ? imageArrayFiles
      : parsed.files.filter((file) => file.fieldName === 'image')
    const maskFiles = parsed.files.filter((file) => file.fieldName === 'mask')
    if (imageFiles.length === 0) {
      throw createRequestError(
        'At least one source image is required for image edits',
        400,
        'image_required'
      )
    }
    if (imageFiles.length > MAX_IMAGE_FILES || maskFiles.length > 1) {
      throw createRequestError('Too many uploaded image files', 413, 'too_many_files')
    }

    const payload = { model: IMAGE_MODEL }
    for (const [name, values] of parsed.fields.entries()) {
      setMultipartField(payload, name, values)
    }
    const requestedModel = parsed.fields.get('model')?.[0]
    const streamValue = String(parsed.fields.get('stream')?.[0] || '')
      .trim()
      .toLowerCase()
    if (streamValue === 'true') {
      payload.stream = true
    }

    payload.images = []
    for (const file of imageFiles) {
      payload.images.push({ image_url: await fileToDataUrl(file) })
    }
    if (maskFiles[0]) {
      payload.mask = { ...(payload.mask || {}), image_url: await fileToDataUrl(maskFiles[0]) }
    }

    validateImagePayload(payload, { endpoint: 'edits', requestedModel })

    const serializedBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8')
    if (serializedBytes > MAX_UPSTREAM_BODY_BYTES) {
      throw createRequestError(
        'Converted image request exceeds the upstream body size limit',
        413,
        'payload_too_large'
      )
    }

    const requestSnapshot = {
      _multipart: true,
      files: parsed.files.map((file) => ({
        field: file.fieldName,
        mime: normalizeMimeType(file.mimeType),
        size: file.size
      })),
      fields: sanitizeImageData(Object.fromEntries(parsed.fields))
    }

    return {
      body: payload,
      stream: payload.stream === true,
      requestSnapshot,
      cleanup
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}

async function prepareOpenAIImageRequest(req, { endpoint }) {
  if (!['generations', 'edits'].includes(endpoint)) {
    throw createRequestError('Unsupported image endpoint', 404, 'not_found')
  }

  if (endpoint === 'edits' && isMultipartRequest(req)) {
    return parseMultipartEditRequest(req)
  }
  if (!isJsonRequest(req)) {
    throw createRequestError(
      endpoint === 'generations'
        ? 'Image generations require an application/json request body'
        : 'Image edits require application/json or multipart/form-data',
      415,
      'unsupported_media_type'
    )
  }
  return normalizeJsonPayload(req.body, { endpoint })
}

function sanitizeCompletedImageEventData(dataText) {
  if (typeof dataText !== 'string') {
    return ''
  }
  return dataText
    .replace(/("b64_json"\s*:\s*")[^"]*(")/gi, '$1[image data omitted]$2')
    .replace(
      /("image_url"\s*:\s*")data:image\/[a-z0-9.+-]+;base64,[^"]*(")/gi,
      '$1[image data omitted]$2'
    )
}

class OpenAIImageSSEObserver {
  constructor({ maxEventBytes = MAX_SSE_EVENT_BYTES, maxStreamBytes = MAX_SSE_STREAM_BYTES } = {}) {
    this.maxEventBytes = maxEventBytes
    this.maxStreamBytes = maxStreamBytes
    this.totalBytes = 0
    this.buffer = ''
    this.bufferBytes = 0
    this.decoder = new StringDecoder('utf8')
    this.pendingCarriageReturn = false
  }

  normalizeDecodedChunk(value, final = false) {
    let decoded = value
    if (this.pendingCarriageReturn) {
      decoded = `\r${decoded}`
      this.pendingCarriageReturn = false
    }
    if (!final && decoded.endsWith('\r')) {
      decoded = decoded.slice(0, -1)
      this.pendingCarriageReturn = true
    }
    return decoded.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  }

  feed(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    this.totalBytes += buffer.length
    if (this.totalBytes > this.maxStreamBytes) {
      throw createRequestError(
        'Upstream image stream exceeded the size limit',
        502,
        'stream_too_large'
      )
    }

    const decoded = this.normalizeDecodedChunk(this.decoder.write(buffer))
    this.buffer += decoded
    this.bufferBytes += Buffer.byteLength(decoded, 'utf8')
    if (this.bufferBytes > this.maxEventBytes && !this.buffer.includes('\n\n')) {
      throw createRequestError(
        'Upstream image event exceeded the size limit',
        502,
        'event_too_large'
      )
    }

    const completed = []
    let boundary
    while ((boundary = this.buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = this.buffer.slice(0, boundary)
      this.buffer = this.buffer.slice(boundary + 2)
      const rawEventBytes = Buffer.byteLength(rawEvent, 'utf8')
      if (rawEventBytes > this.maxEventBytes) {
        throw createRequestError(
          'Upstream image event exceeded the size limit',
          502,
          'event_too_large'
        )
      }
      const parsed = this.parseEvent(rawEvent)
      if (parsed) {
        completed.push(parsed)
      }
      this.bufferBytes = Buffer.byteLength(this.buffer, 'utf8')
    }
    if (this.bufferBytes > this.maxEventBytes) {
      throw createRequestError(
        'Upstream image event exceeded the size limit',
        502,
        'event_too_large'
      )
    }
    return completed
  }

  finish() {
    this.buffer += this.normalizeDecodedChunk(this.decoder.end(), true)
    this.bufferBytes = Buffer.byteLength(this.buffer, 'utf8')
    if (!this.buffer.trim()) {
      this.buffer = ''
      this.bufferBytes = 0
      return []
    }
    const remaining = this.buffer
    this.buffer = ''
    this.bufferBytes = 0
    if (Buffer.byteLength(remaining, 'utf8') > this.maxEventBytes) {
      throw createRequestError(
        'Upstream image event exceeded the size limit',
        502,
        'event_too_large'
      )
    }
    const parsed = this.parseEvent(remaining)
    return parsed ? [parsed] : []
  }

  parseEvent(rawEvent) {
    const eventPreview = rawEvent.slice(0, 8192)
    const eventName = eventPreview.match(/(?:^|\n)event:\s*([^\n]+)/)?.[1]?.trim() || ''
    const typeMatch = eventPreview.match(/"type"\s*:\s*"([^"]+)"/)
    let type = typeMatch?.[1] || eventName
    if (!type.endsWith('.completed') && !eventName && rawEvent.length > eventPreview.length) {
      const eventTail = rawEvent.slice(-8192)
      type = eventTail.match(/"type"\s*:\s*"([^"]+\.completed)"/)?.[1] || type
    }
    if (!type.endsWith('.completed')) {
      return null
    }

    const lines = rawEvent.split('\n')
    const dataText = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n')
    if (!dataText || dataText === '[DONE]') {
      return null
    }

    try {
      const data = JSON.parse(sanitizeCompletedImageEventData(dataText))
      const usage = data?.usage || data?.response?.usage || null
      return usage
        ? { type: data.type || type, usage, model: data.model || data.response?.model || null }
        : null
    } catch (error) {
      logger.warn(`Failed to parse completed OpenAI image SSE event: ${error.message}`)
      return null
    }
  }
}

module.exports = {
  IMAGE_MODEL,
  MAX_UPSTREAM_BODY_BYTES,
  MAX_UPSTREAM_RESPONSE_BYTES,
  MAX_SSE_EVENT_BYTES,
  MAX_SSE_STREAM_BYTES,
  OpenAIImageRequestError,
  OpenAIImageSSEObserver,
  cleanupStaleTempDirectories,
  detectImageMimeType,
  prepareOpenAIImageRequest,
  sanitizeCompletedImageEventData,
  validateImagePayload,
  _resetStaleCleanupForTest: () => {
    staleCleanupPromise = null
  }
}
