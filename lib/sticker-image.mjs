// 抓 LINE 貼圖圖片，存進 DSH 附件庫，供多模態模型閱讀。
const STICKER_BASE = 'https://stickershop.line-scdn.net/stickershop/v1/sticker'

function animationType(resourceType) {
  return resourceType === 'ANIMATION' || resourceType === 'ANIMATION_SOUND'
}

export function createStickerImages({ ctx, logger, dir }) {
  const attachments = ctx?.get?.('attachments')
  const cache = new Map()

  function available() {
    return Boolean(attachments && typeof attachments.saveImages === 'function')
  }

  async function fetchBytes(stickerId, resourceType) {
    const id = String(stickerId || '').replace(/[^0-9]/g, '')
    if (!id) throw new Error('沒有 stickerId')
    const urls = [`${STICKER_BASE}/${id}/android/sticker.png`]
    if (animationType(resourceType)) urls.push(`${STICKER_BASE}/${id}/android/sticker_animation.png`)
    let lastError
    for (const url of urls) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
        if (!response.ok) throw new Error(`LINE 貼圖 HTTP ${response.status}`)
        const data = new Uint8Array(await response.arrayBuffer())
        if (data.byteLength === 0) throw new Error('LINE 貼圖是空檔案')
        if (data.byteLength > 6 * 1024 * 1024) throw new Error('LINE 貼圖太大')
        return { data, url }
      } catch (error) {
        lastError = error
      }
    }
    throw lastError || new Error('抓不到 LINE 貼圖')
  }

  async function toAttachment(stickerId, resourceType) {
    if (!available()) throw new Error('這個 profile 沒有附件服務（attachments）')
    const key = `${stickerId}:${resourceType || ''}`
    if (cache.has(key)) return cache.get(key)
    const { data } = await fetchBytes(stickerId, resourceType)
    const [ref] = await attachments.saveImages([
      { data, mediaType: 'image/png', name: `line-sticker-${stickerId}.png` },
    ])
    if (!ref) throw new Error('附件服務沒有回傳圖片參照')
    cache.set(key, ref)
    if (cache.size > 300) cache.delete(cache.keys().next().value)
    logger?.info?.(`已取得 LINE 貼圖圖片（stickerId=${stickerId}，${data.byteLength} bytes）`)
    return ref
  }

  async function saveBuffer(buffer, name = 'line-image.png', mediaType = 'image/png') {
    if (!available()) throw new Error('這個 profile 沒有附件服務（attachments）')
    if (!buffer || buffer.byteLength === 0) throw new Error('圖片是空檔案')
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
    const [ref] = await attachments.saveImages([{ data: bytes, mediaType, name }])
    if (!ref) throw new Error('附件服務沒有回傳圖片參照')
    return ref
  }

  return { available, toAttachment, saveBuffer, fetchBytes }
}
