import fs from 'node:fs'

const TIME_RE = /^(\d{1,2}):(\d{2})\t(.*)$/
const DATE_RE = /^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s*（[^）]*）)?\s*$/
const MARKERS = new Set(['[貼圖]', '[照片]', '[檔案]', '[影片]', '[語音訊息]', '[相簿]', '[GIF]', '[表情貼]'])

function pad(value) {
  return String(value).padStart(2, '0')
}

function cleanLine(line) {
  return String(line || '').replace(/[\u2066-\u2069]/g, '')
}

export function parseLineExport(raw) {
  const lines = cleanLine(raw).replace(/\r\n?/g, '\n').split('\n')
  const messages = []
  let title = ''
  let savedAt = ''
  let date = ''
  let current = null
  for (const line of lines) {
    const dateMatch = line.match(DATE_RE)
    if (dateMatch) {
      date = `${dateMatch[1]}-${pad(dateMatch[2])}-${pad(dateMatch[3])}`
      current = null
      continue
    }
    if (!date) {
      if (/^\[LINE\]/.test(line)) title = line.replace(/^\[LINE\]\s*/, '').trim()
      const saved = line.match(/儲存日期[：:]\s*(.+)$/)
      if (saved) savedAt = saved[1].trim()
      continue
    }
    const timeMatch = line.match(TIME_RE)
    if (timeMatch) {
      const time = `${pad(timeMatch[1])}:${timeMatch[2]}`
      const rest = timeMatch[3]
      const parts = rest.split('\t')
      if (parts.length >= 2) {
        const name = parts[0].trim()
        const body = parts.slice(1).join('\t')
        if (!name) {
          messages.push({ date, time, name: '', text: body, system: true })
          current = null
          continue
        }
        current = { date, time, name, text: body, system: false }
        messages.push(current)
        continue
      }
      messages.push({ date, time, name: '', text: rest, system: true })
      current = null
      continue
    }
    if (current) current.text += `\n${line}`
  }
  const participants = []
  const counts = new Map()
  for (const message of messages) {
    if (message.system || !message.name) continue
    counts.set(message.name, (counts.get(message.name) || 0) + 1)
  }
  for (const [name, count] of counts) participants.push({ name, count })
  participants.sort((a, b) => b.count - a.count)
  return { title, savedAt, messages, participants }
}

function clip(value, max = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function isSubstantive(message) {
  if (message.system || !message.name) return false
  const text = String(message.text || '').trim()
  if (!text) return false
  if (MARKERS.has(text)) return false
  if (/^https?:\/\//i.test(text)) return false
  return text.length >= 4
}

export function buildDigest(parsed, options = {}) {
  const recentLimit = Math.max(40, Math.min(600, Number(options.recentLimit) || 220))
  const perMember = Math.max(4, Math.min(30, Number(options.perMember) || 12))
  const messages = parsed.messages.filter((message) => !message.system && message.name)
  const substantive = messages.filter(isSubstantive)
  const recent = substantive.slice(-recentLimit)
  const byName = new Map()
  for (const message of substantive) {
    if (!byName.has(message.name)) byName.set(message.name, [])
    byName.get(message.name).push(message)
  }
  const members = []
  for (const [name, list] of byName) {
    members.push({ name, count: list.length, samples: list.slice(-perMember) })
  }
  members.sort((a, b) => b.count - a.count)
  const lines = []
  lines.push(`群組：${parsed.title || '（未命名）'}`)
  if (parsed.savedAt) lines.push(`匯出時間：${parsed.savedAt}`)
  const first = messages[0]
  const last = messages[messages.length - 1]
  if (first && last) lines.push(`訊息範圍：${first.date} ${first.time} ～ ${last.date} ${last.time}`)
  lines.push(`訊息總數：${messages.length}`)
  lines.push(`參與者（發言數）：${parsed.participants.map((item) => `${item.name}（${item.count}）`).join('、')}`)
  lines.push('')
  lines.push('【最近的對話】')
  for (const message of recent) lines.push(`[${message.date} ${message.time}] ${message.name}：${clip(message.text)}`)
  lines.push('')
  lines.push('【各成員的代表發言】')
  for (const member of members) {
    lines.push(`◆ ${member.name}（共 ${member.count} 則）`)
    for (const message of member.samples) lines.push(`- ${clip(message.text)}`)
  }
  return { text: lines.join('\n'), members, recentCount: recent.length, messageCount: messages.length }
}

export function buildImportPrompt(digest) {
  return [
    '你是一位擅長讀懂群組氣氛的記憶整理助手。下面是一份 LINE 群組聊天記錄摘要。',
    '請整理成嚴格 JSON（不要 markdown 圍欄、不要解釋），格式：',
    '{"summary":"這個群組最近在聊什麼、氣氛如何（120 字內）","topics":["主題1","主題2","主題3"],"members":[{"name":"成員名稱","notes":["關於這個人的長期重點1","重點2"]}]}',
    '規則：',
    '1. members 只放摘要裡真的有出現的成員，名字照抄，不要發明。',
    '2. notes 每人 1~4 點，只寫長期有用的事實、偏好、口頭禪、在意的事或關係；不要寫一次性閒聊、不要評論長相或隱私。',
    '3. 不要記錄電話、地址、帳號、密碼等敏感資料。',
    '4. 看不出來的就少寫，寧缺勿濫。',
    '5. summary 與 notes 用繁體中文。',
    '',
    '聊天記錄摘要：',
    digest,
  ].join('\n')
}

export function parseImportResult(text) {
  const raw = String(text || '').trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  const slice = raw.slice(start, end + 1)
  try {
    const value = JSON.parse(slice)
    if (!value || typeof value !== 'object') return null
    const members = Array.isArray(value.members)
      ? value.members
          .filter((item) => item && typeof item.name === 'string' && item.name.trim())
          .map((item) => ({
            name: item.name.trim().slice(0, 40),
            notes: (Array.isArray(item.notes) ? item.notes : [])
              .map((note) => String(note || '').trim().slice(0, 160))
              .filter(Boolean)
              .slice(0, 4),
          }))
          .filter((item) => item.notes.length > 0)
      : []
    return {
      summary: String(value.summary || '').trim().slice(0, 300),
      topics: (Array.isArray(value.topics) ? value.topics : [])
        .map((topic) => String(topic || '').trim().slice(0, 60))
        .filter(Boolean)
        .slice(0, 6),
      members: members.slice(0, 30),
    }
  } catch {
    return null
  }
}

export function readExportFile(file) {
  return fs.readFileSync(file, 'utf8')
}
