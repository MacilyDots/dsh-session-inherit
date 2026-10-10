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
//   POST /__session-inherit/preview  {sessionId, title, recentUsers?}
//        → {ok, doc, source, route}
//   POST /__session-inherit/commit   {sessionId, title, doc?, nextStep?, start?}
//        → {ok, sessionId, mode, workspace}
//
// 只消费公开服务：agents（硬依赖）/ sessionQuery / sessionController /
// workspaceRegistry / sessionTitle / agentPresets / agentDefaultModel / webServer。
// 全部按需查找，缺一个就降级一项，不让整个插件失活。

import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { collectAnchors, composeInheritDoc, formatTime, replaceNextStepSection, DOC_MARK } from './lib/extract.mjs'

export const name = 'dsh-session-inherit'

/** agents 是硬依赖：没有它就无法新建"会话 + agent"这一整体。 */
export const inject = ['agents']

const ROUTE_PREFIX = '/__session-inherit'
const MAX_BODY_BYTES = 4 * 1024 * 1024
const SNAPSHOT_TTL_MS = 120_000
const SNAPSHOT_LIMIT = 3
const SESSION_ID_RE = /^(session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const DEFAULTS = {
  enabled: true,
  recentUsers: 6,
  startByDefault: true,
  cacheTtlMs: SNAPSHOT_TTL_MS,
}

/**
 * 归一化配置（不做 schema 校验依赖：非法值回落到默认，保证插件总能挂载）。
 * @param {object} config - profile patch 里传入的配置。
 * @returns {{enabled: boolean, recentUsers: number, startByDefault: boolean, cacheTtlMs: number}} 归一化结果。
 */
function resolveConfig(config) {
  const src = config !== null && typeof config === 'object' ? config : {}
  const recentUsers = Number.isInteger(src.recentUsers) && src.recentUsers >= 1 && src.recentUsers <= 50
    ? src.recentUsers
    : DEFAULTS.recentUsers
  const cacheTtlMs = Number.isFinite(src.cacheTtlMs) && src.cacheTtlMs >= 0
    ? src.cacheTtlMs
    : DEFAULTS.cacheTtlMs
  return {
    enabled: src.enabled !== false,
    recentUsers,
    startByDefault: src.startByDefault !== false,
    cacheTtlMs,
  }
}

// ── 诊断日志与超时 ────────────────────────────────────────────────────────
// 第一次真实点击时卡在"正在创建…"而没有现场可看，所以每个阶段都落一行到
// %DSH_HOME%\logs\dsh-session-inherit.log；同时给每个外部 await 加超时，
// 保证界面不会无限等待。写日志永远不能影响主流程。

/** @returns {string} 诊断日志文件路径。 */
function logFile() {
  // 环境变量优先：离线测试必须把日志写到临时文件，绝不能污染真实诊断日志
  // （上一次就发生过——测试用的假 session id 混进了生产日志，差点误判）。
  if (typeof process.env.DSH_SESSION_INHERIT_LOG === 'string' && process.env.DSH_SESSION_INHERIT_LOG.length > 0) {
    return process.env.DSH_SESSION_INHERIT_LOG
  }
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'logs', 'dsh-session-inherit.log')
}

/** @returns {string} 自检标志文件路径（存在即触发一次真实链路自检）。 */
function selfTestFlag() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'session-inherit-selftest.json')
}

/**
 * 追加一行诊断日志（失败静默）。
 * @param {string} message - 内容。
 */
function note(message) {
  try {
    const file = logFile()
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`)
  } catch {
    /* 日志永远不能影响主流程 */
  }
}

/**
 * 给一个 promise 加超时，避免界面无限等待。
 * @param {Promise<unknown>} promise - 目标。
 * @param {number} ms - 超时毫秒。
 * @param {string} label - 步骤名（拼进错误信息）。
 * @returns {Promise<unknown>} 结果，或超时错误。
 */
function withTimeout(promise, ms, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} 超过 ${Math.round(ms / 1000)} 秒未返回`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

// ── HTTP 小工具 ────────────────────────────────────────────────────────────

/**
 * 回写 JSON。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {number} status - 状态码。
 * @param {unknown} payload - 负载。
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * 读取请求体（带上限 + 超时）。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @param {number} [timeoutMs] - 读取超时（默认 8 秒）。
 * @returns {Promise<string>} 请求体文本。
 */
function readBody(req, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let data = ''
    let settled = false
    let timer
    /**
     * 只结算一次并清掉超时器。
     * @param {Function} settle - resolve 或 reject。
     * @param {unknown} value - 结算值。
     */
    const finish = (settle, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      settle(value)
    }
    // 必须能超时退出：如果上游已经把 body 消费掉，'end' 永远不会再来，
    // 这个 Promise 就会连同 handler 和界面一起永久挂起——正是卡死的症状之一。
    timer = setTimeout(() => finish(reject, new Error('request body timeout (8s)')), timeoutMs)
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > MAX_BODY_BYTES) {
        req.destroy()
        finish(reject, new Error('request body too large'))
      }
    })
    req.on('end', () => finish(resolve, data))
    req.on('error', (error) => finish(reject, error))
    req.on('aborted', () => finish(reject, new Error('aborted')))
  })
}

/**
 * 同源判定：拒绝跨站发起（简单 CSRF 护栏，浏览器侧本来就只从本页发起）。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {boolean} 是否同源。
 */
function sameOrigin(req) {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin.length === 0) return true // 非浏览器发起
  const host = req.headers.host
  if (typeof host !== 'string') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

// ── 会话读取（带短期缓存，preview → commit 只读一次） ──────────────────────

/** @type {Map<string, {at: number, snapshot: object}>} 最近的会话快照缓存。 */
const snapshotCache = new Map()

/**
 * 读取一个会话的完整日志（冷会话安全）。
 * preview 与 commit 共用一次读取；ttlMs 为 0 时完全不缓存。
 * @param {object} ctx - Cordis 上下文。
 * @param {string} sessionId - 会话 id。
 * @param {number} ttlMs - 缓存有效期（毫秒）。
 * @returns {Promise<{session: object, events: object[]}>} 会话 header 与事件。
 */
async function readSnapshot(ctx, sessionId, ttlMs) {
  if (ttlMs > 0) {
    const cached = snapshotCache.get(sessionId)
    if (cached !== undefined && Date.now() - cached.at < ttlMs) return cached.snapshot
  }

  const query = ctx.get('sessionQuery')
  if (query === undefined || typeof query.readSession !== 'function') {
    throw new Error('sessionQuery 服务不可用，无法读取会话日志')
  }
  const snapshot = await query.readSession(sessionId)
  if (snapshot === null || typeof snapshot !== 'object' || !Array.isArray(snapshot.events)) {
    throw new Error(`读取会话日志失败：${sessionId}`)
  }
  if (ttlMs > 0) {
    snapshotCache.set(sessionId, { at: Date.now(), snapshot })
    if (snapshotCache.size > SNAPSHOT_LIMIT) {
      // 只保留最近 N 条，避免大会话日志长期驻留内存。
      const oldest = [...snapshotCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (oldest !== undefined) snapshotCache.delete(oldest[0])
    }
  }
  return snapshot
}

// ── 路由与预设 ────────────────────────────────────────────────────────────

/**
 * 从事件流里取最后一次请求使用的模型路由。
 * @param {object[]} events - 事件数组。
 * @returns {{provider: string, model: string}|null} 路由或 null。
 */
function extractRoute(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event === null || typeof event !== 'object') continue
    if (event.type !== 'request/header') continue
    const config = event.data?.header?.config
    if (config !== null && typeof config === 'object'
      && typeof config.provider === 'string' && typeof config.model === 'string') {
      return { provider: config.provider, model: config.model }
    }
  }
  return null
}

/**
 * 解析最终使用的模型路由：源会话最近一次请求 → 部署默认。
 * @param {object} ctx - Cordis 上下文。
 * @param {object[]} events - 源会话事件。
 * @returns {{provider: string, model: string}|null} 路由或 null。
 */
function resolveRoute(ctx, events) {
  const fromLog = extractRoute(events)
  if (fromLog !== null) return fromLog
  const defaults = ctx.get('agentDefaultModel')
  if (defaults !== undefined && typeof defaults.currentSelection === 'function') {
    try {
      const selection = defaults.currentSelection()
      if (selection !== null && typeof selection === 'object'
        && typeof selection.provider === 'string' && typeof selection.model === 'string') {
        return { provider: selection.provider, model: selection.model }
      }
    } catch {
      /* 无默认模型：交给 agents.create 自行决定 */
    }
  }
  return null
}

/**
 * 组合子会话的 agent preset（沿用源会话的系统提示 / 工具 / 技能构成）。
 * 没有 registry 时仍把源会话的 preset id 记进 header（保持延续性），只是不挂载。
 * @param {object} ctx - Cordis 上下文。
 * @param {string|undefined} presetId - 源会话记录的 preset id。
 * @returns {Promise<{agentPreset?: string, setup: Function}>} 组合结果。
 */
async function composeForPreset(ctx, presetId) {
  const fallbackId = typeof presetId === 'string' && presetId.trim().length > 0 ? presetId.trim() : undefined
  const marked = fallbackId === undefined
    ? { setup: () => undefined }
    : { agentPreset: fallbackId, setup: () => undefined }
  const presets = ctx.get('agentPresets')
  if (presets === undefined || typeof presets.resolve !== 'function') return marked
  try {
    const resolved = await presets.resolve(fallbackId)
    const id = resolved !== null && typeof resolved === 'object' ? resolved.id : undefined
    if (typeof id !== 'string' || id.length === 0) return marked
    return {
      agentPreset: id,
      setup: async (agentCtx) => {
        await presets.mount(agentCtx, id)
      },
    }
  } catch {
    return marked
  }
}

// ── 创建子会话 ────────────────────────────────────────────────────────────

/**
 * 新建"会话 + agent"整体（必须一起建：只建裸会话会让客户端打开时走 resume
 * 撞上 "cannot prepare while it is live"）。
 * @param {object} ctx - Cordis 上下文。
 * @param {{header: object, route: {provider: string, model: string}|null}} input - 源会话信息。
 * @returns {Promise<object>} 子会话对象。
 */
async function createChild(ctx, input) {
  const sourceHeader = input.header !== null && typeof input.header === 'object' ? input.header : {}
  const composition = input.mountPreset === false
    ? {
        ...(typeof sourceHeader.agentPreset === 'string' && sourceHeader.agentPreset.length > 0
          ? { agentPreset: sourceHeader.agentPreset }
          : {}),
        setup: () => undefined,
      }
    : await composeForPreset(ctx, sourceHeader.agentPreset)
  // 注意：这里**不传** `parentSession`。
  // 它是 fork-lineage 字段，而我们的源会话常常是冷的；第一次真实点击时挂起
  // 就发生在 agents.create 上，去掉这条父链后创建是纯新增，不再依赖源会话状态。
  // 来源信息由交接单正文自己携带（含源会话 id），不依赖 header lineage。
  const meta = {
    ...(typeof sourceHeader.cwd === 'string' && sourceHeader.cwd.length > 0 ? { cwd: sourceHeader.cwd } : {}),
    ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
  }
  note(`create: preset=${composition.agentPreset ?? '(none)'} mountPreset=${input.mountPreset !== false} cwd=${meta.cwd ?? '(none)'} route=${input.route === null || input.route === undefined ? '(none)' : `${input.route.provider}/${input.route.model}`}`)
  const handle = await ctx.agents.create({
    sessionId: `session-${randomUUID()}`,
    agentOptions: input.route !== null && input.route !== undefined
      ? { provider: input.route.provider, model: input.route.model }
      : {},
    meta,
    setup: composition.setup,
  })
  const session = handle?.agent?.session
  if (session === undefined || session === null) throw new Error('agents.create 未返回会话')
  return session
}

/**
 * 把子会话挂进源会话所在的工作区分组（失败仅告警：会话仍可用，只是暂落"未分组"）。
 * @param {object} ctx - Cordis 上下文。
 * @param {string|undefined} cwd - 工作目录。
 * @param {string} childSessionId - 子会话 id。
 * @returns {Promise<boolean>} 是否挂载成功。
 */
async function attachWorkspace(ctx, cwd, childSessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined || typeof registry.create !== 'function') return false
  if (typeof cwd !== 'string' || cwd.length === 0) return false
  const workspace = await registry.create(cwd)
  if (workspace === null || typeof workspace !== 'object' || typeof workspace.attachSession !== 'function') return false
  await workspace.attachSession(childSessionId)
  return true
}

/**
 * 构造一条可追加的用户消息（优先用官方构造器，失败则手写等价结构）。
 * @param {string} text - 正文。
 * @returns {Promise<object>} user/message 的事件数据。
 */
async function makeUserMessage(text) {
  const content = [{ type: 'text', text }]
  try {
    const mod = await import('@deepseek-ai/dsh-llm')
    if (typeof mod.createUserMessage === 'function') {
      return mod.createUserMessage({ content, source: { kind: 'user' } })
    }
  } catch {
    /* 包不可解析：用手写结构兜底 */
  }
  return { id: randomUUID(), role: 'user', content, source: { kind: 'user' } }
}

/**
 * 把交接单送进子会话。
 * 默认走 sessionController.prompt：一条正常的用户消息，并立即开始工作；
 * prompt 不可用或失败时降级为直接 append（只记录、不触发首轮）。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} child - 子会话。
 * @param {string} doc - 交接单正文。
 * @param {boolean} start - 是否立即开始。
 * @returns {Promise<{mode: 'prompted'|'appended'|'appended-after-prompt-failure', note: string}>} 注入结果。
 */
async function injectDoc(ctx, child, doc, start) {
  if (start) {
    const controller = ctx.get('sessionController')
    if (controller !== undefined && typeof controller.prompt === 'function') {
      // prompt 的契约只承诺"投递被接受"，但真实运行时它可能一直挂到整个 turn 跑完
      // （第一次真实点击时 agent 已经跑了很多步，而界面还在等回执）。界面不能等它：
      // 8 秒内没回执就当作已投递并继续，agent 该跑还是会跑。
      const call = controller.prompt({
        requestId: `inherit-${randomUUID()}`,
        sessionId: child.id,
        mode: 'queue',
        content: [{ type: 'text', text: doc }],
      }, new AbortController().signal)
      // 迟到的失败不能变成 unhandled rejection（下面 8 秒窗口之后的那些）。
      call.catch(() => { /* 由 outcome 分支处理 */ })
      const outcome = await Promise.race([
        call.then(() => 'accepted', (error) => ({ failed: error })),
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 8_000)),
      ])
      if (outcome === 'accepted') {
        return { mode: 'prompted', note: '交接单已作为首条消息发出，新会话已开始工作。' }
      }
      if (outcome === 'timeout') {
        note(`prompt: 8 秒未回执，按已投递继续（child=${child.id}）`)
        return { mode: 'prompted', note: '交接单已发出，新会话正在开始工作（宿主未在 8 秒内回执，属正常）。' }
      }
      const message = String(outcome.failed?.message ?? outcome.failed)
      note(`prompt 失败: ${message}`)
      const fallbackNote = await appendDoc(child, doc)
      return {
        mode: 'appended-after-prompt-failure',
        note: `自动开始失败（${message}），已改为只注入交接单：${fallbackNote}`,
      }
    }
  }
  const noteText = await appendDoc(child, doc)
  return { mode: 'appended', note: noteText }
}

/**
 * 直接追加交接单（不触发首轮）。
 * @param {object} child - 子会话。
 * @param {string} doc - 交接单正文。
 * @returns {Promise<string>} 说明文本。
 */
async function appendDoc(child, doc) {
  if (typeof child.append !== 'function') {
    throw new Error('会话不支持 append，交接单未能注入')
  }
  const message = await makeUserMessage(doc)
  child.append('user/message', message, { surfaceOp: 'append' })
  return '交接单已写入新会话，打开后直接说要做什么即可。'
}

/**
 * 给子会话一个可辨识的标题（失败仅告警）。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} child - 子会话。
 * @param {string} sourceTitle - 源会话标题。
 */
function renameChild(ctx, child, sourceTitle) {
  const titles = ctx.get('sessionTitle')
  if (titles === undefined || typeof titles.rename !== 'function') return
  const base = typeof sourceTitle === 'string' && sourceTitle.trim().length > 0 ? sourceTitle.trim() : '会话'
  try {
    titles.rename(child, `继承: ${base}`.slice(0, 80))
  } catch {
    /* 标题不是关键路径 */
  }
}

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

// ── 继承记录（旁路） ──────────────────────────────────────────────────────
//
// 为什么是旁路文件，而不是"给源会话改标题"：
// `sessionTitle.rename(session, title)` 的契约要求传入**活着的** session 对象
// （源码里断言 `ctx.sessions.get(id) === session`，且 `sessions.get` 的文档明确
// "returns undefined when no live session has that id"）。而本插件最主要的场景
// 恰恰是对**冷会话**继承——那时根本拿不到 session 对象，改名必然失败。
// 所以把「谁被继承到了哪里」记在会话日志之外，在**用户真正要做决定的时刻**
// （点开预览框）提示出来，顺带挡住重复继承。

/** @returns {string} 继承记录文件路径。 */
function historyFile() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'session-inherit', 'history.json')
}

/**
 * 读取继承记录（任何异常都当作空表：记录永远不能影响主流程）。
 * @returns {Record<string, Array<{child: string, at: number}>>} 源会话 id → 继承出去的记录。
 */
function readHistory() {
  try {
    const parsed = JSON.parse(readFileSync(historyFile(), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 记一笔「源会话 → 子会话」。
 * @param {string} sourceId - 源会话 id。
 * @param {string} childId - 新建的子会话 id。
 */
function rememberInherit(sourceId, childId) {
  try {
    const all = readHistory()
    const list = Array.isArray(all[sourceId]) ? all[sourceId] : []
    list.push({ child: childId, at: Date.now() })
    all[sourceId] = list.slice(-10)
    const keys = Object.keys(all)
    if (keys.length > 200) {
      // 只保留最近 200 个源会话，避免文件无限增长。
      const lastAt = (id) => (Array.isArray(all[id]) && all[id].length > 0 ? all[id][all[id].length - 1].at : 0)
      for (const key of keys.sort((a, b) => lastAt(a) - lastAt(b)).slice(0, keys.length - 200)) delete all[key]
    }
    const file = historyFile()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(all), 'utf8')
    note(`history: ${sourceId} → ${childId} 已记录`)
  } catch (error) {
    note(`history 写入失败（已忽略）: ${String(error?.message ?? error)}`)
  }
}

/**
 * @param {string} sessionId - 源会话 id。
 * @returns {Array<{child: string, at: number}>} 该会话已经继承出去的记录。
 */
function readInheritedBy(sessionId) {
  const list = readHistory()[sessionId]
  return Array.isArray(list) ? list : []
}

// ── 两个处理器 ────────────────────────────────────────────────────────────

/**
 * 给绝对路径锚点打上「已不存在」标记（就地修改）。
 *
 * 纯机械、零模型成本，但能省掉新会话去翻一个已被删除或改名的文件——这正是
 * 新会话最容易浪费头几步的地方。只查绝对路径：相对引用的基准目录不确定，
 * 查了反而误导。
 * @param {object} anchors - collectAnchors 的结果。
 */
function markMissingFiles(anchors) {
  for (const group of [anchors.edited, anchors.read, anchors.mentioned]) {
    if (!Array.isArray(group)) continue
    for (const file of group) {
      if (file === null || typeof file !== 'object' || file.absolute === false) continue
      try {
        file.missing = !existsSync(file.path)
      } catch {
        /* 路径不可查（权限、非法字符等）：当作存在，不标注 */
      }
    }
  }
}

/**
 * 生成交接单（preview 与 commit 共用）。
 * @param {object} ctx - Cordis 上下文。
 * @param {{sessionId: string, title?: string, recentUsers: number, nextStep?: string, cacheTtlMs?: number}} input - 输入。
 * @returns {Promise<{doc: string, header: object, events: object[], anchors: object, route: object|null}>} 结果。
 */
async function buildDoc(ctx, input) {
  const snapshot = await readSnapshot(ctx, input.sessionId, Number.isFinite(input.cacheTtlMs) ? input.cacheTtlMs : SNAPSHOT_TTL_MS)
  const header = snapshot.session !== null && typeof snapshot.session === 'object' ? snapshot.session : {}
  const anchors = collectAnchors(snapshot.events, { recentUsers: input.recentUsers })
  markMissingFiles(anchors)
  const route = resolveRoute(ctx, snapshot.events)
  const doc = composeInheritDoc(
    {
      sessionId: input.sessionId,
      title: input.title,
      cwd: header.cwd,
      model: route === null ? undefined : `${route.provider}/${route.model}`,
    },
    anchors,
    { nextStep: input.nextStep },
  )
  return { doc, header, events: snapshot.events, anchors, route }
}

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
    const built = await buildDoc(ctx, {
      sessionId,
      title: typeof args?.title === 'string' ? args.title : undefined,
      recentUsers: resolved.recentUsers,
      cacheTtlMs: resolved.cacheTtlMs,
    })
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
      // 这个会话以前被继承过几次：在用户即将再次继承时提示，防止重复继承。
      inherited: readInheritedBy(sessionId),
    })
  } catch (error) {
    sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
  }
}

/**
 * 处理 commit 请求：建新会话并注入交接单。
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
  const title = typeof args?.title === 'string' ? args.title : undefined
  const start = typeof args?.start === 'boolean' ? args.start : resolved.startByDefault
  const nextStep = typeof args?.nextStep === 'string' ? args.nextStep : undefined

  // 区分「客户端没传 doc」（agent 工具 / 命令通路）与「客户端传了空 doc」
  // （用户在预览框里把交接单清空）。后者不能静默换成自动生成的版本——那是
  // 用户明确表达的意图，只该如实报错。
  const docFromClient = typeof args?.doc === 'string' ? args.doc : null
  let doc = docFromClient ?? ''
  note(`commit start session=${sessionId} start=${start} docFromClient=${docFromClient !== null} docLen=${doc.length} nextStepLen=${typeof nextStep === 'string' ? nextStep.trim().length : 0}`)

  let header
  let route = null
  try {
    const built = await withTimeout(buildDoc(ctx, {
      sessionId,
      title,
      recentUsers: resolved.recentUsers,
      nextStep,
      cacheTtlMs: resolved.cacheTtlMs,
    }), 30_000, '读取源会话')
    header = built.header
    route = built.route
    if (docFromClient === null) {
      doc = built.doc
    } else if (typeof nextStep === 'string' && nextStep.trim().length > 0) {
      // 客户端回传了（可能被编辑过的）交接单，同时用户又在独立输入框里填了下一步：
      // 把后者写进前者。少了这一步，那个输入框就是白填的——它以前一直是这样。
      doc = replaceNextStepSection(doc, nextStep)
    }
    note(`commit: 源会话已读 events=${built.events.length} preset=${header.agentPreset ?? '(none)'} route=${route === null ? '(none)' : `${route.provider}/${route.model}`} finalDocLen=${doc.length}`)
  } catch (error) {
    note(`commit FAIL 读取源会话: ${String(error?.message ?? error)}`)
    sendJson(res, 500, { ok: false, error: `读取源会话失败：${String(error?.message ?? error)}` })
    return
  }
  if (doc.trim().length === 0) {
    sendJson(res, 400, { ok: false, error: '交接单为空' })
    return
  }

  let child
  try {
    const began = Date.now()
    child = await withTimeout(createChild(ctx, { header, route }), 15_000, '新建会话')
    note(`commit: 新会话已建 ${child.id} 用时 ${Date.now() - began}ms`)
  } catch (error) {
    const first = String(error?.message ?? error)
    note(`commit: 首次创建失败（${first}），改为不挂 preset 重试`)
    try {
      child = await withTimeout(createChild(ctx, { header, route, mountPreset: false }), 15_000, '新建会话(降级)')
      note(`commit: 降级创建成功 ${child.id}`)
    } catch (error2) {
      const second = String(error2?.message ?? error2)
      note(`commit FAIL 新建会话: 首次=${first} 降级=${second}`)
      sendJson(res, 500, { ok: false, error: `新建会话失败：${first}；去掉 preset 重试仍失败：${second}` })
      return
    }
  }

  let workspace = false
  try {
    workspace = await withTimeout(attachWorkspace(ctx, header.cwd, child.id), 10_000, '挂载工作区')
    note(`commit: 工作区 attach=${workspace}`)
  } catch (error) {
    workspace = false
    note(`commit: 工作区挂载失败（已忽略）: ${String(error?.message ?? error)}`)
  }

  renameChild(ctx, child, title)

  let injection
  try {
    const began = Date.now()
    injection = await withTimeout(injectDoc(ctx, child, doc, start), 30_000, '注入交接单')
    note(`commit: 注入完成 mode=${injection.mode} 用时 ${Date.now() - began}ms`)
  } catch (error) {
    note(`commit FAIL 注入交接单: ${String(error?.message ?? error)}`)
    sendJson(res, 500, {
      ok: false,
      sessionId: child.id,
      error: `会话已创建（${child.id}），但交接单注入失败：${String(error?.message ?? error)}`,
    })
    return
  }

  note(`commit ok child=${child.id} mode=${injection.mode} workspace=${workspace}`)
  rememberInherit(sessionId, child.id)
  sendJson(res, 200, {
    ok: true,
    sessionId: child.id,
    mode: injection.mode,
    workspace,
    resumable: true,
    note: injection.note,
  })
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
      createChild(ctx, { header: built.header, route: built.route }),
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
          const startNow = typeof args?.start === 'boolean' ? args.start : resolved.startByDefault
          try {
            const built = await withTimeout(buildDoc(ctx, {
              sessionId: target,
              recentUsers: resolved.recentUsers,
              nextStep: typeof args?.nextStep === 'string' ? args.nextStep : undefined,
              cacheTtlMs: resolved.cacheTtlMs,
            }), 30_000, '读取源会话')
            note(`tool: 源会话已读 ${target} docLen=${built.doc.length} events=${built.events.length}`)
            const child = await withTimeout(createChild(ctx, { header: built.header, route: built.route }), 20_000, '新建会话')
            note(`tool: 新会话 ${child.id}`)
            try {
              await withTimeout(attachWorkspace(ctx, built.header.cwd, child.id), 10_000, '挂载工作区')
            } catch (error) {
              note(`tool: 工作区挂载失败（忽略）: ${String(error?.message ?? error)}`)
            }
            renameChild(ctx, child, undefined)
            const injection = await withTimeout(injectDoc(ctx, child, built.doc, startNow), 30_000, '注入交接单')
            rememberInherit(target, child.id)
            note(`tool: 注入 ${injection.mode}`)
            return [
              `继承完成：新会话 ${child.id}`,
              `模式：${injection.mode}`,
              `交接单 ${built.doc.length} 字符。${injection.note}`,
            ].join('\n')
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
            const built = await withTimeout(buildDoc(ctx, {
              sessionId: target,
              recentUsers: resolved.recentUsers,
              nextStep: parsed.nextStep,
              cacheTtlMs: resolved.cacheTtlMs,
            }), 30_000, '读取源会话')
            const child = await withTimeout(createChild(ctx, { header: built.header, route: built.route }), 20_000, '新建会话')
            try {
              await withTimeout(attachWorkspace(ctx, built.header.cwd, child.id), 10_000, '挂载工作区')
            } catch (error) {
              note(`command: 工作区挂载失败（忽略）: ${String(error?.message ?? error)}`)
            }
            renameChild(ctx, child, undefined)
            const injection = await withTimeout(injectDoc(ctx, child, built.doc, resolved.startByDefault), 30_000, '注入交接单')
            rememberInherit(target, child.id)
            note(`command: 继承完成 ${target} → ${child.id} mode=${injection.mode}`)
            return {
              kind: 'success',
              text: [
                `继承完成：新会话 \`${child.id}\``,
                `交接单 ${built.doc.length} 字符（源会话 ${target}，共 ${built.anchors.turns} 轮）。`,
                injection.note,
                '去侧边栏打开它继续工作（源会话未改动）。',
              ].join('\n'),
            }
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
