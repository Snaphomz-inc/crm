'use client'

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
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

export function TransactionManagement() {
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

  const [newTransaction, setNewTransaction] = useState({
    property_address: '',
    client_name: '',
    client_email: '',
    client_phone: '',
    transaction_type: 'sale',
    assigned_agent: '',
    listing_price: '',
    closing_date: ''
  })

  useEffect(() => {
    fetchTransactions()
  }, [])

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

  const fetchTransactions = async () => {
    setLoading(true)
    try {
      const response = await fetch('/api/transactions')
      const data = await response.json()
      if (data.success) {
        const baseTransactions = Array.isArray(data.transactions) ? data.transactions : []

        const enrichedTransactions = await Promise.all(
          baseTransactions.map(async (tx) => {
            try {
              const txType = (tx?.transaction_type || 'sale').toLowerCase()
              const checklistRes = await fetch(`/api/transactions/${tx.id}/checklist`)
              const checklistData = await checklistRes.json()
              if (!checklistRes.ok || !checklistData?.success || !Array.isArray(checklistData.checklist_items)) {
                return tx
              }

              const incompleteItems = checklistData.checklist_items.filter((item) => item?.status !== 'completed')
              const stageHistory = Array.isArray(tx?.stage_history) ? tx.stage_history : []
              const forcedStages = new Set(
                stageHistory
                  .filter((entry) => {
                    if (!entry || !entry.stage) return false
                    if (entry.forced === true) return true
                    return entry?.validation_result?.valid === false
                  })
                  .flatMap((entry) => [entry.stage, entry.transitioned_from].filter(Boolean))
              )

              const scopedStages = new Set(forcedStages)
              if (tx?.current_stage) scopedStages.add(tx.current_stage)

              // Backward compatibility for records where forced stage history wasn't persisted.
              if (forcedStages.size === 0 && tx?.current_stage) {
                const currentOrder = getStageOrder(tx.current_stage, txType)
                incompleteItems.forEach((task) => {
                  const order = getStageOrder(task?.stage, txType)
                  if (order <= currentOrder) scopedStages.add(task.stage)
                })
              }

              const openStages = Array.from(
                new Set(
                  incompleteItems
                    .map((task) => task?.stage)
                    .filter((stage) => stage && scopedStages.has(stage))
                )
              ).sort((a, b) => getStageOrder(a, txType) - getStageOrder(b, txType))

              return {
                ...tx,
                open_stages: openStages.length > 0
                  ? openStages
                  : (tx?.current_stage ? [tx.current_stage] : [])
              }
            } catch (error) {
              console.error(`Error deriving open stages for transaction ${tx?.id}:`, error)
              return tx
            }
          })
        )

        setTransactions(enrichedTransactions)
      }
    } catch (error) {
      console.error('Error fetching transactions:', error)
    }
    setLoading(false)
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

  const createTransaction = async () => {
    if (!newTransaction.property_address || !newTransaction.client_name) {
      alert('Property address and client name are required')
      return
    }

    setLoading(true)
    try {
      const response = await fetch('/api/transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newTransaction)
      })

      const data = await response.json()
      if (data.success) {
        const createdTx = data.transaction || {}
        setTransactions([{ ...createdTx, open_stages: createdTx.current_stage ? [createdTx.current_stage] : [] }, ...transactions])
        setNewTransaction({
          property_address: '',
          client_name: '',
          client_email: '',
          client_phone: '',
          transaction_type: 'sale',
          assigned_agent: '',
          listing_price: '',
          closing_date: ''
        })
        setIsAddDialogOpen(false)
      } else {
        alert(data.error || 'Failed to create transaction')
      }
    } catch (error) {
      console.error('Error creating transaction:', error)
      alert('Failed to create transaction')
    }
    setLoading(false)
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
            ← Back to Transactions
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
        <Button onClick={() => setIsAddDialogOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          New Transaction
        </Button>
      </div>

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
                  onChange={(e) => setNewTransaction({...newTransaction, closing_date: e.target.value})}
                />
              </div>
            </div>
          </div>
          
          <div className="flex justify-end space-x-2 pt-4">
            <Button variant="outline" onClick={() => setIsAddDialogOpen(false)}>
              Cancel
            </Button>
            <Button 
              onClick={createTransaction} 
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
