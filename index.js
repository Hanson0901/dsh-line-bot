// dsh-line-bot host 進入點。真正的邏輯放在 lib/host.mjs，這裡只做：
// 1) 把 /api/line-bot/* 掛到 webServer（webServer 不在 inject：headless profile 沒有它）
// 2) 開發用 dev/reload：改完 lib/*.mjs 不用重裝插件
// 3) 插件卸載時釋放 runtime（webhook 伺服器、tunnel、排程）
import { jsonFail, jsonOk } from './lib/util.mjs'

export const name = 'dsh-line-bot'

export function apply(ctx, config) {
  const state = {
    runtime: null,
    loadPromise: null,
    loadError: '',
    mounted: false,
  }

  const log = (message, error) => {
    try {
      if (error) ctx.logger?.error?.(`[line-bot] ${message}`, error)
      else ctx.logger?.info?.(`[line-bot] ${message}`)
    } catch {
      /* logger 不一定存在 */
    }
  }

  async function loadRuntime() {
    const url = new URL('./lib/host.mjs', import.meta.url)
    url.searchParams.set('v', String(Date.now()))
    const mod = await import(url.href)
    return mod.create({ ctx, config, logger: ctx.logger })
  }

  async function ensureRuntime() {
    if (state.runtime) return state.runtime
    if (!state.loadPromise) {
      state.loadPromise = loadRuntime()
        .then((runtime) => {
          state.runtime = runtime
          state.loadError = ''
          log(`執行期就緒 v${runtime.version}`)
          return runtime
        })
        .catch((error) => {
          state.loadError = error?.message || String(error)
          log(`執行期載入失敗：${state.loadError}`, error)
          throw error
        })
        .finally(() => {
          state.loadPromise = null
        })
    }
    return state.loadPromise
  }

  async function handleHttp(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1')

    if (url.pathname === '/api/line-bot/dev/reload') {
      if (req.method !== 'POST') {
        jsonFail(res, 'method not allowed', 405)
        return
      }
      const previous = state.runtime
      state.runtime = null
      try {
        await previous?.dispose?.()
      } catch (error) {
        log(`舊執行期停止時出錯：${error?.message || error}`)
      }
      try {
        const runtime = await ensureRuntime()
        jsonOk(res, { reloaded: true, version: runtime.version })
      } catch (error) {
        jsonFail(res, state.loadError || error?.message || '重新載入失敗', 500)
      }
      return
    }

    try {
      const runtime = await ensureRuntime()
      await runtime.handleHttp(req, res, url)
    } catch (error) {
      jsonFail(res, error?.message || 'LINE Bot 執行期尚未就緒', 503)
    }
  }

  function mount(webServer) {
    if (state.mounted) return
    state.mounted = true
    ctx.effect(
      () =>
        webServer.register({
          kind: 'prefix',
          path: '/api/line-bot',
          handler: handleHttp,
        }),
      'line-bot: /api/line-bot 路由',
    )
    log('HTTP 路由已掛載：/api/line-bot')
  }

  // webServer 常比插件晚幾秒就緒；先直接取，取不到再等 inject 回呼。
  try {
    const immediate = ctx.get?.('webServer')
    if (immediate) mount(immediate)
  } catch {
    /* 還沒就緒 */
  }
  if (!state.mounted) {
    try {
      ctx.inject(['webServer'], (scope) => mount(scope.webServer))
    } catch (error) {
      log(`等待 webServer 失敗：${error?.message || error}`)
    }
  }

  ctx.effect(
    () => () => {
      try {
        state.runtime?.dispose?.()
      } catch (error) {
        log(`卸載時停止失敗：${error?.message || error}`)
      }
      state.runtime = null
    },
    'line-bot: 執行期資源',
  )

  log(`插件已套用（enabled=${config?.enabled !== false}）`)
}
