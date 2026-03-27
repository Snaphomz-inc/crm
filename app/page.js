'use client'

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Search, Plus, Users, TrendingUp, Home, Phone, Mail, MapPin, DollarSign, Building, Sparkles, Bot, FileText, Trash2, CalendarDays, ListChecks } from 'lucide-react'
import { Textarea } from '@/components/ui/textarea'
import { AssistantChat } from '@/components/AssistantChat'
import { PropertySearch } from '@/components/PropertySearch'
import { AssistantPanel } from '@/components/AssistantPanel'
import { TransactionManagement } from '@/components/TransactionManagement'
import { SmartAlerts } from '@/components/DealSummary'
import { MarkdownText } from '@/components/ui/markdown'
import { 
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
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
  SidebarInset,
} from '@/components/ui/sidebar'

export default function RealEstateCRM() {
  // Default to Assistant tab on load
  const [activeTab, setActiveTab] = useState('assistant')
  const [leads, setLeads] = useState([])
  const [filteredLeads, setFilteredLeads] = useState([])
  const [searchTerm, setSearchTerm] = useState('')
  const [filterType, setFilterType] = useState('all')
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false)
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false)
  const [selectedLead, setSelectedLead] = useState(null)
  const [leadMatchesDialogLead, setLeadMatchesDialogLead] = useState(null)
  const [removingPropertyKey, setRemovingPropertyKey] = useState(null)
  const [dashboardStats, setDashboardStats] = useState({})
  const [loading, setLoading] = useState(false)
  const [propertyMatches, setPropertyMatches] = useState(null)
  const [isStartTransDialogOpen, setIsStartTransDialogOpen] = useState(false)
  const [transactionDraft, setTransactionDraft] = useState({
    property_address: '',
    client_name: '',
    client_email: '',
    client_phone: '',
    transaction_type: 'sale',
    assigned_agent: '',
    listing_price: '',
    closing_date: ''
  })
  const [transactionsRefresh, setTransactionsRefresh] = useState(0)
  const [newLead, setNewLead] = useState({
    name: '',
    email: '',
    phone: '',
    lead_type: 'buyer',
    preferences: {
      zipcode: '',
      min_price: '',
      max_price: '',
      bedrooms: '',
      bathrooms: '',
      // seller-specific (optional)
      seller_address: '',
      seller_price: '',
      seller_property_type: '',
      seller_bedrooms: '',
      seller_bathrooms: '',
      seller_year_built: '',
      seller_square_feet: '',
      seller_lot_size: '',
      seller_condition: '',
      seller_occupancy: '',
      seller_timeline: '',
      seller_hoa_fee: '',
      seller_description: ''
    },
    assigned_agent: '',
    tags: []
  })

  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const tab = String(params.get('tab') || '').trim()
    if (['assistant', 'dashboard', 'transactions', 'properties'].includes(tab)) {
      setActiveTab(tab)
    }
  }, [])

  useEffect(() => {
    if (activeTab === 'dashboard') {
      fetchLeads()
      fetchDashboardStats()
    }
  }, [activeTab])

  useEffect(() => {
    const handleFocusTask = () => setActiveTab('transactions')
    window.addEventListener('crm:focus-task', handleFocusTask)
    return () => window.removeEventListener('crm:focus-task', handleFocusTask)
  }, [])

  useEffect(() => {
    if (activeTab === 'dashboard') {
      filterLeads()
    }
  }, [leads, searchTerm, filterType, activeTab])

  const fetchLeads = async () => {
    try {
      const response = await fetch('/api/leads')
      const data = await response.json()
      // Ensure we always store an array of leads
      const arr = Array.isArray(data) ? data : (Array.isArray(data?.leads) ? data.leads : [])
      setLeads(arr)
    } catch (error) {
      console.error('Error fetching leads:', error)
    }
  }

  const fetchDashboardStats = async () => {
    try {
      const response = await fetch('/api/analytics/dashboard')
      const data = await response.json()
      setDashboardStats(data)
    } catch (error) {
      console.error('Error fetching dashboard stats:', error)
    }
  }

  const filterLeads = () => {
    let filtered = Array.isArray(leads) ? leads : []

    if (searchTerm) {
      const q = searchTerm.toLowerCase()
      filtered = filtered.filter(lead => {
        const name = (lead?.name || '').toLowerCase()
        const email = (lead?.email || '').toLowerCase()
        const phone = (lead?.phone || '')
        return name.includes(q) || email.includes(q) || phone.includes(searchTerm)
      })
    }

    if (filterType !== 'all') {
      filtered = filtered.filter(lead => lead?.lead_type === filterType)
    }

    setFilteredLeads(Array.isArray(filtered) ? filtered : [])
  }

  const handleAddLead = async () => {
    setLoading(true)
    try {
      const response = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newLead)
      })
      
      if (response.ok) {
        const createdLead = await response.json()
        setLeads([createdLead, ...leads])
        setNewLead({
          name: '',
          email: '',
          phone: '',
          lead_type: 'buyer',
          preferences: {
            zipcode: '',
            min_price: '',
            max_price: '',
            bedrooms: '',
            bathrooms: '',
            seller_address: '',
            seller_price: '',
            seller_property_type: '',
            seller_bedrooms: '',
            seller_bathrooms: '',
            seller_year_built: '',
            seller_square_feet: '',
            seller_lot_size: '',
            seller_condition: '',
            seller_occupancy: '',
            seller_timeline: '',
            seller_hoa_fee: '',
            seller_description: ''
          },
          assigned_agent: '',
          tags: []
        })
        setIsAddDialogOpen(false)
        fetchDashboardStats() // Refresh stats
      } else {
        const error = await response.json()
        alert(error.error)
      }
    } catch (error) {
      console.error('Error adding lead:', error)
      alert('Error adding lead')
    }
    setLoading(false)
  }

  const openStartTransaction = (lead) => {
    const isSeller = lead?.lead_type === 'seller'
    setTransactionDraft({
      property_address: isSeller ? (lead?.preferences?.seller_address || '') : '',
      client_name: lead?.name || '',
      client_email: lead?.email || '',
      client_phone: lead?.phone || '',
      transaction_type: isSeller ? 'sale' : 'purchase',
      assigned_agent: lead?.assigned_agent || '',
      listing_price: isSeller ? (lead?.preferences?.seller_price || '') : '',
      closing_date: ''
    })
    setIsStartTransDialogOpen(true)
  }

  const createTransactionFromLead = async () => {
    setLoading(true)
    try {
      const payload = { ...transactionDraft }
      if (!payload.property_address) {
        // Backend requires property_address; for buyer flows, use a sensible placeholder
        if ((payload.transaction_type || 'purchase') === 'purchase') {
          const name = (payload.client_name || '').trim()
          payload.property_address = `Buyer prospect${name ? ` - ${name}` : ''}`
        }
      }

      const response = await fetch('/api/transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      const data = await response.json().catch(() => ({}))
      if (response.ok && (data.success || data.transaction || data.id)) {
        setIsStartTransDialogOpen(false)
        setTransactionDraft({
          property_address: '',
          client_name: '',
          client_email: '',
          client_phone: '',
          transaction_type: 'sale',
          assigned_agent: '',
          listing_price: '',
          closing_date: ''
        })
        setTransactionsRefresh((prev) => prev + 1)
        setActiveTab('transactions')
      } else {
        alert(data.error || 'Failed to create transaction')
      }
    } catch (error) {
      console.error('Error creating transaction from lead:', error)
      alert('Failed to create transaction')
    }
    setLoading(false)
  }

  const handleUpdateLead = async () => {
    setLoading(true)
    try {
      const response = await fetch(`/api/leads/${selectedLead.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(selectedLead)
      })
      
      if (response.ok) {
        const updatedLead = await response.json()
        setLeads(leads.map(lead => lead.id === updatedLead.id ? updatedLead : lead))
        setIsEditDialogOpen(false)
        setSelectedLead(null)
        fetchDashboardStats() // Refresh stats
      }
    } catch (error) {
      console.error('Error updating lead:', error)
    }
    setLoading(false)
  }

  const openLeadEditor = async (lead) => {
    if (!lead?.id) {
      setSelectedLead(lead || null)
      setIsEditDialogOpen(true)
      return
    }

    try {
      const response = await fetch(`/api/leads/${lead.id}`)
      if (response.ok) {
        const latestLead = await response.json()
        setSelectedLead(latestLead)
      } else {
        setSelectedLead(lead)
      }
    } catch (error) {
      console.error('Error loading lead details:', error)
      setSelectedLead(lead)
    }
    setIsEditDialogOpen(true)
  }

  const openLeadMatchesDialog = async (lead) => {
    if (!lead?.id) return
    try {
      const response = await fetch(`/api/leads/${lead.id}`)
      if (response.ok) {
        const latestLead = await response.json()
        setLeadMatchesDialogLead(latestLead)
      } else {
        setLeadMatchesDialogLead(lead)
      }
    } catch (error) {
      console.error('Error loading potential matches:', error)
      setLeadMatchesDialogLead(lead)
    }
  }

  const removePropertyFromLead = async (lead, propertyIndex) => {
    if (!lead?.id) return
    const current = Array.isArray(lead.interested_properties) ? lead.interested_properties : []
    if (propertyIndex < 0 || propertyIndex >= current.length) return

    const property = current[propertyIndex] || {}
    const propertyName = property?.address || 'this property'
    const confirmed = window.confirm(`Remove "${propertyName}" from ${lead.name}'s saved properties?`)
    if (!confirmed) return

    const nextProperties = current.filter((_, idx) => idx !== propertyIndex)
    const key = `${lead.id}:${propertyIndex}`
    setRemovingPropertyKey(key)
    try {
      const response = await fetch(`/api/leads/${lead.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interested_properties: nextProperties })
      })
      if (!response.ok) {
        const err = await response.json().catch(() => ({}))
        throw new Error(err?.error || `Failed to remove property (${response.status})`)
      }
      const updatedLead = await response.json()
      setLeadMatchesDialogLead(updatedLead)
      setLeads(prev => prev.map(l => l.id === updatedLead.id ? updatedLead : l))
      setSelectedLead(prev => (prev?.id === updatedLead.id ? updatedLead : prev))
    } catch (error) {
      console.error('Error removing saved property:', error)
      alert(error?.message || 'Failed to remove property')
    } finally {
      setRemovingPropertyKey(null)
    }
  }

  const handleFindMatches = async (leadId) => {
    setLoading(true)
    try {
      const response = await fetch(`/api/leads/${leadId}/match`, {
        method: 'POST'
      })
      const data = await response.json()
      setPropertyMatches(data)
      if (data?.updated_lead?.id) {
        setLeads(prev => prev.map(l => l.id === data.updated_lead.id ? data.updated_lead : l))
      }
    } catch (error) {
      console.error('Error finding property matches:', error)
    }
    setLoading(false)
  }

  const handleDeleteLead = async (leadId) => {
    if (!leadId) return
    setLoading(true)
    try {
      const response = await fetch(`/api/leads/${leadId}`, { method: 'DELETE' })
      if (response.ok) {
        setLeads(prev => prev.filter(l => l.id !== leadId))
        if (selectedLead?.id === leadId) {
          setIsEditDialogOpen(false)
          setSelectedLead(null)
        }
        fetchDashboardStats()
      } else {
        const err = await response.json().catch(() => ({}))
        alert(err?.error || 'Failed to delete lead')
      }
    } catch (error) {
      console.error('Error deleting lead:', error)
      alert('Error deleting lead')
    }
    setLoading(false)
  }

  const getInitials = (name) => {
    if (!name || typeof name !== 'string') return 'NA'
    return name.split(' ').map(n => n[0]).join('').toUpperCase()
  }

  const formatCurrency = (amount) => {
    if (amount === undefined || amount === null || amount === '') return 'N/A'
    const parsed = typeof amount === 'number' ? amount : Number(String(amount).replace(/[^0-9.-]/g, ''))
    if (!Number.isFinite(parsed)) return 'N/A'
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
    }).format(parsed)
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
                <SidebarMenuButton isActive={activeTab === 'assistant'} onClick={() => setActiveTab('assistant')}>
                  <Bot className="h-4 w-4" />
                  <span>Assistant</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={activeTab === 'dashboard'} onClick={() => setActiveTab('dashboard')}>
                  <Users className="h-4 w-4" />
                  <span>Leads</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={activeTab === 'transactions'} onClick={() => setActiveTab('transactions')}>
                  <FileText className="h-4 w-4" />
                  <span>Transactions</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={activeTab === 'properties'} onClick={() => setActiveTab('properties')}>
                  <Home className="h-4 w-4" />
                  <span>Properties</span>
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
        <div className="container mx-auto py-6 px-4">
          <div className="flex flex-col space-y-6">
          {/* Main Tabs (Sidebar controls the active tab; hide tab list visually) */}
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="hidden">
              <TabsTrigger value="assistant" />
              <TabsTrigger value="dashboard" />
              <TabsTrigger value="transactions" />
              <TabsTrigger value="properties" />
            </TabsList>

            {/* Dashboard Tab */}
            <TabsContent value="dashboard" className="space-y-6">
              {/* Dashboard Stats */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">Total Leads</CardTitle>
                    <Users className="h-4 w-4 text-muted-foreground" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">{dashboardStats.total_leads || 0}</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">Active Leads</CardTitle>
                    <TrendingUp className="h-4 w-4 text-muted-foreground" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">{dashboardStats.active_leads || 0}</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">Buyers</CardTitle>
                    <Home className="h-4 w-4 text-muted-foreground" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">{dashboardStats.buyer_leads || 0}</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">Sellers</CardTitle>
                    <Building className="h-4 w-4 text-muted-foreground" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">{dashboardStats.seller_leads || 0}</div>
                  </CardContent>
                </Card>
              </div>

              {/* Search and Filters */}
              <div className="flex flex-col sm:flex-row gap-4 items-stretch sm:items-end">
                <div className="flex-1">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="Search leads by name, email, or phone..."
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      className="pl-10"
                    />
                  </div>
                </div>
                <Select value={filterType} onValueChange={setFilterType}>
                  <SelectTrigger className="w-full sm:w-48">
                    <SelectValue placeholder="Filter by type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Leads</SelectItem>
                    <SelectItem value="buyer">Buyers</SelectItem>
                    <SelectItem value="seller">Sellers</SelectItem>
                  </SelectContent>
                </Select>
                <div className="sm:ml-auto">
                  <Button onClick={() => setIsAddDialogOpen(true)} className="w-full sm:w-auto">
                    <Plus className="mr-2 h-4 w-4" />
                    Add Lead
                  </Button>
                </div>
              </div>

              {/* Leads List */}
              <div className="grid gap-6">
                {filteredLeads.map((lead) => (
                  <Card key={lead.id} className="hover:shadow-md transition-shadow">
                    <CardContent className="p-6">
                      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                        <div className="flex items-center space-x-4">
                          <Avatar className="h-12 w-12">
                            <AvatarFallback className="bg-primary/10 text-primary font-semibold">
                              {getInitials(lead.name)}
                            </AvatarFallback>
                          </Avatar>
                          <div className="space-y-1">
                            <button
                              type="button"
                              className="text-left text-lg font-semibold hover:underline"
                              onClick={() => openLeadEditor(lead)}
                            >
                              {lead.name}
                            </button>
                            <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                              <Badge variant={lead.lead_type === 'buyer' ? 'default' : 'secondary'}>
                                {lead.lead_type}
                              </Badge>
                              <button type="button" onClick={() => openLeadMatchesDialog(lead)} className="cursor-pointer">
                                <Badge variant="outline">
                                  Properties: {Array.isArray(lead.interested_properties) ? lead.interested_properties.length : 0}
                                </Badge>
                              </button>
                              {lead.source === 'assistant' && (
                                <Badge variant="outline" className="text-purple-600 border-purple-600">
                                  <Bot className="mr-1 h-3 w-3" />
                                  AI Created
                                </Badge>
                              )}
                              <span className="text-sm text-muted-foreground">
                                Added {new Date(lead.created_at).toLocaleDateString()}
                              </span>
                            </div>
                          </div>
                        </div>
                        
                        <div className="flex flex-col sm:flex-row gap-3">
                          <div className="flex flex-col space-y-1 text-sm">
                            <div className="flex items-center text-muted-foreground">
                              <Mail className="mr-2 h-4 w-4" />
                              {lead.email}
                            </div>
                            <div className="flex items-center text-muted-foreground">
                              <Phone className="mr-2 h-4 w-4" />
                              {lead.phone}
                            </div>
                            {lead.preferences?.zipcode && (
                              <div className="flex items-center text-muted-foreground">
                                <MapPin className="mr-2 h-4 w-4" />
                                {lead.preferences.zipcode}
                              </div>
                            )}
                          </div>
                          
                          <div className="flex flex-col sm:flex-row gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => openLeadEditor(lead)}
                            >
                              Edit
                            </Button>
                            <Button
                              variant="default"
                              size="sm"
                              onClick={() => handleFindMatches(lead.id)}
                              disabled={loading}
                            >
                              <Sparkles className="mr-2 h-4 w-4" />
                              AI Match
                            </Button>
                            <Button
                              variant="default"
                              size="sm"
                              onClick={() => openStartTransaction(lead)}
                            >
                              <FileText className="mr-2 h-4 w-4" />
                              Start Transaction
                            </Button>
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="text-red-600 border-red-600 hover:bg-red-50"
                                  disabled={loading}
                                >
                                  <Trash2 className="mr-2 h-4 w-4" />
                                  Delete
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>Delete lead?</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    This action cannot be undone. This will permanently remove {lead.name}'s lead and related insights.
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                                  <AlertDialogAction onClick={() => handleDeleteLead(lead.id)}>
                                    Delete
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          </div>
                        </div>
                      </div>
                      
                      {lead.ai_insights && (
                        <div className="mt-4 p-3 bg-muted rounded-lg">
                          <p className="text-sm font-medium text-muted-foreground mb-1">AI Insights:</p>
                          <MarkdownText text={lead.ai_insights} className="text-sm" />
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>

              {filteredLeads.length === 0 && (
                <Card>
                  <CardContent className="p-12 text-center">
                    <Users className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
                    <h3 className="text-lg font-semibold mb-2">No leads found</h3>
                    <p className="text-muted-foreground mb-4">
                      {searchTerm || filterType !== 'all' 
                        ? 'Try adjusting your search or filters'
                        : 'Get started by adding your first lead or using the AI Assistant'
                      }
                    </p>
                    <div className="flex gap-2 justify-center">
                      <Button onClick={() => setIsAddDialogOpen(true)}>
                        <Plus className="mr-2 h-4 w-4" />
                        Add Lead
                      </Button>
                      <Button variant="outline" onClick={() => setActiveTab('assistant')}>
                        <Bot className="mr-2 h-4 w-4" />
                        Try AI Assistant
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )}
            </TabsContent>

          

            {/* Transactions Tab */}
            <TabsContent value="transactions" className="space-y-6">
              <div className="grid gap-6 lg:grid-cols-3">
                <div className="lg:col-span-2">
                  <TransactionManagement key={transactionsRefresh} />
                </div>
                <div>
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-lg">Smart Alerts</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <SmartAlerts />
                    </CardContent>
                  </Card>
                </div>
              </div>
            </TabsContent>

            {/* Property Search Tab */}
            <TabsContent value="properties" className="space-y-6">
              <PropertySearch />
            </TabsContent>

            {/* Assistant Tab */}
            <TabsContent value="assistant" className="space-y-6">
            <AssistantPanel />
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Bot className="h-5 w-5 text-purple-600" />
                    AI Real Estate Assistant
                  </CardTitle>
                  <CardDescription>
                    Use natural language to create leads and find matching properties. 
                    Try: "Just met Priya Sharma. 2BHK in Frisco under $500K."
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <AssistantChat />
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>
        </div>
      <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add New Lead</DialogTitle>
            <DialogDescription>
              Create a new lead and let AI provide insights and property matches.
            </DialogDescription>
          </DialogHeader>
          <Tabs defaultValue="basic" className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="basic">Basic Info</TabsTrigger>
              <TabsTrigger value="preferences">Details</TabsTrigger>
            </TabsList>
            <TabsContent value="basic" className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Full Name</Label>
                  <Input
                    id="name"
                    value={newLead.name}
                    onChange={(e) => setNewLead({...newLead, name: e.target.value})}
                    placeholder="John Doe"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lead_type">Lead Type</Label>
                  <Select value={newLead.lead_type} onValueChange={(value) => setNewLead({...newLead, lead_type: value})}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="buyer">Buyer</SelectItem>
                      <SelectItem value="seller">Seller</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    value={newLead.email}
                    onChange={(e) => setNewLead({...newLead, email: e.target.value})}
                    placeholder="john@example.com"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="phone">Phone</Label>
                  <Input
                    id="phone"
                    value={newLead.phone}
                    onChange={(e) => setNewLead({...newLead, phone: e.target.value})}
                    placeholder="(555) 123-4567"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="assigned_agent">Assigned Agent (Optional)</Label>
                <Input
                  id="assigned_agent"
                  value={newLead.assigned_agent}
                  onChange={(e) => setNewLead({...newLead, assigned_agent: e.target.value})}
                  placeholder="Agent Name"
                />
              </div>
            </TabsContent>
            <TabsContent value="preferences" className="space-y-4">
              {newLead.lead_type === 'seller' ? (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="seller_address">Property Address</Label>
                    <Input
                      id="seller_address"
                      value={newLead.preferences?.seller_address || ''}
                      onChange={(e) => setNewLead({
                        ...newLead,
                        preferences: { ...newLead.preferences, seller_address: e.target.value }
                      })}
                      placeholder="123 Main St, City, State, ZIP"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="seller_price">Asking Price</Label>
                    <Input
                      id="seller_price"
                      type="number"
                      value={newLead.preferences?.seller_price || ''}
                      onChange={(e) => setNewLead({
                        ...newLead,
                        preferences: { ...newLead.preferences, seller_price: e.target.value }
                      })}
                      placeholder="500000"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="seller_property_type">Property Type</Label>
                      <Select
                        value={newLead.preferences?.seller_property_type || ''}
                        onValueChange={(v) => setNewLead({
                          ...newLead,
                          preferences: { ...newLead.preferences, seller_property_type: v }
                        })}
                      >
                        <SelectTrigger id="seller_property_type">
                          <SelectValue placeholder="Select type" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="single_family">Single Family</SelectItem>
                          <SelectItem value="condo">Condo</SelectItem>
                          <SelectItem value="townhouse">Townhouse</SelectItem>
                          <SelectItem value="multi_family">Multi-Family</SelectItem>
                          <SelectItem value="land">Land</SelectItem>
                          <SelectItem value="other">Other</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="seller_bedrooms">Bedrooms</Label>
                        <Input
                          id="seller_bedrooms"
                          type="number"
                          value={newLead.preferences?.seller_bedrooms || ''}
                          onChange={(e) => setNewLead({
                            ...newLead,
                            preferences: { ...newLead.preferences, seller_bedrooms: e.target.value }
                          })}
                          placeholder="3"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="seller_bathrooms">Bathrooms</Label>
                        <Input
                          id="seller_bathrooms"
                          type="number"
                          step="0.5"
                          value={newLead.preferences?.seller_bathrooms || ''}
                          onChange={(e) => setNewLead({
                            ...newLead,
                            preferences: { ...newLead.preferences, seller_bathrooms: e.target.value }
                          })}
                          placeholder="2"
                        />
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="seller_year_built">Year Built</Label>
                      <Input
                        id="seller_year_built"
                        type="number"
                        value={newLead.preferences?.seller_year_built || ''}
                        onChange={(e) => setNewLead({
                          ...newLead,
                          preferences: { ...newLead.preferences, seller_year_built: e.target.value }
                        })}
                        placeholder="1998"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="seller_square_feet">Square Feet</Label>
                      <Input
                        id="seller_square_feet"
                        type="number"
                        value={newLead.preferences?.seller_square_feet || ''}
                        onChange={(e) => setNewLead({
                          ...newLead,
                          preferences: { ...newLead.preferences, seller_square_feet: e.target.value }
                        })}
                        placeholder="1800"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="seller_lot_size">Lot Size (sq ft)</Label>
                      <Input
                        id="seller_lot_size"
                        type="number"
                        value={newLead.preferences?.seller_lot_size || ''}
                        onChange={(e) => setNewLead({
                          ...newLead,
                          preferences: { ...newLead.preferences, seller_lot_size: e.target.value }
                        })}
                        placeholder="6500"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="seller_condition">Condition</Label>
                      <Select
                        value={newLead.preferences?.seller_condition || ''}
                        onValueChange={(v) => setNewLead({
                          ...newLead,
                          preferences: { ...newLead.preferences, seller_condition: v }
                        })}
                      >
                        <SelectTrigger id="seller_condition">
                          <SelectValue placeholder="Select condition" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="needs_work">Needs work</SelectItem>
                          <SelectItem value="average">Average</SelectItem>
                          <SelectItem value="good">Good</SelectItem>
                          <SelectItem value="excellent">Excellent</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="seller_occupancy">Occupancy</Label>
                      <Select
                        value={newLead.preferences?.seller_occupancy || ''}
                        onValueChange={(v) => setNewLead({
                          ...newLead,
                          preferences: { ...newLead.preferences, seller_occupancy: v }
                        })}
                      >
                        <SelectTrigger id="seller_occupancy">
                          <SelectValue placeholder="Select occupancy" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="owner">Owner-occupied</SelectItem>
                          <SelectItem value="tenant">Tenant-occupied</SelectItem>
                          <SelectItem value="vacant">Vacant</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="seller_timeline">Timeline to List</Label>
                      <Select
                        value={newLead.preferences?.seller_timeline || ''}
                        onValueChange={(v) => setNewLead({
                          ...newLead,
                          preferences: { ...newLead.preferences, seller_timeline: v }
                        })}
                      >
                        <SelectTrigger id="seller_timeline">
                          <SelectValue placeholder="Select timeline" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="asap">ASAP</SelectItem>
                          <SelectItem value="30_60">30–60 days</SelectItem>
                          <SelectItem value="60_90">60–90 days</SelectItem>
                          <SelectItem value="90_plus">90+ days</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="seller_hoa_fee">HOA Fee (monthly)</Label>
                      <Input
                        id="seller_hoa_fee"
                        type="number"
                        value={newLead.preferences?.seller_hoa_fee || ''}
                        onChange={(e) => setNewLead({
                          ...newLead,
                          preferences: { ...newLead.preferences, seller_hoa_fee: e.target.value }
                        })}
                        placeholder="0"
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="seller_description">Listing Notes</Label>
                    <Textarea
                      id="seller_description"
                      value={newLead.preferences?.seller_description || ''}
                      onChange={(e) => setNewLead({
                        ...newLead,
                        preferences: { ...newLead.preferences, seller_description: e.target.value }
                      })}
                      placeholder="Upgrades, repairs needed, highlights, etc."
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="zipcode">Preferred Zipcode</Label>
                      <Input
                        id="zipcode"
                        value={newLead.preferences.zipcode}
                        onChange={(e) => setNewLead({
                          ...newLead,
                          preferences: {...newLead.preferences, zipcode: e.target.value}
                        })}
                        placeholder="90210"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="bedrooms">Bedrooms</Label>
                      <Input
                        id="bedrooms"
                        type="number"
                        value={newLead.preferences.bedrooms}
                        onChange={(e) => setNewLead({
                          ...newLead,
                          preferences: {...newLead.preferences, bedrooms: e.target.value}
                        })}
                        placeholder="3"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="min_price">Min Price</Label>
                      <Input
                        id="min_price"
                        type="number"
                        value={newLead.preferences.min_price}
                        onChange={(e) => setNewLead({
                          ...newLead,
                          preferences: {...newLead.preferences, min_price: e.target.value}
                        })}
                        placeholder="300000"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="max_price">Max Price</Label>
                      <Input
                        id="max_price"
                        type="number"
                        value={newLead.preferences.max_price}
                        onChange={(e) => setNewLead({
                          ...newLead,
                          preferences: {...newLead.preferences, max_price: e.target.value}
                        })}
                        placeholder="500000"
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="bathrooms">Bathrooms</Label>
                    <Input
                      id="bathrooms"
                      type="number"
                      step="0.5"
                      value={newLead.preferences.bathrooms}
                      onChange={(e) => setNewLead({
                        ...newLead,
                        preferences: {...newLead.preferences, bathrooms: e.target.value}
                      })}
                      placeholder="2"
                    />
                  </div>
                </>
              )}
            </TabsContent>
          </Tabs>
          <div className="flex justify-end space-x-2">
            <Button variant="outline" onClick={() => setIsAddDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleAddLead} disabled={loading}>
              {loading ? 'Creating...' : 'Create Lead'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Lead Dialog */}
      {selectedLead && (
        <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
          <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Edit Lead</DialogTitle>
              <DialogDescription>
                Update lead details and preferences.
              </DialogDescription>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-name">Full Name</Label>
                <Input
                  id="edit-name"
                  value={selectedLead.name}
                  onChange={(e) => setSelectedLead({...selectedLead, name: e.target.value})}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-lead_type">Lead Type</Label>
                <Select value={selectedLead.lead_type} onValueChange={(value) => setSelectedLead({...selectedLead, lead_type: value})}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="buyer">Buyer</SelectItem>
                    <SelectItem value="seller">Seller</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-email">Email</Label>
                <Input
                  id="edit-email"
                  type="email"
                  value={selectedLead.email}
                  onChange={(e) => setSelectedLead({...selectedLead, email: e.target.value})}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-phone">Phone</Label>
                <Input
                  id="edit-phone"
                  value={selectedLead.phone}
                  onChange={(e) => setSelectedLead({...selectedLead, phone: e.target.value})}
                />
              </div>
            </div>

            {/* Details */}
            <div className="mt-6 space-y-4">
              <h4 className="font-medium">Details</h4>
              {selectedLead.lead_type === 'seller' ? (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="edit-seller_address">Property Address</Label>
                    <Input
                      id="edit-seller_address"
                      value={selectedLead.preferences?.seller_address || ''}
                      onChange={(e) => setSelectedLead({
                        ...selectedLead,
                        preferences: { ...selectedLead.preferences, seller_address: e.target.value }
                      })}
                      placeholder="123 Main St, City, State, ZIP"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-seller_price">Asking Price</Label>
                    <Input
                      id="edit-seller_price"
                      type="number"
                      value={selectedLead.preferences?.seller_price || ''}
                      onChange={(e) => setSelectedLead({
                        ...selectedLead,
                        preferences: { ...selectedLead.preferences, seller_price: e.target.value }
                      })}
                      placeholder="500000"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="edit-seller_property_type">Property Type</Label>
                      <Select
                        value={selectedLead.preferences?.seller_property_type || ''}
                        onValueChange={(v) => setSelectedLead({
                          ...selectedLead,
                          preferences: { ...selectedLead.preferences, seller_property_type: v }
                        })}
                      >
                        <SelectTrigger id="edit-seller_property_type">
                          <SelectValue placeholder="Select type" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="single_family">Single Family</SelectItem>
                          <SelectItem value="condo">Condo</SelectItem>
                          <SelectItem value="townhouse">Townhouse</SelectItem>
                          <SelectItem value="multi_family">Multi-Family</SelectItem>
                          <SelectItem value="land">Land</SelectItem>
                          <SelectItem value="other">Other</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="edit-seller_bedrooms">Bedrooms</Label>
                        <Input
                          id="edit-seller_bedrooms"
                          type="number"
                          value={selectedLead.preferences?.seller_bedrooms || ''}
                          onChange={(e) => setSelectedLead({
                            ...selectedLead,
                            preferences: { ...selectedLead.preferences, seller_bedrooms: e.target.value }
                          })}
                          placeholder="3"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="edit-seller_bathrooms">Bathrooms</Label>
                        <Input
                          id="edit-seller_bathrooms"
                          type="number"
                          step="0.5"
                          value={selectedLead.preferences?.seller_bathrooms || ''}
                          onChange={(e) => setSelectedLead({
                            ...selectedLead,
                            preferences: { ...selectedLead.preferences, seller_bathrooms: e.target.value }
                          })}
                          placeholder="2"
                        />
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="edit-seller_year_built">Year Built</Label>
                      <Input
                        id="edit-seller_year_built"
                        type="number"
                        value={selectedLead.preferences?.seller_year_built || ''}
                        onChange={(e) => setSelectedLead({
                          ...selectedLead,
                          preferences: { ...selectedLead.preferences, seller_year_built: e.target.value }
                        })}
                        placeholder="1998"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="edit-seller_square_feet">Square Feet</Label>
                      <Input
                        id="edit-seller_square_feet"
                        type="number"
                        value={selectedLead.preferences?.seller_square_feet || ''}
                        onChange={(e) => setSelectedLead({
                          ...selectedLead,
                          preferences: { ...selectedLead.preferences, seller_square_feet: e.target.value }
                        })}
                        placeholder="1800"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="edit-seller_lot_size">Lot Size (sq ft)</Label>
                      <Input
                        id="edit-seller_lot_size"
                        type="number"
                        value={selectedLead.preferences?.seller_lot_size || ''}
                        onChange={(e) => setSelectedLead({
                          ...selectedLead,
                          preferences: { ...selectedLead.preferences, seller_lot_size: e.target.value }
                        })}
                        placeholder="6500"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="edit-seller_condition">Condition</Label>
                      <Select
                        value={selectedLead.preferences?.seller_condition || ''}
                        onValueChange={(v) => setSelectedLead({
                          ...selectedLead,
                          preferences: { ...selectedLead.preferences, seller_condition: v }
                        })}
                      >
                        <SelectTrigger id="edit-seller_condition">
                          <SelectValue placeholder="Select condition" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="needs_work">Needs work</SelectItem>
                          <SelectItem value="average">Average</SelectItem>
                          <SelectItem value="good">Good</SelectItem>
                          <SelectItem value="excellent">Excellent</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="edit-seller_occupancy">Occupancy</Label>
                      <Select
                        value={selectedLead.preferences?.seller_occupancy || ''}
                        onValueChange={(v) => setSelectedLead({
                          ...selectedLead,
                          preferences: { ...selectedLead.preferences, seller_occupancy: v }
                        })}
                      >
                        <SelectTrigger id="edit-seller_occupancy">
                          <SelectValue placeholder="Select occupancy" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="owner">Owner-occupied</SelectItem>
                          <SelectItem value="tenant">Tenant-occupied</SelectItem>
                          <SelectItem value="vacant">Vacant</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="edit-seller_timeline">Timeline to List</Label>
                      <Select
                        value={selectedLead.preferences?.seller_timeline || ''}
                        onValueChange={(v) => setSelectedLead({
                          ...selectedLead,
                          preferences: { ...selectedLead.preferences, seller_timeline: v }
                        })}
                      >
                        <SelectTrigger id="edit-seller_timeline">
                          <SelectValue placeholder="Select timeline" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="asap">ASAP</SelectItem>
                          <SelectItem value="30_60">30–60 days</SelectItem>
                          <SelectItem value="60_90">60–90 days</SelectItem>
                          <SelectItem value="90_plus">90+ days</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="edit-seller_hoa_fee">HOA Fee (monthly)</Label>
                      <Input
                        id="edit-seller_hoa_fee"
                        type="number"
                        value={selectedLead.preferences?.seller_hoa_fee || ''}
                        onChange={(e) => setSelectedLead({
                          ...selectedLead,
                          preferences: { ...selectedLead.preferences, seller_hoa_fee: e.target.value }
                        })}
                        placeholder="0"
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-seller_description">Listing Notes</Label>
                    <Textarea
                      id="edit-seller_description"
                      value={selectedLead.preferences?.seller_description || ''}
                      onChange={(e) => setSelectedLead({
                        ...selectedLead,
                        preferences: { ...selectedLead.preferences, seller_description: e.target.value }
                      })}
                      placeholder="Upgrades, repairs needed, highlights, etc."
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="edit-zipcode">Preferred Zipcode</Label>
                      <Input
                        id="edit-zipcode"
                        value={selectedLead.preferences?.zipcode || ''}
                        onChange={(e) => setSelectedLead({
                          ...selectedLead,
                          preferences: {...selectedLead.preferences, zipcode: e.target.value}
                        })}
                        placeholder="90210"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="edit-bedrooms">Bedrooms</Label>
                      <Input
                        id="edit-bedrooms"
                        type="number"
                        value={selectedLead.preferences?.bedrooms || ''}
                        onChange={(e) => setSelectedLead({
                          ...selectedLead,
                          preferences: {...selectedLead.preferences, bedrooms: e.target.value}
                        })}
                        placeholder="3"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="edit-min_price">Min Price</Label>
                      <Input
                        id="edit-min_price"
                        type="number"
                        value={selectedLead.preferences?.min_price || ''}
                        onChange={(e) => setSelectedLead({
                          ...selectedLead,
                          preferences: {...selectedLead.preferences, min_price: e.target.value}
                        })}
                        placeholder="300000"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="edit-max_price">Max Price</Label>
                      <Input
                        id="edit-max_price"
                        type="number"
                        value={selectedLead.preferences?.max_price || ''}
                        onChange={(e) => setSelectedLead({
                          ...selectedLead,
                          preferences: {...selectedLead.preferences, max_price: e.target.value}
                        })}
                        placeholder="500000"
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-bathrooms">Bathrooms</Label>
                    <Input
                      id="edit-bathrooms"
                      type="number"
                      step="0.5"
                      value={selectedLead.preferences?.bathrooms || ''}
                      onChange={(e) => setSelectedLead({
                        ...selectedLead,
                        preferences: {...selectedLead.preferences, bathrooms: e.target.value}
                      })}
                      placeholder="2"
                    />
                  </div>
                </>
              )}
            </div>

            <div className="flex justify-end space-x-2">
              <Button variant="outline" onClick={() => setIsEditDialogOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleUpdateLead} disabled={loading}>
                {loading ? 'Updating...' : 'Update Lead'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {leadMatchesDialogLead && (
        <Dialog open={!!leadMatchesDialogLead} onOpenChange={(open) => { if (!open) setLeadMatchesDialogLead(null) }}>
          <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Properties - {leadMatchesDialogLead.name}</DialogTitle>
              <DialogDescription>
                Saved properties for this lead.
              </DialogDescription>
            </DialogHeader>
            <div className="flex justify-end">
              <Button
                onClick={() => {
                  setLeadMatchesDialogLead(null)
                  setActiveTab('properties')
                }}
              >
                Add Properties
              </Button>
            </div>

            {Array.isArray(leadMatchesDialogLead.interested_properties) && leadMatchesDialogLead.interested_properties.length > 0 ? (
              <div className="grid gap-3 md:grid-cols-2">
                {leadMatchesDialogLead.interested_properties.map((property, index) => {
                  const locationLine = [property?.city, property?.state, property?.zipcode].filter(Boolean).join(', ')
                  const removeKey = `${leadMatchesDialogLead.id}:${index}`
                  const isRemoving = removingPropertyKey === removeKey
                  return (
                    <Card key={property?.property_id || property?.mls_number || property?.address || index} className="overflow-hidden">
                      <CardContent className="p-3">
                        <div className="flex gap-3">
                          {property?.primary_image ? (
                            <img
                              src={property.primary_image}
                              alt={property?.address || 'Property'}
                              className="h-20 w-24 rounded object-cover border"
                            />
                          ) : (
                            <div className="h-20 w-24 rounded border bg-muted flex items-center justify-center text-muted-foreground">
                              <Home className="h-5 w-5" />
                            </div>
                          )}
                          <div className="min-w-0 flex-1 space-y-1">
                            <p className="font-medium text-sm truncate">{property?.address || 'Saved property'}</p>
                            <p className="text-xs text-muted-foreground truncate">{locationLine || 'Location unavailable'}</p>
                            <p className="text-sm font-semibold text-primary">{formatCurrency(property?.price)}</p>
                            <div className="flex flex-wrap gap-1 text-xs text-muted-foreground">
                              {property?.property_type && (
                                <Badge variant="secondary">{property.property_type}</Badge>
                              )}
                              {(property?.bedrooms ?? '') !== '' && <span>{property.bedrooms} bd</span>}
                              {(property?.bathrooms ?? '') !== '' && <span>{property.bathrooms} ba</span>}
                              {(property?.square_feet ?? '') !== '' && <span>{property.square_feet} sqft</span>}
                            </div>
                            <div className="pt-2">
                              <Button
                                variant="outline"
                                size="sm"
                                className="text-red-600 border-red-600 hover:bg-red-50"
                                onClick={() => removePropertyFromLead(leadMatchesDialogLead, index)}
                                disabled={isRemoving}
                              >
                                <Trash2 className="mr-2 h-4 w-4" />
                                {isRemoving ? 'Removing...' : 'Delete'}
                              </Button>
                            </div>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  )
                })}
              </div>
            ) : (
              <div className="rounded-md border border-dashed p-4">
                <p className="text-sm text-muted-foreground">
                  No properties saved for this lead yet.
                </p>
              </div>
            )}
          </DialogContent>
        </Dialog>
      )}

      {/* Start Transaction from Lead Dialog */}
      <Dialog open={isStartTransDialogOpen} onOpenChange={setIsStartTransDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Start Transaction</DialogTitle>
            <DialogDescription>
              Create a transaction pre-filled from this lead.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="draft-client-name">Client Name *</Label>
                  <Input
                    id="draft-client-name"
                    value={transactionDraft.client_name}
                    onChange={(e) => setTransactionDraft({ ...transactionDraft, client_name: e.target.value })}
                    placeholder="John Smith"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="draft-transaction-type">Transaction Type</Label>
                  <Select
                    value={transactionDraft.transaction_type}
                    onValueChange={(value) => setTransactionDraft({ ...transactionDraft, transaction_type: value })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="sale">Sale (Seller)</SelectItem>
                      <SelectItem value="purchase">Purchase (Buyer)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="draft-property-address">Property Address {transactionDraft.transaction_type === 'sale' ? '*' : '(optional)'}</Label>
                <Input
                  id="draft-property-address"
                  value={transactionDraft.property_address}
                  onChange={(e) => setTransactionDraft({ ...transactionDraft, property_address: e.target.value })}
                  placeholder="123 Main Street, City, State, ZIP"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="draft-client-email">Client Email</Label>
                  <Input
                    id="draft-client-email"
                    type="email"
                    value={transactionDraft.client_email}
                    onChange={(e) => setTransactionDraft({ ...transactionDraft, client_email: e.target.value })}
                    placeholder="client@email.com"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="draft-client-phone">Client Phone</Label>
                  <Input
                    id="draft-client-phone"
                    value={transactionDraft.client_phone}
                    onChange={(e) => setTransactionDraft({ ...transactionDraft, client_phone: e.target.value })}
                    placeholder="(555) 123-4567"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="draft-assigned-agent">Assigned Agent</Label>
                  <Input
                    id="draft-assigned-agent"
                    value={transactionDraft.assigned_agent}
                    onChange={(e) => setTransactionDraft({ ...transactionDraft, assigned_agent: e.target.value })}
                    placeholder="Agent Name"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="draft-listing-price">Listing/Target Price</Label>
                  <Input
                    id="draft-listing-price"
                    type="number"
                    value={transactionDraft.listing_price}
                    onChange={(e) => setTransactionDraft({ ...transactionDraft, listing_price: e.target.value })}
                    placeholder="500000"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="draft-closing-date">Expected Closing Date</Label>
                <Input
                  id="draft-closing-date"
                  type="date"
                  value={transactionDraft.closing_date}
                  onChange={(e) => setTransactionDraft({ ...transactionDraft, closing_date: e.target.value })}
                />
              </div>
            </div>
          </div>
          <div className="flex justify-end space-x-2 pt-2">
            <Button variant="outline" onClick={() => setIsStartTransDialogOpen(false)}>Cancel</Button>
            <Button
              onClick={createTransactionFromLead}
              disabled={loading || !transactionDraft.client_name || (transactionDraft.transaction_type === 'sale' && !transactionDraft.property_address)}
            >
              {loading ? 'Creating...' : 'Create Transaction'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Property Matches Dialog */}
      {propertyMatches && (
        <Dialog open={!!propertyMatches} onOpenChange={() => setPropertyMatches(null)}>
          <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {(propertyMatches?.filter_policy === 'seller_no_search' || propertyMatches?.updated_lead?.lead_type === 'seller')
                  ? 'AI Seller Insights'
                  : 'AI Property Matches'}
              </DialogTitle>
              <DialogDescription>
                {(propertyMatches?.filter_policy === 'seller_no_search' || propertyMatches?.updated_lead?.lead_type === 'seller')
                  ? "Seller-focused insights based on the subject property (address and asking price)."
                  : <>Found {propertyMatches.total_found} properties. Here are the top matches:</>}
              </DialogDescription>
            </DialogHeader>
            
            {propertyMatches.ai_recommendations && (
              <div className="mb-6 p-4 bg-muted rounded-lg">
                <h4 className="font-semibold mb-2 flex items-center">
                  <Sparkles className="mr-2 h-4 w-4" />
                  AI Recommendations
                </h4>
                <MarkdownText text={propertyMatches.ai_recommendations} className="text-sm" />
              </div>
            )}
            
            {(propertyMatches?.filter_policy !== 'seller_no_search' && propertyMatches?.updated_lead?.lead_type !== 'seller') && (
              <div className="grid gap-4">
                {propertyMatches.properties.slice(0, 5).map((property, index) => (
                  <Card key={index}>
                    <CardContent className="p-4">
                      <div className="flex justify-between items-start">
                        <div>
                          <h4 className="font-semibold">{property.address || `Property #${index + 1}`}</h4>
                          <p className="text-sm text-muted-foreground">{property.city}, {property.state} {property.zipcode}</p>
                          <div className="flex gap-4 mt-2">
                            {property.bedrooms && <span className="text-sm">🛏️ {property.bedrooms} bed</span>}
                            {property.bathrooms && <span className="text-sm">🛁 {property.bathrooms} bath</span>}
                            {property.square_feet && <span className="text-sm">📐 {property.square_feet} sq ft</span>}
                          </div>
                        </div>
                        {property.price && (
                          <div className="text-right">
                            <p className="text-lg font-bold text-primary">{formatCurrency(property.price)}</p>
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </DialogContent>
        </Dialog>
      )}
    </SidebarInset>
    </SidebarProvider>
  )
}
