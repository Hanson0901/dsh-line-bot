// 診斷工具：把「為什麼圖片沒送出去」這類問題變成可讀的檢查清單。
// 只讀取本機狀態，不修改設定；repair 由 host 另外執行安全修復。
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

export function whichCommand(name) {
  const cmd = process.platform === 'win32' ? 'where' : 'which'
  try {
    const result = spawnSync(cmd, [name], { encoding: 'utf8', timeout: 5000, windowsHide: true })
    if (result.status !== 0) return ''
    return String(result.stdout || '')
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find(Boolean) || ''
  } catch {
    return ''
  }
}

export function check(id, title, status, detail, fix = '') {
  return { id, title, status, detail: String(detail || ''), fix: String(fix || '') }
}

export function summarizeChecks(checks) {
  const counts = { ok: 0, warn: 0, fail: 0 }
  for (const item of checks) counts[item.status] = (counts[item.status] || 0) + 1
  const status = counts.fail > 0 ? 'fail' : counts.warn > 0 ? 'warn' : 'ok'
  return { status, ...counts, total: checks.length }
}

export function scanLogForErrors(file, { limit = 8, maxBytes = 200000 } = {}) {
  try {
    const stat = fs.statSync(file)
    if (!stat.size) return []
    const start = Math.max(0, stat.size - maxBytes)
    const fd = fs.openSync(file, 'r')
    const buffer = Buffer.alloc(stat.size - start)
    fs.readSync(fd, buffer, 0, buffer.length, start)
    fs.closeSync(fd)
    const lines = buffer.toString('utf8').split(/\r?\n/).filter(Boolean)
    const hits = []
    const seen = new Set()
    for (const line of lines) {
      if (!/\[(warn|error)\]/.test(line)) continue
      const key = line.replace(/^\S+\s+/, '').slice(0, 160)
      if (seen.has(key)) continue
      seen.add(key)
      hits.push(line.trim())
    }
    return hits.slice(-limit)
  } catch {
    return []
  }
}

export function formatChecks(checks) {
  const icon = { ok: '✅', warn: '⚠️ ', fail: '❌' }
  return checks
    .map((item) => `${icon[item.status] || '•'} ${item.title}：${item.detail}${item.fix ? `\n   → ${item.fix}` : ''}`)
    .join('\n')
}
