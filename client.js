// dsh-line-bot 設定面板（瀏覽器端）。
// 註冊到 settings.section；所有資料走同源 /api/line-bot/*。
window.__ModuleLoader__.load({
  id: 'dsh-line-bot',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useMemo, useState } = React

    const API = '/api/line-bot'
    const SECTION_ID = 'line-bot'

    // 二級選單：卡片區塊的快速跳轉。
    const NAV = [
      { key: 'overview', label: '狀態總覽' },
      { key: 'line', label: 'LINE 憑證' },
      { key: 'tunnel', label: 'Cloudflare' },
      { key: 'model', label: '模型與來源' },
      { key: 'persona', label: '回覆人設' },
      { key: 'sync', label: '貼吧同步' },
      { key: 'memory', label: '個人記憶' },
      { key: 'balance', label: 'DeepSeek 餘額' },
      { key: 'nudge', label: '主動傳訊' },
      { key: 'meme', label: '表情包' },
      { key: 'users', label: '使用者' },
      { key: 'group', label: '群組' },
      { key: 'advanced', label: '進階／日誌' },
    ]
    const sectionDomId = (key) => `${SECTION_ID}-sec-${key}`

    // ── 樣式（用主題 token，跟著 DSH 深/淺色走） ───────────────────────────
    const S = {
      root: { display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 880, paddingBottom: 48, color: 'var(--dsw-alias-label-primary)' },
      topbar: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
      // 固定在頂端：儲存列在最上面，二級選單緊接在下面，捲到哪裡都按得到。
      stickyWrap: {
        position: 'sticky', top: 0, zIndex: 30, display: 'flex', flexDirection: 'column', gap: 8,
        padding: '8px 0 10px', background: 'var(--dsw-alias-bg-base)',
        borderBottom: '1px solid var(--dsw-alias-border-l2)',
      },
      nav: { display: 'flex', gap: 6, flexWrap: 'wrap' },
      navBtn: {
        appearance: 'none', cursor: 'pointer', padding: '3px 10px', fontSize: 12, lineHeight: '18px',
        borderRadius: 999, border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
      },
      navBtnActive: {
        background: 'var(--dsw-alias-bg-mask-1)', color: 'var(--dsw-alias-label-primary)',
        borderColor: 'var(--dsw-alias-label-tertiary)', fontWeight: 600,
      },
      title: { margin: 0, fontSize: 18, fontWeight: 600, lineHeight: '26px' },
      sub: { marginTop: 2, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
      topActions: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      dirty: { fontSize: 12, color: 'var(--dsw-alias-state-warning-primary, #d48806)' },
      card: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, background: 'var(--dsw-alias-bg-base)', overflow: 'hidden' },
      cardHead: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, padding: '12px 14px 0' },
      cardTitle: { fontSize: 14, fontWeight: 600 },
      cardDesc: { marginTop: 2, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
      cardBody: { padding: 14, display: 'flex', flexDirection: 'column', gap: 12 },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 },
      field: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
      label: { fontSize: 12, fontWeight: 500, color: 'var(--dsw-alias-label-secondary)' },
      hint: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' },
      input: {
        boxSizing: 'border-box', width: '100%', minWidth: 0, padding: '6px 9px', fontSize: 13, lineHeight: '20px',
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-mask-1)',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, outline: 'none',
      },
      textarea: { boxSizing: 'border-box', width: '100%', minHeight: 64, resize: 'vertical', padding: '6px 9px', fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-mask-1)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, outline: 'none', fontFamily: 'inherit' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      btn: {
        appearance: 'none', cursor: 'pointer', padding: '6px 12px', fontSize: 12, fontWeight: 500, lineHeight: '18px',
        borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
      },
      btnPrimary: { background: 'var(--dsw-alias-label-primary)', borderColor: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-base)' },
      btnDanger: { color: 'var(--dsw-alias-state-error-primary, #d4380d)', borderColor: 'var(--dsw-alias-state-error-primary, #d4380d)' },
      btnDisabled: { opacity: 0.45, cursor: 'not-allowed' },
      badge: { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 8px', borderRadius: 999, fontSize: 11, lineHeight: '18px', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-mask-1)' },
      dot: { width: 6, height: 6, borderRadius: 999, display: 'inline-block' },
      ok: { color: 'var(--dsw-alias-state-success-primary, #389e0d)' },
      warn: { color: 'var(--dsw-alias-state-warning-primary, #d48806)' },
      bad: { color: 'var(--dsw-alias-state-error-primary, #d4380d)' },
      muted: { color: 'var(--dsw-alias-label-tertiary)' },
      kv: { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 12px', fontSize: 12 },
      pre: { margin: 0, padding: 10, fontSize: 11, lineHeight: '16px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: 'var(--dsw-alias-bg-mask-1)', borderRadius: 8, maxHeight: 240, overflow: 'auto', color: 'var(--dsw-alias-label-secondary)' },
      note: { fontSize: 12, lineHeight: '18px', padding: '8px 10px', borderRadius: 8, background: 'var(--dsw-alias-bg-mask-1)', color: 'var(--dsw-alias-label-secondary)' },
      warnBox: { fontSize: 12, lineHeight: '18px', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--dsw-alias-state-warning-primary, #d48806)', color: 'var(--dsw-alias-state-warning-primary, #d48806)' },
      errBox: { fontSize: 12, lineHeight: '18px', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--dsw-alias-state-error-primary, #d4380d)', color: 'var(--dsw-alias-state-error-primary, #d4380d)', whiteSpace: 'pre-wrap' },
      panelBox: { display: 'flex', flexDirection: 'column', gap: 6, padding: 10, borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)' },
      fieldTitle: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      okBox: { fontSize: 12, lineHeight: '18px', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--dsw-alias-state-success-primary, #389e0d)', color: 'var(--dsw-alias-state-success-primary, #389e0d)', whiteSpace: 'pre-wrap' },
      link: { color: 'var(--dsw-alias-state-business-primary, #4b7bec)', textDecoration: 'none', fontSize: 12 },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
      th: { textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-tertiary)', fontWeight: 500 },
      td: { padding: '6px 8px', borderBottom: '1px solid var(--dsw-alias-border-l2)', verticalAlign: 'top' },
      divider: { height: 1, background: 'var(--dsw-alias-border-l2)', margin: '2px 0' },
    }

    // ── API ────────────────────────────────────────────────────────────────
    async function call(path, init) {
      const res = await fetch(API + path, { credentials: 'same-origin', ...(init || {}) })
      let body = null
      try {
        body = await res.json()
      } catch {
        body = null
      }
      if (!res.ok || (body && body.ok === false)) {
        throw new Error((body && body.error) || `HTTP ${res.status}`)
      }
      return body ? body.value : null
    }
    const jget = (path) => call(path)
    const jpost = (path, body) =>
      call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })

    // 秘密欄位在 draft 留空＝不變更；status 回來的是遮罩值。
    function stripSecrets(config) {
      const line = config?.line || {}
      const cloudflare = config?.cloudflare || {}
      return {
        ...config,
        line: { ...line, channelSecret: '', accessToken: '' },
        cloudflare: { ...cloudflare, apiToken: '' },
      }
    }
    function merge(base, patch) {
      const out = { ...base }
      for (const [key, value] of Object.entries(patch || {})) {
        if (value && typeof value === 'object' && !Array.isArray(value)) out[key] = { ...(base?.[key] || {}), ...value }
        else out[key] = value
      }
      return out
    }

    function fmtTime(value) {
      if (!value) return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      return date.toLocaleString('zh-TW', { hour12: false })
    }
    function fmtDuration(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return '—'
      const sec = Math.round(ms / 1000)
      if (sec < 60) return `${sec} 秒`
      const min = Math.floor(sec / 60)
      if (min < 60) return `${min} 分 ${sec % 60} 秒`
      return `${Math.floor(min / 60)} 時 ${min % 60} 分`
    }
    function textList(value) {
      return Array.isArray(value) ? value.join('\n') : ''
    }
    function parseList(text) {
      return String(text || '')
        .split(/[\s,，、;；]+/)
        .map((item) => item.trim())
        .filter(Boolean)
    }
    function describeResult(result) {
      if (result == null) return '完成'
      if (typeof result === 'string') return result
      if (Array.isArray(result)) {
        return result
          .map((step) => {
            const name = step?.step || step?.name || step?.action || '步驟'
            if (step?.ok === false || step?.error) return `${name}：失敗 ${step?.error || ''}`.trim()
            return `${name}：完成`
          })
          .join('；')
      }
      if (result.message) return String(result.message)
      if (result.url) return `完成（${result.url}）`
      if (result.endpoint) return `完成（${result.endpoint}）`
      try {
        const text = JSON.stringify(result)
        return text.length > 240 ? text.slice(0, 240) + '…' : text
      } catch {
        return '完成'
      }
    }

    // ── 小元件 ─────────────────────────────────────────────────────────────
    function Btn({ children, onClick, disabled, tone, title }) {
      const style = { ...S.btn }
      if (tone === 'primary') Object.assign(style, S.btnPrimary)
      if (tone === 'danger') Object.assign(style, S.btnDanger)
      if (disabled) Object.assign(style, S.btnDisabled)
      return h('button', { type: 'button', style, onClick: disabled ? undefined : onClick, disabled: !!disabled, title: title || '' }, children)
    }

    function Card({ id, title, desc, right, children, order }) {
      return h(
        'section',
        { id, 'data-section': id || undefined, style: { ...S.card, scrollMarginTop: 104, ...(order ? { order } : {}) } },
        h('div', { style: S.cardHead }, h('div', null, h('div', { style: S.cardTitle }, title), desc ? h('div', { style: S.cardDesc }, desc) : null), right || null),
        h('div', { style: S.cardBody }, children),
      )
    }

    function Field({ label, hint, children }) {
      return h('label', { style: S.field }, h('span', { style: S.label }, label), children, hint ? h('span', { style: S.hint }, hint) : null)
    }

    function Text({ value, onChange, placeholder, type, disabled, mono }) {
      return h('input', {
        type: type || 'text',
        value: value == null ? '' : String(value),
        placeholder: placeholder || '',
        disabled: !!disabled,
        spellCheck: false,
        autoComplete: 'off',
        onChange: (event) => onChange(event.target.value),
        style: mono ? { ...S.input, ...S.mono } : S.input,
      })
    }

    function Num({ value, onChange, min, max, step, disabled }) {
      return h('input', {
        type: 'number',
        value: Number.isFinite(value) ? String(value) : '',
        min: min == null ? undefined : min,
        max: max == null ? undefined : max,
        step: step == null ? 1 : step,
        disabled: !!disabled,
        onChange: (event) => {
          const raw = event.target.value
          if (raw === '') return onChange('')
          const num = Number(raw)
          onChange(Number.isFinite(num) ? num : '')
        },
        style: S.input,
      })
    }

    function Area({ value, onChange, placeholder, rows, mono }) {
      return h('textarea', {
        value: value == null ? '' : String(value),
        placeholder: placeholder || '',
        rows: rows || 3,
        spellCheck: false,
        onChange: (event) => onChange(event.target.value),
        style: mono ? { ...S.textarea, ...S.mono } : S.textarea,
      })
    }

    function Toggle({ checked, onChange, label, hint }) {
      return h(
        'label',
        { style: { ...S.row, alignItems: 'flex-start', cursor: 'pointer' } },
        h('input', { type: 'checkbox', checked: !!checked, onChange: (event) => onChange(event.target.checked), style: { marginTop: 3 } }),
        h('span', null, h('div', { style: { fontSize: 12, fontWeight: 500 } }, label), hint ? h('div', { style: S.hint }, hint) : null),
      )
    }


    function UserChips({ users, value, onChange, emptyText }) {
      const ids = Array.isArray(value) ? value : []
      const list = Array.isArray(users) ? users : []
      if (list.length === 0) {
        return h('div', { style: S.note }, emptyText || '目前還沒有使用者跟 bot 聊過；有人傳訊息後就會出現在這裡。')
      }
      return h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
        list.map((user) => {
          const selected = ids.includes(user.userId)
          const label = (user.displayName || '未命名') + '（' + String(user.userId).slice(-6) + '）'
          return h('button', {
            key: user.userId,
            type: 'button',
            onClick: () => onChange(selected ? ids.filter((id) => id !== user.userId) : [...ids, user.userId]),
            title: user.userId,
            style: { ...S.btn, padding: '4px 10px', borderRadius: 999, fontSize: 12, background: selected ? 'var(--dsw-alias-state-business-primary, #4b7bec)' : 'transparent', color: selected ? '#fff' : 'var(--dsw-alias-label-primary)', border: '1px solid ' + (selected ? 'transparent' : 'var(--dsw-alias-border-l2)') },
          }, label)
        }),
      )
    }

    function Badge({ ok, children }) {
      const color = ok === true ? S.ok.color : ok === false ? S.bad.color : S.warn.color
      const dot = ok === true ? S.ok.color : ok === false ? S.bad.color : S.warn.color
      return h('span', { style: S.badge }, h('span', { style: { ...S.dot, background: dot } }), h('span', { style: { color } }, children))
    }

    function KV({ rows }) {
      return h(
        'div',
        { style: S.kv },
        rows.map(([key, value]) => [
          h('span', { key: key + ':k', style: S.muted }, key),
          h('span', { key: key + ':v' }, value == null || value === '' ? '—' : value),
        ]),
      )
    }

    function Toast({ toast }) {
      if (!toast) return null
      return h('div', { style: toast.kind === 'ok' ? S.okBox : S.errBox }, toast.text)
    }

    // ── 主面板 ─────────────────────────────────────────────────────────────
    const memoCfgApng = (cfgValue) => cfgValue?.apng === true

    const ACTION_LABELS = {
      'meme-stats': '讀取表情包圖庫',
      start: '啟動',
      stop: '停止',
      restart: '重新啟動',
      'server-start': '啟動 webhook 伺服器',
      'server-stop': '停止 webhook 伺服器',
      'tunnel-start': '啟動隧道',
      'tunnel-stop': '停止隧道',
      'tunnel-restart': '重啟隧道',
      'tunnel-download': '下載 cloudflared',
      'cloudflare-verify': '驗證 Cloudflare token',
      'cloudflare-provision': '建立 Cloudflare 隧道',
      'webhook-apply': '套用 webhook',
      'webhook-test': '測試 webhook',
      'line-verify': '驗證 LINE 憑證',
      'token-refresh': '重新簽發 access token',
      'persona-status': '重新讀取人設',
      'persona-mode': '切換人設模式',
      'tieba-preview': '預覽貼吧同步差異',
      'model-catalog': '讀取模型清單',
      'balance-refresh': '查詢 DeepSeek 餘額',
      'memory-list': '讀取個人記憶',
      'memory-delete': '刪除記憶',
      'memory-prune': '清理到期記憶',
      'memory-review': '請角色整理記憶',
      'balance-ask': '餘額提醒',
      'tieba-sync': '同步貼吧學習',
      'local-persona-list': '讀取自訂人設',
      'local-persona-get': '讀取自訂人設內容',
      'local-persona-add': '新增自訂人設',
      'local-persona-update': '更新自訂人設',
      'local-persona-remove': '刪除自訂人設',
      'local-persona-import': '匯入大肥魚人設',
      'nudge-test': '主動傳訊試跑',
      'agent-test': '測試 Agent 回覆',
      'user-reset': '重設使用者',
      'user-persona': '設定使用者人設',
      'group-persona': '設定群組人設',
      'group-reset': '重設群組',
      'logs-clear': '清除日誌',
      setup: '一鍵上線',
    }

    function Panel() {
      const [status, setStatus] = useState(null)
      const [draft, setDraft] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState('')
      const [toast, setToast] = useState(null)
      const [active, setActive] = useState('overview')
      const [syncPreview, setSyncPreview] = useState(null)
      const [balancePreview, setBalancePreview] = useState(null)
      const [memoryData, setMemoryData] = useState(null)
      const [modelCatalog, setModelCatalog] = useState(null)
      const [localEdit, setLocalEdit] = useState({ id: '', name: '', text: '' })

      const dirty = useMemo(() => {
        if (!status || !draft) return false
        return JSON.stringify(stripSecrets(status.config)) !== JSON.stringify(draft)
      }, [status, draft])

      useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const value = await jget('/status')
            if (!alive) return
            setStatus(value)
            setError('')
            setDraft((current) => current || stripSecrets(value.config))
          } catch (err) {
            if (alive) setError(err.message || String(err))
          }
        }
        tick()
        const timer = setInterval(tick, 3000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [])

      const update = (patch) => setDraft((current) => merge(current, patch))

      // 二級選單：跟著捲動位置高亮目前區塊（capture 也能接到內層捲動容器）。
      useEffect(() => {
        const onScroll = () => {
          let current = NAV[0].key
          for (const item of NAV) {
            const el = document.getElementById(sectionDomId(item.key))
            if (!el) continue
            if (el.getBoundingClientRect().top <= 120) current = item.key
          }
          setActive(current)
        }
        window.addEventListener('scroll', onScroll, true)
        onScroll()
        return () => window.removeEventListener('scroll', onScroll, true)
      }, [status])

      function jumpTo(key) {
        const el = document.getElementById(sectionDomId(key))
        setActive(key)
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }

      async function persist(showToast) {
        if (!draft) return null
        const value = await jpost('/config', { patch: draft })
        if (value) {
          setStatus(value)
          setDraft(stripSecrets(value.config))
        }
        if (showToast) setToast({ kind: 'ok', text: '設定已儲存' })
        return value
      }

      async function save() {
        setBusy('save')
        setToast(null)
        try {
          await persist(false)
          setToast({ kind: 'ok', text: '設定已儲存' })
        } catch (err) {
          setToast({ kind: 'error', text: err.message || String(err) })
        } finally {
          setBusy('')
        }
      }

      async function act(action, payload) {
        setBusy(action)
        setToast(null)
        try {
          if (dirty) await persist(false)
          const value = await jpost('/action', { action, payload: payload || {} })
          if (value?.status) {
            setStatus(value.status)
            setDraft(stripSecrets(value.status.config))
          }
          setToast({ kind: 'ok', text: `${ACTION_LABELS[action] || action}：${describeResult(value?.result)}` })
        } catch (err) {
          setToast({ kind: 'error', text: `${ACTION_LABELS[action] || action} 失敗：${err.message || err}` })
        } finally {
          setBusy('')
        }
      }

      async function previewBalance() {
        setBusy('balance-ask')
        setToast(null)
        try {
          if (dirty) await persist(false)
          const value = await jpost('/action', { action: 'balance-ask', payload: { dryRun: true, force: true } })
          if (value?.status) {
            setStatus(value.status)
            setDraft(stripSecrets(value.status.config))
          }
          setBalancePreview(value?.result || null)
          setToast({ kind: 'ok', text: value?.result?.text ? '已產生提醒文字，還沒有送出。' : '目前不需要提醒。' })
        } catch (err) {
          setToast({ kind: 'error', text: '預覽提醒失敗：' + (err.message || err) })
        } finally {
          setBusy('')
        }
      }

      async function askBalance() {
        if (typeof window !== 'undefined' && !window.confirm('現在真的用 LINE 送一則餘額提醒給使用者？')) return
        setBalancePreview(null)
        await act('balance-ask', { dryRun: false, force: true })
      }

      async function loadMemory({ quiet = false } = {}) {
        if (!quiet) setBusy('memory-list')
        try {
          if (dirty && !quiet) await persist(false)
          const value = await jpost('/action', { action: 'memory-list', payload: {} })
          if (value?.status) {
            setStatus(value.status)
            setDraft(stripSecrets(value.status.config))
          }
          setMemoryData(value?.result || null)
        } catch (err) {
          if (!quiet) setToast({ kind: 'error', text: '讀取記憶失敗：' + (err.message || err) })
        } finally {
          if (!quiet) setBusy('')
        }
      }

      async function removeMemory(userId, entry) {
        setBusy('memory-delete')
        try {
          const value = await jpost('/action', { action: 'memory-delete', payload: { userId, id: entry.id } })
          if (value?.status) {
            setStatus(value.status)
            setDraft(stripSecrets(value.status.config))
          }
          await loadMemory({ quiet: true })
          setToast({ kind: 'ok', text: '已刪掉一筆記憶。' })
        } catch (err) {
          setToast({ kind: 'error', text: '刪除記憶失敗：' + (err.message || err) })
        } finally {
          setBusy('')
        }
      }

      async function runMemory(action) {
        await act(action)
        await loadMemory({ quiet: true })
      }

      async function loadModelCatalog({ quiet = false, force = false } = {}) {
        if (!quiet) setBusy('model-catalog')
        try {
          if (dirty && !quiet) await persist(false)
          const value = await jpost('/action', { action: 'model-catalog', payload: force ? { force: true } : {} })
          if (value?.status) {
            setStatus(value.status)
            setDraft(stripSecrets(value.status.config))
          }
          setModelCatalog(value?.result || null)
        } catch (err) {
          if (!quiet) setToast({ kind: 'error', text: '讀取模型清單失敗：' + (err.message || err) })
        } finally {
          if (!quiet) setBusy('')
        }
      }

      useEffect(() => {
        loadMemory({ quiet: true })
        loadModelCatalog({ quiet: true })
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      async function previewSync() {
        setBusy('tieba-preview')
        setToast(null)
        try {
          if (dirty) await persist(false)
          const value = await jpost('/action', { action: 'tieba-preview', payload: {} })
          if (value?.status) {
            setStatus(value.status)
            setDraft(stripSecrets(value.status.config))
          }
          const result = value?.result || null
          setSyncPreview(result)
          setToast({ kind: 'ok', text: result?.changed ? '有新內容可以同步（看下方預覽）' : '目前人設已是最新' })
        } catch (err) {
          setToast({ kind: 'error', text: `預覽失敗：${err.message || err}` })
        } finally {
          setBusy('')
        }
      }

      async function editLocalPersona(item) {
        setBusy('local-persona-get')
        setToast(null)
        try {
          const value = await jpost('/action', { action: 'local-persona-get', payload: { id: item.id } })
          const result = value?.result || {}
          setLocalEdit({ id: item.id, name: result.name || item.name, text: result.text || '' })
        } catch (err) {
          setToast({ kind: 'error', text: `讀取人設失敗：${err.message || err}` })
        } finally {
          setBusy('')
        }
      }

      async function saveLocalPersona() {
        const name = String(localEdit.name || '').trim()
        const text = String(localEdit.text || '').trim()
        if (!name || !text) {
          setToast({ kind: 'error', text: '請填入人設名稱與內容' })
          return
        }
        await act(localEdit.id ? 'local-persona-update' : 'local-persona-add', {
          ...(localEdit.id ? { id: localEdit.id } : {}),
          name,
          text,
        })
        setLocalEdit({ id: '', name: '', text: '' })
      }

      async function removeLocalPersona(item) {
        if (typeof window !== 'undefined' && !window.confirm(`刪除自訂人設「${item.name}」？`)) return
        await act('local-persona-remove', { id: item.id })
        if (localEdit.id === item.id) setLocalEdit({ id: '', name: '', text: '' })
      }

      async function importPersona() {
        if (!personaCfg.id || selectedIsLocal) {
          setToast({ kind: 'error', text: '請先在「使用的人設」選一個大肥魚的人設，再按複製。' })
          return
        }
        await act('local-persona-import', { id: personaCfg.id })
      }

      async function applySync() {
        setBusy('tieba-sync')
        setToast(null)
        try {
          if (dirty) await persist(false)
          const value = await jpost('/action', { action: 'tieba-sync', payload: {} })
          if (value?.status) {
            setStatus(value.status)
            setDraft(stripSecrets(value.status.config))
          }
          const result = value?.result || {}
          setSyncPreview(null)
          setToast({ kind: 'ok', text: result.skipped === 'unchanged' ? '貼吧人設沒有新內容，不用同步' : `已同步（版本 ${result.version ?? '?'}，${result.samples ?? '?'} 句）${result.reload?.ok === false ? '，但重載大肥魚失敗：' + result.reload.error : ''}` })
        } catch (err) {
          setToast({ kind: 'error', text: `同步失敗：${err.message || err}` })
        } finally {
          setBusy('')
        }
      }

      async function refresh() {
        setToast(null)
        try {
          const value = await jget('/status')
          setStatus(value)
          setDraft(stripSecrets(value.config))
          setError('')
        } catch (err) {
          setError(err.message || String(err))
        }
      }

      async function devReload() {
        setBusy('dev-reload')
        setToast(null)
        try {
          await call('/dev/reload', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          setToast({ kind: 'ok', text: 'host 模組已重新載入' })
          await refresh()
        } catch (err) {
          setToast({ kind: 'error', text: `重新載入失敗：${err.message || err}` })
        } finally {
          setBusy('')
        }
      }

      if (!status || !draft) {
        return h(
          'div',
          { style: S.root },
          error ? h('div', { style: S.errBox }, `無法連線到 LINE Bot 執行期：${error}`) : h('div', { style: S.note }, '讀取 LINE Bot 狀態中…'),
        )
      }

      const cfg = draft
      const line = cfg.line || {}
      const server = cfg.server || {}
      const tunnel = cfg.tunnel || {}
      const cloudflare = cfg.cloudflare || {}
      const personaCfg = cfg.persona || {}
      const agentCfg = cfg.agent || {}
      const nudgeCfg = cfg.nudge || {}
      const syncCfg = cfg.sync || {}
      const balanceCfg = cfg.balance || {}
      const groupCfg = cfg.group || {}
      const groupList = status.groups || []
      const memeCfg = cfg.stickers || {}
      const memeStatus = status.meme || {}
      const memeSample = Array.isArray(memeStatus.sample) ? memeStatus.sample : []
      const balanceStatus = status.balance || {}
      const balanceSymbol = balanceStatus.cny ? '¥' : balanceStatus.usd ? '$' : '¥'
      const balanceTotal = balanceStatus.cny ? balanceStatus.cny.total : balanceStatus.usd ? balanceStatus.usd.total : null
      const memoryCfg = cfg.memory || {}
      const memoryStatus = status.memory || {}
      const agentStatus = status.agent || {}
      const modelProviders = Array.isArray(modelCatalog?.providers) ? modelCatalog.providers : []
      const memoryUsers = memoryData?.users || []
      const syncStats = status.sync || {}
      const runtime = status
      const persona = status.persona || {}
      const personaOptions = Array.isArray(persona.list) ? persona.list : []
      const personaLocal = Array.isArray(persona.local) ? persona.local : []
      const personaCatalog = Array.isArray(persona.catalog) && persona.catalog.length
        ? persona.catalog
        : [...personaOptions, ...personaLocal]
      const selectedPersona = personaCatalog.find((item) => item.id === personaCfg.id) || null
      const selectedName = selectedPersona?.name || personaCfg.id || '大肥魚'
      const selectedIsLocal = String(personaCfg.id || '').startsWith('local:')
      const syncPersonaOptions = personaOptions.filter((item) => !item.builtin)
      const syncTarget = syncCfg.targetPersonaId || (syncPersonaOptions[0] && syncPersonaOptions[0].id) || ''
      const bot = status.line?.bot || null
      const webhook = status.line?.webhook || null
      const tunnelStatus = status.tunnel || {}
      const nudgeStats = status.nudge || {}

      return h(
        'div',
        { style: S.root },
        // 儲存列固定在所有區塊之上，二級選單緊接其下，捲到哪裡都按得到。
        h(
          'div',
          { style: S.stickyWrap },
          h(
            'div',
            { style: S.topbar },
            h('div', null, h('h2', { style: S.title }, 'LINE Bot'), h('div', { style: S.sub }, `dsh-line-bot ${status.version || ''} · 資料夾 ${status.paths?.dataDir || status.paths?.dir || ''}`)),
            h(
              'div',
              { style: S.topActions },
              dirty ? h('span', { style: S.dirty }, '有未儲存的變更') : null,
              h(Btn, { onClick: save, disabled: !!busy, tone: dirty ? 'primary' : undefined }, busy === 'save' ? '儲存中…' : '儲存變更'),
              h(Btn, { onClick: refresh, disabled: !!busy }, '重新整理'),
            ),
          ),
          h(
            'nav',
            { style: S.nav, 'aria-label': 'LINE Bot 設定快速跳轉' },
            NAV.map((item) =>
              h(
                'button',
                {
                  key: item.key,
                  type: 'button',
                  style: { ...S.navBtn, ...(active === item.key ? S.navBtnActive : {}) },
                  onClick: () => jumpTo(item.key),
                },
                item.label,
              )),
          ),
        ),
        h(Toast, { toast }),
        error ? h('div', { style: S.errBox }, `狀態讀取失敗：${error}`) : null,

        // 1. 狀態總覽
        h(
          Card,
          { id: sectionDomId('overview'), order: 1, title: '狀態總覽', desc: '綠燈＝已就緒。第一次使用建議依序：填入 LINE 憑證 → 啟動 webhook → 啟動隧道。', right: h(Btn, { tone: 'primary', onClick: () => act('setup'), disabled: !!busy }, busy === 'setup' ? '上線中…' : '一鍵上線') },
          h(
            'div',
            { style: S.row },
            h(Badge, { ok: !!runtime.server?.running }, `Webhook 伺服器 ${runtime.server?.running ? `127.0.0.1:${runtime.server.port}` : '未啟動'}`),
            h(Badge, { ok: tunnelStatus.phase === 'running' || tunnelStatus.phase === 'external' ? true : tunnelStatus.phase === 'error' ? false : null }, `隧道 ${tunnelStatus.phase || '未啟動'}`),
            h(Badge, { ok: runtime.line?.hasToken ? true : false }, runtime.line?.hasToken ? `LINE 已連線${bot?.displayName ? `（${bot.displayName}）` : ''}` : 'LINE 未設定 token'),
            h(Badge, { ok: persona.available ? (persona.mode === 'session' ? true : null) : false }, persona.available ? `人設 ${selectedName}${persona.mode === 'session' ? '' : `（模式：${persona.mode || '未知'}）`}` : '大肥魚插件未就緒'),
            h(Badge, { ok: nudgeCfg.enabled ? true : null }, `主動傳訊 ${nudgeCfg.enabled ? '開啟' : '關閉'}`),
          ),
          h('div', { style: S.row },
            h(Btn, { onClick: () => act('start'), disabled: !!busy }, '啟動全部'),
            h(Btn, { onClick: () => act('stop'), disabled: !!busy }, '停止全部'),
            h(Btn, { onClick: () => act('restart'), disabled: !!busy }, '重新啟動'),
            h(Btn, { onClick: () => act('line-verify'), disabled: !!busy }, busy === 'line-verify' ? '驗證中…' : '驗證 LINE 憑證'),
          ),
          tunnelStatus.url ? h(KV, { rows: [['公開網址', h('a', { href: tunnelStatus.url, target: '_blank', rel: 'noreferrer', style: S.link }, tunnelStatus.url)]] }) : null,
          runtime.line?.lastError ? h('div', { style: S.errBox }, `LINE：${runtime.line.lastError}`) : null,
          tunnelStatus.error ? h('div', { style: S.errBox }, `隧道：${tunnelStatus.error}`) : null,
          persona.warning ? h('div', { style: S.warnBox }, persona.warning) : null,
          runtime.agent?.lastError ? h('div', { style: S.errBox }, `Agent：${runtime.agent.lastError}`) : null,
        ),

        // 1.5 DeepSeek 餘額
        h(
          Card,
          {
            id: sectionDomId('balance'), order: 8,
            title: 'DeepSeek 餘額',
            desc: '讓角色知道 API 錢包剩多少；低於門檻時由角色自己想一句話提醒你儲值（會避開主動傳訊的靜音時段）。只有模型來源是 deepseek-account 時才適用。',
            right: h(Btn, { onClick: () => act('balance-refresh'), disabled: !!busy || balanceStatus.applicable === false }, busy === 'balance-refresh' ? '查詢中…' : '重新查詢'),
          },
          balanceStatus.applicable === false
            ? h('div', { style: S.warnBox }, `目前模型來源是「${agentStatus.provider || '未設定'}」，不是 DeepSeek 官方帳號，所以餘額查詢與主動提醒已停用。把上面的「模型與接口來源」切回 deepseek-account 就會自動恢復。`)
            : null,
          h(
            'fieldset',
            {
              disabled: balanceStatus.applicable === false,
              style: { border: 0, margin: 0, padding: 0, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12, ...(balanceStatus.applicable === false ? { opacity: 0.45 } : {}) },
            },
          h(
            'div',
            { style: S.row },
            h(Badge, { ok: balanceStatus.status === 'ready' ? !balanceStatus.low : false }, balanceTotal != null ? ('可用 ' + balanceSymbol + Number(balanceTotal).toFixed(2)) : ('餘額：' + (balanceStatus.status || '未查詢'))),
            h(Badge, { ok: balanceCfg.enabled !== false }, '監控' + (balanceCfg.enabled !== false ? '開啟' : '關閉')),
            h(Badge, { ok: balanceCfg.ask !== false }, '主動提醒' + (balanceCfg.ask !== false ? '開啟' : '關閉')),
          ),
          balanceStatus.status === 'ready'
            ? h(KV, {
                rows: [
                  ['目前餘額', (balanceStatus.cny ? '¥' + Number(balanceStatus.cny.total).toFixed(2) + '（一般 ¥' + Number(balanceStatus.cny.normal).toFixed(2) + '、贈金 ¥' + Number(balanceStatus.cny.bonus).toFixed(2) + '）' : '$' + Number(balanceStatus.usd.total).toFixed(2))],
                  ['上次查詢', fmtTime(balanceStatus.at)],
                  ['上次提醒', balanceStatus.lastAskAt ? fmtTime(balanceStatus.lastAskAt) : '還沒提醒過'],
                  ['提醒門檻', '¥' + (balanceCfg.threshold || 0) + '（0 = 不自動提醒）'],
                ],
              })
            : h(
                'div',
                { style: S.note },
                balanceStatus.status === 'unavailable'
                  ? '這個 DSH profile 沒有 deepseek-account 服務，抓不到餘額；其他功能不受影響。'
                  : balanceStatus.status === 'signed-out'
                    ? '目前沒有登入 DeepSeek 帳號（或登入已過期），所以查不到餘額。'
                    : balanceStatus.error
                      ? ('查詢失敗：' + balanceStatus.error)
                      : '按「重新查詢」讀取目前的 DeepSeek API 餘額。',
              ),
          h(Field, { label: '餘額提醒對象', hint: '留空＝沿用主動傳訊的指定對象；只會提醒這裡選的人' }, h(UserChips, { users: status.users, value: balanceCfg.targetUserIds, onChange: (ids) => update({ balance: { targetUserIds: ids } }) })),
          h(
            'div',
            { style: S.grid },
            h(Field, { label: '低於多少提醒（¥）', hint: '0 = 不自動提醒；低於門檻時由角色主動傳訊息' }, h(Num, { value: balanceCfg.threshold, min: 0, max: 100000, step: 1, onChange: (value) => update({ balance: { threshold: value } }) })),
            h(Field, { label: '提醒冷卻（小時）', hint: '同一段時間內最多提醒一次' }, h(Num, { value: balanceCfg.cooldownHours, min: 1, max: 168, step: 1, onChange: (value) => update({ balance: { cooldownHours: value } }) })),
          ),
          h(
            'div',
            { style: S.row },
            h(Toggle, { checked: balanceCfg.enabled !== false, onChange: (value) => update({ balance: { enabled: value } }), label: '在每輪回覆裡提供餘額給角色', hint: '關掉就完全不知道餘額' }),
            h(Toggle, { checked: balanceCfg.ask !== false, onChange: (value) => update({ balance: { ask: value } }), label: '低於門檻時主動提醒', hint: '由角色自己決定怎麼問' }),
          ),
          h(
            'div',
            { style: S.row },
            h(Btn, { onClick: previewBalance, disabled: !!busy }, busy === 'balance-ask' ? '產生中…' : '預覽提醒（不送出）'),
            h(Btn, { tone: 'primary', onClick: askBalance, disabled: !!busy }, '立即提醒一次'),
          ),
          balancePreview && balancePreview.text ? h('div', { style: S.panelBox }, h('div', { style: S.fieldTitle }, '角色會傳這則：'), h('pre', { style: S.pre }, balancePreview.text)) : null,
          ),
        ),

        // 1.6 個人記憶
        h(
          Card,
          {
            id: sectionDomId('memory'), order: 7,
            title: '個人記憶',
            desc: '每位使用者分開。角色覺得重要的事會自己記下來；有期限的到期自動刪，每天也會請角色自己整理一次。',
            right: h(Btn, { onClick: () => loadMemory(), disabled: !!busy }, busy === 'memory-list' ? '讀取中…' : '重新整理'),
          },
          h('div', { style: S.row },
            h(Badge, { ok: memoryStatus.enabled !== false }, '共 ' + (memoryStatus.total || 0) + ' 筆'),
            h(Badge, { ok: memoryCfg.reviewDaily !== false }, '每日整理：' + (memoryCfg.reviewDaily !== false ? (Number(memoryCfg.reviewHour) || 0) + ' 點' : '關閉')),
            h(Badge, { ok: true }, '到期自動刪'),
          ),
          h(KV, { rows: [
            ['上次清理', memoryStatus.lastPruneAt ? fmtTime(memoryStatus.lastPruneAt) : '還沒清過'],
            ['上次角色整理', memoryStatus.lastReviewAt ? fmtTime(memoryStatus.lastReviewAt) : '還沒整理過'],
            ['記憶檔', memoryStatus.file || ''],
          ] }),
          h('div', { style: S.grid },
            h(Field, { label: '每天整理時間（0–23 點）', hint: '由角色自己判斷哪幾筆該忘掉' }, h(Num, { value: memoryCfg.reviewHour, min: 0, max: 23, step: 1, onChange: (value) => update({ memory: { reviewHour: value } }) })),
            h(Field, { label: '每輪最多帶入幾筆', hint: '其餘仍留在檔案裡' }, h(Num, { value: memoryCfg.injectMaxEntries, min: 1, max: 80, step: 1, onChange: (value) => update({ memory: { injectMaxEntries: value } }) })),
            h(Field, { label: '每人上限（筆）', hint: '超過時刪最舊的' }, h(Num, { value: memoryCfg.maxPerUser, min: 10, max: 500, step: 10, onChange: (value) => update({ memory: { maxPerUser: value } }) })),
            h(Field, { label: '帶入字數上限', hint: '避免佔用太多 prompt' }, h(Num, { value: memoryCfg.injectMaxChars, min: 200, max: 8000, step: 200, onChange: (value) => update({ memory: { injectMaxChars: value } }) })),
          ),
          h('div', { style: S.row },
            h(Toggle, { checked: memoryCfg.enabled !== false, onChange: (value) => update({ memory: { enabled: value } }), label: '開啟個人記憶', hint: '關掉後角色不再記新的事情，也不會讀到舊的' }),
            h(Toggle, { checked: memoryCfg.reviewDaily !== false, onChange: (value) => update({ memory: { reviewDaily: value } }), label: '每天請角色整理一次', hint: '清掉過期或不再成立的記憶' }),
          ),
          h('div', { style: S.row },
            h(Btn, { onClick: () => runMemory('memory-prune'), disabled: !!busy }, busy === 'memory-prune' ? '清理中…' : '清理到期記憶'),
            h(Btn, { onClick: () => runMemory('memory-review'), disabled: !!busy }, busy === 'memory-review' ? '整理中…' : '現在請角色整理'),
          ),
          memoryData
            ? (memoryUsers.length === 0
                ? h('div', { style: S.note }, '目前沒有任何記憶。角色在對話中覺得重要時，會自己記下來。')
                : memoryUsers.map((row) => h('div', { key: row.userId, style: S.panelBox },
                    h('div', { style: S.fieldTitle }, (row.displayName || row.userId) + '（' + row.entries.length + ' 筆）'),
                    row.entries.map((entry) => h('div', { key: entry.id, style: { display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 0', borderTop: '1px solid var(--dsw-alias-border-l2)' } },
                      h('span', { style: { flex: '0 0 auto', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', paddingTop: 2 } }, ({ fact: '事實', event: '事件', preference: '喜好', inside: '默契' })[entry.kind] || entry.kind),
                      h('span', { style: { flex: 1, fontSize: 13, lineHeight: 1.5 } }, entry.text, entry.expiresText ? h('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, '（到 ' + String(entry.expiresText).slice(0, 10) + '）') : null),
                      h(Btn, { tone: 'danger', onClick: () => removeMemory(row.userId, entry), disabled: !!busy }, '刪除'),
                    )),
                  )))
            : h('div', { style: S.note }, '按「重新整理」讀取目前記住的內容。'),
        ),

        // 2. LINE 憑證
        h(
          Card,
          { id: sectionDomId('line'), order: 2, title: 'LINE 憑證', desc: '在 LINE Developers Console 的 Messaging API channel 取得。貼上後可按「驗證」確認。' },
          h(
            'div',
            { style: S.note },
            '提醒：LINE 沒有公開 API 可以代為建立 channel（2024-09 起只能在 Official Account Manager 手動建立），所以這裡不代建 bot；但只要有 Channel ID＋Channel Secret，插件就能自動簽發 access token，並自動設定 webhook 端點。',
          ),
          h('div', { style: S.row },
            h('a', { href: 'https://manager.line.biz/', target: '_blank', rel: 'noreferrer', style: S.link }, '① 建立／管理 Official Account ↗'),
            h('a', { href: 'https://developers.line.biz/console/', target: '_blank', rel: 'noreferrer', style: S.link }, '② LINE Developers Console ↗'),
          ),
          h(
            'div',
            { style: S.grid },
            h(Field, { label: 'Channel ID', hint: 'Messaging API channel 的 Channel ID（數字）' }, h(Text, { value: line.channelId, onChange: (value) => update({ line: { channelId: value } }), placeholder: '例如 2000000000' })),
            h(Field, { label: 'Channel Secret', hint: `目前：${runtime.line?.hasSecret ? '已設定' : '未設定'}；留空＝不變更` }, h(Text, { value: line.channelSecret, onChange: (value) => update({ line: { channelSecret: value } }), type: 'password', placeholder: runtime.line?.hasSecret ? '••••••••（已設定）' : '貼上 Channel Secret' })),
            h(Field, { label: 'Channel Access Token（選填）', hint: `目前：${runtime.line?.hasToken ? '已設定' : '未設定'}；留空＝用 Channel ID＋Secret 自動簽發` }, h(Text, { value: line.accessToken, onChange: (value) => update({ line: { accessToken: value } }), type: 'password', placeholder: runtime.line?.hasToken ? '••••••••（已設定）' : '可留空，由插件自動取得' })),
            h(Field, { label: 'Token 狀態', hint: '自動簽發的 token 約 30 天到期，插件會在需要時自動續簽' }, h('div', { style: { fontSize: 12, paddingTop: 4 } }, runtime.line?.hasToken ? `來源：${runtime.line.tokenSource || '—'}，到期：${runtime.line.tokenExpiresAt ? fmtTime(runtime.line.tokenExpiresAt) : '—'}` : '尚未取得')),
          ),
          h(Toggle, { checked: line.useAutoToken !== false, onChange: (value) => update({ line: { useAutoToken: value } }), label: '自動簽發 access token', hint: '有 Channel ID＋Secret 時，優先自動取得（建議開啟）' }),
          h(Toggle, { checked: line.loadingEnabled !== false, onChange: (value) => update({ line: { loadingEnabled: value } }), label: '顯示「正在輸入」動畫', hint: '回覆前呼叫 LINE 的 loading 動畫' }),
          h(Toggle, { checked: line.stickerVision !== false, onChange: (value) => update({ line: { stickerVision: value } }), label: '看得懂貼圖', hint: '收到貼圖時抓圖片給模型看；模型不支援圖片時仍會用貼圖關鍵字' }),
          h('div', { style: S.row },
            h(Btn, { onClick: () => act('line-verify'), disabled: !!busy, tone: 'primary' }, busy === 'line-verify' ? '驗證中…' : '驗證並讀取 bot 資訊'),
            h(Btn, { onClick: () => act('token-refresh'), disabled: !!busy }, '重新簽發 token'),
          ),
          bot
            ? h(KV, {
                rows: [
                  ['Bot 名稱', bot.displayName || '—'],
                  ['Basic ID', bot.basicId || '—'],
                  ['Premium ID', bot.premiumId || '—'],
                  ['Chat 模式', bot.chatMode || '—'],
                  ['Webhook 設定', webhook ? `${webhook.endpoint || '—'}${webhook.active ? '（啟用）' : '（未啟用）'}` : '—'],
                ],
              })
            : null,
          h('div', { style: S.row },
            h(Btn, { onClick: () => act('webhook-apply'), disabled: !!busy }, busy === 'webhook-apply' ? '套用中…' : '把隧道網址套到 webhook'),
            h(Btn, { onClick: () => act('webhook-test'), disabled: !!busy }, '測試 webhook'),
          ),
          h('div', { style: S.hint }, '「Use webhook」開關只能在 LINE console 的 Messaging API 設定頁手動開啟；端點本身由插件自動設定。'),
          h(Field, { label: '白名單使用者 ID', hint: '一行一個；留空＝任何加 bot 的人都能用。可從下方「使用者」清單複製。' }, h(Area, { value: textList(line.allowedUserIds), onChange: (value) => update({ line: { allowedUserIds: parseList(value) } }), rows: 2, mono: true })),
        ),

        // 3. Cloudflare Tunnel
        h(
          Card,
          { id: sectionDomId('tunnel'), order: 3, title: 'Cloudflare Tunnel', desc: '把 127.0.0.1 的 webhook 公開到 https，LINE 才收得到。Quick tunnel 免 token、網址每次不同；API Token 模式可固定網域。' },
          h('div', { style: S.grid },
            h(Field, { label: '模式' },
              h('select', {
                value: tunnel.mode || 'quick',
                onChange: (event) => update({ tunnel: { mode: event.target.value } }),
                style: S.input,
              },
                h('option', { value: 'quick' }, 'Quick tunnel（不需要 Cloudflare 帳號）'),
                h('option', { value: 'api' }, 'API Token（固定網址，需要網域）'),
              )),
            h(Field, { label: 'Cloudflare API Token', hint: `目前：${runtime.tunnel?.cloudflare?.hasApiToken ? '已設定' : '未設定'}；留空＝不變更` },
              h(Text, { value: cloudflare.apiToken, onChange: (value) => update({ cloudflare: { apiToken: value } }), type: 'password', placeholder: '貼上 API Token（權限：Account → Cloudflare Tunnel → Edit；Zone → DNS → Edit；選填 Account Settings:Read、Zone:Read 讓面板自動帶入 ID）' })),
            h(Field, { label: '固定網址（hostname）', hint: '例：line.example.com，需在 API Token 可管理的網域內' }, h(Text, { value: cloudflare.hostname, onChange: (value) => update({ cloudflare: { hostname: value } }), placeholder: 'line.example.com' })),
            h(Field, { label: '隧道名稱' }, h(Text, { value: cloudflare.tunnelName, onChange: (value) => update({ cloudflare: { tunnelName: value } }), placeholder: 'dsh-line-bot' })),
            h(Field, { label: 'Account ID（選填）', hint: 'token 看得到多個帳號時才需要填' }, h(Text, { value: cloudflare.accountId, onChange: (value) => update({ cloudflare: { accountId: value } }), placeholder: '自動偵測' })),
            h(Field, { label: 'Zone ID（選填）', hint: '通常會自動從 hostname 找；找不到時再填' }, h(Text, { value: cloudflare.zoneId, onChange: (value) => update({ cloudflare: { zoneId: value } }), placeholder: '自動偵測' })),
            h(Field, { label: 'cloudflared 路徑（選填）', hint: '留空＝自動找 /opt/homebrew/bin、/usr/local/bin 或 <資料夾>/bin；也可以按「下載 cloudflared」' }, h(Text, { value: tunnel.binaryPath, onChange: (value) => update({ tunnel: { binaryPath: value } }), placeholder: '/path/to/cloudflared', mono: true })),
          ),
          h('div', { style: S.row },
            h(Btn, { onClick: () => act('cloudflare-verify'), disabled: !!busy }, busy === 'cloudflare-verify' ? '驗證中…' : '驗證 API Token'),
            h(Btn, { onClick: () => act('cloudflare-provision'), disabled: !!busy, tone: 'primary' }, busy === 'cloudflare-provision' ? '建立中…' : '建立／更新隧道與 DNS'),
            h(Btn, { onClick: () => act('tunnel-download'), disabled: !!busy }, busy === 'tunnel-download' ? '下載中…' : '下載 cloudflared'),
          ),
          h(Toggle, { checked: tunnel.autoConfigureWebhook !== false, onChange: (value) => update({ tunnel: { autoConfigureWebhook: value } }), label: '隧道就緒後自動設定 LINE webhook', hint: '取得 https 網址後自動 PUT 到 LINE，並跑一次 webhook test' }),
          h(Toggle, { checked: tunnel.autoRestart !== false, onChange: (value) => update({ tunnel: { autoRestart: value } }), label: '隧道斷線自動重啟', hint: '最多重試 6 次（間隔漸增）' }),
          h(Field, { label: '自行提供的公開網址（選填）', hint: '已有反向代理／固定網域時填入，例：https://line.example.com；填了就不再開 cloudflared。' },
            h(Text, { value: tunnel.publicUrl, onChange: (value) => update({ tunnel: { publicUrl: value } }), placeholder: 'https://line.example.com' })),
          h('div', { style: S.row },
            h(Btn, { onClick: () => act('tunnel-start'), disabled: !!busy }, busy === 'tunnel-start' ? '啟動中…' : '啟動隧道'),
            h(Btn, { onClick: () => act('tunnel-stop'), disabled: !!busy }, '停止隧道'),
            h(Btn, { onClick: () => act('tunnel-restart'), disabled: !!busy }, '重啟隧道'),
          ),
          tunnelStatus.url ? h(KV, { rows: [['目前網址', tunnelStatus.url], ['cloudflared', `${tunnelStatus.binary?.path || '—'}${tunnelStatus.binary?.version ? `（${tunnelStatus.binary.version}）` : ''}`], ['帳號', tunnelStatus.cloudflare?.accountId || cloudflare.accountId || '—'], ['Zone', tunnelStatus.cloudflare?.zoneId || cloudflare.zoneId || '—'], ['Tunnel ID', tunnelStatus.cloudflare?.tunnelId || cloudflare.tunnelId || '—']] }) : null,
          tunnelStatus.tail ? h('pre', { style: S.pre }, tunnelStatus.tail.slice(-3000)) : null,
          h('div', { style: S.hint }, 'Quick tunnel 每次重啟網址都會變；若 LINE 的 webhook 沒自動更新，按上面「把隧道網址套到 webhook」。API Token 模式需要先在 Cloudflare 建立 API Token（權限：Account → Cloudflare Tunnel → Edit；Zone → DNS → Edit）。若驗證後面板沒自動帶入帳號／Zone，代表 token 少了 Account Settings:Read／Zone:Read，請手動填 Account ID 與 Zone ID（或幫 token 補上讀取權限）。'),
        ),

        // 3.5 模型與接口來源
        h(
          Card,
          {
            id: sectionDomId('model'),
            order: 4,
            title: '模型與接口來源',
            desc: 'LINE 回覆要用的 provider／模型。留空＝跟隨 DSH 目前的預設；選非 DeepSeek 的來源時，下面的餘額功能會自動停用。',
            right: h(Btn, { onClick: () => loadModelCatalog({ force: true }), disabled: !!busy }, busy === 'model-catalog' ? '讀取中…' : '重新讀取清單'),
          },
          h(KV, {
            rows: [
              ['目前使用', `${agentStatus.provider || '—'} / ${agentStatus.model || '—'}${agentStatus.source === 'custom' ? '（面板指定）' : '（跟隨 DSH 預設）'}`],
              ['DSH 預設', `${agentStatus.defaultProvider || '—'} / ${agentStatus.defaultModel || '—'}`],
              ['餘額功能', agentStatus.provider === 'deepseek-account' ? '可用（DeepSeek 官方帳號）' : '已停用（不是 deepseek-account）'],
            ],
          }),
          h('div', { style: S.grid },
            h(Field, { label: '模型接口來源（provider）', hint: '清單來自這個 DSH profile 已註冊的 provider' },
              h('select', {
                style: S.input,
                value: draft.agent.provider || '',
                onChange: (event) => {
                  const provider = event.target.value
                  const entry = modelProviders.find((item) => item.id === provider)
                  const first = entry?.models?.[0]?.id || ''
                  update({ agent: { provider, model: provider ? first : '' } })
                },
              },
                h('option', { value: '' }, `跟隨 DSH 預設${agentStatus.defaultProvider ? `（${agentStatus.defaultProvider} / ${agentStatus.defaultModel}）` : ''}`),
                modelProviders.map((item) => h('option', { key: item.id, value: item.id }, `${item.name}（${item.id}）${item.models?.length ? '' : ' · 無模型資料'}`)),
                draft.agent.provider && !modelProviders.some((item) => item.id === draft.agent.provider)
                  ? h('option', { value: draft.agent.provider }, draft.agent.provider)
                  : null,
              )),
            h(Field, { label: '模型', hint: '可直接輸入模型 id，或從清單選' },
              h('input', {
                style: S.input,
                list: 'line-bot-model-options',
                value: draft.agent.model || '',
                placeholder: '留空＝跟隨預設；例：deepseek-flash',
                onChange: (event) => update({ agent: { model: event.target.value } }),
              }),
              h('datalist', { id: 'line-bot-model-options' },
                ((modelProviders.find((item) => item.id === (draft.agent.provider || agentStatus.defaultProvider)) || {}).models || []).map((item) => h('option', { key: item.id, value: item.id }, item.name))),
            ),
            h(Field, { label: '推理強度（選填）', hint: '留空＝跟隨 provider 預設' },
              h(Text, { value: draft.agent.reasoningEffort || '', onChange: (value) => update({ agent: { reasoningEffort: value } }), placeholder: 'max / high / medium' })),
          ),
          h('div', { style: S.note }, modelCatalog?.error
            ? `讀取模型清單失敗：${modelCatalog.error}`
            : modelCatalog
              ? `共 ${modelProviders.length} 個來源。清單只列已註冊的 provider；實際能不能用仍取決於該來源的憑證。`
              : '正在讀取模型清單…'),
          h('div', { style: S.row },
            h(Btn, { onClick: () => loadModelCatalog({ force: true }), disabled: !!busy }, busy === 'model-catalog' ? '讀取中…' : '重新讀取模型清單'),
            h(Btn, { onClick: () => act('agent-test', { text: '請用一句話確認你現在用的模型來源。' }), disabled: !!busy }, busy === 'agent-test' ? '測試中…' : '測試 Agent 回覆'),
          ),
        ),

        // 4. 人設
        h(
          Card,
          { id: sectionDomId('persona'), order: 5, title: '回覆人設', desc: 'LINE 的回覆會套用這裡選的人設。來源有兩種：大肥魚插件（有安裝時）、插件自己的自訂人設（不依賴任何外掛）。' },
          persona.warning ? h('div', { style: S.warnBox }, persona.warning) : null,
          persona.error ? h('div', { style: S.warnBox }, `讀不到大肥魚插件：${persona.error}`) : null,
          h('div', { style: S.grid },
            h(Field, { label: `使用的人設（${personaCatalog.length} 個可選）` },
              h('select', { value: personaCfg.id || '', onChange: (event) => update({ persona: { id: event.target.value } }), style: S.input },
                personaOptions.length
                  ? h('optgroup', { label: '大肥魚插件' },
                      personaOptions.filter((item) => item.enabled !== false).map((item) =>
                        h('option', { key: item.id, value: item.id }, `${item.name}${item.builtin ? '（內建）' : ''} · ${item.chars} 字`)))
                  : null,
                personaLocal.length
                  ? h('optgroup', { label: '插件自訂' },
                      personaLocal.map((item) => h('option', { key: item.id, value: item.id }, `${item.name} · ${item.chars} 字`)))
                  : null,
                (!personaCatalog.length)
                  ? h('option', { value: personaCfg.id || '' }, selectedName)
                  : null)),
            h(Field, { label: '人設來源' },
              h('div', { style: { fontSize: 12, paddingTop: 4 } },
                selectedIsLocal
                  ? '插件自訂人設：每一輪由插件注入 system prompt，不需要任何外掛。'
                  : `大肥魚 · ${persona.mode || '未知'}${persona.mode === 'session' ? '（可逐 session 指定）' : '（目前不是 session 模式，指定可能無效）'}`)),
          ),
          h(Toggle, { checked: personaCfg.enforce !== false, onChange: (value) => update({ persona: { enforce: value } }), label: '強制使用選擇的人設', hint: '關掉＝完全不套用人設（連大肥魚也不指定）' }),
          h(Toggle, { checked: personaCfg.allowUserSwitch !== false, onChange: (value) => update({ persona: { allowUserSwitch: value } }), label: '允許使用者自己換人設', hint: '開啟後，LINE 使用者可傳「人設」看清單、「人設 2」或「人設 阿茶」切換；只影響他自己' }),
          h('div', { style: S.note }, '每位使用者的人設分開儲存（面板「使用者」區可個別調整或重設）。沒有自己選過的人，會用上面這個預設人設。'),
          h('div', { style: S.row },
            h(Btn, { onClick: () => act('persona-status'), disabled: !!busy }, '重新讀取人設清單'),
            h(Btn, { onClick: () => act('persona-mode', { mode: 'session' }), disabled: !!busy || persona.bridgeAvailable === false }, '切換大肥魚到 session 模式'),
            h(Btn, { onClick: () => act('agent-test'), disabled: !!busy, tone: 'primary' }, busy === 'agent-test' ? '測試中…' : '測試 Agent 回覆'),
          ),
          h('div', { style: S.hint }, '切換 session 模式會改變大肥魚插件在全域的行為（每個 session 可各自指定人設），這是它官方支援的設定。'),
          h('div', { style: { ...S.panelBox, marginTop: 4 } },
            h('div', { style: S.fieldTitle }, '自訂人設（插件內建，不依賴外掛）'),
            h('div', { style: S.hint }, `存在 ${persona.localPath || '<資料夾>/personas.json'}。可以新增／編輯／刪除，或把目前的大肥魚人設複製一份過來再改。`),
            h('div', { style: S.grid },
              h(Field, { label: '名稱' }, h(Text, { value: localEdit.name, onChange: (value) => setLocalEdit((prev) => ({ ...prev, name: value })), placeholder: '例如：我的助手' })),
            ),
            h(Field, { label: '人設內容（會放進 system prompt）' },
              h(Area, { value: localEdit.text, onChange: (value) => setLocalEdit((prev) => ({ ...prev, text: value })), rows: 6, placeholder: '寫下它的身分、說話方式、底線…' })),
            h('div', { style: S.row },
              h(Btn, { onClick: saveLocalPersona, disabled: !!busy, tone: 'primary' }, localEdit.id ? '儲存變更' : '新增人設'),
              localEdit.id ? h(Btn, { onClick: () => setLocalEdit({ id: '', name: '', text: '' }), disabled: !!busy }, '取消編輯') : null,
              h(Btn, { onClick: importPersona, disabled: !!busy || selectedIsLocal }, '把目前人設複製成自訂'),
            ),
            personaLocal.length
              ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 } },
                  personaLocal.map((item) =>
                    h('div', { key: item.id, style: { ...S.row, justifyContent: 'space-between' } },
                      h('span', { style: { fontSize: 12 } }, `${item.name}（${item.chars} 字）`),
                      h('div', { style: S.row },
                        h(Btn, { onClick: () => editLocalPersona(item), disabled: !!busy }, '編輯'),
                        h(Btn, { onClick: () => removeLocalPersona(item), disabled: !!busy, tone: 'danger' }, '刪除')))))
              : h('div', { style: S.hint }, '還沒有自訂人設；填上面的名稱與內容後按「新增人設」。'),
          ),
        ),

        // 4b. 貼吧學習同步
        h(
          Card,
          { id: sectionDomId('sync'), order: 6, title: '貼吧學習同步', desc: '把「刷貼吧」每天演化學到的語氣樣本，寫回上方人設的「## 貼吧學來的口氣」段落，並重載大肥魚插件讓它立即生效。' },
          h(Toggle, { checked: syncCfg.enabled !== false, onChange: (value) => update({ sync: { enabled: value } }), label: '開啟自動同步', hint: '每小時檢查一次；貼吧人設版本有變才寫入（寫入前會備份 personas.json）' }),
          h('div', { style: S.grid },
            h(Field, { label: '同步到哪個人設' },
              h('select', { value: syncTarget, onChange: (event) => update({ sync: { targetPersonaId: event.target.value } }), style: S.input },
                syncPersonaOptions.length
                  ? syncPersonaOptions.map((item) => h('option', { key: item.id, value: item.id }, item.name))
                  : h('option', { value: syncTarget }, '（請先在「回覆人設」頁建立／匯入一個自訂人設）'))),
            h(Field, { label: '檢查間隔（分鐘）', hint: '貼吧每天最多演化一次，60 分鐘夠即時' }, h(Num, { value: syncCfg.intervalMinutes, min: 5, max: 1440, onChange: (value) => update({ sync: { intervalMinutes: value } }) })),
          ),
          h('div', { style: S.row },
            h(Toggle, { checked: syncCfg.syncTraits !== false, onChange: (value) => update({ sync: { syncTraits: value } }), label: '同步性格數值', hint: '把「溫柔 8/10」這類數字也一起更新' }),
            h(Toggle, { checked: syncCfg.reloadPersona !== false, onChange: (value) => update({ sync: { reloadPersona: value } }), label: '寫入後重載大肥魚插件', hint: '大肥魚只在啟動時讀人設檔；不重載的話要等下次重啟才生效' }),
          ),
          h('div', { style: S.row },
            h(Btn, { onClick: applySync, disabled: !!busy, tone: 'primary' }, busy === 'tieba-sync' ? '同步中…' : '立即同步'),
            h(Btn, { onClick: previewSync, disabled: !!busy }, busy === 'tieba-preview' ? '讀取中…' : '預覽差異'),
          ),
          h('div', { style: S.note },
            `貼吧版本：${syncStats.tiebaVersion == null ? '讀不到' : `v${syncStats.tiebaVersion}（${syncStats.tiebaSamples} 句）`}｜上次同步：${syncStats.lastAt ? fmtTime(syncStats.lastAt) : '還沒同步過'}${syncStats.lastVersion != null ? `（版本 ${syncStats.lastVersion}）` : ''}${syncStats.pending ? '｜有新版待同步' : ''}${syncStats.lastError ? `｜錯誤：${syncStats.lastError}` : ''}`),
          syncPreview
            ? h('div', { style: S.panelBox },
                h('div', { style: S.fieldTitle }, `預覽：${syncPreview.changed ? '有變更' : '沒有變更'}（${syncPreview.samples?.length || 0} 句）`),
                h('pre', { style: S.pre }, syncPreview.changed ? syncPreview.nextSection : '（目前內容與新樣本一致）'))
            : null,
        ),

        // 5. 主動傳訊
        h(
          Card,
          { id: sectionDomId('nudge'), order: 9, title: '主動傳訊（大肥魚自己找人聊天）', desc: '由插件內建排程器執行：每隔幾分鐘擲骰子，符合條件就請 Agent 主動傳一句；不適合時 Agent 可回 SKIP。' },
          h(Toggle, { checked: !!nudgeCfg.enabled, onChange: (value) => update({ nudge: { enabled: value } }), label: '開啟主動傳訊' }),
          h('div', { style: S.grid },
            h(Field, { label: '每次擲骰機率（0~1）', hint: '例：0.18 ＝ 每輪 18% 機率開口' }, h(Num, { value: nudgeCfg.chance, min: 0, max: 1, step: 0.01, onChange: (value) => update({ nudge: { chance: value } }) })),
            h(Field, { label: '檢查間隔（分鐘）' }, h(Num, { value: nudgeCfg.intervalMinutes, min: 1, max: 1440, onChange: (value) => update({ nudge: { intervalMinutes: value } }) })),
            h(Field, { label: '每日上限（則）' }, h(Num, { value: nudgeCfg.dailyCap, min: 0, max: 100, onChange: (value) => update({ nudge: { dailyCap: value } }) })),
            h(Field, { label: '每月上限（則）' }, h(Num, { value: nudgeCfg.monthlyCap, min: 0, max: 1000, onChange: (value) => update({ nudge: { monthlyCap: value } }) })),
            h(Field, { label: '兩則之間至少間隔（分鐘）' }, h(Num, { value: nudgeCfg.minGapMinutes, min: 0, max: 10080, onChange: (value) => update({ nudge: { minGapMinutes: value } }) })),
            h(Field, { label: '對方安靜多久才可打擾（分鐘）', hint: '剛聊完不一會兒就別插嘴' }, h(Num, { value: nudgeCfg.idleMinutes, min: 0, max: 10080, onChange: (value) => update({ nudge: { idleMinutes: value } }) })),
            h(Field, { label: '安靜開始（HH:MM）' }, h(Text, { value: nudgeCfg.quietStart, onChange: (value) => update({ nudge: { quietStart: value } }), placeholder: '00:30' })),
            h(Field, { label: '安靜結束（HH:MM）' }, h(Text, { value: nudgeCfg.quietEnd, onChange: (value) => update({ nudge: { quietEnd: value } }), placeholder: '09:30' })),
          ),
          h(Field, { label: '指定對象', hint: '留空＝所有已聊過的使用者中挑最久沒互動的；直接點選要傳給誰' }, h(UserChips, { users: status.users, value: nudgeCfg.targetUserIds, onChange: (ids) => update({ nudge: { targetUserIds: ids } }) })),
          h(Field, { label: '主動傳訊提示詞（給 Agent 的指示）', hint: '留空＝用內建預設（自然、簡短、不提系統、不重複、不適合就 SKIP）' }, h(Area, { value: nudgeCfg.prompt, onChange: (value) => update({ nudge: { prompt: value } }), rows: 4 })),
          h('div', { style: S.row },
            h(Btn, { onClick: () => act('nudge-test', { force: true }), disabled: !!busy, tone: 'primary' }, busy === 'nudge-test' ? '試跑中…' : '立即試傳一則'),
            h(Btn, { onClick: refresh, disabled: !!busy }, '重新整理統計'),
          ),
          h(KV, {
            rows: [
              ['今日', `${nudgeStats.dayCount ?? 0} / ${nudgeCfg.dailyCap ?? '—'} 則`],
              ['本月', `${nudgeStats.monthCount ?? 0} / ${nudgeCfg.monthlyCap ?? '—'} 則`],
              ['上次傳訊', fmtTime(nudgeStats.lastAt)],
              ['下次檢查', fmtTime(nudgeStats.nextAt)],
              ['上次結果', nudgeStats.lastReason || '—'],
            ],
          }),
          nudgeStats.lastError ? h('div', { style: S.errBox }, nudgeStats.lastError) : null,
        ),

        // 5.5 表情包（dsh-meme 圖庫）
        h(
          Card,
          { id: sectionDomId('meme'), order: 10, title: '表情包（dsh-meme 圖庫）', desc: '角色可以在文字後面配一張圖，也可以只回一張圖。圖片來自 dsh-meme 外掛的圖庫；要新增、分類或改描述，請到 dsh-meme 的設定頁。' },
          !memeStatus.available
            ? h('div', { style: S.warnBox }, '沒有偵測到 dsh-meme 外掛（或尚未啟用）。請先安裝並啟用 dsh-meme，這裡才會出現可用圖片。')
            : h('div', null,
                h('div', { style: S.row },
                  h(Badge, { ok: true }, '圖庫 ' + ((memeStatus.packs || []).length) + ' 個'),
                  h(Badge, { ok: true }, '共 ' + (memeStatus.count || 0) + ' 張'),
                  h(Badge, { ok: !!memeStatus.publicBase }, memeStatus.publicBase ? '公開網址正常' : '沒有公開網址'),
                ),
                h(Toggle, { checked: memeCfg.enabled !== false, onChange: (value) => update({ stickers: { enabled: value } }), label: '允許角色使用表情包', hint: '關掉後只回文字' }),
                h(Field, { label: '一次最多幾張', hint: 'LINE 一次回覆最多 5 則訊息，圖片也算在內' }, h(Num, { value: memeCfg.maxPerReply, min: 1, max: 3, step: 1, onChange: (value) => update({ stickers: { maxPerReply: value } }) })),
                h(Toggle, { checked: memoCfgApng(memeCfg), onChange: (value) => update({ stickers: { apng: value } }), label: 'GIF 保留 APNG 動畫', hint: 'LINE 目前不會播放 APNG，只會顯示第一幀；開啟會讓檔案變大' }),
                h('div', { style: S.row },
                  h(Btn, { onClick: () => act('meme-stats'), disabled: !!busy }, busy === 'meme-stats' ? '讀取中…' : '重新讀取圖庫'),
                ),
                h('div', { style: S.fieldTitle }, '圖庫樣本'),
                memeSample.length === 0
                  ? h('div', { style: S.hint }, '目前讀不到樣本；確認 dsh-meme 是否已啟用圖庫。')
                  : h('div', null, memeSample.map((item, index) => h('div', { key: index, style: { fontSize: 13, padding: '4px 0', borderTop: '1px solid var(--dsw-alias-border-l2)' } }, '・' + item.caption + '（' + item.tag + '）'))),
              ),
        ),

        // 6. 使用者
        h(
          Card,
          { id: sectionDomId('users'), order: 11, title: '使用者', desc: '與 bot 互動過的 LINE 使用者。每個人有自己的 DSH session 與工作資料夾（記憶、檔案不互通），人設也可以個別指定。' },
          (status.users || []).length === 0
            ? h('div', { style: S.hint }, '還沒有人傳訊息給 bot。')
            : h('table', { style: S.table },
                h('thead', null, h('tr', null, h('th', { style: S.th }, '使用者'), h('th', { style: S.th }, 'session／記憶資料夾'), h('th', { style: S.th }, '訊息'), h('th', { style: S.th }, '人設'), h('th', { style: S.th }, '上次互動'), h('th', { style: S.th }, ''))),
                h('tbody', null, (status.users || []).map((user) =>
                  h('tr', { key: user.userId },
                    h('td', { style: S.td }, h('div', null, user.displayName || '（未命名）'), h('div', { style: { ...S.hint, ...S.mono } }, user.userId)),
                    h('td', { style: { ...S.td, ...S.mono } }, user.sessionId || '—', user.workspaceDir ? h('div', { style: { ...S.hint, ...S.mono, wordBreak: 'break-all' } }, user.workspaceDir) : null),
                    h('td', { style: S.td }, String(user.messages ?? 0), h('div', { style: S.hint }, `主動 ${user.nudges ?? 0}`)),
                    h('td', { style: S.td },
                      h('select', {
                        value: user.personaId || personaCfg.id || 'dafeiyu',
                        onChange: (event) => act('user-persona', { userId: user.userId, personaId: event.target.value }),
                        style: { ...S.input, padding: '3px 6px', fontSize: 12 },
                        disabled: !!busy,
                      },
                        (personaCatalog.length ? personaCatalog : [{ id: user.personaId, name: user.personaName || user.personaId }]).map((item) =>
                          h('option', { key: item.id, value: item.id }, `${item.name}${item.source === 'local' ? '（自訂）' : ''}`)))),
                    h('td', { style: S.td }, fmtTime(user.lastAt)),
                    h('td', { style: S.td }, h('div', { style: S.row },
                      h(Btn, { onClick: () => act('user-reset', { userId: user.userId }), disabled: !!busy, tone: 'danger' }, '重設 session'),
                      h(Btn, {
                        onClick: () => {
                          if (typeof window !== 'undefined' && !window.confirm('這會清空這個使用者自己的工作資料夾（記憶、檔案），確定？')) return
                          act('user-reset', { userId: user.userId, wipeWorkspace: true })
                        },
                        disabled: !!busy,
                        tone: 'danger',
                      }, '清空記憶'))),
                  )))),
        ),

        // 6.5 群組
        h(
          Card,
          { id: sectionDomId('group'), order: 12, title: '群組', desc: '被加進群組時，只有被 @、被引用，或依機率擲骰才回覆；每個群組有自己的 session、工作資料夾、人設與記憶。' },
          h('div', { style: S.grid },
            h(Field, { label: '沒被點名時的回覆機率（%）', hint: '每則群組訊息用這個機率決定要不要回；0 就只在被 @ 或引用時回' },
              h(Num, { value: Math.round((Number(groupCfg.replyChance) || 0) * 100), min: 0, max: 100, step: 1, onChange: (value) => update({ group: { replyChance: value / 100 } }) })),
          ),
          h('div', { style: S.row },
            h(Toggle, { checked: groupCfg.enabled !== false, onChange: (value) => update({ group: { enabled: value } }), label: '在群組裡運作', hint: '關掉後群組訊息完全不回' }),
            h(Toggle, { checked: groupCfg.replyToMentions !== false, onChange: (value) => update({ group: { replyToMentions: value } }), label: '被 @ 一定回' }),
            h(Toggle, { checked: groupCfg.replyToQuotes !== false, onChange: (value) => update({ group: { replyToQuotes: value } }), label: '被引用一定回' }),
          ),
          groupList.length === 0
            ? h('div', { style: S.hint }, '還沒被加入任何群組，或群組還沒傳過訊息。')
            : h('table', { style: S.table },
                h('thead', null, h('tr', null, h('th', { style: S.th }, '群組'), h('th', { style: S.th }, 'session／資料夾'), h('th', { style: S.th }, '訊息'), h('th', { style: S.th }, '人設'), h('th', { style: S.th }, '上次互動'), h('th', { style: S.th }, ''))),
                h('tbody', null, groupList.map((group) =>
                  h('tr', { key: group.groupId },
                    h('td', { style: S.td }, h('div', null, group.displayName || '（未命名群組）'), h('div', { style: { ...S.hint, ...S.mono } }, group.groupId)),
                    h('td', { style: { ...S.td, ...S.mono } }, group.sessionId || '—', group.workspaceDir ? h('div', { style: { ...S.hint, ...S.mono, wordBreak: 'break-all' } }, group.workspaceDir) : null),
                    h('td', { style: S.td }, String(group.messages ?? 0)),
                    h('td', { style: S.td },
                      h('select', {
                        value: group.personaId || personaCfg.id || 'dafeiyu',
                        onChange: (event) => act('group-persona', { groupId: group.groupId, personaId: event.target.value }),
                        style: { ...S.input, padding: '3px 6px', fontSize: 12 },
                        disabled: !!busy,
                      },
                        (personaCatalog.length ? personaCatalog : [{ id: group.personaId, name: group.personaName || group.personaId }]).map((item) =>
                          h('option', { key: item.id, value: item.id }, `${item.name}${item.source === 'local' ? '（自訂）' : ''}`)))),
                    h('td', { style: S.td }, fmtTime(group.lastAt)),
                    h('td', { style: S.td }, h(Btn, {
                      onClick: () => {
                        if (typeof window !== 'undefined' && !window.confirm('這會清空這個群組自己的 session 與工作資料夾（記憶、檔案），確定？')) return
                        act('group-reset', { groupId: group.groupId, wipeWorkspace: true })
                      },
                      disabled: !!busy,
                      tone: 'danger',
                    }, '清空記憶'))),
                  ))),
        ),

        // 7. 進階設定
        h(
          Card,
          { id: sectionDomId('advanced'), order: 20, title: '進階設定', desc: '通常不用改；出問題時可從這裡調整。' },
          h('div', { style: S.grid },
            h(Field, { label: 'Webhook 連接埠', hint: '改完按儲存；伺服器會自動重啟。' }, h(Num, { value: server.port, min: 1024, max: 65535, onChange: (value) => update({ server: { port: value } }) })),
            h(Field, { label: '每位使用者獨立工作資料夾', hint: '開啟＝每個 LINE 使用者有自己的 cwd（檔案、AGENTS.md、工作區記憶互不相通）' },
              h(Toggle, { checked: agentCfg.perUserWorkspace !== false, onChange: (value) => update({ agent: { perUserWorkspace: value } }), label: '一人一個資料夾', hint: '預設開；關閉則全部共用 agent.cwd' })),
            h(Field, { label: '使用者工作資料夾根目錄（選填）', hint: '留空＝<資料夾>/users/<LINE userId>' }, h(Text, { value: agentCfg.workspaceRoot, onChange: (value) => update({ agent: { workspaceRoot: value } }), placeholder: '留空＝自動', mono: true })),
            h(Field, { label: '讓 Agent 知道貼吧動態', hint: '每輪注入「剛剛有沒有刷貼吧、今天刷過幾場、有沒有日報」；貼吧外掛的紀錄不在時自動略過。' },
              h(Toggle, { checked: agentCfg.tiebaContext !== false, onChange: (value) => update({ agent: { tiebaContext: value } }), label: '注入貼吧動態', hint: '預設開' })),
            h(Field, { label: 'Agent 逾時（毫秒）' }, h(Num, { value: agentCfg.timeoutMs, min: 10000, max: 900000, step: 1000, onChange: (value) => update({ agent: { timeoutMs: value } }) })),
            h(Field, { label: 'Agent provider（留空＝跟隨 DSH 預設）' }, h(Text, { value: agentCfg.provider, onChange: (value) => update({ agent: { provider: value } }), placeholder: 'deepseek-account' })),
            h(Field, { label: 'Agent model（留空＝跟隨 DSH 預設）' }, h(Text, { value: agentCfg.model, onChange: (value) => update({ agent: { model: value } }), placeholder: 'deepseek-flash' })),
            h(Field, { label: 'Agent cwd（留空＝家目錄）' }, h(Text, { value: agentCfg.cwd, onChange: (value) => update({ agent: { cwd: value } }), placeholder: '/Users/you' })),
            h(Field, { label: 'reasoning effort（留空＝預設）' }, h(Text, { value: agentCfg.reasoningEffort, onChange: (value) => update({ agent: { reasoningEffort: value } }), placeholder: 'max' })),
          ),
          h(Field, { label: '歡迎訊息（第一次加好友）' }, h(Area, { value: line.welcomeText, onChange: (value) => update({ line: { welcomeText: value } }), rows: 2 })),
          h(Field, { label: '錯誤訊息' }, h(Area, { value: line.errorReply, onChange: (value) => update({ line: { errorReply: value } }), rows: 2 })),
          h(Field, { label: '空回覆訊息（Agent 沒說話時）' }, h(Area, { value: line.emptyReply, onChange: (value) => update({ line: { emptyReply: value } }), rows: 2 })),
          h('div', { style: S.row },
            h(Btn, { onClick: () => act('logs-clear'), disabled: !!busy, tone: 'danger' }, '清除日誌'),
            h(Btn, { onClick: devReload, disabled: !!busy }, '重新載入 host 模組（開發用）'),
          ),
          h(KV, {
            rows: [
              ['資料夾', status.paths?.dataDir || '—'],
              ['設定檔', status.paths?.configPath || status.paths?.config || '—'],
              ['狀態檔', status.paths?.statePath || status.paths?.state || '—'],
              ['Webhook 路徑', status.server?.endpointPath || '/webhook'],
              ['Agent 模型', runtime.agent?.providerModel ? `${runtime.agent.providerModel.provider || '—'} / ${runtime.agent.providerModel.model || '—'}` : '—'],
              ['執行中', runtime.agent?.running ? '是' : '否'],
            ],
          }),
          h('div', { style: S.label }, '即時日誌'),
          h('pre', { style: S.pre }, (status.logs || []).join('\n') || '（尚無日誌）'),
        ),
      )
    }

    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error }
      }
      componentDidCatch(error) {
        try {
          console.error('[line-bot] 面板錯誤', error)
        } catch {
          /* ignore */
        }
      }
      render() {
        if (this.state.error) {
          return h('div', { style: S.errBox }, 'LINE Bot 面板發生錯誤：', String(this.state.error?.message || this.state.error))
        }
        return this.props.children
      }
    }

    function apply(ctx) {
      const slots = ctx.slots || (typeof ctx.get === 'function' ? ctx.get('slots') : null)
      if (!slots) {
        try {
          console.warn('[line-bot] 找不到 slots 服務，設定面板未註冊')
        } catch {
          /* ignore */
        }
        return
      }
      try {
        slots.inject('settings.section', () =>
          slots.register(
            { name: 'settings.section', id: SECTION_ID, order: 45, label: () => 'LINE Bot' },
            () => h(Boundary, null, h(Panel)),
          ),
        )
      } catch (error) {
        try {
          console.error('[line-bot] 註冊設定頁失敗', error)
        } catch {
          /* ignore */
        }
      }
    }

    return { inject: ['slots'], apply }
  },
})
