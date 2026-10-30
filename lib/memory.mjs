// 每位 LINE 使用者各自的「個人記憶」：agent 覺得重要就自己寫進來，
// 有保存期限的到期後由背景清理；也可以被要求翻出來看或忘掉。
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { readJsonSafe, writeJsonAtomic, nowIso } from './util.mjs'
import { defineTool } from './toolkit.mjs'

const KINDS = ['fact', 'event', 'preference', 'inside']
const MAX_TEXT = 600
const DAY = 24 * 60 * 60 * 1000

function emptyStore() {
  return { version: 1, users: {}, lastPruneAt: 0 }
}

function normalizeEntry(input) {
  const text = String(input?.text || '').trim().slice(0, MAX_TEXT)
  if (!text) throw new Error('記憶內容不能是空的')
  const kind = KINDS.includes(input?.kind) ? input.kind : 'fact'
  let importance = Number(input?.importance)
  if (!Number.isFinite(importance)) importance = 3
  importance = Math.max(1, Math.min(5, Math.round(importance)))
  let expiresAt = 0
  const ttlDays = Number(input?.ttlDays)
  if (Number.isFinite(ttlDays) && ttlDays > 0) {
    expiresAt = Date.now() + Math.min(ttlDays, 3650) * DAY
  }
  return {
    id: 'm_' + randomBytes(4).toString('hex'),
    text,
    kind,
    importance,
    source: input?.source === 'user' ? 'user' : 'agent',
    createdAt: Date.now(),
    expiresAt,
  }
}

export function createMemoryStore({ dir, logger, getConfig }) {
  const file = path.join(dir, 'memories.json')
  let store = readJsonSafe(file, emptyStore())
  if (!store || typeof store !== 'object') store = emptyStore()
  if (!store.users || typeof store.users !== 'object') store.users = {}
  if (!store.version) store.version = 1

  function save() {
    writeJsonAtomic(file, store, 0o600)
  }

  function cfg() {
    return getConfig()?.memory || {}
  }

  function bucket(userId) {
    const key = String(userId || '')
    if (!key) throw new Error('缺少使用者 ID')
    if (!store.users[key]) store.users[key] = { entries: [], updatedAt: 0 }
    if (!Array.isArray(store.users[key].entries)) store.users[key].entries = []
    return store.users[key]
  }

  function activeEntries(userId) {
    const now = Date.now()
    return bucket(userId).entries
      .filter((entry) => !entry.expiresAt || entry.expiresAt > now)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  function list(userId) {
    return activeEntries(userId).map((entry) => ({ ...entry }))
  }

  function add(userId, input) {
    const entry = normalizeEntry(input)
    const target = bucket(userId)
    target.entries.push(entry)
    target.updatedAt = Date.now()
    const max = Math.max(10, Math.min(Number(cfg().maxPerUser) || 120, 500))
    if (target.entries.length > max) {
      target.entries.sort((a, b) => a.createdAt - b.createdAt)
      target.entries.splice(0, target.entries.length - max)
    }
    save()
    logger?.info?.(`個人記憶：幫 ${userId} 記下「${entry.text.slice(0, 40)}」`)
    return { ...entry }
  }

  function forget(userId, { ids, query, expired } = {}) {
    const target = bucket(userId)
    const now = Date.now()
    const wanted = new Set(Array.isArray(ids) ? ids.map(String) : [])
    const needle = String(query || '').trim().toLowerCase()
    const removed = []
    target.entries = target.entries.filter((entry) => {
      const hit = (wanted.size > 0 && wanted.has(entry.id))
        || (expired === true && entry.expiresAt && entry.expiresAt <= now)
        || (needle && String(entry.text || '').toLowerCase().includes(needle))
      if (hit) removed.push(entry.id)
      return !hit
    })
    if (removed.length > 0) {
      target.updatedAt = Date.now()
      save()
      logger?.info?.(`個人記憶：從 ${userId} 刪掉 ${removed.length} 筆`)
    }
    return { removed: removed.length, ids: removed }
  }

  function prune() {
    const now = Date.now()
    let removed = 0
    for (const [userId, target] of Object.entries(store.users)) {
      const entries = Array.isArray(target?.entries) ? target.entries : []
      const kept = entries.filter((entry) => !entry.expiresAt || entry.expiresAt > now)
      removed += entries.length - kept.length
      if (kept.length !== entries.length) {
        target.entries = kept
        target.updatedAt = now
      }
      if (kept.length === 0 && Object.keys(target).length <= 2) delete store.users[userId]
    }
    if (removed > 0 || !store.lastPruneAt) {
      store.lastPruneAt = now
      save()
    }
    return { removed, at: now }
  }

  function stats() {
    const now = Date.now()
    let total = 0
    let expired = 0
    const users = []
    for (const [userId, target] of Object.entries(store.users)) {
      const entries = Array.isArray(target?.entries) ? target.entries : []
      const live = entries.filter((entry) => !entry.expiresAt || entry.expiresAt > now)
      expired += entries.length - live.length
      total += live.length
      if (live.length > 0) users.push({ userId, count: live.length, lastAt: target.updatedAt || 0 })
    }
    return { file, total, expired, users, lastPruneAt: store.lastPruneAt || 0 }
  }

  function formatForContext(userId) {
    const conf = cfg()
    if (conf.enabled === false || !userId) return ''
    const entries = activeEntries(userId)
    if (entries.length === 0) return ''
    const maxEntries = Math.max(1, Math.min(Number(conf.injectMaxEntries) || 20, 80))
    const maxChars = Math.max(200, Math.min(Number(conf.injectMaxChars) || 2000, 8000))
    const lines = []
    let used = 0
    for (const entry of entries.slice(0, maxEntries)) {
      const stamp = new Date(entry.createdAt).toISOString().slice(0, 10)
      const until = entry.expiresAt ? `，${new Date(entry.expiresAt).toISOString().slice(0, 10)} 失效` : ''
      const line = `- [${entry.kind}] ${entry.text}（${stamp}${until}）`
      if (used + line.length > maxChars) break
      lines.push(line)
      used += line.length
    }
    if (lines.length === 0) return ''
    return [
      '【你記得的關於這位使用者的事】',
      '（這些是你自己寫下的記憶；可自然引用，但不必逐條複述。若發現過期或不再成立，可用 line_memory_forget 刪掉。）',
      ...lines,
    ].join('\n')
  }

  function toolsFor(userId) {
    return [
      defineTool({
        name: 'line_memory_add',
        description: '把關於這位使用者的重要事情寫進你的個人記憶。只記長期有用、之後還會影響對話的內容；'
          + '一次性或純閒聊不要記。有期限的（例如「下週考試」「這個月在減肥」）請填 ttlDays，到期會自動刪掉。'
          + '不要記密碼、token、身分證號等敏感資料。',
        parameters: {
          text: { type: 'string', description: '要記住的事，一句到兩句，寫成你自己看得懂的描述', required: true },
          kind: { type: 'string', enum: KINDS, description: 'fact=事實、event=事件、preference=喜好、inside=你們之間的默契' },
          importance: { type: 'number', description: '1~5，越高越重要（預設 3）' },
          ttlDays: { type: 'number', description: '幾天後失效；不填或 0 表示長期保留' },
        },
        execute: async (args) => {
          const entry = add(userId, args || {})
          return { saved: true, id: entry.id, kind: entry.kind, expiresAt: entry.expiresAt || null }
        },
      }),
      defineTool({
        name: 'line_memory_forget',
        description: '刪掉你的個人記憶：用 ids 指定，或給 query 刪掉內容包含這段字的記憶；'
          + '給 expired:true 則清掉所有已到期的。使用者要求「忘掉」時就用這個。',
        parameters: {
          ids: { type: 'array', items: { type: 'string' }, description: '要刪的記憶 id' },
          query: { type: 'string', description: '刪掉內容包含這個字串的記憶' },
          expired: { type: 'boolean', description: '清掉所有已到期的記憶' },
        },
        execute: async (args) => forget(userId, args || {}),
      }),
      defineTool({
        name: 'line_memory_list',
        description: '列出你目前對這位使用者記得的內容（含 id 與到期日），想確認或整理時使用。',
        parameters: {},
        execute: async () => ({ count: activeEntries(userId).length, entries: activeEntries(userId) }),
      }),
    ]
  }

  return { file, list, add, forget, prune, stats, formatForContext, toolsFor }
}
