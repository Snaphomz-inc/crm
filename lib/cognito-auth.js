const AUTH_PARAM_KEYS = [
  'access_token',
  'refresh_token',
  'id_token',
  'expires_at',
  'expires_in',
  'token_type',
  'type',
  'code',
  'state',
  'error',
  'error_description'
]

function getBrowserOrigin() {
  if (typeof window === 'undefined') return ''
  return window.location.origin
}

export function getCognitoConfig() {
  const origin = getBrowserOrigin()
  const redirectDefault = origin ? `${origin}/auth/callback` : ''
  const logoutDefault = origin || ''

  return {
    region: process.env.NEXT_PUBLIC_COGNITO_REGION || '',
    userPoolId: process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID || '',
    clientId: process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID || '',
    domain: process.env.NEXT_PUBLIC_COGNITO_DOMAIN || '',
    redirectUri: process.env.NEXT_PUBLIC_COGNITO_REDIRECT_URI || redirectDefault,
    logoutUri: process.env.NEXT_PUBLIC_COGNITO_LOGOUT_URI || logoutDefault
  }
}

export function getFormattedCognitoDomain(domain, region) {
  if (!domain) return ''
  if (domain.endsWith('amazoncognito.com')) return domain
  if (domain.includes('.')) return domain
  if (!region) return domain
  return `${domain}.auth.${region}.amazoncognito.com`
}

export function isCognitoConfigured(config = getCognitoConfig()) {
  return Boolean(config.region && config.userPoolId && config.clientId && config.domain)
}

export function getStorageKey(clientId = getCognitoConfig().clientId) {
  if (!clientId) return ''
  return `CognitoIdentityServiceProvider.${clientId}.LastAuthResult`
}

export function readStoredAuthTokens(clientId = getCognitoConfig().clientId) {
  if (typeof window === 'undefined') return null
  const key = getStorageKey(clientId)
  if (!key) return null
  const raw = window.localStorage.getItem(key)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed?.idToken && !parsed?.accessToken) return null
    return parsed
  } catch {
    return null
  }
}

export function writeStoredAuthTokens(tokens, clientId = getCognitoConfig().clientId) {
  if (typeof window === 'undefined') return
  const key = getStorageKey(clientId)
  if (!key) return

  const payload = {
    accessToken: tokens?.access_token || tokens?.accessToken || '',
    idToken: tokens?.id_token || tokens?.idToken || '',
    refreshToken: tokens?.refresh_token || tokens?.refreshToken || '',
    expiresIn: Number(tokens?.expires_in || tokens?.expiresIn || 0) || 0,
    tokenType: tokens?.token_type || tokens?.tokenType || 'Bearer',
    clockDrift: 0,
    receivedAt: Date.now()
  }

  window.localStorage.setItem(key, JSON.stringify(payload))
}

export function clearStoredAuthTokens(clientId = getCognitoConfig().clientId) {
  if (typeof window === 'undefined') return
  const key = getStorageKey(clientId)
  if (key) window.localStorage.removeItem(key)

  const prefixes = ['CognitoIdentityServiceProvider', 'aws.amplify']
  const keysToRemove = []
  for (const lsKey of Object.keys(window.localStorage)) {
    if (prefixes.some((p) => lsKey.includes(p))) keysToRemove.push(lsKey)
  }
  keysToRemove.forEach((lsKey) => window.localStorage.removeItem(lsKey))
}

function base64UrlToBase64(input) {
  let value = String(input || '').replace(/-/g, '+').replace(/_/g, '/')
  const pad = value.length % 4
  if (pad) value += '='.repeat(4 - pad)
  return value
}

export function decodeJwtPayload(token) {
  try {
    const parts = String(token || '').split('.')
    if (parts.length !== 3) return null
    const decoded = atob(base64UrlToBase64(parts[1]))
    return JSON.parse(decoded)
  } catch {
    return null
  }
}

export function isJwtExpired(token, leewaySeconds = 60) {
  const decoded = decodeJwtPayload(token)
  if (!decoded?.exp) return false
  const now = Math.floor(Date.now() / 1000)
  return decoded.exp <= now + leewaySeconds
}

function buildHostedAuthParams({ identityProvider, email, prompt, state } = {}) {
  const config = getCognitoConfig()
  const params = new URLSearchParams()

  params.set('client_id', config.clientId)
  params.set('response_type', 'code')
  params.set('scope', 'openid email profile')
  params.set('redirect_uri', config.redirectUri)
  params.set('state', state || '/')

  if (prompt) params.set('prompt', prompt)
  if (email) params.set('login_hint', String(email).trim().toLowerCase())
  if (identityProvider) params.set('identity_provider', identityProvider)

  return params
}

export function buildAuthorizeUrl({ identityProvider, email, prompt, state } = {}) {
  const config = getCognitoConfig()
  const domain = getFormattedCognitoDomain(config.domain, config.region)
  const params = buildHostedAuthParams({ identityProvider, email, prompt, state })
  return `https://${domain}/oauth2/authorize?${params.toString()}`
}

export function buildHostedUiEntryUrl({ mode = 'login', email, state } = {}) {
  const config = getCognitoConfig()
  const domain = getFormattedCognitoDomain(config.domain, config.region)
  const safeMode = String(mode || 'login').toLowerCase() === 'signup' ? 'signup' : 'login'
  const params = buildHostedAuthParams({ email, state, prompt: 'login' })
  return `https://${domain}/${safeMode}?${params.toString()}`
}

export function buildHostedLogoutUrl() {
  const config = getCognitoConfig()
  const domain = getFormattedCognitoDomain(config.domain, config.region)
  const params = new URLSearchParams()

  params.set('client_id', config.clientId)
  params.set('logout_uri', config.logoutUri)

  return `https://${domain}/logout?${params.toString()}`
}

export async function exchangeCodeForTokens(code) {
  const config = getCognitoConfig()
  const domain = getFormattedCognitoDomain(config.domain, config.region)
  const tokenUrl = `https://${domain}/oauth2/token`

  const body = new URLSearchParams()
  body.set('grant_type', 'authorization_code')
  body.set('client_id', config.clientId)
  body.set('code', code)
  body.set('redirect_uri', config.redirectUri)

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(text || `Cognito token exchange failed (${response.status})`)
  }

  return response.json()
}

export async function refreshTokensWithRefreshToken(refreshToken) {
  const config = getCognitoConfig()
  const domain = getFormattedCognitoDomain(config.domain, config.region)
  const tokenUrl = `https://${domain}/oauth2/token`

  const body = new URLSearchParams()
  body.set('grant_type', 'refresh_token')
  body.set('client_id', config.clientId)
  body.set('refresh_token', refreshToken)

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(text || `Cognito refresh failed (${response.status})`)
  }

  return response.json()
}

export function clearAuthParamsFromUrl() {
  if (typeof window === 'undefined') return

  const url = new URL(window.location.href)
  AUTH_PARAM_KEYS.forEach((key) => url.searchParams.delete(key))

  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''))
  AUTH_PARAM_KEYS.forEach((key) => hashParams.delete(key))
  const newHash = hashParams.toString()
  const newSearch = url.searchParams.toString()

  const cleaned = `${url.origin}${url.pathname}${newSearch ? `?${newSearch}` : ''}${newHash ? `#${newHash}` : ''}`
  window.history.replaceState({}, document.title, cleaned)
}
