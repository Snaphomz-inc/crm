'use client'

import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserAttribute,
  CognitoUserPool,
} from 'amazon-cognito-identity-js'
import {
  clearStoredAuthTokens,
  decodeJwtPayload,
  getCognitoConfig,
  isCognitoConfigured,
  readStoredAuthTokens,
  writeStoredAuthTokens,
} from '@/lib/cognito-auth'

const AuthContext = createContext(undefined)

function isOpaqueUsername(value) {
  const raw = String(value || '').trim()
  if (!raw) return true

  // Cognito/native user ids are often UUID-like and should not be shown as display names.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) return true
  if (/^[a-z]+_[0-9]{8,}$/i.test(raw)) return true

  return false
}

function deriveDisplayName(decoded) {
  const explicitName = String(decoded?.name || '').trim()
  if (explicitName && !isOpaqueUsername(explicitName)) return explicitName

  const fromGivenFamily = [decoded?.given_name, decoded?.family_name]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' ')
  if (fromGivenFamily) return fromGivenFamily

  const preferred = String(decoded?.preferred_username || '').trim()
  if (preferred && !isOpaqueUsername(preferred)) return preferred

  const email = String(decoded?.email || '').trim().toLowerCase()
  if (email.includes('@')) {
    const local = email.split('@')[0]
    const words = local
      .replace(/[0-9]+/g, ' ')
      .split(/[^a-zA-Z]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())

    if (words.length) return words.join(' ')
  }

  const cognitoUsername = String(decoded?.['cognito:username'] || '').trim()
  if (cognitoUsername && !isOpaqueUsername(cognitoUsername)) return cognitoUsername

  return null
}

function buildAuthStateFromTokens(tokens) {
  const idToken = tokens?.idToken || null
  const accessToken = tokens?.accessToken || null
  const decoded = idToken ? decodeJwtPayload(idToken) : null

  if (!idToken || !decoded) {
    return {
      isSignedIn: false,
      userEmail: null,
      userName: null,
      userPicture: null,
      idToken: null,
      accessToken: null,
    }
  }

  return {
    isSignedIn: true,
    userEmail: decoded?.email || null,
    userName: deriveDisplayName(decoded),
    userPicture: decoded?.picture || null,
    idToken,
    accessToken,
  }
}

function toAuthError(error) {
  if (!error) return 'Authentication failed'
  if (typeof error === 'string') return error
  if (error?.code && error?.message) {
    return `${error.code}: ${error.message}`
  }
  return error?.message || error?.code || String(error)
}

function toAuthException(error) {
  const wrapped = new Error(toAuthError(error))
  wrapped.code = error?.code || null
  wrapped.raw = error || null
  return wrapped
}

function patchFetchForApiAuth() {
  if (typeof window === 'undefined') return () => {}
  if (window.__crmFetchAuthPatched) return () => {}

  const originalFetch = window.fetch.bind(window)
  window.__crmOriginalFetch = originalFetch

  window.fetch = async (input, init) => {
    try {
      const requestUrl = input instanceof Request ? input.url : String(input)
      const resolved = new URL(requestUrl, window.location.origin)
      const isLocalApi = resolved.origin === window.location.origin && resolved.pathname.startsWith('/api/')

      if (!isLocalApi) return originalFetch(input, init)

      const tokens = readStoredAuthTokens()
      const bearer = tokens?.accessToken || tokens?.idToken
      if (!bearer) return originalFetch(input, init)

      const mergedHeaders = new Headers(input instanceof Request ? input.headers : undefined)
      const initHeaders = new Headers(init?.headers || undefined)
      initHeaders.forEach((value, key) => mergedHeaders.set(key, value))

      if (!mergedHeaders.has('Authorization')) {
        mergedHeaders.set('Authorization', `Bearer ${bearer}`)
      }

      return originalFetch(input, { ...init, headers: mergedHeaders })
    } catch {
      return originalFetch(input, init)
    }
  }

  window.__crmFetchAuthPatched = true

  return () => {
    if (window.__crmFetchAuthPatched && window.__crmOriginalFetch) {
      window.fetch = window.__crmOriginalFetch
      window.__crmFetchAuthPatched = false
      window.__crmOriginalFetch = undefined
    }
  }
}

export function CognitoAuthProvider({ children }) {
  const [loading, setLoading] = useState(true)
  const [state, setState] = useState(buildAuthStateFromTokens(null))

  const config = getCognitoConfig()
  const configured = isCognitoConfigured(config)

  const getPool = () => new CognitoUserPool({
    UserPoolId: config.userPoolId,
    ClientId: config.clientId,
  })

  const makeUsername = (email) => String(email || '').trim().toLowerCase()

  const getSignupUsernameMapKey = () => `crm.cognito.signup-username-map.${config.userPoolId}.${config.clientId}`

  const readSignupUsernameMap = () => {
    if (typeof window === 'undefined') return {}
    try {
      const raw = window.localStorage.getItem(getSignupUsernameMapKey())
      if (!raw) return {}
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  const writeSignupUsernameMap = (mapValue) => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(getSignupUsernameMapKey(), JSON.stringify(mapValue || {}))
    } catch {}
  }

  const getMappedSignupUsername = (email) => {
    const normalizedEmail = makeUsername(email)
    if (!normalizedEmail) return ''
    const mapValue = readSignupUsernameMap()
    return String(mapValue?.[normalizedEmail] || '').trim()
  }

  const rememberSignupUsername = (email, username) => {
    const normalizedEmail = makeUsername(email)
    const normalizedUsername = String(username || '').trim()
    if (!normalizedEmail || !normalizedUsername) return

    const mapValue = readSignupUsernameMap()
    mapValue[normalizedEmail] = normalizedUsername
    writeSignupUsernameMap(mapValue)
  }

  const hashFNV1a = (input) => {
    let hash = 2166136261
    const text = String(input || '')
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i)
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)
    }
    return (hash >>> 0).toString(36)
  }

  const makeAliasCompatibleUsername = (email) => {
    const normalizedEmail = makeUsername(email)
    if (!normalizedEmail) return ''

    const localPart = normalizedEmail.split('@')[0].replace(/[^a-z0-9]/g, '').slice(0, 12) || 'user'
    const salt = `${config.userPoolId}:${config.clientId}:${normalizedEmail}`
    const digest = hashFNV1a(salt)
    return `u_${localPart}_${digest}`
  }

  const shouldRetrySignUpWithInternalUsername = (error) => {
    const msg = String(error?.message || '').toLowerCase()
    const code = String(error?.code || '').toLowerCase()
    if (code !== 'invalidparameterexception') return false
    return msg.includes('username cannot be of email format') || msg.includes('configured for email alias')
  }

  const makeUser = (email) => new CognitoUser({
    Username: makeUsername(email),
    Pool: getPool(),
  })

  const isUserNotFoundError = (error) => {
    const code = String(error?.code || '').toLowerCase()
    const message = String(error?.message || '').toLowerCase()
    return code === 'usernotfoundexception' || message.includes('user does not exist')
  }

  const getUsernameCandidates = (email) => {
    const normalizedEmail = makeUsername(email)
    if (!normalizedEmail) return []
    const mapped = getMappedSignupUsername(normalizedEmail)
    const generated = makeAliasCompatibleUsername(normalizedEmail)
    return [...new Set([mapped, normalizedEmail, generated].filter(Boolean))]
  }

  const runWithUsernameCandidates = async (email, runner) => {
    const candidates = getUsernameCandidates(email)
    let lastError = null

    for (let i = 0; i < candidates.length; i++) {
      const username = candidates[i]
      try {
        return await runner(username)
      } catch (err) {
        lastError = err
        if (!isUserNotFoundError(err) || i === candidates.length - 1) {
          throw err
        }
      }
    }

    throw lastError || new Error('Authentication failed')
  }

  const persistSession = (session) => {
    const idToken = session?.getIdToken?.()?.getJwtToken?.() || ''
    const accessToken = session?.getAccessToken?.()?.getJwtToken?.() || ''
    const refreshToken = session?.getRefreshToken?.()?.getToken?.() || ''

    writeStoredAuthTokens({
      idToken,
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
    }, config.clientId)

    setState(buildAuthStateFromTokens({ idToken, accessToken, refreshToken }))
  }

  const clearSession = () => {
    try {
      const pool = getPool()
      const current = pool.getCurrentUser()
      if (current) current.signOut()
    } catch {}

    clearStoredAuthTokens(config.clientId)
    setState(buildAuthStateFromTokens(null))
  }

  const refreshSession = async () => {
    if (!configured) {
      setState(buildAuthStateFromTokens(null))
      setLoading(false)
      return
    }

    setLoading(true)
    try {
      const pool = getPool()
      const currentUser = pool.getCurrentUser()
      if (!currentUser) {
        setState(buildAuthStateFromTokens(null))
        return
      }

      await new Promise((resolve) => {
        currentUser.getSession((err, session) => {
          if (err || !session) {
            clearSession()
            resolve()
            return
          }

          if (session.isValid()) {
            persistSession(session)
            resolve()
            return
          }

          const refresh = session.getRefreshToken?.()
          if (!refresh) {
            clearSession()
            resolve()
            return
          }

          currentUser.refreshSession(refresh, (refreshErr, refreshedSession) => {
            if (refreshErr || !refreshedSession) {
              clearSession()
              resolve()
              return
            }
            persistSession(refreshedSession)
            resolve()
          })
        })
      })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refreshSession()
    const unpatch = patchFetchForApiAuth()
    return () => unpatch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const signIn = async ({ email, password }) => {
    if (!configured) throw new Error('Cognito is not configured')

    const username = makeUsername(email)
    if (!username || !password) throw new Error('Email and password are required')

    const user = makeUser(username)
    const authDetails = new AuthenticationDetails({
      Username: username,
      Password: password,
    })

    return new Promise((resolve, reject) => {
      user.authenticateUser(authDetails, {
        onSuccess: (session) => {
          persistSession(session)
          resolve({ success: true })
        },
        onFailure: (error) => reject(new Error(toAuthError(error))),
        newPasswordRequired: () => reject(new Error('NEW_PASSWORD_REQUIRED')),
      })
    })
  }

  const signUp = async ({ email, password }) => {
    if (!configured) throw new Error('Cognito is not configured')

    const emailUsername = makeUsername(email)
    if (!emailUsername || !password) throw new Error('Email and password are required')

    const pool = getPool()
    const attributes = [
      new CognitoUserAttribute({ Name: 'email', Value: emailUsername }),
    ]

    const runSignUp = (usernameValue) => new Promise((resolve, reject) => {
      pool.signUp(usernameValue, password, attributes, null, (err, result) => {
        if (err) {
          reject(err)
          return
        }
        resolve(result)
      })
    })

    try {
      const first = await runSignUp(emailUsername)
      return { success: true, userConfirmed: Boolean(first?.userConfirmed) }
    } catch (firstError) {
      if (!shouldRetrySignUpWithInternalUsername(firstError)) {
        throw toAuthException(firstError)
      }

      const mapped = getMappedSignupUsername(emailUsername)
      const internalUsername = mapped || makeAliasCompatibleUsername(emailUsername)
      if (!internalUsername) {
        throw toAuthException(firstError)
      }

      // Persist mapping before retry so follow-up flows (confirm/resend/reset) can target same username.
      rememberSignupUsername(emailUsername, internalUsername)

      try {
        const second = await runSignUp(internalUsername)
        return { success: true, userConfirmed: Boolean(second?.userConfirmed) }
      } catch (secondError) {
        throw toAuthException(secondError)
      }
    }
  }

  const confirmSignUp = async ({ email, code }) => {
    if (!configured) throw new Error('Cognito is not configured')

    if (!makeUsername(email) || !code) throw new Error('Email and confirmation code are required')

    return runWithUsernameCandidates(email, (username) => {
      const user = makeUser(username)
      return new Promise((resolve, reject) => {
        user.confirmRegistration(code, true, (err) => {
          if (err) {
            reject(toAuthException(err))
            return
          }
          resolve({ success: true })
        })
      })
    })
  }

  const resendConfirmationCode = async ({ email }) => {
    if (!configured) throw new Error('Cognito is not configured')

    if (!makeUsername(email)) throw new Error('Email is required')

    return runWithUsernameCandidates(email, (username) => {
      const user = makeUser(username)
      return new Promise((resolve, reject) => {
        user.resendConfirmationCode((err) => {
          if (err) {
            reject(toAuthException(err))
            return
          }
          resolve({ success: true })
        })
      })
    })
  }

  const forgotPasswordStart = async ({ email }) => {
    if (!configured) throw new Error('Cognito is not configured')

    if (!makeUsername(email)) throw new Error('Email is required')

    return runWithUsernameCandidates(email, (username) => {
      const user = makeUser(username)
      return new Promise((resolve, reject) => {
        user.forgotPassword({
          onFailure: (err) => reject(toAuthException(err)),
          inputVerificationCode: () => resolve({ success: true, codeSent: true }),
          onSuccess: () => resolve({ success: true }),
        })
      })
    })
  }

  const forgotPasswordSubmit = async ({ email, code, newPassword }) => {
    if (!configured) throw new Error('Cognito is not configured')

    if (!makeUsername(email) || !code || !newPassword) {
      throw new Error('Email, verification code and new password are required')
    }

    return runWithUsernameCandidates(email, (username) => {
      const user = makeUser(username)
      return new Promise((resolve, reject) => {
        user.confirmPassword(code, newPassword, {
          onFailure: (err) => reject(toAuthException(err)),
          onSuccess: () => resolve({ success: true }),
        })
      })
    })
  }

  const signOut = () => {
    clearSession()
  }

  const getAccessToken = () => {
    const tokens = readStoredAuthTokens(config.clientId)
    return tokens?.accessToken || tokens?.idToken || null
  }

  const value = useMemo(() => ({
    loading,
    isSignedIn: state.isSignedIn,
    userEmail: state.userEmail,
    userName: state.userName,
    userPicture: state.userPicture,
    idToken: state.idToken,
    accessToken: state.accessToken,
    isCognitoConfigured: configured,
    signIn,
    signUp,
    signOut,
    refreshSession,
    confirmSignUp,
    resendConfirmationCode,
    forgotPasswordStart,
    forgotPasswordSubmit,
    getAccessToken,
  }), [loading, state, configured])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within CognitoAuthProvider')
  }
  return context
}
