// dsh-line-bot 的 host 端：設定/狀態、LINE 憑證、webhook 伺服器、Cloudflare 隧道、
// 大肥魚人設、agent 回覆與主動傳訊，全部集中在這裡，index.js 只負責載入與路由掛載。
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
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
const tiebaContextMod = await import(withVersion('./tieba-context.mjs'))
const balanceMod = await import(withVersion('./deepseek-balance.mjs'))
const memoryMod = await import(withVersion('./memory.mjs'))
const utilMod = await import(withVersion('./util.mjs'))
const { createConfigStore, publicConfig, dataDir } = configMod
const { createPersonaClient } = personaMod
const { createAgentRunner } = runnerMod
const { createWebhookServer } = webhookMod
const { createTunnelManager } = tunnelMod
const { createNudgeScheduler } = nudgeMod
const { createTiebaSync, reloadPersonaPlugin } = tiebaSyncMod
const { createLocalPersonas, LOCAL_PREFIX } = localPersonasMod
const { buildTiebaContext } = tiebaContextMod
const { createBalanceMonitor } = balanceMod
const { createMemoryStore } = memoryMod
const { chunkText, clip, inQuietWindow, jsonFail, jsonOk, maskSecret, readJsonBody } = utilMod

export const VERSION = '0.4.0'

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
  const startedAt = Date.now()

  const runtime = {
    botInfo: null,
    botInfoAt: 0,
    lastLineError: '',
    lastEventAt: 0,
    lastReply: null,
    lastTokenIssueAt: 0,
    tokenSource: '',
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

  // 回傳 runner 需要的 persona（大肥魚 id）與 personaText（自訂人設全文）。
  // 選自訂人設時，先請大肥魚在這個 session 讓開，避免兩套人設疊在一起。
  async function applyPersonaSelection(selection, sessionId) {
    const resolved = resolvePersonaSelection(selection)
    if (resolved.kind === 'local') {
      try {
        await persona().disableSessionPersona(sessionId)
      } catch (error) {
        logger.warn(`請大肥魚讓開失敗（自訂人設仍會注入）：${errorText(error)}`)
      }
      return { persona: null, personaText: resolved.text, source: 'local', name: resolved.name }
    }
    if (resolved.kind === 'dafeiyu') {
      return { persona: resolved.id, personaText: null, source: 'dafeiyu', name: '' }
    }
    return { persona: null, personaText: null, source: '', name: '' }
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
          entry.models = (models || []).map((item) => ({ id: item.id, name: item.name || item.id }))
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

  function agentContextText(userId) {
    return [tiebaContextText(), balanceContextText(), memoryContextText(userId)].filter(Boolean).join('\n\n')
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
    const candidates = Object.entries(state.users || {}).filter(([, user]) => user?.sessionId)
    const preferred = (cfg.nudge.targetUserIds || []).find((id) => candidates.some(([key]) => key === id))
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
    const check = () => {
      if (!balanceApplicable()) return
      refreshBalance()
        .then(() => maybeAskForTopUp({ dryRun: false }))
        .catch((error) => logger.warn('餘額檢查失敗：' + errorText(error)))
    }
    const initial = setTimeout(check, 8_000)
    initial.unref?.()
    balanceTimer = setInterval(check, 30 * 60_000)
    balanceTimer.unref?.()
  }

  function stopBalanceWatch() {
    if (balanceTimer) {
      clearInterval(balanceTimer)
      balanceTimer = null
    }
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
      : Object.entries(state.users || {})
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

  function isAllowed(userId, cfg) {
    const list = cfg.line.allowedUserIds || []
    return list.length === 0 || list.includes(userId)
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

  async function handlePersonaCommand({ userId, sessionId, text, replyToken, dryRun = false }) {
    const match = text.match(PERSONA_CMD)
    if (!match) return null
    const cfg = store.get()
    if (cfg.persona.allowUserSwitch === false) {
      return { reply: '這個 bot 目前不開放自行切換人設；想換請跟管理者說。' }
    }
    const state = store.getState()
    const user = dryRun ? state.users?.[userId] || { personaId: cfg.persona.id } : ensureUser(userId)
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
      store.updateState((next) => ({
        ...next,
        users: { ...next.users, [userId]: { ...(next.users[userId] || {}), personaId: picked.id } },
      }))
      if (picked.source === 'local') {
        await persona().disableSessionPersona(sessionId).catch((error) => logger.warn(`停用大肥魚人設失敗：${errorText(error)}`))
      } else {
        await persona().setSessionPersona(sessionId, picked.id).catch((error) => logger.warn(`套用人設失敗：${errorText(error)}`))
      }
    }
    const prefix = reset ? '好，換回預設的' : '好，之後就用'
    return { reply: `${prefix}「${picked.name}」回你。` }
  }

  async function replyOrPush(userId, replyToken, texts) {
    const chunks = chunkText(texts)
    if (chunks.length === 0) return
    try {
      await withToken((token) => lineApi.replyMessage(token, replyToken, chunks))
    } catch (error) {
      logger.warn(`reply 失敗，改用 push：${errorText(error)}`)
      await withToken((token) => lineApi.pushMessage(token, userId, chunks))
    }
  }

  async function handleEvent(event) {
    runtime.lastEventAt = Date.now()
    store.updateState((state) => ({ ...state, lastEventAt: runtime.lastEventAt }))
    const cfg = store.get()
    if (cfg.enabled === false) return
    const type = event?.type
    const userId = event?.source?.userId
    if (type === 'follow' && userId) {
      if (!isAllowed(userId, cfg)) return
      const welcome = cfg.line.welcomeText || ''
      if (welcome && event.replyToken) {
        await replyOrPush(userId, event.replyToken, welcome).catch((error) => logger.warn(`歡迎訊息失敗：${errorText(error)}`))
      }
      return
    }
    if (type !== 'message') return
    if (!userId) return
    if (!isAllowed(userId, cfg)) {
      logger.warn(`略過未授權的使用者 ${userId}（allowedUserIds）`)
      return
    }
    if (event.message?.type !== 'text') {
      logger.info(`略過非文字訊息（${event.message?.type}）`)
      return
    }
    const text = String(event.message.text || '').trim()
    if (!text) return

    const user = ensureUser(userId)
    store.updateState((state) => {
      const target = state.users[userId]
      if (!target) return state
      return {
        ...state,
        totalMessages: (Number(state.totalMessages) || 0) + 1,
        users: {
          ...state.users,
          [userId]: { ...target, messages: (Number(target.messages) || 0) + 1, lastAt: Date.now(), lastUserAt: Date.now() },
        },
      }
    })

    const personaResult = await handlePersonaCommand({ userId, sessionId: user.sessionId, text, replyToken: event.replyToken })
    if (personaResult) {
      await replyOrPush(userId, event.replyToken, personaResult.reply)
      return
    }

    try {
      if (cfg.line.loadingEnabled && event.replyToken) {
        await withToken((token) => lineApi.startLoading(token, userId)).catch(() => {})
      }
      const freshUser = store.getState().users?.[userId] || user
      const selection = cfg.persona.enforce ? freshUser.personaId || cfg.persona.id : ''
      const applied = await applyPersonaSelection(selection, user.sessionId)
      const result = await runner.turn({
        sessionId: user.sessionId,
        text,
        persona: applied.persona,
        personaText: applied.personaText,
        personaClient: persona(),
        contextText: agentContextText(userId),
        tools: memoryToolsFor(userId),
        cwd: ensureUserWorkspace(userId) || cfg.agent.cwd || undefined,
      })
      let replyText = String(result?.text || '').trim()
      if (!replyText) replyText = cfg.line.emptyReply || '（她沒有說話）'
      await replyOrPush(userId, event.replyToken, replyText)
      runtime.lastReply = { userId, at: Date.now(), text: clip(replyText, 300) }
      store.updateState((state) => ({
        ...state,
        lastReply: runtime.lastReply,
        users: {
          ...state.users,
          [userId]: { ...state.users[userId], lastAt: Date.now(), lastReplyAt: Date.now() },
        },
      }))
    } catch (error) {
      runtime.lastLineError = errorText(error)
      logger.error(`回覆 ${userId} 失敗：${errorText(error)}`)
      const fallback = cfg.line.errorReply || '（剛剛卡住了，再說一次好嗎？）'
      await replyOrPush(userId, event.replyToken, fallback).catch((err) => logger.error(`錯誤訊息也送不出去：${errorText(err)}`))
    }
    void fetchProfile(userId)
  }

  // ── 元件 ────────────────────────────────────────────────────────────────
  const runner = createAgentRunner({ ctx, logger, getConfig: () => store.get() })

  const server = createWebhookServer({ getConfig: () => store.get(), logger, dispatch: handleEvent })

  const tunnel = createTunnelManager({
    getConfig: () => withEnvCloudflare(store.get()),
    patchConfig: (patch) => store.patch(patch, { silent: true }),
    logger,
    dataDir: dir,
    onUrl: async (url) => {
      logger.info(`Cloudflare 公網位址：${url}`)
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
    const chunks = chunkText(text)
    await withToken((token) => lineApi.pushMessage(token, userId, chunks))
    store.updateState((state) => ({
      ...state,
      users: {
        ...state.users,
        [userId]: { ...(state.users[userId] || {}), lastAt: Date.now(), lastPushAt: Date.now() },
      },
    }))
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
        personaClient: persona(),
        contextText: agentContextText(owner?.[0]),
        tools: memoryToolsFor(owner?.[0]),
        cwd: owner ? ensureUserWorkspace(owner[0]) : undefined,
      })
    },
    sendProactive: sendPush,
  })

  const tiebaSync = createTiebaSync({ ctx, store, logger })

  // ── 人設摘要（給面板） ───────────────────────────────────────────────────
  let personaCache = { at: 0, value: null }
  async function getPersonaSummary({ force = false } = {}) {
    const cfg = store.get()
    if (!force && personaCache.value && Date.now() - personaCache.at < 5000) return personaCache.value
    const client = persona()
    const local = localPersonas.catalog()
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
      summary.catalog = [
        ...summary.list.filter((item) => item.enabled !== false),
        ...local,
      ]
    } catch (error) {
      summary.error = errorText(error)
      summary.catalog = [...local]
    }
    const selected = summary.catalog.find((item) => item.id === cfg.persona.id)
    summary.selectedName = selected?.name || ''
    if (!selected) {
      summary.warning = selectedSource === 'local'
        ? `找不到自訂人設「${cfg.persona.id}」，LINE 會改用預設人設。`
        : `找不到人設「${cfg.persona.id}」，LINE 會退回大肥魚的全域人設。`
    } else if (selectedSource === 'dafeiyu' && cfg.persona.enforce && summary.mode !== 'session') {
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
          lastAt: Number(user.lastAt) || 0,
          lastUserAt: Number(user.lastUserAt) || 0,
          lastReplyAt: Number(user.lastReplyAt) || 0,
          personaId,
          personaName: personaNames.get(personaId) || '',
          workspaceDir: user.workspaceDir || (cfg.agent.perUserWorkspace ? userWorkspaceDir(userId, cfg) : ''),
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
        lastAskText: state.balance?.lastAskText || '',
        low: Boolean(balanceView() && Number(cfg.balance.threshold) > 0 && balanceView().value.total < Number(cfg.balance.threshold)),
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
      sync: { ...tiebaSync.stats(), config: cfg.sync },
      users,
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
      case 'memory-list': {
        const only = String(payload.userId || '').trim()
        const state = store.getState()
        const rows = Object.entries(state.users || {})
          .filter(([userId]) => !only || userId === only)
          .map(([userId, user]) => ({
            userId,
            displayName: user?.displayName || '',
            entries: memory.list(userId).map((entry) => ({
              ...entry,
              createdText: new Date(entry.createdAt).toISOString(),
              expiresText: entry.expiresAt ? new Date(entry.expiresAt).toISOString() : '',
            })),
          }))
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
