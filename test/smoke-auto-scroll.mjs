/**
 * 拖拽自动滚动冒烟测试：用最小 fake DOM 跑 client.js 的 dragstart/dragover 流程，
 * 验证靠近列表底部/顶部时会滚动滚动容器，并给目标工作区分组加高亮。
 *   node test/smoke-auto-scroll.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const code = fs.readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')

/* ---------------- fake DOM ---------------- */
const listeners = new Map()
function makeClassList() {
  const set = new Set()
  return { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c) }
}
function element(init = {}) {
  const el = {
    attributes: init.attributes || {},
    className: init.className || '',
    textContent: init.textContent || '',
    parentElement: init.parentElement || null,
    scrollTop: init.scrollTop || 0,
    scrollHeight: init.scrollHeight || 0,
    clientHeight: init.clientHeight || 0,
    getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null },
    getBoundingClientRect() { return this.rect || { top: 0, bottom: 0, left: 0, right: 0, height: 0 } },
    querySelector(selector) { return this._qs ? this._qs(selector) : null },
    querySelectorAll() { return [] },
    closest() { return null },
    appendChild() {},
    matches() { return false },
  }
  el.classList = makeClassList()
  return Object.assign(el, init)
}

const scrollEl = element({
  scrollHeight: 1000,
  clientHeight: 400,
  scrollTop: 0,
  rect: { top: 0, bottom: 600, left: 0, right: 260, height: 600 },
})

const sourceWorkspaceRow = element({ attributes: { 'data-row-key': 'workspace:w-source' }, textContent: '源工作区' })
const sourceGroup = element({ className: 'GAkraW_groupSection' })
sourceGroup._qs = (s) => (s === '[data-row-key^="workspace:"]' ? sourceWorkspaceRow : null)
sourceGroup.closest = (s) => (s === '[class*="groupSection"]' ? sourceGroup : null)
sourceGroup.parentElement = scrollEl
sourceWorkspaceRow.parentElement = sourceGroup

const targetWorkspaceRow = element({ attributes: { 'data-row-key': 'workspace:w-target' }, textContent: '目标工作区' })
const targetGroup = element({ className: 'GAkraW_groupSection' })
targetGroup._qs = (s) => (s === '[data-row-key^="workspace:"]' ? targetWorkspaceRow : null)
targetGroup.closest = (s) => (s === '[class*="groupSection"]' ? targetGroup : null)
targetGroup.parentElement = scrollEl
targetWorkspaceRow.parentElement = targetGroup
targetWorkspaceRow.closest = (s) => (s === '[class*="groupSection"]' ? targetGroup : null)

const row = element({ attributes: { 'data-row-key': 'session:session-test' }, textContent: '测试会话' })
row.closest = (selector) => {
  if (selector === '[class*="groupSection"]') return sourceGroup
  if (selector === '[data-row-key^="session:"]') return row
  return null
}
row.parentElement = sourceGroup

const highlighted = new Set()
const document = {
  body: element(),
  documentElement: element(),
  head: element(),
  getElementById: () => null,
  createElement: () => element(),
  addEventListener: (type, handler) => listeners.set(type, handler),
  removeEventListener: () => {},
  querySelector: (selector) => (selector === '[data-row-key="session:session-test"]' ? row : null),
  querySelectorAll: (selector) => (selector === '.dsh-wsd-drop' ? [...highlighted] : []),
  elementsFromPoint: () => [targetWorkspaceRow],
}
const originalAdd = targetGroup.classList.add
targetGroup.classList.add = (c) => { originalAdd(c); if (c === 'dsh-wsd-drop') highlighted.add(targetGroup) }
const originalRemove = targetGroup.classList.remove
targetGroup.classList.remove = (c) => { originalRemove(c); if (c === 'dsh-wsd-drop') highlighted.delete(targetGroup) }

const rafQueue = []
const context = {
  window: {},
  document,
  console,
  fetch: () => Promise.reject(new Error('fake network')),
  setTimeout: () => 0,
  clearTimeout: () => {},
  requestAnimationFrame: (cb) => { rafQueue.push(cb); return rafQueue.length },
  cancelAnimationFrame: () => {},
}
context.window.getComputedStyle = (node) => (node === scrollEl ? { overflowY: 'auto' } : { overflowY: 'visible' })
context.globalThis = context
let captured = null
context.window.__ModuleLoader__ = { load: (definition) => { captured = definition } }

vm.createContext(context)
vm.runInContext(code, context, { filename: 'client.js' })
assert(captured, '插件没有调用 __ModuleLoader__.load')
assert.equal(captured.id, 'dsh-workspace-session-drag')
const mod = captured.factory()
assert.equal(typeof mod.apply, 'function')
mod.apply({})

const dragStart = listeners.get('dragstart')
const dragOver = listeners.get('dragover')
const dragEnd = listeners.get('dragend')
assert(dragStart && dragOver && dragEnd, '缺少事件监听')

dragStart({ target: row, clientX: 120, clientY: 560, dataTransfer: { setData() {} } })
assert.equal(scrollEl.scrollTop, 0, '拖拽开始不应立即滚动')

// 靠近底部（600-585=15 < 84）：dragover 后 RAF 帧应向下滚
dragOver({ clientX: 120, clientY: 585, dataTransfer: { dropEffect: '' }, preventDefault() {} })
assert(rafQueue.length > 0, '靠近底部时应安排自动滚动帧')
rafQueue.shift()()
assert(scrollEl.scrollTop > 0, '底部边缘应自动向下滚动，实际 scrollTop=' + scrollEl.scrollTop)
assert(targetGroup.classList.contains('dsh-wsd-drop'), '跨工作区拖拽时应高亮目标分组')

// 指针移到顶部区域：执行下一帧应向上滚
const before = scrollEl.scrollTop
dragOver({ clientX: 120, clientY: 20, dataTransfer: { dropEffect: '' }, preventDefault() {} })
const tick = rafQueue.pop()
if (tick) tick()
assert(scrollEl.scrollTop < before, '顶部边缘应自动向上滚动')

// dragend 停止并清理
dragEnd()
assert(!targetGroup.classList.contains('dsh-wsd-drop'), 'dragend 后应清除高亮')

console.log('PASS: auto-scroll + highlight + dragend cleanup')
