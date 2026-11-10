// session_read 工具的视角：summary / tail / timeline / search。
//
// 「继承」把源会话的编号写进了交接单（首行「来源」），但新会话拿到编号后**读不了**：
// 会话日志是 `%DSH_HOME%\sessions\<工作区转义>\session-<id>\session.vN.jsonl.zstd`，
// 多帧 zstd 拼接（实测 2.7MB 文件切成 1067 帧，Node 的 zstdDecompressSync 只解第一帧），
// 让它自己写解压脚本不是该走的路。下面这组函数把 sessionQuery 包成几个视角。
import { clip, collectAnchors, formatTime, resolveLang, textOfBlocks } from './extract.mjs'

/**
 * 文案。工具返回文本也是给人读的，语言要跟调用方一致——以前这里全是硬编码
 * 中文，英文界面下模型拿到的工具结果是中文，它就顺着用中文回话。
 */
const TEXTS = {
  zh: {
    sessionLine: (id, title) => `会话 ${id}${title}`,
    statsLine: (turns, events, time) => `共 ${turns} 轮 · ${events} 个事件 · 最后活动 ${time}`,
    unknown: '未知',
    cwdLine: (cwd, preset) => `工作目录：${cwd}${preset}`,
    presetSuffix: (preset) => ` · 预设：${preset}`,
    task: '## 任务目标',
    edited: '## 改过的文件',
    failures: '## 最近失败',
    recentUsers: '## 最近的用户指令',
    todos: '## 待办',
    lastReply: '## 最后一次回复',
    summaryHint: '> 要细节就用 mode=search + query；要看最后发生了什么就用 mode=tail。',
    tailHeader: (id, shown, total) => `会话 ${id} 的最后 ${shown} 个事件（该会话共 ${total} 个）：`,
    eventLine: (seq, type, text) => `[${seq}] ${type}：${text}`,
    timelineHeader: (id, total) => `会话 ${id} 的时间线（共 ${total} 条事件，只列有人类可读内容的）：`,
    timelineEmpty: '（没有可读内容）',
    searchNeedsQuery: '读取失败：mode=search 需要同时给 query。',
    searchEmpty: (id, query) => `会话 ${id} 里搜「${query}」：没找到。\n换关键词再试，或用 mode=tail 看最后发生了什么。`,
    searchHeader: (id, query, count, more) => `会话 ${id} 里搜「${query}」：命中 ${count}${more} 条`,
    searchHint: (limit) => `> 只显示前 ${limit} 条，需要更多就把 limit 调大（最大 100）。`,
    pageHint: (from, shown, total) => `> 这是第 ${from}–${from + shown - 1} 条（共 ${total} 条）；看更早的用 offset，看更近的用 tail。`,
  },
  en: {
    sessionLine: (id, title) => `Session ${id}${title}`,
    statsLine: (turns, events, time) => `${turns} turns · ${events} events · last activity ${time}`,
    unknown: 'unknown',
    cwdLine: (cwd, preset) => `Working directory: ${cwd}${preset}`,
    presetSuffix: (preset) => ` · preset: ${preset}`,
    task: '## Task',
    edited: '## Files edited',
    failures: '## Recent failures',
    recentUsers: '## Recent user instructions',
    todos: '## Todos',
    lastReply: '## Last reply',
    summaryHint: '> For details use mode=search + query; for what happened last use mode=tail.',
    tailHeader: (id, shown, total) => `Last ${shown} events of session ${id} (${total} in total):`,
    eventLine: (seq, type, text) => `[${seq}] ${type}: ${text}`,
    timelineHeader: (id, total) => `Timeline of session ${id} (${total} events with readable content):`,
    timelineEmpty: '(no readable content)',
    searchNeedsQuery: 'Failed: mode=search requires a query.',
    searchEmpty: (id, query) => `Search "${query}" in session ${id}: no match.\nTry another keyword, or use mode=tail to see what happened last.`,
    searchHeader: (id, query, count, more) => `Search "${query}" in session ${id}: ${count}${more} matches`,
    searchHint: (limit) => `> Showing the first ${limit}; raise limit for more (max 100).`,
    pageHint: (from, shown, total) => `> Lines ${from}-${from + shown - 1} of ${total}; use offset for earlier and tail for later.`,
  },
}

/**
 * 取当前语言的文案。
 * @param {string} [lang] - 语言标签。
 * @returns {object} 文案表。
 */
function texts(lang) {
  return TEXTS[resolveLang(lang)]
}

/**
 * 把一条事件压成一行可搜文本（只取有人类可读内容的事件类型）。
 * @param {object} event - 会话事件。
 * @returns {string} 文本（无内容则空串）。
 */
export function eventText(event) {
  if (event === null || typeof event !== 'object') return ''
  switch (event.type) {
    case 'user/message':
      return textOfBlocks(event.data?.content)
    case 'assistant/message':
      return textOfBlocks(event.data?.message?.content)
    case 'tool/call':
      return `${event.data?.name ?? 'tool'} ${String(event.data?.arguments ?? '')}`
    case 'tool/result':
      return textOfBlocks(event.data?.message?.content)
    default:
      return ''
  }
}

/**
 * 结构化摘要（复用交接单同一套锚点提取，但更短）。
 * @param {string} sessionId - 会话 id。
 * @param {object} header - 会话 header。
 * @param {object[]} events - 事件。
 * @param {string} [lang] - 语言。
 * @returns {string} 摘要文本。
 */
export function renderSessionSummary(sessionId, header, events, lang) {
  const t = texts(lang)
  const anchors = collectAnchors(events, { recentUsers: 6 })
  const title = typeof header.title === 'string' && header.title.trim().length > 0 ? ` (${header.title.trim()})` : ''
  const lines = [
    t.sessionLine(sessionId, title),
    t.statsLine(anchors.turns, anchors.eventCount, formatTime(anchors.lastTime) || t.unknown),
    t.cwdLine(
      typeof header.cwd === 'string' ? header.cwd : '(?)',
      typeof header.agentPreset === 'string' ? t.presetSuffix(header.agentPreset) : '',
    ),
    '',
  ]
  // 与交接单保持一致：优先用 selectTaskMessage 的结果，而不是字面上的第一条。
  const task = anchors.task
  if (task !== null && typeof task === 'object') lines.push(t.task, clip(task.text, 800), '')
  if (anchors.edited.length > 0) lines.push(t.edited, ...anchors.edited.map((file) => `- ${file.path}`), '')
  if (anchors.failures.length > 0) {
    lines.push(t.failures, ...anchors.failures.map((f) => `- (t${f.turn ?? '?'}) ${f.code || f.tool}: ${clip(f.text, 200)}`), '')
  }
  if (anchors.recentUsers.length > 0) {
    lines.push(t.recentUsers, ...anchors.recentUsers.map((u) => `- (t${u.turn}) ${clip(u.text, 200)}`), '')
  }
  if (anchors.todos.length > 0) {
    lines.push(t.todos, ...anchors.todos.map((item) => `- [${item.status === 'completed' ? 'x' : ' '}] ${clip(item.content, 150)}`), '')
  }
  if (anchors.lastAssistant !== null) lines.push(t.lastReply, clip(anchors.lastAssistant.text, 800), '')
  lines.push(t.summaryHint)
  return lines.join('\n')
}

/**
 * 最后 N 个有内容的事件。
 * @param {string} sessionId - 会话 id。
 * @param {object} header - 会话 header（保持签名一致）。
 * @param {object[]} events - 事件。
 * @param {number} limit - 条数。
 * @param {string} [lang] - 语言。
 * @returns {string} 文本。
 */
export function renderSessionTail(sessionId, header, events, limit, lang) {
  const t = texts(lang)
  const tail = events.slice(-limit)
  const lines = [t.tailHeader(sessionId, tail.length, events.length), '']
  for (const event of tail) {
    const text = eventText(event).replace(/\s+/g, ' ').trim()
    if (text.length === 0) continue
    lines.push(t.eventLine(event.seq ?? '?', event.type, clip(text, 220)))
  }
  return lines.join('\n')
}

/**
 * 时间线：按 seq 顺序列所有"有人类可读内容"的事件。
 *
 * 与 tail 的区别是它会从头部开始、支持 offset 分页——长会话里 `tail` 只能看到
 * 末尾，想从头看就得翻 offset。
 * @param {string} sessionId - 会话 id。
 * @param {object} header - 会话 header（保持签名一致）。
 * @param {object[]} events - 事件。
 * @param {{limit?: number, offset?: number}} [options] - 分页。
 * @param {string} [lang] - 语言。
 * @returns {string} 文本。
 */
export function renderSessionTimeline(sessionId, header, events, options = {}, lang) {
  const t = texts(lang)
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 200) : 60
  const offset = Number.isInteger(options.offset) && options.offset > 0 ? options.offset : 0
  const readable = []
  for (const event of events) {
    const text = eventText(event).replace(/\s+/g, ' ').trim()
    if (text.length === 0) continue
    readable.push({ seq: event.seq ?? '?', type: event.type, text })
  }
  const page = readable.slice(offset, offset + limit)
  if (page.length === 0) return t.timelineEmpty
  const lines = [t.timelineHeader(sessionId, readable.length), '']
  for (const item of page) lines.push(t.eventLine(item.seq, item.type, clip(item.text, 220)))
  lines.push('', t.pageHint(offset + 1, page.length, readable.length))
  return lines.join('\n')
}

/**
 * 按关键词搜事件，返回命中处前后的上下文。
 * @param {string} sessionId - 会话 id。
 * @param {object} header - 会话 header（保持签名一致）。
 * @param {object[]} events - 事件。
 * @param {string} query - 关键词（不区分大小写）。
 * @param {number} limit - 最多返回几条。
 * @param {string} [lang] - 语言。
 * @returns {string} 文本。
 */
export function renderSessionSearch(sessionId, header, events, query, limit, lang) {
  const t = texts(lang)
  const needle = String(query ?? '').trim().toLowerCase()
  if (needle.length === 0) return t.searchNeedsQuery
  const hits = []
  for (const event of events) {
    const text = eventText(event)
    if (text.length === 0) continue
    const at = text.toLowerCase().indexOf(needle)
    if (at < 0) continue
    const from = Math.max(0, at - 150)
    const snippet = clip(text.slice(from, at + needle.length + 250).replace(/\s+/g, ' ').trim(), 400)
    hits.push(t.eventLine(event.seq ?? '?', event.type, `…${snippet}…`))
    if (hits.length >= limit) break
  }
  if (hits.length === 0) return t.searchEmpty(sessionId, query)
  return [
    t.searchHeader(sessionId, query, hits.length, hits.length >= limit ? '+' : ''),
    '',
    ...hits,
    '',
    t.searchHint(limit),
  ].join('\n')
}
