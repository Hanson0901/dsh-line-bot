// 共用小工具：JSON/HTTP、檔案、遮罩、文字切塊。
import fs from 'node:fs'
import path from 'node:path'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function nowIso() {
  return new Date().toISOString()
}

/** 只保留頭尾字元，其餘遮掉；面板只會看到遮罩值。 */
export function maskSecret(value, keep = 4) {
  if (typeof value !== 'string' || value.length === 0) return ''
  if (value.length <= keep * 2) return `${'•'.repeat(Math.max(4, value.length - keep))}${value.slice(-keep)}`
  return `${value.slice(0, keep)}…${value.slice(-keep)}`
}

export function isMaskedValue(value) {
  return typeof value === 'string' && (value.includes('…') || value.includes('•'))
}

export function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** 原子寫檔；預設 600，避免憑證被其他使用者讀到。 */
export function writeJsonAtomic(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode })
  fs.renameSync(tmp, file)
  try {
    fs.chmodSync(file, mode)
  } catch {
    /* 非 POSIX 就算了 */
  }
}

export function jsonSend(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(data),
  })
  res.end(data)
}

export function jsonOk(res, value) {
  jsonSend(res, 200, { ok: true, value })
}

export function jsonFail(res, error, status = 400) {
  jsonSend(res, status, { ok: false, error: error instanceof Error ? error.message : String(error) })
}

export async function readRequestBody(req, limit = 2 * 1024 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) throw new Error('請求內容過大')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export async function readJsonBody(req, limit = 2 * 1024 * 1024) {
  const raw = await readRequestBody(req, limit)
  if (raw.length === 0) return {}
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    throw new Error('請求內容不是合法 JSON')
  }
}

export function clip(text, max = 300) {
  const s = String(text ?? '')
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}

/** LINE 單則文字上限 5000 字元，保守切 4900。 */
export function chunkText(text, size = 4900, max = 5) {
  const s = String(text ?? '')
  if (!s) return []
  const out = []
  for (let i = 0; i < s.length && out.length < max; i += size) out.push(s.slice(i, i + size))
  return out
}

export function safeArray(value) {
  if (!Array.isArray(value)) return []
  return value.map((it) => String(it ?? '').trim()).filter(Boolean)
}

export function timeHHMM(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** "HH:MM" → 當天分鐘數 */
export function parseMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim())
  if (!m) return null
  const hh = Number(m[1])
  const mm = Number(m[2])
  if (hh > 23 || mm > 59) return null
  return hh * 60 + mm
}

/** 支援跨午夜（00:30–09:30 或 23:00–07:00） */
export function inQuietWindow(minutes, start, end) {
  if (start === null || end === null) return false
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end
}

export function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分 ${s % 60} 秒`
  const hh = Math.floor(m / 60)
  return `${hh} 小時 ${m % 60} 分`
}

export function hostnameOf(url) {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}
