// dsh-session-inherit · 提取器单测（node --test test/）
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  collectAnchors,
  composeInheritDoc,
  isInheritDoc,
  textOfBlocks,
  clip,
  DOC_MARK,
} from '../lib/extract.mjs'

const path = 'X:\\work\\demo\\package.json'

/** 一份典型的会话事件流：两轮、含文件/命令/待办/推理块。 */
function sampleEvents() {
  return [
    { type: 'turn/start', seq: 1, time: 1_700_000_000_000, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 1_700_000_001_000, data: { content: [{ type: 'text', text: '帮我把 demo 项目改名' }] } },
    {
      type: 'assistant/message',
      seq: 3,
      time: 1_700_000_002_000,
      data: {
        message: {
          content: [
            { type: 'reasoning', text: '这段推理不应该出现在交接单里' },
            { type: 'text', text: '我先看一下 package.json。' },
          ],
        },
      },
    },
    { type: 'tool/call', seq: 4, time: 1_700_000_003_000, data: { callId: 'c1', name: 'read', arguments: JSON.stringify({ path }) } },
    { type: 'tool/call', seq: 5, time: 1_700_000_004_000, data: { callId: 'c2', name: 'pwsh', arguments: JSON.stringify({ command: 'node -v' }) } },
    {
      type: 'tool/call',
      seq: 6,
      time: 1_700_000_005_000,
      data: {
        callId: 'c3',
        name: 'todo_write',
        arguments: JSON.stringify({
          todos: [
            { content: '改 package.json 的 name', status: 'pending' },
            { content: '跑一次测试', status: 'completed' },
          ],
        }),
      },
    },
    { type: 'turn/start', seq: 7, time: 1_700_000_006_000, data: { turn: 2 } },
    { type: 'user/message', seq: 8, time: 1_700_000_007_000, data: { content: [{ type: 'text', text: '继续，先别动版本号' }] } },
    { type: 'assistant/message', seq: 9, time: 1_700_000_008_000, data: { message: { content: [{ type: 'text', text: '好，我保持版本号不变。' }] } } },
  ]
}

test('textOfBlocks 只取 text 块', () => {
  assert.equal(textOfBlocks([{ type: 'text', text: 'a' }, { type: 'reasoning', text: 'b' }, { type: 'text', text: 'c' }]), 'a\nc')
  assert.equal(textOfBlocks(undefined), '')
})

test('isInheritDoc 识别交接单首行', () => {
  assert.equal(isInheritDoc(`${DOC_MARK}\n\n内容`), true)
  assert.equal(isInheritDoc('   ' + DOC_MARK + ' x'), true)
  assert.equal(isInheritDoc('普通用户消息'), false)
})

test('collectAnchors 提取任务、轮次、文件、命令与待办', () => {
  const anchors = collectAnchors(sampleEvents())
  assert.equal(anchors.turns, 2)
  assert.equal(anchors.eventCount, 9)
  assert.match(anchors.firstUser.text, /改名/)
  assert.equal(anchors.recentUsers.length, 2)
  assert.equal(anchors.recentUsers[1].text, '继续，先别动版本号')
  assert.equal(anchors.recentUsers[1].turn, 2)
  assert.deepEqual(anchors.files.map((f) => f.path), [path])
  assert.deepEqual(anchors.commands.map((c) => c.command), ['node -v'])
  assert.equal(anchors.todos.length, 2)
  assert.equal(anchors.todos[0].content, '改 package.json 的 name')
  assert.equal(anchors.lastAssistant.text, '好，我保持版本号不变。')
  assert.equal(anchors.inheritedCount, 0)
})

test('collectAnchors 不把交接单本身当成用户消息', () => {
  const events = [
    { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: `${DOC_MARK}\n\n旧交接单` }] } },
    { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: '真正的话' }] } },
  ]
  const anchors = collectAnchors(events)
  assert.equal(anchors.inheritedCount, 1)
  assert.equal(anchors.recentUsers.length, 1)
  assert.equal(anchors.recentUsers[0].text, '真正的话')
  assert.equal(anchors.firstUser.text, '真正的话')
})

test('collectAnchors 的 recentUsers 只保留最后 N 条', () => {
  const events = []
  for (let i = 1; i <= 10; i += 1) {
    events.push({ type: 'user/message', seq: i, time: i, data: { content: [{ type: 'text', text: `第 ${i} 条` }] } })
  }
  const anchors = collectAnchors(events, { recentUsers: 3 })
  assert.equal(anchors.recentUsers.length, 3)
  assert.equal(anchors.recentUsers[0].text, '第 8 条')
  assert.equal(anchors.firstUser.text, '第 1 条')
})

test('collectAnchors 忽略 URL，不把它当文件路径', () => {
  const events = [
    { type: 'tool/call', seq: 1, time: 1, data: { callId: 'c', name: 'fetch', arguments: JSON.stringify({ url: 'https://example.com/a/b.json' }) } },
  ]
  assert.deepEqual(collectAnchors(events).files, [])
})

test('composeInheritDoc 带出具体锚点且不含推理文本', () => {
  const annotations = collectAnchors(sampleEvents())
  const doc = composeInheritDoc({ sessionId: 'session-abc', title: '示例会话', cwd: 'X:\\work\\demo' }, annotations, { nextStep: '改完跑一次 npm test' })
  assert.ok(doc.startsWith(DOC_MARK))
  assert.match(doc, /不要复述本单/)
  assert.match(doc, /## 1\. 任务目标/)
  assert.match(doc, /改名/)
  assert.match(doc, /## 3\. 涉及的文件/)
  assert.ok(doc.includes(path))
  assert.match(doc, /node -v/)
  assert.match(doc, /改 package\.json 的 name/)
  assert.match(doc, /改完跑一次 npm test/)
  assert.ok(!doc.includes('这段推理不应该出现'), '推理块不得进入交接单')
  assert.match(doc, /X:\\work\\demo/)
})

test('collectAnchors 只认 source.kind === user 的用户消息', () => {
  const events = [
    { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: '真正的话' }], source: { kind: 'user' } } },
    { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: '<system-reminder> 注入的规矩' }], source: { kind: 'agent-instructions' } } },
    { type: 'user/message', seq: 3, time: 3, data: { content: [{ type: 'text', text: 'Current runtime context.' }], source: { kind: 'runtime-context' } } },
    { type: 'user/message', seq: 4, time: 4, data: { content: [{ type: 'text', text: '[MEMO] 提示' }], source: { kind: 'memo-provider' } } },
    { type: 'user/message', seq: 5, time: 5, data: { content: [{ type: 'text', text: 'Time sampled while preparing turn 1' }], source: { kind: 'time-context' } } },
  ]
  const anchors = collectAnchors(events)
  assert.equal(anchors.recentUsers.length, 1)
  assert.equal(anchors.recentUsers[0].text, '真正的话')
  assert.ok(!JSON.stringify(anchors).includes('system-reminder'))
})

test('collectAnchors 过滤单段 POSIX 噪音与运行时路径', () => {
  const events = [
    { type: 'tool/call', seq: 1, time: 1, data: { callId: 'c1', name: 'read', arguments: JSON.stringify({ path: '/m.size' }) } },
    { type: 'tool/call', seq: 2, time: 2, data: { callId: 'c2', name: 'read', arguments: JSON.stringify({ path: '/EnemyGrunt.cs' }) } },
    { type: 'tool/call', seq: 3, time: 3, data: { callId: 'c3', name: 'read', arguments: JSON.stringify({ path: '/Scripts/Enemies/EnemyGrunt.cs' }) } },
    {
      type: 'tool/call',
      seq: 4,
      time: 4,
      data: {
        callId: 'c4',
        name: 'pwsh',
        arguments: JSON.stringify({ command: '"X:\\tools\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe" -V' }),
      },
    },
  ]
  const paths = collectAnchors(events).files.map((f) => f.path)
  assert.deepEqual(paths, ['/Scripts/Enemies/EnemyGrunt.cs'])
})

test('collectAnchors 保留含空格的 Windows 项目路径', () => {
  const full = 'X:\\work\\My Project Name\\Assets\\Art\\Characters\\Player\\CHR_Warrior_Idle_Front.png'
  const events = [
    { type: 'tool/call', seq: 1, time: 1, data: { callId: 'c', name: 'read', arguments: JSON.stringify({ path: full }) } },
  ]
  const files = collectAnchors(events).files
  assert.equal(files.length, 1)
  assert.equal(files[0].path, full)
  assert.equal(files[0].absolute, true)
})

test('composeInheritDoc 把绝对路径与相对引用分开列', () => {
  const events = [
    { type: 'tool/call', seq: 1, time: 1, data: { callId: 'c1', name: 'read', arguments: JSON.stringify({ path: 'X:\\work\\demo\\a.py' }) } },
    { type: 'tool/call', seq: 2, time: 2, data: { callId: 'c2', name: 'read', arguments: JSON.stringify({ path: '/art-ai/verify_round2.py' }) } },
  ]
  const doc = composeInheritDoc({ sessionId: 'session-x' }, collectAnchors(events), {})
  assert.match(doc, /## 3\. 涉及的文件（绝对路径/)
  assert.ok(doc.includes('X:\\work\\demo\\a.py'))
  assert.match(doc, /## 4\. 项目内相对引用/)
  assert.ok(doc.includes('/art-ai/verify_round2.py'))
})

test('composeInheritDoc 的下一步为空时要求先问一句', () => {
  const doc = composeInheritDoc({ sessionId: 'session-x' }, collectAnchors([]), {})
  assert.match(doc, /先问我一句要做什么/)
})

test('clip 折叠超长文本', () => {
  const out = clip('x'.repeat(50), 10)
  assert.equal(out.length, 10)
  assert.ok(out.endsWith('…'))
})
