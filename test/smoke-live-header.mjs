/**
 * 冒烟测试：内存里那条 live Session 的 header 同步（不碰真实 .dsh，纯假对象）。
 *
 * 背景：dsh-session-query 的 assertSessionHeadersCompatible() 会拿 live Session 的 header
 * 和磁盘 artifact 的 header 逐字段比对，不一致就让 /api/session/list 整体报错
 * （session source headers conflict）—— 侧栏全空，直到重启 DSH。
 *
 *   node test/smoke-live-header.mjs
 */
import assert from 'node:assert/strict'
import {
  retargetLiveSessionHeader,
  restoreLiveSessionHeader,
  retargetLiveSessionHeaders,
  restoreLiveSessionHeaders,
} from '../lib/move-core.js'

const SRC = 'D:\\ws-src'
const DST = 'D:\\ws-dst'

/** 造一个和真实 Session 同形状的假对象：header 是普通字段，字段值 deep-frozen。 */
function makeSession(id, cwd) {
  return {
    id,
    header: Object.freeze({ version: 4, id, createdAt: 1790000000000, cwd, isSeeded: false }),
  }
}

/* 1. 正常切换：换的是引用，旧对象不变，其余字段原样保留 */
{
  const session = makeSession('session-a', SRC)
  const previous = retargetLiveSessionHeader(session, DST)
  assert.equal(session.header.cwd, DST, 'cwd 必须切到目标')
  assert.equal(session.header.id, 'session-a', '其它字段原样保留')
  assert.equal(session.header.createdAt, 1790000000000, 'createdAt 不能变（它参与 header 比对）')
  assert.equal(Object.isFrozen(session.header), true, '换上去的 header 仍然要是冻结对象')
  assert.notEqual(session.header, previous, '必须是换引用，不是改字段')
  assert.equal(previous.cwd, SRC, '旧对象保持原样，可用于回滚')

  restoreLiveSessionHeader(session, previous)
  assert.equal(session.header, previous, '回滚后指回原对象')
  assert.equal(session.header.cwd, SRC)
}

/* 2. 已经就是目标 cwd：不动（幂等） */
{
  const session = makeSession('session-b', DST)
  const before = session.header
  const previous = retargetLiveSessionHeader(session, DST)
  assert.equal(previous, before)
  assert.equal(session.header, before, '没必要换就别换')
}

/* 3. 会话不可用 / 没有 header：抛错，让调用方整体放弃 */
{
  assert.throws(() => retargetLiveSessionHeader(null, DST), /不可用/)
  assert.throws(() => retargetLiveSessionHeader({ id: 'x' }, DST), /没有 header/)
}

/* 4. 批量：一条成功、一条失败 → 已经改过的要还原（不留部分同步） */
{
  const ok = makeSession('session-c', SRC)
  const broken = { id: 'session-d' } // 没有 header → 抛错
  assert.throws(() => retargetLiveSessionHeaders([ok, broken], DST), /没有 header/)
  assert.equal(ok.header.cwd, SRC, '失败时已改的必须还原')
}

/* 5. 批量回滚 */
{
  const a = makeSession('session-e', SRC)
  const b = makeSession('session-f', SRC)
  const changes = retargetLiveSessionHeaders([a, b], DST)
  assert.equal(changes.length, 2)
  assert.equal(a.header.cwd, DST)
  assert.equal(b.header.cwd, DST)
  restoreLiveSessionHeaders(changes)
  assert.equal(a.header.cwd, SRC)
  assert.equal(b.header.cwd, SRC)
}

console.log('PASS：live Session header 同步 / 幂等 / 失败回滚 全部正确')
