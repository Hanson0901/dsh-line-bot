// LINE Messaging API 的最小封裝（只用 fetch，不帶任何依賴）。
const MESSAGING = 'https://api.line.me/v2/bot'
const OAUTH = 'https://api.line.me'
const DEFAULT_TIMEOUT = 20000

export class LineApiError extends Error {
  constructor(message, { status = 0, data = null } = {}) {
    super(message)
    this.name = 'LineApiError'
    this.status = status
    this.data = data
  }
}

async function request(url, init = {}, { timeoutMs = DEFAULT_TIMEOUT } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    const text = await res.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = text ? { raw: text } : null
    }
    if (!res.ok) {
      const detail =
        data?.message || data?.error_description || data?.error || (data?.errors && JSON.stringify(data.errors)) || text || ''
      throw new LineApiError(`LINE ${res.status}${detail ? `：${detail}` : ''}`, { status: res.status, data })
    }
    return data
  } catch (error) {
    if (error?.name === 'AbortError') throw new LineApiError(`LINE 請求逾時（${url}）`, { status: 0 })
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function bearer(token) {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

function formBody(fields) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(fields)) params.set(key, String(value))
  return params
}

/**
 * 長效 channel access token（client_credentials）：即使沒有開發者後台簽發，
 * 只要持有 channel ID + channel secret 也能取得；LINE 端會回 expires_in。
 */
export async function issueAccessToken(channelId, channelSecret, { timeoutMs = DEFAULT_TIMEOUT } = {}) {
  const data = await request(
    `${OAUTH}/v2/oauth/accessToken`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: formBody({ grant_type: 'client_credentials', client_id: channelId, client_secret: channelSecret }),
    },
    { timeoutMs },
  )
  return {
    accessToken: data?.access_token || '',
    expiresIn: Number(data?.expires_in) || 0,
    tokenType: data?.token_type || 'Bearer',
  }
}

/** 無狀態短效 token（15 分鐘）：不需要 JWT 簽章，刷新成本低。 */
export async function issueStatelessToken(channelId, channelSecret, { timeoutMs = DEFAULT_TIMEOUT } = {}) {
  const data = await request(
    `${OAUTH}/oauth2/v3/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: formBody({ grant_type: 'client_credentials', client_id: channelId, client_secret: channelSecret }),
    },
    { timeoutMs },
  )
  return {
    accessToken: data?.access_token || '',
    expiresIn: Number(data?.expires_in) || 900,
    tokenType: data?.token_type || 'Bearer',
  }
}

export async function getBotInfo(accessToken) {
  return request(`${MESSAGING}/info`, { headers: bearer(accessToken) })
}

export async function getProfile(accessToken, userId) {
  return request(`${MESSAGING}/profile/${encodeURIComponent(userId)}`, { headers: bearer(accessToken) })
}

export async function getGroupSummary(accessToken, groupId) {
  return request(`${MESSAGING}/group/${encodeURIComponent(groupId)}/summary`, { headers: bearer(accessToken) })
}

export async function getRoomSummary(accessToken, roomId) {
  return request(`${MESSAGING}/room/${encodeURIComponent(roomId)}/summary`, { headers: bearer(accessToken) })
}

export async function getQuota(accessToken) {
  return request(`${MESSAGING}/message/quota`, { headers: bearer(accessToken) })
}

export async function getWebhookEndpoint(accessToken) {
  return request(`${MESSAGING}/channel/webhook/endpoint`, { headers: bearer(accessToken) })
}

export async function setWebhookEndpoint(accessToken, endpoint) {
  return request(`${MESSAGING}/channel/webhook/endpoint`, {
    method: 'PUT',
    headers: bearer(accessToken),
    body: JSON.stringify({ endpoint }),
  })
}

export async function testWebhookEndpoint(accessToken, endpoint) {
  return request(`${MESSAGING}/channel/webhook/test`, {
    method: 'POST',
    headers: bearer(accessToken),
    body: JSON.stringify({ endpoint }),
  })
}

export async function startLoading(accessToken, chatId, loadingSeconds = 60) {
  return request(`${MESSAGING}/chat/loading/start`, {
    method: 'POST',
    headers: bearer(accessToken),
    body: JSON.stringify({ chatId, loadingSeconds }),
  })
}

function toMessages(input) {
  return (Array.isArray(input) ? input : [input])
    .filter(Boolean)
    .map((item) => (typeof item === 'string' ? { type: 'text', text: item } : item))
    .filter((item) => item && item.type)
}

export async function replyMessage(accessToken, replyToken, content) {
  const messages = toMessages(content)
  if (messages.length === 0) return null
  return request(`${MESSAGING}/message/reply`, {
    method: 'POST',
    headers: bearer(accessToken),
    body: JSON.stringify({ replyToken, messages }),
  })
}

export async function pushMessage(accessToken, to, content) {
  const messages = toMessages(content)
  if (messages.length === 0) return null
  return request(`${MESSAGING}/message/push`, {
    method: 'POST',
    headers: bearer(accessToken),
    body: JSON.stringify({ to, messages }),
  })
}
