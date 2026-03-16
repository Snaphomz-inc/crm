'use client'

import { useState } from 'react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { NotificationBell } from '@/components/NotificationCenter'
import { useAuth } from '@/components/auth/CognitoAuthProvider'
import { AuthDialog } from '@/components/auth/AuthDialog'

function getInitials(nameOrEmail) {
  const raw = String(nameOrEmail || '').trim()
  if (!raw) return 'U'
  const parts = raw.split(/\s+/).filter(Boolean)
  if (parts.length > 1) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase()
  }
  return raw.slice(0, 2).toUpperCase()
}

export function HeaderAuthControls() {
  const { isSignedIn, userName, userEmail, isCognitoConfigured, signOut } = useAuth()
  const [authOpen, setAuthOpen] = useState(false)
  const [authMode, setAuthMode] = useState('signin')

  const openAuth = (mode) => {
    setAuthMode(mode)
    setAuthOpen(true)
  }

  return (
    <div className="hidden md:flex items-center gap-3">
      <div className="relative">
        <input
          type="text"
          placeholder="Search..."
          className="h-9 w-64 rounded-md border bg-background px-3 text-sm outline-none ring-0 placeholder:text-muted-foreground focus:border-primary"
        />
      </div>

      <NotificationBell />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-9 w-9 rounded-full p-0">
            <Avatar className="h-9 w-9">
              <AvatarFallback>{getInitials(userName || userEmail || 'u')}</AvatarFallback>
            </Avatar>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {isCognitoConfigured ? (
            isSignedIn ? (
              <>
                <DropdownMenuLabel>
                  <div className="font-medium">{userName || 'Signed in user'}</div>
                  <div className="text-xs text-muted-foreground">{userEmail || ''}</div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={signOut}>Sign out</DropdownMenuItem>
              </>
            ) : (
              <>
                <DropdownMenuLabel>Account</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => openAuth('signin')}>Sign in</DropdownMenuItem>
                <DropdownMenuItem onClick={() => openAuth('signup')}>Create account</DropdownMenuItem>
              </>
            )
          ) : (
            <>
              <DropdownMenuLabel>Auth not configured</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled>Set NEXT_PUBLIC_COGNITO_* in .env.local</DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <AuthDialog open={authOpen} onOpenChange={setAuthOpen} initialMode={authMode} />
    </div>
  )
}
