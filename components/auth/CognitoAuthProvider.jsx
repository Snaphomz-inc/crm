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

  const makeUser = (email) => new CognitoUser({
    Username: makeUsername(email),
    Pool: getPool(),
  })

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

    const username = makeUsername(email)
    if (!username || !password) throw new Error('Email and password are required')

    const pool = getPool()
    const attributes = [
      new CognitoUserAttribute({ Name: 'email', Value: username }),
    ]

    return new Promise((resolve, reject) => {
      pool.signUp(username, password, attributes, null, (err, result) => {
        if (err) {
          reject(new Error(toAuthError(err)))
          return
        }
        resolve({ success: true, userConfirmed: Boolean(result?.userConfirmed) })
      })
    })
  }

  const confirmSignUp = async ({ email, code }) => {
    if (!configured) throw new Error('Cognito is not configured')

    const username = makeUsername(email)
    if (!username || !code) throw new Error('Email and confirmation code are required')

    const user = makeUser(username)
    return new Promise((resolve, reject) => {
      user.confirmRegistration(code, true, (err) => {
        if (err) {
          reject(new Error(toAuthError(err)))
          return
        }
        resolve({ success: true })
      })
    })
  }

  const resendConfirmationCode = async ({ email }) => {
    if (!configured) throw new Error('Cognito is not configured')

    const username = makeUsername(email)
    if (!username) throw new Error('Email is required')

    const user = makeUser(username)
    return new Promise((resolve, reject) => {
      user.resendConfirmationCode((err) => {
        if (err) {
          reject(new Error(toAuthError(err)))
          return
        }
        resolve({ success: true })
      })
    })
  }

  const forgotPasswordStart = async ({ email }) => {
    if (!configured) throw new Error('Cognito is not configured')

    const username = makeUsername(email)
    if (!username) throw new Error('Email is required')

    const user = makeUser(username)
    return new Promise((resolve, reject) => {
      user.forgotPassword({
        onFailure: (err) => reject(new Error(toAuthError(err))),
        inputVerificationCode: () => resolve({ success: true, codeSent: true }),
        onSuccess: () => resolve({ success: true }),
      })
    })
  }

  const forgotPasswordSubmit = async ({ email, code, newPassword }) => {
    if (!configured) throw new Error('Cognito is not configured')

    const username = makeUsername(email)
    if (!username || !code || !newPassword) {
      throw new Error('Email, verification code and new password are required')
    }

    const user = makeUser(username)
    return new Promise((resolve, reject) => {
      user.confirmPassword(code, newPassword, {
        onFailure: (err) => reject(new Error(toAuthError(err))),
        onSuccess: () => resolve({ success: true }),
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
