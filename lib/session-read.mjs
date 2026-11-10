// session_read 工具的三种视角：summary / tail / search。
//
// 「继承」把源会话的编号写进了交接单（首行「来源」），但新会话拿到编号后**读不了**：
// 会话日志是 `%DSH_HOME%\sessions\<工作区转义>\session-<id>\session.vN.jsonl.zstd`，
// 多帧 zstd 拼接（实测 2.7MB 文件切成 1067 帧，Node 的 zstdDecompressSync 只解第一帧），
// 让它自己写解压脚本不是该走的路。下面这组函数把 sessionQuery 包成三种视角。
import { clip, collectAnchors, formatTime, textOfBlocks } from './extract.mjs'

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
 * @returns {string} 摘要文本。
 */
export function renderSessionSummary(sessionId, header, events) {
  const anchors = collectAnchors(events, { recentUsers: 6 })
  const title = typeof header.title === 'string' && header.title.trim().length > 0 ? `（${header.title.trim()}）` : ''
  const lines = [
    `会话 ${sessionId}${title}`,
    `共 ${anchors.turns} 轮 · ${anchors.eventCount} 个事件 · 最后活动 ${formatTime(anchors.lastTime) || '未知'}`,
    `工作目录：${typeof header.cwd === 'string' ? header.cwd : '(未知)'}${typeof header.agentPreset === 'string' ? ` · 预设：${header.agentPreset}` : ''}`,
    '',
  ]
  if (anchors.firstUser !== null) lines.push('## 任务目标', clip(anchors.firstUser.text, 800), '')
  if (anchors.edited.length > 0) lines.push('## 改过的文件', ...anchors.edited.map((file) => `- ${file.path}`), '')
  if (anchors.failures.length > 0) {
    lines.push('## 最近失败', ...anchors.failures.map((f) => `- (t${f.turn ?? '?'}) ${f.code || f.tool}：${clip(f.text, 200)}`), '')
  }
  if (anchors.recentUsers.length > 0) {
    lines.push('## 最近的用户指令', ...anchors.recentUsers.map((u) => `- (t${u.turn}) ${clip(u.text, 200)}`), '')
  }
  if (anchors.todos.length > 0) {
    lines.push('## 待办', ...anchors.todos.map((t) => `- [${t.status === 'completed' ? 'x' : ' '}] ${clip(t.content, 150)}`), '')
  }
  if (anchors.lastAssistant !== null) lines.push('## 最后一次回复', clip(anchors.lastAssistant.text, 800), '')
  lines.push('> 要细节就用 mode=search + query；要看最后发生了什么就用 mode=tail。')
  return lines.join('\n')
}

/**
 * 最后 N 个有内容的事件。
 * @param {string} sessionId - 会话 id。
 * @param {object} header - 会话 header（未使用，保持签名一致）。
 * @param {object[]} events - 事件。
 * @param {number} limit - 条数。
 * @returns {string} 文本。
 */
export function renderSessionTail(sessionId, header, events, limit) {
  const tail = events.slice(-limit)
  const lines = [`会话 ${sessionId} 的最后 ${tail.length} 个事件（该会话共 ${events.length} 个）：`, '']
  for (const event of tail) {
    const text = eventText(event).replace(/\s+/g, ' ').trim()
    if (text.length === 0) continue
    lines.push(`[${event.seq ?? '?'}] ${event.type}：${clip(text, 220)}`)
  }
  return lines.join('\n')
}

/**
 * 按关键词搜事件，返回命中处前后的上下文。
 * @param {string} sessionId - 会话 id。
 * @param {object} header - 会话 header（未使用，保持签名一致）。
 * @param {object[]} events - 事件。
 * @param {string} query - 关键词（不区分大小写）。
 * @param {number} limit - 最多返回几条。
 * @returns {string} 文本。
 */
export function renderSessionSearch(sessionId, header, events, query, limit) {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return '读取失败：mode=search 需要同时给 query。'
  const hits = []
  for (const event of events) {
    const text = eventText(event)
    if (text.length === 0) continue
    const at = text.toLowerCase().indexOf(needle)
    if (at < 0) continue
    const from = Math.max(0, at - 150)
    const snippet = clip(text.slice(from, at + needle.length + 250).replace(/\s+/g, ' ').trim(), 400)
    hits.push(`[${event.seq ?? '?'}] ${event.type}：…${snippet}…`)
    if (hits.length >= limit) break
  }
  if (hits.length === 0) {
    return `会话 ${sessionId} 里搜「${query}」：没找到。\n换关键词再试，或用 mode=tail 看最后发生了什么。`
  }
  return [
    `会话 ${sessionId} 里搜「${query}」：命中 ${hits.length}${hits.length >= limit ? '+' : ''} 条`,
    '',
    ...hits,
    '',
    `> 只显示前 ${limit} 条，需要更多就把 limit 调大（最大 100）。`,
  ].join('\n')
}
