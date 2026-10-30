#!/usr/bin/env node
// dsh-line-bot 安裝小工具。
//
// 用法：
//   npx dsh-line-bot install [--profile <名稱>] [--version <版本>] [--dry-run]
//   npx dsh-line-bot uninstall [--profile <名稱>] [--dry-run]
//   npx dsh-line-bot status [--profile <名稱>]
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
import { fileURLToPath } from 'node:url'

const PKG = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const NAME = PKG.name || 'dsh-line-bot'

function out(line = '') {
  process.stdout.write(`${line}\n`)
}
function fail(message) {
  process.stderr.write(`\n✖ ${message}\n`)
  process.exit(1)
}

function parseArgs(argv) {
  const options = { command: '', profile: '', version: '', dryRun: false, enable: true }
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
    } else if (arg === '--no-enable') {
      options.enable = false
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

function withBundle(manifest, enabled) {
  const bundles = bundlesOf(manifest)
  if (enabled) {
    if (!bundles.includes(NAME)) bundles.push(NAME)
  } else {
    const index = bundles.indexOf(NAME)
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

function findPnpm() {
  const localPnpm = process.platform === 'darwin'
    ? '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.cjs'
    : ''
  if (localPnpm && fs.existsSync(localPnpm)) return { kind: 'pnpm', command: process.execPath, prefix: [localPnpm] }
  const pnpm = spawnSync('pnpm', ['--version'], { stdio: 'ignore' })
  if (pnpm.status === 0) return { kind: 'pnpm', command: 'pnpm', prefix: [] }
  return null
}

function findDsh() {
  const probe = spawnSync('dsh', ['--version'], { stdio: 'ignore' })
  return probe.status === 0 ? 'dsh' : ''
}

function runInstall(profile, versionSpec, { dryRun }) {
  const dir = profileDir(profile)
  const dsh = findDsh()
  let result
  if (dsh) {
    const args = ['plugin', '--profile', profile, 'add', versionSpec]
    out(`→ ${dsh} ${args.join(' ')}`)
    if (!dryRun) result = spawnSync(dsh, args, { cwd: dir, stdio: 'inherit' })
  } else {
    const pnpm = findPnpm()
    if (!pnpm) {
      fail(
        '找不到 dsh 或 pnpm。請先安裝 DeepSeek Harness 桌面版（內含 pnpm），或改用面板「設定 → 外掛 → 安裝」。',
      )
    }
    const args = [...pnpm.prefix, 'add', versionSpec, '--dir', dir]
    out(`→ ${pnpm.command} ${args.join(' ')}`)
    if (!dryRun) result = spawnSync(pnpm.command, args, { cwd: dir, stdio: 'inherit' })
  }
  if (!dryRun && result && result.status !== 0) {
    fail(`安裝套件失敗（pnpm 結束碼 ${result.status}）。請確認網路與 ${dir} 的權限後重試。`)
  }
}

function commandInstall(options) {
  const profile = pickProfile(options.profile)
  const { dir, file, manifest } = readManifest(profile)
  const versionSpec = options.version ? `${NAME}@${options.version}` : `${NAME}@${PKG.version}`
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
    out(`→ ${dsh} ${args.join(' ')}`)
    if (!options.dryRun) {
      const result = spawnSync(dsh, args, { cwd: dir, stdio: 'inherit' })
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
  out('  --no-enable            只安裝套件，不寫入 bundle 清單')
  out('  --dry-run, -n          只顯示會做什麼，不寫入')
  out('  --help, -h             顯示這段說明')
  out('')
  out('不用這個 CLI 也可以：DSH 設定 → 外掛 → 安裝 bundle，輸入 dsh-line-bot。')
}

const options = parseArgs(process.argv.slice(2))
switch (options.command) {
  case 'install':
  case 'add':
    commandInstall(options)
    break
  case 'uninstall':
  case 'remove':
    commandUninstall(options)
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
