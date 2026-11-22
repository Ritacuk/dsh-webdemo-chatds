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
interface WorkspaceEntity {
  id: string
  path: string
  title?: string
  sessionIds?: readonly string[]
}
interface WorkspaceRegistry {
  create(path: string, title?: string): Promise<WorkspaceEntity & { attachSession(id: SessionId): Promise<void> }>
  get(id: string): WorkspaceEntity | undefined
  list(): readonly WorkspaceEntity[]
  resolveByPath(path: string): Promise<WorkspaceEntity | undefined>
  archiveSession(id: SessionId): Promise<void>
}

function agents(ctx: Context): AgentRegistry | undefined {
  // dsh-agent is provided by the native Host, and the chat surface may run without it.
  return ctx.get('agents' as never) as AgentRegistry | undefined
}

export class WorkBranchDirectoryRequired extends Error {}

/** R8.5:工作分支创建参数——优先选已注册 DSH 工作区,兼容旧的原始目录路径。 */
export interface WorkBranchOptions {
  directory?: string
  workspaceId?: string
}

/** 工作分支可用的 DSH 工作区清单(父会话工作区优先;供选择器渲染)。 */
export async function listWorkBranchWorkspaces(ctx: Context, parent: string): Promise<{
  available: boolean
  reason?: string
  workspaces: { id: string; title?: string; path: string; sessions: number }[]
  parentWorkspaceId?: string
}> {
  const workspaces = ctx.get('workspaceRegistry' as never) as WorkspaceRegistry | undefined
  if (!workspaces?.list) return { available: false, reason: 'DSH 工作区服务不可用。', workspaces: [] }
  let parentWorkspaceId: string | undefined
  try {
    const source = await ctx.sessionPersistence.open(SessionId(parent), 'read')
    try {
      const headerCwd = source.header.cwd
      if (headerCwd) parentWorkspaceId = (await workspaces.resolveByPath(headerCwd))?.id
    } finally {
      await source.close()
    }
  } catch {
    // 父会话头部不可读时只影响默认选中,不阻塞清单
  }
  return {
    available: true,
    workspaces: workspaces.list().map((workspace) => ({
      id: workspace.id,
      ...(workspace.title !== undefined ? { title: workspace.title } : {}),
      path: workspace.path,
      sessions: workspace.sessionIds?.length ?? 0,
    })),
    ...(parentWorkspaceId !== undefined ? { parentWorkspaceId } : {}),
  }
}

export async function createWorkBranch(
  ctx: Context, parent: string, events: readonly SessionEvent[], messageId: string, options: WorkBranchOptions = {},
) {
  const { directory, workspaceId } = options
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
    // R8.5:目标工作目录解析——已注册 DSH 工作区 id 优先(默认父会话所在工作区),
    // 兼容旧的原始目录路径(仅"新建工作区"流程使用)。路径与父会话一致时走纯 fork。
    let targetCwd: string | undefined
    if (typeof workspaceId === 'string' && workspaceId !== '') {
      const workspace = workspaces.get(workspaceId)
      if (!workspace) throw new WorkBranchDirectoryRequired('所选 DSH 工作区不存在或已被删除，请重新选择。')
      targetCwd = workspace.path
    } else if (directory) {
      if (!isAbsolute(directory)) throw new WorkBranchDirectoryRequired('请选择 Agent 工作目录。')
      const canonical = await realpath(directory).catch(() => undefined)
      if (!canonical || !(await stat(canonical).catch(() => undefined))?.isDirectory()) {
        throw new WorkBranchDirectoryRequired('所选工作目录已不可用，请重新选择。')
      }
      targetCwd = canonical
    } else if (headerCwd) {
      targetCwd = headerCwd
    } else {
      throw new WorkBranchDirectoryRequired('请选择工作分支使用的 DSH 工作区。')
    }
    if (targetCwd === undefined || !(await stat(targetCwd).catch(() => undefined))?.isDirectory()) {
      throw new WorkBranchDirectoryRequired('所选 DSH 工作区的目录已不可访问，请重新选择。')
    }
    if (headerCwd !== undefined && targetCwd === headerCwd) {
      const branch = await controller.fork({ sessionId: parentId, atSeq: checkpoint.seq, allowMigration: false })
      sessionId = branch.sessionId
    } else {
      const registry = agents(ctx)
      const defaults = ctx.get('agentDefaultModel' as never) as { currentSelection(): NonNullable<CreateAgentOptions['agentOptions']> } | undefined
      const presets = ctx.get('agentPresets' as never) as {
        resolve(id: string | undefined): Promise<{ id: string }>
        mount(ctx: Context, id: string): Promise<unknown>
      } | undefined
      if (!registry || !defaults) throw new Error('Native Agent Registry is unavailable')
      const presetId = (await presets?.resolve(undefined))?.id
      // create() 按规范路径幂等:已注册工作区返回既有实体,新路径才创建注册(官方语义)。
      const workspace = await workspaces.create(targetCwd)
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
