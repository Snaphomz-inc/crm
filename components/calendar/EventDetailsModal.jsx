'use client'

import {
  CalendarClock,
  ClipboardList,
  DollarSign,
  Mail,
  MapPin,
  Pencil,
  Phone,
  Tag,
  User
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'

const normalizeDate = (value) => {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

const formatDateTime = (value, options) => {
  const date = normalizeDate(value)
  if (!date) return ''
  return new Intl.DateTimeFormat('en-US', options).format(date)
}

const formatEventRange = (start, end) => {
  const safeStart = normalizeDate(start)
  const safeEnd = normalizeDate(end)
  if (!safeStart) return 'Date unavailable'
  const dateLabel = formatDateTime(safeStart, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  })
  const startLabel = formatDateTime(safeStart, {
    hour: 'numeric',
    minute: '2-digit'
  })
  if (!safeEnd) return `${dateLabel} at ${startLabel}`
  const sameDay =
    safeStart.getFullYear() === safeEnd.getFullYear() &&
    safeStart.getMonth() === safeEnd.getMonth() &&
    safeStart.getDate() === safeEnd.getDate()
  const endLabel = formatDateTime(safeEnd, {
    hour: 'numeric',
    minute: '2-digit'
  })
  if (sameDay) return `${dateLabel} | ${startLabel} - ${endLabel}`
  const endDateLabel = formatDateTime(safeEnd, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })
  return `${dateLabel} ${startLabel} to ${endDateLabel} ${endLabel}`
}

const formatCurrency = (value) => {
  if (value === null || value === undefined || value === '') return ''
  const numeric = Number(String(value).replace(/[^0-9.-]/g, ''))
  if (!Number.isFinite(numeric)) return String(value)
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0
  }).format(numeric)
}

const TYPE_LABEL = {
  event: 'Event',
  task: 'Task',
  closing: 'Closing'
}

const SOURCE_LABEL = {
  manual: 'Manual',
  checklist: 'Checklist',
  transaction: 'Transaction',
  alert: 'Smart Alert'
}

function DetailRow({ icon: Icon, label, children }) {
  if (!children) return null
  return (
    <div className="flex items-start gap-3">
      <Icon className="mt-0.5 h-4 w-4 text-[#6B6B6B]" />
      <div className="text-sm text-[#313131]">
        <span className="font-medium text-[#4C4C4C]">{label}: </span>
        {children}
      </div>
    </div>
  )
}

export function EventDetailsModal({
  open,
  onOpenChange,
  event,
  onEdit,
  canEdit = false,
  editDisabledReason = '',
  loading = false,
  error = ''
}) {
  const safeType = String(event?.type || 'event').toLowerCase()
  const safeSource = String(event?.source || 'manual').toLowerCase()
  const priceLabel = formatCurrency(event?.listingPrice)
  const email = String(event?.clientEmail || '').trim()
  const transactionId = String(event?.transactionId || '').trim()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl rounded-xl border border-[#E2E2E2] bg-white p-0 shadow-[0_22px_58px_rgba(35,31,32,0.18)]">
        <DialogHeader className="gap-3 border-b border-[#E2E2E2] px-6 py-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-[#EDF4FF] px-2.5 py-1 text-xs font-medium text-[#214A94]">
              {TYPE_LABEL[safeType] || 'Event'}
            </span>
            <span className="rounded-full bg-[#F6F6F6] px-2.5 py-1 text-xs font-medium text-[#5B5B5B]">
              {SOURCE_LABEL[safeSource] || 'Calendar'}
            </span>
          </div>
          <DialogTitle className="text-2xl font-bold leading-tight text-[#231F20]">
            {String(event?.title || 'Event details').trim() || 'Event details'}
          </DialogTitle>
          <DialogDescription className="text-sm font-light text-[#6F6F6F]">
            {formatEventRange(event?.start, event?.end)}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 px-6 py-5">
          {loading && (
            <div className="rounded-lg bg-[#FCFCFC] px-3 py-2 text-xs font-medium text-[#6A6A6A]">
              Loading latest details...
            </div>
          )}
          {!!error && (
            <div className="rounded-lg bg-[#FFF5F5] px-3 py-2 text-xs font-medium text-[#B93131]">
              {error}
            </div>
          )}
          <DetailRow icon={MapPin} label="Location">
            {String(event?.location || event?.transactionLabel || '').trim() || 'Not set'}
          </DetailRow>
          <DetailRow icon={User} label="Client">
            {String(event?.clientName || '').trim() || 'Not set'}
          </DetailRow>
          <DetailRow icon={Mail} label="Email">
            {email ? (
              <a className="text-[#2563EB] underline-offset-2 hover:underline" href={`mailto:${email}`}>
                {email}
              </a>
            ) : (
              'Not set'
            )}
          </DetailRow>
          <DetailRow icon={Phone} label="Phone">
            {String(event?.clientPhone || '').trim() || 'Not set'}
          </DetailRow>
          <DetailRow icon={CalendarClock} label="Assigned Agent">
            {String(event?.assignedAgent || '').trim() || 'Not set'}
          </DetailRow>
          <DetailRow icon={DollarSign} label="Listing Price">
            {priceLabel || 'Not set'}
          </DetailRow>
          <DetailRow icon={Tag} label="Transaction ID">
            {transactionId || 'Not linked'}
          </DetailRow>
          <DetailRow icon={ClipboardList} label="Notes">
            {String(event?.description || '').trim() || 'No notes'}
          </DetailRow>
        </div>

        <DialogFooter className="border-t border-[#E2E2E2] px-6 py-4 sm:justify-end">
          {!canEdit && editDisabledReason && (
            <p className="mr-auto text-xs font-medium text-[#8A8A8A]">{editDisabledReason}</p>
          )}
          <button
            type="button"
            onClick={() => onEdit?.(event)}
            disabled={!canEdit}
            className="inline-flex items-center gap-2 rounded-lg bg-[#F57F2E] px-5 py-2 text-sm font-medium text-white shadow-[0_10px_22px_rgba(245,127,46,0.28)] transition duration-200 hover:bg-[#E16E24] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-55"
          >
            <Pencil className="h-4 w-4" />
            Edit event
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
