import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { readJsonSafe, writeJsonAtomic, clip } from './util.mjs'

const MAX_TEXT = 120
const MAX_USAGE = 160
const MAX_ENTRIES = 400

const DEFAULTS = [
  { text: '這波啊，這波是⋯', usage: '遇到離譜的操作或劇情反轉時，接一句吐槽', mood: 'amused' },
  { text: '典', usage: '對方講了一長串很典型的套路或偏見，一個字收掉', mood: 'dry' },
  { text: '急了', usage: '對方被戳到跳腳、開始連珠炮時', mood: 'teasing' },
  { text: '破防了', usage: '被一句話戳中痛點，帶點自嘲', mood: 'self-deprecating' },
  { text: '你禮貌嗎', usage: '對方講話欠揍但又不到翻臉時', mood: 'teasing' },
  { text: '離譜', usage: '事情荒唐到不知道從哪吐槽時', mood: 'amused' },
  { text: '樂', usage: '看熱鬧、覺得好笑但不想長篇大論時', mood: 'amused' },
  { text: '有內味了', usage: '某個場景或語氣很像某種刻板印象時', mood: 'dry' },
  { text: '泰褲辣', usage: '反諷式誇張稱讚，語氣要明顯在鬧', mood: 'playful' },
  { text: '屬於是', usage: '把對方的行為歸類成一個荒謬結論時', mood: 'dry' },
  { text: '好傢伙', usage: '看到離譜場面時的驚嘆，簡短收尾', mood: 'amused' },
  { text: '不然呢', usage: '對方問了答案很明顯的問題時', mood: 'dry' },
  { text: '血壓上來了', usage: '被氣到但又還在開玩笑的範圍內', mood: 'amused' },
  { text: '蚌埠住了', usage: '忍不住笑出來或撐不住時（「崩不住了」的諧音）', mood: 'amused' },
  { text: '拴Q', usage: '無奈道謝或自嘲式感謝（thank you 諧音）', mood: 'playful' },
  { text: '芭比Q了', usage: '事情搞砸、完蛋了的輕鬆說法', mood: 'amused' },
  { text: '退退退', usage: '開玩笑地把麻煩或推銷趕走', mood: 'playful' },
  { text: '我不理解', usage: '遇到無法理解的邏輯時，淡淡一句', mood: 'confused' },
  { text: '這是可以說的嗎', usage: '對方講了很敢講的話時，假裝驚訝', mood: 'teasing' },
  { text: '笑死', usage: '真的很好笑，但不想打長串時', mood: 'amused' },
  { text: '離大譜', usage: '比「離譜」再誇張一點的版本', mood: 'amused' },
  { text: '真有你的', usage: '對方做了讓人哭笑不得的事時', mood: 'teasing' },
  { text: '懂了但沒完全懂', usage: '大概抓到意思、細節還模糊時', mood: 'confused' },
  { text: '抽象', usage: '某件事荒謬到難以形容時（語氣要輕，別用來罵人）', mood: 'dry' },
]

function nowIso() {
  return new Date().toISOString()
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

export function createJokeStore({ dir, logger }) {
  const file = path.join(dir, 'jokes.json')
  let data = readJsonSafe(file, null)

  if (!data || !Array.isArray(data.entries)) {
    data = {
      version: 1,
      entries: DEFAULTS.map((item) => ({
        id: 'j_' + randomBytes(4).toString('hex'),
        text: item.text,
        usage: item.usage,
        mood: item.mood,
        source: 'seed',
        enabled: true,
        createdAt: nowIso(),
      })),
    }
    writeJsonAtomic(file, data)
  }

  // 既有安裝也要補上新增的內建種子（只補缺少的文字，不動使用者自己加的）。
  {
    const have = new Set(data.entries.filter((item) => item.source === 'seed').map((item) => item.text))
    let changed = false
    for (const item of DEFAULTS) {
      if (have.has(item.text)) continue
      data.entries.push({
        id: 'j_' + randomBytes(4).toString('hex'),
        text: item.text,
        usage: item.usage,
        mood: item.mood,
        source: 'seed',
        enabled: true,
        createdAt: nowIso(),
      })
      changed = true
    }
    if (changed) writeJsonAtomic(file, data)
  }

  function save() {
    writeJsonAtomic(file, data)
  }

  function list() {
    return data.entries.slice()
  }

  function find(id) {
    return data.entries.find((item) => item.id === id)
  }

  function add(input = {}) {
    const text = normalizeText(input.text)
    if (!text) throw new Error('梗的內容不能空白')
    if (text.length > MAX_TEXT) throw new Error(`梗的內容最多 ${MAX_TEXT} 字`)
    const entry = {
      id: 'j_' + randomBytes(4).toString('hex'),
      text,
      usage: normalizeText(input.usage).slice(0, MAX_USAGE),
      example: normalizeText(input.example).slice(0, MAX_USAGE),
      taboo: normalizeText(input.taboo).slice(0, MAX_USAGE),
      mood: normalizeText(input.mood).slice(0, 20),
      source: normalizeText(input.source).slice(0, 20) || 'manual',
      enabled: input.enabled !== false,
      createdAt: nowIso(),
    }
    data.entries.push(entry)
    if (data.entries.length > MAX_ENTRIES) data.entries = data.entries.slice(-MAX_ENTRIES)
    save()
    return entry
  }

  function update(id, patch = {}) {
    const entry = find(id)
    if (!entry) throw new Error('找不到這則梗')
    for (const key of ['text', 'usage', 'example', 'taboo', 'mood']) {
      if (patch[key] !== undefined) entry[key] = normalizeText(patch[key]).slice(0, key === 'text' ? MAX_TEXT : MAX_USAGE)
    }
    if (patch.enabled !== undefined) entry.enabled = Boolean(patch.enabled)
    save()
    return entry
  }

  function remove(id) {
    const index = data.entries.findIndex((item) => item.id === id)
    if (index < 0) throw new Error('找不到這則梗')
    const [removed] = data.entries.splice(index, 1)
    save()
    return removed
  }

  function removeBySource(source) {
    const before = data.entries.length
    data.entries = data.entries.filter((item) => item.source !== source)
    if (data.entries.length !== before) save()
    return before - data.entries.length
  }

  function importMany(source, items, options = {}) {
    const enabled = options.enabled !== false
    const seen = new Set(data.entries.map((item) => `${item.source}:${item.text}`))
    let added = 0
    for (const item of items) {
      const text = normalizeText(item.text)
      if (!text || text.length < 3 || text.length > MAX_TEXT) continue
      const key = `${source}:${text}`
      if (seen.has(key)) continue
      seen.add(key)
      data.entries.push({
        id: 'j_' + randomBytes(4).toString('hex'),
        text,
        usage: normalizeText(item.usage).slice(0, MAX_USAGE),
        mood: normalizeText(item.mood).slice(0, 20),
        source,
        enabled,
        createdAt: nowIso(),
      })
      added += 1
      if (data.entries.length >= MAX_ENTRIES) break
    }
    save()
    return added
  }

  function contextText(getConfig) {
    const cfg = getConfig() || {}
    const jokes = cfg.jokes || {}
    if (jokes.enabled === false) return ''
    const allowTieba = jokes.tieba !== false
    const allowWanjiqi = jokes.wanjiqi === true
    const usable = data.entries.filter((item) => {
      if (!item.enabled) return false
      if (item.source === 'tieba' && !allowTieba) return false
      if (item.source === 'wanjiqi' && !allowWanjiqi) return false
      return true
    })
    if (usable.length === 0) return ''
    const count = Math.max(1, Math.min(8, Number(jokes.perTurn) || 3))
    const maxUse = Math.max(1, Math.min(3, Number(jokes.maxUsePerReply) || 1))
    const picked = []
    const pool = usable.slice()
    while (picked.length < count && pool.length > 0) {
      const index = Math.floor(Math.random() * pool.length)
      picked.push(pool.splice(index, 1)[0])
    }
    const lines = picked.map((item) => `- ${item.text}${item.usage ? `（${item.usage}）` : ''}`)
    return [
      `【玩梗】你可以自然用一點梗，但一次回覆最多用 ${maxUse} 個，不要解釋梗，也不要每句都塞；正經、難過、第一次聊天時不要用。`,
      '可用（挑順眼的，用不上就別用）：',
      ...lines,
      '- 不要用貶低、地域、性別、疾病或政治相關的梗；不確定就不要用。',
    ].join('\n')
  }

  function stats() {
    const bySource = {}
    let enabled = 0
    for (const item of data.entries) {
      bySource[item.source] = (bySource[item.source] || 0) + 1
      if (item.enabled) enabled += 1
    }
    return { file, total: data.entries.length, enabled, bySource }
  }

  return { file, list, find, add, update, remove, removeBySource, importMany, contextText, stats }
}
