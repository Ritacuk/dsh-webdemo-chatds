import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { Message, MessageProvenance } from '@dsh-chat/shared'
import { replayChatSession, type WorkspaceSessions } from '../sessions.js'
import type { ChatPartitionStore } from '../partitions.js'
import type { TurnRunner } from '../turns.js'
import { writePluginRecord } from '../plugin-record.js'
import type { SyncSnapshot } from './protocol.js'

export interface SharingWorkspace {
  pagePath: string
  sessions: WorkspaceSessions
  partitions: ChatPartitionStore
  turns: TurnRunner
}

export const sharedMessageRecord = 'plugin:chat-workspace/shared-message'

export interface SharedMessageRecord {
  messageId: string
  parentId: string | null
  role: SyncSnapshot['role']
  text: string
  source: MessageProvenance
}

export function projectSharedMessage(record: SharedMessageRecord): Message {
  const { messageId, parentId, role, text, source } = record
  const shared = { id: messageId, parentId, createdAt: Date.parse(source.createdAt), provenance: source }
  return role === 'user'
    ? { ...shared, role, content: text, files: [] }
    : { ...shared, role, blocks: [{ type: 'text', text }], model: null, prefix: false, status: 'done' }
}

/** Call only from the serialized inbox. The Main writer owns the DSH log. */
export async function receiveInWorkspace(
  workspace: SharingWorkspace,
  event: SyncSnapshot,
  source: MessageProvenance,
): Promise<'merged' | 'missing' | 'busy'> {
  if (event.context === 'excerpt') return 'missing'
  const { sessions, turns } = workspace
  const id = event.conversationId
  if (!sessions.owns(id) || turns.isRunning(id)) return 'busy'
  if (!await sessions.sharingTarget(id)) return 'missing'
  let session = await sessions.liveSession(id)
  if (!session) {
    if (event.parentId !== null || event.role !== 'user') return 'missing'
    await sessions.reserveSharingReplica(id, Date.parse(event.conversationCreatedAt!), source)
    session = await sessions.create(id)
  }
  if (turns.isRunning(id)) return 'busy'
  const tree = replayChatSession(session.snapshotEvents(SessionLogOffset(0))).tree
  const existing = tree.find(({ message }) => message.id === event.messageId)
  if (existing) {
    const message = existing.message
    const text = message.role === 'user' ? message.content : message.blocks.flatMap((block) =>
      block.type === 'text' && !block.isTemplate ? [block.text] : []).join('\n\n')
    if (message.role !== event.role || text !== event.text || existing.parent !== event.parentId) return 'missing'
  } else {
    if (event.parentId !== null && !tree.some(({ message }) => message.id === event.parentId)) return 'missing'
    if (event.parentId === null && event.role !== 'user') return 'missing'
    const record: SharedMessageRecord = { messageId: event.messageId, parentId: event.parentId, role: event.role, text: event.text, source }
    writePluginRecord(session, sharedMessageRecord, record)
  }
  await sessions.flushSession(session)
  await sessions.publishSharingReplica(id)
  return 'merged'
}
