import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionLogOffset, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { writePluginRecord } from './plugin-record.js'
import { eventsToWireMessages, WorkspaceSessionUnavailable, type WorkspaceSessions } from './sessions.js'
import type { TurnRunner } from './turns.js'
import { currentProfile } from './profile.js'
import { sendConclusion } from './agent-bridge.js'

const recordType = 'plugin:chat-workspace/sidecar-context'

interface ParentSnapshot {
  parent: string
  checkpoint: number | null
  transcript: string
}

declare module '@deepseek-ai/dsh-session' {
  interface PluginRecordMap {
    [recordType]: ParentSnapshot
  }
}

export function sidecarParentContext(session: Session): ParentSnapshot | undefined {
  const events = session.snapshotEvents(SessionLogOffset(0))
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event && (event.type as string) === recordType) {
      const value = event.data as Partial<ParentSnapshot>
      if (typeof value.parent === 'string' && (typeof value.checkpoint === 'number' || value.checkpoint === null) && typeof value.transcript === 'string') {
        return { parent: value.parent, checkpoint: value.checkpoint, transcript: value.transcript }
      }
    }
  }
  return undefined
}

const isCheckpoint = (event: SessionEvent) => event.type === 'turn/end' && event.data.reason.kind === 'completed'

export function checkpointTranscript(events: readonly SessionEvent[], checkpoint: number): string {
  const rows: string[] = []
  let remaining = 12_000
  for (let i = events.length - 1; i >= 0 && rows.length < 12 && remaining > 0; i--) {
    const event = events[i]
    if (!event || event.seq > checkpoint) continue
    const message = event.type === 'user/message' && event.data.source.kind === 'user' ? event.data
      : event.type === 'assistant/message' ? event.data.message : undefined
    if (!message) continue
    const text = message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim()
    if (!text) continue
    const row = (event.type === 'user/message' ? '用户' : 'Agent') + '：' + text.slice(0, Math.min(2400, remaining))
    rows.push(row)
    remaining -= row.length
  }
  return rows.reverse().join('\n\n')
}

export class SidecarContext {
  private readonly syncing = new Set<string>()

  constructor(private readonly ctx: Context, private readonly sessions: WorkspaceSessions, private readonly turns: TurnRunner) {}

  private sessionKey(parent: string, profile = currentProfile(this.ctx)): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(parent) || parent.startsWith('chatws-')) throw new Error('Invalid parent Agent session')
    const scope = profile + '\0' + parent
    return 'chatws-side-' + createHash('sha256').update(scope).digest('hex').slice(0, 32)
  }

  private async linkedSession(parent: string): Promise<{ id: string; session?: Session }> {
    const id = this.sessionKey(parent)
    const session = await this.sessions.liveSession(id)
    if (currentProfile(this.ctx) === 'desktop') {
      const hasMessages = (item: Session) => item.snapshotEvents(SessionLogOffset(0))
        .some((event) => event.type === 'user/message' || event.type === 'assistant/message')
      if (!session || !hasMessages(session)) {
        // Desktop previously used this key when the launcher did not export DSH_PROFILE.
        const oldId = this.sessionKey(parent, 'default')
        const old = await this.sessions.liveSession(oldId)
        if (old && sidecarParentContext(old)?.parent === parent && (!session || hasMessages(old))) {
          return { id: oldId, session: old }
        }
      }
    }
    return { id, session }
  }

  private async readParent(parent: string): Promise<readonly SessionEvent[]> {
    const id = SessionId(parent)
    try {
      const handle = await this.ctx.sessionPersistence.open(id, 'read')
      try {
        return (await handle.read(0)).events
      } finally {
        await handle.close()
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'SessionPersistenceNotFoundError' && this.ctx.sessions.get(id)) return []
      throw error
    }
  }

  async describe(parent: string) {
    const checkpoints = (await this.readParent(parent)).filter(isCheckpoint).slice(-50).reverse()
      .map(({ seq, time }) => ({ seq: Number(seq), time }))
    try {
      const { id, session } = await this.linkedSession(parent)
      const snapshot = session && sidecarParentContext(session)
      return { checkpoints, sessionId: snapshot && id, selected: snapshot?.checkpoint, transcript: snapshot?.transcript }
    } catch (error) {
      if (error instanceof WorkspaceSessionUnavailable) return { unavailable: true }
      throw error
    }
  }

  async sync(parent: string, checkpoint: unknown) {
    if (this.syncing.has(parent)) throw new Error('Side chat is busy')
    this.syncing.add(parent)
    try {
      const { id: sessionId, session: existing } = await this.linkedSession(parent)
      if (this.turns.isRunning(sessionId)) throw new Error('Side chat is busy')
      const events = await this.readParent(parent)
      const selected = checkpoint === undefined ? (events.filter(isCheckpoint).at(-1)?.seq ?? null) : checkpoint
      if (selected !== null && (typeof selected !== 'number' || !events.some((event) => event.seq === selected && isCheckpoint(event)))) {
        throw new Error('Invalid parent checkpoint')
      }
      const session = existing ?? await this.sessions.create(sessionId)
      if (this.turns.isRunning(sessionId)) throw new Error('Side chat is busy')
      const snapshot = sidecarParentContext(session)
      const transcript = selected === null ? '' : checkpointTranscript(events, selected)
      if (snapshot?.parent !== parent || snapshot.checkpoint !== selected || snapshot.transcript !== transcript) {
        writePluginRecord(session, recordType, { parent, checkpoint: selected, transcript })
        await this.sessions.flushSession(session)
      }
      return { sessionId, selected }
    } finally {
      this.syncing.delete(parent)
    }
  }

  async deliver(sideSessionId: string, messageId: string): Promise<void> {
    const session = await this.sessions.liveSession(sideSessionId)
    const snapshot = session && sidecarParentContext(session)
    if (!session || !snapshot) throw new Error('Parent Agent unavailable')
    const messages = eventsToWireMessages(session.snapshotEvents(SessionLogOffset(0)))
    const reply = messages.find((message) => message.id === messageId)
    if (reply?.role !== 'assistant' || reply.status !== 'done') throw new Error('Conclusion unavailable')
    const text = reply.blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n\n').trim()
    if (!text || text.length > 12_000) throw new Error('Invalid conclusion')
    sendConclusion(this.ctx, snapshot.parent, text)
  }
}
