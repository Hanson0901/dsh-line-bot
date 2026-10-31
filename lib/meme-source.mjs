// 讀 dsh-meme 外掛提供的只讀取圖服務（ctx.get('dshMeme')）。
// 圖庫、分類、描述都由 dsh-meme 維護；這裡只負責挑圖與把檔案路徑交給 LINE。
export function createMemeSource({ ctx, logger }) {
  function service() {
    try {
      return ctx?.get?.('dshMeme') || null
    } catch {
      return null
    }
  }

  function available() {
    const svc = service()
    return Boolean(svc && typeof svc.pick === 'function')
  }

  function packs() {
    try {
      const rows = service()?.packs?.()
      return Array.isArray(rows) ? rows : []
    } catch (error) {
      logger?.warn?.(`讀取 dsh-meme 圖庫失敗：${error?.message || error}`)
      return []
    }
  }

  function search({ query = '', tag = '', limit = 8 } = {}) {
    try {
      const result = service()?.search?.({ query, tag, limit })
      if (result && Array.isArray(result.memes)) return result
      return { ok: false, memes: [] }
    } catch (error) {
      logger?.warn?.(`搜尋 dsh-meme 圖庫失敗：${error?.message || error}`)
      return { ok: false, memes: [] }
    }
  }

  function pick({ query = '', tag = '', limit = 8 } = {}) {
    try {
      const result = service()?.pick?.({ query, tag, limit })
      if (result && result.ok && result.path) return result
      return result && typeof result === 'object' ? result : { ok: false }
    } catch (error) {
      logger?.warn?.(`挑選 dsh-meme 圖片失敗：${error?.message || error}`)
      return { ok: false, error: error?.message || String(error) }
    }
  }

  const MOODS = ['happy', 'angry', 'sad', 'shy', 'confused', 'daily']

  function sample({ limit = 16 } = {}) {
    const seen = new Set()
    const rows = []
    for (const tag of MOODS) {
      const result = search({ tag, limit: 4 })
      for (const item of result.memes || []) {
        const key = item.path || `${item.tag}:${item.caption}`
        if (seen.has(key)) continue
        seen.add(key)
        rows.push(item)
        if (rows.length >= limit) return rows
      }
    }
    return rows
  }

  function stats() {
    const rows = packs()
    const count = rows.reduce((sum, pack) => sum + (Number(pack.count) || 0), 0)
    return { available: available(), count, packs: rows }
  }

  return { available, packs, search, pick, sample, stats }
}
