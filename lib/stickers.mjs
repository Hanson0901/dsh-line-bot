// 表情包圖庫：把使用者上傳的圖片存到 <dataDir>/stickers，
// 回覆時由角色用 [[sticker:名稱]] 標記挑一張，再由 host 轉成 LINE image message。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { readJsonSafe, writeJsonAtomic } from './util.mjs'

const MAX_BYTES = 5 * 1024 * 1024
const MAX_NAME = 40
const MAX_DESC = 160

function sniff(buffer) {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    const width = buffer.readUInt32BE(16)
    const height = buffer.readUInt32BE(20)
    return { mime: 'image/png', ext: 'png', width, height }
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg', ...jpegSize(buffer) }
  }
  return null
}

function jpegSize(buffer) {
  let offset = 2
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = buffer[offset + 1]
    const length = buffer.readUInt16BE(offset + 2)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
    }
    offset += 2 + length
  }
  return { width: 0, height: 0 }
}

function decodeBase64(input) {
  const text = String(input || '')
  const comma = text.indexOf(',')
  const payload = text.startsWith('data:') && comma >= 0 ? text.slice(comma + 1) : text
  if (!payload) throw new Error('沒有收到圖片內容')
  const buffer = Buffer.from(payload.replace(/\s+/g, ''), 'base64')
  if (buffer.length === 0) throw new Error('圖片解碼後是空的')
  return buffer
}

export function createStickerStore({ dir, logger }) {
  const baseDir = path.join(dir, 'stickers')
  const indexFile = path.join(baseDir, 'index.json')
  let cache = null

  function ensureDir() {
    if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true })
  }

  function load() {
    if (cache) return cache
    const raw = readJsonSafe(indexFile, { version: 1, items: [] })
    const items = Array.isArray(raw?.items) ? raw.items.filter((item) => item && item.id && item.file) : []
    cache = { version: 1, items }
    return cache
  }

  function save(store) {
    ensureDir()
    writeJsonAtomic(indexFile, store)
    cache = store
  }

  function list() {
    return load().items.map((item) => ({ ...item }))
  }

  function get(idOrName) {
    const key = String(idOrName || '').trim().toLowerCase()
    if (!key) return null
    return load().items.find((item) => item.id.toLowerCase() === key || item.name.toLowerCase() === key) || null
  }

  function filePath(entry) {
    return path.join(baseDir, entry.file)
  }

  function readFile(entry) {
    try {
      return readFileSync(filePath(entry))
    } catch {
      return null
    }
  }

  function uniqueName(name, ignoreId) {
    const wanted = String(name || '').trim().slice(0, MAX_NAME) || 'sticker'
    const taken = new Set(load().items.filter((item) => item.id !== ignoreId).map((item) => item.name.toLowerCase()))
    if (!taken.has(wanted.toLowerCase())) return wanted
    let index = 2
    while (taken.has(`${wanted}-${index}`.toLowerCase())) index += 1
    return `${wanted}-${index}`
  }

  function add({ name, description, dataUrl }) {
    const buffer = decodeBase64(dataUrl)
    if (buffer.length > MAX_BYTES) throw new Error(`圖片太大（${Math.round(buffer.length / 1024)} KB），上限 5 MB`)
    const info = sniff(buffer)
    if (!info) throw new Error('只接受 PNG 或 JPEG 圖片')
    ensureDir()
    const id = randomBytes(4).toString('hex')
    const file = `${id}.${info.ext}`
    writeFileSync(path.join(baseDir, file), buffer)
    const entry = {
      id,
      name: uniqueName(name),
      description: String(description || '').trim().slice(0, MAX_DESC),
      mime: info.mime,
      file,
      bytes: buffer.length,
      width: info.width || 0,
      height: info.height || 0,
      createdAt: Date.now(),
    }
    const store = load()
    save({ version: 1, items: [entry, ...store.items] })
    logger?.info?.(`表情包已加入：${entry.name}（${Math.round(buffer.length / 1024)} KB）`)
    return { ...entry }
  }

  function update(id, patch = {}) {
    const store = load()
    const entry = store.items.find((item) => item.id === id)
    if (!entry) throw new Error('找不到這個表情包')
    if (patch.name !== undefined) entry.name = uniqueName(patch.name, entry.id)
    if (patch.description !== undefined) entry.description = String(patch.description || '').trim().slice(0, MAX_DESC)
    save({ version: 1, items: store.items })
    return { ...entry }
  }

  function remove(id) {
    const store = load()
    const entry = store.items.find((item) => item.id === id)
    if (!entry) throw new Error('找不到這個表情包')
    try {
      rmSync(filePath(entry), { force: true })
    } catch (error) {
      logger?.warn?.(`刪除表情包檔案失敗：${error?.message || error}`)
    }
    save({ version: 1, items: store.items.filter((item) => item.id !== id) })
    return { id: entry.id, name: entry.name, removed: true }
  }

  function stats() {
    const items = load().items
    return { dir: baseDir, indexFile, count: items.length, bytes: items.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0) }
  }

  return { list, get, add, update, remove, readFile, filePath, stats }
}
