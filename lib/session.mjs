// 会话级操作：建会话、挂工作区、改标题、注入交接单。
//
// createSessionOnly 与 registerPresetBinding 必须分开：
//   - 建会话是**有副作用且不可取消**的一步（agents.create 一旦被调用，超时也拦不住）；
//   - 往第三方插件账本登记是**纯展示同步**，挂了、慢了都不该影响继承本身。
// 以前两件事挤在一个函数里，一次 fetch 卡住就能把"建会话"变成"报错但会话已建"。
import { randomUUID } from 'node:crypto'
import { copyTavernBinding, composeForPreset } from './presets.mjs'
import { note } from './log.mjs'

/**
 * 新建"会话 + agent"整体（必须一起建：只建裸会话会让客户端打开时走 resume
 * 撞上 "cannot prepare while it is live"）。
 * @param {object} ctx - Cordis 上下文。
 * @param {{header: object, route: {provider: string, model: string}|null, presetOverride?: string|null, mountPreset?: boolean, report?: object}} input - 源会话信息。
 * @returns {Promise<object>} 子会话对象。
 */
export async function createSessionOnly(ctx, input) {
  const sourceHeader = input.header !== null && typeof input.header === 'object' ? input.header : {}
  // presetOverride 三态：不传 = 沿用源会话 header 的预设（工具/命令通路的老行为）；
  // `null` = 这次不继承、用 DSH 默认预设；非空字符串 = 用这个 preset id。
  // 自定义预设**只能**在会话创建时经由这里设置：某些预设插件的
  // `/api/tavern/bind-preset` 只写它自己的账本，不切换 DSH 的 agent preset。
  const override = input.presetOverride
  const wantedPreset = override === null
    ? undefined
    : typeof override === 'string' && override.trim().length > 0
      ? override.trim()
      : sourceHeader.agentPreset
  const composition = input.mountPreset === false
    ? {
        ...(typeof wantedPreset === 'string' && wantedPreset.length > 0
          ? { agentPreset: wantedPreset }
          : {}),
        mounted: false,
        setup: () => undefined,
      }
    : await composeForPreset(ctx, wantedPreset)
  // 把实际结果回报给调用方：commit 要据此在交接单页脚写清"到底有没有继承"，
  // 而不是按"打算继承"来写（那正是上一版页脚撒谎的原因）。
  if (input.report !== null && typeof input.report === 'object') {
    input.report.preset = composition.agentPreset ?? null
    input.report.mounted = composition.mounted === true
  }
  // 注意：这里**不传** `parentSession`。
  // 它是 fork-lineage 字段，而我们的源会话常常是冷的；第一次真实点击时挂起
  // 就发生在 agents.create 上，去掉这条父链后创建是纯新增，不再依赖源会话状态。
  // 来源信息由交接单正文自己携带（含源会话 id），不依赖 header lineage。
  const meta = {
    ...(typeof sourceHeader.cwd === 'string' && sourceHeader.cwd.length > 0 ? { cwd: sourceHeader.cwd } : {}),
    ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
  }
  note(`create: preset=${composition.agentPreset ?? '(none)'} mounted=${composition.mounted === true} mountPreset=${input.mountPreset !== false} cwd=${meta.cwd ?? '(none)'} route=${input.route === null || input.route === undefined ? '(none)' : `${input.route.provider}/${input.route.model}`}`)
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
 * 把源会话的预设绑定登记到新会话的第三方账本（只影响那个插件的面板显示）。
 * 失败只返回 null，不抛——它不属于继承主流程。
 * @param {object} ctx - Cordis 上下文。
 * @param {string|undefined} sourceId - 源会话 id。
 * @param {string} childId - 新会话 id。
 * @param {number} [timeoutMs] - 绑定接口 cap。
 * @returns {Promise<string|null>} 登记成功的预设 id。
 */
export async function registerPresetBinding(ctx, sourceId, childId, timeoutMs = 2000) {
  if (typeof sourceId !== 'string' || sourceId.length === 0) return null
  return await copyTavernBinding(ctx, sourceId, childId, timeoutMs)
}

/**
 * 建会话 + 登记绑定（绑定失败只告警）。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} input - 同 createSessionOnly。
 * @param {number} [bindingTimeoutMs] - 绑定接口 cap。
 * @returns {Promise<object>} 子会话对象。
 */
export async function createChild(ctx, input, bindingTimeoutMs = 2000) {
  const sourceHeader = input.header !== null && typeof input.header === 'object' ? input.header : {}
  const session = await createSessionOnly(ctx, input)
  // 用户取消勾选「继承原对话预设」时（presetOverride === null）不登记：账本上写着绑了、
  // DSH 侧却没绑，比不登记更误导。
  // 降级重试（mountPreset === false）同样跳过：那一轮 DSH 侧本来就没挂 preset，再走一遍
  // 网络只会把已经慢过一次的降级也拖黄。
  if (input.presetOverride !== null && input.mountPreset !== false) {
    await registerPresetBinding(ctx, sourceHeader.id, session.id, bindingTimeoutMs)
  }
  return session
}

/**
 * 把子会话挂进源会话所在的工作区分组（失败仅告警：会话仍可用，只是暂落"未分组"）。
 * @param {object} ctx - Cordis 上下文。
 * @param {string|undefined} cwd - 工作目录。
 * @param {string} childSessionId - 子会话 id。
 * @returns {Promise<boolean>} 是否挂载成功。
 */
export async function attachWorkspace(ctx, cwd, childSessionId) {
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
export async function makeUserMessage(text) {
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
 * 直接追加交接单（不触发首轮）。
 * @param {object} child - 子会话。
 * @param {string} doc - 交接单正文。
 * @returns {Promise<string>} 说明文本。
 */
export async function appendDoc(child, doc) {
  if (typeof child.append !== 'function') {
    throw new Error('会话不支持 append，交接单未能注入')
  }
  const message = await makeUserMessage(doc)
  // append 在部分实现里是异步的：不 await 就等于把失败吞掉，而重试路径的
  // 幂等判断依赖"交接单到底写进去没有"。
  await child.append('user/message', message, { surfaceOp: 'append' })
  return '交接单已写入新会话，打开后直接说要做什么即可。'
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
export async function injectDoc(ctx, child, doc, start) {
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
 * 给子会话一个可辨识的标题（失败仅告警）。
 *
 * `sessionTitle.rename` 的第一个参数必须是**活的 Session 实例**（源码里断言
 * `ctx.sessions.get(id) === session`），新建的会话正好是 live，所以这里可以直接用。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} child - 子会话。
 * @param {string|undefined} sourceTitle - 源会话标题。
 */
export function renameChild(ctx, child, sourceTitle) {
  const titles = ctx.get('sessionTitle')
  if (titles === undefined || typeof titles.rename !== 'function') return
  const raw = typeof sourceTitle === 'string' && sourceTitle.trim().length > 0 ? sourceTitle.trim() : '会话'
  // 链式继承会一代代累积前缀（「继承: 继承: 继承: X」）。这里把已有的前缀剥掉再加一层，
  // 标题始终只有一层，不会随着继承次数越滚越长。
  const base = raw.replace(/^(?:继承|Inherited from):\s*/, '').replace(/^(?:继承|Inherited from):\s*/, '') || '会话'
  try {
    titles.rename(child, `继承: ${base}`.slice(0, 80))
  } catch {
    /* 标题不是关键路径 */
  }
}
