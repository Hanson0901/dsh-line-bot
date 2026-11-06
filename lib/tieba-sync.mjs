// 把「刷貼吧」每天學到的語氣寫回大肥魚的人設本文。
//
// 兩邊的資料本來是分開的：
//   - 刷貼吧：<DSH_HOME>/tieba-duty/persona.json（tieba_evolve_apply 每天最多寫一次）
//   - 大肥魚：<DSH_HOME>/storages/dsh-persona-dafeiyu/personas.json
// 這裡只改「面板指定的人設」裡的「## 貼吧學來的口氣」段落，其他文字原封不動。
//
// 注意：大肥魚外掛在 apply() 只 readStore() 一次，直接改檔它看不到。所以寫完檔案後
// 會把 loader 裡的 persona-dafeiyu entry dispose + 重新 init，讓它重新讀檔。
import fs from 'node:fs'
import path from 'node:path'
import { dshHome, dataDir } from './config.mjs'
import { readJsonSafe, writeJsonAtomic } from './util.mjs'

const SECTION_HEADING = '## 貼吧學來的口氣'
const TRAITS = [
  ['溫柔', 'gentle'],
  ['毒舌', 'sharp'],
  ['抽象', 'abstract'],
  ['話癆', 'talkative'],
  ['發圖傾向', 'imageBias'],
]

export function tiebaPersonaPath() {
  return path.join(dshHome(), 'tieba-duty', 'persona.json')
}

export function dafeiyuStorePath() {
  return path.join(dshHome(), 'storages', 'dsh-persona-dafeiyu', 'personas.json')
}

function pad(n) {
  return String(n).padStart(2, '0')
}

function stampOf(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function readTiebaPersona() {
  const file = tiebaPersonaPath()
  const raw = readJsonSafe(file, null)
  if (!raw || typeof raw !== 'object') throw new Error(`讀不到刷貼吧人設：${file}`)
  const samples = Array.isArray(raw.voice?.samples) ? raw.voice.samples.map((item) => String(item).trim()).filter(Boolean) : []
  if (!samples.length) throw new Error('刷貼吧人設裡還沒有語氣樣本（voice.samples 是空的）')
  return { raw, samples, traits: raw.traits || {}, version: Number(raw.version) || 0, file }
}

function readPersonaStore() {
  const file = dafeiyuStorePath()
  const raw = readJsonSafe(file, null)
  if (!raw || !Array.isArray(raw.personas)) throw new Error(`讀不到大肥魚人設檔：${file}`)
  return { raw, file }
}

/** 產生要放進人設本文的段落（固定標題，方便下次整段替換）。 */
export function buildSection(tieba, date = new Date()) {
  const samples = tieba.samples.slice(-8)
  const lines = [
    `## 貼吧學來的口氣（自動同步 ${stampOf(date)}）`,
    `（以下 ${samples.length} 句是刷貼吧學到的語氣樣本，簡體原樣；意思到了就好，用繁體照著說，別照抄成口頭禪。）`,
    '',
    ...samples.map((item) => `- ${item}`),
  ]
  const traits = tieba.traits || {}
  const traitBits = TRAITS
    .filter(([, key]) => Number.isFinite(Number(traits[key])))
    .map(([label, key]) => `${label} ${Math.round(Number(traits[key]))}`)
  if (traitBits.length) lines.push('', `語氣參考：${traitBits.join('／')}`)
  return `${lines.join('\n')}\n\n`
}

// 只比較內容：標題裡的時間戳每次都會變，不能拿它判斷「語氣有變化」。
function sansStamp(text) {
  return String(text).replace(/(##\s*貼吧學來的口氣（自動同步 )[^）]*(）)/, '$1…$2')
}

function findSection(text) {
  const heading = /^##\s*貼吧學來的口氣[^\n]*$/m.exec(text)
  if (!heading) return null
  const start = heading.index
  const rest = text.slice(start + heading[0].length)
  const next = /^##\s/m.exec(rest)
  const end = next ? start + heading[0].length + next.index : text.length
  return { start, end, text: text.slice(start, end) }
}

/** 用人設本文的「貼吧學來的口氣」段落做替換；沒有這段就附加到最後。 */
export function applySection(text, section) {
  const hit = findSection(text)
  if (!hit) {
    const base = text.trimEnd()
    return `${base}\n\n${section.trimEnd()}\n`
  }
  const before = text.slice(0, hit.start)
  const after = text.slice(hit.end)
  const trailing = after.startsWith('\n') ? after : `\n${after}`
  return `${before}${section.trimEnd()}\n${trailing}`.replace(/\n{3,}/g, '\n\n')
}

function applyTraits(text, traits) {
  if (!traits || typeof traits !== 'object') return text
  let out = text
  for (const [label, key] of TRAITS) {
    const n = Number(traits[key])
    if (!Number.isFinite(n)) continue
    const re = new RegExp(`(-\\s*${label}\\s*)\\d+(\\s*\\/\\s*10)`)
    out = out.replace(re, `$1${Math.round(n)}$2`)
  }
  return out
}

/**
 * 讓大肥魚外掛重新 apply()（它只在那時 readStore）。
 * loader entry 的 dispose + init 是它自己的生命週期，等同停掉再啟動這個外掛。
 */
export async function reloadPersonaPlugin(ctx) {
  const loader = (typeof ctx?.get === 'function' ? ctx.get('loader') : undefined) || ctx?.loader
  if (!loader) return { ok: false, error: '目前執行環境沒有 loader 服務（headless？）' }
  const entry = [...loader.entries()].find((item) => item.options?.id === 'persona-dafeiyu'
    || String(item.options?.name || '').includes('persona-dafeiyu'))
  if (!entry) return { ok: false, error: '找不到 persona-dafeiyu 外掛 entry' }
  const uidBefore = entry.fiber?.uid ?? null
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  await entry.fiber?.dispose?.()
  entry.fiber = undefined
  // dsh-persona-dafeiyu 0.8.0 在 dispose 後第一次 init 偶爾不會生成 fiber，
  // 這時 bridge 會變 401；等一下再 init 一次通常就會恢復。
  await entry.init()
  await wait(700)
  let uidAfter = entry.fiber?.uid ?? null
  if (uidAfter == null) {
    await wait(900)
    uidAfter = entry.fiber?.uid ?? null
  }
  if (uidAfter == null) {
    await entry.init()
    await wait(700)
    uidAfter = entry.fiber?.uid ?? null
  }
  if (uidAfter == null) return { ok: false, uidBefore, uidAfter, error: '重新 init 後仍沒有 fiber' }
  return { ok: true, uidBefore, uidAfter }
}

export function personaOverlayPath(personaId) {
  const safe = String(personaId || '').replace(/[^A-Za-z0-9:_-]/g, '_')
  return path.join(dataDir(), 'persona-overlays', `${safe}.md`)
}

export function readPersonaOverlay(personaId) {
  try {
    return fs.readFileSync(personaOverlayPath(personaId), 'utf8')
  } catch {
    return ''
  }
}

/** 從刷貼吧的風格庫挑短句，當作「梗／金句」匯入。 */
export function readTiebaStyleSamples({ limit = 40, minLikes = 30 } = {}) {
  const file = path.join(dshHome(), 'tieba-duty', 'style-lib.json')
  const raw = readJsonSafe(file, null)
  if (!raw || typeof raw !== 'object') return []
  const out = []
  const seen = new Set()
  for (const [bar, pack] of Object.entries(raw)) {
    let barLabel = bar
    try { barLabel = decodeURIComponent(bar) } catch { /* keep raw */ }
    if (!/弱智|抽象|搞笑|梗|段子|地狱|孫|孙|乐子|整活/.test(barLabel)) continue
    const samples = Array.isArray(pack?.samples) ? pack.samples : []
    for (const sample of samples) {
      const text = String(sample?.text || '').replace(/\s+/g, ' ').trim()
      const likes = Number(sample?.likes) || 0
      const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length
      const ascii = (text.match(/[A-Za-z]/g) || []).length
      if (likes < Math.max(50, minLikes) || text.length < 5 || text.length > 30) continue
      if (cjk < 3 || ascii > 2) continue
      if (/^(?:\[|https?:|image_emoticon)/i.test(text)) continue
      if (seen.has(text)) continue
      seen.add(text)
      let barName = bar
      try { barName = decodeURIComponent(bar) } catch { /* keep raw */ }
      out.push({ text, usage: `貼吧「${barName}」高讚回覆（${likes} 讚）` })
      if (out.length >= limit) return out
    }
  }
  return out
}

/** 把梗類貼吧加進刷貼吧的 bars / barPool（會先備份設定檔）。 */
export function ensureTiebaBars(bars = ['弱智吧', '抽象吧', '搞笑吧', '梗吧']) {
  const file = path.join(dshHome(), 'tieba-duty', 'config.json')
  const raw = readJsonSafe(file, null)
  if (!raw) throw new Error(`讀不到刷貼吧設定：${file}`)
  const currentBars = Array.isArray(raw.bars) ? raw.bars.slice() : []
  const currentPool = Array.isArray(raw.barPool) ? raw.barPool.slice() : currentBars.slice()
  const added = []
  for (const bar of bars) {
    if (!currentBars.includes(bar)) { currentBars.push(bar); added.push(bar) }
    if (!currentPool.includes(bar)) currentPool.push(bar)
  }
  if (added.length > 0) {
    fs.copyFileSync(file, `${file}.bak-linebot-${Date.now()}`)
    writeJsonAtomic(file, { ...raw, bars: currentBars, barPool: currentPool })
  }
  return { added, bars: currentBars, file }
}

export function createTiebaSync({ ctx, store, logger, getCatalog }) {
  const dir = dataDir()
  const backupDir = path.join(dir, 'persona-backups')
  let timer = null
  let inflight = null

  function config() {
    const cfg = store.get()
    return cfg.sync || {}
  }

  async function catalog() {
    try {
      return (await getCatalog?.()) || []
    } catch {
      return []
    }
  }

  function overlayWrite(personaId, text) {
    const file = personaOverlayPath(personaId)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
    return file
  }

  async function preview() {
    const tieba = readTiebaPersona()
    const targetId = String(config().targetPersonaId || '').trim() || 'dafeiyu'
    const list = await catalog()
    const info = list.find((item) => item.id === targetId)
    const builtin = Boolean(info?.builtin) || ['dafeiyu', 'acha', 'tinglan'].includes(targetId)
    const overlayMode = builtin || String(targetId).startsWith('local:') || info?.source === 'local'
    const section = buildSection(tieba)
    if (overlayMode) {
      const oldText = readPersonaOverlay(targetId)
      return {
        ok: true,
        mode: 'overlay',
        targetId,
        targetName: info?.name || targetId,
        version: tieba.version,
        samples: tieba.samples,
        traits: tieba.traits,
        currentSection: oldText.trim(),
        nextSection: section,
        changed: sansStamp(oldText) !== sansStamp(section),
        overlayPath: personaOverlayPath(targetId),
      }
    }
    const { raw } = readPersonaStore()
    const target = raw.personas.find((item) => item.id === targetId)
    if (!target) throw new Error(`大肥魚人設裡找不到「${targetId || '(未設定)'}」`)
    const oldText = String(target.text || '')
    const nextText = applySection(oldText, section)
    return {
      ok: true,
      mode: 'persona',
      targetId,
      targetName: target.name,
      version: tieba.version,
      samples: tieba.samples,
      traits: tieba.traits,
      currentSection: findSection(oldText)?.text || '',
      nextSection: section,
      changed: nextText !== oldText,
    }
  }

  async function run({ force = false } = {}) {
    if (inflight) return inflight
    inflight = (async () => {
      const cfg = config()
      if (!force && !cfg.enabled) return { skipped: 'disabled' }
      const tieba = readTiebaPersona()
      const targetId = String(cfg.targetPersonaId || '').trim() || 'dafeiyu'
      const list = await catalog()
      const info = list.find((item) => item.id === targetId)
      const builtin = Boolean(info?.builtin) || ['dafeiyu', 'acha', 'tinglan'].includes(targetId)
      const overlayMode = builtin || String(targetId).startsWith('local:') || info?.source === 'local'
      const section = buildSection(tieba)
      const at = Date.now()
      const stateSync = store.getState().sync || {}
      let changed = false
      let backupPath = ''
      let reload = null
      let sectionText = section

      if (overlayMode) {
        const oldText = readPersonaOverlay(targetId)
        const nextText = applySection(oldText, section).trimEnd() + '\n'
        changed = sansStamp(oldText) !== sansStamp(section)
        if (!changed && stateSync.version === tieba.version) {
          return { skipped: 'unchanged', version: tieba.version, targetId, mode: 'overlay' }
        }
        if (changed) {
          fs.mkdirSync(backupDir, { recursive: true })
          if (oldText) {
            backupPath = path.join(backupDir, `overlay-${targetId}-${new Date().toISOString().replace(/[:.]/g, '-')}.md`)
            fs.writeFileSync(backupPath, oldText)
          }
          overlayWrite(targetId, nextText)
          logger.info(`已把刷貼吧學到的口氣寫進「${info?.name || targetId}」的覆蓋層`)
        }
        sectionText = nextText
      } else {
        const { raw } = readPersonaStore()
        const target = raw.personas.find((item) => item.id === targetId)
        if (!target) throw new Error(`大肥魚人設裡找不到「${targetId}」`)
        const oldText = String(target.text || '')
        let nextText = applySection(oldText, section)
        if (cfg.syncTraits !== false) nextText = applyTraits(nextText, tieba.traits)
        changed = sansStamp(nextText) !== sansStamp(oldText)
        if (!changed && stateSync.version === tieba.version) {
          return { skipped: 'unchanged', version: tieba.version, targetId, mode: 'persona' }
        }
        if (changed) {
          if (nextText.length > 64000) throw new Error(`人設正文會超過 64000 字（${nextText.length}）`)
          fs.mkdirSync(backupDir, { recursive: true })
          backupPath = path.join(backupDir, `personas-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
          fs.writeFileSync(backupPath, JSON.stringify(raw, null, 2))
          const next = {
            ...raw,
            personas: raw.personas.map((item) => (item.id === targetId ? { ...item, text: nextText } : item)),
          }
          writeJsonAtomic(dafeiyuStorePath(), next)
          logger.info(`已把刷貼吧學到的語氣寫回人設「${target.name || targetId}」（版本 ${tieba.version}）`)
        }
        sectionText = nextText
      }

      store.updateState((state) => ({
        ...state,
        sync: {
          at,
          version: tieba.version,
          targetId,
          mode: overlayMode ? 'overlay' : 'persona',
          samples: tieba.samples.length,
          changed,
          backupPath,
          reloadOk: null,
          error: '',
        },
      }))

      if (!overlayMode && changed && cfg.reloadPersona !== false) {
        try {
          reload = await reloadPersonaPlugin(ctx)
          if (!reload.ok) logger.warn(`重載大肥魚外掛失敗：${reload.error}`)
        } catch (error) {
          reload = { ok: false, error: String(error?.message || error) }
          logger.warn(`重載大肥魚外掛失敗：${reload.error}`)
        }
        store.updateState((state) => ({ ...state, sync: { ...(state.sync || {}), reloadOk: Boolean(reload?.ok) } }))
      }
      return {
        at,
        version: tieba.version,
        targetId,
        targetName: info?.name || targetId,
        mode: overlayMode ? 'overlay' : 'persona',
        changed,
        samples: tieba.samples.length,
        backupPath,
        reload,
        nextSection: sectionText,
      }
    })()
    try {
      return await inflight
    } finally {
      inflight = null
    }
  }

  function stats() {
    const cfg = config()
    const stateSync = store.getState().sync || {}
    let tiebaVersion = null
    let tiebaSamples = 0
    try {
      const tieba = readTiebaPersona()
      tiebaVersion = tieba.version
      tiebaSamples = tieba.samples.length
    } catch { /* 檔案還沒生成時不用報錯 */ }
    const lastAt = Number(stateSync.at) || 0
    const intervalMs = Math.max(5, Number(cfg.intervalMinutes) || 60) * 60000
    return {
      enabled: Boolean(cfg.enabled),
      targetPersonaId: cfg.targetPersonaId || 'dafeiyu',
      intervalMinutes: Number(cfg.intervalMinutes) || 60,
      syncTraits: cfg.syncTraits !== false,
      reloadPersona: cfg.reloadPersona !== false,
      lastAt,
      lastVersion: stateSync.version ?? null,
      lastChanged: stateSync.changed ?? null,
      lastSamples: stateSync.samples ?? 0,
      lastError: stateSync.error || '',
      lastBackupPath: stateSync.backupPath || '',
      reloadOk: stateSync.reloadOk ?? null,
      lastTargetId: stateSync.targetId || '',
      lastMode: stateSync.mode || '',
      nextAt: cfg.enabled ? (lastAt ? lastAt + intervalMs : Date.now()) : 0,
      tiebaVersion,
      tiebaSamples,
      pending: tiebaVersion !== null && tiebaVersion !== (stateSync.version ?? null),
    }
  }

  async function tick() {
    const cfg = config()
    if (!cfg.enabled) return
    const due = Number(store.getState().sync?.at) || 0
    const intervalMs = Math.max(5, Number(cfg.intervalMinutes) || 60) * 60000
    if (due && Date.now() - due < intervalMs) return
    try {
      await run()
    } catch (error) {
      const message = String(error?.message || error)
      logger.warn(`貼吧人設同步失敗：${message}`)
      store.updateState((state) => ({ ...state, sync: { ...(state.sync || {}), at: Date.now(), error: message } }))
    }
  }

  function start() {
    if (timer) return
    timer = setInterval(() => { void tick() }, 60000)
    if (typeof timer.unref === 'function') timer.unref()
    setTimeout(() => { void tick() }, 8000)
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
  }

  return { preview, run, stats, start, stop, tick }
}
