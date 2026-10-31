// 用 modlens CLI 看圖：只在模型本身不支援圖片、或需要描述時使用。
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TIMEOUT_MS = 90_000

function candidateMains() {
  const list = []
  if (process.env.MODLENS_MAIN) list.push(process.env.MODLENS_MAIN)
  const home = os.homedir()
  for (const profile of ['desktop', 'web', 'line', 'headless']) {
    list.push(path.join(home, '.dsh', 'profiles', profile, 'node_modules', '@liustack', 'modlens', 'dist', 'main.js'))
  }
  list.push('/opt/homebrew/lib/node_modules/@liustack/modlens/dist/main.js')
  list.push('/usr/local/lib/node_modules/@liustack/modlens/dist/main.js')
  return list
}

function execFileAsync(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout
        error.stderr = stderr
        reject(error)
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

function pickText(data) {
  const parts = []
  if (data?.summary) parts.push(String(data.summary).trim())
  const scene = data?.semantics?.scene
  if (scene && !parts.includes(scene)) parts.push(String(scene).trim())
  const intent = data?.semantics?.intent
  if (intent) parts.push(`意圖：${intent}`)
  const entities = Array.isArray(data?.semantics?.entities) ? data.semantics.entities.map((item) => item?.name).filter(Boolean) : []
  if (entities.length) parts.push(`畫面元素：${entities.slice(0, 6).join('、')}`)
  const ocr = String(data?.ocr?.full_text || '').trim()
  if (ocr) parts.push(`文字：${ocr.slice(0, 240)}`)
  const regions = Array.isArray(data?.layout?.regions) ? data.layout.regions.map((item) => item?.text).filter(Boolean) : []
  if (!parts.length && regions.length) parts.push(regions.slice(0, 8).join(' '))
  const text = parts.filter(Boolean).join('；').replace(/\s+/g, ' ').trim()
  return text.slice(0, 600)
}

export function createVision({ logger, cacheDir }) {
  let mainPath
  let lastError = ''

  function resolveMain() {
    if (mainPath !== undefined) return mainPath
    mainPath = candidateMains().find((file) => fs.existsSync(file)) || ''
    return mainPath
  }

  function available() {
    return Boolean(resolveMain())
  }

  function status() {
    return { available: available(), main: resolveMain(), lastError }
  }

  async function describe(file, { prompt = '', provider = '', model = '' } = {}) {
    if (!available()) throw new Error('找不到 modlens（請安裝 @liustack/modlens 或設定 MODLENS_MAIN）')
    if (!file) throw new Error('沒有指定圖片')
    if (!/^https?:\/\//i.test(file) && !fs.existsSync(file)) throw new Error('找不到要看的圖片檔案')
    const dir = cacheDir || path.join(os.tmpdir(), 'dsh-line-bot-vision')
    fs.mkdirSync(dir, { recursive: true })
    const out = path.join(dir, `modlens-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.json`)
    const args = ['analyze', '-i', file, '-o', out, '--timeout', String(TIMEOUT_MS)]
    if (provider) args.push('--provider', provider)
    if (model) args.push('--model', model)
    if (prompt) args.push('--prompt', prompt)
    try {
      await execFileAsync(process.execPath, [resolveMain(), ...args], { timeout: TIMEOUT_MS + 15_000 })
      const raw = JSON.parse(fs.readFileSync(out, 'utf8'))
      const text = pickText(raw)
      if (!text) throw new Error('modlens 沒有回傳可用的描述')
      lastError = ''
      return { text, raw }
    } catch (error) {
      lastError = String(error?.message || error).slice(0, 300)
      logger?.warn?.(`modlens 看圖失敗：${lastError}`)
      throw error
    } finally {
      try {
        fs.rmSync(out, { force: true })
      } catch {}
    }
  }

  return { available, describe, status }
}
