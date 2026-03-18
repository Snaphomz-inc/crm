'use client'

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Progress } from '@/components/ui/progress'
import { 
  MessageSquare, 
  Send, 
  AlertTriangle,
  Clock,
  CheckCircle,
  Bell,
  X,
  Calendar,
  TrendingDown,
  AlertCircle,
  Home,
  User,
  FileText,
  Activity,
  Target,
  Lightbulb,
  Timer,
  Loader2
} from 'lucide-react'

const ALERT_PRIORITY_CONFIG = {
  low: { color: 'bg-gray-100 text-gray-700', icon: Bell },
  medium: { color: 'bg-blue-100 text-blue-700', icon: Clock },
  high: { color: 'bg-orange-100 text-orange-700', icon: AlertTriangle },
  urgent: { color: 'bg-red-100 text-red-700', icon: AlertCircle }
}

const ALERT_TYPE_CONFIG = {
  overdue_tasks: { name: 'Overdue Tasks', icon: Clock },
  deal_inactivity: { name: 'Deal Inactive', icon: TrendingDown },
  closing_approaching: { name: 'Closing Soon', icon: Calendar }
}

const PRIORITY_LEVELS = ['urgent', 'high', 'medium', 'low']
const EMPTY_TASK_PRIORITY_COUNTS = { urgent: 0, high: 0, medium: 0, low: 0 }
const createEmptyTaskPriorityGroups = () => ({ urgent: [], high: [], medium: [], low: [] })
const formatStageLabel = (stage = '') =>
  String(stage)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())

export function DealCommand() {
  const [command, setCommand] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)
  const [commandHistory, setCommandHistory] = useState([])

  const executeCommand = async () => {
    if (!command.trim()) return

    setLoading(true)
    try {
      const response = await fetch('/api/agent/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: command.trim() })
      })

      const data = await response.json()
      
      const commandEntry = {
        id: Date.now().toString(),
        command: command.trim(),
        result: data,
        timestamp: new Date()
      }
      
      setCommandHistory(prev => [commandEntry, ...prev.slice(0, 9)]) // Keep last 10
      setResult(data)
      setCommand('')
    } catch (error) {
      console.error('Command execution error:', error)
      setResult({
        success: false,
        error: 'Failed to execute command'
      })
    }
    setLoading(false)
  }

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !loading) {
      executeCommand()
    }
  }

  const DealSummaryDisplay = ({ summary }) => (
    <div className="space-y-6">
      {/* Transaction Overview */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Home className="h-5 w-5" />
                {summary.transaction.property_address}
              </CardTitle>
              <CardDescription>
                Client: {summary.transaction.client_name} | Type: {summary.transaction.transaction_type}
              </CardDescription>
            </div>
            <Badge variant="outline" className="text-lg px-3 py-1">
              {summary.transaction.current_stage.replace('_', ' ')}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="text-center">
              <div className="text-2xl font-bold text-green-600">
                {summary.checklist_summary.completed_tasks}
              </div>
              <p className="text-sm text-muted-foreground">Completed</p>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-blue-600">
                {summary.checklist_summary.total_tasks}
              </div>
              <p className="text-sm text-muted-foreground">Total Tasks</p>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-orange-600">
                {summary.checklist_summary.overdue_tasks}
              </div>
              <p className="text-sm text-muted-foreground">Overdue</p>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-purple-600">
                {summary.checklist_summary.current_stage_progress}%
              </div>
              <p className="text-sm text-muted-foreground">Stage Progress</p>
            </div>
          </div>
          
          <div className="mt-4">
            <div className="flex justify-between text-sm mb-2">
              <span>Current Stage Progress</span>
              <span>{summary.checklist_summary.current_stage_progress}%</span>
            </div>
            <Progress value={summary.checklist_summary.current_stage_progress} className="h-2" />
          </div>
        </CardContent>
      </Card>

      {/* AI Analysis */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5" />
            AI Analysis
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <h4 className="font-semibold mb-2">Summary</h4>
            <p className="text-sm">{summary.ai_analysis.summary}</p>
          </div>
          
          <div>
            <h4 className="font-semibold mb-2">Current Status</h4>
            <p className="text-sm">{summary.ai_analysis.current_status}</p>
          </div>
          
          <div>
            <h4 className="font-semibold mb-2">Progress Assessment</h4>
            <p className="text-sm">{summary.ai_analysis.progress_assessment}</p>
          </div>
        </CardContent>
      </Card>

      {/* Critical Actions & Next Steps */}
      <div className="grid md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-red-600">
              <AlertTriangle className="h-5 w-5" />
              Critical Actions
            </CardTitle>
          </CardHeader>
          <CardContent>
            {summary.ai_analysis.critical_actions?.length > 0 ? (
              <ul className="space-y-2">
                {summary.ai_analysis.critical_actions.map((action, index) => (
                  <li key={index} className="flex items-start gap-2 text-sm">
                    <AlertTriangle className="h-4 w-4 text-red-500 mt-0.5 flex-shrink-0" />
                    {action}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No critical actions at this time</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-blue-600">
              <Target className="h-5 w-5" />
              Next Steps
            </CardTitle>
          </CardHeader>
          <CardContent>
            {summary.ai_analysis.next_steps?.length > 0 ? (
              <ul className="space-y-2">
                {summary.ai_analysis.next_steps.map((step, index) => (
                  <li key={index} className="flex items-start gap-2 text-sm">
                    <CheckCircle className="h-4 w-4 text-blue-500 mt-0.5 flex-shrink-0" />
                    {step}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No next steps defined</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Overdue Tasks */}
      {summary.overdue_tasks?.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-orange-600">
              <Clock className="h-5 w-5" />
              Overdue Tasks ({summary.overdue_tasks.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {summary.overdue_tasks.slice(0, 5).map((task, index) => (
                <div key={index} className="flex items-center justify-between p-3 bg-orange-50 rounded-lg">
                  <div>
                    <h5 className="font-medium">{task.title}</h5>
                    <p className="text-sm text-muted-foreground">
                      Due: {new Date(task.due_date).toLocaleDateString()} | 
                      Priority: {task.priority}
                    </p>
                  </div>
                  <Badge variant="outline" className="text-orange-600">
                    {Math.ceil((new Date() - new Date(task.due_date)) / (1000 * 60 * 60 * 24))} days overdue
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recommendations */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-green-600">
            <Lightbulb className="h-5 w-5" />
            Recommendations
          </CardTitle>
        </CardHeader>
        <CardContent>
          {summary.ai_analysis.recommendations?.length > 0 ? (
            <ul className="space-y-2">
              {summary.ai_analysis.recommendations.map((recommendation, index) => (
                <li key={index} className="flex items-start gap-2 text-sm">
                  <Lightbulb className="h-4 w-4 text-green-500 mt-0.5 flex-shrink-0" />
                  {recommendation}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No specific recommendations at this time</p>
          )}
        </CardContent>
      </Card>

      {/* Timeline Outlook */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Timer className="h-5 w-5" />
            Timeline Outlook
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm">{summary.ai_analysis.timeline_outlook}</p>
          <div className="mt-3 text-xs text-muted-foreground">
            Summary generated: {new Date(summary.generated_at).toLocaleString()}
          </div>
        </CardContent>
      </Card>
    </div>
  )

  return (
    <div className="space-y-6">
      {/* Command Interface */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MessageSquare className="h-5 w-5" />
            Agent Command Interface
          </CardTitle>
          <CardDescription>
            Try: "Summarize 125 Maple Ave deal" or "Show me overdue tasks"
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <Input
              placeholder="Enter your command..."
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyPress={handleKeyPress}
              disabled={loading}
              className="flex-1"
            />
            <Button 
              onClick={executeCommand}
              disabled={!command.trim() || loading}
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Command Result */}
      {result && (
        <Card>
          <CardHeader>
            <CardTitle>Command Result</CardTitle>
          </CardHeader>
          <CardContent>
            {result.success ? (
              result.action === 'deal_summary' ? (
                <DealSummaryDisplay summary={result} />
              ) : result.action === 'alerts' ? (
                <div>Alerts functionality coming soon</div>
              ) : (
                <pre className="text-sm">{JSON.stringify(result, null, 2)}</pre>
              )
            ) : (
              <div className="flex items-center gap-2 text-red-600">
                <AlertCircle className="h-4 w-4" />
                {result.error}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Command History */}
      {commandHistory.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Recent Commands</CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-48">
              <div className="space-y-2">
                {commandHistory.map((entry, index) => (
                  <div key={entry.id} className="flex items-center justify-between text-sm p-2 bg-muted rounded">
                    <span>"{entry.command}"</span>
                    <div className="flex items-center gap-2">
                      {entry.result.success ? (
                        <CheckCircle className="h-4 w-4 text-green-500" />
                      ) : (
                        <AlertCircle className="h-4 w-4 text-red-500" />
                      )}
                      <span className="text-xs text-muted-foreground">
                        {entry.timestamp.toLocaleTimeString()}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

export function SmartAlerts() {
  const [alerts, setAlerts] = useState([])
  const [taskPriorityCounts, setTaskPriorityCounts] = useState(EMPTY_TASK_PRIORITY_COUNTS)
  const [taskPriorityGroups, setTaskPriorityGroups] = useState(() => createEmptyTaskPriorityGroups())
  const [loading, setLoading] = useState(false)
  const [taskDialog, setTaskDialog] = useState({ open: false, alert: null })
  const [priorityDialog, setPriorityDialog] = useState({ open: false, priority: null })
  const [filters, setFilters] = useState({
    priority: 'all',
    type: 'all'
  })

  useEffect(() => {
    fetchAlerts()
  }, [filters])

  useEffect(() => {
    let es
    let timer = null
    const scheduleRefresh = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        fetchAlerts()
      }, 250)
    }

    try {
      es = new EventSource('/api/assistant/stream')
      es.addEventListener('ready', scheduleRefresh)
      es.addEventListener('tasks:changed', scheduleRefresh)
      es.addEventListener('alerts:changed', scheduleRefresh)
      es.addEventListener('suggestions:update', scheduleRefresh)
      es.onerror = () => { try { es.close() } catch {} }
    } catch (_) {
      // Ignore SSE setup issues; manual refresh remains available.
    }

    return () => {
      if (timer) clearTimeout(timer)
      try { es && es.close() } catch {}
    }
  }, [])

  const getPriorityBadgeClasses = (priority) => {
    const normalized = String(priority || 'medium').toLowerCase()
    const base = ALERT_PRIORITY_CONFIG[normalized]?.color || ALERT_PRIORITY_CONFIG.medium.color
    return `${base} border-0 capitalize`
  }

  const fetchTaskPriorityCounts = async () => {
    const txRes = await fetch('/api/transactions')
    const txData = await txRes.json()
    if (!txRes.ok || txData?.success === false) {
      throw new Error(txData?.error || 'Failed to fetch transactions')
    }

    const txList = Array.isArray(txData?.transactions)
      ? txData.transactions
      : (Array.isArray(txData) ? txData : [])

    if (!txList.length) {
      return {
        counts: { ...EMPTY_TASK_PRIORITY_COUNTS },
        groups: createEmptyTaskPriorityGroups()
      }
    }

    const checklistResults = await Promise.all(
      txList.map(async (tx) => {
        const res = await fetch(`/api/transactions/${tx.id}/checklist`)
        const data = await res.json()
        return { ok: res.ok, data }
      })
    )

    const counts = { ...EMPTY_TASK_PRIORITY_COUNTS }
    const groups = createEmptyTaskPriorityGroups()
    let validChecklistResponses = 0

    checklistResults.forEach(({ ok, data }, txIndex) => {
      if (!ok || !data?.success || !Array.isArray(data.checklist_items)) return
      validChecklistResponses += 1
      const tx = txList[txIndex] || {}

      data.checklist_items.forEach((task) => {
        if (task?.status === 'completed') return
        const priority = String(task?.priority || 'medium').toLowerCase()
        if (Object.prototype.hasOwnProperty.call(counts, priority)) {
          counts[priority] += 1
          groups[priority].push({
            id: task.id,
            title: task.title || 'Untitled task',
            due_date: task.due_date || null,
            stage: task.stage || '',
            transaction_id: tx.id || '',
            property_address: tx.property_address || 'Unknown address'
          })
        }
      })
    })

    if (validChecklistResponses === 0) {
      throw new Error('Failed to fetch checklist data')
    }

    PRIORITY_LEVELS.forEach((priority) => {
      groups[priority] = groups[priority]
        .slice()
        .sort((a, b) => {
          const ad = a?.due_date ? new Date(a.due_date).getTime() : Number.POSITIVE_INFINITY
          const bd = b?.due_date ? new Date(b.due_date).getTime() : Number.POSITIVE_INFINITY
          if (ad !== bd) return ad - bd
          return String(a?.title || '').localeCompare(String(b?.title || ''))
        })
    })

    return { counts, groups }
  }

  const fetchAlerts = async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (filters.priority !== 'all') params.append('priority', filters.priority)
      if (filters.type !== 'all') params.append('type', filters.type)

      const [alertsResult, countsResult] = await Promise.allSettled([
        fetch(`/api/alerts/smart?${params.toString()}`).then(async (response) => {
          const data = await response.json()
          return { ok: response.ok, data }
        }),
        fetchTaskPriorityCounts()
      ])

      if (alertsResult.status === 'fulfilled' && alertsResult.value?.ok && alertsResult.value?.data?.success) {
        setAlerts(alertsResult.value.data.alerts || [])
      } else if (alertsResult.status === 'rejected') {
        console.error('Error fetching alerts:', alertsResult.reason)
      }

      if (countsResult.status === 'fulfilled') {
        setTaskPriorityCounts(countsResult.value.counts)
        setTaskPriorityGroups(countsResult.value.groups)
      } else {
        console.error('Error fetching task priority counts:', countsResult.reason)
        setTaskPriorityCounts({ ...EMPTY_TASK_PRIORITY_COUNTS })
        setTaskPriorityGroups(createEmptyTaskPriorityGroups())
      }
    } catch (error) {
      console.error('Error fetching alerts:', error)
      setTaskPriorityCounts({ ...EMPTY_TASK_PRIORITY_COUNTS })
      setTaskPriorityGroups(createEmptyTaskPriorityGroups())
    }
    setLoading(false)
  }

  const dismissAlert = async (alertId) => {
    try {
      const response = await fetch(`/api/alerts/dismiss/${alertId}`, {
        method: 'POST'
      })
      
      if (response.ok) {
        setAlerts(alerts.filter(alert => alert.id !== alertId))
      }
    } catch (error) {
      console.error('Error dismissing alert:', error)
    }
  }

  const generateAlerts = async () => {
    setLoading(true)
    try {
      await fetch('/api/alerts/generate', { method: 'POST' })
      await fetchAlerts()
    } catch (error) {
      console.error('Error generating alerts:', error)
    }
    setLoading(false)
  }

  const focusTaskFromAlert = (alert, task) => {
    const transactionId = alert?.transaction_id
    const taskId = task?.id
    if (!transactionId || !taskId || typeof window === 'undefined') return

    window.dispatchEvent(new CustomEvent('crm:focus-task', {
      detail: {
        transactionId,
        taskId,
        stage: task.stage || null
      }
    }))
    setTaskDialog({ open: false, alert: null })
  }

  const focusTaskFromPriorityDialog = (task) => {
    const transactionId = task?.transaction_id
    const taskId = task?.id
    if (!transactionId || !taskId || typeof window === 'undefined') return

    window.dispatchEvent(new CustomEvent('crm:focus-task', {
      detail: {
        transactionId,
        taskId,
        stage: task.stage || null
      }
    }))
    setPriorityDialog({ open: false, priority: null })
  }

  const AlertCard = ({ alert }) => {
    const priorityConfig = ALERT_PRIORITY_CONFIG[alert.priority] || ALERT_PRIORITY_CONFIG.medium
    const typeConfig = ALERT_TYPE_CONFIG[alert.alert_type] || ALERT_TYPE_CONFIG.overdue_tasks
    const PriorityIcon = priorityConfig.icon
    const closingDateLabel = alert?.details?.closing_date
      ? new Date(alert.details.closing_date).toLocaleDateString()
      : new Date(alert.created_at).toLocaleDateString()
    const openStages = Array.from(
      new Set(
        (Array.isArray(alert?.details?.open_stages) ? alert.details.open_stages : [alert?.details?.current_stage])
          .filter(Boolean)
      )
    )
    const remainingTaskList = Array.isArray(alert?.details?.remaining_tasks) ? alert.details.remaining_tasks : []
    const remainingTasks = remainingTaskList.length || Number(alert?.details?.incomplete_tasks || 0)
    const isClosingAlert = alert.alert_type === 'closing_approaching'

    return (
      <Card className="hover:shadow-sm transition-shadow">
        <CardContent className="p-4">
          <div className="flex items-start justify-between">
            <div className="flex items-start gap-3 flex-1">
              <div className={`p-2 rounded-full ${priorityConfig.color}`}>
                <PriorityIcon className="h-4 w-4" />
              </div>
              
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <h4 className="font-semibold">{alert.title}</h4>
                  <Badge variant="outline" className="text-xs">
                    {typeConfig.name}
                  </Badge>
                </div>

                {isClosingAlert ? (
                  <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground mb-2">
                    <span className="flex items-center gap-1">
                      <Home className="h-3 w-3" />
                      {alert.property_address}
                    </span>
                    <span className="flex items-center gap-1">
                      <User className="h-3 w-3" />
                      {alert.client_name}
                    </span>
                    <span className="flex items-center gap-1">
                      <Calendar className="h-3 w-3" />
                      {closingDateLabel}
                    </span>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground mb-2">
                    {alert.message}
                  </p>
                )}

                {isClosingAlert && openStages.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-2">
                    {openStages.map((stage) => (
                      <Badge key={stage} variant="secondary" className="text-xs">
                        {formatStageLabel(stage)}
                      </Badge>
                    ))}
                  </div>
                )}

                {!isClosingAlert && (
                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Home className="h-3 w-3" />
                      {alert.property_address}
                    </span>
                    <span className="flex items-center gap-1">
                      <User className="h-3 w-3" />
                      {alert.client_name}
                    </span>
                    <span className="flex items-center gap-1">
                      <Calendar className="h-3 w-3" />
                      {closingDateLabel}
                    </span>
                  </div>
                )}

                {/* Alert Details */}
                {alert.details && !isClosingAlert && (
                  <div className="mt-3 p-2 bg-muted rounded text-xs">
                    {alert.alert_type === 'overdue_tasks' && (
                      <div>
                        <strong>{alert.details.overdue_count} overdue tasks</strong>
                        {alert.details.overdue_tasks && (
                          <ul className="mt-1 list-disc list-inside">
                            {alert.details.overdue_tasks.slice(0, 3).map((task, index) => (
                              <li key={index}>
                                {task.title} ({task.days_overdue} days overdue)
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                    
                    {alert.alert_type === 'deal_inactivity' && (
                      <div>
                        <strong>Inactive for {alert.details.days_inactive} days</strong>
                        <br />Current stage: {alert.details.current_stage}
                      </div>
                    )}
                  </div>
                )}

                {isClosingAlert && (
                  <Button
                    variant="default"
                    size="sm"
                    className="mt-3 h-9 rounded-full px-4 text-xs font-semibold"
                    onClick={() => setTaskDialog({ open: true, alert })}
                  >
                    {remainingTasks} {remainingTasks === 1 ? 'task' : 'tasks'} remaining
                  </Button>
                )}
              </div>
            </div>
            
            <Button
              variant="ghost"
              size="sm"
              onClick={() => dismissAlert(alert.id)}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Smart Alerts</h2>
          <p className="text-muted-foreground">
            Automated alerts for overdue tasks, deal inactivity, and closing deadlines
          </p>
        </div>
        <Button onClick={generateAlerts} disabled={loading}>
          {loading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Bell className="mr-2 h-4 w-4" />
          )}
          Refresh Alerts
        </Button>
      </div>

      {/* Alert Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {PRIORITY_LEVELS.map(priority => {
          const count = taskPriorityCounts[priority] || 0
          const config = ALERT_PRIORITY_CONFIG[priority]
          return (
            <Card
              key={priority}
              className="cursor-pointer transition-shadow hover:shadow-md"
              onClick={() => setPriorityDialog({ open: true, priority })}
            >
              <CardContent className="p-4 text-center">
                <div className={`text-2xl font-bold ${config.color.replace('bg-', 'text-').replace('100', '600')}`}>
                  {count}
                </div>
                <p className="text-sm capitalize">{priority} Priority</p>
              </CardContent>
            </Card>
          )
        })}
      </div>

      {/* Alerts List */}
      {loading && alerts.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <div className="text-center">
            <Loader2 className="h-8 w-8 animate-spin mx-auto mb-4" />
            <p>Loading alerts...</p>
          </div>
        </div>
      ) : alerts.length > 0 ? (
        <div className="space-y-4">
          {alerts.map((alert) => (
            <AlertCard key={alert.id} alert={alert} />
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="p-12 text-center">
            <Bell className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No active alerts</h3>
            <p className="text-muted-foreground mb-4">
              All your transactions are on track! Smart alerts will appear here when attention is needed.
            </p>
            <Button onClick={generateAlerts}>
              <Bell className="mr-2 h-4 w-4" />
              Check for New Alerts
            </Button>
          </CardContent>
        </Card>
      )}

      <Dialog
        open={taskDialog.open}
        onOpenChange={(open) => setTaskDialog((prev) => ({ ...prev, open, alert: open ? prev.alert : null }))}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {(taskDialog.alert?.title || 'Remaining Tasks')}
            </DialogTitle>
            <DialogDescription>
              {taskDialog.alert?.property_address || 'Transaction'} tasks across open stages
            </DialogDescription>
          </DialogHeader>

          {Array.isArray(taskDialog.alert?.details?.remaining_tasks) && taskDialog.alert.details.remaining_tasks.length > 0 ? (
            <div className="max-h-[320px] space-y-2 overflow-y-auto pr-1">
              {taskDialog.alert.details.remaining_tasks.map((task) => {
                const dueDate = task?.due_date ? new Date(task.due_date) : null
                const dueLabel = dueDate && !Number.isNaN(dueDate.getTime())
                  ? dueDate.toLocaleDateString()
                  : 'No due date'

                return (
                  <button
                    type="button"
                    key={task.id || `${task.title}-${task.stage}-${task.due_date || 'na'}`}
                    className="w-full rounded-md border p-3 text-left transition-colors hover:bg-muted/50"
                    onClick={() => focusTaskFromAlert(taskDialog.alert, task)}
                  >
                    <div className="font-medium">{task.title}</div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Calendar className="h-3 w-3" />
                        {dueLabel}
                      </span>
                      <Badge variant="outline" className={`text-xs ${getPriorityBadgeClasses(task.priority || 'medium')}`}>
                        {String(task.priority || 'medium')}
                      </Badge>
                      {task.stage && (
                        <Badge variant="secondary" className="text-xs">
                          {formatStageLabel(task.stage)}
                        </Badge>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">No remaining tasks found.</div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={priorityDialog.open}
        onOpenChange={(open) => setPriorityDialog((prev) => ({ ...prev, open, priority: open ? prev.priority : null }))}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {priorityDialog.priority ? `${formatStageLabel(priorityDialog.priority)} Priority Tasks` : 'Priority Tasks'}
            </DialogTitle>
            <DialogDescription>
              All incomplete tasks across transactions for this priority level
            </DialogDescription>
          </DialogHeader>

          {priorityDialog.priority && (taskPriorityGroups[priorityDialog.priority] || []).length > 0 ? (
            <div className="max-h-[360px] space-y-2 overflow-y-auto pr-1">
              {(taskPriorityGroups[priorityDialog.priority] || []).map((task) => {
                const dueDate = task?.due_date ? new Date(task.due_date) : null
                const dueLabel = dueDate && !Number.isNaN(dueDate.getTime())
                  ? dueDate.toLocaleDateString()
                  : 'No due date'

                return (
                  <button
                    type="button"
                    key={`${task.transaction_id}-${task.id}`}
                    className="w-full rounded-md border p-3 text-left transition-colors hover:bg-muted/50"
                    onClick={() => focusTaskFromPriorityDialog(task)}
                  >
                    <div className="font-medium">{task.property_address}</div>
                    <div className="mt-1 text-sm text-muted-foreground">{task.title}</div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {task.stage && (
                        <Badge variant="secondary" className="text-xs">
                          {formatStageLabel(task.stage)}
                        </Badge>
                      )}
                      <Badge variant="outline" className={`text-xs ${getPriorityBadgeClasses(priorityDialog.priority)}`}>
                        {String(priorityDialog.priority)}
                      </Badge>
                      <span className="flex items-center gap-1">
                        <Calendar className="h-3 w-3" />
                        {dueLabel}
                      </span>
                    </div>
                  </button>
                )
              })}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">No tasks found for this priority.</div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
