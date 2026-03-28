'use client'

import { useState, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { ToastAction } from '@/components/ui/toast'
import { toast } from '@/hooks/use-toast'
import { 
  Plus, 
  Home, 
  User, 
  Calendar, 
  DollarSign, 
  ArrowRight,
  FileText,
  Clock,
  CheckCircle,
  PlayCircle,
  Search,
  Trash2
} from 'lucide-react'
import { TransactionTimeline } from '@/components/TransactionTimeline'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import { useAuth } from '@/components/auth/CognitoAuthProvider'

// Stage configurations for seller (sale) and buyer (purchase)
const STAGE_CONFIGS = {
  sale: {
    pre_listing: { name: 'Pre-Listing', color: 'bg-blue-500', icon: FileText },
    listing: { name: 'Active Listing', color: 'bg-yellow-500', icon: PlayCircle },
    under_contract: { name: 'Under Contract', color: 'bg-orange-500', icon: Clock },
    escrow_closing: { name: 'Escrow & Closing', color: 'bg-green-500', icon: CheckCircle }
  },
  purchase: {
    pre_approval: { name: 'Pre-Approval', color: 'bg-blue-500', icon: FileText },
    home_search: { name: 'Home Search', color: 'bg-purple-500', icon: PlayCircle },
    offer: { name: 'Offer', color: 'bg-yellow-500', icon: FileText },
    under_contract: { name: 'Under Contract', color: 'bg-orange-500', icon: Clock },
    escrow_closing: { name: 'Escrow & Closing', color: 'bg-green-500', icon: CheckCircle }
  }
}

const formatStageLabel = (stage = '') =>
  String(stage)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())

const CALENDAR_PROVIDER_OPTIONS = [
  { id: 'google', label: 'Google Calendar' },
  { id: 'outlook', label: 'Outlook Calendar' }
]

const CALENDAR_PROVIDER_LABELS = {
  google: 'Google Calendar',
  outlook: 'Outlook Calendar'
}

const getCalendarProviderLabel = (providerId = '') => CALENDAR_PROVIDER_LABELS[String(providerId || '').toLowerCase()] || 'Calendar'
const PENDING_CALENDAR_TRANSACTION_KEY = 'crm.pending_calendar_transaction_create'

const GOOGLE_EMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com'])
const OUTLOOK_EMAIL_DOMAINS = new Set([
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'office365.com',
  'microsoft.com'
])

const getRecommendedProviderFromEmail = (email = '') => {
  const normalizedEmail = String(email || '').trim().toLowerCase()
  const domain = normalizedEmail.includes('@') ? normalizedEmail.split('@')[1] : ''
  if (!domain) return null
  if (GOOGLE_EMAIL_DOMAINS.has(domain)) return 'google'
  if (OUTLOOK_EMAIL_DOMAINS.has(domain)) return 'outlook'
  return null
}

const OUTLOOK_CALENDAR_FALLBACK_URL = 'https://outlook.live.com/calendar/view/workweek'

export function TransactionManagement() {
  const { userEmail, isSignedIn, loading: authLoading } = useAuth()
  const [transactions, setTransactions] = useState([])
  const [filteredTransactions, setFilteredTransactions] = useState([])
  const [selectedTransaction, setSelectedTransaction] = useState(null)
  const [focusTarget, setFocusTarget] = useState(null)
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [stageFilter, setStageFilter] = useState('all')
  const [deleteDialog, setDeleteDialog] = useState({ open: false, tx: null })
  const [deleting, setDeleting] = useState(false)
  const [calendarStatus, setCalendarStatus] = useState({
    loading: true,
    providers: [],
    configured: false,
    connected: false,
    connected_providers: [],
    configured_providers: [],
    byProvider: {}
  })
  const [isCalendarConnectDialogOpen, setIsCalendarConnectDialogOpen] = useState(false)
  const [calendarActionLoading, setCalendarActionLoading] = useState(false)
  const [calendarConnectReason, setCalendarConnectReason] = useState('manual')
  const connectRedirectingRef = useRef(false)

  const [newTransaction, setNewTransaction] = useState({
    property_address: '',
    client_name: '',
    client_email: '',
    client_phone: '',
    transaction_type: 'sale',
    assigned_agent: '',
    listing_price: '',
    closing_date: '',
    add_to_calendar: false
  })

  useEffect(() => {
    fetchTransactions()
  }, [])

  useEffect(() => {
    if (authLoading) return
    fetchCalendarStatus()
  }, [authLoading, isSignedIn, userEmail])

  useEffect(() => {
    filterTransactions()
  }, [transactions, searchTerm, stageFilter])

  useEffect(() => {
    const handleFocusTask = async (event) => {
      const transactionId = event?.detail?.transactionId
      const taskId = event?.detail?.taskId
      const stage = event?.detail?.stage || null
      if (!transactionId || !taskId) return

      let transaction = transactions.find((tx) => tx.id === transactionId) || null
      if (!transaction) {
        try {
          const response = await fetch(`/api/transactions/${transactionId}`)
          const data = await response.json()
          if (data?.success && data?.transaction) {
            transaction = data.transaction
            setTransactions((prev) => {
              if (prev.some((tx) => tx.id === transaction.id)) return prev
              return [transaction, ...prev]
            })
          }
        } catch (error) {
          console.error('Error loading transaction for task focus:', error)
        }
      }

      if (transaction) {
        setSelectedTransaction(transaction)
        setFocusTarget({ transactionId, taskId, stage, nonce: Date.now() })
      }
    }

    window.addEventListener('crm:focus-task', handleFocusTask)
    return () => window.removeEventListener('crm:focus-task', handleFocusTask)
  }, [transactions])

  useEffect(() => {
    if (typeof window === 'undefined') return

    const parsePendingCalendarTransaction = () => {
      try {
        const raw = window.sessionStorage.getItem(PENDING_CALENDAR_TRANSACTION_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object') return null
        if (!parsed.transaction || typeof parsed.transaction !== 'object') return null
        return parsed
      } catch {
        return null
      }
    }

    const clearPendingCalendarTransaction = () => {
      window.sessionStorage.removeItem(PENDING_CALENDAR_TRANSACTION_KEY)
    }

    const run = async () => {
      const url = new URL(window.location.href)
      const flag = url.searchParams.get('calendar') || url.searchParams.get('google_calendar')
      const provider = String(url.searchParams.get('calendar_provider') || '').toLowerCase()
      const providerLabel = provider ? getCalendarProviderLabel(provider) : 'Calendar'
      const shouldContinuePending = url.searchParams.get('calendar_continue') === 'transaction_create'
      if (!flag) return

      if (flag === 'connected') {
        toast({
          title: `${providerLabel} connected`,
          description: 'New transactions with a closing date will be synced automatically.'
        })
        setIsCalendarConnectDialogOpen(false)
        await fetchCalendarStatus()
        let resumedPendingCreate = false
        if (shouldContinuePending) {
          const pending = parsePendingCalendarTransaction()
          if (pending?.transaction) {
            resumedPendingCreate = true
            await createTransaction(pending.transaction, { skipConnectionGate: true, isRetry: true })
          }
        }
        if (!resumedPendingCreate) {
          clearPendingCalendarTransaction()
        }
      } else if (flag === 'missing_config') {
        toast({
          title: `${providerLabel} is not configured`,
          description: 'Configure calendar OAuth environment variables in `.env.local`.'
        })
      } else if (flag === 'oauth_denied') {
        toast({
          title: `${providerLabel} access was denied`,
          description: 'Authorize access to enable calendar sync.'
        })
      } else if (flag === 'connect_failed') {
        const errorMsg = url.searchParams.get('calendar_error') || url.searchParams.get('google_error') || 'Calendar OAuth callback failed.'
        toast({
          title: `${providerLabel} connection failed`,
          description: errorMsg
        })
      }

      if (flag !== 'connected') {
        clearPendingCalendarTransaction()
      }

      url.searchParams.delete('calendar')
      url.searchParams.delete('calendar_provider')
      url.searchParams.delete('calendar_error')
      url.searchParams.delete('google_calendar')
      url.searchParams.delete('google_error')
      url.searchParams.delete('calendar_continue')
      window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`)
    }

    run()
  }, [])

  const fetchTransactions = async () => {
    setLoading(true)
    try {
      const response = await fetch('/api/transactions?include_open_stages=1')
      const data = await response.json()
      if (data.success) {
        const baseTransactions = Array.isArray(data.transactions) ? data.transactions : []
        setTransactions(baseTransactions)
      }
    } catch (error) {
      console.error('Error fetching transactions:', error)
    }
    setLoading(false)
  }

  const applyCalendarStatusPayload = (data = {}) => {
    const providers = Array.isArray(data?.providers) ? data.providers : []
    const byProvider = providers.reduce((acc, item) => {
      if (item?.provider) acc[item.provider] = item
      return acc
    }, {})

    const nextState = {
      loading: false,
      providers,
      configured: Boolean(data?.configured || providers.some((item) => item?.configured)),
      connected: Boolean(data?.connected || providers.some((item) => item?.connected)),
      connected_providers: Array.isArray(data?.connected_providers)
        ? data.connected_providers
        : providers.filter((item) => item?.connected).map((item) => item.provider),
      configured_providers: Array.isArray(data?.configured_providers)
        ? data.configured_providers
        : providers.filter((item) => item?.configured).map((item) => item.provider),
      byProvider
    }
    setCalendarStatus(nextState)
    return nextState
  }

  const loadPendingCalendarTransaction = () => {
    if (typeof window === 'undefined') return null
    try {
      const raw = window.sessionStorage.getItem(PENDING_CALENDAR_TRANSACTION_KEY)
      if (!raw) return null
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') return null
      if (!parsed.transaction || typeof parsed.transaction !== 'object') return null
      return parsed
    } catch {
      return null
    }
  }

  const clearPendingCalendarTransaction = () => {
    if (typeof window === 'undefined') return
    window.sessionStorage.removeItem(PENDING_CALENDAR_TRANSACTION_KEY)
  }

  const fetchCalendarStatus = async () => {
    try {
      const response = await fetch('/api/calendar/status')
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data?.success) {
        throw new Error(data?.error || 'Failed to load calendar status')
      }
      return applyCalendarStatusPayload(data)
    } catch (error) {
      console.error('Error fetching calendar status:', error)
      const fallback = {
        loading: false,
        providers: [],
        configured: false,
        connected: false,
        connected_providers: [],
        configured_providers: [],
        byProvider: {}
      }
      setCalendarStatus(fallback)
      return fallback
    }
  }

  const handleCalendarConnectDialogChange = (open) => {
    setIsCalendarConnectDialogOpen(open)
    if (open) return

    if (!connectRedirectingRef.current && calendarConnectReason === 'event_create') {
      clearPendingCalendarTransaction()
    }

    connectRedirectingRef.current = false
    setCalendarActionLoading(false)
    setCalendarConnectReason('manual')
  }

  const connectCalendarWithProvider = (provider = 'outlook') => {
    const normalizedProvider = String(provider || '').trim().toLowerCase()
    if (!['google', 'outlook'].includes(normalizedProvider)) return
    const providerLabel = getCalendarProviderLabel(normalizedProvider)
    if (!userEmail) {
      toast({
        title: 'Sign in required',
        description: `Please sign in before connecting ${providerLabel}.`
      })
      return
    }

    const pending = loadPendingCalendarTransaction()
    const returnTo = pending?.transaction
      ? '/?tab=transactions&calendar_continue=transaction_create'
      : '/?tab=transactions'

    connectRedirectingRef.current = true
    setCalendarActionLoading(true)
    setIsCalendarConnectDialogOpen(false)
    const params = new URLSearchParams({
      provider: normalizedProvider,
      returnTo,
      user_key: String(userEmail || '').trim().toLowerCase() || 'anonymous'
    })
    window.location.href = `/api/calendar/connect?${params.toString()}`
  }

  const openCalendarConnectDialog = () => {
    if (!userEmail) {
      toast({
        title: 'Sign in required',
        description: 'Please sign in before connecting a calendar.'
      })
      return
    }
    clearPendingCalendarTransaction()
    setCalendarConnectReason('manual')
    setIsCalendarConnectDialogOpen(true)
  }

  const disconnectCalendar = async () => {
    const connectedProvider = Array.isArray(calendarStatus.connected_providers) && calendarStatus.connected_providers.length > 0
      ? calendarStatus.connected_providers[0]
      : null
    const providerLabel = getCalendarProviderLabel(connectedProvider || '')
    setCalendarActionLoading(true)
    try {
      const response = await fetch('/api/calendar/disconnect', {
        method: 'POST'
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data?.success) {
        throw new Error(data?.error || 'Failed to disconnect calendar')
      }

      toast({
        title: `${providerLabel} disconnected`,
        description: 'Future transactions will not be synced until you reconnect.'
      })
      applyCalendarStatusPayload(data)
    } catch (error) {
      toast({
        title: 'Disconnect failed',
        description: error.message || 'Please try again.'
      })
    } finally {
      setCalendarActionLoading(false)
    }
  }

  const filterTransactions = () => {
    let filtered = transactions

    if (searchTerm) {
      filtered = filtered.filter(transaction =>
        transaction.property_address.toLowerCase().includes(searchTerm.toLowerCase()) ||
        transaction.client_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        transaction.assigned_agent?.toLowerCase().includes(searchTerm.toLowerCase())
      )
    }

    if (stageFilter !== 'all') {
      filtered = filtered.filter((transaction) => {
        const openStages = getOpenStages(transaction)
        if (openStages.length > 0) return openStages.includes(stageFilter)
        return transaction.current_stage === stageFilter
      })
    }

    setFilteredTransactions(filtered)
  }

  const createTransaction = async (transactionPayload = newTransaction, options = {}) => {
    const isClickEventPayload = Boolean(
      transactionPayload &&
      typeof transactionPayload === 'object' &&
      (typeof transactionPayload.preventDefault === 'function' || transactionPayload?.nativeEvent)
    )
    const sourcePayload = isClickEventPayload ? newTransaction : transactionPayload
    const payload = {
      ...sourcePayload,
      closing_date: sourcePayload?.closing_date || '',
      add_to_calendar: Boolean(sourcePayload?.add_to_calendar)
    }

    if (!payload.property_address || !payload.client_name) {
      alert('Property address and client name are required')
      return
    }

    const selectedClosingDate = payload.closing_date
    const wantsCalendarSync = Boolean(payload.add_to_calendar) && Boolean(selectedClosingDate)

    setLoading(true)
    try {
      const response = await fetch('/api/transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })

        const data = await response.json()
        if (data.success) {
          const createdTx = data.transaction || {}
          clearPendingCalendarTransaction()
        setTransactions((prev) => [{ ...createdTx, open_stages: createdTx.current_stage ? [createdTx.current_stage] : [] }, ...prev])
        setNewTransaction({
          property_address: '',
          client_name: '',
          client_email: '',
          client_phone: '',
          transaction_type: 'sale',
          assigned_agent: '',
          listing_price: '',
          closing_date: '',
          add_to_calendar: false
        })
        setIsAddDialogOpen(false)

        const calendarResult = data.calendar || data.google_calendar || null
        const responseQuickAddUrl = String(data?.quick_add_url || calendarResult?.quick_add_url || '').trim() || null
        const providerResults = Array.isArray(calendarResult?.providers) ? calendarResult.providers : []
        const successfulProviders = providerResults.filter((entry) => entry?.success)
        const attemptedOutlook =
          providerResults.some((entry) => String(entry?.provider || '').toLowerCase() === 'outlook') ||
          (Array.isArray(calendarStatus.connected_providers) &&
            calendarStatus.connected_providers.some((entry) => String(entry || '').toLowerCase() === 'outlook'))
        const successfulProviderNames = successfulProviders
          .map((entry) => getCalendarProviderLabel(entry.provider))
          .filter(Boolean)
        const firstEventLink = successfulProviders.find((entry) => entry?.event_link)?.event_link || calendarResult?.event_link || null
        const manualQuickAddUrl = wantsCalendarSync ? responseQuickAddUrl : null

        if (wantsCalendarSync && calendarResult?.success && successfulProviders.length > 0) {
          toast({
            title: 'Transaction created and synced',
            description: successfulProviderNames.length > 0
              ? `Closing date was added to ${successfulProviderNames.join(', ')}.`
              : 'Closing date was synced to connected calendars.',
            action: firstEventLink ? (
              <ToastAction
                altText="Open calendar event"
                onClick={() => window.open(firstEventLink, '_blank', 'noopener,noreferrer')}
              >
                View Event
              </ToastAction>
            ) : undefined
          })
        } else if (wantsCalendarSync && calendarResult?.partial_success && successfulProviders.length > 0) {
          toast({
            title: 'Transaction created, calendar partially synced',
            description: successfulProviderNames.length > 0
              ? `Synced to ${successfulProviderNames.join(', ')}. ${calendarResult?.error || ''}`.trim()
              : (calendarResult?.error || 'Some calendar providers could not be synced.')
          })
        } else if (wantsCalendarSync && manualQuickAddUrl) {
          if (manualQuickAddUrl) {
            console.log('OUTLOOK URL:', manualQuickAddUrl)
            window.open(manualQuickAddUrl, '_blank', 'noopener,noreferrer')
          }
          toast({
            title: calendarResult?.attempted ? 'Transaction created, calendar sync failed' : 'Transaction created',
            description: calendarResult?.attempted
              ? (calendarResult?.error || 'Calendar page opened. Save the event to confirm.')
              : 'Calendar page opened. Save the event to confirm.',
            action: (
              <ToastAction
                altText="Add closing date to calendar"
                onClick={() => window.open(manualQuickAddUrl, '_blank', 'noopener,noreferrer')}
              >
                Add to Calendar
              </ToastAction>
            )
          })
        } else if (wantsCalendarSync && calendarResult?.attempted && !calendarResult?.success) {
          if (attemptedOutlook) {
            window.open(OUTLOOK_CALENDAR_FALLBACK_URL, '_blank', 'noopener,noreferrer')
          }
          toast({
            title: 'Transaction created, calendar sync failed',
            description: calendarResult?.error || 'Please reconnect your calendar and try again.'
          })
        } else if (wantsCalendarSync && !calendarResult?.success) {
          if (attemptedOutlook) {
            window.open(OUTLOOK_CALENDAR_FALLBACK_URL, '_blank', 'noopener,noreferrer')
          }
          toast({
            title: 'Transaction created',
            description: 'Calendar sync is pending. Reconnect your calendar to sync this closing date.'
          })
        } else {
          toast({
            title: 'Transaction created',
            description: wantsCalendarSync
              ? 'Transaction saved. Connect a calendar anytime to sync future events.'
              : 'Saved without calendar sync.'
          })
        }
      } else {
        if (options?.isRetry) clearPendingCalendarTransaction()
        alert(data.error || 'Failed to create transaction')
      }
    } catch (error) {
      if (options?.isRetry) clearPendingCalendarTransaction()
      console.error('Error creating transaction:', error)
      alert('Failed to create transaction')
    } finally {
      setLoading(false)
    }
  }

  const formatCurrency = (amount) => {
    if (!amount) return ''
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
    }).format(amount)
  }

  const formatDate = (date) => {
    if (!date) return ''
    return new Date(date).toLocaleDateString()
  }

  const openDeleteDialog = (tx, e) => {
    if (e) e.stopPropagation()
    setDeleteDialog({ open: true, tx })
  }

  const handleDelete = async () => {
    if (!deleteDialog.tx) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/transactions/${deleteDialog.tx.id}`, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        throw new Error(data?.error || 'Failed to delete transaction')
      }
      setTransactions((prev) => prev.filter((t) => t.id !== deleteDialog.tx.id))
      toast({ title: 'Transaction deleted', description: `${deleteDialog.tx.property_address} removed.` })
      setDeleteDialog({ open: false, tx: null })
    } catch (err) {
      toast({ title: 'Delete failed', description: err.message || 'Please try again.' })
    } finally {
      setDeleting(false)
    }
  }

  const getStageOrder = (stage, txType) => {
    const orderedStages = Object.keys(STAGE_CONFIGS[txType] || {})
    const idx = orderedStages.indexOf(stage)
    return idx === -1 ? Number.MAX_SAFE_INTEGER : idx
  }

  const getOpenStages = (transaction) => {
    const txType = (transaction?.transaction_type || 'sale').toLowerCase()
    const stageHistory = Array.isArray(transaction?.stage_history) ? transaction.stage_history : []
    const scoped = new Set(
      stageHistory
        .filter((entry) => {
          if (!entry || !entry.stage) return false
          if (entry.forced === true) return true
          return entry?.validation_result?.valid === false
        })
        .flatMap((entry) => [entry.stage, entry.transitioned_from].filter(Boolean))
    )

    if (Array.isArray(transaction?.open_stages)) {
      transaction.open_stages.filter(Boolean).forEach((stage) => scoped.add(stage))
    }
    if (transaction?.current_stage) scoped.add(transaction.current_stage)

    return Array.from(scoped).sort((a, b) => getStageOrder(a, txType) - getStageOrder(b, txType))
  }

  const providerOptions = Array.isArray(calendarStatus.providers) && calendarStatus.providers.length > 0
    ? calendarStatus.providers.map((entry) => ({
      id: entry.provider,
      label: getCalendarProviderLabel(entry.provider),
      configured: Boolean(entry.configured),
      connected: Boolean(entry.connected),
      connected_email: entry.connected_email || null
    }))
    : CALENDAR_PROVIDER_OPTIONS.map((entry) => ({
      ...entry,
      configured: false,
      connected: false,
      connected_email: null
    }))

  const connectedProviderEntry = providerOptions.find((entry) => entry.connected) || null
  const connectedProviderLabel = connectedProviderEntry?.label || 'Calendar'
  const anyProviderConfigured = providerOptions.some((entry) => entry.configured)
  const googleOption = providerOptions.find((entry) => entry.id === 'google') || { configured: false }
  const outlookOption = providerOptions.find((entry) => entry.id === 'outlook') || { configured: false }
  const recommendedProvider = getRecommendedProviderFromEmail(userEmail)
  const googleRecommended = recommendedProvider === 'google'
  const outlookRecommended = recommendedProvider === 'outlook'

  if (selectedTransaction) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <Button 
            variant="outline" 
            onClick={async () => {
              setSelectedTransaction(null)
              setFocusTarget(null)
              await fetchTransactions()
            }}
          >
            &lt;- Back to Transactions
          </Button>
          <h2 className="text-2xl font-bold">Transaction Timeline</h2>
        </div>
        <TransactionTimeline
          transactionId={selectedTransaction.id}
          focusTaskId={focusTarget?.taskId || null}
          focusStage={focusTarget?.stage || null}
          onFocusHandled={() => setFocusTarget(null)}
        />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold">Transaction Management</h2>
          <p className="text-muted-foreground">Manage your real estate transactions with timeline checklists</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={calendarStatus.connected ? 'outline' : 'default'}
            onClick={openCalendarConnectDialog}
            disabled={
              calendarStatus.loading ||
              calendarActionLoading ||
              !anyProviderConfigured ||
              authLoading ||
              !isSignedIn ||
              !userEmail ||
              calendarStatus.connected
            }
          >
            <Calendar className="mr-2 h-4 w-4" />
            {calendarStatus.connected ? `${connectedProviderLabel} Connected` : 'Connect Calendar'}
          </Button>
          {calendarStatus.connected && (
            <Button
              variant="ghost"
              onClick={disconnectCalendar}
              disabled={calendarActionLoading}
            >
              Disconnect
            </Button>
          )}
          <Button onClick={() => setIsAddDialogOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New Transaction
          </Button>
        </div>
      </div>
      {!calendarStatus.loading && !calendarStatus.configured && (
        <p className="text-sm text-muted-foreground">
          Calendar sync is disabled. Set Google (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`) and/or Microsoft (`MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT`, `MICROSOFT_REDIRECT_URI`) variables in `.env.local`.
        </p>
      )}
      {!calendarStatus.loading && calendarStatus.connected && (
        <p className="text-sm text-muted-foreground">
          Synced accounts: {providerOptions
            .filter((entry) => entry.connected)
            .map((entry) => `${entry.label}${entry.connected_email ? ` (${entry.connected_email})` : ''}`)
            .join(' | ')}
        </p>
      )}
      <Dialog open={isCalendarConnectDialogOpen} onOpenChange={handleCalendarConnectDialogChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Connect your calendar</DialogTitle>
            <DialogDescription>
              To sync this event, please connect your calendar
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Button
              className="w-full justify-start"
              variant={googleRecommended ? 'default' : 'outline'}
              onClick={() => connectCalendarWithProvider('google')}
              disabled={calendarActionLoading || !googleOption.configured}
            >
              <span className="flex items-center justify-between w-full">
                <span>Continue with Google</span>
                {googleRecommended && <span className="text-xs opacity-80">Recommended</span>}
              </span>
            </Button>
            {!googleOption.configured && (
              <p className="text-xs text-muted-foreground">Google provider is not configured in environment variables.</p>
            )}
            <Button
              className="w-full justify-start"
              variant={outlookRecommended ? 'default' : 'outline'}
              onClick={() => connectCalendarWithProvider('outlook')}
              disabled={calendarActionLoading || !outlookOption.configured}
            >
              <span className="flex items-center justify-between w-full">
                <span>Continue with Outlook</span>
                {outlookRecommended && <span className="text-xs opacity-80">Recommended</span>}
              </span>
            </Button>
            {!outlookOption.configured && (
              <p className="text-xs text-muted-foreground">Microsoft provider is not configured in environment variables.</p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Search and Filters */}
      <div className="flex flex-col sm:flex-row gap-4">
        <div className="flex-1">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by property address, client, or agent..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10"
            />
          </div>
        </div>
        <Select value={stageFilter} onValueChange={setStageFilter}>
          <SelectTrigger className="w-full sm:w-48">
            <SelectValue placeholder="Filter by stage" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Stages</SelectItem>
            {/* Show union of sale + purchase stages */}
            {Array.from(new Set([
              ...Object.keys(STAGE_CONFIGS.sale),
              ...Object.keys(STAGE_CONFIGS.purchase)
            ])).map((key) => {
              const stage = STAGE_CONFIGS.sale[key] || STAGE_CONFIGS.purchase[key]
              return (
                <SelectItem key={key} value={key}>{stage.name}</SelectItem>
              )
            })}
          </SelectContent>
        </Select>
      </div>

      {/* Transactions Grid */}
      {loading && transactions.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
            <p>Loading transactions...</p>
          </div>
        </div>
      ) : filteredTransactions.length > 0 ? (
        <div className="grid gap-6">
          {filteredTransactions.map((transaction) => {
            const tType = transaction.transaction_type || 'sale'
            const openStages = getOpenStages(transaction)
            
            return (
              <Card key={transaction.id} className="hover:shadow-md transition-shadow cursor-pointer"
                    onClick={() => setSelectedTransaction(transaction)}>
                <CardContent className="p-6">
                  <div className="flex items-start justify-between">
                    <div className="space-y-3 flex-1">
                      <div className="flex items-start justify-between">
                        <div>
                          <h3 className="text-lg font-semibold">{transaction.property_address}</h3>
                          <p className="text-muted-foreground">Client: {transaction.client_name}</p>
                        </div>
                        <div className="flex flex-wrap justify-end gap-2 pl-4">
                          {(openStages.length > 0 ? openStages : [transaction.current_stage]).map((stageKey) => {
                            const badgeCfg = (STAGE_CONFIGS[tType] && STAGE_CONFIGS[tType][stageKey]) || {}
                            const BadgeIcon = badgeCfg.icon || FileText
                            return (
                              <Badge key={`${transaction.id}-${stageKey}`} className={`${badgeCfg.color || 'bg-gray-500'} text-white`}>
                                <BadgeIcon className="mr-1 h-3 w-3" />
                                {badgeCfg.name || formatStageLabel(stageKey)}
                              </Badge>
                            )
                          })}
                        </div>
                      </div>
                      
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
                        <div className="flex items-center gap-2">
                          <User className="h-4 w-4 text-muted-foreground" />
                          <span>Agent: {transaction.assigned_agent || 'Unassigned'}</span>
                        </div>
                        
                        <div className="flex items-center gap-2">
                          <Home className="h-4 w-4 text-muted-foreground" />
                          <span>Type: {transaction.transaction_type}</span>
                        </div>
                        
                        <div className="flex items-center gap-2">
                          <Calendar className="h-4 w-4 text-muted-foreground" />
                          <span>Created: {formatDate(transaction.created_at)}</span>
                        </div>
                      </div>
                      
                      {(transaction.listing_price || transaction.contract_price) && (
                        <div className="flex items-center gap-4 text-sm">
                          {transaction.listing_price && (
                            <div className="flex items-center gap-1">
                              <DollarSign className="h-4 w-4 text-muted-foreground" />
                              <span>Listed: {formatCurrency(transaction.listing_price)}</span>
                            </div>
                          )}
                          {transaction.contract_price && (
                            <div className="flex items-center gap-1">
                              <DollarSign className="h-4 w-4 text-muted-foreground" />
                              <span>Contract: {formatCurrency(transaction.contract_price)}</span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    
                    <div className="flex items-center gap-1 sm:gap-2">
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="text-destructive hover:bg-destructive/10"
                              onClick={(e) => openDeleteDialog(transaction, e)}
                              aria-label="Delete transaction"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Delete</TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                      <Button variant="ghost" size="icon" aria-label="Open">
                        <ArrowRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      ) : (
        <Card>
          <CardContent className="p-12 text-center">
            <FileText className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No transactions found</h3>
            <p className="text-muted-foreground mb-4">
              {searchTerm || stageFilter !== 'all' 
                ? 'Try adjusting your search or filters'
                : 'Create your first transaction to get started with timeline management'
              }
            </p>
            <Button onClick={() => setIsAddDialogOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              New Transaction
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Add Transaction Dialog */}
      <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Create New Transaction</DialogTitle>
            <DialogDescription>
              Set up a new real estate transaction with timeline tracking
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4">
              <div className="space-y-2">
                <Label htmlFor="property-address">Property Address *</Label>
                <Input
                  id="property-address"
                  value={newTransaction.property_address}
                  onChange={(e) => setNewTransaction({...newTransaction, property_address: e.target.value})}
                  placeholder="123 Main Street, City, State, ZIP"
                />
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="client-name">Client Name *</Label>
                  <Input
                    id="client-name"
                    value={newTransaction.client_name}
                    onChange={(e) => setNewTransaction({...newTransaction, client_name: e.target.value})}
                    placeholder="John Smith"
                  />
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="transaction-type">Transaction Type</Label>
                  <Select 
                    value={newTransaction.transaction_type} 
                    onValueChange={(value) => setNewTransaction({...newTransaction, transaction_type: value})}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="sale">Sale</SelectItem>
                      <SelectItem value="purchase">Purchase</SelectItem>
                      <SelectItem value="lease">Lease</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="client-email">Client Email</Label>
                  <Input
                    id="client-email"
                    type="email"
                    value={newTransaction.client_email}
                    onChange={(e) => setNewTransaction({...newTransaction, client_email: e.target.value})}
                    placeholder="client@email.com"
                  />
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="client-phone">Client Phone</Label>
                  <Input
                    id="client-phone"
                    value={newTransaction.client_phone}
                    onChange={(e) => setNewTransaction({...newTransaction, client_phone: e.target.value})}
                    placeholder="(555) 123-4567"
                  />
                </div>
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="assigned-agent">Assigned Agent</Label>
                  <Input
                    id="assigned-agent"
                    value={newTransaction.assigned_agent}
                    onChange={(e) => setNewTransaction({...newTransaction, assigned_agent: e.target.value})}
                    placeholder="Agent Name"
                  />
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="listing-price">Listing Price</Label>
                  <Input
                    id="listing-price"
                    type="number"
                    value={newTransaction.listing_price}
                    onChange={(e) => setNewTransaction({...newTransaction, listing_price: e.target.value})}
                    placeholder="500000"
                  />
                </div>
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="closing-date">Expected Closing Date</Label>
                <Input
                  id="closing-date"
                  type="date"
                  value={newTransaction.closing_date}
                  onChange={(e) => {
                    const nextDate = e.target.value
                    setNewTransaction((prev) => ({
                      ...prev,
                      closing_date: nextDate,
                      add_to_calendar: nextDate ? prev.add_to_calendar : false
                    }))
                  }}
                />
              </div>
              <div className="rounded-md border p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <Label htmlFor="add-calendar-toggle" className="text-sm font-medium">Add this to calendar</Label>
                    <p className="text-xs text-muted-foreground">
                      Optional. Enable only if you want this transaction synced to Google/Outlook.
                    </p>
                  </div>
                  <Switch
                    id="add-calendar-toggle"
                    checked={Boolean(newTransaction.add_to_calendar)}
                    onCheckedChange={(checked) => {
                      const hasClosingDate = Boolean(newTransaction.closing_date)
                      setNewTransaction((prev) => ({
                        ...prev,
                        add_to_calendar: hasClosingDate ? Boolean(checked) : false
                      }))
                    }}
                    disabled={!newTransaction.closing_date}
                  />
                </div>
                {!newTransaction.closing_date && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Add a closing date first to enable calendar sync.
                  </p>
                )}
                {newTransaction.closing_date && newTransaction.add_to_calendar && !calendarStatus.connected && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    No calendar connected. Transaction will still be created; you can connect later from the top button.
                  </p>
                )}
              </div>
            </div>
          </div>
          
          <div className="flex justify-end space-x-2 pt-4">
            <Button variant="outline" onClick={() => setIsAddDialogOpen(false)}>
              Cancel
            </Button>
            <Button 
              onClick={() => createTransaction()} 
              disabled={!newTransaction.property_address || !newTransaction.client_name || loading}
            >
              {loading ? 'Creating...' : 'Create Transaction'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialog.open} onOpenChange={(open) => setDeleteDialog((prev) => ({ ...prev, open }))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this transaction?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove the transaction{deleteDialog.tx ? ` for ${deleteDialog.tx.property_address}` : ''} and its checklist items. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={deleting}>
              {deleting ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
