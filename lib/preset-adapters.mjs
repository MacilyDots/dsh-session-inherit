// 预设账本适配器。
//
// 为什么要有这一层：这个插件真正让人格生效走的是 DSH 官方路径——
// `createSessionOnly` 在**创建时**把 presetId 当 agentPreset 传进去并 mount。
// 往第三方插件的账本里"登记"只是可选的第二件事，目的是让那个面板显示得对。
//
// 既然是可选的，它就必须可关、可探测、失败可解释：
//   `none`   —— 一次 HTTP 都不发（离线环境、或用户不想让插件碰别的东西）；
//   `tavern` —— 显式指定，选不出来要产生 warning（用户明确要过的东西不该静默失效）；
//   `auto`   —— 探测得到才用，探测不到静默跳过（默认）。
import { note } from './log.mjs'

/** 允许的适配器模式。 */
export const ADAPTER_MODES = ['auto', 'none', 'tavern']

/**
 * 选一个预设账本适配器。
 * @param {object} ctx - Cordis 上下文。
 * @param {{presetAdapter?: string}} config - 归一化配置。
 * @returns {{name: string, port: number}|null} 适配器；null 表示本次不登记。
 */
export function selectPresetAdapter(ctx, config = {}) {
  const mode = ADAPTER_MODES.includes(config.presetAdapter) ? config.presetAdapter : 'auto'
  if (mode === 'none') return null
  const port = Number(ctx.get('webServer')?.port)
  if (!Number.isInteger(port) || port <= 0) {
    // auto 下这是常态（没装 / 端口还没起），不该吵；显式 tavern 则是配置与现实的
    // 冲突，必须留下痕迹。
    if (mode === 'tavern') note('adapter: 显式指定 tavern，但拿不到 webServer 端口')
    return null
  }
  return { name: 'tavern', port }
}

/**
 * 显式指定的适配器没选出来时，该不该给 warning。
 * @param {{presetAdapter?: string}} config - 归一化配置。
 * @param {object|null} adapter - selectPresetAdapter 的结果。
 * @returns {{code: string, message: string}|null} warning，或 null。
 */
export function adapterUnavailableWarning(config, adapter) {
  if (adapter !== null) return null
  if (config?.presetAdapter !== 'tavern') return null
  return {
    code: 'preset-adapter-unavailable',
    message: '配置了 presetAdapter: tavern，但拿不到 webServer 端口，预设账本未登记',
  }
}
