'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Bot,
  CalendarDays,
  FileText,
  Home,
  ListChecks,
  Plus,
  Search,
  Users
} from 'lucide-react'
import { Input } from '@/components/ui/input'
import { EventModal } from '@/components/calendar/EventModal'
import {
  SidebarProvider,
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarSeparator,
  SidebarInset
} from '@/components/ui/sidebar'

const TYPE_META = {
  event: {
    label: 'Event',
    dot: 'bg-[#4B83D8]'
  },
  task: {
    label: 'Task',
    dot: 'bg-[#F57F2E]'
  },
  closing: {
    label: 'Closing',
    dot: 'bg-[#D14A4A]'
  }
}

const STATUS_META = {
  scheduled: 'bg-[#FFF2E8] text-[#A85619]',
  completed: 'bg-[#EDF8F2] text-[#2F8F5B]',
  overdue: 'bg-[#FFF0F0] text-[#B93131]'
}

const toArray = (payload) => {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.transactions)) return payload.transactions
  if (Array.isArray(payload?.data)) return payload.data
  return []
}

const isValidDate = (value) => {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime())
}

const toDate = (value, fallbackHour = 9) => {
  if (!value) return null
  const stringValue = String(value)
  const dateOnlyMatch = /^\d{4}-\d{2}-\d{2}$/.test(stringValue)
  const parsed = new Date(dateOnlyMatch ? `${stringValue}T${String(fallbackHour).padStart(2, '0')}:00:00` : stringValue)
  return isValidDate(parsed) ? parsed : null
}

const addMinutes = (value, minutes) => new Date(value.getTime() + minutes * 60 * 1000)

const formatDateLabel = (value) =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(value)

const formatTimeLabel = (value) =>
  new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(value)

const inferTaskStatus = (task = {}, startDate, now = new Date()) => {
  const rawStatus = String(task?.status || '').toLowerCase()
  if (rawStatus === 'completed') return 'completed'
  if (startDate && startDate.getTime() < now.getTime()) return 'overdue'
  return 'scheduled'
}

const inferClosingStatus = (startDate, now = new Date()) =>
  startDate && startDate.getTime() < now.getTime() ? 'completed' : 'scheduled'
const TRANSACTION_FETCH_LIMIT = 5000

const toAlertsArray = (payload) => {
  if (Array.isArray(payload?.alerts)) return payload.alerts
  if (Array.isArray(payload?.data)) return payload.data
  return []
}

const dedupeAndSortEvents = (events = []) => {
  const unique = new Map()
  for (const event of Array.isArray(events) ? events : []) {
    const startDate = toDate(event?.start, 9)
    if (!startDate) continue
    const key = [
      String(event?.type || 'event').toLowerCase(),
      String(event?.transaction_id || ''),
      String(event?.title || '').trim().toLowerCase(),
      startDate.toISOString()
    ].join('|')
    if (unique.has(key)) continue
    unique.set(key, { ...event, start: startDate.toISOString() })
  }
  return [...unique.values()].sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
}

const buildEventsFromAlerts = (alerts = [], now = new Date()) => {
  const built = []

  for (const alert of Array.isArray(alerts) ? alerts : []) {
    const details =
      alert?.details && typeof alert.details === 'object' && !Array.isArray(alert.details) ? alert.details : {}
    const transactionId = alert?.transaction_id || null
    const transactionLabel = String(alert?.property_address || 'Unassigned transaction').trim() || 'Unassigned transaction'
    const alertId = String(alert?.id || `${transactionId || 'tx'}-${alert?.alert_type || 'alert'}`)
    const seenTaskIds = new Set()
    const beforeCount = built.length

    const pushEvent = ({ id, type = 'event', title, start, subtype = 'Smart alert' }) => {
      const startDate = toDate(start, 9)
      if (!startDate) return
      const endDate = addMinutes(startDate, 60)
      const status =
        type === 'closing'
          ? inferClosingStatus(startDate, now)
          : type === 'task'
            ? inferTaskStatus({}, startDate, now)
            : startDate.getTime() < now.getTime()
              ? 'overdue'
              : 'scheduled'
      built.push({
        id,
        title: String(title || 'Smart alert').trim() || 'Smart alert',
        type,
        status,
        start: startDate.toISOString(),
        end: endDate.toISOString(),
        transaction_id: transactionId,
        transaction_label: transactionLabel,
        subtype
      })
    }

    if (details?.closing_date) {
      pushEvent({
        id: `alert-closing-${alertId}`,
        type: 'closing',
        title: `${transactionLabel} closing`,
        start: details.closing_date,
        subtype: 'Closing alert'
      })
    }

    const candidateTasks = []
    if (details?.next_action_task && typeof details.next_action_task === 'object') {
      candidateTasks.push(details.next_action_task)
    }
    if (Array.isArray(details?.remaining_tasks)) {
      candidateTasks.push(...details.remaining_tasks)
    }
    if (Array.isArray(details?.overdue_tasks)) {
      candidateTasks.push(...details.overdue_tasks)
    }

    candidateTasks.forEach((task, index) => {
      const dueAt = task?.scheduled_start || task?.due_date
      if (!dueAt) return
      const taskId = String(task?.id || `${alertId}-${index}`)
      if (seenTaskIds.has(taskId)) return
      seenTaskIds.add(taskId)
      pushEvent({
        id: `alert-task-${taskId}`,
        type: 'task',
        title: task?.title || alert?.title || 'Alert task',
        start: dueAt,
        subtype: 'Smart alert task'
      })
    })

    if (built.length === beforeCount) {
      pushEvent({
        id: `alert-${alertId}`,
        type: 'event',
        title: alert?.title || 'Smart alert',
        start: alert?.updated_at || alert?.created_at,
        subtype: String(alert?.alert_type || 'Smart alert').replace(/_/g, ' ')
      })
    }
  }

  return built
}

export default function CalendarEventsPage() {
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [typeFilter, setTypeFilter] = useState('all')
  const [eventModalOpen, setEventModalOpen] = useState(false)
  const [transactions, setTransactions] = useState([])
  const [baseEvents, setBaseEvents] = useState([])
  const [manualEvents, setManualEvents] = useState([])

  useEffect(() => {
    let active = true
    const loadEvents = async () => {
      setLoading(true)
      try {
        const alertsPromise = (async () => {
          try {
            const response = await fetch('/api/alerts/smart')
            if (!response.ok) return []
            const payload = await response.json().catch(() => ({}))
            return toAlertsArray(payload)
          } catch (_) {
            return []
          }
        })()

        const txResponse = await fetch(`/api/transactions?limit=${TRANSACTION_FETCH_LIMIT}`)
        const txPayload = await txResponse.json().catch(() => ({}))
        const txList = toArray(txPayload)
        if (!active) return
        setTransactions(txList)

        const checklistPayloads = await Promise.all(
          txList.map(async (transaction) => {
            try {
              const response = await fetch(`/api/transactions/${transaction.id}/checklist`)
              if (!response.ok) return { transaction, items: [] }
              const payload = await response.json().catch(() => ({}))
              return {
                transaction,
                items: Array.isArray(payload?.checklist_items) ? payload.checklist_items : []
              }
            } catch (_) {
              return { transaction, items: [] }
            }
          })
        )

        const now = new Date()
        const closingEvents = txList
          .filter((transaction) => transaction?.id && transaction?.closing_date)
          .map((transaction) => {
            const startDate = toDate(transaction.closing_date, 11)
            const endDate = startDate ? addMinutes(startDate, 60) : null
            if (!startDate || !endDate) return null
            return {
              id: `closing-${transaction.id}`,
              title: `${transaction.property_address || 'Transaction'} closing`,
              type: 'closing',
              status: inferClosingStatus(startDate, now),
              start: startDate.toISOString(),
              end: endDate.toISOString(),
              transaction_id: transaction.id,
              transaction_label: transaction.property_address || 'Unassigned transaction',
              subtype: 'Closing deadline'
            }
          })
          .filter(Boolean)

        const taskEvents = checklistPayloads.flatMap(({ transaction, items }) =>
          items
            .filter((item) => item?.due_date)
            .map((item) => {
              const startDate = toDate(item.scheduled_start || item.due_date, 9)
              const endDate = toDate(item.scheduled_end, 10) || (startDate ? addMinutes(startDate, 60) : null)
              if (!startDate || !endDate) return null
              return {
                id: `task-${item.id || `${transaction.id}-${item.title}`}`,
                title: String(item.title || 'Checklist task').trim() || 'Checklist task',
                type: 'task',
                status: inferTaskStatus(item, startDate, now),
                start: startDate.toISOString(),
                end: endDate.toISOString(),
                transaction_id: transaction.id,
                transaction_label: transaction.property_address || 'Unassigned transaction',
                subtype: String(item.stage || 'Task').replace(/_/g, ' ')
              }
            })
            .filter(Boolean)
        )

        const baseMerged = dedupeAndSortEvents([...closingEvents, ...taskEvents])
        if (!active) return
        setBaseEvents(baseMerged)

        const alerts = await alertsPromise
        if (!active || !Array.isArray(alerts) || alerts.length === 0) return
        const alertEvents = buildEventsFromAlerts(alerts, now)
        setBaseEvents(dedupeAndSortEvents([...baseMerged, ...alertEvents]))
      } catch (_) {
        if (!active) return
        setBaseEvents([])
      } finally {
        if (active) setLoading(false)
      }
    }
    loadEvents()
    return () => {
      active = false
    }
  }, [])

  const allEvents = useMemo(
    () =>
      [...manualEvents, ...baseEvents].sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()),
    [baseEvents, manualEvents]
  )

  const filteredEvents = useMemo(() => {
    const normalizedQuery = String(query || '').trim().toLowerCase()
    return allEvents.filter((event) => {
      if (typeFilter !== 'all' && event.type !== typeFilter) return false
      if (statusFilter !== 'all' && event.status !== statusFilter) return false
      if (!normalizedQuery) return true
      const haystack = `${event.title} ${event.transaction_label} ${event.subtype}`.toLowerCase()
      return haystack.includes(normalizedQuery)
    })
  }, [allEvents, query, statusFilter, typeFilter])

  const handleCreateEvent = (payload) => {
    const linkedTransaction = transactions.find((transaction) => transaction.id === payload.transactionId)
    const created = {
      id: `manual-${Date.now()}`,
      title: payload.title,
      type: payload.type || 'event',
      status: 'scheduled',
      start: payload.start,
      end: payload.end,
      transaction_id: payload.transactionId || null,
      transaction_label: linkedTransaction?.property_address || 'Not linked',
      subtype: payload.type === 'task' ? 'Manual task' : payload.type === 'closing' ? 'Closing reminder' : 'Meeting'
    }
    setManualEvents((previous) => [created, ...previous])
  }

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon" className="bg-secondary">
        <SidebarHeader />
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Overview</SidebarGroupLabel>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <a href="/?tab=assistant">
                    <Bot className="h-4 w-4" />
                    <span>Assistant</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <a href="/?tab=dashboard">
                    <Users className="h-4 w-4" />
                    <span>Leads</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <a href="/?tab=transactions">
                    <FileText className="h-4 w-4" />
                    <span>Transactions</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <a href="/?tab=properties">
                    <Home className="h-4 w-4" />
                    <span>Properties</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <a href="/calendar">
                    <CalendarDays className="h-4 w-4" />
                    <span>Calendar</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton isActive asChild>
                  <a href="/calendar/events">
                    <ListChecks className="h-4 w-4" />
                    <span>Events</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
          <SidebarSeparator />
        </SidebarContent>
      </Sidebar>

      <SidebarInset>
        <div className="container mx-auto px-4 py-6">
          <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-3xl font-bold text-[#231F20]">Events</h1>
              <p className="text-sm font-light text-[#757575]">{filteredEvents.length} events</p>
            </div>
            <div className="flex items-center gap-2">
              <a
                href="/calendar"
                className="inline-flex items-center gap-2 rounded-lg border border-[#E2E2E2] bg-white px-4 py-2 text-sm font-medium text-[#231F20] transition duration-200 hover:-translate-y-0.5 hover:shadow-sm active:scale-[0.99]"
              >
                <CalendarDays className="h-4 w-4" />
                Calendar View
              </a>
              <button
                type="button"
                onClick={() => setEventModalOpen(true)}
                className="inline-flex items-center gap-2 rounded-lg bg-[#F57F2E] px-4 py-2 text-sm font-medium text-white shadow-[0_10px_22px_rgba(245,127,46,0.28)] transition duration-200 hover:bg-[#E16E24] active:scale-[0.99]"
              >
                <Plus className="h-4 w-4" />
                Add Event
              </button>
            </div>
          </div>

          <section className="rounded-xl border border-[#E2E2E2] bg-white p-4 shadow-[0_10px_26px_rgba(35,31,32,0.05)]">
            <div className="mb-4 flex flex-wrap gap-3">
              <div className="relative min-w-[260px] flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8A8A8A]" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search events..."
                  className="h-11 rounded-lg border-[#E2E2E2] bg-white pl-9 text-sm font-medium text-[#231F20] placeholder:font-light placeholder:text-[#8A8A8A] focus:border-[#F57F2E] focus:ring-[#F57F2E]"
                />
              </div>
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
                className="h-11 min-w-[170px] rounded-lg border border-[#E2E2E2] bg-white px-3 text-sm font-medium text-[#231F20] outline-none transition focus:border-[#F57F2E]"
              >
                <option value="all">All Status</option>
                <option value="scheduled">Scheduled</option>
                <option value="completed">Completed</option>
                <option value="overdue">Overdue</option>
              </select>
              <select
                value={typeFilter}
                onChange={(event) => setTypeFilter(event.target.value)}
                className="h-11 min-w-[170px] rounded-lg border border-[#E2E2E2] bg-white px-3 text-sm font-medium text-[#231F20] outline-none transition focus:border-[#F57F2E]"
              >
                <option value="all">All Types</option>
                <option value="event">Event</option>
                <option value="task">Task</option>
                <option value="closing">Closing</option>
              </select>
            </div>

            <div className="overflow-x-auto rounded-lg border border-[#E2E2E2]">
              <table className="w-full min-w-[860px] border-collapse">
                <thead>
                  <tr className="bg-[#FAFAFA]">
                    <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wide text-[#6F6F6F]">Event</th>
                    <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wide text-[#6F6F6F]">Date & Time</th>
                    <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wide text-[#6F6F6F]">Transaction</th>
                    <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wide text-[#6F6F6F]">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {loading && (
                    <tr>
                      <td colSpan={4} className="px-4 py-8 text-center text-sm font-light text-[#7B7B7B]">
                        Loading events...
                      </td>
                    </tr>
                  )}
                  {!loading && filteredEvents.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-4 py-8 text-center text-sm font-light text-[#7B7B7B]">
                        No events found for selected filters.
                      </td>
                    </tr>
                  )}
                  {!loading &&
                    filteredEvents.map((event) => {
                      const startDate = toDate(event.start, 9)
                      const endDate = toDate(event.end, 10)
                      if (!startDate || !endDate) return null
                      const type = String(event.type || 'event').toLowerCase()
                      const typeMeta = TYPE_META[type] || TYPE_META.event
                      const status = String(event.status || 'scheduled').toLowerCase()
                      const statusClass = STATUS_META[status] || STATUS_META.scheduled
                      return (
                        <tr key={event.id} className="border-t border-[#E2E2E2] transition hover:bg-[#FCFCFC]">
                          <td className="px-4 py-4">
                            <div className="flex items-start gap-3">
                              <span className={`mt-2 h-2.5 w-2.5 rounded-full ${typeMeta.dot}`} />
                              <div>
                                <p className="text-base font-medium text-[#231F20]">{event.title}</p>
                                <p className="text-sm font-light text-[#7A7A7A]">{event.subtype || typeMeta.label}</p>
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-4">
                            <p className="text-base font-medium text-[#231F20]">{formatDateLabel(startDate)}</p>
                            <p className="text-sm font-light text-[#7A7A7A]">
                              {formatTimeLabel(startDate)} - {formatTimeLabel(endDate)}
                            </p>
                          </td>
                          <td className="px-4 py-4 text-base font-light text-[#575757]">
                            {event.transaction_label || 'Not linked'}
                          </td>
                          <td className="px-4 py-4">
                            <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium capitalize ${statusClass}`}>
                              {status}
                            </span>
                          </td>
                        </tr>
                      )
                    })}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <EventModal
          open={eventModalOpen}
          onOpenChange={setEventModalOpen}
          onSubmit={handleCreateEvent}
          transactions={transactions}
        />
      </SidebarInset>
    </SidebarProvider>
  )
}
