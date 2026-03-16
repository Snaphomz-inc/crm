'use client'

import { useEffect, useMemo, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/components/auth/CognitoAuthProvider'

const initialForm = {
  email: '',
  password: '',
  confirmPassword: '',
  code: '',
  newPassword: '',
}

function friendlyError(message) {
  const msg = String(message || 'Authentication failed')
  if (msg.includes('UsernameExistsException') || /user already exists/i.test(msg)) return 'Account already exists.'
  if (msg.includes('UserNotConfirmedException') || /not confirmed/i.test(msg)) return 'Account exists but is not confirmed. Use verification code.'
  if (msg.includes('CodeMismatchException')) return 'Incorrect verification code.'
  if (msg.includes('ExpiredCodeException')) return 'Verification code expired. Request a new one.'
  if (msg.includes('UserNotFoundException') || /user does not exist/i.test(msg)) return 'No account found for this email. Create account first.'
  if (/unable to verify secret hash for client/i.test(msg)) return 'Cognito app client is configured with a client secret. Use an App Client without a secret for this web login.'
  if (msg.includes('InvalidPasswordException')) return 'Password does not meet Cognito policy requirements.'
  if (msg.includes('TooManyFailedAttemptsException') || /password attempts exceeded/i.test(msg)) return 'Too many failed attempts. Wait a few minutes or reset password.'
  if (msg.includes('NotAuthorizedException') || /incorrect username or password/i.test(msg)) return 'Incorrect email or password.'
  return msg
}

export function AuthDialog({ open, onOpenChange, initialMode = 'signin' }) {
  const {
    signIn,
    signUp,
    confirmSignUp,
    resendConfirmationCode,
    forgotPasswordStart,
    forgotPasswordSubmit,
  } = useAuth()

  const [mode, setMode] = useState(initialMode)
  const [form, setForm] = useState(initialForm)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (open) {
      setMode(initialMode)
      setForm(initialForm)
      setMessage('')
      setError('')
      setBusy(false)
    }
  }, [open, initialMode])

  const update = (key, value) => setForm((prev) => ({ ...prev, [key]: value }))

  const title = useMemo(() => {
    if (mode === 'signup') return 'Create account'
    if (mode === 'confirm') return 'Confirm account'
    if (mode === 'forgot') return 'Forgot password'
    if (mode === 'reset') return 'Reset password'
    return 'Sign in'
  }, [mode])

  const description = useMemo(() => {
    if (mode === 'signup') return 'Create your CRM login with email and password.'
    if (mode === 'confirm') return 'Enter the verification code sent to your email.'
    if (mode === 'forgot') return 'We will send a verification code to your email.'
    if (mode === 'reset') return 'Enter the verification code and your new password.'
    return 'Sign in with your email and password.'
  }, [mode])

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setMessage('')
    setBusy(true)

    try {
      if (mode === 'signin') {
        await signIn({ email: form.email, password: form.password })
        onOpenChange(false)
      } else if (mode === 'signup') {
        if (form.password !== form.confirmPassword) {
          throw new Error('Passwords do not match. Check hidden spaces/autofill and try again.')
        }
        await signUp({ email: form.email, password: form.password })
        setMode('confirm')
        setMessage('Account created. Enter the verification code from your email.')
      } else if (mode === 'confirm') {
        await confirmSignUp({ email: form.email, code: form.code })
        setMode('signin')
        setMessage('Account confirmed. Sign in with your email and password.')
      } else if (mode === 'forgot') {
        await forgotPasswordStart({ email: form.email })
        setMode('reset')
        setMessage('Verification code sent. Enter it below with your new password.')
      } else if (mode === 'reset') {
        await forgotPasswordSubmit({
          email: form.email,
          code: form.code,
          newPassword: form.newPassword,
        })
        setMode('signin')
        setMessage('Password reset successful. Sign in with your new password.')
      }
    } catch (err) {
      const rawMsg = err?.message || 'Authentication failed'
      const msg = friendlyError(rawMsg)

      if (msg === 'Account already exists.') {
        setMode('confirm')
        setMessage('This email is already registered. If not verified yet, enter the code or resend it. If already verified, go back and sign in.')
      } else if (msg === 'Account exists but is not confirmed. Use verification code.') {
        setMode('confirm')
        setMessage('Enter your verification code to confirm this account.')
      } else {
        setError(msg)
      }
    } finally {
      setBusy(false)
    }
  }

  const resendCode = async () => {
    setError('')
    setMessage('')
    setBusy(true)
    try {
      await resendConfirmationCode({ email: form.email })
      setMessage('Confirmation code resent.')
    } catch (err) {
      setError(friendlyError(err?.message || 'Failed to resend code'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={handleSubmit} autoComplete="off">
          <div className="space-y-2">
            <Label htmlFor="auth-email">Email</Label>
            <Input
              id="auth-email"
              type="email"
              value={form.email}
              onChange={(e) => update('email', e.target.value)}
              autoComplete={mode === 'signin' ? 'username' : 'off'}
              name={mode === 'signin' ? 'signin_email' : 'signup_email'}
              required
            />
          </div>

          {(mode === 'signin' || mode === 'signup') && (
            <div className="space-y-2">
              <Label htmlFor="auth-password">Password</Label>
              <Input
                id="auth-password"
                type="password"
                value={form.password}
                onChange={(e) => update('password', e.target.value)}
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                name={mode === 'signin' ? 'signin_password' : 'signup_password'}
                required
              />
            </div>
          )}

          {mode === 'signup' && (
            <div className="space-y-2">
              <Label htmlFor="auth-confirm-password">Confirm Password</Label>
              <Input
                id="auth-confirm-password"
                type="password"
                value={form.confirmPassword}
                onChange={(e) => update('confirmPassword', e.target.value)}
                autoComplete="new-password"
                name="signup_confirm_password"
                required
              />
            </div>
          )}

          {(mode === 'confirm' || mode === 'reset') && (
            <div className="space-y-2">
              <Label htmlFor="auth-code">Verification Code</Label>
              <Input
                id="auth-code"
                type="text"
                value={form.code}
                onChange={(e) => update('code', e.target.value)}
                autoComplete="one-time-code"
                name="verification_code"
                required
              />
            </div>
          )}

          {mode === 'reset' && (
            <div className="space-y-2">
              <Label htmlFor="auth-new-password">New Password</Label>
              <Input
                id="auth-new-password"
                type="password"
                value={form.newPassword}
                onChange={(e) => update('newPassword', e.target.value)}
                autoComplete="new-password"
                name="reset_new_password"
                required
              />
            </div>
          )}

          {error ? <p className="text-sm text-red-600">{error}</p> : null}
          {!error && message ? <p className="text-sm text-emerald-700">{message}</p> : null}

          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? 'Please wait...' : title}
          </Button>

          <div className="flex items-center justify-between text-sm gap-3">
            {(mode === 'signin' || mode === 'forgot') && (
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => setMode(mode === 'signin' ? 'forgot' : 'signin')}
              >
                {mode === 'signin' ? 'Forgot password?' : 'Back to sign in'}
              </button>
            )}

            {(mode === 'signin' || mode === 'signup') && (
              <button
                type="button"
                className="text-primary hover:underline ml-auto"
                onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}
              >
                {mode === 'signin' ? 'Create account' : 'Already have an account?'}
              </button>
            )}

            {mode === 'confirm' && (
              <div className="ml-auto flex items-center gap-3">
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={() => setMode('signin')}
                >
                  Back to sign in
                </button>
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={resendCode}
                  disabled={busy}
                >
                  Resend code
                </button>
              </div>
            )}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}