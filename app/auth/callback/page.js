'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  clearAuthParamsFromUrl,
  exchangeCodeForTokens,
  getCognitoConfig,
  isCognitoConfigured,
  readStoredAuthTokens,
  writeStoredAuthTokens
} from '@/lib/cognito-auth'
import { useAuth } from '@/components/auth/CognitoAuthProvider'

function collectParams() {
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const searchParams = new URLSearchParams(window.location.search)

  searchParams.forEach((value, key) => {
    if (!hashParams.has(key)) hashParams.set(key, value)
  })

  return hashParams
}

function resolveRedirectTarget(rawState) {
  if (!rawState) return '/'
  if (rawState.startsWith('/')) return rawState

  try {
    const stateUrl = new URL(rawState, window.location.origin)
    if (stateUrl.origin === window.location.origin) {
      return `${stateUrl.pathname}${stateUrl.search}${stateUrl.hash}`
    }
  } catch {
    return '/'
  }

  return '/'
}

export default function AuthCallbackPage() {
  const router = useRouter()
  const { refreshSession } = useAuth()
  const [status, setStatus] = useState('Processing authentication...')
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true

    const run = async () => {
      const config = getCognitoConfig()
      if (!isCognitoConfigured(config)) {
        if (!active) return
        setError('Cognito is not configured. Set NEXT_PUBLIC_COGNITO_* variables first.')
        return
      }

      const params = collectParams()
      const oauthError = params.get('error')
      const oauthErrorDescription = params.get('error_description') || ''
      const code = params.get('code')
      const state = params.get('state') || '/'
      const redirectTarget = resolveRedirectTarget(state)

      if (oauthError) {
        if (!active) return
        setError(`Cognito returned an error: ${oauthError}${oauthErrorDescription ? ` (${oauthErrorDescription})` : ''}`)
        return
      }

      if (!code) {
        clearAuthParamsFromUrl()
        if (!active) return
        setStatus('No authorization code found. Redirecting...')
        setTimeout(() => router.replace('/'), 250)
        return
      }

      try {
        setStatus('Exchanging code for tokens...')
        const tokens = await exchangeCodeForTokens(code)
        writeStoredAuthTokens(tokens, config.clientId)

        clearAuthParamsFromUrl()
        await refreshSession()

        if (!active) return
        setStatus('Success. Redirecting...')
        router.replace(redirectTarget)

        setTimeout(() => {
          if (window.location.pathname.startsWith('/auth/callback')) {
            window.location.replace(redirectTarget)
          }
        }, 400)
      } catch (exchangeError) {
        // If tokens already exist, treat this as recovered success.
        const cached = readStoredAuthTokens(config.clientId)
        if (cached?.idToken) {
          clearAuthParamsFromUrl()
          await refreshSession().catch(() => {})
          if (!active) return
          router.replace(redirectTarget)
          return
        }

        clearAuthParamsFromUrl()
        if (!active) return
        setError(`Could not complete Cognito authentication: ${exchangeError?.message || String(exchangeError)}`)
      }
    }

    run()

    return () => {
      active = false
    }
  }, [refreshSession, router])

  return (
    <main className="min-h-screen bg-[#F5F3F1] flex items-center justify-center px-4">
      <div className="w-full max-w-md p-8 bg-white rounded-lg shadow-lg text-center space-y-3">
        <h1 className="text-2xl font-semibold">Authentication</h1>
        {error ? (
          <>
            <p className="text-sm text-red-600">{error}</p>
            <p className="text-sm text-gray-600">Return to the CRM and try login again.</p>
          </>
        ) : (
          <>
            <p className="text-gray-700">{status}</p>
            <p className="text-sm text-gray-500">This should only take a moment.</p>
          </>
        )}
      </div>
    </main>
  )
}
