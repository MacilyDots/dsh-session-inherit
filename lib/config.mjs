// 配置归一化。
//
// 不做 schema 校验依赖：非法值一律回落到默认，保证插件总能挂载——一个插件因为
// 一个拼错的配置键整个不加载，比用默认值跑起来更难排查。

const SNAPSHOT_TTL_MS = 120_000

export const DEFAULTS = {
  enabled: true,
  recentUsers: 6,
  startByDefault: true,
  cacheTtlMs: SNAPSHOT_TTL_MS,
  // preview 读源会话的上界。commit 一直有 cap，preview 没有，读一个大日志就能
  // 把对话框永久挂在 loading；值可配是为了让离线测试不必真等 30 秒。
  previewTimeoutMs: 30_000,
  // commit 的分步预算。cap 与总预算取小，见 lib/timeouts.mjs 的 createBudget。
  timeoutMs: {
    total: 60_000,
    build: 20_000,
    create: 10_000,
    binding: 2_000,
    workspace: 5_000,
    inject: 15_000,
  },
  // 访问边界。DSH web 默认只绑 127.0.0.1，这些端点本来就只在本机可达；
  // 但用户可能把 bind 改成 0.0.0.0（局域网/手机访问），那时端点会跟着暴露。
  // 默认只认 loopback，远程访问必须显式打开并配 token。
  allowRemote: false,
  token: '',
  // 交接单 / 工具返回文本的语言。'auto' 表示"由调用方决定"：界面请求带 lang
  // 就用它，命令与工具入口没有界面上下文，只能回落中文。
  lang: 'auto',
  // 推理强度：'warn'（默认）只把源会话的强度写进交接单页脚，不改新会话；
  // 'inherit' 额外把它套用到新会话的 agentOptions。
  inheritReasoningEffort: 'warn',
  // 低信息量章节的开关。默认全开；关掉能缩短交接单。
  sections: {
    readFiles: true,
    mentioned: true,
    relativeRefs: true,
    commands: true,
  },
}

/**
 * 取一个正整数配置，非法则回落。
 * @param {unknown} value - 候选值。
 * @param {number} fallback - 默认值。
 * @returns {number} 归一化结果。
 */
function positiveMs(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * 归一化配置。
 * @param {object} config - profile patch 里传入的配置。
 * @returns {{enabled: boolean, recentUsers: number, startByDefault: boolean, cacheTtlMs: number, previewTimeoutMs: number, timeoutMs: {total: number, build: number, create: number, binding: number, workspace: number, inject: number}}} 归一化结果。
 */
export function resolveConfig(config) {
  const src = config !== null && typeof config === 'object' ? config : {}
  const recentUsers = Number.isInteger(src.recentUsers) && src.recentUsers >= 1 && src.recentUsers <= 50
    ? src.recentUsers
    : DEFAULTS.recentUsers
  const cacheTtlMs = Number.isFinite(src.cacheTtlMs) && src.cacheTtlMs >= 0
    ? src.cacheTtlMs
    : DEFAULTS.cacheTtlMs
  const givenTimeouts = src.timeoutMs !== null && typeof src.timeoutMs === 'object' ? src.timeoutMs : {}
  // token 太短等于没配——远程访问只可能发生在手动打开 allowRemote 之后，
  // 这里不替用户生成随机值（重启就变，客户端没法持有），配了就按配的用。
  const token = typeof src.token === 'string' && src.token.trim().length >= 16 ? src.token.trim() : ''
  const givenSections = src.sections !== null && typeof src.sections === 'object' ? src.sections : {}
  return {
    enabled: src.enabled !== false,
    recentUsers,
    startByDefault: src.startByDefault !== false,
    cacheTtlMs,
    previewTimeoutMs: positiveMs(src.previewTimeoutMs, DEFAULTS.previewTimeoutMs),
    allowRemote: src.allowRemote === true,
    token,
    lang: src.lang === 'zh' || src.lang === 'en' ? src.lang : DEFAULTS.lang,
    inheritReasoningEffort: src.inheritReasoningEffort === 'inherit' ? 'inherit' : DEFAULTS.inheritReasoningEffort,
    sections: {
      readFiles: givenSections.readFiles !== false,
      mentioned: givenSections.mentioned !== false,
      relativeRefs: givenSections.relativeRefs !== false,
      commands: givenSections.commands !== false,
    },
    timeoutMs: {
      total: positiveMs(givenTimeouts.total, DEFAULTS.timeoutMs.total),
      build: positiveMs(givenTimeouts.build, DEFAULTS.timeoutMs.build),
      create: positiveMs(givenTimeouts.create, DEFAULTS.timeoutMs.create),
      binding: positiveMs(givenTimeouts.binding, DEFAULTS.timeoutMs.binding),
      workspace: positiveMs(givenTimeouts.workspace, DEFAULTS.timeoutMs.workspace),
      inject: positiveMs(givenTimeouts.inject, DEFAULTS.timeoutMs.inject),
    },
  }
}
