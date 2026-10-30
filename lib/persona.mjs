// 大肥魚人設插件的橋接。我們不直接碰它的 store 檔，而是走它自己開的 HTTP 入口
// （/api/dsh-persona-dafeiyu/*），行為、驗證與即時 session 選擇都由它負責。
const TIMEOUT = 10000

async function callJson(url, init = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    const text = await res.text()
    let body = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = null
    }
    if (!res.ok || !body) throw new Error(`人設服務回應 ${res.status}`)
    if (body.ok === false) throw new Error(body.error || '人設服務回報失敗')
    return body.value
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('連線人設服務逾時')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export function createPersonaClient({ origin, getOrigin, logger } = {}) {
  const baseOf = () => {
    const value = typeof getOrigin === 'function' ? getOrigin() : origin
    return value ? `${String(value).replace(/\/$/, '')}/api/dsh-persona-dafeiyu` : ''
  }
  function needBase(hint) {
    const base = baseOf()
    if (!base) throw new Error(`找不到 DSH Web 服務，無法${hint}`)
    return base
  }

  async function status(sessionId = '', cwd = '') {
    const base = needBase('讀取大肥魚人設')
    const qs = new URLSearchParams()
    if (sessionId) qs.set('sessionId', sessionId)
    if (cwd) qs.set('cwd', cwd)
    return callJson(`${base}/status${qs.size ? `?${qs}` : ''}`)
  }

  async function mutate(action) {
    const base = needBase('切換大肥魚人設')
    return callJson(`${base}/mutate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(action),
    })
  }

  async function personaText(id) {
    const base = needBase('讀取人設內容')
    return callJson(`${base}/persona?id=${encodeURIComponent(id)}`)
  }

  return {
    available: Boolean(baseOf()),
    status,
    mutate,
    personaText,
    setSessionPersona: (sessionId, personaId) =>
      mutate({ action: 'set-session-persona', sessionId, personaId: personaId || null }),
    // 讓大肥魚在這個 session 完全不注入人設（SESSION_NO_PERSONA）。
    // 插件要用自己的人設時，先叫它讓開，避免兩套人設疊在一起。
    disableSessionPersona: (sessionId) =>
      mutate({ action: 'set-session-persona', sessionId, none: true }),
    clearSessionPersona: (sessionId) => mutate({ action: 'set-session-persona', sessionId, personaId: null }),
    setMode: (mode) => mutate({ action: 'set-mode', mode }),
  }
}
