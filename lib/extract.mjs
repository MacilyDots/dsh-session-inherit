// 会话继承 · 锚点提取（纯函数，零依赖，可单测）
//
// 设计取舍：**不调用 LLM 做摘要**。
// 实测证据（2026-10-08，某会话）：/compact 把上下文从 541,227 压到
// 25,602 token 后 4 步内退化复发，且重复词从「做。」变成「好。」——压缩摘要保留的
// 是"要做验收/要写报告"这类**抽象意图**，丢掉的恰恰是文件路径、下一步参数这类
// **具体锚点**；模型握着模糊意图在抽象层反复自我告诫，句式的同质化本身就是喂给
// 重复退化的燃料。
//
// 所以这里的交接单只搬运"可核对的具体物"：任务原文、最近指令、动过的文件、
// 跑过的命令、未完成的待办。每条都可追溯回源会话，不生成任何新的概括句。

/** 交接单首行标记；也是"不要再继承一份交接单"的识别依据（防止套娃）。 */
export const DOC_MARK = '📋 会话继承单'

const LIMITS = {
  firstUserChars: 1200,
  recentUserChars: 500,
  assistantChars: 1200,
  files: 24,
  commands: 8,
  todos: 20,
  docChars: 14000,
  recentUsers: 6,
}

/** 参数里携带 shell 命令的工具名。 */
const COMMAND_TOOLS = new Set(['pwsh', 'bash', 'shell', 'terminal', 'run_command', 'exec'])

/**
 * 取出内容块里的全部 text 文本。
 * @param {unknown} blocks - 消息 content。
 * @returns {string} 拼接文本（无 text 块则空串）。
 */
export function textOfBlocks(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * 判断一段文本是否为继承交接单本身。
 * @param {unknown} text - 候选文本。
 * @returns {boolean} 是否为本插件生成的交接单。
 */
export function isInheritDoc(text) {
  return typeof text === 'string' && text.trimStart().startsWith(DOC_MARK)
}

/**
 * Windows 绝对路径。
 * 中间段允许含空格（真实项目目录常带空格，如 `X:\work\My Project Name\Assets`），
 * 末段不含空白，避免把后续句子一起吞进来。
 */
const WIN_PATH = /[A-Za-z]:[\\/](?:[^\\/\r\n"'`<>|?*]+[\\/])*[^\\/\r\n"'`<>|?*\s]+/g
/**
 * POSIX 绝对路径：要求至少两段且末段带扩展名。
 * 单段形式（`/m.size`、`/EnemyGrunt.cs`、`/§4.3.1`）在真实日志里几乎全是
 * 从普通文本或标点里误抓的噪音，直接不放行。
 */
const POSIX_PATH = /(?:\/[\w.@+-]+){2,}\.[A-Za-z0-9]{1,8}(?![A-Za-z0-9])/g
/** 运行时/临时目录：真实日志里每条 shell 命令都会带上，对"接着做什么"没有信息量。 */
const NOISE_PATH = /(?:[\\/])(?:node_modules|\.pnpm|\.git|dsh-runtimes|\.dsh[\\/]sessions|\.codex[\\/]sessions)(?:[\\/]|$)/i

/**
 * 在一个字符串里找路径候选。
 * @param {string} value - 原始字符串。
 * @returns {string[]} 命中的路径。
 */
function matchPaths(value) {
  const out = []
  if (typeof value !== 'string' || value.length < 4) return out
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return out // URL 不当路径
  for (const re of [WIN_PATH, POSIX_PATH]) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(value)) !== null) {
      const hit = m[0].replace(/[.,;:]+$/, '')
      if (hit.length < 4 || hit.length > 260) continue
      if (NOISE_PATH.test(hit)) continue
      out.push(hit)
    }
  }
  return out
}

/**
 * 递归收集对象/数组/字符串里的全部字符串值（带上限，避免超大参数爆炸）。
 * @param {unknown} value - 目标。
 * @param {number} [budget] - 最大收集条数。
 * @returns {string[]} 字符串集合。
 */
function walkStrings(value, budget = 400) {
  const out = []
  const stack = [value]
  while (stack.length > 0 && out.length < budget) {
    const current = stack.pop()
    if (typeof current === 'string') {
      out.push(current)
    } else if (Array.isArray(current)) {
      for (let i = current.length - 1; i >= 0; i -= 1) stack.push(current[i])
    } else if (current !== null && typeof current === 'object') {
      for (const key of Object.keys(current)) stack.push(current[key])
    }
  }
  return out
}

/**
 * 从会话事件流里收集"可核对的具体锚点"。
 * @param {Iterable<object>} events - 会话事件（升序 seq）。
 * @param {{recentUsers?: number}} [options] - 提取选项。
 * @returns {{
 *   firstUser: {text: string, time: number}|null,
 *   recentUsers: Array<{text: string, time: number, turn: number}>,
 *   lastAssistant: {text: string, time: number}|null,
 *   files: Array<{path: string, hits: number, time: number}>,
 *   commands: Array<{name: string, command: string, time: number}>,
 *   todos: Array<{content: string, status: string}>,
 *   inheritedCount: number,
 *   turns: number,
 *   eventCount: number,
 *   lastTime: number,
 * }} 锚点集合。
 */
export function collectAnchors(events, options = {}) {
  const recentUsersLimit = Number.isInteger(options.recentUsers) && options.recentUsers > 0
    ? options.recentUsers
    : LIMITS.recentUsers

  const users = []
  const assistants = []
  const fileHits = new Map()
  const commands = []
  let todos = []
  let inheritedCount = 0
  let turns = 0
  let eventCount = 0
  let lastTime = 0
  let currentTurn = 0

  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    eventCount += 1
    const time = typeof event.time === 'number' ? event.time : 0
    if (time > lastTime) lastTime = time

    switch (event.type) {
      case 'turn/start': {
        const turn = event.data?.turn
        if (typeof turn === 'number' && turn > turns) turns = turn
        if (typeof turn === 'number') currentTurn = turn
        break
      }
      case 'user/message': {
        // 只有 source.kind === 'user' 才是用户真的敲进来的话。
        // 其余（agent-instructions / runtime-context / skill-catalog / time-context /
        // 记忆提示 / 模型选择 / 压缩检查点）都是运行时注入，
        // 实测在某真实会话里占 42 条 user/message 中的 27 条，全是噪音。
        const sourceKind = event.data?.source?.kind
        if (sourceKind !== undefined && sourceKind !== 'user') break
        const text = textOfBlocks(event.data?.content).trim()
        if (text.length === 0) break
        if (isInheritDoc(text)) {
          inheritedCount += 1
          break
        }
        users.push({ text, time, turn: currentTurn })
        break
      }
      case 'assistant/message': {
        const text = textOfBlocks(event.data?.message?.content).trim()
        if (text.length > 0) assistants.push({ text, time })
        break
      }
      case 'tool/call': {
        collectToolCall(event.data, time, { fileHits, commands, setTodos: (next) => { todos = next } })
        break
      }
      default:
        break
    }
  }

  const files = [...fileHits.entries()]
    .map(([path, record]) => ({
      path,
      hits: record.hits,
      time: record.time,
      /** 是否带盘符的绝对路径；否则是工具参数里的相对引用片段。 */
      absolute: /^[A-Za-z]:[\\/]/.test(path),
    }))
    .sort((a, b) => (b.time - a.time) || (b.hits - a.hits))
    .slice(0, LIMITS.files)

  return {
    firstUser: users.length > 0 ? { text: users[0].text, time: users[0].time } : null,
    recentUsers: users.slice(-recentUsersLimit),
    lastAssistant: assistants.length > 0 ? assistants[assistants.length - 1] : null,
    files,
    commands: commands.slice(-LIMITS.commands),
    todos: todos.slice(0, LIMITS.todos),
    inheritedCount,
    turns,
    eventCount,
    lastTime,
  }
}

/**
 * 处理一条 tool/call，累积命令、待办与文件锚点。
 * @param {unknown} data - tool/call 的 data。
 * @param {number} time - 事件时间。
 * @param {{fileHits: Map<string, {hits: number, time: number}>, commands: Array<object>, setTodos: (todos: Array<{content: string, status: string}>) => void}} acc - 累加器。
 */
function collectToolCall(data, time, acc) {
  if (data === null || typeof data !== 'object') return
  const name = typeof data.name === 'string' ? data.name : ''
  const raw = typeof data.arguments === 'string' ? data.arguments : ''
  let args
  try {
    args = raw.length > 0 ? JSON.parse(raw) : undefined
  } catch {
    args = undefined
  }

  if (COMMAND_TOOLS.has(name) && args !== null && typeof args === 'object') {
    const command = typeof args.command === 'string' ? args.command : undefined
    if (command !== undefined && command.trim().length > 0) {
      acc.commands.push({ name, command: command.trim(), time })
    }
  }

  if (name === 'todo_write' && args !== null && typeof args === 'object' && Array.isArray(args.todos)) {
    const todos = []
    for (const item of args.todos) {
      if (item === null || typeof item !== 'object') continue
      const content = typeof item.content === 'string' ? item.content.trim() : ''
      if (content.length === 0) continue
      const status = typeof item.status === 'string' ? item.status : 'pending'
      todos.push({ content, status })
    }
    acc.setTodos(todos)
  }

  const strings = args === undefined ? [raw] : walkStrings(args)
  for (const value of strings) {
    for (const path of matchPaths(value)) {
      const record = acc.fileHits.get(path)
      if (record === undefined) {
        acc.fileHits.set(path, { hits: 1, time })
      } else {
        record.hits += 1
        if (time > record.time) record.time = time
      }
    }
  }
}

/**
 * 秒级时间戳格式化为本地可读文本。
 * @param {number} ms - 毫秒时间戳。
 * @returns {string} `YYYY-MM-DD HH:mm` 或空串。
 */
export function formatTime(ms) {
  if (typeof ms !== 'number' || ms <= 0) return ''
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 单行化 + 截断。
 * @param {string} text - 原文。
 * @param {number} max - 最大字符数。
 * @returns {string} 处理后的文本。
 */
export function clip(text, max) {
  const flat = String(text ?? '').replace(/\r\n/g, '\n').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, max - 1)}…`
}

/** 折叠围栏与多行，用于列表项。 */
function oneLine(text, max) {
  return clip(text, max).replace(/\n{2,}/g, '\n').replace(/\n/g, ' ⏎ ')
}

/**
 * 组装交接单正文（新会话首条消息）。
 * @param {{sessionId: string, title?: string, cwd?: string, model?: string}} source - 源会话标识。
 * @param {ReturnType<typeof collectAnchors>} anchors - 提取出的锚点。
 * @param {{nextStep?: string, startedAt?: number}} [extra] - 用户补充的下一步。
 * @returns {string} Markdown 交接单。
 */
export function composeInheritDoc(source, anchors, extra = {}) {
  const lines = []
  const titleSuffix = typeof source.title === 'string' && source.title.trim().length > 0
    ? `（${source.title.trim()}）`
    : ''

  lines.push(DOC_MARK)
  lines.push('')
  lines.push(`> 来源：\`${source.sessionId}\`${titleSuffix} · 共 ${anchors.turns} 轮 · 最后活动 ${formatTime(anchors.lastTime) || '未知'}`)
  lines.push('> **执行规则**：不要复述本单，不要总结本单，不要回应"收到/了解了"。读完直接做「下一步」。')
  lines.push('> 第一步只做一个具体动作（读某个文件 / 跑某条命令），做完停下汇报；不要同时铺开多个方向。')
  if (anchors.inheritedCount > 0) {
    lines.push(`> 注意：源会话本身也是继承来的（含 ${anchors.inheritedCount} 份更早交接单），细节以源会话日志为准。`)
  }
  lines.push('')

  lines.push('## 1. 任务目标')
  lines.push(anchors.firstUser === null ? '_（源会话没有用户消息）_' : clip(anchors.firstUser.text, LIMITS.firstUserChars))
  lines.push('')

  if (anchors.recentUsers.length > 0) {
    lines.push(`## 2. 最近的用户指令（由旧到新）`)
    for (const item of anchors.recentUsers) {
      lines.push(`- (t${item.turn}) ${oneLine(item.text, LIMITS.recentUserChars)}`)
    }
    lines.push('')
  }

  const absoluteFiles = anchors.files.filter((file) => file.absolute !== false)
  const relativeRefs = anchors.files.filter((file) => file.absolute === false)
  if (absoluteFiles.length > 0) {
    lines.push('## 3. 涉及的文件（绝对路径，按最近使用排序）')
    for (const file of absoluteFiles) {
      lines.push(`- \`${file.path}\`${file.hits > 1 ? `（${file.hits} 处）` : ''}`)
    }
    lines.push('')
  }

  if (relativeRefs.length > 0) {
    lines.push('## 4. 项目内相对引用（工具参数里出现过，基准目录未确定，需要时用文件搜索确认）')
    for (const file of relativeRefs) {
      lines.push(`- \`${file.path}\`${file.hits > 1 ? `（${file.hits} 处）` : ''}`)
    }
    lines.push('')
  }

  if (anchors.commands.length > 0) {
    lines.push('## 5. 最近执行的命令')
    for (const item of anchors.commands) {
      lines.push(`- \`${oneLine(item.command, 180)}\``)
    }
    lines.push('')
  }

  if (anchors.todos.length > 0) {
    lines.push('## 6. 待办（源会话最后一次 todo 状态）')
    for (const todo of anchors.todos) {
      const box = todo.status === 'completed' ? '[x]' : '[ ]'
      lines.push(`- ${box} ${oneLine(todo.content, 200)}`)
    }
    lines.push('')
  }

  if (anchors.lastAssistant !== null) {
    lines.push('## 7. 源会话最后一次回复')
    lines.push(clip(anchors.lastAssistant.text, LIMITS.assistantChars))
    lines.push('')
  }

  const nextStep = typeof extra.nextStep === 'string' ? extra.nextStep.trim() : ''
  lines.push('## 8. 下一步')
  lines.push(nextStep.length > 0 ? nextStep : '_（未指定：先问我一句要做什么，不要自行展开）_')
  lines.push('')

  if (typeof source.cwd === 'string' && source.cwd.length > 0) {
    lines.push(`---`)
    lines.push(`工作目录：\`${source.cwd}\`${source.model ? ` · 模型：${source.model}` : ''}`)
  }
  lines.push(`> 由 dsh-session-inherit 生成（机械提取，未调用模型）。源会话未被改动，需要细节时回去查。`)

  const doc = lines.join('\n')
  return doc.length > LIMITS.docChars ? `${doc.slice(0, LIMITS.docChars)}\n…（交接单已截断）` : doc
}
