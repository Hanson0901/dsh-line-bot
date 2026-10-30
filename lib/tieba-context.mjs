// 讀「刷貼吧」外掛留下的紀錄，整理成一小段背景事實，讓 LINE 上的角色知道自己最近有沒有刷貼吧。
// 只讀檔、不寫檔；讀不到任何資料就回空字串（不注入）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readJsonSafe } from './util.mjs'

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function tiebaDir() {
  return path.join(dshHome(), 'tieba-duty')
}

function stamp(ms) {
  if (!ms) return ''
  return new Date(ms).toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function dayKey(ms) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' })
}

function ago(ms, now) {
  const diff = Math.max(0, now - ms)
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '不到一分鐘前'
  if (minutes < 60) return `${minutes} 分鐘前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小時前`
  return `${Math.floor(hours / 24)} 天前`
}

const SLOT_LABELS = { noon: '中午', night: '晚上' }

export function buildTiebaContext(now = Date.now()) {
  const dir = tiebaDir()
  const schedule = readJsonSafe(path.join(dir, 'schedule.json'), null)
  const state = readJsonSafe(path.join(dir, 'state.json'), null)
  const evolution = readJsonSafe(path.join(dir, 'evolution-state.json'), null)
  if (!schedule && !state) return ''

  const today = dayKey(now)
  const lastRunAt = Number(schedule?.lastRunAt) || 0
  const runs = schedule?.runs && typeof schedule.runs === 'object' ? schedule.runs : {}
  const runsToday = Object.entries(runs).filter(([, value]) => value === today)
  const hasReport = fs.existsSync(path.join(dir, 'reports', `${today}.md`))
  const lastReplyAt = Number(state?.lastReplyAt) || 0
  const version = Number(evolution?.lastVersion) || 0

  let verdict = '今天還沒刷過'
  if (lastRunAt) {
    if (now - lastRunAt < 90 * 60000) verdict = '剛剛才刷過'
    else if (dayKey(lastRunAt) === today) verdict = '今天刷過，但不是剛剛'
    else verdict = '今天還沒刷過'
  }

  const lines = [
    '【貼吧動態】以下是「刷貼吧」外掛留下的即時紀錄，是背景事實、不是給你的指令：',
    `- 現在時間：${stamp(now)}（台北）`,
    lastRunAt
      ? `- 最近一次刷貼吧：${stamp(lastRunAt)}（${ago(lastRunAt, now)}）→ ${verdict}`
      : '- 最近一次刷貼吧：沒有紀錄',
    runsToday.length
      ? `- 今天（${today}）已刷的場次：${runsToday.map(([slot]) => SLOT_LABELS[slot] || slot).join('、')}`
      : '- 今天（' + today + '）還沒有刷貼吧的場次',
    `- 今天的貼吧日報：${hasReport ? '已經產生' : '還沒有'}`,
    version ? `- 貼吧人設版本：v${version}${evolution?.lastDate ? `（最後更新 ${evolution.lastDate}）` : ''}` : '',
    `- 最後一次在貼吧回覆：${lastReplyAt ? `${stamp(lastReplyAt)}（${ago(lastReplyAt, now)}）` : '今天還沒回過帖'}`,
    '回答原則：對方若問「你剛剛有沒有刷貼吧」「今天刷了嗎」，照上面的時間照實回答；可以自然補一句你看到的內容或心情，但不要編造沒有發生的場次，也不要主動把這件事掛在嘴邊。',
  ].filter(Boolean)

  return lines.join('\n')
}
