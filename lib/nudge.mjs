// 大肥魚主動傳訊排程。執行在 host 裡（不用 launchd），所有參數都由面板調整：
// 每位使用者有自己的倒數（最短／最長間隔隨機），時間到且沉默夠久才可能開口；
// 連續未回覆達上限就暫停，使用者一說話就歸零並重新倒數。
import { safeArray } from './util.mjs'

const DEFAULT_PROMPT =
  '（主動傳訊）現在輪到你主動找對方說話。用一兩句自然、像訊息的短句開場，不要提「系統」「排程」「AI」這些字，也不要複製你之前說過的話。如果氣氛合適，可以在句子後面加 [[meme:#編號]] 配一張圖（編號照 context 裡的圖庫清單），不適合就純文字。如果你判斷現在不適合打擾，只輸出 SKIP。'

export function createNudgeScheduler({ getConfig, store, logger, runTurn, sendProactive }) {
  let timer = null
  let ticking = false
  let lastTickAt = 0

  function nudgeState() {
    const state = store.getState()
    const n = state.nudge && typeof state.nudge === 'object' ? state.nudge : {}
    return {
      day: typeof n.day === 'string' ? n.day : '',
      dayCount: Number(n.dayCount) || 0,
      month: typeof n.month === 'string' ? n.month : '',
      monthCount: Number(n.monthCount) || 0,
      lastAt: Number(n.lastAt) || 0,
      lastRollAt: Number(n.lastRollAt) || 0,
      lastError: typeof n.lastError === 'string' ? n.lastError : '',
      lastReason: typeof n.lastReason === 'string' ? n.lastReason : '',
      nextAt: Number(n.nextAt) || 0,
    }
  }

  function saveNudge(patch) {
    store.updateState((state) => {
      const prev = state.nudge && typeof state.nudge === 'object' ? state.nudge : {}
      return { ...state, nudge: { ...prev, ...patch } }
    })
  }

  function dayKey(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  }

  function monthKey(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
  }

  function minutesOf(date = new Date()) {
    return date.getHours() * 60 + date.getMinutes()
  }

  function inQuiet(cfg, date = new Date()) {
    const toMin = (value) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''))
      return m ? Number(m[1]) * 60 + Number(m[2]) : null
    }
    const start = toMin(cfg.nudge.quietStart)
    const end = toMin(cfg.nudge.quietEnd)
    if (start === null || end === null) return false
    const now = minutesOf(date)
    return start <= end ? now >= start && now < end : now >= start || now < end
  }

  function counters() {
    const n = nudgeState()
    const today = dayKey()
    const month = monthKey()
    return {
      dayCount: n.day === today ? n.dayCount : 0,
      monthCount: n.month === month ? n.monthCount : 0,
      day: today,
      month,
    }
  }

  // 最短／最長間隔（分鐘）。舊版只有 intervalMinutes，沒有新設定時當成最短值。
  function intervalRange(cfg) {
    const legacy = Number(cfg.nudge.intervalMinutes)
    const min = Math.max(1, Number(cfg.nudge.minIntervalMinutes) || (Number.isFinite(legacy) && legacy > 0 ? legacy : 45))
    const max = Math.max(min, Number(cfg.nudge.maxIntervalMinutes) || Math.max(min, 180))
    return { min, max }
  }

  function randomIntervalMs(cfg) {
    const { min, max } = intervalRange(cfg)
    if (max <= min) return min * 60000
    return Math.round((min + Math.random() * (max - min)) * 60000)
  }

  function setUserSchedule(userId, patch) {
    store.updateState((state) => {
      const target = state.users?.[userId]
      if (!target) return state
      return { ...state, users: { ...state.users, [userId]: { ...target, ...patch } } }
    })
  }

  function allowedUsers(cfg) {
    const state = store.getState()
    const allowed = safeArray(cfg.line?.allowedUserIds)
    const targets = safeArray(cfg.nudge.targetUserIds)
    const ids = targets.length ? targets : Object.keys(state.users || {})
    return ids.filter((userId) => {
      const user = state.users?.[userId]
      if (!user?.sessionId) return false
      return allowed.length > 0 && allowed.includes(userId)
    })
  }

  // 第一次啟動（或舊資料）時，把還沒有倒數的使用者排進佇列，避免同時到期。
  function ensureSchedules(cfg) {
    const state = store.getState()
    const now = Date.now()
    let changed = false
    const users = { ...(state.users || {}) }
    for (const userId of allowedUsers(cfg)) {
      const user = users[userId]
      if (!user) continue
      if (!Number(user.nudgeNextAt)) {
        users[userId] = {
          ...user,
          nudgeNextAt: now + randomIntervalMs(cfg),
          nudgeUnanswered: Number(user.nudgeUnanswered) || 0,
          nudgePaused: false,
        }
        changed = true
      }
    }
    if (changed) store.updateState((s) => ({ ...s, users }))
  }

  function nextDueAt(cfg) {
    const state = store.getState()
    let best = 0
    for (const userId of allowedUsers(cfg)) {
      const user = state.users?.[userId]
      if (!user || user.nudgePaused) continue
      const at = Number(user.nudgeNextAt) || 0
      if (!at) continue
      if (!best || at < best) best = at
    }
    return best
  }

  function pickUser(cfg, { force }) {
    const state = store.getState()
    const now = Date.now()
    const candidate = []
    for (const userId of allowedUsers(cfg)) {
      const user = state.users?.[userId]
      if (!user) continue
      if (!force) {
        if (user.nudgePaused) continue
        const at = Number(user.nudgeNextAt) || 0
        if (!at || at > now) continue
        const last = Number(user.lastAt) || 0
        if (cfg.nudge.idleMinutes > 0 && now - last < cfg.nudge.idleMinutes * 60000) continue
      }
      candidate.push({ userId, at: Number(user.nudgeNextAt) || 0, last: Number(user.lastAt) || 0 })
    }
    if (candidate.length === 0) return null
    candidate.sort((a, b) => (force ? a.last - b.last : a.at - b.at))
    return candidate[0].userId
  }

  async function tick({ force = false } = {}) {
    if (ticking) return { skipped: 'busy' }
    ticking = true
    lastTickAt = Date.now()
    try {
      const cfg = getConfig()
      const now = new Date()
      if (!force && !cfg.nudge.enabled) return { skipped: 'disabled' }
      if (!force && inQuiet(cfg, now)) return { skipped: 'quiet' }
      const n = nudgeState()
      const c = counters()
      if (!force) ensureSchedules(cfg)
      if (!force) {
        if (cfg.nudge.dailyCap > 0 && c.dayCount >= cfg.nudge.dailyCap) return { skipped: 'daily-cap', ...c }
        if (cfg.nudge.monthlyCap > 0 && c.monthCount >= cfg.nudge.monthlyCap) return { skipped: 'monthly-cap', ...c }
        if (n.lastAt && cfg.nudge.minGapMinutes > 0 && Date.now() - n.lastAt < cfg.nudge.minGapMinutes * 60000) {
          return { skipped: 'min-gap', nextAt: nextDueAt(cfg) }
        }
      }
      const userId = pickUser(cfg, { force })
      if (!userId) {
        return { skipped: 'not-due', nextAt: nextDueAt(cfg), ...c }
      }
      const user = store.getState().users[userId]
      const prompt = (cfg.nudge.prompt || '').trim() || DEFAULT_PROMPT
      let result
      try {
        result = await runTurn({ sessionId: user.sessionId, text: prompt, nudge: true })
      } catch (error) {
        setUserSchedule(userId, { nudgeNextAt: Date.now() + 5 * 60000 })
        saveNudge({ lastError: error?.message || String(error), lastReason: 'error', nextAt: nextDueAt(cfg) })
        store.updateState((state) => ({ ...state, lastError: error?.message || String(error) }))
        logger?.error?.(`主動傳訊失敗：${error?.message || error}`)
        return { skipped: 'agent-error', error: error?.message || String(error) }
      }
      const text = String(result?.text || '').trim()
      if (!text || /^SKIP\b/i.test(text)) {
        setUserSchedule(userId, { nudgeNextAt: Date.now() + randomIntervalMs(cfg) })
        saveNudge({ lastReason: 'skip', nextAt: nextDueAt(cfg) })
        return { skipped: 'skip', ...c }
      }
      try {
        await sendProactive(userId, text)
      } catch (error) {
        setUserSchedule(userId, { nudgeNextAt: Date.now() + 5 * 60000 })
        saveNudge({ lastError: error?.message || String(error), lastReason: 'send-error', nextAt: nextDueAt(cfg) })
        logger?.error?.(`主動傳訊送出失敗：${error?.message || error}`)
        return { skipped: 'send-error', error: error?.message || String(error) }
      }
      const stamp = Date.now()
      const today = dayKey()
      const month = monthKey()
      const next = counters()
      const unanswered = (Number(user.nudgeUnanswered) || 0) + 1
      const limit = Number(cfg.nudge.unansweredLimit) || 0
      const paused = limit > 0 && unanswered >= limit
      const nextAt = paused ? 0 : stamp + randomIntervalMs(cfg)
      setUserSchedule(userId, {
        nudgeNextAt: nextAt,
        nudgeLastAt: stamp,
        nudgeUnanswered: unanswered,
        nudgePaused: paused,
        lastAt: stamp,
        nudges: (Number(user.nudges) || 0) + 1,
      })
      saveNudge({
        day: today,
        dayCount: next.dayCount + 1,
        month,
        monthCount: next.monthCount + 1,
        lastAt: stamp,
        lastReason: force ? 'test' : 'sent',
        lastError: '',
        nextAt: nextDueAt(cfg),
      })
      if (paused) logger?.info?.(`主動傳訊：${userId} 已連續 ${unanswered} 次未回覆，暫停到對方下次說話`)
      logger?.info?.(`已主動傳訊給 ${userId}（${text.length} 字）`)
      return { sent: true, userId, text, unanswered, paused, ...counters() }
    } finally {
      ticking = false
    }
  }

  // 使用者一說話：未回覆歸零、解除暫停，並重新隨機倒數（沉默後才再開口）。
  function noteUserMessage(userId) {
    const cfg = getConfig()
    const user = store.getState().users?.[userId]
    if (!user) return 0
    const nextAt = Date.now() + randomIntervalMs(cfg)
    setUserSchedule(userId, {
      nudgeNextAt: nextAt,
      nudgeUnanswered: 0,
      nudgePaused: false,
      nudgeLastUserAt: Date.now(),
    })
    return nextAt
  }

  function scheduleOf(userId) {
    const user = store.getState().users?.[userId] || {}
    return {
      nextAt: Number(user.nudgeNextAt) || 0,
      unanswered: Number(user.nudgeUnanswered) || 0,
      paused: Boolean(user.nudgePaused),
      lastAt: Number(user.nudgeLastAt) || 0,
    }
  }

  function start() {
    if (timer) return
    timer = setInterval(() => {
      tick().catch((error) => logger?.error?.(`主動傳訊排程例外：${error?.message || error}`))
    }, 60 * 1000)
    if (typeof timer.unref === 'function') timer.unref()
    logger?.info?.('主動傳訊排程已啟動（每分鐘檢查一次，每位使用者獨立倒數）')
  }

  function stop() {
    if (!timer) return
    clearInterval(timer)
    timer = null
  }

  function stats() {
    const cfg = getConfig()
    const c = counters()
    const n = nudgeState()
    const state = store.getState()
    const pausedUsers = Object.values(state.users || {}).filter((u) => u?.sessionId && u.nudgePaused).length
    return {
      running: Boolean(timer),
      enabled: cfg.nudge.enabled,
      dayCount: c.dayCount,
      monthCount: c.monthCount,
      dailyCap: cfg.nudge.dailyCap,
      monthlyCap: cfg.nudge.monthlyCap,
      lastAt: n.lastAt,
      lastRollAt: n.lastRollAt,
      lastError: n.lastError,
      lastReason: n.lastReason,
      nextAt: nextDueAt(cfg),
      pausedUsers,
      minIntervalMinutes: intervalRange(cfg).min,
      maxIntervalMinutes: intervalRange(cfg).max,
      unansweredLimit: Number(cfg.nudge.unansweredLimit) || 0,
      lastTickAt,
      eligibleUsers: allowedUsers(cfg).length,
    }
  }

  return { start, stop, tick, stats, DEFAULT_PROMPT, noteUserMessage, scheduleOf }
}
