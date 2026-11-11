// 会话分叉检测。
//
// DSH 没有 parentSession 链（创建会话时去掉父链是刻意的，见 lib/session.mjs），
// 所以"这个会话是从哪条线分出来的"只能靠事件前缀判断：分叉出来的会话，开头
// 若干条事件的 `time + type + data` 会一字不差地相同。
//
// 成本控制：只看**同一工作区**里的会话，且每个会话只解压到够 40 条事件为止。
// 实测 10.3MB / 5566 帧的会话，前 15 帧约 5KB —— 扫 30 个会话也才几百 KB。
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { dshHome } from './contracts.mjs'

/** zstd 帧魔数（小端）。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
/** 前缀比对默认取多少条事件。 */
export const PREFIX_EVENTS = 40
/** 一次最多扫多少个候选会话。 */
export const MAX_CANDIDATES = 15
/**
 * 每个会话最多读多少字节。
 *
 * 必须只读开头：`readFileSync` 会把 10MB 的会话整个读进内存，而 40 条事件实测
 * 只占约 15 帧 / 5KB。按 30 个候选算，全读是 300MB，读 256KB 是 7.5MB——
 * 实测把一次分叉检测从 1.1 秒压到几十毫秒。
 */
const PREFIX_BYTES = 64 * 1024

/**
 * 找到某个会话文件（同目录可能有多个版本，取最高版本）。
 * @param {string} dir - 会话目录。
 * @returns {string|null} 文件路径。
 */
function sessionFileOf(dir) {
  let best = null
  let bestVersion = -1
  try {
    for (const name of readdirSync(dir)) {
      const match = name.match(/^session\.v(\d+)\.jsonl(\.zstd)?$/)
      if (match === null) continue
      const version = Number(match[1])
      if (version > bestVersion) {
        bestVersion = version
        best = join(dir, name)
      }
    }
  } catch {
    return null
  }
  return best
}

/**
 * 读会话文件的前若干条事件。
 *
 * 两种存储形态都要认：明文 jsonl 与多帧 zstd（一帧一行事件流）。多帧只能用魔数
 * 切分——`zstdDecompressSync` 对拼接帧只解第一帧。
 * @param {string} file - 会话文件。
 * @param {number} maxEvents - 最多取几条。
 * @returns {object[]} 事件。
 */
export function readSessionPrefix(file, maxEvents = PREFIX_EVENTS) {
  let buf
  try {
    // 只读开头一段，不把整个会话读进内存。
    const fd = openSync(file, 'r')
    try {
      const chunk = Buffer.alloc(PREFIX_BYTES)
      const bytes = readSync(fd, chunk, 0, PREFIX_BYTES, 0)
      buf = chunk.subarray(0, bytes)
    } finally {
      closeSync(fd)
    }
  } catch {
    return []
  }
  const events = []
  const pushLines = (text) => {
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue
      try {
        const parsed = JSON.parse(line)
        if (parsed !== null && typeof parsed === 'object' && typeof parsed.type === 'string') events.push(parsed)
      } catch {
        /* 半截行：文件正在被写时会出现 */
      }
      if (events.length >= maxEvents) return
    }
  }
  if (!file.endsWith('.zstd')) {
    pushLines(buf.toString('utf8'))
    return events.slice(0, maxEvents)
  }
  let pos = 0
  while (pos < buf.length && events.length < maxEvents) {
    const next = buf.indexOf(ZSTD_MAGIC, pos + ZSTD_MAGIC.length)
    const end = next < 0 ? buf.length : next
    try {
      pushLines(zstdDecompressSync(buf.subarray(pos, end)).toString('utf8'))
    } catch {
      break
    }
    pos = end
  }
  return events.slice(0, maxEvents)
}

/**
 * 把事件序列压成可比较的指纹行。
 * @param {object[]} events - 事件。
 * @param {number} [count] - 取前多少条。
 * @returns {string[]} 指纹行。
 */
export function prefixFingerprint(events, count = PREFIX_EVENTS) {
  return events.slice(0, count).map((event) => {
    const data = event.data === undefined ? null : event.data
    let json
    try {
      json = JSON.stringify(data)
    } catch {
      json = ''
    }
    return `${String(event.time ?? '')}|${String(event.type)}|${json}`
  })
}

/**
 * 两个指纹的共享前缀长度。
 * @param {string[]} a - 指纹 A。
 * @param {string[]} b - 指纹 B。
 * @returns {number} 共享条数。
 */
export function sharedPrefixLength(a, b) {
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1
  return n
}

/**
 * 找出目标会话所在的工作区目录。
 * @param {string} sessionId - 会话 id。
 * @returns {string|null} 工作区目录名（sessions 下一级）。
 */
function workspaceDirOf(sessionId) {
  const root = join(dshHome(), 'sessions')
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (existsSync(join(root, entry.name, sessionId))) return entry.name
  }
  return null
}

/**
 * 检测与目标会话共享前缀的其他会话。
 *
 * 默认只看同一工作区：跨工作区的会话本来就该由用户显式决定要不要看（它们常常是
 * 别的项目，扫所有工作区既慢又容易给出无意义的匹配）。
 * @param {object} ctx - Cordis 上下文（保持签名一致，未使用）。
 * @param {string} sessionId - 目标会话 id。
 * @param {{allowCrossWorkspace?: boolean, maxCandidates?: number, minShared?: number}} [options] - 选项。
 * @returns {{workspace: string|null, branches: Array<{sessionId: string, shared: number, ownEvents: number, prefixEvents: number}>}} 结果。
 */
export function findBranches(ctx, sessionId, options = {}) {
  const maxCandidates = Number.isInteger(options.maxCandidates) && options.maxCandidates > 0
    ? Math.min(options.maxCandidates, MAX_CANDIDATES)
    : MAX_CANDIDATES
  const minShared = Number.isInteger(options.minShared) && options.minShared > 0 ? options.minShared : 5

  const workspace = workspaceDirOf(sessionId)
  if (workspace === null) return { workspace: null, branches: [] }
  const root = join(dshHome(), 'sessions')

  const targetFile = sessionFileOf(join(root, workspace, sessionId))
  if (targetFile === null) return { workspace, branches: [] }
  const targetPrefix = prefixFingerprint(readSessionPrefix(targetFile))

  // 同工作区的其他会话 +（可选）其他工作区。
  const candidates = []
  const workspaces = options.allowCrossWorkspace === true
    ? readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    : [workspace]
  for (const slug of workspaces) {
    let ids
    try {
      ids = readdirSync(join(root, slug), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== sessionId)
        .map((entry) => entry.name)
    } catch {
      continue
    }
    for (const id of ids) candidates.push({ slug, id })
  }

  // 新的优先：分叉出来的会话通常就在近期。但工作区里可能有几百个会话（本机实测
  // 606 个），对每个 statSync 取 mtime 是几百次系统调用——先取前 40 个再排序，
  // 把一次检测从秒级压到几十毫秒。这个启发式不追求覆盖全部历史，只求命中近期的线。
  const withMtime = candidates.slice(0, 40).map((item) => {
    let mtime = 0
    try {
      mtime = statSync(join(root, item.slug, item.id)).mtimeMs
    } catch {
      mtime = 0
    }
    return { ...item, mtime }
  })
  const sorted = withMtime.sort((a, b) => b.mtime - a.mtime).slice(0, maxCandidates)

  const branches = []
  for (const candidate of sorted) {
    const file = sessionFileOf(join(root, candidate.slug, candidate.id))
    if (file === null) continue
    const other = prefixFingerprint(readSessionPrefix(file))
    const shared = sharedPrefixLength(targetPrefix, other)
    if (shared >= minShared) {
      branches.push({
        sessionId: candidate.id,
        shared,
        prefixEvents: other.length,
        ownEvents: targetPrefix.length,
      })
    }
  }
  branches.sort((a, b) => b.shared - a.shared)
  return { workspace, branches }
}
