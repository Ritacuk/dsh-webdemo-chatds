/**
 * R8 导入流复现测试 — 用真实 @deepseek-ai/dsh-session(插件副本)驱动 importParsedSession,
 * 复现隔离桌面上的 append seq mismatch。
 */

import { describe, expect, it, vi } from 'vitest'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import { WorkspaceSessions, replayChatSession } from '../src/host/sessions.js'
import { parseArchive, importParsedSession } from '../src/host/archive.js'
import { strToU8, zipSync } from 'fflate'

function fixture() {
  const native = { active: 'native-active', history: [{ id: 'native-active', content: 'Existing transcript' }] }
  const ctx = {
    sessions: {
      prepare: vi.fn(),
      messageProjections: [],
      enter: vi.fn(), announce: vi.fn(), flush: vi.fn(),
    },
    sessionPersistence: { create: vi.fn(), open: vi.fn() },
  }

  const tables = new Map<string, Map<string, unknown>>()
  const store = { ensure: async () => ({ table: (name: string) => {
    const records = tables.get(name) ?? new Map()
    tables.set(name, records)
    return {
      get: (id: string) => records.get(id),
      put: async (id: string, value: unknown) => { records.set(id, structuredClone(value)) },
      update: async (id: string, fn: (value: unknown) => unknown) => { records.set(id, structuredClone(fn(records.get(id)))) },
      entries: () => records.entries(),
    }
  } }) }
  const restart = () => new WorkspaceSessions(ctx as never, store as never)
  return { workspace: restart(), ctx, native, restart }
}

describe('R8:导入写入序列', () => {
  it('导入后写 plugin 记录不触发 seq mismatch', async () => {
    const { workspace, ctx, native, restart } = fixture()
    const before = structuredClone(native)
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
    const result = await importParsedSession(workspace, parsed[0]!)
    const session = (await workspace.liveSession(result.id))!
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
    const log = session.snapshotEvents(SessionLogOffset(0))
    expect(log.length).toBeGreaterThan(0)
    // 所有事件 seq 连续
    log.forEach((event, index) => expect(Number(event.seq)).toBe(index))
    await workspace.disposeAll()
    const reopened = restart()
    expect(replayChatSession((await reopened.readEvents(result.id))!).messages).toEqual(replay.messages)
    expect(await reopened.list()).toMatchObject([{ id: result.id, title: '导入', imported: true }])
    expect(native).toEqual(before)
    expect(ctx.sessionPersistence.create).not.toHaveBeenCalled()
    expect(ctx.sessionPersistence.open).not.toHaveBeenCalled()
    expect(ctx.sessions.prepare).not.toHaveBeenCalled()
    expect(ctx.sessions.enter).not.toHaveBeenCalled()
    expect(ctx.sessions.announce).not.toHaveBeenCalled()
    expect(ctx.sessions.flush).not.toHaveBeenCalled()
  })

  it('keeps pin changes independent of the log, archive metadata and last activity', async () => {
    const { workspace, restart } = fixture()
    const first = await workspace.create()
    const second = await workspace.create()
    const original = await workspace.list()
    const events = await workspace.readEvents(first.id)
    await Promise.all([
      workspace.setPinned(first.id, true),
      workspace.setPinned(second.id, true),
      workspace.setArchived(first.id, true),
      workspace.flushSession(first),
    ])
    expect(await workspace.list()).toEqual(original.map((entry) => ({
      ...entry, pinned: true, ...(entry.id === first.id ? { archived: true } : {}),
    })))
    expect(await workspace.readEvents(first.id)).toEqual(events)
    await workspace.disposeAll()
    const reopened = restart()
    await reopened.setPinned(first.id, false)
    await reopened.setArchived(first.id, false)
    expect(await reopened.list()).toEqual(original.map((entry) =>
      entry.id === second.id ? { ...entry, pinned: true } : entry))
  })

})
