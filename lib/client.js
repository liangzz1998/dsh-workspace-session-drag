/**
 * dsh-workspace-session-drag — 浏览器半侧
 *
 * 在侧栏里监听会话行的原生拖拽：
 *   · 拖动会话到另一个工作区的分组上（悬停高亮）
 *   · 松开后弹出确认框：「是否将《会话》从《工作区 A》移动到《工作区 B》？」
 *   · 确认后 POST 给宿主半侧完成移动；宿主即时刷新注册表，界面自动更新
 *
 * 同组拖拽保持 DSH 自带的“工作区内排序”行为，不弹框。
 */
window.__ModuleLoader__.load({
  id: 'dsh-workspace-session-drag',
  factory: () => {
    var module = { exports: {} }
    var NS = 'dsh-workspace-session-drag'
    var ROUTE = '/dsh-workspace-drag'
    var CSS_ID = NS + '-css'
    var DROP_CLASS = 'dsh-wsd-drop'
    var inject = []

    var state = {
      dragging: null,
      hover: null,
      meta: null,
      metaPromise: null,
      dialog: null,
      installed: false,
      pointer: null,
      scrollEl: null,
      scrollRaf: null,
    }

    /* ------------------------------- CSS ------------------------------- */
    var CSS = [
      '.dsh-wsd-overlay{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);backdrop-filter:blur(2px)}',
      '.dsh-wsd-dialog{width:440px;max-width:calc(100vw - 48px);background:var(--dsw-alias-bg-layer-2,#20242c);color:var(--dsw-alias-label-primary,#e6e6e6);border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:14px;box-shadow:0 18px 48px rgba(0,0,0,.45);padding:18px 20px 16px;font-size:13px;line-height:1.6}',
      '.dsh-wsd-title{font-size:15px;font-weight:600;margin-bottom:10px}',
      '.dsh-wsd-body{color:var(--dsw-alias-label-primary,#e6e6e6)}',
      '.dsh-wsd-body b{color:var(--dsw-alias-state-business-primary,#6ea8fe);font-weight:600}',
      '.dsh-wsd-hint{margin-top:8px;font-size:12px;color:var(--dsw-alias-label-tertiary,#8b93a1)}',
      '.dsh-wsd-error{margin-top:10px;font-size:12px;color:var(--dsw-alias-state-error-primary,#ff6b6b);white-space:pre-wrap;display:none}',
      '.dsh-wsd-actions{margin-top:16px;display:flex;justify-content:flex-end;gap:8px}',
      '.dsh-wsd-btn{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.06));color:inherit;border-radius:8px;padding:6px 16px;font:inherit;font-size:13px;cursor:pointer}',
      '.dsh-wsd-btn:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary,#6ea8fe)}',
      '.dsh-wsd-btn:disabled{opacity:.55;cursor:default}',
      '.dsh-wsd-primary{background:var(--dsw-alias-state-business-primary,#3964fe);border-color:transparent;color:#fff}',
      '.dsh-wsd-primary:hover:not(:disabled){filter:brightness(1.08)}',
      '.dsh-wsd-toast{position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:100000;max-width:min(520px,90vw);padding:10px 16px;border-radius:10px;font-size:13px;line-height:1.5;color:#fff;background:rgba(30,34,42,.96);border:1px solid rgba(255,255,255,.14);box-shadow:0 10px 30px rgba(0,0,0,.4);opacity:0;transition:opacity .18s ease, transform .18s ease;pointer-events:none}',
      '.dsh-wsd-toast.show{opacity:1;transform:translateX(-50%) translateY(-4px)}',
      '.dsh-wsd-toast.error{border-color:rgba(255,107,107,.5);color:#ffd7d7}',
      '.' + DROP_CLASS + '{outline:2px dashed var(--dsw-alias-state-business-primary,#6ea8fe);outline-offset:-2px;border-radius:8px;background:rgba(110,168,254,.08)}',
    ].join('\n')

    function ensureCss() {
      if (document.getElementById(CSS_ID)) return
      var tag = document.createElement('style')
      tag.id = CSS_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /* ----------------------------- helpers ----------------------------- */
    function rowKeyOf(element, prefix) {
      if (!element || !element.getAttribute) return null
      var key = element.getAttribute('data-row-key')
      if (typeof key !== 'string' || key.indexOf(prefix) !== 0) return null
      return key.slice(prefix.length)
    }

    /** 会话行 → 它所在的工作区分组 { el, workspaceId }。 */
    function groupOfSessionRow(row) {
      var group = row.closest && row.closest('[class*="groupSection"]')
      if (!group) return null
      var workspaceRow = group.querySelector('[data-row-key^="workspace:"]')
      if (!workspaceRow) return null
      var workspaceId = rowKeyOf(workspaceRow, 'workspace:')
      if (!workspaceId) return null
      return { el: group, workspaceId: workspaceId }
    }

    /** 鼠标位置 → 工作区分组（嵌套时取最内层）。 */
    function findGroupAt(x, y) {
      var elements = []
      try {
        elements = document.elementsFromPoint ? document.elementsFromPoint(x, y) : [document.elementFromPoint(x, y)]
      } catch { return null }
      for (var i = 0; i < elements.length; i++) {
        var element = elements[i]
        if (!element || !element.closest) continue
        var workspaceId = rowKeyOf(element, 'workspace:')
        if (workspaceId !== null) {
          var group = element.closest('[class*="groupSection"]')
          if (group) return { el: group, workspaceId: workspaceId }
          continue
        }
        var containingGroup = element.closest('[class*="groupSection"]')
        if (containingGroup) {
          var workspaceRow = containingGroup.querySelector('[data-row-key^="workspace:"]')
          var id = workspaceRow ? rowKeyOf(workspaceRow, 'workspace:') : null
          if (id) return { el: containingGroup, workspaceId: id }
        }
      }
      return null
    }

    function groupTitle(groupEl) {
      var workspaceRow = groupEl && groupEl.querySelector('[data-row-key^="workspace:"]')
      if (!workspaceRow) return ''
      var text = (workspaceRow.textContent || '').replace(/\s+/g, ' ').trim()
      return text.slice(0, 40)
    }

    function sessionTitleFromDom(sessionId) {
      var row = document.querySelector('[data-row-key="session:' + sessionId + '"]')
      if (!row) return ''
      var titleNode = row.querySelector('[class*="title"]') || row
      var text = (titleNode.textContent || '').replace(/\s+/g, ' ').trim()
      return text.slice(0, 60)
    }

    function workspaceTitle(workspaceId) {
      var meta = state.meta
      if (meta && Array.isArray(meta.workspaces)) {
        var found = meta.workspaces.find(function (w) { return w.id === workspaceId })
        if (found && found.title) return found.title
      }
      var workspaceRow = document.querySelector('[data-row-key="workspace:' + workspaceId + '"]')
      return workspaceRow ? groupTitle(workspaceRow.closest('[class*="groupSection"]')) : ''
    }

    function sessionTitle(sessionId) {
      var meta = state.meta
      if (meta && meta.sessions && meta.sessions[sessionId] && meta.sessions[sessionId].title) {
        return meta.sessions[sessionId].title
      }
      return sessionTitleFromDom(sessionId) || sessionId
    }

    function loadMeta() {
      if (state.metaPromise) return state.metaPromise
      state.metaPromise = fetch(ROUTE + '/state', { credentials: 'same-origin', cache: 'no-store' })
        .then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status)
          return response.json()
        })
        .then(function (json) {
          if (json && json.ok) state.meta = json
          return state.meta
        })
        .catch(function () {
          state.metaPromise = null
          return null
        })
      return state.metaPromise
    }

    /* --------------------------- highlight ----------------------------- */
    function clearHighlight() {
      var nodes = document.querySelectorAll('.' + DROP_CLASS)
      for (var i = 0; i < nodes.length; i++) nodes[i].classList.remove(DROP_CLASS)
      state.hover = null
    }
    function setHighlight(target) {
      if (state.hover && state.hover.el === target.el) return
      clearHighlight()
      target.el.classList.add(DROP_CLASS)
      state.hover = target
    }

    /* ------------------------- auto scroll on drag ---------------------- */
    var SCROLL_EDGE = 84
    var SCROLL_MAX_STEP = 22

    /** 从拖拽源向上找真正的滚动容器（不依赖具体 class）。 */
    function findScrollableAncestor(element) {
      var node = element
      while (node && node !== document.body && node !== document.documentElement) {
        try {
          var style = window.getComputedStyle ? window.getComputedStyle(node) : null
          var overflowY = style ? style.overflowY : ''
          if ((overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') &&
              node.scrollHeight > node.clientHeight + 4) {
            return node
          }
        } catch (error) { /* 忽略 */ }
        node = node.parentElement
      }
      return null
    }

    /** 距离边缘越近，每一步滚得越快（2 ~ 22px/帧）。 */
    function scrollStepFor(distance) {
      var ratio = Math.min(1, Math.max(0, distance / SCROLL_EDGE))
      return Math.max(2, Math.round(ratio * ratio * SCROLL_MAX_STEP))
    }

    function updateHoverFromPointer() {
      if (!state.dragging || !state.pointer) return
      var target = findGroupAt(state.pointer.x, state.pointer.y)
      if (!target || !target.workspaceId || target.workspaceId === state.dragging.fromWorkspaceId) {
        clearHighlight()
        return
      }
      setHighlight(target)
    }

    function autoScrollTick() {
      state.scrollRaf = null
      var element = state.scrollEl
      var pointer = state.pointer
      if (!element || !state.dragging || !pointer) return
      var rect
      try { rect = element.getBoundingClientRect() } catch (error) { return }
      if (!rect || !(rect.height > 0)) return
      /* 指针离开侧栏滚动区（比如拖到聊天区）就不滚 */
      if (pointer.x < rect.left - 40 || pointer.x > rect.right + 40) return
      if (pointer.y < rect.top - 40 || pointer.y > rect.bottom + 40) return
      var delta = 0
      if (pointer.y < rect.top + SCROLL_EDGE) {
        delta = -scrollStepFor(rect.top + SCROLL_EDGE - pointer.y)
      } else if (pointer.y > rect.bottom - SCROLL_EDGE) {
        delta = scrollStepFor(pointer.y - (rect.bottom - SCROLL_EDGE))
      }
      if (!delta) return
      var before = element.scrollTop
      element.scrollTop = before + delta
      if (element.scrollTop === before) return /* 到底/到顶：等下一次 dragover 再判断 */
      updateHoverFromPointer()
      state.scrollRaf = requestAnimationFrame(autoScrollTick)
    }

    function ensureAutoScroll() {
      if (state.scrollRaf !== null) return
      if (!state.scrollEl || !state.dragging) return
      state.scrollRaf = requestAnimationFrame(autoScrollTick)
    }

    function stopAutoScroll() {
      if (state.scrollRaf !== null) {
        try { cancelAnimationFrame(state.scrollRaf) } catch (error) { /* 忽略 */ }
        state.scrollRaf = null
      }
      state.scrollEl = null
      state.pointer = null
    }

    /* ----------------------------- dialog ------------------------------ */
    function toast(message, isError) {
      var node = document.createElement('div')
      node.className = 'dsh-wsd-toast' + (isError ? ' error' : '')
      node.textContent = message
      document.body.appendChild(node)
      requestAnimationFrame(function () { node.classList.add('show') })
      setTimeout(function () {
        node.classList.remove('show')
        setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node) }, 250)
      }, isError ? 5200 : 2800)
    }

    function closeDialog() {
      if (state.dialog && state.dialog.parentNode) state.dialog.parentNode.removeChild(state.dialog)
      state.dialog = null
      state.dragging = null
    }

    function openConfirm(drag, targetWorkspaceId, targetGroupEl) {
      var fromTitle = workspaceTitle(drag.fromWorkspaceId) || drag.fromTitle || drag.fromWorkspaceId
      var toTitle = workspaceTitle(targetWorkspaceId) || groupTitle(targetGroupEl) || targetWorkspaceId
      var sessionName = sessionTitle(drag.sessionId) || drag.sessionTitle || drag.sessionId

      var overlay = document.createElement('div')
      overlay.className = 'dsh-wsd-overlay'
      var dialog = document.createElement('div')
      dialog.className = 'dsh-wsd-dialog'
      dialog.innerHTML = ''
      var title = document.createElement('div')
      title.className = 'dsh-wsd-title'
      title.textContent = '移动会话'
      var body = document.createElement('div')
      body.className = 'dsh-wsd-body'
      body.appendChild(document.createTextNode('是否将 '))
      var bSession = document.createElement('b'); bSession.textContent = '《' + sessionName + '》'
      body.appendChild(bSession)
      body.appendChild(document.createTextNode(' 从 '))
      var bFrom = document.createElement('b'); bFrom.textContent = '《' + fromTitle + '》'
      body.appendChild(bFrom)
      body.appendChild(document.createTextNode(' 移动到 '))
      var bTo = document.createElement('b'); bTo.textContent = '《' + toTitle + '》'
      body.appendChild(bTo)
      body.appendChild(document.createTextNode(' ？'))
      var hint = document.createElement('div')
      hint.className = 'dsh-wsd-hint'
      hint.textContent = '会话日志与归属会一起切换，移动前自动备份。正在运行的会话不能移动。'
      var error = document.createElement('div')
      error.className = 'dsh-wsd-error'
      var actions = document.createElement('div')
      actions.className = 'dsh-wsd-actions'
      var cancel = document.createElement('button')
      cancel.className = 'dsh-wsd-btn'
      cancel.textContent = '取消'
      var ok = document.createElement('button')
      ok.className = 'dsh-wsd-btn dsh-wsd-primary'
      ok.textContent = '移动'

      dialog.appendChild(title)
      dialog.appendChild(body)
      dialog.appendChild(hint)
      dialog.appendChild(error)
      dialog.appendChild(actions)
      actions.appendChild(cancel)
      actions.appendChild(ok)
      overlay.appendChild(dialog)
      document.body.appendChild(overlay)
      state.dialog = overlay
      ok.focus()

      function finish() { closeDialog() }
      cancel.addEventListener('click', finish)
      overlay.addEventListener('click', function (event) { if (event.target === overlay) finish() })
      var esc = function (event) { if (event.key === 'Escape') { document.removeEventListener('keydown', esc, true); finish() } }
      document.addEventListener('keydown', esc, true)

      ok.addEventListener('click', function () {
        ok.disabled = true
        cancel.disabled = true
        ok.textContent = '移动中…'
        error.style.display = 'none'
        fetch(ROUTE + '/move', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: drag.sessionId, targetWorkspaceId: targetWorkspaceId }),
        }).then(function (response) {
          return response.json().catch(function () { return { ok: false, error: { message: '宿主返回了非 JSON 响应' } } })
        }).then(function (json) {
          if (json && json.ok) {
            document.removeEventListener('keydown', esc, true)
            closeDialog()
            var message = '已移动到《' + (json.to && json.to.title ? json.to.title : toTitle) + '》'
            if (json.instant === false) message += '，重启 DSH 后生效'
            toast(message, false)
          } else {
            ok.disabled = false
            cancel.disabled = false
            ok.textContent = '移动'
            error.style.display = 'block'
            error.textContent = (json && json.error && json.error.message) || '移动失败：宿主没有返回原因'
          }
        }).catch(function (failure) {
          ok.disabled = false
          cancel.disabled = false
          ok.textContent = '移动'
          error.style.display = 'block'
          error.textContent = '无法连接宿主半侧：' + (failure && failure.message ? failure.message : String(failure))
        })
      })
    }

    /* ---------------------------- listeners ---------------------------- */
    function onDragStart(event) {
      try {
        var row = event.target && event.target.closest ? event.target.closest('[data-row-key^="session:"]') : null
        if (!row) { state.dragging = null; return }
        var sessionId = rowKeyOf(row, 'session:')
        var group = groupOfSessionRow(row)
        if (!sessionId || !group) { state.dragging = null; return }
        state.dragging = {
          sessionId: sessionId,
          fromWorkspaceId: group.workspaceId,
          fromTitle: groupTitle(group.el),
          sessionTitle: sessionTitleFromDom(sessionId),
        }
        state.pointer = { x: event.clientX, y: event.clientY }
        state.scrollEl = findScrollableAncestor(row)
        ensureAutoScroll()
        loadMeta()
      } catch (error) {
        state.dragging = null
      }
    }

    function onDragOver(event) {
      if (!state.dragging) return
      try {
        state.pointer = { x: event.clientX, y: event.clientY }
        ensureAutoScroll()
        var target = findGroupAt(event.clientX, event.clientY)
        if (!target || !target.workspaceId || target.workspaceId === state.dragging.fromWorkspaceId) {
          clearHighlight()
          return
        }
        event.preventDefault()
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
        setHighlight(target)
      } catch (error) { /* 拖拽过程中忽略 */ }
    }

    function onDrop(event) {
      stopAutoScroll()
      if (!state.dragging) return
      try {
        var target = findGroupAt(event.clientX, event.clientY)
        if (!target || !target.workspaceId) return
        if (target.workspaceId === state.dragging.fromWorkspaceId) return
        event.preventDefault()
        event.stopPropagation()
        var drag = state.dragging
        var targetEl = target.el
        var targetId = target.workspaceId
        clearHighlight()
        state.dragging = null
        loadMeta()
        openConfirm(drag, targetId, targetEl)
      } catch (error) { /* 忽略 */ }
    }

    function onDragEnd() {
      stopAutoScroll()
      clearHighlight()
      state.dragging = null
    }

    function install() {
      if (state.installed) return
      state.installed = true
      ensureCss()
      document.addEventListener('dragstart', onDragStart, false)
      document.addEventListener('dragover', onDragOver, false)
      document.addEventListener('drop', onDrop, true)
      document.addEventListener('dragend', onDragEnd, false)
    }

    function uninstall() {
      state.installed = false
      document.removeEventListener('dragstart', onDragStart, false)
      document.removeEventListener('dragover', onDragOver, false)
      document.removeEventListener('drop', onDrop, true)
      document.removeEventListener('dragend', onDragEnd, false)
      stopAutoScroll()
      clearHighlight()
      closeDialog()
    }

    function apply(ctx) {
      try {
        install()
        if (ctx && typeof ctx.effect === 'function') {
          ctx.effect(function () { return function () { uninstall() } }, NS + ': sidebar drag listeners')
        }
      } catch (error) {
        // 任何失败都不能影响 DSH 启动
      }
    }

    module.exports = { apply: apply, inject: inject, __dshWorkspaceSessionDrag: true }
    return module.exports
  },
})
