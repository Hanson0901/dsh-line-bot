// 讀 DSH 登入的 DeepSeek 帳號餘額（走 deepseek-account 的 getBalance），快取起來給
// LINE 的 system prompt 與「餘額不足時主動找人」使用。只讀，不會儲值或改設定。
export function createBalanceMonitor({ ctx, logger }) {
  let cache = {
    status: 'idle', // idle | ready | signed-out | unavailable | failed | error
    at: 0,
    error: '',
    wallets: [],
    cny: null,
    usd: null,
  }

  function accountService() {
    try {
      return ctx.get?.('deepseekAccount') || ctx.get?.('account') || null
    } catch {
      return null
    }
  }

  function normalize(detail) {
    const normal = Array.isArray(detail?.value) ? detail.value : []
    const bonus = Array.isArray(detail?.bonusWallets) ? detail.bonusWallets : []
    const wallets = [...normal, ...bonus].filter((wallet) => wallet && typeof wallet.balance === 'string')
    const sum = (currency, source) => source
      .filter((wallet) => wallet.currency === currency)
      .reduce((total, wallet) => total + (Number(wallet.balance) || 0), 0)
    const make = (currency) => {
      const normalSum = sum(currency, normal)
      const bonusSum = sum(currency, bonus)
      return { normal: normalSum, bonus: bonusSum, total: normalSum + bonusSum }
    }
    return { wallets, cny: wallets.length ? make('CNY') : null, usd: wallets.length ? make('USD') : null }
  }

  async function fetchNow() {
    const service = accountService()
    if (!service?.getBalance) {
      cache = { status: 'unavailable', at: Date.now(), error: '找不到 deepseekAccount 服務', wallets: [], cny: null, usd: null }
      return cache
    }
    try {
      const detail = await service.getBalance({
        version: '0.2.1',
        locale: 'zh-TW',
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      })
      if (!detail) {
        cache = { status: 'signed-out', at: Date.now(), error: '', wallets: [], cny: null, usd: null }
        return cache
      }
      if (detail.status !== 'ready') {
        cache = { status: 'failed', at: Date.now(), error: '帳號餘額查詢失敗', wallets: [], cny: null, usd: null }
        return cache
      }
      cache = { status: 'ready', at: Date.now(), error: '', ...normalize(detail) }
    } catch (error) {
      cache = { status: 'error', at: Date.now(), error: error?.message || String(error), wallets: [], cny: null, usd: null }
      logger?.warn?.(`讀取 DeepSeek 餘額失敗：${cache.error}`)
    }
    return cache
  }

  return { fetchNow, get: () => cache }
}
