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
  await entry.fiber?.dispose?.()
  entry.fiber = undefined
  await entry.init()
  await new Promise((resolve) => setTimeout(resolve, 400))
  return { ok: true, uidBefore, uidAfter: entry.fiber?.uid ?? null }
}

export function createTiebaSync({ ctx, store, logger }) {
  const dir = dataDir()
  const backupDir = path.join(dir, 'persona-backups')
  let timer = null
  let inflight = null

  function config() {
    const cfg = store.get()
    return cfg.sync || {}
  }

  function preview() {
    const tieba = readTiebaPersona()
    const { raw } = readPersonaStore()
    const targetId = String(config().targetPersonaId || '').trim()
    const target = raw.personas.find((item) => item.id === targetId)
    if (!target) throw new Error(`大肥魚人設裡找不到「${targetId || '(未設定)'}」`)
    const section = buildSection(tieba)
    const oldText = String(target.text || '')
    const nextText = applySection(oldText, section)
    return {
      ok: true,
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
      const { raw } = readPersonaStore()
      const targetId = String(cfg.targetPersonaId || '').trim()
      const target = raw.personas.find((item) => item.id === targetId)
      if (!target) {
        throw new Error(targetId
          ? `大肥魚人設裡找不到「${targetId}」`
          : '尚未選擇要同步的人設（面板：回覆人設 → 貼吧學習同步）')
      }

      const oldText = String(target.text || '')
      let nextText = applySection(oldText, buildSection(tieba))
      if (cfg.syncTraits !== false) nextText = applyTraits(nextText, tieba.traits)
      const changed = sansStamp(nextText) !== sansStamp(oldText)
      const stateSync = store.getState().sync || {}
      if (!changed && stateSync.version === tieba.version) {
        return { skipped: 'unchanged', version: tieba.version, targetId }
      }

      const at = Date.now()
      let backupPath = ''
      let reload = null
      if (changed) {
        if (nextText.length > 64000) throw new Error(`人設正文會超過 64000 字（${nextText.length}）`)
        fs.mkdirSync(backupDir, { recursive: true })
        backupPath = path.join(backupDir, `personas-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
        fs.writeFileSync(backupPath, JSON.stringify(raw, null, 2))
        // 只換目標人設的 text，其他欄位（mode/current/disabled/workspaces）原封不動。
        const next = {
          ...raw,
          personas: raw.personas.map((item) => (item.id === targetId ? { ...item, text: nextText } : item)),
        }
        writeJsonAtomic(dafeiyuStorePath(), next)
        logger.info(`已把刷貼吧學到的語氣寫回人設「${target.name || targetId}」（版本 ${tieba.version}）`)
      }

      // 先記帳再重載：重載要幾百毫秒，中途若插件重啟，新實例讀到的 state 才不會還停在舊的 at 而立刻再跑一次。
      store.updateState((state) => ({
        ...state,
        sync: {
          at,
          version: tieba.version,
          targetId,
          samples: tieba.samples.length,
          changed,
          backupPath,
          reloadOk: null,
          error: '',
        },
      }))

      if (changed && cfg.reloadPersona !== false) {
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
        targetName: target.name,
        changed,
        samples: tieba.samples.length,
        backupPath,
        reload,
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
      targetPersonaId: cfg.targetPersonaId || '',
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
