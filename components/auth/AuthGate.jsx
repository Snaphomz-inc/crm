'use client'

import { useState } from 'react'
import { usePathname } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/components/auth/CognitoAuthProvider'

export function AuthGate({ children }) {
  const pathname = usePathname()
  const [email, setEmail] = useState('')
  const { loading, isSignedIn, isCognitoConfigured, signIn, signUp } = useAuth()

  if (pathname?.startsWith('/auth/callback')) {
    return children
  }

  if (!isCognitoConfigured) {
    return children
  }

  if (loading) {
    return (
      <main className="min-h-[70vh] grid place-items-center">
        <div className="text-sm text-muted-foreground">Checking authentication...</div>
      </main>
    )
  }

  if (isSignedIn) {
    return children
  }

  return (
    <main className="min-h-[70vh] grid place-items-center px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Welcome to CRM</CardTitle>
          <CardDescription>Sign in if you already have an account, or create a new one.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="login-email">Email (optional)</Label>
            <Input
              id="login-email"
              type="email"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <Button className="w-full" onClick={() => signIn({ provider: 'cognito', email })}>
            Sign in
          </Button>
          <Button variant="outline" className="w-full" onClick={() => signUp({ provider: 'cognito', email })}>
            Create account
          </Button>
        </CardContent>
      </Card>
    </main>
  )
}
