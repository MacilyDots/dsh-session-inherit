// 分叉检测单测：真造会话目录，跑真实的文件读取与前缀比对。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

// branches.mjs 通过 contracts.dshHome() 读 DSH_HOME，必须在 import 之前设好。
process.env.DSH_HOME = join(tmpdir(), 'dsh-session-inherit-branches-home')
const HOME = process.env.DSH_HOME

const { findBranches, prefixFingerprint, readSessionPrefix, sharedPrefixLength } = await import('../lib/branches.mjs')
const { renderSessionBranches } = await import('../lib/session-read.mjs')

/**
 * 造一条事件。
 * @param {number} seq - 序号。
 * @param {string} type - 类型。
 * @param {object} [data] - data。
 * @returns {object} 事件。
 */
function ev(seq, type, data = {}) {
  return { type, seq, time: 1_700_000_000_000 + seq, data }
}

/**
 * 写一个明文会话文件。
 * @param {string} slug - 工作区目录。
 * @param {string} id - 会话 id。
 * @param {object[]} events - 事件。
 */
function writeSession(slug, id, events) {
  const dir = join(HOME, 'sessions', slug, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`)
}

const SHARED = [
  ev(0, 'session', { id: 'shared-prefix' }),
  ev(1, 'turn/start', { turn: 1 }),
  ev(2, 'user/message', { content: [{ type: 'text', text: '把贴图重命名' }] }),
  ev(3, 'assistant/message', { message: { content: [{ type: 'text', text: '先看目录' }] } }),
  ev(4, 'tool/call', { callId: 'c1', name: 'read', arguments: '{"path":"X:\\\\a.cs"}' }),
  ev(5, 'tool/result', { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] } }),
]

test('共享事件前缀的会话被判为分叉', () => {
  rmSync(HOME, { recursive: true, force: true })
  writeSession('--X-DSH--', 'session-aaaa', SHARED)
  // 分叉：前 6 条完全一致，之后各自走了
  writeSession('--X-DSH--', 'session-bbbb', [...SHARED, ev(6, 'user/message', { content: [{ type: 'text', text: '另一条线' }] })])
  // 无关会话：只有类型相同，time/data 都不同
  writeSession('--X-DSH--', 'session-cccc', [ev(0, 'session', { id: 'other' }), ev(1, 'turn/start', { turn: 9 })])

  const result = findBranches({}, 'session-aaaa')
  assert.equal(result.workspace, '--X-DSH--')
  const ids = result.branches.map((item) => item.sessionId)
  assert.ok(ids.includes('session-bbbb'), '共享前缀的会话必须检出')
  assert.ok(!ids.includes('session-cccc'), '前缀不一致的会话不能算分支')
  assert.equal(result.branches[0].shared, 6, '共享条数要如实报告')
})

test('默认只扫同一工作区，allowCrossWorkspace 才跨区', () => {
  // 另一个工作区里有同一条线的分叉
  writeSession('--Y-OTHER--', 'session-dddd', SHARED)

  const narrow = findBranches({}, 'session-aaaa')
  assert.ok(!narrow.branches.some((item) => item.sessionId === 'session-dddd'), '默认不跨工作区')

  const wide = findBranches({}, 'session-aaaa', { allowCrossWorkspace: true })
  assert.ok(wide.branches.some((item) => item.sessionId === 'session-dddd'), '显式允许时必须跨区')
})

test('zstd 多帧/单帧会话文件也能读前缀', () => {
  const dir = join(HOME, 'sessions', '--X-DSH--', 'session-eeee')
  mkdirSync(dir, { recursive: true })
  const text = SHARED.map((event) => JSON.stringify(event)).join('\n')
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(text, 'utf8')))

  const events = readSessionPrefix(join(dir, 'session.v4.jsonl.zstd'), 40)
  assert.equal(events.length, SHARED.length)
  assert.deepEqual(prefixFingerprint(events), prefixFingerprint(SHARED))
})

test('指纹与前缀长度是纯函数', () => {
  const a = prefixFingerprint(SHARED)
  const b = prefixFingerprint([...SHARED.slice(0, 4), ev(9, 'session', { other: true })])
  assert.equal(sharedPrefixLength(a, b), 4)
  assert.equal(sharedPrefixLength(a, a), SHARED.length)
  assert.equal(sharedPrefixLength(a, []), 0)
})

test('branches 渲染：有分叉、无分叉、英文三种形态', () => {
  const result = findBranches({}, 'session-aaaa')
  const zh = renderSessionBranches('session-aaaa', {}, result)
  assert.match(zh, /的分支 \d+ 个/)
  assert.match(zh, /共享前缀 \d+ 条/)

  const none = renderSessionBranches('session-zzzz', {}, { workspace: '--X-DSH--', branches: [] })
  assert.match(none, /没找到共享前缀/)

  const en = renderSessionBranches('session-aaaa', {}, result, 'en')
  assert.match(en, /branch\(es\)/)
})
