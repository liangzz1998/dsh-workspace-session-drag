/**
 * dsh-workspace-session-drag — 宿主半侧
 *
 * 提供两个 HTTP 路由给浏览器半侧（lib/client.js）：
 *   GET  /dsh-workspace-drag/state   工作区列表、会话标题、归档集合
 *   POST /dsh-workspace-drag/move    { sessionId, targetWorkspaceId }
 *
 * 移动流程：
 *   1. 校验（目标工作区、会话归属、会话是否正在运行）
 *   2. 文件级移动（move-core：备份 / 改 header cwd / 移动会话目录，子代理随行）
 *   3. 同步投影缓存里的 identity.cwd（标题不会在新工作区消失）
 *   4. 即时刷新工作区注册表（detach 旧工作区 / attach 新工作区），失败则整体回滚
 *
 * 注册表刷新成功后，浏览器里的 workspace follow 流会立刻推送新归属，无需重启。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  moveSessionFiles,
  scanSessions,
  collectDescendants,
} from './move-core.js'

const name = 'dsh-workspace-session-drag'
const NS = name
const ROUTE_BASE = '/dsh-workspace-drag'
const inject = ['webServer', 'workspaceRegistry', 'sessionPersistence']

class MoveError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'MoveError'
    this.code = code
  }
}

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function resolveWebServer(ctx) {
  try {
    const viaGet = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
    if (viaGet) return viaGet
  } catch { /* 取不到就当没有 */ }
  return ctx.webServer
}

function hasRoutes(server) {
  return Boolean(server && typeof server.register === 'function')
}

/** 会话标题：优先读投影缓存内存记录（与列表一致）。 */
function titleOf(cache, sessionId) {
  try {
    const record = cache?.table?.get?.(sessionId)
    const title = record?.rows?.title
    if (title && typeof title.val === 'string') return title.val
  } catch { /* ignore */ }
  return ''
}

/** 更新一个会话在投影缓存里的生命周期 identity.cwd；返回是否写入。 */
async function updateCacheCwd(cache, sessionId, fromCwd, toCwd) {
  try {
    if (!cache || !cache.table) return false
    const record = cache.table.get(sessionId)
    if (!record || !record.identity) return false
    if (record.identity.cwd !== fromCwd) return false
    await cache.table.update(sessionId, (current) => ({
      ...current,
      identity: { ...current.identity, cwd: toCwd },
    }))
    return true
  } catch (error) {
    return false
  }
}

/* ------------------- 已打开（live）会话的安全迁移 ------------------- */

/**
 * 查该会话当前有没有进行中的工作（turn / 子代理 / 后台任务 / 提醒）。
 * 空数组表示“已打开但空闲”，此时可以安全迁移。
 */
async function sessionActivityOf(ctx, sessionId) {
  try {
    if (typeof ctx.waterfall !== 'function') return []
    const activity = await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
    return Array.isArray(activity) ? activity : []
  } catch {
    return []
  }
}
function describeActivity(activity) {
  const kinds = new Set()
  for (const item of activity) {
    if (item && typeof item === 'object') {
      if (item.kind) kinds.add(String(item.kind))
      if (item.type) kinds.add(String(item.type))
      if (item.name) kinds.add(String(item.name))
    }
  }
  return [...kinds].join('/') || '运行中'
}

/**
 * 已发布会话在 jsonl 后端里持有写句柄，写句柄用 header.cwd 推导日志路径。
 * 移动会话目录后必须把句柄的 header.cwd 也切到新工作区，否则后续事件会写到旧路径。
 * 找不到写句柄记录（后端实现变化）时保守拒绝。
 */
function collectLiveWriteHandles(ctx, sessionIds) {
  let backend
  try { backend = ctx.sessionPersistence } catch { backend = undefined }
  const tracker = backend && backend.tracker
  if (!tracker || !(tracker.writers instanceof Map)) {
    return {
      ok: false,
      handles: [],
      reason: '当前 DSH 版本无法安全迁移已打开的会话（找不到写句柄记录），请重启 DSH 后再移动。',
    }
  }
  const handles = []
  for (const id of sessionIds) {
    const writer = tracker.writers.get(id)
    if (writer === undefined || writer === null) continue
    if (!writer.header || typeof writer.header !== 'object') {
      return { ok: false, handles: [], reason: '已打开会话的日志头不可用，请重启 DSH 后再移动。' }
    }
    if (Object.isFrozen(writer.header)) {
      return { ok: false, handles: [], reason: '已打开会话的日志头被冻结，无法安全切换目录，请重启 DSH 后再移动。' }
    }
    handles.push(writer)
  }
  return { ok: true, handles }
}
function applyHandleCwd(handles, newCwd) {
  const changes = []
  try {
    for (const handle of handles) {
      const before = handle.header.cwd
      if (before === newCwd) continue
      handle.header.cwd = newCwd
      if (handle.header.cwd !== newCwd) throw new Error('写句柄 cwd 切换未生效')
      changes.push({ handle, before })
    }
  } catch (error) {
    restoreHandleCwd(changes)
    throw error
  }
  return changes
}
function restoreHandleCwd(changes) {
  for (const change of changes) {
    try { change.handle.header.cwd = change.before } catch { /* 回滚尽力而为 */ }
  }
}

/**
 * 即时刷新注册表：把 sessionId 从 oldEntity 挪到 target。
 * 先 detach 再 attach；任何一步失败都恢复内存快照并抛出。
 */
async function refreshRegistry(reg, oldEntity, target, sessionId, newHeader, newCwd) {
  const oldRecord = reg.table.get(oldEntity.id)
  const oldRecordCopy = oldRecord === undefined ? undefined : JSON.parse(JSON.stringify(oldRecord))
  const hadHeader = reg.headers.has(sessionId)
  const oldHeader = reg.headers.get(sessionId)
  const hadPath = reg.sessionPaths.has(sessionId)
  const oldPath = reg.sessionPaths.get(sessionId)
  const restoreIndex = () => {
    if (hadHeader) reg.headers.set(sessionId, oldHeader)
    else reg.headers.delete(sessionId)
    if (hadPath) reg.sessionPaths.set(sessionId, oldPath)
    else reg.sessionPaths.delete(sessionId)
  }
  reg.headers.set(sessionId, newHeader)
  reg.sessionPaths.set(sessionId, newCwd)
  try {
    await oldEntity.detachSession(sessionId)
  } catch (error) {
    restoreIndex()
    throw error
  }
  try {
    await target.attachSession(sessionId)
  } catch (error) {
    if (oldRecordCopy !== undefined) {
      try {
        await reg.table.put(oldEntity.id, oldRecordCopy)
        oldEntity.record = oldRecordCopy
      } catch (restoreError) {
        throw new Error(`attach 失败且旧工作区记录恢复失败：${error.message} / ${restoreError.message}`)
      }
    }
    restoreIndex()
    throw error
  }
}

/**
 * 已打开（live）会话的注册表刷新：直接改两张工作区记录。
 *
 * 不能走 attachSession：它会把 live session 的内存 header 当作 cwd 校验依据，
 * 而 live Session 的 header 是冻结的旧 cwd。这里我们自己保证：
 *   · 磁盘 header 已改成新 cwd（move-core 完成）
 *   · 后端写句柄的 header.cwd 已切到新 cwd（applyHandleCwd 完成）
 *   · registry 的 session 路径索引也指向新 cwd
 * 然后成对地改写「旧工作区移除 / 新工作区加入」两条记录。
 */
async function refreshRegistryDirect(reg, oldEntity, target, sessionId, newHeader, newCwd) {
  const oldRecord = reg.table.get(oldEntity.id)
  const targetRecord = reg.table.get(target.id)
  if (oldRecord === undefined || targetRecord === undefined) throw new Error('工作区记录不存在')
  const oldCopy = JSON.parse(JSON.stringify(oldRecord))
  const targetCopy = JSON.parse(JSON.stringify(targetRecord))
  const now = new Date().toISOString()
  const nextOld = {
    ...oldCopy,
    sessionIds: oldCopy.sessionIds.filter((id) => id !== sessionId),
    updatedAt: now,
  }
  const nextTarget = {
    ...targetCopy,
    sessionIds: [sessionId, ...targetCopy.sessionIds.filter((id) => id !== sessionId)],
    updatedAt: now,
  }
  const hadHeader = reg.headers.has(sessionId)
  const previousHeader = reg.headers.get(sessionId)
  const hadPath = reg.sessionPaths.has(sessionId)
  const previousPath = reg.sessionPaths.get(sessionId)
  try {
    reg.headers.set(sessionId, newHeader)
    reg.sessionPaths.set(sessionId, newCwd)
    await reg.table.put(oldEntity.id, nextOld)
    oldEntity.record = nextOld
    await reg.table.put(target.id, nextTarget)
    target.record = nextTarget
  } catch (error) {
    try {
      await reg.table.put(oldEntity.id, oldCopy)
      oldEntity.record = oldCopy
    } catch { /* 尽力回滚 */ }
    try {
      await reg.table.put(target.id, targetCopy)
      target.record = targetCopy
    } catch { /* 尽力回滚 */ }
    if (hadHeader) reg.headers.set(sessionId, previousHeader)
    else reg.headers.delete(sessionId)
    if (hadPath) reg.sessionPaths.set(sessionId, previousPath)
    else reg.sessionPaths.delete(sessionId)
    throw error
  }
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        req.destroy()
        reject(new MoveError('bad-request', '请求体过大'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', (error) => reject(error))
  })
}

function sendJson(res, code, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(body.length),
  })
  res.end(body)
}

function apply(ctx) {
  const webServer = resolveWebServer(ctx)
  if (!hasRoutes(webServer)) {
    try {
      ctx.logger?.warn?.(
        `[${NS}] 当前 profile 没有可用的 webServer；拖拽移动插件的宿主半侧未挂载路由。`,
      )
    } catch { /* 日志失败不影响加载 */ }
    return
  }

  const disposers = []
  const connection = () => {
    try { return typeof ctx.get === 'function' ? ctx.get('connection') : ctx.connection } catch { return undefined }
  }

  /** 浏览器信任栅栏：自定义路由必须过一遍，避免被任意网页读写。 */
  function rejected(req, res) {
    try {
      const conn = connection()
      if (!conn || typeof conn.requestRejection !== 'function') return false
      const code = conn.requestRejection(req)
      if (code === undefined || code === null || code === false) return false
      res.statusCode = typeof code === 'number' ? code : 403
      res.end()
      return true
    } catch {
      return false
    }
  }

  function registerRoute(kind, routePath, handler) {
    return webServer.register({
      kind,
      path: routePath,
      handler: async (req, res) => {
        if (rejected(req, res)) return
        try {
          await handler(req, res)
        } catch (error) {
          if (!res.headersSent) {
            sendJson(res, 200, {
              ok: false,
              error: {
                code: error?.code || 'internal',
                message: error instanceof Error ? error.message : String(error),
              },
            })
          }
        }
      },
    })
  }

  /* ---------------------------- GET state ---------------------------- */
  disposers.push(registerRoute('exact', ROUTE_BASE + '/state', async (req, res) => {
    const reg = ctx.workspaceRegistry
    const cache = (() => { try { return ctx.get('sessionProjectionCache') } catch { return undefined } })()
    const workspaces = reg.list().map((entity) => ({
      id: entity.id,
      title: entity.title,
      path: entity.path,
      sessionIds: [...entity.sessionIds],
    }))
    const sessions = {}
    for (const workspace of workspaces) {
      for (const sessionId of workspace.sessionIds) {
        sessions[sessionId] = { title: titleOf(cache, sessionId) }
      }
    }
    sendJson(res, 200, {
      ok: true,
      workspaces,
      sessions,
      archivedSessionIds: [...(reg.archivedSessionIds || [])],
    })
  }))

  /* ---------------------------- POST move ---------------------------- */
  disposers.push(registerRoute('exact', ROUTE_BASE + '/move', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: '请用 POST' } })
      return
    }
    let body
    try {
      body = JSON.parse(await readBody(req) || '{}')
    } catch (error) {
      throw new MoveError('bad-request', '请求体不是合法 JSON')
    }
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    const targetWorkspaceId = typeof body.targetWorkspaceId === 'string' ? body.targetWorkspaceId.trim() : ''
    if (!sessionId || !targetWorkspaceId) throw new MoveError('bad-request', '缺少 sessionId 或 targetWorkspaceId')

    const reg = ctx.workspaceRegistry
    const home = dshHome()
    const sessionsRoot = path.join(home, 'sessions')
    const backupsRoot = path.join(home, 'backups')

    const target = reg.get(targetWorkspaceId)
    if (!target) throw new MoveError('workspace/not-found', '目标工作区不存在')
    const oldEntity = reg.list().find((entity) => entity.sessionIds.includes(sessionId))
    if (!oldEntity) throw new MoveError('session/not-accounted', '该会话不属于任何已注册工作区，无法移动')
    if (oldEntity.id === target.id) throw new MoveError('move/already-there', '会话已经在目标工作区')
    if (!fs.existsSync(target.path)) throw new MoveError('workspace/missing-dir', '目标工作区目录不存在')

    const scanned = scanSessions(sessionsRoot)
    const root = scanned.find((s) => s.id === sessionId)
    if (!root) throw new MoveError('session/not-found', '找不到该会话的持久化日志')
    if (root.header.cwd === target.path) throw new MoveError('move/already-there', '会话已经在目标工作区')
    const descendants = collectDescendants(scanned, sessionId)
    const moving = [root, ...descendants]
    const movingIds = moving.map((s) => s.id)

    /*
     * 已打开的会话（GUI 里当前显示/加载过）在宿主里是 live session，持有写句柄。
     *   · 有进行中的工作（turn / 子代理 / 后台任务 / 提醒）→ 拒绝
     *   · 仅打开、空闲 → 先 flush，再移动文件，并把写句柄的 header.cwd 切到新工作区
     */
    const sessionsService = (() => { try { return ctx.get('sessions') } catch { return undefined } })()
    const liveSessions = []
    if (sessionsService && typeof sessionsService.list === 'function') {
      for (const session of sessionsService.list()) {
        if (movingIds.includes(session.id)) liveSessions.push(session)
      }
    }
    let liveHandles = []
    if (liveSessions.length > 0) {
      for (const session of liveSessions) {
        const activity = await sessionActivityOf(ctx, session.id)
        if (activity.length > 0) {
          throw new MoveError(
            'move/session-busy',
            `「${session.id}」还有进行中的工作（${describeActivity(activity)}），等它空闲后再移动。`,
          )
        }
      }
      const collected = collectLiveWriteHandles(ctx, movingIds)
      if (!collected.ok) throw new MoveError('move/session-live', collected.reason)
      liveHandles = collected.handles
      for (const session of liveSessions) {
        try {
          if (typeof sessionsService.flush === 'function') await sessionsService.flush(session)
        } catch (error) {
          throw new MoveError(
            'move/session-flush-failed',
            '该会话的事件保存失败，已取消移动：' + (error instanceof Error ? error.message : String(error)),
          )
        }
      }
    }

    /* 文件级移动（含备份）；失败时内部已尽力回滚。 */
    const moved = moveSessionFiles({
      sessionsRoot,
      backupsRoot,
      sessionIds: movingIds,
      targetCwd: target.path,
      scanned,
    })
    try {
      fs.copyFileSync(path.join(home, 'storages', 'workspace.json'), path.join(moved.backupDir, 'workspace.json'))
    } catch { /* 备份失败不影响移动本身 */ }

    /* 已打开会话：把写句柄的 header.cwd 切到新工作区，后续事件才会写进新日志。 */
    let handleChanges = []
    if (liveHandles.length > 0) {
      try {
        handleChanges = applyHandleCwd(liveHandles, target.path)
      } catch (error) {
        const problems = moved.undo()
        throw new MoveError(
          'move/session-handle-failed',
          '已打开会话的写路径切换失败，已回滚文件' +
            (problems.length ? '（部分回滚问题：' + problems.join('；') + '）' : '') +
            '：' + (error instanceof Error ? error.message : String(error)),
        )
      }
    }

    /* 同步标题缓存（软失败：失败时列表可能暂时没有标题，重启后自愈）。 */
    const cache = (() => { try { return ctx.get('sessionProjectionCache') } catch { return undefined } })()
    const cacheRestore = []
    for (const session of moving) {
      const updated = await updateCacheCwd(cache, session.id, session.header.cwd, target.path)
      if (updated) cacheRestore.push({ id: session.id, from: target.path, to: session.header.cwd })
    }

    /* 注册表即时刷新；失败则把文件、缓存、注册表全部回滚。 */
    try {
      const newHeader = { ...root.header, cwd: target.path }
      if (liveSessions.length > 0) {
        await refreshRegistryDirect(reg, oldEntity, target, sessionId, newHeader, target.path)
      } else {
        await refreshRegistry(reg, oldEntity, target, sessionId, newHeader, target.path)
      }
    } catch (error) {
      restoreHandleCwd(handleChanges)
      for (const item of cacheRestore) await updateCacheCwd(cache, item.id, item.from, item.to)
      const problems = moved.undo()
      throw new MoveError(
        'move/registry-sync-failed',
        '注册表同步失败，已回滚文件' +
          (problems.length ? '（部分回滚问题：' + problems.join('；') + '）' : '') +
          '：' + (error instanceof Error ? error.message : String(error)),
      )
    }

    sendJson(res, 200, {
      ok: true,
      instant: true,
      from: { id: oldEntity.id, title: oldEntity.title },
      to: { id: target.id, title: target.title },
      sessionId,
      movedSessionIds: movingIds,
      backupDir: moved.backupDir,
      movedOpenSession: liveHandles.length > 0,
    })
  }))

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* ignore */ }
    }
  }, 'dsh-workspace-session-drag routes')
}

const plugin = { name, inject, apply }
export { apply, inject, name }
export default plugin
