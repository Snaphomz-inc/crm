'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { MarkdownText } from '@/components/ui/markdown'
import { 
  Bot, 
  Send, 
  User, 
  Home, 
  DollarSign, 
  MapPin, 
  Bed, 
  Bath,
  Square,
  UserPlus,
  CheckCircle,
  AlertCircle,
  Loader2,
  FileText,
  X
} from 'lucide-react'

import ChatPropertyResults from '@/components/ChatPropertyResults'

const ASSISTANT_MATCH_TIMEOUT_MS = 120000
const ASSISTANT_LOADING_GUARD_MS = ASSISTANT_MATCH_TIMEOUT_MS + 5000

export function AssistantChat() {
  const [messages, setMessages] = useState([
    {
      id: '1',
      type: 'assistant',
      content: 'Hi! I\'m your AI real estate assistant. You can tell me about leads in natural language like: "Just met Priya Sharma. 2BHK in Frisco under $500K." I\'ll help you create leads and find matching properties!',
      timestamp: new Date(),
    }
  ])
  const [inputMessage, setInputMessage] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  // Keep track of the lead we are enriching via slot-filling
  const [currentLeadId, setCurrentLeadId] = useState(null)
  // Session continuity when bridged to Snaphomz-ai-search
  const [aiSessionId, setAiSessionId] = useState(null)
  const activeRequestRef = useRef(null)

  useEffect(() => {
    return () => {
      if (activeRequestRef.current) {
        try { activeRequestRef.current.abort() } catch {}
      }
    }
  }, [])

  useEffect(() => {
    if (!isLoading) return
    const guard = setTimeout(() => {
      setIsLoading(false)
    }, ASSISTANT_LOADING_GUARD_MS)
    return () => clearTimeout(guard)
  }, [isLoading])

  const formatCurrency = (amount) => {
    if (amount === null || amount === undefined || amount === '') return 'N/A'
    const n = Number(amount)
    if (Number.isNaN(n)) return 'N/A'
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
    }).format(n)
  }

  const handleSendMessage = async () => {
    if (!inputMessage.trim() || isLoading) return

    const userMessage = {
      id: Date.now().toString(),
      type: 'user',
      content: inputMessage,
      timestamp: new Date()
    }

    setMessages(prev => [...prev, userMessage])
    setIsLoading(true)
    
    const currentInput = inputMessage
    setInputMessage('')
    let matchController = null
    let matchTimeout = null

    try {
      // Single-step: let backend self-parse and fulfill
      matchController = new AbortController()
      activeRequestRef.current = matchController

      matchTimeout = setTimeout(() => {
        try { matchController.abort() } catch {}
      }, ASSISTANT_MATCH_TIMEOUT_MS)

      const matchResponse = await fetch('/api/assistant/match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: currentInput, lead_id: currentLeadId || undefined, session_id: aiSessionId || undefined }),
        signal: matchController.signal
      })

      console.log('Match response status:', matchResponse.status, matchResponse.statusText)

      if (!matchResponse.ok) {
        const errorText = await matchResponse.text()
        console.error('Match API error response:', errorText)
        throw new Error(`Match API failed: ${matchResponse.status} ${matchResponse.statusText} - ${errorText}`)
      }

      let matchData
      try {
        const responseText = await matchResponse.text()
        console.log('Match response text length:', responseText.length)
        
        if (!responseText.trim()) {
          throw new Error('Empty response from match API')
        }
        matchData = JSON.parse(responseText)
        console.log('Match data success:', matchData.success)
      } catch (jsonError) {
        console.error('Match response JSON error:', jsonError)
        throw new Error('Invalid response format from match API')
      }

      if (!matchData || !matchData.success) {
        console.error('Match data indicates failure:', matchData)
        throw new Error(matchData?.error || 'Failed to process request')
      }

      // Create assistant response with results
      const assistantMessage = {
        id: (Date.now() + 1).toString(),
        type: 'assistant',
        content: matchData.answer || matchData.ai_recommendations || 'I\'ve processed your request successfully.',
        timestamp: new Date(),
        data: {
          lead: matchData.lead,
          isNewLead: matchData.is_new_lead,
          properties: Array.isArray(matchData.properties) ? matchData.properties : null,
          propertiesCount: matchData.properties_count || 0,
          intent: matchData.intent || null,
          summary: matchData.summary,
          transactions: matchData.transactions || [],
          tasks: matchData.tasks || [],
          alerts: matchData.alerts || [],
          requireMoreDetails: !!matchData.require_more_details,
          missingFields: Array.isArray(matchData.missing_fields) ? matchData.missing_fields : []
        }
      }

      setMessages(prev => [...prev, assistantMessage])

      // Persist the lead id for subsequent slot-filling messages
      if (matchData?.lead?.id) {
        setCurrentLeadId(matchData.lead.id)
      }
      if (matchData?.session_id) {
        setAiSessionId(matchData.session_id)
      }

    } catch (error) {
      console.error('Assistant error:', error)
      
      let errorMsg = 'Sorry, I encountered an error. Please try again.'
      
      if (error.name === 'AbortError') {
        errorMsg = 'Request timed out. The AI processing is taking longer than expected. Please try again.'
      } else if (error.message.includes('502') || error.message.includes('Bad Gateway')) {
        errorMsg = '**Infrastructure Issue Detected**\n\nThe assistant backend is reachable, but external API routing is failing. Please check proxy/API configuration and retry.'
      } else if (error.message.includes('Match API failed')) {
        errorMsg = 'Failed to process your request. Please try again.'
      } else {
        errorMsg = `Error: ${error.message}`
      }
      
      const errorMessage = {
        id: (Date.now() + 1).toString(),
        type: 'assistant',
        content: errorMsg,
        timestamp: new Date(),
        isError: true
      }
      setMessages(prev => [...prev, errorMessage])
    } finally {
      if (matchTimeout) {
        clearTimeout(matchTimeout)
      }
      if (activeRequestRef.current === matchController) {
        activeRequestRef.current = null
      }
      setIsLoading(false)
    }
  }

  const cancelActiveRequest = () => {
    if (activeRequestRef.current) {
      try { activeRequestRef.current.abort() } catch {}
      activeRequestRef.current = null
    }
    setIsLoading(false)
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSendMessage()
    }
  }

  return (
    <div className="flex flex-col h-[600px] w-full">
      {/* Chat Header */}
      <div className="flex items-center space-x-3 p-4 border-b bg-muted/50">
        <Avatar className="h-8 w-8">
          <AvatarFallback className="bg-primary/10 text-primary">
            <Bot className="h-4 w-4" />
          </AvatarFallback>
        </Avatar>
        <div>
          <h3 className="font-semibold">AI Real Estate Assistant</h3>
          <p className="text-sm text-muted-foreground">Lead & Property Matching</p>
        </div>
      </div>

      {/* Chat Messages */}
      <ScrollArea native className="flex-1 p-4 pr-6 md:pr-8">
        <div className="space-y-4">
          {messages.map((message) => (
            <div key={message.id} className={`flex w-full ${message.type === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`flex items-start space-x-2 min-w-0 ${message.type === 'user' ? 'max-w-[80%] flex-row-reverse space-x-reverse' : 'max-w-[96%] overflow-x-visible mr-4 md:mr-6'}`}>
                <Avatar className="h-6 w-6 mt-1">
                  <AvatarFallback className={`text-xs ${message.type === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>
                    {message.type === 'user' ? <User className="h-3 w-3" /> : <Bot className="h-3 w-3" />}
                  </AvatarFallback>
                </Avatar>
                
                <div className="space-y-2 flex-1 min-w-0">
                  <div className={`rounded-lg p-3 pr-6 md:pr-8 break-words min-w-0 ${
                    message.type === 'user' 
                      ? 'bg-primary text-primary-foreground' 
                      : message.isError
                        ? 'bg-destructive/10 text-destructive border border-destructive/20'
                        : 'bg-muted'
                  }`}>
                    {message.type === 'assistant' ? (
                      <MarkdownText text={message.content} className="text-sm break-words" />
                    ) : (
                      <p className="text-sm whitespace-pre-wrap break-words">{message.content}</p>
                    )}
                  </div>

                  {/* Results Display */}
                  {message.data && (
                    <div className="space-y-3 pr-6 md:pr-8 overflow-x-visible">
                      {/* Missing Fields Prompt for Seller Slot-Filling */}
                      {message.data.requireMoreDetails && Array.isArray(message.data.missingFields) && message.data.missingFields.length > 0 && (
                        <Card className="bg-background border-amber-300/60">
                          <CardHeader className="pb-2 pr-4 md:pr-6">
                            <CardTitle className="text-sm">Missing Details</CardTitle>
                          </CardHeader>
                          <CardContent className="pt-0 pr-4 md:pr-6">
                            <div className="text-sm text-muted-foreground mb-2">Please provide these to complete the seller profile:</div>
                            <div className="flex flex-wrap gap-2">
                              {message.data.missingFields.map((f, idx) => (
                                <Badge key={idx} variant="outline" className="capitalize">{String(f).replace(/^seller_/,'').replace(/_/g,' ')}</Badge>
                              ))}
                            </div>
                          </CardContent>
                        </Card>
                      )}

                      {/* Transactions Status */}
                      {message.data.transactions && message.data.transactions.length > 0 && (
                        <Card className="bg-background">
                          <CardHeader className="pb-2 pr-4 md:pr-6">
                            <CardTitle className="text-sm flex items-center">
                              <FileText className="mr-2 h-4 w-4 text-blue-600" />
                              Transactions Status
                            </CardTitle>
                          </CardHeader>
                          <CardContent className="pt-0 pr-4 md:pr-6 space-y-2">
                            {message.data.transactions.slice(0,5).map((t, idx) => (
                              <div key={idx} className="text-sm">
                                <div className="font-medium">{t.title || t.property_address || t.address || `Deal ${t.id}`}</div>
                                <div className="text-muted-foreground">Stage: {t.current_stage || 'n/a'}</div>
                                {t.next_tasks && t.next_tasks.length > 0 && (
                                  <div className="text-muted-foreground">Next: {t.next_tasks[0].title}</div>
                                )}
                              </div>
                            ))}
                          </CardContent>
                        </Card>
                      )}

                      {/* Tasks Lists */}
                      {message.data.tasks && message.data.tasks.length > 0 && (
                        <Card className="bg-background">
                          <CardHeader className="pb-2 pr-4 md:pr-6">
                            <CardTitle className="text-sm flex items-center">
                              <CheckCircle className="mr-2 h-4 w-4 text-green-600" />
                              Tasks
                            </CardTitle>
                          </CardHeader>
                          <CardContent className="pt-0 pr-4 md:pr-6 space-y-2">
                            {message.data.tasks.slice(0,5).map((t, idx) => (
                              <div key={idx} className="flex items-center justify-between text-sm">
                                <div>
                                  <div className="font-medium">{t.title}</div>
                                  <div className="text-muted-foreground">Due: {t.due_date ? new Date(t.due_date).toLocaleString() : 'N/A'}</div>
                                </div>
                                {t.id && (
                                  <Button size="sm" variant="outline" onClick={async () => {
                                    try {
                                      const res = await fetch(`/api/checklist/${t.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'completed' }) })
                                      if (res.ok) {
                                        // Optimistic UI update
                                        t.status = 'completed'
                                      }
                                    } catch {}
                                  }}>Complete</Button>
                                )}
                              </div>
                            ))}
                          </CardContent>
                        </Card>
                      )}

                      {/* Alerts */}
                      {message.data.alerts && message.data.alerts.length > 0 && (
                        <Card className="bg-background">
                          <CardHeader className="pb-2 pr-4 md:pr-6">
                            <CardTitle className="text-sm flex items-center">
                              <AlertCircle className="mr-2 h-4 w-4 text-amber-600" />
                              Alerts
                            </CardTitle>
                          </CardHeader>
                          <CardContent className="pt-0 pr-4 md:pr-6 space-y-2">
                            {message.data.alerts.slice(0,5).map((a, idx) => (
                              <div key={idx} className="flex items-center justify-between text-sm">
                                <div>
                                  <div className="font-medium">{a.title || a.type}</div>
                                  <div className="text-muted-foreground">Priority: {a.priority || 'normal'}</div>
                                </div>
                                {a.id && (
                                  <Button size="sm" variant="outline" onClick={async () => {
                                    try {
                                      await fetch(`/api/alerts/dismiss/${a.id}`, { method: 'POST' })
                                    } catch {}
                                  }}>Dismiss</Button>
                                )}
                              </div>
                            ))}
                          </CardContent>
                        </Card>
                      )}

                      {/* Lead Information */}
                      {message.data.lead && (
                        <Card className="bg-background">
                          <CardHeader className="pb-2 pr-4 md:pr-6">
                            <div className="flex items-center justify-between gap-2">
                              <CardTitle className="text-sm flex items-center">
                                {message.data.isNewLead ? <UserPlus className="mr-2 h-4 w-4 text-green-600" /> : <CheckCircle className="mr-2 h-4 w-4 text-blue-600" />}
                                {message.data.isNewLead ? 'New Lead Created' : 'Existing Lead Found'}
                              </CardTitle>
                              <Badge className="shrink-0" variant={message.data.lead.lead_type === 'buyer' ? 'default' : 'secondary'}>
                                {message.data.lead.lead_type}
                              </Badge>
                            </div>
                          </CardHeader>
                          <CardContent className="pt-0 pr-4 md:pr-6">
                            <div className="space-y-2">
                              <p className="font-medium">{message.data.lead.name}</p>
                              <div className="grid grid-cols-2 gap-2 text-sm text-muted-foreground">
                                <span>Email: {message.data.lead.email}</span>
                                <span>Phone: {message.data.lead.phone}</span>
                              </div>
                              {message.data.lead.preferences && Object.keys(message.data.lead.preferences).length > 0 && (
                                <div className="mt-2 p-2 bg-muted rounded text-sm">
                                  <strong>{message.data.lead.lead_type === 'seller' ? 'Seller Details:' : 'Preferences:'}</strong>
                                  {message.data.lead.lead_type === 'seller' ? (
                                    <div className="grid grid-cols-2 gap-1 mt-1">
                                      {(message.data.lead.preferences.seller_address || message.data.lead.preferences.address) && (
                                        <span><MapPin className="inline h-3 w-3 mr-1" />{message.data.lead.preferences.seller_address || message.data.lead.preferences.address}</span>
                                      )}
                                      {(message.data.lead.preferences.seller_price ?? message.data.lead.preferences.asking_price) != null && (
                                        <span><DollarSign className="inline h-3 w-3 mr-1" />Ask: {formatCurrency(message.data.lead.preferences.seller_price ?? message.data.lead.preferences.asking_price)}</span>
                                      )}
                                      {(message.data.lead.preferences.seller_property_type || message.data.lead.preferences.property_type) && (
                                        <span><Home className="inline h-3 w-3 mr-1" />{message.data.lead.preferences.seller_property_type || message.data.lead.preferences.property_type}</span>
                                      )}
                                      {(message.data.lead.preferences.seller_bedrooms || message.data.lead.preferences.bedrooms) && (
                                        <span><Bed className="inline h-3 w-3 mr-1" />{message.data.lead.preferences.seller_bedrooms || message.data.lead.preferences.bedrooms} bed</span>
                                      )}
                                      {(message.data.lead.preferences.seller_bathrooms || message.data.lead.preferences.bathrooms) && (
                                        <span><Bath className="inline h-3 w-3 mr-1" />{message.data.lead.preferences.seller_bathrooms || message.data.lead.preferences.bathrooms} bath</span>
                                      )}
                                      {(message.data.lead.preferences.seller_year_built || message.data.lead.preferences.year_built) && (
                                        <span>Year: {message.data.lead.preferences.seller_year_built || message.data.lead.preferences.year_built}</span>
                                      )}
                                      {(message.data.lead.preferences.seller_square_feet || message.data.lead.preferences.square_feet) && (
                                        <span><Square className="inline h-3 w-3 mr-1" />{message.data.lead.preferences.seller_square_feet || message.data.lead.preferences.square_feet} sqft</span>
                                      )}
                                      {(message.data.lead.preferences.seller_lot_size || message.data.lead.preferences.lot_size) && (
                                        <span>Lot: {message.data.lead.preferences.seller_lot_size || message.data.lead.preferences.lot_size}</span>
                                      )}
                                      {(message.data.lead.preferences.seller_condition || message.data.lead.preferences.condition) && (
                                        <span>Condition: {message.data.lead.preferences.seller_condition || message.data.lead.preferences.condition}</span>
                                      )}
                                      {(message.data.lead.preferences.seller_occupancy || message.data.lead.preferences.occupancy) && (
                                        <span>Occupancy: {message.data.lead.preferences.seller_occupancy || message.data.lead.preferences.occupancy}</span>
                                      )}
                                      {(message.data.lead.preferences.seller_timeline || message.data.lead.preferences.timeline) && (
                                        <span>Timeline: {message.data.lead.preferences.seller_timeline || message.data.lead.preferences.timeline}</span>
                                      )}
                                      {(message.data.lead.preferences.seller_hoa_fee != null || message.data.lead.preferences.hoa_fee != null) && (
                                        <span>HOA: {formatCurrency((message.data.lead.preferences.seller_hoa_fee ?? message.data.lead.preferences.hoa_fee) || 0)}/mo</span>
                                      )}
                                      {(message.data.lead.preferences.seller_description || message.data.lead.preferences.description || message.data.lead.preferences.notes) && (
                                        <span className="col-span-2">Notes: {message.data.lead.preferences.seller_description || message.data.lead.preferences.description || message.data.lead.preferences.notes}</span>
                                      )}
                                    </div>
                                  ) : (
                                    <div className="grid grid-cols-2 gap-1 mt-1">
                                      {message.data.lead.preferences.zipcode && (
                                        <span><MapPin className="inline h-3 w-3 mr-1" />{message.data.lead.preferences.zipcode}</span>
                                      )}
                                      {message.data.lead.preferences.bedrooms && (
                                        <span><Bed className="inline h-3 w-3 mr-1" />{message.data.lead.preferences.bedrooms} bed</span>
                                      )}
                                      {message.data.lead.preferences.min_price && (
                                        <span><DollarSign className="inline h-3 w-3 mr-1" />Min: {formatCurrency(message.data.lead.preferences.min_price)}</span>
                                      )}
                                      {message.data.lead.preferences.max_price && (
                                        <span><DollarSign className="inline h-3 w-3 mr-1" />Max: {formatCurrency(message.data.lead.preferences.max_price)}</span>
                                      )}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          </CardContent>
                        </Card>
                      )}

                      {/* Properties Results */}
                      {message.data.properties && message.data.properties.length > 0 && (
                        <ChatPropertyResults
                          properties={message.data.properties}
                          totalCount={message.data.propertiesCount}
                        />
                      )}

                      {/* No Properties Found */}
                      {Array.isArray(message.data.properties) && message.data.properties.length === 0 && /find_properties|search|properties|listing/i.test(String(message.data.intent || '')) && (
                        <Card className="bg-background border-dashed">
                          <CardContent className="p-4 text-center">
                            <Home className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
                            <p className="text-sm text-muted-foreground">No properties found matching the criteria</p>
                          </CardContent>
                        </Card>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
          
          {isLoading && (
            <div className="flex justify-start">
              <div className="flex items-start space-x-2 max-w-[80%] min-w-0">
                <Avatar className="h-6 w-6 mt-1">
                  <AvatarFallback className="bg-muted">
                    <Bot className="h-3 w-3" />
                  </AvatarFallback>
                </Avatar>
                <div className="rounded-lg p-3 bg-muted">
                  <div className="flex items-center space-x-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <p className="text-sm">Processing your request...</p>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </ScrollArea>

      <Separator />

      {/* Chat Input */}
      <div className="p-4">
        <div className="flex space-x-2">
          <Input
            value={inputMessage}
            onChange={(e) => setInputMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Try: 'Just met John Smith. Looking for 3BR in Dallas under $400K'"
            className="flex-1"
          />
          <Button 
            onClick={isLoading ? cancelActiveRequest : handleSendMessage}
            disabled={!isLoading && !inputMessage.trim()}
            className="shrink-0"
            title={isLoading ? 'Stop request' : 'Send'}
          >
            {isLoading ? (
              <X className="h-4 w-4" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          Tip: Use natural language like "Met Sarah, wants 2BHK in Austin under $350K" or "John selling condo in NYC for $800K"
        </p>
      </div>
    </div>
  )
}







