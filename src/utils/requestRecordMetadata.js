const REQUEST_RECORD_METADATA_FIELDS = [
  'clientIp',
  'upstreamRequestId',
  'downstreamHttpStatus',
  'upstreamHttpStatus',
  'upstreamSemanticStatus',
  'terminalType',
  'errorType',
  'errorCode',
  'requestedModel',
  'mappedModel',
  'actualModel',
  'billingModel',
  'firstTokenLatencyMs'
]

function pickRequestRecordMetadata(source = null) {
  if (!source || typeof source !== 'object') {
    return {}
  }

  const metadata = {}
  for (const field of REQUEST_RECORD_METADATA_FIELDS) {
    const value = source[field]
    if (value !== undefined && value !== null && value !== '') {
      metadata[field] = value
    }
  }
  return metadata
}

module.exports = {
  REQUEST_RECORD_METADATA_FIELDS,
  pickRequestRecordMetadata
}
