/* dsh-session-inherit — 客户端半（Client half）
 *
 * 两件事：
 *   1. 往会话行「…」菜单里加一行「继承」（官方 slot
 *      `sidebar.workspaces.session.menu.item`，order 350，插在「分叉」和「归档」之间）；
 *   2. 一个预览对话框（`shell.overlay`）：显示机械提取出的交接单，可编辑，
 *      确认后由宿主新建会话，然后自动打开它。
 *
 * 判定与提取全在宿主侧（宿主才拿得到冷会话的完整日志）；这里只管 UI 和跳转。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-inherit',
  factory: (require) => {
    var React = require('react')
    var h = React.createElement

    var primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch (error) {
      primitives = null
    }
    var iconsModule = null
    try {
      iconsModule = require('@deepseek-ai/dsh-client-ui-primitives/icons')
    } catch (error) {
      iconsModule = null
    }

    var NS = 'session-inherit'
    var MENU_SLOT = 'sidebar.workspaces.session.menu.item'
    var OVERLAY_SLOT = 'shell.overlay'
    var MENU_ID = 'session-inherit'
    var DIALOG_ID = 'session-inherit-dialog'
    var EVENT = 'dsh-session-inherit:open'
    var PREVIEW_URL = '/__session-inherit/preview'
    var COMMIT_URL = '/__session-inherit/commit'

    // ── 文案 ──────────────────────────────────────────────────────────────
    var zhDict = {
      'menu.inherit': '继承',
      'menu.busy': '继承（读取中…）',
      'dialog.title': '继承会话',
      'dialog.loading': '正在读取源会话并提取交接单…',
      'dialog.desc': '新建一个空会话，只把下面这份交接单作为首条消息带过去；旧对话历史不会被复制。',
      'dialog.source': '源会话',
      'dialog.stats': '共 {turns} 轮 · 文件 {files} 个 · 命令 {commands} 条 · 待办 {todos} 条',
      'dialog.docLabel': '交接单（可直接编辑；在「## 7. 下一步」下面写你要接着做的事）',
      'dialog.start': '创建后立即开始工作（把交接单作为首条消息发出）',
      'dialog.cancel': '取消',
      'dialog.cancelWhileBusy': '停止等待',
      'dialog.confirm': '创建并继承',
      'dialog.confirming': '正在创建…',
      'dialog.error': '继承失败',
      'dialog.nextStepHint': '提示：交接单里的「下一步」越具体越好（点名文件 + 一个动作）。',
    }
    var enDict = {
      'menu.inherit': 'Inherit',
      'menu.busy': 'Inherit (reading…)',
      'dialog.title': 'Inherit session',
      'dialog.loading': 'Reading the source session and extracting the handoff…',
      'dialog.desc': 'Creates a blank session carrying only the handoff below as its first message. No old history is copied.',
      'dialog.source': 'Source session',
      'dialog.stats': '{turns} turns · {files} files · {commands} commands · {todos} todos',
      'dialog.docLabel': 'Handoff (editable; write what to do next under "## 7. 下一步")',
      'dialog.start': 'Start working immediately (send the handoff as the first message)',
      'dialog.cancel': 'Cancel',
      'dialog.cancelWhileBusy': 'Stop waiting',
      'dialog.confirm': 'Create and inherit',
      'dialog.confirming': 'Creating…',
      'dialog.error': 'Inherit failed',
      'dialog.nextStepHint': 'Tip: the more specific the "next step" (a named file plus one action), the better.',
    }

    var locale = null

    function fallbackLang() {
      if (typeof navigator === 'undefined') return 'zh'
      var tags = (navigator.languages || []).concat([navigator.language])
      for (var i = 0; i < tags.length; i += 1) {
        var primary = String(tags[i] || '').toLowerCase().split('-')[0]
        if (primary === 'zh' || primary === 'en') return primary
      }
      return 'zh'
    }

    function t(key, vars) {
      var text
      if (locale !== null && typeof locale.bind === 'function') {
        try {
          var translate = locale.bind(NS)
          if (typeof translate === 'function') text = translate(key)
        } catch (error) {
          text = undefined
        }
      }
      if (typeof text !== 'string' || text === key) {
        var dict = fallbackLang() === 'en' ? enDict : zhDict
        text = dict[key] !== undefined ? dict[key] : key
      }
      if (vars !== undefined && vars !== null) {
        text = text.replace(/\{(\w+)\}/g, function (match, name) {
          return vars[name] !== undefined ? String(vars[name]) : match
        })
      }
      return text
    }

    function useLocaleRevision() {
      var pair = React.useState(0)
      React.useEffect(function () {
        if (locale === null || typeof locale.subscribe !== 'function') return undefined
        return locale.subscribe(function () {
          pair[1](function (v) { return v + 1 })
        })
      }, [])
    }

    // ── 菜单行 ────────────────────────────────────────────────────────────

    function pickIcon() {
      var sources = [iconsModule, primitives]
      var names = ['IconContextInjectionOutlineRegular', 'IconBranchOutlineRegular']
      for (var i = 0; i < sources.length; i += 1) {
        var source = sources[i]
        if (source === null || source === undefined) continue
        for (var j = 0; j < names.length; j += 1) {
          if (typeof source[names[j]] === 'function') return source[names[j]]
        }
      }
      return null
    }

    function menuRowStyle(color) {
      return {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        padding: '6px 12px',
        border: 'none',
        background: 'transparent',
        color: color,
        font: 'inherit',
        fontSize: 13,
        lineHeight: '20px',
        textAlign: 'left',
        borderRadius: 6,
        cursor: 'pointer',
      }
    }

    /** 防止连点重复发起 preview；菜单行随菜单关闭而卸载，所以状态放模块级。 */
    var previewInFlight = false

    function InheritMenuItem(props) {
      useLocaleRevision()
      var sessionId = props.sessionId
      var displayTitle = props.displayTitle
      var useMenuOpenState = props.useMenuOpenState

      // hook 必须在渲染期调用：这里取一次 setter，事件处理器只调用它。
      var menuState = typeof useMenuOpenState === 'function' ? useMenuOpenState() : null
      var setMenuOpen = Array.isArray(menuState) && typeof menuState[1] === 'function' ? menuState[1] : null

      var closeMenu = function () {
        if (setMenuOpen !== null) setMenuOpen(false)
      }

      var dispatch = function (detail) {
        window.dispatchEvent(new CustomEvent(EVENT, { detail: detail }))
      }

      var onSelect = function () {
        closeMenu()
        if (previewInFlight) return
        previewInFlight = true
        dispatch({ phase: 'loading', sessionId: sessionId, title: displayTitle })
        fetch(PREVIEW_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: sessionId, title: displayTitle }),
        })
          .then(function (response) { return response.json() })
          .then(function (data) {
            previewInFlight = false
            if (data === null || typeof data !== 'object' || data.ok !== true) {
              dispatch({
                phase: 'error',
                sessionId: sessionId,
                title: displayTitle,
                error: data !== null && typeof data === 'object' && data.error ? data.error : '未知错误',
              })
              return
            }
            dispatch({
              phase: 'ready',
              sessionId: sessionId,
              title: displayTitle,
              doc: data.doc,
              source: data.source,
              route: data.route,
            })
          })
          .catch(function (error) {
            previewInFlight = false
            dispatch({
              phase: 'error',
              sessionId: sessionId,
              title: displayTitle,
              error: String(error && error.message ? error.message : error),
            })
          })
      }

      var label = t('menu.inherit')
      var Icon = pickIcon()

      if (primitives !== null && typeof primitives.MenuItemButton === 'function') {
        return h(primitives.MenuItemButton, {
          icon: Icon === null ? undefined : h(Icon, {}),
          onSelect: onSelect,
          children: label,
        })
      }
      return h('button', {
        type: 'button',
        role: 'menuitem',
        onClick: onSelect,
        style: menuRowStyle('var(--dsw-alias-label-primary, inherit)'),
      }, Icon === null ? null : h(Icon, { size: 16 }), h('span', null, label))
    }

    // ── 预览对话框 ────────────────────────────────────────────────────────

    function statLine(source) {
      if (source === null || typeof source !== 'object') return ''
      return t('dialog.stats', {
        turns: source.turns !== undefined ? source.turns : 0,
        files: source.fileCount !== undefined ? source.fileCount : 0,
        commands: source.commandCount !== undefined ? source.commandCount : 0,
        todos: source.todoCount !== undefined ? source.todoCount : 0,
      })
    }

    function InheritDialog() {
      useLocaleRevision()
      var statePair = React.useState(null)
      var detail = statePair[0]
      var setDetail = statePair[1]
      var docPair = React.useState('')
      var doc = docPair[0]
      var setDoc = docPair[1]
      var startPair = React.useState(true)
      var start = startPair[0]
      var setStart = startPair[1]
      var busyPair = React.useState(false)
      var busy = busyPair[0]
      var setBusy = busyPair[1]
      var errorPair = React.useState(null)
      var error = errorPair[0]
      var setError = errorPair[1]

      React.useEffect(function () {
        var handler = function (event) {
          var next = event && event.detail ? event.detail : {}
          setDetail(next)
          setError(next.phase === 'error' ? next.error : null)
          setDoc(typeof next.doc === 'string' ? next.doc : '')
          setBusy(false)
        }
        window.addEventListener(EVENT, handler)
        return function () { window.removeEventListener(EVENT, handler) }
      }, [])

      // 取消永远可用：它只让本界面停止等待，不会中断宿主侧已经发出的请求。
      // （曾经的 bug：busy 时这里直接 return，用户被永久锁在对话框里。）
      var close = function () {
        setDetail(null)
        setError(null)
        setBusy(false)
      }

      var confirm = function () {
        if (busy === true || detail === null) return
        if (typeof detail.sessionId !== 'string') return
        setBusy(true)
        setError(null)
        // 宿主侧若卡住，界面不能跟着无限等：90 秒后放弃等待并如实说明。
        var abort = new AbortController()
        var timer = window.setTimeout(function () { abort.abort() }, 90000)
        fetch(COMMIT_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: detail.sessionId,
            title: detail.title,
            doc: doc,
            start: start,
          }),
          signal: abort.signal,
        })
          .then(function (response) { return response.json() })
          .then(function (data) {
            window.clearTimeout(timer)
            setBusy(false)
            if (data === null || typeof data !== 'object' || data.ok !== true) {
              setError(data !== null && typeof data === 'object' && data.error ? data.error : '未知错误')
              return
            }
            if (data.mode !== 'prompted') {
              console.warn('[dsh-session-inherit] ' + String(data.note || data.mode))
            }
            setDetail(null)
            openWhenReady(data.sessionId)
          })
          .catch(function (err) {
            window.clearTimeout(timer)
            setBusy(false)
            var message = String(err && err.message ? err.message : err)
            if (err && err.name === 'AbortError') {
              message = '宿主 90 秒未响应（会话可能已经建好但没返回）。先刷新会话列表看看侧边栏有没有「继承: …」；没有的话把这一条告诉我。'
            }
            setError(message)
          })
      }

      if (detail === null) return null

      var Modal = primitives !== null ? primitives.Modal : null
      var source = detail.source
      var headText = ''
      if (source !== null && typeof source === 'object') {
        headText = (source.title ? source.title + ' · ' : '') + source.sessionId + ' · ' + statLine(source)
      } else if (typeof detail.title === 'string') {
        headText = detail.title
      }

      var body = []
      body.push(h('div', {
        key: 'meta',
        style: {
          color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
          fontSize: 12,
          lineHeight: '18px',
          marginBottom: 10,
          wordBreak: 'break-all',
        },
      }, headText))

      if (detail.phase === 'loading') {
        body.push(h('div', {
          key: 'loading',
          style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary, #8a8a8e)' },
        }, t('dialog.loading')))
      } else if (error !== null && detail.phase === 'error') {
        body.push(h('div', {
          key: 'err',
          role: 'alert',
          style: { fontSize: 13, color: 'var(--dsw-alias-state-error-primary, #e5484d)' },
        }, error))
      } else if (detail.phase === 'ready') {
        body.push(h('label', {
          key: 'docLabel',
          style: { display: 'block', fontSize: 12, color: 'var(--dsw-alias-label-secondary, #8a8a8e)', marginBottom: 6 },
        }, t('dialog.docLabel')))
        body.push(h('textarea', {
          key: 'doc',
          value: doc,
          spellCheck: false,
          onChange: function (event) { setDoc(event.target.value) },
          style: {
            width: '100%',
            minHeight: '44vh',
            maxHeight: '58vh',
            resize: 'vertical',
            boxSizing: 'border-box',
            padding: 10,
            borderRadius: 8,
            border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
            background: 'var(--dsw-alias-bg-base, transparent)',
            color: 'var(--dsw-alias-label-primary, inherit)',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            fontSize: 12,
            lineHeight: '18px',
            whiteSpace: 'pre',
            overflow: 'auto',
          },
        }))
        body.push(h('label', {
          key: 'start',
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginTop: 10,
            fontSize: 13,
            lineHeight: '20px',
            color: 'var(--dsw-alias-label-primary, inherit)',
          },
        }, h('input', {
          type: 'checkbox',
          checked: start,
          disabled: busy === true,
          onChange: function (event) { setStart(event.target.checked) },
        }), t('dialog.start')))
        body.push(h('div', {
          key: 'hint',
          style: { marginTop: 8, fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #8a8a8e)' },
        }, t('dialog.nextStepHint')))
        if (error !== null) {
          body.push(h('div', {
            key: 'err2',
            role: 'alert',
            style: { marginTop: 8, fontSize: 12, color: 'var(--dsw-alias-state-error-primary, #e5484d)' },
          }, error))
        }
      }

      var footer = []
      footer.push(h('button', {
        key: 'cancel',
        type: 'button',
        onClick: close,
        style: {
          padding: '6px 14px',
          marginRight: 8,
          borderRadius: 8,
          border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
          background: 'transparent',
          color: 'var(--dsw-alias-label-primary, inherit)',
          fontSize: 13,
          cursor: 'pointer',
        },
      }, busy === true ? t('dialog.cancelWhileBusy') : t('dialog.cancel')))
      if (detail.phase === 'ready') {
        footer.push(h('button', {
          key: 'confirm',
          type: 'button',
          disabled: busy === true,
          onClick: confirm,
          style: {
            padding: '6px 14px',
            borderRadius: 8,
            border: '1px solid var(--dsw-alias-brand-primary, #4d6bfe)',
            background: 'var(--dsw-alias-brand-primary, #4d6bfe)',
            color: '#fff',
            fontSize: 13,
            cursor: busy === true ? 'default' : 'pointer',
            opacity: busy === true ? 0.6 : 1,
          },
        }, busy === true ? t('dialog.confirming') : t('dialog.confirm')))
      }

      var title = t('dialog.title')
      var description = detail.phase === 'error' ? t('dialog.error') : t('dialog.desc')

      if (Modal === null) {
        return h('div', {
          style: {
            position: 'fixed',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,.45)',
            pointerEvents: 'auto',
            zIndex: 9999,
          },
        }, h('div', {
          style: {
            width: 'min(860px, 92vw)',
            maxHeight: '86vh',
            overflow: 'auto',
            padding: 18,
            borderRadius: 12,
            background: 'var(--dsw-alias-bg-elevated, #1e1e1f)',
            color: 'var(--dsw-alias-label-primary, inherit)',
            pointerEvents: 'auto',
          },
        }, h('div', { style: { fontSize: 15, marginBottom: 8 } }, title), body, h('div', { style: { marginTop: 14 } }, footer)))
      }

      return h(Modal, {
        open: true,
        onClose: close,
        title: title,
        closeLabel: t('dialog.cancel'),
        description: description,
        footer: footer,
      }, body)
    }

    // ── 打开新会话 ────────────────────────────────────────────────────────

    var rootCtx = null

    function lookup(name) {
      if (rootCtx === null || typeof rootCtx.get !== 'function') return null
      try {
        return rootCtx.get(name) || null
      } catch (error) {
        return null
      }
    }

    /**
     * 宿主刚建的会话要等客户端目录刷新才可寻址：先轮询，再打开。
     * @param {string} sessionId - 新会话 id。
     */
    function openWhenReady(sessionId) {
      var attempts = 0
      var attempt = function () {
        attempts += 1
        var sessions = lookup('sessions')
        var ready = true
        if (sessions !== null && typeof sessions.binding === 'function') {
          try {
            ready = sessions.binding(sessionId) !== undefined
          } catch (error) {
            ready = true
          }
        }
        if (ready === true || attempts > 12) {
          var ui = lookup('uiWorkspace')
          if (ui !== null && typeof ui.openSession === 'function') {
            ui.openSession(sessionId)
          } else {
            var raw = lookup('sessions')
            if (raw !== null && typeof raw.open === 'function') raw.open(sessionId)
          }
          return
        }
        window.setTimeout(attempt, 400)
      }
      attempt()
    }

    // ── 挂载 ──────────────────────────────────────────────────────────────

    function apply(ctx) {
      rootCtx = ctx
      var localeService = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
      if (localeService !== undefined && localeService !== null) {
        locale = localeService
        try {
          ctx.effect(function () {
            return localeService.register(NS, { zh: zhDict, en: enDict })
          })
        } catch (error) {
          /* 命名空间已存在：沿用已有文案 */
        }
        if (typeof localeService.register !== 'function') locale = null
      }

      ctx.slots.inject(MENU_SLOT, function () {
        return ctx.slots.register({
          name: MENU_SLOT,
          id: MENU_ID,
          order: 350,
          locale: NS,
        }, InheritMenuItem)
      })

      ctx.slots.inject(OVERLAY_SLOT, function () {
        return ctx.slots.register({
          name: OVERLAY_SLOT,
          id: DIALOG_ID,
          order: 60,
          locale: NS,
        }, InheritDialog)
      })
    }

    return { apply: apply, inject: ['slots'] }
  },
})
