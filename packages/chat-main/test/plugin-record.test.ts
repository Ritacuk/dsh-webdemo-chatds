/**
 * D1:plugin 记录 shim 的回归测试。
 *
 * 覆盖 V0 的跨模块类身份缺陷修复(F-4)之后的写入契约:
 * - 信封与官方 #appendRecord 完全一致(`{type,seq,time,data,ignorable}`),且冻结;
 * - 类型语法校验(非法 type 必须在写入前失败,不能污染正式会话日志);
 * - 负载必须可无损 JSON 序列化(循环引用/undefined 拒绝);
 * - `publicationEntry()` 的返回原样交给 `commit()`(不吞掉 store 附件语义)。
 */

import { describe, expect, it } from 'vitest'
import { writePluginRecord } from '../src/host/plugin-record.js'

type Commit = { event: Record<string, unknown>; entry: unknown }

function fakeSession(seq = 3): {
  session: { seq: number; snapshotEvents: () => { seq: number }[]; publicationEntry: () => unknown; commit: (event: unknown, entry: unknown) => void }
  commits: Commit[]
  entry: unknown
} {
  const commits: Commit[] = []
  const entry = { announced: true }
  return {
    commits,
    entry,
    session: {
      seq,
      snapshotEvents: () => seq === 0 ? [] : [{ seq: seq - 1 }],
      publicationEntry: () => entry,
      commit: (event, received) => { commits.push({ event: event as Record<string, unknown>, entry: received }) },
    },
  }
}

describe('D1:writePluginRecord 契约', () => {
  it('写入与官方一致的冻结信封,seq 取当前日志长度,ignorable=true', () => {
    const { session, commits, entry } = fakeSession(7)
    writePluginRecord(session as never, 'plugin:chat-workspace/settings', { turn: 1, model: 'deepseek-flash' })
    expect(commits).toHaveLength(1)
    const { event, entry: received } = commits[0]!
    expect(event).toMatchObject({
      type: 'plugin:chat-workspace/settings',
      seq: 7,
      ignorable: true,
      data: { turn: 1, model: 'deepseek-flash' },
    })
    expect(typeof event.time).toBe('number')
    expect(Object.isFrozen(event)).toBe(true)
    // publicationEntry() 的返回值必须原样交给 commit(store 附件/重入检查依赖它)
    expect(received).toBe(entry)
  })

  it('负载是独立快照:写入后修改原对象不影响已提交记录', () => {
    const { session, commits } = fakeSession()
    const payload = { turn: 1, nested: { mode: 'chat' } }
    writePluginRecord(session as never, 'plugin:chat-workspace/settings', payload)
    payload.nested.mode = 'plan'
    expect((commits[0]!.event.data as { nested: { mode: string } }).nested.mode).toBe('chat')
  })

  it('非法类型语法在写入前被拒绝(不产生 commit)', () => {
    const { session, commits } = fakeSession()
    expect(() => writePluginRecord(session as never, 'plugin:Bad/Type', {})).toThrow(/lowercase slash-separated/)
    expect(() => writePluginRecord(session as never, 'not-a-plugin-record', {})).toThrow(/slash-separated/)
    expect(commits).toHaveLength(0)
  })

  it('不可 JSON 序列化的负载被拒绝(循环引用)', () => {
    const { session, commits } = fakeSession()
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => writePluginRecord(session as never, 'plugin:chat-workspace/branch', circular)).toThrow(/non-JSON-serializable/)
    expect(commits).toHaveLength(0)
  })

  it('缺少官方写入原语时给出可诊断错误', () => {
    const broken = { seq: 0, publicationEntry: () => undefined, commit: undefined }
    expect(() => writePluginRecord(broken as never, 'plugin:chat-workspace/settings', {})).toThrow(/does not expose/)
  })

  it('拒绝写入与已提交事件不连续的序号', () => {
    const { session, commits } = fakeSession(2)
    session.snapshotEvents = () => []
    expect(() => writePluginRecord(session as never, 'plugin:chat-workspace/settings', {})).toThrow(/sequence contract/)
    expect(commits).toHaveLength(0)
  })
})
