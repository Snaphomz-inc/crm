'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious } from '@/components/ui/carousel'
import { Bed, Bath, Square, Image as ImageIcon } from 'lucide-react'

function formatCurrency(amount) {
  if (amount === undefined || amount === null || amount === '' || Number.isNaN(Number(amount))) return 'N/A'
  const num = typeof amount === 'string' ? Number(amount) : amount
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }).format(num)
  } catch {
    return `$${num}`
  }
}

function getThumb(p) {
  const candidates = [
    p.thumbnail,
    p.thumbnail_url,
    p.primary_image,
    p.primary_photo_url,
    p.image_url,
    p.photo_url,
    Array.isArray(p.images) && p.images[0],
    Array.isArray(p.photos) && p.photos[0]?.url,
    Array.isArray(p.photos) && p.photos[0],
  ].filter(Boolean)
  return candidates.length ? candidates[0] : null
}

function getAddressText(property) {
  return typeof property.address === 'object'
    ? (property.address.street || property.address.address || 'Property')
    : (property.address || 'Property')
}

function buildLeadInsightsFromSavedProperties(savedProperties = []) {
  const list = Array.isArray(savedProperties) ? savedProperties : []
  if (!list.length) return null

  const first = list[0] || {}
  const formatMoney = (v) => {
    const n = Number(v)
    return Number.isFinite(n)
      ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }).format(n)
      : 'N/A'
  }

  const lines = []
  lines.push('### AI Insights')
  if (list.length === 1) {
    const p = first
    lines.push(`1) Selected Property`)
    lines.push(`- Address: ${getAddressText(p)}`)
    lines.push(`- Price: ${formatMoney(p?.price)}`)
    lines.push(`- Bedrooms / Bathrooms: ${p?.bedrooms ?? 'N/A'} / ${p?.bathrooms ?? 'N/A'}`)
    lines.push(`- Location: ${[p?.city, p?.state, p?.zipcode].filter(Boolean).join(', ') || 'N/A'}`)
    lines.push('')
    lines.push('### Summary')
    lines.push('- One property has been finalized as the saved lead preference.')
    lines.push('')
    lines.push('### Next Steps')
    lines.push('- Start transaction for this property and schedule showing/offer workflow.')
  } else {
    list.slice(0, 5).forEach((p, i) => {
      lines.push(`${i + 1}) Saved Property`)
      lines.push(`- Address: ${getAddressText(p)}`)
      lines.push(`- Price: ${formatMoney(p?.price)}`)
      lines.push(`- Bedrooms / Bathrooms: ${p?.bedrooms ?? 'N/A'} / ${p?.bathrooms ?? 'N/A'}`)
      lines.push(`- Location: ${[p?.city, p?.state, p?.zipcode].filter(Boolean).join(', ') || 'N/A'}`)
      lines.push('')
    })
    lines.push('### Summary')
    lines.push(`- ${list.length} properties are currently saved for this lead.`)
    lines.push('')
    lines.push('### Next Steps')
    lines.push('- Compare saved properties and start a transaction for the preferred one.')
  }

  return lines.join('\n')
}

function PropertyLine({ property, onSave, canSave, isSaving, isSaved }) {
  const thumb = getThumb(property)
  const addressText = getAddressText(property)
  return (
    <div className="flex items-start justify-between gap-3 p-2 rounded hover:bg-muted/50">
      <div className="flex items-center gap-3 min-w-0">
        <div className="h-16 w-16 rounded overflow-hidden bg-muted flex items-center justify-center">
          {thumb ? (
            <img src={thumb} alt={addressText} className="h-full w-full object-cover" />
          ) : (
            <ImageIcon className="h-5 w-5 text-muted-foreground" />
          )}
        </div>
        <div className="min-w-0">
          <div className="font-medium text-sm truncate">{addressText}</div>
          <div className="text-xs text-muted-foreground truncate">
            {[property.city, property.state, property.zipcode].filter(Boolean).join(', ')}
          </div>
          <div className="flex gap-3 text-xs text-muted-foreground mt-1">
            {property.bedrooms ? <span className="flex items-center"><Bed className="mr-1 h-3 w-3" />{property.bedrooms}</span> : null}
            {property.bathrooms ? <span className="flex items-center"><Bath className="mr-1 h-3 w-3" />{property.bathrooms}</span> : null}
            {property.square_feet ? <span className="flex items-center"><Square className="mr-1 h-3 w-3" />{property.square_feet} sq ft</span> : null}
          </div>
        </div>
      </div>
      <div className="text-right shrink-0">
        {property.price ? <div className="font-bold text-primary text-sm">{formatCurrency(property.price)}</div> : null}
        <div className="mt-2 flex items-center gap-1 justify-end">
          <Button size="sm" variant="outline" disabled={!canSave || isSaving || isSaved} onClick={() => onSave?.(property)}>
            {isSaving ? 'Saving...' : (isSaved ? 'Saved' : 'Save')}
          </Button>
          <Button size="sm" variant="ghost">Compare</Button>
        </div>
      </div>
    </div>
  )
}

function PropertyCard({ property, rank, onSave, canSave, isSaving, isSaved }) {
  const thumb = getThumb(property)
  const addressText = getAddressText(property)
  const locationText = [property.city, property.state, property.zipcode].filter(Boolean).join(', ')
  const propertyType = property.property_type || 'Residential'

  return (
    <Card className="overflow-hidden rounded-2xl border-[#d9dde5] shadow-sm">
      <div className="relative h-44 bg-muted">
        {thumb ? (
          <img src={thumb} alt={addressText} className="h-full w-full object-cover" />
        ) : (
          <div className="h-full w-full flex items-center justify-center">
            <ImageIcon className="h-8 w-8 text-muted-foreground" />
          </div>
        )}
        <div className="absolute left-3 top-3 rounded-xl bg-[#2d3748]/85 px-3 py-1 text-sm font-semibold text-white">
          {propertyType}
        </div>
        <div className="absolute right-3 top-3 rounded-xl bg-white/90 px-3 py-1 text-xl font-bold text-[#1e293b]">
          #{rank}
        </div>
      </div>
      <CardContent className="p-4">
        <div className="text-2xl font-semibold text-[#1f2937] mb-1">{formatCurrency(property.price)}</div>
        <div className="text-[#4b5563] text-lg font-medium truncate">{addressText}</div>
        <div className="text-[#6b7280] text-base truncate">{locationText}</div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-[#4b5563]">
          {property.bedrooms ? <span className="flex items-center gap-1"><Bed className="h-4 w-4" /> {property.bedrooms} Beds</span> : null}
          {property.bathrooms ? <span className="flex items-center gap-1"><Bath className="h-4 w-4" /> {property.bathrooms} Baths</span> : null}
          {property.square_feet ? <span className="flex items-center gap-1"><Square className="h-4 w-4" /> {property.square_feet} sqft</span> : null}
        </div>
        <div className="mt-4 flex items-center justify-between gap-2">
          <Badge variant="outline" className="rounded-full px-3 py-1 text-sm">Pool</Badge>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={!canSave || isSaving || isSaved} onClick={() => onSave?.(property)}>
              {isSaving ? 'Saving...' : (isSaved ? 'Saved' : 'Save')}
            </Button>
            <Button variant="ghost" className="text-[#e67f2f] font-semibold text-base h-8 px-2">Show More</Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export default function ChatPropertyResults({ properties = [], totalCount, leadId = null, lead = null }) {
  const [savingKeys, setSavingKeys] = useState({})
  const [savedKeys, setSavedKeys] = useState({})
  const [resolvedLeadId, setResolvedLeadId] = useState(leadId || null)
  const canSave = Boolean(resolvedLeadId || leadId || lead?.name)

  const normalizeName = (v) =>
    String(v || '')
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()

  useEffect(() => {
    setResolvedLeadId(leadId || null)
  }, [leadId])

  const keyForProperty = useMemo(() => (property) => {
    const idPart = property?.id || property?.property_id || property?.mls_id || ''
    const addrPart = getAddressText(property)
    const zip = property?.zipcode || ''
    return `${idPart}|${addrPart}|${zip}`
  }, [])

  const savePropertyForLead = async (property) => {
    const key = keyForProperty(property)
    setSavingKeys((prev) => ({ ...prev, [key]: true }))
    try {
      const readErrorText = async (res) => {
        try {
          const t = await res.text()
          return t || `${res.status} ${res.statusText}`
        } catch {
          return `${res.status} ${res.statusText}`
        }
      }
      let activeLeadId = null

      const ensureLeadId = async () => {
        if (activeLeadId) return activeLeadId
        const hasIdentity = Boolean(lead?.name || lead?.email || lead?.phone)
        if (!hasIdentity) return null

        // 1) Try finding an existing lead by name first.
        try {
          if (lead?.name) {
            const q = encodeURIComponent(lead.name)
            const findRes = await fetch(`/api/leads?search=${q}`)
            if (findRes.ok) {
              const list = await findRes.json()
              const found = Array.isArray(list)
                ? list.find((l) => normalizeName(l?.name) === normalizeName(lead?.name))
                : null
              if (found?.id) {
                activeLeadId = found.id
                setResolvedLeadId(found.id)
                return activeLeadId
              }
            }
          }
        } catch (_) {}

        // 1b) Try finding by email/phone if present.
        try {
          if (lead?.email || lead?.phone) {
            const findRes = await fetch('/api/leads')
            if (findRes.ok) {
              const list = await findRes.json()
              const found = Array.isArray(list)
                ? list.find((l) =>
                    (lead?.email && String(l?.email || '').toLowerCase() === String(lead.email || '').toLowerCase()) ||
                    (lead?.phone && String(l?.phone || '') === String(lead.phone || ''))
                  )
                : null
              if (found?.id) {
                activeLeadId = found.id
                setResolvedLeadId(found.id)
                return activeLeadId
              }
            }
          }
        } catch (_) {}

        // 2) Create a new lead if none found.
        const createRes = await fetch('/api/leads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: lead.name,
            email: lead.email || null,
            phone: lead.phone || null,
            lead_type: lead.lead_type || 'buyer',
            preferences: lead.preferences || {},
            source: 'assistant',
            // Saving a property should be fast/reliable; insights can be generated later.
            skip_ai_insights: true
          })
        })
        if (createRes.status === 409) {
          try {
            const dup = await createRes.json()
            const existingLeadId = dup?.existing_lead
            if (existingLeadId) {
              activeLeadId = existingLeadId
              setResolvedLeadId(existingLeadId)
              return activeLeadId
            }
          } catch (_) {}
          return null
        }
        if (!createRes.ok) {
          const msg = await readErrorText(createRes)
          throw new Error(`Create lead failed: ${msg}`)
        }
        const createdLead = await createRes.json()
        if (createdLead?.id) {
          activeLeadId = createdLead.id
          setResolvedLeadId(createdLead.id)
        }
        return activeLeadId
      }

      // Prefer stable identity resolution over potentially stale ids from old chat state.
      activeLeadId = await ensureLeadId()
      if (!activeLeadId) {
        activeLeadId = resolvedLeadId || leadId || null
      }
      if (!activeLeadId) {
        throw new Error('No lead available for save')
      }

      let leadRes = await fetch(`/api/leads/${activeLeadId}`)
      if (leadRes.status === 404 && (lead?.name || lead?.email || lead?.phone)) {
        // Recover from stale lead id by re-resolving/creating a fresh lead once.
        setResolvedLeadId(null)
        activeLeadId = null
        activeLeadId = await ensureLeadId()
        if (!activeLeadId) throw new Error('Lead not found and failed to recreate')
        leadRes = await fetch(`/api/leads/${activeLeadId}`)
      }
      if (!leadRes.ok) {
        const msg = await readErrorText(leadRes)
        throw new Error(`Load lead failed: ${msg}`)
      }
      const leadDoc = await leadRes.json()

      const existing = Array.isArray(leadDoc?.interested_properties) ? leadDoc.interested_properties : []
      const exists = existing.some((p) => keyForProperty(p) === key)
      if (exists) {
        setSavedKeys((prev) => ({ ...prev, [key]: true }))
        return
      }

      const nextInterested = [...existing, property]
      const aiInsightsFromSaved = buildLeadInsightsFromSavedProperties(nextInterested)
      const updateRes = await fetch(`/api/leads/${activeLeadId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          interested_properties: nextInterested,
          ...(aiInsightsFromSaved ? { ai_insights: aiInsightsFromSaved } : {})
        })
      })
      if (!updateRes.ok) {
        const msg = await readErrorText(updateRes)
        throw new Error(`Save property failed: ${msg}`)
      }

      setSavedKeys((prev) => ({ ...prev, [key]: true }))
      if (typeof window !== 'undefined') {
        try {
          window.dispatchEvent(new CustomEvent('crm:lead-property-saved', {
            detail: {
              leadId: activeLeadId,
              leadName: leadDoc?.name || lead?.name || null,
              propertyAddress: getAddressText(property)
            }
          }))
        } catch {}
      }
    } catch (error) {
      console.error('Failed to save property for lead:', error)
      window.alert(`Could not save this property to the lead.\n${error?.message || ''}`)
    } finally {
      setSavingKeys((prev) => ({ ...prev, [key]: false }))
    }
  }

  const count = totalCount ?? properties.length
  const topPicks = properties.slice(0, 3)
  const remaining = Math.max(0, count - topPicks.length)

  return (
    <div className="space-y-2 w-full pr-2 md:pr-4">
      <div className="flex items-center justify-between gap-2 pr-2 min-w-0">
        <p className="text-xl font-medium truncate text-[#3f3f46]">Found {count} properties • Top picks</p>
        <div className="flex items-center gap-2 shrink-0">
          <Badge variant="outline" className="text-sm">{topPicks.length} shown</Badge>
          {remaining > 0 && (
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 px-2 shrink-0">Show all ({remaining})</Button>
              </SheetTrigger>
              <SheetContent side="right" className="sm:max-w-xl w-full">
                <SheetHeader>
                  <SheetTitle>All results ({count})</SheetTitle>
                </SheetHeader>
                <div className="py-3 pr-2">
                  <ScrollArea className="h-[78vh] pr-4">
                    <div className="space-y-2">
                      {properties.map((p, i) => (
                        <Card key={i} className="bg-background">
                          <CardContent className="p-2">
                            <PropertyLine
                              property={p}
                              onSave={savePropertyForLead}
                              canSave={canSave}
                              isSaving={Boolean(savingKeys[keyForProperty(p)])}
                              isSaved={Boolean(savedKeys[keyForProperty(p)])}
                            />
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  </ScrollArea>
                </div>
              </SheetContent>
            </Sheet>
          )}
        </div>
      </div>

      <Card className="bg-background overflow-visible">
        <CardContent className="p-3 pr-6">
          <div className="relative overflow-visible">
            <Carousel className="w-full overflow-visible">
              <CarouselContent>
                {topPicks.map((p, idx) => (
                  <CarouselItem key={idx} className="basis-full lg:basis-1/2 xl:basis-1/3">
                    <div className="p-1">
                      <PropertyCard
                        property={p}
                        rank={idx + 1}
                        onSave={savePropertyForLead}
                        canSave={canSave}
                        isSaving={Boolean(savingKeys[keyForProperty(p)])}
                        isSaved={Boolean(savedKeys[keyForProperty(p)])}
                      />
                    </div>
                  </CarouselItem>
                ))}
              </CarouselContent>
              <CarouselPrevious className="left-2" />
              <CarouselNext className="right-2" />
            </Carousel>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
