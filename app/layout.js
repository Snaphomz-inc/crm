import './globals.css'
import Image from 'next/image'
import { Toaster } from '@/components/ui/toaster'
import { CognitoAuthProvider } from '@/components/auth/CognitoAuthProvider'
import { HeaderAuthControls } from '@/components/auth/HeaderAuthControls'

export const metadata = {
  title: 'Real Estate CRM - Lead Management System',
  description: 'AI-powered real estate CRM with lead management, property matching, and deal tracking',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background font-sans antialiased">
        <CognitoAuthProvider>
          <header className="sticky top-0 z-40 w-full border-b bg-secondary/70 backdrop-blur supports-[backdrop-filter]:bg-secondary/60">
            <div className="container mx-auto px-4 py-3 flex items-center justify-between">
              <a href="/" className="flex items-center gap-3">
                <Image
                  src="/snaphomz-logo.svg"
                  alt="Snaphomz"
                  width={36}
                  height={36}
                  priority
                />
                <span className="text-lg font-semibold tracking-tight">Snaphomz</span>
              </a>
              <HeaderAuthControls />
            </div>
          </header>

          {children}
          <Toaster />
        </CognitoAuthProvider>
      </body>
    </html>
  )
}
