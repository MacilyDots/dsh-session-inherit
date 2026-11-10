// 契约测试：用一份固定的、脱敏的真实形状事件流，锁住"提取器对这些事件做了什么"。
//
// 为什么需要它：其余单测用的是就地构造的最小事件，覆盖的是逻辑分支；这一份覆盖的是
// **DSH 真实事件的字段形状**（content 数组、attachment 对象、tool/result 的 error.code、
// turn/end 的 reason.kind 等）。DSH 升级如果改了这些形状，解析器会静默少提取东西——
// 这份 fixture 是唯一能及时变红的地方。
//
// fixture 里的路径一律用虚构盘符 `X:`，正文均为示例文本，不含任何真实项目内容。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { collectAnchors, composeInheritDoc } from '../lib/extract.mjs'
import { EVENTS } from '../lib/contracts.mjs'

const events = JSON.parse(readFileSync(new URL('./fixtures/session-events.json', import.meta.url), 'utf8'))

test('契约 fixture 覆盖插件依赖的全部事件类型', () => {
  const seen = new Set(events.map((event) => event.type))
  for (const name of Object.values(EVENTS)) {
    // session/end-seed 只在特定场景补写，fixture 里不强制出现。
    if (name === EVENTS.sessionEndSeed) continue
    assert.ok(seen.has(name), `fixture 缺少事件类型 ${name}（DSH 可能改了这个类型的名字）`)
  }
})

test('对契约 fixture 提取出的锚点符合预期', () => {
  const anchors = collectAnchors(events, { recentUsers: 6 })

  assert.equal(anchors.turns, 1)
  assert.equal(anchors.task.weak, false)
  assert.match(anchors.task.text, /武器贴图/)

  // 运行时注入的 user/message 不能进任何用户视角
  assert.ok(!anchors.recentUsers.some((item) => item.text.includes('运行时注入')))
  assert.equal(anchors.recentUsers.length, 1)

  assert.equal(anchors.edited.length, 1, 'write 的 file_path 应进「改过的文件」')
  assert.match(anchors.edited[0].path, /weapon\.png\.meta$/)
  assert.ok(anchors.read.length >= 1, 'read 的 path 应进「读过的文件」')

  assert.equal(anchors.failures.length, 1)
  assert.equal(anchors.failures[0].code, 'FS_STALE_VERSION')
  assert.equal(anchors.failures[0].tool, 'write')
  assert.equal(anchors.failures[0].turn, 1)

  assert.equal(anchors.todos.length, 2)
  assert.equal(anchors.verifyCommand, 'npm test')
  assert.deepEqual(anchors.lastTurn, { state: 'completed', turn: 1, cause: '' })
  assert.equal(anchors.attachments.length, 0)
  assert.equal(anchors.title, '武器贴图批量重命名')
})

test('交接单从 fixture 生成预期章节，且不含推理与运行时注入', () => {
  const anchors = collectAnchors(events)
  const doc = composeInheritDoc(
    { sessionId: 'session-fixture-0000-0000-0000-000000000000', cwd: 'X:\\work\\demo', model: 'provider/model' },
    anchors,
    {},
  )
  assert.match(doc, /## 任务目标/)
  assert.match(doc, /## 改过的文件/)
  assert.match(doc, /## 最近失败/)
  assert.match(doc, /## 建议先验证/)
  assert.match(doc, /## 待办/)
  assert.match(doc, /npm test/)
  assert.match(doc, /FS_STALE_VERSION/)
  assert.doesNotMatch(doc, /这段推理不该进交接单/)
  assert.doesNotMatch(doc, /运行时注入/)
})

test('fixture 文件本身不含真实路径与用户名', () => {
  const text = JSON.stringify(events)
  assert.doesNotMatch(text, /[A-Za-z]:\\Users\\/i, '不能出现 C:\\Users 这类本机路径')
  // 只允许虚构盘符 X:
  const drives = text.match(/[A-Za-z]:\\/g) ?? []
  assert.ok(drives.every((hit) => hit === 'X:\\'), `只允许虚构盘符 X:，实际出现 ${drives.join(', ')}`)
})
