import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)

export const MLX_MODEL = 'mlx-community/Fun-CosyVoice3-0.5B-2512-8bit'
export const GGUF_BACKEND = 'cosyvoice3-tts'
export const CRISPASR_VERSION = 'v0.8.49'
export const DEFAULT_INSTRUCT = '用可愛、輕快、帶點撒嬌的語氣說，語速稍慢。'

const CRISPASR_MAC_URL = `https://github.com/CrispStrobe/CrispASR/releases/download/${CRISPASR_VERSION}/crispasr-macos-arm64.tar.gz`
const CRISPASR_WIN_URL = `https://github.com/CrispStrobe/CrispASR/releases/download/${CRISPASR_VERSION}/crispasr-windows-x86_64-cpu.zip`

function isWin() {
  return process.platform === 'win32'
}

function which(command) {
  try {
    const out = execFileSync(isWin() ? 'where' : 'which', [command], { encoding: 'utf8', timeout: 4000 })
    return String(out).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] || ''
  } catch {
    return ''
  }
}

function fileExists(file) {
  try {
    return fs.existsSync(file)
  } catch {
    return false
  }
}

function dirExists(dir) {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

function pythonVersion(python) {
  try {
    const out = execFileSync(python, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], {
      encoding: 'utf8',
      timeout: 6000,
      env: process.env,
    }).trim()
    const [major, minor] = out.split('.').map((value) => Number(value))
    return { text: out, major, minor }
  } catch {
    return { text: '', major: 0, minor: 0 }
  }
}

function parseDurationSeconds(text) {
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(text || ''))
  if (!match) return 0
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

export function createTts({ dir, logger, getConfig }) {
  const root = path.join(dir, 'tts')
  const paths = {
    root,
    refDir: path.join(root, 'ref'),
    outDir: path.join(root, 'out'),
    jobsDir: path.join(root, 'jobs'),
    hfHome: path.join(root, 'hf'),
    mlxVenv: path.join(root, 'mlx312-venv'),
    mlxPython: path.join(root, 'mlx312-venv', 'bin', 'python'),
    mlxScript: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'mlx_synth.py'),
    macCrisp: path.join(root, 'crispasr', 'crispasr-macos-arm64', 'crispasr'),
    winCrisp: path.join(root, 'crispasr', 'windows', 'crispasr.exe'),
    winDir: path.join(root, 'crispasr', 'windows'),
    defaultRef: path.join(root, 'ref', 'default.wav'),
  }
  for (const item of [paths.root, paths.refDir, paths.outDir, paths.jobsDir, paths.hfHome]) {
    try {
      fs.mkdirSync(item, { recursive: true })
    } catch {
      /* 權限不足時留給 status 回報 */
    }
  }

  const state = {
    setup: { phase: 'idle', message: '', error: '', at: 0, startedAt: 0 },
    last: null,
    lastError: '',
    installing: false,
  }

  function setSetup(phase, message, error = '') {
    state.setup = {
      phase,
      message,
      error: error ? String(error).slice(0, 800) : '',
      at: Date.now(),
      startedAt: state.setup.startedAt || Date.now(),
    }
    if (logger) {
      if (error) logger.warn(`語音環境：${message}（${String(error).slice(0, 200)}）`)
      else logger.info(`語音環境：${message}`)
    }
  }

  function cfgVoice() {
    const cfg = getConfig ? getConfig() : {}
    return cfg.voice || {}
  }

  function referencePath() {
    const cfg = cfgVoice()
    const configured = String(cfg.referencePath || '').trim()
    if (configured && fileExists(configured)) return configured
    if (fileExists(paths.defaultRef)) return paths.defaultRef
    return ''
  }

  function referenceInfo() {
    const file = referencePath()
    if (!file) return { path: '', exists: false, seconds: 0 }
    let seconds = 0
    try {
      const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], {
        encoding: 'utf8',
        timeout: 8000,
      })
      seconds = Number(out.trim()) || 0
    } catch {
      seconds = 0
    }
    return { path: file, exists: true, seconds: Math.round(seconds * 100) / 100 }
  }

  function mlxModelCached() {
    const hub = path.join(paths.hfHome, 'hub')
    try {
      const dirs = fs.readdirSync(hub).filter((name) => name.startsWith('models--mlx-community--Fun-CosyVoice3'))
      for (const name of dirs) {
        const snapshots = path.join(hub, name, 'snapshots')
        if (!dirExists(snapshots)) continue
        for (const snap of fs.readdirSync(snapshots)) {
          if (fileExists(path.join(snapshots, snap, 'model.safetensors'))) return true
        }
      }
    } catch {
      /* ignore */
    }
    return false
  }

  let mlxError = ''
  function mlxReady() {
    if (!fileExists(paths.mlxPython)) {
      mlxError = '找不到 MLX Python 環境'
      return false
    }
    if (!fileExists(paths.mlxScript)) {
      mlxError = `找不到 MLX 合成腳本：${paths.mlxScript}`
      return false
    }
    try {
      execFileSync(paths.mlxPython, ['-c', 'import mlx_audio, mlx_lm, librosa'], { stdio: 'ignore', timeout: 30000 })
      mlxError = ''
      return true
    } catch (error) {
      mlxError = String(error?.stderr || error?.message || error).slice(0, 300)
      return false
    }
  }

  function ggufBinary() {
    const candidates = [isWin() ? paths.winCrisp : paths.macCrisp, which('crispasr')]
    return candidates.find((item) => item && fileExists(item)) || ''
  }

  function ggufReady() {
    const bin = ggufBinary()
    if (!bin) return false
    try {
      execFileSync(bin, ['--version'], { stdio: 'ignore', timeout: 8000 })
      return true
    } catch {
      return false
    }
  }

  function detect() {
    const platform = process.platform
    const arch = process.arch
    const preferred = platform === 'darwin' && arch === 'arm64' ? 'mlx' : 'gguf'
    const ffmpeg = which('ffmpeg')
    const ref = referenceInfo()
    return {
      platform,
      arch,
      preferred,
      ffmpeg: { path: ffmpeg, ok: !!ffmpeg },
      mlx: {
        ok: mlxReady(),
        python: fileExists(paths.mlxPython) ? paths.mlxPython : '',
        model: MLX_MODEL,
        modelCached: mlxModelCached(),
        error: mlxError,
        script: paths.mlxScript,
      },
      gguf: {
        ok: ggufReady(),
        binary: ggufBinary(),
        backend: GGUF_BACKEND,
      },
      reference: ref,
      setup: state.setup,
      ready: (preferred === 'mlx' ? mlxReady() : ggufReady()) && !!ref.path,
    }
  }

  function resolveProvider(cfg = cfgVoice()) {
    const detected = detect()
    const wanted = String(cfg.provider || 'auto')
    if (wanted === 'mlx') {
      if (!detected.mlx.ok) throw new Error('MLX 語音環境還沒安裝完成，請先按「一鍵配置環境」')
      return 'mlx'
    }
    if (wanted === 'gguf') {
      if (!detected.gguf.ok) throw new Error('CosyVoice GGUF 引擎還沒安裝完成，請先按「一鍵配置環境」')
      return 'gguf'
    }
    if (detected.mlx.ok && (detected.platform === 'darwin' || detected.preferred === 'mlx')) return 'mlx'
    if (detected.gguf.ok) return 'gguf'
    if (detected.mlx.ok) return 'mlx'
    throw new Error('還沒有可用的語音引擎，請先按「一鍵配置環境」')
  }

  async function run(command, args, { env = process.env, timeout = 180000, maxBuffer = 20 * 1024 * 1024 } = {}) {
    return execFileAsync(command, args, { env, timeout, maxBuffer })
  }

  function findPython() {
    const candidates = [
      process.env.LINEBOT_MLX_PYTHON,
      '/opt/homebrew/opt/python@3.12/bin/python3.12',
      '/opt/homebrew/bin/python3.12',
      '/usr/local/bin/python3.12',
      '/opt/homebrew/bin/python3.11',
      '/usr/local/bin/python3.11',
    ].filter(Boolean)
    for (const candidate of candidates) {
      if (!fileExists(candidate)) continue
      const version = pythonVersion(candidate)
      if (version.major > 3 || (version.major === 3 && version.minor >= 10)) return candidate
    }
    const system = which('python3')
    if (system && !system.includes('DeepSeek Harness.app')) {
      const version = pythonVersion(system)
      if (version.major > 3 || (version.major === 3 && version.minor >= 10)) return system
    }
    return ''
  }

  function uvCommand() {
    const candidates = [path.join(os.homedir(), '.local', 'bin', 'uv'), '/opt/homebrew/bin/uv', which('uv')].filter(Boolean)
    return candidates.find((item) => fileExists(item)) || ''
  }

  async function installMlx() {
    setSetup('python', '檢查 Python（MLX 需要 3.10 以上）')
    let python = findPython()
    if (!python) {
      const brew = which('brew')
      if (!brew) throw new Error('找不到 Python 3.10 以上，也找不到 Homebrew。請先安裝 Python 3.12。')
      setSetup('python', '用 Homebrew 安裝 Python 3.12（第一次會比較久）')
      await run(brew, ['install', 'python@3.12'], { timeout: 1200000 })
      python = findPython()
    }
    if (!python) throw new Error('找不到可用的 Python 3.10 以上')

    if (!fileExists(paths.mlxPython)) {
      setSetup('venv', '建立 MLX 專用 Python 環境')
      await run(python, ['-m', 'venv', paths.mlxVenv], { timeout: 120000 })
    } else {
      setSetup('venv', 'MLX Python 環境已存在')
    }

    const uv = uvCommand()
    const pipBase = uv ? [uv, 'pip', 'install', '--python', paths.mlxPython] : [paths.mlxPython, '-m', 'pip', 'install']
    setSetup('pip', '安裝 MLX 語音套件（mlx-audio-plus）')
    const packages = ['mlx-audio-plus==0.1.7', 'mlx-lm==0.29.1', 'librosa', 'pyloudnorm', 'soundfile']
    await run(pipBase[0], [...pipBase.slice(1), ...packages], { timeout: 1800000, env: { ...process.env, HF_HOME: paths.hfHome } })

    if (!mlxModelCached()) {
      setSetup('model', '下載 CosyVoice3-0.5B 模型（約 1.4GB，第一次會比較久）')
      const downloader = [
        'from huggingface_hub import snapshot_download',
        `snapshot_download(${JSON.stringify(MLX_MODEL)}, cache_dir=${JSON.stringify(path.join(paths.hfHome, 'hub'))})`,
      ].join('\n')
      await run(paths.mlxPython, ['-c', downloader], {
        timeout: 3600000,
        env: { ...process.env, HF_HOME: paths.hfHome },
      })
    } else {
      setSetup('model', 'MLX 模型已下載')
    }
    if (!mlxReady()) throw new Error('MLX 套件安裝後仍無法載入，請查看日誌')
    return 'mlx'
  }

  async function downloadFile(url, target) {
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok) throw new Error(`下載失敗（HTTP ${res.status}）：${url}`)
    const bytes = Buffer.from(await res.arrayBuffer())
    fs.writeFileSync(target, bytes)
  }

  async function installMacGguf() {
    setSetup('engine', '下載 CosyVoice GGUF 引擎（macOS 備援）')
    const target = path.join(root, 'crispasr')
    fs.mkdirSync(target, { recursive: true })
    const tgz = path.join(root, 'crispasr-macos-arm64.tar.gz')
    await downloadFile(CRISPASR_MAC_URL, tgz)
    await run('tar', ['-xzf', tgz, '-C', target], { timeout: 180000 })
    if (!fileExists(paths.macCrisp)) throw new Error('解壓縮後找不到 crispasr 執行檔')
    fs.chmodSync(paths.macCrisp, 0o755)
    return 'gguf'
  }

  async function installWinGguf() {
    setSetup('engine', '下載 CosyVoice GGUF 引擎（Windows）')
    fs.mkdirSync(paths.winDir, { recursive: true })
    const zip = path.join(root, 'crispasr-windows.zip')
    await downloadFile(CRISPASR_WIN_URL, zip)
    await run('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath ${JSON.stringify(zip)} -DestinationPath ${JSON.stringify(paths.winDir)} -Force`], { timeout: 300000 })
    const found = []
    for (const name of fs.readdirSync(paths.winDir)) {
      const full = path.join(paths.winDir, name)
      if (/crispasr(\.exe)?$/i.test(name)) found.push(full)
      if (dirExists(full)) {
        for (const sub of fs.readdirSync(full)) {
          if (/^crispasr(\.exe)?$/i.test(sub)) found.push(path.join(full, sub))
        }
      }
    }
    if (!found[0]) throw new Error('解壓縮後找不到 crispasr.exe')
    if (found[0] !== paths.winCrisp) fs.copyFileSync(found[0], paths.winCrisp)
    return 'gguf'
  }

  async function ensureDefaultReference() {
    setSetup('reference', '準備預設參考音')
    if (fileExists(paths.defaultRef)) return paths.defaultRef
    const cfg = cfgVoice()
    let source = String(cfg.referenceSource || '').trim()
    if (!source || !fileExists(source)) {
      const downloads = path.join(os.homedir(), 'Downloads')
      try {
        const hit = fs.readdirSync(downloads).find((name) => name.includes('本间心铃'))
        if (hit) source = path.join(downloads, hit)
      } catch {
        /* no Downloads */
      }
    }
    if (!source || !fileExists(source)) {
      if (fileExists(paths.defaultRef)) return paths.defaultRef
      throw new Error('找不到預設參考音，請在面板上傳一段聲音檔')
    }
    const ffmpeg = which('ffmpeg')
    if (!ffmpeg) throw new Error('需要 ffmpeg 才能處理參考音，請先安裝 ffmpeg')
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '12', '-t', '4.2', '-i', source, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', paths.defaultRef], { timeout: 120000 })
    return paths.defaultRef
  }

  async function install() {
    if (state.installing) return { started: false, already: true }
    state.installing = true
    state.setup.startedAt = Date.now()
    setSetup('detect', '偵測系統環境')
    try {
      const detected = detect()
      let provider = ''
      if (detected.platform === 'darwin' && detected.arch === 'arm64') {
        try {
          provider = await installMlx()
        } catch (error) {
          setSetup('fallback', 'MLX 安裝失敗，改用 GGUF 備援', error)
          provider = await installMacGguf()
        }
      } else if (detected.platform === 'win32') {
        provider = await installWinGguf()
      } else {
        provider = await installMacGguf()
      }
      await ensureDefaultReference()
      const env = { ...process.env, HF_HOME: paths.hfHome }
      setSetup('test', '測試語音合成')
      await synthesize('主人，語音功能測試成功。', { forceProvider: provider, env, skipConsent: true })
      setSetup('done', `環境已就緒（${provider === 'mlx' ? 'macOS MLX' : 'CosyVoice GGUF'}）`)
      return { started: true, provider }
    } catch (error) {
      setSetup('error', '環境安裝失敗', error)
      throw error
    } finally {
      state.installing = false
    }
  }

  function cleanText(text, maxChars) {
    const value = String(text || '')
      .replace(/\[\[\s*(?:voice|語音|语音)\s*\]\]/gi, '')
      .replace(/[*_`#>]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    return value.slice(0, Math.max(1, maxChars))
  }

  async function synthesize(text, { forceProvider = '', env = process.env, skipConsent = false, instructText: instructOverride = '' } = {}) {
    const cfg = cfgVoice()
    if (!skipConsent && cfg.consent !== true) throw new Error('尚未確認聲音使用權利（面板：語音回覆 → 我確認有使用權）')
    if (!skipConsent && cfg.enabled === false) throw new Error('語音功能未開啟')
    const provider = forceProvider || resolveProvider(cfg)
    const ref = referencePath()
    if (!ref) throw new Error('尚未設定參考音')
    const maxChars = Math.max(20, Math.min(300, Number(cfg.maxChars) || 80))
    const cleaned = cleanText(text, maxChars)
    if (!cleaned) throw new Error('沒有可合成的文字')
    const ffmpeg = which('ffmpeg')
    if (!ffmpeg) throw new Error('找不到 ffmpeg')
    const id = randomUUID().slice(0, 8)
    const prefix = path.join(paths.outDir, `tts-${id}`)
    const startedAt = Date.now()
    const instructText = String(instructOverride || cfg.instructText || DEFAULT_INSTRUCT).trim()
    const cloneMode = String(cfg.cloneMode || 'instruct')
    let wav = ''
    try {
      if (provider === 'mlx') {
        const jobFile = path.join(paths.jobsDir, `${id}.json`)
        const payload = {
          text: cleaned,
          model: String(cfg.model || MLX_MODEL),
          refAudio: ref,
          prefix,
          instructText: cloneMode === 'instruct' ? instructText : '',
          refText: cloneMode === 'zero-shot' ? String(cfg.refText || '') : '',
        }
        fs.writeFileSync(jobFile, JSON.stringify(payload), { mode: 0o600 })
        const { stdout } = await run(paths.mlxPython, [paths.mlxScript, jobFile], {
          timeout: 600000,
          env: { ...env, HF_HOME: paths.hfHome },
        })
        const line = String(stdout || '').split(/\r?\n/).reverse().find((item) => item.startsWith('RESULT:'))
        if (!line) throw new Error(`MLX 沒有回傳結果：${String(stdout).slice(-300)}`)
        const result = JSON.parse(line.slice('RESULT:'.length))
        if (!result.ok || !result.file) throw new Error('MLX 沒有產生音檔')
        wav = result.file
      } else {
        const bin = ggufBinary()
        if (!bin) throw new Error('找不到 crispasr 執行檔')
        wav = `${prefix}.wav`
        const args = ['--backend', GGUF_BACKEND, '-m', String(cfg.model || 'auto'), '--voice', ref, '--tts', cleaned, '--tts-output', wav, '-tl', 'zh', '--i-have-rights']
        if (cloneMode === 'instruct' && instructText) args.push('--instruct', instructText)
        if (cloneMode === 'zero-shot' && cfg.refText) args.push('--ref-text', String(cfg.refText))
        if (cfg.skipDisclaimer !== false) args.push('--no-spoken-disclaimer', '--accept-marking-responsibility')
        const { stderr } = await run(bin, args, { timeout: 900000, env: { ...env, HF_HOME: paths.hfHome } })
        if (!fileExists(wav)) throw new Error(`GGUF 沒有產生音檔：${String(stderr || '').slice(-300)}`)
      }
      const m4a = `${prefix}.m4a`
      await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-c:a', 'aac', '-b:a', '96k', '-ar', '44100', '-ac', '1', m4a], { timeout: 120000 })
      const durationMs = await fileDurationMs(m4a)
      const bytes = fs.statSync(m4a).size
      state.last = { provider, at: Date.now(), durationMs, bytes, chars: cleaned.length, processingMs: Date.now() - startedAt }
      state.lastError = ''
      return { provider, wav, m4a, durationMs, bytes, chars: cleaned.length, processingMs: state.last.processingMs }
    } catch (error) {
      state.lastError = String(error?.message || error)
      throw error
    }
  }

  async function fileDurationMs(file) {
    try {
      const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { timeout: 15000 })
      return Math.max(0, Math.round(Number(String(stdout).trim()) * 1000))
    } catch {
      return 0
    }
  }

  async function saveReferenceBuffer(buffer, filename, ext = '.wav') {
    const safe = String(filename || 'upload').replace(/[^\w.\-()\u4e00-\u9fff ]+/g, '_').slice(0, 60) || 'upload'
    const src = path.join(paths.refDir, `${Date.now()}-${safe}${safe.endsWith(ext) ? '' : ext}`)
    fs.writeFileSync(src, buffer)
    if (!fileExists(src)) throw new Error('寫入上傳檔案失敗')
    const ffmpeg = which('ffmpeg')
    if (!ffmpeg) throw new Error('需要 ffmpeg 才能轉換音檔')
    const dest = path.join(paths.refDir, `upload-${Date.now()}.wav`)
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', dest], { timeout: 120000 })
    const info = referenceInfoFor(dest)
    return { path: dest, ...info }
  }

  function referenceInfoFor(file) {
    let seconds = 0
    try {
      const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8', timeout: 8000 })
      seconds = Number(out.trim()) || 0
    } catch {
      seconds = 0
    }
    return { seconds: Math.round(seconds * 100) / 100 }
  }

  function status() {
    const detected = detect()
    return {
      ...detected,
      reference: detected.reference,
      setup: state.setup,
      installing: state.installing,
      last: state.last,
      lastError: state.lastError,
      mlxScript: fileExists(paths.mlxScript),
      lastSample: (() => {
        try {
          const files = fs.readdirSync(paths.outDir).filter((name) => name.endsWith('.m4a')).sort().reverse()
          return files[0] ? path.join(paths.outDir, files[0]) : ''
        } catch {
          return ''
        }
      })(),
    }
  }

  return { detect, install, synthesize, status, saveReferenceBuffer, referencePath, paths }
}
