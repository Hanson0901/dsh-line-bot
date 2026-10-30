// 插件自己的人設庫：不依賴任何「個性外掛」也能用。
//
// 存檔在 <DSH_HOME>/line-bot/personas.json（0600）。對外的 id 一律加
// `local:` 前綴，這樣它和大肥魚（dafeiyu）的人設 id 不會撞在一起，
// 面板、狀態、LINE 指令都只需要認得這個複合 id。
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { nowIso, readJsonSafe, writeJsonAtomic } from './util.mjs'

export const LOCAL_PREFIX = 'local:'
const MAX_NAME = 60
const MAX_TEXT = 64000

function selectionId(localId) {
  return `${LOCAL_PREFIX}${localId}`
}

function normalize(raw) {
  return {
    id: String(raw.id),
    name: String(raw.name || '未命名').slice(0, MAX_NAME),
    text: String(raw.text || ''),
    createdAt: raw.createdAt || nowIso(),
  }
}

export function createLocalPersonas({ dir, logger }) {
  const file = path.join(dir, 'personas.json')
  let cache = null

  function read() {
    if (cache) return cache
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch {
      /* 目錄建立失敗時，讀寫會再報錯 */
    }
    const raw = readJsonSafe(file, { version: 1, personas: [] })
    const list = Array.isArray(raw?.personas) ? raw.personas : []
    cache = {
      version: 1,
      personas: list
        .filter((item) => item && item.id && typeof item.text === 'string')
        .map(normalize),
    }
    return cache
  }

  function persist(next) {
    writeJsonAtomic(file, { version: 1, personas: next }, 0o600)
    cache = { version: 1, personas: next }
  }

  function validateText(text) {
    const value = String(text || '').trim()
    if (!value) throw new Error('人設內容不能是空的')
    if (value.length > MAX_TEXT) throw new Error(`人設內容太長（上限 ${MAX_TEXT} 字）`)
    return value
  }

  function catalog() {
    return read().personas.map((item) => ({
      id: selectionId(item.id),
      localId: item.id,
      name: item.name,
      source: 'local',
      builtin: false,
      enabled: true,
      chars: item.text.length,
      description: '插件內建人設（不依賴外掛）',
    }))
  }

  function get(idOrSelection) {
    const key = String(idOrSelection || '')
    if (!key.startsWith(LOCAL_PREFIX)) return null
    const localId = key.slice(LOCAL_PREFIX.length)
    return read().personas.find((item) => item.id === localId) || null
  }

  function add({ name, text }) {
    const title = String(name || '').trim().slice(0, MAX_NAME)
    if (!title) throw new Error('請填入人設名稱')
    const body = validateText(text)
    const item = normalize({ id: randomBytes(4).toString('hex'), name: title, text: body })
    persist([...read().personas, item])
    logger?.info?.(`新增自訂人設「${item.name}」`)
    return { ...catalog().find((entry) => entry.localId === item.id), text: item.text }
  }

  function update({ id, name, text }) {
    const item = get(id)
    if (!item) throw new Error('找不到這個自訂人設')
    const title = String(name ?? item.name).trim().slice(0, MAX_NAME)
    if (!title) throw new Error('人設名稱不能是空的')
    const body = validateText(text ?? item.text)
    const next = read().personas.map((entry) => (entry.id === item.id ? { ...entry, name: title, text: body } : entry))
    persist(next)
    logger?.info?.(`更新自訂人設「${title}」`)
    return { id: selectionId(item.id), name: title, chars: body.length }
  }

  function remove(id) {
    const item = get(id)
    if (!item) throw new Error('找不到這個自訂人設')
    persist(read().personas.filter((entry) => entry.id !== item.id))
    logger?.info?.(`刪除自訂人設「${item.name}」`)
    return { id: selectionId(item.id), name: item.name, removed: true }
  }

  return {
    file,
    catalog,
    get,
    add,
    update,
    remove,
    selectionId,
    stats: () => ({ count: read().personas.length, path: file }),
  }
}
