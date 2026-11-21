import { describe, expect, it, vi } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { WorkspaceSessionUnavailable, WorkspaceSessions } from '../src/host/sessions.js'

function fixture(id = 'chatws-side-writer') {
  const events: { seq: number; type: string; time: number }[] = []
  const stored: typeof events = []
  const buffer: typeof events = []
  const handle = {
    append: vi.fn(async (batch: typeof events) => { stored.push(...batch) }),
    flush: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    read: vi.fn(async () => ({ events: [...stored] })),
  }
  const session = {
    id, header: { createdAt: 1 }, inheritedEventCount: 0,
    snapshotEvents: (offset: number) => events.slice(offset),
  } as unknown as Session
  const flush = vi.fn(async () => {
    for (const event of buffer.splice(0)) {
      if (event.seq !== stored.length) throw new Error('append seq mismatch')
      stored.push(event)
    }
    return true
  })
  const enter = vi.fn(() => vi.fn())
  const ctx = {
    sessions: {
      prepare: (_id: string, options?: { seed: typeof events }) => {
        if (options) {
          events.push(...options.seed, { seq: options.seed.length, type: 'session/end-seed', time: 2 })
        }
        return session
      },
      enter, announce: vi.fn(), flush,
    },
    sessionPersistence: { create: async () => handle, open: vi.fn(async () => handle) },
  }
  const store = { ensure: async () => ({ table: () => ({ get: () => undefined, put: async () => {} }) }) }
  const workspace = new WorkspaceSessions(ctx as never, store as never, true)
  const commit = (seq: number) => {
    const event = { seq, type: 'plugin:chat-workspace/sidecar-context', time: 1 }
    events.push(event)
    buffer.push(event)
  }
  return { workspace, session, handle, commit, stored, flush, ctx, enter }
}

describe('DSH owns published WebChat events', () => {
  it('uses only the official route for 20 live events and concurrent flushes', async () => {
    const { workspace, session, handle, commit, stored } = fixture()
    await workspace.create(session.id)
    for (let seq = 0; seq < 20; seq++) commit(seq)
    await Promise.all([workspace.flushSession(session), workspace.flushSession(session)])
    expect(stored.map((event) => event.seq)).toEqual(Array.from({ length: 20 }, (_, index) => index))
    expect(handle.append).not.toHaveBeenCalled()
    await workspace.disposeAll()
    expect(handle.close).toHaveBeenCalledOnce()
  })

  it('writes unpublished seed markers before entering and opens once for concurrent resumes', async () => {
    const { workspace, session, handle, commit, stored, ctx, enter } = fixture()
    const resumed = await Promise.all([workspace.resume(session.id), workspace.resume(session.id)])
    expect(resumed).toEqual([session, session])
    expect(ctx.sessionPersistence.open).toHaveBeenCalledOnce()
    expect(handle.append).toHaveBeenCalledExactlyOnceWith([{ seq: 0, type: 'session/end-seed', time: 2 }])
    expect(handle.append.mock.invocationCallOrder[0]).toBeLessThan(enter.mock.invocationCallOrder[0]!)
    commit(1)
    await workspace.flushSession(session)
    expect(stored.map((event) => event.seq)).toEqual([0, 1])
    expect(handle.append).toHaveBeenCalledOnce()
    await workspace.disposeAll()
  })

  it.each([0, 2])('isolates duplicate or missing events at seq=%d', async (seq) => {
    const { workspace, session, handle, commit, stored } = fixture()
    await workspace.create(session.id)
    commit(0)
    await workspace.flushSession(session)
    commit(seq)
    await expect(workspace.flushSession(session)).rejects.toBeInstanceOf(WorkspaceSessionUnavailable)
    await expect(workspace.resume(session.id)).rejects.toBeInstanceOf(WorkspaceSessionUnavailable)
    expect(stored.map((event) => event.seq)).toEqual([0])
    expect(handle.append).not.toHaveBeenCalled()
    await workspace.disposeAll()
    expect(handle.close).toHaveBeenCalledOnce()
  })

  it('fails closed if the Host has no durability listener', async () => {
    const { workspace, session, flush, handle } = fixture()
    flush.mockResolvedValue(false)
    await expect(workspace.create(session.id)).rejects.toBeInstanceOf(WorkspaceSessionUnavailable)
    expect(handle.close).toHaveBeenCalledOnce()
  })
})
