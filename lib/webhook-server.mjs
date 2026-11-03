// 對外（實務上是對 Cloudflare Tunnel）開的 webhook 伺服器。
// 只做三件事：驗簽章、馬上回 200、把事件依使用者排隊交給 dispatch。
import http from 'node:http'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { jsonFail, jsonOk, readRequestBody } from './util.mjs'

function verifySignature(secret, raw, signature) {
  if (!secret || typeof signature !== 'string' || signature.length === 0) return false
  const expected = createHmac('sha256', secret).update(raw).digest('base64')
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(signature, 'utf8')
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export function createWebhookServer({ getConfig, logger, dispatch, getMedia, getDoctor }) {
  let server = null
  let port = 0
  let startedAt = 0
  let lastError = ''
  let lastRequestAt = 0
  const dedupe = new Map()
  const queues = new Map()

  function pruneDedupe() {
    if (dedupe.size <= 1000) return
    const cutoff = Date.now() - 10 * 60 * 1000
    for (const [id, at] of dedupe) if (at < cutoff) dedupe.delete(id)
  }

  function enqueue(event) {
    const id = event?.webhookEventId
    if (id) {
      if (dedupe.has(id)) {
        logger?.info?.(`略過重複事件 ${id}`)
        return
      }
      dedupe.set(id, Date.now())
      pruneDedupe()
    }
    const key = event?.source?.userId || event?.source?.groupId || event?.source?.roomId || 'unknown'
    let queue = queues.get(key)
    if (!queue) {
      queue = { pending: [], running: false }
      queues.set(key, queue)
    }
    queue.pending.push(event)
    if (queue.running) {
      logger?.info?.(`${key} 還在處理上一則，先排入合併（目前 ${queue.pending.length} 則）`)
      return
    }
    queue.running = true
    void drain(key, queue)
  }

  async function drain(key, queue) {
    try {
      while (queue.pending.length > 0) {
        const first = queue.pending.shift()
        await dispatch(first)
        if (queue.pending.length > 0) {
          const batch = queue.pending.splice(0)
          logger?.info?.(`合併 ${batch.length} 則補充訊息（${key}）`)
          await dispatch({ type: 'message_batch', batch })
        }
      }
    } catch (error) {
      lastError = error?.message || String(error)
      logger?.error?.(`處理事件失敗：${lastError}`)
    } finally {
      queue.running = false
      if (queue.pending.length > 0) {
        queue.running = true
        void drain(key, queue)
      } else {
        queues.delete(key)
      }
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    lastRequestAt = Date.now()

    if (req.method === 'GET' && url.pathname === '/doctor') {
      if (typeof getDoctor !== 'function') return jsonFail(res, '診斷功能尚未載入', 503)
      try {
        const repair = url.searchParams.get('repair') === '1'
        const result = await getDoctor({ repair })
        return jsonOk(res, result)
      } catch (error) {
        return jsonFail(res, error?.message || String(error), 500)
      }
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      jsonOk(res, {
        ok: true,
        plugin: 'dsh-line-bot',
        port,
        startedAt,
        queued: queues.size,
        lastRequestAt,
      })
      return
    }

    if (req.method === 'GET' && url.pathname.startsWith('/media/')) {
      const id = decodeURIComponent(url.pathname.slice('/media/'.length))
      const media = typeof getMedia === 'function' ? await getMedia(id) : null
      if (!media || !media.bytes) {
        jsonFail(res, 'not found', 404)
        return
      }
      res.writeHead(200, {
        'content-type': media.mime || 'application/octet-stream',
        'content-length': media.bytes.length,
        'cache-control': 'public, max-age=31536000, immutable',
      })
      res.end(media.bytes)
      return
    }

    if (url.pathname !== '/webhook') {
      jsonFail(res, 'not found', 404)
      return
    }
    if (req.method !== 'POST') {
      jsonFail(res, 'method not allowed', 405)
      return
    }

    const cfg = getConfig()
    if (!cfg.line.channelSecret) {
      jsonFail(res, '尚未設定 LINE channel secret', 503)
      return
    }

    let raw
    try {
      raw = await readRequestBody(req)
    } catch (error) {
      jsonFail(res, error, 413)
      return
    }

    const signature = req.headers['x-line-signature']
    if (!verifySignature(cfg.line.channelSecret, raw, signature)) {
      logger?.warn?.('LINE webhook 簽章驗證失敗')
      jsonFail(res, 'signature 驗證失敗', 403)
      return
    }

    let body
    try {
      body = JSON.parse(raw.toString('utf8') || '{}')
    } catch {
      jsonFail(res, '請求內容不是合法 JSON', 400)
      return
    }

    // LINE 要求快速回 200；真正的回覆在背景跑。
    jsonOk(res, {})
    if (cfg.enabled === false) return
    const events = Array.isArray(body.events) ? body.events : []
    if (events.length > 0) {
      logger?.info?.(`LINE webhook：收到 ${events.length} 筆事件（${events.map((event) => event?.type || '?').join('、')}）`)
    }
    for (const event of events) enqueue(event)
  }

  async function start() {
    if (server) return { port, startedAt }
    const cfg = getConfig()
    const candidate = http.createServer((req, res) => {
      handle(req, res).catch((error) => {
        logger?.error?.(`webhook 伺服器例外：${error?.message || error}`)
        try {
          jsonFail(res, error, 500)
        } catch {
          /* 已經寫回了 */
        }
      })
    })
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        candidate.removeListener('listening', onListening)
        reject(new Error(`LINE webhook 伺服器啟動失敗（port ${cfg.server.port}）：${error?.message || error}`))
      }
      const onListening = () => {
        candidate.removeListener('error', onError)
        resolve()
      }
      candidate.once('error', onError)
      candidate.once('listening', onListening)
      candidate.listen(cfg.server.port, cfg.server.host || '127.0.0.1')
    })
    server = candidate
    port = server.address()?.port || cfg.server.port
    startedAt = Date.now()
    lastError = ''
    logger?.info?.(`LINE webhook 監聽 http://127.0.0.1:${port}/webhook`)
    return { port, startedAt }
  }

  async function stop() {
    if (!server) return { stopped: true }
    const current = server
    server = null
    await new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        resolve()
      }
      try {
        current.close(finish)
      } catch {
        finish()
      }
      setTimeout(finish, 3000)
    })
    port = 0
    startedAt = 0
    queues.clear()
    logger?.info?.('LINE webhook 伺服器已停止')
    return { stopped: true }
  }

  return {
    start,
    stop,
    status: () => ({
      running: Boolean(server),
      port: port || getConfig().server.port,
      startedAt,
      lastError,
      lastRequestAt,
      queued: queues.size,
      endpointPath: '/webhook',
      tunnelTarget: `http://127.0.0.1:${port || getConfig().server.port}`,
    }),
  }
}
