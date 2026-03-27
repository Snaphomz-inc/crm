'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Bot,
  CalendarDays,
  CheckCircle2,
  FileText,
  Home,
  ListChecks,
  Users
} from 'lucide-react'
import { CalendarView } from '@/components/calendar/CalendarView'
import { EventModal } from '@/components/calendar/EventModal'
import { EventDetailsModal } from '@/components/calendar/EventDetailsModal'
import { ConnectCalendarModal } from '@/components/calendar/ConnectCalendarModal'
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

const TRANSACTION_FETCH_LIMIT = 5000

const toArray = (payload) => {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.transactions)) return payload.transactions
  if (Array.isArray(payload?.data)) return payload.data
  return []
}

const toAlertsArray = (payload) => {
  if (Array.isArray(payload?.alerts)) return payload.alerts
  if (Array.isArray(payload?.data)) return payload.data
  return []
}

const normalizeText = (value, fallback = '') => {
  const text = String(value ?? '').trim()
  return text || fallback
}

const isValidDate = (value) => Number.isFinite(new Date(value).getTime())

const toDate = (value, fallbackHour = 9, fallbackMinute = 0) => {
  if (!value) return null
  const stringValue = String(value)
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(stringValue)
  const parsed = new Date(
    dateOnly
      ? `${stringValue}T${String(fallbackHour).padStart(2, '0')}:${String(fallbackMinute).padStart(2, '0')}:00`
      : stringValue
  )
  return isValidDate(parsed) ? parsed : null
}

const addMinutes = (value, minutes = 60) => new Date(value.getTime() + minutes * 60 * 1000)

const getResponseErrorMessage = async (response, fallbackMessage) => {
  try {
    const payload = await response.json().catch(() => ({}))
    if (typeof payload?.error === 'string' && payload.error.trim()) return payload.error.trim()
    if (typeof payload?.message === 'string' && payload.message.trim()) return payload.message.trim()
  } catch (_) {}
  return fallbackMessage
}

const buildTransactionMeta = (transaction = {}, fallback = {}) => {
  const transactionId = normalizeText(transaction?.id || fallback.transactionId, '')
  const transactionLabel = normalizeText(
    transaction?.property_address || fallback.propertyAddress || fallback.transactionLabel,
    transactionId || 'Transaction'
  )

  return {
    transactionId: transactionId || null,
    transactionLabel,
    location: normalizeText(transaction?.property_address || fallback.location, ''),
    clientName: normalizeText(transaction?.client_name || fallback.clientName, ''),
    clientEmail: normalizeText(transaction?.client_email || fallback.clientEmail, ''),
    clientPhone: normalizeText(transaction?.client_phone || fallback.clientPhone, ''),
    assignedAgent: normalizeText(transaction?.assigned_agent || fallback.assignedAgent, ''),
    listingPrice:
      transaction?.listing_price !== undefined && transaction?.listing_price !== null && transaction?.listing_price !== ''
        ? transaction.listing_price
        : transaction?.contract_price ?? fallback.listingPrice ?? ''
  }
}

const buildUnlinkedMeta = (location = '') => ({
  transactionId: null,
  transactionLabel: 'Not linked',
  location: normalizeText(location, ''),
  clientName: '',
  clientEmail: '',
  clientPhone: '',
  assignedAgent: '',
  listingPrice: ''
})

const dedupeAndSortEvents = (events = []) => {
  const unique = new Map()
  for (const event of Array.isArray(events) ? events : []) {
    const start = toDate(event?.start, 9, 0)
    if (!start) continue
    const key = [
      String(event?.type || 'event').toLowerCase(),
      String(event?.transactionId || ''),
      String(event?.title || '').trim().toLowerCase(),
      start.toISOString()
    ].join('|')
    if (unique.has(key)) continue
    unique.set(key, { ...event, start: start.toISOString() })
  }
  return [...unique.values()].sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
}

const resolveEventEditMeta = (event) => {
  const source = String(event?.source || '').toLowerCase()
  const explicitType = String(event?.editType || '').toLowerCase()
  const sourceId = normalizeText(event?.sourceId, '')
  const transactionId = normalizeText(event?.transactionId, '')

  if (explicitType === 'manual' || source === 'manual') {
    return { canEdit: true, type: 'manual', sourceId: normalizeText(event?.id, '') }
  }

  if (explicitType === 'checklist' || source === 'checklist') {
    if (sourceId) return { canEdit: true, type: 'checklist', sourceId }
    return { canEdit: false, reason: 'Checklist event is missing item ID.' }
  }

  if (explicitType === 'transaction' || source === 'transaction') {
    const id = sourceId || transactionId
    if (id) return { canEdit: true, type: 'transaction', sourceId: id }
    return { canEdit: false, reason: 'Transaction event is missing transaction ID.' }
  }

  if (source === 'alert') {
    if (explicitType === 'checklist' && sourceId) return { canEdit: true, type: 'checklist', sourceId }
    if (explicitType === 'transaction' && (sourceId || transactionId)) {
      return { canEdit: true, type: 'transaction', sourceId: sourceId || transactionId }
    }
    return { canEdit: false, reason: 'Smart alert-only events are read-only.' }
  }

  return { canEdit: false, reason: 'This event type is read-only.' }
}

const buildEventsFromAlerts = (
  alerts = [],
  transactionLookup = new Map(),
  checklistItemIds = new Set(),
  transactionClosingIds = new Set()
) => {
  const built = []

  for (const alert of Array.isArray(alerts) ? alerts : []) {
    const details =
      alert?.details && typeof alert.details === 'object' && !Array.isArray(alert.details) ? alert.details : {}
    const transactionId = normalizeText(alert?.transaction_id, '')
    const linkedTransaction = transactionId ? transactionLookup.get(transactionId) : null
    const txMeta = buildTransactionMeta(linkedTransaction || {}, {
      transactionId,
      propertyAddress: alert?.property_address
    })
    const alertId = normalizeText(alert?.id, `${transactionId || 'tx'}-${alert?.alert_type || 'alert'}`)
    const seenTaskIds = new Set()
    const beforeCount = built.length

    const pushEvent = ({ id, type = 'event', title, start, description = '', sourceId = '', editType = '' }) => {
      const startDate = toDate(start, 9, 0)
      if (!startDate) return
      const endDate = addMinutes(startDate, 60)
      built.push({
        id,
        type,
        title: normalizeText(title, 'Alert'),
        start: startDate.toISOString(),
        end: endDate.toISOString(),
        source: 'alert',
        sourceId: sourceId || null,
        editType: editType || null,
        description: normalizeText(description, ''),
        ...txMeta
      })
    }

    if (details?.closing_date && !transactionClosingIds.has(String(txMeta.transactionId || ''))) {
      pushEvent({
        id: `alert-closing-${alertId}`,
        type: 'closing',
        title: `${txMeta.transactionLabel} closing`,
        start: details.closing_date,
        description: normalizeText(alert?.message || alert?.title, ''),
        sourceId: txMeta.transactionId,
        editType: txMeta.transactionId ? 'transaction' : ''
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
      const taskId = normalizeText(task?.id, `${alertId}-${index}`)
      const hasMatchingChecklistEvent = Boolean(task?.id) && checklistItemIds.has(String(task.id))
      if (hasMatchingChecklistEvent) return
      if (seenTaskIds.has(taskId)) return
      seenTaskIds.add(taskId)
      pushEvent({
        id: `alert-task-${taskId}`,
        type: 'task',
        title: task?.title || alert?.title || 'Alert task',
        start: dueAt,
        description: normalizeText(task?.description || task?.notes || alert?.message, ''),
        sourceId: normalizeText(task?.id, ''),
        editType: normalizeText(task?.id, '') ? 'checklist' : ''
      })
    })

    if (built.length === beforeCount) {
      pushEvent({
        id: `alert-${alertId}`,
        type: 'event',
        title: alert?.title || 'Smart alert',
        start: alert?.updated_at || alert?.created_at,
        description: normalizeText(alert?.message, '')
      })
    }
  }

  return built
}

export default function CalendarPage() {
  const [view, setView] = useState('month')
  const [selectedDate, setSelectedDate] = useState(new Date())
  const [eventModalOpen, setEventModalOpen] = useState(false)
  const [eventModalMode, setEventModalMode] = useState('create')
  const [eventBeingEdited, setEventBeingEdited] = useState(null)
  const [eventDetailsOpen, setEventDetailsOpen] = useState(false)
  const [selectedEvent, setSelectedEvent] = useState(null)
  const [eventDetailsLoading, setEventDetailsLoading] = useState(false)
  const [eventDetailsError, setEventDetailsError] = useState('')
  const [connectModalOpen, setConnectModalOpen] = useState(false)
  const [events, setEvents] = useState([])
  const [transactions, setTransactions] = useState([])
  const [connectedProvider, setConnectedProvider] = useState('')
  const [eventDraft, setEventDraft] = useState({ start: null, end: null })
  const [refreshSignal, setRefreshSignal] = useState(0)

  const selectedEventEditMeta = useMemo(() => resolveEventEditMeta(selectedEvent), [selectedEvent])

  const hydrateEventFromLiveRecords = async (event) => {
    if (!event || typeof event !== 'object') return event
    let hydrated = { ...event }
    const transactionId = normalizeText(event?.transactionId, '')

    if (transactionId) {
      try {
        const txResponse = await fetch(`/api/transactions/${transactionId}`)
        if (txResponse.ok) {
          const txPayload = await txResponse.json().catch(() => ({}))
          const transaction = txPayload?.transaction && typeof txPayload.transaction === 'object' ? txPayload.transaction : null
          if (transaction) {
            const txMeta = buildTransactionMeta(transaction, {
              transactionId,
              location: hydrated.location,
              transactionLabel: hydrated.transactionLabel,
              clientName: hydrated.clientName,
              clientEmail: hydrated.clientEmail,
              clientPhone: hydrated.clientPhone,
              assignedAgent: hydrated.assignedAgent,
              listingPrice: hydrated.listingPrice
            })
            hydrated = {
              ...hydrated,
              ...txMeta,
              location: normalizeText(hydrated.location, txMeta.location)
            }
            if (String(hydrated?.type || '').toLowerCase() === 'closing' && transaction?.closing_date) {
              const closingStart = toDate(transaction.closing_date, 11, 0)
              if (closingStart) {
                hydrated.start = closingStart.toISOString()
                hydrated.end = addMinutes(closingStart, 60).toISOString()
              }
            }
          }
        }
      } catch (_) {}
    }

    const editMeta = resolveEventEditMeta(hydrated)
    const checklistId = editMeta?.type === 'checklist' ? normalizeText(editMeta?.sourceId, '') : ''

    if (transactionId && checklistId) {
      try {
        const checklistResponse = await fetch(`/api/transactions/${transactionId}/checklist`)
        if (checklistResponse.ok) {
          const checklistPayload = await checklistResponse.json().catch(() => ({}))
          const items = Array.isArray(checklistPayload?.checklist_items) ? checklistPayload.checklist_items : []
          const matchedItem = items.find((item) => String(item?.id || '') === checklistId)
          if (matchedItem) {
            const startDate =
              toDate(matchedItem?.scheduled_start || matchedItem?.due_date, 9, 30) || toDate(hydrated?.start, 9, 30)
            const endDate =
              toDate(matchedItem?.scheduled_end, startDate?.getHours?.() + 1 || 10, startDate?.getMinutes?.() || 0) ||
              (startDate ? addMinutes(startDate, 60) : toDate(hydrated?.end, 10, 30))
            hydrated = {
              ...hydrated,
              title: normalizeText(matchedItem?.title, hydrated.title),
              description: normalizeText(matchedItem?.description || matchedItem?.notes, hydrated.description),
              sourceId: normalizeText(matchedItem?.id, hydrated.sourceId),
              editType: 'checklist',
              start: startDate ? startDate.toISOString() : hydrated.start,
              end: endDate ? endDate.toISOString() : hydrated.end
            }
          }
        }
      } catch (_) {}
    }

    return hydrated
  }

  const handleEventDetailsOpenChange = (nextOpen) => {
    setEventDetailsOpen(nextOpen)
    if (!nextOpen) {
      setEventDetailsLoading(false)
      setEventDetailsError('')
    }
  }

  useEffect(() => {
    let active = true
    const loadCalendarStatus = async () => {
      try {
        const response = await fetch('/api/calendar/status')
        if (!response.ok) return
        const payload = await response.json().catch(() => ({}))
        if (!active) return
        const provider = String(payload?.provider || payload?.connected_provider || '').toLowerCase()
        if (provider) setConnectedProvider(provider)
      } catch (_) {}
    }
    loadCalendarStatus()
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    let active = true

    const loadCalendarEvents = async () => {
      try {
        const alertsPromise = (async () => {
          try {
            const alertResponse = await fetch('/api/alerts/smart')
            if (!alertResponse.ok) return []
            const alertPayload = await alertResponse.json().catch(() => ({}))
            return toAlertsArray(alertPayload)
          } catch (_) {
            return []
          }
        })()

        const response = await fetch(`/api/transactions?limit=${TRANSACTION_FETCH_LIMIT}`)
        if (!response.ok) return
        const payload = await response.json().catch(() => ({}))
        const list = toArray(payload)
        if (!active) return

        setTransactions(list)

        const transactionLookup = new Map(
          (Array.isArray(list) ? list : [])
            .filter((transaction) => transaction?.id)
            .map((transaction) => [String(transaction.id), transaction])
        )

        const checklistPayloads = await Promise.all(
          list.map(async (transaction) => {
            try {
              const checklistResponse = await fetch(`/api/transactions/${transaction.id}/checklist`)
              if (!checklistResponse.ok) return { transaction, items: [] }
              const checklistPayload = await checklistResponse.json().catch(() => ({}))
              return {
                transaction,
                items: Array.isArray(checklistPayload?.checklist_items) ? checklistPayload.checklist_items : []
              }
            } catch (_) {
              return { transaction, items: [] }
            }
          })
        )

        const closingEvents = list
          .filter((transaction) => transaction?.id && transaction?.closing_date)
          .map((transaction) => {
            const start = toDate(transaction.closing_date, 11, 0)
            if (!start) return null
            const end = addMinutes(start, 60)
            const txMeta = buildTransactionMeta(transaction)
            return {
              id: `tx-closing-${transaction.id}`,
              type: 'closing',
              title: `${txMeta.transactionLabel} closing`,
              start: start.toISOString(),
              end: end.toISOString(),
              source: 'transaction',
              sourceId: String(transaction.id),
              editType: 'transaction',
              description: `Closing deadline for ${txMeta.transactionLabel}.`,
              ...txMeta
            }
          })
          .filter(Boolean)

        const taskEvents = checklistPayloads.flatMap(({ transaction, items }) => {
          const txMeta = buildTransactionMeta(transaction)
          return items
            .filter((item) => item?.due_date)
            .map((item) => {
              const start = toDate(item.scheduled_start || item.due_date, 9, 30)
              if (!start) return null
              const end = toDate(item.scheduled_end, start.getHours() + 1, start.getMinutes()) || addMinutes(start, 60)
              return {
                id: `task-${item.id || `${transaction.id}-${item.title || 'task'}`}`,
                type: 'task',
                title: normalizeText(item.title, 'Checklist task'),
                start: start.toISOString(),
                end: end.toISOString(),
                source: 'checklist',
                sourceId: item?.id ? String(item.id) : null,
                editType: item?.id ? 'checklist' : null,
                description: normalizeText(item?.description || item?.notes, ''),
                stage: normalizeText(item?.stage, ''),
                status: normalizeText(item?.status, ''),
                ...txMeta
              }
            })
            .filter(Boolean)
        })

        const checklistItemIds = new Set(
          taskEvents.map((event) => normalizeText(event?.sourceId, '')).filter(Boolean)
        )
        const transactionClosingIds = new Set(
          closingEvents
            .map((event) => normalizeText(event?.transactionId, ''))
            .filter(Boolean)
        )

        const baseMerged = dedupeAndSortEvents([...closingEvents, ...taskEvents])

        setEvents((previous) => {
          const manualEvents = (Array.isArray(previous) ? previous : []).filter((event) => event?.source === 'manual')
          return dedupeAndSortEvents([...baseMerged, ...manualEvents])
        })

        const alerts = await alertsPromise
        if (!active || !Array.isArray(alerts) || alerts.length === 0) return
        const alertEvents = buildEventsFromAlerts(alerts, transactionLookup, checklistItemIds, transactionClosingIds)
        setEvents((previous) => {
          const manualEvents = (Array.isArray(previous) ? previous : []).filter((event) => event?.source === 'manual')
          return dedupeAndSortEvents([...baseMerged, ...alertEvents, ...manualEvents])
        })
      } catch (_) {}
    }

    loadCalendarEvents()
    return () => {
      active = false
    }
  }, [refreshSignal])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return
    const triggerRefresh = () => setRefreshSignal((previous) => previous + 1)
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        triggerRefresh()
      }
    }
    window.addEventListener('focus', triggerRefresh)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('focus', triggerRefresh)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  useEffect(() => {
    if (!selectedEvent?.id) return
    const refreshed = events.find((event) => String(event?.id || '') === String(selectedEvent.id))
    if (refreshed) setSelectedEvent(refreshed)
  }, [events, selectedEvent?.id])

  useEffect(() => {
    if (!eventDetailsOpen || !selectedEvent?.id) return
    let active = true

    const hydrate = async () => {
      setEventDetailsError('')
      setEventDetailsLoading(true)
      try {
        const hydrated = await hydrateEventFromLiveRecords(selectedEvent)
        if (!active || !hydrated) return
        setSelectedEvent(hydrated)
        setEvents((previous) =>
          dedupeAndSortEvents(
            (Array.isArray(previous) ? previous : []).map((event) =>
              String(event?.id || '') === String(hydrated?.id || '') ? { ...event, ...hydrated } : event
            )
          )
        )
      } catch (error) {
        if (!active) return
        setEventDetailsError(String(error?.message || 'Unable to load latest event details.'))
      } finally {
        if (active) setEventDetailsLoading(false)
      }
    }

    hydrate()
    return () => {
      active = false
    }
  }, [eventDetailsOpen, selectedEvent?.id])

  const openEventModalForDate = (dateValue = new Date()) => {
    const raw = dateValue instanceof Date ? new Date(dateValue) : new Date(dateValue)
    const safe = isValidDate(raw) ? raw : new Date()
    safe.setSeconds(0, 0)
    if (safe.getHours() === 0 && safe.getMinutes() === 0) {
      safe.setHours(9, 0, 0, 0)
    }
    const end = addMinutes(safe, 60)
    setEventModalMode('create')
    setEventBeingEdited(null)
    setEventDraft({ start: safe, end })
    setEventModalOpen(true)
  }

  const openEditForEvent = (event) => {
    if (!event) return
    const editMeta = resolveEventEditMeta(event)
    if (!editMeta?.canEdit) return
    const start = toDate(event.start, 9, 0) || new Date()
    const end = toDate(event.end, start.getHours() + 1, start.getMinutes()) || addMinutes(start, 60)
    handleEventDetailsOpenChange(false)
    setEventModalMode('edit')
    setEventBeingEdited({ ...event, sourceId: editMeta.sourceId, editType: editMeta.type })
    setEventDraft({ start, end })
    setEventModalOpen(true)
  }

  const handleEventModalOpenChange = (nextOpen) => {
    setEventModalOpen(nextOpen)
    if (!nextOpen) {
      setEventModalMode('create')
      setEventBeingEdited(null)
    }
  }

  const handleCreateEvent = async (payload) => {
    const linkedTransaction = transactions.find((transaction) => String(transaction?.id || '') === String(payload.transactionId || ''))
    const txMeta = payload.transactionId
      ? buildTransactionMeta(linkedTransaction || {}, {
          transactionId: payload.transactionId,
          location: payload.location
        })
      : buildUnlinkedMeta(payload.location)

    const createdId = `manual-${Date.now()}`
    const created = {
      id: createdId,
      sourceId: createdId,
      editType: 'manual',
      source: 'manual',
      type: payload.type || 'event',
      title: normalizeText(payload.title, 'Event'),
      start: payload.start,
      end: payload.end,
      reminder: payload.reminder || '30m',
      location: normalizeText(payload.location, txMeta.location),
      description: normalizeText(payload.description, ''),
      ...txMeta
    }

    setEvents((previous) => dedupeAndSortEvents([...(Array.isArray(previous) ? previous : []), created]))
  }

  const handleEditEvent = async (payload) => {
    const editing = eventBeingEdited
    if (!editing) throw new Error('No event selected for editing.')

    const editMeta = resolveEventEditMeta(editing)
    if (!editMeta.canEdit) throw new Error(editMeta.reason || 'This event cannot be edited.')

    if (editMeta.type === 'manual') {
      const linkedTransaction = transactions.find(
        (transaction) => String(transaction?.id || '') === String(payload.transactionId || '')
      )
      const txMeta = payload.transactionId
        ? buildTransactionMeta(linkedTransaction || {}, {
            transactionId: payload.transactionId,
            location: payload.location
          })
        : buildUnlinkedMeta(payload.location)

      setEvents((previous) =>
        dedupeAndSortEvents(
          (Array.isArray(previous) ? previous : []).map((event) => {
            if (String(event?.id || '') !== String(editing.id || '')) return event
            return {
              ...event,
              ...txMeta,
              type: payload.type || event.type || 'event',
              title: normalizeText(payload.title, event.title || 'Event'),
              start: payload.start,
              end: payload.end,
              reminder: payload.reminder || event.reminder || '30m',
              location: normalizeText(payload.location, txMeta.location),
              description: normalizeText(payload.description, ''),
              updatedAt: new Date().toISOString()
            }
          })
        )
      )
      return
    }

    if (editMeta.type === 'checklist') {
      const checklistId = editMeta.sourceId
      const response = await fetch(`/api/checklist/${checklistId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: payload.title,
          description: payload.description,
          due_date: payload.start,
          scheduled_start: payload.start,
          scheduled_end: payload.end
        })
      })
      if (!response.ok) {
        throw new Error(await getResponseErrorMessage(response, 'Unable to update checklist event.'))
      }
      const body = await response.json().catch(() => ({}))
      const updatedItem = body?.checklist_item || {}

      const nextStartDate =
        toDate(updatedItem?.scheduled_start || updatedItem?.due_date || payload.start, 9, 30) ||
        toDate(payload.start, 9, 30)
      const nextEndDate =
        toDate(
          updatedItem?.scheduled_end || payload.end,
          nextStartDate?.getHours?.() + 1 || 10,
          nextStartDate?.getMinutes?.() || 0
        ) || (nextStartDate ? addMinutes(nextStartDate, 60) : toDate(payload.end, 10, 30))

      setEvents((previous) =>
        dedupeAndSortEvents(
          (Array.isArray(previous) ? previous : []).map((event) => {
            const eventEditMeta = resolveEventEditMeta(event)
            const sameChecklistId =
              eventEditMeta.type === 'checklist' && String(eventEditMeta.sourceId || '') === String(checklistId)
            if (!sameChecklistId) return event
            return {
              ...event,
              title: normalizeText(updatedItem?.title || payload.title, event.title || 'Checklist task'),
              start: nextStartDate ? nextStartDate.toISOString() : payload.start,
              end: nextEndDate ? nextEndDate.toISOString() : payload.end,
              description: normalizeText(updatedItem?.description || payload.description, event.description || ''),
              location: normalizeText(payload.location, event.location || ''),
              reminder: payload.reminder || event.reminder || '30m',
              updatedAt: new Date().toISOString()
            }
          })
        )
      )
      return
    }

    if (editMeta.type === 'transaction') {
      const transactionId = editMeta.sourceId
      const nextLocation = normalizeText(payload.location, '')
      const updatePayload = { closing_date: payload.start }
      if (nextLocation) updatePayload.property_address = nextLocation

      const response = await fetch(`/api/transactions/${transactionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatePayload)
      })
      if (!response.ok) {
        throw new Error(await getResponseErrorMessage(response, 'Unable to update transaction event.'))
      }
      const body = await response.json().catch(() => ({}))
      const updatedTransaction = body?.transaction || {}

      setTransactions((previous) =>
        (Array.isArray(previous) ? previous : []).map((transaction) =>
          String(transaction?.id || '') === String(transactionId) ? { ...transaction, ...updatedTransaction } : transaction
        )
      )

      const mergedTransaction = { ...updatedTransaction, id: transactionId }
      const txMeta = buildTransactionMeta(mergedTransaction, {
        transactionId,
        location: nextLocation || editing.location
      })

      const nextStartDate = toDate(mergedTransaction?.closing_date || payload.start, 11, 0) || toDate(payload.start, 11, 0)
      const nextEndDate = nextStartDate ? addMinutes(nextStartDate, 60) : toDate(payload.end, 12, 0)
      const updatedAt = new Date().toISOString()

      setEvents((previous) =>
        dedupeAndSortEvents(
          (Array.isArray(previous) ? previous : []).map((event) => {
            if (String(event?.transactionId || '') !== String(transactionId)) return event
            const nextEvent = {
              ...event,
              ...txMeta,
              location: normalizeText(nextLocation, txMeta.location || event.location || ''),
              updatedAt
            }
            const eventEditMeta = resolveEventEditMeta(event)
            const managesClosingSchedule =
              eventEditMeta.type === 'transaction' && String(event?.type || '').toLowerCase() === 'closing'
            if (!managesClosingSchedule) return nextEvent
            return {
              ...nextEvent,
              title: normalizeText(payload.title, `${txMeta.transactionLabel} closing`),
              start: nextStartDate ? nextStartDate.toISOString() : payload.start,
              end: nextEndDate ? nextEndDate.toISOString() : payload.end,
              description: normalizeText(payload.description, event.description || ''),
              reminder: payload.reminder || event.reminder || '30m'
            }
          })
        )
      )
      return
    }

    throw new Error('Unsupported event type for editing.')
  }

  const handleConnectProvider = async (provider) => {
    const safeProvider = String(provider || '').toLowerCase()
    if (!safeProvider || typeof window === 'undefined') return
    setConnectedProvider(safeProvider)
    const returnTo = encodeURIComponent('/calendar')
    window.location.href = `/api/calendar/connect?provider=${safeProvider}&returnTo=${returnTo}`
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
                <SidebarMenuButton isActive asChild>
                  <a href="/calendar">
                    <CalendarDays className="h-4 w-4" />
                    <span>Calendar</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
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
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-bold text-[#231F20] md:text-2xl">CRM Calendar</h2>
              <p className="text-sm font-light text-[#737373]">Google Calendar layout, tailored to Snaphomz workflows.</p>
            </div>
            {connectedProvider && (
              <div className="inline-flex items-center gap-2 rounded-full border border-[#E2E2E2] bg-white px-3 py-1.5 text-xs font-medium text-[#4C4C4C]">
                <CheckCircle2 className="h-4 w-4 text-[#F57F2E]" />
                Connected: {connectedProvider === 'google' ? 'Google' : connectedProvider === 'outlook' ? 'Outlook' : connectedProvider}
              </div>
            )}
          </div>

          <CalendarView
            events={events}
            view={view}
            selectedDate={selectedDate}
            onSelectedDateChange={setSelectedDate}
            onDateClick={(date) => openEventModalForDate(date)}
            onViewChange={setView}
            onCreateEvent={() => openEventModalForDate(selectedDate)}
            onConnectCalendar={() => setConnectModalOpen(true)}
            onEventSelect={(event) => {
              if (!event?.start) return
              setSelectedDate(new Date(event.start))
              setSelectedEvent(event)
              setEventDetailsError('')
              setEventDetailsOpen(true)
            }}
          />
        </div>

        <EventModal
          open={eventModalOpen}
          onOpenChange={handleEventModalOpenChange}
          onSubmit={eventModalMode === 'edit' ? handleEditEvent : handleCreateEvent}
          transactions={transactions}
          defaultStart={eventDraft.start || selectedDate}
          defaultEnd={eventDraft.end || undefined}
          mode={eventModalMode}
          initialEvent={eventBeingEdited}
        />

        <EventDetailsModal
          open={eventDetailsOpen}
          onOpenChange={handleEventDetailsOpenChange}
          event={selectedEvent}
          canEdit={Boolean(selectedEventEditMeta?.canEdit)}
          editDisabledReason={selectedEventEditMeta?.reason || ''}
          onEdit={openEditForEvent}
          loading={eventDetailsLoading}
          error={eventDetailsError}
        />

        <ConnectCalendarModal
          open={connectModalOpen}
          onOpenChange={setConnectModalOpen}
          onConnect={handleConnectProvider}
          activeProvider={connectedProvider}
        />
      </SidebarInset>
    </SidebarProvider>
  )
}
