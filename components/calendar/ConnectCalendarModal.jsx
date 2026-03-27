'use client'

import { useMemo, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Calendar, CheckCircle2, Cloud } from 'lucide-react'
import { cn } from '@/lib/utils'

const PROVIDERS = [
  {
    id: 'google',
    label: 'Google',
    description: 'Sync events, tasks, and reminders with Google Calendar.',
    icon: Calendar
  },
  {
    id: 'outlook',
    label: 'Outlook',
    description: 'Keep your CRM timeline aligned with Outlook calendar.',
    icon: Cloud
  }
]

export function ConnectCalendarModal({ open, onOpenChange, onConnect, activeProvider = '' }) {
  const [selectedProvider, setSelectedProvider] = useState('')
  const [loading, setLoading] = useState(false)

  const preselected = useMemo(() => String(activeProvider || '').toLowerCase(), [activeProvider])
  const selected = selectedProvider || preselected

  const handleClose = () => {
    setSelectedProvider('')
    setLoading(false)
    onOpenChange?.(false)
  }

  const handleOpenChange = (nextOpen) => {
    if (nextOpen) {
      onOpenChange?.(true)
      return
    }
    handleClose()
  }

  const handleConnect = async () => {
    if (!selected) return
    setLoading(true)
    try {
      await onConnect?.(selected)
      handleClose()
    } catch (_) {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-xl rounded-xl border border-[#E2E2E2] bg-white p-0 shadow-[0_22px_58px_rgba(35,31,32,0.18)]">
        <DialogHeader className="border-b border-[#E2E2E2] px-6 py-5">
          <DialogTitle className="text-xl font-bold text-[#231F20]">Connect your calendar</DialogTitle>
          <DialogDescription className="text-sm font-light text-[#737373]">
            Choose one provider to sync events from Snaphomz into your external calendar.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 px-6 py-5 sm:grid-cols-2">
          {PROVIDERS.map((provider) => {
            const Icon = provider.icon
            const isSelected = selected === provider.id
            return (
              <button
                key={provider.id}
                type="button"
                onClick={() => setSelectedProvider(provider.id)}
                className={cn(
                  'rounded-xl border bg-white p-4 text-left transition duration-200 hover:-translate-y-0.5 hover:shadow-[0_12px_24px_rgba(35,31,32,0.1)]',
                  isSelected ? 'border-[#F57F2E] shadow-[0_12px_24px_rgba(245,127,46,0.15)]' : 'border-[#E2E2E2]'
                )}
              >
                <div className="mb-3 flex items-center justify-between">
                  <div className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-[#F8F8F8] text-[#231F20]">
                    <Icon className="h-5 w-5" />
                  </div>
                  {isSelected && <CheckCircle2 className="h-5 w-5 text-[#F57F2E]" />}
                </div>
                <p className="text-base font-bold text-[#231F20]">{provider.label}</p>
                <p className="mt-1 text-sm font-light text-[#727272]">{provider.description}</p>
              </button>
            )
          })}
        </div>

        <DialogFooter className="border-t border-[#E2E2E2] px-6 py-4 sm:justify-end">
          <button
            type="button"
            onClick={handleClose}
            className="rounded-lg border border-[#D8D8D8] bg-white px-4 py-2 text-sm font-medium text-[#4E4E4E] transition duration-200 hover:shadow-sm active:scale-[0.99]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!selected || loading}
            onClick={handleConnect}
            className="rounded-lg bg-[#F57F2E] px-5 py-2 text-sm font-medium text-white shadow-[0_10px_22px_rgba(245,127,46,0.28)] transition duration-200 hover:bg-[#E16E24] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? 'Connecting...' : 'Connect your calendar'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
