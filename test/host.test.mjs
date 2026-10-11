// dsh-session-inherit · 宿主半集成测试
//
// 用一个假 Cordis 上下文把 apply() 跑起来，再直接调用注册到 webServer 上的
// handler，验证「注册成功 → 读会话 → 提取 → 组装 → JSON 响应」整条链路。
// 这样可以在不动真实 DSH 的前提下，把 host 半的问题先挡掉。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    // 命令/工具注册走的是 `sub.commands.register` / `sub.tools.register`（属性访问），
    // 所以这里必须真的挂上属性，只放进 get() 是不够的。
    commands: services.commands,
    tools: services.tools,
    get(serviceName) {
      if (serviceName === 'webServer') return webServer
      if (serviceName === 'sessionQuery') return services.sessionQuery
      if (serviceName === 'sessionController') return services.sessionController
      if (serviceName === 'workspaceRegistry') return services.workspaceRegistry
      if (serviceName === 'sessionTitle') return services.sessionTitle
      if (serviceName === 'agentPresets') return services.agentPresets
      if (serviceName === 'agentDefaultModel') return services.agentDefaultModel
      if (serviceName === 'commands') return services.commands
      if (serviceName === 'tools') return services.tools
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

// 「继承」把源会话编号写进交接单，但新会话读不了它（会话日志是多帧 zstd）。
// session_read 就是补这一环：让新会话能按编号回查源会话。
test('session_read 工具：summary / tail / search 三种模式', async () => {
  const registered = []
  const tools = { register(spec) { registered.push(spec); return () => {} } }
  bootstrap({ sessionQuery: makeSessionQuery(sampleEvents()), tools })

  const spec = registered.find((entry) => entry.name === 'session_read')
  assert.ok(spec !== undefined, 'session_read 未注册')

  // summary：复用交接单那套锚点提取，但要更短
  const summary = await spec.execute({ sessionId: SESSION_ID, mode: 'summary' })
  assert.match(summary, /共 1 轮/)
  assert.match(summary, /## 任务目标/)
  assert.match(summary, /把 demo 的武器贴图修一下/)
  assert.match(summary, /## 改过的文件/)
  assert.match(summary, /weapon\.png\.meta/)

  // tail：最后几个有内容的事件
  const tail = await spec.execute({ sessionId: SESSION_ID, mode: 'tail', limit: 3 })
  assert.match(tail, /最后 3 个事件/)

  // search：命中 tool/result 里的报错文本
  const search = await spec.execute({ sessionId: SESSION_ID, mode: 'search', query: 'file changed' })
  assert.match(search, /命中 1/)
  assert.match(search, /file changed/)

  // 搜不到要如实说，并给替代路径，而不是返回空
  const miss = await spec.execute({ sessionId: SESSION_ID, mode: 'search', query: 'zzz-不存在-zzz' })
  assert.match(miss, /没找到/)
  assert.match(miss, /mode=tail/)

  // search 缺 query 要说清用法
  const noQuery = await spec.execute({ sessionId: SESSION_ID, mode: 'search' })
  assert.match(noQuery, /需要同时给 query/)

  // 非法 id 直接拒绝
  const bad = await spec.execute({ sessionId: 'nope' })
  assert.match(bad, /不合法/)
})

// 虚拟空间/酒馆类预设的人格绑定**不在**会话 header 里（那里永远是 standard），
// 而在宿主的 `.agent-presets/session-bindings.json`。继承时必须读出来并绑到新会话上，
// 否则新会话拿不到人格——这是用户实测发现的问题（源会话标题「开始」）。
// 绑定必须在会话空白时做：tavern 里写着"已开始的会话 agent 预设本体被 DSH 锁定"。
test('继承时把源会话的虚拟空间绑定复制到新会话', async () => {
  const bindingsPath = join(process.env.DSH_HOME, '.agent-presets', 'session-bindings.json')
  mkdirSync(dirname(bindingsPath), { recursive: true })
  writeFileSync(bindingsPath, JSON.stringify({ [SESSION_ID]: 'preset-mty5odkp-ka272v' }))

  const handlers = new Map()
  const calls = []
  const created = []
  const mounted = []
  const appended = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) })
    return { ok: true, status: 200, async json() { return { ok: true } } }
  }
  try {
    bootstrap({
      sessionQuery: makeSessionQuery(sampleEvents()),
      webServer: {
        port: 19387,
        register(route) { handlers.set(route.path, route.handler); return () => {} },
      },
      // 这条用例要走到「建子会话 → 挂预设 → 登记账本」那一步，所以 agents 服务不能缺；
      // 缺了会先在 createChild 里 500，预设相关的断言根本轮不到跑。
      agents: {
        async create(options) {
          created.push(options)
          // 真宿主会执行 setup（= 挂预设）；替身不执行就等于把挂载整条路径跳过。
          if (typeof options.setup === 'function') await options.setup({})
          return { agent: { session: { id: options.sessionId, append(_type, message) { appended.push(message) } } } }
        },
      },
      agentPresets: {
        async resolve(id) { return { id } },
        async mount(_agentCtx, id) { mounted.push(id) },
      },
    })

    const commit = await call(handlers.get(COMMIT), 'POST', { sessionId: SESSION_ID, start: false })
    assert.equal(commit.status, 200)
    // 1) 真正的人格继承发生在**会话创建时**：meta.agentPreset 必须是虚拟空间绑定值，
    //    不是 header 里的 standard。tavern 那个 HTTP 接口换不了 DSH 的预设。
    assert.equal(created.length, 1)
    assert.equal(created[0].meta.agentPreset, 'preset-mty5odkp-ka272v')
    assert.deepEqual(mounted, ['preset-mty5odkp-ka272v'], '必须真的把该预设挂到新会话上')
    // 2) 同时登记进 tavern 账本，让酒馆面板显示得对。
    assert.equal(calls.length, 1, '应该正好调一次 tavern 绑定接口')
    assert.match(calls[0].url, /\/api\/tavern\/bind-preset$/)
    assert.equal(calls[0].body.presetId, 'preset-mty5odkp-ka272v', '要绑的是源会话的绑定值，不是 header 里的 standard')
    assert.equal(calls[0].body.sessionId, commit.json.sessionId, '要登记到新建的那个会话上')
    // 3) 宿主如实回报实际结果，页脚也写成事实（而不是"打算继承"）。
    assert.equal(commit.json.preset, 'preset-mty5odkp-ka272v')
    assert.equal(commit.json.presetInherited, true)
    assert.match(JSON.stringify(appended[0]), /新会话已继承该预设/, '页脚必须写明已继承')
  } finally {
    globalThis.fetch = originalFetch
    // 必须删掉：其他用例也会走 createChild，留着会让它们去发真实请求。
    rmSync(dirname(bindingsPath), { recursive: true, force: true })
  }
})

// 没有绑定（没装酒馆类插件）时不能凭空去调接口。
test('源会话没有虚拟空间绑定时不调 tavern 接口', async () => {
  const handlers = new Map()
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => { calls.push(String(url)); return { ok: true, status: 200, async json() { return { ok: true } } } }
  try {
    // 前提要自己造：上一条用例往同一个临时 DSH_HOME 写了绑定，它失败（或单独跑本条）
    // 时残留的绑定会让这里读到别人的预设，断言就失去意义。
    rmSync(join(process.env.DSH_HOME, '.agent-presets'), { recursive: true, force: true })
    bootstrap({
      sessionQuery: makeSessionQuery(sampleEvents()),
      webServer: { port: 19387, register(route) { handlers.set(route.path, route.handler); return () => {} } },
      // 缺 agents 服务时 createChild 抛 "Cannot read properties of undefined (reading 'create')"，
      // 表现为 commit 500，把本用例真正要断言的东西整个盖住。
      agents: {
        async create(options) {
          return { agent: { session: { id: options.sessionId, append() {} } } }
        },
      },
    })
    const commit = await call(handlers.get(COMMIT), 'POST', { sessionId: SESSION_ID, start: false })
    assert.equal(commit.status, 200)
    assert.equal(calls.length, 0, '没有绑定就不该发请求')
  } finally {
    globalThis.fetch = originalFetch
  }
})

// 用户取消勾选「继承原对话预设」时：新会话用 DSH 默认预设（不传 agentPreset），
// 也不该往 tavern 账本里登记——账本说绑了、DSH 侧却没绑，比不登记更误导。
test('取消勾选继承预设时用默认预设，且不登记 tavern 账本', async () => {
  const bindingsPath = join(process.env.DSH_HOME, '.agent-presets', 'session-bindings.json')
  mkdirSync(dirname(bindingsPath), { recursive: true })
  writeFileSync(bindingsPath, JSON.stringify({ [SESSION_ID]: 'preset-mty5odkp-ka272v' }))

  const handlers = new Map()
  const calls = []
  const created = []
  const appended = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return { ok: true, status: 200, async json() { return { ok: true } } }
  }
  try {
    bootstrap({
      sessionQuery: makeSessionQuery(sampleEvents()),
      webServer: { port: 19387, register(route) { handlers.set(route.path, route.handler); return () => {} } },
      agents: {
        async create(options) {
          created.push(options)
          if (typeof options.setup === 'function') await options.setup({})
          return { agent: { session: { id: options.sessionId, append(_type, message) { appended.push(message) } } } }
        },
      },
      agentPresets: { async resolve(id) { return { id } }, async mount() {} },
    })
    const commit = await call(handlers.get(COMMIT), 'POST', { sessionId: SESSION_ID, start: false, inheritPreset: false })
    assert.equal(commit.status, 200)
    assert.equal(created[0].meta.agentPreset, undefined, '取消勾选时不该把源预设写进新会话')
    assert.equal(calls.length, 0, '取消勾选时不该登记 tavern 账本')
    assert.equal(commit.json.preset, null)
    assert.equal(commit.json.presetInherited, false)
    assert.match(JSON.stringify(appended[0]), /本次未继承/, '页脚必须写明这次没继承')
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dirname(bindingsPath), { recursive: true, force: true })
  }
})
