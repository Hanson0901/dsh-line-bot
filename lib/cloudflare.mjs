// Cloudflare API v4 的最小封裝：驗 token、找帳號/zone、建具名隧道、設 ingress 與 DNS。
const CF = 'https://api.cloudflare.com/client/v4'
const TIMEOUT = 25000

class CloudflareError extends Error {
  constructor(message, { status = 0, errors = [] } = {}) {
    super(message)
    this.name = 'CloudflareError'
    this.status = status
    this.errors = errors
  }
}

async function cf(token, pathname, { method = 'GET', body, timeoutMs = TIMEOUT } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${CF}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await res.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = null
    }
    if (!res.ok || !data?.success) {
      const errors = Array.isArray(data?.errors) ? data.errors : []
      const detail = errors.map((e) => `${e.code ?? ''} ${e.message ?? ''}`.trim()).join('；') || text.slice(0, 300) || `HTTP ${res.status}`
      throw new CloudflareError(`Cloudflare API：${detail}`, { status: res.status, errors })
    }
    return data.result
  } catch (error) {
    if (error?.name === 'AbortError') throw new CloudflareError('Cloudflare API 逾時')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export { CloudflareError }

/** 驗證 API Token 是否有效，並回傳 token 的狀態（active / expired…）。 */
export async function verifyToken(token) {
  if (!token) throw new CloudflareError('尚未填入 Cloudflare API Token')
  return cf(token, '/user/tokens/verify')
}

export async function listAccounts(token) {
  return cf(token, '/accounts?per_page=50')
}

export async function listZones(token) {
  return cf(token, '/zones?per_page=50')
}

export async function listTunnels(token, accountId) {
  const result = await cf(token, `/accounts/${accountId}/cfd_tunnel?is_deleted=false&per_page=100`)
  return Array.isArray(result) ? result : []
}

export async function findTunnel(token, accountId, name) {
  const tunnels = await listTunnels(token, accountId)
  return tunnels.find((t) => t.name === name) || null
}

export async function createTunnel(token, accountId, name) {
  return cf(token, `/accounts/${accountId}/cfd_tunnel`, {
    method: 'POST',
    body: { name, config_src: 'cloudflare' },
  })
}

/** 取得可讓 cloudflared 直接 `tunnel run --token` 的憑證。 */
export async function getTunnelToken(token, accountId, tunnelId) {
  const result = await cf(token, `/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`)
  if (typeof result === 'string') return result
  return result?.token || ''
}

export async function setTunnelIngress(token, accountId, tunnelId, hostname, service, httpHostHeader) {
  const ingress = []
  if (hostname) {
    ingress.push({
      hostname,
      service,
      ...(httpHostHeader ? { originRequest: { httpHostHeader } } : {}),
    })
  }
  ingress.push({ service: 'http_status:404' })
  return cf(token, `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
    method: 'PUT',
    body: { config: { ingress } },
  })
}

export async function listDnsRecords(token, zoneId, name) {
  return cf(token, `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}&per_page=20`)
}

export async function upsertCname(token, zoneId, hostname, tunnelId) {
  const target = `${tunnelId}.cfargotunnel.com`
  const body = { type: 'CNAME', name: hostname, content: target, proxied: true, ttl: 1 }
  let existing = null
  let canRead = true
  try {
    const records = await listDnsRecords(token, zoneId, hostname)
    existing = Array.isArray(records) ? records.find((r) => r.name === hostname) : null
  } catch (error) {
    // 有些 token 只給了 Zone → DNS → Edit 沒有 Read；讀不到就直接嘗試建立。
    if (!(error instanceof CloudflareError) || error.status !== 403) throw error
    canRead = false
  }
  if (existing) {
    if (existing.type === 'CNAME' && existing.content === target && existing.proxied === true) return existing
    return cf(token, `/zones/${zoneId}/dns_records/${existing.id}`, { method: 'PUT', body })
  }
  try {
    return await cf(token, `/zones/${zoneId}/dns_records`, { method: 'POST', body })
  } catch (error) {
    const codes = (error?.errors || []).map((item) => Number(item?.code))
    if (error?.status === 403) {
      throw new CloudflareError(
        `這把 token 沒有 ${hostname} 所屬 Zone 的 DNS 寫入權限（Zone → DNS → Edit）。到 Cloudflare 補上這個權限，或自己在後台建立 CNAME 後再按一次「建立具名隧道」。`,
        { status: error.status, errors: error.errors },
      )
    }
    if (!canRead && codes.includes(81057)) {
      throw new CloudflareError(
        `DNS 記錄 ${hostname} 已經存在，但這把 token 沒有 Zone → DNS → Read，查不到它的 id 可以更新。請把 token 的 DNS 權限改成 Edit（含 Read），或先到 Cloudflare 後台手動刪掉這筆 CNAME 再試一次。`,
        { status: error.status, errors: error.errors },
      )
    }
    throw error
  }
}

/** 從 hostname 找對應 zone（取最長後綴）。 */
export function pickZoneForHostname(zones, hostname) {
  const host = String(hostname || '').toLowerCase().trim()
  if (!host) return null
  let best = null
  for (const zone of Array.isArray(zones) ? zones : []) {
    const name = String(zone?.name || '').toLowerCase()
    if (!name) continue
    if (host === name || host.endsWith(`.${name}`)) {
      if (!best || name.length > String(best.name).length) best = zone
    }
  }
  return best
}

export async function verifyAndDescribe(token) {
  const verify = await verifyToken(token)
  let accounts = []
  let zones = []
  const warnings = []
  try {
    accounts = (await listAccounts(token)) || []
  } catch (error) {
    warnings.push(`讀取帳號列表失敗：${error?.message || error}`)
  }
  try {
    zones = (await listZones(token)) || []
  } catch (error) {
    warnings.push(`讀取 zone 列表失敗：${error?.message || error}`)
  }
  if (accounts.length === 0 && zones.length > 0) {
    // 有些 token 只给了 Zone:Read 沒給 Account Settings:Read；zone 物件裡的 account 欄位
    // 仍然帶著 Account ID，可以直接反推，省得使用者手動找。
    const seen = new Map()
    for (const zone of zones) {
      const account = zone?.account
      if (account?.id && !seen.has(account.id)) {
        seen.set(account.id, { id: account.id, name: account.name || account.id })
      }
    }
    accounts = [...seen.values()]
    if (accounts.length > 0) {
      warnings.push('token 缺少 Account Settings:Read；已從 Zone 反推 Account ID。')
    }
  }
  if (accounts.length === 0) {
    warnings.push('這個 token 看不到任何帳號（通常缺少「Account → Account Settings → Read」權限）：請手動填入 Account ID，或幫 token 加上該權限。')
  }
  if (zones.length === 0) {
    warnings.push('這個 token 看不到任何 Zone（通常缺少「Zone → Zone → Read」權限）：請手動填入 Hostname 與 Zone ID，或幫 token 加上該權限。')
  }
  return { verify, accounts, zones, warnings }
}
