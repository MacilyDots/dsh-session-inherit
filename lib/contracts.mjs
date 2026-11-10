// DSH 契约声明与运行时探测。
//
// 为什么要集中一处：这个插件消费的事件类型、服务名、跨插件账本格式散在各文件里，
// DSH 一升级就变成"静默少节/静默丢人格"，而失败点分散、无法一眼定位。
// 2026-11-10 的现场就是例子：dsh-tavern 把 session-bindings.json 从字符串改成对象，
// 我们这边读不到，继承出来的人格直接变标准模式，页脚却还写着"已继承"。
//
// probe() 在 apply 时跑一次并写日志；health 端点把它连同账本格式一起暴露出来，
// 下次契约断裂时不用猜。
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 本插件读取的会话事件类型。改名意味着对应章节会静默消失。 */
export const EVENTS = {
  userMessage: 'user/message',
  assistantMessage: 'assistant/message',
  toolCall: 'tool/call',
  toolResult: 'tool/result',
  turnStart: 'turn/start',
  turnEnd: 'turn/end',
  sessionTitle: 'session/title',
  compactionStart: 'compaction/start',
  sessionEndSeed: 'session/end-seed',
}

/** 本插件按需获取的 DSH 服务；缺哪个就降级哪一项。 */
export const SERVICES = [
  'agents',
  'sessionQuery',
  'sessionController',
  'workspaceRegistry',
  'sessionTitle',
  'agentPresets',
  'agentDefaultModel',
  'webServer',
  'tools',
  'commands',
]

/** @returns {string} DSH 根目录。 */
export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/**
 * 探测各服务是否在。
 * @param {object} ctx - Cordis 上下文。
 * @returns {{available: string[], missing: string[], degraded: boolean}} 探测结果。
 */
export function probe(ctx) {
  const available = []
  const missing = []
  for (const name of SERVICES) {
    let service
    try {
      service = ctx.get(name)
    } catch {
      service = undefined
    }
    if (service === undefined || service === null) missing.push(name)
    else available.push(name)
  }
  return { available, missing, degraded: missing.length > 0 }
}

/**
 * 探测跨插件账本 `session-bindings.json` 的格式。
 *
 * 这个文件由 dsh-tavern 维护（dsh-muv-engine / dsh-muv-table 也读），格式不归我们定。
 * 两种历史形态：
 *   旧：`"session-xxx": "preset-id"`
 *   新（tavern 2.7+）：`{mode:'preset', presetId, source, at, rev}` / `{mode:'none'}`
 * 两边都读不了对方的隐含变化时没有任何报错，只会"人格丢了"——所以这里把它探测出来。
 * @returns {{state: string, entries: number, legacy: number, object: number, none: number, invalid: number, path: string}} 探测结果。
 */
export function inspectBindings() {
  const path = join(dshHome(), '.agent-presets', 'session-bindings.json')
  const empty = { state: 'absent', entries: 0, legacy: 0, object: 0, none: 0, invalid: 0, path }
  if (!existsSync(path)) return empty
  try {
    const map = JSON.parse(readFileSync(path, 'utf8'))
    if (map === null || typeof map !== 'object') return { ...empty, state: 'invalid' }
    let legacy = 0
    let object = 0
    let none = 0
    let invalid = 0
    for (const value of Object.values(map)) {
      if (typeof value === 'string') {
        legacy += 1
      } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        if (value.mode === 'none') none += 1
        else if (value.mode === 'preset' && typeof value.presetId === 'string' && value.presetId.length > 0) object += 1
        else invalid += 1
      } else {
        invalid += 1
      }
    }
    const entries = legacy + object + none + invalid
    // state 表达的是"我们能不能解析"：全对象 ⇒ object；全字符串 ⇒ legacy；
    // 混合 ⇒ mixed（说明迁移半途，或有人手改过）。
    let state = 'empty'
    if (entries > 0) {
      if (object > 0 && legacy === 0) state = 'object'
      else if (legacy > 0 && object === 0) state = 'legacy'
      else state = 'mixed'
    }
    return { state, entries, legacy, object, none, invalid, path }
  } catch {
    return { ...empty, state: 'invalid' }
  }
}

/**
 * 读 package.json 里的自身版本（失败返回 null）。
 * @returns {string|null} 版本号。
 */
export function ownVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}
