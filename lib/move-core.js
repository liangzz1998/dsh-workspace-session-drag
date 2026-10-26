/**
 * move-core.js — 会话日志的文件级移动（无 Cordis 依赖，便于单测）。
 *
 * 只负责磁盘上的部分：
 *   1. 备份受影响会话目录
 *   2. 改写会话日志 header 帧里的 cwd
 *   3. 把会话目录移动到目标工作区对应的 session-project 目录
 *
 * 注册表（workspace.json）与投影缓存的内存状态由 lib/index.js 负责，
 * 调用方可以在成功后用返回的 undo() 做文件级回滚。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const ZSTD_MAGIC = 4247762216
const CHECKSUM_OPTIONS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }
const zstdCompressSync = zlib.zstdCompressSync || zlib.zstdCompress
const zstdDecompressSync = zlib.zstdDecompressSync || zlib.zstdDecompress

/** 与 dsh-session-persistence-jsonl 一致的 workspace 目录名编码。 */
export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('cwd 不能为空')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return '--' + ((readable.replace(/^-+/, '') || 'root').slice(0, 251)) + '--'
}
export function projectDirOf(sessionsRoot, cwd) {
  return path.join(sessionsRoot, projectKey(cwd))
}

/** 扫描 zstd 帧边界（不依赖解压）。 */
export function scanFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) throw new Error('不完整的 zstd 帧')
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error('第 ' + offset + ' 字节不是 zstd 帧头')
    offset += 4
    const descriptor = buffer.readUInt8(offset); offset += 1
    if ((descriptor & 24) !== 0) throw new Error('zstd 帧头保留位非零')
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictFlag = descriptor & 3
    const dictBytes = dictFlag === 3 ? 4 : dictFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    offset += (singleSegment ? 0 : 1) + dictBytes + contentSizeBytes
    for (;;) {
      if (buffer.length - offset < 3) throw new Error('不完整的 zstd block')
      const bh = buffer.readUIntLE(offset, 3); offset += 3
      const last = (bh & 1) !== 0
      const type = (bh >>> 1) & 3
      const size = bh >>> 3
      if (type === 3) throw new Error('zstd 保留 block 类型')
      offset += type === 1 ? 1 : size
      if (offset > buffer.length) throw new Error('zstd block 越界')
      if (last) break
    }
    if (checksum) offset += 4
    if (offset > buffer.length) throw new Error('zstd 帧越界')
    frames.push({ start, end: offset })
  }
  return frames
}

/** 读取一个日志文件的 header（首帧必须是单独一行 JSON）。 */
export function readHeaderFromFile(file) {
  const buf = fs.readFileSync(file)
  const frames = scanFrames(buf)
  if (frames.length === 0) throw new Error('空日志文件：' + file)
  const text = zstdDecompressSync(buf.subarray(frames[0].start, frames[0].end)).toString('utf8')
  if (!text.endsWith('\n') || text.indexOf('\n') !== text.length - 1) {
    throw new Error('首帧不是单独一行 header：' + file)
  }
  return { buf, frames, header: JSON.parse(text), headerText: text }
}

function writeFileAtomic(file, data) {
  const tmp = file + '.' + Math.random().toString(16).slice(2) + '.tmp'
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}

/** 只改写 header 帧里的 cwd，事件帧原样保留。 */
export function rewriteHeaderCwd(file, newCwd) {
  const { buf, frames, header } = readHeaderFromFile(file)
  const oldCwd = header.cwd
  header.cwd = newCwd
  const frame = zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n', 'utf8'), CHECKSUM_OPTIONS)
  writeFileAtomic(file, Buffer.concat([frame, buf.subarray(frames[0].end)]))
  const check = readHeaderFromFile(file)
  if (check.header.cwd !== newCwd) throw new Error('回读校验失败：' + file)
  return { oldCwd }
}

export function logFilesIn(dir) {
  return fs.readdirSync(dir).filter((f) => /^session\.v\d+\.jsonl(\.zstd)?$/.test(f)).sort()
}

/** 扫描 sessions 根：id -> 会话目录 / 日志文件 / 磁盘上的 header。 */
export function scanSessions(sessionsRoot) {
  const out = []
  if (!fs.existsSync(sessionsRoot)) return out
  for (const proj of fs.readdirSync(sessionsRoot)) {
    const projPath = path.join(sessionsRoot, proj)
    let stat
    try { stat = fs.statSync(projPath) } catch { continue }
    if (!stat.isDirectory()) continue
    for (const sid of fs.readdirSync(projPath)) {
      const dir = path.join(projPath, sid)
      let dirStat
      try { dirStat = fs.statSync(dir) } catch { continue }
      if (!dirStat.isDirectory()) continue
      const logs = logFilesIn(dir)
      if (logs.length === 0) continue
      let header
      try { header = readHeaderFromFile(path.join(dir, logs[logs.length - 1])).header } catch { continue }
      out.push({ id: header.id || sid, dir, projectDir: projPath, logs, header })
    }
  }
  return out
}

/** 递归找某个会话的后代（子代理会话）。 */
export function collectDescendants(sessions, rootId) {
  const result = []
  const walk = (parentId) => {
    for (const s of sessions) {
      if (s.header && s.header.parentSession === parentId) {
        result.push(s)
        walk(s.id)
      }
    }
  }
  walk(rootId)
  return result
}

function stamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
}

/**
 * 移动一批会话（父会话 + 子代理）到新的工作区目录。
 * @param {object} options
 * @param {string} options.sessionsRoot - `<DSH_HOME>/sessions`
 * @param {string} options.backupsRoot - `<DSH_HOME>/backups`
 * @param {string[]} options.sessionIds - 要移动的会话 id（含子代理）
 * @param {string} options.targetCwd - 目标工作区路径
 * @param {Array} [options.scanned] - 预先 scanSessions() 的结果（可选）
 * @returns {{ backupDir: string, moved: Array, undo: () => Array<string> }}
 */
export function moveSessionFiles({ sessionsRoot, backupsRoot, sessionIds, targetCwd, scanned }) {
  const all = scanned || scanSessions(sessionsRoot)
  const byId = new Map(all.map((s) => [s.id, s]))
  const targetProject = projectDirOf(sessionsRoot, targetCwd)
  const moves = []
  for (const id of sessionIds) {
    const s = byId.get(id)
    if (!s) throw new Error('找不到会话目录：' + id)
    const dest = path.join(targetProject, id)
    if (fs.existsSync(dest)) throw new Error('目标工作区已存在同名会话目录：' + dest)
    moves.push({ session: s, oldDir: s.dir, newDir: dest, oldCwd: s.header.cwd, newCwd: targetCwd })
  }
  // 备份
  const backupDir = path.join(backupsRoot, 'session-drag-' + stamp())
  fs.mkdirSync(backupDir, { recursive: true })
  for (const mv of moves) {
    fs.cpSync(mv.oldDir, path.join(backupDir, 'sessions', mv.session.id), { recursive: true, force: true })
  }
  fs.writeFileSync(path.join(backupDir, 'move.json'), JSON.stringify({
    at: new Date().toISOString(),
    targetCwd,
    sessions: moves.map((mv) => ({ id: mv.session.id, oldCwd: mv.oldCwd, newCwd: mv.newCwd, oldDir: mv.oldDir, newDir: mv.newDir })),
  }, null, 2), 'utf8')
  // 先全部改 header，再全部移动目录
  const done = []
  try {
    for (const mv of moves) {
      for (const log of mv.session.logs) rewriteHeaderCwd(path.join(mv.oldDir, log), targetCwd)
      mv.headerRewritten = true
    }
    fs.mkdirSync(targetProject, { recursive: true })
    for (const mv of moves) {
      fs.renameSync(mv.oldDir, mv.newDir)
      done.push(mv)
    }
  } catch (error) {
    rollbackFiles(done, moves)
    throw error
  }
  return {
    backupDir,
    moved: moves,
    undo() {
      const problems = rollbackFiles(done, moves)
      return problems
    },
  }
}

/** 把已移动的目录和 header 还原；返回失败清单（尽力而为）。 */
function rollbackFiles(done, moves) {
  const problems = []
  for (const mv of done.slice().reverse()) {
    try {
      fs.mkdirSync(path.dirname(mv.oldDir), { recursive: true })
      fs.renameSync(mv.newDir, mv.oldDir)
    } catch (error) {
      problems.push('还原目录失败 ' + mv.session.id + '：' + String(error && error.message ? error.message : error))
    }
  }
  for (const mv of moves) {
    if (!mv.headerRewritten) continue
    const dir = fs.existsSync(mv.oldDir) ? mv.oldDir : mv.newDir
    try {
      for (const log of mv.session.logs) rewriteHeaderCwd(path.join(dir, log), mv.oldCwd)
    } catch (error) {
      problems.push('还原 header 失败 ' + mv.session.id + '：' + String(error && error.message ? error.message : error))
    }
  }
  return problems
}
