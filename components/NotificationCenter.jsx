"use client";

import { useEffect, useMemo, useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Bell, RefreshCcw, Check, Clock, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || ''
const apiUrl = (path) => `${API_BASE}${path}`

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts)
  const text = await res.text().catch(() => '')
  let json = null
  try { json = text ? JSON.parse(text) : null } catch (_) { json = null }

  if (!res.ok) {
    const msg = json?.error || json?.message || `HTTP ${res.status}`
    throw new Error(msg)
  }

  if (json !== null) return json
  throw new Error('API returned non-JSON response')
}

export function NotificationBell() {
  const [open, setOpen] = useState(false)
  const [counts, setCounts] = useState({ total: 0, unread: 0 })
  const { toast } = useToast()

  const loadCount = async () => {
    try {
      const data = await fetchJSON(apiUrl('/api/notifications?countOnly=1'))
      setCounts({ total: data.total || 0, unread: data.unread || 0 })
    } catch {}
  }

  useEffect(() => {
    loadCount()
    const t = setInterval(loadCount, 30000)
    return () => clearInterval(t)
  }, [])

  // Listen globally for reminders so user gets a toast even if drawer is closed
  useEffect(() => {
    let es
    try {
      es = new EventSource(apiUrl('/api/assistant/stream'))
      es.addEventListener('notifications:remind', (e) => {
        try {
          const p = JSON.parse(e.data || '{}')
          toast({ title: p.title || 'Reminder', description: p.message || '' })
          // Try browser notification too
          if (typeof window !== 'undefined' && 'Notification' in window) {
            if (Notification.permission === 'granted') {
              new Notification(p.title || 'Reminder', { body: p.message || '', icon: '/snaphomz-logo.svg' })
            }
          }
        } catch {}
        setTimeout(loadCount, 250)
      })
    } catch {}
    return () => { try { es && es.close() } catch {} }
  }, [])

  // When sheet closes, refresh counters (in case actions happened)
  const onOpenChange = (v) => { setOpen(v); if (!v) setTimeout(loadCount, 500) }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild>
        <button className="relative inline-flex h-9 w-9 items-center justify-center rounded-md border bg-background hover:bg-muted">
          <Bell className="h-4 w-4" />
          {counts.unread > 0 && (
            <span className="absolute -top-1 -right-1 flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-destructive px-1 text-[11px] font-medium text-destructive-foreground">
              {counts.unread}
            </span>
          )}
          <span className="sr-only">Notifications</span>
        </button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="flex items-center justify-between">
            <span>Notifications</span>
            <Button variant="ghost" size="icon" onClick={() => setOpen(false)}>
              <Check className="h-4 w-4" />
            </Button>
          </SheetTitle>
        </SheetHeader>
        <div className="mt-3">
          <NotificationCenter onAnyAction={loadCount} />
        </div>
      </SheetContent>
    </Sheet>
  )
}

export function NotificationCenter({ onAnyAction }) {
  const [tab, setTab] = useState('all')
  const [loading, setLoading] = useState(false)
  const [notifications, setNotifications] = useState([])
  const [alerts, setAlerts] = useState([])
  const { toast } = useToast()

  const loadAll = async () => {
    setLoading(true)
    try {
      const [notifRes, alertRes] = await Promise.all([
        fetchJSON(apiUrl('/api/notifications?limit=100')),
        fetchJSON(apiUrl('/api/alerts/smart'))
      ])
      setNotifications(notifRes.notifications || [])
      setAlerts(alertRes.alerts || [])
    } catch (e) {
      toast({ title: 'Failed to load notifications', description: e.message || 'Please try again', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadAll() }, [])

  // Realtime refresh on server events
  useEffect(() => {
    let es
    try {
      es = new EventSource(apiUrl('/api/assistant/stream'))
      const refresh = () => setTimeout(loadAll, 150)
      es.addEventListener('notifications:changed', refresh)
      es.addEventListener('alerts:changed', refresh)
    } catch {}
    return () => { try { es && es.close() } catch {} }
  }, [])

  const unreadCount = useMemo(() => notifications.filter(n => n.status !== 'read').length, [notifications])
  const allItems = useMemo(() => {
    const notifs = notifications.map(n => ({ ...n, kind: 'notification' }))
    const al = alerts.map(a => ({ ...a, kind: 'alert' }))
    if (tab === 'notifications') return notifs
    if (tab === 'alerts') return al
    return [...notifs, ...al].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
  }, [notifications, alerts, tab])

  const markRead = async (id) => {
    try { await fetchJSON(apiUrl(`/api/notifications/${id}/read`), { method: 'POST' }); await loadAll(); onAnyAction && onAnyAction() } catch {}
  }
  const snooze = async (id, minutes) => {
    try { await fetchJSON(apiUrl(`/api/notifications/${id}/snooze`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ minutes }) }); await loadAll(); onAnyAction && onAnyAction() } catch {}
  }
  const clearRead = async () => {
    try { await fetchJSON(apiUrl('/api/notifications/clear-read'), { method: 'POST' }); await loadAll(); onAnyAction && onAnyAction() } catch {}
  }
  const dismissAlert = async (id) => {
    try { await fetchJSON(apiUrl(`/api/alerts/dismiss/${id}`), { method: 'POST' }); await loadAll(); onAnyAction && onAnyAction() } catch {}
  }

  const fmt = (d) => {
    const dt = new Date(d)
    if (isNaN(dt.getTime())) return '—'
    return dt.toLocaleString()
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <Tabs value={tab} onValueChange={setTab} className="w-auto">
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="notifications">Notifications</TabsTrigger>
            <TabsTrigger value="alerts">Alerts</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" onClick={loadAll} disabled={loading}><RefreshCcw className="h-4 w-4" /></Button>
          <Button variant="ghost" size="sm" onClick={clearRead}>
            <Trash2 className="h-4 w-4 mr-1" /> Clear read
          </Button>
        </div>
      </div>

      <div className="text-xs text-muted-foreground">Unread: {unreadCount}</div>

      <div className="max-h-[70vh] overflow-auto space-y-2 pr-1">
        {allItems.length === 0 && (
          <div className="text-sm text-muted-foreground py-8 text-center">No items</div>
        )}

        {allItems.map((item) => (
          <div key={`${item.kind}:${item.id}`} className="rounded-md border p-3 bg-background">
            <div className="flex items-start justify-between gap-2">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <Badge variant={item.kind === 'alert' ? 'destructive' : 'secondary'}>
                    {item.kind}
                  </Badge>
                  {item.priority && <Badge variant="outline">{item.priority}</Badge>}
                  {item.status && <Badge variant="outline">{item.status}</Badge>}
                </div>
                <div className="font-medium text-sm">{item.title || item.message || item.alert_type || 'Untitled'}</div>
                {item.message && <div className="text-sm text-muted-foreground">{item.message}</div>}
                <div className="text-xs text-muted-foreground flex items-center gap-1"><Clock className="h-3 w-3" /> {fmt(item.created_at)}</div>
              </div>

              <div className="flex items-center gap-1">
                {item.kind === 'notification' ? (
                  <>
                    {item.status !== 'read' && (
                      <Button size="sm" variant="outline" onClick={() => markRead(item.id)}>
                        <Check className="h-3.5 w-3.5 mr-1" /> Read
                      </Button>
                    )}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="sm" variant="ghost">Snooze</Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => snooze(item.id, 15)}>15 min</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => snooze(item.id, 60)}>1 hour</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => snooze(item.id, 24 * 60)}>1 day</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => dismissAlert(item.id)}>Dismiss</Button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

