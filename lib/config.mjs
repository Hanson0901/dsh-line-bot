// 設定與狀態的持久化。所有使用者設定都在 <DSH_HOME>/line-bot/config.json（600），
// 執行期狀態（每個 LINE 使用者的 session、主動傳訊記帳）在 state.json。
import os from 'node:os'
import path from 'node:path'
import {
  isMaskedValue,
  readJsonSafe,
  safeArray,
  writeJsonAtomic,
} from './util.mjs'

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function dataDir() {
  return path.join(dshHome(), 'line-bot')
}

export const DEFAULT_CONFIG = {
  line: {
    channelId: '',
    channelSecret: '',
    accessToken: '',
    tokenExpiresAt: 0,
    useAutoToken: true,
    loadingEnabled: true,
    stickerVision: true,
    allowedUserIds: [],
    welcomeText: '（已加好友）嗨，我是大肥魚～想聊什麼都可以跟我說。',
    errorReply: '（剛剛卡住了，再說一次好嗎？）',
    emptyReply: '（她沒有說話）',
  },
  server: {
    host: '127.0.0.1',
    port: 8791,
    autoStart: true,
  },
  tunnel: {
    mode: 'quick', // quick | api
    binaryPath: '',
    autoStart: true,
    autoRestart: true,
    publicUrl: '',
    autoConfigureWebhook: true,
    hostname: '',
  },
  cloudflare: {
    apiToken: '',
    accountId: '',
    zoneId: '',
    hostname: '',
    tunnelName: 'dsh-line-bot',
    tunnelId: '',
    verified: false,
  },
  group: {
    enabled: true,
    replyChance: 0.15,
    replyToMentions: true,
    replyToQuotes: true,
  },
  persona: {
    id: 'dafeiyu',
    enforce: true,
    acceptGlobalMode: false,
    // 允許 LINE 使用者自己用「人設 …」指令換人設（只影響他自己）。
    allowUserSwitch: true,
  },
  agent: {
    provider: '',
    model: '',
    reasoningEffort: '',
    cwd: '',
    timeoutMs: 180000,
    // 每位 LINE 使用者一個獨立工作資料夾：session／檔案／AGENTS.md 不互通。
    perUserWorkspace: true,
    workspaceRoot: '',
    // 每輪把「剛剛有沒有刷貼吧」等貼吧動態注入 system prompt。
    tiebaContext: true,
  },
  sync: {
    // 每天把刷貼吧學到的語氣寫回指定的人設本文（預設關閉，請在面板選一個「自訂人設」）。
    enabled: false,
    targetPersonaId: '',
    intervalMinutes: 60,
    syncTraits: true,
    reloadPersona: true,
  },
  nudge: {
    enabled: false,
    chance: 0.18,
    intervalMinutes: 60,
    dailyCap: 2,
    monthlyCap: 60,
    minGapMinutes: 180,
    quietStart: '00:30',
    quietEnd: '09:30',
    idleMinutes: 90,
    targetUserIds: [],
    prompt: '',
  },
  balance: {
    // 讓角色知道 DeepSeek API 餘額；低於門檻時由角色自己想句話提醒主人儲值。
    enabled: true,
    threshold: 10,
    ask: true,
    cooldownHours: 12,
    targetUserIds: [],
  },
  memory: {
    // 每位使用者各自的個人記憶：agent 覺得重要就自己記，有期限的到期自動刪。
    enabled: true,
    maxPerUser: 120,
    injectMaxEntries: 20,
    injectMaxChars: 2000,
    // 背景每天檢查一次，請角色自己把過期／失效的記憶刪掉。
    reviewDaily: true,
    reviewHour: 4,
  },
  stickers: {
    // 角色可以用圖片／表情包回話；圖片由面板上傳，存在 <dataDir>/stickers。
    enabled: true,
    maxPerReply: 1,
    // LINE 的圖片訊息不會播放 APNG 動畫，預設只送第一幀（靜態 PNG）；要保留 APNG 檔可打開。
    apng: false,
  },
  log: {
    maxLines: 400,
  },
}

const SENSITIVE = new Set(['channelSecret', 'accessToken', 'apiToken'])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function mergeConfig(base, patch) {
  if (!isPlainObject(patch)) return base
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in out)) continue
    if (isPlainObject(out[key]) && isPlainObject(value)) out[key] = mergeConfig(out[key], value)
    else if (Array.isArray(out[key])) out[key] = safeArray(value)
    else if (value !== undefined) out[key] = value
  }
  return out
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function clampFloat(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

/** 把面板送來的 patch 驗證成可落地設定；秘密欄位留空＝不變更。 */
export function sanitizePatch(current, patch) {
  const next = mergeConfig(current, patch || {})
  const line = next.line || {}
  const cf = next.cloudflare || {}
  for (const key of SENSITIVE) {
    for (const branch of [line, cf]) {
      if (key in branch) {
        const value = branch[key]
        if (typeof value !== 'string' || value.trim() === '' || isMaskedValue(value)) {
          // 留空或貼回遮罩值 → 保留原值
          if (key in current.line) branch[key] = current.line[key]
          else if (key in current.cloudflare) branch[key] = current.cloudflare[key]
        } else {
          branch[key] = value.trim()
        }
      }
    }
  }
  next.line.channelId = String(line.channelId || '').trim()
  next.line.accessToken = String(next.line.accessToken || '').trim()
  next.line.tokenExpiresAt = clampInt(next.line.tokenExpiresAt, 0, Number.MAX_SAFE_INTEGER, 0)
  next.line.allowedUserIds = safeArray(next.line.allowedUserIds)
  next.line.loadingEnabled = Boolean(next.line.loadingEnabled)
  next.line.stickerVision = Boolean(next.line.stickerVision)
  next.line.welcomeText = String(next.line.welcomeText ?? '').slice(0, 1000)
  next.line.errorReply = String(next.line.errorReply ?? '').slice(0, 500)
  next.line.emptyReply = String(next.line.emptyReply ?? '').slice(0, 500)
  next.line.useAutoToken = Boolean(next.line.useAutoToken)

  next.server.host = '127.0.0.1'
  next.server.port = clampInt(next.server.port, 1024, 65535, 8791)
  next.server.autoStart = Boolean(next.server.autoStart)

  next.tunnel.mode = next.tunnel.mode === 'api' ? 'api' : 'quick'
  next.tunnel.binaryPath = String(next.tunnel.binaryPath || '').trim()
  next.tunnel.publicUrl = String(next.tunnel.publicUrl || '').trim()
  next.tunnel.hostname = String(next.tunnel.hostname || '').trim()
  next.tunnel.autoStart = Boolean(next.tunnel.autoStart)
  next.tunnel.autoRestart = Boolean(next.tunnel.autoRestart)
  next.tunnel.autoConfigureWebhook = Boolean(next.tunnel.autoConfigureWebhook)

  next.cloudflare.accountId = String(cf.accountId || '').trim()
  next.cloudflare.zoneId = String(cf.zoneId || '').trim()
  next.cloudflare.hostname = String(cf.hostname || '').trim()
  next.cloudflare.tunnelName = String(cf.tunnelName || 'dsh-line-bot').trim() || 'dsh-line-bot'
  next.cloudflare.tunnelId = String(cf.tunnelId || '').trim()
  next.cloudflare.verified = Boolean(cf.verified)

  next.persona.id = String(next.persona.id || 'dafeiyu').trim() || 'dafeiyu'
  next.persona.enforce = Boolean(next.persona.enforce)
  next.persona.acceptGlobalMode = Boolean(next.persona.acceptGlobalMode)
  next.persona.allowUserSwitch = Boolean(next.persona.allowUserSwitch)

  next.agent.provider = String(next.agent.provider || '').trim()
  next.agent.model = String(next.agent.model || '').trim()
  next.agent.reasoningEffort = String(next.agent.reasoningEffort || '').trim()
  next.agent.cwd = String(next.agent.cwd || '').trim()
  next.agent.timeoutMs = clampInt(next.agent.timeoutMs, 10000, 900000, 180000)
  next.agent.perUserWorkspace = Boolean(next.agent.perUserWorkspace)
  next.agent.workspaceRoot = String(next.agent.workspaceRoot || '').trim()
  next.agent.tiebaContext = Boolean(next.agent.tiebaContext)

  const sync = next.sync
  sync.enabled = Boolean(sync.enabled)
  sync.targetPersonaId = String(sync.targetPersonaId || '').trim()
  sync.intervalMinutes = clampInt(sync.intervalMinutes, 5, 1440, 60)
  sync.syncTraits = Boolean(sync.syncTraits)
  sync.reloadPersona = Boolean(sync.reloadPersona)

  const balance = next.balance
  balance.enabled = Boolean(balance.enabled)
  balance.ask = Boolean(balance.ask)
  balance.threshold = clampFloat(balance.threshold, 0, 100000, 10)
  balance.cooldownHours = clampInt(balance.cooldownHours, 1, 168, 12)
  balance.targetUserIds = safeArray(balance.targetUserIds)

  const memory = next.memory || (next.memory = {})
  memory.enabled = Boolean(memory.enabled)
  memory.reviewDaily = Boolean(memory.reviewDaily)
  memory.maxPerUser = clampInt(memory.maxPerUser, 10, 500, 120)
  memory.injectMaxEntries = clampInt(memory.injectMaxEntries, 1, 80, 20)
  memory.injectMaxChars = clampInt(memory.injectMaxChars, 200, 8000, 2000)
  memory.reviewHour = clampInt(memory.reviewHour, 0, 23, 4)

  const stickers = next.stickers || (next.stickers = {})
  stickers.enabled = Boolean(stickers.enabled)
  stickers.maxPerReply = clampInt(stickers.maxPerReply, 1, 3, 1)
  stickers.apng = Boolean(stickers.apng)

  const nudge = next.nudge
  nudge.enabled = Boolean(nudge.enabled)
  nudge.chance = clampFloat(nudge.chance, 0, 1, 0.18)
  nudge.intervalMinutes = clampInt(nudge.intervalMinutes, 5, 1440, 60)
  nudge.dailyCap = clampInt(nudge.dailyCap, 0, 50, 2)
  nudge.monthlyCap = clampInt(nudge.monthlyCap, 0, 1000, 60)
  nudge.minGapMinutes = clampInt(nudge.minGapMinutes, 0, 10080, 180)
  nudge.quietStart = HHMM.test(String(nudge.quietStart)) ? String(nudge.quietStart) : '00:30'
  nudge.quietEnd = HHMM.test(String(nudge.quietEnd)) ? String(nudge.quietEnd) : '09:30'
  nudge.idleMinutes = clampInt(nudge.idleMinutes, 0, 10080, 90)
  nudge.targetUserIds = safeArray(nudge.targetUserIds)
  nudge.prompt = String(nudge.prompt || '').slice(0, 4000)

  next.log.maxLines = clampInt(next.log.maxLines, 50, 2000, 400)
  return next
}

export function publicConfig(cfg) {
  return {
    ...cfg,
    line: {
      ...cfg.line,
      channelSecret: cfg.line.channelSecret ? maskLike(cfg.line.channelSecret) : '',
      accessToken: cfg.line.accessToken ? maskLike(cfg.line.accessToken) : '',
      hasSecret: Boolean(cfg.line.channelSecret),
      hasToken: Boolean(cfg.line.accessToken),
      hasChannelId: Boolean(cfg.line.channelId),
    },
    cloudflare: {
      ...cfg.cloudflare,
      apiToken: cfg.cloudflare.apiToken ? maskLike(cfg.cloudflare.apiToken) : '',
      hasApiToken: Boolean(cfg.cloudflare.apiToken),
    },
  }
}

function maskLike(value) {
  return value.length <= 8 ? `${'•'.repeat(Math.max(4, value.length - 2))}${value.slice(-2)}` : `${value.slice(0, 4)}…${value.slice(-4)}`
}

export function createConfigStore({ logger } = {}) {
  const dir = dataDir()
  const configPath = path.join(dir, 'config.json')
  const statePath = path.join(dir, 'state.json')
  let config = sanitizePatch(DEFAULT_CONFIG, readJsonSafe(configPath, {}))
  let state = normalizeState(readJsonSafe(statePath, {}))

  function save() {
    writeJsonAtomic(configPath, config)
    writeJsonAtomic(statePath, state)
  }

  return {
    dir,
    configPath,
    statePath,
    get: () => config,
    getState: () => state,
    save,
    patch(patch, { silent = false } = {}) {
      config = sanitizePatch(config, patch)
      save()
      if (!silent) logger?.info?.('設定已更新')
      return config
    },
    updateState(mutator) {
      state = normalizeState(mutator(state) || state)
      writeJsonAtomic(statePath, state)
      return state
    },
  }
}

export function normalizeState(raw) {
  const state = isPlainObject(raw) ? raw : {}
  return {
    users: isPlainObject(state.users) ? state.users : {},
    groups: isPlainObject(state.groups) ? state.groups : {},
    nudge: isPlainObject(state.nudge) ? state.nudge : {},
    balance: isPlainObject(state.balance) ? state.balance : {},
    memory: isPlainObject(state.memory) ? state.memory : {},
    sync: isPlainObject(state.sync) ? state.sync : {},
    webhook: isPlainObject(state.webhook) ? state.webhook : null,
    lastEventAt: Number(state.lastEventAt) || 0,
    lastError: typeof state.lastError === 'string' ? state.lastError : '',
    lastStartAt: state.lastStartAt || 0,
    totalMessages: Number(state.totalMessages) || 0,
  }
}
