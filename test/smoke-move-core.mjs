/**
 * move-core 冒烟测试：在临时 DSH_HOME 副本上移动一个带子代理的会话，再撤销。
 * 不接触真实 .dsh（只读取复制来源）。
 *   node test/smoke-move-core.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import {
  scanSessions,
  collectDescendants,
  moveSessionFiles,
  readHeaderFromFile,
  projectDirOf,
} from '../lib/move-core.js'

const HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE, '.dsh')
const tmp = path.join(os.tmpdir(), 'dsh-drag-test-' + Date.now())
const sessionsRoot = path.join(tmp, 'sessions')
const backupsRoot = path.join(tmp, 'backups')

fs.mkdirSync(tmp, { recursive: true })
fs.cpSync(path.join(HOME, 'sessions'), sessionsRoot, { recursive: true })
fs.cpSync(path.join(HOME, 'storages'), path.join(tmp, 'storages'), { recursive: true })

const ws = JSON.parse(fs.readFileSync(path.join(tmp, 'storages', 'workspace.json'), 'utf8'))
const views = ws.global.workspaceIds.map((id) => ({ id, ...ws.tables.workspaces[id] }))
const target = views.find((v) => v.title.includes('系统与软件排障')) || views[1]
const all = scanSessions(sessionsRoot)
const parent = all.find((s) => s.id === 'session-80831a46-2f6c-4f5f-9c2a-d110fe02e2cd') ||
  all.find((s) => !s.header.parentSession && all.some((c) => c.header.parentSession === s.id))
assert(parent, '找不到带子代理的父会话')
const descendants = collectDescendants(all, parent.id)
const ids = [parent.id, ...descendants.map((d) => d.id)]
console.log(`parent=${parent.id} children=${descendants.length} target=${target.title}`)

const before = new Map(ids.map((id) => {
  const s = all.find((x) => x.id === id)
  return [id, { cwd: s.header.cwd, dir: s.dir, logs: s.logs }]
}))

const result = moveSessionFiles({
  sessionsRoot,
  backupsRoot,
  sessionIds: ids,
  targetCwd: target.path,
  scanned: all,
})

for (const id of ids) {
  const dir = path.join(projectDirOf(sessionsRoot, target.path), id)
  assert(fs.existsSync(dir), '目标目录存在 ' + id)
  const log = fs.readdirSync(dir).find((f) => /^session\.v\d+\.jsonl(\.zstd)?$/.test(f))
  assert.equal(readHeaderFromFile(path.join(dir, log)).header.cwd, target.path, 'header cwd ' + id)
  assert(!fs.existsSync(before.get(id).dir), '旧目录已移除 ' + id)
}
assert(fs.existsSync(result.backupDir), '备份目录存在 ' + result.backupDir)
for (const id of ids) {
  assert(fs.existsSync(path.join(result.backupDir, 'sessions', id)), '备份包含 ' + id)
}
console.log('moved ok, backup =', result.backupDir)

const problems = result.undo()
assert.deepEqual(problems, [], '回滚无问题')
for (const id of ids) {
  const old = before.get(id)
  assert(fs.existsSync(old.dir), '目录已还原 ' + id)
  const log = fs.readdirSync(old.dir).find((f) => /^session\.v\d+\.jsonl(\.zstd)?$/.test(f))
  assert.equal(readHeaderFromFile(path.join(old.dir, log)).header.cwd, old.cwd, 'header cwd 已还原 ' + id)
}
console.log('undo ok')
fs.rmSync(tmp, { recursive: true, force: true })
console.log('PASS')
