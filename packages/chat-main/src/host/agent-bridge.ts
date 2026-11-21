import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { installModelSelection, type AgentRegistry, type CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  SessionId, SessionLogOffset, type SessionEvent,
} from '@deepseek-ai/dsh-session'
import { eventsToWireMessages } from './sessions.js'

interface SessionController {
  fork(request: { sessionId: SessionId; atSeq: number; allowMigration: false }): Promise<{ sessionId: SessionId }>
  follow(request: { address: { kind: 'session'; sessionId: SessionId }; maxMessages: number }, signal: AbortSignal):
    AsyncIterable<{ type: string }>
}
interface WorkspaceRegistry {
  create(path: string): Promise<{ path: string; attachSession(id: SessionId): Promise<void> }>
  archiveSession(id: SessionId): Promise<void>
}

function agents(ctx: Context): AgentRegistry | undefined {
  // dsh-agent is provided by the native Host, and the chat surface may run without it.
  return ctx.get('agents' as never) as AgentRegistry | undefined
}

export class WorkBranchDirectoryRequired extends Error {}

export async function createWorkBranch(
  ctx: Context, parent: string, events: readonly SessionEvent[], messageId: string, directory: string | undefined,
) {
  if (!eventsToWireMessages(events).some((message) => message.id === messageId)) throw new Error('Checkpoint unavailable')
  const checkpoint = events.find((event) => event.type === 'user/message' ? event.data.id === messageId
    : event.type === 'assistant/message' && event.data.message.id === messageId)
  const controller = ctx.get('sessionController' as never) as SessionController | undefined
  const workspaces = ctx.get('workspaceRegistry' as never) as WorkspaceRegistry | undefined
  if (!checkpoint || !controller || !workspaces) throw new Error('Native Session Controller is unavailable')
  const parentId = SessionId(parent)
  // 手动释放读句柄:不用 `await using`,保证 node 22(无 explicit resource management)可加载。
  const source = await ctx.sessionPersistence.open(parentId, 'read')
  let headerCwd: string | undefined
  let stored: readonly SessionEvent[]
  try {
    const read = await source.read(0)
    stored = read.events
    headerCwd = source.header.cwd
  } finally {
    await source.close()
  }
  const storedCheckpoint = stored.find((event) => event.seq === checkpoint.seq)
  if (storedCheckpoint?.type !== checkpoint.type || (storedCheckpoint.type === 'user/message'
    ? storedCheckpoint.data.id !== messageId
    : storedCheckpoint.type !== 'assistant/message' || storedCheckpoint.data.message.id !== messageId)) {
    throw new Error('Checkpoint has not been saved')
  }
  let sessionId: SessionId | undefined
  try {
    if (headerCwd) {
      if (!(await stat(headerCwd)).isDirectory()) throw new WorkBranchDirectoryRequired('原工作目录已不可用。')
      const branch = await controller.fork({ sessionId: parentId, atSeq: checkpoint.seq, allowMigration: false })
      sessionId = branch.sessionId
    } else {
      if (!directory || !isAbsolute(directory)) throw new WorkBranchDirectoryRequired('请选择 Agent 工作目录。')
      const cwd = await realpath(directory).catch(() => undefined)
      if (!cwd || !(await stat(cwd).catch(() => undefined))?.isDirectory()) {
        throw new WorkBranchDirectoryRequired('所选工作目录已不可用，请重新选择。')
      }

      const registry = agents(ctx)
      const defaults = ctx.get('agentDefaultModel' as never) as { currentSelection(): NonNullable<CreateAgentOptions['agentOptions']> } | undefined
      const presets = ctx.get('agentPresets' as never) as {
        resolve(id: string | undefined): Promise<{ id: string }>
        mount(ctx: Context, id: string): Promise<unknown>
      } | undefined
      if (!registry || !defaults) throw new Error('Native Agent Registry is unavailable')
      const presetId = (await presets?.resolve(undefined))?.id
      const workspace = await workspaces.create(cwd)
      const id = SessionId('session-' + randomUUID())
      sessionId = id
      await registry.create({
        sessionId: id,
        meta: { cwd: workspace.path, parentSession: parentId, isSeeded: true, ...(presetId ? { agentPreset: presetId } : {}) },
        seed: buildForkSeed(stored, checkpoint.seq),
        inheritedEventCount: SessionLogOffset(checkpoint.seq + 1),
        agentOptions: defaults.currentSelection(),
        setup: async (agentCtx) => {
          installModelSelection(agentCtx)
          if (presets && presetId) await presets.mount(agentCtx, presetId)
        },
      })
      await workspace.attachSession(id)
    }
    const child = ctx.sessions.get(sessionId)
    if (!child) throw new Error('Native branch was not published')
    if (!await ctx.sessions.flush(child)) throw new Error('Native branch has no persistence listener')
    const persisted = await ctx.sessionPersistence.open(sessionId, 'read')
    try {
      const { events: seed } = await persisted.read(0)
      if (!seed.some((event) => event.type === 'session/end-seed')) throw new Error('Native branch is not yet readable')
    } finally {
      await persisted.close()
    }
    // Verify the same opening snapshot the native UI needs before navigating to the new branch.
    const frames = controller.follow({ address: { kind: 'session', sessionId }, maxMessages: 1 }, AbortSignal.timeout(5_000))
    for await (const frame of frames) {
      if (frame.type !== 'snapshot') throw new Error('Native branch snapshot is unavailable')
      return { sessionId }
    }
    throw new Error('Native branch snapshot did not arrive')
  } catch (error) {
    const remote = error as { code?: string; details?: { sessionId?: unknown } } | null
    const orphan = remote?.code === 'session/workspace-attach-failed' ? remote.details?.sessionId : undefined
    if (!sessionId && typeof orphan === 'string' && /^session-[a-f0-9-]{36}$/.test(orphan)) sessionId = SessionId(orphan)
    if (sessionId) {
      try {
        await workspaces.archiveSession(sessionId)
      } catch {
        console.warn('[ChatDS] Failed to archive unverified Agent work branch')
        throw new Error('工作分支未通过验证，自动归档失败。请在 DSH 会话列表中检查该分支。', { cause: error })
      }
    }
    throw error
  }
}

export function sendConclusion(ctx: Context, parent: string, text: string): void {
  const agent = agents(ctx)?.get(SessionId(parent))
  if (!agent) throw new Error('Parent Agent is not active')
  agent.send(createUserMessage({
    content: [{ type: 'text', text: `来自用户确认的 Agent Side Chat 讨论结论：\n\n${text}` }],
    source: { kind: 'user' },
  }), 'next-turn', false)
}
