const crypto = require('crypto')
const axios = require('axios')
const config = require('../../config/config')
const redis = require('../models/redis')
const ProxyHelper = require('../utils/proxyHelper')

const SESSION_TTL_SECONDS = 30 * 60

const validateUrl = (rawUrl, { host, allowLoopbackHttp = false }) => {
  const parsed = new URL(rawUrl)
  const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)
  const validProtocol = parsed.protocol === 'https:' || (allowLoopbackHttp && isLoopback)
  if (
    !validProtocol ||
    (allowLoopbackHttp ? !isLoopback : parsed.hostname !== host) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (!allowLoopbackHttp && parsed.port)
  ) {
    throw new Error(`Invalid OAuth URL: ${rawUrl}`)
  }
  return parsed.toString()
}

const getAxiosOptions = (proxy, timeout = 30000) => {
  const options = {
    timeout,
    maxRedirects: 0,
    validateStatus: (status) => status >= 200 && status < 300,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  }
  const agent = ProxyHelper.createProxyAgent(proxy)
  if (agent) {
    options.httpAgent = agent
    options.httpsAgent = agent
    options.proxy = false
  }
  return options
}

const decodeJwtClaims = (token) => {
  if (typeof token !== 'string') {
    return {}
  }
  const parts = token.split('.')
  if (parts.length !== 3) {
    return {}
  }
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    return {}
  }
}

const normalizeTokens = (data, previousRefreshToken = '') => {
  const accessToken = data?.access_token || data?.accessToken || ''
  const refreshToken = data?.refresh_token || data?.refreshToken || previousRefreshToken || ''
  const idToken = data?.id_token || data?.idToken || ''
  const expiresIn = Number(data?.expires_in ?? data?.expiresIn)
  const claims = decodeJwtClaims(idToken || accessToken)
  const claimExpiry = Number(claims.exp)
  const expiresAt =
    Number.isFinite(expiresIn) && expiresIn > 0
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : Number.isFinite(claimExpiry) && claimExpiry > 0
        ? new Date(claimExpiry * 1000).toISOString()
        : ''
  return {
    accessToken,
    refreshToken,
    idToken,
    tokenType: data?.token_type || data?.tokenType || 'Bearer',
    scope: data?.scope || config.grok.oauthScope,
    expiresAt,
    accountInfo: {
      email: claims.email || '',
      subject: claims.sub || '',
      teamId: claims.team_id || claims.teamId || claims.organization_id || '',
      subscriptionTier: claims.subscription_tier || claims.subscriptionTier || claims.plan || '',
      entitlementStatus: claims.entitlement_status || claims.entitlementStatus || ''
    }
  }
}

const parseAuthorizationInput = (input) => {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (!raw) {
    throw new Error('Authorization code is required')
  }
  let params = null
  let requiresState = false
  try {
    const parsed = new URL(raw)
    params = parsed.searchParams
    requiresState = true
  } catch {
    if (raw.startsWith('?') || raw.includes('code=') || raw.includes('&state=')) {
      params = new URLSearchParams(raw.replace(/^\?/, ''))
      requiresState = true
    }
  }
  if (!params) {
    return { code: raw, state: '', requiresState: false }
  }
  const code = params.get('code')?.trim() || ''
  const state = params.get('state')?.trim() || ''
  if (!code) {
    throw new Error('Callback does not contain an authorization code')
  }
  return { code, state, requiresState }
}

const safeStateEqual = (expected, actual) => {
  const left = Buffer.from(String(expected || ''))
  const right = Buffer.from(String(actual || ''))
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right)
}

class GrokOAuthService {
  constructor() {
    this.validateConfiguration()
  }

  validateConfiguration() {
    validateUrl(config.grok.oauthAuthorizeUrl, { host: 'auth.x.ai' })
    validateUrl(config.grok.oauthTokenUrl, { host: 'auth.x.ai' })
    validateUrl(config.grok.oauthRedirectUri, { allowLoopbackHttp: true })
    validateUrl(config.grok.apiBaseUrl, { host: 'api.x.ai' })
    validateUrl(config.grok.cliBaseUrl, { host: 'cli-chat-proxy.grok.com' })
    return true
  }

  async generateAuthorizationSession(proxy = null) {
    const codeVerifier = crypto.randomBytes(64).toString('base64url')
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')
    const state = crypto.randomBytes(32).toString('hex')
    const sessionId = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    await redis.setOAuthSession(
      sessionId,
      {
        platform: 'grok',
        codeVerifier,
        state,
        proxy,
        redirectUri: config.grok.oauthRedirectUri,
        createdAt,
        expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString()
      },
      SESSION_TTL_SECONDS
    )
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.grok.oauthClientId,
      redirect_uri: config.grok.oauthRedirectUri,
      scope: config.grok.oauthScope,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state
    })
    return {
      sessionId,
      authUrl: `${config.grok.oauthAuthorizeUrl}?${params.toString()}`,
      expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString()
    }
  }

  async exchangeCode(sessionId, input) {
    const session = await redis.getOAuthSession(sessionId)
    if (!session || session.platform !== 'grok') {
      throw new Error('Invalid or expired Grok OAuth session')
    }
    if (Date.parse(session.expiresAt || '') <= Date.now()) {
      await redis.deleteOAuthSession(sessionId)
      throw new Error('Grok OAuth session has expired')
    }
    const parsed = parseAuthorizationInput(input)
    if ((parsed.requiresState || parsed.state) && !safeStateEqual(session.state, parsed.state)) {
      throw new Error('OAuth state mismatch')
    }
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: parsed.code,
      redirect_uri: session.redirectUri || config.grok.oauthRedirectUri,
      client_id: config.grok.oauthClientId,
      code_verifier: session.codeVerifier
    })
    const response = await axios.post(
      config.grok.oauthTokenUrl,
      body.toString(),
      getAxiosOptions(session.proxy)
    )
    const tokens = normalizeTokens(response.data)
    if (!tokens.accessToken || !tokens.refreshToken) {
      throw new Error('xAI OAuth token response is incomplete')
    }
    await redis.deleteOAuthSession(sessionId)
    return tokens
  }

  async refreshTokens(refreshToken, proxy = null) {
    if (!refreshToken) {
      throw new Error('Refresh token is required')
    }
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: config.grok.oauthClientId,
      scope: config.grok.oauthScope
    })
    const response = await axios.post(
      config.grok.oauthTokenUrl,
      body.toString(),
      getAxiosOptions(proxy)
    )
    const tokens = normalizeTokens(response.data, refreshToken)
    if (!tokens.accessToken) {
      throw new Error('xAI refresh response did not contain an access token')
    }
    return tokens
  }

  async validateRefreshToken(refreshToken, proxy = null) {
    return await this.refreshTokens(refreshToken, proxy)
  }
}

module.exports = new GrokOAuthService()
module.exports.parseAuthorizationInput = parseAuthorizationInput
module.exports.normalizeTokens = normalizeTokens
