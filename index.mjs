// dsh-session-inherit — 宿主半（Host half）
//
// 「继承」：把任意一个已有会话（含冷会话）里**可核对的具体锚点**搬运到一个
// 全新会话，让工作在干净上下文里继续，而不复制旧对话历史。
//
// 为什么不是 /compact、也不是官方的「分叉」：
//   - /compact 只换掉喂进去的历史，解码退化发生在"生成当前这一步"，实测把
//     541,227 token 压到 25,602 之后 4 步内照样复发（某会话）；
//   - 官方分叉会复制整段历史前缀，等于把退化诱因一起带走。
//   本插件走第三条路：新建空会话 + 只注入一份机械提取的交接单，不调 LLM。
//
// 路由（同源 fetch，仅 loopback 使用）：
//   POST /__session-inherit/preview  {sessionId, title?, lang?}
//        → {ok, doc, source, route, boundPreset, inherited, warnings}
//   POST /__session-inherit/commit   {sessionId, title?, doc?, nextStep?, start?, inheritPreset?, lang?}
//        → {ok, sessionId, state, mode, workspace, preset, warnings}
//
// 三处入口（HTTP / session_inherit 工具 / /inherit 命令）共用 lib/inherit.mjs
// 的一条流水线。本文件只做装配、参数归一化与响应形状转换。
//
// 只消费公开服务：agents（硬依赖）/ sessionQuery / sessionController /
// workspaceRegistry / sessionTitle / agentPresets / agentDefaultModel / webServer。
// 全部按需查找，缺一个就降级一项，不让整个插件失活。

import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { DOC_MARK, formatTime } from './lib/extract.mjs'
import { resolveConfig } from './lib/config.mjs'
import { InheritError, inheritSession } from './lib/inherit.mjs'
import { readInheritedBy } from './lib/history.mjs'
import { note, selfTestFlag } from './lib/log.mjs'
import { buildDoc, readSnapshot } from './lib/read.mjs'
import { readBody, sameOrigin, sendJson } from './lib/security.mjs'
import { createChild, renameChild } from './lib/session.mjs'
import { renderSessionSearch, renderSessionSummary, renderSessionTail } from './lib/session-read.mjs'
import { withTimeout } from './lib/timeouts.mjs'

export const name = 'dsh-session-inherit'

/** agents 是硬依赖：没有它就无法新建"会话 + agent"这一整体。 */
export const inject = ['agents']

const ROUTE_PREFIX = '/__session-inherit'
const SESSION_ID_RE = /^(session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 处理 preview 请求。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} resolved - 归一化配置。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @param {import('node:http').ServerResponse} res - 响应。
 */
async function handlePreview(ctx, resolved, req, res) {
  // 第一行就留痕：上一次真实点击时日志里什么都没有，而 note 被放在参数校验之后，
  // 结果无法区分"请求没到"和"被校验拦下"。现在任何到达 handler 的请求都有记录。
  note(`preview hit method=${req.method} origin=${req.headers?.origin ?? '(none)'} host=${req.headers?.host ?? '(none)'} len=${req.headers?.['content-length'] ?? '?'}`)
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'method not allowed' })
    return
  }
  if (!sameOrigin(req)) {
    sendJson(res, 403, { ok: false, error: 'forbidden' })
    return
  }
  let args
  try {
    const body = await readBody(req)
    args = body.length > 0 ? JSON.parse(body) : {}
  } catch (error) {
    sendJson(res, 400, { ok: false, error: `bad json body: ${String(error?.message ?? error)}` })
    return
  }
  const sessionId = typeof args?.sessionId === 'string' ? args.sessionId.trim() : ''
  if (!SESSION_ID_RE.test(sessionId)) {
    sendJson(res, 400, { ok: false, error: `invalid session id: ${sessionId}` })
    return
  }
  try {
    // preview 也要有上界：读一个 10MB 的源会话可能几秒也可能永远不返回（上游把 body
    // 消费掉、压缩帧损坏、磁盘还在写）。commit 一直有 cap，preview 没有——于是同一个
    // 源会话，点「继承」卡死而命令通路正常，排查时非常容易误判成客户端问题。
    const built = await withTimeout(buildDoc(ctx, {
      sessionId,
      title: typeof args?.title === 'string' ? args.title : undefined,
      recentUsers: resolved.recentUsers,
      // 交接单正文跟随客户端语言：英文界面下生成英文交接单，否则新会话读到的
      // 是一份它和用户都不认识的外语正文。
      lang: typeof args?.lang === 'string' ? args.lang : undefined,
      cacheTtlMs: resolved.cacheTtlMs,
    }), resolved.previewTimeoutMs, '读取源会话')
    sendJson(res, 200, {
      ok: true,
      doc: built.doc,
      mark: DOC_MARK,
      source: {
        sessionId,
        title: typeof args?.title === 'string' ? args.title : null,
        cwd: typeof built.header.cwd === 'string' ? built.header.cwd : null,
        agentPreset: typeof built.header.agentPreset === 'string' ? built.header.agentPreset : null,
        turns: built.anchors.turns,
        eventCount: built.anchors.eventCount,
        lastTime: built.anchors.lastTime,
        lastTimeText: formatTime(built.anchors.lastTime),
        fileCount: built.anchors.files.length,
        editedCount: built.anchors.edited.length,
        readCount: built.anchors.read.length,
        failureCount: built.anchors.failures.length,
        commandCount: built.anchors.commands.length,
        todoCount: built.anchors.todos.length,
        inheritedCount: built.anchors.inheritedCount,
      },
      route: built.route,
      // 有没有自定义预设绑定：界面据此决定要不要提「继承当前对话的预设」这件事。
      boundPreset: built.boundPreset ?? null,
      // 这个会话以前被继承过几次：在用户即将再次继承时提示，防止重复继承。
      inherited: readInheritedBy(sessionId),
      warnings: [],
    })
  } catch (error) {
    sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
  }
}

/**
 * 处理 commit 请求：只做参数归一化与响应形状转换，流程在 lib/inherit.mjs。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} resolved - 归一化配置。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @param {import('node:http').ServerResponse} res - 响应。
 */
async function handleCommit(ctx, resolved, req, res) {
  note(`commit hit method=${req.method} origin=${req.headers?.origin ?? '(none)'} host=${req.headers?.host ?? '(none)'} len=${req.headers?.['content-length'] ?? '?'}`)
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'method not allowed' })
    return
  }
  if (!sameOrigin(req)) {
    sendJson(res, 403, { ok: false, error: 'forbidden' })
    return
  }
  let args
  try {
    const body = await readBody(req)
    args = body.length > 0 ? JSON.parse(body) : {}
  } catch (error) {
    sendJson(res, 400, { ok: false, error: `bad json body: ${String(error?.message ?? error)}` })
    return
  }
  const sessionId = typeof args?.sessionId === 'string' ? args.sessionId.trim() : ''
  if (!SESSION_ID_RE.test(sessionId)) {
    sendJson(res, 400, { ok: false, error: `invalid session id: ${sessionId}` })
    return
  }
  // 区分「客户端没传 doc」（agent 工具 / 命令通路）与「客户端传了空 doc」
  // （用户在预览框里把交接单清空）。后者不能静默换成自动生成的版本——那是
  // 用户明确表达的意图，只该如实报错。
  const docFromClient = typeof args?.doc === 'string' ? args.doc : null
  note(`commit start session=${sessionId} docFromClient=${docFromClient !== null} docLen=${docFromClient === null ? 0 : docFromClient.length}`)
  try {
    const result = await inheritSession(ctx, {
      sourceId: sessionId,
      title: typeof args?.title === 'string' ? args.title : undefined,
      doc: docFromClient,
      nextStep: typeof args?.nextStep === 'string' ? args.nextStep : undefined,
      start: typeof args?.start === 'boolean' ? args.start : resolved.startByDefault,
      // 默认继承源会话的预设（自定义预设绑定也算）；用户取消勾选时用 DSH 默认预设。
      inheritPreset: typeof args?.inheritPreset === 'boolean' ? args.inheritPreset : true,
      lang: typeof args?.lang === 'string' ? args.lang : undefined,
      source: 'http',
    }, resolved)
    sendJson(res, 200, {
      ok: true,
      sessionId: result.sessionId,
      state: result.state,
      mode: result.mode,
      workspace: result.workspace,
      resumable: true,
      // 实际挂上的预设（没继承/没绑定时为 null）：界面据此如实提示，不靠猜。
      preset: result.preset,
      presetInherited: result.presetInherited,
      note: result.note,
      warnings: result.warnings,
      ...(result.deduplicated === true ? { deduplicated: true } : {}),
    })
  } catch (error) {
    const status = error instanceof InheritError
      ? (error.code === 'empty-doc' ? 400 : error.code === 'conflicting-commit' ? 409 : 500)
      : 500
    const payload = { ok: false, error: String(error?.message ?? error) }
    if (error instanceof InheritError) payload.code = error.code
    sendJson(res, status, payload)
  }
}

// ── 自检 ──────────────────────────────────────────────────────────────────

/**
 * 启动自检：标志文件存在时，异步跑一次**真实**的创建链路并把结果写日志。
 *
 * 为什么需要它：真实点击的失败现场只有在浏览器里才看得到，而宿主端点的外部
 * 访问需要 web token。自检让插件在启动后自己去跑一遍 `agents.create`，把真实
 * 运行时的结果落进同一个日志文件——不用点界面就能定位。
 *
 * 只建一个**空会话**（不注入交接单、不触发首轮），跑完打上 `[自检] 可删除`
 * 标题，方便识别。全程 catch，绝不影响插件加载。
 * @param {object} ctx - Cordis 上下文。
 */
async function runSelfTest(ctx) {
  const flag = selfTestFlag()
  let payload = {}
  try {
    payload = JSON.parse(readFileSync(flag, 'utf8'))
  } catch {
    payload = {}
  }
  try {
    unlinkSync(flag)
  } catch {
    /* 删不掉就下次再说 */
  }
  note(`selftest start payload=${JSON.stringify(payload)}`)
  try {
    const query = ctx.get('sessionQuery')
    if (query === undefined || typeof query.listSessions !== 'function') throw new Error('sessionQuery 不可用')
    let sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
    if (sessionId.length === 0) {
      const records = await query.listSessions()
      const candidates = records.filter((record) => record !== null && typeof record === 'object' && record.header !== undefined)
      note(`selftest: 候选会话 ${candidates.length} 个`)
      candidates.sort((a, b) => (b.header.createdAt ?? 0) - (a.header.createdAt ?? 0))
      const pick = candidates.find((record) => record.header.cwd !== undefined) ?? candidates[0]
      if (pick === undefined) throw new Error('没有可用会话')
      sessionId = pick.header.id
    }
    note(`selftest: 源会话 ${sessionId}`)
    const built = await withTimeout(
      buildDoc(ctx, { sessionId, recentUsers: 6, cacheTtlMs: 0 }),
      30_000,
      'selftest 读取会话',
    )
    note(`selftest: 交接单 ${built.doc.length} 字符 preset=${built.header.agentPreset ?? '(none)'} route=${built.route === null ? '(none)' : `${built.route.provider}/${built.route.model}`}`)
    const child = await withTimeout(
      createChild(ctx, { header: built.header, route: built.route, presetOverride: built.boundPreset ?? undefined }),
      25_000,
      'selftest 创建会话',
    )
    note(`selftest OK child=${child.id}`)
    try {
      renameChild(ctx, child, '[自检] 可删除')
      note('selftest: 已设标题 [自检] 可删除')
    } catch (error) {
      note(`selftest: 标题设置失败（忽略）: ${String(error?.message ?? error)}`)
    }
  } catch (error) {
    note(`selftest FAIL: ${String(error?.message ?? error)}`)
  }
}

// ── /inherit 参数解析 ─────────────────────────────────────────────────────

/**
 * 解析 `/inherit` 的原始输入：`[<sessionId>] [--next <下一步>]`。
 *
 * 用显式 `--next` 标记而不是"把剩下的文本当下一步"：`/inherit 修复登录 bug`
 * 这种写法会被当成会话 id 直接报错，比默默猜错更清楚。下一步的文本允许带空格，
 * 一直延伸到输入结尾。
 * @param {string} raw - 原始输入（已 trim）。
 * @returns {{sessionId: string, nextStep: string|undefined}} 解析结果。
 */
function parseInheritArgs(raw) {
  if (raw.length === 0) return { sessionId: '', nextStep: undefined }
  const marker = raw.match(/(?:^|\s)--next(?:\s|$)/)
  if (marker === null) return { sessionId: raw, nextStep: undefined }
  const before = raw.slice(0, marker.index).trim()
  const after = raw.slice(marker.index + marker[0].length).trim()
  return { sessionId: before, nextStep: after.length > 0 ? after : undefined }
}

// ── 挂载 ──────────────────────────────────────────────────────────────────

/**
 * 插件入口。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} [config] - profile patch 配置。
 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) return

  /**
   * 注册两个 HTTP 端点。
   * webServer 一律通过 `ctx.get` 取（cordis 下直接读未声明的属性会抛
   * "cannot get property ... without inject"），因此这里接收已解析好的实例。
   * @param {object} host - 用于 effect 的上下文。
   * @param {object} webServer - webServer 服务实例。
   */
  const registerRoutes = (host, webServer) => {
    if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') return
    host.effect(() => webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/preview`,
      handler: (req, res) => handlePreview(ctx, resolved, req, res),
    }))
    host.effect(() => webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/commit`,
      handler: (req, res) => handleCommit(ctx, resolved, req, res),
    }))
  }

  const webServer = ctx.get('webServer')
  if (webServer !== undefined) {
    registerRoutes(ctx, webServer)
  } else {
    ctx.inject(['webServer'], (sub) => registerRoutes(sub, sub.get('webServer')))
  }

  // ── agent 工具通路 ──────────────────────────────────────────────────────
  // 界面点击走的是 HTTP 端点，而那条链路第一次真实点击时卡住了。这里再提供一条
  // 完全绕开 HTTP 的通路：注册一个 `session_inherit` 工具，让 agent（以及通过
  // agent 表达意图的用户）能直接发起继承。注册全程 try/catch——工具形状万一不被
  // 接受，也绝不能连累整条插件 entry 失活。
  ctx.inject(['tools'], (sub) => {
    try {
      const tools = sub.tools
      if (tools !== undefined && typeof tools.register === 'function') {
        const disposer = tools.register({
          name: 'session_inherit',
          description: '把指定会话的"具体锚点"（任务原文、最近的用户指令、动过的文件、跑过的命令、最后一次待办状态）机械提取成一份交接单，在一个全新会话里继续工作——不复制旧对话历史，也不调用 LLM。用于长会话退化或上下文过长时，换一个干净会话接着干。',
          parameters: {
            type: 'object',
            properties: {
              sessionId: { type: 'string', description: '源会话 id，形如 session-<uuid>。' },
              nextStep: { type: 'string', description: '新会话要做的第一步。越具体越好（点名文件 + 一个动作）。' },
              start: { type: 'boolean', description: '是否立即把交接单作为首条消息发出并开始工作；默认 true。' },
            },
            required: ['sessionId'],
            additionalProperties: false,
          },
          output: {
            schema: { type: 'string' },
            render(_args, value) { return [{ type: 'text', text: String(value ?? '') }] },
          },
          async execute(args) {
            const target = String(args?.sessionId ?? '').trim()
            if (!SESSION_ID_RE.test(target)) return `继承失败：sessionId 不合法（${target}）`
            try {
              const result = await inheritSession(ctx, {
                sourceId: target,
                nextStep: typeof args?.nextStep === 'string' ? args.nextStep : undefined,
                start: typeof args?.start === 'boolean' ? args.start : resolved.startByDefault,
                inheritPreset: true,
                source: 'tool',
              }, resolved)
              const lines = [
                `继承完成：新会话 ${result.sessionId}`,
                `模式：${result.mode}`,
                `交接单 ${result.doc.length} 字符。${result.note}`,
              ]
              if (result.warnings.length > 0) {
                lines.push(`已降级 ${result.warnings.length} 项：${result.warnings.map((w) => w.code).join(', ')}`)
              }
              return lines.join('\n')
            } catch (error) {
              note(`tool FAIL: ${String(error?.message ?? error)}`)
              return `继承失败：${String(error?.message ?? error)}`
            }
          },
        })
        note('tool: session_inherit 已注册')
        sub.effect(() => (typeof disposer === 'function' ? disposer : () => {}))
      } else {
        note('tool: tools 服务不可用，跳过工具注册')
      }
    } catch (error) {
      note(`tool 注册失败（已忽略，插件继续工作）: ${String(error?.message ?? error)}`)
    }
  })

  // ── session_read 工具 ───────────────────────────────────────────────────
  // 交接单首行写了源会话编号，但新会话读不了它（多帧 zstd，见 lib/session-read.mjs
  // 的说明）。这个工具把 sessionQuery 包一层，让新会话能按需回查源会话。
  ctx.inject(['tools'], (sub) => {
    try {
      const tools = sub.tools
      if (tools === undefined || typeof tools.register !== 'function') return
      const disposer = tools.register({
        name: 'session_read',
        description: '读取任意 DSH 会话的日志（含已冷掉的会话），用于回查「继承」交接单首行那个源会话。三种模式：search（默认，按关键词搜索并给出命中上下文）、summary（结构化摘要：任务目标 / 改过的文件 / 最近失败 / 待办 / 最后一次回复）、tail（最后 N 个事件）。只读，不创建也不修改任何东西。',
        parameters: {
          type: 'object',
          properties: {
            sessionId: { type: 'string', description: '会话 id，形如 session-<uuid>——就是继承单首行「来源」里那个。' },
            mode: { type: 'string', enum: ['search', 'summary', 'tail'], description: 'search=关键词搜索（默认）；summary=结构化摘要；tail=最后若干事件。' },
            query: { type: 'string', description: 'mode=search 时的关键词，不区分大小写。' },
            limit: { type: 'number', description: '返回条数上限，默认 20，最大 100。' },
          },
          required: ['sessionId'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'string' },
          render(_args, value) { return [{ type: 'text', text: String(value ?? '') }] },
        },
        async execute(args) {
          const target = String(args?.sessionId ?? '').trim()
          if (!SESSION_ID_RE.test(target)) return `读取失败：sessionId 不合法（${target}）`
          const limit = Number.isInteger(args?.limit) ? Math.min(Math.max(args.limit, 1), 100) : 20
          const mode = args?.mode === 'summary' || args?.mode === 'tail' ? args.mode : 'search'
          try {
            // ttl=0：回查是显式动作，不跟 preview 的快照缓存互相干扰。
            const snapshot = await withTimeout(readSnapshot(ctx, target, 0), 30_000, '读取会话')
            const header = snapshot.session !== null && typeof snapshot.session === 'object' ? snapshot.session : {}
            if (mode === 'summary') return renderSessionSummary(target, header, snapshot.events)
            if (mode === 'tail') return renderSessionTail(target, header, snapshot.events, limit)
            return renderSessionSearch(target, header, snapshot.events, String(args?.query ?? ''), limit)
          } catch (error) {
            note(`session_read FAIL: ${String(error?.message ?? error)}`)
            return `读取失败：${String(error?.message ?? error)}`
          }
        },
      })
      note('tool: session_read 已注册')
      sub.effect(() => (typeof disposer === 'function' ? disposer : () => {}))
    } catch (error) {
      note(`session_read 注册失败（已忽略）: ${String(error?.message ?? error)}`)
    }
  })

  // ── /inherit 命令通路 ───────────────────────────────────────────────────
  // 第三条入口：宿主侧直接执行，不经过 HTTP、也不依赖客户端半区。
  // 不带参数时继承**当前会话**——这是最常用的场景。同样必须用 inject 等 commands。
  ctx.inject(['commands'], (sub) => {
    try {
      sub.commands.register({
        name: 'inherit',
        description: '把当前会话（或指定会话）的具体锚点提取成交接单，在一个全新会话里继续工作；不复制旧对话历史，也不调用 LLM。不带参数时继承当前会话。',
        input: { hint: '[<sessionId>] [--next <下一步>]' },
        async handler(invocation) {
          const agentSession = invocation !== null && invocation !== undefined && invocation.agent !== undefined
            ? invocation.agent.session
            : undefined
          const raw = typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim() : ''
          const parsed = parseInheritArgs(raw)
          const target = parsed.sessionId.length > 0
            ? parsed.sessionId
            : (agentSession !== undefined && agentSession !== null ? agentSession.id : '')
          if (!SESSION_ID_RE.test(target)) {
            return { kind: 'error', text: `继承：会话 id 不合法（${target.length > 0 ? target : '空'}）；用法 /inherit [<sessionId>] [--next <下一步>]` }
          }
          try {
            const result = await inheritSession(ctx, {
              sourceId: target,
              nextStep: parsed.nextStep,
              start: resolved.startByDefault,
              inheritPreset: true,
              source: 'command',
            }, resolved)
            const lines = [
              `继承完成：新会话 \`${result.sessionId}\``,
              `交接单 ${result.doc.length} 字符。`,
              result.note,
              '去侧边栏打开它继续工作（源会话未改动）。',
            ]
            if (result.warnings.length > 0) {
              lines.push(`已降级 ${result.warnings.length} 项：${result.warnings.map((w) => w.code).join(', ')}`)
            }
            return { kind: 'success', text: lines.join('\n') }
          } catch (error) {
            note(`command FAIL: ${String(error?.message ?? error)}`)
            return { kind: 'error', text: `继承失败：${String(error?.message ?? error)}` }
          }
        },
      })
      note('command: /inherit 已注册')
    } catch (error) {
      note(`command 注册失败（已忽略）: ${String(error?.message ?? error)}`)
    }
  })

  // 自检标志存在时，异步跑一次真实创建链路（见 runSelfTest 的说明）。
  // 放在 apply 末尾、且不 await：它绝不能拖慢或阻断插件激活。
  if (existsSync(selfTestFlag())) {
    setTimeout(() => {
      runSelfTest(ctx).catch((error) => note(`selftest crash: ${String(error?.message ?? error)}`))
    }, 3000)
  }
}
