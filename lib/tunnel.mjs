// Cloudflare Tunnel 管理：快速隧道（trycloudflare.com）與 API Token 具名隧道。
// 子程序用 cloudflared，binary 會自動找；找不到就從官方 GitHub Release 下載到插件資料夾。
import { spawn, execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
// 這一層也要跟著 dev/reload 的 ?v 走，否則改 cloudflare.mjs 之後 ESM 會拿舊的快取。
const LOAD_VERSION = new URL(import.meta.url).searchParams.get('v') || ''
const cf = await import(LOAD_VERSION ? `./cloudflare.mjs?v=${LOAD_VERSION}` : './cloudflare.mjs')
import { clip, sleep } from './util.mjs'
import { resolveCname } from 'node:dns/promises'

const QUICK_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/g

function binaryName() {
  return process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
}

function candidateNames() {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64'
      ? ['cloudflared-darwin-arm64.tgz']
      : ['cloudflared-darwin-amd64.tgz']
  }
  if (process.platform === 'linux') {
    return process.arch === 'arm64' ? ['cloudflared-linux-arm64'] : ['cloudflared-linux-amd64']
  }
  if (process.platform === 'win32') return ['cloudflared-windows-amd64.exe']
  return []
}

function isExecutable(file) {
  try {
    const st = fs.statSync(file)
    if (!st.isFile()) return false
    if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function findOnPath(name) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    const file = path.join(dir, name)
    if (isExecutable(file)) return file
  }
  return ''
}

function resolveBinary(cfg, dataDir) {
  const explicit = cfg.tunnel?.binaryPath ? String(cfg.tunnel.binaryPath).replace(/^~(?=$|\/)/, os.homedir()) : ''
  if (explicit && isExecutable(explicit)) return explicit
  const local = path.join(dataDir, 'bin', binaryName())
  if (isExecutable(local)) return local
  for (const fallback of ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared']) {
    if (isExecutable(fallback)) return fallback
  }
  return findOnPath(binaryName())
}

async function execVersion(binary) {
  return new Promise((resolve) => {
    execFile(binary, ['--version'], { timeout: 8000 }, (error, stdout, stderr) => {
      if (error) return resolve('')
      resolve(String(stdout || stderr || '').trim().split('\n')[0])
    })
  })
}

export function createTunnelManager({ getConfig, patchConfig, logger, dataDir, onUrl, onPhase }) {
  const state = {
    phase: 'stopped', // stopped | starting | running | external | error
    mode: '',
    url: '',
    error: '',
    pid: 0,
    startedAt: 0,
    tail: [],
    downloads: '',
    lastExit: null,
  }
  let child = null
  let stopping = false
  let restartTimer = null
  let restartAttempts = 0
  let binaryVersion = ''
  let binaryVersionPath = ''

  function binary() {
    return resolveBinary(getConfig(), dataDir)
  }

  function push(line) {
    const text = String(line || '').trim()
    if (!text) return
    state.tail.push(`${new Date().toISOString().slice(11, 19)} ${clip(text, 500)}`)
    if (state.tail.length > 120) state.tail.splice(0, state.tail.length - 120)
  }

  function setPhase(phase, error = '') {
    state.phase = phase
    state.error = error
    onPhase?.(status())
  }

  async function ensureBinary() {
    const found = binary()
    if (found) {
      if (binaryVersionPath !== found) {
        binaryVersion = await execVersion(found)
        binaryVersionPath = found
      }
      return found
    }
    throw new Error('找不到 cloudflared：請在面板按「下載 cloudflared」，或指定既有執行檔路徑')
  }

  async function download() {
    if (state.downloads) throw new Error('cloudflared 正在下載中')
    const names = candidateNames()
    if (names.length === 0) throw new Error(`不支援的平台：${process.platform}/${process.arch}`)
    const fileName = names[0]
    const binDir = path.join(dataDir, 'bin')
    fs.mkdirSync(binDir, { recursive: true })
    state.downloads = '正在連線 GitHub Release…'
    push(state.downloads)
    const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${fileName}`
    try {
      const res = await fetch(url, { redirect: 'follow' })
      if (!res.ok || !res.body) throw new Error(`下載失敗：HTTP ${res.status}`)
      if (fileName.endsWith('.tgz')) {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudflared-'))
        const tgz = path.join(tmpDir, fileName)
        state.downloads = `下載中（${fileName}）…`
        await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tgz))
        const target = path.join(binDir, binaryName())
        await new Promise((resolve, reject) => {
          execFile('tar', ['-xzf', tgz, '-C', binDir], { timeout: 120000 }, (error) => (error ? reject(error) : resolve()))
        })
        try {
          fs.chmodSync(target, 0o755)
        } catch {
          /* windows 不需要 */
        }
        fs.rmSync(tmpDir, { recursive: true, force: true })
        if (!isExecutable(target)) throw new Error('解壓後找不到 cloudflared 執行檔')
      } else {
        const target = path.join(binDir, binaryName())
        state.downloads = `下載中（${fileName}）…`
        await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(target))
        try {
          fs.chmodSync(target, 0o755)
        } catch {
          /* ignore */
        }
      }
      state.downloads = ''
      binaryVersionPath = ''
      const version = await execVersion(binary())
      push(`cloudflared 下載完成：${version || fileName}`)
      return { path: binary(), version }
    } catch (error) {
      state.downloads = ''
      push(`下載失敗：${error?.message || error}`)
      throw error
    }
  }

  function attach(childProcess) {
    const onData = (chunk) => {
      const text = chunk.toString('utf8')
      for (const line of text.split('\n')) push(line)
      const urls = text.match(QUICK_URL_RE)
      if (urls && urls.length > 0) {
        const url = urls[0]
        if (url !== state.url) {
          state.url = url
          setPhase('running')
          // quick tunnel 每次重啟網址都會變，交給 host 重新設 webhook
          Promise.resolve(onUrl?.(url)).catch((error) => logger?.warn?.(`設定 webhook 失敗：${error?.message || error}`))
        }
      }
    }
    childProcess.stdout?.on('data', onData)
    childProcess.stderr?.on('data', onData)
    childProcess.on('exit', (code, signal) => {
      state.lastExit = { code, signal, at: Date.now() }
      child = null
      state.pid = 0
      if (stopping) {
        setPhase('stopped')
        return
      }
      const wasRunning = state.phase === 'running' || state.phase === 'starting'
      setPhase('error', `cloudflared 結束（code ${code ?? signal}）`)
      const cfg = getConfig()
      if (wasRunning && cfg.tunnel.autoRestart && restartAttempts < 6) {
        restartAttempts += 1
        const delay = Math.min(60000, 5000 * restartAttempts)
        logger?.warn?.(`cloudflared 意外結束，${Math.round(delay / 1000)} 秒後重啟（第 ${restartAttempts} 次）`)
        clearTimeout(restartTimer)
        restartTimer = setTimeout(() => {
          restartTimer = null
          if (!stopping) start().catch((error) => logger?.error?.(`自動重啟失敗：${error?.message || error}`))
        }, delay)
        if (typeof restartTimer.unref === 'function') restartTimer.unref()
      }
    })
  }

  async function startQuick() {
    const bin = await ensureBinary()
    const port = getConfig().server.port
    const args = ['--no-autoupdate', 'tunnel', '--url', `http://127.0.0.1:${port}`]
    state.mode = 'quick'
    state.url = ''
    state.tail = []
    state.startedAt = Date.now()
    setPhase('starting')
    push(`啟動快速隧道 → http://127.0.0.1:${port}`)
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
    child = proc
    state.pid = proc.pid || 0
    attach(proc)
    const ok = await waitFor(() => state.phase === 'running' && state.url, 60000)
    if (!ok) {
      if (state.phase !== 'error') setPhase('error', '等待 trycloudflare 網址逾時（60 秒）')
      throw new Error(state.error || '快速隧道啟動逾時')
    }
    return state.url
  }

  async function startApi() {
    const cfg = getConfig()
    const { apiToken, accountId, tunnelId } = cfg.cloudflare
    const hostname = String(cfg.cloudflare.hostname || cfg.tunnel.hostname || '').trim()
    if (!apiToken) throw new Error('API Token 模式需要 Cloudflare API Token')
    if (!accountId) throw new Error('API Token 模式需要 Account ID（可先按「驗證 Token」自動帶入）')
    if (!tunnelId) throw new Error('尚未建立具名隧道：請先按「建立／更新隧道」')
    if (!hostname) throw new Error('API Token 模式需要主機名稱（例如 line.example.com）')
    const tunnelToken = await cf.getTunnelToken(apiToken, accountId, tunnelId)
    if (!tunnelToken) throw new Error('拿不到 tunnel token')
    const bin = await ensureBinary()
    state.mode = 'api'
    state.url = `https://${hostname}`
    state.tail = []
    state.startedAt = Date.now()
    setPhase('starting')
    push(`啟動具名隧道 ${hostname} → http://127.0.0.1:${cfg.server.port}`)
    const proc = spawn(bin, ['--no-autoupdate', 'tunnel', 'run', '--token', tunnelToken], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    child = proc
    state.pid = proc.pid || 0
    attach(proc)
    await waitFor(
      () => /Registered tunnel connection|Connection [0-9a-f-]+ registered/i.test(state.tail.join('\n')),
      45000,
    )
    if (state.phase !== 'running') setPhase('running')
    Promise.resolve(onUrl?.(state.url)).catch((error) => logger?.warn?.(`設定 webhook 失敗：${error?.message || error}`))
    return state.url
  }

  async function start() {
    if (child) return state.url
    clearTimeout(restartTimer)
    restartTimer = null
    stopping = false
    const cfg = getConfig()
    const publicUrl = String(cfg.tunnel.publicUrl || '').trim()
    if (publicUrl) {
      state.mode = 'external'
      state.url = publicUrl.replace(/\/$/, '')
      state.error = ''
      state.startedAt = Date.now()
      setPhase('external')
      push(`使用自訂公開位址：${state.url}`)
      Promise.resolve(onUrl?.(state.url)).catch(() => {})
      return state.url
    }
    if (cfg.tunnel.mode === 'api') return startApi()
    return startQuick()
  }

  async function stop({ silent = false } = {}) {
    stopping = true
    clearTimeout(restartTimer)
    restartTimer = null
    const proc = child
    if (!proc) {
      setPhase('stopped')
      return { stopped: true }
    }
    if (!silent) push('停止 tunnel…')
    try {
      proc.kill('SIGTERM')
    } catch {
      /* 已經結束 */
    }
    const exited = await waitFor(() => child === null, 5000)
    if (!exited) {
      try {
        proc.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      await waitFor(() => child === null, 3000)
    }
    setPhase('stopped')
    state.url = ''
    restartAttempts = 0
    return { stopped: true }
  }

  async function restart() {
    await stop({ silent: true })
    stopping = false
    return start()
  }

  /** 用 API Token 建立/更新具名隧道（含 ingress 與 DNS）。 */
  async function provision(payload = {}) {
    const cfg = getConfig()
    const apiToken = String(payload.apiToken || cfg.cloudflare.apiToken || '').trim()
    if (!apiToken) throw new Error('請先填入 Cloudflare API Token')
    const info = await cf.verifyAndDescribe(apiToken)
    let accountId = String(payload.accountId || cfg.cloudflare.accountId || '').trim()
    if (!accountId) {
      const accounts = info.accounts || []
      if (accounts.length === 1) accountId = accounts[0].id
      else if (accounts.length === 0) throw new Error('這個 token 看不到任何帳號，請確認權限（Account: Cloudflare Tunnel: Edit）')
      else throw new Error(`這個 token 看得到多個帳號（${accounts.length}），請在面板指定 Account ID`)
    }
    const hostname = String(payload.hostname || cfg.cloudflare.hostname || cfg.tunnel.hostname || '').trim()
    if (!hostname) throw new Error('請填寫要綁定的主機名稱（例如 line.example.com）')
    let zoneId = String(payload.zoneId || cfg.cloudflare.zoneId || '').trim()
    if (!zoneId) {
      const zone = cf.pickZoneForHostname(info.zones, hostname)
      if (!zone) throw new Error(`找不到 ${hostname} 對應的 Cloudflare zone：請確認網域在同一个 token 可見的帳號下`)
      zoneId = zone.id
    }
    const tunnelName = String(payload.tunnelName || cfg.cloudflare.tunnelName || 'dsh-line-bot').trim()
    let tunnel = cfg.cloudflare.tunnelId
      ? { id: cfg.cloudflare.tunnelId, name: tunnelName }
      : await cf.findTunnel(apiToken, accountId, tunnelName)
    if (!tunnel || !tunnel.id) tunnel = await cf.createTunnel(apiToken, accountId, tunnelName)
    if (!tunnel?.id) throw new Error('建立 tunnel 失敗：Cloudflare 沒有回傳 id')
    // 先把 tunnel 資訊落地：如果後面 DNS 因為權限失敗，重試時才不會又建一個新 tunnel。
    patchConfig({
      cloudflare: { apiToken, accountId, zoneId, hostname, tunnelId: tunnel.id, tunnelName },
    })
    const service = String(payload.service || `http://127.0.0.1:${cfg.server.port}`)
    await cf.setTunnelIngress(apiToken, accountId, tunnel.id, hostname, service)
    const dnsTarget = `${tunnel.id}.cfargotunnel.com`
    let dns = { ok: false, created: false, manual: false, error: '' }
    try {
      await cf.upsertCname(apiToken, zoneId, hostname, tunnel.id)
      dns = { ok: true, created: true, manual: false, error: '' }
    } catch (error) {
      let records = []
      try {
        records = await resolveCname(hostname)
      } catch {
        records = []
      }
      const resolved = records.map((item) => String(item).toLowerCase())
      if (resolved.some((item) => item.includes(dnsTarget.toLowerCase()))) {
        dns = { ok: true, created: false, manual: true, error: '' }
        info.warnings.push(`DNS 已由外部建立：${hostname} → ${dnsTarget}`)
      } else {
        dns = { ok: false, created: false, manual: false, error: error?.message || String(error) }
        info.warnings.push(
          `DNS 還沒建立。到 Cloudflare 該網域的 DNS 頁面新增一筆 CNAME：名稱 ${hostname.split('.')[0]}、目標 ${dnsTarget}、Proxied 開啟；或給 token 加上 Zone → DNS → Edit 後再按一次。`,
        )
      }
    }
    const url = `https://${hostname}`
    if (dns.ok) {
      patchConfig({
        cloudflare: {
          apiToken,
          accountId,
          zoneId,
          hostname,
          tunnelId: tunnel.id,
          tunnelName,
          verified: true,
        },
        tunnel: { hostname, mode: 'api' },
      })
      push(`具名隧道就緒：${url}`)
    }
    return {
      url,
      ready: dns.ok,
      dns,
      accountId,
      zoneId,
      hostname,
      tunnelId: tunnel.id,
      tunnelName,
      warnings: info.warnings,
    }
  }

  async function status() {
    let pathOnDisk = ''
    try {
      pathOnDisk = binary()
    } catch {
      pathOnDisk = ''
    }
    if (pathOnDisk && binaryVersionPath !== pathOnDisk) {
      binaryVersionPath = pathOnDisk
      binaryVersion = await execVersion(pathOnDisk).catch(() => '')
    }
    const cfg = getConfig()
    return {
      phase: state.phase,
      mode: state.mode || cfg.tunnel.mode,
      url: state.url,
      error: state.error,
      pid: state.pid,
      startedAt: state.startedAt,
      tail: state.tail.slice(-80),
      downloads: state.downloads,
      lastExit: state.lastExit,
      binary: { path: pathOnDisk, version: binaryVersion, ok: Boolean(pathOnDisk) },
      publicUrl: cfg.tunnel.publicUrl,
      hostname: cfg.cloudflare.hostname || cfg.tunnel.hostname,
      cloudflare: {
        hasApiToken: Boolean(cfg.cloudflare.apiToken),
        verified: Boolean(cfg.cloudflare.verified),
        accountId: cfg.cloudflare.accountId,
        zoneId: cfg.cloudflare.zoneId,
        tunnelId: cfg.cloudflare.tunnelId,
        tunnelName: cfg.cloudflare.tunnelName,
      },
    }
  }

  return { start, stop, restart, provision, download, status, binary }

  async function waitFor(predicate, timeoutMs) {
    const started = Date.now()
    for (;;) {
      try {
        if (predicate()) return true
      } catch {
        /* ignore */
      }
      if (Date.now() - started >= timeoutMs) return false
      await sleep(250)
    }
  }
}
