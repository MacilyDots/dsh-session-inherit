// dsh-session-inherit · 宿主半集成测试
//
// 用一个假 Cordis 上下文把 apply() 跑起来，再直接调用注册到 webServer 上的
// handler，验证「注册成功 → 读会话 → 提取 → 组装 → JSON 响应」整条链路。
// 这样可以在不动真实 DSH 的前提下，把 host 半的问题先挡掉。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// 离线测试必须把诊断日志写到临时文件。上一轮这些用例的假 session id
// （session-11111111-…）混进了真实的生产日志，差点被当成用户操作记录误判——
// 所以环境变量在 import 之前设置，且 index.mjs 用动态 import 拉进来。
process.env.DSH_SESSION_INHERIT_LOG = join(tmpdir(), 'dsh-session-inherit-test.log')
process.env.DSH_HOME = join(tmpdir(), 'dsh-session-inherit-test-home')
const { apply, name: pluginName, inject } = await import('../index.mjs')

const PREVIEW = '/__session-inherit/preview'
const COMMIT = '/__session-inherit/commit'

const SESSION_ID = 'session-11111111-2222-3333-4444-555555555555'

/** 一段包含真实用户消息、注入消息、文件与待办的事件流。 */
function sampleEvents() {
  return [
    { type: 'turn/start', seq: 1, time: 1_700_000_000_000, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 1_700_000_001_000, data: { content: [{ type: 'text', text: '把 demo 的武器贴图修一下' }], source: { kind: 'user' } } },
    { type: 'user/message', seq: 3, time: 1_700_000_002_000, data: { content: [{ type: 'text', text: '<system-reminder> 注入内容不该出现' }], source: { kind: 'agent-instructions' } } },
    { type: 'tool/call', seq: 4, time: 1_700_000_003_000, data: { callId: 'c1', name: 'read', arguments: JSON.stringify({ path: 'X:\\work\\demo\\art\\weapon.png' }) } },
    { type: 'tool/call', seq: 5, time: 1_700_000_004_000, data: { callId: 'c2', name: 'pwsh', arguments: JSON.stringify({ command: 'python verify.py' }) } },
    { type: 'tool/call', seq: 6, time: 1_700_000_005_000, data: { callId: 'c3', name: 'todo_write', arguments: JSON.stringify({ todos: [{ content: '复算连通性', status: 'pending' }] }) } },
    { type: 'assistant/message', seq: 7, time: 1_700_000_006_000, data: { message: { content: [{ type: 'text', text: '已经改好，待复算。' }] } } },
    { type: 'request/header', seq: 8, time: 1_700_000_007_000, data: { header: { config: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } }, reason: 'initial' } },
    { type: 'tool/call', seq: 9, time: 1_700_000_008_000, data: { callId: 'c4', name: 'edit', arguments: JSON.stringify({ file_path: 'X:\\work\\demo\\art\\weapon.png.meta', old_string: 'a', new_string: 'b' }) } },
    {
      type: 'tool/result',
      seq: 10,
      time: 1_700_000_009_000,
      data: {
        turn: 1,
        step: 3,
        message: {
          role: 'tool',
          toolCallId: 'c4',
          isError: true,
          content: [{ type: 'text', text: 'Error: cannot write "X:\\work\\demo\\art\\weapon.png.meta": file changed since it was read — re-read the file, then retry' }],
        },
        error: { name: 'FsError', code: 'FS_STALE_VERSION' },
      },
    },
  ]
}

function makeSessionQuery(events, header = {}) {
  return {
    calls: 0,
    async readSession() {
      this.calls += 1
      return {
        session: { id: SESSION_ID, cwd: 'X:\\work\\demo', agentPreset: 'standard', ...header },
        inheritedEventCount: 0,
        events,
      }
    },
  }
}

function makeRequest(method, payload) {
  const handlers = {}
  const req = {
    method,
    headers: { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' },
    on(event, callback) {
      handlers[event] = handlers[event] ?? []
      handlers[event].push(callback)
      return req
    },
  }
  setTimeout(() => {
    if (payload !== undefined) {
      for (const cb of handlers.data ?? []) cb(Buffer.from(JSON.stringify(payload)))
    }
    for (const cb of handlers.end ?? []) cb()
  }, 0)
  return req
}

function makeResponse() {
  const res = {
    status: null,
    body: '',
    writeHead(status) { res.status = status },
    end(chunk) { res.body = chunk ?? '' },
  }
  return res
}

/**
 * 造一个假 Cordis 上下文并 apply 插件。
 * 默认关掉快照缓存，保证每个用例都真的读一次日志（缓存行为另有专门用例）。
 * @param {{sessionQuery?: object, agents?: object, sessionController?: object, webServer?: object}} services
 * @param {object} [config]
 * @returns {{routes: Map<string, Function>, ctx: object, webServer: object}}
 */
function bootstrap(services = {}, config = { cacheTtlMs: 0 }) {
  const routes = new Map()
  const webServer = services.webServer ?? {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  }
  const ctx = {
    agents: services.agents,
    // 命令注册走的是 `sub.commands.register`（属性访问），所以这里必须真的挂上属性，
    // 只放进 get() 是不够的。
    commands: services.commands,
    get(serviceName) {
      if (serviceName === 'webServer') return webServer
      if (serviceName === 'sessionQuery') return services.sessionQuery
      if (serviceName === 'sessionController') return services.sessionController
      if (serviceName === 'workspaceRegistry') return services.workspaceRegistry
      if (serviceName === 'sessionTitle') return services.sessionTitle
      if (serviceName === 'agentPresets') return services.agentPresets
      if (serviceName === 'agentDefaultModel') return services.agentDefaultModel
      if (serviceName === 'commands') return services.commands
      return undefined
    },
    effect(callback) {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    inject(_names, callback) { callback(ctx) },
    on() { return () => {} },
    logger() { return { info() {}, warn() {}, error() {} } },
  }
  apply(ctx, config)
  return { routes, ctx, webServer }
}

async function call(handler, method, payload) {
  const res = makeResponse()
  await handler(makeRequest(method, payload), res)
  return { status: res.status, json: res.body.length > 0 ? JSON.parse(res.body) : null }
}

test('插件导出契约', () => {
  assert.equal(pluginName, 'dsh-session-inherit')
  assert.deepEqual(inject, ['agents'])
})

test('apply 注册 preview 与 commit 两个端点', () => {
  const { routes } = bootstrap({ sessionQuery: makeSessionQuery(sampleEvents()) })
  assert.ok(routes.has(PREVIEW), '缺少 preview 路由')
  assert.ok(routes.has(COMMIT), '缺少 commit 路由')
})

test('preview 返回带具体锚点的交接单', async () => {
  const sessionQuery = makeSessionQuery(sampleEvents())
  const { routes } = bootstrap({ sessionQuery })
  const { status, json } = await call(routes.get(PREVIEW), 'POST', { sessionId: SESSION_ID, title: '演示会话' })

  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.match(json.doc, /把 demo 的武器贴图修一下/)
  assert.ok(json.doc.includes('X:\\work\\demo\\art\\weapon.png'))
  assert.match(json.doc, /python verify\.py/)
  assert.match(json.doc, /复算连通性/)
  assert.ok(!json.doc.includes('注入内容不该出现'), '注入消息不得进入交接单')
  assert.equal(json.source.turns, 1)
  assert.equal(json.source.fileCount, 2)
  assert.equal(json.source.editedCount, 1)
  assert.equal(json.source.failureCount, 1)
  assert.match(json.doc, /## 改过的文件/)
  assert.match(json.doc, /## 最近失败/)
  assert.match(json.doc, /FS_STALE_VERSION/)
  assert.ok(!/^## \d+\./m.test(json.doc), '章节标题不应带序号')
  assert.equal(json.route.provider, 'opencode-go')
  assert.equal(json.route.model, 'deepseek-v4.1-flash')
  assert.equal(sessionQuery.calls, 1)
})

test('preview 的连接被缓存：commit 不再重复读日志', async () => {
  const sessionQuery = makeSessionQuery(sampleEvents())
  const created = []
  const prompted = []
  const { routes } = bootstrap({
    sessionQuery,
    agents: {
      async create(options) {
        created.push(options)
        return { agent: { session: { id: options.sessionId, append() { throw new Error('不应走到 append') } } } }
      },
    },
    sessionController: {
      async prompt(request) { prompted.push(request); return { accepted: true } },
    },
    sessionTitle: { rename() {} },
  }, { cacheTtlMs: 120_000 })
  const preview = await call(routes.get(PREVIEW), 'POST', { sessionId: SESSION_ID })
  assert.equal(preview.status, 200)
  const commit = await call(routes.get(COMMIT), 'POST', { sessionId: SESSION_ID, doc: preview.json.doc, start: true })
  assert.equal(commit.status, 200)
  assert.equal(commit.json.ok, true)
  assert.equal(commit.json.mode, 'prompted')
  assert.equal(sessionQuery.calls, 1, '同一个会话在缓存窗口内只应读一次')

  assert.equal(created.length, 1)
  const options = created[0]
  assert.equal(options.meta.cwd, 'X:\\work\\demo')
  // 刻意不传 parentSession：它是 fork-lineage 字段，源会话常常是冷的，
  // 第一次真实点击的挂起就发生在 agents.create 上。去掉父链后创建是纯新增。
  assert.equal(options.meta.parentSession, undefined)
  assert.equal(options.meta.agentPreset, 'standard')
  assert.deepEqual(options.agentOptions, { provider: 'opencode-go', model: 'deepseek-v4.1-flash' })
  assert.match(options.sessionId, /^session-[0-9a-f-]{36}$/)

  assert.equal(prompted.length, 1)
  assert.match(prompted[0].content[0].text, /把 demo 的武器贴图修一下/)
  assert.equal(prompted[0].mode, 'queue')
})

test('start:false 时只追加交接单、不触发首轮', async () => {
  const appended = []
  const { routes } = bootstrap({
    sessionQuery: makeSessionQuery(sampleEvents()),
    agents: {
      async create(options) {
        return {
          agent: {
            session: {
              id: options.sessionId,
              append(type, data, opts) { appended.push({ type, data, opts }) },
            },
          },
        }
      },
    },
    sessionController: { async prompt() { throw new Error('不应被调用') } },
  })
  const { status, json } = await call(routes.get(COMMIT), 'POST', { sessionId: SESSION_ID, start: false })
  assert.equal(status, 200)
  assert.equal(json.mode, 'appended')
  assert.equal(appended.length, 1)
  assert.equal(appended[0].type, 'user/message')
  assert.equal(appended[0].opts.surfaceOp, 'append')
  assert.match(appended[0].data.content[0].text, /把 demo 的武器贴图修一下/)
  assert.equal(appended[0].data.role, 'user')
})

test('prompt 失败时降级为 append，并如实说明', async () => {
  const appended = []
  const { routes } = bootstrap({
    sessionQuery: makeSessionQuery(sampleEvents()),
    agents: {
      async create(options) {
        return { agent: { session: { id: options.sessionId, append(type, data) { appended.push({ type, data }) } } } }
      },
    },
    sessionController: { async prompt() { throw new Error('session/writer-held') } },
  })
  const { status, json } = await call(routes.get(COMMIT), 'POST', { sessionId: SESSION_ID, start: true })
  assert.equal(status, 200)
  assert.equal(json.mode, 'appended-after-prompt-failure')
  assert.match(json.note, /session\/writer-held/)
  assert.equal(appended.length, 1)
})

test('非法会话 id 与非 POST 被拒绝', async () => {
  const { routes } = bootstrap({ sessionQuery: makeSessionQuery(sampleEvents()) })
  const bad = await call(routes.get(PREVIEW), 'POST', { sessionId: 'not-a-session' })
  assert.equal(bad.status, 400)
  assert.equal(bad.json.ok, false)

  const wrongMethod = await call(routes.get(PREVIEW), 'GET')
  assert.equal(wrongMethod.status, 405)
})

test('源会话不存在时 preview 返回 500 且带原因', async () => {
  const { routes } = bootstrap({
    sessionQuery: { async readSession() { throw new Error('session not found') } },
  })
  const { status, json } = await call(routes.get(PREVIEW), 'POST', { sessionId: SESSION_ID })
  assert.equal(status, 500)
  assert.match(json.error, /session not found/)
})

test('没有 webServer 服务时不抛错（终端型 profile 降级）', () => {
  const ctx = {
    agents: {},
    get() { return undefined },
    effect() { return () => {} },
    inject(_names, callback) { callback(ctx) },
    on() { return () => {} },
    logger() { return { info() {}, warn() {}, error() {} } },
  }
  assert.doesNotThrow(() => apply(ctx, {}))
})

test('enabled:false 时不注册任何路由', () => {
  const routes = new Map()
  const webServer = { register(route) { routes.set(route.path, route.handler); return () => {} } }
  const ctx = {
    agents: {},
    get(serviceName) { return serviceName === 'webServer' ? webServer : undefined },
    effect(callback) { const d = callback(); return typeof d === 'function' ? d : () => {} },
    inject(_names, callback) { callback(ctx) },
    on() { return () => {} },
    logger() { return { info() {}, warn() {}, error() {} } },
  }
  apply(ctx, { enabled: false })
  assert.equal(routes.size, 0)
})

test('客户端把交接单清空时报错，不静默换成自动生成的版本', async () => {
  const { routes } = bootstrap({ sessionQuery: makeSessionQuery(sampleEvents()) })
  const { status, json } = await call(routes.get(COMMIT), 'POST', { sessionId: SESSION_ID, doc: '' })
  assert.equal(status, 400)
  assert.match(json.error, /交接单为空/)
})

test('/inherit 支持 --next 指定下一步', async () => {
  const registered = []
  const appended = []
  const commands = { register(spec) { registered.push(spec); return () => {} } }
  bootstrap({
    sessionQuery: makeSessionQuery(sampleEvents()),
    commands,
    agents: {
      async create(options) {
        return { agent: { session: { id: options.sessionId, append(type, data) { appended.push({ type, data }) } } } }
      },
    },
  }, { cacheTtlMs: 0, startByDefault: false })

  const spec = registered.find((entry) => entry.name === 'inherit')
  assert.ok(spec !== undefined, '/inherit 未注册')

  // 不带 sessionId：继承当前会话，--next 之后全部算下一步。
  const withNext = await spec.handler({ rawInput: '--next 先跑一次 npm test', agent: { session: { id: SESSION_ID } } })
  assert.equal(withNext.kind, 'success')
  assert.equal(appended.length, 1)
  assert.match(appended[0].data.content[0].text, /先跑一次 npm test/)
  assert.match(appended[0].data.content[0].text, /把 demo 的武器贴图修一下/)

  // 显式 sessionId + --next。
  appended.length = 0
  const explicit = await spec.handler({ rawInput: `${SESSION_ID} --next 换个文件继续`, agent: { session: { id: SESSION_ID } } })
  assert.equal(explicit.kind, 'success')
  assert.match(appended[0].data.content[0].text, /换个文件继续/)

  // 没有 --next 的裸文本只可能是会话 id，不合法就如实报错（不猜成"下一步"）。
  const bad = await spec.handler({ rawInput: '修复登录 bug', agent: { session: { id: SESSION_ID } } })
  assert.equal(bad.kind, 'error')
  assert.match(bad.text, /不合法/)
})

test('客户端回传 doc 时，独立填写的 nextStep 也会写进交接单', async () => {
  const prompted = []
  const { routes } = bootstrap({
    sessionQuery: makeSessionQuery(sampleEvents()),
    agents: {
      async create(options) {
        return { agent: { session: { id: options.sessionId, append() {} } } }
      },
    },
    sessionController: { async prompt(request) { prompted.push(request); return { accepted: true } } },
    sessionTitle: { rename() {} },
  })
  const preview = await call(routes.get(PREVIEW), 'POST', { sessionId: SESSION_ID })
  assert.equal(preview.status, 200)
  // 预览里的「下一步」是自动生成的占位文本。
  assert.match(preview.json.doc, /先问我一句要做什么/)

  const commit = await call(routes.get(COMMIT), 'POST', {
    sessionId: SESSION_ID,
    doc: preview.json.doc,
    nextStep: '先跑一次 npm test',
    start: true,
  })
  assert.equal(commit.status, 200)
  assert.equal(commit.json.mode, 'prompted')
  const sent = prompted[0].content[0].text
  assert.match(sent, /先跑一次 npm test/, '独立输入框的内容必须被写进交接单')
  assert.ok(!sent.includes('先问我一句要做什么'), '自动生成的占位文本必须被替换掉')
  assert.match(sent, /把 demo 的武器贴图修一下/, '交接单其余部分不受影响')
})

test('preview 带出此前的继承记录，commit 后写入新记录', async () => {
  const historyPath = join(process.env.DSH_HOME, 'session-inherit', 'history.json')
  mkdirSync(dirname(historyPath), { recursive: true })
  writeFileSync(historyPath, JSON.stringify({
    [SESSION_ID]: [{ child: 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', at: 1_791_561_308_478 }],
  }), 'utf8')

  const { routes } = bootstrap({
    sessionQuery: makeSessionQuery(sampleEvents()),
    agents: {
      async create(options) {
        return { agent: { session: { id: options.sessionId, append() {} } } }
      },
    },
    sessionController: { async prompt() { return { accepted: true } } },
    sessionTitle: { rename() {} },
  })

  const preview = await call(routes.get(PREVIEW), 'POST', { sessionId: SESSION_ID })
  assert.equal(preview.status, 200)
  assert.equal(preview.json.inherited.length, 1, 'preview 必须带出此前的继承记录')
  assert.equal(preview.json.inherited[0].child, 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')

  const commit = await call(routes.get(COMMIT), 'POST', { sessionId: SESSION_ID, start: false })
  assert.equal(commit.status, 200)
  const saved = JSON.parse(readFileSync(historyPath, 'utf8'))
  assert.equal(saved[SESSION_ID].length, 2, 'commit 之后应新增一条记录')
  assert.equal(saved[SESSION_ID][1].child, commit.json.sessionId)
})
