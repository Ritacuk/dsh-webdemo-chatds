import type { MessageProvenance } from '@dsh-chat/shared'
import { projectSharedMessage, sharedMessageRecord, type SharedMessageRecord } from './sharing/workspace.js'
/**
 * WebChat uses detached Session instances with plugin-owned logs.
 * Legacy Main logs are read in place and copied on first edit. Agent Side Chat keeps its DSH writer.
 *
 * 写入路径(对齐 dsh-agent-loop/src/index.ts createStoredSession 的官方序列):
 *   prepare → create persistence handle → store initial suffix → enter + announce;
 *   JSONL 路由独占已发布事件写入；sessions.flush 等待官方持久化屏障。
 *
 * 恢复路径:open(id,'write') → read(0) → interruptedTurnClosers()(dsh-session/src/repair.ts)
 *   → sessions.prepare({ seed, meta: 存储头原样, inheritedEventCount, eventState:'detached' })
 *   → enter + announce → 接回事件路由。
 *
 * 读取路径:live 会话用 snapshotEvents();否则 open(id,'read') 读全量。
 * 列表索引缓存与附件索引在 WorkspaceStore(KV,可重建)。
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { interruptedTurnClosers, Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import {
  dshContentToReplyBlocks,
  type AssistantMessage as DemoAssistant,
  type Message as DemoMessage,
} from '@dsh-chat/shared'
import type { WireSessionSummary } from '@dsh-chat/shared'
import type { WorkspaceStore } from './store.js'
import { writePluginRecord } from './plugin-record.js'

declare module '@deepseek-ai/dsh-session' {
  interface PluginRecordMap {
    'plugin:chat-workspace/branch-selection': { messageId: string }
    'plugin:chat-workspace/rich-usage': { messageId: string; usage: NonNullable<DemoAssistant['usage']> }
  }
}

/** 一次 live 会话与其写句柄。 */
interface LiveEntry {
  session: Session
  handle?: SessionHandle
  detach?: () => void
  saving?: Promise<void>
}

export class WorkspaceSessionUnavailable extends Error {
  constructor(readonly id: string, options?: { cause?: unknown }) {
    super('该聊天会话暂时无法安全打开或保存。原始记录已保留。', options)
  }
}

export class WorkspaceSessions {
  private readonly live = new Map<string, LiveEntry>()
  private readonly opening = new Map<string, Promise<Session | undefined>>()
  private readonly unavailable = new Map<string, WorkspaceSessionUnavailable>()
  /** R8.5:由 create({draft}) 声明的占位会话;首条消息落盘前由 persistIndex 维持 draft 标记。 */
  private readonly pendingDraft = new Set<string>()
  private stopping = false

  constructor(
    private readonly ctx: Context,
    private readonly store: WorkspaceStore,
    private readonly sidecar = false,
  ) {}

  owns(id: string): boolean {
    return /^chatws-[a-zA-Z0-9-]+$/.test(id) && id.startsWith('chatws-side-') === this.sidecar
  }

  /** 停用时:flush 全部活动句柄并关闭。 */
  async disposeAll(): Promise<void> {
    this.stopping = true
    await Promise.allSettled(this.opening.values())
    const entries = [...this.live.values()]
    this.live.clear()
    await Promise.allSettled(entries.map((entry) => this.flushEntry(entry)))
    for (const entry of entries) {
      try {
        entry.detach?.()
      } finally {
        await entry.handle?.close().catch(() => {})
      }
    }
  }

  newKey(): string {
    return `${this.sidecar ? 'chatws-side' : 'chatws-local'}-${randomUUID()}`
  }

  async reserveImport(id: string, createdAt: number): Promise<void> {
    const table = (await this.store.ensure()).table('sessions')
    if (table.get(id)) throw new Error('会话 ID 已存在。')
    await table.put(id, { id, title: null, createdAt, updatedAt: createdAt, hidden: true, isolated: true, messageCount: 0 })
  }

  async sharingTarget(id: string): Promise<boolean> {
    const record = (await this.store.ensure()).table('sessions').get(id)
    return !record?.hidden || record.sharingPending === true
  }

  async reserveSharingReplica(id: string, createdAt: number, provenance: MessageProvenance): Promise<void> {
    const table = (await this.store.ensure()).table('sessions')
    const record = table.get(id)
    if (record?.sharingPending) return
    if (record) throw new Error('Chat identity is already in use')
    await table.put(id, {
      id, title: 'Shared conversation', manualTitle: 'Shared conversation',
      createdAt, updatedAt: createdAt, hidden: true, isolated: true, sharingPending: true, provenance, messageCount: 0,
    })
  }

  async publishSharingReplica(id: string): Promise<void> {
    const table = (await this.store.ensure()).table('sessions')
    const record = table.get(id)
    if (!record?.sharingPending || !record.messageCount) return
    await table.update(id, (current) => ({ ...current, sharingPending: false, hidden: false }))
  }

  async importFingerprints(): Promise<Set<string>> {
    const table = (await this.store.ensure()).table('sessions')
    return new Set([...table.entries()].flatMap(([, record]) => record.importFingerprint ? [record.importFingerprint] : []))
  }

  async publishImport(id: string, title: string | null, updatedAt: number, pinned: boolean, importFingerprint: string | undefined, archived = false): Promise<void> {
    const table = (await this.store.ensure()).table('sessions')
    const record = table.get(id)
    if (!record?.hidden) throw new Error('待导入会话不存在。')
    await table.update(id, (current) => ({
      ...current, hidden: false, updatedAt, pinned, importFingerprint, archived,
      ...(title?.trim() ? { title: title.trim(), manualTitle: title.trim() } : {}),
    }))
  }

  /** 创建新会话(写句柄 + KV 索引)。draft 会话在首条消息落盘前不进入历史列表。 */
  async create(key = this.newKey(), options: { draft?: boolean } = {}): Promise<Session> {
    if (!this.owns(key) || this.live.has(key) || this.opening.has(key)) throw new Error('Invalid or occupied ChatDS session identity')
    if (options.draft === true) this.pendingDraft.add(key)
    const session = await this.withWriter(key, true)
    if (!session) throw new WorkspaceSessionUnavailable(key)
    return session
  }

  /** 恢复既有会话为 live；只有确实不存在才返回 undefined。 */
  async resume(id: string): Promise<Session | undefined> {
    if (!this.owns(id)) return undefined
    this.assertAvailable(id)
    return this.opening.get(id) ?? this.live.get(id)?.session ?? this.withWriter(id, false)
  }

  isUnavailable(id: string): boolean {
    return this.unavailable.has(id)
  }

  private assertAvailable(id: string): void {
    const failure = this.unavailable.get(id)
    if (failure) throw failure
    if (this.stopping) throw new WorkspaceSessionUnavailable(id)
  }

  private fail(id: string, stage: string, error: unknown): WorkspaceSessionUnavailable {
    const known = this.unavailable.get(id)
    if (known) return known
    // R8:保留原始错误(cause)与消息,便于归档导入等路径的可诊断性
    const failure = new WorkspaceSessionUnavailable(id, { cause: error })
    this.unavailable.set(id, failure)
    console.warn('[ChatDS] Session persistence failed', {
      scope: this.sidecar ? 'side' : 'main',
      stage,
      kind: error instanceof Error && /seq mismatch|contigu/i.test(error.message) ? 'sequence' : 'storage',
      detail: error instanceof Error ? error.message : String(error),
    })
    return failure
  }

  private async withWriter(id: string, create: boolean): Promise<Session | undefined> {
    this.assertAvailable(id)
    const pending = this.openWriter(SessionId(id), create)
    this.opening.set(id, pending)
    try {
      return await pending
    } finally {
      this.opening.delete(id)
    }
  }

  private async openWriter(id: SessionId, create: boolean): Promise<Session | undefined> {
    let handle: SessionHandle | undefined
    let detach: (() => void) | undefined
    try {
      if (!this.sidecar || await this.isIsolated(id)) return await this.openLocal(id, create)
      let session: Session
      if (create) {
        session = this.ctx.sessions.prepare(id)
        handle = await this.ctx.sessionPersistence.create(session.header, { inheritedEventCount: session.inheritedEventCount })
        const initial = session.snapshotEvents(SessionLogOffset(0))
        if (initial.length > 0) await handle.append(initial)
      } else {
        try {
          handle = await this.ctx.sessionPersistence.open(id, 'write')
        } catch (error) {
          if (error instanceof Error && error.name === 'SessionPersistenceNotFoundError') return undefined
          throw error
        }
        const { events } = await handle.read(0)
        const closers = interruptedTurnClosers(events)
        session = this.ctx.sessions.prepare(id, {
          seed: [...events, ...closers],
          inheritedEventCount: handle.inheritedEventCount,
          eventState: 'detached',
          meta: handle.header,
        })
        // Repair events and the constructor’s end-seed marker were never published.
        const unpublished = session.snapshotEvents(SessionLogOffset(events.length))
        if (unpublished.length > 0) await handle.append(unpublished)
      }
      await handle.flush()
      if (this.stopping) throw new WorkspaceSessionUnavailable(id)
      detach = this.ctx.sessions.enter(session)
      const entry: LiveEntry = { session, handle, detach }
      this.live.set(id, entry)
      this.ctx.sessions.announce(session)
      await this.flushEntry(entry)
      return session
    } catch (error) {
      this.live.delete(id)
      try {
        detach?.()
      } finally {
        await handle?.close().catch(() => {})
      }
      throw this.fail(id, create ? 'create' : 'resume', error)
    }
  }

  private async isIsolated(id: string): Promise<boolean> {
    if (!this.sidecar && id.startsWith('chatws-local-')) return true
    const domain = await this.store.ensure()
    return domain.table('sessions').get(id)?.isolated === true || Boolean(domain.table('session_logs').get(id))
  }

  private async localSnapshot(id: string): Promise<{ header: SessionHeader; events: SessionEvent[]; inheritedEventCount?: number } | undefined> {
    const record = (await this.store.ensure()).table('session_logs').get(id)
    return record && JSON.parse(record.snapshot)
  }

  private async openLocal(id: SessionId, create: boolean): Promise<Session | undefined> {
    let snapshot = await this.localSnapshot(id)
    if (!create && !snapshot && !await this.isIsolated(id)) {
      try {
        const handle = await this.ctx.sessionPersistence.open(id, 'read')
        try {
          snapshot = { header: handle.header, inheritedEventCount: handle.inheritedEventCount, events: [...(await handle.read(0)).events] }
        } finally {
          await handle.close()
        }
      } catch (error) {
        if (!(error instanceof Error) || error.name !== 'SessionPersistenceNotFoundError') throw error
      }
    }
    if (create && snapshot) throw new Error('WebChat session already exists')
    if (!create && !snapshot) return undefined
    const projections = this.ctx.sessions.messageProjections
    const session = snapshot
      ? Session.fromRestore(id, [...snapshot.events, ...interruptedTurnClosers(snapshot.events)], snapshot.header,
          SessionLogOffset(snapshot.inheritedEventCount ?? 0), 'detached', projections)
      : Session.create(id, undefined, undefined, undefined, projections)
    if (this.stopping) throw new WorkspaceSessionUnavailable(id)
    const entry: LiveEntry = { session }
    this.live.set(id, entry)
    // An independent Session has no attachment and never publishes native events.
    if (create) await this.flushEntry(entry)
    return session
  }

  /** 取 live 会话;必要时恢复。 */
  async liveSession(id: string): Promise<Session | undefined> {
    return this.resume(id)
  }

  /** 读一个会话的完整事件序列(live 直读;否则只读句柄)。 */
  async readEvents(id: string): Promise<readonly SessionEvent[] | undefined> {
    if (!this.owns(id)) return undefined
    this.assertAvailable(id)
    await this.opening.get(id)
    const entry = this.live.get(id)
    if (entry !== undefined) {
      return entry.session.snapshotEvents(SessionLogOffset(0))
    }
    try {
      if (await this.isIsolated(id)) return (await this.localSnapshot(id))?.events
      const handle = await this.ctx.sessionPersistence.open(SessionId(id), 'read')
      try {
        const read = await handle.read(0)
        return read.events
      } finally {
        await handle.close()
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'SessionPersistenceNotFoundError') return undefined
      throw this.fail(id, 'read', error)
    }
  }

  /** 列出工作区会话(KV 索引)。draft 占位会话(尚无消息)不进入列表。 */
  async list(): Promise<WireSessionSummary[]> {
    const domain = await this.store.ensure()
    const table = domain.table('sessions')
    const pins = domain.table('session_pins')
    const out: WireSessionSummary[] = []
    for (const [id, record] of table.entries()) {
      if (record.hidden) continue
      if (record.draft === true && record.messageCount === 0) continue
      out.push({
        id,
        title: record.title ?? '新对话',
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        messageCount: record.messageCount,
        ...(record.provenance ? { provenance: record.provenance } : {}),
        ...(record.remoteSources?.length ? { remoteSources: record.remoteSources } : {}),
        ...((pins.get(id)?.pinned ?? record.pinned) ? { pinned: true } : {}),
        ...(record.importFingerprint ? { imported: true } : {}),
        ...(record.archived ? { archived: true } : {}),
      })
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    return out
  }

  /** 隐藏会话(P1 无官方删除 API;持久日志保留,可撤销)。 */
  async hide(id: string): Promise<boolean> {
    const domain = await this.store.ensure()
    const table = domain.table('sessions')
    const record = table.get(id)
    if (record === undefined) return false
    await table.update(id, (current) => ({ ...current, hidden: true }))
    return true
  }

  async rename(id: string, title: string): Promise<boolean> {
    const domain = await this.store.ensure()
    const table = domain.table('sessions')
    const record = table.get(id)
    if (record === undefined || record.hidden) return false
    await table.update(id, (current) => ({ ...current, title, manualTitle: title }))
    return true
  }

  async setPinned(id: string, pinned: boolean): Promise<boolean> {
    const domain = await this.store.ensure()
    const record = domain.table('sessions').get(id)
    if (!record || record.hidden) return false
    await domain.table('session_pins').put(id, { pinned })
    return true
  }

  async setArchived(id: string, archived: boolean): Promise<boolean> {
    const table = (await this.store.ensure()).table('sessions')
    const record = table.get(id)
    if (!record || record.hidden) return false
    await table.update(id, (current) => ({ ...current, archived }))
    return true
  }

  async selectVersion(id: string, messageId: string): Promise<boolean> {
    const session = await this.liveSession(id)
    if (!session) return false
    const { versions } = replayChatSession(session.snapshotEvents(SessionLogOffset(0)))
    if (!Object.values(versions).some((siblings) => siblings.includes(messageId))) return false
    writePluginRecord(session, 'plugin:chat-workspace/branch-selection', { messageId })
    await this.flushSession(session)
    return true
  }

  async flushSession(session: Session): Promise<void> {
    const entry = this.live.get(session.id)
    if (!entry || entry.session !== session) throw new Error('ChatDS Session writer is unavailable')
    await this.flushEntry(entry)
  }

  /** 恢复显示。 */
  async unhide(id: string): Promise<boolean> {
    const domain = await this.store.ensure()
    const table = domain.table('sessions')
    const record = table.get(id)
    if (record === undefined) return false
    await table.update(id, (current) => ({ ...current, hidden: false }))
    return true
  }

  /** 把一个 live 会话的 KV 索引刷新为当前事实(标题投影/计数/更新时间)。 */
  async persistIndex(session: Session): Promise<void> {
    const domain = await this.store.ensure()
    const table = domain.table('sessions')
    const events = session.snapshotEvents(SessionLogOffset(0))
    let title: string | null = null
    const messageCount = events.filter(
      (event) => event.type === 'user/message' || event.type === 'assistant/message' || (event.type as string) === sharedMessageRecord,
    ).length
    const remoteSources = new Map<string, string>()
    const importedTimes = new Map(events.flatMap((event) => {
      if ((event.type as string) !== 'plugin:chat-workspace/imported-message') return []
      const { id, createdAt } = event.data as { id: string; createdAt: number }
      return Number.isFinite(createdAt) ? [[id, createdAt] as const] : []
    }))
    let lastActivity = 0
    for (const event of events) {
      if (event.type === 'session/title') title = event.data.title
      if ((event.type as string) === sharedMessageRecord) {
        const source = (event.data as unknown as SharedMessageRecord).source
        remoteSources.set(source.deviceId, source.deviceName)
        lastActivity = Math.max(lastActivity, Date.parse(source.createdAt))
      } else if (event.type === 'user/message') {
        lastActivity = Math.max(lastActivity, importedTimes.get(event.data.id) ?? event.time)
      } else if (event.type === 'assistant/message') {
        lastActivity = Math.max(lastActivity, importedTimes.get(event.data.message.id) ?? event.time)
      }
    }
    // R8.5:draft 占位在首条消息落盘时解除;此后与普通会话一致。
    const pendingDraft = this.pendingDraft.has(session.id)
    if (messageCount > 0) this.pendingDraft.delete(session.id)
    const next = (previous?: ReturnType<typeof table.get>) => ({
      id: session.id,
      title: previous?.manualTitle ?? title,
      ...(previous?.manualTitle === undefined ? {} : { manualTitle: previous.manualTitle }),
      ...(previous?.pinned === undefined ? {} : { pinned: previous.pinned }),
      ...(previous?.archived === undefined ? {} : { archived: previous.archived }),
      ...(messageCount === 0 && (pendingDraft || previous?.draft) ? { draft: true } : {}),
      createdAt: previous?.createdAt ?? session.header.createdAt,
      updatedAt: Math.max(previous?.updatedAt ?? session.header.createdAt, lastActivity),
      messageCount,
      hidden: previous?.hidden ?? false,
      ...(previous?.provenance ? { provenance: previous.provenance } : {}),
      ...(remoteSources.size ? { remoteSources: [...remoteSources].slice(-200).map(([deviceId, deviceName]) => ({ deviceId, deviceName })) } : {}),
      ...(previous?.sharingPending ? { sharingPending: true } : {}),
      ...(previous?.isolated ? { isolated: true } : {}),
      ...(previous?.importFingerprint === undefined ? {} : { importFingerprint: previous.importFingerprint }),
    })
    if (table.get(session.id)) await table.update(session.id, next)
    else await table.put(session.id, next())
  }

  private flushEntry(entry: LiveEntry): Promise<void> {
    const pending = (entry.saving ?? Promise.resolve()).then(() => this.saveEntry(entry))
    entry.saving = pending
    return pending
  }

  private async saveEntry(entry: LiveEntry): Promise<void> {
    const failure = this.unavailable.get(entry.session.id)
    if (failure) throw failure
    try {
      // handle.flush() alone does not drain the JSONL backend's live buffer.
      if (entry.handle) {
        if (!await this.ctx.sessions.flush(entry.session)) throw new Error('DSH has no live session durability listener')
      } else {
        const table = (await this.store.ensure()).table('session_logs')
        const { session } = entry
        await table.put(session.id, { snapshot: JSON.stringify({
          header: session.header, inheritedEventCount: session.inheritedEventCount, events: session.snapshotEvents(SessionLogOffset(0)),
        }) })
      }
      await this.persistIndex(entry.session)
    } catch (error) {
      throw this.fail(entry.session.id, 'flush', error)
    }
  }
}

/** 事件流 → 页面消息模型(demo 的 Message[];附件引用由 plugin 记录恢复)。 */

/** 编辑/重新生成/继续生成的分支记录(写入 plugin:chat-workspace/branch;V0 接线)。 */
export interface BranchRecord {
  turn: number
  action: 'edit' | 'regenerate' | 'continue'
  /** 从可见路径移除的消息 id(旧路径尾段;regenerate 另含本轮提问副本;continue 另含续写块)。 */
  hideIds: string[]
  reuseUser?: true
  /** continue:续写块并入的原回复 id。 */
  mergeIntoId?: string
  /** continue:承载新流块的助手消息 id(其块并入 mergeIntoId 后隐藏)。 */
  continueReplyId?: string
}

/**
 * 应用分支记录:hideIds 移出可见路径;continue 的续写块并入原回复。
 * 消息对象在 eventsToWireMessages 内新建,允许就地合并块。
 */
function applyBranchRecords(
  messages: DemoMessage[],
  records: readonly (BranchRecord & { at: number })[],
  selections: ReadonlyMap<number, { id: string; exact: boolean }[]>,
  hasTurnStarts: boolean,
  imported: ReadonlyMap<string, ImportedMessage>,
): { messages: DemoMessage[]; versions: Record<string, string[]>; tree: { message: DemoMessage; parent: string | null }[] } {
  const byId = new Map<string, DemoMessage>()
  const positions = new Map<string, number>()
  messages.forEach((message, index) => { byId.set(message.id, message); positions.set(message.id, index) })
  const excluded = new Set<string>()
  const replacements = new Map<string, string>()
  for (const record of records) {
    if (record.action === 'edit') {
      const replacement = messages[hasTurnStarts ? record.at : record.at - 2]
      if (replacement?.role === 'user' && record.hideIds[0]) replacements.set(replacement.id, record.hideIds[0])
      continue
    }
    if (record.action === 'regenerate') {
      if (record.reuseUser) {
        const replacement = messages[record.at]
        if (replacement?.role === 'assistant' && record.hideIds[0]) replacements.set(replacement.id, record.hideIds[0])
        continue
      }
      const duplicateId = record.hideIds.at(-1)
      const index = duplicateId === undefined ? undefined : positions.get(duplicateId)
      const replacement = index === undefined ? undefined : messages[index + 1]
      if (duplicateId && replacement?.role === 'assistant' && record.hideIds[0]) {
        excluded.add(duplicateId)
        replacements.set(replacement.id, record.hideIds[0])
      }
      continue
    }
    for (const id of record.hideIds) excluded.add(id)
    const base = record.mergeIntoId !== undefined ? byId.get(record.mergeIntoId) : undefined
    const continuation = record.continueReplyId !== undefined ? byId.get(record.continueReplyId) : undefined
    if (base?.role === 'assistant' && continuation?.role === 'assistant') {
      base.blocks = [...base.blocks, ...continuation.blocks]
      base.usage = continuation.usage ?? base.usage
      base.stopReason = continuation.stopReason ?? base.stopReason
      base.stopDetails = continuation.stopDetails ?? base.stopDetails
      base.status = continuation.status
      base.error = continuation.error
    }
  }
  const parents = new Map<string, string | null>()
  const children = new Map<string | null, string[]>()
  const selected = new Map<string | null, string>()
  let leaf: string | null = null
  const choose = (id: string, exact = false) => {
    if (!parents.has(id)) return
    selected.set(parents.get(id) ?? null, id)
    leaf = id
    if (exact) {
      selected.delete(id)
      for (let child = id, ancestor = parents.get(child); ancestor != null; ancestor = parents.get(child)) {
        selected.set(parents.get(ancestor) ?? null, ancestor)
        child = ancestor
      }
    }
    while (selected.has(leaf)) leaf = selected.get(leaf)!
  }
  for (let index = 0; index <= messages.length; index++) {
    for (const selection of selections.get(index) ?? []) choose(selection.id, selection.exact)
    const message = messages[index]
    if (!message || excluded.has(message.id)) continue
    const replaced = replacements.get(message.id)
    const explicit = imported.get(message.id)
    const parent: string | null = message.provenance ? (message.parentId ?? null) : explicit ? explicit.parent
      : replaced && parents.has(replaced) ? (parents.get(replaced) ?? null) : leaf
    parents.set(message.id, parent)
    const siblings = children.get(parent) ?? []
    siblings.push(message.id)
    children.set(parent, siblings)
    if (!message.provenance || (!selected.has(parent) && leaf === parent)) choose(message.id)
  }
  const path: DemoMessage[] = []
  const versions: Record<string, string[]> = Object.create(null) as Record<string, string[]>
  for (let id = selected.get(null); id !== undefined; id = selected.get(id)) {
    const message = byId.get(id)
    if (!message) break
    path.push(message)
    const siblings = children.get(parents.get(id) ?? null)
    if (siblings && siblings.length > 1) versions[id] = siblings
  }
  return { messages: path, versions, tree: [...parents].map(([id, parent]) => ({ message: byId.get(id)!, parent })) }
}

export function eventsToWireMessages(events: readonly SessionEvent[]): DemoMessage[] {
  return replayChatSession(events).messages
}

interface ImportedMessage {
  id: string
  parent: string | null
  createdAt: number
  thinking: boolean
  search: boolean
  status: string
  templates?: string[]
}

export function replayChatSession(events: readonly SessionEvent[]) {
  // 附件记录先于消息映射收集(plugin 记录可能出现在对应 user/message 之后)。
  const attachmentsByUserMessage = new Map<string, {
    id: string
    name: string
    size: number
    handling: string
    mimeType: string
  }[]>()
  const branchRecords: (BranchRecord & { at: number })[] = []
  const selections = new Map<number, { id: string; exact: boolean }[]>()
  const imported = new Map<string, ImportedMessage>()
  let messagesSoFar = 0
  let hasTurnStarts = false
  const failures = new Map<number, DemoAssistant['error']>()
  const richUsage = new Map<string, NonNullable<DemoAssistant['usage']>>()
  for (const event of events) {
    if (event.type === 'turn/start') hasTurnStarts = true
    if (event.type === 'assistant/message' || event.type === 'user/message' || (event.type as string) === sharedMessageRecord) messagesSoFar++
    if (event.type === 'turn/end' && event.data.reason.kind === 'error') {
      const { message, code, status } = event.data.reason.error
      failures.set(event.data.turn, {
        kind: 'stream', message,
        ...(code === undefined ? {} : { code }),
        ...(status === undefined ? {} : { status }),
      })
    }
    // plugin 记录类型经 PluginRecordMap 合并(见 turns.ts);此处用字符串比较读取,
    // 避免跨文件类型增强在增量编译下的可见性差异。
    if ((event.type as string) === 'plugin:chat-workspace/attachments') {
      const data = (event as { data: unknown }).data as {
        userMessageId: string
        attachments: { id: string; name: string; size: number; handling: string; mimeType: string }[]
      }
      attachmentsByUserMessage.set(data.userMessageId, data.attachments)
    }
    if ((event.type as string) === 'plugin:chat-workspace/branch') {
      branchRecords.push({ ...((event as { data: unknown }).data as BranchRecord), at: messagesSoFar })
    }
    if ((event.type as string) === 'plugin:chat-workspace/rich-usage') {
      const { messageId, usage } = event.data as unknown as { messageId: string; usage: NonNullable<DemoAssistant['usage']> }
      richUsage.set(messageId, usage)
    }
    if ((event.type as string) === 'plugin:chat-workspace/imported-message') {
      const info = event.data as unknown as ImportedMessage
      imported.set(info.id, info)
    }
    if ((event.type as string) === 'plugin:chat-workspace/branch-selection') {
      const { messageId, exact } = event.data as unknown as { messageId?: string; exact?: boolean }
      if (typeof messageId !== 'string') continue
      const previous = selections.get(messagesSoFar) ?? []
      previous.push({ id: messageId, exact: exact === true })
      selections.set(messagesSoFar, previous)
    }
  }
  const messages: DemoMessage[] = []
  for (const event of events) {
    if ((event.type as string) === sharedMessageRecord) {
      messages.push(projectSharedMessage(event.data as unknown as SharedMessageRecord))
      continue
    }
    if ((event.type as string) === 'plugin:chat-workspace/attachments') {
      continue
    }
    if (event.type === 'user/message') {
      const message = event.data
      const files = (attachmentsByUserMessage.get(message.id) ?? []).map((attachment) => ({
        id: attachment.id,
        serverId: null,
        ...(attachment.handling === 'unavailable' ? { unavailable: true } : {}),
        ...(attachment.handling === 'archive-only' ? { archivedCopy: true } : {}),
        name: attachment.name,
        size: attachment.size,
        isImage: /^image\//.test(attachment.mimeType),
        mimeType: attachment.mimeType,
      }))
      messages.push({
        id: message.id,
        role: 'user',
        content: textOfBlocks(message.content),
        files,
        createdAt: imported.get(message.id)?.createdAt ?? event.time,
      })
    } else if (event.type === 'assistant/message') {
      const data = event.data as AssistantSettlementData
      const replay = lastFinishReplay(data.stream)
      const usage = richUsage.get(data.message.id) ?? replay?.usage
      const failure = failures.get(event.data.turn)
      const origin = imported.get(data.message.id)
      messages.push({
        id: data.message.id,
        role: 'assistant',
        createdAt: origin?.createdAt ?? event.time,
        model: data.message.source.model ?? null,
        prefix: origin === undefined,
        ...(origin ? { thinking: origin.thinking, search: origin.search } : {}),
        ...(origin?.status === 'CONTENT_FILTER' ? { stopReason: 'refusal' as const } : {}),
        status: data.interrupted === true ? 'stopped' : failure !== undefined ? 'error' : 'done',
        ...(failure === undefined ? {} : { error: failure }),
        blocks: [...dshContentToReplyBlocks(data.message.content), ...(origin?.templates ?? []).map((text) => ({
          type: 'text' as const, isTemplate: true as const, text,
        }))],
        ...(replay?.stopReason !== undefined ? { stopReason: replay.stopReason } : {}),
        ...(replay?.stopDetails !== undefined ? { stopDetails: replay.stopDetails } : {}),
        ...(usage !== undefined ? { usage } : {}),
        ...(data.message.source.provider === 'deepseek-rich' ? { usageSource: 'rich' as const } : {}),
        ...(replay?.latestReminder !== undefined ? { latestReminder: replay.latestReminder } : {}),
      } satisfies DemoAssistant)
    }
  }
  return applyBranchRecords(messages, branchRecords, selections, hasTurnStarts, imported)
}

/** assistant/message 事件数据中本插件用到的字段。 */
interface AssistantSettlementData {
  message: { id: string; content: readonly unknown[]; source: { provider?: string; model?: string } }
  interrupted?: true
  stream?: { type: 'chunk'; time: number; chunk: { type: string; replayState?: { response?: RichReplayResponse } } }[]
}

/** finish 块内的适配器私有回放数据(native stop reason / usage)。 */
export interface RichReplayResponse {
  latestReminder?: string
  stopReason?: DemoAssistant['stopReason']
  stopDetails?: DemoAssistant['stopDetails']
  usage?: DemoAssistant['usage']
  requestId?: string
  nativeModel?: string
}

function lastFinishReplay(
  stream: AssistantSettlementData['stream'],
): RichReplayResponse | undefined {
  if (stream === undefined) return undefined
  for (let i = stream.length - 1; i >= 0; i--) {
    const record = stream[i]
    if (record?.type === 'chunk' && record.chunk.type === 'finish') {
      return record.chunk.replayState?.response
    }
  }
  return undefined
}

function textOfBlocks(content: readonly { type: string; text?: string }[]): string {
  return content
    .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('')
}
