// 大肥魚主動傳訊排程。執行在 host 裡（不用 launchd），所有參數都由面板調整：
// 機率、間隔、每日/每月上限、安靜時段、冷卻時間、指定對象；每次真的送出才記帳。
const DEFAULT_PROMPT =
  '（主動傳訊）現在輪到你主動找對方說話。用一兩句自然、像訊息的短句開場，不要提「系統」「排程」「AI」這些字，也不要複製你之前說過的話。如果你判斷現在不適合打擾，只輸出 SKIP。'

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
    const cfg = getConfig()
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

  function pickUser(cfg, { force }) {
    const state = store.getState()
    const now = Date.now()
    const targets = cfg.nudge.targetUserIds.length
      ? cfg.nudge.targetUserIds
      : Object.keys(state.users || {})
    const candidate = []
    for (const userId of targets) {
      const user = state.users?.[userId]
      if (!user?.sessionId) continue
      const last = Number(user.lastAt) || 0
      if (!force && cfg.nudge.idleMinutes > 0 && now - last < cfg.nudge.idleMinutes * 60000) continue
      candidate.push({ userId, last })
    }
    if (candidate.length === 0) return null
    candidate.sort((a, b) => a.last - b.last)
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
      if (!force) {
        if (cfg.nudge.dailyCap > 0 && c.dayCount >= cfg.nudge.dailyCap) return { skipped: 'daily-cap', ...c }
        if (cfg.nudge.monthlyCap > 0 && c.monthCount >= cfg.nudge.monthlyCap) return { skipped: 'monthly-cap', ...c }
        if (n.lastAt && cfg.nudge.minGapMinutes > 0 && Date.now() - n.lastAt < cfg.nudge.minGapMinutes * 60000) {
          return { skipped: 'min-gap' }
        }
        if (n.lastRollAt && Date.now() - n.lastRollAt < cfg.nudge.intervalMinutes * 60000) return { skipped: 'interval' }
        saveNudge({ lastRollAt: Date.now() })
        if (Math.random() >= cfg.nudge.chance) return { skipped: 'chance' }
      }
      const userId = pickUser(cfg, { force })
      if (!userId) return { skipped: 'no-user' }
      const user = store.getState().users[userId]
      const prompt = (cfg.nudge.prompt || '').trim() || DEFAULT_PROMPT
      let result
      try {
        result = await runTurn({ sessionId: user.sessionId, text: prompt, nudge: true })
      } catch (error) {
        saveNudge({ lastError: error?.message || String(error), lastReason: 'error', nextAt: Date.now() + 60000 })
        store.updateState((state) => ({ ...state, lastError: error?.message || String(error) }))
        logger?.error?.(`主動傳訊失敗：${error?.message || error}`)
        return { skipped: 'agent-error', error: error?.message || String(error) }
      }
      const text = String(result?.text || '').trim()
      if (!text || /^SKIP\b/i.test(text)) {
        saveNudge({ lastReason: 'skip' })
        return { skipped: 'skip', ...c }
      }
      try {
        await sendProactive(userId, text)
      } catch (error) {
        saveNudge({ lastError: error?.message || String(error), lastReason: 'send-error' })
        logger?.error?.(`主動傳訊送出失敗：${error?.message || error}`)
        return { skipped: 'send-error', error: error?.message || String(error) }
      }
      const stamp = Date.now()
      const today = dayKey()
      const month = monthKey()
      const next = counters()
      saveNudge({
        day: today,
        dayCount: next.dayCount + 1,
        month,
        monthCount: next.monthCount + 1,
        lastAt: stamp,
        lastReason: force ? 'test' : 'sent',
        lastError: '',
        nextAt: cfg.nudge.minGapMinutes > 0 ? stamp + cfg.nudge.minGapMinutes * 60000 : stamp + 3600000,
      })
      store.updateState((state) => {
        const target = state.users[userId]
        if (!target) return state
        return {
          ...state,
          users: { ...state.users, [userId]: { ...target, lastAt: stamp, nudges: (Number(target.nudges) || 0) + 1 } },
        }
      })
      logger?.info?.(`已主動傳訊給 ${userId}（${text.length} 字）`)
      return { sent: true, userId, text, ...counters() }
    } finally {
      ticking = false
    }
  }

  function start() {
    if (timer) return
    timer = setInterval(() => {
      tick().catch((error) => logger?.error?.(`主動傳訊排程例外：${error?.message || error}`))
    }, 60 * 1000)
    if (typeof timer.unref === 'function') timer.unref()
    logger?.info?.('主動傳訊排程已啟動（每分鐘檢查一次）')
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
      nextAt: n.nextAt,
      lastTickAt,
      eligibleUsers: Object.values(store.getState().users || {}).filter((u) => u?.sessionId).length,
    }
  }

  return { start, stop, tick, stats, DEFAULT_PROMPT }
}
