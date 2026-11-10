// 读会话 + 组装交接单。
//
// preview 与 commit 共用一次读取（同一份快照缓存），避免点一次「继承」读两遍日志。
import { existsSync } from 'node:fs'
import { collectAnchors, composeInheritDoc } from './extract.mjs'
import { readBoundPreset } from './presets.mjs'

export const SNAPSHOT_TTL_MS = 120_000
export const SNAPSHOT_LIMIT = 3

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
export async function readSnapshot(ctx, sessionId, ttlMs) {
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

/**
 * 从事件流里取最后一次请求使用的模型路由。
 * @param {object[]} events - 事件数组。
 * @returns {{provider: string, model: string}|null} 路由或 null。
 */
export function extractRoute(events) {
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
export function resolveRoute(ctx, events) {
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
 * 给绝对路径锚点打上「已不存在」标记（就地修改）。
 *
 * 纯机械、零模型成本，但能省掉新会话去翻一个已被删除或改名的文件——这正是
 * 新会话最容易浪费头几步的地方。只查绝对路径：相对引用的基准目录不确定，
 * 查了反而误导。
 * @param {object} anchors - collectAnchors 的结果。
 */
export function markMissingFiles(anchors) {
  for (const group of [anchors.edited, anchors.read, anchors.mentioned]) {
    if (!Array.isArray(group)) continue
    for (const file of group) {
      if (file === null || typeof file !== 'object' || file.absolute === false) continue
      // `regex` 路线可能只抓到截断版（末段含空格时必然截断），拿它去 existsSync
      // 一定为假，于是好路径被标「已不存在」——比不标更误导新会话。
      // 只有结构化参数与引号包裹这两类来源才有完整边界，才值得判存在性。
      if (file.source === 'regex') continue
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
 * @param {{sessionId: string, title?: string, recentUsers: number, nextStep?: string, lang?: string, cacheTtlMs?: number}} input - 输入。
 * @returns {Promise<{doc: string, header: object, events: object[], anchors: object, route: object|null, boundPreset: string|undefined}>} 结果。
 */
export async function buildDoc(ctx, input) {
  const snapshot = await readSnapshot(ctx, input.sessionId, Number.isFinite(input.cacheTtlMs) ? input.cacheTtlMs : SNAPSHOT_TTL_MS)
  const header = snapshot.session !== null && typeof snapshot.session === 'object' ? snapshot.session : {}
  const anchors = collectAnchors(snapshot.events, { recentUsers: input.recentUsers })
  markMissingFiles(anchors)
  const route = resolveRoute(ctx, snapshot.events)
  // 这类预设不写进 header，绑定在宿主的 session-bindings.json 里，单独捞。
  // 这个值不只是给页脚看的——它是新会话真正要挂的那个人格（见 createSession 的
  // presetOverride），所以必须一路带到 commit。
  const boundPreset = readBoundPreset(input.sessionId)
  const doc = composeInheritDoc(
    {
      sessionId: input.sessionId,
      title: input.title,
      cwd: header.cwd,
      model: route === null ? undefined : `${route.provider}/${route.model}`,
      // 写进交接单页脚：新会话该用什么预设，一眼可见，不用去猜。
      agentPreset: typeof header.agentPreset === 'string' ? header.agentPreset : undefined,
      boundPreset,
    },
    anchors,
    { nextStep: input.nextStep, lang: input.lang },
  )
  return { doc, header, events: snapshot.events, anchors, route, boundPreset }
}
