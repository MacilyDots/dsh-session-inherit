// dsh-session-inherit · 提取器单测（node --test test/）
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  collectAnchors,
  composeInheritDoc,
  isInheritDoc,
  replaceNextStepSection,
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
  assert.match(doc, /## 任务目标/)
  assert.match(doc, /改名/)
  assert.match(doc, /## 读过的文件/)
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
  assert.match(doc, /## 读过的文件/)
  assert.ok(doc.includes('X:\\work\\demo\\a.py'))
  assert.match(doc, /## 项目内相对引用/)
  assert.ok(doc.includes('/art-ai/verify_round2.py'))
})

test('章节标题不带序号（回归：UI 与 README 曾写死「## 7. 下一步」而实际是「## 8.」）', () => {
  const doc = composeInheritDoc({ sessionId: 'session-x' }, collectAnchors(sampleEvents()), { nextStep: '做 A' })
  assert.match(doc, /^## 下一步$/m)
  assert.match(doc, /^## 任务目标$/m)
  assert.ok(!/^## \d+\./m.test(doc), '章节标题不应带序号')
})

test('collectAnchors 区分「改过的文件」与「读过的文件」', () => {
  const events = [
    { type: 'tool/call', seq: 1, time: 10, data: { callId: 'c1', name: 'read', arguments: JSON.stringify({ file_path: 'X:\\p\\read-only.cs' }) } },
    { type: 'tool/call', seq: 2, time: 20, data: { callId: 'c2', name: 'edit', arguments: JSON.stringify({ file_path: 'X:\\p\\edited.cs', old_string: 'a', new_string: 'b' }) } },
    { type: 'tool/call', seq: 3, time: 30, data: { callId: 'c3', name: 'write', arguments: JSON.stringify({ file_path: 'X:\\p\\written.md', content: '正文' }) } },
  ]
  const anchors = collectAnchors(events)
  assert.deepEqual(anchors.edited.map((f) => f.path).sort(), ['X:\\p\\edited.cs', 'X:\\p\\written.md'])
  assert.deepEqual(anchors.read.map((f) => f.path), ['X:\\p\\read-only.cs'])

  const doc = composeInheritDoc({ sessionId: 'session-x' }, anchors, {})
  assert.match(doc, /## 改过的文件/)
  assert.match(doc, /## 读过的文件/)
  assert.ok(doc.indexOf('edited.cs') < doc.indexOf('read-only.cs'), '「改过的文件」应排在「读过的文件」之前')
})

test('write 正文里提到的路径算「文中提到」，不算「改过的文件」', () => {
  const events = [
    {
      type: 'tool/call',
      seq: 1,
      time: 10,
      data: {
        callId: 'c1',
        name: 'write',
        arguments: JSON.stringify({
          file_path: 'X:\\p\\README.md',
          content: '参见 X:\\p\\其他\\旧文件.cs，以及 X:\\p\\其他\\另一个.cs',
        }),
      },
    },
  ]
  const anchors = collectAnchors(events)
  assert.deepEqual(anchors.edited.map((f) => f.path), ['X:\\p\\README.md'])
  assert.deepEqual(anchors.mentioned.map((f) => f.path).sort(), ['X:\\p\\其他\\另一个.cs', 'X:\\p\\其他\\旧文件.cs'])

  const doc = composeInheritDoc({ sessionId: 'session-x' }, anchors, {})
  assert.match(doc, /## 文中提到的路径/)
  // 三个路径都要出现，但只有 README 在「改过的文件」那一节里。
  const editedSection = doc.slice(doc.indexOf('## 改过的文件'), doc.indexOf('## 文中提到的路径'))
  assert.ok(editedSection.includes('README.md'))
  assert.ok(!editedSection.includes('旧文件.cs'))
})

test('collectAnchors 收集 tool/result 的失败现场并映射回工具名', () => {
  const events = [
    { type: 'tool/call', seq: 1, time: 10, data: { callId: 'call_a', name: 'edit', arguments: JSON.stringify({ file_path: 'X:\\p\\a.cs' }) } },
    {
      type: 'tool/result',
      seq: 2,
      time: 11,
      data: {
        turn: 1,
        step: 2,
        message: {
          role: 'tool',
          toolCallId: 'call_a',
          isError: true,
          content: [{ type: 'text', text: 'Error: cannot write "X:\\p\\a.cs": file changed since it was read — re-read the file, then retry' }],
        },
        error: { name: 'FsError', code: 'FS_STALE_VERSION' },
      },
    },
  ]
  const anchors = collectAnchors(events)
  assert.equal(anchors.failures.length, 1)
  assert.equal(anchors.failures[0].tool, 'edit')
  assert.equal(anchors.failures[0].code, 'FS_STALE_VERSION')
  assert.equal(anchors.failures[0].turn, 1, '失败要带轮次，否则分不清哪些是陈年旧账')
  assert.match(anchors.failures[0].text, /file changed since it was read/)
  assert.ok(!anchors.failures[0].text.startsWith('Error:'), '开头的 Error: 前缀应被剥掉')

  const doc = composeInheritDoc({ sessionId: 'session-x' }, anchors, {})
  assert.match(doc, /## 最近失败/)
  assert.match(doc, /\(t1\) `edit` FS_STALE_VERSION/)
})

test('replaceNextStepSection 把独立填写的下一步写进交接单', () => {
  const doc = '📋 会话继承单\n\n## 任务目标\n做 A\n\n## 下一步\n_（未指定：先问我一句要做什么，不要自行展开）_\n'
  const out = replaceNextStepSection(doc, '读 X:\\work\\a.cs，把 parse 的分支补上')
  assert.match(out, /## 下一步\n读 X:\\work\\a\.cs，把 parse 的分支补上/)
  assert.ok(!out.includes('先问我一句要做什么'), '旧的占位文本必须被替换掉')
  assert.match(out, /## 任务目标\n做 A/, '其他章节不受影响')

  // 空值原样返回（没填就不动）
  assert.equal(replaceNextStepSection(doc, '   '), doc)
  assert.equal(replaceNextStepSection(doc, ''), doc)

  // 没有「## 下一步」节时补一节
  const bare = '📋 会话继承单\n\n## 任务目标\n做 A\n'
  assert.match(replaceNextStepSection(bare, '做 B'), /## 下一步\n做 B/)

  // 不能把后面的章节吞掉
  const withTail = '## 下一步\n旧内容\n\n## 源会话最后一次回复\n保留我\n'
  const tailed = replaceNextStepSection(withTail, '新内容')
  assert.match(tailed, /## 下一步\n新内容/)
  assert.ok(!tailed.includes('旧内容'))
  assert.match(tailed, /## 源会话最后一次回复\n保留我/)
})

test('collectAnchors 丢掉成功的 tool/result 与用户主动打断', () => {
  const ok = { type: 'tool/result', seq: 1, time: 1, data: { message: { toolCallId: 'c1', isError: false, content: [{ type: 'text', text: '一切正常' }] } } }
  const aborted = {
    type: 'tool/result',
    seq: 2,
    time: 2,
    data: {
      message: { toolCallId: 'c2', isError: true, content: [{ type: 'text', text: 'Error: tool call aborted' }] },
      error: { name: 'AbortError', code: 'ABORTED' },
    },
  }
  const anchors = collectAnchors([ok, aborted])
  assert.deepEqual(anchors.failures, [])
})

test('collectAnchors 统计 compaction 次数', () => {
  const events = [
    { type: 'compaction/start', seq: 1, time: 1, data: {} },
    { type: 'compaction/end', seq: 2, time: 2, data: {} },
    { type: 'user/message', seq: 3, time: 3, data: { content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } } },
  ]
  const anchors = collectAnchors(events)
  assert.equal(anchors.compactions, 1)
  assert.match(composeInheritDoc({ sessionId: 'session-x' }, anchors, {}), /做过 1 次上下文压缩/)
})

test('已不存在的文件被标注', () => {
  const events = [
    { type: 'tool/call', seq: 1, time: 1, data: { callId: 'c1', name: 'edit', arguments: JSON.stringify({ file_path: 'X:\\gone\\a.cs' }) } },
  ]
  const anchors = collectAnchors(events)
  anchors.edited[0].missing = true
  const doc = composeInheritDoc({ sessionId: 'session-x' }, anchors, {})
  assert.match(doc, /已不存在/)
})

test('超长交接单按优先级丢弃整节，绝不切掉「下一步」', () => {
  const events = []
  // 一条 write，content 正文里塞满长路径 → 全部落在「文中提到的路径」里。
  events.push({
    type: 'tool/call',
    seq: 1,
    time: 1000,
    data: {
      callId: 'w1',
      name: 'write',
      arguments: JSON.stringify({
        file_path: 'X:\\p\\out.md',
        content: Array.from({ length: 24 }, (_, i) => `X:\\p\\${'提'.repeat(200)}\\m${i}.cs`).join('\n'),
      }),
    },
  })
  for (let i = 1; i <= 8; i += 1) {
    events.push({
      type: 'tool/call',
      seq: 10 + i,
      time: 10 + i,
      data: { callId: `p${i}`, name: 'pwsh', arguments: JSON.stringify({ command: `echo ${'命'.repeat(300)}` }) },
    })
  }
  events.push({
    type: 'tool/call',
    seq: 30,
    time: 30,
    data: {
      callId: 't1',
      name: 'todo_write',
      arguments: JSON.stringify({
        todos: Array.from({ length: 20 }, (_, i) => ({ content: `待办 ${i} ${'办'.repeat(150)}`, status: 'pending' })),
      }),
    },
  })
  events.push({
    type: 'assistant/message',
    seq: 40,
    time: 40,
    data: { message: { content: [{ type: 'text', text: '回'.repeat(2000) }] } },
  })
  for (let i = 1; i <= 6; i += 1) {
    events.push({
      type: 'user/message',
      seq: 50 + i,
      time: 50 + i,
      data: { content: [{ type: 'text', text: `指令 ${i} ${'令'.repeat(600)}` }], source: { kind: 'user' } },
    })
  }

  const anchors = collectAnchors(events)
  const nextStep = '第一步：读 X:\\p\\out.md'
  const doc = composeInheritDoc({ sessionId: 'session-x' }, anchors, { nextStep })
  assert.ok(doc.length <= 14000, `交接单不应超过上限，实际 ${doc.length}`)
  // 这一节存在就说明整节丢弃根本没发生（也就是下面这份数据不够长，测试失去意义）。
  assert.ok(!doc.includes('## 文中提到的路径'), '超长时应先丢掉「文中提到的路径」')
  assert.match(doc, /第一步：读 X:\\p\\out\.md/, '「下一步」必须完整保留')
  assert.match(doc, /## 任务目标/, '「任务目标」必须保留')
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

// 回归：路径最后一段本身含空格时（如 `X:\work\My Project Name`），WIN_PATH 的末段
// 不允许空白，会把它截断成 `X:\work\My Project`（真实会话里这类残留出现过 42 次）。
test('引号内「最后一段含空格」的路径不被截断', () => {
  const events = [
    {
      type: 'tool/call',
      seq: 1,
      time: 1,
      data: {
        callId: 'c1',
        name: 'pwsh',
        arguments: JSON.stringify({ command: "Push-Location 'X:\\work\\My Project Name'\nGet-Location" }),
      },
    },
  ]
  assert.deepEqual(
    collectAnchors(events).files.map((f) => f.path),
    ['X:\\work\\My Project Name'],
  )
})

test('结构化参数里的完整路径不被截断（含空格末段的目录）', () => {
  const events = [
    {
      type: 'tool/call',
      seq: 1,
      time: 1,
      data: { callId: 'c1', name: 'grep', arguments: JSON.stringify({ path: 'X:\\work\\My Project Name', pattern: 'x' }) },
    },
  ]
  const anchors = collectAnchors(events)
  assert.deepEqual(anchors.read.map((f) => f.path), ['X:\\work\\My Project Name'])
  assert.deepEqual(anchors.files.map((f) => f.path), ['X:\\work\\My Project Name'])
})

test('空格拼起来的多个路径不会被当成一个', () => {
  const events = [
    {
      type: 'tool/call',
      seq: 1,
      time: 1,
      data: { callId: 'c1', name: 'pwsh', arguments: JSON.stringify({ command: 'copy X:\\p\\a.cs X:\\p\\b.cs' }) },
    },
  ]
  assert.deepEqual(collectAnchors(events).files.map((f) => f.path).sort(), ['X:\\p\\a.cs', 'X:\\p\\b.cs'])
})

test('过滤自动审查被中断这类噪音失败，并按文本去重', () => {
  const same = 'The tool call was interrupted after it was recorded, but no result was durably recorded.'
  const events = [
    {
      type: 'tool/result',
      seq: 1,
      time: 1,
      data: {
        message: { toolCallId: 'c1', isError: true, content: [{ type: 'text', text: 'Error: cannot write "X:\\p\\a.cs": file changed since it was read' }] },
        error: { name: 'FsError', code: 'FS_STALE_VERSION' },
      },
    },
    {
      type: 'tool/result',
      seq: 2,
      time: 2,
      data: {
        message: { toolCallId: 'c2', isError: true, content: [{ type: 'text', text: same }] },
        error: { name: 'ToolError', code: 'TOOL_OUTCOME_UNKNOWN' },
      },
    },
    {
      type: 'tool/result',
      seq: 3,
      time: 3,
      data: {
        message: { toolCallId: 'c3', isError: true, content: [{ type: 'text', text: same }] },
        error: { name: 'ToolError', code: 'TOOL_OUTCOME_UNKNOWN' },
      },
    },
    {
      type: 'tool/result',
      seq: 4,
      time: 4,
      data: {
        message: { toolCallId: 'c4', isError: true, content: [{ type: 'text', text: 'Auto review of tool "read_image" failed; its body was not executed: auto-review: reviewer ended with aborted ABORTED' }] },
      },
    },
  ]
  const failures = collectAnchors(events).failures
  assert.equal(failures.length, 2, '两条同文本应合成一条，auto-review 那条应被丢掉')
  assert.equal(failures[0].code, 'FS_STALE_VERSION')
  assert.equal(failures[1].code, 'TOOL_OUTCOME_UNKNOWN')
})
