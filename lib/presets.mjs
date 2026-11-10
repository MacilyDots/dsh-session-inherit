// agent preset 的组合与第三方插件账本登记。
//
// 三件事要分清：
//   1. **真正的 preset 继承**发生在会话创建时（meta.agentPreset + setup 里 mount）；
//   2. 有些预设插件不在 header 里记录绑定，而是写自己的 session-bindings.json，
//      所以继承时要专门去读（readBoundPreset）；
//   3. 反过来，我们还要往那个插件的账本里登记，否则它的面板显示不一致
//      （copyTavernBinding）——这只影响显示，不影响 DSH 侧真的挂了什么。
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { note } from './log.mjs'

/**
 * 组合子会话的 agent preset（沿用源会话的系统提示 / 工具 / 技能构成）。
 * 没有 registry 时仍把源会话的 preset id 记进 header（保持延续性），只是不挂载。
 * @param {object} ctx - Cordis 上下文。
 * @param {string|undefined} presetId - 源会话记录的 preset id。
 * @returns {Promise<{agentPreset?: string, mounted: boolean, setup: Function}>} 组合结果。
 */
export async function composeForPreset(ctx, presetId) {
  const fallbackId = typeof presetId === 'string' && presetId.trim().length > 0 ? presetId.trim() : undefined
  const marked = fallbackId === undefined
    ? { mounted: false, setup: () => undefined }
    : { agentPreset: fallbackId, mounted: false, setup: () => undefined }
  const presets = ctx.get('agentPresets')
  if (presets === undefined || typeof presets.resolve !== 'function') {
    if (fallbackId !== undefined) note(`preset: agentPresets 服务不可用，${fallbackId} 只记 id 不挂载`)
    return marked
  }
  try {
    const resolved = await presets.resolve(fallbackId)
    const id = resolved !== null && typeof resolved === 'object' ? resolved.id : undefined
    if (typeof id !== 'string' || id.length === 0) {
      if (fallbackId !== undefined) note(`preset: resolve(${fallbackId}) 没返回有效 id，降级为只记 id 不挂载`)
      return marked
    }
    return {
      agentPreset: id,
      // 这条标志是给日志用的：降级路径（只记 id、不挂载）和成功路径以前打出来的
      // 日志一模一样，真出问题时根本分不清新会话到底挂了哪个预设。
      mounted: true,
      setup: async (agentCtx) => {
        await presets.mount(agentCtx, id)
      },
    }
  } catch (error) {
    note(`preset: resolve(${fallbackId ?? '(none)'}) 抛错，降级为只记 id 不挂载：${String(error?.message ?? error)}`)
    return marked
  }
}

/**
 * 读宿主侧「会话 → 自定义预设」的绑定。
 *
 * 这类预设**不改**会话 header 的 `agentPreset`（那里永远是 standard），真正的人格
 * 绑定记在 `%DSH_HOME%\.agent-presets\session-bindings.json` 里，形如
 * `{ "session-xxx": "preset-xxxxxxxx" }`。继承时只读 header 会漏掉它，新会话就
 * 丢了人格——所以把绑定也捞出来写进交接单，让用户知道新会话该选哪个。
 * 文件不存在（没装那类插件）时静默返回 undefined，不影响主流程。
 * @param {string} sessionId - 源会话 id。
 * @returns {string|undefined} 绑定的预设 id。
 */
export function readBoundPreset(sessionId) {
  try {
    const file = join(process.env.DSH_HOME || join(homedir(), '.dsh'), '.agent-presets', 'session-bindings.json')
    const map = JSON.parse(readFileSync(file, 'utf8'))
    if (map === null || typeof map !== 'object') return undefined
    // key 的前缀不统一（新旧会话有的带 session- 有的不带），三种写法都试一遍。
    const bare = sessionId.replace(/^session-/, '')
    for (const key of [sessionId, `session-${bare}`, bare]) {
      const value = map[key]
      if (typeof value === 'string' && value.trim().length > 0) return value.trim()
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * 把源会话的预设绑定**登记**到新会话。
 *
 * 这个函数**不负责**让新会话真正用上那个预设。`/api/tavern/bind-preset` 只写 tavern
 * 自己的 `session-bindings.json`，DSH 侧的 agent preset 一个字节都不会变。
 * 真正继承人格靠 createSession 在**创建时**把 presetId 当 agentPreset 传进去。
 *
 * 那为什么还留着：让那个预设插件的账本和 DSH 保持一致，否则它的面板里这个新会话显示的
 * 仍是上一个预设，用户会以为继承没生效。
 *
 * 时机：必须在注入交接单**之前**调用——那时新会话还没有 user 消息，tavern 判定未开始。
 * @param {object} ctx - Cordis 上下文。
 * @param {string} sourceId - 源会话 id。
 * @param {string} childId - 新会话 id。
 * @param {number} [timeoutMs] - 绑定接口的 cap，默认 2 秒。
 * @returns {Promise<string|null>} 登记成功的预设 id，未登记则 null。
 */
export async function copyTavernBinding(ctx, sourceId, childId, timeoutMs = 2000) {
  const presetId = readBoundPreset(sourceId)
  if (presetId === undefined) return null
  const port = Number(ctx.get('webServer')?.port)
  if (!Number.isInteger(port) || port <= 0) {
    note(`tavern: 拿不到 webServer 端口，跳过绑定 ${presetId}`)
    return null
  }
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/tavern/bind-preset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: childId, presetId }),
      // 这是第三方插件的端点，它挂住不能拖住建会话。以前这里没有超时，靠外层
      // createChild 的 15 秒 cap 兜底——而那时 agents.create 已经把会话建出来了，
      // 超时只让调用方失败：用户看到"新建会话失败"，实际留了个没人知道的孤儿。
      signal: AbortSignal.timeout(timeoutMs),
    })
    const data = await response.json().catch(() => null)
    const ok = response.ok && data !== null && data.ok !== false
    const locked = data !== null && data.locked === true
    note(`tavern: 绑定 ${presetId} → ${childId} ${ok ? '成功' : `失败(HTTP ${response.status})`}${locked ? ' [locked：会话已开始，预设被锁]' : ''}`)
    return ok ? presetId : null
  } catch (error) {
    note(`tavern: 绑定失败（已忽略）: ${String(error?.message ?? error)}`)
    return null
  }
}
