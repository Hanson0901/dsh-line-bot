#!/usr/bin/env node
// dsh-line-bot 安裝小工具。
//
// 用法：
//   npx dsh-line-bot install [--profile <名稱>] [--version <版本>] [--dry-run]
//   npx dsh-line-bot uninstall [--profile <名稱>] [--dry-run]
//   npx dsh-line-bot status [--profile <名稱>]
//   npx dsh-line-bot doctor [--fix] [--json]
//
// 它做的事和 DSH 面板的「安裝 bundle」一樣：
//   1. 用 DSH 內建的 pnpm 把套件加進 profile；
//   2. 把套件名稱寫進 profile package.json 的 dsh.profile.bundles；
//   3. 提示重開 DSH。
// 不需要 DSH 正在執行；建議先關掉 DSH 再安裝，避免 node_modules 被同時使用。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import readline from 'node:readline/promises'

const IS_WIN = process.platform === 'win32'
import { fileURLToPath } from 'node:url'

import { whichCommand, scanLogForErrors, summarizeChecks, check } from '../lib/diagnostics.mjs'

const PKG = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const NAME = PKG.name || 'dsh-line-bot'

// 搭配的外掛：不裝也能用，但少掉某些功能。安裝時會偵測並詢問是否一起裝。
const COMPANIONS = [
  { name: 'dsh-persona-dafeiyu', label: '大肥魚人設', hint: '人設清單、貼吧同步（建議）' },
  { name: 'dsh-meme', label: '表情包圖庫', hint: '讓角色回圖片／貼圖（建議）' },
  { name: 'dsh-tieba-dive', label: '刷貼吧', hint: '貼吧學習同步的來源（可選）' },
]

function out(line = '') {
  process.stdout.write(`${line}\n`)
}
function fail(message) {
  process.stderr.write(`\n✖ ${message}\n`)
  process.exit(1)
}

function parseArgs(argv) {
  const options = { command: '', profile: '', version: '', spec: '', dryRun: false, enable: true, companions: 'ask', fix: false, json: false }
  const rest = [...argv]
  options.command = (rest.shift() || 'help').toLowerCase()
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]
    if (arg === '--profile' || arg === '-p') {
      options.profile = rest[index + 1] || ''
      index += 1
    } else if (arg.startsWith('--profile=')) {
      options.profile = arg.slice('--profile='.length)
    } else if (arg === '--version' || arg === '-v') {
      options.version = rest[index + 1] || ''
      index += 1
    } else if (arg.startsWith('--version=')) {
      options.version = arg.slice('--version='.length)
    } else if (arg === '--dry-run' || arg === '-n') {
      options.dryRun = true
    } else if (arg === '--spec') {
      options.spec = rest[index + 1] || ''
      index += 1
    } else if (arg.startsWith('--spec=')) {
      options.spec = arg.slice('--spec='.length)
    } else if (arg === '--no-enable') {
      options.enable = false
    } else if (arg === '--with-companions') {
      options.companions = 'yes'
    } else if (arg === '--no-companions') {
      options.companions = 'no'
    } else if (arg === '--fix') {
      options.fix = true
    } else if (arg === '--json') {
      options.json = true
    } else if (arg === '--help' || arg === '-h') {
      options.command = 'help'
    } else {
      fail(`不認得的參數：${arg}`)
    }
  }
  return options
}

function dshHome() {
  return process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(os.homedir(), '.dsh')
}

function listProfiles() {
  const dir = path.join(dshHome(), 'profiles')
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => fs.existsSync(path.join(dir, entry.name, 'package.json')))
    .map((entry) => entry.name)
    .sort()
}

function pickProfile(requested) {
  const wanted = requested || process.env.DSH_PROFILE || ''
  const profiles = listProfiles()
  if (wanted) {
    if (!profiles.includes(wanted)) {
      fail(`找不到 profile「${wanted}」。可用的 profile：${profiles.join('、') || '（沒有）'}`)
    }
    return wanted
  }
  for (const candidate of ['desktop', 'web', 'headless', 'tui']) {
    if (profiles.includes(candidate)) return candidate
  }
  if (profiles.length === 1) return profiles[0]
  fail(`偵測不到要安裝到哪個 profile，請加 --profile <名稱>。可用：${profiles.join('、') || '（沒有）'}`)
}

function profileDir(profile) {
  return path.join(dshHome(), 'profiles', profile)
}

function readManifest(profile) {
  const dir = profileDir(profile)
  const file = path.join(dir, 'package.json')
  if (!fs.existsSync(file)) fail(`profile 不存在：${dir}`)
  try {
    return { dir, file, manifest: JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch (error) {
    fail(`讀不懂 ${file}：${error.message}`)
  }
}

function writeManifestAtomic(file, manifest) {
  const backup = `${file}.bak-${Date.now()}`
  fs.copyFileSync(file, backup)
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`)
  fs.renameSync(tmp, file)
  return backup
}

function bundlesOf(manifest) {
  const bundles = manifest?.dsh?.profile?.bundles
  return Array.isArray(bundles) ? [...bundles] : []
}

function withBundle(manifest, enabled, name = NAME) {
  const bundles = bundlesOf(manifest)
  if (enabled) {
    if (!bundles.includes(name)) bundles.push(name)
  } else {
    const index = bundles.indexOf(name)
    if (index >= 0) bundles.splice(index, 1)
  }
  return {
    ...manifest,
    dsh: {
      ...(manifest.dsh || {}),
      profile: { ...(manifest.dsh?.profile || {}), bundles },
    },
  }
}

function windowsPnpmCandidates() {
  const roots = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'),
    process.env.PROGRAMFILES,
    process.env['PROGRAMFILES(X86)'],
  ].filter(Boolean)
  const suffix = ['resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs']
  const found = []
  for (const root of roots) {
    found.push(path.join(root, 'DeepSeek Harness', ...suffix))
    try {
      for (const name of fs.readdirSync(root)) {
        if (/deepseek/i.test(name)) found.push(path.join(root, name, ...suffix))
      }
    } catch {
      /* 目錄不存在就跳過 */
    }
  }
  return found
}

function findPnpm() {
  const localPnpm = process.platform === 'darwin'
    ? ['/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.cjs']
    : process.platform === 'win32'
      ? windowsPnpmCandidates()
      : []
  for (const candidate of localPnpm) {
    if (fs.existsSync(candidate)) return { kind: 'pnpm', command: process.execPath, prefix: [candidate], shell: false }
  }
  const pnpm = spawnSync('pnpm', ['--version'], { stdio: 'ignore', shell: IS_WIN })
  if (pnpm.status === 0) return { kind: 'pnpm', command: 'pnpm', prefix: [], shell: IS_WIN }
  return null
}

function findDsh() {
  const probe = spawnSync('dsh', ['--version'], { stdio: 'ignore', shell: IS_WIN })
  return probe.status === 0 ? { command: 'dsh', shell: IS_WIN } : null
}

function quoteWin(value) {
  return /[\s"]/.test(value) ? '"' + value.replace(/"/g, '\\"') + '"' : value
}

function spawnTool(tool, args, options) {
  if (!tool.shell) return spawnSync(tool.command, [...(tool.prefix || []), ...args], options)
  const line = [tool.command, ...args].map(quoteWin).join(' ')
  return spawnSync(line, { ...options, shell: true })
}

function runInstall(profile, versionSpec, { dryRun }) {
  const dir = profileDir(profile)
  const dsh = findDsh()
  let result
  if (dsh) {
    const args = ['plugin', '--profile', profile, 'add', versionSpec]
    out(`→ dsh ${args.join(' ')}`)
    if (!dryRun) result = spawnTool(dsh, args, { cwd: dir, stdio: 'inherit' })
  } else {
    const pnpm = findPnpm()
    if (!pnpm) {
      fail(
        IS_WIN
          ? '找不到 dsh 或 pnpm。請先安裝 DeepSeek Harness 桌面版（內含 pnpm），或先執行「npm install -g pnpm」再重試；也可以直接用面板「設定 → 外掛 → 安裝 bundle」。'
          : '找不到 dsh 或 pnpm。請先安裝 DeepSeek Harness 桌面版（內含 pnpm），或改用面板「設定 → 外掛 → 安裝」。',
      )
    }
    const args = [...(pnpm.prefix || []), 'add', versionSpec, '--dir', dir]
    out(`→ ${pnpm.command} ${args.join(' ')}`)
    if (!dryRun) result = spawnTool(pnpm, args, { cwd: dir, stdio: 'inherit' })
  }
  if (!dryRun && result && result.status !== 0) {
    fail(`安裝套件失敗（pnpm 結束碼 ${result.status}）。請確認網路與 ${dir} 的權限後重試。`)
  }
}

function companionMissing(profile, dir, manifest, name) {
  const deps = { ...(manifest.dependencies || {}), ...(manifest.devDependencies || {}) }
  if (deps[name]) return false
  if (bundlesOf(manifest).includes(name)) return false
  return !fs.existsSync(path.join(dir, 'node_modules', name, 'package.json'))
}

async function askYesNo(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question(question)).trim().toLowerCase()
    return answer === '' || answer === 'y' || answer === 'yes' || answer === '是'
  } finally {
    rl.close()
  }
}

function installCompanion(profile, name, options) {
  runInstall(profile, `${name}@latest`, options)
  if (options.dryRun) return
  const { file } = readManifest(profile)
  const current = readManifest(profile).manifest
  const next = withBundle(current, true, name)
  if (JSON.stringify(next) !== JSON.stringify(current)) {
    writeManifestAtomic(file, next)
    out(`✔ 已啟用 ${name}`)
  }
}

async function setupCompanions(profile, options) {
  const { dir, manifest } = readManifest(profile)
  const missing = COMPANIONS.filter((item) => companionMissing(profile, dir, manifest, item.name))
  if (missing.length === 0) {
    out('• 搭配外掛都已安裝。')
    return
  }
  out('')
  out('搭配外掛（可選，不裝也能用）：')
  for (const item of missing) out(`  • ${item.name} — ${item.label}：${item.hint}`)
  if (options.dryRun) {
    out(`→ 會詢問是否一起安裝 ${missing.map((item) => item.name).join('、')}`)
    return
  }
  let install = false
  if (options.companions === 'yes') install = true
  else if (options.companions === 'no') install = false
  else if (process.stdin.isTTY) install = await askYesNo('要一起安裝嗎？(Y/n) ')
  else {
    out('• 目前不是互動終端，略過搭配外掛；可加 --with-companions 一起安裝。')
    return
  }
  if (!install) {
    out('• 略過搭配外掛。之後可再跑 npx dsh-line-bot install --with-companions。')
    return
  }
  for (const item of missing) installCompanion(profile, item.name, options)
  out('✔ 搭配外掛安裝完成。')
}


async function httpJson(url, timeout = 45000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) })
  const body = await res.json().catch(() => null)
  if (!res.ok || !body?.ok) throw new Error(body?.error || `HTTP ${res.status}`)
  return body.value
}

function offlineDoctor(dataDir, reason) {
  const checks = []
  const configPath = path.join(dataDir, 'config.json')
  let config = null
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')) } catch { /* ignore */ }
  checks.push(check('config', '設定檔', config ? 'ok' : 'fail', config ? configPath : `找不到 ${configPath}`, config ? '' : '先在 DSH 面板安裝並啟動 dsh-line-bot'))
  if (config) {
    const line = config.line || {}
    checks.push(check('line-config', 'LINE 憑證', line.channelSecret || line.accessToken ? 'ok' : 'fail',
      line.channelSecret ? '已設定 Channel Secret' : line.accessToken ? '已設定 Access Token' : '沒有憑證',
      line.channelSecret || line.accessToken ? '' : '面板「LINE 憑證」填入 Channel ID／Secret 或 Access Token'))
    checks.push(check('server', 'Webhook 伺服器', 'warn', `無法連線（${reason}）`, '確認 DSH 正在執行、外掛已啟動；面板「狀態總覽」可看伺服器狀態'))
  }
  const home = dshHome()
  let memeFound = false
  try {
    for (const entry of fs.readdirSync(path.join(home, 'profiles'))) {
      const candidate = path.join(home, 'profiles', entry, 'node_modules', 'dsh-meme', 'package.json')
      if (fs.existsSync(candidate)) { memeFound = true; break }
    }
  } catch { /* ignore */ }
  checks.push(check('dsh-meme', 'dsh-meme 圖庫', memeFound ? 'ok' : 'fail',
    memeFound ? '已安裝' : '沒有在 profile 裡找到 dsh-meme',
    memeFound ? '' : 'npx dsh-line-bot install --with-companions'))
  const sips = whichCommand('sips')
  const ffmpeg = whichCommand('ffmpeg')
  checks.push(check('converters', '轉圖工具', (sips || ffmpeg) ? 'ok' : 'warn',
    `sips=${sips ? '有' : '無'} ffmpeg=${ffmpeg ? '有' : '無'}`,
    ffmpeg ? '' : '安裝 ffmpeg 以支援 GIF／webp 表情包'))
  const today = new Date().toISOString().slice(0, 10)
  const recent = scanLogForErrors(path.join(dataDir, 'logs', `${today}.log`))
  checks.push(check('logs', '最近錯誤', recent.length ? 'warn' : 'ok',
    recent.length ? recent[recent.length - 1].slice(0, 240) : '沒有最近錯誤',
    recent.length ? `看完整日誌：${path.join(dataDir, 'logs', `${today}.log`)}` : ''))
  return { version: PKG.version, at: Date.now(), offline: true, summary: summarizeChecks(checks), checks }
}

async function commandDoctor(options) {
  const home = dshHome()
  const dataDir = path.join(home, 'line-bot')
  let config = null
  try { config = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')) } catch { /* ignore */ }
  const port = Number(config?.server?.port) || 8791
  const url = `http://127.0.0.1:${port}/doctor${options.fix ? '?repair=1' : ''}`
  let result = null
  let reason = ''
  try {
    result = await httpJson(url)
  } catch (error) {
    reason = error?.message || String(error)
    result = offlineDoctor(dataDir, reason)
  }
  if (options.json) {
    out(JSON.stringify(result, null, 2))
    process.exitCode = result.summary?.fail ? 1 : 0
    return
  }
  const icon = { ok: '✅', warn: '⚠️ ', fail: '❌' }
  out(`dsh-line-bot ${result.version || PKG.version} 診斷${result.offline ? '（離線）' : ''}`)
  for (const item of result.checks) {
    out(`${icon[item.status] || '•'} ${item.title}：${item.detail}`)
    if (item.fix) out(`   → ${item.fix}`)
  }
  const summary = result.summary || summarizeChecks(result.checks)
  out(`\n結果：${summary.ok} 正常、${summary.warn} 提醒、${summary.fail} 失敗`)
  if (result.offline) {
    out('提示：伺服器在執行時，doctor 會自動測公開網址、webhook 與圖片可送達；修復請用 npx dsh-line-bot doctor --fix。')
  }
  process.exitCode = summary.fail ? 1 : 0
}

async function commandInstall(options) {
  const profile = pickProfile(options.profile)
  const { dir, file, manifest } = readManifest(profile)
  const versionSpec = options.spec || (options.version ? `${NAME}@${options.version}` : `${NAME}@${PKG.version}`)
  out('')
  out(`dsh-line-bot ${PKG.version}`)
  out(`profile：${profile}（${dir}）`)
  out(`套件：${versionSpec}`)
  if (options.dryRun) out('（dry-run：只顯示，不真的寫入）')
  out('')

  runInstall(profile, versionSpec, options)

  if (options.enable) {
    const next = withBundle(manifest, true)
    if (JSON.stringify(next) !== JSON.stringify(manifest)) {
      if (options.dryRun) {
        out(`→ 會把 ${NAME} 加進 ${file} 的 dsh.profile.bundles`)
      } else {
        const backup = writeManifestAtomic(file, next)
        out(`✔ 已啟用 bundle，原檔備份：${path.basename(backup)}`)
      }
    } else {
      out('• bundle 已經在啟用清單裡，略過。')
    }
  }

  await setupCompanions(profile, options)

  out('')
  out('完成。下一步：')
  out('  1. 完全結束並重開 DeepSeek Harness（桌面版請確認選單列沒有殘留）。')
  out('  2. 設定 → LINE Bot，填入 Channel ID / Channel Secret。')
  out('  3. 按「一鍵上線」，到 LINE 加 bot 好友測試。')
}

function commandUninstall(options) {
  const profile = pickProfile(options.profile)
  const { dir, file, manifest } = readManifest(profile)
  out('')
  out(`移除 dsh-line-bot（profile：${profile}）`)
  if (options.dryRun) out('（dry-run：只顯示，不真的寫入）')

  const next = withBundle(manifest, false)
  if (JSON.stringify(next) !== JSON.stringify(manifest)) {
    if (options.dryRun) out(`→ 會把 ${NAME} 從 ${file} 的 dsh.profile.bundles 移除`)
    else {
      const backup = writeManifestAtomic(file, next)
      out(`✔ 已從 bundle 清單移除，原檔備份：${path.basename(backup)}`)
    }
  }

  const dsh = findDsh()
  if (dsh) {
    const args = ['plugin', '--profile', profile, 'remove', NAME]
    out(`→ dsh ${args.join(' ')}`)
    if (!options.dryRun) {
      const result = spawnTool(dsh, args, { cwd: dir, stdio: 'inherit' })
      if (result.status !== 0) out('（pnpm 移除失敗，可能本來就沒安裝；bundle 清單已處理）')
    }
  } else {
    out('找不到 dsh 指令，請手動移除依賴，或用面板「外掛」卸載。')
  }

  out('')
  out('重開 DSH 後生效。設定檔與 LINE 憑證會留在 <DSH_HOME>/line-bot/，不會被刪除。')
}

function commandStatus(options) {
  const profile = pickProfile(options.profile)
  const { dir, manifest } = readManifest(profile)
  const dependency = manifest.dependencies?.[NAME] || manifest.devDependencies?.[NAME] || ''
  const enabled = bundlesOf(manifest).includes(NAME)
  out('')
  out(`dsh-line-bot ${PKG.version}`)
  out(`DSH_HOME：${dshHome()}`)
  out(`profile：${profile}（${dir}）`)
  out(`依賴：${dependency || '（未安裝）'}`)
  out(`bundle 啟用：${enabled ? '是' : '否'}`)
  const companions = COMPANIONS.map((item) => {
    const ok = !companionMissing(profile, dir, manifest, item.name)
    return `${item.name}${ok ? '（已安裝）' : '（未安裝）'}`
  })
  out(`搭配外掛：${companions.join('、')}`)
  if (fs.existsSync(path.join(dshHome(), 'line-bot', 'config.json'))) {
    out('設定檔：<DSH_HOME>/line-bot/config.json（已存在）')
  }
}

function commandHelp() {
  out('')
  out(`dsh-line-bot ${PKG.version} — 把 LINE Bot 裝進 DeepSeek Harness`)
  out('')
  out('用法：')
  out('  npx dsh-line-bot install     安裝並啟用（可加 --profile <名稱>）')
  out('  npx dsh-line-bot uninstall   移除')
  out('  npx dsh-line-bot status      看目前裝在哪個 profile')
  out('')
  out('選項：')
  out('  --profile, -p <名稱>   DSH profile（預設讀 DSH_PROFILE，否則 desktop）')
  out('  --version, -v <版本>   指定要安裝的版本（預設跟這個 CLI 相同）')
  out('  --spec <pnpm 規格>     直接指定套件規格，例如 github:Hanson0901/dsh-line-bot')
  out('  --no-enable            只安裝套件，不寫入 bundle 清單')
  out('  --with-companions      一起安裝搭配外掛（dsh-persona-dafeiyu、dsh-meme、dsh-tieba-dive）')
  out('  --no-companions        不詢問搭配外掛')
  out('  --dry-run, -n          只顯示會做什麼，不寫入')
  out('  --help, -h             顯示這段說明')
  out('')
  out('不用這個 CLI 也可以：DSH 設定 → 外掛 → 安裝 bundle，輸入 dsh-line-bot。')
}

const options = parseArgs(process.argv.slice(2))
switch (options.command) {
  case 'install':
  case 'add':
    await commandInstall(options)
    break
  case 'uninstall':
  case 'remove':
    commandUninstall(options)
    break
  case 'doctor':
  case 'diagnose':
    await commandDoctor(options)
    break
  case 'status':
  case 'list':
    commandStatus(options)
    break
  case 'help':
  case '--help':
    commandHelp()
    break
  default:
    commandHelp()
    process.exitCode = 1
}
