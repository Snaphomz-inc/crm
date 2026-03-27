'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

const EVENT_TYPES = [
  { value: 'event', label: 'Event' },
  { value: 'task', label: 'Task' },
  { value: 'closing', label: 'Closing Alert' }
]

const REMINDER_OPTIONS = [
  { value: 'none', label: 'No reminder' },
  { value: '10m', label: '10 minutes before' },
  { value: '30m', label: '30 minutes before' },
  { value: '1h', label: '1 hour before' },
  { value: '1d', label: '1 day before' }
]

const EVENT_TYPE_SET = new Set(EVENT_TYPES.map((item) => item.value))
const REMINDER_SET = new Set(REMINDER_OPTIONS.map((item) => item.value))

const toLocalDateTimeInput = (value) => {
  const date = value instanceof Date ? new Date(value) : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const offsetMs = date.getTimezoneOffset() * 60 * 1000
  const local = new Date(date.getTime() - offsetMs)
  return local.toISOString().slice(0, 16)
}

const normalizeDate = (value) => {
  const date = value instanceof Date ? new Date(value) : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

const buildDefaultWindow = (baseDate = new Date()) => {
  const start = new Date(baseDate)
  start.setMinutes(0, 0, 0)
  start.setHours(start.getHours() + 1)
  const end = new Date(start)
  end.setHours(end.getHours() + 1)
  return { start, end }
}

const resolveType = (value) => {
  const safe = String(value || '').toLowerCase()
  return EVENT_TYPE_SET.has(safe) ? safe : 'event'
}

const resolveReminder = (value) => {
  const safe = String(value || '').toLowerCase()
  return REMINDER_SET.has(safe) ? safe : '30m'
}

export function EventModal({
  open,
  onOpenChange,
  onSubmit,
  transactions = [],
  defaultStart,
  defaultEnd,
  mode = 'create',
  initialEvent = null
}) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({
    title: '',
    start: '',
    end: '',
    type: 'event',
    reminder: '30m',
    transactionId: '',
    location: '',
    description: '',
    saveGoogle: false,
    saveOutlook: false
  })

  const transactionOptions = useMemo(() => (Array.isArray(transactions) ? transactions : []), [transactions])
  const isEditMode = String(mode || '').toLowerCase() === 'edit'
  const eventSource = String(initialEvent?.source || '').toLowerCase()
  const isSourceManaged = isEditMode && eventSource && eventSource !== 'manual'

  useEffect(() => {
    if (!open) return
    const fallbackWindow = buildDefaultWindow()
    const initialStart =
      normalizeDate(initialEvent?.start) || normalizeDate(defaultStart) || fallbackWindow.start
    const initialEnd =
      normalizeDate(initialEvent?.end) || normalizeDate(defaultEnd) || new Date(initialStart.getTime() + 60 * 60 * 1000)

    setError('')
    setSubmitting(false)
    setForm({
      title: String(initialEvent?.title || '').trim(),
      start: toLocalDateTimeInput(initialStart),
      end: toLocalDateTimeInput(initialEnd),
      type: resolveType(initialEvent?.type),
      reminder: resolveReminder(initialEvent?.reminder),
      transactionId: String(initialEvent?.transactionId || ''),
      location: String(initialEvent?.location || '').trim(),
      description: String(initialEvent?.description || '').trim(),
      saveGoogle: false,
      saveOutlook: false
    })
  }, [open, defaultStart, defaultEnd, initialEvent])

  const updateField = (field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    const title = String(form.title || '').trim()
    if (!title) {
      setError('Event title is required.')
      return
    }

    const startDate = new Date(form.start)
    const endDate = new Date(form.end)
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      setError('Start and end time are required.')
      return
    }
    if (endDate <= startDate) {
      setError('End time must be after start time.')
      return
    }

    setSubmitting(true)
    setError('')
    try {
      await onSubmit?.({
        title,
        start: startDate.toISOString(),
        end: endDate.toISOString(),
        type: form.type,
        reminder: form.reminder,
        transactionId: form.transactionId || null,
        location: String(form.location || '').trim(),
        description: String(form.description || '').trim(),
        saveGoogle: Boolean(form.saveGoogle),
        saveOutlook: Boolean(form.saveOutlook)
      })
      onOpenChange?.(false)
    } catch (submitError) {
      setError(String(submitError?.message || `Unable to ${isEditMode ? 'update' : 'create'} event right now.`))
    } finally {
      setSubmitting(false)
    }
  }

  const inputClass =
    'h-11 rounded-lg border-[#E2E2E2] bg-white text-sm font-medium text-[#231F20] shadow-none placeholder:font-light placeholder:text-[#8E8E8E] focus:border-[#F57F2E] focus:ring-[#F57F2E] disabled:cursor-not-allowed disabled:opacity-65'
  const labelClass = 'text-xs font-medium uppercase tracking-wide text-[#6E6E6E]'
  const heading = isEditMode ? 'Edit event' : 'Create event'
  const subHeading = isEditMode
    ? 'Update event details and schedule changes.'
    : 'Add a calendar activity with reminders and optional transaction linking.'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl gap-0 rounded-xl border border-[#E2E2E2] bg-white p-0 shadow-[0_22px_58px_rgba(35,31,32,0.18)]">
        <form onSubmit={handleSubmit}>
          <DialogHeader className="border-b border-[#E2E2E2] px-6 py-5">
            <DialogTitle className="text-xl font-bold text-[#231F20]">{heading}</DialogTitle>
            <DialogDescription className="text-sm font-light text-[#737373]">{subHeading}</DialogDescription>
          </DialogHeader>

          <div className="space-y-5 px-6 py-5">
            <div className="space-y-2">
              <Label htmlFor="event-title" className={labelClass}>
                Event Title
              </Label>
              <Input
                id="event-title"
                value={form.title}
                onChange={(e) => updateField('title', e.target.value)}
                className={cn(inputClass, 'h-12 text-base font-medium')}
                placeholder="Quarterly review with buyer"
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="event-start" className={labelClass}>
                  Start
                </Label>
                <Input
                  id="event-start"
                  type="datetime-local"
                  value={form.start}
                  onChange={(e) => updateField('start', e.target.value)}
                  className={inputClass}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="event-end" className={labelClass}>
                  End
                </Label>
                <Input
                  id="event-end"
                  type="datetime-local"
                  value={form.end}
                  onChange={(e) => updateField('end', e.target.value)}
                  className={inputClass}
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="event-type" className={labelClass}>
                  Type
                </Label>
                <select
                  id="event-type"
                  value={form.type}
                  onChange={(e) => updateField('type', e.target.value)}
                  className={cn(inputClass, 'w-full px-3')}
                  disabled={isSourceManaged}
                >
                  {EVENT_TYPES.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="event-reminder" className={labelClass}>
                  Reminder
                </Label>
                <select
                  id="event-reminder"
                  value={form.reminder}
                  onChange={(e) => updateField('reminder', e.target.value)}
                  className={cn(inputClass, 'w-full px-3')}
                >
                  {REMINDER_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="event-transaction" className={labelClass}>
                Transaction Link
              </Label>
              <select
                id="event-transaction"
                value={form.transactionId}
                onChange={(e) => updateField('transactionId', e.target.value)}
                className={cn(inputClass, 'w-full px-3')}
                disabled={isSourceManaged}
              >
                <option value="">Not linked</option>
                {transactionOptions.map((transaction) => (
                  <option key={transaction.id} value={transaction.id}>
                    {transaction.property_address || transaction.title || transaction.id}
                  </option>
                ))}
              </select>
              {isSourceManaged && (
                <p className="text-xs font-medium text-[#8A8A8A]">
                  This event is linked to CRM data, so type and transaction link are locked.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="event-location" className={labelClass}>
                Location
              </Label>
              <Input
                id="event-location"
                value={form.location}
                onChange={(e) => updateField('location', e.target.value)}
                className={inputClass}
                placeholder="123 Main St, San Francisco"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="event-description" className={labelClass}>
                Description
              </Label>
              <Textarea
                id="event-description"
                value={form.description}
                onChange={(e) => updateField('description', e.target.value)}
                className="min-h-[96px] rounded-lg border-[#E2E2E2] bg-white text-sm font-medium text-[#231F20] placeholder:font-light placeholder:text-[#8E8E8E] focus:border-[#F57F2E] focus:ring-[#F57F2E]"
                placeholder="Optional notes for your team"
              />
            </div>

            {!isEditMode && (
              <div className="space-y-3 rounded-lg bg-[#FCFCFC] px-4 py-3">
                <label className="flex items-center gap-3 text-sm font-medium text-[#231F20]">
                  <input
                    type="checkbox"
                    checked={form.saveGoogle}
                    onChange={(e) => updateField('saveGoogle', e.target.checked)}
                    className="h-4 w-4 rounded border-[#D4D4D4] accent-[#F57F2E]"
                  />
                  Save to Google Calendar
                </label>
                <label className="flex items-center gap-3 text-sm font-medium text-[#231F20]">
                  <input
                    type="checkbox"
                    checked={form.saveOutlook}
                    onChange={(e) => updateField('saveOutlook', e.target.checked)}
                    className="h-4 w-4 rounded border-[#D4D4D4] accent-[#F57F2E]"
                  />
                  Save to Outlook
                </label>
              </div>
            )}

            {error && <p className="text-sm font-medium text-[#B93131]">{error}</p>}
          </div>

          <DialogFooter className="border-t border-[#E2E2E2] px-6 py-4 sm:justify-end">
            <button
              type="button"
              onClick={() => onOpenChange?.(false)}
              className="rounded-lg border border-[#D8D8D8] bg-white px-4 py-2 text-sm font-medium text-[#4E4E4E] transition duration-200 hover:shadow-sm active:scale-[0.99]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-lg bg-[#F57F2E] px-5 py-2 text-sm font-medium text-white shadow-[0_10px_22px_rgba(245,127,46,0.28)] transition duration-200 hover:bg-[#E16E24] hover:shadow-[0_12px_24px_rgba(245,127,46,0.3)] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-65"
            >
              {submitting ? (isEditMode ? 'Saving...' : 'Creating...') : isEditMode ? 'Save Changes' : 'Create Event'}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
