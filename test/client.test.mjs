// dsh-session-inherit · 客户端半加载测试
//
// client.js 是给浏览器模块系统用的经典脚本（顶层调用
// window.__ModuleLoader__.load({id, factory})）。这里用最小替身把这个契约
// 跑一遍：确认 factory 可执行、apply 会把「继承」菜单项与对话框注册到正确
// 的 slot 上。组件本身的渲染需要真实 React，不在离线测试范围内。
import test from 'node:test'
import assert from 'node:assert/strict'

const MENU_SLOT = 'sidebar.workspaces.session.menu.item'
const OVERLAY_SLOT = 'shell.overlay'

/** 最小的 React 替身：client.js 顶层只取引用，离线不渲染组件。 */
const reactStub = {
  createElement: () => null,
  useState: (initial) => [initial, () => {}],
  useEffect: () => undefined,
  Fragment: 'fragment',
}

/** 加载 client.js 并把它的 factory 结果返回。 */
async function loadClient(options = {}) {
  const react = options.react === undefined ? reactStub : options.react
  let captured = null
  const listeners = new Map()
  globalThis.window = {
    __ModuleLoader__: {
      load(spec) { captured = spec },
    },
    dispatchEvent(event) {
      const handlers = listeners.get(event && event.type)
      if (handlers !== undefined) {
        for (const handler of handlers.slice()) handler(event)
      }
      return true
    },
    setTimeout,
    clearTimeout,
    addEventListener(name, handler) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(handler)
    },
    removeEventListener(name, handler) {
      const handlers = listeners.get(name)
      if (handlers === undefined) return
      const at = handlers.indexOf(handler)
      if (at >= 0) handlers.splice(at, 1)
    },
  }
  // 带查询串的动态 import：每个用例都拿到一份全新的模块实例（否则模块体
  // 只会执行一次，captured 在第二次调用时仍是 null）。
  await import(`../client.js?case=${Math.random()}`)
  assert.ok(captured !== null, 'client.js 没有调用 __ModuleLoader__.load')
  const fakeRequire = (id) => {
    if (id === 'react') return react
    // ui-primitives 在离线环境不存在：client.js 必须自己兜住
    throw new Error(`offline: cannot resolve ${id}`)
  }
  return { spec: captured, mod: captured.factory(fakeRequire) }
}

/**
 * 有状态的 React 替身。
 *
 * 旧替身把 useState 的 setter 写成空函数、useEffect 直接丢弃，结果组件体
 * 一次都没被真正执行——「confirm 里引用了未声明的 setError，抛 ReferenceError
 * 导致 fetch 永不发出、界面永久停在『正在创建…』」这个真实故障因此完全逃过
 * 测试。这里让状态真正落盘、effect 可被手动触发，组件才能被跑起来。
 *
 * 每个组件一份独立的 hook 槽位（真实 React 按 fiber 隔离，共享会让两个组件
 * 的 useState 索引互相串位）。
 */
function createHarness() {
  const groups = new Map()
  let current = null

  /** 取（或建）某个组件的 hook 槽位。 */
  const groupFor = (component) => {
    let group = groups.get(component)
    if (group === undefined) {
      group = { slots: [], cursor: 0, effects: [] }
      groups.set(component, group)
    }
    return group
  }

  const react = {
    createElement(type, props, ...children) {
      return { type, props: props === null || props === undefined ? {} : props, children }
    },
    useState(initial) {
      const group = current
      const index = group.cursor
      group.cursor += 1
      if (group.slots[index] === undefined) group.slots[index] = { value: initial }
      const slot = group.slots[index]
      return [slot.value, (next) => {
        slot.value = typeof next === 'function' ? next(slot.value) : next
      }]
    },
    useEffect(callback) {
      current.effects.push(callback)
    },
    Fragment: 'fragment',
  }

  return {
    react,
    /** 渲染一个组件（重置该组件的 hook 游标，模拟一次重渲染）。 */
    render(component, props) {
      current = groupFor(component)
      current.cursor = 0
      return component(props)
    },
    /** 执行该组件本轮注册的 effect（模拟 React 提交阶段）。 */
    flushEffects(component) {
      const group = groupFor(component)
      const pending = group.effects.splice(0, group.effects.length)
      for (const callback of pending) callback()
    },
  }
}

/** 把 React 元素树摊平成节点数组，便于按类型/文案查找。 */
function collect(node, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out)
    return out
  }
  if (typeof node !== 'object') return out
  out.push(node)
  if (node.children !== undefined) collect(node.children, out)
  return out
}

/** 让已排队的 promise 链跑完（setImmediate 是宏任务，能清空微任务队列）。 */
function settle() {
  return new Promise((resolve) => { setImmediate(resolve) })
}

test('client.js 以 __ModuleLoader__ 协议注册，并导出 apply/inject', async () => {
  const { spec, mod } = await loadClient()
  assert.equal(spec.id, 'dsh-session-inherit')
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(mod.inject, ['slots'])
})

test('apply 把「继承」注册到会话菜单与 shell.overlay', async () => {
  const { mod } = await loadClient()
  const registered = []
  const injected = []
  const ctx = {
    get() { return undefined },
    effect(callback) { const d = callback(); return typeof d === 'function' ? d : () => {} },
    slots: {
      inject(slotName, callback) {
        injected.push(slotName)
        callback()
        return () => {}
      },
      register(options, component) {
        registered.push({ options, component })
        return () => {}
      },
    },
  }

  assert.doesNotThrow(() => mod.apply(ctx))
  assert.deepEqual(injected.sort(), [MENU_SLOT, OVERLAY_SLOT].sort())

  const menu = registered.find((entry) => entry.options.name === MENU_SLOT)
  assert.ok(menu !== undefined, '未注册会话菜单项')
  assert.equal(menu.options.id, 'session-inherit')
  assert.equal(menu.options.order, 350, '应插在分叉(300)与归档(400)之间')
  assert.equal(typeof menu.component, 'function')

  const dialog = registered.find((entry) => entry.options.name === OVERLAY_SLOT)
  assert.ok(dialog !== undefined, '未注册对话框')
  assert.equal(dialog.options.id, 'session-inherit-dialog')
})

test('ui-primitives 不可用时仍能渲染降级菜单行', async () => {
  // client.js 在 factory 执行时就把 React.createElement 取成局部 h，
  // 所以必须在加载之前替换，替换才对这个 factory 生效。
  const calls = []
  const originalCreate = reactStub.createElement
  reactStub.createElement = (type, props, ...children) => {
    calls.push({ type, props, children })
    return { type, props }
  }
  try {
    const { mod } = await loadClient()
    let menuComponent = null
    const ctx = {
      get() { return undefined },
      effect(callback) { const d = callback(); return typeof d === 'function' ? d : () => {} },
      slots: {
        inject(_slotName, callback) { callback(); return () => {} },
        register(options, component) {
          if (options.name === MENU_SLOT) menuComponent = component
          return () => {}
        },
      },
    }
    mod.apply(ctx)
    assert.equal(typeof menuComponent, 'function')

    const element = menuComponent({
      sessionId: 'session-11111111-2222-3333-4444-555555555555',
      displayTitle: '演示会话',
      useMenuOpenState: () => [true, () => {}],
    })
    assert.ok(element !== null && element !== undefined)
    // h('span') 作为 h('button') 的实参先被求值，所以这里按类型找按钮。
    const button = calls.find((entry) => entry.type === 'button')
    assert.ok(button !== undefined, '降级分支应渲染一个 button')
    assert.equal(button.props.role, 'menuitem')
    assert.match(String(button.props.style.color), /label-primary/)
  } finally {
    reactStub.createElement = originalCreate
  }
})

// ── 全链路：菜单 → preview → 对话框 → 确认 → commit ──────────────────────────
//
// 本次真实故障的回归测试。客户端点「创建并继承」时必须真的发出 commit 请求。
// 此前 InheritDialog 里 setError/setDoc/setBusy 未声明，confirm() 第一句
// setError(null) 就抛 ReferenceError，fetch 永远执行不到；而 busy 已经置 true，
// 界面就永久停在「正在创建…」。宿主日志里只留下 preview hit、没有 commit hit。
//
// 旧的 reactStub 不执行组件体，所以这条路径一次都没被覆盖过。

const SOURCE = 'session-11111111-2222-3333-4444-555555555555'
const CHILD = 'session-99999999-8888-7777-6666-555555555555'

test('点「创建并继承」必须真的发出 commit 请求（回归：未声明变量曾让它永不发出）', async () => {
  const harness = createHarness()
  const fetches = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (url, options) => {
    fetches.push({ url: String(url), options: options === undefined ? {} : options })
    if (String(url).includes('/preview')) {
      return Promise.resolve({
        json: () => Promise.resolve({
          ok: true,
          doc: '📋 会话继承单\n\n## 1. 任务目标\n演示用交接单',
          source: { sessionId: SOURCE, turns: 3, fileCount: 1, commandCount: 0, todoCount: 0 },
          route: null,
        }),
      })
    }
    return Promise.resolve({
      json: () => Promise.resolve({ ok: true, sessionId: CHILD, mode: 'appended', workspace: true }),
    })
  }

  try {
    const { mod } = await loadClient({ react: harness.react })
    let menuComponent = null
    let dialogComponent = null
    const ctx = {
      get() { return undefined },
      effect(callback) { const disposer = callback(); return typeof disposer === 'function' ? disposer : () => {} },
      slots: {
        inject(_slotName, callback) { callback(); return () => {} },
        register(options, component) {
          if (options.name === MENU_SLOT) menuComponent = component
          if (options.name === OVERLAY_SLOT) dialogComponent = component
          return () => {}
        },
      },
    }
    mod.apply(ctx)
    assert.equal(typeof menuComponent, 'function', '未拿到菜单项组件')
    assert.equal(typeof dialogComponent, 'function', '未拿到对话框组件')

    // 1) 先渲染一次对话框，让它注册 EVENT 监听（初始 detail 为 null → 什么都不渲染）。
    assert.equal(harness.render(dialogComponent), null)
    harness.flushEffects(dialogComponent)

    // 2) 点菜单项「继承」→ 必须发出 preview 请求。
    const menuTree = harness.render(menuComponent, {
      sessionId: SOURCE,
      displayTitle: '演示会话',
      useMenuOpenState: () => [true, () => {}],
    })
    const menuButton = collect(menuTree).find((node) => node.type === 'button' && node.props.role === 'menuitem')
    assert.ok(menuButton !== undefined, '未找到降级菜单按钮')
    menuButton.props.onClick()
    await settle()
    assert.equal(fetches.length, 1, '点菜单后应发出一次 preview 请求')
    assert.match(fetches[0].url, /\/__session-inherit\/preview$/)

    // 3) preview 回来后对话框应有内容（交接单被填进编辑框）。
    const dialogTree = harness.render(dialogComponent)
    assert.ok(dialogTree !== null, 'preview 成功后对话框应渲染')
    const confirmButton = collect(dialogTree)
      .find((node) => node.type === 'button' && node.children[0] === '创建并继承')
    assert.ok(confirmButton !== undefined, '未找到「创建并继承」按钮')

    // 4) 点确认：这里若引用未声明变量就会抛 ReferenceError，fetch 不发出。
    assert.doesNotThrow(() => confirmButton.props.onClick(), '点确认不应抛错')
    await settle()
    assert.equal(fetches.length, 2, '点确认后必须发出 commit 请求（只发出 preview 就是回归了）')
    assert.match(fetches[1].url, /\/__session-inherit\/commit$/)
    const commitBody = JSON.parse(fetches[1].options.body)
    assert.equal(commitBody.sessionId, SOURCE)
    assert.equal(commitBody.start, true)
    assert.match(commitBody.doc, /会话继承单/, 'commit 必须带上交接单正文（doc 状态没被填充过就是回归）')
  } finally {
    globalThis.fetch = originalFetch
  }
})
