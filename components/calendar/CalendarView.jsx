'use client'

import { useMemo } from 'react'
import { CalendarSync, ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'

const WEEK_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const VIEW_OPTIONS = ['month', 'week', 'day']

const EVENT_TONE = {
  event: {
    chip: 'border-[#C9DEFF] bg-[#EDF4FF] text-[#214A94]'
  },
  task: {
    chip: 'border-[#FAD9BF] bg-[#FFF2E8] text-[#A85619]'
  },
  closing: {
    chip: 'border-[#F6CDCD] bg-[#FFF0F0] text-[#B93131]'
  }
}

const startOfDay = (value) => {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  return date
}

const addDays = (value, days) => {
  const date = new Date(value)
  date.setDate(date.getDate() + days)
  return date
}

const startOfWeek = (value) => {
  const base = startOfDay(value)
  return addDays(base, -base.getDay())
}

const isSameDay = (a, b) => {
  if (!a || !b) return false
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

const normalizeDate = (value) => {
  const date = value instanceof Date ? new Date(value) : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

const formatMonthTitle = (date) =>
  new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(date)

const formatLongDate = (date) =>
  new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(date)

const formatShortDate = (date) =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(date)

const formatTime = (value) => {
  const date = normalizeDate(value)
  if (!date) return ''
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(date)
}

const sameMonth = (a, b) => a?.getMonth?.() === b?.getMonth?.() && a?.getFullYear?.() === b?.getFullYear?.()

function CalendarEventChip({ event, onClick, compact = false }) {
  const typeKey = String(event?.type || 'event').toLowerCase()
  const tone = EVENT_TONE[typeKey] || EVENT_TONE.event

  return (
    <button
      type="button"
      onClick={() => onClick?.(event)}
      className={cn(
        'w-full rounded-md border px-2 py-1 text-left transition duration-200 hover:-translate-y-0.5 hover:shadow-[0_10px_20px_rgba(35,31,32,0.09)] active:scale-[0.99]',
        tone.chip
      )}
    >
      <p className={cn('truncate text-[11px] font-light opacity-80', compact && 'text-[10px]')}>{formatTime(event.start)}</p>
      <p className={cn('truncate text-xs font-medium', compact && 'text-[11px]')}>{event.title}</p>
    </button>
  )
}

export function CalendarView({
  events = [],
  selectedDate = new Date(),
  view = 'month',
  onSelectedDateChange,
  onDateClick,
  onViewChange,
  onCreateEvent,
  onConnectCalendar,
  onEventSelect
}) {
  const safeView = VIEW_OPTIONS.includes(view) ? view : 'month'
  const anchorDate = normalizeDate(selectedDate) || new Date()

  const normalizedEvents = useMemo(
    () =>
      (Array.isArray(events) ? events : [])
        .map((event) => ({
          ...event,
          start: normalizeDate(event?.start),
          end: normalizeDate(event?.end)
        }))
        .filter((event) => event.start)
        .sort((a, b) => a.start.getTime() - b.start.getTime()),
    [events]
  )

  const monthDays = useMemo(() => {
    const firstOfMonth = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), 1)
    const firstCell = startOfWeek(firstOfMonth)
    return Array.from({ length: 42 }, (_, index) => addDays(firstCell, index))
  }, [anchorDate])

  const weekDays = useMemo(() => {
    const weekStart = startOfWeek(anchorDate)
    return Array.from({ length: 7 }, (_, index) => addDays(weekStart, index))
  }, [anchorDate])

  const dayEvents = useMemo(
    () => normalizedEvents.filter((event) => isSameDay(event.start, anchorDate)),
    [anchorDate, normalizedEvents]
  )

  const rangeLabel = useMemo(() => {
    if (safeView === 'day') return formatLongDate(anchorDate)
    if (safeView === 'week') {
      const start = weekDays[0]
      const end = weekDays[6]
      if (!start || !end) return ''
      if (sameMonth(start, end)) {
        return `${start.toLocaleDateString('en-US', { month: 'long' })} ${start.getDate()}-${end.getDate()}, ${start.getFullYear()}`
      }
      return `${formatShortDate(start)} - ${formatShortDate(end)}, ${end.getFullYear()}`
    }
    return formatMonthTitle(anchorDate)
  }, [anchorDate, safeView, weekDays])

  const getEventsForDay = (date) => normalizedEvents.filter((event) => isSameDay(event.start, date))

  const moveWindow = (direction = 1) => {
    const next = new Date(anchorDate)
    if (safeView === 'month') next.setMonth(next.getMonth() + direction)
    else if (safeView === 'week') next.setDate(next.getDate() + 7 * direction)
    else next.setDate(next.getDate() + direction)
    onSelectedDateChange?.(next)
  }

  const handleDateClick = (date) => {
    onSelectedDateChange?.(date)
    onDateClick?.(date)
  }

  return (
    <section className="overflow-hidden rounded-xl border border-[#E2E2E2] bg-[#FFFFFF] shadow-[0_10px_28px_rgba(35,31,32,0.08)]">
      <div className="flex flex-col gap-4 border-b border-[#E2E2E2] px-4 py-4 md:flex-row md:items-center md:justify-between md:px-5">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => moveWindow(-1)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[#E2E2E2] text-[#231F20] transition duration-200 hover:-translate-y-0.5 hover:shadow-sm active:scale-95"
            aria-label="Previous range"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => onSelectedDateChange?.(new Date())}
            className="rounded-lg border border-[#E2E2E2] px-3 py-2 text-xs font-medium text-[#231F20] transition duration-200 hover:bg-[#FAFAFA]"
          >
            Today
          </button>
          <button
            type="button"
            onClick={() => moveWindow(1)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[#E2E2E2] text-[#231F20] transition duration-200 hover:-translate-y-0.5 hover:shadow-sm active:scale-95"
            aria-label="Next range"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <h2 className="ml-2 text-base font-bold text-[#231F20] md:text-lg">{rangeLabel}</h2>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <div className="inline-flex rounded-lg bg-[#F7F7F7] p-1">
            {VIEW_OPTIONS.map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => onViewChange?.(mode)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-xs font-medium capitalize transition duration-200',
                  safeView === mode ? 'bg-[#F57F2E] text-white shadow-sm' : 'text-[#6B6B6B] hover:bg-white hover:text-[#231F20]'
                )}
              >
                {mode}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => onConnectCalendar?.()}
            className="inline-flex items-center gap-2 rounded-lg border border-[#E2E2E2] bg-white px-3 py-2 text-xs font-medium text-[#231F20] transition duration-200 hover:-translate-y-0.5 hover:shadow-sm active:scale-[0.99]"
          >
            <CalendarSync className="h-4 w-4 text-[#6B6B6B]" />
            External Sync
          </button>

          <button
            type="button"
            onClick={() => onCreateEvent?.()}
            className="inline-flex items-center gap-2 rounded-lg bg-[#F57F2E] px-4 py-2 text-xs font-medium text-white shadow-[0_8px_18px_rgba(245,127,46,0.25)] transition duration-200 hover:-translate-y-0.5 hover:bg-[#E06E22] active:translate-y-0 active:scale-[0.99]"
          >
            <Plus className="h-4 w-4" />
            + Event
          </button>
        </div>
      </div>

      {safeView === 'month' && (
        <div>
          <div className="grid grid-cols-7 border-b border-[#E2E2E2] bg-[#FCFCFC]">
            {WEEK_DAYS.map((label) => (
              <div key={label} className="border-r border-[#E2E2E2] px-3 py-2 text-xs font-light uppercase tracking-wide text-[#767676] last:border-r-0">
                {label}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7">
            {monthDays.map((day, index) => {
              const inMonth = day.getMonth() === anchorDate.getMonth()
              const eventsForDay = getEventsForDay(day)
              return (
                <div
                  key={`${day.toISOString()}-${index}`}
                  className={cn(
                    'min-h-[130px] border-b border-r border-[#E2E2E2] p-2 align-top last:border-r-0',
                    !inMonth && 'bg-[#FAFAFA]',
                    isSameDay(day, new Date()) && 'bg-[#FFF9F4]'
                  )}
                >
                  <button
                    type="button"
                    onClick={() => handleDateClick(day)}
                    className={cn(
                      'inline-flex h-7 min-w-7 items-center justify-center rounded-md px-1 text-xs transition',
                      isSameDay(day, anchorDate)
                        ? 'bg-[#231F20] text-white'
                        : inMonth
                          ? 'font-medium text-[#231F20] hover:bg-[#F5F5F5]'
                          : 'font-light text-[#A4A4A4] hover:bg-[#F2F2F2]'
                    )}
                  >
                    {day.getDate()}
                  </button>
                  <div className="mt-2 max-h-[104px] space-y-1 overflow-y-auto pr-1">
                    {eventsForDay.map((event) => (
                      <CalendarEventChip key={event.id || `${event.title}-${event.start?.toISOString()}`} event={event} onClick={onEventSelect} compact />
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {safeView === 'week' && (
        <div className="grid grid-cols-7">
          {weekDays.map((day, index) => {
            const eventsForDay = getEventsForDay(day)
            return (
              <div key={`${day.toISOString()}-${index}`} className="min-h-[520px] border-r border-[#E2E2E2] px-2 py-3 last:border-r-0">
                <button
                  type="button"
                  onClick={() => handleDateClick(day)}
                  className={cn(
                    'mb-3 inline-flex w-full flex-col items-start rounded-lg px-2 py-1.5 text-left transition hover:bg-[#F9F9F9]',
                    isSameDay(day, anchorDate) && 'bg-[#FFF5EE]'
                  )}
                >
                  <span className="text-[11px] font-light uppercase tracking-wide text-[#8A8A8A]">{WEEK_DAYS[day.getDay()]}</span>
                  <span className="text-sm font-bold text-[#231F20]">{day.getDate()}</span>
                </button>
                <div className="space-y-2">
                  {eventsForDay.length === 0 && <p className="px-2 text-xs font-light text-[#A2A2A2]">No events</p>}
                  {eventsForDay.map((event) => (
                    <CalendarEventChip key={event.id || `${event.title}-${event.start?.toISOString()}`} event={event} onClick={onEventSelect} />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {safeView === 'day' && (
        <div className="grid grid-cols-[72px_1fr]">
          <div className="border-r border-[#E2E2E2] bg-[#FCFCFC]">
            {Array.from({ length: 12 }, (_, idx) => idx + 8).map((hour) => (
              <div key={hour} className="h-20 border-b border-[#E2E2E2] px-2 py-2 text-right text-[11px] font-light text-[#8A8A8A]">
                {new Intl.DateTimeFormat('en-US', { hour: 'numeric' }).format(new Date(2026, 0, 1, hour))}
              </div>
            ))}
          </div>
          <div>
            {Array.from({ length: 12 }, (_, idx) => idx + 8).map((hour) => {
              const rowEvents = dayEvents.filter((event) => event.start?.getHours?.() === hour)
              return (
                <div key={hour} className="h-20 border-b border-[#E2E2E2] px-2 py-1.5">
                  <div className="space-y-1.5">
                    {rowEvents.map((event) => (
                      <CalendarEventChip key={event.id || `${event.title}-${event.start?.toISOString()}`} event={event} onClick={onEventSelect} />
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </section>
  )
}
