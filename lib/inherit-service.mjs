// 进程内继承服务：供 dsh-degen-guard 等插件在退化熔断时可选调用。
//
// 三条入口（HTTP / 工具 / 命令）仍然走 lib/inherit.mjs 的人工继承流水线，本模块
// 不改它们的任何行为。这里是一条**独立、面向程序调用**的通路，只做一件事：把
// 「建子会话 → 登记深度 → 校验 cwd/预设 → 注入/启动」的顺序固定下来，并让调用方
// 能在任何 prompt 之前同步拿到 childId。
//
// 为什么必须独立：
//   1. guard 的熔断可能在一个 turn 内连着触发两次。若等 prompt 之后才告诉它
//      childId，第二个 trip 会认为这还是老会话，又建一个 child（快速熔断竞态）。
//      所以 onChildCreated 在 createSessionOnly 之后、任何 injectDoc 之前被 await。
//   2. auto 的「启动」要等 cwd/预设核对完。核对失败不能重头再来一遍（那会建出
//      第二个会话），只能在**同一个 child** 上改成草稿注入，state='draft-fallback'。
//   3. 建会话超时意味着 agents.create 可能已经在后台建好了，绝不能重试；返回
//      'create-timeout' + childId=null，由调用方决定怎么处理。
//
// 服务通过 ctx.provide('sessionInherit', api) 发布；消费方用
// export const inject = ['sessionInherit'] 或 ctx.get('sessionInherit') 取。
import { existsSync } from 'node:fs'
import { annotatePresetLine, replaceNextStepSection } from './extract.mjs'
import { commitOnce } from './inherit.mjs'
import { rememberInherit } from './history.mjs'
import { note } from './log.mjs'
import { buildDoc } from './read.mjs'
import { adapterUnavailableWarning, selectPresetAdapter } from './preset-adapters.mjs'
import { appendDoc, attachWorkspace, createSessionOnly, injectDoc, registerPresetBinding, renameChild } from './session.mjs'
import { createBudget } from './timeouts.mjs'
import { ownVersion, probe } from './contracts.mjs'

/** 这些预设是 DSH 内置的，没有 registry 挂载也算可用。 */
const BUILTIN_PRESETS = new Set(['standard', 'ptc', 'minimal', 'cordis'])

/** 深度账本上限：只防泄漏，不参与业务逻辑。 */
const DEPTH_LIMIT = 512

/** @type {Map<string, {parentSessionId: string, childSessionId: string, depth: number, at: number}>} */
const depthLedger = new Map()

/**
 * 深度登记：按 childSessionId 幂等，先到为准。
 *
 * 竞态的根因是「同一个 child 被两层守卫各登记一次」——那会把深度算成 2 倍，
 * 让链式继承过早停住。这里以 childSessionId 为唯一键，第二次登记直接返回既有值，
 * `registered:false` 让调用方知道这不是新记录。
 * @param {string} parentSessionId - 父会话 id。
 * @param {string} childSessionId - 子会话 id。
 * @param {number} depth - 子会话在继承链上的深度（根为 0，子为 1…）。
 * @returns {{registered: boolean, parentSessionId?: string, childSessionId?: string, depth?: number, at?: number, error?: string}} 结果。
 */
export function registerChildDepth(parentSessionId, childSessionId, depth) {
  if (typeof childSessionId !== 'string' || childSessionId.trim().length === 0) {
    return { registered: false, error: 'missing childSessionId' }
  }
  if (typeof parentSessionId !== 'string' || parentSessionId.trim().length === 0) {
    return { registered: false, error: 'missing parentSessionId' }
  }
  if (!Number.isInteger(depth) || depth < 0) {
    return { registered: false, error: 'invalid depth' }
  }
  const key = childSessionId.trim()
  const hit = depthLedger.get(key)
  if (hit !== undefined) return { registered: false, ...hit }
  const entry = {
    parentSessionId: parentSessionId.trim(),
    childSessionId: key,
    depth,
    at: Date.now(),
  }
  depthLedger.set(key, entry)
  if (depthLedger.size > DEPTH_LIMIT) {
    const oldest = [...depthLedger.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest !== undefined) depthLedger.delete(oldest[0])
  }
  return { registered: true, ...entry }
}

/**
 * 查一个子会话的深度登记。
 * @param {string} childSessionId - 子会话 id。
 * @returns {{parentSessionId: string, childSessionId: string, depth: number, at: number}|null} 记录或 null。
 */
export function depthOf(childSessionId) {
  if (typeof childSessionId !== 'string') return null
  return depthLedger.get(childSessionId.trim()) ?? null
}

/** 清空深度账本（测试用；运行期不要调）。 */
export function clearDepthLedger() {
  depthLedger.clear()
}

/**
 * 归一化 handoff 输入：给缺失的字段填安全默认。
 * @param {object} raw - 原始输入。
 * @returns {object} 归一化输入。
 */
function normalizeInput(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const mode = input.mode === 'hint' || input.mode === 'draft' || input.mode === 'auto'
    ? input.mode
    : 'draft'
  return {
    mode,
    sourceId: typeof input.sourceId === 'string' ? input.sourceId.trim() : '',
    parentSessionId: typeof input.parentSessionId === 'string' ? input.parentSessionId.trim() : '',
    depth: Number.isInteger(input.depth) ? input.depth : null,
    nextStep: typeof input.nextStep === 'string' ? input.nextStep : undefined,
    title: typeof input.title === 'string' ? input.title : undefined,
    lang: typeof input.lang === 'string' ? input.lang : undefined,
    inheritPreset: input.inheritPreset !== false,
    // 程序调用一般不传编辑过的 doc；传了就尊重它（与 HTTP commit 一致）。
    doc: typeof input.doc === 'string' ? input.doc : null,
    onChildCreated: typeof input.onChildCreated === 'function' ? input.onChildCreated : null,
    // 供 commitOnce 的指纹使用：auto=要启动，hint/draft=不启动。
    start: mode === 'auto',
  }
}

/**
 * 启动前的 cwd / 预设核对。只在 auto 模式下决定是否真的 prompt。
 * @param {{header: object, boundPreset?: string, presetReport: object, inheritPreset: boolean}} facts - 事实。
 * @returns {{ok: boolean, reasons: object[], checked: {cwd: string|null, preset: string|null}}} 核对结果。
 */
function checkPreflight(facts) {
  const reasons = []
  const header = facts.header !== null && typeof facts.header === 'object' ? facts.header : {}
  const cwd = typeof header.cwd === 'string' && header.cwd.length > 0 ? header.cwd : null
  if (cwd === null) {
    reasons.push({ code: 'cwd-missing', message: '源会话没有 cwd，无法确定新会话的工作目录' })
  } else {
    try {
      if (!existsSync(cwd)) reasons.push({ code: 'cwd-not-found', message: `工作目录不存在：${cwd}` })
    } catch (error) {
      reasons.push({ code: 'cwd-unreadable', message: `工作目录不可读：${cwd}（${String(error?.message ?? error)}）` })
    }
  }

  let preset = null
  if (facts.inheritPreset !== false) {
    const intended = typeof facts.boundPreset === 'string' && facts.boundPreset.length > 0
      ? facts.boundPreset
      : (typeof header.agentPreset === 'string' && header.agentPreset.length > 0 ? header.agentPreset : null)
    if (intended !== null) {
      preset = intended
      // 自定义预设没挂上 = 人格会丢；内置预设不需要 registry 挂载。
      if (facts.presetReport.mounted !== true && !BUILTIN_PRESETS.has(intended)) {
        reasons.push({ code: 'preset-unavailable', message: `预设 ${intended} 未能挂载，新会话不会继承它的人格` })
      }
    }
  }

  return { ok: reasons.length === 0, reasons, checked: { cwd, preset } }
}

/**
 * 构造一个「没建成」的结果（不抛错，调用方只看 state）。
 * @param {object} input - 归一化输入。
 * @param {string} state - 状态。
 * @param {string} code - warning / error 代码。
 * @param {string} message - 说明。
 * @returns {object} 结果。
 */
function failedResult(input, state, code, message) {
  return {
    ok: false,
    mode: input.mode,
    state,
    childId: null,
    doc: '',
    cwd: null,
    preset: null,
    presetInherited: false,
    workspace: false,
    preflight: { ok: false, reasons: [{ code, message }], checked: { cwd: null, preset: null } },
    warnings: [{ code, message }],
    note: message,
    error: message,
  }
}

/**
 * 跑一次 handoff。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} input - 归一化输入。
 * @param {object} config - 归一化配置。
 * @returns {Promise<object>} 精确结果。
 */
async function runHandoff(ctx, input, config) {
  const warnings = []
  const budget = createBudget(config.timeoutMs.total)

  // ── 1. 读源会话（所有模式共用；hint 只读不写）──
  let built
  try {
    built = await budget.step(buildDoc(ctx, {
      sessionId: input.sourceId,
      title: input.title,
      recentUsers: config.recentUsers,
      nextStep: input.nextStep,
      lang: input.lang,
      cacheTtlMs: 0,
      sections: config.sections,
    }), config.timeoutMs.build, '读取源会话')
  } catch (error) {
    return failedResult(input, 'failed', 'build-failed', `读取源会话失败：${String(error?.message ?? error)}`)
  }

  let doc = input.doc !== null ? input.doc : built.doc
  if (input.doc !== null && typeof input.nextStep === 'string' && input.nextStep.trim().length > 0) {
    doc = replaceNextStepSection(doc, input.nextStep)
  }
  if (doc.trim().length === 0) {
    return failedResult(input, 'failed', 'empty-doc', '交接单为空')
  }

  const cwd = typeof built.header.cwd === 'string' && built.header.cwd.length > 0 ? built.header.cwd : null
  const presetOverride = input.inheritPreset === false
    ? null
    : (typeof built.boundPreset === 'string' && built.boundPreset.length > 0 ? built.boundPreset : undefined)
  const presetReport = {}

  // ── 2. hint：只给建议，绝不建会话 ──
  if (input.mode === 'hint') {
    const preflight = checkPreflight({ header: built.header, boundPreset: built.boundPreset, presetReport, inheritPreset: input.inheritPreset })
    return {
      ok: true,
      mode: 'hint',
      state: 'hinted',
      childId: null,
      doc,
      cwd,
      preset: preflight.checked.preset,
      presetInherited: false,
      workspace: false,
      preflight,
      warnings: preflight.reasons.map((reason) => ({ code: `preflight-${reason.code}`, message: reason.message })),
      note: '仅提示：未创建会话，可用 mode=auto 或 mode=draft 真正继承。',
    }
  }

  // ── 3. 建会话：只试一次。超时 = 可能已经建好 = 绝不重试 ──
  let child
  try {
    child = await budget.step(createSessionOnly(ctx, {
      header: built.header,
      route: built.route,
      presetOverride,
      reasoningEffort: config.inheritReasoningEffort === 'inherit' && built.route !== null
        ? built.route.reasoningEffort
        : undefined,
      report: presetReport,
      mountPreset: true,
    }), config.timeoutMs.create, '新建会话')
  } catch (error) {
    const isTimeout = error?.code === 'ETIMEOUT'
    const code = isTimeout ? 'create-timeout' : 'create-failed'
    const message = isTimeout
      ? `新建会话超时（${String(error?.message ?? error)}）。会话可能已经建好，不得重复创建。`
      : `新建会话失败：${String(error?.message ?? error)}`
    const result = failedResult(input, isTimeout ? 'create-timeout' : 'failed', code, message)
    result.cwd = cwd
    return result
  }

  // 建出来的那一刻就记账；后面任何一步失败，调用方都能从账本和 childId 找回它。
  rememberInherit(input.sourceId, child.id, { state: 'pending', mode: `service-${input.mode}` })

  // ── 4. ★通知调用方★：在任何注入/prompt 之前 await ──
  // guard 在这里同步登记 childId→depth。它抛错 = 无法保证深度已登记 = 不许启动。
  let notifyError = null
  if (input.onChildCreated !== null) {
    try {
      await input.onChildCreated({
        childId: child.id,
        sourceId: input.sourceId,
        parentSessionId: input.parentSessionId !== '' ? input.parentSessionId : null,
        depth: input.depth,
        mode: input.mode,
      })
    } catch (error) {
      notifyError = error
      warnings.push({ code: 'on-child-created-failed', message: String(error?.message ?? error) })
      note(`service: onChildCreated 失败（已禁止自动启动）: ${String(error?.message ?? error)}`)
    }
  }

  // ── 5. 启动前的 cwd / 预设核对 ──
  const preflight = checkPreflight({
    header: built.header,
    boundPreset: built.boundPreset,
    presetReport,
    inheritPreset: input.inheritPreset,
  })
  for (const reason of preflight.reasons) warnings.push({ code: `preflight-${reason.code}`, message: reason.message })

  // ── 6. 建之后的旁路步骤：失败只告警，绝不让会话丢失 ──
  const adapter = selectPresetAdapter(ctx, config)
  if (presetOverride !== null && presetReport.mounted === true && adapter !== null) {
    try {
      await budget.step(registerPresetBinding(ctx, built.header.id, child.id, config.timeoutMs.binding, adapter),
        config.timeoutMs.binding, '登记预设账本')
    } catch (error) {
      warnings.push({ code: 'preset-binding-failed', message: String(error?.message ?? error) })
    }
  }
  const adapterWarning = adapterUnavailableWarning(config, adapter)
  if (adapterWarning !== null) warnings.push(adapterWarning)

  let workspace = false
  try {
    workspace = await budget.step(attachWorkspace(ctx, built.header.cwd, child.id), config.timeoutMs.workspace, '挂载工作区')
  } catch (error) {
    warnings.push({ code: 'workspace-attach-failed', message: String(error?.message ?? error) })
  }
  try {
    const derivedTitle = typeof input.title === 'string' && input.title.trim().length > 0
      ? input.title
      : (typeof built.anchors.title === 'string' && built.anchors.title.trim().length > 0 ? built.anchors.title : undefined)
    renameChild(ctx, child, derivedTitle)
  } catch (error) {
    warnings.push({ code: 'title-rename-failed', message: String(error?.message ?? error) })
  }

  if (typeof built.boundPreset === 'string' && built.boundPreset.length > 0) {
    try {
      doc = annotatePresetLine(doc, { lang: input.lang, inheritPreset: input.inheritPreset, mounted: presetReport.mounted === true })
    } catch {
      /* 页脚不是关键路径 */
    }
  }

  // ── 7. 注入：auto 仅在核对 + 登记都成功时 prompt；否则同一 child 改草稿 ──
  const canStart = input.mode === 'auto' && preflight.ok && notifyError === null
  let injection
  try {
    if (canStart) {
      injection = await budget.step(injectDoc(ctx, child, doc, true), config.timeoutMs.inject, '注入交接单')
    } else {
      const noteText = await budget.step(appendDoc(child, doc), config.timeoutMs.inject, '注入交接单')
      injection = { mode: 'appended', note: noteText }
    }
  } catch (error) {
    const message = String(error?.message ?? error)
    warnings.push({ code: 'inject-failed', message })
    rememberInherit(input.sourceId, child.id, { state: 'failed', error: message.slice(0, 200), warnings })
    note(`service: 注入失败，保留已建会话 ${child.id}: ${message}`)
    return {
      ok: true,
      mode: input.mode,
      state: 'pending-injection',
      childId: child.id,
      doc,
      cwd,
      preset: presetReport.preset ?? null,
      presetInherited: presetReport.mounted === true,
      workspace,
      preflight,
      warnings,
      note: `会话已创建（${child.id}），但交接单注入失败。可打开它手动粘贴；不得对同一逻辑操作重建。`,
    }
  }

  let state
  if (input.mode === 'draft') {
    state = 'draft'
  } else if (canStart && injection.mode === 'prompted') {
    state = 'started'
  } else {
    state = 'draft-fallback'
    if (canStart && injection.mode !== 'prompted') {
      warnings.push({ code: 'prompt-failed', message: `启动未生效（${injection.mode}），已改为草稿注入` })
    }
  }

  rememberInherit(input.sourceId, child.id, {
    state: state === 'started' ? 'ok' : 'draft',
    mode: `service-${input.mode}`,
    warnings,
  })
  note(`service ok child=${child.id} mode=${input.mode} state=${state} injection=${injection.mode} preflight=${preflight.ok} warnings=${warnings.length}`)
  return {
    ok: true,
    mode: input.mode,
    state,
    childId: child.id,
    doc,
    cwd,
    preset: presetReport.preset ?? null,
    presetInherited: presetReport.mounted === true,
    workspace,
    preflight,
    warnings,
    note: injection.note,
    injectionMode: injection.mode,
  }
}

/**
 * 建一个服务实例。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} config - 归一化配置（resolveConfig 的结果）。
 * @returns {object} 冻结的 API。
 */
export function createInheritService(ctx, config) {
  const api = {
    name: 'sessionInherit',
    version: ownVersion(),

    /**
     * 发起一次继承。
     * @param {{sourceId: string, mode?: 'hint'|'draft'|'auto', parentSessionId?: string, depth?: number,
     *   nextStep?: string, title?: string, lang?: string, inheritPreset?: boolean, doc?: string,
     *   onChildCreated?: (info: {childId: string, sourceId: string, parentSessionId: string|null, depth: number|null, mode: string}) => void|Promise<void>}} input - 参数。
     * @returns {Promise<object>} {ok, mode, state, childId, doc, cwd, preset, presetInherited, workspace, preflight, warnings, note, error?}
     */
    handoff(input) {
      const normalized = normalizeInput(input)
      if (!/^(session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(normalized.sourceId)) {
        return Promise.resolve(failedResult(normalized, 'failed', 'invalid-source', `sourceId 不合法：${normalized.sourceId}`))
      }
      // hint 只读、无副作用：不能进 commitOnce 的在途池，否则会与 draft（start 同为 false）
      // 撞指纹并复用后者的结果——"只读建议"拿到一个已建会话 id 是错的。
      if (normalized.mode === 'hint') return runHandoff(ctx, normalized, config)
      return commitOnce(normalized, () => runHandoff(ctx, normalized, config))
    },

    registerChildDepth,
    depthOf,
    clearDepthLedger,

    /**
     * 只读健康检查。
     * @returns {object} 服务状态。
     */
    probe() {
      return {
        name: 'sessionInherit',
        version: ownVersion(),
        state: 'ready',
        modes: ['hint', 'draft', 'auto'],
        methods: ['handoff', 'registerChildDepth', 'depthOf', 'probe'],
        entries: depthLedger.size,
        services: probe(ctx),
      }
    },
  }
  return Object.freeze(api)
}
