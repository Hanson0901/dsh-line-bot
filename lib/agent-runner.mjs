// 把「一個 LINE 訊息」變成一輪真正的 DSH Agent 回覆。
// 這裡刻意照抄 dsh-headless 的一次性驅動流程：建立/接續 agent → whenIdle →
// followup → 等子代理收斂 → flush session → 從 session 事件裡取出最終文字。
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { sleep } from './util.mjs'

function userMessage(text, images = []) {
  const content = [{ type: 'text', text }]
  for (const attachment of images) content.push({ type: 'image', attachment })
  return {
    id: randomUUID(),
    role: 'user',
    content,
    source: { kind: 'user' },
  }
}

function summarizeAssistant(session, firstSeq) {
  let started = false
  let text = ''
  let reason
  for (let seq = firstSeq; seq < session.seq; seq += 1) {
    const event = session.eventAt(seq)
    if (!event) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (event.type === 'turn/end') {
      if (started && event.data && 'reason' in event.data) reason = event.data.reason
      continue
    }
    if (!started || event.type !== 'assistant/message') continue
    const content = event.data?.message?.content
    if (!Array.isArray(content)) continue
    const joined = content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('')
      .trim()
    if (joined) text = joined
  }
  return { text, reason }
}

export function createAgentRunner({ ctx, logger, getConfig }) {
  let running = 0
  let lastError = ''
  let lastDurationMs = 0
  let lastFinishedAt = 0

  function agentOptions() {
    const cfg = getConfig()
    const defaultModel = ctx.get?.('agentDefaultModel')
    let selection = null
    try {
      selection = defaultModel?.currentSelection?.() || null
    } catch {
      selection = null
    }
    const provider = String(cfg.agent.provider || selection?.provider || '').trim()
    const model = String(cfg.agent.model || selection?.model || '').trim()
    if (!provider || !model) throw new Error('沒有可用的模型：請在面板「進階」指定 provider/model，或設定預設模型')
    const options = { provider, model }
    const effort = String(cfg.agent.reasoningEffort || '').trim()
    if (effort) options.reasoningEffort = effort
    return { options, provider, model }
  }

  async function resolveCwd(override) {
    const cfg = getConfig()
    const fs = ctx.get?.('fs')
    const target = String(override || '').trim() || cfg.agent.cwd || os.homedir()
    try {
      if (fs?.resolve && fs?.processPath) return fs.processPath(await fs.resolve(target))
    } catch (error) {
      logger?.warn?.(`工作目錄解析失敗，改用 ${target}：${error?.message || error}`)
    }
    return target
  }

  // 把「插件自己的人設」與「貼吧動態」掛進這個 agent 的 system prompt。
  // 自訂人設只有選了才注入；大肥魚的人設走它自己的 session 指定。
  function agentSetup({ personaText, contextText, tools = [] }) {
    return (agentCtx) => {
      try {
        const prompt = agentCtx?.systemPrompt
        if (!prompt?.section) {
          logger?.warn?.('這個 profile 沒有 systemPrompt，自訂人設與貼吧動態都不會被注入')
          return
        }
        let order = 100
        try {
          const resolved = prompt.getSectionOrder?.('DEPLOYMENT_PERSONA_PREFIX')
          if (typeof resolved === 'number') order = resolved
        } catch {
          /* 用預設順序 */
        }
        // dsh-meme 外掛會注入它自己的「陪伴模式」提示詞（叫模型用 send_meme／[表情:]）。
        // LINE 沒有那個前端配圖器，這段會和本外掛的標記規則打架，所以在最外層把它濾掉。
        try {
          agentCtx.effect(
            () => agentCtx.on?.('system-prompt/assemble', async (_assembly, _context, next) => {
              const assembled = await next()
              if (!Array.isArray(assembled?.sections)) return assembled
              const sections = assembled.sections.filter((section) => section?.name !== 'dsh-expression:companion')
              return sections.length === assembled.sections.length ? assembled : { ...assembled, sections }
            }, { prepend: true }),
            'line-bot: drop dsh-meme companion prompt',
          )
        } catch (error) {
          logger?.warn?.(`無法覆寫 dsh-meme 提示詞：${error?.message || error}`)
        }
        if (personaText) {
          agentCtx.effect(
            () => prompt.section({
              name: 'line-bot:persona',
              order,
              text: personaText,
              interpolate: false,
            }),
            'line-bot: persona section',
          )
        }
        if (contextText) {
          agentCtx.effect(
            () => prompt.section({
              name: 'line-bot:tieba-context',
              order: order + 20,
              text: contextText,
              interpolate: false,
            }),
            'line-bot: tieba context section',
          )
        }
      } catch (error) {
        logger?.warn?.(`注入人設／貼吧動態失敗：${error?.message || error}`)
      }
      try {
        const registry = agentCtx.get?.('tools') || agentCtx.tools
        if (registry?.restrict) {
          for (const name of ['send_meme', 'learn_meme', 'meme_update', 'meme_list']) {
            try {
              agentCtx.effect(() => registry.restrict({ deny: [name] }), `line-bot: hide ${name}`)
            } catch {
              /* 這個 profile 沒有這個工具就略過 */
            }
          }
        }
      } catch (error) {
        logger?.warn?.(`隱藏 dsh-meme 工具失敗：${error?.message || error}`)
      }
      if (Array.isArray(tools) && tools.length > 0) {
        try {
          const registry = agentCtx.get?.('tools') || agentCtx.tools
          if (!registry?.register) throw new Error('這個 profile 沒有 tools 服務')
          for (const spec of tools) {
            agentCtx.effect(() => registry.register(spec), `line-bot: tool ${spec.name}`)
          }
        } catch (error) {
          logger?.warn?.(`掛載記憶工具失敗：${error?.message || error}`)
        }
      }
    }
  }

  async function openAgent(sessionId, options, cwd, setup) {
    const agents = ctx.get?.('agents')
    if (!agents) throw new Error('agents 服務不可用（這個 profile 沒有 agent 核心）')
    try {
      const live = agents.get?.(sessionId)
      if (live) return { agent: live, handle: null }
    } catch {
      /* 找不到就往下建立 */
    }
    try {
      const handle = await agents.create({ sessionId, meta: { cwd }, agentOptions: options, ...(setup ? { setup } : {}) })
      return { agent: handle.agent, handle }
    } catch (createError) {
      try {
        const handle = await agents.resume({ resumeSessionId: sessionId, agentOptions: options, ...(setup ? { setup } : {}) })
        return { agent: handle.agent, handle }
      } catch (resumeError) {
        const detail = `${createError?.message || createError}；${resumeError?.message || resumeError}`
        throw new Error(`建立/接續 LINE session 失敗：${detail}`)
      }
    }
  }

  async function drain(agent) {
    const subagents = ctx.get?.('subagents')
    for (;;) {
      await agent.whenIdle()
      const idleSeq = agent.session.seq
      let waitingChildren = false
      try {
        waitingChildren = Boolean(await subagents?.waitForChildren?.(agent))
      } catch {
        waitingChildren = false
      }
      if (!waitingChildren && agent.status === 'idle' && agent.session.seq === idleSeq) return
    }
  }

  async function turn({ sessionId, text, persona, personaClient, personaText, contextText, tools = [], images = [], cwd: cwdOverride }) {
    const cfg = getConfig()
    const timeoutMs = cfg.agent.timeoutMs || 180000
    const { options } = agentOptions()
    const cwd = await resolveCwd(cwdOverride)
    const startedAt = Date.now()
    running += 1
    let agent = null
    let handle = null
    let failure = null
    let offError = null
    let offEnd = null

    try {
      const setup = personaText || contextText || tools.length > 0 ? agentSetup({ personaText, contextText, tools }) : undefined
      const opened = await openAgent(sessionId, options, cwd, setup)
      agent = opened.agent
      handle = opened.handle
      await agent.whenIdle()

      // 先把這個 LINE session 的人設釘好，再送訊息；大肥魚在組 system prompt 時就會套用。
      if (persona && personaClient) {
        try {
          await personaClient.setSessionPersona(agent.id || sessionId, persona)
        } catch (error) {
          logger?.warn?.(`套用人設「${persona}」失敗：${error?.message || error}`)
        }
      }

      offError = ctx.on?.('agent/error', (payload) => {
        const subject = payload?.agent
        if (subject ? subject === agent || subject?.id === agent.id : true) failure = payload?.error
      })
      offEnd = ctx.on?.('session/event', (session, event) => {
        if (session !== agent.session) return
        if (event?.type === 'turn/end' && event.data?.reason?.kind === 'error' && event.data?.reason?.error) {
          failure = failure || event.data.reason.error
        }
      })

      const firstSeq = agent.session.seq
      agent.followup(userMessage(text, images))

      let timedOut = false
      const timer = new Promise((_, reject) => {
        const id = setTimeout(() => {
          timedOut = true
          reject(Object.assign(new Error('agent turn 逾時'), { code: 'TURN_TIMEOUT' }))
        }, timeoutMs)
        if (typeof id?.unref === 'function') id.unref()
      })
      try {
        await Promise.race([drain(agent), timer])
      } catch (error) {
        if (timedOut) {
          try {
            agent.cancel({ kind: 'user' })
          } catch {
            /* 已經停了 */
          }
          await Promise.race([agent.whenIdle().catch(() => {}), sleep(5000)])
          throw new Error('回覆逾時：agent 沒有在時限內完成')
        }
        throw error
      }

      if (failure) {
        const detail = failure instanceof Error ? failure.message : failure?.message || JSON.stringify(failure)
        throw new Error(String(detail || 'agent 回報錯誤'))
      }

      const outcome = summarizeAssistant(agent.session, firstSeq)
      try {
        await ctx.get?.('sessions')?.flush?.(agent.session)
      } catch (error) {
        logger?.warn?.(`flush session 失敗：${error?.message || error}`)
      }
      lastDurationMs = Date.now() - startedAt
      lastFinishedAt = Date.now()
      lastError = ''
      return { text: outcome.text, reason: outcome.reason, sessionId: agent.id || sessionId }
    } catch (error) {
      lastError = error?.message || String(error)
      lastFinishedAt = Date.now()
      throw error
    } finally {
      running -= 1
      try {
        offError?.()
        offEnd?.()
      } catch {
        /* ignore */
      }
      // 每輪結束就 dispose：下一則訊息改用 resume 接續同一個 session。
      // 這樣面板改模型/人設後一定套用新的 agent options，不會沿用舊的 live agent。
      try {
        await handle?.dispose?.()
      } catch (error) {
        logger?.warn?.(`dispose agent 失敗：${error?.message || error}`)
      }
    }
  }

  return {
    turn,
    stats: () => ({ running, lastError, lastDurationMs, lastFinishedAt, providerModel: safeModelLabel() }),
  }

  function safeModelLabel() {
    try {
      const { provider, model } = agentOptions()
      return { provider, model }
    } catch {
      return null
    }
  }
}
