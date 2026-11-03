// dsh-line-bot 的 host 端：設定/狀態、LINE 憑證、webhook 伺服器、Cloudflare 隧道、
// 大肥魚人設、agent 回覆與主動傳訊，全部集中在這裡，index.js 只負責載入與路由掛載。
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
// 用 ?v= 載入：dev/reload 重新 import host.mjs 時，這整組模組也會跟著重新求值，
// 不用重開 DSH 就能套用 lib/*.mjs 的修改。
const LOAD_VERSION = new URL(import.meta.url).searchParams.get('v') || ''
const withVersion = (spec) => (LOAD_VERSION ? `${spec}?v=${LOAD_VERSION}` : spec)
const configMod = await import(withVersion('./config.mjs'))
const lineApi = await import(withVersion('./line-api.mjs'))
const cloudflare = await import(withVersion('./cloudflare.mjs'))
const personaMod = await import(withVersion('./persona.mjs'))
const runnerMod = await import(withVersion('./agent-runner.mjs'))
const webhookMod = await import(withVersion('./webhook-server.mjs'))
const tunnelMod = await import(withVersion('./tunnel.mjs'))
const nudgeMod = await import(withVersion('./nudge.mjs'))
const tiebaSyncMod = await import(withVersion('./tieba-sync.mjs'))
const localPersonasMod = await import(withVersion('./local-personas.mjs'))
const builtinPersonasMod = await import(withVersion('./builtin-personas.mjs'))
const chatImport = await import(withVersion('./chat-import.mjs'))
const diagnosticsMod = await import(withVersion('./diagnostics.mjs'))
const tiebaContextMod = await import(withVersion('./tieba-context.mjs'))
const balanceMod = await import(withVersion('./deepseek-balance.mjs'))
const memoryMod = await import(withVersion('./memory.mjs'))
const jokesMod = await import(withVersion('./jokes.mjs'))
const stickersMod = await import(withVersion('./stickers.mjs'))
const memeSourceMod = await import(withVersion('./meme-source.mjs'))
const stickerImageMod = await import(withVersion('./sticker-image.mjs'))
const visionMod = await import(withVersion('./vision.mjs'))
const ttsMod = await import(withVersion('./tts.mjs'))
const utilMod = await import(withVersion('./util.mjs'))
const { createConfigStore, publicConfig, dataDir, dshHome } = configMod
const { createPersonaClient } = personaMod
const { createAgentRunner } = runnerMod
const { createWebhookServer } = webhookMod
const { createTunnelManager } = tunnelMod
const { createNudgeScheduler } = nudgeMod
const { createTiebaSync, reloadPersonaPlugin, readPersonaOverlay, ensureTiebaBars, readTiebaStyleSamples } = tiebaSyncMod
const { createLocalPersonas, LOCAL_PREFIX } = localPersonasMod
const { BUILTIN_IDS } = builtinPersonasMod
const { buildTiebaContext } = tiebaContextMod
const { createBalanceMonitor } = balanceMod
const { createMemoryStore } = memoryMod
const { createJokeStore } = jokesMod
const { createStickerStore } = stickersMod
const { createMemeSource } = memeSourceMod
const { createStickerImages } = stickerImageMod
const { createVision } = visionMod
const { createTts } = ttsMod
const { chunkText, clip, inQuietWindow, jsonFail, jsonOk, maskSecret, readJsonBody, safeArray, sleep, readJsonSafe } = utilMod

export const VERSION = '0.10.0'

// 環境變數提供的 Cloudflare API Token（方便用 shell 注入、不用把 token 寫進設定檔）。
// 設定檔裡的 token 優先；兩者都沒有時才用環境變數。
const ENV_CF_TOKEN = String(
  process.env.cf_tunnel_token || process.env.CF_TUNNEL_TOKEN || process.env.CLOUDFLARE_API_TOKEN || '',
).trim()

function withEnvCloudflare(cfgValue) {
  if (!ENV_CF_TOKEN || cfgValue?.cloudflare?.apiToken) return cfgValue
  return { ...cfgValue, cloudflare: { ...cfgValue.cloudflare, apiToken: ENV_CF_TOKEN } }
}

function errorText(error) {
  if (!error) return ''
  return error instanceof Error ? error.message : String(error)
}

function makeLogger(dir, upstream) {
  const lines = []
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true })
  function push(level, message) {
    const text = typeof message === 'string' ? message : (() => {
      try {
        return JSON.stringify(message)
      } catch {
        return String(message)
      }
    })()
    const line = `${new Date().toISOString().slice(11, 19)} [${level}] ${text}`
    lines.push(line)
    if (lines.length > 400) lines.splice(0, lines.length - 400)
    try {
      fs.appendFileSync(path.join(dir, 'logs', `${new Date().toISOString().slice(0, 10)}.log`), `${line}\n`)
    } catch {
      /* 寫不進去不影響功能 */
    }
    try {
      if (level === 'error') upstream?.error?.(`[line-bot] ${text}`)
      else if (level === 'warn') upstream?.warn?.(`[line-bot] ${text}`)
      else upstream?.info?.(`[line-bot] ${text}`)
    } catch {
      /* ignore */
    }
  }
  return {
    info: (message) => push('info', message),
    warn: (message) => push('warn', message),
    error: (message) => push('error', message),
    lines: () => lines.slice(-120),
    clear: () => {
      lines.length = 0
    },
  }
}

export async function create({ ctx, config: pluginConfig, logger: upstream }) {
  const dir = dataDir()
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true })
  const logger = makeLogger(dir, upstream)
  const store = createConfigStore({ logger })
  const localPersonas = createLocalPersonas({ dir, logger })
  const jokes = createJokeStore({ dir, logger })
  const startedAt = Date.now()

  const runtime = {
    botInfo: null,
    botInfoAt: 0,
    lastLineError: '',
    lastEventAt: 0,
    lastReply: null,
    lastTokenIssueAt: 0,
    tokenSource: '',
    publicUrl: '',
  }

  const service = (name) => {
    try {
      return ctx.get?.(name)
    } catch {
      return undefined
    }
  }
  const getOrigin = () => {
    try {
      return service('webServer')?.getOrigin?.() || ''
    } catch {
      return ''
    }
  }
  const persona = () => createPersonaClient({ getOrigin, logger })

  // 人設的「選擇值」有兩種：大肥魚的人設 id（例如 moxi），或插件自己的
  // `local:<id>`。這裡把選擇值解析成實際要套用的內容。
  function resolvePersonaSelection(selection) {
    const id = String(selection || '').trim()
    if (!id) return { kind: 'none', id: '' }
    if (id.startsWith(LOCAL_PREFIX)) {
      const local = localPersonas.get(id)
      return local
        ? { kind: 'local', id, name: local.name, text: local.text }
        : { kind: 'missing', id }
    }
    return { kind: 'dafeiyu', id }
  }

  // 內建繁中人設（dafeiyu/acha/tinglan）在 local store 裡的別名，格式 local:builtin-<id>。
  function localBuiltinAlias(id) {
    const key = String(id || '')
    if (!BUILTIN_IDS.includes(key)) return ''
    const hit = localPersonas.catalog().find((item) => item.builtin && item.builtinId === key)
    return hit ? hit.id : ''
  }

  function builtinIdOfLocalSelection(id) {
    const match = /^local:builtin-(.+)$/.exec(String(id || ''))
    return match && BUILTIN_IDS.includes(match[1]) ? match[1] : ''
  }

  // 沒有大肥魚外掛時，把內建設定值（dafeiyu/acha/tinglan）換成插件內建的繁中版本；
  // 外掛回來時再換回去，避免選到被隱藏的人設。
  function reconcileBuiltinSelection(bridgeUp) {
    const cfg = store.get()
    const patch = {}
    const personaId = String(cfg.persona?.id || '')
    const localBuiltin = builtinIdOfLocalSelection(personaId)
    if (bridgeUp && localBuiltin) patch.persona = { id: localBuiltin }
    if (!bridgeUp && BUILTIN_IDS.includes(personaId)) {
      const alias = localBuiltinAlias(personaId)
      if (alias) patch.persona = { id: alias }
    }
    const syncId = String(cfg.sync?.targetPersonaId || '')
    const syncBuiltin = builtinIdOfLocalSelection(syncId)
    if (bridgeUp && syncBuiltin) patch.sync = { ...(patch.sync || {}), targetPersonaId: syncBuiltin }
    if (!bridgeUp && BUILTIN_IDS.includes(syncId)) {
      const alias = localBuiltinAlias(syncId)
      if (alias) patch.sync = { ...(patch.sync || {}), targetPersonaId: alias }
    }
    if (!Object.keys(patch).length) return
    try {
      store.patch(patch, { silent: true })
    } catch (error) {
      logger.warn(`切換內建人設設定失敗：${errorText(error)}`)
    }
  }

  // 回傳 runner 需要的 persona（大肥魚 id）與 personaText（自訂人設全文）。
  // 選自訂人設時，先請大肥魚在這個 session 讓開，避免兩套人設疊在一起。
  async function applyPersonaSelection(selection, sessionId) {
    let chosen = String(selection || '').trim()
    if (chosen && !chosen.startsWith(LOCAL_PREFIX)) {
      try {
        const summary = await getPersonaSummary()
        if (!summary.bridgeAvailable) {
          const alias = BUILTIN_IDS.includes(chosen) ? localBuiltinAlias(chosen) : ''
          if (alias) {
            chosen = alias
          } else if (!summary.catalog.some((item) => item.id === chosen)) {
            // 大肥魚外掛不在時，選到它的人設也只能先用插件內建的繁中版本頂著，
            // 不要讓 LINE 掉成「完全沒有人設」。
            chosen = localBuiltinAlias('dafeiyu')
              || localPersonas.catalog().find((item) => item.builtin)?.id
              || chosen
          }
        }
      } catch (error) {
        logger.warn(`解析人設失敗：${errorText(error)}`)
      }
    }
    const resolved = resolvePersonaSelection(chosen)
    if (resolved.kind === 'local') {
      try {
        await persona().disableSessionPersona(sessionId)
      } catch (error) {
        logger.warn(`請大肥魚讓開失敗（自訂人設仍會注入）：${errorText(error)}`)
      }
      return { persona: null, personaText: resolved.text, source: 'local', name: resolved.name, selection: resolved.id }
    }
    if (resolved.kind === 'dafeiyu') {
      return { persona: resolved.id, personaText: null, source: 'dafeiyu', name: '', selection: resolved.id }
    }
    return { persona: null, personaText: null, source: '', name: '', selection: '' }
  }

  // 內建人設（大肥魚等）不能改原文，貼吧同步會寫在覆蓋層；每輪注入在 persona 之後。
  function personaOverlayText(applied) {
    const id = applied?.selection || applied?.persona
    if (!id) return ''
    try {
      return readPersonaOverlay(id)
    } catch {
      return ''
    }
  }

  // 每輪把貼吧活動摘要塞進 system prompt；面板可關閉（agent.tiebaContext）。
  function tiebaContextText() {
    try {
      if (store.get().agent.tiebaContext === false) return ''
      return buildTiebaContext()
    } catch (error) {
      logger.warn(`組貼吧動態失敗：${errorText(error)}`)
      return ''
    }
  }

  // ── DeepSeek 餘額 ───────────────────────────────────────────────────────
  const balance = createBalanceMonitor({ ctx, logger })
  let balanceTimer = null
  let balanceNextAt = 0
  const memory = createMemoryStore({ dir, logger, getConfig: () => store.get() })
  let memoryTimer = null

  function balanceView() {
    const cached = balance.get()
    if (cached.status !== 'ready') return null
    if (cached.cny) return { code: 'CNY', symbol: '¥', value: cached.cny }
    if (cached.usd) return { code: 'USD', symbol: '$', value: cached.usd }
    return null
  }

  function modelSelection() {
    const cfg = store.get()
    let fallback = null
    try {
      fallback = ctx.get?.('agentDefaultModel')?.currentSelection?.() || null
    } catch {
      fallback = null
    }
    const custom = Boolean(String(cfg.agent.provider || '').trim() || String(cfg.agent.model || '').trim())
    const provider = String(cfg.agent.provider || fallback?.provider || '').trim()
    const model = String(cfg.agent.model || fallback?.model || '').trim()
    return {
      provider,
      model,
      source: custom ? 'custom' : 'default',
      defaultProvider: fallback?.provider || '',
      defaultModel: fallback?.model || '',
    }
  }

  // 只有 DeepSeek 官方帳號（deepseek-account）才查得到餘額；其他來源停用餘額相關功能。
  function balanceApplicable() {
    return modelSelection().provider === 'deepseek-account'
  }

  let modelCache = null
  async function modelCatalog({ force = false } = {}) {
    const now = Date.now()
    if (!force && modelCache && now - modelCache.at < 60_000) return modelCache.value
    const llm = ctx.get?.('llm')
    if (!llm || typeof llm.listProviders !== 'function') {
      return { providers: [], current: modelSelection(), error: '這個 profile 沒有 llm 服務，無法列出模型' }
    }
    const providers = []
    try {
      const infos = await llm.listProviders()
      for (const info of infos || []) {
        const entry = { id: info.id, name: info.name || info.id, models: [] }
        try {
          const models = await llm.listModels(info.id)
          const mapped = []
          for (const item of models || []) {
            const model = { id: item.id, name: item.name || item.id }
            if (typeof llm.resolveModelInfo === 'function') {
              try {
                const info2 = await llm.resolveModelInfo(info.id, item.id)
                if (Array.isArray(info2?.inputModalities)) model.inputModalities = info2.inputModalities
              } catch { /* 有些 provider 不支援查詢，略過 */ }
            }
            mapped.push(model)
          }
          entry.models = mapped
        } catch (error) {
          entry.error = errorText(error)
        }
        providers.push(entry)
      }
    } catch (error) {
      return { providers: [], current: modelSelection(), error: errorText(error) }
    }
    const value = { providers, current: modelSelection(), at: now }
    modelCache = { at: now, value }
    return value
  }

  function balanceContextText() {
    const cfg = store.get()
    if (cfg.balance.enabled === false) return ''
    if (!balanceApplicable()) return ''
    const view = balanceView()
    if (!view) return ''
    const cached = balance.get()
    const total = view.value.total
    const threshold = Number(cfg.balance.threshold) || 0
    const when = new Date(cached.at || Date.now()).toLocaleTimeString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei' })
    const lines = [
      '【DeepSeek API 餘額】約 ' + view.symbol + total.toFixed(2) + '（一般 ' + view.symbol + view.value.normal.toFixed(2) + '、贈金 ' + view.symbol + view.value.bonus.toFixed(2) + '），' + when + ' 查詢。',
    ]
    if (threshold > 0 && total < threshold) lines.push('目前低於提醒門檻 ' + view.symbol + threshold + '；主人若問起，可以提醒他儲值。')
    return lines.join('\n')
  }

  function modelContextText() {
    const sel = modelSelection()
    if (!sel.provider || !sel.model) return ''
    const value = modelCache?.value
    const providerInfo = (value?.providers || []).find((item) => item.id === sel.provider)
    const modelInfo = (providerInfo?.models || []).find((item) => item.id === sel.model)
    const providerName = providerInfo?.name || sel.provider
    const modelName = modelInfo?.name || sel.model
    const effort = String(store.get().agent?.reasoningEffort || '').trim()
    return [
      '【目前使用的模型】' + sel.provider + (providerName !== sel.provider ? '（' + providerName + '）' : '') + '／' + sel.model + (modelName !== sel.model ? '（' + modelName + '）' : '') + (effort ? '，推理強度 ' + effort : '') + '。',
      '如果主人問你「你是哪個模型」、「用什麼模型回答」，就照這一行回答模型與來源；只講這兩個，不要加推測或額外解釋，也不要說成別的模型，不用提這是插件提供的背景資訊。',
    ].join('\n')
  }

  function memoryRulesText() {
    if (store.get().memory?.enabled === false) return ''
    return [
      '【個人記憶】你有一份自己的記憶（每位使用者分開）。',
      '對話中若出現你覺得重要、之後還會用到的資訊（喜好、近況、承諾、重要事件），馬上用 line_memory_add 記下來，不用等對方交代。',
      '一次只記一件事；如果同時有兩三件重要的事，就分開呼叫兩三次，不要合併成一段。',
      '有期限的事（考試、旅行、短期的狀況）請填 ttlDays，到期會自動刪掉；一次性閒聊不要記。',
      '使用者要你忘掉某件事時，用 line_memory_forget 刪掉；想確認自己記了什麼就用 line_memory_list。',
      '很重要：只有真的呼叫了工具才算記住。沒呼叫就不要說「記好了」；使用者明確要你記住時，先呼叫工具再回覆。',
      '不要記密碼、token、證件號等敏感資料，也不要在回覆裡提到這些工具或「記憶系統」。',
    ].join('\n')
  }

  function memoryContextText(userId) {
    if (!userId) return ''
    const rules = memoryRulesText()
    const remembered = memory.formatForContext(userId)
    return [rules, remembered].filter(Boolean).join('\n\n')
  }

  function memoryToolsFor(userId) {
    if (!userId || store.get().memory?.enabled === false) return []
    try {
      return memory.toolsFor(userId)
    } catch (error) {
      logger.warn('準備記憶工具失敗：' + errorText(error))
      return []
    }
  }

  function agentContextText(ownerKey, kind = 'user', extra = '') {
    const jokeText = jokes.contextText(() => store.get())
    // 群組不注入貼吧作息，避免在群組裡突然講起刷貼吧的事。
    const tieba = kind === 'user' ? tiebaContextText() : ''
    return [modelContextText(), voiceContextText(), jokeText, tieba, balanceContextText(), extra, memoryContextText(ownerKey), memeContextText() || stickerContextText()].filter(Boolean).join('\n\n')
  }

  const VOICE_MARKER = /\[\[\s*(?:voice|語音|语音|audio)\s*(?:[:：]\s*([^\]\n]{0,200}))?\s*\]\]/gi
  let voiceCache = { at: 0, value: null }

  function voiceStatusCached() {
    if (!voiceCache.value || Date.now() - voiceCache.at > 10000) {
      try {
        voiceCache = { at: Date.now(), value: tts.status() }
      } catch (error) {
        voiceCache = { at: Date.now(), value: { ready: false, lastError: errorText(error) } }
      }
    }
    return voiceCache.value
  }

  function voiceReady(cfg = store.get()) {
    if (cfg.voice?.enabled !== true || cfg.voice?.consent !== true) return false
    const st = voiceStatusCached()
    return st?.ready === true && Boolean(st?.reference?.path)
  }

  function voiceContextText() {
    const cfg = store.get()
    if (cfg.voice?.enabled !== true || cfg.voice?.consent !== true) return ''
    if (!voiceReady(cfg)) return ''
    const max = Math.max(20, Math.min(300, Number(cfg.voice?.maxChars) || 80))
    return [
      '【語音】你可以用語音回覆。',
      `想用時把 [[voice]] 放在回覆最後；如果要指定語氣，寫成 [[voice:用溫柔、帶點撒嬌的語氣，語速慢一點]]。`,
      `語氣、情緒、語速、停頓這些「怎麼說」的指示只能放在標記裡；正文只放要念出來的字，不要把語氣描述、括號動作或舞台指示寫進正文（最多約 ${max} 字）。`,
      '一次最多一則語音；不適合用語音（例如內容太長、需要圖片）就不要加標記。',
    ].join('\n')
  }

  function splitVoiceMarker(text) {
    let requested = false
    let instruct = ''
    const cleaned = String(text || '')
      .replace(VOICE_MARKER, (_match, tone) => {
        requested = true
        if (tone && String(tone).trim()) instruct = String(tone).trim().slice(0, 200)
        return ''
      })
      .trim()
    return { text: cleaned, requested, instruct }
  }

  async function synthesizeVoiceMessage(text, instruct = '') {
    const base = publicBaseSync()
    if (!base) throw new Error('目前沒有公開網址，語音訊息送不出去')
    const result = await tts.synthesize(text, { instructText: instruct })
    const token = registerFile(result.m4a, 'audio/mp4')
    if (!token) throw new Error('無法把語音檔存進媒體庫')
    return {
      message: { type: 'audio', originalContentUrl: `${base}/media/${token}`, duration: Math.max(1000, Math.round(result.durationMs || 0)) },
      token,
      provider: result.provider,
      durationMs: result.durationMs,
    }
  }

  async function replyMessages(userId, replyToken, messages) {
    if (!Array.isArray(messages) || messages.length === 0) return
    try {
      await withToken((token) => lineApi.replyMessage(token, replyToken, messages))
    } catch (error) {
      logger.warn(`reply 失敗，改用 push：${errorText(error)}`)
      await withToken((token) => lineApi.pushMessage(token, userId, messages))
    }
  }

  async function refreshBalance() {
    return balance.fetchNow()
  }

  async function maybeAskForTopUp({ dryRun = true, force = false } = {}) {
    const cfg = store.get()
    if (cfg.balance.enabled === false || cfg.balance.ask === false) return { skipped: 'disabled' }
    if (!balanceApplicable()) return { skipped: 'provider-not-deepseek', provider: modelSelection().provider }
    const view = balanceView()
    if (!view) {
      const cached = balance.get()
      return { skipped: 'balance-unavailable', status: cached.status, error: cached.error || '' }
    }
    const total = view.value.total
    const threshold = Number(cfg.balance.threshold) || 0
    const low = threshold > 0 && total < threshold
    if (!force && !low) return { skipped: 'enough', total, threshold }
    const state = store.getState()
    const lastAskAt = Number(state.balance?.lastAskAt) || 0
    const cooldownMs = Math.max(1, Number(cfg.balance.cooldownHours) || 12) * 3600_000
    if (!force && lastAskAt && Date.now() - lastAskAt < cooldownMs) return { skipped: 'cooldown', lastAskAt }
    if (!force && inQuietWindow(Date.now(), cfg.nudge.quietStart, cfg.nudge.quietEnd)) return { skipped: 'quiet-hours' }
    const candidates = Object.entries(state.users || {}).filter(([userId, user]) => user?.sessionId && isAllowed(userId, cfg))
    const targetIds = safeArray(cfg.balance?.targetUserIds).length ? safeArray(cfg.balance?.targetUserIds) : safeArray(cfg.nudge?.targetUserIds)
    const preferred = targetIds.find((id) => candidates.some(([key]) => key === id))
    const picked = preferred ? candidates.find(([key]) => key === preferred) : [...candidates].sort((a, b) => (a[1].lastAt || 0) - (b[1].lastAt || 0))[0]
    if (!picked) return { skipped: 'no-user' }
    const [userId, user] = picked
    const selection = cfg.persona.enforce ? user.personaId || cfg.persona.id : ''
    const applied = await applyPersonaSelection(selection, user.sessionId)
    const promptText = [
      '（這是系統提供的背景資訊，不是主人說的話）你剛剛查到主人的 DeepSeek API 餘額只剩 ' + view.symbol + total.toFixed(2) + '，低於提醒門檻 ' + view.symbol + threshold + '。',
      '請用你自己的語氣、簡短地跟主人說一聲，提醒他該儲值了；金額可以講，也可以講得籠統一點。',
      '不要提到系統、插件、面板、監控或「額度不足」這類技術字眼，不要編造其他內容。',
      '只輸出要傳給主人的那一則訊息，不要加引號、標籤或說明。',
    ].join('\n')
    const result = await runner.turn({
      sessionId: user.sessionId,
      text: promptText,
      persona: applied.persona,
      personaText: applied.personaText,
      overlayText: personaOverlayText(applied),
      personaClient: persona(),
      contextText: '',
      cwd: ensureUserWorkspace(userId) || undefined,
    })
    const text = String(result.text || '').trim()
    if (!text || /^SKIP\b/i.test(text)) return { skipped: 'agent-skip', total, threshold }
    if (dryRun) return { sent: false, dryRun: true, userId, text, total, threshold }
    await sendPush(userId, text)
    store.updateState((s) => ({ ...s, balance: { ...(s.balance || {}), lastAskAt: Date.now(), lastAskText: text, lastBalance: total } }))
    logger.info('餘額偏低（' + view.symbol + total.toFixed(2) + ' < ' + view.symbol + threshold + '），已提醒 ' + userId)
    return { sent: true, userId, text, total, threshold }
  }

  function startBalanceWatch() {
    stopBalanceWatch()
    const runCheck = () => {
      balanceNextAt = Date.now() + 30 * 60_000
      if (!balanceApplicable()) return
      refreshBalance()
        .then((cache) => {
          if (!cache || cache.status !== 'ready') return null
          return maybeAskForTopUp({ dryRun: false })
        })
        .then((result) => {
          if (!result || !result.skipped) return
          if (['enough', 'disabled', 'provider-not-deepseek'].includes(result.skipped)) return
          logger.info('餘額檢查：這次不提醒（' + result.skipped + '）')
        })
        .catch((error) => logger.warn('餘額檢查失敗：' + errorText(error)))
    }
    const initial = setTimeout(runCheck, 8_000)
    balanceNextAt = Date.now() + 8_000
    initial.unref?.()
    balanceTimer = setInterval(runCheck, 30 * 60_000)
    balanceTimer.unref?.()
  }

  function stopBalanceWatch() {
    if (balanceTimer) {
      clearInterval(balanceTimer)
      balanceTimer = null
    }
    balanceNextAt = 0
  }

  // ── 個人記憶：清理與每日整理 ────────────────────────────────────────────
  function pruneMemories() {
    try {
      const out = memory.prune()
      if (out.removed > 0) logger.info('個人記憶：清理 ' + out.removed + ' 筆到期項目')
      return out
    } catch (error) {
      logger.warn('清理個人記憶失敗：' + errorText(error))
      return { removed: 0, error: errorText(error) }
    }
  }

  async function reviewMemories({ userId = '' } = {}) {
    const cfg = store.get()
    if (cfg.memory?.enabled === false) return { skipped: 'disabled' }
    const state = store.getState()
    const targets = userId
      ? [[userId, state.users?.[userId]]]
      : Object.entries(state.users || {}).filter(([id]) => isAllowed(id, cfg))
    const reviewed = []
    for (const [id, user] of targets) {
      if (!user?.sessionId) continue
      const entries = memory.list(id)
      if (entries.length === 0) continue
      const selection = cfg.persona.enforce ? user.personaId || cfg.persona.id : ''
      const applied = await applyPersonaSelection(selection, user.sessionId)
      const lines = entries.map((entry) => {
        const created = new Date(entry.createdAt).toISOString().slice(0, 10)
        const until = entry.expiresAt ? '，' + new Date(entry.expiresAt).toISOString().slice(0, 10) + ' 失效' : ''
        return '- ' + entry.id + ' [' + entry.kind + '] ' + entry.text + '（' + created + until + '）'
      })
      const promptText = [
        '（這是系統提供的背景整理，不是主人說的話）請你檢查自己對這位使用者的記憶。',
        '目前的記憶：',
        ...lines,
        '把已經過期、一次事件已結束、或明顯不再成立的，用 line_memory_forget 刪掉；其餘保留。',
        '不要輸出給主人看的訊息，只呼叫工具，最後回一個 OK。',
      ].join('\n')
      try {
        await runner.turn({
          sessionId: user.sessionId,
          text: promptText,
          persona: applied.persona,
          personaText: applied.personaText,
          overlayText: personaOverlayText(applied),
          personaClient: persona(),
          contextText: '',
          tools: memoryToolsFor(id),
          cwd: ensureUserWorkspace(id) || undefined,
        })
        reviewed.push({ userId: id, entries: entries.length })
      } catch (error) {
        logger.warn('整理 ' + id + ' 的記憶失敗：' + errorText(error))
      }
    }
    store.updateState((current) => ({ ...current, memory: { ...(current.memory || {}), lastReviewAt: Date.now() } }))
    logger.info('個人記憶：整理完成，檢查 ' + reviewed.length + ' 位使用者')
    return { reviewed: reviewed.length, users: reviewed }
  }

  function maybeDailyMemoryReview() {
    const cfg = store.get()
    if (cfg.memory?.enabled === false || cfg.memory?.reviewDaily === false) return
    const hour = Number(cfg.memory?.reviewHour)
    const wantedHour = Number.isFinite(hour) ? Math.max(0, Math.min(23, Math.round(hour))) : 4
    const now = new Date()
    if (now.getHours() !== wantedHour) return
    const lastReviewAt = Number(store.getState().memory?.lastReviewAt) || 0
    if (lastReviewAt && now.getTime() - lastReviewAt < 20 * 3600_000) return
    reviewMemories().catch((error) => logger.warn('每日記憶整理失敗：' + errorText(error)))
  }

  function startMemoryWatch() {
    stopMemoryWatch()
    pruneMemories()
    memoryTimer = setInterval(() => {
      pruneMemories()
      maybeDailyMemoryReview()
    }, 10 * 60_000)
    memoryTimer.unref?.()
  }

  function stopMemoryWatch() {
    if (memoryTimer) {
      clearInterval(memoryTimer)
      memoryTimer = null
    }
  }

  // ── LINE 憑證 ────────────────────────────────────────────────────────────
  async function getToken({ force = false } = {}) {
    const cfg = store.get()
    const now = Date.now()
    const manual = String(cfg.line.accessToken || '').trim()
    const canAuto = Boolean(cfg.line.channelId && cfg.line.channelSecret)
    if (!force && manual) {
      const expiresAt = Number(cfg.line.tokenExpiresAt) || 0
      if (!expiresAt || expiresAt - now > 60000) return manual
    }
    if (canAuto && (cfg.line.useAutoToken || !manual || force)) {
      try {
        const issued = await lineApi.issueAccessToken(cfg.line.channelId, cfg.line.channelSecret)
        if (!issued.accessToken) throw new Error('LINE 沒有回傳 access token')
        const expiresAt = now + Math.max(60, issued.expiresIn || 2592000) * 1000
        store.patch({ line: { accessToken: issued.accessToken, tokenExpiresAt: expiresAt } }, { silent: true })
        runtime.tokenSource = 'auto'
        runtime.lastTokenIssueAt = now
        runtime.lastLineError = ''
        logger.info(`已自動簽發 channel access token（到期：${new Date(expiresAt).toLocaleString()}）`)
        return issued.accessToken
      } catch (error) {
        runtime.lastLineError = errorText(error)
        if (manual) {
          logger.warn(`自動簽發 access token 失敗，改用已設定的 token：${errorText(error)}`)
          return manual
        }
        throw error
      }
    }
    if (manual) return manual
    throw new Error('尚未設定 LINE 憑證：請填入 Channel ID + Channel Secret（會自動簽發 token），或直接貼上 Channel Access Token')
  }

  async function withToken(fn) {
    let token = await getToken()
    try {
      return await fn(token)
    } catch (error) {
      if (error instanceof lineApi.LineApiError && error.status === 401) {
        token = await getToken({ force: true })
        return fn(token)
      }
      throw error
    }
  }

  async function refreshBotInfo() {
    try {
      const info = await withToken((token) => lineApi.getBotInfo(token))
      runtime.botInfo = info
      runtime.botInfoAt = Date.now()
      runtime.lastLineError = ''
      return info
    } catch (error) {
      runtime.lastLineError = errorText(error)
      throw error
    }
  }

  async function refreshWebhookInfo() {
    try {
      const info = await withToken((token) => lineApi.getWebhookEndpoint(token))
      store.updateState((state) => ({
        ...state,
        webhook: {
          ...(state.webhook || {}),
          endpoint: info?.endpoint || state.webhook?.endpoint || '',
          active: Boolean(info?.active),
          checkedAt: Date.now(),
        },
      }))
      return info
    } catch (error) {
      runtime.lastLineError = errorText(error)
      throw error
    }
  }

  // ── 對外公開網址 → LINE webhook ──────────────────────────────────────────
  async function applyWebhook(url, { test = true } = {}) {
    const baseUrl = String(url || '').trim().replace(/\/$/, '')
    if (!baseUrl) throw new Error('還沒有公開網址：請先啟動 tunnel，或填入自訂公開位址')
    if (!baseUrl.startsWith('https://')) throw new Error('LINE 只接受 https 的 webhook 端點')
    // 面板與自動流程都可能傳「完整端點」或「站台網址」，兩種都要吃。
    const endpoint = baseUrl.endsWith('/webhook') ? baseUrl : `${baseUrl}/webhook`
    const token = await getToken()
    await lineApi.setWebhookEndpoint(token, endpoint)
    let tested = null
    let testError = ''
    if (test) {
      try {
        tested = await lineApi.testWebhookEndpoint(token, endpoint)
      } catch (error) {
        testError = errorText(error)
      }
    }
    store.updateState((state) => ({
      ...state,
      webhook: {
        endpoint,
        active: true,
        at: Date.now(),
        testOk: tested ? Boolean(tested.success) : null,
        testReason: tested?.reason || testError || '',
      },
    }))
    logger.info(`已設定 LINE webhook：${endpoint}${tested ? `（測試：${tested.success ? '通過' : tested.reason || '失敗'}）` : ''}`)
    return { endpoint, tested, testError }
  }

  // ── webhook 自動修復 ─────────────────────────────────────────────────────
  // quick tunnel 每次重啟都會換網址；剛換時新子網域常還沒傳播，PUT webhook 會失敗。
  // 兩層保底：換網址後短時間內重試；平常每 90 秒比對目前隧道網址與 LINE 端點。
  const webhookWatch = { retryTimer: null, guardTimer: null, attempts: 0, lastAttemptAt: 0 }

  function clearWebhookRetry() {
    if (webhookWatch.retryTimer) {
      clearTimeout(webhookWatch.retryTimer)
      webhookWatch.retryTimer = null
    }
  }

  function scheduleWebhookRetry(url) {
    if (webhookWatch.retryTimer) return
    const delays = [8_000, 15_000, 30_000, 60_000, 120_000, 300_000]
    const delay = delays[Math.min(webhookWatch.attempts, delays.length - 1)]
    webhookWatch.attempts += 1
    logger.info(`LINE webhook 自動重試：${Math.round(delay / 1000)} 秒後再試（第 ${webhookWatch.attempts} 次）`)
    webhookWatch.retryTimer = setTimeout(async () => {
      webhookWatch.retryTimer = null
      if (!store.get().tunnel.autoConfigureWebhook) return
      const live = String((await tunnel.status().catch(() => null))?.url || '').trim()
      if (!live) return
      try {
        await applyWebhook(live)
        webhookWatch.attempts = 0
      } catch (error) {
        logger.warn(`自動重試 LINE webhook 失敗：${errorText(error)}`)
        scheduleWebhookRetry(live)
      }
    }, delay)
    webhookWatch.retryTimer.unref?.()
  }

  async function reconcileWebhook({ force = false } = {}) {
    const cfg = store.get()
    if (!cfg.tunnel.autoConfigureWebhook) return { skipped: 'autoConfigureWebhook 已關閉' }
    if (!cfg.line.channelId || (!cfg.line.channelSecret && !cfg.line.accessToken)) return { skipped: '尚未設定 LINE 憑證' }
    const tunnelStatus = await tunnel.status().catch(() => null)
    const raw = String(tunnelStatus?.url || '').trim()
    if (!raw) return { skipped: '隧道還沒好' }
    const endpoint = raw.endsWith('/webhook') ? raw : `${raw}/webhook`
    const saved = store.getState().webhook || {}
    if (!force && saved.endpoint === endpoint && saved.active) return { skipped: '已是最新', endpoint }
    if (!force && Date.now() - webhookWatch.lastAttemptAt < 60_000) return { skipped: '剛試過，稍後再試' }
    webhookWatch.lastAttemptAt = Date.now()
    try {
      const applied = await applyWebhook(raw)
      webhookWatch.attempts = 0
      clearWebhookRetry()
      return { applied, endpoint: applied.endpoint }
    } catch (error) {
      logger.warn(`自動修復 LINE webhook 失敗：${errorText(error)}`)
      scheduleWebhookRetry(raw)
      return { error: errorText(error) }
    }
  }

  function startWebhookGuard() {
    if (webhookWatch.guardTimer) return
    webhookWatch.guardTimer = setInterval(() => {
      reconcileWebhook().catch(() => {})
    }, 90_000)
    webhookWatch.guardTimer.unref?.()
    setTimeout(() => reconcileWebhook().catch(() => {}), 4_000).unref?.()
  }

  function stopWebhookGuard() {
    if (webhookWatch.guardTimer) {
      clearInterval(webhookWatch.guardTimer)
      webhookWatch.guardTimer = null
    }
    clearWebhookRetry()
  }

  // ── 使用者 session ───────────────────────────────────────────────────────
  // 每位使用者一個獨立工作資料夾：各自的檔案、AGENTS.md、工作區記憶互不相通。
  function userWorkspaceDir(userId, cfg = store.get()) {
    const safe = String(userId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_')
    const root = String(cfg.agent.workspaceRoot || '').trim() || path.join(dir, 'users')
    return path.join(root, safe)
  }

  function ensureUserWorkspace(userId) {
    const cfg = store.get()
    if (!cfg.agent.perUserWorkspace) return ''
    const target = userWorkspaceDir(userId, cfg)
    try {
      fs.mkdirSync(target, { recursive: true })
      return target
    } catch (error) {
      logger.warn(`建立使用者工作資料夾失敗（${target}）：${errorText(error)}`)
      return ''
    }
  }

  function ensureUser(userId) {
    const cfg = store.get()
    const state = store.getState()
    const existing = state.users?.[userId]
    const workspaceDir = ensureUserWorkspace(userId)
    const personaId = existing?.personaId || cfg.persona.id
    if (existing?.sessionId) {
      if (existing.workspaceDir !== workspaceDir || existing.personaId !== personaId) {
        const patched = { ...existing, workspaceDir, personaId }
        store.updateState((s) => ({ ...s, users: { ...(s.users || {}), [userId]: patched } }))
        return patched
      }
      return existing
    }
    const user = {
      userId,
      sessionId: `session-${randomUUID()}`,
      createdAt: Date.now(),
      messages: 0,
      nudges: 0,
      lastAt: Date.now(),
      lastUserAt: 0,
      displayName: existing?.displayName || '',
      personaId,
      workspaceDir,
    }
    store.updateState((s) => ({ ...s, users: { ...(s.users || {}), [userId]: user } }))
    logger.info(`建立 LINE 使用者 ${userId} 的 session ${user.sessionId}（工作資料夾：${workspaceDir || '共用'}）`)
    return user
  }

  // 群組／多人聊天室：各自一個 session、工作資料夾、人設與記憶。
  function ensureGroup(chatId, kind = 'group') {
    const cfg = store.get()
    const state = store.getState()
    const existing = state.groups?.[chatId]
    const workspaceDir = ensureUserWorkspace(chatId)
    const personaId = existing?.personaId || cfg.persona.id
    if (existing?.sessionId) {
      if (existing.workspaceDir !== workspaceDir || existing.personaId !== personaId) {
        const patched = { ...existing, workspaceDir, personaId, kind }
        store.updateState((s) => ({ ...s, groups: { ...(s.groups || {}), [chatId]: patched } }))
        return patched
      }
      return existing
    }
    const group = {
      groupId: chatId,
      kind,
      sessionId: `session-${randomUUID()}`,
      createdAt: Date.now(),
      messages: 0,
      lastAt: Date.now(),
      lastUserAt: 0,
      displayName: existing?.displayName || '',
      personaId,
      workspaceDir,
    }
    store.updateState((s) => ({ ...s, groups: { ...(s.groups || {}), [chatId]: group } }))
    logger.info(`建立 LINE ${kind === 'room' ? '聊天室' : '群組'} ${chatId} 的 session ${group.sessionId}（工作資料夾：${workspaceDir || '共用'}）`)
    return group
  }

  function mentionedBot(message) {
    const botId = runtime.botInfo?.userId || ''
    const mentionees = message?.mention?.mentionees
    if (Array.isArray(mentionees)) {
      for (const item of mentionees) {
        if (item?.isSelf === true) return true
        if (botId && item?.userId === botId) return true
      }
    }
    return false
  }

  function groupGate(message, cfg) {
    const rules = cfg.group || {}
    if (rules.enabled === false) return { reply: false, reason: 'group-disabled' }
    if (rules.replyToMentions !== false && mentionedBot(message)) return { reply: true, reason: 'mention' }
    if (rules.replyToQuotes !== false && message?.quotedMessageId) return { reply: true, reason: 'quote' }
    const chance = Number(rules.replyChance)
    if (!Number.isFinite(chance) || chance <= 0) return { reply: false, reason: 'dice' }
    return { reply: Math.random() < chance, reason: 'dice' }
  }

  async function fetchProfile(userId) {
    const user = store.getState().users?.[userId]
    if (!user || user.displayName) return
    try {
      const profile = await withToken((token) => lineApi.getProfile(token, userId))
      if (profile?.displayName) {
        store.updateState((state) => ({
          ...state,
          users: {
            ...state.users,
            [userId]: {
              ...state.users[userId],
              displayName: profile.displayName,
              pictureUrl: profile.pictureUrl || '',
              statusMessage: profile.statusMessage || '',
            },
          },
        }))
      }
    } catch (error) {
      logger.warn(`讀取 LINE 個人檔失敗：${errorText(error)}`)
    }
  }

  async function fetchGroupSummary(chatId, kind) {
    const group = store.getState().groups?.[chatId]
    if (!group || group.displayName) return
    try {
      const summary = kind === 'room'
        ? await withToken((token) => lineApi.getRoomSummary(token, chatId))
        : await withToken((token) => lineApi.getGroupSummary(token, chatId))
      const name = summary?.groupName || summary?.roomName || ''
      if (name) {
        store.updateState((state) => ({
          ...state,
          groups: {
            ...state.groups,
            [chatId]: { ...state.groups[chatId], displayName: name, pictureUrl: summary.pictureUrl || '' },
          },
        }))
      }
    } catch (error) {
      logger.warn(`讀取 LINE 群組摘要失敗：${errorText(error)}`)
    }
  }

  function personName(userId) {
    const state = store.getState()
    return state.users?.[userId]?.displayName || state.people?.[userId]?.displayName || ''
  }

  async function ensurePerson(userId) {
    const name = personName(userId)
    if (name) return name
    try {
      const profile = await withToken((token) => lineApi.getProfile(token, userId))
      if (profile?.displayName) {
        store.updateState((state) => ({
          ...state,
          people: {
            ...(state.people || {}),
            [userId]: { displayName: profile.displayName, pictureUrl: profile.pictureUrl || '', at: Date.now() },
          },
        }))
        return profile.displayName
      }
    } catch (error) {
      logger.warn(`讀取 LINE 成員資料失敗（${userId}）：${errorText(error)}`)
    }
    return ''
  }

  function groupImportedText(groupId) {
    const imported = store.getState().groups?.[groupId]?.imported
    if (!imported) return ''
    const parts = ['【匯入的群組歷史】']
    if (imported.summary) parts.push(imported.summary)
    if (Array.isArray(imported.topics) && imported.topics.length > 0) parts.push(`常聊主題：${imported.topics.join('、')}`)
    parts.push('（以上是匯入的舊聊天整理出來的背景；自然接話就好，不要逐條複述，也不要說「根據匯入紀錄」。）')
    return parts.join('\n').slice(0, 1400)
  }

  function groupMemberKey(groupId, name) {
    const state = store.getState()
    const rows = [...Object.entries(state.users || {}), ...Object.entries(state.people || {})]
    const hit = rows.find(([, item]) => item?.displayName === name)
    return hit ? `${groupId}:${hit[0]}` : `${groupId}:name:${name}`
  }

  async function importGroupChat({ groupId, text, dryRun = false }) {
    const cfg = store.get()
    const parsed = chatImport.parseLineExport(text)
    const digest = chatImport.buildDigest(parsed)
    if (digest.messageCount === 0) throw new Error('讀不到聊天記錄，請確認是 LINE 匯出的 .txt')
    if (dryRun) {
      return {
        dryRun: true,
        groupId,
        title: parsed.title,
        messageCount: digest.messageCount,
        participants: parsed.participants.map((item) => item.name),
        digestChars: digest.text.length,
      }
    }
    if (!store.getState().groups?.[groupId]) ensureGroup(groupId, 'group')
    const sessionId = `session-import-${randomUUID()}`
    const reply = await runner.turn({
      sessionId,
      text: chatImport.buildImportPrompt(digest.text),
      persona: null,
      personaText: '',
      contextText: '',
      tools: [],
      cwd: ensureUserWorkspace(groupId) || cfg.agent.cwd || undefined,
    })
    const result = chatImport.parseImportResult(reply.text) || { summary: '', topics: [], members: [] }
    const botName = runtime.botInfo?.displayName || ''
    const members = []
    let added = 0
    const state = store.getState()
    for (const member of result.members) {
      if (!member.name) continue
      if (botName && member.name === botName) continue
      if (/^大肥魚$/.test(member.name) && botName === '大肥魚') continue
      const key = groupMemberKey(groupId, member.name)
      const existing = memory.list(key).map((entry) => entry.text)
      const notes = []
      for (const note of member.notes) {
        if (!note || existing.includes(note)) continue
        memory.add(key, { text: note, kind: 'fact', importance: 3, source: 'import' })
        notes.push(note)
        added += 1
      }
      members.push({ name: member.name, key, notes })
    }
    const imported = {
      at: Date.now(),
      messageCount: digest.messageCount,
      title: parsed.title,
      participants: parsed.participants.map((item) => item.name),
      summary: result.summary || '',
      topics: result.topics || [],
      members,
    }
    store.updateState((current) => {
      const target = current.groups?.[groupId]
      if (!target) return current
      return { ...current, groups: { ...current.groups, [groupId]: { ...target, imported } } }
    })
    logger.info(`匯入群組聊天：${parsed.title || groupId}，${digest.messageCount} 則，寫入 ${added} 筆記憶`)
    return {
      groupId,
      title: parsed.title,
      messageCount: digest.messageCount,
      participants: parsed.participants.map((item) => item.name),
      summary: result.summary || '',
      topics: result.topics || [],
      members: members.map((item) => ({ name: item.name, notes: item.notes.length })),
      memories: added,
      sessionId,
    }
  }

  function groupRecentText(groupId) {
    const rows = (store.getState().groups?.[groupId]?.recent || []).slice(-6)
    if (rows.length === 0) return ''
    return [
      '【群組最近的訊息】',
      ...rows.map((row) => `${row.name || row.userId}：${row.text}`),
      '（上面是群組裡最近幾則別人的訊息；現在輪到你回應，可以自然接話，但不要逐條回顧。）',
    ].join('\n')
  }

  function pushRecent(groupId, entry) {
    store.updateState((state) => {
      const group = state.groups?.[groupId]
      if (!group) return state
      const recent = [...(Array.isArray(group.recent) ? group.recent : []), entry].slice(-12)
      return { ...state, groups: { ...state.groups, [groupId]: { ...group, recent } } }
    })
  }

  function isAllowed(userId, cfg = store.get()) {
    const list = cfg.line.allowedUserIds || []
    return list.length > 0 && list.includes(userId)
  }

  function pendingUsersList() {
    return Object.values(store.getState().pendingUsers || {}).sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
  }

  function queuePendingUser(userId, patch = {}) {
    const existing = store.getState().pendingUsers?.[userId]
    if (existing) {
      if (patch.displayName || patch.lastText) {
        store.updateState((state) => ({
          ...state,
          pendingUsers: {
            ...(state.pendingUsers || {}),
            [userId]: { ...existing, displayName: patch.displayName || existing.displayName || '', lastText: patch.lastText || existing.lastText || '' },
          },
        }))
      }
      return existing
    }
    const entry = { userId, displayName: patch.displayName || '', lastText: patch.lastText || '', at: Date.now() }
    store.updateState((state) => ({ ...state, pendingUsers: { ...(state.pendingUsers || {}), [userId]: entry } }))
    logger.warn(`待審核使用者 ${userId}${entry.displayName ? `（${entry.displayName}）` : ''}`)
    return entry
  }

  function removePendingUser(userId) {
    store.updateState((state) => {
      if (!state.pendingUsers?.[userId]) return state
      const next = { ...state.pendingUsers }
      delete next[userId]
      return { ...state, pendingUsers: next }
    })
  }

  async function requireAccess(userId, { replyToken = '', sourceKind = 'user', text = '' } = {}) {
    const cfg = store.get()
    if (isAllowed(userId, cfg)) return true
    const mode = cfg.line.accessMode || 'approval'
    const allowed = cfg.line.allowedUserIds || []
    logger.warn(`拒絕未授權使用者 ${userId}（accessMode=${mode}，白名單 ${allowed.length} 人）`)
    if (mode !== 'approval') return false
    const first = !store.getState().pendingUsers?.[userId]
    const displayName = await ensurePerson(userId).catch(() => '')
    queuePendingUser(userId, { displayName: displayName || personName(userId), lastText: clip(text || '', 160) })
    if (first && sourceKind === 'user') {
      await replyOrPush(userId, replyToken, '已送出使用申請；等主人核准後就能聊天。').catch((error) => logger.warn(`待審核通知失敗：${errorText(error)}`))
    }
    return false
  }

  function approveUser(userId) {
    const id = String(userId || '').trim()
    if (!id) throw new Error('缺少 userId')
    const list = safeArray(store.get().line.allowedUserIds)
    if (!list.includes(id)) store.patch({ line: { allowedUserIds: [...list, id] } })
    removePendingUser(id)
    logger.info(`已核准使用者 ${id}`)
    sendPush(id, '主人核准了，現在可以正常聊天了。').catch((error) => logger.warn(`通知核准失敗：${errorText(error)}`))
    return { userId: id, allowed: true, allowedUserIds: store.get().line.allowedUserIds }
  }

  function denyUser(userId) {
    const id = String(userId || '').trim()
    if (!id) throw new Error('缺少 userId')
    removePendingUser(id)
    logger.info(`已拒絕使用者 ${id}`)
    return { userId: id, denied: true }
  }

  // ── LINE 端的「人設」指令（只改自己的） ────────────────────────────────
  const PERSONA_CMD = /^(?:換|切換|選擇)?\s*(?:人設|人格|persona)\s*([\s\S]*)$/i

  function personaCandidates(summary) {
    const list = summary?.catalog || summary?.list || summary?.personas || []
    return list.filter((item) => item.enabled !== false)
  }

  function findPersona(candidates, raw) {
    const key = String(raw || '').trim()
    if (!key) return null
    if (/^\d+$/.test(key)) return candidates[Number(key) - 1] || null
    const lower = key.toLowerCase()
    return (
      candidates.find((item) => item.id === key) ||
      candidates.find((item) => item.name === key) ||
      candidates.find((item) => String(item.name || '').toLowerCase() === lower) ||
      candidates.find((item) => String(item.name || '').includes(key)) ||
      null
    )
  }

  function personaMenuText(candidates, currentId) {
    const current = candidates.find((item) => item.id === currentId)
    const head = current ? `目前的人設是「${current.name}」。` : '目前還沒選人設。'
    const lines = candidates.map((item, index) => `${index + 1}. ${item.name}${item.id === currentId ? '（目前）' : ''}${item.source === 'local' ? '（插件自訂）' : item.builtin ? '' : '（自訂）'}`)
    return [head, '想換的話回我：', '・「人設 1」＝用清單編號', '・「人設 阿茶」＝用名字', '・「人設 預設」＝回到預設', '', ...lines].join('\n')
  }

  async function handlePersonaCommand({ ownerKind = 'user', ownerId, userId, sessionId, text, replyToken, dryRun = false }) {
    const match = text.match(PERSONA_CMD)
    if (!match) return null
    const cfg = store.get()
    if (cfg.persona.allowUserSwitch === false) {
      return { reply: '這個 bot 目前不開放自行切換人設；想換請跟管理者說。' }
    }
    const kind = ownerKind === 'group' ? 'group' : 'user'
    const id = ownerId || userId
    const state = store.getState()
    const bucket = kind === 'group' ? 'groups' : 'users'
    const user = dryRun
      ? (state[bucket]?.[id] || { personaId: cfg.persona.id })
      : (kind === 'group' ? ensureGroup(id) : ensureUser(id))
    const rest = String(match[1] || '').trim()
    let summary = null
    try {
      summary = await getPersonaSummary({ force: true })
    } catch (error) {
      logger.warn(`讀取人設清單失敗：${errorText(error)}`)
    }
    const candidates = personaCandidates(summary)
    if (!candidates.length) {
      return { reply: '目前沒有可用的人設。請管理者先在面板「回覆人設」新增一個。' }
    }
    const currentId = user.personaId || cfg.persona.id
    if (!rest) {
      return { reply: personaMenuText(candidates, currentId) }
    }
    const reset = /^(預設|預設值|重置|重設|default)$/i.test(rest)
    const fallbackDefault = candidates.find((item) => item.id === cfg.persona.id)
      || candidates.find((item) => item.source === 'dafeiyu')
      || candidates[0]
    const picked = reset ? fallbackDefault || null : findPersona(candidates, rest)
    if (!picked) {
      return { reply: `找不到「${rest}」這個人設。\n\n${personaMenuText(candidates, currentId)}` }
    }
    if (!dryRun) {
      store.updateState((next) => {
        const nextBucket = kind === 'group' ? 'groups' : 'users'
        const map = next[nextBucket] || {}
        return {
          ...next,
          [nextBucket]: { ...map, [id]: { ...(map[id] || {}), personaId: picked.id } },
        }
      })
      if (picked.source === 'local') {
        await persona().disableSessionPersona(sessionId).catch((error) => logger.warn(`停用大肥魚人設失敗：${errorText(error)}`))
      } else {
        await persona().setSessionPersona(sessionId, picked.id).catch((error) => logger.warn(`套用人設失敗：${errorText(error)}`))
      }
    }
    const prefix = reset ? '好，換回預設的' : '好，之後就用'
    return { reply: `${prefix}「${picked.name}」回你。` }
  }

  function publicBaseSync() {
    const cfg = store.get()
    if (runtime.publicUrl) return String(runtime.publicUrl).replace(/\/+$/, '')
    if (cfg.tunnel?.publicUrl) return String(cfg.tunnel.publicUrl).replace(/\/+$/, '')
    if (cfg.tunnel?.mode === 'api' && cfg.cloudflare?.hostname) return `https://${cfg.cloudflare.hostname}`
    return ''
  }

  const STICKER_MARKER = /\[\[\s*(?:sticker|貼圖|贴图|表情包)\s*:\s*([^\]\n]{1,60})\s*\]\]/gi
  const MEME_MARKER = /\[\[\s*meme\s*:\s*([^\]\n]{1,80})\s*\]\]/gi
  const MEME_HASH = /\[\[\s*meme\s*#\s*(\d{1,3})\s*\]\]/gi
  const MEME_ANGLE = /<\s*meme\s*#\s*(\d{1,3})\s*>/gi
  const MEME_BRACKET = /\[表情\s*[:：#]\s*([^\]\n]{1,80})\]/g

  function splitStickerMarkers(text) {
    const names = []
    const memeNames = []
    let cleaned = String(text || '')
      .replace(STICKER_MARKER, (_match, name) => {
        const value = String(name || '').trim()
        if (value) names.push(value)
        return ''
      })
      .replace(MEME_ANGLE, (_match, index) => {
        memeNames.push(`#${index}`)
        return ''
      })
      .replace(MEME_HASH, (_match, index) => {
        memeNames.push(`#${index}`)
        return ''
      })
      .replace(MEME_MARKER, (_match, name) => {
        const value = String(name || '').trim()
        if (value) memeNames.push(value)
        return ''
      })
    if (memes.available()) {
      cleaned = cleaned.replace(MEME_BRACKET, (_match, name) => {
        const value = String(name || '').trim()
        if (value) memeNames.push(value)
        return ''
      })
    }
    cleaned = cleaned
      .replace(/^\s*[<>]\s*$/gm, '')
      .replace(/[ \t]*[<>][ \t]*$/gm, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    return { text: cleaned, names, memes: memeNames }
  }

  function memeMaxPerReply() {
    return Math.max(1, Math.min(3, Number(store.get().stickers?.maxPerReply) || 1))
  }

  function memeContextText() {
    const cfg = store.get()
    if (cfg.stickers?.enabled === false) return ''
    if (!memes.available()) return ''
    if (memes.packs().length === 0) return ''
    const sample = memes.sample({ limit: 20 })
    runtime.memeChoices = sample
    const lines = (sample || []).filter((item) => String(item.caption || '').trim()).slice(0, 20)
    if (lines.length === 0) return ''
    return [
      '【表情包】你的貼圖只能從已安裝的 dsh-meme 外掛圖庫取得。下面是這一輪可用的清單（編號．情緒｜描述）：',
      lines.map((item, index) => `${index + 1}. ${item.tag || 'daily'}｜${String(item.caption || '').trim()}`).join('\n'),
      '想配圖時，在回覆最後加上 [[meme:#編號]]（例如 [[meme:#3]]）。規則：',
      '- 只能挑上面清單裡的編號；不要自己產生圖片、不要上傳、不要貼外部圖片網址、不要捏造檔案路徑、不要用 markdown 圖片語法。',
      '- 清單裡沒有適合的圖就不要硬挑，改用文字；想新增圖片請主人到 dsh-meme 的設定／圖庫頁加入，你這邊不能新增圖庫內容。',
      '- 不要呼叫 send_meme（LINE 沒有連到它，呼叫了也不會送出圖片），也不要寫 <meme#N> 或 [表情:…] 這種格式。',
      '- 標記放最後；不要在旁邊解釋圖片內容，也不要說「我傳了貼圖」。',
      '- 主人明確說「不要圖」「只要文字」時，就不要加任何標記。',
      '- 只回圖也可以：整則回覆只放標記。',
      `- 一次最多 ${memeMaxPerReply()} 張，編號必須是 1–${lines.length}。`,
      '- 氣氛明顯（開心、無語、害羞、想睡、被逗笑）才用；一般聊天、正事、難過時不要用；對方明確要表情包時就用。',
      '- 如果主人問「你的貼圖哪裡來的」，照實說：從 dsh-meme 圖庫挑的。',
      publicBaseSync() ? '' : '（目前沒有公開網址，圖片暫時送不出去。）',
    ].filter(Boolean).join('\n')
  }

  function stickerContextText() {
    const cfg = store.get()
    if (cfg.stickers?.enabled === false) return ''
    const items = stickers.list()
    if (items.length === 0) return ''
    const list = items.slice(0, 24).map((item) => `${item.name}${item.description ? `（${item.description}）` : ''}`).join('、')
    return [
      '【表情包】你可以在文字後面配一張圖，也可以只回一張圖。',
      `可用：${list}`,
      `想用時把 [[sticker:名稱]] 放在回覆最後，一次最多 ${memeMaxPerReply()} 張，名稱要完全符合；不需要就不要用，也不要每句都加。`,
      publicBaseSync() ? '' : '（目前沒有公開網址，圖片暫時送不出去。）',
    ].filter(Boolean).join('\n')
  }

  function convertToPng(filePath) {
    if (process.platform !== 'darwin') return ''
    try {
      const cacheDir = path.join(dir, 'cache')
      fs.mkdirSync(cacheDir, { recursive: true })
      const stat = fs.statSync(filePath)
      const key = createHash('sha1').update(`${filePath}:${stat.mtimeMs}`).digest('hex').slice(0, 16)
      const dest = path.join(cacheDir, `${key}.png`)
      if (!fs.existsSync(dest)) {
        execFileSync('sips', ['-s', 'format', 'png', filePath, '--out', dest], { stdio: 'ignore', timeout: 15000 })
      }
      return fs.existsSync(dest) ? dest : ''
    } catch (error) {
      logger.warn(`轉換表情包格式失敗：${errorText(error)}`)
      return ''
    }
  }

  function convertGifToApng(filePath) {
    try {
      const cacheDir = path.join(dir, 'cache')
      fs.mkdirSync(cacheDir, { recursive: true })
      const stat = fs.statSync(filePath)
      const key = createHash('sha1').update(`apng:${filePath}:${stat.mtimeMs}`).digest('hex').slice(0, 16)
      const dest = path.join(cacheDir, `${key}.apng.png`)
      if (!fs.existsSync(dest)) {
        const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', filePath, '-plays', '0', '-f', 'apng', dest], { timeout: 25000 })
        if (result.status !== 0 || !fs.existsSync(dest)) {
          logger.warn(`轉換 GIF 成 APNG 失敗：${String(result.stderr || '').slice(0, 200)}`)
          return ''
        }
      }
      const size = fs.statSync(dest).size
      if (size > 8 * 1024 * 1024) {
        logger.warn(`APNG 太大（${Math.round(size / 1024)} KB），改用靜態 PNG`)
        return ''
      }
      const head = fs.readFileSync(dest).subarray(0, 200)
      if (!head.includes(Buffer.from('acTL'))) return ''
      return dest
    } catch (error) {
      logger.warn(`轉換 GIF 成 APNG 失敗：${errorText(error)}`)
      return ''
    }
  }

  const mediaDir = path.join(dir, 'media')
  let mediaIndex = {}
  try {
    fs.mkdirSync(mediaDir, { recursive: true })
    mediaIndex = JSON.parse(fs.readFileSync(path.join(mediaDir, 'index.json'), 'utf8')) || {}
  } catch {
    mediaIndex = {}
  }

  function saveMediaIndex() {
    try {
      const file = path.join(mediaDir, 'index.json')
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(mediaIndex), { mode: 0o600 })
      fs.renameSync(tmp, file)
    } catch (error) {
      logger.warn(`儲存媒體索引失敗：${error?.message || error}`)
    }
  }

  function pruneMedia() {
    const cutoff = Date.now() - 90 * 86400000
    let dropped = 0
    for (const [key, item] of Object.entries(mediaIndex)) {
      if (!item || !item.at || item.at < cutoff) {
        try {
          fs.unlinkSync(path.join(mediaDir, item?.file || ''))
        } catch {
          /* 檔案可能已不在 */
        }
        delete mediaIndex[key]
        dropped += 1
      }
    }
    if (dropped > 0) saveMediaIndex()
  }
  pruneMedia()

  function registerImageFile(filePath) {
    const ext = path.extname(String(filePath || '')).toLowerCase()
    let serve = filePath
    let mime = ''
    if (ext === '.jpg' || ext === '.jpeg') mime = 'image/jpeg'
    else if (ext === '.png') mime = 'image/png'
    else if (ext === '.gif') {
      mime = 'image/png'
      serve = store.get().stickers?.apng === true
        ? (convertGifToApng(filePath) || convertToPng(filePath))
        : convertToPng(filePath)
    } else if (ext === '.webp') {
      mime = 'image/png'
      serve = convertToPng(filePath)
    } else {
      return ''
    }
    if (!mime || !serve || !fs.existsSync(serve)) return ''
    const token = `m${randomBytes(6).toString('hex')}`
    const filename = `${token}${mime === 'image/png' ? '.png' : '.jpg'}`
    const target = path.join(mediaDir, filename)
    try {
      fs.copyFileSync(serve, target)
    } catch (error) {
      logger.warn(`複製媒體失敗：${error?.message || error}`)
      return ''
    }
    const item = { file: filename, mime, at: Date.now(), bytes: fs.statSync(target).size }
    mediaTokens.set(token, item)
    mediaIndex[token] = item
    saveMediaIndex()
    return token
  }

  function registerFile(filePath, mime, ext = '') {
    if (!filePath || !fs.existsSync(filePath)) return ''
    const token = `m${randomBytes(6).toString('hex')}`
    const suffix = ext || path.extname(String(filePath || '')).toLowerCase() || '.bin'
    const filename = `${token}${suffix}`
    const target = path.join(mediaDir, filename)
    try {
      fs.copyFileSync(filePath, target)
    } catch (error) {
      logger.warn(`複製媒體失敗：${error?.message || error}`)
      return ''
    }
    const item = { file: filename, mime: mime || 'application/octet-stream', at: Date.now(), bytes: fs.statSync(target).size }
    mediaTokens.set(token, item)
    mediaIndex[token] = item
    saveMediaIndex()
    return token
  }

  function getMedia(id) {
    const key = String(id || '')
    if (!key) return null
    if (key.startsWith('m')) {
      const hit = mediaTokens.get(key) || mediaIndex[key]
      if (!hit) return null
      try {
        const bytes = fs.readFileSync(path.join(mediaDir, hit.file))
        mediaTokens.set(key, hit)
        return { mime: hit.mime, bytes }
      } catch {
        mediaTokens.delete(key)
        return null
      }
    }
    const entry = stickers.get(key)
    const bytes = entry ? stickers.readFile(entry) : null
    return entry && bytes ? { mime: entry.mime, bytes } : null
  }

  let publicReady = { base: '', at: 0 }

  async function publicBaseReady() {
    const base = publicBaseSync()
    if (!base) return ''
    if (publicReady.base === base && Date.now() - publicReady.at < 60 * 1000) return base
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2500) })
        if (res.ok) {
          publicReady = { base, at: Date.now() }
          return base
        }
      } catch {
        /* 還沒準備好，再試一次 */
      }
      await sleep(1200)
    }
    logger.warn(`公開網址尚未就緒，這次先不附圖：${base}`)
    return ''
  }

  function buildFlexMessage(text, urls) {
    const bubbles = urls.map((url, index) => {
      const bubble = {
        type: 'bubble',
        hero: { type: 'image', url, size: 'full', aspectRatio: '1:1', aspectMode: 'cover' },
      }
      if (index === 0 && text) {
        bubble.body = {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          contents: [{ type: 'text', text: String(text).slice(0, 1800), wrap: true, size: 'sm' }],
        }
      }
      return bubble
    })
    return {
      type: 'flex',
      altText: (text || '表情包').slice(0, 400),
      contents: bubbles.length === 1 ? bubbles[0] : { type: 'carousel', contents: bubbles },
    }
  }

  function findMemeChoice(desc, choices = runtime.memeChoices || []) {
    const query = String(desc || '').trim()
    if (!query || choices.length === 0) return null
    const exact = choices.find((item) => item.caption === query)
    if (exact) return exact
    const contained = choices.find((item) => item.caption && (item.caption.includes(query) || query.includes(item.caption)))
    if (contained) return contained
    const tokens = query.split(/[，,。.!！?？、\s]+/).filter((item) => item.length >= 2)
    let best = null
    let bestScore = 0
    for (const item of choices) {
      const caption = item.caption || ''
      let score = 0
      for (const token of tokens) if (caption.includes(token)) score += token.length
      if (score > bestScore) { bestScore = score; best = item }
    }
    return bestScore >= 2 ? best : null
  }

  // 把回覆切成多個 LINE 訊息框。預設用空行分段（段落），也可改成每個換行一段。
  function splitReplyText(text) {
    const cfg = store.get()
    const raw = String(text || '').trim()
    if (!raw) return []
    if (cfg.line?.splitMessages === false) return [raw]
    const separator = cfg.line?.splitMode === 'line' ? /\n+/ : /\n[ \t]*\n+/
    const parts = raw.split(separator).map((part) => part.trim()).filter(Boolean)
    return parts.length > 1 ? parts : [raw]
  }

  async function buildOutgoingMessages(text) {
    const cfg = store.get()
    const parsed = splitStickerMarkers(text)
    const max = memeMaxPerReply()
    const base = parsed.memes.length > 0 || parsed.names.length > 0 ? await publicBaseReady() : ''
    const imageUrls = []
    if (cfg.stickers?.enabled !== false && base && parsed.memes.length > 0 && memes.available()) {
      const sample = runtime.memeChoices?.length ? runtime.memeChoices : memes.sample({ limit: 20 })
      for (const desc of parsed.memes.slice(0, max)) {
        const indexMatch = /^#?(\d{1,3})$/.exec(String(desc).trim())
        const index = indexMatch ? Number(indexMatch[1]) - 1 : -1
        let file = index >= 0 ? (sample[index]?.path || '') : (findMemeChoice(desc, sample)?.path || '')
        if (!file) {
          const picked = memes.pick({ query: desc })
          file = picked?.ok && picked.path ? picked.path : ''
        }
        if (!file) {
          const fallback = memes.search({ query: desc, limit: 1 })
          file = fallback.memes?.[0]?.path || ''
        }
        if (!file) {
          logger.warn(`找不到表情包：${desc}`)
          continue
        }
        const token = registerImageFile(file)
        if (!token) {
          logger.warn(`表情包格式不支援（LINE 只收 JPEG/PNG）：${file}`)
          continue
        }
        imageUrls.push(`${base}/media/${token}`)
      }
    }
    if (cfg.stickers?.enabled !== false && base && parsed.names.length > 0) {
      for (const name of parsed.names.slice(0, max)) {
        const entry = stickers.get(name)
        if (!entry) {
          logger.warn(`找不到表情包：${name}`)
          continue
        }
        imageUrls.push(`${base}/media/${encodeURIComponent(entry.id)}`)
      }
    }
    const messages = []
    if (imageUrls.length > 0) {
      messages.push(buildFlexMessage(parsed.text, imageUrls))
    } else if (parsed.text) {
      const texts = []
      for (const segment of splitReplyText(parsed.text)) {
        for (const chunk of chunkText(segment)) texts.push(chunk)
      }
      // LINE 一次最多 5 則：超出時把多餘的段落併進最後一則，避免後半段被丟掉。
      if (texts.length > 5) {
        const kept = texts.slice(0, 4)
        kept.push(texts.slice(4).join('\n\n').slice(0, 4900))
        texts.length = 0
        texts.push(...kept)
      }
      for (const chunk of texts) {
        if (messages.length >= 5) break
        messages.push(chunk)
      }
    }
    return { messages: messages.slice(0, 5), parsed }
  }

  async function replyOrPush(userId, replyToken, texts) {
    const { messages } = await buildOutgoingMessages(texts)
    if (messages.length === 0) return
    const imageCount = messages.filter((item) => typeof item !== 'string' && item.type === 'image').length
    if (imageCount > 0) logger.info(`回覆含 ${imageCount} 張圖片`)
    try {
      await withToken((token) => lineApi.replyMessage(token, replyToken, messages))
    } catch (error) {
      logger.warn(`reply 失敗，改用 push：${errorText(error)}`)
      await withToken((token) => lineApi.pushMessage(token, userId, messages))
    }
  }

  async function handleEvent(event) {
    runtime.lastEventAt = Date.now()
    store.updateState((state) => ({ ...state, lastEventAt: runtime.lastEventAt }))
    const cfg = store.get()
    if (cfg.enabled === false) return
    const type = event?.type
    const source = event?.source || {}
    const userId = source.userId
    const sourceKind = source.type === 'group' ? 'group' : source.type === 'room' ? 'room' : 'user'
    const chatId = sourceKind === 'group' ? source.groupId : sourceKind === 'room' ? source.roomId : userId
    if (type === 'follow' && userId) {
      if (!(await requireAccess(userId, { replyToken: event.replyToken, sourceKind: 'user' }))) return
      const welcome = cfg.line.welcomeText || ''
      if (welcome && event.replyToken) {
        await replyOrPush(userId, event.replyToken, welcome).catch((error) => logger.warn(`歡迎訊息失敗：${errorText(error)}`))
      }
      return
    }
    if (type !== 'message') return
    if (!userId || !chatId) return
    const messageType = event.message?.type
    if (!(await requireAccess(userId, { replyToken: event.replyToken, sourceKind, text: messageType === 'text' ? String(event.message?.text || '') : '' }))) return
    const messageImages = []
    let text = ''
    if (messageType === 'text') {
      text = String(event.message.text || '').trim()
    } else if (messageType === 'sticker') {
      const keywords = Array.isArray(event.message.keywords)
        ? event.message.keywords.filter(Boolean).slice(0, 8).join('、')
        : ''
      const supportsImages = await modelSupportsImages()
      let hasImage = false
      let described = ''
      if (cfg.line?.stickerVision !== false) {
        try {
          if (supportsImages) {
            const ref = await stickerImages.toAttachment(event.message.stickerId, event.message.stickerResourceType)
            if (ref) {
              messageImages.push(ref)
              hasImage = true
            }
          } else {
            let description = ''
            const { data } = await stickerImages.fetchBytes(event.message.stickerId, event.message.stickerResourceType)
            const file = writeIncomingImage(Buffer.from(data), `sticker-${event.message.stickerId}-${Date.now()}.png`)
            if (vision.available()) {
              try {
                description = await describeImageFile(file, '這是一張 LINE 貼圖，請用繁體中文簡短描述圖案與情緒。')
              } catch (error) {
                logger.warn(`modlens 看貼圖失敗，改用視覺模型：${errorText(error)}`)
              }
            }
            if (!description) {
              try {
                const ref = await stickerImages.saveBuffer(Buffer.from(data), `line-sticker-${event.message.stickerId}.png`, 'image/png')
                description = await describeWithVisionModel(ref)
              } catch (error) {
                logger.warn(`視覺模型看貼圖失敗：${errorText(error)}`)
              }
            }
            described = description
          }
        } catch (error) {
          logger.warn(`取得貼圖圖片或看圖失敗，只用關鍵字：${errorText(error)}`)
        }
      }
      text = [
        `（使用者沒有打字，傳了一個 LINE 貼圖：packageId=${event.message.packageId ?? '?'}, stickerId=${event.message.stickerId ?? '?'}`,
        keywords ? `，貼圖關鍵字：${keywords}` : '',
        hasImage ? '，貼圖圖片已附在這一則訊息裡（請直接看圖）' : described ? `，貼圖內容描述：${described}` : '',
        '。請用你自己的語氣，一兩句自然回應這個貼圖；不要說「你傳了貼圖」這種話，依圖片內容或關鍵字猜情緒，不確定就輕鬆帶過。）',
      ].join('')
      logger.info(`收到貼圖（packageId=${event.message.packageId ?? '?'}, stickerId=${event.message.stickerId ?? '?'}${keywords ? `，${keywords}` : ''}${hasImage ? '，已附圖' : described ? '，已取得圖片描述' : ''}）`)
    } else if (messageType === 'image') {
      if (cfg.line?.imageVision === false) {
        logger.info('略過圖片（line.imageVision 關閉）')
        return
      }
      try {
        const messageId = event.message?.id
        if (!messageId) throw new Error('缺少 messageId')
        const buffer = await withToken((token) => lineApi.getMessageContent(token, messageId))
        const mediaType = imageMediaType(buffer)
        if (await modelSupportsImages()) {
          const ref = await stickerImages.saveBuffer(buffer, `line-image-${messageId}.${mediaType.split('/')[1]}`, mediaType)
          messageImages.push(ref)
          text = '（使用者傳了一張圖片，圖片已附在這一則訊息裡，請直接看圖並用你自己的語氣自然回應；不要說「你傳了圖片」這種話。）'
        } else {
          let description = ''
          if (vision.available()) {
            try {
              const file = writeIncomingImage(buffer, `incoming-${messageId}.${mediaType.split('/')[1]}`)
              description = await describeImageFile(file, '這是一張 LINE 對話中傳來的圖片，請用繁體中文簡潔描述內容與情緒。')
            } catch (error) {
              logger.warn(`modlens 看圖片失敗，改用視覺模型：${errorText(error)}`)
            }
          }
          if (!description) {
            try {
              const ref = await stickerImages.saveBuffer(buffer, `line-image-${messageId}.${mediaType.split('/')[1]}`, mediaType)
              description = await describeWithVisionModel(ref)
            } catch (error) {
              logger.warn(`視覺模型看圖片失敗：${errorText(error)}`)
            }
          }
          text = description
            ? `（使用者傳了一張圖片。圖片內容描述：${description}。請依這個描述用你自己的語氣自然回應，不要說「你傳了圖片」這種話。）`
            : '（使用者傳了一張圖片，但目前模型不支援看圖、modlens 也不可用；請用文字輕輕帶過，不要假裝看到內容。）'
        }
        logger.info(`收到圖片（messageId=${messageId}，${buffer.length} bytes）`)
      } catch (error) {
        logger.warn(`處理圖片失敗：${errorText(error)}`)
        text = '（使用者傳了一張圖片，但下載或辨識失敗；請用文字輕輕帶過，不要假裝看到內容。）'
      }
    } else {
      logger.info(`略過非文字訊息（${messageType}）`)
      return
    }
    if (!text) return

    let groupReason = ''
    let groupRecent = ''
    let senderName = ''
    if (sourceKind !== 'user') {
      senderName = await ensurePerson(userId)
      const bufferText = messageType === 'sticker' ? '（傳了一個 LINE 貼圖）' : clip(text, 300)
      const gate = groupGate(event.message, cfg)
      if (!gate.reply) {
        pushRecent(chatId, { userId, name: senderName || userId, text: bufferText, at: Date.now() })
        logger.info(`群組訊息（${gate.reason}）：這次不回`)
        return
      }
      groupRecent = groupRecentText(chatId)
      pushRecent(chatId, { userId, name: senderName || userId, text: bufferText, at: Date.now() })
      groupReason = gate.reason
      logger.info(`群組訊息：回覆（${gate.reason}）`)
    }

    const conversationKey = sourceKind === 'user' ? userId : chatId
    const memoryKey = sourceKind === 'user' ? userId : `${chatId}:${userId}`
    const user = sourceKind === 'user' ? ensureUser(userId) : ensureGroup(chatId, sourceKind)
    const bucketName = sourceKind === 'user' ? 'users' : 'groups'
    store.updateState((state) => {
      const map = state[bucketName] || {}
      const target = map[conversationKey]
      if (!target) return state
      return {
        ...state,
        totalMessages: (Number(state.totalMessages) || 0) + 1,
        [bucketName]: {
          ...map,
          [conversationKey]: { ...target, messages: (Number(target.messages) || 0) + 1, lastAt: Date.now(), lastUserAt: Date.now() },
        },
      }
    })

    if (sourceKind === 'user') {
      try {
        nudge.noteUserMessage(userId)
      } catch (error) {
        logger.warn(`重設主動傳訊倒數失敗：${errorText(error)}`)
      }
    }

    const personaResult = await handlePersonaCommand({
      ownerKind: sourceKind,
      ownerId: conversationKey,
      sessionId: user.sessionId,
      text,
      replyToken: event.replyToken,
    })
    if (personaResult) {
      await replyOrPush(chatId, event.replyToken, personaResult.reply)
      return
    }

    try {
      if (cfg.line.loadingEnabled && event.replyToken) {
        await withToken((token) => lineApi.startLoading(token, chatId)).catch(() => {})
      }
      const freshMap = sourceKind === 'user' ? store.getState().users : store.getState().groups
      const freshUser = freshMap?.[conversationKey] || user
      const selection = cfg.persona.enforce ? freshUser.personaId || cfg.persona.id : ''
      const applied = await applyPersonaSelection(selection, user.sessionId)
      const result = await runner.turn({
        sessionId: user.sessionId,
        text,
        persona: applied.persona,
        personaText: applied.personaText,
        overlayText: personaOverlayText(applied),
        personaClient: persona(),
        contextText: agentContextText(
          memoryKey,
          sourceKind,
          [
            groupImportedText(conversationKey),
            groupRecent,
            senderName && `${chatId}:name:${senderName}` !== memoryKey ? memoryContextText(`${chatId}:name:${senderName}`) : '',
          ].filter(Boolean).join('\n\n'),
        ),
        tools: memoryToolsFor(memoryKey),
        images: messageImages,
        cwd: ensureUserWorkspace(conversationKey) || cfg.agent.cwd || undefined,
      })
      let replyText = String(result?.text || '').trim()
      const voiceDirective = splitVoiceMarker(replyText)
      replyText = voiceDirective.text
      const parsedReply = splitStickerMarkers(replyText)
      let voiceSent = null
      if (voiceDirective.requested && voiceReady(cfg)) {
        const spoken = parsedReply.text || ''
        if (spoken) {
          try {
            voiceSent = await synthesizeVoiceMessage(spoken, voiceDirective.instruct)
            logger.info(`語音回覆：${spoken.length} 字，${Math.round((voiceSent.durationMs || 0) / 1000)} 秒（${voiceSent.provider}；語氣：${voiceDirective.instruct || '預設'}）`)
          } catch (error) {
            logger.warn(`語音合成失敗，改用文字：${errorText(error)}`)
          }
        }
      }
      if (voiceSent) {
        await replyMessages(chatId, event.replyToken, [voiceSent.message])
      } else {
        if (!parsedReply.text && parsedReply.names.length === 0) replyText = cfg.line.emptyReply || '（她沒有說話）'
        await replyOrPush(chatId, event.replyToken, replyText)
      }
      runtime.lastReply = { chatId, kind: sourceKind, at: Date.now(), text: clip(voiceSent ? `[語音] ${parsedReply.text || replyText}` : parsedReply.text || (parsedReply.names.length ? `[表情包] ${parsedReply.names.join('、')}` : replyText), 300) }
      store.updateState((state) => {
        const map = state[bucketName] || {}
        const target = map[conversationKey]
        if (!target) return { ...state, lastReply: runtime.lastReply }
        return {
          ...state,
          lastReply: runtime.lastReply,
          [bucketName]: { ...map, [conversationKey]: { ...target, lastAt: Date.now(), lastReplyAt: Date.now() } },
        }
      })
    } catch (error) {
      runtime.lastLineError = errorText(error)
      logger.error(`回覆 ${chatId} 失敗：${errorText(error)}`)
      const fallback = cfg.line.errorReply || '（剛剛卡住了，再說一次好嗎？）'
      await replyOrPush(chatId, event.replyToken, fallback).catch((err) => logger.error(`錯誤訊息也送不出去：${errorText(err)}`))
    }
    if (sourceKind === 'user') void fetchProfile(userId)
    else void fetchGroupSummary(chatId, sourceKind)
  }

  // ── 元件 ────────────────────────────────────────────────────────────────
  const runner = createAgentRunner({ ctx, logger, getConfig: () => store.get() })
  const stickers = createStickerStore({ dir, logger })
  const memes = createMemeSource({ ctx, logger })
  const stickerImages = createStickerImages({ ctx, logger, dir })
  const vision = createVision({ logger, cacheDir: path.join(dir, 'cache') })
  const tts = createTts({ dir, logger, getConfig: () => store.get() })
  const mediaTokens = new Map()
  let imageSupportCache = { at: 0, key: '', value: false }

  async function modelSupportsImages() {
    const selection = modelSelection()
    const key = `${selection.provider}/${selection.model}`
    if (imageSupportCache.key === key && Date.now() - imageSupportCache.at < 60_000) return imageSupportCache.value
    let value = false
    try {
      const llm = ctx.get?.('llm')
      if (llm?.resolveModelInfo && selection.provider && selection.model) {
        const info = await llm.resolveModelInfo(selection.provider, selection.model)
        value = Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')
      }
      if (!value) {
        const catalog = await modelCatalog({ force: false }).catch(() => null)
        const provider = catalog?.providers?.find((item) => item.id === selection.provider)
        const model = provider?.models?.find((item) => item.id === selection.model)
        value = Array.isArray(model?.inputModalities) && model.inputModalities.includes('image')
      }
    } catch (error) {
      logger.warn(`查模型圖片能力失敗：${errorText(error)}`)
    }
    imageSupportCache = { at: Date.now(), key, value }
    return value
  }

  function imageMediaType(buffer) {
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || [])
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png'
    if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
    if (bytes.length >= 6 && bytes.toString('ascii', 0, 3) === 'GIF') return 'image/gif'
    return 'image/png'
  }

  function writeIncomingImage(buffer, name) {
    const file = path.join(dir, 'cache', name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, buffer)
    return file
  }

  async function describeImageFile(file, prompt) {
    const described = await vision.describe(file, { prompt })
    return described.text
  }

  async function describeWithVisionModel(ref) {
    const llm = ctx.get?.('llm')
    if (!llm?.stream || !ref) return ''
    const catalog = await modelCatalog({ force: false }).catch(() => null)
    const wanted = [
      ['cguair', 'gpt-6.1-terra'],
      ['cguair', 'gpt-6.1-sol'],
      ['deepseek-account', 'deepseek-flash'],
      ['deepseek-official', 'deepseek-flash'],
      ['deepseek-modlens', 'deepseek-v4-pro'],
    ]
    const available = []
    for (const [provider, model] of wanted) {
      const item = catalog?.providers?.find((entry) => entry.id === provider)?.models?.find((entry) => entry.id === model)
      if (item && Array.isArray(item.inputModalities) && item.inputModalities.includes('image')) available.push({ provider, model })
    }
    for (const entry of available) {
      try {
        let text = ''
        const stream = llm.stream({
          provider: entry.provider,
          model: entry.model,
          maxTokens: 220,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: '請用繁體中文簡短描述這張圖片的內容與情緒，兩句以內，不要客套。' },
                { type: 'image', attachment: ref },
              ],
            },
          ],
        })
        for await (const chunk of stream) {
          if (chunk?.type === 'text-delta') text += chunk.text || ''
        }
        if (text.trim()) return text.trim()
      } catch (error) {
        logger.warn(`用 ${entry.provider}/${entry.model} 看圖失敗：${errorText(error)}`)
      }
    }
    return ''
  }

  const server = createWebhookServer({ getConfig: () => store.get(), logger, dispatch: handleEvent, getMedia, getDoctor: (options) => runDiagnostics(options) })

  const tunnel = createTunnelManager({
    getConfig: () => withEnvCloudflare(store.get()),
    patchConfig: (patch) => store.patch(patch, { silent: true }),
    logger,
    dataDir: dir,
    onUrl: async (url) => {
      logger.info(`Cloudflare 公網位址：${url}`)
      runtime.publicUrl = String(url || '').replace(/\/+$/, '')
      if (!store.get().tunnel.autoConfigureWebhook) return
      try {
        await applyWebhook(url)
      } catch (error) {
        logger.warn(`自動設定 LINE webhook 失敗：${errorText(error)}`)
        webhookWatch.attempts = 0
        scheduleWebhookRetry(url)
      }
    },
    onPhase: () => {},
  })

  async function sendPush(userId, text) {
    const voiceDirective = splitVoiceMarker(text)
    if (voiceDirective.requested) logger.info('主動訊息中的語音標記已忽略，改用文字')
    const { messages } = await buildOutgoingMessages(voiceDirective.text)
    if (messages.length === 0) return { sent: false, reason: 'empty' }
    const imageCount = messages.filter((item) => typeof item !== 'string' && item.type === 'image').length
    if (imageCount > 0) logger.info(`主動訊息含 ${imageCount} 張圖片`)
    const response = await withToken((token) => lineApi.pushMessage(token, userId, messages))
    logger.info(`主動訊息已送出（${messages.length} 則，LINE 回報 ${Array.isArray(response?.sentMessages) ? response.sentMessages.length : '未知'} 則）`)
    store.updateState((state) => ({
      ...state,
      users: {
        ...state.users,
        [userId]: { ...(state.users[userId] || {}), lastAt: Date.now(), lastPushAt: Date.now() },
      },
    }))
    return { sent: true, count: messages.length, requestId: response?.requestId || '' }
  }

  const nudge = createNudgeScheduler({
    getConfig: () => store.get(),
    store,
    logger,
    runTurn: async ({ sessionId, text }) => {
      const cfg = store.get()
      const owner = Object.entries(store.getState().users || {}).find(([, item]) => item.sessionId === sessionId)
      const selection = cfg.persona.enforce ? owner?.[1]?.personaId || cfg.persona.id : ''
      const applied = await applyPersonaSelection(selection, sessionId)
      return runner.turn({
        sessionId,
        text,
        persona: applied.persona,
        personaText: applied.personaText,
        overlayText: personaOverlayText(applied),
        personaClient: persona(),
        contextText: agentContextText(owner?.[0]),
        tools: memoryToolsFor(owner?.[0]),
        cwd: owner ? ensureUserWorkspace(owner[0]) : undefined,
      })
    },
    sendProactive: sendPush,
  })

  const tiebaSync = createTiebaSync({ ctx, store, logger, getCatalog: async () => (await getPersonaSummary({ force: true })).catalog })

  // ── 人設摘要（給面板） ───────────────────────────────────────────────────
  let personaCache = { at: 0, value: null }
  function readDafeiyuStoreFallback() {
    const builtins = [
      { id: 'dafeiyu', name: '大肥魚', chars: 635 },
      { id: 'acha', name: '阿茶', chars: 979 },
      { id: 'tinglan', name: '听澜', chars: 1738 },
    ].map((item) => ({ ...item, builtin: true, enabled: true, description: '', source: 'dafeiyu' }))
    const list = builtins
    try {
      const file = path.join(dshHome(), 'storages', 'dsh-persona-dafeiyu', 'personas.json')
      const raw = readJsonSafe(file, null)
      for (const item of raw?.personas || []) {
        const id = String(item?.id || '').trim()
        if (!id) continue
        list.push({
          id,
          name: String(item.name || id),
          builtin: false,
          enabled: true,
          chars: String(item.text || '').length,
          description: '直接從 personas.json 讀取',
          source: 'dafeiyu',
        })
      }
    } catch { /* 讀不到就只列內建 */ }
    return list
  }

  async function getPersonaSummary({ force = false } = {}) {
    const cfg = store.get()
    if (!force && personaCache.value && Date.now() - personaCache.at < 5000) return personaCache.value
    const client = persona()
    const local = localPersonas.catalog()
    const localBuiltins = local.filter((item) => item.builtin)
    const localCustom = local.filter((item) => !item.builtin)
    const selectedSource = String(cfg.persona.id || '').startsWith(LOCAL_PREFIX) ? 'local' : 'dafeiyu'
    const summary = {
      available: Boolean(getOrigin()),
      bridgeAvailable: false,
      mode: '',
      current: '',
      currentName: '',
      globalOff: false,
      selected: cfg.persona.id,
      selectedName: '',
      selectedSource,
      enforce: cfg.persona.enforce,
      list: [],
      local,
      catalog: [...local],
      warning: '',
      error: '',
      localPath: localPersonas.stats().path,
    }
    try {
      const status = await client.status()
      summary.available = true
      summary.bridgeAvailable = true
      summary.mode = status?.mode || ''
      summary.current = status?.current || ''
      summary.currentName = status?.currentName || ''
      summary.globalOff = Boolean(status?.globalOff)
      summary.list = (status?.personas || []).map((item) => ({
        id: item.id,
        name: item.name,
        builtin: Boolean(item.builtin),
        enabled: item.enabled !== false,
        chars: item.chars,
        description: item.description || '',
        source: 'dafeiyu',
      }))
      summary.local = local
      summary.catalog = [
        ...summary.list.filter((item) => item.enabled !== false),
        ...localCustom,
      ]
    } catch (error) {
      summary.error = errorText(error)
      summary.list = []
      summary.local = local
      summary.mode = 'unknown'
      summary.catalog = [...local]
      summary.warning = localBuiltins.length
        ? '目前讀不到大肥魚外掛，改用插件內建的繁體中文人設；大肥魚的人設要等外掛回來才能用。'
        : '目前讀不到大肥魚外掛，也沒有內建人設可用（請重新載入插件）。'
    }
    const bridgeUp = summary.bridgeAvailable
    reconcileBuiltinSelection(bridgeUp)
    const liveCfg = store.get()
    summary.selected = liveCfg.persona.id
    summary.selectedSource = String(liveCfg.persona.id || '').startsWith(LOCAL_PREFIX) ? 'local' : 'dafeiyu'
    let selected = summary.catalog.find((item) => item.id === liveCfg.persona.id)
    if (!selected && BUILTIN_IDS.includes(liveCfg.persona.id)) {
      const alias = localBuiltinAlias(liveCfg.persona.id)
      if (alias) selected = summary.catalog.find((item) => item.id === alias)
    }
    summary.selectedName = selected?.name || ''
    if (selected && selected.builtin && !bridgeUp) {
      summary.warning = '目前使用插件內建的繁體中文人設（沒有偵測到大肥魚外掛）；可在下方人設庫編輯。'
    } else if (!selected) {
      summary.warning = summary.selectedSource === 'local'
        ? `找不到自訂人設「${liveCfg.persona.id}」，LINE 會改用預設人設。`
        : (bridgeUp
            ? `找不到人設「${liveCfg.persona.id}」，LINE 會退回預設人設。`
            : `找不到人設「${liveCfg.persona.id}」；如果那是大肥魚的人設，請安裝／重新載入大肥魚外掛，或改用插件內建的繁中版本。`)
    } else if (!summary.error && summary.selectedSource === 'dafeiyu' && liveCfg.persona.enforce && summary.mode !== 'session') {
      summary.warning = `大肥魚目前是「${summary.mode || '未知'}」模式；LINE 的逐 session 人設指定要切到 session 模式才會生效。`
    }
    personaCache = { at: Date.now(), value: summary }
    return summary
  }

  // ── 啟停 ────────────────────────────────────────────────────────────────
  async function startAll() {
    const cfg = store.get()
    await server.start()
    if (cfg.tunnel.autoStart) {
      try {
        await tunnel.start()
      } catch (error) {
        logger.error(`tunnel 啟動失敗：${errorText(error)}`)
        throw error
      }
    }
    const liveTunnel = await tunnel.status().catch(() => null)
    if (liveTunnel?.url) runtime.publicUrl = String(liveTunnel.url).replace(/\/+$/, '')
    startWebhookGuard()
    nudge.start()
    tiebaSync.start()
    startBalanceWatch()
    startMemoryWatch()
    store.updateState((state) => ({ ...state, lastStartAt: Date.now() }))
    if (cfg.line.channelId && cfg.line.channelSecret) refreshBotInfo().catch(() => {})
    return buildStatus()
  }

  async function stopAll() {
    stopWebhookGuard()
    stopBalanceWatch()
    stopMemoryWatch()
    nudge.stop()
    tiebaSync.stop()
    await tunnel.stop({ silent: true }).catch(() => {})
    await server.stop().catch(() => {})
    return buildStatus()
  }

  async function runDiagnostics({ repair = false } = {}) {
    const cfg = store.get()
    const checks = []
    const check = diagnosticsMod.check
    if (repair) {
      try {
        const tunnelState = await tunnel.status()
        if (cfg.tunnel?.autoStart && tunnelState.phase !== 'running' && tunnelState.phase !== 'external') await tunnel.start()
        await refreshBotInfo()
        await reconcileWebhook({ force: true })
      } catch (error) {
        logger.warn(`診斷修復失敗：${errorText(error)}`)
      }
    }
    const serverState = server.status()
    checks.push(check('server', 'Webhook 伺服器', serverState.running ? 'ok' : 'fail',
      serverState.running ? `127.0.0.1:${serverState.port}` : (serverState.lastError || '沒有啟動'),
      serverState.running ? '' : '面板按「啟動伺服器」，或執行 npx dsh-line-bot doctor --fix'))
    const tunnelState = await tunnel.status().catch((error) => ({ phase: 'error', error: errorText(error) }))
    const phaseOk = tunnelState.phase === 'running' || tunnelState.phase === 'external'
    checks.push(check('tunnel', 'Cloudflare Tunnel', phaseOk ? 'ok' : 'fail',
      `${tunnelState.phase}${tunnelState.url ? `：${tunnelState.url}` : ''}${tunnelState.error ? `（${tunnelState.error}）` : ''}`,
      phaseOk ? '' : '檢查 tunnel.mode、cloudflared 路徑或 API Token，然後重啟 tunnel'))
    const base = publicBaseSync()
    checks.push(check('public-url', '公開網址', base ? 'ok' : 'fail', base || '沒有公開網址，LINE 抓不到圖片',
      base ? '' : '啟動 tunnel，或設定 tunnel.publicUrl'))
    if (base) {
      let reachable = false
      let detail = ''
      try {
        const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(6000) })
        reachable = res.ok
        detail = `HTTP ${res.status}`
      } catch (error) {
        detail = errorText(error)
      }
      checks.push(check('public-health', '公開網址健康檢查', reachable ? 'ok' : 'warn', detail || '無法連線',
        reachable ? '' : 'quick tunnel 換網址後 LINE 可能還抓不到舊圖；重啟 tunnel 並重設 webhook'))
    }
    try {
      const token = await getToken()
      const endpoint = await lineApi.getWebhookEndpoint(token)
      const expected = base ? `${base}/webhook` : ''
      const matches = expected && String(endpoint?.endpoint || '') === expected
      checks.push(check('webhook', 'LINE Webhook', endpoint?.active && matches ? 'ok' : 'fail',
        `active=${!!endpoint?.active} endpoint=${endpoint?.endpoint || '（未設定）'}`,
        endpoint?.active && matches ? '' : '面板按「套用 Webhook」，或執行 doctor --fix'))
    } catch (error) {
      checks.push(check('webhook', 'LINE Webhook', 'warn', errorText(error), '確認 Channel Access Token 與網路'))
    }
    let memeStats = { available: false, count: 0 }
    try {
      memeStats = memes.stats()
      checks.push(check('dsh-meme', 'dsh-meme 圖庫', memeStats.available && memeStats.count > 0 ? 'ok' : 'fail',
        `available=${!!memeStats.available} count=${memeStats.count || 0}`,
        memeStats.available ? '' : '安裝 dsh-meme 外掛（npx dsh-line-bot install --with-companions）'))
    } catch (error) {
      checks.push(check('dsh-meme', 'dsh-meme 圖庫', 'fail', errorText(error), '安裝 dsh-meme 外掛'))
    }
    const stickerCfg = cfg.stickers || {}
    checks.push(check('meme-config', '表情包設定', stickerCfg.enabled === false ? 'warn' : 'ok',
      `enabled=${stickerCfg.enabled !== false} maxPerReply=${stickerCfg.maxPerReply || 1} apng=${!!stickerCfg.apng}`,
      stickerCfg.enabled === false ? '面板「表情包」打開「允許角色使用表情包」' : ''))
    const sips = diagnosticsMod.whichCommand('sips')
    const ffmpeg = diagnosticsMod.whichCommand('ffmpeg')
    checks.push(check('converters', '轉圖工具', (sips || ffmpeg) ? (process.platform === 'win32' && !ffmpeg ? 'warn' : 'ok') : 'warn',
      `sips=${sips ? '有' : '無'} ffmpeg=${ffmpeg ? '有' : '無'}（GIF／APNG 需要 ffmpeg；webp 需要 sips 或 ffmpeg）`,
      process.platform === 'win32' && !ffmpeg ? 'Windows 建議安裝 ffmpeg，否則 GIF／webp 表情包會送不出去' : '安裝 ffmpeg（brew install ffmpeg）可轉 GIF／APNG'))
    try {
      const selected = modelSelection()
      const info = await ctx.get?.('llm')?.resolveModelInfo?.(selected.provider, selected.model)
      const modalities = info?.inputModalities || []
      checks.push(check('model', '回覆模型', 'ok',
        `${selected.provider}/${selected.model}${modalities.length ? `（${modalities.join('+')}）` : ''}`,
        modalities.includes('image') ? '' : '這個模型不吃圖；會改用 modlens 或另一個視覺模型描述圖片，失敗才退回關鍵字'))
    } catch (error) {
      checks.push(check('model', '回覆模型', 'warn', errorText(error), '在面板「模型與接口來源」重新選模型'))
    }
    {
      const status = vision.status()
      checks.push(check('vision', '看圖能力（modlens）', status.available ? 'ok' : 'warn',
        status.available ? `modlens 可用${status.lastError ? `；最近錯誤：${status.lastError}` : ''}` : '找不到 modlens；模型不吃圖時會退回關鍵字',
        status.available ? '' : '安裝 @liustack/modlens，或改用支援圖片的模型'))
    }
    if (memeStats.available && base) {
      try {
        const sample = memes.sample({ limit: 1 })[0]
        if (sample) {
          const marker = `測試 [[meme:${sample.caption || sample.tag || ''}]]`
          const built = await buildOutgoingMessages(marker)
          let imageUrl = ''
          for (const item of built.messages) {
            if (item.type === 'image') imageUrl = item.originalContentUrl
            else if (item.type === 'flex') {
              const contents = item.contents || {}
              if (contents.type === 'bubble') imageUrl = contents.hero?.url || ''
              else if (contents.type === 'carousel') imageUrl = contents.contents?.[0]?.hero?.url || ''
            }
            if (imageUrl) break
          }
          if (imageUrl) {
            const res = await fetch(imageUrl, { signal: AbortSignal.timeout(8000) })
            checks.push(check('media', '圖片可送達測試', res.ok ? 'ok' : 'fail',
              res.ok ? `HTTP ${res.status} ${imageUrl}` : `HTTP ${res.status}`,
              res.ok ? '' : '公開網址或 /media 路由有問題，重啟 tunnel 後再試'))
          } else {
            checks.push(check('media', '圖片可送達測試', 'fail',
              `組不出圖片訊息（caption=${String(sample.caption || '').slice(0, 30)}，messages=${built.messages.length}，markers=${built.parsed.memes.length}）`,
              '確認 dsh-meme 圖庫與公開網址'))
          }
        }
      } catch (error) {
        checks.push(check('media', '圖片可送達測試', 'warn', errorText(error), '重試或查看日誌'))
      }
    }
    try {
      const today = new Date().toISOString().slice(0, 10)
      const recent = diagnosticsMod.scanLogForErrors(path.join(dir, 'logs', `${today}.log`))
      checks.push(check('logs', '最近錯誤', recent.length ? 'warn' : 'ok',
        recent.length ? recent[recent.length - 1].slice(0, 240) : '沒有最近錯誤',
        recent.length ? `看完整日誌：${path.join(dir, 'logs', `${today}.log`)}` : ''))
    } catch { /* ignore */ }
    const summary = diagnosticsMod.summarizeChecks(checks)
    return { version: VERSION, at: Date.now(), summary, checks }
  }

  // ── 狀態快照 ────────────────────────────────────────────────────────────
  async function buildStatus() {
    const cfg = store.get()
    const state = store.getState()
    const personaSummary = await getPersonaSummary()
    const tunnelStatus = await tunnel.status().catch((error) => ({ phase: 'error', error: errorText(error) }))
    const personaNames = new Map((personaSummary?.catalog || personaSummary?.list || []).map((item) => [item.id, item.name]))
    const users = Object.entries(state.users || {})
      .map(([userId, user]) => {
        const personaId = user.personaId || cfg.persona.id
        return {
          userId,
          sessionId: user.sessionId || '',
          displayName: user.displayName || '',
          pictureUrl: user.pictureUrl || '',
          messages: Number(user.messages) || 0,
          nudges: Number(user.nudges) || 0,
          nudgeNextAt: Number(user.nudgeNextAt) || 0,
          nudgeUnanswered: Number(user.nudgeUnanswered) || 0,
          nudgePaused: Boolean(user.nudgePaused),
          nudgeLastAt: Number(user.nudgeLastAt) || 0,
          lastAt: Number(user.lastAt) || 0,
          lastUserAt: Number(user.lastUserAt) || 0,
          lastReplyAt: Number(user.lastReplyAt) || 0,
          personaId,
          personaName: personaNames.get(personaId) || '',
          workspaceDir: user.workspaceDir || (cfg.agent.perUserWorkspace ? userWorkspaceDir(userId, cfg) : ''),
        }
      })
      .sort((a, b) => b.lastAt - a.lastAt)
    const groups = Object.entries(state.groups || {})
      .map(([groupId, group]) => {
        const personaId = group.personaId || cfg.persona.id
        return {
          groupId,
          kind: group.kind || 'group',
          sessionId: group.sessionId || '',
          displayName: group.displayName || '',
          pictureUrl: group.pictureUrl || '',
          messages: Number(group.messages) || 0,
          lastAt: Number(group.lastAt) || 0,
          lastUserAt: Number(group.lastUserAt) || 0,
          lastReplyAt: Number(group.lastReplyAt) || 0,
          personaId,
          personaName: personaNames.get(personaId) || '',
          workspaceDir: group.workspaceDir || (cfg.agent.perUserWorkspace ? userWorkspaceDir(groupId, cfg) : ''),
        }
      })
      .sort((a, b) => b.lastAt - a.lastAt)
    const hasBot = Boolean(runtime.botInfo)
    const publicCfg = publicConfig(cfg)
    if (publicCfg.cloudflare) {
      publicCfg.cloudflare.hasApiToken = Boolean(cfg.cloudflare.apiToken || ENV_CF_TOKEN)
      publicCfg.cloudflare.tokenSource = cfg.cloudflare.apiToken ? 'config' : ENV_CF_TOKEN ? 'env' : 'none'
    }
    return {
      version: VERSION,
      startedAt,
      now: Date.now(),
      paths: { dataDir: dir, configPath: store.configPath, statePath: store.statePath },
      config: publicCfg,
      line: {
        configured: Boolean((cfg.line.channelId && cfg.line.channelSecret) || cfg.line.accessToken),
        hasChannelId: Boolean(cfg.line.channelId),
        hasSecret: Boolean(cfg.line.channelSecret),
        hasToken: Boolean(cfg.line.accessToken),
        channelId: cfg.line.channelId,
        tokenSource: runtime.tokenSource,
        tokenExpiresAt: Number(cfg.line.tokenExpiresAt) || 0,
        bot: hasBot ? runtime.botInfo : null,
        botCheckedAt: runtime.botInfoAt,
        webhook: state.webhook || null,
        lastError: runtime.lastLineError,
        lastEventAt: state.lastEventAt || runtime.lastEventAt,
        totalMessages: Number(state.totalMessages) || 0,
        lastReply: state.lastReply || runtime.lastReply || null,
      },
      server: server.status(),
      tunnel: tunnelStatus,
      persona: personaSummary,
      agent: {
        ...runner.stats(),
        ...modelSelection(),
        timeoutMs: cfg.agent.timeoutMs,
        lastFinishedAt: runner.stats().lastFinishedAt,
      },
      nudge: { ...nudge.stats(), config: cfg.nudge },
      balance: {
        ...balance.get(),
        applicable: balanceApplicable(),
        provider: modelSelection().provider,
        enabled: cfg.balance.enabled !== false,
        ask: cfg.balance.ask !== false,
        threshold: Number(cfg.balance.threshold) || 0,
        cooldownHours: Number(cfg.balance.cooldownHours) || 12,
        lastAskAt: Number(state.balance?.lastAskAt) || 0,
        nextCheckAt: balanceNextAt,
        targetUserIds: safeArray(cfg.balance?.targetUserIds),
        lastAskText: state.balance?.lastAskText || '',
        low: Boolean(balanceView() && Number(cfg.balance.threshold) > 0 && balanceView().value.total < Number(cfg.balance.threshold)),
      },
      meme: {
        ...memes.stats(),
        enabled: cfg.stickers?.enabled !== false,
        maxPerReply: memeMaxPerReply(),
        publicBase: publicBaseSync(),
        sample: memes.sample({ limit: 8 }).map((item) => ({ tag: item.tag, caption: item.caption, packName: item.packName })),
        localStickers: stickers.stats().count,
      },
      stickers: {
        ...stickers.stats(),
        enabled: cfg.stickers?.enabled !== false,
        maxPerReply: Math.max(1, Math.min(3, Number(cfg.stickers?.maxPerReply) || 1)),
        publicBase: publicBaseSync(),
        items: stickers.list(),
        warning: publicBaseSync() ? '' : '尚未取得公開網址（Cloudflare tunnel 未啟動）',
      },
      vision: {
        ...vision.status(),
        modelSupportsImages: await modelSupportsImages(),
        imageVision: cfg.line?.imageVision !== false,
        stickerVision: cfg.line?.stickerVision !== false,
      },
      voice: {
        ...voiceStatusCached(),
        enabled: cfg.voice?.enabled === true,
        consent: cfg.voice?.consent === true,
        provider: cfg.voice?.provider || 'auto',
        cloneMode: cfg.voice?.cloneMode || 'instruct',
        instructText: cfg.voice?.instructText || '',
        maxChars: Number(cfg.voice?.maxChars) || 80,
        referencePath: cfg.voice?.referencePath || '',
        ready: voiceReady(cfg),
        publicBase: publicBaseSync(),
      },
      memory: {
        ...memory.stats(),
        enabled: cfg.memory?.enabled !== false,
        reviewDaily: cfg.memory?.reviewDaily !== false,
        reviewHour: Number(cfg.memory?.reviewHour) || 0,
        maxPerUser: Number(cfg.memory?.maxPerUser) || 120,
        injectMaxEntries: Number(cfg.memory?.injectMaxEntries) || 20,
        injectMaxChars: Number(cfg.memory?.injectMaxChars) || 2000,
        lastReviewAt: Number(state.memory?.lastReviewAt) || 0,
      },
      jokes: {
        ...jokes.stats(),
        enabled: cfg.jokes?.enabled !== false,
        tieba: cfg.jokes?.tieba !== false,
        wanjiqi: cfg.jokes?.wanjiqi === true,
        perTurn: Number(cfg.jokes?.perTurn) || 3,
        entries: jokes.list().slice(0, 200),
      },
      sync: { ...tiebaSync.stats(), config: cfg.sync },
      access: {
        mode: cfg.line.accessMode || 'approval',
        allowedUserIds: safeArray(cfg.line.allowedUserIds),
        gateOpen: safeArray(cfg.line.allowedUserIds).length > 0,
        pending: pendingUsersList().map((item) => ({ userId: item.userId, displayName: item.displayName || '', at: Number(item.at) || 0, lastText: item.lastText || '' })),
      },
      users,
      groups,
      logs: logger.lines(),
    }
  }

  // ── 動作 ────────────────────────────────────────────────────────────────
  async function runAction(action, payload = {}) {
    const cfg = store.get()
    switch (action) {
      case 'start':
        return startAll()
      case 'stop':
        return stopAll()
      case 'restart':
        await stopAll()
        return startAll()
      case 'server-start':
        return server.start()
      case 'server-stop':
        return server.stop()
      case 'tunnel-start': {
        if (!server.status().running) await server.start()
        const url = await tunnel.start()
        return { url }
      }
      case 'tunnel-stop':
        return tunnel.stop()
      case 'tunnel-restart':
        return { url: await tunnel.restart() }
      case 'tunnel-download':
        return tunnel.download()
      case 'cloudflare-verify': {
        const apiToken = String(payload.apiToken || cfg.cloudflare.apiToken || ENV_CF_TOKEN || '').trim()
        if (!apiToken) throw new Error('請先填入 Cloudflare API Token')
        const info = await cloudflare.verifyAndDescribe(apiToken)
        const accounts = (info.accounts || []).map((item) => ({ id: item.id, name: item.name }))
        const zones = (info.zones || []).map((item) => ({ id: item.id, name: item.name }))
        let accountId = cfg.cloudflare.accountId || (accounts.length === 1 ? accounts[0].id : '')
        const hostname = String(payload.hostname || cfg.cloudflare.hostname || '').trim()
        let zoneId = cfg.cloudflare.zoneId || ''
        if (!zoneId && hostname) {
          const zone = cloudflare.pickZoneForHostname(info.zones, hostname)
          if (zone) zoneId = zone.id
        }
        store.patch({ cloudflare: { apiToken, accountId, zoneId, hostname, verified: true } }, { silent: true })
        return { verify: info.verify, accounts, zones, accountId, zoneId, warnings: info.warnings }
      }
      case 'cloudflare-provision':
        return tunnel.provision(payload)
      case 'webhook-apply': {
        const url = String(payload.url || (await tunnel.status()).url || '').trim()
        return applyWebhook(url, { test: payload.test !== false })
      }
      case 'webhook-test': {
        const endpoint =
          String(payload.endpoint || (await tunnel.status()).url || '').trim()
        if (!endpoint) throw new Error('還沒有公開網址，請先啟動 tunnel')
        const full = endpoint.endsWith('/webhook') ? endpoint : `${endpoint.replace(/\/$/, '')}/webhook`
        const tested = await withToken((token) => lineApi.testWebhookEndpoint(token, full))
        return { endpoint: full, tested }
      }
      case 'line-verify': {
        const bot = await refreshBotInfo()
        let webhook = null
        try {
          webhook = await refreshWebhookInfo()
        } catch {
          webhook = null
        }
        return { bot, webhook }
      }
      case 'token-refresh': {
        const token = await getToken({ force: true })
        await refreshBotInfo().catch(() => {})
        return { tokenTail: maskSecret(token, 2), tokenSource: runtime.tokenSource }
      }
      case 'persona-command': {
        const text = String(payload.text || '人設').trim()
        const userId = String(payload.userId || '')
        const state = store.getState()
        const fallback = Object.values(state.users || {}).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))[0]
        const target = userId || fallback?.userId || 'preview'
        const sessionId = payload.sessionId || (userId ? state.users?.[userId]?.sessionId : fallback?.sessionId) || 'preview'
        const result = await handlePersonaCommand({ userId: target, sessionId, text, dryRun: true })
        return { text, handled: Boolean(result), reply: result?.reply || '', personaId: state.users?.[target]?.personaId || store.get().persona.id }
      }
      case 'persona-mode': {
        await persona().setMode('session')
        personaCache.at = 0
        return getPersonaSummary({ force: true })
      }
      case 'persona-status':
        return getPersonaSummary({ force: true })
      case 'persona-reload':
        return reloadPersonaPlugin(ctx)
      case 'tieba-context':
        return { text: tiebaContextText(), enabled: store.get().agent.tiebaContext !== false }
      case 'tieba-preview':
        return tiebaSync.preview()
      case 'tieba-sync':
        return tiebaSync.run({ force: true })
      case 'tieba-bars-add': {
        const bars = Array.isArray(payload.bars) && payload.bars.length > 0
          ? payload.bars.map((item) => String(item || '').trim()).filter(Boolean)
          : ['弱智吧', '抽象吧', '搞笑吧', '梗吧']
        const result = ensureTiebaBars(bars)
        logger.info(`刷貼吧設定已加入梗類貼吧：${result.added.join('、') || '（都已經在了）'}`)
        return result
      }
      case 'joke-list':
        return { ...jokes.stats(), entries: jokes.list() }
      case 'joke-add':
        return jokes.add({
          text: payload.text,
          usage: payload.usage,
          mood: payload.mood,
          source: 'manual',
        })
      case 'joke-update':
        return jokes.update(String(payload.id || ''), payload)
      case 'joke-delete':
        return jokes.remove(String(payload.id || ''))
      case 'joke-import-tieba': {
        const items = readTiebaStyleSamples({ limit: Math.max(1, Math.min(100, Number(payload.limit) || 40)) })
        const removed = jokes.removeBySource('tieba')
        const added = jokes.importMany('tieba', items)
        return { added, removed, scanned: items.length, source: 'tieba' }
      }
      case 'joke-import-wanjiqi': {
        const response = await fetch('https://raw.githubusercontent.com/Chu-Xin-r/wanjiqi-meme/main/skills/wanjiqi-meme/assets/memes_top100.json')
        if (!response.ok) throw new Error(`下載 wanjiqi 梗庫失敗：HTTP ${response.status}`)
        const raw = await response.json()
        const items = (Array.isArray(raw) ? raw : [])
          .map((item) => String(item?.barrage || '').replace(/\s+/g, ' ').trim())
          .filter((text) => text.length >= 4 && text.length <= 40)
          .map((text) => ({ text, usage: '玩机器 6657 直播間彈幕梗（來源：wanjiqi-meme）' }))
        const removed = jokes.removeBySource('wanjiqi')
        const added = jokes.importMany('wanjiqi', items, { enabled: true })
        return { added, removed, scanned: items.length, source: 'wanjiqi' }
      }
      case 'persona-save': {
        const id = String(payload.id || '').trim()
        if (!id) throw new Error('缺少人設 id')
        const summary = await getPersonaSummary({ force: true })
        if (!(summary.catalog || []).some((item) => item.id === id)) throw new Error(`找不到人設：${id}`)
        store.patch({ persona: { id } })
        personaCache.at = 0
        return getPersonaSummary({ force: true })
      }
      case 'local-persona-list':
        return { personas: localPersonas.catalog(), path: localPersonas.stats().path }
      case 'local-persona-get': {
        const item = localPersonas.get(payload.id)
        if (!item) throw new Error('找不到這個自訂人設')
        return { selectionId: localPersonas.selectionId(item.id), name: item.name, text: item.text }
      }
      case 'local-persona-add': {
        const created = localPersonas.add({ name: payload.name, text: payload.text })
        personaCache.at = 0
        return created
      }
      case 'local-persona-update': {
        const updated = localPersonas.update({ id: payload.id, name: payload.name, text: payload.text })
        personaCache.at = 0
        return updated
      }
      case 'local-persona-remove': {
        const removed = localPersonas.remove(payload.id)
        const cfg2 = store.get()
        if (cfg2.persona.id === removed.id) store.patch({ persona: { id: 'dafeiyu' } })
        store.updateState((state) => {
          const users = { ...(state.users || {}) }
          let changed = false
          for (const [key, user] of Object.entries(users)) {
            if (user?.personaId === removed.id) {
              users[key] = { ...user, personaId: 'dafeiyu' }
              changed = true
            }
          }
          return changed ? { ...state, users } : state
        })
        personaCache.at = 0
        return removed
      }
      case 'local-persona-import': {
        const id = String(payload.id || '').trim()
        if (!id) throw new Error('缺少大肥魚人設 id')
        if (id.startsWith(LOCAL_PREFIX)) throw new Error('這已經是插件內建人設了')
        const text = await persona().personaText(id)
        if (!text?.text) throw new Error('讀不到這個人設的內容')
        const created = localPersonas.add({ name: payload.name || `${text.name}（副本）`, text: text.text })
        personaCache.at = 0
        return created
      }
      case 'model-catalog':
        return modelCatalog({ force: payload.force === true })
      case 'balance-refresh':
        if (!balanceApplicable()) return { skipped: 'provider-not-deepseek', provider: modelSelection().provider }
        return refreshBalance()
      case 'balance-ask':
        return maybeAskForTopUp({ dryRun: payload.dryRun !== false, force: payload.force === true })
      case 'meme-stats':
        return { ...memes.stats(), enabled: store.get().stickers?.enabled !== false, maxPerReply: memeMaxPerReply(), sample: memes.sample({ limit: 20 }) }
      case 'vision-model-look': {
        const url = String(payload.url || '').trim()
        if (!url) throw new Error('缺少 url')
        const response = await fetch(url, { signal: AbortSignal.timeout(20_000) })
        if (!response.ok) throw new Error(`下載圖片失敗：HTTP ${response.status}`)
        const buffer = Buffer.from(await response.arrayBuffer())
        const mediaType = imageMediaType(buffer)
        const ref = await stickerImages.saveBuffer(buffer, `vision-model-${Date.now()}.${mediaType.split('/')[1]}`, mediaType)
        return { text: await describeWithVisionModel(ref), attachmentId: String(ref.attachmentId || '') }
      }
      case 'image-look': {
        const url = String(payload.url || '').trim()
        if (!url) throw new Error('缺少 url')
        const response = await fetch(url, { signal: AbortSignal.timeout(20_000) })
        if (!response.ok) throw new Error(`下載圖片失敗：HTTP ${response.status}`)
        const buffer = Buffer.from(await response.arrayBuffer())
        if (buffer.length > 10 * 1024 * 1024) throw new Error('圖片超過 10MB')
        const mediaType = imageMediaType(buffer)
        const ref = await stickerImages.saveBuffer(buffer, `test-image-${Date.now()}.${mediaType.split('/')[1]}`, mediaType)
        const result = await runner.turn({
          sessionId: `session-image-look-${Date.now()}`,
          text: '請用一句繁體中文描述這張圖片的內容與情緒。',
          images: [ref],
          contextText: '',
          cwd: store.get().agent.cwd || undefined,
        })
        return { text: result.text, attachmentId: String(ref.attachmentId || ''), mediaType }
      }
      case 'vision-describe': {
        const url = String(payload.url || '').trim()
        const stickerId = String(payload.stickerId || '').trim()
        const file = String(payload.file || '').trim()
        if (!url && !stickerId && !file) throw new Error('需要 url、stickerId 或 file')
        let target = url || file
        if (stickerId) {
          const { data } = await stickerImages.fetchBytes(stickerId, payload.stickerResourceType || 'STATIC')
          target = writeIncomingImage(Buffer.from(data), `vision-${stickerId}-${Date.now()}.png`)
        }
        const described = await vision.describe(target, { prompt: String(payload.prompt || '').trim() })
        return { text: described.text, vision: vision.status() }
      }
      case 'sticker-look': {
        const stickerId = String(payload.stickerId || '').trim()
        if (!stickerId) throw new Error('缺少 stickerId')
        const ref = await stickerImages.toAttachment(stickerId, payload.stickerResourceType || 'STATIC')
        const result = await runner.turn({
          sessionId: `session-sticker-look-${Date.now()}`,
          text: '這是一張 LINE 貼圖。請用一句繁體中文說出圖片裡的圖案內容與情緒。',
          images: [ref],
          contextText: '',
          cwd: store.get().agent.cwd || undefined,
        })
        return { text: result.text, attachmentId: String(ref.attachmentId || ''), mediaType: ref.mediaType }
      }
      case 'meme-preview': {
        if (!payload.text) throw new Error('缺少 text')
        const built = await buildOutgoingMessages(String(payload.text))
        return { messages: built.messages, parsed: built.parsed }
      }
      case 'voice-detect':
        return tts.detect()
      case 'voice-install': {
        if (tts.status().installing) return { started: false, already: true }
        tts.install()
          .then((result) => {
            if (result?.provider) store.patch({ voice: { provider: result.provider } }, { silent: true })
            logger.info(`語音環境安裝完成（${result?.provider || 'unknown'}）`)
            voiceCache = { at: 0, value: null }
          })
          .catch((error) => logger.error(`語音環境安裝失敗：${errorText(error)}`))
        return { started: true }
      }
      case 'voice-preview':
      case 'voice-test': {
        const text = String(payload.text || '主人，這是語音測試，聽得到嗎？').trim()
        if (!text) throw new Error('缺少文字')
        const result = await tts.synthesize(text)
        const token = registerFile(result.m4a, 'audio/mp4')
        const base = publicBaseSync()
        voiceCache = { at: 0, value: null }
        return {
          provider: result.provider,
          durationMs: result.durationMs,
          bytes: result.bytes,
          chars: result.chars,
          processingMs: result.processingMs,
          url: base ? `${base}/media/${token}` : '',
          localUrl: `/api/line-bot/media/${token}`,
          token,
        }
      }
      case 'voice-save-reference': {
        const dataUrl = String(payload.dataUrl || '')
        const match = /^data:([^;]+);base64,([\s\S]+)$/.exec(dataUrl)
        if (!match) throw new Error('缺少音檔資料')
        const buffer = Buffer.from(match[2], 'base64')
        if (buffer.length > 20 * 1024 * 1024) throw new Error('音檔超過 20MB')
        const saved = await tts.saveReferenceBuffer(buffer, String(payload.filename || 'reference'), String(payload.ext || '.wav'))
        store.patch({ voice: { referencePath: saved.path } }, { silent: true })
        voiceCache = { at: 0, value: null }
        return { path: saved.path, seconds: saved.seconds }
      }
      case 'voice-reset-reference':
        store.patch({ voice: { referencePath: '' } }, { silent: true })
        voiceCache = { at: 0, value: null }
        return { path: tts.referencePath() }
      case 'meme-send': {
        const userId = String(payload.userId || '').trim()
        if (!userId) throw new Error('缺少 userId')
        if (!payload.text) throw new Error('缺少 text')
        await sendPush(userId, String(payload.text))
        return { sent: true, userId, text: String(payload.text) }
      }
      case 'sticker-list':
        return { ...stickers.stats(), items: stickers.list(), publicBase: publicBaseSync() }
      case 'sticker-add': {
        const entry = stickers.add({ name: payload.name, description: payload.description, dataUrl: payload.dataUrl || payload.data })
        return { sticker: entry, count: stickers.list().length }
      }
      case 'sticker-delete': {
        if (!payload.id) throw new Error('缺少表情包 id')
        return stickers.remove(String(payload.id))
      }
      case 'memory-list': {
        const only = String(payload.userId || '').trim()
        const state = store.getState()
        const mapEntry = (kind) => ([id, item]) => {
          let displayName = item?.displayName || ''
          let rowKind = kind
          if (id.includes(':')) {
            const parts = id.split(':')
            const groupId = parts.shift()
            const memberId = parts.join(':')
            const group = state.groups?.[groupId]
            const memberName = memberId.startsWith('name:') ? memberId.slice(5) : personName(memberId) || memberId
            displayName = `${group?.displayName || groupId}／${memberName}`
            rowKind = 'group-member'
          }
          return {
          userId: id,
          id,
          kind: rowKind,
          displayName,
          entries: memory.list(id).map((entry) => ({
            ...entry,
            createdText: new Date(entry.createdAt).toISOString(),
            expiresText: entry.expiresAt ? new Date(entry.expiresAt).toISOString() : '',
          })),
          }
        }
        const rows = memory.keys()
          .filter((id) => !only || id === only || id.startsWith(`${only}:`))
          .map((id) => {
            if (id.includes(':')) return mapEntry('group-member')([id, null])
            if (state.users?.[id]) return mapEntry('user')([id, state.users[id]])
            if (state.groups?.[id]) return mapEntry('group')([id, state.groups[id]])
            return mapEntry('unknown')([id, null])
          })
          .filter((row) => row.entries.length > 0)
        return { users: rows, total: rows.reduce((sum, row) => sum + row.entries.length, 0) }
      }
      case 'memory-add': {
        const userId = String(payload.userId || '').trim()
        if (!userId) throw new Error('缺少 userId')
        return memory.add(userId, payload)
      }
      case 'memory-delete': {
        const userId = String(payload.userId || '').trim()
        if (!userId) throw new Error('缺少 userId')
        return memory.forget(userId, { ids: payload.id ? [payload.id] : payload.ids })
      }
      case 'memory-prune':
        return pruneMemories()
      case 'memory-review':
        return reviewMemories({ userId: String(payload.userId || '').trim() })
      case 'nudge-test':
        return nudge.tick({ force: true })
      case 'agent-test': {
        const text = String(payload.text || '（連線測試）請用一句話跟我打招呼，順便說你是誰。')
        const sessionId = String(payload.sessionId || `session-line-selftest-${Date.now()}`)
        const cwd = String(payload.cwd || '').trim() || undefined
        const selection = String(payload.personaId || '').trim() || (cfg.persona.enforce ? cfg.persona.id : '')
        const testUserId = String(payload.userId || '').trim()
          || Object.entries(store.getState().users || {}).find(([, item]) => item.sessionId === sessionId)?.[0]
          || ''
        const applied = await applyPersonaSelection(selection, sessionId)
        const result = await runner.turn({
          sessionId,
          text,
          persona: applied.persona,
          personaText: applied.personaText,
          overlayText: personaOverlayText(applied),
          personaClient: persona(),
          contextText: agentContextText(testUserId),
          tools: memoryToolsFor(testUserId),
          cwd,
        })
        return { text: result.text, reason: result.reason, sessionId, cwd: cwd || '', persona: selection, personaSource: applied.source }
      }
      case 'client-graph': {
        const cm = ctx.get?.('clientModules')
        if (!cm || typeof cm.graph !== 'function') throw new Error('clientModules 服務不可用')
        const graph = cm.graph()
        const entries = (graph?.entries || []).map((entry) => ({
          id: entry.id,
          rev: entry.rev,
          clientPath: typeof cm.clientPath === 'function' ? cm.clientPath(entry.id) : undefined,
          inject: entry.inject,
        }))
        return {
          hasCfEnvToken: Boolean(ENV_CF_TOKEN),
          rev: graph?.rev,
          count: entries.length,
          lineBot: entries.find((entry) => entry.id === 'dsh-line-bot') || null,
          ids: entries.map((entry) => entry.id),
        }
      }
      case 'user-workspace': {
        const userId = String(payload.userId || '')
        if (!userId) throw new Error('缺少 userId')
        const user = ensureUser(userId)
        return { userId, sessionId: user.sessionId, personaId: user.personaId || store.get().persona.id, workspaceDir: user.workspaceDir || '', perUserWorkspace: Boolean(store.get().agent.perUserWorkspace) }
      }
      case 'access-list':
        return { mode: store.get().line.accessMode || 'approval', allowedUserIds: safeArray(store.get().line.allowedUserIds), pending: pendingUsersList() }
      case 'access-mode': {
        const mode = String(payload.mode || '').trim()
        if (!['approval', 'whitelist'].includes(mode)) throw new Error('mode 只能是 approval 或 whitelist')
        store.patch({ line: { accessMode: mode } })
        return { mode }
      }
      case 'access-approve':
        return approveUser(payload.userId)
      case 'access-deny':
        return denyUser(payload.userId)
      case 'access-add': {
        const id = String(payload.userId || '').trim()
        if (!id) throw new Error('缺少 userId')
        const list = safeArray(store.get().line.allowedUserIds)
        if (!list.includes(id)) store.patch({ line: { allowedUserIds: [...list, id] } })
        removePendingUser(id)
        return { userId: id, allowedUserIds: store.get().line.allowedUserIds }
      }
      case 'access-remove': {
        const id = String(payload.userId || '').trim()
        const list = safeArray(store.get().line.allowedUserIds).filter((item) => item !== id)
        store.patch({ line: { allowedUserIds: list } })
        return { userId: id, allowedUserIds: list }
      }
      case 'user-persona': {
        const userId = String(payload.userId || '')
        if (!userId) throw new Error('缺少 userId')
        const personaId = String(payload.personaId || '').trim()
        if (!personaId) throw new Error('缺少 personaId')
        const summary = await getPersonaSummary({ force: true })
        const picked = (summary.catalog || []).find((item) => item.id === personaId)
        if (!picked) throw new Error(`找不到人設：${personaId}`)
        store.updateState((state) => ({
          ...state,
          users: { ...state.users, [userId]: { ...(state.users[userId] || {}), personaId } },
        }))
        const sessionId = store.getState().users?.[userId]?.sessionId
        if (sessionId) {
          if (picked.source === 'local') {
            await persona().disableSessionPersona(sessionId).catch((error) => logger.warn(`停用大肥魚人設失敗：${errorText(error)}`))
          } else {
            await persona().setSessionPersona(sessionId, personaId).catch((error) => logger.warn(`套用人設失敗：${errorText(error)}`))
          }
        }
        return { userId, personaId, personaName: picked.name || '', personaSource: picked.source || 'dafeiyu' }
      }
      case 'diagnose':
        return runDiagnostics({ repair: payload.repair === true })

      case 'group-import': {
        const groupId = String(payload.groupId || '').trim()
        const text = String(payload.text || '')
        if (!groupId) throw new Error('需要 groupId')
        if (!text) throw new Error('需要聊天記錄內容')
        return importGroupChat({ groupId, text, dryRun: payload.dryRun === true })
      }

      case 'group-persona': {
        const groupId = String(payload.groupId || '').trim()
        if (!groupId) throw new Error('缺少 groupId')
        const personaId = String(payload.personaId || '').trim()
        if (!personaId) throw new Error('缺少 personaId')
        const summary = await getPersonaSummary({ force: true })
        const picked = (summary.catalog || []).find((item) => item.id === personaId)
        if (!picked) throw new Error(`找不到人設：${personaId}`)
        store.updateState((state) => ({
          ...state,
          groups: { ...state.groups, [groupId]: { ...(state.groups[groupId] || {}), personaId } },
        }))
        const sessionId = store.getState().groups?.[groupId]?.sessionId
        if (sessionId) {
          if (picked.source === 'local') {
            await persona().disableSessionPersona(sessionId).catch((error) => logger.warn(`停用大肥魚人設失敗：${errorText(error)}`))
          } else {
            await persona().setSessionPersona(sessionId, personaId).catch((error) => logger.warn(`套用人設失敗：${errorText(error)}`))
          }
        }
        return { groupId, personaId, personaName: picked.name || '', personaSource: picked.source || 'dafeiyu' }
      }
      case 'group-reset': {
        const groupId = String(payload.groupId || '').trim()
        if (!groupId) throw new Error('缺少 groupId')
        if (payload.wipeWorkspace && store.get().agent.perUserWorkspace) {
          const target = userWorkspaceDir(groupId)
          try {
            fs.rmSync(target, { recursive: true, force: true })
            logger.info(`已清空群組工作資料夾：${target}`)
          } catch (error) {
            logger.warn(`清空工作資料夾失敗：${errorText(error)}`)
          }
        }
        const cleared = memory.forgetPrefix(`${groupId}:`)
        store.updateState((state) => {
          const next = { ...state, groups: { ...state.groups } }
          delete next.groups[groupId]
          return next
        })
        return { groupId, reset: true, memory: cleared }
      }
      case 'user-reset': {
        const userId = String(payload.userId || '')
        if (!userId) throw new Error('缺少 userId')
        if (payload.wipeWorkspace && store.get().agent.perUserWorkspace) {
          const target = userWorkspaceDir(userId)
          try {
            fs.rmSync(target, { recursive: true, force: true })
            logger.info(`已清空使用者工作資料夾：${target}`)
          } catch (error) {
            logger.warn(`清空工作資料夾失敗：${errorText(error)}`)
          }
        }
        store.updateState((state) => {
          const next = { ...state, users: { ...state.users } }
          delete next.users[userId]
          return next
        })
        return { userId, reset: true }
      }
      case 'logs-clear':
        logger.clear()
        return { cleared: true }
      case 'setup': {
        if (payload.patch) store.patch(payload.patch)
        if (!store.get().line.channelSecret && !store.get().line.accessToken) {
          throw new Error('請先填入 LINE Channel Secret（或直接貼上 Channel Access Token）')
        }
        const steps = []
        await server.start()
        steps.push({ step: 'webhook 伺服器', ok: true, detail: `127.0.0.1:${server.status().port}` })
        const url = await tunnel.start()
        steps.push({ step: 'Cloudflare tunnel', ok: true, detail: url })
        const applied = await applyWebhook(url)
        steps.push({ step: '設定 LINE webhook', ok: true, detail: `${applied.endpoint}（測試：${applied.tested?.success ? '通過' : applied.testError || '未通過'}）` })
        const bot = await refreshBotInfo().catch((error) => ({ error: errorText(error) }))
        steps.push({ step: 'LINE 身分驗證', ok: !bot.error, detail: bot.displayName ? `${bot.displayName} (${bot.basicId || ''})` : bot.error || 'ok' })
        nudge.start()
        return { steps, url }
      }
      default:
        throw new Error(`未知動作：${action}`)
    }
  }

  // ── HTTP 路由 ───────────────────────────────────────────────────────────
  async function handleHttp(req, res, url) {
    const sub = url.pathname.replace(/^\/api\/line-bot/, '') || '/'
    try {
      if (req.method === 'GET' && (sub === '/' || sub === '/status')) {
        jsonOk(res, await buildStatus())
        return
      }
      if (req.method === 'GET' && sub === '/doctor') {
        jsonOk(res, await runDiagnostics({ repair: url.searchParams.get('repair') === '1' }))
        return
      }
      if (req.method === 'GET' && sub.startsWith('/media/')) {
        const media = getMedia(decodeURIComponent(sub.slice('/media/'.length)))
        if (!media || !media.bytes) {
          jsonFail(res, 'not found', 404)
          return
        }
        res.writeHead(200, {
          'content-type': media.mime || 'application/octet-stream',
          'content-length': media.bytes.length,
          'cache-control': 'public, max-age=31536000, immutable',
        })
        res.end(media.bytes)
        return
      }
      if (req.method === 'GET' && sub === '/health') {
        jsonOk(res, { ok: true, version: VERSION, server: server.status(), tunnel: (await tunnel.status()).phase })
        return
      }
      if (req.method === 'POST' && sub === '/config') {
        const body = await readJsonBody(req)
        const beforePort = store.get().server.port
        store.patch(body.patch || body)
        const afterPort = store.get().server.port
        if (beforePort !== afterPort && server.status().running) {
          await server.stop()
          await server.start()
        }
        personaCache.at = 0
        jsonOk(res, await buildStatus())
        return
      }
      if (req.method === 'POST' && sub === '/action') {
        const body = await readJsonBody(req)
        const result = await runAction(String(body.action || ''), body.payload || {})
        jsonOk(res, { action: body.action, result, status: await buildStatus() })
        return
      }
      jsonFail(res, 'not found', 404)
    } catch (error) {
      logger.error(`API ${sub} 失敗：${errorText(error)}`)
      jsonFail(res, errorText(error) || '未知錯誤', 500)
    }
  }

  // 自動啟動：server 一啟動就開始收 webhook；tunnel 依設定。
  const cfg0 = store.get()
  if (cfg0.enabled !== false && cfg0.server.autoStart) {
    setTimeout(() => {
      startAll().catch((error) => logger.error(`自動啟動失敗：${errorText(error)}`))
    }, 300)
  } else {
    logger.info('自動啟動已關閉：請在面板按「啟動」')
  }
  if (cfg0.line.channelId && cfg0.line.channelSecret) {
    setTimeout(() => refreshBotInfo().catch(() => {}), 1500)
  }

  return {
    version: VERSION,
    handleHttp,
    status: buildStatus,
    async dispose() {
      stopWebhookGuard()
      stopBalanceWatch()
      try {
        nudge.stop()
      } catch {
        /* ignore */
      }
      await tunnel.stop({ silent: true }).catch(() => {})
      await server.stop().catch(() => {})
      logger.info('LINE Bot 已停止')
    },
  }
}
