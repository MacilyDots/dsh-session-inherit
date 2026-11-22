// dsh-session-inherit · 进程内继承服务测试
//
// 这里验证「让 degen-guard 可选调用」的那条新通路：
//   hint 不建会话 / draft 不启动 / auto 核对通过才 prompt /
//   核对失败或登记失败时同一 child 改草稿（绝不重建）/
//   onChildCreated 在任何 prompt 之前被调用（防快速熔断竞态）/
//   深度登记幂等 / 建会话超时不重试。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_SESSION_INHERIT_LOG = join(tmpdir(), 'dsh-session-inherit-service-test.log')
const tmpHome = mkdtempSync(join(tmpdir(), 'dsh-inherit-service-'))
process.env.DSH_HOME = tmpHome
process.env.DSH_SESSION_INHERIT_LOG = join(tmpHome, 'service-test.log')

const { apply, name: pluginName, inject } = await import('../index.mjs')
const { clearDepthLedger } = await import('../lib/inherit-service.mjs')

const SESSION_ID = 'session-11111111-2222-3333-4444-555555555555'
const CHILD_ID = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

function sampleEvents() {
  return [
    { type: 'turn/start', seq: 1, time: 1_700_000_000_000, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 1_700_000_001_000, data: { content: [{ type: 'text', text: '把 demo 的武器贴图修一下' }], source: { kind: 'user' } } },
    { type: 'request/header', seq: 3, time: 1_700_000_002_000, data: { header: { config: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } }, reason: 'initial' } },
  ]
}

/**
 * 造一个假 Cordis 上下文并 apply 插件，返回被 provide 的服务。
 * @param {object} options - create / prompt / append 的钩子与会话 header。
 * @returns {{service: object, calls: object, ctx: object}}
 */
function bootstrap(options = {}) {
  const calls = { created: [], prompted: [], appended: [], bindings: [] }
  const header = { id: SESSION_ID, cwd: options.cwd === undefined ? process.cwd() : options.cwd, agentPreset: options.agentPreset ?? 'standard' }
  const sessionQuery = {
    async readSession() {
      return { session: { ...header }, inheritedEventCount: 0, events: sampleEvents() }
    },
  }
  const agents = {
    async create(opts) {
      calls.created.push(opts)
      if (options.createError !== undefined) throw options.createError
      return {
        agent: {
          session: {
            id: CHILD_ID,
            append(type, data, meta) {
              if (options.appendError !== undefined) throw options.appendError
              calls.appended.push({ type, data, meta })
            },
          },
        },
      }
    },
  }
  const sessionController = options.noController ? undefined : {
    async prompt(request) {
      calls.prompted.push(request)
      if (options.promptError !== undefined) throw options.promptError
      return { accepted: true }
    },
  }
  const presets = options.noPresets ? undefined : {
    async resolve(id) { return { id } },
    async mount() {},
  }
  const services = { sessionQuery, agents, sessionController, agentPresets: presets }
  const ctx = {
    agents,
    commands: undefined,
    tools: undefined,
    get(serviceName) {
      if (serviceName === 'sessionQuery') return sessionQuery
      if (serviceName === 'agents') return agents
      if (serviceName === 'sessionController') return sessionController
      if (serviceName === 'agentPresets') return presets
      return undefined
    },
    effect(callback) { const d = callback(); return typeof d === 'function' ? d : () => {} },
    provide(serviceName, value) { services[serviceName] = value },
    inject(_names, callback) { callback(ctx) },
    on() { return () => {} },
    logger() { return { info() {}, warn() {}, error() {} } },
  }
  apply(ctx, { cacheTtlMs: 0, presetAdapter: 'none', timeoutMs: options.timeoutMs })
  return { service: services.sessionInherit, calls, ctx }
}

test('插件导出契约 + 服务通过 ctx.provide 发布', async () => {
  assert.equal(pluginName, 'dsh-session-inherit')
  assert.deepEqual(inject, ['agents'])
  clearDepthLedger()
  const { service } = bootstrap()
  assert.ok(service !== undefined, 'sessionInherit 未发布')
  assert.equal(service.name, 'sessionInherit')
  const info = service.probe()
  assert.equal(info.state, 'ready')
  assert.deepEqual(info.modes, ['hint', 'draft', 'auto'])
  assert.ok(Object.isFrozen(service))
})

test('hint 只读不建会话，返回 hinted + 建议', async () => {
  const { service, calls } = bootstrap()
  const result = await service.handoff({ sourceId: SESSION_ID, mode: 'hint' })
  assert.equal(result.ok, true)
  assert.equal(result.state, 'hinted')
  assert.equal(result.childId, null)
  assert.match(result.doc, /把 demo 的武器贴图修一下/)
  assert.equal(calls.created.length, 0)
  assert.equal(calls.prompted.length, 0)
  assert.equal(calls.appended.length, 0)
})

test('draft 建会话但 start:false：只 append，不 prompt', async () => {
  const { service, calls } = bootstrap()
  const result = await service.handoff({ sourceId: SESSION_ID, mode: 'draft' })
  assert.equal(result.state, 'draft')
  assert.equal(result.childId, CHILD_ID)
  assert.equal(calls.created.length, 1)
  assert.equal(calls.prompted.length, 0, 'draft 绝不 prompt')
  assert.equal(calls.appended.length, 1)
  assert.equal(calls.appended[0].type, 'user/message')
})

test('auto 核对通过：onChildCreated 在 prompt 之前被 await 调用', async () => {
  const sequence = []
  const { service, calls } = bootstrap()
  const result = await service.handoff({
    sourceId: SESSION_ID,
    mode: 'auto',
    parentSessionId: SESSION_ID,
    depth: 2,
    nextStep: '先跑一次 npm test',
    async onChildCreated(info) {
      sequence.push('notify')
      assert.equal(info.childId, CHILD_ID)
      assert.equal(info.depth, 2)
      assert.equal(calls.prompted.length, 0, '回调触发时绝不能已经 prompt')
      // 模拟 guard 在这里同步登记深度（子深度 = 父深度 + 1）。
      const registration = service.registerChildDepth(info.parentSessionId, info.childId, info.depth + 1)
      assert.equal(registration.registered, true)
    },
  })
  sequence.push('returned')
  assert.equal(result.state, 'started')
  assert.equal(result.childId, CHILD_ID)
  assert.equal(result.preflight.ok, true)
  assert.match(result.doc, /先跑一次 npm test/)
  assert.deepEqual(sequence, ['notify', 'returned'])
  assert.equal(calls.prompted.length, 1)
  assert.equal(calls.appended.length, 0)
  assert.equal(calls.created.length, 1, 'auto 成功只建一个 child')
})

test('onChildCreated 抛错：禁止启动，同一 child 改草稿', async () => {
  const { service, calls } = bootstrap()
  const result = await service.handoff({
    sourceId: SESSION_ID,
    mode: 'auto',
    onChildCreated() { throw new Error('depth registration failed') },
  })
  assert.equal(result.state, 'draft-fallback')
  assert.equal(result.childId, CHILD_ID)
  assert.equal(calls.created.length, 1, '绝不因登记失败重建')
  assert.equal(calls.prompted.length, 0)
  assert.equal(calls.appended.length, 1)
  assert.ok(result.warnings.some((w) => w.code === 'on-child-created-failed'))
})

test('cwd 缺失 / 不存在时 auto 改草稿，不 prompt 不重建', async () => {
  clearDepthLedger()
  const badCwd = join(tmpHome, 'definitely-missing-dir')
  const { service, calls } = bootstrap({ cwd: badCwd })
  const result = await service.handoff({ sourceId: SESSION_ID, mode: 'auto' })
  assert.equal(result.state, 'draft-fallback')
  assert.equal(result.childId, CHILD_ID)
  assert.equal(result.preflight.ok, false)
  assert.ok(result.preflight.reasons.some((r) => r.code === 'cwd-not-found'))
  assert.equal(calls.created.length, 1)
  assert.equal(calls.prompted.length, 0)
  assert.equal(calls.appended.length, 1)
})

test('预设不可用时 auto 改草稿，不 prompt 不重建', async () => {
  const { service, calls } = bootstrap({
    cwd: process.cwd(),
    agentPreset: 'custom-missing-preset',
    noPresets: true,
  })
  const result = await service.handoff({ sourceId: SESSION_ID, mode: 'auto' })
  assert.equal(result.state, 'draft-fallback')
  assert.equal(result.childId, CHILD_ID)
  assert.ok(result.preflight.reasons.some((r) => r.code === 'preset-unavailable'))
  assert.equal(calls.created.length, 1)
  assert.equal(calls.prompted.length, 0)
  assert.equal(calls.appended.length, 1)
})

test('深度登记按 childId 幂等，先到为准', async () => {
  clearDepthLedger()
  const { registerChildDepth, depthOf } = await import('../lib/inherit-service.mjs')
  const a = registerChildDepth('parent-1', 'child-1', 1)
  assert.equal(a.registered, true)
  assert.equal(a.depth, 1)
  const b = registerChildDepth('parent-2', 'child-1', 5)
  assert.equal(b.registered, false)
  assert.equal(b.parentSessionId, 'parent-1')
  assert.equal(b.depth, 1, '先到为准，后到的 depth 不覆盖')
  const record = depthOf('child-1')
  assert.equal(record.depth, 1)
  assert.equal(depthOf('nonexistent'), null)
  assert.equal(registerChildDepth('p', '', 1).registered, false)
  assert.equal(registerChildDepth('p', 'c2', -1).registered, false)
})

test('建会话超时返回 create-timeout，childId=null，不重试', async () => {
  const error = new Error('create stuck')
  error.code = 'ETIMEOUT'
  const { service, calls } = bootstrap({ createError: error, timeoutMs: { create: 100 } })
  const result = await service.handoff({ sourceId: SESSION_ID, mode: 'auto' })
  assert.equal(result.state, 'create-timeout')
  assert.equal(result.childId, null)
  assert.ok(result.warnings.some((w) => w.code === 'create-timeout'))
  assert.equal(calls.created.length, 1, '超时绝不重试建会话')
})

test('注入失败保留 childId，state=pending-injection，不重建', async () => {
  // append 抛错且没有 controller → 没有可降级的注入路径 → 已建会话必须保留。
  const { service, calls } = bootstrap({
    noController: true,
    appendError: new Error('writer held'),
  })
  const r = await service.handoff({ sourceId: SESSION_ID, mode: 'auto' })
  assert.equal(r.state, 'pending-injection')
  assert.equal(r.childId, CHILD_ID, '已建会话 id 必须返回，禁止重建')
  assert.equal(calls.created.length, 1)
  assert.match(r.note, /childId|会话已创建/)
  assert.ok(r.warnings.some((w) => w.code === 'inject-failed'))
})

test('hint 不进在途池：与 draft 同参并发也不会复用已建会话结果', async () => {
  const { service, calls } = bootstrap()
  const [hint, draft] = await Promise.all([
    service.handoff({ sourceId: SESSION_ID, mode: 'hint' }),
    service.handoff({ sourceId: SESSION_ID, mode: 'draft' }),
  ])
  assert.equal(hint.state, 'hinted')
  assert.equal(hint.childId, null, 'hint 绝不能因为撞指纹拿到 draft 的 childId')
  assert.equal(draft.state, 'draft')
  assert.equal(draft.childId, CHILD_ID)
  assert.equal(calls.created.length, 1)
})

test('并发同参数 handoff 复用同一 child（commitOnce 去重）', async () => {
  const { service, calls } = bootstrap()
  const [a, b] = await Promise.all([
    service.handoff({ sourceId: SESSION_ID, mode: 'draft', nextStep: '同一步' }),
    service.handoff({ sourceId: SESSION_ID, mode: 'draft', nextStep: '同一步' }),
  ])
  assert.equal(a.childId, CHILD_ID)
  assert.equal(b.childId, a.childId)
  assert.equal(calls.created.length, 1, '并发同参数只能建一个 child')
})
