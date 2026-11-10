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

/** 交接单首行标记（中文）。 */
export const DOC_MARK = '📋 会话继承单'
/** 交接单首行标记（英文）。 */
export const DOC_MARK_EN = '📋 Session handoff'
/** 两种语言的首行标记都要认：它同时是"不要再继承一份交接单"的识别依据（防止套娃）。 */
const DOC_MARKS = [DOC_MARK, DOC_MARK_EN]

/**
 * 各节上限。
 *
 * 这些数字是**按实测篇幅占比**定下来的，不是拍脑袋：在一个 1976 事件的真实会话上
 * 量过，交接单 6235 字符里「最近执行的命令」独占 23.9%（且是被硬切成碎片的 PowerShell
 * 长脚本，读不全也重跑不了），「读过的文件」+「文中提到的路径」再占 26.8%。交接单是
 * 新会话的**首条消息、每轮都会重发**，所以信息密度比条数重要。
 * 核心四节（下一步 / 任务目标 / 改过的文件 / 最近失败）只收紧长度，不砍条数。
 */
const LIMITS = {
  firstUserChars: 1200,
  recentUserChars: 500,
  assistantChars: 800,
  files: 24,
  editedFiles: 16,
  readFiles: 8,
  mentionedFiles: 6,
  relativeRefs: 6,
  commands: 5,
  commandChars: 120,
  todos: 12,
  failures: 5,
  failureChars: 200,
  docChars: 14000,
  recentUsers: 6,
  attachments: 8,
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
const DROP_ORDER = ['mentioned', 'readFiles', 'relativeRefs', 'attachments', 'commands', 'lastAssistant', 'todos', 'recentUsers', 'editedFiles']

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
  if (typeof text !== 'string') return false
  const head = text.trimStart()
  return DOC_MARKS.some((mark) => head.startsWith(mark))
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
 *
 * 返回结果带 `source`，标记这条路径是从哪条路线抓到的：
 *   `structured` = 工具参数里的权威字段（read/write 的 file_path 等）
 *   `quoted`     = 引号/反引号包裹的整段
 *   `regex`      = 正文里正则扫出来的（末段可能被截断，据此才能不误判"已不存在"）
 * @param {string} value - 原始字符串。
 * @returns {Array<{path: string, source: 'structured'|'quoted'|'regex'}>} 命中的路径与来源。
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
    return NOISE_PATH.test(whole) ? out : [{ path: whole, source: 'structured' }]
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
    out.push({ path: inner, source: 'quoted' })
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
      out.push({ path: hit, source: 'regex' })
    }
  }
  // 含连续两个反斜杠的候选不是有效路径（UNC 前缀 `\\server` 不以盘符开头，走不到这里）：
  // 实测真实日志里存在被二次转义过的形态，抓出来只会是垃圾。
  return out.filter((item) => !item.path.includes('\\\\'))
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
  /** 最后一条 turn/end 的形态；循环结束后若还有未闭合的 turn，改写成 open。 */
  let lastTurn = null
  let turnOpen = false
  /** 事件流里最后一次 `session/title`（用户手动改过名就是最后那条）。 */
  let title = null
  /** 旧交接单正文（链式继承时用），最多留最近 2 份。 */
  const inheritedDocs = []
  /** 用户消息里的图片 / 文件附件。 */
  const attachments = []

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
        turnOpen = true
        break
      }
      case 'turn/end': {
        turnOpen = false
        const reason = event.data?.reason !== null && typeof event.data?.reason === 'object' ? event.data.reason : {}
        const kind = typeof reason.kind === 'string' && reason.kind.length > 0 ? reason.kind : 'unknown'
        // aborted 的内层原因（user / parent / hook / disposed / legacy）比 "aborted" 本身有用得多：
        // 用户主动停下来的会话和进程崩掉的会话，接着干的方式完全不同。
        const cause = reason.kind === 'aborted' && typeof reason.reason?.kind === 'string' ? reason.reason.kind : ''
        lastTurn = {
          state: kind,
          turn: Number.isInteger(event.data?.turn) ? event.data.turn : null,
          cause,
        }
        break
      }
      case 'session/title': {
        const next = event.data?.title
        if (typeof next === 'string' && next.trim().length > 0) title = next.trim()
        break
      }
      case 'user/message': {
        // 只有 source.kind === 'user' 才是用户真的敲进来的话。
        // 其余（agent-instructions / runtime-context / skill-catalog / time-context /
        // 记忆提示 / 模型选择 / 压缩检查点）都是运行时注入，
        // 实测在某真实会话里占 42 条 user/message 中的 27 条，全是噪音。
        const sourceKind = event.data?.source?.kind
        if (sourceKind !== undefined && sourceKind !== 'user') break
        collectAttachments(event.data?.content, time, attachments)
        const text = textOfBlocks(event.data?.content).trim()
        if (text.length === 0) break
        if (isInheritDoc(text)) {
          inheritedCount += 1
          // 链式继承：A→B→C 时 B 的 Task 节本来会成为"C 的首条真人指令"，
          // 原任务只剩一句"源会话本身也是继承来的"。留原单正文供回落。
          inheritedDocs.push(text)
          if (inheritedDocs.length > 2) inheritedDocs.shift()
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
    .map(([path, record]) => ({
      path,
      hits: record.hits,
      time: record.time,
      absolute: isAbsolute(path),
      // 来源决定这条路径能不能拿去做存在性检查：regex 路线可能只抓到截断版。
      source: record.source ?? 'regex',
    }))
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
  const mentioned = files.filter((file) => !editedPaths.has(file.path) && !readPaths.has(file.path)).slice(0, LIMITS.mentionedFiles)

  return {
    firstUser: users.length > 0 ? { text: users[0].text, time: users[0].time } : null,
    // P1-6：首条消息常常是"你好，帮我看看"，直接当任务目标会让新会话读错重点。
    task: selectTaskMessage(users),
    recentUsers: users.slice(-recentUsersLimit),
    lastAssistant: assistants.length > 0 ? assistants[assistants.length - 1] : null,
    files,
    edited,
    read,
    mentioned,
    failures: dedupeFailures(failures, LIMITS.failures),
    commands: commands.slice(-LIMITS.commands),
    todos: todos.slice(0, LIMITS.todos),
    // P1-7：新会话最浪费的几步常是"不知道该先跑什么验证"。
    verifyCommand: pickVerifyCommand(commands),
    // P1-5：贴在会话里的图片/文件在交接单里原本零痕迹。
    attachments: dedupeAttachments(attachments, LIMITS.attachments),
    // P1-3：上一轮怎么结束的（含"仍在进行中"）。
    lastTurn: turnOpen ? { state: 'open', turn: currentTurn, cause: '' } : lastTurn,
    // P1-2：源会话标题，命令/工具入口用它派生新会话标题。
    title,
    // P1-4：旧交接单正文，供任务目标回落。
    inheritedDocs,
    inheritedCount,
    compactions,
    turns,
    eventCount,
    lastTime,
  }
}

/** 整条消息只是寒暄：不该被当成任务陈述。 */
const GREETING_ONLY = /^(?:你好|您好|在吗|哈喽|嗨|hi|hello|hey|good\s*(?:morning|afternoon|evening))[\s，。,.!！?？~～]*$/i

/** 指令类动词：命中就认为这句话在说"要我做什么"。 */
const INSTRUCTION_VERBS = /(?:实现|修复|添加|新增|重构|测试|部署|调查|排查|优化|改造|迁移|同步|整理|生成|分析|检查|确认|跑一下|改成|换成|写一个|写个|看一下|查一下|帮我|fix|add|implement|refactor|test|build|deploy|investigate|review|update|migrate|debug|write|create|check|analyze)/i

/** 出现路径基本可以认定这是任务陈述。 */
const TASK_PATH_HINT = /(?:[A-Za-z]:[\\/]|\/[\w.@+-]+\/[\w.@+-]+)/

/**
 * 从用户消息里挑出"任务陈述"。
 *
 * 首条用户消息常常是「你好，帮我看看」这类开场，直接当任务目标会让新会话读错重点
 * （README 里一直挂着这条已知限制）。这里在前 5 条里找第一条像任务的消息：
 *   1. 跳过纯寒暄；
 *   2. 长度 ≥ 40 字符 / 命中路径 / 命中指令动词，任一成立即采用；
 *   3. 全都不满足就退回第一条，并标 `weak` —— 交接单要如实说"这陈述可能偏弱"，
 *      而不是装作很确定。
 * @param {Array<{text: string, time: number}>} users - 用户消息（升序）。
 * @returns {{text: string, time: number, weak: boolean}|null} 选中的任务陈述。
 */
function selectTaskMessage(users) {
  if (users.length === 0) return null
  for (const item of users.slice(0, 5)) {
    const text = item.text.trim()
    if (GREETING_ONLY.test(text)) continue
    if (text.length >= 40) return { text: item.text, time: item.time, weak: false }
    if (TASK_PATH_HINT.test(text)) return { text: item.text, time: item.time, weak: false }
    if (INSTRUCTION_VERBS.test(text)) return { text: item.text, time: item.time, weak: false }
  }
  return { text: users[0].text, time: users[0].time, weak: true }
}

/** 验证类命令：新会话开工前最该先跑的那类。 */
const VERIFY_COMMAND = /(?:\btest\b|\bvitest\b|\bjest\b|\bpytest\b|npm\s+run|pnpm\s+(?:run\s+)?\w|\byarn\s+\w|\bbuild\b|\blint\b|\btsc\b|go\s+test|cargo\s+test|dotnet\s+test|\bmvn\b|\bgradle\b|-m\s+unittest)/i

/**
 * 从历史命令里挑最近一条验证类命令。
 *
 * 只收**单行、短**的命令：真实会话里大量"验证"是几行的 PowerShell 脚本
 * （先取路径、再判断、再兜底），把它压成一行既跑不了也读不懂，
 * 拿去当"建议先验证"只是噪音。`npm test` 这种单行命令才是目标。
 * @param {Array<{command: string}>} commands - 按时间升序的命令列表。
 * @returns {string|null} 命令或 null。
 */
function pickVerifyCommand(commands) {
  for (let i = commands.length - 1; i >= 0; i -= 1) {
    const item = commands[i]
    if (item === null || typeof item !== 'object') continue
    const command = typeof item.command === 'string' ? item.command.trim() : ''
    if (command.length === 0 || command.length > 200) continue
    if (command.includes('\n')) continue
    if (!VERIFY_COMMAND.test(command)) continue
    return command
  }
  return null
}

/**
 * 收集用户消息里的图片 / 文件附件。
 *
 * 真实形状（`dsh-llm/lib/types/types.d.ts`）：
 *   `{type:'image', attachment:{name?, mediaType, bytes, width, height, attachmentId}}`
 *   `{type:'file',  attachment:{name, bytes, attachmentId}}`
 * 名字在 `block.attachment.name`，**不在** `block.name`；`FileAttachmentRef` 没有
 * path、也没有 mimeType —— 按平坦字段探测会一条都抓不到。
 * @param {unknown} blocks - user/message 的 content。
 * @param {number} time - 事件时间。
 * @param {Array<object>} out - 累加器。
 */
function collectAttachments(blocks, time, out) {
  if (!Array.isArray(blocks)) return
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    const type = typeof block.type === 'string' ? block.type : ''
    if (type !== 'image' && type !== 'file') continue
    const attachment = block.attachment !== null && typeof block.attachment === 'object' ? block.attachment : block
    out.push({
      kind: type,
      name: typeof attachment.name === 'string' ? attachment.name : '',
      mediaType: typeof attachment.mediaType === 'string' ? attachment.mediaType : '',
      bytes: Number.isFinite(attachment.bytes) ? attachment.bytes : 0,
      time,
    })
  }
}

/**
 * 同名附件去重（同一张图可能被引用多次），保留最近的。
 * @param {Array<object>} list - 原始附件列表。
 * @param {number} limit - 最多保留几条。
 * @returns {Array<object>} 去重后的列表。
 */
function dedupeAttachments(list, limit) {
  const seen = new Set()
  const out = []
  for (let i = list.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const item = list[i]
    const key = `${item.kind}|${item.name}|${item.bytes}`
    if (seen.has(key)) continue
    seen.add(key)
    out.unshift(item)
  }
  return out
}

/** 旧交接单里能被机械解析的节标题（中英各一）。 */
const INHERITED_TASK_TITLES = ['## 任务目标', '## Task']
const INHERITED_NEXT_TITLES = ['## 下一步', '## Next step']

/**
 * 从一份旧交接单里取出「任务目标」与「下一步」两节。
 * @param {string} doc - 旧交接单正文。
 * @param {number} [maxChars] - 任务目标的最大长度。
 * @returns {{task: string, nextStep: string}} 解析结果（取不到就是空串）。
 */
function extractInheritedSections(doc, maxChars = LIMITS.firstUserChars) {
  const lines = String(doc ?? '').split('\n')
  /** 取某一节正文：从标题下一行到下一个 `## ` 或文末。 */
  const section = (titles) => {
    const at = lines.findIndex((line) => titles.includes(line.trim()))
    if (at < 0) return ''
    const body = []
    for (let i = at + 1; i < lines.length; i += 1) {
      if (lines[i].startsWith('## ')) break
      body.push(lines[i])
    }
    return body.join('\n').trim()
  }
  return {
    task: clip(section(INHERITED_TASK_TITLES), maxChars),
    nextStep: clip(section(INHERITED_NEXT_TITLES), 400),
  }
}

/** 路径来源的可信度排序：结构化参数 > 引号包裹 > 正则扫出。 */
const SOURCE_RANK = { structured: 3, quoted: 2, regex: 1 }

/**
 * 在一张命中表里累加一个路径。
 * @param {Map<string, {hits: number, time: number, source: string}>} hits - 命中表。
 * @param {string} path - 路径。
 * @param {number} time - 事件时间。
 * @param {'structured'|'quoted'|'regex'} [source] - 这条路径从哪条路线抓到。
 */
function bump(hits, path, time, source = 'regex') {
  const record = hits.get(path)
  if (record === undefined) {
    hits.set(path, { hits: 1, time, source })
    return
  }
  record.hits += 1
  if (time > record.time) record.time = time
  // 同一路径先被正则截断版抓到、后来又被结构化参数抓到：来源要升级，
  // 否则 markMissingFiles 会拿截断版去 existsSync，把好路径标成"已不存在"。
  if ((SOURCE_RANK[source] ?? 0) > (SOURCE_RANK[record.source] ?? 0)) record.source = source
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
      if (WRITE_TOOLS.has(name)) bump(acc.editedHits, structured, time, 'structured')
      else if (READ_TOOLS.has(name)) bump(acc.readHits, structured, time, 'structured')
    }
  }

  const strings = args === undefined ? [raw] : walkStrings(args)
  for (const value of strings) {
    for (const hit of matchPaths(value)) bump(acc.fileHits, hit.path, time, hit.source)
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
 * @param {{callNames: Map<string, string>, failures: Array<{tool: string, code: string, text: string, turn: number|null}>}} acc - 累加器。
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
    // 带轮次：5 条失败可能横跨好几轮，不标轮次的话新会话分不清哪些是陈年旧账。
    turn: Number.isInteger(data.turn) ? data.turn : null,
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
 * 交接单文案。
 *
 * 交接单是**注入到新会话里的正文**，语言要跟随用户，而不是跟插件 UI 走：
 * 英文界面下生成一份中文交接单，新会话的模型和用户读到的都是外语。
 */
const TEXTS = {
  zh: {
    mark: DOC_MARK,
    sourceLine: (id, titleSuffix, turns, time) => `> 来源：\`${id}\`${titleSuffix} · 共 ${turns} 轮 · 最后活动 ${time}`,
    rules: [
      '> **执行规则**：不要复述本单，不要总结本单，不要回应"收到/了解了"。读完直接做「下一步」。',
      '> 第一步只做一个具体动作（读某个文件 / 跑某条命令），做完停下汇报；不要同时铺开多个方向。',
    ],
    noteInherited: (n) => `> 注意：源会话本身也是继承来的（含 ${n} 份更早交接单），细节以源会话日志为准。`,
    noteCompacted: (n) => `> 注意：源会话做过 ${n} 次上下文压缩，更早的原文可能已不在日志里。`,
    titleTask: '任务目标',
    titleEdited: '改过的文件（源会话实际写入/修改过，按最近改动排序）',
    titleFailures: '最近失败（源会话最后几次工具报错，先确认是否已解决）',
    titleRecentUsers: '最近的用户指令（由旧到新）',
    titleRead: '读过的文件（只读取过，未修改）',
    titleMentioned: '文中提到的路径（从工具参数正文里扫出来的，可能是噪音）',
    titleRelative: '项目内相对引用（基准目录未确定，需要时用文件搜索确认）',
    titleCommands: '最近执行的命令',
    titleTodos: '待办（源会话最后一次 todo 状态）',
    titleLastAssistant: '源会话最后一次回复',
    titleVerify: '建议先验证（源会话最近一条验证类命令）',
    titleAttachments: '附件（源会话中，未复制）',
    titleNext: '下一步',
    noUserMessage: '_（源会话没有用户消息）_',
    noNextStep: '_（未指定：先问我一句要做什么，不要自行展开）_',
    taskWeak: '> 首条消息像是短开场，任务陈述可能偏弱；不确定就先向用户确认。',
    inheritedChain: (n) => `> 继承链：这是第 ${n} 次继承；任务目标取自上一份交接单。`,
    lastTurnLine: (state, turn, cause) => {
      const at = Number.isInteger(turn) && turn > 0 ? `第 ${turn} 轮 ` : ''
      switch (state) {
        case 'open': return `> 最后状态：${at}仍在进行中（源会话未结束，日志可能停在 turn 中途）`
        case 'completed': return `> 最后状态：${at}正常结束`
        case 'aborted': {
          const why = cause === 'user' ? '用户主动中断'
            : cause === 'disposed' ? '进程退出'
              : cause === 'hook' ? '被插件钩子阻断'
                : cause === 'parent' ? '父会话中断'
                  : '被中断'
          return `> 最后状态：${at}${why}`
        }
        case 'blocked': return `> 最后状态：${at}被阻断（blocked）`
        case 'max-tokens': return `> 最后状态：${at}触顶（max-tokens）`
        case 'error': return `> 最后状态：${at}出错，先确认当前状态`
        case 'interrupted': return `> 最后状态：${at}被中断（日志补写）`
        case 'forked': return `> 最后状态：${at}已分叉`
        default: return `> 最后状态：${at}未知`
      }
    },
    attachmentLine: (item) => {
      const meta = [item.mediaType, item.bytes > 0 ? `${Math.round(item.bytes / 1024)} KB` : ''].filter((part) => part.length > 0).join(', ')
      const name = item.name.length > 0 ? item.name : (item.kind === 'image' ? '（未命名图片）' : '（未命名文件）')
      return `- ${item.kind === 'image' ? '图片' : '文件'}：${name}${meta.length > 0 ? `（${meta}）` : ''}`
    },
    missingMark: ' **（已不存在）**',
    hitSuffix: (n) => `（${n} 次）`,
    toolFallback: '工具',
    sep: '：',
    footer: '> 由 dsh-session-inherit 生成（机械提取，未调用模型）。源会话未被改动，需要细节时回去查。',
    truncated: '…（交接单过长，尾部已截断）',
    cwdLabel: '工作目录：',
    modelLabel: ' · 模型：',
    presetLabel: ' · 预设：',
    presetInherited: ' → 新会话已继承该预设',
    presetSkipped: ' → 本次未继承，新会话用默认预设',
    presetFailed: ' → 挂载失败，新会话仍是默认预设',
    timeUnknown: '未知',
    titleSuffix: (title) => `（${title}）`,
  },
  en: {
    mark: DOC_MARK_EN,
    sourceLine: (id, titleSuffix, turns, time) => `> Source: \`${id}\`${titleSuffix} · ${turns} turns · last activity ${time}`,
    rules: [
      '> **Rules**: do not restate this document, do not summarize it, do not reply "got it / understood". Read it and go straight to the "next step".',
      '> Take exactly one concrete action first (read one file / run one command), then stop and report; do not branch out in several directions at once.',
    ],
    noteInherited: (n) => `> Note: the source session was itself inherited (it holds ${n} earlier handoff(s)); check its log for details.`,
    noteCompacted: (n) => `> Note: the source session was compacted ${n} time(s); earlier original text may no longer be in its log.`,
    titleTask: 'Task',
    titleEdited: 'Files edited (written/modified by the source session, most recent first)',
    titleFailures: 'Recent failures (last tool errors in the source session — check whether they are already resolved)',
    titleRecentUsers: 'Recent user instructions (oldest first)',
    titleRead: 'Files read (read-only, never modified)',
    titleMentioned: 'Paths mentioned in text (scraped from tool-argument bodies; may be noise)',
    titleRelative: 'In-project relative references (base directory undetermined; confirm with a file search)',
    titleCommands: 'Recent commands',
    titleTodos: 'Todos (last todo state in the source session)',
    titleLastAssistant: "Source session's last reply",
    titleVerify: 'Run this first (the source session\'s most recent verification command)',
    titleAttachments: 'Attachments (present in the source session, not copied)',
    titleNext: 'Next step',
    noUserMessage: '_(the source session has no user message)_',
    noNextStep: '_(unspecified — ask me what to do first, do not start on your own)_',
    taskWeak: '> The first message looks like a short opener; the task statement may be weak — confirm with the user if unsure.',
    inheritedChain: (n) => `> Inheritance chain: this is handoff #${n}; the task statement is taken from the previous handoff.`,
    lastTurnLine: (state, turn, cause) => {
      const at = Number.isInteger(turn) && turn > 0 ? `turn ${turn} ` : ''
      switch (state) {
        case 'open': return `> Last state: ${at}still running (the source session has not stopped; its log may end mid-turn)`
        case 'completed': return `> Last state: ${at}completed normally`
        case 'aborted': {
          const why = cause === 'user' ? 'interrupted by the user'
            : cause === 'disposed' ? 'the process exited'
              : cause === 'hook' ? 'blocked by a plugin hook'
                : cause === 'parent' ? 'the parent session was interrupted'
                  : 'interrupted'
          return `> Last state: ${at}${why}`
        }
        case 'blocked': return `> Last state: ${at}blocked`
        case 'max-tokens': return `> Last state: ${at}hit max-tokens`
        case 'error': return `> Last state: ${at}failed with an error — verify the current state first`
        case 'interrupted': return `> Last state: ${at}interrupted (synthesized by the log reader)`
        case 'forked': return `> Last state: ${at}forked`
        default: return `> Last state: ${at}unknown`
      }
    },
    attachmentLine: (item) => {
      const meta = [item.mediaType, item.bytes > 0 ? `${Math.round(item.bytes / 1024)} KB` : ''].filter((part) => part.length > 0).join(', ')
      const name = item.name.length > 0 ? item.name : (item.kind === 'image' ? '(unnamed image)' : '(unnamed file)')
      return `- ${item.kind}: ${name}${meta.length > 0 ? ` (${meta})` : ''}`
    },
    missingMark: ' **(no longer exists)**',
    hitSuffix: (n) => ` (${n}x)`,
    toolFallback: 'tool',
    sep: ': ',
    footer: '> Generated by dsh-session-inherit (mechanical extraction, no model call). The source session was not modified; go back to it for details.',
    truncated: '…(handoff too long, tail truncated)',
    cwdLabel: 'Working directory: ',
    modelLabel: ' · Model: ',
    presetLabel: ' · Preset: ',
    presetInherited: ' → inherited by the new session',
    presetSkipped: ' → not inherited this time; the new session uses the default preset',
    presetFailed: ' → mount failed; the new session keeps the default preset',
    timeUnknown: 'unknown',
    titleSuffix: (title) => ` (${title})`,
  },
}

/**
 * 语言归一化：只认 zh / en，其余一律回落 zh（保持既有行为）。
 * @param {unknown} lang - 语言标签，如 `en` / `zh-CN`。
 * @returns {'zh'|'en'} 归一化后的语言。
 */
export function resolveLang(lang) {
  return String(lang ?? '').toLowerCase().split('-')[0] === 'en' ? 'en' : 'zh'
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
  const L = TEXTS[resolveLang(extra.lang)]
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
  const fileLine = (file) => `- \`${file.path}\`${file.hits > 1 ? L.hitSuffix(file.hits) : ''}${file.missing === true ? L.missingMark : ''}`

  const titleSuffix = typeof source.title === 'string' && source.title.trim().length > 0
    ? L.titleSuffix(source.title.trim())
    : ''

  head.push(L.mark)
  head.push('')
  head.push(L.sourceLine(source.sessionId, titleSuffix, anchors.turns, formatTime(anchors.lastTime) || L.timeUnknown))
  head.push(...L.rules)
  if (anchors.inheritedCount > 0) head.push(L.noteInherited(anchors.inheritedCount))
  if (Number.isInteger(anchors.compactions) && anchors.compactions > 0) head.push(L.noteCompacted(anchors.compactions))
  // P1-3：上一轮怎么结束的。live 源会话读出来是 open（日志停在 turn 中途），
  // 这一行能挡掉"新会话以为活还在继续、结果白跑一遍"。
  const lastTurn = anchors.lastTurn !== null && typeof anchors.lastTurn === 'object' ? anchors.lastTurn : null
  if (lastTurn !== null && typeof lastTurn.state === 'string' && lastTurn.state !== 'completed') {
    head.push(L.lastTurnLine(lastTurn.state, lastTurn.turn, lastTurn.cause ?? ''))
  }

  // P1-6 / P1-4：任务目标。链式继承时以上一份交接单的任务为主、本会话首条指令作补充；
  // 首条若是寒暄，selectTaskMessage 已跳过它，并返回 weak 标记。
  const task = anchors.task !== null && typeof anchors.task === 'object' && typeof anchors.task.text === 'string'
    ? anchors.task
    : (anchors.firstUser === null || anchors.firstUser === undefined
        ? null
        : { text: anchors.firstUser.text, weak: false })
  const inheritedDocs = Array.isArray(anchors.inheritedDocs) ? anchors.inheritedDocs : []
  const previous = inheritedDocs.length > 0 ? extractInheritedSections(inheritedDocs[inheritedDocs.length - 1]) : null
  const taskLines = []
  // 旧单里的任务太短（比如只有"要"）就没有回落的必要，直接用本会话的。
  if (previous !== null && previous.task.length >= 10) {
    taskLines.push(L.inheritedChain(anchors.inheritedCount))
    taskLines.push('')
    taskLines.push(previous.task)
    if (task !== null && task.text.trim().length > 0) {
      taskLines.push('', '---', '')
      taskLines.push(clip(task.text, LIMITS.firstUserChars))
    }
  } else if (task !== null) {
    taskLines.push(clip(task.text, LIMITS.firstUserChars))
  } else {
    taskLines.push(L.noUserMessage)
  }
  if (task !== null && task.weak === true) taskLines.push('', L.taskWeak)
  add('task', L.titleTask, taskLines)

  if (anchors.edited.length > 0) {
    add('editedFiles', L.titleEdited, anchors.edited.map(fileLine))
  }

  // P1-5：附件只写名字与元信息，不复制内容（贴图可能几 MB，交接单是首条消息）。
  const attachments = Array.isArray(anchors.attachments) ? anchors.attachments : []
  if (attachments.length > 0) {
    add('attachments', L.titleAttachments, attachments.map((item) => L.attachmentLine(item)))
  }

  if (anchors.failures.length > 0) {
    add('failures', L.titleFailures, anchors.failures.map((failure) => {
      const label = failure.tool.length > 0 ? `\`${failure.tool}\`` : L.toolFallback
      const code = failure.code.length > 0 ? ` ${failure.code}` : ''
      // 轮次是判断时效性的唯一线索：同一节里的失败可能横跨好几轮。
      const turn = Number.isInteger(failure.turn) ? `(t${failure.turn}) ` : ''
      return `- ${turn}${label}${code}${L.sep}${oneLine(failure.text, LIMITS.failureChars)}`
    }))
  }

  // P1-7：新会话最浪费的几步常是"不知道现状还成不成立、该先跑什么验证"。
  if (typeof anchors.verifyCommand === 'string' && anchors.verifyCommand.length > 0) {
    add('verify', L.titleVerify, [`- \`${oneLine(anchors.verifyCommand, 200)}\``])
  }

  if (anchors.recentUsers.length > 0) {
    add('recentUsers', L.titleRecentUsers, anchors.recentUsers.map((item) => `- (t${item.turn}) ${oneLine(item.text, LIMITS.recentUserChars)}`))
  }

  const readAbsolute = anchors.read.filter((file) => file.absolute !== false)
  const readRelative = anchors.read.filter((file) => file.absolute === false)
  const mentionedAbsolute = anchors.mentioned.filter((file) => file.absolute !== false)
  const mentionedRelative = anchors.mentioned.filter((file) => file.absolute === false)

  add('readFiles', L.titleRead, readAbsolute.map(fileLine))
  add('mentioned', L.titleMentioned, mentionedAbsolute.map(fileLine))
  add('relativeRefs', L.titleRelative, [...readRelative, ...mentionedRelative].slice(0, LIMITS.relativeRefs).map(fileLine))

  // verify 已经单独成节，commands 里不必再重复一遍。
  const verifyCommand = typeof anchors.verifyCommand === 'string' ? anchors.verifyCommand : ''
  const shownCommands = anchors.commands.filter((item) => item.command.trim() !== verifyCommand)
  if (shownCommands.length > 0) {
    add('commands', L.titleCommands, shownCommands.map((item) => `- \`${oneLine(item.command, LIMITS.commandChars)}\``))
  }

  if (anchors.todos.length > 0) {
    add('todos', L.titleTodos, anchors.todos.map((todo) => `- ${todo.status === 'completed' ? '[x]' : '[ ]'} ${oneLine(todo.content, 200)}`))
  }

  if (anchors.lastAssistant !== null) {
    add('lastAssistant', L.titleLastAssistant, [clip(anchors.lastAssistant.text, LIMITS.assistantChars)])
  }

  const nextStep = typeof extra.nextStep === 'string' ? extra.nextStep.trim() : ''
  add('nextStep', L.titleNext, [nextStep.length > 0 ? nextStep : L.noNextStep])

  tail.push('')
  if (typeof source.cwd === 'string' && source.cwd.length > 0) {
    tail.push('---')
    // 只写一个「预设」字段，值取**当前真正生效**的那个：这类预设不改会话
    // header 的 agentPreset（那里永远是 standard），真正的人格绑定记在宿主的
    // `.agent-presets\session-bindings.json` 里。以前两个都写出来（`预设：standard ·
    // 预设：preset-x`），新会话读着自相矛盾；现在有绑定就写绑定值。
    const effectivePreset = typeof source.boundPreset === 'string' && source.boundPreset.length > 0
      ? source.boundPreset
      : source.agentPreset
    tail.push([
      `${L.cwdLabel}\`${source.cwd}\``,
      source.model ? `${L.modelLabel}${source.model}` : '',
      effectivePreset ? `${L.presetLabel}${effectivePreset}` : '',
    ].filter((part) => part.length > 0).join(''))
  }
  tail.push(L.footer)

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
    // 按实际文案长度留位置：中英文案长度不同，写死常数会越界。
    doc = `${doc.slice(0, LIMITS.docChars - L.truncated.length - 1)}\n${L.truncated}`
  }
  return doc
}

/**
 * 「下一步」一节在两种语言下的标题。客户端填的 nextStep 要被写回交接单，
 * 就得先按用户的语言找到那一节。
 */
const NEXT_STEP_TITLES = ['## 下一步', '## Next step']

/**
 * 把交接单里「下一步」一节的内容换成用户新填的文本。
 *
 * 客户端把「下一步」抽成了独立输入框，但它同时仍会回传整份交接单（用户可能展开
 * 编辑过）。宿主收到的如果是"编辑过的 doc + 另外填写的 nextStep"，就必须把后者
 * 写进前者——否则那个输入框等于白填，而这是最容易漏的一环（`nextStep` 原本只在
 * 客户端不传 doc 时才生效，而客户端从来都是传的）。
 *
 * @param {string} doc - 交接单正文。
 * @param {string} nextStep - 用户填写的下一步（空则原样返回）。
 * @returns {string} 替换后的正文。
 */
export function replaceNextStepSection(doc, nextStep) {
  const text = String(doc ?? '')
  const value = String(nextStep ?? '').trim()
  if (value.length === 0) return text
  const lines = text.split('\n')
  const at = lines.findIndex((line) => NEXT_STEP_TITLES.includes(line.trim()))
  if (at < 0) return `${text.trimEnd()}\n\n${NEXT_STEP_TITLES[0]}\n${value}\n`
  let end = lines.length
  for (let i = at + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ')) {
      end = i
      break
    }
  }
  return [...lines.slice(0, at + 1), value, '', ...lines.slice(end)].join('\n')
}

/** 页脚里「预设」那一行的标记（中英各一份，用于定位）。 */
const PRESET_LINE_LABELS = [' · 预设：', ' · Preset: ']

/**
 * 在页脚的「预设」行尾补一句**事实**：新会话到底有没有继承这个预设。
 *
 * 为什么不在 `composeInheritDoc` 里直接写死：preview 发生在用户勾选之前（菜单一点就
 * 请求），那时还不知道这次会不会继承；只有 commit 拿到挂载结果后才谈得上"如实"。
 * 所以由 commit 侧回填，且幂等（同一份 doc 重复调用不会叠加）。
 *
 * 没有任何「预设」行时原样返回——源会话本来就没绑定，不该凭空多一句话。
 * @param {string} doc - 交接单正文。
 * @param {{lang?: string, inheritPreset?: boolean, mounted?: boolean}} plan - 实际结果。
 * @returns {string} 标注后的正文。
 */
export function annotatePresetLine(doc, plan = {}) {
  const text = String(doc ?? '')
  const label = PRESET_LINE_LABELS.find((candidate) => text.includes(candidate))
  if (label === undefined) return text
  const L = TEXTS[resolveLang(plan.lang)]
  const note = plan.inheritPreset === false
    ? L.presetSkipped
    : plan.mounted === true
      ? L.presetInherited
      : L.presetFailed
  const lines = text.split('\n')
  const at = lines.findIndex((line) => line.includes(label))
  if (at < 0 || lines[at].includes(note)) return text
  lines[at] = `${lines[at]}${note}`
  return lines.join('\n')
}
