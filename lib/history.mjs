// 继承记录（旁路文件）。
//
// 为什么是旁路文件，而不是"给源会话改标题"：
// `sessionTitle.rename(session, title)` 的契约要求传入**活着的** session 对象
// （源码里断言 `ctx.sessions.get(id) === session`）。而本插件最主要的场景恰恰是对
// **冷会话**继承——那时根本拿不到 session 对象，改名必然失败。
// 所以把「谁被继承到了哪里」记在会话日志之外，在用户真正要做决定的时刻（点开预览框）
// 提示出来，顺带挡住重复继承。
//
// 格式 v2（读旧写新）：
//   { version: 2, sources: { "<sourceId>": [ {child, at, state, mode?, warnings?, error?} ] } }
// 旧格式 { "<sourceId>": [ {child, at} ] } 读的时候全部视为 state:'ok'——历史数据
// 一定都是成功记录。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { note } from './log.mjs'

const STATE_OK = 'ok'

/** @returns {string} 继承记录文件路径。 */
export function historyFile() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'session-inherit', 'history.json')
}

/**
 * 把磁盘上的记录归一化成 v2 结构。
 * @param {unknown} parsed - JSON.parse 的结果。
 * @returns {{version: number, sources: Record<string, Array<{child: string, at: number, state: string}>>}} 归一化结果。
 */
function normalize(parsed) {
  const sources = {}
  if (parsed === null || typeof parsed !== 'object') return { version: 2, sources }
  const raw = parsed.version === 2 && parsed.sources !== null && typeof parsed.sources === 'object'
    ? parsed.sources
    : parsed
  for (const [sourceId, list] of Object.entries(raw)) {
    if (!Array.isArray(list)) continue
    const entries = []
    for (const item of list) {
      if (item === null || typeof item !== 'object') continue
      if (typeof item.child !== 'string' || item.child.length === 0) continue
      entries.push({
        child: item.child,
        at: Number.isFinite(item.at) ? item.at : 0,
        // 旧格式没有 state：那些记录只可能是成功路径写下的。
        state: typeof item.state === 'string' ? item.state : STATE_OK,
        ...(typeof item.mode === 'string' ? { mode: item.mode } : {}),
        ...(Array.isArray(item.warnings) ? { warnings: item.warnings } : {}),
        ...(typeof item.error === 'string' ? { error: item.error } : {}),
      })
    }
    if (entries.length > 0) sources[sourceId] = entries
  }
  return { version: 2, sources }
}

/**
 * 读取继承记录（任何异常都当作空表：记录永远不能影响主流程）。
 * @returns {{version: number, sources: Record<string, Array<{child: string, at: number, state: string}>>}} 归一化结果。
 */
export function readHistory() {
  try {
    return normalize(JSON.parse(readFileSync(historyFile(), 'utf8')))
  } catch {
    return { version: 2, sources: {} }
  }
}

/**
 * 原子写入：先写临时文件再改名，避免两个并发请求把文件写成半截。
 * @param {{version: number, sources: object}} data - 完整数据。
 */
function writeHistory(data) {
  const file = historyFile()
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(data), 'utf8')
  renameSync(tmp, file)
}

/**
 * 记一笔「源会话 → 子会话」。同一条记录（source + child）已存在时改为更新状态，
 * 不重复追加——重试路径会反复走到这里。
 * @param {string} sourceId - 源会话 id。
 * @param {string} childId - 新建的子会话 id。
 * @param {{state?: string, mode?: string, warnings?: object[], error?: string}} [extra] - 附加状态。
 */
export function rememberInherit(sourceId, childId, extra = {}) {
  try {
    const all = readHistory()
    const list = Array.isArray(all.sources[sourceId]) ? all.sources[sourceId] : []
    const state = typeof extra.state === 'string' && extra.state.length > 0 ? extra.state : STATE_OK
    const existing = list.find((item) => item.child === childId)
    if (existing !== undefined) {
      existing.state = state
      if (typeof extra.mode === 'string') existing.mode = extra.mode
      if (Array.isArray(extra.warnings)) existing.warnings = extra.warnings
      if (typeof extra.error === 'string') existing.error = extra.error
    } else {
      list.push({
        child: childId,
        at: Date.now(),
        state,
        ...(typeof extra.mode === 'string' ? { mode: extra.mode } : {}),
        ...(Array.isArray(extra.warnings) ? { warnings: extra.warnings } : {}),
        ...(typeof extra.error === 'string' ? { error: extra.error } : {}),
      })
    }
    all.sources[sourceId] = list.slice(-10)
    const keys = Object.keys(all.sources)
    if (keys.length > 200) {
      // 只保留最近 200 个源会话，避免文件无限增长。
      const lastAt = (id) => {
        const records = all.sources[id]
        return Array.isArray(records) && records.length > 0 ? records[records.length - 1].at : 0
      }
      for (const key of keys.sort((a, b) => lastAt(a) - lastAt(b)).slice(0, keys.length - 200)) delete all.sources[key]
    }
    writeHistory(all)
    note(`history: ${sourceId} → ${childId} ${state}`)
  } catch (error) {
    note(`history 写入失败（已忽略）: ${String(error?.message ?? error)}`)
  }
}

/**
 * 该会话已经继承出去几次。
 * @param {string} sessionId - 源会话 id。
 * @returns {Array<{child: string, at: number, state: string}>} 记录列表。
 */
export function readInheritedBy(sessionId) {
  const list = readHistory().sources[sessionId]
  return Array.isArray(list) ? list : []
}
