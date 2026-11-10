// 继承编排器：唯一一条流水线，三处入口都走它。
//
// 为什么要合并：commit 端点、session_inherit 工具、/inherit 命令以前各写一遍
// 「读 → 建 → 挂 → 改名 → 注入 → 记账」，三份代码已经出现了不一致（标题、超时、
// 语言）。合并之后改一处就是改三处。
//
// 超时语义（本文件最重要的约定）：
//   - 读源会话：无副作用，超时直接失败；
//   - 建会话：有副作用且不可取消。超时意味着"可能已经建出来了"，此时**绝不重试**
//     （重试 = 第二个会话 + 第一个泄漏），而是报错并让用户去侧边栏确认；
//   - 建会话之后的一切：会话已经存在，失败只能降级，返回 200 + sessionId，
//     让用户至少能找回它。这就是"不出现假失败、真建好"。
import { annotatePresetLine, replaceNextStepSection } from './extract.mjs'
import { rememberInherit } from './history.mjs'
import { note } from './log.mjs'
import { buildDoc } from './read.mjs'
import { attachWorkspace, createSessionOnly, injectDoc, registerPresetBinding, renameChild } from './session.mjs'
import { createBudget } from './timeouts.mjs'

/** 继承流程的可识别错误：入口据此映射 HTTP 状态码或文本提示。 */
export class InheritError extends Error {
  /**
   * @param {string} message - 展示给用户的文案。
   * @param {string} code - 机器可读代码。
   */
  constructor(message, code) {
    super(message)
    this.name = 'InheritError'
    this.code = code
  }
}

const INFLIGHT_TTL_MS = 120_000

/** @type {Map<string, {startedAt: number, promise: Promise<object>}>} 在途继承。 */
const inFlight = new Map()

/**
 * 参数指纹：只有这些参数不同才算"另一次继承"。
 * @param {object} input - 归一化输入。
 * @returns {string} 指纹。
 */
function fingerprint(input) {
  const docPart = typeof input.doc === 'string' ? [input.doc.length, input.doc.slice(0, 64)] : null
  return JSON.stringify([
    input.sourceId,
    input.title ?? '',
    input.nextStep ?? '',
    input.start === true,
    input.inheritPreset !== false,
    docPart,
  ])
}

/**
 * 同一个源会话 + 同一组参数只允许一次在途执行。
 *
 * 旧实现只挡客户端连点，两个标签页仍会建出两个子会话。这里按指纹去重：
 * 同指纹复用同一个结果，同源不同指纹直接拒绝——静默复用别人的参数比报错更糟。
 * @param {object} input - 归一化输入。
 * @param {() => Promise<object>} run - 真正的继承流程。
 * @returns {Promise<object>} 继承结果。
 */
export function commitOnce(input, run) {
  const key = fingerprint(input)
  const hit = inFlight.get(key)
  if (hit !== undefined && Date.now() - hit.startedAt < INFLIGHT_TTL_MS) {
    note(`commitOnce: 复用同参数在途请求 ${key.slice(0, 80)}`)
    return hit.promise.then((result) => ({ ...result, deduplicated: true }))
  }
  const sourcePrefix = JSON.stringify([input.sourceId]).slice(0, -1)
  for (const [otherKey, other] of inFlight) {
    if (otherKey === key) continue
    if (!otherKey.startsWith(sourcePrefix)) continue
    if (Date.now() - other.startedAt >= INFLIGHT_TTL_MS) continue
    throw new InheritError('同一源会话正在以另一组参数继承，请等这次完成再试', 'conflicting-commit')
  }
  const promise = Promise.resolve()
    .then(run)
    .finally(() => {
      if (inFlight.get(key)?.promise === promise) inFlight.delete(key)
    })
  inFlight.set(key, { startedAt: Date.now(), promise })
  return promise
}

/**
 * 建会话失败后的降级：只重试建会话本身，不重跑预设绑定。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} built - buildDoc 结果。
 * @param {string|null|undefined} presetOverride - 预设覆盖值。
 * @param {object} budget - 预算对象。
 * @param {object} config - 归一化配置。
 * @returns {Promise<{child: object, presetReport: object}>} 子会话与预设报告。
 */
async function createWithDegrade(ctx, built, presetOverride, budget, config) {
  const presetReport = {}
  const spawn = (mountPreset) => createSessionOnly(ctx, {
    header: built.header,
    route: built.route,
    presetOverride,
    report: presetReport,
    mountPreset,
  })
  let child
  try {
    child = await budget.step(spawn(true), config.timeoutMs.create, '新建会话')
  } catch (error) {
    // 超时意味着 agents.create 可能已经在后台把会话建出来了。这时重试等于再造一个，
    // 而第一个没有任何记录——正是"假失败、真建好 + 孤儿"的来源。宁可报错让用户确认。
    if (error?.code === 'ETIMEOUT') {
      throw new InheritError(
        `新建会话超时（${error.message}）。会话可能已经建好，请先刷新侧边栏确认，不要重复点击`,
        'create-timeout',
      )
    }
    note(`commit: 首次创建失败（${String(error?.message ?? error)}），改为不挂 preset 重试`)
    try {
      child = await budget.step(spawn(false), config.timeoutMs.create, '新建会话(降级)')
      note(`commit: 降级创建成功 ${child.id}`)
    } catch (error2) {
      throw new InheritError(
        `新建会话失败：${String(error?.message ?? error)}；去掉 preset 重试仍失败：${String(error2?.message ?? error2)}`,
        'create-failed',
      )
    }
  }
  return { child, presetReport }
}

/**
 * 跑一次完整的继承。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} input - 归一化输入（见 apply 里的入口注释）。
 * @param {object} config - 归一化配置。
 * @returns {Promise<{sessionId: string, state: string, mode: string, workspace: boolean, preset: string|null, presetInherited: boolean, note: string, warnings: object[], doc: string, deduplicated: boolean}>} 结果。
 */
export async function inheritSession(ctx, input, config) {
  return commitOnce(input, () => runInherit(ctx, input, config))
}

/**
 * 真正的流水线。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} input - 归一化输入。
 * @param {object} config - 归一化配置。
 * @returns {Promise<object>} 结果。
 */
async function runInherit(ctx, input, config) {
  const warnings = []
  const budget = createBudget(config.timeoutMs.total)

  // ── 1. 读源会话 + 提取锚点（无副作用，超时可直接失败） ──
  let built
  try {
    built = await budget.step(buildDoc(ctx, {
      sessionId: input.sourceId,
      title: input.title,
      recentUsers: config.recentUsers,
      nextStep: input.nextStep,
      lang: input.lang,
      cacheTtlMs: config.cacheTtlMs,
    }), config.timeoutMs.build, '读取源会话')
  } catch (error) {
    throw new InheritError(`读取源会话失败：${String(error?.message ?? error)}`, 'build-failed')
  }

  // ── 2. 交接单正文：客户端可能回传了编辑过的版本 ──
  const docFromClient = typeof input.doc === 'string' ? input.doc : null
  let doc = docFromClient !== null ? docFromClient : built.doc
  if (docFromClient !== null && typeof input.nextStep === 'string' && input.nextStep.trim().length > 0) {
    // 客户端回传了（可能被编辑过的）交接单，同时用户又在独立输入框里填了下一步：
    // 把后者写进前者。少了这一步，那个输入框就是白填的。
    doc = replaceNextStepSection(doc, input.nextStep)
  }
  if (doc.trim().length === 0) {
    // 用户明确把交接单清空了：不能静默换成自动生成的版本。
    throw new InheritError('交接单为空', 'empty-doc')
  }

  // ── 3. 建会话 ──
  const presetOverride = input.inheritPreset === false
    ? null
    : (typeof built.boundPreset === 'string' && built.boundPreset.length > 0 ? built.boundPreset : undefined)
  const { child, presetReport } = await createWithDegrade(ctx, built, presetOverride, budget, config)
  // 建出来的那一刻就记账：之后任何一步失败，用户都能从账本里找回这个会话。
  rememberInherit(input.sourceId, child.id, { state: 'pending' })

  // 预设账本登记：只影响第三方插件的面板显示，失败不该有任何存在感（除了 warning）。
  if (presetOverride !== null && presetReport.mounted === true) {
    try {
      await budget.step(registerPresetBinding(ctx, built.header.id, child.id),
        config.timeoutMs.binding, '登记预设账本')
    } catch (error) {
      warnings.push({ code: 'preset-binding-failed', message: String(error?.message ?? error) })
      note(`commit: 预设账本登记失败（已降级）: ${String(error?.message ?? error)}`)
    }
  }

  // ── 4. 建之后的步骤：全部降级为 warning，绝不让会话丢失 ──
  let workspace = false
  try {
    workspace = await budget.step(attachWorkspace(ctx, built.header.cwd, child.id),
      config.timeoutMs.workspace, '挂载工作区')
  } catch (error) {
    workspace = false
    warnings.push({ code: 'workspace-attach-failed', message: String(error?.message ?? error) })
    note(`commit: 工作区挂载失败（已降级）: ${String(error?.message ?? error)}`)
  }

  // 页脚那句「预设」必须写成事实：preview 发生在用户勾选之前，只有这里拿到
  // 挂载结果才谈得上如实（上一版页脚在说一件接口根本没做的事）。
  if (typeof built.boundPreset === 'string' && built.boundPreset.length > 0) {
    doc = annotatePresetLineOrOriginal(doc, input, presetReport)
  }

  try {
    // P1-2：命令/工具入口以前传 undefined，标题永远是「继承: 会话」。
    // 事件流里最后一条 `session/title` 就是源会话现名（用户手动改过名就取那条）。
    const derivedTitle = typeof input.title === 'string' && input.title.trim().length > 0
      ? input.title
      : (typeof built.anchors.title === 'string' && built.anchors.title.trim().length > 0 ? built.anchors.title : undefined)
    renameChild(ctx, child, derivedTitle)
  } catch (error) {
    warnings.push({ code: 'title-rename-failed', message: String(error?.message ?? error) })
  }

  // ── 5. 注入：失败也不回 500 —— 会话已经在手上了 ──
  let injection
  let state = 'injected'
  try {
    injection = await budget.step(injectDoc(ctx, child, doc, input.start),
      config.timeoutMs.inject, '注入交接单')
  } catch (error) {
    state = 'pending-injection'
    warnings.push({ code: 'inject-failed', message: String(error?.message ?? error) })
    note(`commit: 注入失败（已保留会话 ${child.id}）: ${String(error?.message ?? error)}`)
    rememberInherit(input.sourceId, child.id, {
      state: 'failed',
      error: String(error?.message ?? error).slice(0, 200),
      warnings,
    })
    return {
      sessionId: child.id,
      state,
      mode: 'none',
      workspace,
      preset: presetReport.preset ?? null,
      presetInherited: presetReport.mounted === true,
      note: `会话已创建（${child.id}），但交接单注入失败：${String(error?.message ?? error)}。可以打开它手动粘贴，或稍后重试注入。`,
      warnings,
      doc,
      deduplicated: false,
    }
  }

  rememberInherit(input.sourceId, child.id, { state: 'ok', mode: injection.mode, warnings })
  note(`commit ok child=${child.id} mode=${injection.mode} state=${state} workspace=${workspace} preset=${presetReport.preset ?? '(none)'} mounted=${presetReport.mounted === true} warnings=${warnings.length}`)
  return {
    sessionId: child.id,
    state,
    mode: injection.mode,
    workspace,
    // 实际挂上的预设（没继承/没绑定时为 null）：界面据此如实提示，不靠猜。
    preset: presetReport.preset ?? null,
    presetInherited: presetReport.mounted === true,
    note: injection.note,
    warnings,
    doc,
    deduplicated: false,
  }
}

/**
 * 重写交接单页脚里的预设行（失败时原样返回）。
 * @param {string} doc - 交接单。
 * @param {object} input - 输入。
 * @param {object} presetReport - 预设报告。
 * @returns {string} 处理后的交接单。
 */
function annotatePresetLineOrOriginal(doc, input, presetReport) {
  try {
    return annotatePresetLine(doc, { lang: input.lang, inheritPreset: input.inheritPreset !== false, mounted: presetReport.mounted === true })
  } catch {
    return doc
  }
}
