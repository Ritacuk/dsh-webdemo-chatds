import { describe, expect, it, vi } from 'vitest'
import { createWorkBranch } from '../src/host/agent-bridge.js'

const parent = 'chatws-test'
const child = 'session-11111111-1111-1111-1111-111111111111'
const checkpoint = {
  type: 'user/message', seq: 0, time: 1,
  data: { id: 'question', content: [{ type: 'text', text: 'test' }] },
}
const events = [checkpoint] as never

function setup(cwd: string | undefined = process.cwd()) {
  const fork = vi.fn(async () => ({ sessionId: child }))
  const archive = vi.fn(async () => {})
  const flush = vi.fn(async () => true)
  const follow = vi.fn(async function* () { yield { type: 'snapshot' } })
  const close = vi.fn(async () => {})
  const open = vi.fn(async (id: string) => ({
    header: { cwd },
    read: async () => ({ events: id === parent ? events : [{ type: 'session/end-seed' }] }),
    close,
    [Symbol.asyncDispose]: close,
  }))
  const ctx = {
    get: (name: string) => ({ sessionController: { fork, follow }, workspaceRegistry: { archiveSession: archive } })[name],
    sessions: { get: vi.fn(() => ({})), flush },
    sessionPersistence: { open },
  }
  const run = () => createWorkBranch(ctx as never, parent, events, 'question', undefined)
  return { ctx, run, fork, archive, flush, open, close, follow }
}

describe('Agent 工作分支持久化与补偿', () => {
  it('持久化后冷读，成功不归档', async () => {
    const test = setup()
    await expect(test.run()).resolves.toEqual({ sessionId: child })
    expect(test.open).toHaveBeenNthCalledWith(1, parent, 'read')
    expect(test.open).toHaveBeenNthCalledWith(2, child, 'read')
    expect(test.close).toHaveBeenCalledTimes(2)
    expect(test.archive).not.toHaveBeenCalled()
  })

  it('父记录无法持久化读取时，不创建分支', async () => {
    const test = setup()
    test.open.mockRejectedValueOnce(new Error('parent unavailable'))
    await expect(test.run()).rejects.toThrow('parent unavailable')
    expect(test.fork).not.toHaveBeenCalled()
  })

  it('没有工作目录时拒绝创建', async () => {
    const test = setup('')
    await expect(test.run()).rejects.toThrow('请选择 Agent 工作目录')
    expect(test.fork).not.toHaveBeenCalled()
    expect(test.archive).not.toHaveBeenCalled()
  })

  it.each(['flush', 'cold read', 'opening snapshot', 'workspace attachment'] as const)('%s 失败，归档已创建的分支', async (stage) => {
    const test = setup()
    const failure = new Error('injected failure')
    if (stage === 'flush') test.flush.mockRejectedValueOnce(failure)
    if (stage === 'cold read') test.open.mockImplementationOnce(async () => ({
      header: { cwd: process.cwd() }, read: async () => ({ events }), close: test.close, [Symbol.asyncDispose]: test.close,
    })).mockRejectedValueOnce(failure)
    if (stage === 'opening snapshot') test.follow.mockImplementationOnce(async function* () { throw failure })
    if (stage === 'workspace attachment') test.fork.mockRejectedValueOnce(Object.assign(failure, {
      code: 'session/workspace-attach-failed', details: { sessionId: child },
    }))
    await expect(test.run()).rejects.toThrow(failure)
    expect(test.archive).toHaveBeenCalledExactlyOnceWith(child)
  })
})
