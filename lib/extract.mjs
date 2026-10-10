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
  editedFiles: 16,
  readFiles: 16,
  commands: 8,
  todos: 20,
  failures: 6,
  failureChars: 300,
  docChars: 14000,
  recentUsers: 6,
}

/** 参数里携带 shell 命令的工具名。 */
const COMMAND_TOOLS = new Set(['pwsh', 'bash', 'shell', 'terminal', 'run_command', 'exec'])

/**
 * 会写入/修改文件的工具：只有这些调用的结构化 `file_path` 才算「动过的文件」。
 *
 * 实测某真实会话：写入类 edit 65 + write 20 = 85 次，读取类 read 37 + read_image 15
 * + grep 5 + glob 1 = 58 次；涉及文件数 17 个（写）对 43 个（读）。两类混在一起时，
 * 读过的文件会把真正改过的挤出上限，而"改过什么"才是接着干最需要的。
 */
const WRITE_TOOLS = new Set(['edit', 'write', 'multi_edit', 'create_file', 'apply_patch', 'str_replace', 'str_replace_editor', 'notebook_edit'])
/** 只读取/检索的工具。 */
const READ_TOOLS = new Set(['read', 'read_image', 'view', 'view_image', 'grep', 'glob', 'list_dir', 'list_directory'])
/** 工具参数里承载路径的键（按优先级取第一个命中的）。 */
const PATH_KEYS = ['file_path', 'filePath', 'notebook_path', 'path']

/**
 * 超长时整节丢弃的顺序：先丢信息密度最低的。
 *
 * 不能用"从尾部硬截断"——「下一步」在文档末尾，硬截断第一个切掉的就是唯一
 * 必须被执行的那一节。这里逐节丢，丢到不超限为止；下面这几个 key 之外的
 * 章节（下一步 / 任务目标 / 改过的文件 / 最近失败）永不丢弃。
 */
const DROP_ORDER = ['mentioned', 'readFiles', 'relativeRefs', 'commands', 'lastAssistant', 'todos', 'recentUsers', 'editedFiles']

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
 * 两段都排除中文标点：`X:\p\a.cs，以及 X:\p\b.cs` 这种中文正文写法，不排除的话
 * 整串会被当成一个路径（实测确认）——路径本身极少含中文标点，正文里却很常见。
 * 两段都排除 ASCII 冒号：`copy X:\p\a.cs X:\p\b.cs` 里的第二个盘符会让中间段
 * 一路吃过去，把两条路径连成一条（实测确认）。
 */
const WIN_PATH = /[A-Za-z]:[\\/](?:[^\\/\r\n"'`<>|?*:，。；：、！？（）【】《》“”‘’]+[\\/])*[^\\/\r\n"'`<>|?*\s:，。；：、！？（）【】《》“”‘’]+/g
/**
 * POSIX 绝对路径：要求至少两段且末段带扩展名。
 * 单段形式（`/m.size`、`/EnemyGrunt.cs`、`/§4.3.1`）在真实日志里几乎全是
 * 从普通文本或标点里误抓的噪音，直接不放行。
 */
const POSIX_PATH = /(?:\/[\w.@+-]+){2,}\.[A-Za-z0-9]{1,8}(?![A-Za-z0-9])/g
/**
 * 被引号/反引号包裹的整段。
 *
 * 这是"最后一段本身含空格"的路径唯一可靠的边界。WIN_PATH 抓不到它：它的末段
 * 不允许含空白（否则会把后续句子一起吞进来），于是
 * `'X:\work\My Project Name'` 只会匹配到第一个空格之前——实测被截断成
 * `X:\work\My Project`，在一个真实会话里出现 42 次。引号内的内容
 * 天然有明确边界，整段采用即可。
 */
const QUOTED_SPAN = /(['"`])([^'"`\r\n]{4,260})\1/g
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

  // 整串就是一个路径：工具的结构化参数（read / grep 的 path）经常直接把完整路径
  // 当值传进来，而它可能正是"最后一段含空格"的目录——交给 WIN_PATH 只会得到
  // 截断版（原因见 QUOTED_SPAN 的注释）。这里要求整串只出现一次盘符，避免把
  // 空格拼起来的多个路径当成一个。
  if (/^[A-Za-z]:[\\/]/.test(value) && value.length <= 260 && !/[\r\n;|]/.test(value)
    && (value.match(/[A-Za-z]:[\\/]/g) ?? []).length === 1) {
    const whole = value.trim()
    return NOISE_PATH.test(whole) ? out : [whole]
  }

  // 先处理引号内的整段：它比 WIN_PATH 更完整，所以要占住这些区间，
  // 免得 WIN_PATH 又把同一段路径的截断版再收一遍。
  const quoted = []
  QUOTED_SPAN.lastIndex = 0
  let span
  while ((span = QUOTED_SPAN.exec(value)) !== null) {
    quoted.push([span.index, span.index + span[0].length])
    const inner = span[2].trim()
    if (!/^[A-Za-z]:[\\/]/.test(inner)) continue
    if (/[;|]/.test(inner)) continue // 引号里塞了多条命令，不是单个路径
    if (inner.length > 260 || NOISE_PATH.test(inner)) continue
    out.push(inner)
  }
  const insideQuoted = (at) => quoted.some(([start, end]) => at >= start && at < end)

  for (const re of [WIN_PATH, POSIX_PATH]) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(value)) !== null) {
      if (insideQuoted(m.index)) continue
      const hit = m[0].replace(/[.,;:]+$/, '').replace(/[\\/]+$/, '')
      if (hit.length < 4 || hit.length > 260) continue
      if (NOISE_PATH.test(hit)) continue
      out.push(hit)
    }
  }
  // 含连续两个反斜杠的候选不是有效路径（UNC 前缀 `\\server` 不以盘符开头，走不到这里）：
  // 实测真实日志里存在被二次转义过的形态，抓出来只会是垃圾。
  return out.filter((hit) => !hit.includes('\\\\'))
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
 *   files: Array<{path: string, hits: number, time: number, absolute: boolean}>,
 *   edited: Array<{path: string, hits: number, time: number, absolute: boolean}>,
 *   read: Array<{path: string, hits: number, time: number, absolute: boolean}>,
 *   mentioned: Array<{path: string, hits: number, time: number, absolute: boolean}>,
 *   failures: Array<{tool: string, code: string, text: string}>,
 *   commands: Array<{name: string, command: string, time: number}>,
 *   todos: Array<{content: string, status: string}>,
 *   inheritedCount: number,
 *   compactions: number,
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
  const editedHits = new Map()
  const readHits = new Map()
  const callNames = new Map()
  const failures = []
  const commands = []
  let todos = []
  let inheritedCount = 0
  let compactions = 0
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
        const data = event.data
        if (data !== null && typeof data === 'object'
          && typeof data.callId === 'string' && data.callId.length > 0) {
          // tool/result 只带 toolCallId，靠这张表才能把失败现场还原成"哪个工具失败了"。
          callNames.set(data.callId, typeof data.name === 'string' ? data.name : '')
        }
        collectToolCall(data, time, {
          fileHits,
          editedHits,
          readHits,
          commands,
          setTodos: (next) => { todos = next },
        })
        break
      }
      case 'tool/result': {
        collectToolResult(event.data, { callNames, failures })
        break
      }
      case 'compaction/start': {
        compactions += 1
        break
      }
      default:
        break
    }
  }

  /** 是否带盘符的绝对路径；否则是工具参数里的相对引用片段。 */
  const isAbsolute = (path) => /^[A-Za-z]:[\\/]/.test(path)
  /** 把一张命中表转成按「最近使用」排序的数组。 */
  const toList = (hits, limit) => [...hits.entries()]
    .map(([path, record]) => ({ path, hits: record.hits, time: record.time, absolute: isAbsolute(path) }))
    .sort((a, b) => (b.time - a.time) || (b.hits - a.hits))
    .slice(0, limit)

  const allFiles = toList(fileHits, LIMITS.files)
  // 丢掉"被更完整版本覆盖"的截断候选：短的那个后面紧跟一个空格、再接长路径的剩余部分。
  // 例：`X:\work\My Project` 与 `X:\work\My Project Name` 并存时，
  // 前者必然是后者的截断版。用"前缀 + 空格"判定，不会误伤 `X:\a` 与 `X:\a\b.cs`。
  const filePaths = allFiles.map((file) => file.path)
  const files = allFiles.filter((file) => !filePaths.some((other) => other !== file.path && other.startsWith(`${file.path} `)))
  const edited = toList(editedHits, LIMITS.editedFiles)
  const editedPaths = new Set(edited.map((file) => file.path))
  const read = toList(readHits, LIMITS.readFiles).filter((file) => !editedPaths.has(file.path))
  const readPaths = new Set(read.map((file) => file.path))
  // 工具参数里扫出来、但既不是写入目标也不是读取目标的路径：多数来自 write 的
  // content / edit 的 new_string 正文，属于"文中提到"，信息密度最低。
  const mentioned = files.filter((file) => !editedPaths.has(file.path) && !readPaths.has(file.path))

  return {
    firstUser: users.length > 0 ? { text: users[0].text, time: users[0].time } : null,
    recentUsers: users.slice(-recentUsersLimit),
    lastAssistant: assistants.length > 0 ? assistants[assistants.length - 1] : null,
    files,
    edited,
    read,
    mentioned,
    failures: dedupeFailures(failures, LIMITS.failures),
    commands: commands.slice(-LIMITS.commands),
    todos: todos.slice(0, LIMITS.todos),
    inheritedCount,
    compactions,
    turns,
    eventCount,
    lastTime,
  }
}

/**
 * 在一张命中表里累加一个路径。
 * @param {Map<string, {hits: number, time: number}>} hits - 命中表。
 * @param {string} path - 路径。
 * @param {number} time - 事件时间。
 */
function bump(hits, path, time) {
  const record = hits.get(path)
  if (record === undefined) {
    hits.set(path, { hits: 1, time })
    return
  }
  record.hits += 1
  if (time > record.time) record.time = time
}

/**
 * 取工具参数里第一个结构化路径。
 * @param {object} args - 已解析的工具参数。
 * @returns {string|undefined} 路径。
 */
function firstPath(args) {
  for (const key of PATH_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/**
 * 处理一条 tool/call，累积命令、待办与文件锚点。
 *
 * 路径分两个层次：`edit`/`write` 的 `file_path` 是「动过的文件」的权威来源，
 * `read`/`grep`/`glob` 的是「查过的位置」；其余从任意字符串里扫出来的只当
 * 「文中提到」——因为 write 的 `content`、edit 的 `new_string` 正文里出现的
 * 路径并不是这次调用动过的文件，却会把 hits 刷高、把真正的目标挤出上限。
 *
 * @param {unknown} data - tool/call 的 data。
 * @param {number} time - 事件时间。
 * @param {{fileHits: Map<string, {hits: number, time: number}>, editedHits: Map<string, {hits: number, time: number}>, readHits: Map<string, {hits: number, time: number}>, commands: Array<object>, setTodos: (todos: Array<{content: string, status: string}>) => void}} acc - 累加器。
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

  if (args !== null && args !== undefined && typeof args === 'object') {
    const structured = firstPath(args)
    if (structured !== undefined) {
      if (WRITE_TOOLS.has(name)) bump(acc.editedHits, structured, time)
      else if (READ_TOOLS.has(name)) bump(acc.readHits, structured, time)
    }
  }

  const strings = args === undefined ? [raw] : walkStrings(args)
  for (const value of strings) {
    for (const path of matchPaths(value)) bump(acc.fileHits, path, time)
  }
}

/**
 * 处理一条 tool/result：只收**失败现场**。
 *
 * 实测某真实会话 374 条 tool/result 里 11 条 `isError`、8 条带 `error.code`
 * （如 `FS_STALE_VERSION` / `SEARCH_FAILED`）。成功的 363 条必须丢掉，否则
 * 会把交接单淹掉；而失败的那几条恰恰是"接着干什么"最直接的线索。
 *
 * 用户主动打断（`AbortError` / `ABORTED_BEFORE_DISPATCH`）不算失败现场，丢掉。
 *
 * @param {unknown} data - tool/result 的 data。
 * @param {{callNames: Map<string, string>, failures: Array<{tool: string, code: string, text: string}>}} acc - 累加器。
 */
function collectToolResult(data, acc) {
  if (data === null || typeof data !== 'object') return
  const message = data.message
  if (message === null || typeof message !== 'object') return
  if (message.isError !== true && data.error === undefined) return

  const code = typeof data.error?.code === 'string' ? data.error.code : ''
  const errorName = typeof data.error?.name === 'string' ? data.error.name : ''
  const text = textOfBlocks(message.content).trim()
  if (/^ABORT/i.test(code) || /abort/i.test(errorName) || /^Error:\s*tool call aborted/i.test(text)) return
  // 自动审查被用户打断：不是工具本身失败，也没有任何可操作的线索
  // （实测在一个真实会话的 6 条失败里占了 2 条）。
  if (/auto-review/i.test(text) && /abort/i.test(text)) return
  if (text.length === 0 && code.length === 0) return

  const callId = typeof message.toolCallId === 'string' ? message.toolCallId : ''
  acc.failures.push({
    tool: acc.callNames.get(callId) ?? '',
    code,
    text: text.replace(/^Error:\s*/i, ''),
  })
}

/**
 * 失败按文本去重（保留最近的），再取最后 limit 条。
 *
 * 同一条系统性报错（如 `TOOL_OUTCOME_UNKNOWN`）会在多个工具上各出现一次、
 * 文本一字不差，全列出来只是把交接单撑长。
 * @param {Array<{tool: string, code: string, text: string}>} failures - 原始失败列表。
 * @param {number} limit - 最多保留几条。
 * @returns {Array<{tool: string, code: string, text: string}>} 去重后的列表。
 */
function dedupeFailures(failures, limit) {
  const seen = new Set()
  const out = []
  for (let i = failures.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const item = failures[i]
    if (seen.has(item.text)) continue
    seen.add(item.text)
    out.unshift(item)
  }
  return out
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
 *
 * 两个刻意的设计：
 *   1. **章节标题不带序号**。序号是逐节写死的字面量，会随"某一节有没有内容"漂移；
 *      曾经客户端提示与 README 都写「## 7. 下一步」而实际生成的是「## 8.」，
 *      用户照着提示找永远找不到。去掉序号后增删章节都不会再失配。
 *   2. **超长时整节丢弃，而不是从尾部硬截断**。硬截断第一个切掉的就是文档末尾的
 *      「下一步」——唯一必须被执行的那一节。
 *
 * @param {{sessionId: string, title?: string, cwd?: string, model?: string}} source - 源会话标识。
 * @param {ReturnType<typeof collectAnchors>} anchors - 提取出的锚点。
 * @param {{nextStep?: string}} [extra] - 用户补充的下一步。
 * @returns {string} Markdown 交接单。
 */
export function composeInheritDoc(source, anchors, extra = {}) {
  const head = []
  const sections = []
  const tail = []

  /**
   * 追加一节（正文为空则整节不出现）。
   * @param {string} key - 丢弃顺序用的键。
   * @param {string} title - 章节标题。
   * @param {string[]} body - 正文行。
   */
  const add = (key, title, body) => {
    if (body.length === 0) return
    sections.push({ key, lines: ['', `## ${title}`, ...body] })
  }

  /** @param {{path: string, hits: number, missing?: boolean}} file - 文件锚点。 @returns {string} 一行列表项。 */
  const fileLine = (file) => `- \`${file.path}\`${file.hits > 1 ? `（${file.hits} 次）` : ''}${file.missing === true ? ' **（已不存在）**' : ''}`

  const titleSuffix = typeof source.title === 'string' && source.title.trim().length > 0
    ? `（${source.title.trim()}）`
    : ''

  head.push(DOC_MARK)
  head.push('')
  head.push(`> 来源：\`${source.sessionId}\`${titleSuffix} · 共 ${anchors.turns} 轮 · 最后活动 ${formatTime(anchors.lastTime) || '未知'}`)
  head.push('> **执行规则**：不要复述本单，不要总结本单，不要回应"收到/了解了"。读完直接做「下一步」。')
  head.push('> 第一步只做一个具体动作（读某个文件 / 跑某条命令），做完停下汇报；不要同时铺开多个方向。')
  if (anchors.inheritedCount > 0) {
    head.push(`> 注意：源会话本身也是继承来的（含 ${anchors.inheritedCount} 份更早交接单），细节以源会话日志为准。`)
  }
  if (Number.isInteger(anchors.compactions) && anchors.compactions > 0) {
    head.push(`> 注意：源会话做过 ${anchors.compactions} 次上下文压缩，更早的原文可能已不在日志里。`)
  }

  add('task', '任务目标', [
    anchors.firstUser === null ? '_（源会话没有用户消息）_' : clip(anchors.firstUser.text, LIMITS.firstUserChars),
  ])

  if (anchors.edited.length > 0) {
    add('editedFiles', '改过的文件（源会话实际写入/修改过，按最近改动排序）', anchors.edited.map(fileLine))
  }

  if (anchors.failures.length > 0) {
    add('failures', '最近失败（源会话最后几次工具报错，先确认是否已解决）', anchors.failures.map((failure) => {
      const label = failure.tool.length > 0 ? `\`${failure.tool}\`` : '工具'
      const code = failure.code.length > 0 ? ` ${failure.code}` : ''
      return `- ${label}${code}：${oneLine(failure.text, LIMITS.failureChars)}`
    }))
  }

  if (anchors.recentUsers.length > 0) {
    add('recentUsers', '最近的用户指令（由旧到新）', anchors.recentUsers.map((item) => `- (t${item.turn}) ${oneLine(item.text, LIMITS.recentUserChars)}`))
  }

  const readAbsolute = anchors.read.filter((file) => file.absolute !== false)
  const readRelative = anchors.read.filter((file) => file.absolute === false)
  const mentionedAbsolute = anchors.mentioned.filter((file) => file.absolute !== false)
  const mentionedRelative = anchors.mentioned.filter((file) => file.absolute === false)

  add('readFiles', '读过的文件（只读取过，未修改）', readAbsolute.map(fileLine))
  add('mentioned', '文中提到的路径（从工具参数正文里扫出来的，可能是噪音）', mentionedAbsolute.map(fileLine))
  add('relativeRefs', '项目内相对引用（基准目录未确定，需要时用文件搜索确认）', [...readRelative, ...mentionedRelative].map(fileLine))

  if (anchors.commands.length > 0) {
    add('commands', '最近执行的命令', anchors.commands.map((item) => `- \`${oneLine(item.command, 180)}\``))
  }

  if (anchors.todos.length > 0) {
    add('todos', '待办（源会话最后一次 todo 状态）', anchors.todos.map((todo) => `- ${todo.status === 'completed' ? '[x]' : '[ ]'} ${oneLine(todo.content, 200)}`))
  }

  if (anchors.lastAssistant !== null) {
    add('lastAssistant', '源会话最后一次回复', [clip(anchors.lastAssistant.text, LIMITS.assistantChars)])
  }

  const nextStep = typeof extra.nextStep === 'string' ? extra.nextStep.trim() : ''
  add('nextStep', '下一步', [nextStep.length > 0 ? nextStep : '_（未指定：先问我一句要做什么，不要自行展开）_'])

  tail.push('')
  if (typeof source.cwd === 'string' && source.cwd.length > 0) {
    tail.push('---')
    tail.push(`工作目录：\`${source.cwd}\`${source.model ? ` · 模型：${source.model}` : ''}`)
  }
  tail.push('> 由 dsh-session-inherit 生成（机械提取，未调用模型）。源会话未被改动，需要细节时回去查。')

  const dropped = new Set()
  const build = () => [
    ...head,
    ...sections.filter((section) => !dropped.has(section.key)).flatMap((section) => section.lines),
    ...tail,
  ].join('\n')

  let doc = build()
  for (const key of DROP_ORDER) {
    if (doc.length <= LIMITS.docChars) break
    if (!sections.some((section) => section.key === key)) continue
    dropped.add(key)
    doc = build()
  }
  if (doc.length > LIMITS.docChars) {
    doc = `${doc.slice(0, LIMITS.docChars - 26)}\n…（交接单过长，尾部已截断）`
  }
  return doc
}
