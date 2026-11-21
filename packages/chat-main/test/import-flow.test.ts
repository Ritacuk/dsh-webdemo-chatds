/**
 * R8 导入流复现测试 — 用真实 @deepseek-ai/dsh-session(插件副本)驱动 importParsedSession,
 * 复现隔离桌面上的 append seq mismatch。
 */

import { describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import { WorkspaceSessions, replayChatSession } from '../src/host/sessions.js'
import { parseArchive, importParsedSession } from '../src/host/archive.js'
import { strToU8, zipSync } from 'fflate'

function fixture() {
  const log: { seq: number; type: string; time: number; data?: unknown; ignorable?: true; surfaceOp?: string }[] = []
  const subscriptions = new Map<string, (session: Session) => void>()
  const session = {
    id: 'chatws-import-test',
    header: { createdAt: 1 },
    inheritedEventCount: 0,
    snapshotEvents: (fromSeq: number, toExclusive?: number) => log.slice(fromSeq, toExclusive ?? log.length),
    append: (type: string, data: unknown, opts?: { surfaceOp?: string }) => {
      const event = { seq: log.length, type, time: Date.now(), data, ...(opts?.surfaceOp !== undefined ? { surfaceOp: opts.surfaceOp } : {}) }
      log.push(event)
      queueMicrotask(() => subscriptions.get('session/event')?.(session))
      return event
    },
    publicationEntry: () => ({}),
    commit: (record: { seq: number; type: string; time: number; data?: unknown; ignorable?: true }) => {
      log.push(record)
      queueMicrotask(() => subscriptions.get('session/event')?.(session))
    },
    seq: 0,
  } as unknown as Session
  // 用 getter 模拟真实 seq === log.length
  Object.defineProperty(session, 'seq', { get: () => log.length })
  const handle = {
    append: async (events: unknown[]) => { void events },
    flush: async () => {},
    close: async () => {},
  }
  const ctx = {
    on: (name: string, fn: (session: Session) => void) => { subscriptions.set(name, fn); return () => subscriptions.delete(name) },
    sessions: { prepare: (id: string) => { (session as { id: string }).id = id; return session }, enter: () => () => {}, announce: () => {}, flush: async () => true },
    sessionPersistence: { create: async () => handle },
    get: () => undefined,
  }
  const records = new Map()
  const store = { ensure: async () => ({ table: () => ({
    get: (id: string) => records.get(id), put: async (id: string, value: unknown) => { records.set(id, value) },
    entries: () => records.entries(),
  }) }) }
  const workspace = new WorkspaceSessions(ctx as never, store as never, false)
  return { workspace, session, log, subscriptions }
}

describe('R8:导入写入序列', () => {
  it('导入后写 plugin 记录不触发 seq mismatch', async () => {
    const { workspace, session, log, subscriptions } = fixture()
    const zip = zipSync({
      'manifest.json': strToU8(JSON.stringify({ export_format_version: 3 })),
      'chat_sessions/src.json': strToU8(JSON.stringify({
        id: 'src', title: '导入', pinned: false, current_message_id: 2,
        inserted_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        messages: [
          { id: 1, parent_id: null, role: 'USER', status: 'FINISHED', thinking_enabled: false, search_enabled: false, accumulated_token_usage: 0, inserted_at: new Date().toISOString(), fragments: [{ type: 'REQUEST', content: '问题一' }] },
          { id: 2, parent_id: 1, role: 'ASSISTANT', status: 'FINISHED', thinking_enabled: false, search_enabled: false, accumulated_token_usage: 10, inserted_at: new Date().toISOString(), fragments: [{ type: 'RESPONSE', content: '回答一' }] },
          { id: 3, parent_id: 1, role: 'ASSISTANT', status: 'FINISHED', thinking_enabled: false, search_enabled: false, accumulated_token_usage: 0, inserted_at: new Date().toISOString(), fragments: [{ type: 'RESPONSE', content: '备用回复' }] },
        ],
      })),
    })
    const { sessions: parsed } = await parseArchive(zip)
    let result; try { result = await importParsedSession(workspace, parsed[0]!) } catch (error) { console.log('IMPORT FAILED:', error instanceof Error ? error.message : error); throw error }
    expect(result.messageCount).toBe(3)
    const replay = replayChatSession(session.snapshotEvents(SessionLogOffset(0)))
    expect(replay.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(replay.messages.at(-1)).toMatchObject({ blocks: [{ type: 'text', text: '回答一' }] })
    expect(Object.values(replay.versions)[0]).toHaveLength(2)
    expect(replay.tree).toHaveLength(3)
    expect(await workspace.importFingerprints()).toHaveProperty('size', 1)
    // 模拟路由的 markImportRecord:再向同一会话写一条 plugin 记录
    const { writePluginRecord } = await import('../src/host/plugin-record.js')
    writePluginRecord(session, 'plugin:chat-workspace/import', { source: 'deepchat-v3-zip', messageCount: 2 })
    await new Promise((resolve) => setImmediate(resolve))
    await workspace.flushSession(session)
    expect(log.length).toBeGreaterThan(0)
    // 所有事件 seq 连续
    log.forEach((event, index) => expect(Number(event.seq)).toBe(index))
  })
})
