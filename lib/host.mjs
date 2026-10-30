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
const utilMod = await import(withVersion('./util.mjs'))
const { createConfigStore, publicConfig, dataDir } = configMod
const { createPersonaClient } = personaMod
const { createAgentRunner } = runnerMod
const { createWebhookServer } = webhookMod
const { createTunnelManager } = tunnelMod
const { createNudgeScheduler } = nudgeMod
const { createTiebaSync, reloadPersonaPlugin } = tiebaSyncMod
const { createLocalPersonas, LOCAL_PREFIX } = localPersonasMod
const { chunkText, clip, jsonFail, jsonOk, maskSecret, readJsonBody } = utilMod

export const VERSION = '0.1.0'

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
    nudge.start()
    tiebaSync.start()
    store.updateState((state) => ({ ...state, lastStartAt: Date.now() }))
    if (cfg.line.channelId && cfg.line.channelSecret) refreshBotInfo().catch(() => {})
    return buildStatus()
  }

  async function stopAll() {
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
        timeoutMs: cfg.agent.timeoutMs,
        lastFinishedAt: runner.stats().lastFinishedAt,
      },
      nudge: { ...nudge.stats(), config: cfg.nudge },
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
      case 'nudge-test':
        return nudge.tick({ force: true })
      case 'agent-test': {
        const text = String(payload.text || '（連線測試）請用一句話跟我打招呼，順便說你是誰。')
        const sessionId = String(payload.sessionId || `session-line-selftest-${Date.now()}`)
        const cwd = String(payload.cwd || '').trim() || undefined
        const selection = String(payload.personaId || '').trim() || (cfg.persona.enforce ? cfg.persona.id : '')
        const applied = await applyPersonaSelection(selection, sessionId)
        const result = await runner.turn({
          sessionId,
          text,
          persona: applied.persona,
          personaText: applied.personaText,
          personaClient: persona(),
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
