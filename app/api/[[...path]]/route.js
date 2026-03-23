import { Pool } from 'pg'
import { randomUUID } from 'crypto'
import { NextResponse } from 'next/server'
import fs from 'fs'
import nodePath from 'path'
import crypto from 'crypto'
import { AsyncLocalStorage } from 'async_hooks'

const uuidv4 = () => randomUUID()

// Database connection
let pgPool
let db
let dbInitPromise = null
let dbMode = 'uninitialized'
let dbConnectedLogEmitted = false
let dbMissingConfigLogEmitted = false
let dbConnectErrorLogEmitted = false
let dbInMemoryLogEmitted = false

const PG_DOC_TABLE = 'crm_documents'
const GOOGLE_CALENDAR_CONNECTIONS_COLLECTION = 'google_calendar_connections'
const CALENDAR_CONNECTIONS_COLLECTION = 'calendar_connections'
const CALENDAR_EVENTS_COLLECTION = 'calendar_events'
const GOOGLE_STATE_TTL_MS = 10 * 60 * 1000
const CALENDAR_STATE_TTL_MS = 10 * 60 * 1000
const GOOGLE_OAUTH_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/calendar.events'
]
const OUTLOOK_OAUTH_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'Calendars.ReadWrite'
]
const CALENDAR_PROVIDER_GOOGLE = 'google'
const CALENDAR_PROVIDER_OUTLOOK = 'outlook'
const CALENDAR_PROVIDER_IDS = [CALENDAR_PROVIDER_GOOGLE, CALENDAR_PROVIDER_OUTLOOK]
const CALENDAR_TOKEN_ENCRYPTION_PREFIX = 'enc:v1'
const GRAPH_API_BASE_URL = 'https://graph.microsoft.com/v1.0'
const CRM_USER_SCOPED_COLLECTIONS = new Set([
  'transactions',
  'checklist_items',
  'leads',
  'smart_alerts',
  'assistant_conversations',
  'property_searches',
  'pmd_plans',
  'assistant_plans',
  'notifications',
  'notification_preferences',
  'notification_email_log'
])
const requestScopeStorage = new AsyncLocalStorage()

function buildOwnerScopedFilter(filter = {}, ownerUserId = null) {
  const normalized = isPlainObject(filter) ? filter : {}
  if (!ownerUserId) return normalized
  if (Object.keys(normalized).length === 0) return { owner_user_id: ownerUserId }
  return { $and: [{ owner_user_id: ownerUserId }, normalized] }
}

function withOwnerUserId(doc = {}, ownerUserId = null) {
  if (!ownerUserId || !isPlainObject(doc)) return doc
  return { ...doc, owner_user_id: ownerUserId }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) && !(value instanceof RegExp)
}

function cloneDoc(value) {
  if (typeof structuredClone === 'function') return structuredClone(value)
  return JSON.parse(JSON.stringify(value))
}

function getFieldValue(obj, field) {
  if (!field || typeof field !== 'string') return undefined
  if (!field.includes('.')) return obj?.[field]
  const parts = field.split('.')
  let current = obj
  for (const part of parts) {
    if (current === null || current === undefined) return undefined
    current = current[part]
  }
  return current
}

function setFieldValue(obj, field, value) {
  if (!field || typeof field !== 'string' || !isPlainObject(obj)) return
  if (!field.includes('.')) {
    obj[field] = value
    return
  }
  const parts = field.split('.')
  let current = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]
    if (!isPlainObject(current[part])) current[part] = {}
    current = current[part]
  }
  current[parts[parts.length - 1]] = value
}

function unsetFieldValue(obj, field) {
  if (!field || typeof field !== 'string' || !isPlainObject(obj)) return
  if (!field.includes('.')) {
    delete obj[field]
    return
  }
  const parts = field.split('.')
  let current = obj
  for (let i = 0; i < parts.length - 1; i++) {
    current = current?.[parts[i]]
    if (!isPlainObject(current)) return
  }
  delete current[parts[parts.length - 1]]
}

function toDateMillis(value) {
  if (value instanceof Date) {
    const t = value.getTime()
    return Number.isNaN(t) ? null : t
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(T|\s|$)/.test(value)) {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

function normalizeComparable(value) {
  const asDate = toDateMillis(value)
  if (asDate !== null) return asDate
  if (typeof value === 'number') return value
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  return value
}

function valuesEqual(left, right) {
  if (left === right) return true
  const leftDate = toDateMillis(left)
  const rightDate = toDateMillis(right)
  if (leftDate !== null && rightDate !== null) return leftDate === rightDate
  return false
}

function deepEqual(a, b) {
  if (a === b) return true
  if (a === null || b === null || typeof a !== typeof b) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false
    }
    return true
  }
  if (isPlainObject(a)) {
    if (!isPlainObject(b)) return false
    const keysA = Object.keys(a)
    const keysB = Object.keys(b)
    if (keysA.length !== keysB.length) return false
    for (const key of keysA) {
      if (!deepEqual(a[key], b[key])) return false
    }
    return true
  }
  return false
}

function compareForSort(a, b) {
  const left = normalizeComparable(a)
  const right = normalizeComparable(b)
  if (left === right) return 0
  if (left === undefined || left === null) return 1
  if (right === undefined || right === null) return -1
  if (typeof left === 'string' && typeof right === 'string') return left.localeCompare(right)
  return left > right ? 1 : -1
}

function applySort(docs, sortSpec = {}) {
  const entries = Object.entries(sortSpec).filter(([, direction]) => direction === 1 || direction === -1)
  if (!entries.length) return docs
  return [...docs].sort((a, b) => {
    for (const [field, direction] of entries) {
      const cmp = compareForSort(getFieldValue(a, field), getFieldValue(b, field))
      if (cmp !== 0) return direction === -1 ? -cmp : cmp
    }
    return 0
  })
}

function applyProjection(doc, projection = null) {
  if (!projection || !isPlainObject(projection) || Object.keys(projection).length === 0) return doc
  const include = Object.entries(projection).filter(([, v]) => v === 1).map(([k]) => k)
  const exclude = Object.entries(projection).filter(([, v]) => v === 0).map(([k]) => k)
  if (include.length) {
    const out = {}
    for (const key of include) out[key] = getFieldValue(doc, key)
    return out
  }
  const out = cloneDoc(doc)
  for (const key of exclude) delete out[key]
  return out
}

function matchesCondition(actualValue, condition) {
  if (condition instanceof RegExp) {
    if (actualValue === null || actualValue === undefined) return false
    return condition.test(String(actualValue))
  }
  if (isPlainObject(condition)) {
    const keys = Object.keys(condition)
    const operatorKeys = keys.filter((k) => k.startsWith('$'))
    if (!operatorKeys.length) return deepEqual(actualValue, condition)

    for (const op of operatorKeys) {
      const expected = condition[op]
      if (op === '$options') continue
      if (op === '$ne') {
        if (valuesEqual(actualValue, expected)) return false
        continue
      }
      if (op === '$in') {
        if (!Array.isArray(expected)) return false
        if (Array.isArray(actualValue)) {
          if (!actualValue.some((item) => expected.some((candidate) => valuesEqual(item, candidate)))) return false
        } else if (!expected.some((candidate) => valuesEqual(actualValue, candidate))) {
          return false
        }
        continue
      }
      if (op === '$nin') {
        if (!Array.isArray(expected)) return false
        if (Array.isArray(actualValue)) {
          if (actualValue.some((item) => expected.some((candidate) => valuesEqual(item, candidate)))) return false
        } else if (expected.some((candidate) => valuesEqual(actualValue, candidate))) {
          return false
        }
        continue
      }
      if (op === '$exists') {
        const exists = actualValue !== undefined
        if (Boolean(expected) !== exists) return false
        continue
      }
      if (op === '$regex') {
        const flags = typeof condition.$options === 'string' ? condition.$options : ''
        const regex = expected instanceof RegExp ? expected : new RegExp(String(expected ?? ''), flags)
        if (actualValue === null || actualValue === undefined || !regex.test(String(actualValue))) return false
        continue
      }
      if (op === '$gt' || op === '$gte' || op === '$lt' || op === '$lte') {
        const left = normalizeComparable(actualValue)
        const right = normalizeComparable(expected)
        if (left === undefined || left === null || right === undefined || right === null) return false
        if (op === '$gt' && !(left > right)) return false
        if (op === '$gte' && !(left >= right)) return false
        if (op === '$lt' && !(left < right)) return false
        if (op === '$lte' && !(left <= right)) return false
        continue
      }
      if (!valuesEqual(actualValue, expected)) return false
    }
    return true
  }
  if (condition === null) return actualValue === null || actualValue === undefined
  return valuesEqual(actualValue, condition)
}

function matchesQuery(doc, query = {}) {
  if (!query || !isPlainObject(query) || Object.keys(query).length === 0) return true
  for (const [key, value] of Object.entries(query)) {
    if (key === '$or') {
      if (!Array.isArray(value) || !value.some((sub) => matchesQuery(doc, sub))) return false
      continue
    }
    if (key === '$and') {
      if (!Array.isArray(value) || !value.every((sub) => matchesQuery(doc, sub))) return false
      continue
    }
    const actual = getFieldValue(doc, key)
    if (!matchesCondition(actual, value)) return false
  }
  return true
}

function createCursor(loadDocs, query = {}) {
  let sortSpec = null
  let limitCount = null
  let projection = null
  return {
    sort(spec = {}) {
      sortSpec = spec
      return this
    },
    limit(count) {
      const parsed = Number(count)
      limitCount = Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null
      return this
    },
    project(spec = {}) {
      projection = spec
      return this
    },
    async toArray() {
      let docs = (await loadDocs()).filter((doc) => matchesQuery(doc, query))
      if (sortSpec) docs = applySort(docs, sortSpec)
      if (limitCount !== null) docs = docs.slice(0, limitCount)
      if (projection) docs = docs.map((doc) => applyProjection(doc, projection))
      return docs.map((doc) => cloneDoc(doc))
    },
    async next() {
      const docs = await this.limit(1).toArray()
      return docs[0] || null
    }
  }
}

function createCollectionAdapter(loadAll, persistOne, removeByIds, { collectionName = '' } = {}) {
  const resolveOwnerUserId = () => {
    const scopedName = String(collectionName || '')
    if (!CRM_USER_SCOPED_COLLECTIONS.has(scopedName)) return null
    const scope = requestScopeStorage.getStore()
    if (!scope || !scope.userKey) return null
    return normalizeUserKey(scope.userKey)
  }

  const scopeFilter = (filter = {}) => buildOwnerScopedFilter(filter, resolveOwnerUserId())

  return {
    find(query = {}) {
      return createCursor(loadAll, scopeFilter(query))
    },
    async findOne(filter = {}) {
      const docs = await loadAll()
      const found = docs.find((doc) => matchesQuery(doc, scopeFilter(filter)))
      return found ? cloneDoc(found) : null
    },
    async countDocuments(filter = {}) {
      const docs = await loadAll()
      return docs.filter((doc) => matchesQuery(doc, scopeFilter(filter))).length
    },
    async insertOne(doc = {}) {
      const ownerUserId = resolveOwnerUserId()
      const id = String(doc.id || uuidv4())
      const payload = withOwnerUserId({ ...doc, id }, ownerUserId)
      await persistOne(payload)
      return { insertedId: id }
    },
    async insertMany(docs = []) {
      const ownerUserId = resolveOwnerUserId()
      const insertedIds = {}
      for (let i = 0; i < docs.length; i++) {
        const doc = docs[i]
        const id = String(doc.id || uuidv4())
        await persistOne(withOwnerUserId({ ...doc, id }, ownerUserId))
        insertedIds[i] = id
      }
      return { insertedCount: docs.length, insertedIds }
    },
    async updateOne(filter = {}, update = {}) {
      const ownerUserId = resolveOwnerUserId()
      const docs = await loadAll()
      const index = docs.findIndex((doc) => matchesQuery(doc, scopeFilter(filter)))
      if (index === -1) return { matchedCount: 0, modifiedCount: 0 }
      const target = docs[index]
      const nextDoc = cloneDoc(target)
      const hasOperators = isPlainObject(update) && Object.keys(update).some((key) => key.startsWith('$'))

      if (hasOperators) {
        const setPatch = isPlainObject(update.$set) ? update.$set : {}
        for (const [key, value] of Object.entries(setPatch)) {
          setFieldValue(nextDoc, key, value)
        }

        const unsetPatch = isPlainObject(update.$unset) ? update.$unset : {}
        for (const key of Object.keys(unsetPatch)) {
          unsetFieldValue(nextDoc, key)
        }

        const pushPatch = isPlainObject(update.$push) ? update.$push : {}
        for (const [key, rawValue] of Object.entries(pushPatch)) {
          const existing = getFieldValue(nextDoc, key)
          const arr = Array.isArray(existing) ? [...existing] : []
          if (isPlainObject(rawValue) && Array.isArray(rawValue.$each)) {
            arr.push(...rawValue.$each)
          } else {
            arr.push(rawValue)
          }
          setFieldValue(nextDoc, key, arr)
        }
      } else if (isPlainObject(update)) {
        Object.assign(nextDoc, update)
      }

      if (ownerUserId) nextDoc.owner_user_id = ownerUserId
      if (!nextDoc.id) nextDoc.id = String(target.id || uuidv4())
      await persistOne(nextDoc)
      return { matchedCount: 1, modifiedCount: 1 }
    },
    async deleteOne(filter = {}) {
      const docs = await loadAll()
      const target = docs.find((doc) => matchesQuery(doc, scopeFilter(filter)))
      if (!target?.id) return { deletedCount: 0 }
      const deleted = await removeByIds([String(target.id)])
      return { deletedCount: deleted }
    },
    async deleteMany(filter = {}) {
      const docs = await loadAll()
      const ids = docs.filter((doc) => matchesQuery(doc, scopeFilter(filter))).map((doc) => String(doc.id)).filter(Boolean)
      if (!ids.length) return { deletedCount: 0 }
      const deleted = await removeByIds(ids)
      return { deletedCount: deleted }
    }
  }
}

function createInMemoryDb() {
  const data = new Map()
  return {
    collection(name) {
      if (!data.has(name)) data.set(name, [])
      const list = data.get(name)
      return createCollectionAdapter(
        async () => list,
        async (doc) => {
          const idx = list.findIndex((item) => item.id === doc.id)
          if (idx >= 0) list[idx] = cloneDoc(doc)
          else list.push(cloneDoc(doc))
        },
        async (ids) => {
          const idSet = new Set(ids)
          const keep = list.filter((item) => !idSet.has(String(item.id)))
          const deletedCount = list.length - keep.length
          list.length = 0
          keep.forEach((item) => list.push(item))
          return deletedCount
        },
        { collectionName: name }
      )
    }
  }
}

async function ensurePgSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${PG_DOC_TABLE} (
      collection_name TEXT NOT NULL,
      doc_id TEXT NOT NULL,
      doc JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (collection_name, doc_id)
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_${PG_DOC_TABLE}_collection ON ${PG_DOC_TABLE} (collection_name)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS calendar_connections (
      id UUID PRIMARY KEY,
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('google', 'outlook')),
      connected_email TEXT,
      access_token TEXT,
      refresh_token TEXT,
      token_type TEXT,
      scope TEXT,
      calendar_id TEXT,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, provider)
    )
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_calendar_connections_user_id
    ON calendar_connections (user_id)
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS calendar_events (
      id UUID PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      start_time TIMESTAMPTZ NOT NULL,
      end_time TIMESTAMPTZ NOT NULL,
      description TEXT,
      location TEXT,
      attendees JSONB NOT NULL DEFAULT '[]'::jsonb,
      source_type TEXT,
      source_id TEXT,
      transaction_id TEXT,
      sync_status TEXT NOT NULL DEFAULT 'pending',
      sync_error TEXT,
      synced_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'active',
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_calendar_events_user_start_time
    ON calendar_events (user_id, start_time)
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_calendar_events_transaction_id
    ON calendar_events (transaction_id)
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS event_provider_mapping (
      id UUID PRIMARY KEY,
      event_id UUID NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
      connection_id UUID NOT NULL REFERENCES calendar_connections(id) ON DELETE CASCADE,
      external_event_id TEXT NOT NULL,
      external_event_link TEXT,
      sync_status TEXT NOT NULL DEFAULT 'pending',
      sync_error TEXT,
      last_synced_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (event_id, connection_id),
      UNIQUE (connection_id, external_event_id)
    )
  `)

  // Backward-compatible shape evolution (safe no-op when columns already exist)
  await pool.query(`ALTER TABLE calendar_connections ADD COLUMN IF NOT EXISTS token_type TEXT`)
  await pool.query(`ALTER TABLE calendar_connections ADD COLUMN IF NOT EXISTS scope TEXT`)
  await pool.query(`ALTER TABLE calendar_connections ADD COLUMN IF NOT EXISTS calendar_id TEXT`)
  await pool.query(`ALTER TABLE calendar_connections ALTER COLUMN access_token DROP NOT NULL`)
  await pool.query(`ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS attendees JSONB NOT NULL DEFAULT '[]'::jsonb`)
  await pool.query(`ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS source_type TEXT`)
  await pool.query(`ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS source_id TEXT`)
  await pool.query(`ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS sync_status TEXT NOT NULL DEFAULT 'pending'`)
  await pool.query(`ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS sync_error TEXT`)
  await pool.query(`ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ`)
  await pool.query(`ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'`)
  await pool.query(`ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`)
}

function shouldUseSsl(connectionString) {
  const value = String(connectionString || '').toLowerCase()
  return value.includes('sslmode=require') || value.includes('ssl=true')
}

function isDevInMemoryDbEnabled() {
  return String(process.env.DEV_IN_MEMORY_DB || '').trim().toLowerCase() === 'true'
}

function getDatabaseConnectionString() {
  return String(process.env.POSTGRES_URL || process.env.DATABASE_URL || '').trim()
}

function buildDbConfigError() {
  const error = new Error(
    'Missing DATABASE_URL (or POSTGRES_URL). Configure a PostgreSQL connection. ' +
    'Use DEV_IN_MEMORY_DB=true only for temporary local development.'
  )
  error.code = 'DB_CONFIG_MISSING'
  return error
}

function buildDbConnectError(cause) {
  const error = new Error(`Failed to connect to PostgreSQL: ${String(cause?.message || cause || 'unknown error')}`)
  error.code = 'DB_CONNECT_FAILED'
  return error
}

function getDbRuntimeStatus() {
  return {
    mode: dbMode,
    configured: Boolean(getDatabaseConnectionString()),
    in_memory_enabled: isDevInMemoryDbEnabled(),
    connected: dbMode === 'postgres'
  }
}

function createPostgresDb(pool) {
  return {
    collection(name) {
      const loadAll = async () => {
        const { rows } = await pool.query(`SELECT doc FROM ${PG_DOC_TABLE} WHERE collection_name = $1`, [name])
        return rows.map((row) => (typeof row.doc === 'string' ? JSON.parse(row.doc) : row.doc))
      }
      const persistOne = async (doc) => {
        const id = String(doc.id || uuidv4())
        const payload = { ...doc, id }
        await pool.query(
          `
            INSERT INTO ${PG_DOC_TABLE} (collection_name, doc_id, doc, updated_at)
            VALUES ($1, $2, $3::jsonb, NOW())
            ON CONFLICT (collection_name, doc_id)
            DO UPDATE SET doc = EXCLUDED.doc, updated_at = NOW()
          `,
          [name, id, JSON.stringify(payload)]
        )
      }
      const removeByIds = async (ids = []) => {
        if (!ids.length) return 0
        const { rowCount } = await pool.query(
          `DELETE FROM ${PG_DOC_TABLE} WHERE collection_name = $1 AND doc_id = ANY($2::text[])`,
          [name, ids]
        )
        return rowCount || 0
      }
      return createCollectionAdapter(loadAll, persistOne, removeByIds, { collectionName: name })
    }
  }
}

async function connectToMongo() {
  // Kept for compatibility with existing route handlers.
  if (db) return db
  if (dbInitPromise) return dbInitPromise

  dbInitPromise = (async () => {
    const connectionString = getDatabaseConnectionString()
    const allowInMemory = isDevInMemoryDbEnabled() && process.env.NODE_ENV !== 'production'
    if (!connectionString) {
      if (allowInMemory) {
        if (!dbInMemoryLogEmitted) {
          console.warn('[DB] DEV_IN_MEMORY_DB=true - using in-memory stub database.')
          dbInMemoryLogEmitted = true
        }
        dbMode = 'in-memory'
        db = createInMemoryDb()
        return db
      }
      if (!dbMissingConfigLogEmitted) {
        console.error('[DB] Missing DATABASE_URL - cannot start DB')
        dbMissingConfigLogEmitted = true
      }
      throw buildDbConfigError()
    }

    try {
      if (!pgPool) {
        pgPool = new Pool({
          connectionString,
          ssl: shouldUseSsl(connectionString) ? { rejectUnauthorized: false } : undefined
        })
      }
      await pgPool.query('SELECT 1')
      await ensurePgSchema(pgPool)
      db = createPostgresDb(pgPool)
      dbMode = 'postgres'
      if (!dbConnectedLogEmitted) {
        console.info('[DB] Connected to PostgreSQL')
        dbConnectedLogEmitted = true
      }
      return db
    } catch (error) {
      try { if (pgPool) await pgPool.end() } catch (_) {}
      pgPool = null
      db = null
      dbMode = 'uninitialized'

      if (allowInMemory) {
        if (!dbInMemoryLogEmitted) {
          console.warn('[DB] PostgreSQL unavailable and DEV_IN_MEMORY_DB=true - using in-memory stub database.')
          dbInMemoryLogEmitted = true
        }
        dbMode = 'in-memory'
        db = createInMemoryDb()
        return db
      }

      if (!dbConnectErrorLogEmitted) {
        console.error('[DB] Failed to connect to PostgreSQL:', error?.message || error)
        dbConnectErrorLogEmitted = true
      }
      throw buildDbConnectError(error)
    } finally {
      dbInitPromise = null
    }
  })()

  return dbInitPromise
}

function getAiSearchBaseUrl() {
  const raw = String(process.env.AI_SEARCH_BASE_URL || '').trim()
  if (!raw) {
    // Local development default so CRM can bridge to a colocated AI search service.
    if (process.env.NODE_ENV !== 'production') return 'http://localhost:8001'
    return null
  }
  return raw.replace(/\/+$/, '')
}

async function findChecklistItemById(db, rawItemId) {
  const itemId = String(rawItemId || '').trim()
  if (!itemId) return null

  let existing = await db.collection('checklist_items').findOne({ id: itemId })
  if (existing) return existing

  // Backward compatibility for legacy numeric/non-string IDs in stored docs.
  const all = await db.collection('checklist_items').find({}).toArray()
  existing = all.find((it) => String(it?.id ?? '') === itemId)
  return existing || null
}
function isGreetingOrSmallTalk(message = '') {
  const raw = String(message || '').trim()
  if (!raw) return false

  const lc = raw.toLowerCase()
  const compact = lc.replace(/[^a-z\s']/g, ' ').replace(/\s+/g, ' ').trim()
  const words = compact ? compact.split(' ') : []

  const greetingOnly = /^(hi|hello|hey|yo|hola|good\s+morning|good\s+afternoon|good\s+evening|sup|what'?s\s+up)$/i.test(compact)
  const simpleSmallTalk = /^(how\s+are\s+you|who\s+are\s+you|what\s+can\s+you\s+do|thanks|thank\s+you)$/i.test(compact)

  return (words.length <= 6 && greetingOnly) || simpleSmallTalk
}

function mapAiSearchToCrmMatchResponse(aiData = {}, fallbackQuery = '', inputSessionId = null) {
  const properties = Array.isArray(aiData.properties)
    ? aiData.properties
    : (Array.isArray(aiData.search_results) ? aiData.search_results : [])

  const metadataPayload = aiData?.metadata?.crm_payload || {}
  const finalResponse = (aiData.final_response || aiData.answer || aiData.summary || '').toString().trim()
  const answer = finalResponse || (fallbackQuery ? `Processed: "${fallbackQuery}"` : 'Your request has been processed.')

  const tasks = Array.isArray(aiData.tasks) ? aiData.tasks : []
  const alerts = Array.isArray(aiData.alerts) ? aiData.alerts : []
  const transactions = Array.isArray(aiData.transactions) ? aiData.transactions : []

  return {
    success: true,
    source: 'ai_search',
    intent: aiData.intent || aiData.primary_intent || 'search',
    answer,
    ai_recommendations: answer,
    properties,
    properties_count: properties.length,
    suggestions: Array.isArray(aiData.suggestions) ? aiData.suggestions : [],
    summary: (aiData.summary || answer).toString(),
    session_id: aiData.session_id || inputSessionId || null,
    lead: aiData.lead || metadataPayload.lead || null,
    is_new_lead: Boolean(aiData.is_new_lead ?? metadataPayload.is_new_lead),
    transactions,
    tasks,
    alerts,
    metadata: aiData.metadata || {}
  }
}
async function tryAiSearchBridge({ query, sessionId = null }) {
  const baseUrl = getAiSearchBaseUrl()
  if (!baseUrl || !query) return null

  const text = String(query || '').trim()
  if (!text) return null

  const payload = {
    query: text,
    session_id: sessionId || undefined,
    use_cache: true,
  }

  const timeoutMs = Math.max(1000, Number(process.env.AI_SEARCH_TIMEOUT_MS || 120000))
  const controller = new AbortController()
  const timeoutRef = setTimeout(() => controller.abort(new Error('AI Search timeout')), timeoutMs)
  try {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-crm-bridge': '1',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })

    if (!response.ok) {
      const errTxt = await response.text().catch(() => '')
      throw new Error(`AI Search ${response.status} ${response.statusText}: ${errTxt.slice(0, 300)}`)
    }

    const aiData = await response.json()
    return mapAiSearchToCrmMatchResponse(aiData, text, sessionId)
  } finally {
    clearTimeout(timeoutRef)
  }
}
function parseAssistantJsonResponseSafe(rawText = '') {
  const text = String(rawText || '').trim()
  if (!text) return null

  try {
    return JSON.parse(text)
  } catch (_) {}

  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) {
    const candidate = text.slice(first, last + 1)
    try {
      return JSON.parse(candidate)
    } catch (_) {
      try {
        const cleaned = candidate.replace(/,\s*([}\]])/g, '$1')
        return JSON.parse(cleaned)
      } catch (_) {}
    }
  }

  return null
}

function heuristicAssistantParseSafe(message = '') {
  const text = String(message || '')
  const lc = text.toLowerCase()

  const leadType = /\b(seller|selling|list(?:ing)?)\b/.test(lc) ? 'seller' : 'buyer'
  const nameMatch = text.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/)
  const zipMatch = text.match(/\b(\d{5})(?:-\d{4})?\b/)
  const bedMatch = lc.match(/(\d+(?:\.\d+)?)\s*(?:bhk|bed(?:room)?s?|br)\b/)
  const bathMatch = lc.match(/(\d+(?:\.\d+)?)\s*(?:bath(?:room)?s?|ba)\b/)
  const underPrice = lc.match(/\b(?:under|below|upto|up to|max(?:imum)?|<=?)\s*\$?\s*([\d,.]+)\s*(k|m|million|thousand)?\b/)
  const abovePrice = lc.match(/\b(?:above|over|at least|min(?:imum)?|>=?)\s*\$?\s*([\d,.]+)\s*(k|m|million|thousand)?\b/)
  const inCity = text.match(/\bin\s+([A-Za-z]+(?:\s+[A-Za-z]+){0,2})\b/i)
  const city = inCity ? inCity[1].trim() : null

  const toNumber = (raw, unit) => {
    if (!raw) return null
    const base = Number(String(raw).replace(/,/g, ''))
    if (!Number.isFinite(base)) return null
    const u = String(unit || '').toLowerCase()
    if (u === 'k' || u === 'thousand') return Math.round(base * 1000)
    if (u === 'm' || u === 'million') return Math.round(base * 1000000)
    return Math.round(base)
  }

  return {
    lead_info: {
      name: nameMatch ? nameMatch[1] : null,
      phone: null,
      email: null,
      lead_type: leadType
    },
    preferences: {
      zipcode: zipMatch ? zipMatch[1] : null,
      city,
      state: null,
      min_price: abovePrice ? toNumber(abovePrice[1], abovePrice[2]) : null,
      max_price: underPrice ? toNumber(underPrice[1], underPrice[2]) : null,
      bedrooms: bedMatch ? Number(bedMatch[1]) : null,
      bathrooms: bathMatch ? Number(bathMatch[1]) : null,
      property_type: null
    },
    transaction_info: {
      property_address: null,
      transaction_type: null,
      price: null,
      listing_price: null,
      contract_price: null,
      closing_date: null
    },
    intent: /\b(find|show|search|properties|listing)\b/.test(lc) ? 'find_properties' : 'other',
    summary: text.slice(0, 140) || 'Parsed from heuristic fallback'
  }
}
// Fetch images for a single property by provider ID or address parts
async function fetchPropertyImages(query = {}) {
  const { id, address, city, state, zipcode } = query
  try {
    // Prepare multiple precise body shapes to avoid ambiguous queries
    const attempts = []
    if (id) {
      attempts.push({ id })
      attempts.push({ property_id: id })
      attempts.push({ propertyId: id })
      attempts.push({ mls_id: id })
      attempts.push({ mlsId: id })
    }
    if (address || city || state || zipcode) {
      // Structured address
      attempts.push({ address: address || undefined, city: city || undefined, state: state || undefined, zip: zipcode || undefined })
      // Alternate street key
      if (address) attempts.push({ street: address, city: city || undefined, state: state || undefined, zip: zipcode || undefined })
      if (address) attempts.push({ street_address: address, city: city || undefined, state: state || undefined, zip: zipcode || undefined })
      if (address) attempts.push({ address_line1: address, city: city || undefined, state: state || undefined, zip: zipcode || undefined })
      // Full address string as last resort
      const parts = []
      if (address) parts.push(address)
      const cityStateZip = [city, state, zipcode].filter(Boolean).join(' ')
      if (cityStateZip) parts.push(cityStateZip)
      const full = parts.join(', ')
      if (full) attempts.push({ address: full })
    }

    const endpoints = [
      'https://api.realestateapi.com/v2/PropertyDetail',
      'https://api.realestateapi.com/v2/PropertyDetails',
      'https://api.realestateapi.com/v2/Property',
    ]

    let detail = null
    let lastErr = null
    for (const url of endpoints) {
      for (const body of attempts) {
        try {
          const controller = new AbortController()
          const attemptTimeoutMs = 10000
          const timeoutRef = setTimeout(() => controller.abort(new Error('Request timed out')), attemptTimeoutMs)
          const res = await fetch(url, {
            method: 'POST',
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
              'x-api-key': process.env.REAL_ESTATE_API_KEY,
              'x-user-id': process.env.REAL_ESTATE_USER_ID || 'CRMApp'
            },
            body: JSON.stringify(body),
            signal: controller.signal
          })
          clearTimeout(timeoutRef)
          if (!res.ok) {
            lastErr = new Error(`Detail ${url} ${res.status}`)
            continue
          }
          detail = await res.json()
          break
        } catch (e) {
          lastErr = e
          continue
        }
      }
      if (detail) break
    }

    if (!detail) {
      if (lastErr) console.warn('Property detail fetch failed', lastErr)
      return { images: [], primary_image: null, debug_detail: null }
    }

    // Collect image URLs robustly
    const urls = []
    const pushUrl = (u) => {
      if (!u || typeof u !== 'string') return
      const s = u.trim()
      if (!/^https?:\/\//i.test(s)) return
      urls.push(s)
    }
    const urlFromObj = (o) => o && (o.url || o.href || o.src || o.link || o.image || o.photo || o.mediaUrl || o.media_url || o.full || o.large || o.original || o.medium || o.small || o.thumb || o.thumbnail || o.url_full || o.url_small || o.url_thumb || o.thumbnail_url)

    const seen = new Set()
    const queue = [{ obj: detail, depth: 0 }]
    const maxDepth = 5
    while (queue.length) {
      const { obj, depth } = queue.shift()
      if (!obj || typeof obj !== 'object' || seen.has(obj) || depth > maxDepth) continue
      seen.add(obj)
      if (Array.isArray(obj)) {
        for (const v of obj) {
          if (typeof v === 'string') pushUrl(v)
          else if (typeof v === 'object') {
            const u = urlFromObj(v)
            if (u) pushUrl(u)
            queue.push({ obj: v, depth: depth + 1 })
          }
        }
      } else {
        for (const [k, v] of Object.entries(obj)) {
          const key = k.toLowerCase()
          if (typeof v === 'string') {
            if (key.includes('url') || key.includes('photo') || key.includes('image')) pushUrl(v)
          } else if (typeof v === 'object') {
            const u = urlFromObj(v)
            if (u) pushUrl(u)
            // Prioritize obvious containers
            if (Array.isArray(v) || key.includes('photo') || key.includes('image') || key.includes('media')) {
              queue.push({ obj: v, depth: depth + 1 })
            }
          }
        }
      }
    }

    // Dedupe
    const out = []
    const seenUrl = new Set()
    for (const u of urls) {
      if (!seenUrl.has(u)) { seenUrl.add(u); out.push(u) }
    }

    return {
      images: out,
      primary_image: out[0] || null,
      debug_detail: process.env.NODE_ENV !== 'production' ? detail : undefined
    }
  } catch (error) {
    console.error('fetchPropertyImages error', error)
    return { images: [], primary_image: null }
  }
}

// Query MLS Search for photos by address/city/state/zip or listing id
async function fetchMLSPhotos(query = {}) {
  const { id, address, city, state, zipcode } = query
  try {
    const url = 'https://api.realestateapi.com/v2/MLSSearch'
    // MLSSearch expects top-level fields (no filters wrapper)
    const body = {
      size: 5,
      address: address || undefined,
      city: city || undefined,
      state: state || undefined,
      zip: zipcode || undefined,
      listing_id: id || undefined,
      property_id: id || undefined
    }

    // Use AbortController-based timeout
    let res
    {
      const controller = new AbortController()
      const timeoutMs = 8000
      const timeoutRef = setTimeout(() => controller.abort(new Error('Request timed out')), timeoutMs)
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'x-api-key': process.env.REAL_ESTATE_MLS_API_KEY || process.env.REAL_ESTATE_API_KEY,
            'x-user-id': process.env.REAL_ESTATE_USER_ID || 'CRMApp'
          },
          body: JSON.stringify(body),
          signal: controller.signal
        })
      } catch (err) {
        if (err && err.name === 'AbortError') {
          console.warn('MLSSearch request aborted (timeout)')
          return { images: [], primary_image: null }
        }
        throw err
      } finally {
        clearTimeout(timeoutRef)
      }
    }

    if (!res.ok) {
      let errTxt = ''
      try { errTxt = await res.text() } catch {}
      console.warn('MLSSearch request failed', res.status, errTxt?.slice(0, 300))
      return { images: [], primary_image: null }
    }

    const data = await res.json()
    const items = Array.isArray(data?.results) ? data.results : (Array.isArray(data) ? data : [])
    if (items.length === 0) return { images: [], primary_image: null }

    // Reuse robust URL extraction on the first couple of items
    const urls = []
    const pushUrl = (u) => {
      if (!u || typeof u !== 'string') return
      const s = u.trim()
      if (!/^https?:\/\//i.test(s)) return
      urls.push(s)
    }
    const urlFromObj = (o) => o && (o.url || o.href || o.src || o.link || o.image || o.photo || o.mediaUrl || o.media_url || o.full || o.large || o.original || o.medium || o.small || o.thumb || o.thumbnail || o.url_full || o.url_small || o.url_thumb || o.thumbnail_url)
    const scan = (root) => {
      const seen = new Set()
      const queue = [{ obj: root, depth: 0 }]
      const maxDepth = 5
      while (queue.length) {
        const { obj, depth } = queue.shift()
        if (!obj || typeof obj !== 'object' || seen.has(obj) || depth > maxDepth) continue
        seen.add(obj)
        if (Array.isArray(obj)) {
          for (const v of obj) {
            if (typeof v === 'string') pushUrl(v)
            else if (typeof v === 'object') {
              const u = urlFromObj(v)
              if (u) pushUrl(u)
              queue.push({ obj: v, depth: depth + 1 })
            }
          }
        } else {
          for (const [k, v] of Object.entries(obj)) {
            const key = k.toLowerCase()
            if (typeof v === 'string') {
              if (key.includes('url') || key.includes('photo') || key.includes('image')) pushUrl(v)
            } else if (typeof v === 'object') {
              const u = urlFromObj(v)
              if (u) pushUrl(u)
              if (Array.isArray(v) || key.includes('photo') || key.includes('image') || key.includes('media')) {
                queue.push({ obj: v, depth: depth + 1 })
              }
            }
          }
        }
      }
    }

    // Scan first up to 3 results
    items.slice(0, 3).forEach(scan)

    // Dedupe
    const out = []
    const seenUrl = new Set()
    for (const u of urls) { if (!seenUrl.has(u)) { seenUrl.add(u); out.push(u) } }

    return { images: out, primary_image: out[0] || null, debug_mls_sample: process.env.NODE_ENV !== 'production' ? items[0] : undefined }
  } catch (e) {
    console.warn('fetchMLSPhotos error', e)
    return { images: [], primary_image: null }
  }
}

// Enhanced OpenAI Agent Utilities with advanced features
class OpenAIUtility {
  constructor() {
    this.provider = this.resolveProvider()
    this.apiKey = this.provider === 'groq'
      ? process.env.GROQ_API_KEY
      : process.env.OPENAI_API_KEY
    this.baseURL = this.provider === 'groq'
      ? (process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1')
      : (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1')
    this.defaultModel = this.provider === 'groq'
      ? (process.env.GROQ_MODEL || 'openai/gpt-oss-120b')
      : (process.env.OPENAI_MODEL || 'gpt-4o-mini')
    this.maxRetries = 3
    this.baseDelay = 1000 // 1 second
    this.maxDelay = 30000 // 30 seconds
    const toNum = (v, fallback = 0) => {
      const n = Number(v)
      return Number.isFinite(n) ? n : fallback
    }
    const groqInputCost = toNum(process.env.GROQ_COST_PER_1K_INPUT, 0)
    const groqOutputCost = toNum(process.env.GROQ_COST_PER_1K_OUTPUT, 0)
    this.tokenLimits = {
      'gpt-4o-mini': { input: 128000, output: 16000, cost_per_1k_input: 0.00015, cost_per_1k_output: 0.0006 },
      'o1-mini': { input: 128000, output: 65536, cost_per_1k_input: 0.003, cost_per_1k_output: 0.012 },
      'gpt-4o': { input: 128000, output: 4096, cost_per_1k_input: 0.005, cost_per_1k_output: 0.015 },
      'gpt-5': { input: 400000, output: 128000, cost_per_1k_input: 0.00025, cost_per_1k_output: 0.002 },
      'claude-sonnet-4.5': { input: 1000000, output: 64000, cost_per_1k_input: 0.0006, cost_per_1k_output: 0.003 },
      'anthropic/claude-sonnet-4.5': { input: 1000000, output: 64000, cost_per_1k_input: 0.0006, cost_per_1k_output: 0.003 },
      'claude-opus-4.5': { input: 200000, output: 32000, cost_per_1k_input: 0.001, cost_per_1k_output: 0.005 },
      'anthropic/claude-opus-4.5': { input: 200000, output: 32000, cost_per_1k_input: 0.001, cost_per_1k_output: 0.005 },
      // Groq-hosted OSS model (OpenAI-compatible endpoint)
      'openai/gpt-oss-120b': { input: 131072, output: 65536, cost_per_1k_input: groqInputCost, cost_per_1k_output: groqOutputCost }
    }
    this.requestLog = []
    this.totalCost = 0
    this.dailyCostLimit = 50.00 // $50 daily limit
  }

  resolveProvider() {
    const explicit = String(process.env.AI_PROVIDER || '').trim().toLowerCase()
    if (explicit === 'groq') return 'groq'
    if (explicit === 'openai') return 'openai'
    if (process.env.GROQ_API_KEY) return 'groq'
    return 'openai'
  }

  normalizeModel(inputModel) {
    let model = inputModel || this.defaultModel

    // Normalize common provider-prefixed aliases from OpenAI-compatible gateways.
    const aliasMap = {
      'openai/gpt-5': 'gpt-5',
      'openai/gpt-4o': 'gpt-4o',
      'claude-sonnet-4.5': 'anthropic/claude-sonnet-4.5',
      'claude-opus-4.5': 'anthropic/claude-opus-4.5'
    }
    model = aliasMap[model] || model

    // Preserve existing call-sites and remap aliases based on active provider.
    if (this.provider === 'groq') {
      if (model === 'o1-mini' || model === 'gpt-4o-mini' || model === 'gpt-4o') {
        model = this.defaultModel
      }
    } else {
      const hardcodedOpenAiAliases = new Set(['o1-mini', 'gpt-4o-mini', 'gpt-4o'])
      const defaultIsCustomGatewayModel = !hardcodedOpenAiAliases.has(this.defaultModel)

      // When a custom OpenAI-compatible gateway model is configured, prefer it over internal hardcoded aliases.
      if (defaultIsCustomGatewayModel && hardcodedOpenAiAliases.has(model)) {
        model = this.defaultModel
      } else if (model === 'o1-mini') {
        // Existing internal alias for OpenAI-native flows.
        model = 'gpt-4o-mini'
      }
    }

    if (!this.tokenLimits[model]) {
      console.warn(`Unknown model: ${model}, using ${this.defaultModel} as fallback`)
      model = this.defaultModel
      if (!this.tokenLimits[model]) {
        model = 'gpt-4o-mini'
      }
    }

    return model
  }

  // Enhanced token counting with tiktoken-style approximation
  estimateTokenCount(text, model = this.defaultModel) {
    if (!text) return 0
    
    // Rough approximation: 1 token ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¹ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â  4 characters for English text
    // More accurate for code and structured content
    const baseCount = Math.ceil(text.length / 4)
    
    // Adjust for model-specific tokenization patterns
    const modelAdjustments = {
      'gpt-4o-mini': 1.0,
      'o1-mini': 1.1, // O1 models tend to use slightly more tokens
      'gpt-4o': 1.0,
      'gpt-5': 1.0,
      'claude-sonnet-4.5': 1.0,
      'anthropic/claude-sonnet-4.5': 1.0,
      'claude-opus-4.5': 1.0,
      'anthropic/claude-opus-4.5': 1.0,
      'openai/gpt-oss-120b': 1.0
    }
    
    return Math.ceil(baseCount * (modelAdjustments[model] || 1.0))
  }

  // Calculate message token count including system formatting
  calculateMessageTokens(messages, model = this.defaultModel) {
    let totalTokens = 0
    
    for (const message of messages) {
      // Add tokens for role and content
      totalTokens += this.estimateTokenCount(message.role, model)
      totalTokens += this.estimateTokenCount(message.content, model)
      // Add overhead tokens for message formatting
      totalTokens += 4
    }
    
    // Add conversation overhead
    totalTokens += 2
    
    return totalTokens
  }

  // Cost calculation and budget checking
  calculateCost(inputTokens, outputTokens, model = this.defaultModel) {
    const limits = this.tokenLimits[model]
    if (!limits) return 0

    const inputCost = (inputTokens / 1000) * limits.cost_per_1k_input
    const outputCost = (outputTokens / 1000) * limits.cost_per_1k_output
    
    return inputCost + outputCost
  }

  // Check if request would exceed budget limits
  checkBudgetLimits(estimatedCost) {
    const projectedTotal = this.totalCost + estimatedCost
    
    if (projectedTotal > this.dailyCostLimit) {
      throw new Error(`Request would exceed daily cost limit. Current: $${this.totalCost.toFixed(4)}, Estimated: $${estimatedCost.toFixed(4)}, Limit: $${this.dailyCostLimit}`)
    }

    if (estimatedCost > 5.00) {
      throw new Error(`Single request cost too high: $${estimatedCost.toFixed(4)}. Maximum allowed: $5.00`)
    }
  }

  // Exponential backoff calculation
  calculateBackoffDelay(attemptNumber) {
    const delay = this.baseDelay * Math.pow(2, attemptNumber - 1)
    const jitter = Math.random() * 0.1 * delay // Add 10% jitter
    return Math.min(delay + jitter, this.maxDelay)
  }

  // Enhanced error handling and classification
  classifyError(error, response = null) {
    const status = response?.status || error.status || 0
    const errorData = error.response?.data || error.data || {}
    const errorCode = errorData.error?.code || errorData.code
    const errorType = errorData.error?.type || errorData.type
    
    return {
      status,
      code: errorCode,
      type: errorType,
      message: errorData.error?.message || errorData.message || error.message,
      isRetryable: status === 429 || status === 503 || status === 502 || status >= 500,
      isRateLimit: status === 429,
      isBudgetIssue: errorCode === 'insufficient_quota' || errorCode === 'quota_exceeded',
      isModelIssue: status === 404 && errorType === 'invalid_request_error'
    }
  }

  // Stream response handler
  async handleStreamResponse(response, onChunk = null) {
    if (!response.body) {
      throw new Error('No response body for streaming')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let fullContent = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim()
            if (data === '[DONE]') continue

            try {
              const parsed = JSON.parse(data)
              const content = parsed.choices?.[0]?.delta?.content
              if (content) {
                fullContent += content
                if (onChunk) onChunk(content)
              }
            } catch (parseError) {
              console.warn('Failed to parse streaming chunk:', parseError)
            }
          }
        }
      }

      return fullContent
    } finally {
      reader.releaseLock()
    }
  }

  // Main callOpenAI function with all enhancements
  async callOpenAI(model = this.defaultModel, messages, options = {}) {
    const {
      stream = false,
      onChunk = null,
      maxTokens = null,
      temperature = 0.7,
      topP = 1.0,
      frequencyPenalty = 0,
      presencePenalty = 0,
      stop = null,
      skipBudgetCheck = false,
      customRetries = null,
      // Timeouts (ms): separate defaults for streaming vs non-streaming
      requestTimeoutMs = 20000,
      streamTimeoutMs = 60000
    } = options

    // Normalize aliases and validate model
    model = this.normalizeModel(model)

    // Validate API key
    if (!this.apiKey) {
      throw new Error(`${this.provider.toUpperCase()} API key not configured`)
    }

    // Calculate token usage and cost
    const inputTokens = this.calculateMessageTokens(messages, model)
    const estimatedOutputTokens = maxTokens || this.tokenLimits[model].output / 4
    const estimatedCost = this.calculateCost(inputTokens, estimatedOutputTokens, model)

    // Budget checks
    if (!skipBudgetCheck) {
      this.checkBudgetLimits(estimatedCost)
    }

    // Token limit validation
    const modelLimits = this.tokenLimits[model]
    if (inputTokens > modelLimits.input) {
      throw new Error(`Input tokens (${inputTokens}) exceed model limit (${modelLimits.input})`)
    }

    // Build request payload
    const requestPayload = {
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
      top_p: topP,
      frequency_penalty: frequencyPenalty,
      presence_penalty: presencePenalty,
      stream
    }

    if (stop) requestPayload.stop = stop

    // Remove null/undefined values
    Object.keys(requestPayload).forEach(key => {
      if (requestPayload[key] === null || requestPayload[key] === undefined) {
        delete requestPayload[key]
      }
    })

    const maxRetries = customRetries ?? this.maxRetries
    let lastError = null

    // Retry loop with exponential backoff
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      const requestStart = Date.now()
      
      let timeoutRef
      const controller = new AbortController()
      const timeoutMs = stream ? streamTimeoutMs : requestTimeoutMs
      try {
        timeoutRef = setTimeout(() => controller.abort(new Error('Request timed out')), timeoutMs)
        const response = await fetch(`${this.baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            'User-Agent': 'RealEstate-CRM/1.0'
          },
          body: JSON.stringify(requestPayload),
          signal: controller.signal
        })

        const responseTime = Date.now() - requestStart

        // Handle streaming response
        if (stream && response.ok) {
          const content = await this.handleStreamResponse(response, onChunk)
          const outputTokens = this.estimateTokenCount(content, model)
          const actualCost = this.calculateCost(inputTokens, outputTokens, model)
          
          // Log successful request
          this.logRequest({
            model,
            inputTokens,
            outputTokens,
            cost: actualCost,
            responseTime,
            attempt,
            success: true,
            stream: true
          })

          this.totalCost += actualCost
          return content
        }

        // Handle non-streaming response
        if (response.ok) {
          const data = await response.json()
          const content = data.choices?.[0]?.message?.content || ''
          const usage = data.usage
          const actualOutputTokens = usage?.completion_tokens || this.estimateTokenCount(content, model)
          const actualInputTokens = usage?.prompt_tokens || inputTokens
          const actualCost = this.calculateCost(actualInputTokens, actualOutputTokens, model)

          // Log successful request
          this.logRequest({
            model,
            inputTokens: actualInputTokens,
            outputTokens: actualOutputTokens,
            cost: actualCost,
            responseTime,
            attempt,
            success: true,
            usage
          })

          this.totalCost += actualCost
          return content
        }

        // Handle error response
        const errorData = await response.json().catch(() => ({}))
        const error = new Error(`${this.provider.toUpperCase()} API Error: ${response.status}`)
        error.status = response.status
        error.data = errorData
        throw error
      } catch (error) {
        lastError = error
        const errorInfo = this.classifyError(error)
        
        // Log failed request
        this.logRequest({
          model,
          inputTokens,
          outputTokens: 0,
          cost: 0,
          responseTime: Date.now() - requestStart,
          attempt,
          success: false,
          error: errorInfo
        })

        console.error(`${this.provider.toUpperCase()} API attempt ${attempt} failed:`, errorInfo)

        // Don't retry on non-retryable errors
        if (!errorInfo.isRetryable || attempt > maxRetries) {
          break
        }

        // Calculate backoff delay
        const delay = this.calculateBackoffDelay(attempt)
        console.log(`Retrying in ${delay}ms... (attempt ${attempt + 1}/${maxRetries + 1})`)
        
        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, delay))
      } finally {
        if (timeoutRef) clearTimeout(timeoutRef)
      }
    }

    // All retries exhausted, throw the last error
    const errorInfo = this.classifyError(lastError)
    
    if (errorInfo.isRateLimit) {
      throw new Error(`Rate limit exceeded after ${maxRetries} retries. Please try again later.`)
    } else if (errorInfo.isBudgetIssue) {
      throw new Error(`${this.provider.toUpperCase()} quota exceeded. Please check your billing.`)
    } else if (errorInfo.isModelIssue) {
      throw new Error(`Model '${model}' is not available. Please try a different model.`)
    } else {
      throw new Error(`${this.provider.toUpperCase()} API failed after ${maxRetries} retries: ${errorInfo.message}`)
    }
  }

  // Request logging for monitoring and debugging
  logRequest(requestInfo) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      ...requestInfo
    }
    
    this.requestLog.push(logEntry)
    
    // Keep only last 100 requests in memory
    if (this.requestLog.length > 100) {
      this.requestLog = this.requestLog.slice(-100)
    }

    // Console logging for monitoring
    if (requestInfo.success) {
      console.log(`ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ ${this.provider.toUpperCase()} ${requestInfo.model}: ${requestInfo.inputTokens}+${requestInfo.outputTokens} tokens, $${requestInfo.cost.toFixed(4)}, ${requestInfo.responseTime}ms`)
    } else {
      console.error(`ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ ${this.provider.toUpperCase()} ${requestInfo.model} failed: ${requestInfo.error.message}`)
    }
  }

  // Get usage statistics
  getUsageStats() {
    const successfulRequests = this.requestLog.filter(req => req.success)
    const totalRequests = this.requestLog.length
    const totalTokens = successfulRequests.reduce((sum, req) => sum + req.inputTokens + req.outputTokens, 0)
    const avgResponseTime = successfulRequests.reduce((sum, req) => sum + req.responseTime, 0) / successfulRequests.length

    return {
      totalRequests,
      successfulRequests: successfulRequests.length,
      successRate: (successfulRequests.length / totalRequests) * 100,
      totalCost: this.totalCost,
      totalTokens,
      avgResponseTime: Math.round(avgResponseTime),
      provider: this.provider,
      defaultModel: this.defaultModel,
      baseURL: this.baseURL,
      dailyCostLimit: this.dailyCostLimit,
      remainingBudget: Math.max(0, this.dailyCostLimit - this.totalCost),
      modelUsage: this.getModelUsageBreakdown()
    }
  }

  // Model usage breakdown
  getModelUsageBreakdown() {
    const breakdown = {}
    
    this.requestLog.forEach(req => {
      if (!breakdown[req.model]) {
        breakdown[req.model] = {
          requests: 0,
          tokens: 0,
          cost: 0,
          avgResponseTime: 0
        }
      }
      
      breakdown[req.model].requests++
      breakdown[req.model].tokens += req.inputTokens + req.outputTokens
      breakdown[req.model].cost += req.cost
      breakdown[req.model].avgResponseTime += req.responseTime
    })

    // Calculate averages
    Object.keys(breakdown).forEach(model => {
      if (breakdown[model].requests > 0) {
        breakdown[model].avgResponseTime = Math.round(breakdown[model].avgResponseTime / breakdown[model].requests)
      }
    })

    return breakdown
  }

  // Reset daily usage (for production, this would be automated)
  resetDailyUsage() {
    this.totalCost = 0
    this.requestLog = []
    console.log('ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ Daily usage reset')
  }
}

// Create global instance
const openaiUtility = new OpenAIUtility()

async function callOpenAI(model = openaiUtility.defaultModel, messages, options = {}) {
  return await openaiUtility.callOpenAI(model, messages, options)
}

// Real Estate API Integration - Enhanced Property Search
async function fetchProperties(filters = {}) {
  try {
    const { 
      location, 
      beds, 
      baths, 
      min_price, 
      max_price, 
      listing_status = 'for_sale',
      property_type,
      sort_by,
      limit = 60,
      offset = 0
    } = filters

    // Use the v2 MLSSearch endpoint (POST)
    const url = (process.env.PROPERTY_SEARCH_URL || 'https://api.realestateapi.com/v2/MLSSearch')
    const apiKey = process.env.REAL_ESTATE_MLS_API_KEY || process.env.REAL_ESTATE_API_KEY
    const userId = process.env.REAL_ESTATE_USER_ID || 'CRMApp'

    const fallbackWithReason = (reason, details = undefined) => ({
      ...generateFallbackProperties(filters),
      live_attempted: reason !== 'missing_mls_api_key',
      fallback_reason: reason,
      fallback_details: details
    })

    if (!apiKey) {
      console.warn('MLS search fallback: missing REAL_ESTATE_MLS_API_KEY / REAL_ESTATE_API_KEY')
      return fallbackWithReason('missing_mls_api_key')
    }

    // Build MLSSearch request body
    const requestBody = {
      size: Math.min(250, Number(limit) || 60),
      status: 'Active'
    }
    // Pagination with MLSSearch uses resultIndex (1-based per API samples)
    if (Number(offset) > 0) {
      requestBody.resultIndex = Number(offset)
    }

    // Map filters -> MLSSearch schema
    if (beds) requestBody.bedrooms_min = Number(beds)
    if (baths) requestBody.bathrooms_min = Math.ceil(Number(baths))
    if (min_price) requestBody.listing_price_min = Number(min_price)
    if (max_price) requestBody.listing_price_max = Number(max_price)

    if (location) {
      // Normalize location: support ZIP, ZIP+4, "City, ST", full state name, or 2-letter state code
      const stateMap = {
        alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
        connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA',
        hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY',
        louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
        mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH',
        'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND',
        ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
        'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA',
        washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY'
      }
      const normalizeStateAbbr = (s) => {
        if (!s) return null
        const t = String(s).trim()
        if (/^[A-Za-z]{2}$/.test(t)) return t.toUpperCase()
        const key = t.toLowerCase()
        return stateMap[key] || null
      }
      const loc = String(location).trim()
      if (/^\d{5}(-\d{4})?$/.test(loc)) {
         requestBody.zip = loc.slice(0, 5)
      } else if (loc.includes(',')) {
        const [cityPart, statePart] = loc.split(',').map(s => s.trim()).slice(0, 2)
        if (cityPart) requestBody.city = cityPart
        const st = normalizeStateAbbr(statePart)
        if (st) requestBody.state = st
      } else {
        const st = normalizeStateAbbr(loc)
        if (st) {
          requestBody.state = st
        } else {
          requestBody.city = loc
        }
      }
    }

    // Temporarily omit sort to avoid 400 errors while we confirm other fields
    // if (sort_by) {
    //   const sortMap = {
    //     'price_asc': { list_price: 'asc' },
    //     'price_desc': { list_price: 'desc' },
    //     'date_desc': { list_date: 'desc' },
    //   };
    //   if (sortMap[sort_by]) {
    //     requestBody.sort = sortMap[sort_by];
    //   }
    // }


    console.log('[MLSSearch] Request body:', JSON.stringify(requestBody, null, 2))

    // Use AbortController for a hard timeout (Node/Next fetch doesn't support a 'timeout' option)
    const controller = new AbortController()
    const timeoutMs = 10000
    const timeoutRef = setTimeout(() => controller.abort(new Error('Request timed out')), timeoutMs)
    let response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          // Use MLS API key for MLSSearch
          'x-api-key': apiKey,
          'x-user-id': userId
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      })
    } catch (err) {
      if (err && (err.name === 'AbortError' || /timed out/i.test(String(err.message || '')))) {
        console.error('Real Estate API request aborted (timeout):', err)
        return fallbackWithReason('mls_timeout')
      }
      throw err
    } finally {
      clearTimeout(timeoutRef)
    }
    
    if (!response.ok) {
      const errorBody = await response.text();
      console.error('Real Estate API Error:', {
        status: response.status,
        statusText: response.statusText,
        url: url,
        response_body: errorBody
      })
      
      // Return fallback/mock data only when live MLS request fails
      return fallbackWithReason(`mls_http_${response.status}`, {
        status: response.status,
        statusText: response.statusText
      })
    }
    
    const data = await response.json()
  // Normalize response structure (MLSSearch returns data[])
  const rawProps = data.properties || data.results || data.data || []
  
  // Add metadata
  const normalized = rawProps.map(src => {
    // Prefer MLSSearch nested listing/public shapes
    const listing = src?.listing || {}
    const publicRec = src?.public || {}
    const addrObj = listing.address || (src && typeof src.address === 'object' && src.address !== null ? src.address : null)
    const street = (listing?.address?.unparsedAddress)
      || (addrObj ? (addrObj.street || addrObj.address || addrObj.line1 || addrObj.line || '') : null)
      || (src.street_address || src.address_line1 || src.street || src.address || '')
    const city = (listing?.address?.city)
      || (addrObj && (addrObj.city || addrObj.town)) || src.city || ''
    const state = (listing?.address?.stateOrProvince)
      || (addrObj && (addrObj.state || addrObj.region)) || src.state || ''
    const zipcode = (listing?.address?.zipCode)
      || (addrObj && (addrObj.zip || addrObj.zipcode || addrObj.postal_code))
      || src.zipcode || src.zip_code || src.postal_code || ''

    // Normalize price from various possible sources
    const priceTuples = [
        [listing?.leadTypes?.mlsListingPrice, 'listing.leadTypes.mlsListingPrice'],
        [listing?.listPriceLow, 'listing.listPriceLow'],
        [src.price, 'price'],
        [src.list_price, 'list_price'],
        [src.listPrice, 'listPrice'],
        [src.listing_price, 'listing_price'],
        [src.asking_price, 'asking_price'],
        [src.current_price, 'current_price'],
        [src.original_list_price, 'original_list_price'],
        [src.originalListPrice, 'originalListPrice'],
        [src.original_price, 'original_price'],
        [src.close_price, 'close_price'],
        [src.sold_price, 'sold_price'],
        [src?.list?.price, 'list.price'],
        [src?.prices?.list, 'prices.list'],
        [src?.details?.list_price, 'details.list_price'],
        [src?.listing?.list_price, 'listing.list_price'],
        [src?.listing?.price, 'listing.price'],
        [src?.price?.list, 'price.list'],
      ].filter(([v]) => v !== undefined && v !== null)
      const rawPrice = priceTuples.length > 0 ? priceTuples[0][0] : null
      let price_source = priceTuples.length > 0 ? priceTuples[0][1] : undefined
      let price = typeof rawPrice === 'string'
        ? (rawPrice.trim() === '' ? null : Number(rawPrice.replace(/[^0-9.]/g, '')))
        : (typeof rawPrice === 'number' ? rawPrice : null)

      // Deep fallback: recursively search for any key containing 'price'
      if (price == null) {
        const seen = new Set()
        const queue = [{ obj: src, depth: 0 }]
        const maxDepth = 4
        while (queue.length) {
          const { obj, depth } = queue.shift()
          if (!obj || typeof obj !== 'object' || seen.has(obj) || depth > maxDepth) continue
          seen.add(obj)
          for (const [k, v] of Object.entries(obj)) {
            if (v == null) continue
            const key = k.toLowerCase()
            if (key.includes('price') || key === 'lp' || key === 'listprice' || key === 'list_price') {
              if (typeof v === 'number') { price = v; price_source = k; break }
              if (typeof v === 'string') {
                const num = Number(v.replace(/[^0-9.]/g, ''))
                if (!Number.isNaN(num)) { price = num; price_source = k; break }
              }
              if (typeof v === 'object' && v.amount) {
                const num = typeof v.amount === 'string' ? Number(v.amount.replace(/[^0-9.]/g, '')) : v.amount
                if (!Number.isNaN(num)) { price = num; price_source = `${k}.amount`; break }
              }
            }
            if (typeof v === 'object') queue.push({ obj: v, depth: depth + 1 })
          }
          if (price != null) break
        }
      }

      // Normalize images and a primary thumbnail from various possible sources
      const urlFrom = (val) => {
        if (!val) return null
        if (typeof val === 'string') return val
        if (typeof val === 'object') {
          return (
            val.url || val.href || val.src || val.link || val.image || val.photo ||
            val.mediaUrl || val.media_url || val.highRes || val.midRes || val.lowRes || val.large || val.full ||
            val.original || val.medium || val.small || val.thumb || val.thumbnail ||
            val.url_full || val.url_small || val.url_thumb || val.thumbnail_url || null
          )
        }
        return null
      }
      // Prefer media.primaryListingImageUrl and media.photosList if present (but we'll ignore in final return to keep MLSDetail enrichment only)
      const media = src?.media || listing?.media
      let images = []
      if (media) {
        if (typeof media.primaryListingImageUrl === 'string') images.push(media.primaryListingImageUrl)
        if (Array.isArray(media.photosList)) {
          media.photosList.forEach(p => {
            const u = (p && (p.highRes || p.midRes || p.lowRes)) || urlFrom(p)
            if (u) images.push(u)
          })
        }
      }
      // 1) Shallow candidates
      const imageArrays = [
        src.images,
        src.photos,
        src.photo_urls,
        src.image_urls,
        src?.media?.photos,
        src?.media,
        src?.images?.all,
        src?.images,
        src?.photos?.results,
        src?.listing?.photos,
        src.mlsPhotos,
        src.mls_photos,
        src.mls_photo_urls,
        src.mlsPhotoUrls
      ].filter(Boolean)
      imageArrays.forEach(arr => {
        if (Array.isArray(arr)) {
          arr.forEach(it => {
            const u = urlFrom(it)
            if (u) images.push(u)
          })
        } else {
          const u = urlFrom(arr)
          if (u) images.push(u)
        }
      })

      // 2) Recursive deep scan for any keys containing photo/image/media with URL-ish strings
      const pushUrl = (u) => {
        if (!u || typeof u !== 'string') return
        const s = u.trim()
        if (!/^https?:\/\//i.test(s)) return
        images.push(s)
      }
      const seenDeep = new Set()
      const queueDeep = [{ obj: src, depth: 0 }]
      const maxDeep = 4
      while (queueDeep.length) {
        const { obj, depth } = queueDeep.shift()
        if (!obj || typeof obj !== 'object' || seenDeep.has(obj) || depth > maxDeep) continue
        seenDeep.add(obj)
        if (Array.isArray(obj)) {
          for (const v of obj) {
            if (typeof v === 'string') pushUrl(v)
            else if (typeof v === 'object') {
              const u = urlFrom(v)
              if (u) pushUrl(u)
              queueDeep.push({ obj: v, depth: depth + 1 })
            }
          }
        } else {
          for (const [k, v] of Object.entries(obj)) {
            const key = k.toLowerCase()
            if (typeof v === 'string') {
              if (key.includes('photo') || key.includes('image') || key.includes('media') || key.includes('thumbnail') || key.includes('url')) {
                pushUrl(v)
              }
            } else if (typeof v === 'object') {
              const u = urlFrom(v)
              if (u) pushUrl(u)
              if (Array.isArray(v) || key.includes('photo') || key.includes('image') || key.includes('media')) {
                queueDeep.push({ obj: v, depth: depth + 1 })
              }
            }
          }
        }
      }
      const singlePrimary = urlFrom(
        src.primary_photo_url || src.primaryImage || src.thumbnail_url || src.main_image_url || src.image_url || src.photo_url
      )
      if (singlePrimary) images.unshift(singlePrimary)
      // Dedupe while preserving order
      const seenImg = new Set()
      images = images.filter(u => {
        if (seenImg.has(u)) return false
        seenImg.add(u)
        return true
      })
      const primary_image = images.length > 0 ? images[0] : null

      // Extract possible MLS listing id if available
      const mls_id = (
        listing?.mlsNumber || src.mls_listing_id || src.mlsListingId || src.mlsListingID || src.mls_id || src.mlsId || src.mls_number || src.mlsNumber ||
        src.listing_id || src.listingId || src.id || null
      )

      // Prefer the provider's identifier if present
      const provider_id = (
        mls_id || src.id || src.property_id || src.propertyId ||
        src.apn || src.parcel_number || src.parcelNumber || src.property_identifier || null
      )

      const propertySubType = Array.isArray(listing?.property?.propertySubType)
        ? listing.property.propertySubType[0]
        : (listing?.property?.propertySubType || null)
      const propertyTypeMain = listing?.property?.propertyType || src.property_type || src.type || ''
      const normalizedPropertyType = propertySubType || propertyTypeMain

      return {
        id: provider_id || `prop_${Date.now()}_${Math.random()}`,
        provider_id,
        // Use only the street line for the title. City/State/ZIP are shown separately in the card.
        address: street || [city, state].filter(Boolean).join(', '),
        city,
        state,
        zipcode,
        price,
        price_source,
        // Use photos returned inline from MLSSearch/media extraction.
        primary_image,
        bedrooms: (listing?.property?.bedroomsTotal ?? src.bedrooms ?? src.beds ?? publicRec?.bedrooms ?? null),
        bathrooms: (listing?.property?.bathroomsTotal ?? src.bathrooms ?? src.baths ?? publicRec?.bathrooms ?? null),
        square_feet: (listing?.property?.livingArea ?? src.square_feet ?? src.sqft ?? (publicRec?.squareFeet ? Number(publicRec.squareFeet) : null)),
        property_type: normalizedPropertyType,
        property_type_main: propertyTypeMain || null,
        property_type_sub: propertySubType || null,
        listing_status: (listing?.standardStatus || listing?.customStatus || src.listing_status || src.status || ''),
        description: src.description || '',
        images,
        listing_date: src.listing_date || src.date_listed || null,
        days_on_market: src.days_on_market || src.dom || null,
        mls_number: mls_id || src.mls_number || src.mls_id || null,
        mls_id,
        lot_size: (listing?.property?.lotSizeSquareFeet ?? (publicRec?.lotSquareFeet ? Number(publicRec.lotSquareFeet) : null) ?? src.lot_size ?? null),
        year_built: (listing?.property?.yearBuilt ?? publicRec?.yearBuilt ?? src.year_built ?? null),
        garage: src.garage || 0,
        pool: src.pool || false,
        fireplace: src.fireplace || false
      }
    })

  // Apply property type filtering locally because MLS schema/category values differ from UI labels.
  const typeFiltered = property_type
    ? normalized.filter((p) => matchesPropertyTypeSelection(p, property_type))
    : normalized

  // Apply deterministic server-side sorting so UI order always matches selected sort option.
  const sortedNormalized = sortPropertiesBySelection(typeFiltered, sort_by)

  // MLSDetail image enrichment removed: using MLSSearch include_photos and inline media.

  // Pagination & totals (MLSSearch uses resultCount/resultIndex)
  const computedTotal = (
    typeof data.resultCount === 'number' ? data.resultCount :
    (typeof data.total === 'number' ? data.total : (typeof data.count === 'number' ? data.count : null))
  )
  const returnedCount = Array.isArray(sortedNormalized) ? sortedNormalized.length : 0
  const idx = typeof data.resultIndex === 'number' ? data.resultIndex : (Number(offset) || 1)
  const providerTotalLooksValid = computedTotal !== null && Number.isFinite(computedTotal) && computedTotal >= returnedCount
  const computedHasMore = (typeof data.has_more === 'boolean')
    ? data.has_more
    : (providerTotalLooksValid && Number.isFinite(idx)
        ? ((idx - 1) + returnedCount) < computedTotal
        : (Number.isFinite(Number(limit)) ? returnedCount >= Number(limit) : false))

  const hasLocalPropertyTypeFilter = Boolean(property_type)
  const baseTotal = providerTotalLooksValid ? computedTotal : returnedCount
  const effectiveTotal = hasLocalPropertyTypeFilter
    ? returnedCount
    : baseTotal
  const effectiveHasMore = hasLocalPropertyTypeFilter ? false : computedHasMore

  return {
    properties: sortedNormalized,
    total: effectiveTotal,
    has_more: effectiveHasMore,
    filters_applied: filters,
    is_fallback: false,
    live_attempted: true,
    // Optional: include a raw provider sample for debugging (dev only)
    debug_provider_sample: filters && (filters.include_raw || filters.debug) ? (rawProps[0] || null) : undefined,
    debug_provider_keys: filters && (filters.include_raw || filters.debug) && rawProps[0]
      ? Object.keys(rawProps[0])
      : undefined,
    // legacy debug fields for older UI snippets
    debug_raw_sample: filters && (filters.include_raw || filters.debug) ? (rawProps[0] || null) : undefined,
    debug_raw_sample_keys: filters && (filters.include_raw || filters.debug) && rawProps[0]
      ? Object.keys(rawProps[0])
      : undefined,
    debug_enrichment: filters && (filters.include_raw || filters.debug) ? (filters._debug_enrichment || null) : undefined
  }
  } catch (error) {
    console.error('Property Search Error:', error)
    
    // Return fallback data on error
    return {
      ...generateFallbackProperties(filters),
      live_attempted: true,
      fallback_reason: 'mls_exception',
      fallback_details: String(error?.message || error)
    }
  }
}

// Legacy function for backwards compatibility
async function searchProperties(filters = {}) {
  const result = await fetchProperties(filters)
  return result.properties || []
}

// Helpers ------------------------------
// Remove null/undefined/empty-string values from prefs
function sanitizePreferences(prefs = {}) {
  const clean = {}
  for (const [k, v] of Object.entries(prefs)) {
    if (v !== null && v !== undefined && (typeof v !== 'string' || v.trim() !== '')) {
      clean[k] = v
    }
  }
  return clean
}

// Map Lead preferences to RealEstateAPI filter schema
function mapLeadPreferencesToFilters(prefs = {}) {
  if (!prefs || typeof prefs !== 'object') return {}
  return {
    location: prefs.zipcode || prefs.preferred_zipcode || prefs.location || undefined,
    beds: prefs.bedrooms || prefs.beds || undefined,
    baths: prefs.bathrooms || prefs.baths || undefined,
    min_price: prefs.min_price || prefs.minPrice || undefined,
    max_price: prefs.max_price || prefs.maxPrice || undefined,
    property_type: prefs.property_type || prefs.type || undefined,
  }
}

// Stage Transition Validation using o1-mini (aware of buyer vs seller flows)
async function validateStageTransition(db, transactionId, currentStage, targetStage, force = false) {
  try {
    // Load transaction to determine flow type
    const tx = await db.collection('transactions').findOne({ id: transactionId })
    const txType = (tx?.transaction_type || 'sale').toLowerCase()
    const isBuyer = txType === 'purchase'
    const stagesInOrder = isBuyer
      ? ['pre_approval','home_search','offer','under_contract','escrow_closing']
      : ['pre_listing','listing','under_contract','escrow_closing']

    // Get all checklist items for current stage
    const currentStageItems = await db.collection('checklist_items')
      .find({ 
        transaction_id: transactionId, 
        stage: currentStage 
      })
      .toArray()
    // completeness for validation is computed below using parent/child relationships
    // (avoid premature lists here to prevent variable redeclaration)

    // Compute effective completeness using normalized parent/child items and consider dependencies
    const allStageItems = currentStageItems
    const parents = allStageItems.filter(i => !i.parent_id)
    const children = allStageItems.filter(i => i.parent_id)

    const childrenByParent = new Map()
    for (const c of children) {
      if (!childrenByParent.has(c.parent_id)) childrenByParent.set(c.parent_id, [])
      childrenByParent.get(c.parent_id).push(c)
    }

    const isCompleted = (it) => it.status === 'completed'
    const parentEffectiveComplete = new Map()
    for (const p of parents) {
      const kids = childrenByParent.get(p.id) || []
      const complete = kids.length > 0 ? kids.every(isCompleted) : isCompleted(p)
      parentEffectiveComplete.set(p.id, complete)
    }

    const completedIdSet = new Set([
      ...children.filter(isCompleted).map(i => i.id),
      ...parents.filter(p => parentEffectiveComplete.get(p.id)).map(p => p.id)
    ])

    // Items considered incomplete for validation: incomplete parents (effective) and any incomplete children
    const incompleteParents = parents.filter(p => !parentEffectiveComplete.get(p.id))
    const incompleteChildren = children.filter(c => !isCompleted(c))
    const incompleteItems = [...incompleteParents, ...incompleteChildren]
    const blockedItems = allStageItems.filter(item => item.status === 'blocked')

    // Check unmet dependencies (for both parents and children)
    const unmetDependencyItems = []
    for (const it of allStageItems) {
      const deps = Array.isArray(it.dependencies) ? it.dependencies : []
      const unmet = deps.filter(did => !completedIdSet.has(did))
      if (unmet.length > 0) {
        unmetDependencyItems.push({ id: it.id, title: it.title, unmet_count: unmet.length })
      }
    }

    // Use o1-mini for intelligent validation
    const validationMessages = [
      {
        role: "system",
        content: `You are a real estate transaction expert. Analyze stage transitions for completeness and compliance.

        Transaction type: ${isBuyer ? 'purchase (buyer)' : 'sale (seller)'}
        Current stage: ${currentStage}
        Target stage: ${targetStage}
        
        Stages in order for this flow:
        ${stagesInOrder.map((s, i) => `${i+1}. ${s}`).join('\n')}
        
        Rules:
        - All critical tasks must be completed before advancing
        - Some tasks can be moved to next stage if reasonable
        - Blocked items must be resolved
        - Cannot skip stages (must go in order)
        
        Return JSON with:
        {
          "valid": boolean,
          "confidence": number (0-100),
          "errors": ["error messages"],
          "warnings": ["warning messages"],
          "missing_critical": ["critical task titles"],
          "can_proceed_with_warnings": boolean,
          "recommendations": ["suggestions"]
        }`
      },
      {
        role: "user", 
        content: `Validate transition from "${currentStage}" to "${targetStage}".
        
        Incomplete items (${incompleteItems.length}):
        ${incompleteItems.map(item => `- ${item.title} (${item.priority || 'medium'} priority, status: ${item.status}${item.parent_id ? ', subtask' : ''})`).join('\n')}
        
        Blocked items (${blockedItems.length}):
        ${blockedItems.map(item => `- ${item.title} (blocked: ${item.notes})`).join('\n')}

        Items with unmet dependencies (${unmetDependencyItems.length}):
        ${unmetDependencyItems.map(x => `- ${x.title} (${x.unmet_count} unmet)`).join('\n')}
        
        Force override requested: ${force}
        
        Should this transition be allowed?`
      }
    ]

    const validationResponse = await callOpenAI('o1-mini', validationMessages)
    let validationResult

    try {
      validationResult = JSON.parse(validationResponse)
    } catch (parseError) {
      // Fallback validation logic including stage order enforcement and dependency checks
      const curIdx = stagesInOrder.indexOf(currentStage)
      const tgtIdx = stagesInOrder.indexOf(targetStage)
      const inOrder = curIdx !== -1 && tgtIdx !== -1 && tgtIdx <= curIdx + 1 && tgtIdx >= curIdx
      validationResult = {
        valid: inOrder && incompleteItems.length === 0 && blockedItems.length === 0 && unmetDependencyItems.length === 0,
        confidence: 70,
        errors: [
          ...(inOrder ? [] : ["Invalid stage order for this transaction type"]),
          ...(incompleteItems.length > 0 ? [`${incompleteItems.length} incomplete tasks`] : []),
          ...(unmetDependencyItems.length > 0 ? [`${unmetDependencyItems.length} items with unmet dependencies`] : [])
        ],
        warnings: blockedItems.length > 0 ? [`${blockedItems.length} blocked tasks`] : [],
        missing_critical: incompleteItems.filter(i => i.priority === 'high' || i.priority === 'urgent').map(i => i.title),
        can_proceed_with_warnings: inOrder && incompleteItems.filter(i => i.priority === 'high' || i.priority === 'urgent').length === 0 && unmetDependencyItems.length === 0,
        recommendations: ["Complete high-priority tasks before proceeding"]
      }
    }

    return {
      valid: force || (validationResult.valid || validationResult.can_proceed_with_warnings),
      ...validationResult,
      incomplete_count: incompleteItems.length,
      blocked_count: blockedItems.length,
      missing_tasks: incompleteItems.map(item => ({
        id: item.id,
        title: item.title,
        priority: item.priority,
        status: item.status
      }))
    }
  } catch (error) {
    console.error('Stage validation error:', error)
    return {
      valid: false,
      confidence: 0,
      errors: ["Validation service unavailable"],
      warnings: [],
      missing_critical: [],
      can_proceed_with_warnings: false,
      recommendations: ["Please try again or contact support"]
    }
  }
}

// Create default checklist items for each stage (aware of transaction type)
async function createDefaultChecklistItems(db, transactionId, stage, transactionType = 'sale') {
  const defaultTasks = getDefaultTasksForStage(stage, transactionType)

  // Normalized model with parent/child docs
  const itemsToInsert = []
  defaultTasks.forEach((task, index) => {
    const parentId = uuidv4()
    const parentDoc = {
      id: parentId,
      transaction_id: transactionId,
      title: task.title,
      description: task.description,
      stage: stage,
      status: 'not_started',
      priority: task.priority,
      assignee: '',
      due_date: task.due_days ? new Date(Date.now() + task.due_days * 24 * 60 * 60 * 1000) : null,
      completed_date: null,
      notes: '',
      order: index + 1,
      stage_order: getStageOrder(stage, transactionType),
      dependencies: task.dependencies || [],
      weight: typeof task.weight === 'number' ? task.weight : 1,
      parent_id: null,
      created_at: new Date(),
      updated_at: new Date()
    }
    itemsToInsert.push(parentDoc)

    const subs = Array.isArray(task.subtasks) ? task.subtasks : []
    subs.forEach((sub, sIdx) => {
      const childDoc = {
        id: uuidv4(),
        transaction_id: transactionId,
        title: sub.title,
        description: sub.description || '',
        stage: stage,
        status: 'not_started',
        priority: sub.priority || task.priority || 'medium',
        assignee: '',
        due_date: sub.due_days ? new Date(Date.now() + sub.due_days * 24 * 60 * 60 * 1000) : null,
        completed_date: null,
        notes: '',
        // keep same order as parent for grouping; frontend will nest by parent_id
        order: index + 1,
        stage_order: parentDoc.stage_order,
        dependencies: Array.isArray(sub.dependencies) ? sub.dependencies : [],
        weight: typeof sub.weight === 'number' ? sub.weight : 1,
        parent_id: parentId,
        created_at: new Date(),
        updated_at: new Date()
      }
      itemsToInsert.push(childDoc)
    })
  })

  if (itemsToInsert.length > 0) {
    await db.collection('checklist_items').insertMany(itemsToInsert)
  }

  return itemsToInsert.map(({ _id, ...rest }) => rest)
}

// Get stage order for sorting, branching by transaction type
function getStageOrder(stage, transactionType = 'sale') {
  const sellerOrder = {
    'pre_listing': 1,
    'listing': 2,
    'under_contract': 3,
    'escrow_closing': 4
  }
  const buyerOrder = {
    'pre_approval': 1,
    'home_search': 2,
    'offer': 3,
    'under_contract': 4,
    'escrow_closing': 5
  }
  const mapping = (transactionType === 'purchase') ? buyerOrder : sellerOrder
  return mapping[stage] || 999
}

// Helper function to extract names from messages (fallback parsing)
function extractNameFromMessage(message) {
  // Simple regex to find potential names
  const namePatterns = [
    /met\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i,
    /client\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i,
    /([A-Z][a-z]+\s+[A-Z][a-z]+)(?:\s+wants|is\s+looking|needs)/i
  ]
  
  for (const pattern of namePatterns) {
    const match = message.match(pattern)
    if (match && match[1]) {
      return match[1].trim()
    }
  }
  
  return null
}

// Deal Summary Generation with o1-mini
async function generateDealSummary(db, propertyAddress) {
  try {
    // Find transaction by property address
    const transaction = await db.collection('transactions').findOne({
      property_address: { $regex: propertyAddress, $options: 'i' }
    })

    if (!transaction) {
      return {
        success: false,
        error: "Transaction not found",
        property_address: propertyAddress
      }
    }

    return await generateDealSummaryById(db, transaction.id)
  } catch (error) {
    console.error('Deal summary error:', error)
    return {
      success: false,
      error: "Failed to generate summary"
    }
  }
}

async function generateDealSummaryById(db, transactionId) {
  try {
    // Get transaction details
    const transaction = await db.collection('transactions').findOne({ id: transactionId })
    if (!transaction) {
      return {
        success: false,
        error: "Transaction not found"
      }
    }

    // Get all checklist items
    const checklistItems = await db.collection('checklist_items')
      .find({ transaction_id: transactionId })
      .sort({ stage_order: 1, order: 1 })
      .toArray()

    // Calculate overdue tasks
    const now = new Date()
    const overdueTasks = checklistItems.filter(item => 
      item.due_date && 
      new Date(item.due_date) < now && 
      item.status !== 'completed'
    )

    // Calculate stage completion
    const currentStageItems = checklistItems.filter(item => item.stage === transaction.current_stage)
    const completedStageItems = currentStageItems.filter(item => item.status === 'completed')
    const stageProgress = currentStageItems.length > 0 
      ? Math.round((completedStageItems.length / currentStageItems.length) * 100)
      : 0

    // Use o1-mini for intelligent deal analysis
    const analysisMessages = [
      {
        role: "system",
        content: `You are a real estate deal analyst. Analyze the transaction data and provide a comprehensive summary with actionable insights.

        Focus on:
        - Current stage status and progress
        - Critical overdue items requiring immediate attention
        - Key next steps to keep the deal moving
        - Risk factors and recommendations
        - Timeline insights and potential delays

        Return structured JSON with:
        {
          "summary": "Brief deal overview",
          "current_status": "Current stage analysis",
          "progress_assessment": "Overall progress evaluation",
          "critical_actions": ["List of urgent actions needed"],
          "overdue_risks": "Analysis of overdue items impact",
          "next_steps": ["Prioritized next steps"],
          "recommendations": ["Strategic recommendations"],
          "timeline_outlook": "Timeline assessment and closing likelihood"
        }`
      },
      {
        role: "user",
        content: `Analyze this real estate transaction:

        Property: ${transaction.property_address}
        Client: ${transaction.client_name}
        Type: ${transaction.transaction_type}
        Current Stage: ${transaction.current_stage}
        Stage Progress: ${stageProgress}% (${completedStageItems.length}/${currentStageItems.length} tasks)
        
        Overdue Tasks (${overdueTasks.length}):
        ${overdueTasks.map(task => `- ${task.title} (${task.priority} priority, due ${new Date(task.due_date).toLocaleDateString()})`).join('\n')}
        
        Current Stage Items:
        ${currentStageItems.map(item => `- ${item.title}: ${item.status} (${item.priority})`).join('\n')}
        
        Transaction Created: ${new Date(transaction.created_at).toLocaleDateString()}
        Last Updated: ${new Date(transaction.updated_at).toLocaleDateString()}
        
        Provide comprehensive analysis and actionable recommendations.`
      }
    ]

    const aiAnalysis = await callOpenAI('o1-mini', analysisMessages)
    let analysisResult

    try {
      analysisResult = JSON.parse(aiAnalysis)
    } catch (parseError) {
      // Fallback analysis
      analysisResult = {
        summary: `${transaction.property_address} - ${transaction.current_stage} stage with ${stageProgress}% completion`,
        current_status: `Currently in ${transaction.current_stage} stage`,
        progress_assessment: stageProgress >= 75 ? "Good progress" : stageProgress >= 50 ? "Moderate progress" : "Needs attention",
        critical_actions: overdueTasks.slice(0, 3).map(task => task.title),
        overdue_risks: overdueTasks.length > 0 ? "Multiple overdue tasks may delay closing" : "No overdue tasks",
        next_steps: currentStageItems.filter(item => item.status === 'not_started').slice(0, 3).map(item => item.title),
        recommendations: ["Review overdue tasks", "Update task assignments", "Set realistic deadlines"],
        timeline_outlook: "Timeline assessment pending detailed review"
      }
    }

    return {
      success: true,
      transaction: {
        ...transaction,
        _id: undefined
      },
      checklist_summary: {
        total_tasks: checklistItems.length,
        completed_tasks: checklistItems.filter(item => item.status === 'completed').length,
        overdue_tasks: overdueTasks.length,
        current_stage_progress: stageProgress,
        current_stage_tasks: currentStageItems.length
      },
      overdue_tasks: overdueTasks.map(({ _id, ...rest }) => rest),
      ai_analysis: analysisResult,
      generated_at: new Date()
    }
  } catch (error) {
    console.error('Deal summary generation error:', error)
    return {
      success: false,
      error: "Failed to generate deal summary"
    }
  }
}

// Smart Alerts System
async function getSmartAlerts(db, filters = {}) {
  try {
    // Get existing alerts from database
    let query = { status: { $ne: 'dismissed' } }
    
    if (filters.agent) query.assigned_agent = filters.agent
    if (filters.priority) query.priority = filters.priority
    if (filters.type) query.alert_type = filters.type

    const existingAlerts = await db.collection('smart_alerts')
      .find(query)
      .sort({ created_at: -1 })
      .limit(50)
      .toArray()

    // Generate new alerts if needed
    const newAlerts = await generateSmartAlerts(db)
    // Apply same filters to freshly generated alerts
    const filteredNewAlerts = newAlerts.filter(a => (
      (!filters.agent || a.assigned_agent === filters.agent) &&
      (!filters.priority || a.priority === filters.priority) &&
      (!filters.type || a.alert_type === filters.type)
    ))

    // Combine and return all alerts
    const allAlerts = [...filteredNewAlerts, ...existingAlerts.filter(alert => 
      !filteredNewAlerts.find(newAlert => 
        newAlert.transaction_id === alert.transaction_id && 
        newAlert.alert_type === alert.alert_type
      )
    )]

    return {
      success: true,
      alerts: allAlerts.map(({ _id, ...rest }) => rest),
      total: allAlerts.length,
      filters_applied: filters
    }
  } catch (error) {
    console.error('Smart alerts error:', error)
    return {
      success: false,
      error: "Failed to get smart alerts"
    }
  }
}

async function generateSmartAlerts(db) {
  try {
    const now = new Date()
    const threeDaysAgo = new Date(now.getTime() - (3 * 24 * 60 * 60 * 1000))
    const sevenDaysAgo = new Date(now.getTime() - (7 * 24 * 60 * 60 * 1000))

    // Get all active transactions
    const transactions = await db.collection('transactions')
      .find({ current_stage: { $ne: 'closed' } })
      .toArray()

    // Build candidate alerts based on current state
    const candidates = []
    for (const transaction of transactions) {
      // Overdue tasks (> 3 days)
      const overdueTasks = await db.collection('checklist_items')
        .find({
          transaction_id: transaction.id,
          due_date: { $lt: threeDaysAgo },
          status: { $ne: 'completed' }
        })
        .toArray()

      if (overdueTasks.length > 0) {
        candidates.push({
          alert_type: 'overdue_tasks',
          priority: overdueTasks.some(task => task.priority === 'urgent') ? 'urgent' : 'high',
          transaction_id: transaction.id,
          property_address: transaction.property_address,
          client_name: transaction.client_name,
          assigned_agent: transaction.assigned_agent,
          title: `${overdueTasks.length} Overdue Tasks`,
          message: `${transaction.property_address} has ${overdueTasks.length} tasks overdue by more than 3 days`,
          details: {
            overdue_count: overdueTasks.length,
            most_overdue: overdueTasks[0]?.title,
            overdue_tasks: overdueTasks.slice(0, 5).map(task => ({
              title: task.title,
              due_date: task.due_date,
              priority: task.priority,
              days_overdue: Math.ceil((now - new Date(task.due_date)) / (1000 * 60 * 60 * 24))
            }))
          }
        })
      }

      // Deal inactivity (> 7 days)
      if (new Date(transaction.updated_at) < sevenDaysAgo) {
        candidates.push({
          alert_type: 'deal_inactivity',
          priority: 'medium',
          transaction_id: transaction.id,
          property_address: transaction.property_address,
          client_name: transaction.client_name,
          assigned_agent: transaction.assigned_agent,
          title: 'Deal Inactive',
          message: `${transaction.property_address} has been inactive for ${Math.ceil((now - new Date(transaction.updated_at)) / (1000 * 60 * 60 * 24))} days`,
          details: {
            days_inactive: Math.ceil((now - new Date(transaction.updated_at)) / (1000 * 60 * 60 * 24)),
            current_stage: transaction.current_stage,
            last_update: transaction.updated_at
          }
        })
      }

      // Approaching closing date (<= 7 days)
      if (transaction.closing_date) {
        const closingDate = new Date(transaction.closing_date)
        const daysToClosing = Math.ceil((closingDate - now) / (1000 * 60 * 60 * 24))
        if (!Number.isNaN(closingDate.getTime())) {
          const stageHistory = Array.isArray(transaction.stage_history) ? transaction.stage_history : []
          const txType = (transaction.transaction_type || 'sale').toLowerCase()
          const scopedStages = new Set(
            stageHistory
              .filter((entry) => {
                if (!entry || !entry.stage) return false
                if (entry.forced === true) return true
                // Backward-compatible heuristic for older history entries.
                return entry?.validation_result?.valid === false
              })
              .flatMap((entry) => [entry.stage, entry.transitioned_from].filter(Boolean))
          )
          scopedStages.add(transaction.current_stage)

          // Backward compatibility for previously force-transitioned records:
          // older in-memory/Postgres adapter behavior did not persist `$push` stage_history updates.
          const hasCurrentStageInHistory = stageHistory.some((entry) => entry?.stage === transaction.current_stage)
          if (!hasCurrentStageInHistory) {
            const allIncompleteForTx = await db.collection('checklist_items')
              .find({
                transaction_id: transaction.id,
                status: { $ne: 'completed' }
              })
              .toArray()

            const currentOrder = getStageOrder(transaction.current_stage, txType)
            allIncompleteForTx.forEach((task) => {
              const order = getStageOrder(task.stage, txType)
              if (order <= currentOrder) scopedStages.add(task.stage)
            })
          }

          const stagesToInclude = Array.from(scopedStages)

          const incompleteItems = await db.collection('checklist_items')
            .find({
              transaction_id: transaction.id,
              stage: { $in: stagesToInclude },
              status: { $ne: 'completed' }
            })
            .toArray()
          if (incompleteItems.length > 0) {
            const openStages = Array.from(
              new Set(incompleteItems.map((task) => task.stage).filter(Boolean))
            ).sort((a, b) => getStageOrder(a, txType) - getStageOrder(b, txType))
            const remainingTasks = [...incompleteItems]
              .sort((a, b) => {
                const ad = a?.due_date ? new Date(a.due_date).getTime() : Number.POSITIVE_INFINITY
                const bd = b?.due_date ? new Date(b.due_date).getTime() : Number.POSITIVE_INFINITY
                if (ad !== bd) return ad - bd
                return String(a?.title || '').localeCompare(String(b?.title || ''))
              })
              .map((task) => ({
                id: task.id,
                title: task.title,
                stage: task.stage,
                due_date: task.due_date || null,
                priority: task.priority || 'medium'
              }))

            const closingPriority = daysToClosing <= 3
              ? 'urgent'
              : daysToClosing <= 7
                ? 'high'
                : daysToClosing <= 14
                  ? 'medium'
                  : 'low'

            candidates.push({
              alert_type: 'closing_approaching',
              priority: closingPriority,
              transaction_id: transaction.id,
              property_address: transaction.property_address,
              client_name: transaction.client_name,
              assigned_agent: transaction.assigned_agent,
              title: daysToClosing > 0
                ? `Closing in ${daysToClosing} Days`
                : `Closing overdue by ${Math.abs(daysToClosing)} ${Math.abs(daysToClosing) === 1 ? 'Day' : 'Days'}`,
              message: daysToClosing > 0
                ? `${transaction.property_address} closes in ${daysToClosing} days with ${incompleteItems.length} incomplete tasks`
                : `${transaction.property_address} is past closing by ${Math.abs(daysToClosing)} days with ${incompleteItems.length} incomplete tasks`,
              details: {
                days_to_closing: daysToClosing,
                closing_date: transaction.closing_date,
                incomplete_tasks: incompleteItems.length,
                current_stage: transaction.current_stage,
                open_stages: openStages,
                remaining_tasks: remainingTasks
              }
            })
          }
        }
      }
    }

    // Upsert alerts per (transaction_id, alert_type), preserve dismissed status
    const collection = db.collection('smart_alerts')
    const upserted = []
    for (const cand of candidates) {
      const existing = await collection.findOne({ transaction_id: cand.transaction_id, alert_type: cand.alert_type })
      if (existing) {
        const keepDismissed = existing.status === 'dismissed' && cand.alert_type !== 'closing_approaching'
        const updateFields = {
          // Ensure all core fields are current
          priority: cand.priority,
          property_address: cand.property_address,
          client_name: cand.client_name,
          assigned_agent: cand.assigned_agent,
          title: cand.title,
          message: cand.message,
          details: cand.details,
          updated_at: now
        }
        // Backfill missing custom id for legacy docs
        if (!existing.id) updateFields.id = uuidv4()
        // Reactivate all non-dismissed alerts and always reactivate closing alerts.
        if (!keepDismissed) updateFields.status = 'active'
        // Update by unique key (transaction_id, alert_type) to handle legacy docs without id
        await collection.updateOne(
          { transaction_id: cand.transaction_id, alert_type: cand.alert_type },
          {
            $set: updateFields,
            ...(!keepDismissed ? { $unset: { dismissed_at: '' } } : {})
          }
        )
        const doc = await collection.findOne({ transaction_id: cand.transaction_id, alert_type: cand.alert_type })
        if (doc && doc.status !== 'dismissed') {
          const { _id, ...rest } = doc
          upserted.push(rest)
        }
      } else {
        const doc = {
          id: uuidv4(),
          alert_type: cand.alert_type,
          priority: cand.priority,
          transaction_id: cand.transaction_id,
          property_address: cand.property_address,
          client_name: cand.client_name,
          assigned_agent: cand.assigned_agent,
          title: cand.title,
          message: cand.message,
          details: cand.details,
          created_at: now,
          updated_at: now,
          status: 'active'
        }
        await collection.insertOne(doc)
        const { _id, ...rest } = doc
        upserted.push(rest)
      }
    }

    return upserted
  } catch (error) {
    console.error('Smart alerts generation error:', error)
    return []
  }
}

function getDefaultTasksForStage(stage, transactionType = 'sale') {
  // Seller (listing) flow tasks
  const sellerTasks = {
    'pre_listing': [
      {
        title: 'Property Condition Assessment',
        description: 'Conduct thorough walkthrough to identify needed repairs and improvements',
        priority: 'high',
        due_days: 3,
        weight: 2,
        subtasks: [
          { title: 'Schedule walkthrough', weight: 1 },
          { title: 'Document issues & photos', weight: 1 }
        ]
      },
      {
        title: 'Comparative Market Analysis (CMA)',
        description: 'Research comparable sales, active listings, and market trends',
        priority: 'high',
        due_days: 5,
        weight: 1
      },
      {
        title: 'Pricing Strategy Development',
        description: 'Set competitive listing price based on CMA and market conditions',
        priority: 'high',
        due_days: 7,
        weight: 1
      },
      {
        title: 'Home Staging Consultation',
        description: 'Evaluate staging needs and arrange professional staging if needed',
        priority: 'medium',
        due_days: 10,
        weight: 1,
        subtasks: [
          { title: 'Hire stager', weight: 1 },
          { title: 'Staging day scheduled', weight: 1 }
        ]
      },
      {
        title: 'Professional Photography Scheduling',
        description: 'Book professional photographer for listing photos',
        priority: 'high',
        due_days: 12,
        weight: 1,
        subtasks: [
          { title: 'Select photographer', weight: 0.5 },
          { title: 'Photoshoot completed', weight: 0.5 }
        ]
      },
      {
        title: 'Marketing Materials Preparation',
        description: 'Create flyers, brochures, and property feature sheets',
        priority: 'medium',
        due_days: 14,
        weight: 1
      },
      {
        title: 'Pre-Listing Inspections',
        description: 'Schedule home, pest, and other recommended inspections',
        priority: 'medium',
        due_days: 14,
        weight: 1,
        subtasks: [
          { title: 'Home inspection', weight: 0.5 },
          { title: 'Pest inspection', weight: 0.5 }
        ]
      },
      {
        title: 'Listing Agreement Execution',
        description: 'Sign listing agreement and review all terms with seller',
        priority: 'urgent',
        due_days: 1,
        weight: 1
      }
    ],
    'listing': [
      {
        title: 'MLS Entry and Syndication',
        description: 'Enter property details in MLS and syndicate to major real estate websites',
        priority: 'urgent',
        due_days: 1,
        weight: 1
      },
      {
        title: 'Listing Photos Upload',
        description: 'Upload high-quality photos to MLS and marketing platforms',
        priority: 'high',
        due_days: 1,
        weight: 1
      },
      {
        title: 'Property Description Optimization',
        description: 'Write compelling property description highlighting key features',
        priority: 'high',
        due_days: 2
      },
      {
        title: 'Social Media Marketing Campaign',
        description: 'Create and launch social media marketing posts and ads',
        priority: 'medium',
        due_days: 3
      },
      {
        title: 'Open House Scheduling',
        description: 'Schedule and advertise open house events',
        priority: 'medium',
        due_days: 7
      },
      {
        title: 'Showing Management System Setup',
        description: 'Configure showing system and coordinate with seller',
        priority: 'high',
        due_days: 2
      },
      {
        title: 'Lead Follow-up System',
        description: 'Implement system to track and follow up with interested buyers',
        priority: 'high',
        due_days: 5
      },
      {
        title: 'Market Feedback Collection',
        description: 'Gather feedback from showings and adjust strategy as needed',
        priority: 'medium',
        due_days: 14
      }
    ],
    'under_contract': [
      {
        title: 'Purchase Agreement Review',
        description: 'Review all contract terms and conditions with client',
        priority: 'urgent',
        due_days: 1,
        weight: 2,
        subtasks: [
          { title: 'Confirm contingencies', weight: 1 },
          { title: 'Review timelines', weight: 1 }
        ]
      },
      {
        title: 'Earnest Money Deposit',
        description: 'Collect and deposit earnest money per contract terms',
        priority: 'urgent',
        due_days: 2,
        weight: 1
      },
      {
        title: 'Home Inspection Coordination',
        description: 'Schedule home inspection and coordinate access',
        priority: 'high',
        due_days: 7,
        weight: 1,
        subtasks: [
          { title: 'Schedule inspector', weight: 0.5 },
          { title: 'Distribute report', weight: 0.5 }
        ]
      },
      {
        title: 'Appraisal Scheduling',
        description: 'Coordinate appraisal appointment with lender and appraiser',
        priority: 'high',
        due_days: 10
      },
      {
        title: 'Loan Processing Follow-up',
        description: 'Monitor buyer\'s loan application progress with lender',
        priority: 'high',
        due_days: 14
      },
      {
        title: 'Inspection Response Negotiation',
        description: 'Review inspection report and negotiate any needed repairs',
        priority: 'high',
        due_days: 10
      },
      {
        title: 'Insurance Verification',
        description: 'Verify buyer has secured homeowner\'s insurance',
        priority: 'medium',
        due_days: 20
      },
      {
        title: 'Final Walk-through Scheduling',
        description: 'Schedule final walk-through 24-48 hours before closing',
        priority: 'medium',
        due_days: 25
      }
    ],
    'escrow_closing': [
      {
        title: 'Title Company Coordination',
        description: 'Coordinate with title company and review title commitment',
        priority: 'high',
        due_days: 3
      },
      {
        title: 'Closing Disclosure Review',
        description: 'Review closing disclosure with client for accuracy',
        priority: 'high',
        due_days: 5
      },
      {
        title: 'Final Walk-through Execution',
        description: 'Complete final walk-through with buyer',
        priority: 'high',
        due_days: 1
      },
      {
        title: 'Closing Document Preparation',
        description: 'Ensure all closing documents are prepared and reviewed',
        priority: 'urgent',
        due_days: 2
      },
      {
        title: 'Keys and Garage Remote Transfer',
        description: 'Coordinate transfer of all keys, garage remotes, and access codes',
        priority: 'high',
        due_days: 1
      },
      {
        title: 'Utility Transfer Coordination',
        description: 'Assist with utility transfer arrangements',
        priority: 'medium',
        due_days: 3
      },
      {
        title: 'Closing Day Coordination',
        description: 'Attend closing and ensure smooth transaction completion',
        priority: 'urgent',
        due_days: 0
      },
      {
        title: 'Post-Closing Follow-up',
        description: 'Follow up with clients to ensure satisfaction and gather feedback',
        priority: 'low',
        due_days: 7
      }
    ]
  }

  // Buyer (purchase) flow tasks
  const buyerTasks = {
    'pre_approval': [
      { title: 'Lender Introduction', description: 'Connect client with preferred lenders to start pre-approval', priority: 'high', due_days: 2 },
      { title: 'Collect Financial Docs', description: 'Gather pay stubs, W-2s, bank statements for lender', priority: 'high', due_days: 5 },
      { title: 'Pre-Approval Letter', description: 'Obtain pre-approval letter with target price range and loan program', priority: 'urgent', due_days: 7 }
    ],
    'home_search': [
      { title: 'Define Search Criteria', description: 'Clarify location, beds/baths, budget, must-haves and nice-to-haves', priority: 'high', due_days: 2 },
      { title: 'Auto-Search Setup', description: 'Set up MLS/autosearch alerts matching buyer preferences', priority: 'medium', due_days: 2 },
      { title: 'Schedule Showings', description: 'Organize tours for top candidate properties', priority: 'medium', due_days: 7 }
    ],
    'offer': [
      { title: 'Offer Strategy', description: 'Discuss comps, contingencies, timelines, and negotiation plan', priority: 'high', due_days: 1 },
      { title: 'Draft Offer', description: 'Prepare purchase contract and required disclosures', priority: 'urgent', due_days: 1 },
      { title: 'Submit Offer', description: 'Submit offer and confirm receipt with listing agent', priority: 'urgent', due_days: 1 }
    ],
    'under_contract': [
      { title: 'Earnest Money Deposit', description: 'Deliver EMD per contract terms', priority: 'urgent', due_days: 2 },
      { title: 'Inspection Scheduling', description: 'Coordinate inspections and review findings', priority: 'high', due_days: 7 },
      { title: 'Appraisal Ordered', description: 'Confirm appraisal is ordered and scheduled', priority: 'high', due_days: 10 },
      { title: 'Loan Processing', description: 'Monitor underwriting and provide any additional docs', priority: 'high', due_days: 14 }
    ],
    'escrow_closing': [
      { title: 'Title Review', description: 'Review title commitment and address issues', priority: 'high', due_days: 3 },
      { title: 'Closing Disclosure Review', description: 'Review CD with buyer and verify figures', priority: 'high', due_days: 5 },
      { title: 'Final Walk-through', description: 'Confirm property condition prior to close', priority: 'medium', due_days: 1 },
      { title: 'Closing Logistics', description: 'Coordinate signing, funds, and key handoff', priority: 'urgent', due_days: 0 }
    ]
  }

  const templates = transactionType === 'purchase' ? buyerTasks : sellerTasks
  return templates[stage] || []
}

function toNumericComparable(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const parsed = Number(String(value).replace(/[^0-9.-]/g, ''))
  return Number.isFinite(parsed) ? parsed : null
}

function toTimestampComparable(value) {
  if (!value) return null
  const ts = Date.parse(String(value))
  return Number.isFinite(ts) ? ts : null
}

function normalizePropertyTypeToken(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function matchesPropertyTypeSelection(property = {}, selectedType = '') {
  const selected = normalizePropertyTypeToken(selectedType)
  if (!selected || selected === 'any') return true

  const haystack = [
    property?.property_type,
    property?.property_type_main,
    property?.property_type_sub
  ]
    .map(normalizePropertyTypeToken)
    .filter(Boolean)
    .join(' ')

  if (!haystack) return false

  if (selected === 'single family') {
    // Keep this strict so "townhouse" and other residential categories don't leak in.
    if (/townhouse|townhome|condo|condominium|multi family|multifamily|duplex|triplex|fourplex|quadplex|apartment|land|lot|farm|ranch|commercial/.test(haystack)) {
      return false
    }
    return /single family residence|single family|singlefamily|detached|sfr/.test(haystack)
  }
  if (selected === 'condo') {
    return /condo|condominium/.test(haystack)
  }
  if (selected === 'townhouse') {
    return /townhouse|townhome/.test(haystack)
  }
  if (selected === 'multi family') {
    return /multi family|multifamily|duplex|triplex|fourplex|quadplex|residential income|apartment/.test(haystack)
  }
  if (selected === 'land') {
    return /land|lot|acreage|farm|ranch|agricultural/.test(haystack)
  }

  return haystack.includes(selected)
}

function sortPropertiesBySelection(properties = [], sortBy = 'price_asc') {
  const list = Array.isArray(properties) ? [...properties] : []
  const get = {
    price: (p) => toNumericComparable(p?.price),
    beds: (p) => toNumericComparable(p?.bedrooms),
    baths: (p) => toNumericComparable(p?.bathrooms),
    sqft: (p) => toNumericComparable(p?.square_feet),
    // Prefer listing_date; fall back to days_on_market (lower is newer).
    recency: (p) => {
      const ts = toTimestampComparable(p?.listing_date)
      if (ts !== null) return ts
      const dom = toNumericComparable(p?.days_on_market)
      return dom !== null ? -dom : null
    }
  }

  const compareNullable = (a, b, direction = 'asc') => {
    const av = a === null || a === undefined
    const bv = b === null || b === undefined
    if (av && bv) return 0
    if (av) return 1
    if (bv) return -1
    if (a === b) return 0
    return direction === 'asc' ? (a < b ? -1 : 1) : (a > b ? -1 : 1)
  }

  list.sort((a, b) => {
    switch (sortBy) {
      case 'price_desc':
        return compareNullable(get.price(a), get.price(b), 'desc')
      case 'date_desc':
        return compareNullable(get.recency(a), get.recency(b), 'desc')
      case 'beds_desc': {
        const byBeds = compareNullable(get.beds(a), get.beds(b), 'desc')
        if (byBeds !== 0) return byBeds
        return compareNullable(get.baths(a), get.baths(b), 'desc')
      }
      case 'sqft_desc':
        return compareNullable(get.sqft(a), get.sqft(b), 'desc')
      case 'price_asc':
      default:
        return compareNullable(get.price(a), get.price(b), 'asc')
    }
  })

  return list
}

function generateFallbackProperties(filters = {}) {
  const mockProperties = [
    {
      id: 'prop_ca_1',
      address: '123 Bay Street',
      city: 'San Francisco',
      state: 'CA',
      zipcode: '94121',
      price: 750000,
      bedrooms: 3,
      bathrooms: 2,
      square_feet: 1800,
      property_type: 'Single Family',
      listing_status: 'for_sale',
      description: 'Charming single-family home near Golden Gate Park.',
      images: [],
      listing_date: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      days_on_market: 10,
      mls_number: 'MLS999001',
      lot_size: '0.08',
      year_built: 1990,
      garage: 1,
      pool: false,
      fireplace: true
    },
    {
      id: 'mock_1',
      address: '123 Main Street',
      city: 'Dallas',
      state: 'TX',
      zipcode: '75201',
      price: 450000,
      bedrooms: 3,
      bathrooms: 2.5,
      square_feet: 2200,
      property_type: 'Single Family',
      listing_status: 'for_sale',
      description: 'Beautiful family home in prime location with modern amenities.',
      images: [],
      listing_date: new Date().toISOString(),
      days_on_market: 15,
      mls_number: 'MLS123456',
      lot_size: '0.25 acres',
      year_built: 2018,
      garage: 2,
      pool: false,
      fireplace: true
    },
    {
      id: 'mock_2',
      address: '456 Oak Avenue',
      city: 'Frisco',
      state: 'TX',
      zipcode: '75034',
      price: 520000,
      bedrooms: 4,
      bathrooms: 3,
      square_feet: 2800,
      property_type: 'Single Family',
      listing_status: 'for_sale',
      description: 'Spacious home with large backyard and updated kitchen.',
      images: [],
      listing_date: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      days_on_market: 7,
      mls_number: 'MLS789012',
      lot_size: '0.33 acres',
      year_built: 2020,
      garage: 3,
      pool: true,
      fireplace: true
    },
    {
      id: 'mock_3',
      address: '789 Pine Street',
      city: 'Austin',
      state: 'TX',
      zipcode: '78701',
      price: 380000,
      bedrooms: 2,
      bathrooms: 2,
      square_feet: 1600,
      property_type: 'Condo',
      listing_status: 'for_sale',
      description: 'Modern downtown condo with city views and walkable amenities.',
      images: [],
      listing_date: new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString(),
      days_on_market: 21,
      mls_number: 'MLS345678',
      lot_size: 'N/A',
      year_built: 2019,
      garage: 1,
      pool: false,
      fireplace: false
    }
  ]

  // Filter mock properties based on criteria
  let filteredProperties = mockProperties

  if (filters.min_price) {
    filteredProperties = filteredProperties.filter(p => p.price >= parseInt(filters.min_price))
  }
  if (filters.max_price) {
    filteredProperties = filteredProperties.filter(p => p.price <= parseInt(filters.max_price))
  }
  if (filters.beds) {
    filteredProperties = filteredProperties.filter(p => p.bedrooms >= parseInt(filters.beds))
  }
  if (filters.baths) {
    filteredProperties = filteredProperties.filter(p => p.bathrooms >= parseInt(filters.baths))
  }
  if (filters.location) {
    // Normalize location search
    const loc = filters.location.toLowerCase()
    // Map of US states full name -> abbreviation
    const stateMap = {
      'alabama':'al','alaska':'ak','arizona':'az','arkansas':'ar',
      'california':'ca','colorado':'co','connecticut':'ct','delaware':'de','district of columbia':'dc',
      'florida':'fl','georgia':'ga','hawaii':'hi','idaho':'id','illinois':'il','indiana':'in','iowa':'ia','kansas':'ks','kentucky':'ky','louisiana':'la','maine':'me','maryland':'md','massachusetts':'ma','michigan':'mi','minnesota':'mn','mississippi':'ms','missouri':'mo','montana':'mt','nebraska':'ne','nevada':'nv','new hampshire':'nh','new jersey':'nj','new mexico':'nm','new york':'ny','north carolina':'nc','north dakota':'nd','ohio':'oh','oklahoma':'ok','oregon':'or','pennsylvania':'pa','rhode island':'ri','south carolina':'sc','south dakota':'sd','tennessee':'tn','texas':'tx','utah':'ut','vermont':'vt','virginia':'va','washington':'wa','west virginia':'wv','wisconsin':'wi','wyoming':'wy'
    }
    const locAbbr = stateMap[loc] || loc

    const location = filters.location.toLowerCase()
    filteredProperties = filteredProperties.filter(p => 
      p.city.toLowerCase().includes(location) || 
      p.zipcode.includes(location) ||
      p.state.toLowerCase().includes(location)
    )
  }
  if (filters.property_type) {
    filteredProperties = filteredProperties.filter(p => matchesPropertyTypeSelection(p, filters.property_type))
  }

  const sorted = sortPropertiesBySelection(filteredProperties, filters.sort_by)
  const offset = Math.max(0, Number(filters.offset) || 0)
  const limit = Math.max(1, Number(filters.limit) || sorted.length || 1)
  const paged = sorted.slice(offset, offset + limit)

  return {
    properties: paged,
    total: sorted.length,
    has_more: offset + paged.length < sorted.length,
    filters_applied: filters,
    is_fallback: true
  }
}

// Helper function to handle CORS
function handleCORS(response) {
  response.headers.set('Access-Control-Allow-Origin', '*')
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  response.headers.set('Access-Control-Allow-Credentials', 'true')
  return response
}

function getGoogleOAuthConfig() {
  return {
    clientId: String(process.env.GOOGLE_CLIENT_ID || process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || '').trim(),
    clientSecret: String(process.env.GOOGLE_CLIENT_SECRET || '').trim(),
    redirectUri: String(
      process.env.GOOGLE_REDIRECT_URI ||
      process.env.NEXT_PUBLIC_GOOGLE_REDIRECT_URI ||
      'http://localhost:3000/api/google/callback'
    ).trim(),
    calendarId: String(process.env.GOOGLE_CALENDAR_ID || 'primary').trim() || 'primary',
    stateSecret: String(
      process.env.GOOGLE_OAUTH_STATE_SECRET ||
      process.env.NEXTAUTH_SECRET ||
      process.env.GOOGLE_CLIENT_SECRET ||
      ''
    ).trim()
  }
}

function isGoogleOAuthConfigured(config = getGoogleOAuthConfig()) {
  return Boolean(config.clientId && config.clientSecret && config.redirectUri && config.stateSecret)
}

function toBase64Url(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function fromBase64Url(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/')
  const padLength = (4 - (normalized.length % 4)) % 4
  return Buffer.from(normalized + '='.repeat(padLength), 'base64')
}

function safeTimingEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8')
  const b = Buffer.from(String(right || ''), 'utf8')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

function parseBearerToken(headerValue) {
  const raw = String(headerValue || '').trim()
  if (!raw) return ''
  const match = raw.match(/^Bearer\s+(.+)$/i)
  return String(match?.[1] || raw).trim()
}

function parseJwtPayloadUnsafe(token) {
  try {
    const parts = String(token || '').split('.')
    if (parts.length < 2) return null
    const payloadRaw = fromBase64Url(parts[1]).toString('utf8')
    return JSON.parse(payloadRaw)
  } catch {
    return null
  }
}

function isEmailLike(value) {
  const raw = String(value || '').trim()
  if (!raw) return false
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)
}

function normalizeUserKey(value) {
  const raw = String(value || '').trim().toLowerCase()
  return raw || 'anonymous'
}

function getRequestAuthContext(request) {
  const headers = request?.headers && typeof request.headers.get === 'function' ? request.headers : null
  const readHeader = (name) => headers ? (headers.get(name) || '') : ''
  const authHeader = readHeader('authorization') || readHeader('Authorization') || ''
  const token = parseBearerToken(authHeader)
  const claims = token ? parseJwtPayloadUnsafe(token) : null
  const candidateEmail =
    claims?.email ||
    readHeader('x-user-email') ||
    (isEmailLike(claims?.['cognito:username']) ? claims?.['cognito:username'] : '') ||
    (isEmailLike(claims?.username) ? claims?.username : '')
  const email = String(candidateEmail || '').trim().toLowerCase() || null
  const userKey = normalizeUserKey(
    email ||
    claims?.sub ||
    claims?.['cognito:username'] ||
    claims?.username ||
    readHeader('x-user-id') ||
    'anonymous'
  )

  return {
    token,
    claims,
    email,
    userKey,
    isAuthenticated: Boolean(token && claims)
  }
}

const NOTIFICATION_PREFS_DOC_ID = 'default'
const DEFAULT_NOTIFICATION_CHANNELS = {
  in_app: true,
  email: true,
  calendar: false
}
const DEFAULT_NOTIFICATION_TYPES = {
  general: true,
  nudge: true,
  checklist_slip: true,
  stalled_deal: true,
  new_lead: true,
  overdue_tasks: true,
  deal_inactivity: true,
  closing_approaching: true
}

function getEmailNotificationsConfig() {
  return {
    enabled: String(process.env.EMAIL_NOTIFICATIONS_ENABLED || '').trim().toLowerCase() === 'true',
    provider: String(process.env.EMAIL_PROVIDER || 'resend').trim().toLowerCase() || 'resend',
    fromEmail: String(process.env.EMAIL_FROM || '').trim(),
    resendApiKey: String(process.env.RESEND_API_KEY || '').trim(),
    appName: String(process.env.EMAIL_APP_NAME || 'Snaphomz').trim() || 'Snaphomz',
    appUrl: String(process.env.APP_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || '').trim()
  }
}

function toClockMinutes(clock = '00:00') {
  const raw = String(clock || '').trim()
  const match = raw.match(/^([01]?\d|2[0-3]):([0-5]\d)$/)
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}

function isQuietHoursNow(now = new Date(), quietHours = {}) {
  if (!quietHours?.enabled) return false
  const start = toClockMinutes(quietHours.start || '21:00')
  const end = toClockMinutes(quietHours.end || '08:00')
  if (start === null || end === null) return false
  const mins = now.getHours() * 60 + now.getMinutes()
  if (start === end) return false
  if (start < end) return mins >= start && mins < end
  return mins >= start || mins < end
}

function normalizeNotificationPreferences(input = {}, email = '') {
  const raw = isPlainObject(input) ? input : {}
  const channels = isPlainObject(raw.channels) ? raw.channels : {}
  const types = isPlainObject(raw.types) ? raw.types : {}
  const quietHours = isPlainObject(raw.quiet_hours) ? raw.quiet_hours : {}
  return {
    id: NOTIFICATION_PREFS_DOC_ID,
    email: String(raw.email || email || '').trim().toLowerCase() || null,
    channels: {
      ...DEFAULT_NOTIFICATION_CHANNELS,
      ...channels,
      in_app: true
    },
    timing: raw.timing === 'digest' ? 'digest' : 'immediate',
    quiet_hours: {
      enabled: Boolean(quietHours.enabled),
      start: String(quietHours.start || '21:00'),
      end: String(quietHours.end || '08:00')
    },
    types: {
      ...DEFAULT_NOTIFICATION_TYPES,
      ...types
    },
    updated_at: new Date()
  }
}

async function getNotificationPreferences(db, request, { createIfMissing = true, authOverride = null } = {}) {
  const baseAuth = getRequestAuthContext(request)
  const override = isPlainObject(authOverride) ? authOverride : {}
  const fallbackEmailFromUserKey = isEmailLike(override.userKey)
    ? String(override.userKey).trim().toLowerCase()
    : (isEmailLike(baseAuth.userKey) ? String(baseAuth.userKey).trim().toLowerCase() : '')
  const effectiveEmail = String(override.email || baseAuth.email || fallbackEmailFromUserKey || '').trim().toLowerCase() || null
  const effectiveUserKey = normalizeUserKey(override.userKey || effectiveEmail || baseAuth.userKey || 'anonymous')
  const auth = {
    ...baseAuth,
    email: effectiveEmail,
    userKey: effectiveUserKey
  }
  const ownerUserId = normalizeUserKey(auth?.userKey || auth?.email || 'anonymous')
  const coll = db.collection('notification_preferences')
  const ownerQuery = { id: NOTIFICATION_PREFS_DOC_ID, owner_user_id: ownerUserId }
  const existing = await coll.findOne(ownerQuery)
  if (existing) {
    if (!existing?.email && auth?.email) {
      try {
        await coll.updateOne(ownerQuery, { $set: { email: auth.email, updated_at: new Date() } })
      } catch (_) {}
    }
    return {
      auth: { ...auth, userKey: ownerUserId },
      prefs: normalizeNotificationPreferences(existing, auth.email || '')
    }
  }

  const defaults = normalizeNotificationPreferences({}, auth.email || '')
  if (createIfMissing) {
    try {
      await coll.insertOne({ ...defaults, owner_user_id: ownerUserId, created_at: new Date() })
    } catch (_) {}
  }
  return { auth: { ...auth, userKey: ownerUserId }, prefs: defaults }
}

async function upsertNotificationPreferences(db, request, patch = {}) {
  const { auth, prefs: current } = await getNotificationPreferences(db, request, { createIfMissing: true })
  const ownerUserId = normalizeUserKey(auth?.userKey || auth?.email || 'anonymous')
  const merged = normalizeNotificationPreferences({ ...current, ...(isPlainObject(patch) ? patch : {}) }, auth.email || current.email || '')
  const coll = db.collection('notification_preferences')
  const ownerQuery = { id: NOTIFICATION_PREFS_DOC_ID, owner_user_id: ownerUserId }
  const existing = await coll.findOne(ownerQuery)
  if (existing) {
    await coll.updateOne(
      ownerQuery,
      {
        $set: {
          email: merged.email,
          channels: merged.channels,
          timing: merged.timing,
          quiet_hours: merged.quiet_hours,
          types: merged.types,
          updated_at: new Date()
        }
      }
    )
  } else {
    await coll.insertOne({
      ...merged,
      owner_user_id: ownerUserId,
      created_at: new Date()
    })
  }
  return merged
}

async function wasEmailRecentlySent(db, dedupeKey, cooldownMinutes = 60 * 24) {
  if (!dedupeKey) return false
  const coll = db.collection('notification_email_log')
  const existing = await coll.findOne({ dedupe_key: dedupeKey })
  if (!existing) return false
  const sentAt = new Date(existing.last_sent_at || existing.created_at || 0)
  if (Number.isNaN(sentAt.getTime())) return false
  return (Date.now() - sentAt.getTime()) < (Math.max(1, Number(cooldownMinutes) || (60 * 24)) * 60 * 1000)
}

async function markEmailSent(db, dedupeKey, payload = {}) {
  if (!dedupeKey) return
  const coll = db.collection('notification_email_log')
  const existing = await coll.findOne({ dedupe_key: dedupeKey })
  if (existing) {
    await coll.updateOne(
      { id: existing.id },
      {
        $set: {
          ...payload,
          dedupe_key: dedupeKey,
          last_sent_at: new Date(),
          updated_at: new Date()
        }
      }
    )
    return
  }
  await coll.insertOne({
    id: uuidv4(),
    dedupe_key: dedupeKey,
    ...payload,
    last_sent_at: new Date(),
    created_at: new Date(),
    updated_at: new Date()
  })
}

async function sendEmailViaResend(config, { to, subject, text, html }) {
  const apiKey = String(config?.resendApiKey || '').trim()
  const from = String(config?.fromEmail || '').trim()
  if (!apiKey || !from) {
    return { success: false, reason: 'missing_provider_config' }
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        text,
        html
      })
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      return {
        success: false,
        reason: 'provider_error',
        error: String(payload?.message || payload?.error || `HTTP ${response.status}`)
      }
    }
    return { success: true, provider_message_id: payload?.id || null }
  } catch (error) {
    return {
      success: false,
      reason: 'network_error',
      error: String(error?.message || 'Email send failed')
    }
  }
}

async function sendNotificationEmail({
  db,
  request,
  authOverride = null,
  notificationType = 'general',
  priority = 'medium',
  dedupeKey = '',
  subject,
  message,
  html = null,
  cooldownMinutes = 60 * 24,
  metadata = {}
}) {
  const config = getEmailNotificationsConfig()
  if (!config.enabled) return { success: false, reason: 'email_channel_disabled' }

  const { auth, prefs } = await getNotificationPreferences(db, request, { createIfMissing: true, authOverride })
  const channels = prefs?.channels || DEFAULT_NOTIFICATION_CHANNELS
  if (!channels.email) return { success: false, reason: 'email_pref_disabled' }
  const isTypeEnabled = prefs?.types?.[notificationType]
  if (isTypeEnabled === false) return { success: false, reason: 'type_pref_disabled' }
  if (prefs?.timing === 'digest') return { success: false, reason: 'digest_mode' }

  const normalizedPriority = String(priority || 'medium').toLowerCase()
  const bypassQuietHours = normalizedPriority === 'urgent' || normalizedPriority === 'high'
  if (!bypassQuietHours && isQuietHoursNow(new Date(), prefs?.quiet_hours || {})) {
    return { success: false, reason: 'quiet_hours' }
  }

  const recipient = String(
    prefs?.email ||
    auth?.email ||
    (isEmailLike(auth?.userKey) ? auth.userKey : '') ||
    ''
  ).trim().toLowerCase()
  if (!recipient) return { success: false, reason: 'missing_recipient_email' }

  if (dedupeKey && await wasEmailRecentlySent(db, dedupeKey, cooldownMinutes)) {
    return { success: false, reason: 'duplicate_suppressed' }
  }

  const safeSubject = String(subject || '').trim() || `[${config.appName}] Notification`
  const safeMessage = String(message || '').trim() || 'You have a new update in CRM.'
  const appUrl = config.appUrl || ''
  const textBody = appUrl ? `${safeMessage}\n\nOpen CRM: ${appUrl}` : safeMessage
  const htmlBody = html || `<p>${safeMessage}</p>${appUrl ? `<p><a href="${appUrl}">Open CRM</a></p>` : ''}`

  const sendResult = config.provider === 'resend'
    ? await sendEmailViaResend(config, { to: recipient, subject: safeSubject, text: textBody, html: htmlBody })
    : { success: false, reason: 'unsupported_provider' }

  if (!sendResult.success) return sendResult

  if (dedupeKey) {
    await markEmailSent(db, dedupeKey, {
      notification_type: notificationType,
      recipient,
      priority: normalizedPriority,
      provider: config.provider,
      provider_message_id: sendResult.provider_message_id || null,
      metadata
    })
  }
  return { success: true, recipient }
}

async function sendNotificationRecordEmail(db, request, notification = {}, options = {}) {
  const notif = notification || {}
  const type = String(notif.type || 'general')
  const title = String(notif.title || 'CRM Notification').trim()
  const body = String(notif.message || '').trim() || 'You have a new CRM update.'
  const dedupeKey = `notification:${type}:${String(notif.id || '').trim() || body.toLowerCase().slice(0, 120)}`
  return sendNotificationEmail({
    db,
    request,
    authOverride: options?.authOverride || null,
    notificationType: type,
    priority: String(notif?.meta?.priority || 'medium'),
    dedupeKey,
    subject: `[Snaphomz] ${title}`,
    message: body,
    metadata: {
      notification_id: notif.id || null,
      kind: type
    }
  })
}

async function sendSmartAlertEmail(db, request, alert = {}, options = {}) {
  const type = String(alert?.alert_type || 'general')
  const title = String(alert?.title || 'Smart Alert').trim()
  const message = String(alert?.message || '').trim() || 'You have a smart alert in CRM.'
  const dedupeWindow = new Date().toISOString().slice(0, 10)
  const dedupeKey = `smart_alert:${String(alert?.id || '')}:${dedupeWindow}`
  return sendNotificationEmail({
    db,
    request,
    authOverride: options?.authOverride || null,
    notificationType: type,
    priority: String(alert?.priority || 'medium'),
    dedupeKey,
    subject: `[Snaphomz] ${title}`,
    message,
    metadata: {
      alert_id: alert?.id || null,
      transaction_id: alert?.transaction_id || null,
      alert_type: type
    }
  })
}

function sanitizeReturnPath(returnTo = '/') {
  const raw = String(returnTo || '/').trim()
  if (!raw.startsWith('/')) return '/'
  if (raw.startsWith('//')) return '/'
  return raw
}

function buildReturnPathWithParams(returnPath = '/', params = {}) {
  const safePath = sanitizeReturnPath(returnPath)
  const url = new URL(safePath, 'http://localhost')
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue
    url.searchParams.set(key, String(value))
  }
  return `${url.pathname}${url.search}${url.hash}`
}

function createGoogleOAuthState({ userKey, returnTo = '/', config = getGoogleOAuthConfig() }) {
  const payload = {
    user_key: normalizeUserKey(userKey),
    return_to: sanitizeReturnPath(returnTo),
    ts: Date.now(),
    nonce: uuidv4()
  }
  const encodedPayload = toBase64Url(JSON.stringify(payload))
  const signature = toBase64Url(crypto.createHmac('sha256', config.stateSecret).update(encodedPayload).digest())
  return `${encodedPayload}.${signature}`
}

function verifyGoogleOAuthState(state, config = getGoogleOAuthConfig()) {
  try {
    const [encodedPayload, signature] = String(state || '').split('.')
    if (!encodedPayload || !signature) return null
    const expected = toBase64Url(crypto.createHmac('sha256', config.stateSecret).update(encodedPayload).digest())
    if (!safeTimingEqual(signature, expected)) return null

    const payload = JSON.parse(fromBase64Url(encodedPayload).toString('utf8'))
    const createdAt = Number(payload?.ts || 0)
    if (!Number.isFinite(createdAt)) return null
    if (Math.abs(Date.now() - createdAt) > GOOGLE_STATE_TTL_MS) return null

    return {
      userKey: normalizeUserKey(payload?.user_key),
      returnTo: sanitizeReturnPath(payload?.return_to || '/')
    }
  } catch {
    return null
  }
}

function parseDateToEpochMillis(value) {
  if (!value) return null
  if (value instanceof Date) {
    const epoch = value.getTime()
    return Number.isFinite(epoch) ? epoch : null
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : null
}

function toDateOnlyString(value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return null
  const y = parsed.getUTCFullYear()
  const m = String(parsed.getUTCMonth() + 1).padStart(2, '0')
  const d = String(parsed.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function addDaysToDateOnly(dateOnly, days = 1) {
  const base = new Date(`${dateOnly}T00:00:00.000Z`)
  if (Number.isNaN(base.getTime())) return null
  base.setUTCDate(base.getUTCDate() + Number(days || 0))
  const y = base.getUTCFullYear()
  const m = String(base.getUTCMonth() + 1).padStart(2, '0')
  const d = String(base.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function buildTransactionCalendarSummary(transaction) {
  const type = String(transaction?.transaction_type || 'sale').toLowerCase()
  const typeLabel = type === 'purchase' ? 'Purchase' : type === 'lease' ? 'Lease' : 'Sale'
  return `${typeLabel} closing - ${transaction?.property_address || 'Real Estate Transaction'}`
}

function buildTransactionCalendarDetails(transaction) {
  return [
    `Client: ${transaction?.client_name || 'Unknown'}`,
    transaction?.client_email ? `Email: ${transaction.client_email}` : null,
    transaction?.client_phone ? `Phone: ${transaction.client_phone}` : null,
    transaction?.assigned_agent ? `Assigned Agent: ${transaction.assigned_agent}` : null,
    transaction?.listing_price ? `Listing Price: $${Number(transaction.listing_price).toLocaleString('en-US')}` : null,
    '',
    `Transaction ID: ${transaction?.id || ''}`
  ].filter(Boolean).join('\n')
}

function buildTransactionCalendarEvent(transaction, closingDate) {
  const summary = buildTransactionCalendarSummary(transaction)
  const endDate = addDaysToDateOnly(closingDate, 1)
  const details = buildTransactionCalendarDetails(transaction)
  return {
    summary,
    description: details,
    location: transaction?.property_address || undefined,
    start: { date: closingDate },
    end: { date: endDate || closingDate },
    reminders: { useDefault: true }
  }
}

function buildGoogleCalendarTemplateUrl(transaction, closingDate) {
  const dateOnly = toDateOnlyString(closingDate)
  if (!dateOnly) return null

  const endDateOnly = addDaysToDateOnly(dateOnly, 1) || dateOnly
  const start = dateOnly.replace(/-/g, '')
  const end = endDateOnly.replace(/-/g, '')
  if (!start || !end) return null

  const params = new URLSearchParams()
  params.set('action', 'TEMPLATE')
  params.set('text', buildTransactionCalendarSummary(transaction))
  params.set('dates', `${start}/${end}`)

  const details = buildTransactionCalendarDetails(transaction)
  if (details) params.set('details', details)

  const location = String(transaction?.property_address || '').trim()
  if (location) params.set('location', location)

  return `https://calendar.google.com/calendar/render?${params.toString()}`
}

function buildOutlookCalendarComposeUrl(transaction, closingDate) {
  const dateOnly = toDateOnlyString(closingDate)
  if (!dateOnly) return null

  const endDateOnly = addDaysToDateOnly(dateOnly, 1) || dateOnly
  const params = new URLSearchParams()
  params.set('path', '/calendar/action/compose')
  params.set('rru', 'addevent')
  params.set('subject', buildTransactionCalendarSummary(transaction))
  params.set('startdt', dateOnly)
  params.set('enddt', endDateOnly)
  params.set('allday', 'true')

  const details = buildTransactionCalendarDetails(transaction)
  if (details) params.set('body', details)

  const location = String(transaction?.property_address || '').trim()
  if (location) params.set('location', location)

  return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`
}

function googleApiErrorMessage(payload, fallback = 'Google API request failed') {
  if (!payload) return fallback
  if (typeof payload === 'string') return payload || fallback
  if (payload?.error?.message) return String(payload.error.message)
  if (payload?.error_description) return String(payload.error_description)
  if (payload?.error) return String(payload.error)
  return fallback
}

async function findGoogleCalendarConnection(db, userKey) {
  const key = normalizeUserKey(userKey)
  return db.collection(GOOGLE_CALENDAR_CONNECTIONS_COLLECTION).findOne({ user_key: key })
}

async function upsertGoogleCalendarConnection(db, userKey, updates = {}) {
  const key = normalizeUserKey(userKey)
  const coll = db.collection(GOOGLE_CALENDAR_CONNECTIONS_COLLECTION)
  const existing = await coll.findOne({ user_key: key })
  const now = new Date()

  if (existing) {
    const next = {
      ...existing,
      ...updates,
      user_key: key,
      updated_at: now
    }
    await coll.updateOne({ id: existing.id }, { $set: next })
    return next
  }

  const created = {
    id: uuidv4(),
    user_key: key,
    created_at: now,
    updated_at: now,
    ...updates
  }
  await coll.insertOne(created)
  return created
}

async function deleteGoogleCalendarConnection(db, userKey) {
  const key = normalizeUserKey(userKey)
  return db.collection(GOOGLE_CALENDAR_CONNECTIONS_COLLECTION).deleteOne({ user_key: key })
}

function getGoogleConnectionPublicStatus(connection, config) {
  return {
    configured: isGoogleOAuthConfigured(config),
    connected: Boolean(connection),
    connected_email: connection?.connected_email || null,
    calendar_id: connection?.calendar_id || config.calendarId || 'primary',
    expires_at: connection?.expires_at || null,
    has_refresh_token: Boolean(connection?.refresh_token)
  }
}

async function exchangeGoogleCodeForTokens({ code, config }) {
  const params = new URLSearchParams()
  params.set('code', String(code || ''))
  params.set('client_id', config.clientId)
  params.set('client_secret', config.clientSecret)
  params.set('redirect_uri', config.redirectUri)
  params.set('grant_type', 'authorization_code')

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(googleApiErrorMessage(payload, `Google token exchange failed (${response.status})`))
  }
  return payload
}

async function refreshGoogleAccessToken({ refreshToken, config }) {
  const params = new URLSearchParams()
  params.set('refresh_token', String(refreshToken || ''))
  params.set('client_id', config.clientId)
  params.set('client_secret', config.clientSecret)
  params.set('grant_type', 'refresh_token')

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(googleApiErrorMessage(payload, `Google refresh failed (${response.status})`))
  }
  return payload
}

async function fetchGoogleUserProfile(accessToken) {
  if (!accessToken) return null
  const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  if (!response.ok) return null
  return response.json().catch(() => null)
}

async function createGoogleCalendarEvent({ accessToken, calendarId = 'primary', event }) {
  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(event)
  })

  const payload = await response.json().catch(() => null)
  return {
    ok: response.ok,
    status: response.status,
    payload
  }
}

async function ensureGoogleAccessToken({ db, connection, config }) {
  if (!connection) return { success: false, error: 'Google Calendar is not connected' }
  let current = connection
  let accessToken = String(current.access_token || '').trim()
  const expiresAt = parseDateToEpochMillis(current.expires_at)
  const expiresSoon = expiresAt !== null && expiresAt <= Date.now() + 60 * 1000

  if ((!accessToken || expiresSoon) && current.refresh_token) {
    const refreshed = await refreshGoogleAccessToken({ refreshToken: current.refresh_token, config })
    current = await upsertGoogleCalendarConnection(db, current.user_key, {
      access_token: refreshed.access_token || accessToken,
      refresh_token: current.refresh_token,
      token_type: refreshed.token_type || current.token_type || 'Bearer',
      scope: refreshed.scope || current.scope || GOOGLE_OAUTH_SCOPES.join(' '),
      expires_at: refreshed.expires_in
        ? new Date(Date.now() + Math.max(0, Number(refreshed.expires_in) - 30) * 1000).toISOString()
        : current.expires_at,
      connected_email: current.connected_email || null,
      calendar_id: current.calendar_id || config.calendarId
    })
    accessToken = String(current.access_token || '').trim()
  }

  if (!accessToken) {
    return { success: false, error: 'Missing Google access token' }
  }

  return { success: true, accessToken, connection: current }
}

async function syncTransactionClosingDateToGoogleCalendar({ db, request, transaction }) {
  const closingDate = toDateOnlyString(transaction?.closing_date)
  const quickAddUrl = buildGoogleCalendarTemplateUrl(transaction, closingDate)
  if (!closingDate) {
    return {
      attempted: false,
      connected: false,
      success: false,
      reason: 'closing_date_missing',
      quick_add_url: null
    }
  }

  const config = getGoogleOAuthConfig()
  if (!isGoogleOAuthConfigured(config)) {
    return {
      attempted: false,
      connected: false,
      success: false,
      reason: 'google_oauth_not_configured',
      quick_add_url: quickAddUrl
    }
  }

  const auth = getRequestAuthContext(request)
  const connection = await findGoogleCalendarConnection(db, auth.userKey)
  if (!connection) {
    return {
      attempted: false,
      connected: false,
      success: false,
      reason: 'google_not_connected',
      quick_add_url: quickAddUrl
    }
  }

  const ensured = await ensureGoogleAccessToken({ db, connection, config })
  if (!ensured.success) {
    return {
      attempted: true,
      connected: true,
      success: false,
      reason: 'google_token_unavailable',
      error: ensured.error,
      quick_add_url: quickAddUrl
    }
  }

  const eventPayload = buildTransactionCalendarEvent(transaction, closingDate)
  let insertion = await createGoogleCalendarEvent({
    accessToken: ensured.accessToken,
    calendarId: ensured.connection?.calendar_id || config.calendarId,
    event: eventPayload
  })

  if (!insertion.ok && insertion.status === 401 && ensured.connection?.refresh_token) {
    const refreshed = await refreshGoogleAccessToken({ refreshToken: ensured.connection.refresh_token, config })
    const refreshedConnection = await upsertGoogleCalendarConnection(db, ensured.connection.user_key, {
      access_token: refreshed.access_token || ensured.accessToken,
      refresh_token: ensured.connection.refresh_token,
      token_type: refreshed.token_type || ensured.connection.token_type || 'Bearer',
      scope: refreshed.scope || ensured.connection.scope || GOOGLE_OAUTH_SCOPES.join(' '),
      expires_at: refreshed.expires_in
        ? new Date(Date.now() + Math.max(0, Number(refreshed.expires_in) - 30) * 1000).toISOString()
        : ensured.connection.expires_at,
      connected_email: ensured.connection.connected_email || null,
      calendar_id: ensured.connection.calendar_id || config.calendarId
    })
    insertion = await createGoogleCalendarEvent({
      accessToken: refreshedConnection.access_token,
      calendarId: refreshedConnection.calendar_id || config.calendarId,
      event: eventPayload
    })
  }

  if (!insertion.ok) {
    return {
      attempted: true,
      connected: true,
      success: false,
      reason: 'google_event_create_failed',
      error: googleApiErrorMessage(insertion.payload, `Google Calendar insert failed (${insertion.status})`),
      quick_add_url: quickAddUrl
    }
  }

  const createdEvent = insertion.payload || {}
  const syncFields = {
    google_calendar_event_id: createdEvent.id || null,
    google_calendar_event_link: createdEvent.htmlLink || null,
    google_calendar_synced_at: new Date(),
    updated_at: new Date()
  }

  await db.collection('transactions').updateOne({ id: transaction.id }, { $set: syncFields })

  return {
    attempted: true,
    connected: true,
    success: true,
    event_id: createdEvent.id || null,
    event_link: createdEvent.htmlLink || null,
    calendar_id: ensured.connection?.calendar_id || config.calendarId,
    quick_add_url: null
  }
}

function getCalendarOAuthStateSecret() {
  return String(
    process.env.CALENDAR_OAUTH_STATE_SECRET ||
    process.env.GOOGLE_OAUTH_STATE_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    process.env.MICROSOFT_CLIENT_SECRET ||
    process.env.GOOGLE_CLIENT_SECRET ||
    ''
  ).trim()
}

function getOutlookOAuthConfig() {
  const tenant = String(process.env.MICROSOFT_TENANT || 'common').trim() || 'common'
  return {
    clientId: String(process.env.MICROSOFT_CLIENT_ID || '').trim(),
    clientSecret: String(process.env.MICROSOFT_CLIENT_SECRET || '').trim(),
    tenant,
    redirectUri: String(
      process.env.MICROSOFT_REDIRECT_URI ||
      process.env.REDIRECT_URI ||
      'http://localhost:3000/api/calendar/outlook/callback'
    ).trim(),
    stateSecret: getCalendarOAuthStateSecret(),
    authorizationUrl: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize`,
    tokenUrl: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`
  }
}

function isOutlookOAuthConfigured(config = getOutlookOAuthConfig()) {
  return Boolean(config.clientId && config.clientSecret && config.redirectUri && config.stateSecret)
}

function getCalendarTokenEncryptionSecret() {
  return String(
    process.env.CALENDAR_TOKEN_ENCRYPTION_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    process.env.CALENDAR_OAUTH_STATE_SECRET ||
    process.env.MICROSOFT_CLIENT_SECRET ||
    process.env.GOOGLE_CLIENT_SECRET ||
    ''
  ).trim()
}

function getCalendarTokenEncryptionKey(secret = getCalendarTokenEncryptionSecret()) {
  if (!secret) return null
  return crypto.createHash('sha256').update(secret).digest()
}

function encryptCalendarToken(value, secret = getCalendarTokenEncryptionSecret()) {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (raw.startsWith(`${CALENDAR_TOKEN_ENCRYPTION_PREFIX}:`)) return raw
  const key = getCalendarTokenEncryptionKey(secret)
  if (!key) return raw
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(raw, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${CALENDAR_TOKEN_ENCRYPTION_PREFIX}:${toBase64Url(iv)}:${toBase64Url(tag)}:${toBase64Url(encrypted)}`
}

function decryptCalendarToken(value, secret = getCalendarTokenEncryptionSecret()) {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (!raw.startsWith(`${CALENDAR_TOKEN_ENCRYPTION_PREFIX}:`)) return raw
  const key = getCalendarTokenEncryptionKey(secret)
  if (!key) return null
  const [, ivPart, tagPart, dataPart] = raw.split(':')
  if (!ivPart || !tagPart || !dataPart) return null
  try {
    const iv = fromBase64Url(ivPart)
    const tag = fromBase64Url(tagPart)
    const encrypted = fromBase64Url(dataPart)
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])
    return decrypted.toString('utf8')
  } catch {
    return null
  }
}

function normalizeCalendarProvider(provider) {
  const normalized = String(provider || '').trim().toLowerCase()
  return CALENDAR_PROVIDER_IDS.includes(normalized) ? normalized : null
}

function providerDisplayName(provider) {
  if (provider === CALENDAR_PROVIDER_GOOGLE) return 'Google Calendar'
  if (provider === CALENDAR_PROVIDER_OUTLOOK) return 'Outlook Calendar'
  return 'Calendar'
}

function computeExpiryIso(expiresInSeconds, fallback = null) {
  const parsed = Number(expiresInSeconds || 0)
  if (Number.isFinite(parsed) && parsed > 0) {
    return new Date(Date.now() + Math.max(0, parsed - 30) * 1000).toISOString()
  }
  return fallback || null
}

function createCalendarOAuthState({ userKey, provider, returnTo = '/' }) {
  const normalizedProvider = normalizeCalendarProvider(provider)
  const stateSecret = getCalendarOAuthStateSecret()
  if (!normalizedProvider || !stateSecret) return null
  const payload = {
    user_key: normalizeUserKey(userKey),
    provider: normalizedProvider,
    return_to: sanitizeReturnPath(returnTo),
    ts: Date.now(),
    nonce: uuidv4()
  }
  const encodedPayload = toBase64Url(JSON.stringify(payload))
  const signature = toBase64Url(crypto.createHmac('sha256', stateSecret).update(encodedPayload).digest())
  return `${encodedPayload}.${signature}`
}

function verifyCalendarOAuthState(state, providerHint = null) {
  const stateSecret = getCalendarOAuthStateSecret()
  if (!stateSecret) return null
  try {
    const [encodedPayload, signature] = String(state || '').split('.')
    if (!encodedPayload || !signature) return null
    const expected = toBase64Url(crypto.createHmac('sha256', stateSecret).update(encodedPayload).digest())
    if (!safeTimingEqual(signature, expected)) return null

    const payload = JSON.parse(fromBase64Url(encodedPayload).toString('utf8'))
    const createdAt = Number(payload?.ts || 0)
    if (!Number.isFinite(createdAt)) return null
    if (Math.abs(Date.now() - createdAt) > CALENDAR_STATE_TTL_MS) return null
    const provider = normalizeCalendarProvider(payload?.provider)
    if (!provider) return null
    if (providerHint && provider !== normalizeCalendarProvider(providerHint)) return null

    return {
      userKey: normalizeUserKey(payload?.user_key),
      provider,
      returnTo: sanitizeReturnPath(payload?.return_to || '/')
    }
  } catch {
    return null
  }
}

function hydrateCalendarConnection(stored = null) {
  if (!stored) return null
  const hydrated = { ...stored }
  hydrated.access_token = decryptCalendarToken(stored.access_token) || null
  hydrated.refresh_token = decryptCalendarToken(stored.refresh_token) || null
  return hydrated
}

function toStoredCalendarConnection(connection = {}) {
  const stored = { ...connection }
  if (Object.prototype.hasOwnProperty.call(stored, 'access_token')) {
    stored.access_token = encryptCalendarToken(stored.access_token)
  }
  if (Object.prototype.hasOwnProperty.call(stored, 'refresh_token')) {
    stored.refresh_token = encryptCalendarToken(stored.refresh_token)
  }
  return stored
}

async function migrateLegacyGoogleConnectionIfNeeded(db, userKey) {
  const legacy = await findGoogleCalendarConnection(db, userKey)
  if (!legacy) return null
  const migrated = await upsertCalendarConnection(db, userKey, CALENDAR_PROVIDER_GOOGLE, {
    connected_email: legacy.connected_email || null,
    access_token: legacy.access_token || null,
    refresh_token: legacy.refresh_token || null,
    token_type: legacy.token_type || 'Bearer',
    scope: legacy.scope || GOOGLE_OAUTH_SCOPES.join(' '),
    expires_at: legacy.expires_at || null,
    calendar_id: legacy.calendar_id || getGoogleOAuthConfig().calendarId
  })
  return migrated
}

function isCalendarSqlStorageEnabled() {
  return dbMode === 'postgres' && Boolean(pgPool)
}

function parseDbJson(value, fallback) {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      return fallback
    }
  }
  return value
}

function normalizeDbCalendarEventRow(eventRow = null, mappingRow = null) {
  if (!eventRow) return null
  const attendees = parseDbJson(eventRow.attendees, [])
  return {
    id: String(eventRow.id),
    title: eventRow.title,
    start_time: eventRow.start_time ? new Date(eventRow.start_time).toISOString() : null,
    end_time: eventRow.end_time ? new Date(eventRow.end_time).toISOString() : null,
    user_id: String(eventRow.user_id || ''),
    description: eventRow.description || null,
    location: eventRow.location || null,
    attendees: Array.isArray(attendees) ? attendees : [],
    source_type: eventRow.source_type || null,
    source_id: eventRow.source_id || null,
    transaction_id: eventRow.transaction_id || null,
    sync_status: eventRow.sync_status || 'pending',
    sync_error: eventRow.sync_error || null,
    synced_at: eventRow.synced_at ? new Date(eventRow.synced_at).toISOString() : null,
    status: eventRow.status || 'active',
    deleted_at: eventRow.deleted_at ? new Date(eventRow.deleted_at).toISOString() : null,
    created_at: eventRow.created_at || null,
    updated_at: eventRow.updated_at || null,
    provider: mappingRow?.provider || null,
    external_event_id: mappingRow?.external_event_id || null,
    external_event_link: mappingRow?.external_event_link || null
  }
}

async function getPrimaryEventProviderMapping(eventId) {
  if (!isCalendarSqlStorageEnabled()) return null
  const { rows } = await pgPool.query(
    `
      SELECT
        m.id,
        m.event_id,
        m.connection_id,
        m.external_event_id,
        m.external_event_link,
        m.sync_status,
        m.sync_error,
        m.last_synced_at,
        m.created_at,
        m.updated_at,
        c.provider,
        c.user_id
      FROM event_provider_mapping m
      JOIN calendar_connections c ON c.id = m.connection_id
      WHERE m.event_id = $1
      ORDER BY m.updated_at DESC, m.created_at DESC
      LIMIT 1
    `,
    [String(eventId)]
  )
  return rows?.[0] || null
}

async function upsertEventProviderMappingForUserProvider({
  userId,
  provider,
  eventId,
  externalEventId,
  externalEventLink = null,
  syncStatus = 'synced',
  syncError = null,
  lastSyncedAt = null
}) {
  if (!isCalendarSqlStorageEnabled()) return null
  const normalizedProvider = normalizeCalendarProvider(provider)
  if (!normalizedProvider || !eventId) return null

  const { rows: connectionRows } = await pgPool.query(
    `
      SELECT id
      FROM calendar_connections
      WHERE user_id = $1 AND provider = $2
      LIMIT 1
    `,
    [normalizeUserKey(userId), normalizedProvider]
  )
  const connectionId = connectionRows?.[0]?.id
  if (!connectionId) return null

  const trimmedExternalId = String(externalEventId || '').trim() || null
  if (!trimmedExternalId) return null

  const { rows } = await pgPool.query(
    `
      INSERT INTO event_provider_mapping (
        id,
        event_id,
        connection_id,
        external_event_id,
        external_event_link,
        sync_status,
        sync_error,
        last_synced_at,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
      ON CONFLICT (event_id, connection_id)
      DO UPDATE SET
        external_event_id = EXCLUDED.external_event_id,
        external_event_link = EXCLUDED.external_event_link,
        sync_status = EXCLUDED.sync_status,
        sync_error = EXCLUDED.sync_error,
        last_synced_at = EXCLUDED.last_synced_at,
        updated_at = NOW()
      RETURNING *
    `,
    [
      uuidv4(),
      String(eventId),
      String(connectionId),
      trimmedExternalId,
      externalEventLink || null,
      syncStatus || 'synced',
      syncError || null,
      lastSyncedAt ? new Date(lastSyncedAt) : null
    ]
  )

  const mapping = rows?.[0] || null
  if (!mapping) return null
  return { ...mapping, provider: normalizedProvider, user_id: normalizeUserKey(userId) }
}

async function findCalendarEventDocInSql(userId, eventId) {
  if (!isCalendarSqlStorageEnabled()) return null
  const { rows } = await pgPool.query(
    `
      SELECT *
      FROM calendar_events
      WHERE id = $1 AND user_id = $2
      LIMIT 1
    `,
    [String(eventId), normalizeUserKey(userId)]
  )
  const eventRow = rows?.[0] || null
  if (!eventRow) return null
  const mappingRow = await getPrimaryEventProviderMapping(eventRow.id)
  return normalizeDbCalendarEventRow(eventRow, mappingRow)
}

async function insertCalendarEventDocInSql(eventDoc = {}) {
  if (!isCalendarSqlStorageEnabled()) return eventDoc
  const row = {
    id: String(eventDoc.id || uuidv4()),
    user_id: normalizeUserKey(eventDoc.user_id),
    title: String(eventDoc.title || '').trim(),
    start_time: toIsoDateTime(eventDoc.start_time),
    end_time: toIsoDateTime(eventDoc.end_time),
    description: eventDoc.description || null,
    location: eventDoc.location || null,
    attendees: Array.isArray(eventDoc.attendees) ? eventDoc.attendees : [],
    source_type: eventDoc.source_type || null,
    source_id: eventDoc.source_id ? String(eventDoc.source_id) : null,
    transaction_id: eventDoc.transaction_id ? String(eventDoc.transaction_id) : null,
    sync_status: eventDoc.sync_status || 'pending',
    sync_error: eventDoc.sync_error || null,
    synced_at: eventDoc.synced_at ? new Date(eventDoc.synced_at) : null,
    status: eventDoc.status || 'active',
    deleted_at: eventDoc.deleted_at ? new Date(eventDoc.deleted_at) : null
  }

  const { rows } = await pgPool.query(
    `
      INSERT INTO calendar_events (
        id,
        user_id,
        title,
        start_time,
        end_time,
        description,
        location,
        attendees,
        source_type,
        source_id,
        transaction_id,
        sync_status,
        sync_error,
        synced_at,
        status,
        deleted_at,
        created_at,
        updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15, $16, NOW(), NOW()
      )
      RETURNING *
    `,
    [
      row.id,
      row.user_id,
      row.title,
      row.start_time,
      row.end_time,
      row.description,
      row.location,
      JSON.stringify(row.attendees),
      row.source_type,
      row.source_id,
      row.transaction_id,
      row.sync_status,
      row.sync_error,
      row.synced_at,
      row.status,
      row.deleted_at
    ]
  )

  const inserted = rows?.[0] || null
  if (!inserted) return null

  if (eventDoc.provider && eventDoc.external_event_id) {
    await upsertEventProviderMappingForUserProvider({
      userId: row.user_id,
      provider: eventDoc.provider,
      eventId: inserted.id,
      externalEventId: eventDoc.external_event_id,
      externalEventLink: eventDoc.external_event_link || null,
      syncStatus: row.sync_status,
      syncError: row.sync_error,
      lastSyncedAt: row.synced_at
    })
  }

  return findCalendarEventDocInSql(row.user_id, inserted.id)
}

async function updateCalendarEventDocInSql(eventId, patch = {}) {
  if (!isCalendarSqlStorageEnabled()) return null
  const { rows: existingRows } = await pgPool.query(
    `SELECT * FROM calendar_events WHERE id = $1 LIMIT 1`,
    [String(eventId)]
  )
  const existing = existingRows?.[0] || null
  if (!existing) return null

  const setFragments = []
  const values = [String(eventId)]
  const assign = (column, value) => {
    values.push(value)
    setFragments.push(`${column} = $${values.length}`)
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'title')) assign('title', String(patch.title || '').trim() || existing.title)
  if (Object.prototype.hasOwnProperty.call(patch, 'start_time')) assign('start_time', toIsoDateTime(patch.start_time) || existing.start_time)
  if (Object.prototype.hasOwnProperty.call(patch, 'end_time')) assign('end_time', toIsoDateTime(patch.end_time) || existing.end_time)
  if (Object.prototype.hasOwnProperty.call(patch, 'description')) assign('description', patch.description || null)
  if (Object.prototype.hasOwnProperty.call(patch, 'location')) assign('location', patch.location || null)
  if (Object.prototype.hasOwnProperty.call(patch, 'attendees')) {
    const attendees = Array.isArray(patch.attendees) ? patch.attendees : []
    assign('attendees', JSON.stringify(attendees))
    setFragments[setFragments.length - 1] = `attendees = $${values.length}::jsonb`
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'source_type')) assign('source_type', patch.source_type || null)
  if (Object.prototype.hasOwnProperty.call(patch, 'source_id')) assign('source_id', patch.source_id ? String(patch.source_id) : null)
  if (Object.prototype.hasOwnProperty.call(patch, 'transaction_id')) assign('transaction_id', patch.transaction_id ? String(patch.transaction_id) : null)
  if (Object.prototype.hasOwnProperty.call(patch, 'sync_status')) assign('sync_status', patch.sync_status || 'pending')
  if (Object.prototype.hasOwnProperty.call(patch, 'sync_error')) assign('sync_error', patch.sync_error || null)
  if (Object.prototype.hasOwnProperty.call(patch, 'synced_at')) assign('synced_at', patch.synced_at ? new Date(patch.synced_at) : null)
  if (Object.prototype.hasOwnProperty.call(patch, 'status')) assign('status', patch.status || existing.status || 'active')
  if (Object.prototype.hasOwnProperty.call(patch, 'deleted_at')) assign('deleted_at', patch.deleted_at ? new Date(patch.deleted_at) : null)

  if (setFragments.length > 0) {
    await pgPool.query(
      `
        UPDATE calendar_events
        SET ${setFragments.join(', ')}, updated_at = NOW()
        WHERE id = $1
      `,
      values
    )
  }

  const needsMappingUpdate =
    Object.prototype.hasOwnProperty.call(patch, 'provider') ||
    Object.prototype.hasOwnProperty.call(patch, 'external_event_id') ||
    Object.prototype.hasOwnProperty.call(patch, 'external_event_link')

  if (needsMappingUpdate) {
    const current = await findCalendarEventDocInSql(existing.user_id, existing.id)
    const provider = normalizeCalendarProvider(
      Object.prototype.hasOwnProperty.call(patch, 'provider') ? patch.provider : current?.provider
    )
    const externalEventId = Object.prototype.hasOwnProperty.call(patch, 'external_event_id')
      ? patch.external_event_id
      : current?.external_event_id
    const externalEventLink = Object.prototype.hasOwnProperty.call(patch, 'external_event_link')
      ? patch.external_event_link
      : current?.external_event_link

    if (provider && externalEventId) {
      await upsertEventProviderMappingForUserProvider({
        userId: existing.user_id,
        provider,
        eventId: existing.id,
        externalEventId,
        externalEventLink,
        syncStatus: Object.prototype.hasOwnProperty.call(patch, 'sync_status')
          ? (patch.sync_status || 'synced')
          : (current?.sync_status || 'synced'),
        syncError: Object.prototype.hasOwnProperty.call(patch, 'sync_error')
          ? (patch.sync_error || null)
          : (current?.sync_error || null),
        lastSyncedAt: Object.prototype.hasOwnProperty.call(patch, 'synced_at')
          ? patch.synced_at
          : (current?.synced_at || null)
      })
    }
  }

  return findCalendarEventDocInSql(existing.user_id, existing.id)
}

async function findCalendarConnection(db, userKey, provider) {
  const key = normalizeUserKey(userKey)
  const normalizedProvider = normalizeCalendarProvider(provider)
  if (!normalizedProvider) return null
  if (isCalendarSqlStorageEnabled()) {
    const { rows } = await pgPool.query(
      `
        SELECT *
        FROM calendar_connections
        WHERE user_id = $1 AND provider = $2
        LIMIT 1
      `,
      [key, normalizedProvider]
    )
    const row = rows?.[0] || null
    if (row) return hydrateCalendarConnection(row)
    if (normalizedProvider === CALENDAR_PROVIDER_GOOGLE) {
      return migrateLegacyGoogleConnectionIfNeeded(db, key)
    }
    return null
  }
  const coll = db.collection(CALENDAR_CONNECTIONS_COLLECTION)
  const stored = await coll.findOne({ user_id: key, provider: normalizedProvider })
  if (stored) return hydrateCalendarConnection(stored)
  if (normalizedProvider === CALENDAR_PROVIDER_GOOGLE) {
    return migrateLegacyGoogleConnectionIfNeeded(db, key)
  }
  return null
}

async function listCalendarConnections(db, userKey) {
  const key = normalizeUserKey(userKey)
  if (isCalendarSqlStorageEnabled()) {
    const { rows } = await pgPool.query(
      `
        SELECT *
        FROM calendar_connections
        WHERE user_id = $1
        ORDER BY updated_at DESC, created_at DESC
      `,
      [key]
    )
    return (rows || [])
      .filter((item) => normalizeCalendarProvider(item?.provider))
      .map((item) => hydrateCalendarConnection(item))
      .filter(Boolean)
  }
  const coll = db.collection(CALENDAR_CONNECTIONS_COLLECTION)
  const all = await coll.find({ user_id: key }).toArray()
  const filtered = Array.isArray(all)
    ? all.filter((item) => normalizeCalendarProvider(item?.provider))
    : []
  return filtered.map((item) => hydrateCalendarConnection(item)).filter(Boolean)
}

async function upsertCalendarConnection(db, userKey, provider, updates = {}) {
  const key = normalizeUserKey(userKey)
  const normalizedProvider = normalizeCalendarProvider(provider)
  if (!normalizedProvider) throw new Error('Unsupported calendar provider')
  if (isCalendarSqlStorageEnabled()) {
    const existing = await findCalendarConnection(db, key, normalizedProvider)
    const now = new Date()
    const next = {
      ...(existing || {}),
      ...updates,
      id: existing?.id || updates?.id || uuidv4(),
      user_id: key,
      provider: normalizedProvider,
      created_at: existing?.created_at || now,
      updated_at: now
    }
    const stored = toStoredCalendarConnection(next)
    await pgPool.query(
      `
        INSERT INTO calendar_connections (
          id,
          user_id,
          provider,
          connected_email,
          access_token,
          refresh_token,
          token_type,
          scope,
          calendar_id,
          expires_at,
          created_at,
          updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW()
        )
        ON CONFLICT (user_id, provider)
        DO UPDATE SET
          connected_email = EXCLUDED.connected_email,
          access_token = EXCLUDED.access_token,
          refresh_token = EXCLUDED.refresh_token,
          token_type = EXCLUDED.token_type,
          scope = EXCLUDED.scope,
          calendar_id = EXCLUDED.calendar_id,
          expires_at = EXCLUDED.expires_at,
          updated_at = NOW()
      `,
      [
        String(stored.id),
        key,
        normalizedProvider,
        stored.connected_email || null,
        stored.access_token || null,
        stored.refresh_token || null,
        stored.token_type || null,
        stored.scope || null,
        stored.calendar_id || null,
        stored.expires_at ? new Date(stored.expires_at) : null,
        stored.created_at ? new Date(stored.created_at) : now
      ]
    )
    return findCalendarConnection(db, key, normalizedProvider)
  }
  const coll = db.collection(CALENDAR_CONNECTIONS_COLLECTION)
  const existingStored = await coll.findOne({ user_id: key, provider: normalizedProvider })
  const existing = existingStored ? hydrateCalendarConnection(existingStored) : null
  const now = new Date()
  const next = {
    ...(existing || {}),
    ...updates,
    user_id: key,
    provider: normalizedProvider,
    updated_at: now
  }
  if (!existing) {
    next.id = next.id || uuidv4()
    next.created_at = next.created_at || now
  }
  const storedNext = toStoredCalendarConnection(next)
  if (existingStored) {
    await coll.updateOne({ id: existingStored.id }, { $set: storedNext })
  } else {
    await coll.insertOne(storedNext)
  }
  return next
}

async function deleteCalendarConnection(db, userKey, provider = null) {
  const key = normalizeUserKey(userKey)
  if (isCalendarSqlStorageEnabled()) {
    const normalizedProvider = provider ? normalizeCalendarProvider(provider) : null
    if (provider && !normalizedProvider) return { deletedCount: 0 }
    if (normalizedProvider) {
      const { rowCount } = await pgPool.query(
        `DELETE FROM calendar_connections WHERE user_id = $1 AND provider = $2`,
        [key, normalizedProvider]
      )
      return { deletedCount: rowCount || 0 }
    }
    const { rowCount } = await pgPool.query(
      `DELETE FROM calendar_connections WHERE user_id = $1`,
      [key]
    )
    return { deletedCount: rowCount || 0 }
  }
  const coll = db.collection(CALENDAR_CONNECTIONS_COLLECTION)
  const normalizedProvider = provider ? normalizeCalendarProvider(provider) : null
  if (provider && !normalizedProvider) return { deletedCount: 0 }
  if (normalizedProvider) {
    return coll.deleteOne({ user_id: key, provider: normalizedProvider })
  }
  return coll.deleteMany({ user_id: key })
}

function getCalendarConnectionPublicStatus(connection, provider, configured) {
  const hasAccessToken = Boolean(String(connection?.access_token || '').trim())
  const hasRefreshToken = Boolean(String(connection?.refresh_token || '').trim())
  return {
    provider,
    provider_name: providerDisplayName(provider),
    configured: Boolean(configured),
    connected: Boolean(connection) && (hasAccessToken || hasRefreshToken),
    connected_email: connection?.connected_email || null,
    expires_at: connection?.expires_at || null,
    has_access_token: hasAccessToken,
    has_refresh_token: hasRefreshToken,
    calendar_id: connection?.calendar_id || null
  }
}

async function findCalendarEventRecord(db, { userKey, provider, transactionId }) {
  const key = normalizeUserKey(userKey)
  const normalizedProvider = normalizeCalendarProvider(provider)
  if (!normalizedProvider || !transactionId) return null
  if (isCalendarSqlStorageEnabled()) {
    const { rows } = await pgPool.query(
      `
        SELECT
          m.id,
          e.user_id,
          c.provider,
          e.transaction_id,
          m.external_event_id,
          m.external_event_link,
          e.id AS event_id,
          m.created_at,
          m.updated_at
        FROM event_provider_mapping m
        JOIN calendar_events e ON e.id = m.event_id
        JOIN calendar_connections c ON c.id = m.connection_id
        WHERE e.user_id = $1
          AND c.provider = $2
          AND e.transaction_id = $3
          AND COALESCE(e.status, 'active') <> 'deleted'
        ORDER BY m.updated_at DESC, m.created_at DESC
        LIMIT 1
      `,
      [key, normalizedProvider, String(transactionId)]
    )
    return rows?.[0] || null
  }
  return db.collection(CALENDAR_EVENTS_COLLECTION).findOne({
    user_id: key,
    provider: normalizedProvider,
    transaction_id: String(transactionId)
  })
}

async function listCalendarEventRecordsByTransaction(db, { userKey, transactionId }) {
  const key = normalizeUserKey(userKey)
  if (isCalendarSqlStorageEnabled()) {
    const { rows } = await pgPool.query(
      `
        SELECT
          m.id,
          e.user_id,
          c.provider,
          e.transaction_id,
          m.external_event_id,
          m.external_event_link,
          e.id AS event_id,
          m.created_at,
          m.updated_at
        FROM event_provider_mapping m
        JOIN calendar_events e ON e.id = m.event_id
        JOIN calendar_connections c ON c.id = m.connection_id
        WHERE e.user_id = $1
          AND e.transaction_id = $2
          AND COALESCE(e.status, 'active') <> 'deleted'
        ORDER BY m.updated_at DESC, m.created_at DESC
      `,
      [key, String(transactionId)]
    )
    return rows || []
  }
  return db.collection(CALENDAR_EVENTS_COLLECTION)
    .find({ user_id: key, transaction_id: String(transactionId) })
    .toArray()
}

async function upsertCalendarEventRecord(db, {
  userKey,
  provider,
  transactionId,
  externalEventId,
  externalEventLink = null
}) {
  const key = normalizeUserKey(userKey)
  const normalizedProvider = normalizeCalendarProvider(provider)
  if (!normalizedProvider || !transactionId) return null
  if (isCalendarSqlStorageEnabled()) {
    const { rows: existingEventRows } = await pgPool.query(
      `
        SELECT id
        FROM calendar_events
        WHERE user_id = $1 AND transaction_id = $2
          AND COALESCE(status, 'active') <> 'deleted'
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1
      `,
      [key, String(transactionId)]
    )
    const existingEventId = existingEventRows?.[0]?.id || null
    let eventDoc = existingEventId ? await findCalendarEventDocInSql(key, existingEventId) : null

    if (!eventDoc) {
      const now = new Date()
      eventDoc = await insertCalendarEventDocInSql({
        id: uuidv4(),
        user_id: key,
        title: `Transaction ${transactionId}`,
        start_time: now.toISOString(),
        end_time: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
        description: null,
        location: null,
        attendees: [],
        source_type: 'transaction',
        source_id: String(transactionId),
        transaction_id: String(transactionId),
        sync_status: 'pending',
        sync_error: null,
        status: 'active'
      })
    }

    const mapping = await upsertEventProviderMappingForUserProvider({
      userId: key,
      provider: normalizedProvider,
      eventId: eventDoc?.id,
      externalEventId,
      externalEventLink,
      syncStatus: 'synced',
      syncError: null,
      lastSyncedAt: new Date()
    })

    await updateCalendarEventDocInSql(eventDoc?.id, {
      sync_status: mapping ? 'synced' : (eventDoc?.sync_status || 'pending'),
      sync_error: null,
      synced_at: mapping ? new Date() : null
    })

    return mapping ? {
      id: String(mapping.id),
      user_id: key,
      provider: normalizedProvider,
      transaction_id: String(transactionId),
      external_event_id: String(mapping.external_event_id || '').trim() || null,
      external_event_link: mapping.external_event_link || null,
      event_id: String(eventDoc?.id || ''),
      created_at: mapping.created_at || new Date(),
      updated_at: mapping.updated_at || new Date()
    } : null
  }
  const coll = db.collection(CALENDAR_EVENTS_COLLECTION)
  const existing = await coll.findOne({
    user_id: key,
    provider: normalizedProvider,
    transaction_id: String(transactionId)
  })
  const now = new Date()
  const payload = {
    id: existing?.id || uuidv4(),
    user_id: key,
    provider: normalizedProvider,
    transaction_id: String(transactionId),
    external_event_id: String(externalEventId || '').trim() || null,
    external_event_link: externalEventLink || null,
    created_at: existing?.created_at || now,
    updated_at: now
  }
  if (existing) {
    await coll.updateOne({ id: existing.id }, { $set: payload })
  } else {
    await coll.insertOne(payload)
  }
  return payload
}

async function deleteCalendarEventRecord(db, id) {
  if (!id) return { deletedCount: 0 }
  if (isCalendarSqlStorageEnabled()) {
    const { rowCount } = await pgPool.query(
      `DELETE FROM event_provider_mapping WHERE id = $1`,
      [String(id)]
    )
    return { deletedCount: rowCount || 0 }
  }
  return db.collection(CALENDAR_EVENTS_COLLECTION).deleteOne({ id: String(id) })
}

async function deleteCalendarEventRecordsByQuery(db, query = {}) {
  if (isCalendarSqlStorageEnabled()) {
    const userId = normalizeUserKey(query?.user_id || query?.userKey || '')
    const transactionId = query?.transaction_id ? String(query.transaction_id) : null
    const provider = normalizeCalendarProvider(query?.provider)

    if (userId && transactionId && !provider) {
      const { rowCount } = await pgPool.query(
        `DELETE FROM calendar_events WHERE user_id = $1 AND transaction_id = $2`,
        [userId, transactionId]
      )
      return { deletedCount: rowCount || 0 }
    }

    if (userId && transactionId && provider) {
      const { rowCount } = await pgPool.query(
        `
          DELETE FROM event_provider_mapping m
          USING calendar_events e, calendar_connections c
          WHERE m.event_id = e.id
            AND m.connection_id = c.id
            AND e.user_id = $1
            AND e.transaction_id = $2
            AND c.provider = $3
        `,
        [userId, transactionId, provider]
      )
      return { deletedCount: rowCount || 0 }
    }
  }
  return db.collection(CALENDAR_EVENTS_COLLECTION).deleteMany(query)
}

async function markCalendarEventsAsProviderDisconnected(db, { userKey, provider = null }) {
  const key = normalizeUserKey(userKey)
  const normalizedProvider = provider ? normalizeCalendarProvider(provider) : null
  if (isCalendarSqlStorageEnabled()) {
    if (provider && !normalizedProvider) return
    if (normalizedProvider) {
      await pgPool.query(
        `
          UPDATE event_provider_mapping m
          SET sync_status = 'provider_disconnected',
              sync_error = NULL,
              updated_at = NOW()
          FROM calendar_events e, calendar_connections c
          WHERE m.event_id = e.id
            AND m.connection_id = c.id
            AND e.user_id = $1
            AND c.provider = $2
        `,
        [key, normalizedProvider]
      )
      await pgPool.query(
        `
          UPDATE calendar_events
          SET sync_status = 'provider_disconnected',
              sync_error = NULL,
              updated_at = NOW()
          WHERE user_id = $1
            AND id IN (
              SELECT e.id
              FROM calendar_events e
              JOIN event_provider_mapping m ON m.event_id = e.id
              JOIN calendar_connections c ON c.id = m.connection_id
              WHERE e.user_id = $1 AND c.provider = $2
            )
        `,
        [key, normalizedProvider]
      )
      return
    }

    await pgPool.query(
      `
        UPDATE event_provider_mapping m
        SET sync_status = 'provider_disconnected',
            sync_error = NULL,
            updated_at = NOW()
        FROM calendar_events e
        WHERE m.event_id = e.id
          AND e.user_id = $1
      `,
      [key]
    )
    await pgPool.query(
      `
        UPDATE calendar_events
        SET sync_status = 'provider_disconnected',
            sync_error = NULL,
            updated_at = NOW()
        WHERE user_id = $1
      `,
      [key]
    )
    return
  }
  const query = { user_id: key }
  if (normalizedProvider) query.provider = normalizedProvider

  const events = await db.collection(CALENDAR_EVENTS_COLLECTION).find(query).toArray()
  for (const eventDoc of events) {
    if (!eventDoc?.id) continue
    await db.collection(CALENDAR_EVENTS_COLLECTION).updateOne(
      { id: String(eventDoc.id) },
      {
        $set: {
          sync_status: 'provider_disconnected',
          sync_error: null,
          updated_at: new Date()
        }
      }
    )
  }
}

function buildTransactionCalendarEventInput(transaction, closingDate) {
  return {
    summary: buildTransactionCalendarSummary(transaction),
    description: buildTransactionCalendarDetails(transaction),
    location: String(transaction?.property_address || '').trim() || null,
    start_date: closingDate,
    end_date: addDaysToDateOnly(closingDate, 1) || closingDate,
    attendees: transaction?.client_email
      ? [{ email: String(transaction.client_email).trim().toLowerCase(), name: transaction?.client_name || '' }]
      : []
  }
}

function buildProviderQuickAddUrl(provider, transaction, closingDate) {
  if (provider === CALENDAR_PROVIDER_GOOGLE) {
    return buildGoogleCalendarTemplateUrl(transaction, closingDate)
  }
  if (provider === CALENDAR_PROVIDER_OUTLOOK) {
    return buildOutlookCalendarComposeUrl(transaction, closingDate)
  }
  return null
}

function isRetryableStatus(statusCode) {
  return statusCode === 408 || statusCode === 409 || statusCode === 429 || statusCode >= 500
}

function parseRetryAfterMs(response, fallbackMs = 350) {
  const header = response?.headers?.get?.('retry-after')
  if (!header) return fallbackMs
  const asNumber = Number(header)
  if (Number.isFinite(asNumber) && asNumber >= 0) return Math.min(5000, asNumber * 1000)
  const asDate = Date.parse(header)
  if (Number.isFinite(asDate)) {
    return Math.max(fallbackMs, Math.min(5000, asDate - Date.now()))
  }
  return fallbackMs
}

async function waitMs(ms) {
  const delay = Math.max(0, Number(ms) || 0)
  if (!delay) return
  await new Promise((resolve) => setTimeout(resolve, delay))
}

async function fetchWithRetry(url, init = {}, options = {}) {
  const retries = Math.max(0, Number(options.retries ?? 2))
  const baseDelay = Math.max(0, Number(options.baseDelayMs ?? 350))
  let attempt = 0
  let lastError = null
  while (attempt <= retries) {
    try {
      const response = await fetch(url, init)
      if (attempt < retries && isRetryableStatus(response.status)) {
        const delay = Math.min(4000, parseRetryAfterMs(response, baseDelay * (2 ** attempt)))
        await waitMs(delay)
        attempt += 1
        continue
      }
      return response
    } catch (error) {
      lastError = error
      if (attempt >= retries) break
      const delay = Math.min(4000, baseDelay * (2 ** attempt))
      await waitMs(delay)
      attempt += 1
    }
  }
  throw lastError || new Error('Network request failed')
}

function toIsoDateTime(value) {
  const epoch = parseDateToEpochMillis(value)
  if (epoch === null) return null
  return new Date(epoch).toISOString()
}

function toGraphDateTime(value) {
  const iso = toIsoDateTime(value)
  return iso ? iso.replace(/Z$/, '') : null
}

function genericApiErrorMessage(payload, fallback = 'Calendar API request failed') {
  if (!payload) return fallback
  if (typeof payload === 'string') return payload || fallback
  if (payload?.error?.message) return String(payload.error.message)
  if (payload?.error_description) return String(payload.error_description)
  if (payload?.error) {
    if (typeof payload.error === 'string') return payload.error
    if (payload.error?.message) return String(payload.error.message)
  }
  return fallback
}

function buildUtcDateStart(dateOnly) {
  const safeDate = toDateOnlyString(dateOnly)
  return safeDate ? `${safeDate}T00:00:00` : null
}

function buildUtcDateEnd(dateOnly) {
  const safeDate = toDateOnlyString(dateOnly)
  const end = safeDate ? addDaysToDateOnly(safeDate, 1) : null
  return (end || safeDate) ? `${end || safeDate}T00:00:00` : null
}

async function updateGoogleCalendarEvent({ accessToken, calendarId = 'primary', eventId, event }) {
  const response = await fetchWithRetry(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(event)
    }
  )
  const payload = await response.json().catch(() => null)
  return {
    ok: response.ok,
    status: response.status,
    payload
  }
}

async function deleteGoogleCalendarEvent({ accessToken, calendarId = 'primary', eventId }) {
  const response = await fetchWithRetry(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` }
    }
  )
  let payload = null
  if (response.status !== 204) {
    payload = await response.json().catch(() => null)
  }
  return {
    ok: response.ok || response.status === 404,
    status: response.status,
    payload
  }
}

async function exchangeOutlookCodeForTokens({ code, config }) {
  const params = new URLSearchParams()
  params.set('client_id', config.clientId)
  params.set('client_secret', config.clientSecret)
  params.set('code', String(code || ''))
  params.set('redirect_uri', config.redirectUri)
  params.set('grant_type', 'authorization_code')
  params.set('scope', OUTLOOK_OAUTH_SCOPES.join(' '))

  const response = await fetchWithRetry(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(genericApiErrorMessage(payload, `Outlook token exchange failed (${response.status})`))
  }
  return payload
}

async function refreshOutlookAccessToken({ refreshToken, config }) {
  const params = new URLSearchParams()
  params.set('client_id', config.clientId)
  params.set('client_secret', config.clientSecret)
  params.set('refresh_token', String(refreshToken || ''))
  params.set('grant_type', 'refresh_token')
  params.set('scope', OUTLOOK_OAUTH_SCOPES.join(' '))

  const response = await fetchWithRetry(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(genericApiErrorMessage(payload, `Outlook token refresh failed (${response.status})`))
  }
  return payload
}

async function fetchOutlookUserProfile(accessToken) {
  if (!accessToken) return null
  const response = await fetchWithRetry(`${GRAPH_API_BASE_URL}/me`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  if (!response.ok) return null
  return response.json().catch(() => null)
}

async function createOutlookCalendarEvent({ accessToken, event }) {
  const response = await fetchWithRetry(`${GRAPH_API_BASE_URL}/me/events`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(event)
  })
  const payload = await response.json().catch(() => null)
  return {
    ok: response.ok,
    status: response.status,
    payload
  }
}

async function updateOutlookCalendarEvent({ accessToken, eventId, event }) {
  const response = await fetchWithRetry(`${GRAPH_API_BASE_URL}/me/events/${encodeURIComponent(eventId)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(event)
  })
  const payload = await response.json().catch(() => null)
  return {
    ok: response.ok,
    status: response.status,
    payload
  }
}

async function deleteOutlookCalendarEvent({ accessToken, eventId }) {
  const response = await fetchWithRetry(`${GRAPH_API_BASE_URL}/me/events/${encodeURIComponent(eventId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  let payload = null
  if (response.status !== 204) {
    payload = await response.json().catch(() => null)
  }
  return {
    ok: response.ok || response.status === 404,
    status: response.status,
    payload
  }
}

class CalendarProvider {
  constructor(providerId, displayName) {
    this.providerId = providerId
    this.displayName = displayName
  }

  getConfig() {
    throw new Error('getConfig() must be implemented')
  }

  isConfigured() {
    throw new Error('isConfigured() must be implemented')
  }

  getScopes() {
    return []
  }

  connect() {
    throw new Error('connect() must be implemented')
  }

  async callback() {
    throw new Error('callback() must be implemented')
  }

  async refreshToken() {
    throw new Error('refreshToken() must be implemented')
  }

  async createEvent() {
    throw new Error('createEvent() must be implemented')
  }

  async updateEvent() {
    throw new Error('updateEvent() must be implemented')
  }

  async deleteEvent() {
    throw new Error('deleteEvent() must be implemented')
  }
}

class GoogleCalendarProvider extends CalendarProvider {
  constructor() {
    super(CALENDAR_PROVIDER_GOOGLE, 'Google Calendar')
  }

  getConfig() {
    return getGoogleOAuthConfig()
  }

  isConfigured(config = this.getConfig()) {
    return isGoogleOAuthConfigured(config)
  }

  getScopes() {
    return [...GOOGLE_OAUTH_SCOPES]
  }

  connect({ state }) {
    const config = this.getConfig()
    const params = new URLSearchParams()
    params.set('client_id', config.clientId)
    params.set('redirect_uri', config.redirectUri)
    params.set('response_type', 'code')
    params.set('access_type', 'offline')
    params.set('prompt', 'consent')
    params.set('include_granted_scopes', 'true')
    params.set('scope', this.getScopes().join(' '))
    params.set('state', state)
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
  }

  async callback({ db, userKey, code }) {
    const config = this.getConfig()
    const existing = await findCalendarConnection(db, userKey, this.providerId)
    const tokens = await exchangeGoogleCodeForTokens({ code, config })
    const profile = await fetchGoogleUserProfile(tokens.access_token)
    return upsertCalendarConnection(db, userKey, this.providerId, {
      connected_email: String(profile?.email || existing?.connected_email || '').trim().toLowerCase() || null,
      access_token: tokens.access_token || existing?.access_token || null,
      refresh_token: tokens.refresh_token || existing?.refresh_token || null,
      token_type: tokens.token_type || existing?.token_type || 'Bearer',
      scope: tokens.scope || existing?.scope || this.getScopes().join(' '),
      expires_at: computeExpiryIso(tokens.expires_in, existing?.expires_at),
      calendar_id: existing?.calendar_id || config.calendarId
    })
  }

  async refreshToken({ refreshToken }) {
    const config = this.getConfig()
    return refreshGoogleAccessToken({ refreshToken, config })
  }

  buildEventPayload(eventInput) {
    const startDateTime = toIsoDateTime(eventInput?.start_time)
    const endDateTime = toIsoDateTime(eventInput?.end_time || eventInput?.start_time)
    const payload = {
      summary: eventInput?.summary || 'CRM event',
      description: eventInput?.description || '',
      location: eventInput?.location || undefined,
      reminders: { useDefault: true },
      attendees: Array.isArray(eventInput?.attendees)
        ? eventInput.attendees
            .filter((att) => String(att?.email || '').includes('@'))
            .map((att) => ({
              email: String(att.email).trim().toLowerCase(),
              displayName: att?.name ? String(att.name).trim() : undefined
            }))
        : undefined
    }
    if (startDateTime && endDateTime) {
      payload.start = { dateTime: startDateTime }
      payload.end = { dateTime: endDateTime }
    } else {
      payload.start = { date: toDateOnlyString(eventInput?.start_date || eventInput?.start_time) }
      payload.end = { date: toDateOnlyString(eventInput?.end_date || eventInput?.end_time || eventInput?.start_date || eventInput?.start_time) }
    }
    return payload
  }

  async createEvent({ accessToken, connection, eventInput }) {
    const config = this.getConfig()
    const event = this.buildEventPayload(eventInput)
    const insertion = await createGoogleCalendarEvent({
      accessToken,
      calendarId: connection?.calendar_id || config.calendarId,
      event
    })
    if (!insertion.ok) {
      return {
        ok: false,
        status: insertion.status,
        error: googleApiErrorMessage(insertion.payload, `Google Calendar create failed (${insertion.status})`)
      }
    }
    const payload = insertion.payload || {}
    return {
      ok: true,
      status: insertion.status,
      event_id: payload.id || null,
      event_link: payload.htmlLink || null
    }
  }

  async updateEvent({ accessToken, connection, eventId, eventInput }) {
    const config = this.getConfig()
    const event = this.buildEventPayload(eventInput)
    const response = await updateGoogleCalendarEvent({
      accessToken,
      calendarId: connection?.calendar_id || config.calendarId,
      eventId,
      event
    })
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: googleApiErrorMessage(response.payload, `Google Calendar update failed (${response.status})`)
      }
    }
    const payload = response.payload || {}
    return {
      ok: true,
      status: response.status,
      event_id: payload.id || eventId,
      event_link: payload.htmlLink || null
    }
  }

  async deleteEvent({ accessToken, connection, eventId }) {
    const config = this.getConfig()
    const response = await deleteGoogleCalendarEvent({
      accessToken,
      calendarId: connection?.calendar_id || config.calendarId,
      eventId
    })
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: googleApiErrorMessage(response.payload, `Google Calendar delete failed (${response.status})`)
      }
    }
    return {
      ok: true,
      status: response.status
    }
  }
}

class OutlookCalendarProvider extends CalendarProvider {
  constructor() {
    super(CALENDAR_PROVIDER_OUTLOOK, 'Outlook Calendar')
  }

  getConfig() {
    return getOutlookOAuthConfig()
  }

  isConfigured(config = this.getConfig()) {
    return isOutlookOAuthConfigured(config)
  }

  getScopes() {
    return [...OUTLOOK_OAUTH_SCOPES]
  }

  connect({ state }) {
    const config = this.getConfig()
    const params = new URLSearchParams()
    params.set('client_id', config.clientId)
    params.set('response_type', 'code')
    params.set('redirect_uri', config.redirectUri)
    params.set('response_mode', 'query')
    params.set('scope', this.getScopes().join(' '))
    params.set('prompt', 'select_account')
    params.set('state', state)
    return `${config.authorizationUrl}?${params.toString()}`
  }

  async callback({ db, userKey, code }) {
    const config = this.getConfig()
    const existing = await findCalendarConnection(db, userKey, this.providerId)
    const tokens = await exchangeOutlookCodeForTokens({ code, config })
    const profile = await fetchOutlookUserProfile(tokens.access_token)
    const connectedEmail = String(
      profile?.mail ||
      profile?.userPrincipalName ||
      existing?.connected_email ||
      ''
    ).trim().toLowerCase() || null

    return upsertCalendarConnection(db, userKey, this.providerId, {
      connected_email: connectedEmail,
      access_token: tokens.access_token || existing?.access_token || null,
      refresh_token: tokens.refresh_token || existing?.refresh_token || null,
      token_type: tokens.token_type || existing?.token_type || 'Bearer',
      scope: tokens.scope || existing?.scope || this.getScopes().join(' '),
      expires_at: computeExpiryIso(tokens.expires_in, existing?.expires_at)
    })
  }

  async refreshToken({ refreshToken }) {
    const config = this.getConfig()
    return refreshOutlookAccessToken({ refreshToken, config })
  }

  buildEventPayload(eventInput) {
    const attendees = Array.isArray(eventInput?.attendees)
      ? eventInput.attendees
          .filter((att) => String(att?.email || '').includes('@'))
          .map((att) => ({
            emailAddress: {
              address: String(att.email).trim().toLowerCase(),
              name: String(att?.name || att?.email || '').trim()
            },
            type: 'required'
          }))
      : []

    const startDateTime = toGraphDateTime(eventInput?.start_time)
    const endDateTime = toGraphDateTime(eventInput?.end_time || eventInput?.start_time)
    const payload = {
      subject: eventInput?.summary || 'CRM event',
      body: {
        contentType: 'Text',
        content: String(eventInput?.description || '')
      },
      start: startDateTime
        ? { dateTime: startDateTime, timeZone: 'UTC' }
        : { dateTime: buildUtcDateStart(eventInput?.start_date || eventInput?.start_time), timeZone: 'UTC' },
      end: endDateTime
        ? { dateTime: endDateTime, timeZone: 'UTC' }
        : { dateTime: buildUtcDateEnd(eventInput?.end_date || eventInput?.end_time || eventInput?.start_date || eventInput?.start_time), timeZone: 'UTC' },
      isAllDay: !(startDateTime && endDateTime)
    }

    const location = String(eventInput?.location || '').trim()
    if (location) payload.location = { displayName: location }
    if (attendees.length) payload.attendees = attendees

    return payload
  }

  async createEvent({ accessToken, eventInput }) {
    const event = this.buildEventPayload(eventInput)
    const insertion = await createOutlookCalendarEvent({ accessToken, event })
    if (!insertion.ok) {
      return {
        ok: false,
        status: insertion.status,
        error: genericApiErrorMessage(insertion.payload, `Outlook Calendar create failed (${insertion.status})`)
      }
    }
    const payload = insertion.payload || {}
    return {
      ok: true,
      status: insertion.status,
      event_id: payload.id || null,
      event_link: payload.webLink || null
    }
  }

  async updateEvent({ accessToken, eventId, eventInput }) {
    const event = this.buildEventPayload(eventInput)
    const response = await updateOutlookCalendarEvent({ accessToken, eventId, event })
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: genericApiErrorMessage(response.payload, `Outlook Calendar update failed (${response.status})`)
      }
    }
    const payload = response.payload || {}
    return {
      ok: true,
      status: response.status,
      event_id: payload.id || eventId,
      event_link: payload.webLink || null
    }
  }

  async deleteEvent({ accessToken, eventId }) {
    const response = await deleteOutlookCalendarEvent({ accessToken, eventId })
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: genericApiErrorMessage(response.payload, `Outlook Calendar delete failed (${response.status})`)
      }
    }
    return {
      ok: true,
      status: response.status
    }
  }
}

const calendarProviders = {
  [CALENDAR_PROVIDER_GOOGLE]: new GoogleCalendarProvider(),
  [CALENDAR_PROVIDER_OUTLOOK]: new OutlookCalendarProvider()
}

function getCalendarProvider(provider) {
  const normalizedProvider = normalizeCalendarProvider(provider)
  if (!normalizedProvider) return null
  return calendarProviders[normalizedProvider] || null
}

function listCalendarProviderMetas() {
  return CALENDAR_PROVIDER_IDS.map((providerId) => {
    const provider = getCalendarProvider(providerId)
    return {
      id: providerId,
      name: provider?.displayName || providerDisplayName(providerId),
      configured: provider ? provider.isConfigured() : false
    }
  })
}

async function ensureCalendarProviderAccessToken({ db, provider, connection }) {
  if (!connection) return { success: false, error: `${provider.displayName} is not connected` }
  let current = connection
  let accessToken = String(connection.access_token || '').trim()
  const expiresAt = parseDateToEpochMillis(connection.expires_at)
  const expiresSoon = expiresAt !== null && expiresAt <= Date.now() + 60 * 1000

  if ((!accessToken || expiresSoon) && current.refresh_token) {
    const refreshed = await provider.refreshToken({ refreshToken: current.refresh_token })
    current = await upsertCalendarConnection(db, current.user_id, provider.providerId, {
      access_token: refreshed.access_token || accessToken,
      refresh_token: refreshed.refresh_token || current.refresh_token,
      token_type: refreshed.token_type || current.token_type || 'Bearer',
      scope: refreshed.scope || current.scope || provider.getScopes().join(' '),
      expires_at: computeExpiryIso(refreshed.expires_in, current.expires_at),
      connected_email: current.connected_email || null,
      calendar_id: current.calendar_id || null
    })
    accessToken = String(current.access_token || '').trim()
  }

  if (!accessToken) {
    return { success: false, error: `Missing ${provider.displayName} access token` }
  }

  return { success: true, accessToken, connection: current }
}

class CalendarService {
  constructor({ db, logger = console } = {}) {
    this.db = db
    this.logger = logger
  }

  log(message, payload = null) {
    if (payload) {
      this.logger.log(`[CalendarService] ${message}`, payload)
      return
    }
    this.logger.log(`[CalendarService] ${message}`)
  }

  async resolveSingleProviderConnection(userKey) {
    const key = normalizeUserKey(userKey)
    const connections = await listCalendarConnections(this.db, key)
    if (!Array.isArray(connections) || connections.length === 0) {
      return { providerId: null, connection: null }
    }
    const orderedProviders = [CALENDAR_PROVIDER_OUTLOOK, CALENDAR_PROVIDER_GOOGLE]
    const selected = orderedProviders
      .map((providerId) => connections.find((item) => item?.provider === providerId))
      .find(Boolean) || connections[0]
    if (selected?.provider) {
      return { providerId: selected.provider, connection: selected }
    }
    return { providerId: null, connection: null }
  }

  async updateCalendarEventDoc(eventId, patch = {}) {
    if (isCalendarSqlStorageEnabled()) {
      return updateCalendarEventDocInSql(eventId, patch)
    }
    await this.db.collection(CALENDAR_EVENTS_COLLECTION).updateOne(
      { id: String(eventId) },
      { $set: { ...patch, updated_at: new Date() } }
    )
    return this.db.collection(CALENDAR_EVENTS_COLLECTION).findOne({ id: String(eventId) })
  }

  async findCalendarEventDoc(userKey, eventId) {
    if (isCalendarSqlStorageEnabled()) {
      return findCalendarEventDocInSql(userKey, eventId)
    }
    return this.db.collection(CALENDAR_EVENTS_COLLECTION).findOne({
      id: String(eventId),
      user_id: normalizeUserKey(userKey)
    })
  }

  toProviderEventInput(eventDoc) {
    return {
      summary: eventDoc?.title || 'CRM Event',
      description: eventDoc?.description || '',
      location: eventDoc?.location || null,
      attendees: Array.isArray(eventDoc?.attendees) ? eventDoc.attendees : [],
      start_time: eventDoc?.start_time || null,
      end_time: eventDoc?.end_time || null,
      start_date: toDateOnlyString(eventDoc?.start_time),
      end_date: toDateOnlyString(eventDoc?.end_time || eventDoc?.start_time)
    }
  }

  async createEvent({ userKey, event = {}, source = {} } = {}) {
    const normalizedUser = normalizeUserKey(userKey)
    const title = String(event?.title || event?.summary || '').trim()
    const startTime = toIsoDateTime(event?.start_time || event?.start || event?.start_date)
    const endTimeRaw = toIsoDateTime(event?.end_time || event?.end || event?.end_date)
    const endTime = endTimeRaw || startTime
    if (!title) throw new Error('title is required')
    if (!startTime || !endTime) throw new Error('start_time and end_time are required')
    const startEpoch = parseDateToEpochMillis(startTime)
    const endEpoch = parseDateToEpochMillis(endTime)
    if (startEpoch === null || endEpoch === null || endEpoch <= startEpoch) {
      throw new Error('Invalid time range')
    }

    const eventDoc = {
      id: uuidv4(),
      title,
      start_time: startTime,
      end_time: endTime,
      user_id: normalizedUser,
      provider: null,
      external_event_id: null,
      external_event_link: null,
      description: String(event?.description || '').trim() || null,
      location: String(event?.location || '').trim() || null,
      attendees: Array.isArray(event?.attendees) ? event.attendees : [],
      source_type: source?.type || null,
      source_id: source?.id || null,
      transaction_id: source?.transaction_id ? String(source.transaction_id) : null,
      sync_status: 'pending',
      sync_error: null,
      created_at: new Date(),
      updated_at: new Date()
    }

    const persistedEvent = isCalendarSqlStorageEnabled()
      ? await insertCalendarEventDocInSql(eventDoc)
      : await (async () => {
        await this.db.collection(CALENDAR_EVENTS_COLLECTION).insertOne(eventDoc)
        return eventDoc
      })()
    const localEvent = persistedEvent || eventDoc
    this.log('CRM event created (source of truth)', {
      event_id: localEvent.id,
      user_id: normalizedUser
    })

    const resolved = await this.resolveSingleProviderConnection(normalizedUser)
    if (!resolved.connection || !resolved.providerId) {
      const updated = await this.updateCalendarEventDoc(localEvent.id, {
        provider: null,
        sync_status: 'provider_not_connected',
        sync_error: null
      })
      this.log('No connected provider. Keeping CRM event unsynced.', {
        event_id: localEvent.id,
        user_id: normalizedUser
      })
      return {
        success: true,
        event: updated,
        sync: {
          attempted: false,
          connected: false,
          success: false,
          provider: null,
          reason: 'provider_not_connected',
          error: null
        }
      }
    }

    const providerAdapter = getCalendarProvider(resolved.providerId)
    if (!providerAdapter || !providerAdapter.isConfigured()) {
      const updated = await this.updateCalendarEventDoc(localEvent.id, {
        provider: resolved.providerId,
        sync_status: 'provider_not_configured',
        sync_error: null
      })
      return {
        success: true,
        event: updated,
        sync: {
          attempted: false,
          connected: true,
          success: false,
          provider: resolved.providerId,
          reason: 'provider_not_configured',
          error: null
        }
      }
    }

    // Outlook manual flow: keep CRM event as source of truth and require user confirmation
    // through Outlook compose page instead of API auto-creation.
    if (resolved.providerId === CALENDAR_PROVIDER_OUTLOOK) {
      const updated = await this.updateCalendarEventDoc(localEvent.id, {
        provider: resolved.providerId,
        sync_status: 'manual_confirmation_required',
        sync_error: null
      })
      this.log('Outlook manual confirmation required', {
        event_id: localEvent.id,
        provider: resolved.providerId
      })
      return {
        success: true,
        event: updated,
        sync: {
          attempted: false,
          connected: true,
          success: false,
          provider: resolved.providerId,
          reason: 'manual_confirmation_required',
          error: null
        }
      }
    }

    let ensured
    try {
      ensured = await ensureCalendarProviderAccessToken({
        db: this.db,
        provider: providerAdapter,
        connection: resolved.connection
      })
    } catch (error) {
      const updated = await this.updateCalendarEventDoc(localEvent.id, {
        provider: resolved.providerId,
        sync_status: 'token_refresh_failed',
        sync_error: String(error?.message || error)
      })
      return {
        success: true,
        event: updated,
        sync: {
          attempted: true,
          connected: true,
          success: false,
          provider: resolved.providerId,
          reason: 'token_refresh_failed',
          error: String(error?.message || error)
        }
      }
    }

    if (!ensured.success) {
      const updated = await this.updateCalendarEventDoc(localEvent.id, {
        provider: resolved.providerId,
        sync_status: 'token_unavailable',
        sync_error: ensured.error || null
      })
      return {
        success: true,
        event: updated,
        sync: {
          attempted: true,
          connected: true,
          success: false,
          provider: resolved.providerId,
          reason: 'token_unavailable',
          error: ensured.error || null
        }
      }
    }

    this.log('Syncing event to provider', {
      event_id: localEvent.id,
      provider: resolved.providerId
    })
    const syncResult = await providerAdapter.createEvent({
      accessToken: ensured.accessToken,
      connection: ensured.connection,
      eventInput: this.toProviderEventInput(localEvent)
    })

    if (!syncResult.ok) {
      const updated = await this.updateCalendarEventDoc(localEvent.id, {
        provider: resolved.providerId,
        sync_status: 'sync_failed',
        sync_error: syncResult.error || null
      })
      this.log('Provider sync failed (CRM event retained)', {
        event_id: localEvent.id,
        provider: resolved.providerId,
        error: syncResult.error || null
      })
      return {
        success: true,
        event: updated,
        sync: {
          attempted: true,
          connected: true,
          success: false,
          provider: resolved.providerId,
          reason: 'sync_failed',
          error: syncResult.error || null
        }
      }
    }

    const updated = await this.updateCalendarEventDoc(localEvent.id, {
      provider: resolved.providerId,
      external_event_id: syncResult.event_id || null,
      external_event_link: syncResult.event_link || null,
      sync_status: 'synced',
      sync_error: null,
      synced_at: new Date()
    })
    this.log('Provider sync successful', {
      event_id: localEvent.id,
      provider: resolved.providerId,
      external_event_id: syncResult.event_id || null
    })
    return {
      success: true,
      event: updated,
      sync: {
        attempted: true,
        connected: true,
        success: true,
        provider: resolved.providerId,
        reason: 'synced',
        error: null
      }
    }
  }

  async updateEvent({ userKey, eventId, updates = {} } = {}) {
    const existing = await this.findCalendarEventDoc(userKey, eventId)
    if (!existing) throw new Error('Calendar event not found')

    const title = Object.prototype.hasOwnProperty.call(updates, 'title')
      ? String(updates.title || '').trim()
      : existing.title
    if (!title) throw new Error('title is required')
    const startTime = Object.prototype.hasOwnProperty.call(updates, 'start_time')
      ? toIsoDateTime(updates.start_time)
      : existing.start_time
    const endTime = Object.prototype.hasOwnProperty.call(updates, 'end_time')
      ? toIsoDateTime(updates.end_time)
      : existing.end_time
    if (!startTime || !endTime) throw new Error('start_time and end_time are required')

    const localUpdated = await this.updateCalendarEventDoc(existing.id, {
      title,
      start_time: startTime,
      end_time: endTime,
      description: Object.prototype.hasOwnProperty.call(updates, 'description') ? (updates.description || null) : existing.description,
      location: Object.prototype.hasOwnProperty.call(updates, 'location') ? (updates.location || null) : existing.location,
      attendees: Array.isArray(updates?.attendees) ? updates.attendees : existing.attendees
    })
    this.log('CRM event updated', { event_id: existing.id, user_id: normalizeUserKey(userKey) })

    if (!localUpdated?.provider || !localUpdated?.external_event_id) {
      return {
        success: true,
        event: localUpdated,
        sync: {
          attempted: false,
          connected: false,
          success: false,
          provider: localUpdated?.provider || null,
          reason: 'not_linked',
          error: null
        }
      }
    }

    const providerAdapter = getCalendarProvider(localUpdated.provider)
    const connection = await findCalendarConnection(this.db, userKey, localUpdated.provider)
    if (!providerAdapter || !connection) {
      const updated = await this.updateCalendarEventDoc(existing.id, {
        sync_status: 'provider_not_connected'
      })
      return {
        success: true,
        event: updated,
        sync: {
          attempted: false,
          connected: false,
          success: false,
          provider: localUpdated.provider,
          reason: 'provider_not_connected',
          error: null
        }
      }
    }

    const ensured = await ensureCalendarProviderAccessToken({ db: this.db, provider: providerAdapter, connection })
    if (!ensured.success) {
      const updated = await this.updateCalendarEventDoc(existing.id, {
        sync_status: 'token_unavailable',
        sync_error: ensured.error || null
      })
      return {
        success: true,
        event: updated,
        sync: {
          attempted: true,
          connected: true,
          success: false,
          provider: localUpdated.provider,
          reason: 'token_unavailable',
          error: ensured.error || null
        }
      }
    }

    const syncResult = await providerAdapter.updateEvent({
      accessToken: ensured.accessToken,
      connection: ensured.connection,
      eventId: localUpdated.external_event_id,
      eventInput: this.toProviderEventInput(localUpdated)
    })

    if (!syncResult.ok) {
      const updated = await this.updateCalendarEventDoc(existing.id, {
        sync_status: 'sync_failed',
        sync_error: syncResult.error || null
      })
      return {
        success: true,
        event: updated,
        sync: {
          attempted: true,
          connected: true,
          success: false,
          provider: localUpdated.provider,
          reason: 'sync_failed',
          error: syncResult.error || null
        }
      }
    }

    const updated = await this.updateCalendarEventDoc(existing.id, {
      external_event_link: syncResult.event_link || localUpdated.external_event_link || null,
      sync_status: 'synced',
      sync_error: null
    })
    return {
      success: true,
      event: updated,
      sync: {
        attempted: true,
        connected: true,
        success: true,
        provider: localUpdated.provider,
        reason: 'synced',
        error: null
      }
    }
  }

  async deleteEvent({ userKey, eventId } = {}) {
    const existing = await this.findCalendarEventDoc(userKey, eventId)
    if (!existing) throw new Error('Calendar event not found')

    const marked = await this.updateCalendarEventDoc(existing.id, {
      status: 'deleted',
      deleted_at: new Date()
    })
    this.log('CRM event marked deleted', { event_id: existing.id, user_id: normalizeUserKey(userKey) })

    if (!marked?.provider || !marked?.external_event_id) {
      return {
        success: true,
        event: marked,
        sync: {
          attempted: false,
          connected: false,
          success: false,
          provider: marked?.provider || null,
          reason: 'not_linked',
          error: null
        }
      }
    }

    const providerAdapter = getCalendarProvider(marked.provider)
    const connection = await findCalendarConnection(this.db, userKey, marked.provider)
    if (!providerAdapter || !connection) {
      const updated = await this.updateCalendarEventDoc(existing.id, {
        sync_status: 'provider_not_connected'
      })
      return {
        success: true,
        event: updated,
        sync: {
          attempted: false,
          connected: false,
          success: false,
          provider: marked.provider,
          reason: 'provider_not_connected',
          error: null
        }
      }
    }

    const ensured = await ensureCalendarProviderAccessToken({ db: this.db, provider: providerAdapter, connection })
    if (!ensured.success) {
      const updated = await this.updateCalendarEventDoc(existing.id, {
        sync_status: 'token_unavailable',
        sync_error: ensured.error || null
      })
      return {
        success: true,
        event: updated,
        sync: {
          attempted: true,
          connected: true,
          success: false,
          provider: marked.provider,
          reason: 'token_unavailable',
          error: ensured.error || null
        }
      }
    }

    const syncResult = await providerAdapter.deleteEvent({
      accessToken: ensured.accessToken,
      connection: ensured.connection,
      eventId: marked.external_event_id
    })
    if (!syncResult.ok) {
      const updated = await this.updateCalendarEventDoc(existing.id, {
        sync_status: 'delete_failed',
        sync_error: syncResult.error || null
      })
      return {
        success: true,
        event: updated,
        sync: {
          attempted: true,
          connected: true,
          success: false,
          provider: marked.provider,
          reason: 'delete_failed',
          error: syncResult.error || null
        }
      }
    }

    const updated = await this.updateCalendarEventDoc(existing.id, {
      sync_status: 'deleted_synced',
      sync_error: null
    })
    return {
      success: true,
      event: updated,
      sync: {
        attempted: true,
        connected: true,
        success: true,
        provider: marked.provider,
        reason: 'deleted_synced',
        error: null
      }
    }
  }
}

function getAppOriginFromRequest(request) {
  const configuredOrigin = String(
    process.env.APP_BASE_URL ||
    process.env.BASE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    ''
  ).trim()

  if (configuredOrigin) {
    try {
      const parsedConfiguredOrigin = new URL(
        configuredOrigin.includes('://') ? configuredOrigin : `http://${configuredOrigin}`
      )
      if (parsedConfiguredOrigin.hostname === '0.0.0.0') {
        parsedConfiguredOrigin.hostname = 'localhost'
      }
      return parsedConfiguredOrigin.origin
    } catch (_) {
      // Fallback to request URL origin below.
    }
  }

  const url = new URL(request.url)
  if (url.hostname === '0.0.0.0') {
    url.hostname = 'localhost'
  }
  return `${url.protocol}//${url.host}`
}

function buildCalendarRedirectResponse(request, returnTo = '/', params = {}) {
  const destination = buildReturnPathWithParams(returnTo, params)
  return NextResponse.redirect(`${getAppOriginFromRequest(request)}${destination}`)
}

async function getCalendarStatusPayload(db, request) {
  const auth = getRequestAuthContext(request)
  const userKey = auth.userKey
  const statuses = []
  for (const providerId of CALENDAR_PROVIDER_IDS) {
    const provider = getCalendarProvider(providerId)
    const connection = await findCalendarConnection(db, userKey, providerId)
    statuses.push(getCalendarConnectionPublicStatus(connection, providerId, provider?.isConfigured()))
  }
  const connectedProviders = statuses.filter((entry) => entry.connected).map((entry) => entry.provider)
  const configuredProviders = statuses.filter((entry) => entry.configured).map((entry) => entry.provider)

  return {
    success: true,
    connected: connectedProviders.length > 0,
    configured: configuredProviders.length > 0,
    connected_providers: connectedProviders,
    configured_providers: configuredProviders,
    providers: statuses
  }
}

async function startCalendarConnectFlow(request, providerId) {
  const provider = getCalendarProvider(providerId)
  const url = new URL(request.url)
  const auth = getRequestAuthContext(request)
  const returnTo = sanitizeReturnPath(url.searchParams.get('returnTo') || '/?tab=transactions')
  const userKey = normalizeUserKey(url.searchParams.get('user_key') || auth.userKey)

  if (!provider) {
    return buildCalendarRedirectResponse(request, returnTo, {
      calendar: 'unknown_provider',
      calendar_provider: String(providerId || '')
    })
  }
  if (!provider.isConfigured()) {
    return buildCalendarRedirectResponse(request, returnTo, {
      calendar: 'missing_config',
      calendar_provider: provider.providerId
    })
  }

  const state = createCalendarOAuthState({ userKey, provider: provider.providerId, returnTo })
  if (!state) {
    return buildCalendarRedirectResponse(request, returnTo, {
      calendar: 'state_unavailable',
      calendar_provider: provider.providerId
    })
  }

  const authUrl = provider.connect({ state })
  return NextResponse.redirect(authUrl)
}

async function finishCalendarConnectFlow({ db, request, providerId }) {
  const provider = getCalendarProvider(providerId)
  const url = new URL(request.url)
  const state = String(url.searchParams.get('state') || '')
  const verified = verifyCalendarOAuthState(state, providerId)
  const returnTo = verified?.returnTo || '/?tab=transactions'
  const callbackReturnTo = returnTo

  if (!provider) {
    return buildCalendarRedirectResponse(request, callbackReturnTo, {
      calendar: 'unknown_provider',
      calendar_provider: String(providerId || '')
    })
  }
  if (!provider.isConfigured()) {
    return buildCalendarRedirectResponse(request, callbackReturnTo, {
      calendar: 'missing_config',
      calendar_provider: provider.providerId
    })
  }
  if (!verified?.userKey || verified.provider !== provider.providerId) {
    return buildCalendarRedirectResponse(request, callbackReturnTo, {
      calendar: 'invalid_state',
      calendar_provider: provider.providerId
    })
  }

  const oauthError = url.searchParams.get('error')
  if (oauthError) {
    return buildCalendarRedirectResponse(request, callbackReturnTo, {
      calendar: 'oauth_denied',
      calendar_provider: provider.providerId,
      calendar_error: oauthError
    })
  }

  const code = String(url.searchParams.get('code') || '').trim()
  if (!code) {
    return buildCalendarRedirectResponse(request, callbackReturnTo, {
      calendar: 'missing_code',
      calendar_provider: provider.providerId
    })
  }

  try {
    await provider.callback({ db, userKey: verified.userKey, code })
    const normalizedUser = normalizeUserKey(verified.userKey)
    if (isCalendarSqlStorageEnabled()) {
      await pgPool.query(
        `DELETE FROM calendar_connections WHERE user_id = $1 AND provider <> $2`,
        [normalizedUser, provider.providerId]
      )
    } else {
      await db.collection(CALENDAR_CONNECTIONS_COLLECTION).deleteMany({
        user_id: normalizedUser,
        provider: { $ne: provider.providerId }
      })
    }
    console.log('[CalendarService] Enforced single provider connection for user', {
      user_id: normalizedUser,
      provider: provider.providerId
    })
    return buildCalendarRedirectResponse(request, callbackReturnTo, {
      calendar: 'connected',
      calendar_provider: provider.providerId
    })
  } catch (error) {
    console.error(`Calendar callback error (${provider.providerId}):`, error)
    return buildCalendarRedirectResponse(request, callbackReturnTo, {
      calendar: 'connect_failed',
      calendar_provider: provider.providerId,
      calendar_error: String(error?.message || 'unknown_error')
    })
  }
}

function baseCalendarSyncResult(overrides = {}) {
  return {
    attempted: false,
    connected: false,
    success: false,
    partial_success: false,
    reason: 'not_attempted',
    providers: [],
    event_link: null,
    quick_add_url: null,
    ...overrides
  }
}

function summarizeProviderResults(results = []) {
  const attempted = results.filter((entry) => entry.attempted)
  const successful = results.filter((entry) => entry.success)
  const failed = results.filter((entry) => entry.attempted && !entry.success)
  const firstEvent = successful.find((entry) => entry.event_link)
  const firstQuickAdd = results.find((entry) => entry.quick_add_url)
  const errors = failed.map((entry) => entry.error).filter(Boolean)

  return {
    success: attempted.length > 0 && failed.length === 0 && successful.length === attempted.length,
    partial_success: successful.length > 0 && failed.length > 0,
    event_link: firstEvent?.event_link || null,
    quick_add_url: firstQuickAdd?.quick_add_url || null,
    error: errors.length ? errors.join('; ') : null
  }
}

async function syncTransactionCalendarUpsert({ db, request, transaction }) {
  const auth = getRequestAuthContext(request)
  const userKey = auth.userKey
  const closingDate = toDateOnlyString(transaction?.closing_date)
  const connections = await listCalendarConnections(db, userKey)

  if (!connections.length) {
    return baseCalendarSyncResult({
      reason: 'calendar_not_connected',
      quick_add_url: buildGoogleCalendarTemplateUrl(transaction, closingDate)
    })
  }

  const eventInput = closingDate ? buildTransactionCalendarEventInput(transaction, closingDate) : null
  const providerResults = []

  for (const connection of connections) {
    const providerId = normalizeCalendarProvider(connection?.provider)
    const provider = getCalendarProvider(providerId)
    if (!provider) continue
    const quickAddUrl = buildProviderQuickAddUrl(providerId, transaction, closingDate)

    if (!provider.isConfigured()) {
      providerResults.push({
        provider: providerId,
        attempted: false,
        success: false,
        reason: 'provider_not_configured',
        quick_add_url: quickAddUrl
      })
      continue
    }

    const record = await findCalendarEventRecord(db, {
      userKey,
      provider: providerId,
      transactionId: transaction?.id
    })

    if (!closingDate) {
      if (record?.external_event_id) {
        try {
          const ensured = await ensureCalendarProviderAccessToken({ db, provider, connection })
          if (ensured.success) {
            await provider.deleteEvent({
              accessToken: ensured.accessToken,
              connection: ensured.connection,
              eventId: record.external_event_id
            })
          }
        } catch (_) {
          // Best effort cleanup when closing date was removed.
        }
      }
      if (record?.id) await deleteCalendarEventRecord(db, record.id)
      providerResults.push({
        provider: providerId,
        attempted: Boolean(record),
        success: true,
        reason: 'closing_date_missing',
        quick_add_url: null
      })
      continue
    }

    let ensured
    try {
      ensured = await ensureCalendarProviderAccessToken({ db, provider, connection })
    } catch (error) {
      providerResults.push({
        provider: providerId,
        attempted: true,
        success: false,
        reason: 'token_refresh_failed',
        error: String(error?.message || error),
        quick_add_url: quickAddUrl
      })
      continue
    }

    if (!ensured.success) {
      providerResults.push({
        provider: providerId,
        attempted: true,
        success: false,
        reason: 'token_unavailable',
        error: ensured.error,
        quick_add_url: quickAddUrl
      })
      continue
    }

    try {
      if (record?.external_event_id) {
        let updateResult = await provider.updateEvent({
          accessToken: ensured.accessToken,
          connection: ensured.connection,
          eventId: record.external_event_id,
          eventInput
        })

        if (!updateResult.ok && updateResult.status === 404) {
          updateResult = await provider.createEvent({
            accessToken: ensured.accessToken,
            connection: ensured.connection,
            eventInput
          })
        }

        if (!updateResult.ok) {
          providerResults.push({
            provider: providerId,
            attempted: true,
            success: false,
            reason: 'event_update_failed',
            error: updateResult.error,
            quick_add_url: quickAddUrl
          })
          continue
        }

        await upsertCalendarEventRecord(db, {
          userKey,
          provider: providerId,
          transactionId: transaction?.id,
          externalEventId: updateResult.event_id || record.external_event_id,
          externalEventLink: updateResult.event_link || record.external_event_link || null
        })

        providerResults.push({
          provider: providerId,
          attempted: true,
          success: true,
          reason: 'event_updated',
          event_id: updateResult.event_id || record.external_event_id,
          event_link: updateResult.event_link || record.external_event_link || null,
          quick_add_url: null
        })
        continue
      }

      const createResult = await provider.createEvent({
        accessToken: ensured.accessToken,
        connection: ensured.connection,
        eventInput
      })

      if (!createResult.ok) {
        providerResults.push({
          provider: providerId,
          attempted: true,
          success: false,
          reason: 'event_create_failed',
          error: createResult.error,
          quick_add_url: quickAddUrl
        })
        continue
      }

      await upsertCalendarEventRecord(db, {
        userKey,
        provider: providerId,
        transactionId: transaction?.id,
        externalEventId: createResult.event_id,
        externalEventLink: createResult.event_link
      })

      providerResults.push({
        provider: providerId,
        attempted: true,
        success: true,
        reason: 'event_created',
        event_id: createResult.event_id || null,
        event_link: createResult.event_link || null,
        quick_add_url: null
      })
    } catch (error) {
      providerResults.push({
        provider: providerId,
        attempted: true,
        success: false,
        reason: 'unexpected_error',
        error: String(error?.message || error),
        quick_add_url: quickAddUrl
      })
    }
  }

  const summary = summarizeProviderResults(providerResults)
  return baseCalendarSyncResult({
    attempted: providerResults.length > 0,
    connected: providerResults.length > 0,
    success: summary.success,
    partial_success: summary.partial_success,
    reason: summary.success ? 'synced' : (summary.partial_success ? 'partially_synced' : 'failed'),
    providers: providerResults,
    event_link: summary.event_link,
    quick_add_url: summary.quick_add_url,
    error: summary.error
  })
}

async function syncTransactionCalendarDelete({ db, request, transactionId }) {
  const auth = getRequestAuthContext(request)
  const userKey = auth.userKey
  const records = await listCalendarEventRecordsByTransaction(db, { userKey, transactionId })
  if (!records.length) {
    return baseCalendarSyncResult({
      reason: 'no_calendar_events',
      success: true
    })
  }

  const providerResults = []
  for (const record of records) {
    const providerId = normalizeCalendarProvider(record?.provider)
    const provider = getCalendarProvider(providerId)
    if (!provider) {
      await deleteCalendarEventRecord(db, record.id)
      providerResults.push({
        provider: providerId || 'unknown',
        attempted: false,
        success: true,
        reason: 'provider_missing'
      })
      continue
    }

    const connection = await findCalendarConnection(db, userKey, providerId)
    if (!connection) {
      await deleteCalendarEventRecord(db, record.id)
      providerResults.push({
        provider: providerId,
        attempted: false,
        success: true,
        reason: 'connection_missing'
      })
      continue
    }

    try {
      const ensured = await ensureCalendarProviderAccessToken({ db, provider, connection })
      if (!ensured.success) {
        await deleteCalendarEventRecord(db, record.id)
        providerResults.push({
          provider: providerId,
          attempted: true,
          success: false,
          reason: 'token_unavailable',
          error: ensured.error
        })
        continue
      }

      const result = await provider.deleteEvent({
        accessToken: ensured.accessToken,
        connection: ensured.connection,
        eventId: record.external_event_id
      })

      await deleteCalendarEventRecord(db, record.id)
      providerResults.push({
        provider: providerId,
        attempted: true,
        success: Boolean(result.ok),
        reason: result.ok ? 'event_deleted' : 'event_delete_failed',
        error: result.ok ? null : result.error
      })
    } catch (error) {
      await deleteCalendarEventRecord(db, record.id)
      providerResults.push({
        provider: providerId,
        attempted: true,
        success: false,
        reason: 'unexpected_error',
        error: String(error?.message || error)
      })
    }
  }

  const summary = summarizeProviderResults(providerResults)
  return baseCalendarSyncResult({
    attempted: true,
    connected: true,
    success: summary.success,
    partial_success: summary.partial_success,
    reason: summary.success ? 'deleted' : (summary.partial_success ? 'partially_deleted' : 'delete_failed'),
    providers: providerResults,
    error: summary.error
  })
}

// Lead deduplication check
async function checkDuplicateLead(db, email, phone) {
  const existingLead = await db.collection('leads').findOne({
    $or: [
      { email: email },
      { phone: phone }
    ]
  })
  return existingLead
}

async function generateLeadInsights(lead, properties = []) {
  const safeLead = lead && typeof lead === 'object' ? lead : {}
  const leadName = safeLead.name || 'Unknown Lead'
  const leadType = String(safeLead?.lead_type || '').toLowerCase()

  // Seller: provide valuation/pricing/listing-prep insights. Do NOT fetch listings.
  if (leadType === 'seller') {
    const prefs = safeLead?.preferences || {}
    const sellerAddress = prefs.seller_address || prefs.address || null
    const sellerPrice = prefs.seller_price ?? prefs.asking_price ?? null
    // Normalize seller detail fields so the AI has explicit structured facts
    const sellerDetails = {
      address: sellerAddress || null,
      asking_price: sellerPrice,
      property_type: prefs.seller_property_type ?? prefs.property_type ?? null,
      bedrooms: prefs.seller_bedrooms ?? prefs.bedrooms ?? null,
      bathrooms: prefs.seller_bathrooms ?? prefs.bathrooms ?? null,
      year_built: prefs.seller_year_built ?? prefs.year_built ?? null,
      square_feet: prefs.seller_square_feet ?? prefs.square_feet ?? null,
      lot_size: prefs.seller_lot_size ?? prefs.lot_size ?? null,
      condition: prefs.seller_condition ?? prefs.condition ?? null,
      occupancy: prefs.seller_occupancy ?? prefs.occupancy ?? null,
      timeline_to_list: prefs.seller_timeline ?? prefs.timeline ?? null,
      hoa_fee_monthly: prefs.seller_hoa_fee ?? prefs.hoa_fee ?? null,
      notes: prefs.seller_description ?? prefs.notes ?? null,
      zipcode: prefs.zipcode ?? null
    }

    const messages = [
      {
        role: "system",
        content: "You are a precise real estate listing advisor. For seller leads, provide valuation context, pricing strategy, listing preparation guidance, and next steps. Do NOT recommend purchase listings. Keep it concise and actionable."
      },
      {
        role: "user",
        content: `Lead: ${leadName} (seller)
Seller Details (structured JSON): ${JSON.stringify(sellerDetails)}

Instructions:
- Treat the Seller Details as ground truth; explicitly incorporate known facts (beds/baths, year, square feet, lot size, condition, occupancy, timeline, HOA fee, notes) into your assumptions and recommendations.
- Do NOT suggest properties to buy or include property listings.
- Provide a realistic valuation range with clear assumptions tied to the property's specifics and micro-location. If the address or zipcode is known, reflect that context without fabricating comps.
- Recommend a pricing strategy (e.g., list slightly below/at/above comps) and expected buyer response, referencing the property's condition, size, and occupancy where relevant.
- Provide a concise listing prep checklist tailored to the specifics (e.g., if condition is Good, focus on touch-ups; if Vacant, emphasize staging options; if HOA present, note disclosure items).
- Close with 2-3 concrete next steps for the agent with the seller.

Output (Markdown):
### AI Insights
- Valuation Range and Assumptions (reference relevant facts like beds/baths, year, sqft, lot size, condition)
- Pricing Strategy and Rationale (tie to demand for the given property type/size and occupancy)
- Listing Preparation Checklist (tailored to the provided details)
### Next Steps
- Action 1
- Action 2
${sellerAddress ? '- Suggest obtaining a CMA for the specific address.' : ''}`
      }
    ]

    return await callOpenAI('gpt-4o-mini', messages)
  }

  // Buyer (default): use existing property matching logic.
  // Pull real inventory using lead preferences if properties not provided
  let fetchedProps = properties
  try {
    if (!Array.isArray(fetchedProps) || fetchedProps.length === 0) {
      const filters = mapLeadPreferencesToFilters(safeLead?.preferences || {})
      const res = await fetchProperties(filters)
      fetchedProps = res?.properties || []

      // Apply strict filtering to align with constraints
      const desiredZip = filters.location ? String(filters.location).slice(0, 5) : null
      const minBeds = filters.beds ? Number(filters.beds) : null
      const minBaths = filters.baths ? Number(filters.baths) : null
      const minPrice = filters.min_price ? Number(filters.min_price) : null
      const maxPrice = filters.max_price ? Number(filters.max_price) : null

      fetchedProps = fetchedProps.filter(p => {
        if (desiredZip && String(p.zipcode || '').slice(0, 5) !== desiredZip) return false
        if (minBeds !== null && !(typeof p.bedrooms === 'number' && p.bedrooms >= minBeds)) return false
        if (minBaths !== null && !(typeof p.bathrooms === 'number' && p.bathrooms >= minBaths)) return false
        if (minPrice !== null || maxPrice !== null) {
          if (typeof p.price !== 'number') return false
          if (minPrice !== null && p.price < minPrice) return false
          if (maxPrice !== null && p.price > maxPrice) return false
        }
        return true
      })
    }
  } catch (e) {
    console.warn('generateLeadInsights property fetch/filter failed, continuing with provided properties.', e)
  }

  const topProps = Array.isArray(fetchedProps) ? fetchedProps.slice(0, 5) : []

  const messages = [
    {
      role: "system",
      content: "You are a precise real estate matching expert. Only recommend properties that satisfy the lead's stated constraints. If none satisfy, say so and suggest adjustments."
    },
    {
      role: "user",
      content: `Lead: ${leadName} (${leadType || 'buyer'})
      Preferences: ${JSON.stringify(safeLead.preferences || {})}
      Candidate Properties (up to 5): ${JSON.stringify(topProps)}

      Rules:
      - Only select properties that meet min bedrooms, min bathrooms, and price range when these are provided.
      - If zipcode is specified, only consider that zipcode.
      - Do not include properties with unknown values for required constraints.
      - If no properties meet constraints, clearly state none match and propose specific, practical adjustments.

      Output (Markdown):
      ### AI Insights
      1) For each of the top 3 matches, show:
         - Address
         - Price (USD, commas)
         - Bedrooms / Bathrooms
         - Reason for Match (explicitly reference how it meets the constraints)
      ### Summary
      - Brief recap of how matches satisfy the constraints.
      ### Next Steps
      - 2-3 concise actions for the agent.`
    }
  ]

  return await callOpenAI('gpt-4o-mini', messages)
}

// OPTIONS handler for CORS
export async function OPTIONS() {
  return handleCORS(new NextResponse(null, { status: 200 }))
}

// Route handler function
async function handleRoute(request, { params }) {
  const { path = [] } = params
  const route = `/${path.join('/')}`
  const method = request.method
  requestScopeStorage.enterWith({ userKey: getRequestAuthContext(request).userKey })

  try {
    if (route === '/health/db' && method === 'GET') {
      try {
        await connectToMongo()
        return handleCORS(NextResponse.json({
          success: true,
          db: getDbRuntimeStatus()
        }))
      } catch (error) {
        const code = String(error?.code || 'DB_UNAVAILABLE')
        const status = code === 'DB_CONFIG_MISSING' ? 500 : 503
        return handleCORS(NextResponse.json({
          success: false,
          error: String(error?.message || 'Database unavailable'),
          code,
          db: getDbRuntimeStatus()
        }, { status }))
      }
    }

    const db = await connectToMongo()

    // Root endpoint
    if (route === '/' && method === 'GET') {
      return handleCORS(NextResponse.json({ message: "Real Estate CRM API" }))
    }

    // CALENDAR PROVIDERS (provider-agnostic API)
    if (route === '/calendar/providers' && method === 'GET') {
      const providers = listCalendarProviderMetas()
      return handleCORS(NextResponse.json({
        success: true,
        providers
      }))
    }

    if (route === '/calendar/status' && method === 'GET') {
      try {
        const payload = await getCalendarStatusPayload(db, request)
        return handleCORS(NextResponse.json(payload))
      } catch (error) {
        console.error('Calendar status error:', error)
        return handleCORS(NextResponse.json({
          success: false,
          error: 'Failed to fetch calendar status'
        }, { status: 500 }))
      }
    }

    if (route === '/calendar/connect' && method === 'GET') {
      const url = new URL(request.url)
      const rawProvider = String(url.searchParams.get('provider') || '').trim()
      if (!rawProvider) {
        return handleCORS(NextResponse.json({
          success: false,
          error: 'provider query parameter is required'
        }, { status: 400 }))
      }
      const provider = normalizeCalendarProvider(rawProvider)
      if (!provider) {
        return handleCORS(NextResponse.json({
          success: false,
          error: 'Unsupported calendar provider'
        }, { status: 400 }))
      }
      return startCalendarConnectFlow(request, provider)
    }

    if (route.match(/^\/calendar\/[^\/]+\/callback$/) && method === 'GET') {
      const provider = normalizeCalendarProvider(path[1])
      return finishCalendarConnectFlow({ db, request, providerId: provider })
    }

    if (route.match(/^\/calendar\/callback\/[^\/]+$/) && method === 'GET') {
      const provider = normalizeCalendarProvider(path[2])
      return finishCalendarConnectFlow({ db, request, providerId: provider })
    }

    if (route === '/calendar/disconnect' && method === 'POST') {
      try {
        const auth = getRequestAuthContext(request)
        await deleteCalendarConnection(db, auth.userKey, null)
        await markCalendarEventsAsProviderDisconnected(db, {
          userKey: auth.userKey,
          provider: null
        })
        const payload = await getCalendarStatusPayload(db, request)
        return handleCORS(NextResponse.json(payload))
      } catch (error) {
        console.error('Calendar disconnect error:', error)
        return handleCORS(NextResponse.json({
          success: false,
          error: 'Failed to disconnect calendar'
        }, { status: 500 }))
      }
    }

    if (route === '/calendar/create' && method === 'POST') {
      try {
        const auth = getRequestAuthContext(request)
        const body = await request.json().catch(() => ({}))
        const calendarService = new CalendarService({ db, logger: console })
        const result = await calendarService.createEvent({
          userKey: auth.userKey,
          event: {
            title: body?.title || body?.summary || '',
            description: body?.description || '',
            location: body?.location || '',
            attendees: Array.isArray(body?.attendees) ? body.attendees : [],
            start_time: body?.start_time || body?.start || body?.start_date,
            end_time: body?.end_time || body?.end || body?.end_date
          },
          source: {
            type: body?.source_type || 'manual',
            id: body?.source_id || null,
            transaction_id: body?.transaction_id || null
          }
        })
        return handleCORS(NextResponse.json({
          success: true,
          event: result.event,
          sync: result.sync
        }))
      } catch (error) {
        console.error('Calendar create error:', error)
        return handleCORS(NextResponse.json({
          success: false,
          error: String(error?.message || 'Failed to create calendar event')
        }, { status: 400 }))
      }
    }

    if (route === '/calendar/update' && method === 'POST') {
      try {
        const auth = getRequestAuthContext(request)
        const body = await request.json().catch(() => ({}))
        const eventId = String(body?.event_id || '').trim()
        if (!eventId) {
          return handleCORS(NextResponse.json({
            success: false,
            error: 'event_id is required'
          }, { status: 400 }))
        }
        const calendarService = new CalendarService({ db, logger: console })
        const result = await calendarService.updateEvent({
          userKey: auth.userKey,
          eventId,
          updates: {
            title: body?.title,
            description: body?.description,
            location: body?.location,
            attendees: body?.attendees,
            start_time: body?.start_time,
            end_time: body?.end_time
          }
        })
        return handleCORS(NextResponse.json({
          success: true,
          event: result.event,
          sync: result.sync
        }))
      } catch (error) {
        console.error('Calendar update error:', error)
        const status = /not found/i.test(String(error?.message || '')) ? 404 : 400
        return handleCORS(NextResponse.json({
          success: false,
          error: String(error?.message || 'Failed to update calendar event')
        }, { status }))
      }
    }

    if (route === '/calendar/delete' && method === 'POST') {
      try {
        const auth = getRequestAuthContext(request)
        const body = await request.json().catch(() => ({}))
        const eventId = String(body?.event_id || '').trim()
        if (!eventId) {
          return handleCORS(NextResponse.json({
            success: false,
            error: 'event_id is required'
          }, { status: 400 }))
        }
        const calendarService = new CalendarService({ db, logger: console })
        const result = await calendarService.deleteEvent({
          userKey: auth.userKey,
          eventId
        })
        return handleCORS(NextResponse.json({
          success: true,
          event: result.event,
          sync: result.sync
        }))
      } catch (error) {
        console.error('Calendar delete error:', error)
        const status = /not found/i.test(String(error?.message || '')) ? 404 : 400
        return handleCORS(NextResponse.json({
          success: false,
          error: String(error?.message || 'Failed to delete calendar event')
        }, { status }))
      }
    }

    // GOOGLE CALENDAR OAUTH
    if (route === '/google/status' && method === 'GET') {
      try {
        const payload = await getCalendarStatusPayload(db, request)
        const googleStatus = Array.isArray(payload?.providers)
          ? payload.providers.find((entry) => entry.provider === CALENDAR_PROVIDER_GOOGLE)
          : null
        return handleCORS(NextResponse.json({
          success: true,
          configured: Boolean(googleStatus?.configured),
          connected: Boolean(googleStatus?.connected),
          connected_email: googleStatus?.connected_email || null,
          expires_at: googleStatus?.expires_at || null,
          has_refresh_token: Boolean(googleStatus?.has_refresh_token),
          provider: CALENDAR_PROVIDER_GOOGLE
        }))
      } catch (error) {
        console.error('Google status error:', error)
        return handleCORS(NextResponse.json({
          success: false,
          error: 'Failed to fetch Google Calendar status'
        }, { status: 500 }))
      }
    }

    if (route === '/google/connect' && method === 'GET') {
      return startCalendarConnectFlow(request, CALENDAR_PROVIDER_GOOGLE)
    }

    if (route === '/google/callback' && method === 'GET') {
      return finishCalendarConnectFlow({ db, request, providerId: CALENDAR_PROVIDER_GOOGLE })
    }

    if (route === '/google/disconnect' && method === 'POST') {
      try {
        const auth = getRequestAuthContext(request)
        await markCalendarEventsAsProviderDisconnected(db, {
          userKey: auth.userKey,
          provider: CALENDAR_PROVIDER_GOOGLE
        })
        await deleteCalendarConnection(db, auth.userKey, CALENDAR_PROVIDER_GOOGLE)
        return handleCORS(NextResponse.json({
          success: true
        }))
      } catch (error) {
        console.error('Google disconnect error:', error)
        return handleCORS(NextResponse.json({
          success: false,
          error: 'Failed to disconnect Google Calendar'
        }, { status: 500 }))
      }
    }

    // LEADS ENDPOINTS
    
    // GET /api/leads - Get all leads with search
    if (route === '/leads' && method === 'GET') {
      const url = new URL(request.url)
      const search = url.searchParams.get('search')
      const leadType = url.searchParams.get('lead_type')
      
      let query = {}
      
      if (search) {
        query.$or = [
          { name: { $regex: search, $options: 'i' } },
          { email: { $regex: search, $options: 'i' } },
          { phone: { $regex: search, $options: 'i' } }
        ]
      }
      
      if (leadType) {
        query.lead_type = leadType
      }
      
      const leads = await db.collection('leads')
        .find(query)
        .sort({ created_at: -1 })
        .limit(100)
        .toArray()

      const cleanedLeads = leads.map(({ _id, ...rest }) => rest)
      return handleCORS(NextResponse.json(cleanedLeads))
    }

    // POST /api/leads - Create new lead
    if (route === '/leads' && method === 'POST') {
      const body = await request.json()
      
      if (!body.name || !body.email || !body.phone) {
        return handleCORS(NextResponse.json(
          { error: "Name, email, and phone are required" }, 
          { status: 400 }
        ))
      }

      // Check for duplicates
      const duplicate = await checkDuplicateLead(db, body.email, body.phone)
      if (duplicate) {
        return handleCORS(NextResponse.json(
          { error: "Lead with this email or phone already exists", existing_lead: duplicate.id }, 
          { status: 409 }
        ))
      }

      const lead = {
        id: uuidv4(),
        name: body.name,
        email: body.email,
        phone: body.phone,
        lead_type: body.lead_type || 'buyer',
        preferences: body.preferences || {},
        assigned_agent: body.assigned_agent || null,
        tags: body.tags || [],
        source: body.source || 'manual',
        status: 'new',
        created_at: new Date(),
        updated_at: new Date()
      }

      await db.collection('leads').insertOne(lead)
      
      // Generate AI insights
      const insights = await generateLeadInsights(lead)
      if (insights) {
        await db.collection('leads').updateOne(
          { id: lead.id },
          { $set: { ai_insights: insights, updated_at: new Date() } }
        )
        lead.ai_insights = insights
      }

      const { _id, ...cleanedLead } = lead
      return handleCORS(NextResponse.json(cleanedLead, { status: 201 }))
    }

    // GET /api/leads/:id - Get specific lead
    if (route.match(/^\/leads\/[^\/]+$/) && method === 'GET') {
      const leadId = path[1]
      const lead = await db.collection('leads').findOne({ id: leadId })
      
      if (!lead) {
        return handleCORS(NextResponse.json(
          { error: "Lead not found" }, 
          { status: 404 }
        ))
      }

      const { _id, ...cleanedLead } = lead
      return handleCORS(NextResponse.json(cleanedLead))
    }

    // PUT /api/leads/:id - Update lead
    if (route.match(/^\/leads\/[^\/]+$/) && method === 'PUT') {
      const leadId = path[1]
      const body = await request.json()
      
      const updateData = {
        ...body,
        updated_at: new Date()
      }
      delete updateData.id
      delete updateData.created_at

      const result = await db.collection('leads').updateOne(
        { id: leadId },
        { $set: updateData }
      )

      if (result.matchedCount === 0) {
        return handleCORS(NextResponse.json(
          { error: "Lead not found" }, 
          { status: 404 }
        ))
      }

      const updatedLead = await db.collection('leads').findOne({ id: leadId })
      const { _id, ...cleanedLead } = updatedLead
      return handleCORS(NextResponse.json(cleanedLead))
    }

    // DELETE /api/leads/:id - Delete lead
    if (route.match(/^\/leads\/[^\/]+$/) && method === 'DELETE') {
      const leadId = path[1]
      
      const result = await db.collection('leads').deleteOne({ id: leadId })
      
      if (result.deletedCount === 0) {
        return handleCORS(NextResponse.json(
          { error: "Lead not found" }, 
          { status: 404 }
        ))
      }

      return handleCORS(NextResponse.json({ message: "Lead deleted successfully" }))
    }

    // POST /api/leads/:id/match - AI-powered property matching
    if (route.match(/^\/leads\/[^\/]+\/match$/) && method === 'POST') {
      const leadId = path[1]
      const lead = await db.collection('leads').findOne({ id: leadId })
      
      if (!lead) {
        return handleCORS(NextResponse.json(
          { error: "Lead not found" }, 
          { status: 404 }
        ))
      }

      // If lead is a seller, skip property search and produce seller-focused insights
      const leadTypeForMatch = String(lead?.lead_type || '').toLowerCase()
      if (leadTypeForMatch === 'seller') {
        // Enrich seller preferences from transaction info if available
        const prefs = lead.preferences || {}
        const tx = lead.transaction_info || {}
        const enrichedPrefs = { ...prefs }
        if (!enrichedPrefs.seller_address && tx.property_address) {
          enrichedPrefs.seller_address = tx.property_address
        }
        if (enrichedPrefs.seller_price == null) {
          const txPrice = tx.listing_price ?? tx.asking_price ?? tx.price ?? null
          if (txPrice != null) enrichedPrefs.seller_price = txPrice
        }
        // Persist preference enrichment if changed
        try {
          if (JSON.stringify(enrichedPrefs) !== JSON.stringify(prefs)) {
            await db.collection('leads').updateOne(
              { id: leadId },
              { $set: { preferences: enrichedPrefs, updated_at: new Date() } }
            )
          }
        } catch (e) {
          console.warn('Failed to enrich seller preferences for lead', leadId, e)
        }
        const sellerLead = { ...lead, preferences: enrichedPrefs }
        // Generate seller-specific insights (no property suggestions)
        const insights = await generateLeadInsights(sellerLead, [])
        // Persist insights
        try {
          await db.collection('leads').updateOne(
            { id: leadId },
            { $set: { ai_insights: insights, last_matched_at: new Date(), updated_at: new Date() } }
          )
        } catch (e) {
          console.warn('Failed to persist ai_insights for seller lead', leadId, e)
        }
        const updatedSellerLead = await db.collection('leads').findOne({ id: leadId })
        const { _id: _omit, ...cleanedSellerLead } = updatedSellerLead || {}
        return handleCORS(NextResponse.json({
          lead_id: leadId,
          properties: [],
          ai_recommendations: insights,
          total_found: 0,
          filters_applied: {},
          filter_policy: 'seller_no_search',
          updated_lead: cleanedSellerLead
        }))
      }

      // Search properties based on lead preferences (strict mapping)
      const filters = mapLeadPreferencesToFilters(lead.preferences || {})
      const propertySearchResult = await fetchProperties(filters)
      const properties = propertySearchResult?.properties || []

      // Apply strict, preference-aligned filtering so AI only sees valid candidates
      const desiredZip = filters.location ? String(filters.location).slice(0, 5) : null
      const minBeds = filters.beds ? Number(filters.beds) : null
      const minBaths = filters.baths ? Number(filters.baths) : null
      const minPrice = filters.min_price ? Number(filters.min_price) : null
      const maxPrice = filters.max_price ? Number(filters.max_price) : null

      function filterStrict(list) {
        return list.filter(p => {
          if (desiredZip && String(p.zipcode || '').slice(0, 5) !== desiredZip) return false
          if (minBeds !== null && !(typeof p.bedrooms === 'number' && p.bedrooms >= minBeds)) return false
          if (minBaths !== null && !(typeof p.bathrooms === 'number' && p.bathrooms >= minBaths)) return false
          if (minPrice !== null || maxPrice !== null) {
            if (typeof p.price !== 'number') return false
            if (minPrice !== null && p.price < minPrice) return false
            if (maxPrice !== null && p.price > maxPrice) return false
          }
          return true
        })
      }

      // Progressive relaxation in case of zero strict matches
      let matchingPool = filterStrict(properties)
      let filterPolicy = 'strict'

      if (matchingPool.length === 0) {
        // Allow unknown baths
        matchingPool = properties.filter(p => {
          if (desiredZip && String(p.zipcode || '').slice(0, 5) !== desiredZip) return false
          if (minBeds !== null && !(typeof p.bedrooms === 'number' && p.bedrooms >= minBeds)) return false
          if (minPrice !== null || maxPrice !== null) {
            if (typeof p.price !== 'number') return false
            if (minPrice !== null && p.price < minPrice) return false
            if (maxPrice !== null && p.price > maxPrice) return false
          }
          return true
        })
        if (matchingPool.length > 0) filterPolicy = 'relaxed:allow_unknown_baths'
      }

      if (matchingPool.length === 0) {
        // Allow unknown beds too
        matchingPool = properties.filter(p => {
          if (desiredZip && String(p.zipcode || '').slice(0, 5) !== desiredZip) return false
          if (minBaths !== null && !(typeof p.bathrooms === 'number' && p.bathrooms >= minBaths)) return false
          if (minPrice !== null || maxPrice !== null) {
            if (typeof p.price !== 'number') return false
            if (minPrice !== null && p.price < minPrice) return false
            if (maxPrice !== null && p.price > maxPrice) return false
          }
          return true
        })
        if (matchingPool.length > 0) filterPolicy = 'relaxed:allow_unknown_beds_baths'
      }

      if (matchingPool.length === 0 && (minPrice !== null || maxPrice !== null)) {
        // Expand price by ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â±10%
        const adjMin = minPrice !== null ? Math.floor(minPrice * 0.9) : null
        const adjMax = maxPrice !== null ? Math.ceil(maxPrice * 1.1) : null
        matchingPool = properties.filter(p => {
          if (desiredZip && String(p.zipcode || '').slice(0, 5) !== desiredZip) return false
          if (minBeds !== null && typeof p.bedrooms === 'number' && p.bedrooms < minBeds) return false
          if (minBaths !== null && typeof p.bathrooms === 'number' && p.bathrooms < minBaths) return false
          if (typeof p.price !== 'number') return false
          if (adjMin !== null && p.price < adjMin) return false
          if (adjMax !== null && p.price > adjMax) return false
          return true
        })
        if (matchingPool.length > 0) filterPolicy = 'relaxed:price_10pct'
      }

      // Final fallback to original list to avoid empty UX (AI will explicitly state mismatch)
      if (matchingPool.length === 0) {
        matchingPool = properties
        filterPolicy = 'fallback:unfiltered'
      }
      
      // Generate AI matching insights
      const matchingInsights = await callOpenAI('o1-mini', [
        {
          role: "system",
          content: "You are a precise real estate matching expert. Only recommend properties that satisfy the lead's stated constraints. If none satisfy, say so and suggest adjustments."
        },
        {
          role: "user",
          content: `Lead: ${lead.name} (${lead.lead_type})
          Preferences: ${JSON.stringify(lead.preferences)}
          Applied Filters (strict): ${JSON.stringify(filters)}
          Candidate Properties (post-filter, up to 5): ${JSON.stringify(matchingPool.slice(0, 5))}
          Filter Policy Used: ${filterPolicy}

          Rules:
          - Only select properties that meet min bedrooms, min bathrooms, and price range when these are provided.
          - If zipcode is specified, only consider that zipcode.
          - Do not include properties with unknown values for required constraints.
          - If no properties meet constraints, clearly state none match and propose specific, practical adjustments.

          Output (Markdown):
          ### AI Insights
          1) For each of the top 3 matches, show:
             - Address
             - Price (USD, commas)
             - Bedrooms / Bathrooms
             - Reason for Match (explicitly reference how it meets the constraints)
          ### Summary
          - Brief recap of how matches satisfy the constraints. If Filter Policy is not 'strict', briefly note what was relaxed.
          ### Next Steps
          - 2-3 concise actions for the agent.`
        }
      ])

      // Persist AI insights on the lead for display in UI
      try {
        await db.collection('leads').updateOne(
          { id: leadId },
          { $set: { ai_insights: matchingInsights, updated_at: new Date(), last_matched_at: new Date() } }
        )
      } catch (e) {
        console.warn('Failed to persist ai_insights for lead', leadId, e)
      }

      // Fetch updated lead without _id
      const updatedLeadDoc = await db.collection('leads').findOne({ id: leadId })
      const { _id: _throwaway, ...cleanedUpdatedLead } = updatedLeadDoc || {}

      return handleCORS(NextResponse.json({
        lead_id: leadId,
        properties: matchingPool.slice(0, 10),
        ai_recommendations: matchingInsights,
        total_found: properties.length,
        filters_applied: filters,
        filter_policy: filterPolicy,
        updated_lead: cleanedUpdatedLead
      }))
    }

    // PROPERTY SEARCH ENDPOINTS

    // GET /api/properties - Enhanced property search with comprehensive filters
    if (route === '/properties' && method === 'GET') {
      const url = new URL(request.url)
      const filters = {
        location: url.searchParams.get('location'),
        beds: url.searchParams.get('beds'),
        baths: url.searchParams.get('baths'),
        min_price: url.searchParams.get('min_price'),
        max_price: url.searchParams.get('max_price'),
        listing_status: url.searchParams.get('listing_status') || 'for_sale',
        property_type: url.searchParams.get('property_type'),
        sort_by: url.searchParams.get('sort_by'),
        limit: parseInt(url.searchParams.get('limit')) || 60,
        offset: parseInt(url.searchParams.get('offset')) || 0,
        // debug passthrough
        debug: url.searchParams.get('debug') === '1' || url.searchParams.get('debug') === 'true',
        include_raw: url.searchParams.get('include_raw') === '1' || url.searchParams.get('include_raw') === 'true'
      }
      
      // Remove null/undefined values
      Object.keys(filters).forEach(key => {
        if (filters[key] === null || filters[key] === undefined || filters[key] === '') {
          delete filters[key]
        }
      })
      
      const result = await fetchProperties(filters)
      
      return handleCORS(NextResponse.json({
        success: true,
        ...result,
        search_performed_at: new Date().toISOString()
      }))
    }

    // POST /api/properties/search - Advanced property search with saved filters
    if (route === '/properties/search' && method === 'POST') {
      const body = await request.json()
      
      const filters = {
        location: body.location,
        beds: body.beds,
        baths: body.baths,
        min_price: body.min_price,
        max_price: body.max_price,
        listing_status: body.listing_status || 'for_sale',
        property_type: body.property_type,
        sort_by: body.sort_by || 'price_asc',
        limit: body.limit || 60,
        offset: body.offset || 0,
        // debug passthrough
        debug: !!body.debug,
        include_raw: !!body.include_raw
      }
      
      const result = await fetchProperties(filters)
      
      // Save search to database for analytics
      try {
        const searchRecord = {
          id: uuidv4(),
          filters: filters,
          results_count: result.total,
          timestamp: new Date(),
          user_agent: request.headers.get('user-agent')
        }
        
        await db.collection('property_searches').insertOne(searchRecord)
      } catch (error) {
        console.error('Failed to save search record:', error)
        // Don't fail the request if search logging fails
      }
      
      return handleCORS(NextResponse.json({
        success: true,
        ...result,
        search_performed_at: new Date().toISOString()
      }))
    }

    // GET /api/properties/:id - Get specific property details
    if (route.match(/^\/properties\/[^\/]+$/) && method === 'GET') {
      const propertyId = path[1]
      
      try {
        // In a real implementation, you'd fetch from RealEstateAPI by ID
        // For now, we'll use fallback data
        const mockProperty = {
          id: propertyId,
          address: '123 Property Street',
          city: 'Dallas',
          state: 'TX',
          zipcode: '75201',
          price: 450000,
          bedrooms: 3,
          bathrooms: 2.5,
          square_feet: 2200,
          property_type: 'Single Family',
          listing_status: 'for_sale',
          description: 'Beautiful family home with modern amenities and updates throughout.',
          images: [],
          listing_date: new Date().toISOString(),
          days_on_market: 15,
          mls_number: 'MLS123456',
          lot_size: '0.25 acres',
          year_built: 2018,
          garage: 2,
          pool: false,
          fireplace: true,
          agent_info: {
            name: 'Jane Smith',
            phone: '(555) 123-4567',
            email: 'jane@realestate.com'
          }
        }
        
        return handleCORS(NextResponse.json({
          success: true,
          property: mockProperty
        }))
      } catch (error) {
        console.error('Error fetching property details:', error)
        return handleCORS(NextResponse.json({
          success: false,
          error: 'Property not found'
        }, { status: 404 }))
      }
    }

    // ASSISTANT ENDPOINTS
    
    // POST /api/assistant/parse - Parse natural language input
    if (route === '/assistant/parse' && method === 'POST') {
      const body = await request.json()
      
      if (!body.message) {
        return handleCORS(NextResponse.json(
          { error: "Message is required" }, 
          { status: 400 }
        ))
      }

      try {
        const messages = [
          {
            role: "system",
            content: `You are a real estate assistant that extracts structured information from agent messages.
            
            Extract the following information from the agent's message and return it as JSON:
            {
              "lead_info": {
                "name": "extracted name or null",
                "phone": "extracted phone or null",
                "email": "extracted email or null",
                "lead_type": "buyer or seller (inferred from context)"
              },
              "preferences": {
                "zipcode": "extracted zipcode/area or null",
                "city": "extracted city or null",
                "state": "2-letter state code if present or null",
                "min_price": "minimum price or null",
                "max_price": "maximum price or null",
                "bedrooms": "number of bedrooms or null",
                "bathrooms": "number of bathrooms or null",
                "property_type": "extracted property type or null"
              },
              "transaction_info": {
                "property_address": "full address if provided or null",
                "transaction_type": "purchase | sale | lease | null",
                "price": "numeric price if stated (e.g. 500000) or null",
                "listing_price": "if explicitly a listing price, else null",
                "contract_price": "if explicitly a contract price, else null",
                "closing_date": "ISO date string if a closing date is mentioned, else null"
              },
              "intent": "one of: find_properties | create_lead | update_preferences | create_transaction | other",
              "summary": "brief summary of the request"
            }
            
            For property preferences:
            - Convert terms like "2BHK" to bedrooms: "2"
            - Convert "under $500K" to max_price: "500000"
            - Convert "above $300K" to min_price: "300000"
            - Extract city/area names and map to zipcodes if possible (Frisco->75034, Dallas->75201, etc)
            
            For transaction extraction:
            - Map phrases like "open a deal", "start a transaction", "create a transaction" to intent: "create_transaction"
            - Prefer a full street address for property_address if present; otherwise leave null
            - If lead_type is buyer and only one price is mentioned, map it to contract_price; if seller, map to listing_price
            - Parse closing dates (e.g., "Nov 1", "11/01", "in 30 days") to an ISO date string when possible
            
            Return only valid JSON, no other text.`
          },
          {
            role: "user",
            content: body.message
          }
        ]

        const response = await callOpenAI('gpt-4o-mini', messages, { maxTokens: 700, temperature: 0 })
        
        if (!response) {
          throw new Error('No response from OpenAI')
        }
        
        // Parse model response to JSON and return
        const parsed = parseAssistantJsonResponseSafe(response)
        if (!parsed) {
          console.warn('Assistant parse JSON error: using heuristic fallback. Raw:', response)
          return handleCORS(NextResponse.json({
            success: true,
            parsed_data: heuristicAssistantParseSafe(body.message),
            parse_fallback: 'heuristic'
          }))
        }

        return handleCORS(NextResponse.json({ success: true, parsed_data: parsed }))
      } catch (error) {
        console.error('Assistant parse error:', error)
        return handleCORS(NextResponse.json({
          success: false,
          error: 'Failed to parse message',
          details: error.message
        }, { status: 500 }))
      }
    }

    // POST /api/assistant/match - Match lead, search properties, optionally create transaction
    if (route === '/assistant/match' && method === 'POST') {
      try {
        const body = await request.json()
        let { parsed_data, original_message, agent_name, lead_id: incomingLeadId } = body

        // Allow flexible inputs from frontend: query/text/message/original_message
        let query = (body.query || body.text || body.message || original_message || '').toString()
        if (!original_message && query) original_message = query

        // AI Search bridge (optional): if AI_SEARCH_BASE_URL is set, route through Snaphomz-ai-search tool framework first.
        const skipAiSearchBridge =
          body?.skip_ai_search_bridge === true ||
          String(body?.skip_ai_search_bridge || '').toLowerCase() === 'true' ||
          request.headers.get('x-ai-search-bridge') === '1'

        const skipAiInsights =
          body?.skip_ai_insights === true ||
          String(body?.skip_ai_insights || '').toLowerCase() === 'true'

        const skipPropertySearch =
          body?.skip_property_search === true ||
          String(body?.skip_property_search || '').toLowerCase() === 'true'

        if (query && !skipAiSearchBridge) {
          try {
            const external = await tryAiSearchBridge({ query, sessionId: body.session_id || body.ai_session_id || null })
            if (external?.success) {
              return handleCORS(NextResponse.json(external))
            }
          } catch (bridgeError) {
            console.warn('AI Search bridge failed, falling back to CRM assistant:', bridgeError?.message || bridgeError)
          }
        }
        // Backward compatibility: if parsed_data missing, invoke the heavy parser internally
        if (!parsed_data && query) {
          try {
            const parseRes = await handleRoute(
              new Request(request.url, {
                method: 'POST',
                body: JSON.stringify({ message: query }),
                headers: { 'content-type': 'application/json' }
              }),
              { params: { path: ['assistant', 'parse'] } }
            )
            const parsedJson = await parseRes.json()
            if (parsedJson?.success && parsedJson.parsed_data) {
              parsed_data = parsedJson.parsed_data
            } else if (parsedJson?.parsed_data) {
              parsed_data = parsedJson.parsed_data
            }
          } catch (e) {
            console.warn('Fallback heavy parse failed:', e)
          }
        }

        // If still no parsed_data and also no query, return a gentle success with snapshot guidance
        if (!parsed_data && !query) {
          return handleCORS(NextResponse.json({
            success: true,
            intent: 'general.suggestions',
            answer: 'No message provided. Ask me about tasks, alerts, pipeline status, or say: "Just met Priya Sharma. 2BHK in Frisco under $500K."',
            summary: 'Awaiting input'
          }))
        }

        // Extract entities and enhance for seller detection
        let { lead_info = {}, preferences = {}, intent = '', summary = '', transaction_info = {} } = parsed_data || {}

        const wholeMessage = (original_message || query || '').toString()
        const lcWhole = wholeMessage.toLowerCase()
        const sellerHints = (
          /\bseller\b/.test(lcWhole) ||
          /\bsell(?:ing)?\b/.test(lcWhole) ||
          /\blist(?:ing)?\b/.test(lcWhole) ||
          /\basking\s+price\b/.test(lcWhole) ||
          /\bmy\s+(?:house|home|condo|apartment)\b/.test(lcWhole)
        )
        const explicitSellerFields = Boolean(
          (preferences && (preferences.seller_address || preferences.seller_price)) ||
          (transaction_info && (transaction_info.listing_price || transaction_info.property_address))
        )
        if (!lead_info.lead_type && (sellerHints || explicitSellerFields)) {
          lead_info.lead_type = 'seller'
        }

        function findLikelyPrice(text) {
          try {
            const t = String(text || '')
            const l = t.toLowerCase()
            const toNumber = (numStr, unit) => {
              let n = parseFloat(String(numStr).replace(/,/g, ''))
              const u = (unit || '').toLowerCase()
              if (u === 'm' || u === 'million') n *= 1_000_000
              else if (u === 'k' || u === 'thousand') n *= 1_000
              if (!isFinite(n)) return null
              return Math.round(n)
            }

            // 1) Strong signal: keywords near amount
            const kwRe = /(asking|ask|list(?:ing)?|price|offer|for)\s*[:\-]?\s*\$?\s*([0-9][\d,\.]*)\s*(m|million|k|thousand)?/i
            const kw = l.match(kwRe)
            if (kw) return toNumber(kw[2], kw[3])

            // 2) Dollar amounts anywhere
            const dollarRe = /\$\s*([0-9][\d,\.]*)\s*(m|million|k|thousand)?/ig
            let m2, best2 = 0
            while ((m2 = dollarRe.exec(l))) {
              const val = toNumber(m2[1], m2[2])
              if (val && val > best2) best2 = val
            }
            if (best2 >= 1000) return best2

            // 3) Number + unit like 500k, 1.2m
            const unitRe = /\b([0-9][\d,\.]*)\s*(m|million|k|thousand)\b/ig
            let m3, best3 = 0
            while ((m3 = unitRe.exec(l))) {
              const val = toNumber(m3[1], m3[2])
              if (val && val > best3) best3 = val
            }
            if (best3 >= 1000) return best3

            // 4) Fallback: choose a large standalone number not tied to beds/baths/sqft/year/lot/hoa
            const numRe = /\b([0-9][\d,\.]*)\b/g
            let m4, best4 = 0
            while ((m4 = numRe.exec(l))) {
              const start = m4.index
              const end = start + m4[0].length
              const ctx = l.slice(Math.max(0, start - 10), Math.min(l.length, end + 10))
              if (/(bed|br|bath|ba|sq\s?ft|sqft|square\s?feet|year|built|lot|hoa)/.test(ctx)) continue
              const val = toNumber(m4[1], null)
              if (val && val > best4) best4 = val
            }
            if (best4 >= 10000) return best4
            return null
          } catch { return null }
        }

        function extractSellerDetailsFromText(text) {
          const out = {}
          try {
            const t = String(text || '')
            const l = t.toLowerCase()
            // property type
            if (/\b(single[-\s]?family)\b/.test(l)) out.seller_property_type = 'single_family'
            else if (/\bcondo\b/.test(l)) out.seller_property_type = 'condo'
            else if (/\btown\s?house\b/.test(l)) out.seller_property_type = 'townhouse'
            else if (/\bmulti[-\s]?family\b/.test(l)) out.seller_property_type = 'multi_family'
            else if (/\bland\b/.test(l)) out.seller_property_type = 'land'

            // bedrooms / bathrooms
            const bed = l.match(/(\d+(?:\.5)?)\s*(?:bed(?:rooms?)?|br)\b/)
            if (bed) out.seller_bedrooms = Number(bed[1])
            const bath = l.match(/(\d+(?:\.5)?)\s*(?:bath(?:rooms?)?|ba)\b/)
            if (bath) out.seller_bathrooms = Number(bath[1])

            // year built
            const year = l.match(/\b(?:built|year)\D{0,6}(19\d{2}|20\d{2})\b/)
            if (year) out.seller_year_built = Number(year[1])

            // square feet
            const sqft = l.match(/(\d{3,5})\s*(?:sq\s?ft|sqft|square\s?feet)\b/)
            if (sqft) out.seller_square_feet = Number(sqft[1].replace(/,/g, ''))

            // lot size (sq ft or acres) with various phrasings
            // e.g., "lot size is 2400 sqft", "lot 0.25 acres", "lot size: 6,500"
            const lot1 = l.match(/\blot\s*size\s*(?:is|of|:|=)?\s*~?\s*([\d,\.]+)\s*(sq\s?ft|sqft|square\s?feet|acres?|ac)?\b/)
            const lot2 = l.match(/\blot\s*(?:is|size)?\s*~?\s*([\d,\.]+)\s*(sq\s?ft|sqft|square\s?feet|acres?|ac)\b/)
            const lot3 = l.match(/\b([\d,\.]+)\s*(sq\s?ft|sqft)\b[^\n]{0,15}\blot\b/)
            const lot = lot1 || lot2 || lot3
            if (lot) {
              const num = parseFloat(lot[1].replace(/,/g, ''))
              const unit = (lot[2] || 'sqft').toLowerCase()
              if (isFinite(num)) {
                out.seller_lot_size = unit.startsWith('ac') ? Math.round(num * 43560) : Math.round(num)
              }
            }

            // occupancy
            if (/owner[-\s]?occupied/.test(l) || /owner\b/.test(l)) out.seller_occupancy = 'owner'
            else if (/tenant\b/.test(l)) out.seller_occupancy = 'tenant'
            else if (/vacant\b/.test(l)) out.seller_occupancy = 'vacant'

            // condition
            if (/needs?\s+work/.test(l)) out.seller_condition = 'needs_work'
            else if (/\baverage\b/.test(l)) out.seller_condition = 'average'
            else if (/\bgood\b/.test(l)) out.seller_condition = 'good'
            else if (/\bexcellent\b/.test(l)) out.seller_condition = 'excellent'

            // timeline
            if (/\basap\b|\bimmediately\b|\bright away\b/.test(l)) out.seller_timeline = 'asap'
            else if (/(30|thirty)\s*[ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œ-]?\s*(60|sixty)\s*days/.test(l)) out.seller_timeline = '30_60'
            else if (/(60|sixty)\s*[ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œ-]?\s*(90|ninety)\s*days/.test(l)) out.seller_timeline = '60_90'
            else if (/(90|ninety)\+?\s*days/.test(l)) out.seller_timeline = '90_plus'

            // HOA
            const hoa = l.match(/\bhoa\b[^0-9$]{0,10}(?:fee|dues)?[^0-9$]{0,10}\$?\s*([\d,][\d,\.]*)/)
            if (hoa) {
              const n = parseFloat(String(hoa[1]).replace(/,/g, ''))
              if (isFinite(n)) out.seller_hoa_fee = Math.round(n)
            }

            // Asking price (avoid picking up bed/bath counts)
            const price = findLikelyPrice(t)
            if (price) out.seller_price = price

          } catch { /* ignore */ }
  return out
}

function parseAssistantJsonResponse(rawText = '') {
  const text = String(rawText || '').trim()
  if (!text) return null

  // 1) Direct parse
  try {
    return JSON.parse(text)
  } catch (_) {}

  // 2) Extract the outermost JSON object block
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) {
    const candidate = text.slice(first, last + 1)
    try {
      return JSON.parse(candidate)
    } catch (_) {
      // 3) Remove trailing commas and retry
      try {
        const cleaned = candidate.replace(/,\s*([}\]])/g, '$1')
        return JSON.parse(cleaned)
      } catch (_) {}
    }
  }

  return null
}

function heuristicAssistantParse(message = '') {
  const text = String(message || '')
  const lc = text.toLowerCase()

  const leadType = /\b(seller|selling|list(?:ing)?)\b/.test(lc) ? 'seller' : 'buyer'
  const nameMatch = text.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/)
  const zipMatch = text.match(/\b(\d{5})(?:-\d{4})?\b/)
  const bedMatch = lc.match(/(\d+(?:\.\d+)?)\s*(?:bhk|bed(?:room)?s?|br)\b/)
  const bathMatch = lc.match(/(\d+(?:\.\d+)?)\s*(?:bath(?:room)?s?|ba)\b/)
  const underPrice = lc.match(/\b(?:under|below|upto|up to|max(?:imum)?|<=?)\s*\$?\s*([\d,.]+)\s*(k|m|million|thousand)?\b/)
  const abovePrice = lc.match(/\b(?:above|over|at least|min(?:imum)?|>=?)\s*\$?\s*([\d,.]+)\s*(k|m|million|thousand)?\b/)
  const inCity = text.match(/\bin\s+([A-Za-z]+(?:\s+[A-Za-z]+){0,2})\b/i)
  const city = inCity ? inCity[1].trim() : null

  const toNumber = (raw, unit) => {
    if (!raw) return null
    const base = Number(String(raw).replace(/,/g, ''))
    if (!Number.isFinite(base)) return null
    const u = String(unit || '').toLowerCase()
    if (u === 'k' || u === 'thousand') return Math.round(base * 1000)
    if (u === 'm' || u === 'million') return Math.round(base * 1000000)
    return Math.round(base)
  }

  const parsed = {
    lead_info: {
      name: nameMatch ? nameMatch[1] : null,
      phone: null,
      email: null,
      lead_type: leadType
    },
    preferences: {
      zipcode: zipMatch ? zipMatch[1] : null,
      city: city,
      state: null,
      min_price: abovePrice ? toNumber(abovePrice[1], abovePrice[2]) : null,
      max_price: underPrice ? toNumber(underPrice[1], underPrice[2]) : null,
      bedrooms: bedMatch ? Number(bedMatch[1]) : null,
      bathrooms: bathMatch ? Number(bathMatch[1]) : null,
      property_type: null
    },
    transaction_info: {
      property_address: null,
      transaction_type: null,
      price: null,
      listing_price: null,
      contract_price: null,
      closing_date: null
    },
    intent: /\b(find|show|search|properties|listing)\b/.test(lc) ? 'find_properties' : 'other',
    summary: text.slice(0, 140) || 'Parsed from heuristic fallback'
  }

  return parsed
}

        if ((lead_info.lead_type || '').toLowerCase() === 'seller') {
          preferences = preferences || {}
          if (!preferences.seller_address && transaction_info?.property_address) {
            preferences.seller_address = transaction_info.property_address
          }
          if (preferences.seller_price == null) {
            const priceNum = typeof transaction_info?.listing_price === 'number' ? transaction_info.listing_price
              : (typeof transaction_info?.price === 'number' ? transaction_info.price : findLikelyPrice(wholeMessage))
            if (typeof priceNum === 'number' && isFinite(priceNum)) preferences.seller_price = priceNum
          }
        }

        // Step 1: Find or create lead (pre-lookup)
        let lead = null
        let isNewLead = false

        // If the frontend sent a specific lead_id, prefer it
        if (incomingLeadId) {
          try { lead = await db.collection('leads').findOne({ id: String(incomingLeadId) }) } catch (_) {}
        }

        const leadQuery = []
        if (lead_info.email) leadQuery.push({ email: lead_info.email })
        if (lead_info.phone) leadQuery.push({ phone: lead_info.phone })
        if (leadQuery.length) {
          lead = await db.collection('leads').findOne({ $or: leadQuery })
        }
        if (!lead && lead_info.name) {
          lead = await db.collection('leads').findOne({ name: { $regex: new RegExp(`^${lead_info.name}$`, 'i') } })
        }

        if (!lead && ((lead_info.name || lead_info.email || lead_info.phone) || (sellerHints || explicitSellerFields))) {
          const defaultName = lead_info.name || ((sellerHints || explicitSellerFields) ? 'Unknown Seller' : 'Unknown')
          const newLead = {
            id: uuidv4(),
            name: defaultName,
            email: lead_info.email || null,
            phone: lead_info.phone || null,
            lead_type: (lead_info.lead_type || (sellerHints || explicitSellerFields ? 'seller' : 'buyer')).toLowerCase(),
            preferences: preferences || {},
            assigned_agent: agent_name || null,
            source: 'assistant',
            tags: [],
            status: 'new',
            created_at: new Date(),
            updated_at: new Date()
          }

          await db.collection('leads').insertOne(newLead)
          lead = newLead
          isNewLead = true
        } else if (lead) {
          // ...
          const cleanPrefs = sanitizePreferences(preferences)
          if (Object.keys(cleanPrefs).length) {
            await db.collection('leads').updateOne(
              { id: lead.id },
              { $set: { preferences: { ...(lead.preferences || {}), ...cleanPrefs }, updated_at: new Date() } }
            )
            lead = await db.collection('leads').findOne({ id: lead.id })
          }
        }

        // Step 2: Determine effective preferences (incoming or stored)
        const cleanedIncoming = sanitizePreferences(preferences)
        const effectivePrefs = Object.keys(cleanedIncoming).length ? cleanedIncoming : (lead?.preferences || {})
        // Branch by lead type: sellers get insights (no listing search); buyers get property search
        const leadType = String(lead?.lead_type || lead_info?.lead_type || '').toLowerCase()
        let properties = []
        let filters = null
        if (leadType === 'seller') {
          // No property search for sellers. Ensure we capture seller-specific fields for insights.
          const prefsUpdate = {}
          if (transaction_info?.property_address && !effectivePrefs.seller_address && !effectivePrefs.address) {
            prefsUpdate.seller_address = transaction_info.property_address
          }
          if ((transaction_info?.listing_price || transaction_info?.price) && !effectivePrefs.seller_price && !effectivePrefs.asking_price) {
            const priceNum = typeof transaction_info.listing_price === 'number' ? transaction_info.listing_price
              : (typeof transaction_info.price === 'number' ? transaction_info.price : undefined)
            if (typeof priceNum === 'number') prefsUpdate.seller_price = priceNum
          }
          // Extract more seller fields from message text if missing
          const extracted = extractSellerDetailsFromText(wholeMessage)
          for (const [k, v] of Object.entries(extracted)) {
            if (v === undefined) continue
            const curr = effectivePrefs[k]
            const isMissing = (curr === undefined || curr === null || (typeof curr === 'string' && curr.trim() === ''))
            if (isMissing) {
              prefsUpdate[k] = v
              continue
            }
            // Corrections for clearly wrong values
            if (k === 'seller_price') {
              const currNum = Number(curr)
              const newNum = Number(v)
              if (Number.isFinite(newNum) && (Number.isNaN(currNum) || currNum < 1000)) {
                prefsUpdate[k] = newNum
              }
            } else if (k === 'seller_lot_size') {
              const currNum = Number(curr)
              const newNum = Number(v)
              // treat < 200 sqft as unrealistic/placeholder
              if (Number.isFinite(newNum) && (Number.isNaN(currNum) || currNum < 200)) {
                prefsUpdate[k] = newNum
              }
            } else if (k === 'seller_hoa_fee') {
              const currNum = Number(curr)
              const newNum = Number(v)
              if (Number.isFinite(newNum) && (Number.isNaN(currNum) || currNum <= 0 || currNum !== newNum)) {
                prefsUpdate[k] = newNum
              }
            }
          }
          if (Object.keys(prefsUpdate).length) {
            await db.collection('leads').updateOne(
              { id: lead.id },
              { $set: { preferences: { ...(lead.preferences || {}), ...prefsUpdate }, updated_at: new Date() } }
            )
            lead = await db.collection('leads').findOne({ id: lead.id })
          }
        } else {
          if (skipPropertySearch) {
            properties = []
            filters = mapLeadPreferencesToFilters(effectivePrefs)
          } else {
            filters = mapLeadPreferencesToFilters(effectivePrefs)
            const propertySearchResult = await searchProperties(filters)
            properties = Array.isArray(propertySearchResult)
              ? propertySearchResult
              : (propertySearchResult?.properties || [])
          }
        }

        // Step 3: Optionally create a transaction if requested
        const normalizedIntent = (intent || '').toString().toLowerCase()
        const isCreateTransaction = normalizedIntent.includes('create_transaction') ||
          (normalizedIntent.includes('create') && normalizedIntent.includes('transaction')) ||
          normalizedIntent.includes('open a deal') ||
          normalizedIntent.includes('start a transaction') ||
          normalizedIntent.includes('create deal')

        let createdTransaction = null
        if (isCreateTransaction && lead) {
          try {
            const txInfo = transaction_info || {}
            const resolvedType = txInfo.transaction_type || (lead.lead_type === 'buyer' ? 'purchase' : 'sale')
            const priceValue = typeof txInfo.price === 'number' ? txInfo.price : (typeof txInfo.price === 'string' ? parseFloat(txInfo.price.toString().replace(/[^0-9.]/g, '')) : undefined)
            const listingPrice = typeof txInfo.listing_price === 'number' ? txInfo.listing_price : (resolvedType === 'sale' ? priceValue : undefined)
            const contractPrice = typeof txInfo.contract_price === 'number' ? txInfo.contract_price : (resolvedType !== 'sale' ? priceValue : undefined)
            const closingDate = txInfo.closing_date ? new Date(txInfo.closing_date) : null

            const initialStage = (resolvedType === 'purchase') ? 'pre_approval' : 'pre_listing'
            const transactionDoc = {
              id: uuidv4(),
              lead_id: lead.id,
              property_address: txInfo.property_address || preferences?.zipcode || '',
              client_name: lead.name,
              client_email: lead.email,
              client_phone: lead.phone,
              transaction_type: resolvedType || 'sale',
              current_stage: initialStage,
              assigned_agent: agent_name || lead.assigned_agent || 'AI Assistant',
              listing_price: listingPrice,
              contract_price: contractPrice,
              closing_date: closingDate,
              add_to_calendar: false,
              created_at: new Date(),
              updated_at: new Date(),
              stage_history: [{
                stage: initialStage,
                entered_at: new Date(),
                status: 'active'
              }],
              source: 'assistant',
              original_message: original_message
            }

            await db.collection('transactions').insertOne(transactionDoc)
            await createDefaultChecklistItems(db, transactionDoc.id, initialStage, resolvedType)

            const { _id, ...cleanedTx } = transactionDoc
            createdTransaction = cleanedTx
          } catch (txErr) {
            console.error('Assistant create transaction error:', txErr)
          }
        }

        // Step 4: AI recommendations/confirmation
        let aiRecommendations = ''
        if (skipAiInsights) {
          aiRecommendations = 'Your request has been processed.'
        } else {
          try {
            if (leadType === 'seller') {
              // Seller-focused insights: valuation/pricing/listing-prep, no property suggestions
              aiRecommendations = await generateLeadInsights(lead, [])
            } else {
              // Buyer-focused insights that can leverage the found properties
              aiRecommendations = await generateLeadInsights(lead, properties)
            }
          } catch (e) {
            console.warn('AI recommendation generation failed:', e)
            aiRecommendations = 'Your request has been processed.'
          }
        }

        // Step 4b: Missing field detection for seller slot-filling
        let assistantAnswer = ''
        let missingFields = []
        if (leadType === 'seller') {
          const p = lead?.preferences || {}
          const requiredFirst = ['seller_address', 'seller_price']
          const secondary = ['seller_property_type', 'seller_bedrooms', 'seller_bathrooms']
          const optional = ['seller_year_built', 'seller_square_feet', 'seller_lot_size', 'seller_condition', 'seller_occupancy', 'seller_timeline', 'seller_hoa_fee']
          const all = [...requiredFirst, ...secondary, ...optional]
          for (const key of all) {
            const val = p[key]
            if (val === undefined || val === null || (typeof val === 'string' && val.trim() === '')) missingFields.push(key)
          }
          // Ask for up to 3 fields at a time, prioritize required + secondary
          const priorities = [...requiredFirst, ...secondary, ...optional]
          missingFields.sort((a, b) => priorities.indexOf(a) - priorities.indexOf(b))
          const askNow = missingFields.slice(0, 3)
          if (askNow.length > 0) {
            const pretty = (k) => k
              .replace(/^seller_/, '')
              .replace(/_/g, ' ')
              .replace(/\b\w/g, (c) => c.toUpperCase())
            assistantAnswer = `I saved the details I have. Could you share the following missing info to complete the seller profile: ${askNow.map(pretty).join(', ')}?`
          }
        }

        // Persist AI insights on the lead for UI display
        try {
          if (lead?.id && aiRecommendations) {
            await db.collection('leads').updateOne(
              { id: lead.id },
              { $set: { ai_insights: aiRecommendations, updated_at: new Date() } }
            )
          }
        } catch (e) {
          console.warn('Failed to persist ai_insights in assistant.match:', e)
        }

        // Step 5: Store conversation in chat history
        const conversationEntry = {
          id: uuidv4(),
          agent_message: original_message,
          parsed_data,
          lead_id: lead?.id || null,
          transaction_id: createdTransaction?.id || null,
          properties_found: properties.length,
          ai_response: aiRecommendations,
          created_at: new Date()
        }

        await db.collection('assistant_conversations').insertOne(conversationEntry)

        return handleCORS(NextResponse.json({
          success: true,
          lead: lead ? { ...lead, _id: undefined } : null,
          is_new_lead: isNewLead,
          created_transaction: createdTransaction || null,
          transaction_id: createdTransaction?.id || null,
          properties: properties.slice(0, 10),
          properties_count: properties.length,
          ai_recommendations: aiRecommendations,
          answer: assistantAnswer || undefined,
          require_more_details: Boolean(assistantAnswer),
          missing_fields: assistantAnswer ? missingFields : [],
          conversation_id: conversationEntry.id,
          summary: summary
        }))
      } catch (error) {
        console.error('Assistant match error:', error)
        return handleCORS(NextResponse.json({
          success: false,
          error: "Failed to process request",
          details: error.message
        }, { status: 500 }))
      }
    }
    
    // GET /api/assistant/conversations - Get conversation history
    if (route === '/assistant/conversations' && method === 'GET') {
      try {
        const conversations = await db.collection('assistant_conversations')
          .find({})
          .sort({ created_at: -1 })
          .limit(50)
          .toArray()

        const cleanedConversations = conversations.map(({ _id, ...rest }) => rest)
        
        return handleCORS(NextResponse.json(cleanedConversations))
      } catch (error) {
        console.error('Error fetching conversations:', error)
        return handleCORS(NextResponse.json(
          { error: "Failed to fetch conversations" }, 
          { status: 500 }
        ))
      }
    }

    // TRANSACTION & CHECKLIST ENDPOINTS
    
    // GET /api/transactions - Get all transactions
    if (route === '/transactions' && method === 'GET') {
      try {
        const url = new URL(request.url)
        const status = url.searchParams.get('status')
        const agent = url.searchParams.get('agent')
        const limit = parseInt(url.searchParams.get('limit')) || 50
        
        let query = {}
        if (status) query.status = status
        if (agent) query.assigned_agent = agent
        
        const transactions = await db.collection('transactions')
          .find(query)
          .sort({ created_at: -1 })
          .limit(limit)
          .toArray()

        const cleanedTransactions = transactions.map(({ _id, ...rest }) => rest)
        
        return handleCORS(NextResponse.json({
          success: true,
          transactions: cleanedTransactions,
          total: cleanedTransactions.length
        }))
      } catch (error) {
        console.error('Error fetching transactions:', error)
        return handleCORS(NextResponse.json({
          success: false,
          error: 'Failed to fetch transactions'
        }, { status: 500 }))
      }
    }

    // POST /api/transactions - Create new transaction
    if (route === '/transactions' && method === 'POST') {
      try {
        const body = await request.json()
        const closingDate = toDateOnlyString(body?.closing_date)
        const addToCalendar = Boolean(body?.add_to_calendar)
        
        if (!body.property_address || !body.client_name) {
          return handleCORS(NextResponse.json({
            success: false,
            error: "Property address and client name are required"
          }, { status: 400 }))
        }

        const txType = (body.transaction_type || 'sale').toLowerCase()
        const initialStage = txType === 'purchase' ? 'pre_approval' : 'pre_listing'
        const transaction = {
          id: uuidv4(),
          property_address: body.property_address,
          client_name: body.client_name,
          client_email: body.client_email,
          client_phone: body.client_phone,
          transaction_type: txType, // sale, purchase, lease
          current_stage: initialStage,
          assigned_agent: body.assigned_agent,
          listing_price: body.listing_price,
          contract_price: body.contract_price,
          closing_date: closingDate,
          add_to_calendar: addToCalendar,
          created_at: new Date(),
          updated_at: new Date(),
          stage_history: [{
            stage: initialStage,
            entered_at: new Date(),
            status: 'active'
          }]
        }

        await db.collection('transactions').insertOne(transaction)

        // Create default checklist items for the initial stage
        await createDefaultChecklistItems(db, transaction.id, initialStage, txType)

        let calendarSync = baseCalendarSyncResult({
          reason: 'not_attempted',
          quick_add_url: null
        })
        if (closingDate && addToCalendar) {
          try {
            const auth = getRequestAuthContext(request)
            const calendarService = new CalendarService({ db, logger: console })
            const endDate = addDaysToDateOnly(closingDate, 1) || closingDate
            const createResult = await calendarService.createEvent({
              userKey: auth.userKey,
              event: {
                title: buildTransactionCalendarSummary(transaction),
                description: buildTransactionCalendarDetails(transaction),
                location: transaction?.property_address || '',
                attendees: transaction?.client_email
                  ? [{ email: String(transaction.client_email).trim().toLowerCase(), name: transaction?.client_name || '' }]
                  : [],
                start_time: `${closingDate}T00:00:00.000Z`,
                end_time: `${endDate}T00:00:00.000Z`
              },
              source: {
                type: 'transaction',
                id: transaction.id,
                transaction_id: transaction.id
              }
            })

            const providerResult = createResult?.sync?.provider
              ? [{
                  provider: createResult.sync.provider,
                  attempted: Boolean(createResult.sync.attempted),
                  success: Boolean(createResult.sync.success),
                  reason: createResult.sync.reason || null,
                  error: createResult.sync.error || null,
                  event_id: createResult?.event?.external_event_id || null,
                  event_link: createResult?.event?.external_event_link || null
                }]
              : []
            const fallbackQuickAddUrl = buildProviderQuickAddUrl(
              createResult?.sync?.provider || null,
              transaction,
              closingDate
            )

            calendarSync = baseCalendarSyncResult({
              attempted: Boolean(createResult?.sync?.attempted),
              connected: Boolean(createResult?.sync?.connected),
              success: Boolean(createResult?.sync?.success),
              reason: createResult?.sync?.reason || 'sync_not_attempted',
              providers: providerResult,
              event_link: createResult?.event?.external_event_link || null,
              error: createResult?.sync?.error || null,
              quick_add_url: createResult?.sync?.success ? null : fallbackQuickAddUrl
            })
          } catch (calendarError) {
            console.error('Transaction calendar sync error:', calendarError)
            calendarSync = baseCalendarSyncResult({
              attempted: true,
              connected: true,
              reason: 'unexpected_error',
              error: String(calendarError?.message || 'Unexpected calendar sync error'),
              quick_add_url: null
            })
          }
        } else if (closingDate && !addToCalendar) {
          calendarSync = baseCalendarSyncResult({
            attempted: false,
            connected: false,
            success: false,
            reason: 'skipped_by_user',
            quick_add_url: null
          })
        }

        const { _id, ...cleanedTransaction } = transaction
        const googleProviderResult = Array.isArray(calendarSync?.providers)
          ? calendarSync.providers.find((entry) => entry.provider === CALENDAR_PROVIDER_GOOGLE)
          : null
        const legacyGoogleResult = googleProviderResult
          ? {
              attempted: Boolean(googleProviderResult.attempted),
              connected: true,
              success: Boolean(googleProviderResult.success),
              reason: googleProviderResult.reason || null,
              error: googleProviderResult.error || null,
              event_id: googleProviderResult.event_id || null,
              event_link: googleProviderResult.event_link || null,
              quick_add_url: googleProviderResult.quick_add_url || null
            }
          : {
              attempted: false,
              connected: false,
              success: false,
              reason: 'provider_not_connected',
              quick_add_url: calendarSync?.quick_add_url || null
            }
        return handleCORS(NextResponse.json({
          success: true,
          transaction: cleanedTransaction,
          calendar: calendarSync,
          google_calendar: legacyGoogleResult,
          quick_add_url: calendarSync?.quick_add_url || null
        }, { status: 201 }))
      } catch (error) {
        console.error('Error creating transaction:', error)
        return handleCORS(NextResponse.json({
          success: false,
          error: 'Failed to create transaction'
        }, { status: 500 }))
      }
    }

    // GET /api/transactions/:id - Get specific transaction
    if (route.match(/^\/transactions\/[^\/]+$/) && method === 'GET') {
      try {
        const transactionId = path[1]
        const transaction = await db.collection('transactions').findOne({ id: transactionId })
        
        if (!transaction) {
          return handleCORS(NextResponse.json({
            success: false,
            error: "Transaction not found"
          }, { status: 404 }))
        }

        const { _id, ...cleanedTransaction } = transaction
        return handleCORS(NextResponse.json({
          success: true,
          transaction: cleanedTransaction
        }))
      } catch (error) {
        console.error('Error fetching transaction:', error)
        return handleCORS(NextResponse.json({
          success: false,
          error: 'Failed to fetch transaction'
        }, { status: 500 }))
      }
    }

    // PUT /api/transactions/:id - Update transaction
    if (route.match(/^\/transactions\/[^\/]+$/) && method === 'PUT') {
      try {
        const transactionId = path[1]
        const body = await request.json()
        
        const updateData = {
          ...body,
          updated_at: new Date()
        }
        delete updateData.id
        delete updateData.created_at
        if (Object.prototype.hasOwnProperty.call(updateData, 'closing_date')) {
          updateData.closing_date = toDateOnlyString(updateData.closing_date)
        }

        const result = await db.collection('transactions').updateOne(
          { id: transactionId },
          { $set: updateData }
        )

        if (result.matchedCount === 0) {
          return handleCORS(NextResponse.json({
            success: false,
            error: "Transaction not found"
          }, { status: 404 }))
        }

        const updatedTransaction = await db.collection('transactions').findOne({ id: transactionId })
        const { _id, ...cleanedTransaction } = updatedTransaction
        let calendarSync = baseCalendarSyncResult({
          reason: 'not_attempted'
        })
        try {
          calendarSync = await syncTransactionCalendarUpsert({ db, request, transaction: updatedTransaction })
        } catch (calendarError) {
          console.error('Transaction calendar update sync error:', calendarError)
          calendarSync = baseCalendarSyncResult({
            attempted: true,
            connected: true,
            reason: 'unexpected_error',
            error: String(calendarError?.message || 'Unexpected calendar sync error')
          })
        }
        
        return handleCORS(NextResponse.json({
          success: true,
          transaction: cleanedTransaction,
          calendar: calendarSync
        }))
      } catch (error) {
        console.error('Error updating transaction:', error)
        return handleCORS(NextResponse.json({
          success: false,
          error: 'Failed to update transaction'
        }, { status: 500 }))
      }
    }

    // DELETE /api/transactions/:id - Delete transaction and associated checklist items
    if (route.match(/^\/transactions\/[^\/]+$/) && method === 'DELETE') {
      try {
        const transactionId = path[1]
        const existing = await db.collection('transactions').findOne({ id: transactionId })
        if (!existing) {
          return handleCORS(NextResponse.json({
            success: false,
            error: "Transaction not found"
          }, { status: 404 }))
        }

        let calendarSync = baseCalendarSyncResult({
          reason: 'not_attempted'
        })
        try {
          calendarSync = await syncTransactionCalendarDelete({ db, request, transactionId })
        } catch (calendarError) {
          console.error('Transaction calendar delete sync error:', calendarError)
          calendarSync = baseCalendarSyncResult({
            attempted: true,
            connected: true,
            reason: 'unexpected_error',
            error: String(calendarError?.message || 'Unexpected calendar delete sync error')
          })
        }

        const result = await db.collection('transactions').deleteOne({ id: transactionId })

        if (result.deletedCount === 0) {
          return handleCORS(NextResponse.json({
            success: false,
            error: "Transaction not found"
          }, { status: 404 }))
        }

        // Also delete related checklist items
        const checklistResult = await db.collection('checklist_items').deleteMany({ transaction_id: transactionId })
        const auth = getRequestAuthContext(request)
        await deleteCalendarEventRecordsByQuery(db, {
          user_id: normalizeUserKey(auth.userKey),
          transaction_id: String(transactionId)
        })

        return handleCORS(NextResponse.json({
          success: true,
          message: "Transaction deleted successfully",
          deleted_checklist_items: checklistResult?.deletedCount || 0,
          calendar: calendarSync
        }))
      } catch (error) {
        console.error('Error deleting transaction:', error)
        return handleCORS(NextResponse.json({
          success: false,
          error: 'Failed to delete transaction'
        }, { status: 500 }))
      }
    }

    // POST /api/transactions/:id/stage-transition - Transition to next stage with validation
    if (route.match(/^\/transactions\/[^\/]+\/stage-transition$/) && method === 'POST') {
      try {
        const transactionId = path[1]
        const body = await request.json()

        const transaction = await db.collection('transactions').findOne({ id: transactionId })
        if (!transaction) {
          return handleCORS(NextResponse.json({
            success: false,
            error: "Transaction not found"
          }, { status: 404 }))
        }

        const target_stage = body.target_stage || body.targetStage
        const force = !!body.force
        const currentStage = transaction.current_stage
        const txType = (transaction.transaction_type || 'sale').toLowerCase()

        if (!target_stage || typeof target_stage !== 'string') {
          return handleCORS(NextResponse.json({
            success: false,
            error: "target_stage is required"
          }, { status: 400 }))
        }

        // Validate stage transition (AI + fallback)
        const validationResult = await validateStageTransition(db, transactionId, currentStage, target_stage, force)

        if (!validationResult.valid && !force) {
          return handleCORS(NextResponse.json({
            success: false,
            error: "Stage transition validation failed",
            validation_errors: validationResult.errors,
            missing_tasks: validationResult.missing_tasks,
            can_force: true
          }, { status: 422 }))
        }

        // Update transaction stage and history
        await db.collection('transactions').updateOne(
          { id: transactionId },
          {
            $set: {
              current_stage: target_stage,
              updated_at: new Date()
            },
            $push: {
              stage_history: {
                stage: target_stage,
                entered_at: new Date(),
                status: 'active',
                forced: force,
                transitioned_from: currentStage,
                validation_result: validationResult
              }
            }
          }
        )

        // Create default checklist items for the new stage (buyer vs seller aware)
        const createdItems = await createDefaultChecklistItems(db, transactionId, target_stage, txType)

        return handleCORS(NextResponse.json({
          success: true,
          from_stage: currentStage,
          to_stage: target_stage,
          created_items: createdItems,
          validation_result: validationResult
        }, { status: 201 }))
      } catch (error) {
        console.error('Error processing stage transition:', error)
        return handleCORS(NextResponse.json({
          success: false,
          error: 'Failed to process stage transition'
        }, { status: 500 }))
      }
    }

    // GET /api/transactions/:id/checklist - Get checklist items for a transaction
    if (route.match(/^\/transactions\/[^\/]+\/checklist$/) && method === 'GET') {
      try {
        const transactionId = path[1]
        const url = new URL(request.url)
        const stage = url.searchParams.get('stage')
        const status = url.searchParams.get('status')

        const transaction = await db.collection('transactions').findOne({ id: transactionId })
        if (!transaction) {
          return handleCORS(NextResponse.json({ success: false, error: 'Transaction not found' }, { status: 404 }))
        }

        const txType = (transaction.transaction_type || 'sale').toLowerCase()
        const query = { transaction_id: transactionId }
        if (stage) query.stage = stage
        if (status) query.status = status

        let items = await db.collection('checklist_items').find(query).toArray()
        items = items.map((it) => {
          if (typeof it.stage_order !== 'number' || Number.isNaN(it.stage_order)) {
            it.stage_order = getStageOrder(it.stage, txType)
          }
          if (typeof it.weight !== 'number' || Number.isNaN(it.weight)) {
            it.weight = 1
          }
          if (it.parent_id === undefined) {
            it.parent_id = null
          }
          const { _id, ...rest } = it
          return rest
        })
        items.sort(
          (a, b) =>
            (a.stage_order || 0) - (b.stage_order || 0) ||
            (a.order || 0) - (b.order || 0) ||
            String(a.title || '').localeCompare(String(b.title || ''))
        )

        return handleCORS(
          NextResponse.json({ success: true, checklist_items: items, total: items.length })
        )
      } catch (error) {
        console.error('Error fetching checklist items:', error)
        return handleCORS(
          NextResponse.json(
            { success: false, error: 'Failed to fetch checklist items' },
            { status: 500 }
          )
        )
      }
    }

    // POST /api/transactions/:id/checklist - Manually add a checklist item to a transaction
    if (route.match(/^\/transactions\/[^\/]+\/checklist$/) && method === 'POST') {
      try {
        const transactionId = path[1]
        const body = await request.json()

        const transaction = await db.collection('transactions').findOne({ id: transactionId })
        if (!transaction) {
          return handleCORS(NextResponse.json({ success: false, error: 'Transaction not found' }, { status: 404 }))
        }

        if (!body.title || typeof body.title !== 'string') {
          return handleCORS(NextResponse.json({ success: false, error: 'title is required' }, { status: 400 }))
        }

        const txType = (transaction.transaction_type || 'sale').toLowerCase()
        let stage = (body.stage || transaction.current_stage)

        const parentId = body.parent_id || null
        let order
        let stage_order

        if (parentId) {
          // Validate parent exists in same transaction
          const parent = await db.collection('checklist_items').findOne({ id: parentId, transaction_id: transactionId })
          if (!parent) {
            return handleCORS(NextResponse.json({ success: false, error: 'Invalid parent_id: parent not found in this transaction' }, { status: 400 }))
          }
          // Child should inherit parent's stage/order for grouping
          stage = parent.stage
          order = parent.order || 1
          stage_order = parent.stage_order || getStageOrder(stage, txType)
        } else {
          // Determine next order within this stage for a new parent item
          const existingCount = await db.collection('checklist_items').countDocuments({ transaction_id: transactionId, stage })
          order = existingCount + 1
          stage_order = getStageOrder(stage, txType)
        }

        const due_date = body.due_date
          ? new Date(body.due_date)
          : (body.due_days ? new Date(Date.now() + Number(body.due_days) * 24 * 60 * 60 * 1000) : null)

        const weight = (body.weight !== undefined && Number.isFinite(Number(body.weight))) ? Number(body.weight) : 1

        const item = {
          id: uuidv4(),
          transaction_id: transactionId,
          title: body.title,
          description: body.description || '',
          stage,
          status: body.status || 'not_started',
          priority: body.priority || 'medium',
          assignee: body.assignee || '',
          due_date,
          completed_date: null,
          notes: body.notes || '',
          order,
          stage_order,
          dependencies: Array.isArray(body.dependencies) ? body.dependencies : [],
          weight,
          parent_id: parentId,
          created_at: new Date(),
          updated_at: new Date()
        }

        await db.collection('checklist_items').insertOne(item)

        // If creating a parent with provided subtasks, insert them as children
        if (!parentId && Array.isArray(body.subtasks) && body.subtasks.length > 0) {
          const children = body.subtasks
            .filter(st => st && typeof st.title === 'string' && st.title.trim() !== '')
            .map((st) => ({
              id: uuidv4(),
              transaction_id: transactionId,
              title: st.title,
              description: st.description || '',
              stage,
              status: st.status || 'not_started',
              priority: st.priority || (body.priority || 'medium'),
              assignee: st.assignee || '',
              due_date: st.due_date ? new Date(st.due_date) : (st.due_days ? new Date(Date.now() + Number(st.due_days) * 24 * 60 * 60 * 1000) : null),
              completed_date: null,
              notes: st.notes || '',
              order,
              stage_order,
              dependencies: Array.isArray(st.dependencies) ? st.dependencies : [],
              weight: (st.weight !== undefined && Number.isFinite(Number(st.weight))) ? Number(st.weight) : 1,
              parent_id: item.id,
              created_at: new Date(),
              updated_at: new Date()
            }))

          if (children.length > 0) {
            await db.collection('checklist_items').insertMany(children)
          }
        }

        const { _id, ...cleanedItem } = item
        // SSE broadcast so clients refresh lists
        try {
          const g = globalThis
          if (g.__crmSSE?.clients) {
            const msg = (ev, data) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`
            for (const c of g.__crmSSE.clients) { try { c.enqueue(msg('tasks:changed', { action: 'created', id: item.id, transaction_id: transactionId })) } catch {} }
            for (const c of g.__crmSSE.clients) { try { c.enqueue(msg('suggestions:update', { reason: 'task_created', id: item.id })) } catch {} }
          }
        } catch (_) { /* ignore SSE errors */ }
        return handleCORS(NextResponse.json({ success: true, checklist_item: cleanedItem }, { status: 201 }))
      } catch (error) {
        console.error('Error creating checklist item:', error)
        return handleCORS(NextResponse.json({ success: false, error: 'Failed to create checklist item' }, { status: 500 }))
      }
    }

    // PUT /api/checklist/:id - Update checklist item
    if (route.match(/^\/checklist\/[^\/]+$/) && method === 'PUT') {
      try {
        const itemId = path[1]
        const body = await request.json()

        const existing = await db.collection('checklist_items').findOne({ id: itemId })
        if (!existing) {
          return handleCORS(NextResponse.json({ success: false, error: 'Checklist item not found' }, { status: 404 }))
        }

        const updateData = { updated_at: new Date() }

        // Whitelist fields
        if ('title' in body) updateData.title = body.title
        if ('description' in body) updateData.description = body.description || ''
        if ('priority' in body) updateData.priority = body.priority || 'medium'
        if ('assignee' in body) updateData.assignee = body.assignee || ''
        if ('notes' in body) updateData.notes = body.notes || ''
        if ('dependencies' in body && Array.isArray(body.dependencies)) updateData.dependencies = body.dependencies
        if ('due_date' in body) {
          updateData.due_date = body.due_date ? new Date(body.due_date) : null
        }
        // Allow scheduling fields for calendar planning
        if ('scheduled_start' in body) {
          updateData.scheduled_start = body.scheduled_start ? new Date(body.scheduled_start) : null
        }
        if ('scheduled_end' in body) {
          updateData.scheduled_end = body.scheduled_end ? new Date(body.scheduled_end) : null
        }
        // Basic validation if either schedule field is provided
        if ('scheduled_start' in body || 'scheduled_end' in body) {
          const s = ('scheduled_start' in body)
            ? (body.scheduled_start ? new Date(body.scheduled_start) : null)
            : (existing.scheduled_start ? new Date(existing.scheduled_start) : null)
          const e = ('scheduled_end' in body)
            ? (body.scheduled_end ? new Date(body.scheduled_end) : null)
            : (existing.scheduled_end ? new Date(existing.scheduled_end) : null)
          if (s && e && e <= s) {
            return handleCORS(NextResponse.json({ success: false, error: 'scheduled_end must be after scheduled_start' }, { status: 400 }))
          }
        }
        if ('weight' in body) {
          if (body.weight === null || body.weight === undefined) {
            // ignore
          } else if (!Number.isFinite(Number(body.weight))) {
            return handleCORS(NextResponse.json({ success: false, error: 'Invalid weight' }, { status: 400 }))
          } else {
            updateData.weight = Number(body.weight)
          }
        }

        // Handle parent assignment changes
        if ('parent_id' in body) {
          if (body.parent_id === existing.id) {
            return handleCORS(NextResponse.json({ success: false, error: 'parent_id cannot reference the item itself' }, { status: 400 }))
          }
          if (body.parent_id === null || body.parent_id === '' ) {
            updateData.parent_id = null
          } else {
            const parent = await db.collection('checklist_items').findOne({ id: body.parent_id, transaction_id: existing.transaction_id })
            if (!parent) {
              return handleCORS(NextResponse.json({ success: false, error: 'Invalid parent_id: parent not found in this transaction' }, { status: 400 }))
            }
            updateData.parent_id = parent.id
            // Align grouping with parent
            updateData.stage = parent.stage
            updateData.stage_order = parent.stage_order || getStageOrder(parent.stage)
            updateData.order = parent.order || 1
          }
        }

        // Handle status changes based on previous status
        if ('status' in body) {
          updateData.status = body.status
          if (body.status === 'completed' && existing.status !== 'completed') {
            updateData.completed_date = new Date()
          } else if (body.status !== 'completed' && existing.status === 'completed') {
            updateData.completed_date = null
          }
        }

        const result = await db.collection('checklist_items').updateOne(
          { id: itemId },
          { $set: updateData }
        )

        if (result.matchedCount === 0) {
          return handleCORS(NextResponse.json({
            success: false,
            error: "Checklist item not found"
          }, { status: 404 }))
        }

        const updatedItem = await db.collection('checklist_items').findOne({ id: itemId })
        const { _id, ...cleanedItem } = updatedItem
        
        // SSE broadcast to notify clients about checklist updates
        try {
          const g = globalThis
          if (g.__crmSSE?.clients) {
            const msg = (ev, data) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`
            for (const c of g.__crmSSE.clients) { try { c.enqueue(msg('tasks:changed', { action: 'updated', id: itemId, fields: Object.keys(updateData || {}) })) } catch {} }
            for (const c of g.__crmSSE.clients) { try { c.enqueue(msg('suggestions:update', { reason: 'task_updated', id: itemId })) } catch {} }
          }
        } catch (_) { /* ignore SSE errors */ }

        return handleCORS(NextResponse.json({
          success: true,
          checklist_item: cleanedItem
        }))
      } catch (error) {
        console.error('Error updating checklist item:', error)
        return handleCORS(NextResponse.json({
          success: false,
          error: 'Failed to update checklist item'
        }, { status: 500 }))
      }
    }

    // DELETE /api/checklist/:id - Delete checklist item
    if (route.match(/^\/checklist\/[^\/]+$/) && method === 'DELETE') {
      try {
        const itemId = path[1]
        
        const result = await db.collection('checklist_items').deleteOne({ id: itemId })
        
        if (result.deletedCount === 0) {
          return handleCORS(NextResponse.json({
            success: false,
            error: "Checklist item not found"
          }, { status: 404 }))
        }

        // SSE broadcast so clients refresh lists
        try {
          const g = globalThis
          if (g.__crmSSE?.clients) {
            const msg = (ev, data) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`
            for (const c of g.__crmSSE.clients) { try { c.enqueue(msg('tasks:changed', { action: 'deleted', id: itemId })) } catch {} }
            for (const c of g.__crmSSE.clients) { try { c.enqueue(msg('suggestions:update', { reason: 'task_deleted', id: itemId })) } catch {} }
          }
        } catch (_) { /* ignore SSE errors */ }

        return handleCORS(NextResponse.json({
          message: "Checklist item deleted successfully"
        }))
      } catch (error) {
        console.error('Error deleting checklist item:', error)
        return handleCORS(NextResponse.json({
          success: false,
          error: 'Failed to delete checklist item'
        }, { status: 500 }))
      }
    }

    // POST /api/checklist/:id/voice - Save a memo (voice/typed) or transcribe-only
    if (route.match(/^\/checklist\/[^\/]+\/voice$/) && method === 'POST') {
      try {
        const itemId = String(path[1] || '').trim()
        const existing = await findChecklistItemById(db, itemId)
        if (!existing) {
          return handleCORS(NextResponse.json({ success: false, error: 'Checklist item not found' }, { status: 404 }))
        }
        const canonicalItemId = String(existing.id)

        let file = null
        let note = ''
        let durationSec = Number.NaN
        let transcribeOnly = false
        const contentType = (request.headers.get('content-type') || '').toLowerCase()

        if (contentType.includes('application/json')) {
          let body
          try {
            body = await request.json()
          } catch (_) {
            return handleCORS(NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 }))
          }
          note = (body?.note || '').toString().trim()
          durationSec = Number(body?.duration)
          transcribeOnly = Boolean(body?.transcribe_only || body?.transcribeOnly)
        } else {
          // Parse multipart form data
          let form
          try {
            form = await request.formData()
          } catch (_) {
            return handleCORS(NextResponse.json({ success: false, error: 'Expected JSON { note } or multipart/form-data' }, { status: 400 }))
          }
          file = form.get('audio')
          note = (form.get('note') || '').toString().trim()
          durationSec = Number(form.get('duration'))
          const rawTranscribeOnly = String(form.get('transcribe_only') || '').toLowerCase()
          transcribeOnly = rawTranscribeOnly === 'true' || rawTranscribeOnly === '1' || rawTranscribeOnly === 'yes'
        }

        const hasAudio = !!file && typeof file.arrayBuffer === 'function'
        if (transcribeOnly && !hasAudio) {
          return handleCORS(NextResponse.json({ success: false, error: 'Audio file is required when transcribe_only is true' }, { status: 400 }))
        }
        if (!hasAudio && !note) {
          return handleCORS(NextResponse.json({ success: false, error: 'Provide an audio file or a memo note' }, { status: 400 }))
        }
        const mime = hasAudio ? (file.type || 'audio/webm').toString() : 'audio/webm'
        const memoId = uuidv4()

        let transcriptText = ''
        if (hasAudio) {
          // Transcribe using provider-compatible audio transcription API
          const transcriptionKey = process.env.TRANSCRIPTION_API_KEY || process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY
          if (!transcriptionKey) {
            return handleCORS(NextResponse.json({ success: false, error: 'TRANSCRIPTION_API_KEY, OPENAI_API_KEY, or GROQ_API_KEY not configured for transcription' }, { status: 500 }))
          }
          const fileName = `${canonicalItemId}-${memoId}.webm`
          const buffer = Buffer.from(await file.arrayBuffer())
          try {
            const fd = new FormData()
            fd.append('model', 'whisper-1')
            // Use a Blob so multipart/form-data boundary and filename are correct
            const blob = new Blob([buffer], { type: mime || 'audio/webm' })
            fd.append('file', blob, fileName)
            // Optional: language hint if known; comment out if undesired
            // fd.append('language', 'en')

            const transcriptionBase = process.env.TRANSCRIPTION_BASE_URL || openaiUtility.baseURL
            const transcriptionUrl = `${transcriptionBase.replace(/\/$/, '')}/audio/transcriptions`
            const res = await fetch(transcriptionUrl, {
              method: 'POST',
              headers: { Authorization: `Bearer ${transcriptionKey}` },
              body: fd
            })
            if (!res.ok) {
              const errTxt = await res.text().catch(() => '')
              throw new Error(`Transcription failed: ${res.status} ${errTxt}`)
            }
            const json = await res.json()
            transcriptText = (json.text || '').toString()
          } catch (e) {
            console.error('OpenAI transcription error', e)
            const safeMessage = String(e?.message || 'Failed to transcribe audio')
              .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***')
              .slice(0, 320)
            return handleCORS(NextResponse.json({ success: false, error: safeMessage }, { status: 502 }))
          }
        }

        if (transcribeOnly) {
          return handleCORS(NextResponse.json({
            success: true,
            transcript: transcriptText,
            duration_sec: Number.isFinite(durationSec) ? durationSec : null
          }))
        }

        const memo = {
          id: memoId,
          text: transcriptText,
          note,
          duration_sec: hasAudio && Number.isFinite(durationSec) ? durationSec : null,
          source: hasAudio ? 'voice' : 'typed',
          created_at: new Date()
        }

        const existingMemos = Array.isArray(existing.voice_memos) ? existing.voice_memos : []
        await db.collection('checklist_items').updateOne(
          { id: canonicalItemId },
          { $set: { voice_memos: [...existingMemos, memo], updated_at: new Date() } }
        )

        const updated = await db.collection('checklist_items').findOne({ id: canonicalItemId })
        const { _id, ...cleaned } = updated
        return handleCORS(NextResponse.json({ success: true, memo, checklist_item: cleaned }, { status: 201 }))
      } catch (error) {
        console.error('Error saving memo:', error)
        return handleCORS(NextResponse.json({ success: false, error: 'Failed to save memo' }, { status: 500 }))
      }
    }

    // DELETE /api/checklist/:id/voice/:memoId - Delete a transcribed memo
    if (route.match(/^\/checklist\/[^\/]+\/voice\/[^\/]+$/) && method === 'DELETE') {
      try {
        const itemId = String(path[1] || '').trim()
        const memoId = path[3]
        const existing = await findChecklistItemById(db, itemId)
        if (!existing) {
          return handleCORS(NextResponse.json({ success: false, error: 'Checklist item not found' }, { status: 404 }))
        }
        const canonicalItemId = String(existing.id)
        const memos = Array.isArray(existing.voice_memos) ? existing.voice_memos : []
        const memo = memos.find(m => m.id === memoId)
        if (!memo) {
          return handleCORS(NextResponse.json({ success: false, error: 'Voice memo not found' }, { status: 404 }))
        }
        const filtered = memos.filter(m => m.id !== memoId)
        await db.collection('checklist_items').updateOne(
          { id: canonicalItemId },
          { $set: { voice_memos: filtered, updated_at: new Date() } }
        )
        return handleCORS(NextResponse.json({ success: true }))
      } catch (error) {
        console.error('Error deleting voice memo:', error)
        return handleCORS(NextResponse.json({ success: false, error: 'Failed to delete voice memo' }, { status: 500 }))
      }
    }

    // =============================
    // PMD (Plan My Day) ENDPOINTS
    // =============================
    // GET /api/pmd/tasks?date=YYYY-MM-DD[&agent=]
    if (route === '/pmd/tasks' && method === 'GET') {
      try {
        const url = new URL(request.url)
        const dateStr = url.searchParams.get('date') || new Date().toISOString().slice(0,10)
        const agent = url.searchParams.get('agent')
        // Use server-local time for start/end of day to avoid UTC drift
        const startOfDay = new Date(`${dateStr}T00:00:00`)
        const endOfDay = new Date(`${dateStr}T23:59:59.999`)
        const now = new Date()

        const agentFilter = agent ? { assignee: agent } : {}

        // Fetch candidate sets
        const [overdue, todayTasks, upcoming] = await Promise.all([
          db.collection('checklist_items').find({ status: { $ne: 'completed' }, due_date: { $lt: startOfDay }, ...agentFilter }).toArray(),
          db.collection('checklist_items').find({ status: { $ne: 'completed' }, due_date: { $gte: startOfDay, $lte: endOfDay }, ...agentFilter }).toArray(),
          db.collection('checklist_items').find({ status: { $ne: 'completed' }, due_date: { $gt: endOfDay }, ...agentFilter }).sort({ due_date: 1 }).limit(200).toArray()
        ])

        const all = [...overdue, ...todayTasks, ...upcoming]

        // Hydrate basic client/listing fields from transactions
        const txIds = [...new Set(all.map(t => t.transaction_id).filter(Boolean))]
        const txMap = new Map()
        if (txIds.length) {
          const txs = await db.collection('transactions').find({ id: { $in: txIds } }).toArray()
          for (const tx of txs) txMap.set(tx.id, tx)
        }

        // Compute ai_score and filter dismissed for this date (post-filter for stub safety)
        const dateKey = dateStr
        const score = (it) => {
          let s = 0
          const due = it.due_date ? new Date(it.due_date) : null
          const daysToDue = due ? Math.ceil((due - now) / 86400000) : null
          if (daysToDue == null) s -= 2
          else if (daysToDue < 0) s += 10 + Math.min(5, Math.abs(daysToDue))
          else if (daysToDue === 0) s += 8
          else if (daysToDue <= 3) s += 5
          if (it.priority === 'urgent') s += 6
          else if (it.priority === 'high') s += 3
          s += (Number(it.est_duration_min || 0) <= 30 ? 2 : 0)
          return s
        }

        const cleaned = all
          .filter(t => !Array.isArray(t.dismissed_dates) || !t.dismissed_dates.includes(dateKey))
          .map(({ _id, ...t }) => ({
            ...t,
            client_name: t.client_name || txMap.get(t.transaction_id)?.client_name || null,
            property_address: t.property_address || txMap.get(t.transaction_id)?.property_address || null,
            ai_score: score(t)
          }))
          .sort((a, b) => b.ai_score - a.ai_score)

        return handleCORS(NextResponse.json({ success: true, tasks: cleaned }))
      } catch (error) {
        console.error('PMD tasks error', error)
        return handleCORS(NextResponse.json({ success: false, error: 'Failed to fetch PMD tasks' }, { status: 500 }))
      }
    }

    // POST /api/pmd/plans - Save snapshot of today's selected tasks
    if (route === '/pmd/plans' && method === 'POST') {
      try {
        const body = await request.json().catch(() => ({}))
        const date = body.date || new Date().toISOString().slice(0,10)
        const agent = body.agent || null
        const items = Array.isArray(body.items) ? body.items : []
        const doc = {
          id: uuidv4(),
          date,
          agent,
          items,
          created_at: new Date(),
          updated_at: new Date()
        }
        await db.collection('pmd_plans').insertOne(doc)
        const { _id, ...cleaned } = doc
        return handleCORS(NextResponse.json({ success: true, plan: cleaned }, { status: 201 }))
      } catch (error) {
        console.error('PMD save error', error)
        return handleCORS(NextResponse.json({ success: false, error: 'Failed to save plan' }, { status: 500 }))
      }
    }

    // GET /api/pmd/plans/latest?date=YYYY-MM-DD[&agent=]
    if (route === '/pmd/plans/latest' && method === 'GET') {
      try {
        const url = new URL(request.url)
        const date = url.searchParams.get('date') || new Date().toISOString().slice(0,10)
        const agent = url.searchParams.get('agent')
        const query = { date }
        if (agent) query.agent = agent
        const plan = await db.collection('pmd_plans').find(query).sort({ created_at: -1 }).limit(1).toArray()
        if (!plan || plan.length === 0) {
          return handleCORS(NextResponse.json({ success: true, plan: null }))
        }
        const { _id, ...cleaned } = plan[0]
        return handleCORS(NextResponse.json({ success: true, plan: cleaned }))
      } catch (error) {
        console.error('PMD latest error', error)
        return handleCORS(NextResponse.json({ success: false, error: 'Failed to load latest plan' }, { status: 500 }))
      }
    }

    // POST /api/tasks/:id/snooze { until }
    if (route.match(/^\/tasks\/[^\/]+\/snooze$/) && method === 'POST') {
      try {
        const itemId = path[1]
        const body = await request.json().catch(() => ({}))
        const until = body.until ? new Date(body.until) : null
        if (!until || isNaN(until)) {
          return handleCORS(NextResponse.json({ success: false, error: 'Invalid until' }, { status: 400 }))
        }
        const existing = await db.collection('checklist_items').findOne({ id: itemId })
        if (!existing) return handleCORS(NextResponse.json({ success: false, error: 'Task not found' }, { status: 404 }))
        await db.collection('checklist_items').updateOne({ id: itemId }, { $set: { due_date: until, updated_at: new Date() } })
        const updated = await db.collection('checklist_items').findOne({ id: itemId })
        const { _id, ...cleaned } = updated
        // SSE broadcast to refresh panels
        try {
          const g = globalThis
          if (g.__crmSSE?.clients) {
            const msg = (ev, data) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`
            for (const c of g.__crmSSE.clients) { try { c.enqueue(msg('tasks:changed', { action: 'snoozed', id: itemId, until })) } catch {} }
            for (const c of g.__crmSSE.clients) { try { c.enqueue(msg('suggestions:update', { reason: 'task_snoozed', id: itemId })) } catch {} }
          }
        } catch (_) { /* ignore SSE errors */ }
        return handleCORS(NextResponse.json({ success: true, task: cleaned }))
      } catch (error) {
        console.error('Snooze error', error)
        return handleCORS(NextResponse.json({ success: false, error: 'Failed to snooze task' }, { status: 500 }))
      }
    }

    // POST /api/tasks/:id/dismiss { date }
    if (route.match(/^\/tasks\/[^\/]+\/dismiss$/) && method === 'POST') {
      try {
        const itemId = path[1]
        const body = await request.json().catch(() => ({}))
        const date = body.date || new Date().toISOString().slice(0,10)
        const existing = await db.collection('checklist_items').findOne({ id: itemId })
        if (!existing) return handleCORS(NextResponse.json({ success: false, error: 'Task not found' }, { status: 404 }))
        const dismissed = Array.isArray(existing.dismissed_dates) ? existing.dismissed_dates : []
        if (!dismissed.includes(date)) dismissed.push(date)
        await db.collection('checklist_items').updateOne({ id: itemId }, { $set: { dismissed_dates: dismissed, updated_at: new Date() } })
        const updated = await db.collection('checklist_items').findOne({ id: itemId })
        const { _id, ...cleaned } = updated
        // SSE broadcast so UI updates immediately
        try {
          const g = globalThis
          if (g.__crmSSE?.clients) {
            const msg = (ev, data) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`
            for (const c of g.__crmSSE.clients) { try { c.enqueue(msg('tasks:changed', { action: 'dismissed', id: itemId, date })) } catch {} }
            for (const c of g.__crmSSE.clients) { try { c.enqueue(msg('suggestions:update', { reason: 'task_dismissed', id: itemId })) } catch {} }
          }
        } catch (_) { /* ignore SSE errors */ }
        return handleCORS(NextResponse.json({ success: true, task: cleaned }))
      } catch (error) {
        console.error('Dismiss error', error)
        return handleCORS(NextResponse.json({ success: false, error: 'Failed to dismiss task' }, { status: 500 }))
      }
    }

    // DEAL SUMMARY & SMART ALERTS ENDPOINTS
    
    // POST /api/agent/command - Process natural language agent commands
    if (route === '/agent/command' && method === 'POST') {
      try {
        const body = await request.json()
        
        if (!body.command) {
          return handleCORS(NextResponse.json({
            success: false,
            error: "Command is required"
          }, { status: 400 }))
        }

        // Use GPT-4o-mini to parse the command
        const parseMessages = [
          {
            role: "system",
            content: `You are a real estate assistant that processes agent commands. Parse the command and determine the action needed.
            
            For deal summary commands like "Summarize 125 Maple Ave deal", return:
            {
              "action": "deal_summary",
              "property_address": "extracted property address",
              "intent": "summary of what the agent wants"
            }
            
            For alert commands, return:
            {
              "action": "alerts",
              "filters": {...},
              "intent": "what alerts they want to see"
            }
            
            Return only valid JSON.`
          },
          {
            role: "user",
            content: body.command
          }
        ]

        const parseResponse = await callOpenAI('gpt-4o-mini', parseMessages)
        let parsedCommand

        try {
          parsedCommand = JSON.parse(parseResponse)
        } catch (parseError) {
          return handleCORS(NextResponse.json({
            success: false,
            error: "Could not parse command",
            original_command: body.command
          }))
        }

        // Process the parsed command
        if (parsedCommand.action === 'deal_summary') {
          const summaryResult = await generateDealSummary(db, parsedCommand.property_address)
          return handleCORS(NextResponse.json({
            success: true,
            action: 'deal_summary',
            ...summaryResult
          }))
        } else if (parsedCommand.action === 'alerts') {
          const alertsResult = await getSmartAlerts(db, parsedCommand.filters)
          return handleCORS(NextResponse.json({
            success: true,
            action: 'alerts',
            ...alertsResult
          }))
        } else {
          return handleCORS(NextResponse.json({
            success: false,
            error: "Unknown command action",
            parsed_command: parsedCommand
          }))
        }

      } catch (error) {
        console.error('Agent command error:', error)
        return handleCORS(NextResponse.json({
          success: false,
          error: "Failed to process command"
        }, { status: 500 }))
      }
    }

    // GET /api/deals/summary/:id - Get detailed deal summary
    if (route.match(/^\/deals\/summary\/[^\/]+$/) && method === 'GET') {
      try {
        const transactionId = path[2]
        const summaryResult = await generateDealSummaryById(db, transactionId)
        
        if (summaryResult.success) {
          return handleCORS(NextResponse.json(summaryResult))
        } else {
          return handleCORS(NextResponse.json(summaryResult, { status: 404 }))
        }
      } catch (error) {
        console.error('Deal summary error:', error)
        return handleCORS(NextResponse.json({
          success: false,
          error: "Failed to generate deal summary"
        }, { status: 500 }))
      }
    }

    

    // GET /api/alerts/smart - Get smart alerts for dashboard
    if (route === '/alerts/smart' && method === 'GET') {
      try {
        const url = new URL(request.url)
        const filters = {
          agent: url.searchParams.get('agent'),
          priority: url.searchParams.get('priority'),
          type: url.searchParams.get('type')
        }
        
        const alertsResult = await getSmartAlerts(db, filters)
        return handleCORS(NextResponse.json(alertsResult))
      } catch (error) {
        console.error('Smart alerts error:', error)
        return handleCORS(NextResponse.json({
          success: false,
          error: "Failed to get alerts"
        }, { status: 500 }))
      }
    }

    // POST /api/alerts/dismiss/:id - Dismiss alert
    if (route.match(/^\/alerts\/dismiss\/[^\/]+$/) && method === 'POST') {
      try {
        const alertId = path[2]
        
        const result = await db.collection('smart_alerts').updateOne(
          { id: alertId },
          { 
            $set: { 
              dismissed_at: new Date(),
              status: 'dismissed'
            } 
          }
        )

        if (result.matchedCount > 0) {
          // SSE broadcast
          try {
            const g = globalThis
            if (g.__crmSSE?.clients) {
              const msg = (ev, data) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`
              for (const c of g.__crmSSE.clients) { try { c.enqueue(msg('alerts:changed', { id: alertId })) } catch {} }
              for (const c of g.__crmSSE.clients) { try { c.enqueue(msg('suggestions:update', { reason: 'alert_dismissed', id: alertId })) } catch {} }
            }
          } catch (_) {}
          return handleCORS(NextResponse.json({
            success: true,
            message: "Alert dismissed"
          }))
        } else {
          return handleCORS(NextResponse.json({
            success: false,
            error: "Alert not found"
          }, { status: 404 }))
        }
      } catch (error) {
        console.error('Alert dismiss error:', error)
        return handleCORS(NextResponse.json({
          success: false,
          error: "Failed to dismiss alert"
        }, { status: 500 }))
      }
    }

    // POST /api/alerts/generate - Manually trigger alert generation
    if (route === '/alerts/generate' && method === 'POST') {
      try {
        const upserted = await generateSmartAlerts(db)
        let emailed = 0
        try {
          const emailRuns = await Promise.allSettled(
            upserted.map((alert) => sendSmartAlertEmail(db, request, alert))
          )
          emailed = emailRuns.filter((run) => run.status === 'fulfilled' && run.value?.success).length
        } catch (_) {}
        // SSE broadcast so UI refreshes immediately
        try {
          const g = globalThis
          if (g.__crmSSE?.clients) {
            const msg = (ev, data) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`
            for (const c of g.__crmSSE.clients) { try { c.enqueue(msg('alerts:changed', { reason: 'alerts_generated', count: upserted.length })) } catch {} }
            for (const c of g.__crmSSE.clients) { try { c.enqueue(msg('suggestions:update', { reason: 'alerts_generated' })) } catch {} }
          }
        } catch (_) { /* ignore SSE errors */ }
        return handleCORS(NextResponse.json({
          success: true,
          message: "Alerts generated successfully",
          generated: upserted.length,
          emailed
        }))
      } catch (error) {
        console.error('Alert generation error:', error)
        return handleCORS(NextResponse.json({
          success: false,
          error: "Failed to generate alerts"
        }, { status: 500 }))
      }
    }
    
    // POST /api/assistant/parse - lightweight NL intent parser
    if (route === '/assistant/parse' && method === 'POST') {
      try {
        const body = await request.json().catch(() => ({}))
        const text = (body.text || body.query || body.message || '').toString()
        const raw = text
        const lc = text.toLowerCase()
        const entities = {}

        // Extract potential transaction id (simple heuristic for UUID-like or custom ids)
        const idMatch = lc.match(/(?:id|tx|transaction)[^\w]?[:#\s]*([a-z0-9\-]{6,})/)
        if (idMatch) entities.transaction_id = idMatch[1]

        // Extract an address-ish token (very naive fallback: quoted string or street number phrase)
        const quoted = raw.match(/["']([^"']{5,})["']/)
        if (quoted) entities.address = quoted[1]
        else {
          const addr = raw.match(/(\d{1,6}\s+[^,\n]{3,40}(?:\s+(?:st|street|ave|avenue|rd|road|dr|drive|blvd|lane|ln|court|ct)\b[^,\n]*)?)/i)
          if (addr) entities.address = addr[1]
        }

        // Extract a person-like name (simple heuristic: two or three capitalized words)
        const nameMatch = raw.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/)
        if (nameMatch) {
          entities.client_name = nameMatch[1]
        }

        let intent = 'general.suggestions'
        let confidence = 0.55

        if ((lc.includes('overdue') || lc.includes('high priority')) && lc.includes('task')) { intent = 'tasks.overdue'; confidence = 0.9 }
        else if (lc.includes('today') && lc.includes('task')) { intent = 'tasks.today'; confidence = 0.85 }
        else if (lc.includes('alert')) { intent = 'alerts.summary'; confidence = 0.8 }
        else if (lc.includes('pipeline') || (lc.includes('summary') && lc.includes('deal'))) { intent = 'pipeline.summary'; confidence = 0.75 }
        else if ((lc.includes('transaction') || lc.includes('deal')) && (lc.includes('status') || lc.includes('update') || lc.includes('progress'))) { intent = 'transactions.status'; confidence = 0.88 }
        else if ((lc.includes('seller') || lc.includes('listing') || lc.includes('lead')) && (lc.includes('overview') || lc.includes('know more') || lc.includes('about') || lc.includes('start') || lc.includes('how to start') || lc.includes('how to begin'))) { intent = 'leads.overview'; confidence = 0.9 }

        return handleCORS(NextResponse.json({ success: true, intent, entities, confidence }))
      } catch (error) {
        console.error('Assistant parse error:', error)
        return handleCORS(NextResponse.json({ success: false, error: 'Failed to parse query' }, { status: 500 }))
      }
    }

    // POST /api/assistant/match - execute intent and return structured answer
    if (route === '/assistant/match' && method === 'POST') {
      try {
        const body = await request.json().catch(() => ({}))
        let { intent, entities = {}, agent, limit = 5, query } = body
        // Normalize alternate field names from existing frontend
        if (!query) query = body.original_message || body.text || body.message || ''
        if (!agent) agent = body.agent_name
        if (!intent && query) {
          // Fallback: self-parse
          const parseRes = await handleRoute(new Request(request.url, { method: 'POST', body: JSON.stringify({ text: query }), headers: { 'content-type': 'application/json' } }), { params: { path: ['assistant','parse'] } })
          try { const j = await parseRes.json(); intent = j.intent; entities = j.entities || entities } catch {}
        }

        const now = new Date()
        const startOfToday = new Date(now); startOfToday.setHours(0,0,0,0)
        const endOfToday = new Date(now); endOfToday.setHours(23,59,59,999)
        const sevenDaysFromNow = new Date(now.getTime() + 7*24*60*60*1000)
        const sevenDaysAgo = new Date(now.getTime() - 7*24*60*60*1000)

        const agentFilterTx = agent ? { assigned_agent: agent } : {}
        const agentFilterTasks = agent ? { assignee: agent } : {}

        const stripId = (doc) => { if (!doc) return doc; const { _id, ...rest } = doc; return rest }

        const makeAnswer = (title, bullets) => `${title}\n- ${bullets.filter(Boolean).join('\n- ')}`

        // Intent handlers
        if (intent === 'transactions.status') {
          const txQuery = { ...agentFilterTx, current_stage: { $ne: 'closed' } }
          if (entities.transaction_id) txQuery.id = entities.transaction_id
          if (entities.address) {
            const rx = new RegExp(entities.address.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
            txQuery.$or = [
              { address: rx },
              { property_address: rx },
              { 'property.address': rx },
              { 'property.full_address': rx },
              { title: rx }
            ]
          }
          // Search by client name and related leads if provided
          if (entities.client_name) {
            const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            const nameRx = new RegExp(esc(entities.client_name), 'i')
            txQuery.$or = [ ...(txQuery.$or || []), { client_name: nameRx } ]
            try {
              const leads = await db.collection('leads').find({ name: nameRx }).project({ id: 1 }).toArray()
              const leadIds = leads.map(l => l.id).filter(Boolean)
              if (leadIds.length) {
                txQuery.$or.push({ lead_id: { $in: leadIds } })
              }
            } catch (_) { /* ignore lead lookup errors */ }
          }
          const txs = await db.collection('transactions')
            .find(txQuery)
            .sort({ updated_at: -1 })
            .limit(limit)
            .toArray()
          const enriched = []
          for (const tx of txs) {
            const nextTasks = await db.collection('checklist_items')
              .find({ transaction_id: tx.id, status: { $ne: 'completed' } })
              .sort({ due_date: 1 })
              .limit(3)
              .toArray()
            enriched.push({ ...stripId(tx), next_tasks: nextTasks.map(stripId) })
          }
          const bullets = enriched.map(t => `Deal ${t.id || ''} (${t.title || t.property_address || t.address || 'Untitled'}): stage ${t.current_stage || 'n/a'}; next ${t.next_tasks?.[0]?.title || 'no pending tasks'}`)
          const answer = makeAnswer('Here is the current status of your active transactions:', bullets.length ? bullets : ['No matching transactions found'])
          return handleCORS(NextResponse.json({ success: true, intent, answer, transactions: enriched }))
        }

        if (intent === 'tasks.overdue') {
          const overdue = await db.collection('checklist_items')
            .find({ status: { $ne: 'completed' }, due_date: { $lt: now }, ...agentFilterTasks })
            .sort({ due_date: 1 })
            .limit(20)
            .toArray()
          const bullets = overdue.slice(0,5).map(t => `${t.title} (due ${new Date(t.due_date).toLocaleDateString()})`)
          const answer = makeAnswer('High-priority overdue tasks:', bullets.length ? bullets : ['No overdue tasks'])
          return handleCORS(NextResponse.json({ success: true, intent, answer, tasks: overdue.map(stripId) }))
        }

        if (intent === 'tasks.today') {
          const today = await db.collection('checklist_items')
            .find({ status: { $ne: 'completed' }, due_date: { $gte: startOfToday, $lte: endOfToday }, ...agentFilterTasks })
            .sort({ due_date: 1 })
            .limit(20)
            .toArray()
          const bullets = today.slice(0,5).map(t => `${t.title} (due ${new Date(t.due_date).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})})`)
          const answer = makeAnswer("Today's tasks:", bullets.length ? bullets : ['No tasks due today'])
          return handleCORS(NextResponse.json({ success: true, intent, answer, tasks: today.map(stripId) }))
        }

        if (intent === 'alerts.summary') {
          const alerts = await getSmartAlerts(db, agent ? { agent } : {})
          const list = alerts?.alerts || []
          const bullets = list.slice(0,5).map(a => `${a.title || a.alert_type} (${a.priority || 'normal'})`)
          const answer = makeAnswer('Smart alerts:', bullets.length ? bullets : ['No active alerts'])
          return handleCORS(NextResponse.json({ success: true, intent, answer, alerts: list.map(stripId), total: alerts?.total ?? list.length }))
        }

        if (intent === 'pipeline.summary') {
          const txs = await db.collection('transactions')
            .find({ ...agentFilterTx })
            .toArray()
          const byStage = {}
          for (const tx of txs) { const s = (tx.current_stage || 'unknown'); byStage[s] = (byStage[s] || 0) + 1 }
          const bullets = Object.entries(byStage).map(([s,c]) => `${s}: ${c}`)
          const answer = makeAnswer('Pipeline summary by stage:', bullets.length ? bullets : ['No transactions'])
          return handleCORS(NextResponse.json({ success: true, intent, answer, summary: byStage, total: txs.length }))
        }

        if (intent === 'leads.overview') {
          // Resolve lead by name, prioritizing sellers
          const nameRaw = entities.client_name || ''
          const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          const sanitizeName = (s) => (s || '')
            .toString()
            .replace(/\b(please|thanks|thank\s+you)\b/gi, ' ')
            .replace(/[^a-zA-Z\s'\-]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
          const cleanedName = sanitizeName(nameRaw)
          let lead = null
          try {
            if (cleanedName) {
              const nameRx = new RegExp(esc(cleanedName), 'i')
              const candidates = await db.collection('leads')
                .find({ name: nameRx })
                .sort({ updated_at: -1 })
                .limit(5)
                .toArray()
              if (candidates && candidates.length) {
                // Prefer sellers
                lead = candidates.find(l => String(l.lead_type || '').toLowerCase() === 'seller') || candidates[0]
              } else {
                // Fallback token-based search requiring all parts to be present in name
                const parts = cleanedName.split(/\s+/).filter(Boolean)
                if (parts.length) {
                  const rxParts = parts.map(p => new RegExp(esc(p), 'i'))
                  const andConds = rxParts.map(rx => ({ name: rx }))
                  const tokenMatches = await db.collection('leads')
                    .find({ $and: andConds })
                    .sort({ updated_at: -1 })
                    .limit(5)
                    .toArray()
                  if (tokenMatches && tokenMatches.length) {
                    lead = tokenMatches.find(l => String(l.lead_type || '').toLowerCase() === 'seller') || tokenMatches[0]
                  }
                }
              }
            } else {
              // Fallback to most recent seller
              lead = await db.collection('leads').find({ lead_type: 'seller' }).sort({ updated_at: -1 }).limit(1).next()
            }
          } catch (_) { /* ignore lookup errors */ }

          if (!lead) {
            const who = cleanedName ? ` for ${cleanedName}` : ''
            const answer = makeAnswer(`I couldn't find a matching seller lead${who}.`, [
              'Try using the exact client name as saved in CRM',
              'Or provide an email/phone so I can locate the lead'
            ])
            return handleCORS(NextResponse.json({ success: true, intent, answer }))
          }

          const stripId = (doc) => { if (!doc) return doc; const { _id, ...rest } = doc; return rest }
          const prefs = lead.preferences || {}
          const sellerAddress = prefs.seller_address || prefs.address
          const sellerPrice = prefs.seller_price ?? prefs.asking_price
          const bullets = [
            `Name: ${lead.name}${lead.lead_type ? ` (${lead.lead_type})` : ''}`,
            `Contact: ${lead.email || 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â'} | ${lead.phone || 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â'}`,
            sellerAddress ? `Address: ${sellerAddress}` : null,
            sellerPrice != null ? `Asking price: $${Number(sellerPrice).toLocaleString()}` : null,
            prefs.seller_property_type ? `Property: ${prefs.seller_property_type}${prefs.seller_bedrooms ? ` ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ ${prefs.seller_bedrooms} bd` : ''}${prefs.seller_bathrooms ? ` ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ ${prefs.seller_bathrooms} ba` : ''}` : null,
            prefs.seller_year_built ? `Year built: ${prefs.seller_year_built}` : null,
            prefs.seller_square_feet ? `Size: ${prefs.seller_square_feet} sqft` : null,
            prefs.seller_lot_size ? `Lot: ${prefs.seller_lot_size}` : null,
            prefs.seller_condition ? `Condition: ${prefs.seller_condition}` : null,
            prefs.seller_occupancy ? `Occupancy: ${prefs.seller_occupancy}` : null,
            prefs.seller_timeline ? `Timeline to list: ${prefs.seller_timeline}` : null,
            prefs.seller_hoa_fee != null ? `HOA: ${prefs.seller_hoa_fee ? `$${Number(prefs.seller_hoa_fee).toLocaleString()}/mo` : 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â'}` : null,
            prefs.seller_description ? `Notes: ${prefs.seller_description}` : null,
            lead.updated_at ? `Last updated: ${new Date(lead.updated_at).toLocaleString()}` : null
          ]
          const overview = makeAnswer(`Seller lead overview for ${lead.name}:`, bullets)

          // Dynamic next steps suggestions
          const actions = []
          const soonish = (prefs.seller_timeline || '').toString().toLowerCase().includes('week') || (prefs.seller_timeline || '').toString().toLowerCase().includes('soon')
          actions.push('Schedule a listing consultation and walkthrough')
          actions.push('Prepare CMA with 3ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œ5 comps and pricing strategy')
          if (prefs.seller_condition && /needs|repair|fix|update/i.test(prefs.seller_condition)) actions.push('Outline repair/refresh plan (paint, fixtures, minor repairs)')
          else actions.push('Create a light staging/declutter checklist')
          actions.push('Book professional photography and floor plan')
          actions.push('Gather docs: HOA, disclosures, utility averages, survey')
          actions.push('Draft listing timeline and MLS remarks')
          if (soonish) actions.push('Expedite prep: compress timeline to 1ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œ2 weeks with daily checkpoints')
          const nextSteps = makeAnswer('Suggested next steps:', actions)

          // Optional AI insights reuse
          let insights = ''
          try {
            if (String(lead.lead_type || '').toLowerCase() === 'seller') {
              insights = await generateLeadInsights(lead, [])
            }
          } catch (_) { /* non-fatal */ }

          const answer = `${overview}\n\n${nextSteps}${insights ? `\n\nAI Insights:\n\n${insights}` : ''}`
          return handleCORS(NextResponse.json({ success: true, intent, answer, lead: stripId(lead), ai_recommendations: insights }))
        }

        // Fallback: brief suggestions snapshot
        const recentLeads = await db.collection('leads').find(agent ? { assigned_agent: agent } : {}).sort({ created_at: -1 }).limit(5).toArray()
        const overdueCount = await db.collection('checklist_items').countDocuments({ status: { $ne: 'completed' }, due_date: { $lt: now }, ...(agent ? { assignee: agent } : {}) })
        const alertsResult = await getSmartAlerts(db, agent ? { agent } : {})
        const bullets = [
          `${recentLeads.length} recent leads`,
          `${overdueCount} overdue tasks`,
          `${(alertsResult?.total ?? (alertsResult?.alerts?.length ?? 0))} smart alerts`
        ]
        const answer = makeAnswer('Here is a quick snapshot:', bullets)
        return handleCORS(NextResponse.json({ success: true, intent: intent || 'general.suggestions', answer, recent_leads: recentLeads.map(stripId), overdue_tasks: overdueCount, smart_alerts: (alertsResult?.alerts || []).map(stripId) }))
      } catch (error) {
        console.error('Assistant match error:', error)
        return handleCORS(NextResponse.json({ success: false, error: 'Failed to fulfill request' }, { status: 500 }))
      }
    }

    // GET /api/assistant/intents - list supported capabilities for UI/help
    if (route === '/assistant/intents' && method === 'GET') {
      try {
        return handleCORS(NextResponse.json({
          success: true,
          intents: [
            { key: 'leads.overview', examples: ['tell me about Priya (seller)', 'seller overview for John', 'how to start with Akash the seller'] },
            { key: 'transactions.status', examples: ['status of my Frisco deal', 'any updates on transaction 123?'] },
            { key: 'tasks.overdue', examples: ['high priority tasks', 'overdue tasks'] },
            { key: 'tasks.today', examples: ["what's due today", 'today\'s checklist'] },
            { key: 'alerts.summary', examples: ['any alerts?', 'smart alerts summary'] },
            { key: 'pipeline.summary', examples: ['pipeline summary', 'deals by stage'] },
            { key: 'general.suggestions', examples: ['what should I do next?'] }
          ]
        }))
      } catch (error) {
        console.error('Assistant intents error:', error)
        return handleCORS(NextResponse.json({ success: false, error: 'Failed to load intents' }, { status: 500 }))
      }
    }

    // GET /api/assistant/suggestions - Aggregated assistant suggestions/workload
    if (route === '/assistant/suggestions' && method === 'GET') {
      try {
        const url = new URL(request.url)
        const agent = url.searchParams.get('agent')
        const limit = parseInt(url.searchParams.get('limit')) || 5

        const now = new Date()
        const startOfToday = new Date(now)
        startOfToday.setHours(0, 0, 0, 0)
        const endOfToday = new Date(now)
        endOfToday.setHours(23, 59, 59, 999)
        const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
        const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)

        const agentFilterTx = agent ? { assigned_agent: agent } : {}
        const agentFilterLead = agent ? { assigned_agent: agent } : {}
        const agentFilterTasks = agent ? { assignee: agent } : {}

        // Recent leads
        const recentLeads = await db.collection('leads')
          .find(agentFilterLead)
          .sort({ created_at: -1 })
          .limit(limit)
          .toArray()

        // Active transactions
        const activeTx = await db.collection('transactions')
          .find({ current_stage: { $ne: 'closed' }, ...agentFilterTx })
          .sort({ created_at: -1 })
          .toArray()
        // Index transactions by id for quick lookup
        const txMap = new Map((activeTx || []).map(tx => [tx.id, tx]))

        // Checklist queries
        const overdueChecklist = await db.collection('checklist_items')
          .find({ status: { $ne: 'completed' }, due_date: { $lt: now }, ...agentFilterTasks })
          .sort({ due_date: 1 })
          .limit(10)
          .toArray()
        const overdueHydrated = overdueChecklist.map(t => {
          const tx = txMap.get(t.transaction_id)
          return { ...t, client_name: tx?.client_name, property_address: tx?.property_address }
        })

        const todayChecklist = await db.collection('checklist_items')
          .find({ status: { $ne: 'completed' }, due_date: { $gte: startOfToday, $lte: endOfToday }, ...agentFilterTasks })
          .sort({ due_date: 1 })
          .limit(10)
          .toArray()
        const todayHydrated = todayChecklist.map(t => {
          const tx = txMap.get(t.transaction_id)
          return { ...t, client_name: tx?.client_name, property_address: tx?.property_address }
        })

        const upcomingChecklist = await db.collection('checklist_items')
          .find({ status: { $ne: 'completed' }, due_date: { $gt: now, $lte: sevenDaysFromNow }, ...agentFilterTasks })
          .sort({ due_date: 1 })
          .limit(10)
          .toArray()

        // Ensure we have transactions for all referenced checklist items (not just activeTx)
        try {
          const idSet = new Set([
            ...overdueChecklist.map(t => t.transaction_id).filter(Boolean),
            ...todayChecklist.map(t => t.transaction_id).filter(Boolean),
            ...upcomingChecklist.map(t => t.transaction_id).filter(Boolean)
          ])
          const missing = [...idSet].filter(id => !txMap.has(id))
          if (missing.length) {
            const extraTx = await db.collection('transactions').find({ id: { $in: missing } }).toArray()
            for (const tx of extraTx) txMap.set(tx.id, tx)
          }
        } catch (_) { /* non-fatal */ }
        const upcomingHydrated = upcomingChecklist.map(t => {
          const tx = txMap.get(t.transaction_id)
          return { ...t, client_name: tx?.client_name, property_address: tx?.property_address }
        })

        // Stalled deals (inactive > 7 days)
        const stalledDeals = await db.collection('transactions')
          .find({ current_stage: { $ne: 'closed' }, updated_at: { $lt: sevenDaysAgo }, ...agentFilterTx })
          .sort({ updated_at: 1 })
          .limit(10)
          .toArray()

        // Smart alerts reuse
        const alertsResult = await getSmartAlerts(db, agent ? { agent } : {})

        // Recent assistant activity
        const recentActivity = await db.collection('assistant_conversations')
          .find({})
          .sort({ created_at: -1 })
          .limit(10)
          .toArray()

        // Totals for summary
        const leadsTotal = await db.collection('leads').countDocuments(agentFilterLead)
        const overdueCount = await db.collection('checklist_items').countDocuments({ status: { $ne: 'completed' }, due_date: { $lt: now }, ...agentFilterTasks })
        const dueTodayCount = await db.collection('checklist_items').countDocuments({ status: { $ne: 'completed' }, due_date: { $gte: startOfToday, $lte: endOfToday }, ...agentFilterTasks })
        const upcomingCount = await db.collection('checklist_items').countDocuments({ status: { $ne: 'completed' }, due_date: { $gt: now, $lte: sevenDaysFromNow }, ...agentFilterTasks })

        // Sanitize helper
        const stripId = (doc) => {
          if (!doc) return doc
          const { _id, ...rest } = doc
          return rest
        }

        // Build Next Best Actions (Phase 1): combine top overdue/today tasks and a top alert, and score them
        const nbaItems = []
        const pushTaskNBA = (t, tag) => {
          const due = new Date(t.due_date)
          const msLeft = due - now
          const daysLeft = Math.floor(msLeft / 86400000)
          const isOverdue = msLeft < 0
          const urgency = isOverdue ? 'overdue' : (due >= startOfToday && due <= endOfToday ? 'due_today' : 'due_soon')
          const base = isOverdue ? 92 : (urgency === 'due_today' ? 78 : 65)
          const timeAdj = isFinite(daysLeft) ? Math.max(-10, Math.min(10, -daysLeft * 2)) : 0
          const title = String(t.title || 'Task')
          // naive duration heuristic
          const lower = title.toLowerCase()
          let est = 15
          if (/call|phone|ring/.test(lower)) est = 5
          else if (/email|text|sms|follow[- ]?up/.test(lower)) est = 8
          else if (/mls|syndication|listing entry|photos|staging/.test(lower)) est = 30
          else if (/agreement|contract|disclosure|docu|esign|signature/.test(lower)) est = 15
          const priority_score = Math.max(0, Math.min(100, base + timeAdj))
          const reasonBits = []
          if (isOverdue) {
            const days = Math.ceil((now - due) / 86400000)
            reasonBits.push(`Overdue by ${days} day${days === 1 ? '' : 's'}`)
          } else if (urgency === 'due_today') {
            reasonBits.push('Due today')
          } else {
            reasonBits.push(`Due in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`)
          }
          if (t.client_name) reasonBits.push(`Client: ${t.client_name}`)
          const labelDue = isNaN(due) ? 'unscheduled' : (urgency === 'due_today' ? 'today' : `due ${due.toLocaleDateString()}`)
          nbaItems.push({
            key: `task:${t.id}`,
            type: 'task',
            id: t.id,
            label: `Complete: ${title} (${labelDue})`,
            client_name: t.client_name,
            property_address: t.property_address,
            transaction_id: t.transaction_id,
            est_duration_min: est,
            priority_score,
            urgency,
            impact: 'medium',
            reason: reasonBits.join(' | '),
            can_auto_complete: false,
            source: tag
          })
        }

        const pushAlertNBA = (a) => {
          const title = a.message || a.description || a.alert_type || 'Alert'
          const est = 2
          const priority_score = a.priority === 'urgent' ? 90 : a.priority === 'high' ? 80 : 60
          nbaItems.push({
            key: `alert:${a.id}`,
            type: 'alert',
            id: a.id,
            label: `Dismiss alert: ${title}`,
            est_duration_min: est,
            priority_score,
            urgency: a.priority === 'urgent' ? 'urgent' : 'normal',
            impact: a.priority === 'urgent' ? 'high' : 'medium',
            reason: a.alert_type ? `Type: ${a.alert_type}` : 'Smart alert',
            can_auto_complete: true,
            source: 'alert'
          })
        }

        // Top N tasks
        for (const t of overdueHydrated.slice(0, 3)) pushTaskNBA(t, 'overdue')
        if (nbaItems.length < 3) {
          for (const t of todayHydrated) {
            if (nbaItems.length >= 3) break
            // avoid duplicates by id
            if (nbaItems.some(i => i.type === 'task' && i.id === t.id)) continue
            pushTaskNBA(t, 'today')
          }
        }
        // Add one alert if we still have space
        if (nbaItems.length < 3 && (alertsResult?.alerts || []).length > 0) {
          pushAlertNBA(alertsResult.alerts[0])
        }
        // Sort by score desc and take up to `limit`
        nbaItems.sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0))
        const nextBestActions = nbaItems.slice(0, limit)

        const suggestions = {
          success: true,
          generated_at: new Date(),
          filters_applied: { agent: agent || null, limit },
          summary: {
            leads_total: leadsTotal,
            active_deals: activeTx.length,
            overdue_tasks: overdueCount,
            due_today: dueTodayCount,
            upcoming_week: upcomingCount,
            stalled_deals: stalledDeals.length,
            recent_conversations: recentActivity.length,
            smart_alerts: alertsResult?.total ?? (alertsResult?.alerts?.length || 0)
          },
          overdue_checklist: overdueHydrated.map(stripId),
          today_tasks: todayHydrated.map(stripId),
          upcoming_tasks: upcomingHydrated.map(stripId),
          stalled_deals: stalledDeals.map(tx => ({
            ...stripId(tx),
            days_inactive: Math.ceil((now - new Date(tx.updated_at)) / (1000 * 60 * 60 * 24))
          })),
          recent_leads: recentLeads.map(stripId),
          recent_activity: recentActivity.map(stripId),
          smart_alerts: (alertsResult?.alerts || []).map(stripId),
          next_best_actions: nextBestActions
        }

        return handleCORS(NextResponse.json(suggestions))
      } catch (error) {
        console.error('Assistant suggestions error:', error)
        return handleCORS(NextResponse.json({
          success: false,
          error: 'Failed to get assistant suggestions'
        }, { status: 500 }))
      }
    }
    
    // POST /api/assistant/plan - Generate a time-blocked plan from selected items
    if (route === '/assistant/plan' && method === 'POST') {
      try {
        const body = await request.json().catch(() => ({}))
        const {
          selected_keys = [],
          agent = null,
          start_time = null,
          workday_start_hour = 9,
          workday_end_hour = 17,
          buffer_min = 10,
          max_items = 10,
          roll_to_next_workday = false,
          min_block_min = 25
        } = body || {}
        const now = new Date()
        const db = await connectToMongo()

        // Build maps/filters
        const agentFilterTasks = agent ? { assignee: agent } : {}

        // Duration and scoring heuristics (aligned with /assistant/suggestions)
        const estimateTask = (t) => {
          const due = new Date(t.due_date)
          const msLeft = due - now
          const daysLeft = Math.floor(msLeft / 86400000)
          const isOverdue = msLeft < 0
          const startOfToday = new Date(now); startOfToday.setHours(0,0,0,0)
          const endOfToday = new Date(now); endOfToday.setHours(23,59,59,999)
          const urgency = isOverdue ? 'overdue' : (due && due >= startOfToday && due <= endOfToday ? 'due_today' : 'due_soon')
          const base = isOverdue ? 92 : (urgency === 'due_today' ? 78 : 65)
          const timeAdj = isFinite(daysLeft) ? Math.max(-10, Math.min(10, -daysLeft * 2)) : 0
          const title = String(t.title || 'Task')
          const lower = title.toLowerCase()
          let est = 15
          if (/call|phone|ring/.test(lower)) est = 5
          else if (/email|text|sms|follow[- ]?up/.test(lower)) est = 8
          else if (/mls|syndication|listing entry|photos|staging/.test(lower)) est = 30
          else if (/agreement|contract|disclosure|docu|esign|signature/.test(lower)) est = 15
          const priority_score = Math.max(0, Math.min(100, base + timeAdj))
          return { est_duration_min: est, priority_score, urgency }
        }
        const estimateAlert = (a) => {
          const est = 2
          const priority_score = a.priority === 'urgent' ? 90 : a.priority === 'high' ? 80 : 60
          return { est_duration_min: est, priority_score, urgency: a.priority === 'urgent' ? 'urgent' : 'normal' }
        }

        // Build items from selected keys or fallback to top actions
        let items = []

        if (Array.isArray(selected_keys) && selected_keys.length > 0) {
          const taskIds = selected_keys.filter(k => k && k.startsWith('task:')).map(k => k.split(':')[1]).filter(Boolean)
          const alertIds = selected_keys.filter(k => k && k.startsWith('alert:')).map(k => k.split(':')[1]).filter(Boolean)

          const [tasks, alerts] = await Promise.all([
            taskIds.length ? db.collection('checklist_items').find({ id: { $in: taskIds }, ...agentFilterTasks }).toArray() : [],
            alertIds.length ? db.collection('smart_alerts').find({ id: { $in: alertIds } }).toArray() : []
          ])

          // Hydrate with transaction info when available
          const txIds = [...new Set(tasks.map(t => t.transaction_id).filter(Boolean))]
          const txMap = new Map()
          if (txIds.length) {
            const txList = await db.collection('transactions').find({ id: { $in: txIds } }).toArray()
            for (const tx of txList) txMap.set(tx.id, tx)
          }

          for (const t of tasks) {
            const { est_duration_min, priority_score, urgency } = estimateTask(t)
            const tx = txMap.get(t.transaction_id)
            const due = t.due_date ? new Date(t.due_date) : null
            const labelDue = due ? (due.toDateString() === new Date().toDateString() ? 'today' : `due ${due.toLocaleDateString()}`) : 'unscheduled'
            items.push({
              key: `task:${t.id}`,
              type: 'task',
              id: t.id,
              label: `Complete: ${t.title || 'Task'} (${labelDue})`,
              client_name: tx?.client_name || t.client_name,
              property_address: tx?.property_address || t.property_address,
              transaction_id: t.transaction_id,
              est_duration_min,
              priority_score,
              urgency,
              reason: t.client_name ? `Client: ${t.client_name}` : undefined
            })
          }
          for (const a of alerts) {
            const { est_duration_min, priority_score, urgency } = estimateAlert(a)
            const title = a.message || a.description || a.alert_type || 'Alert'
            items.push({
              key: `alert:${a.id}`,
              type: 'alert',
              id: a.id,
              label: `Dismiss alert: ${title}`,
              est_duration_min,
              priority_score,
              urgency,
              reason: a.alert_type ? `Type: ${a.alert_type}` : 'Smart alert'
            })
          }
        } else {
          // Fallback: derive tasks up to max_items and hydrate with transaction info
          const endOfToday = new Date(now); endOfToday.setHours(23,59,59,999)
          const startOfToday = new Date(now); startOfToday.setHours(0,0,0,0)
          const tasks = await db.collection('checklist_items')
            .find({ status: { $ne: 'completed' }, due_date: { $lte: endOfToday }, ...agentFilterTasks })
            .sort({ due_date: 1 })
            .limit(max_items)
            .toArray()

          // Hydrate transactions for client/listing display
          const txIds = [...new Set(tasks.map(t => t.transaction_id).filter(Boolean))]
          const txMap = new Map()
          if (txIds.length) {
            const txList = await db.collection('transactions').find({ id: { $in: txIds } }).toArray()
            for (const tx of txList) txMap.set(tx.id, tx)
          }

          items = tasks.map(t => {
            const { est_duration_min, priority_score, urgency } = estimateTask(t)
            const due = t.due_date ? new Date(t.due_date) : null
            const labelDue = due ? (due >= startOfToday && due <= endOfToday ? 'today' : `due ${due.toLocaleDateString()}`) : 'unscheduled'
            const tx = txMap.get(t.transaction_id)
            return {
              key: `task:${t.id}`,
              type: 'task',
              id: t.id,
              label: `Complete: ${t.title || 'Task'} (${labelDue})`,
              transaction_id: t.transaction_id,
              client_name: tx?.client_name || t.client_name,
              property_address: tx?.property_address || t.property_address,
              est_duration_min,
              priority_score,
              urgency,
              reason: (tx?.client_name || t.client_name) ? `Client: ${tx?.client_name || t.client_name}` : undefined
            }
          })
        }

        // Sort and cap
        items.sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0))
        if (items.length > max_items) items = items.slice(0, max_items)

        // Time-blocking within workday
        const start = (() => {
          if (start_time) {
            const dt = new Date(start_time)
            if (!isNaN(dt)) return dt
          }
          const s = new Date(now)
          const wdStart = new Date(now); wdStart.setHours(workday_start_hour, 0, 0, 0)
          return s < wdStart ? wdStart : s
        })()
        let workEnd = new Date(start); workEnd.setHours(workday_end_hour, 0, 0, 0)
        // If we are after work hours and asked to roll, push to next day window
        if (roll_to_next_workday && workEnd <= start) {
          const next = new Date(start)
          next.setDate(next.getDate() + 1)
          next.setHours(workday_start_hour, 0, 0, 0)
          // Advance start and workEnd to next workday
          start.setTime(next.getTime())
          workEnd = new Date(start); workEnd.setHours(workday_end_hour, 0, 0, 0)
        }
        let cursor = new Date(start)
        const scheduled = []
        const overflow = []
        for (const it of items) {
          const dur = Math.max(Number(min_block_min) || 25, Number(it.est_duration_min || min_block_min))
          const end = new Date(cursor.getTime() + dur * 60000)
          if (end <= workEnd) {
            scheduled.push({ ...it, scheduled_start: cursor.toISOString(), scheduled_end: end.toISOString() })
            cursor = new Date(end.getTime() + buffer_min * 60000)
          } else {
            overflow.push({ ...it })
          }
        }
        const planItems = [...scheduled, ...overflow]

        const totalDuration = scheduled.reduce((sum, i) => sum + (i.est_duration_min || 0), 0)
        const response = {
          success: true,
          plan: {
            date: new Date(start).toISOString().slice(0,10),
            started_at: start.toISOString(),
            ends_at: workEnd.toISOString(),
            total_items: planItems.length,
            scheduled_items: scheduled.length,
            total_duration_min: totalDuration
          },
          items: planItems
        }
        return handleCORS(NextResponse.json(response))
      } catch (error) {
        console.error('Assistant plan error:', error)
        return handleCORS(NextResponse.json({ success: false, error: 'Failed to build plan' }, { status: 500 }))
      }
    }

    // POST /api/assistant/plan/save - Persist a generated plan to the database
    if (route === '/assistant/plan/save' && method === 'POST') {
      try {
        const body = await request.json().catch(() => ({}))
        const {
          agent = null,
          plan = {},
          items = [],
          title = null,
          calendar_export = null
        } = body || {}
        const db = await connectToMongo()

        const doc = {
          id: uuidv4(),
          agent,
          title: title || `Plan ${new Date().toLocaleDateString()}`,
          plan,
          items,
          calendar_export: calendar_export || null,
          created_at: new Date(),
          updated_at: new Date()
        }

        await db.collection('assistant_plans').insertOne(doc)

        return handleCORS(NextResponse.json({ success: true, plan_id: doc.id }))
      } catch (error) {
        console.error('Assistant plan save error:', error)
        return handleCORS(NextResponse.json({ success: false, error: 'Failed to save plan' }, { status: 500 }))
      }
    }

    // GET /api/assistant/plan/latest - Fetch latest saved plan (optionally by agent)
    if (route === '/assistant/plan/latest' && method === 'GET') {
      try {
        const url = new URL(request.url)
        const agentQ = url.searchParams.get('agent') || null
        const db = await connectToMongo()
        const query = agentQ ? { agent: agentQ } : {}
        const latest = await db.collection('assistant_plans').find(query).sort({ created_at: -1 }).limit(1).toArray()
        const doc = latest && latest[0] ? latest[0] : null
        if (!doc) {
          return handleCORS(NextResponse.json({ success: true, plan: null }))
        }
        const { _id, ...rest } = doc
        return handleCORS(NextResponse.json({ success: true, plan: rest }))
      } catch (error) {
        console.error('Assistant latest plan error:', error)
        return handleCORS(NextResponse.json({ success: false, error: 'Failed to load latest plan' }, { status: 500 }))
      }
    }

    // GET /api/assistant/stream - Server-Sent Events stream for real-time updates
    if (route === '/assistant/stream' && method === 'GET') {
      try {
        const stream = new ReadableStream({
          start(controller) {
            const g = globalThis
            if (!g.__crmSSE) g.__crmSSE = { clients: new Set() }
            g.__crmSSE.clients.add(controller)
            // Initial event
            try { controller.enqueue(`event: ready\ndata: {"ts": ${Date.now()}}\n\n`) } catch (_) {}
            const pingId = setInterval(() => {
              try { controller.enqueue(`event: ping\ndata: ${Date.now()}\n\n`) } catch (_) {}
            }, 15000)
            controller._cleanup = () => {
              clearInterval(pingId)
              try { g.__crmSSE.clients.delete(controller) } catch (_) {}
              try { controller.close() } catch (_) {}
            }
          },
          cancel() { try { this._cleanup && this._cleanup() } catch (_) {} }
        })
        const res = new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Connection': 'keep-alive',
            'Cache-Control': 'no-cache'
          }
        })
        return handleCORS(res)
      } catch (error) {
        console.error('SSE stream error:', error)
        return handleCORS(NextResponse.json({ success: false, error: 'SSE stream failed' }, { status: 500 }))
      }
    }

    // OPENAI UTILITIES ENDPOINTS
    
    // GET /api/openai/usage - Get OpenAI usage statistics
    if (route === '/openai/usage' && method === 'GET') {
      try {
        const stats = openaiUtility.getUsageStats()
        return handleCORS(NextResponse.json({
          success: true,
          ...stats
        }))
      } catch (error) {
        console.error('Error getting OpenAI usage stats:', error)
        return handleCORS(NextResponse.json({
          success: false,
          error: 'Failed to get usage statistics'
        }, { status: 500 }))
      }
    }

    // POST /api/openai/test - Test OpenAI utility with various models
    if (route === '/openai/test' && method === 'POST') {
      try {
        const body = await request.json()
        let { model = openaiUtility.defaultModel, test_type = 'simple', enable_streaming = false } = body

        let messages = []
        let options = {}

        switch (test_type) {
          case 'simple':
            messages = [
              { role: 'system', content: 'You are a helpful assistant.' },
              { role: 'user', content: 'Say hello in exactly 5 words.' }
            ]
            break
          case 'cost_test':
            messages = [
              { role: 'system', content: 'You are a real estate expert.' },
              { role: 'user', content: 'Explain the home buying process in detail with all steps, requirements, and timeline.' }
            ]
            options.maxTokens = 500
            break
          case 'streaming':
            messages = [
              { role: 'system', content: 'You are a creative writer.' },
              { role: 'user', content: 'Write a short story about a real estate agent.' }
            ]
            options.stream = true
            options.maxTokens = 300
            break
          case 'error_test':
            // Test with invalid model to trigger fallback
            model = 'invalid-model'
            messages = [
              { role: 'user', content: 'Test error handling' }
            ]
            break
        }

        if (enable_streaming && test_type !== 'streaming') {
          options.stream = true
        }

        const result = await callOpenAI(model, messages, options)

        return handleCORS(NextResponse.json({
          success: true,
          model: model,
          test_type,
          response: result,
          options_used: options,
          message: `${openaiUtility.provider.toUpperCase()} utility test completed successfully`
        }))
      } catch (error) {
        console.error('OpenAI test error:', error)
        return handleCORS(NextResponse.json({
          success: false,
          error: error.message,
          details: `${openaiUtility.provider.toUpperCase()} utility test failed`
        }, { status: 500 }))
      }
    }

    // POST /api/openai/reset-usage - Reset daily usage (admin only)
    if (route === '/openai/reset-usage' && method === 'POST') {
      try {
        openaiUtility.resetDailyUsage()
        return handleCORS(NextResponse.json({
          success: true,
          message: 'Daily usage reset successfully'
        }))
      } catch (error) {
        console.error('Error resetting usage:', error)
        return handleCORS(NextResponse.json({
          success: false,
          error: 'Failed to reset usage'
        }, { status: 500 }))
      }
    }

    // GET /api/openai/models - Get supported models and their limits
    if (route === '/openai/models' && method === 'GET') {
      try {
        return handleCORS(NextResponse.json({
          success: true,
          provider: openaiUtility.provider,
          default_model: openaiUtility.defaultModel,
          base_url: openaiUtility.baseURL,
          models: openaiUtility.tokenLimits,
          current_limits: {
            daily_cost_limit: openaiUtility.dailyCostLimit,
            max_single_request_cost: 5.00,
            max_retries: openaiUtility.maxRetries,
            base_delay: openaiUtility.baseDelay,
            max_delay: openaiUtility.maxDelay
          },
          usage_summary: openaiUtility.getUsageStats()
        }))
      } catch (error) {
        console.error('Error getting model info:', error)
        return handleCORS(NextResponse.json({
          success: false,
          error: 'Failed to get model information'
        }, { status: 500 }))
      }
    }
    
    // GET /api/analytics/dashboard - Dashboard stats
    if (route === '/analytics/dashboard' && method === 'GET') {
      const totalLeads = await db.collection('leads').countDocuments()
      const activeLeads = await db.collection('leads').countDocuments({ status: { $ne: 'closed' } })
      const buyerLeads = await db.collection('leads').countDocuments({ lead_type: 'buyer' })
      const sellerLeads = await db.collection('leads').countDocuments({ lead_type: 'seller' })
      
      const recentLeads = await db.collection('leads')
        .find({})
        .sort({ created_at: -1 })
        .limit(5)
        .toArray()

      const stats = {
        total_leads: totalLeads,
        active_leads: activeLeads,
        buyer_leads: buyerLeads,
        seller_leads: sellerLeads,
        recent_leads: recentLeads.map(({ _id, ...rest }) => rest)
      }

      return handleCORS(NextResponse.json(stats))
    }

    // GET /api/preferences/notifications - Per-user notification channel preferences
    if (route === '/preferences/notifications' && method === 'GET') {
      try {
        const { prefs } = await getNotificationPreferences(db, request, { createIfMissing: true })
        return handleCORS(NextResponse.json({
          success: true,
          preferences: {
            id: prefs.id,
            email: prefs.email,
            channels: prefs.channels,
            timing: prefs.timing,
            quiet_hours: prefs.quiet_hours,
            types: prefs.types
          }
        }))
      } catch (error) {
        console.error('Notification preferences fetch error:', error)
        return handleCORS(NextResponse.json({
          success: false,
          error: 'Failed to fetch notification preferences'
        }, { status: 500 }))
      }
    }

    // PUT /api/preferences/notifications - Update per-user notification preferences
    if (route === '/preferences/notifications' && (method === 'PUT' || method === 'PATCH')) {
      try {
        const body = await request.json().catch(() => ({}))
        const updated = await upsertNotificationPreferences(db, request, body || {})
        return handleCORS(NextResponse.json({
          success: true,
          preferences: {
            id: updated.id,
            email: updated.email,
            channels: updated.channels,
            timing: updated.timing,
            quiet_hours: updated.quiet_hours,
            types: updated.types
          }
        }))
      } catch (error) {
        console.error('Notification preferences update error:', error)
        return handleCORS(NextResponse.json({
          success: false,
          error: 'Failed to update notification preferences'
        }, { status: 500 }))
      }
    }

    // --- Notifications API ---
    // GET /api/notifications
    if (route === '/notifications' && method === 'GET') {
      try {
        const url = new URL(request.url)
        const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 50))
        const countOnly = url.searchParams.get('countOnly') === '1'
        const coll = (await connectToMongo()).collection('notifications')
        if (countOnly) {
          const total = await coll.countDocuments()
          const unread = await coll.countDocuments({ status: 'unread' })
          return handleCORS(NextResponse.json({ success: true, total, unread }))
        }
        const items = await coll.find({}).sort({ created_at: -1 }).limit(limit).toArray()
        return handleCORS(NextResponse.json({ success: true, items: items.map(({ _id, ...rest }) => rest) }))
      } catch (e) {
        console.error('Notifications list error', e)
        return handleCORS(NextResponse.json({ success: false, error: 'Failed to list notifications' }, { status: 500 }))
      }
    }

    // POST /api/notifications (create)
    if (route === '/notifications' && method === 'POST') {
      try {
        const body = await request.json().catch(() => ({}))
        const notif = {
          id: uuidv4(),
          type: body.type || 'general',
          title: body.title || null,
          message: body.message || body.description || '',
          meta: body.meta || {},
          status: 'unread',
          created_at: new Date(),
          updated_at: new Date(),
          snooze_until: null
        }
        const coll = (await connectToMongo()).collection('notifications')
        await coll.insertOne(notif)
        try { await sendNotificationRecordEmail(db, request, notif) } catch (_) {}
        // SSE broadcast
        try {
          const g = globalThis
          if (g.__crmSSE?.clients) {
            const msg = (ev, data) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`
            for (const c of g.__crmSSE.clients) { try { c.enqueue(msg('notifications:changed', { action: 'created', id: notif.id })) } catch {} }
          }
        } catch (_) {}
        return handleCORS(NextResponse.json({ success: true, notification: notif }, { status: 201 }))
      } catch (e) {
        console.error('Notifications create error', e)
        return handleCORS(NextResponse.json({ success: false, error: 'Failed to create notification' }, { status: 500 }))
      }
    }

    // POST /api/notifications/:id/read
    if (route.match(/^\/notifications\/[^\/]+\/read$/) && method === 'POST') {
      try {
        const id = path[1]
        const coll = (await connectToMongo()).collection('notifications')
        await coll.updateOne({ id }, { $set: { status: 'read', updated_at: new Date() } })
        try {
          const g = globalThis
          if (g.__crmSSE?.clients) {
            const msg = (ev, data) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`
            for (const c of g.__crmSSE.clients) { try { c.enqueue(msg('notifications:changed', { action: 'read', id })) } catch {} }
          }
        } catch (_) {}
        return handleCORS(NextResponse.json({ success: true }))
      } catch (e) {
        console.error('Notifications read error', e)
        return handleCORS(NextResponse.json({ success: false, error: 'Failed to mark read' }, { status: 500 }))
      }
    }

    // POST /api/notifications/:id/snooze
    if (route.match(/^\/notifications\/[^\/]+\/snooze$/) && method === 'POST') {
      try {
        const id = path[1]
        const body = await request.json().catch(() => ({}))
        const minutes = Math.max(1, Number(body.minutes) || 30)
        const until = new Date(Date.now() + minutes * 60 * 1000)
        const coll = (await connectToMongo()).collection('notifications')
        await coll.updateOne({ id }, { $set: { status: 'snoozed', snooze_until: until, updated_at: new Date() } })
        try {
          const g = globalThis
          if (g.__crmSSE?.clients) {
            const msg = (ev, data) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`
            for (const c of g.__crmSSE.clients) { try { c.enqueue(msg('notifications:changed', { action: 'snoozed', id, until })) } catch {} }
          }
        } catch (_) {}
        return handleCORS(NextResponse.json({ success: true }))
      } catch (e) {
        console.error('Notifications snooze error', e)
        return handleCORS(NextResponse.json({ success: false, error: 'Failed to snooze' }, { status: 500 }))
      }
    }

    // POST /api/notifications/clear-read
    if (route === '/notifications/clear-read' && method === 'POST') {
      try {
        const coll = (await connectToMongo()).collection('notifications')
        // Prefer deleteMany, fallback to manual loop if unavailable
        if (typeof coll.deleteMany === 'function') {
          await coll.deleteMany({ status: 'read' })
        } else {
          const all = await coll.find({}).toArray()
          for (const n of all) { if (n.status === 'read') { try { await coll.deleteOne({ id: n.id }) } catch {} } }
        }
        try {
          const g = globalThis
          if (g.__crmSSE?.clients) {
            const msg = (ev, data) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`
            for (const c of g.__crmSSE.clients) { try { c.enqueue(msg('notifications:changed', { action: 'clear_read' })) } catch {} }
          }
        } catch (_) {}
        return handleCORS(NextResponse.json({ success: true }))
      } catch (e) {
        console.error('Notifications clear-read error', e)
        return handleCORS(NextResponse.json({ success: false, error: 'Failed to clear read' }, { status: 500 }))
      }
    }

    // Route not found
    return handleCORS(NextResponse.json(
      { error: `Route ${route} not found` }, 
      { status: 404 }
    ))

  } catch (error) {
    const code = String(error?.code || '')
    if (code === 'DB_CONFIG_MISSING' || code === 'DB_CONNECT_FAILED') {
      return handleCORS(NextResponse.json(
        {
          error: String(error?.message || 'Database unavailable'),
          code,
          db: getDbRuntimeStatus()
        },
        { status: 503 }
      ))
    }
    console.error('API Error:', error)
    return handleCORS(NextResponse.json(
      { error: "Internal server error" }, 
      { status: 500 }
    ))
  }
}

// --- Nudge Scheduler (Proactive AI Nudges) ---
if (!globalThis.__crmNudgeScheduler) {
  const pushSSE = (evt, payload) => {
    try {
      const g = globalThis
      if (!g.__crmSSE || !g.__crmSSE.clients) return
      const json = JSON.stringify(payload)
      for (const c of g.__crmSSE.clients) {
        try { c.enqueue(`event: ${evt}\ndata: ${json}\n\n`) } catch (_) {}
      }
    } catch (_) {}
  }

  const runNudgeScan = async () => {
    try {
      const db = await connectToMongo()
      const now = new Date()

      // Overdue checklist tasks
      const overdueTasks = await db.collection('checklist_items').find({
        status: { $ne: 'completed' },
        due_date: { $lte: now }
      }).limit(5).toArray()

      for (const t of overdueTasks) {
        const payload = {
          id: `task_${t.id || t._id}`,
          type: 'checklist_slip',
          message: `Task overdue: ${t.title || 'Unnamed task'}`,
          quickAction: { type: 'complete_task', id: t.id || t._id }
        }
        pushSSE('nudge', payload)
        // Persist as a notification (dedupe per hour)
        try {
          const coll = db.collection('notifications')
          const nid = `nudge:${payload.id}:${now.toISOString().slice(0, 13)}`
          const exists = await coll.findOne({ id: nid })
          if (!exists) {
            const ownerUserId = normalizeUserKey(t?.owner_user_id || 'anonymous')
            const ownerEmail = ownerUserId.includes('@') ? ownerUserId : null
            const notificationDoc = {
              id: nid,
              type: 'nudge',
              title: 'Overdue task',
              message: payload.message,
              meta: payload,
              owner_user_id: ownerUserId,
              status: 'unread',
              created_at: new Date(),
              updated_at: new Date(),
              snooze_until: null
            }
            await coll.insertOne(notificationDoc)
            try {
              await sendNotificationRecordEmail(db, null, notificationDoc, {
                authOverride: { userKey: ownerUserId, email: ownerEmail }
              })
            } catch (_) {}
          }
        } catch (_) {}
      }

      // Stalled deals (no update in 7 days)
      const seven = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      const stalled = await db.collection('transactions').find({
        status: { $in: ['active', 'open', 'in_progress'] },
        updated_at: { $lte: seven }
      }).limit(3).toArray()

      for (const tx of stalled) {
        const days = Math.ceil((now - new Date(tx.updated_at)) / 86400000)
        const payload = {
          id: `deal_${tx.id || tx._id}`,
          type: 'stalled_deal',
          message: `Deal \"${tx.title || tx.property_address || 'Untitled'}\" stalled for ${days} days.`
        }
        pushSSE('nudge', payload)
        // Persist as a notification (dedupe per hour)
        try {
          const coll = db.collection('notifications')
          const nid = `nudge:${payload.id}:${now.toISOString().slice(0, 13)}`
          const exists = await coll.findOne({ id: nid })
          if (!exists) {
            const ownerUserId = normalizeUserKey(tx?.owner_user_id || 'anonymous')
            const ownerEmail = ownerUserId.includes('@') ? ownerUserId : null
            const notificationDoc = {
              id: nid,
              type: 'nudge',
              title: 'Stalled deal',
              message: payload.message,
              meta: payload,
              owner_user_id: ownerUserId,
              status: 'unread',
              created_at: new Date(),
              updated_at: new Date(),
              snooze_until: null
            }
            await coll.insertOne(notificationDoc)
            try {
              await sendNotificationRecordEmail(db, null, notificationDoc, {
                authOverride: { userKey: ownerUserId, email: ownerEmail }
              })
            } catch (_) {}
          }
        } catch (_) {}
      }

      // Fresh leads (last hour)
      const hourAgo = new Date(now.getTime() - 60 * 60 * 1000)
      const leads = await db.collection('leads').find({ created_at: { $gte: hourAgo } }).limit(3).toArray()
      for (const lead of leads) {
        const payload = {
          id: `lead_${lead.id || lead._id}`,
          type: 'new_lead',
          message: `New lead: ${lead.name || lead.full_name || 'Prospect'}`,
          quickAction: { type: 'open_lead', id: lead.id || lead._id }
        }
        pushSSE('nudge', payload)
        // Persist as a notification (dedupe per hour)
        try {
          const coll = db.collection('notifications')
          const nid = `nudge:${payload.id}:${now.toISOString().slice(0, 13)}`
          const exists = await coll.findOne({ id: nid })
          if (!exists) {
            const ownerUserId = normalizeUserKey(lead?.owner_user_id || 'anonymous')
            const ownerEmail = ownerUserId.includes('@') ? ownerUserId : null
            const notificationDoc = {
              id: nid,
              type: 'nudge',
              title: 'New lead',
              message: payload.message,
              meta: payload,
              owner_user_id: ownerUserId,
              status: 'unread',
              created_at: new Date(),
              updated_at: new Date(),
              snooze_until: null
            }
            await coll.insertOne(notificationDoc)
            try {
              await sendNotificationRecordEmail(db, null, notificationDoc, {
                authOverride: { userKey: ownerUserId, email: ownerEmail }
              })
            } catch (_) {}
          }
        } catch (_) {}
      }

      // Notify panels to refresh suggestions summary
      pushSSE('suggestions:update', { ts: Date.now() })
    } catch (e) {
      console.warn('Nudge scan error', e)
    }
  }

  // Kick off immediately then every 30 min
  runNudgeScan()
  globalThis.__crmNudgeScheduler = setInterval(runNudgeScan, 30 * 60 * 1000)
}

// --- Snooze Wake-up Scheduler (auto-unsnooze reminders) ---
if (!globalThis.__crmSnoozeScheduler) {
  const pushSSE = (evt, payload) => {
    try {
      const g = globalThis
      if (g.__crmSSE?.clients) {
        const msg = (ev, data) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`
        for (const c of g.__crmSSE.clients) { try { c.enqueue(msg(evt, payload)) } catch {} }
      }
    } catch (_) {}
  }

  const runSnoozeScan = async () => {
    try {
      const db = await connectToMongo()
      const coll = db.collection('notifications')
      const now = new Date()
      // Find all snoozed notifications that are due to wake up
      const due = await coll.find({ status: 'snoozed', snooze_until: { $lte: now } }).toArray()
      for (const n of due) {
        await coll.updateOne({ id: n.id }, { $set: { status: 'unread', snooze_until: null, updated_at: new Date() } })
        // Inform clients to refresh counters/lists
        try { pushSSE('notifications:changed', { action: 'unsnoozed', id: n.id }) } catch {}
        // Proactively remind the user with a payload (toast/browser notification on client)
        try { pushSSE('notifications:remind', { id: n.id, type: n.type, title: n.title || 'Reminder', message: n.message, meta: n.meta || {} }) } catch {}
        try {
          const ownerUserId = normalizeUserKey(n?.owner_user_id || 'anonymous')
          const ownerEmail = ownerUserId.includes('@') ? ownerUserId : null
          await sendNotificationRecordEmail(db, null, {
            ...n,
            status: 'unread',
            snooze_until: null,
            updated_at: new Date()
          }, {
            authOverride: { userKey: ownerUserId, email: ownerEmail }
          })
        } catch (_) {}
      }
    } catch (e) {
      console.warn('Snooze scan error', e)
    }
  }

  // Kick off immediately then every minute
  runSnoozeScan()
  globalThis.__crmSnoozeScheduler = setInterval(runSnoozeScan, 60 * 1000)
}

// Export all HTTP methods
export const GET = handleRoute
export const POST = handleRoute
export const PUT = handleRoute
export const DELETE = handleRoute
export const PATCH = handleRoute










