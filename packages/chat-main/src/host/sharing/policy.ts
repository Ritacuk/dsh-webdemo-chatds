import type { Message, SyncSelection } from '@dsh-chat/shared'
import { replayChatSession } from '../sessions.js'
import { digest, shareableText, snapshotId, type SyncSnapshot } from './protocol.js'
import type { SharingWorkspace } from './workspace.js'

interface Node { message: Message; parent: string | null }
export interface SharingPlan {
  events: SyncSnapshot[]
  dependencies: { messageId: string; text: string; reference: boolean }[]
  attachmentBytesOmitted: number
  blocked: number
  scopeConversationIds: string[]
  confirmation: string
}

const content = (message: Message) => message.role === 'user' ? message.content :
  message.blocks.flatMap((block) => block.type === 'text' && !block.isTemplate ? [block.text] : []).join('\n\n')

function ancestors(node: Node, tree: ReadonlyMap<string, Node>): Node[] | undefined {
  const path = [node]
  const visited = new Set([node.message.id])
  let parent = node.parent
  while (parent !== null) {
    const next = tree.get(parent)
    if (!next || visited.has(parent)) return undefined
    path.push(next)
    visited.add(parent)
    parent = next.parent
  }
  return path.reverse()
}

export async function sharingPlan(
  workspace: SharingWorkspace,
  selection: SyncSelection,
  senderId: string,
  globalExclusions: ReadonlySet<string>,
  approvedDependencies?: ReadonlySet<string>,
): Promise<SharingPlan> {
  const directSelection = selection.messageIds.length > 0 || selection.branchIds.length > 0
  if (directSelection && !selection.conversationScopeId) throw new Error('Choose a conversation for message or branch sharing')
  const { assignments } = await workspace.partitions.read()
  const scope = {
    partitions: new Set(selection.partitionIds),
    chats: new Set(selection.conversationIds),
    messages: new Set(selection.messageIds),
    branches: new Set(selection.branchIds),
    excluded: new Set([...globalExclusions, ...selection.excludedIds]),
  }
  const events = new Map<string, SyncSnapshot>()
  const dependencies = new Map<string, SharingPlan['dependencies'][number]>()
  const countedAttachments = new Set<string>()
  let attachmentBytesOmitted = 0
  let blocked = 0
  const scopeConversationIds = new Set<string>()
  for (const summary of await workspace.sessions.list()) {
    const partition = assignments[summary.id]
    if (scope.excluded.has(summary.id) || (partition && scope.excluded.has(partition))) continue
    const broad = scope.chats.has(summary.id) || (!summary.imported && (selection.all || (partition !== undefined && scope.partitions.has(partition))))
    if (broad) scopeConversationIds.add(summary.id)
    const direct = directSelection && summary.id === selection.conversationScopeId
    if (!broad && !direct) continue
    if (workspace.turns.isRunning(summary.id)) continue
    const records = await workspace.sessions.readEvents(summary.id)
    if (!records) continue
    const tree = new Map(replayChatSession(records).tree.map((entry) => [entry.message.id, entry]))
    const branchMembers = new Set<string>()
    for (const tip of direct ? scope.branches : []) {
      const node = tree.get(tip)
      const path = node && ancestors(node, tree)
      if (path && !scope.excluded.has(tip) && !path.some(({ message }) => scope.excluded.has('branch:' + message.id))) {
        for (const part of path) branchMembers.add(part.message.id)
      }
    }
    const denied = (node: Node) => scope.excluded.has(node.message.id) ||
      (ancestors(node, tree) ?? [node]).some((part) => scope.excluded.has('branch:' + part.message.id))
    const safe = (node: Node) => !denied(node) && shareableText(content(node.message))
    const add = (node: Node, complete: boolean) => {
      const message = node.message
      if (message.provenance) return
      if (message.role === 'user') for (const file of message.files) {
        if (!countedAttachments.has(file.id)) {
          countedAttachments.add(file.id)
          attachmentBytesOmitted += file.size
        }
      }
      const event: Omit<SyncSnapshot, 'eventId'> = {
        senderId, conversationId: summary.id, messageId: message.id,
        parentId: complete ? node.parent : null, role: message.role, text: content(message),
        createdAt: new Date(message.createdAt).toISOString(),
        conversationCreatedAt: complete ? new Date(summary.createdAt).toISOString() : null,
        context: complete ? 'complete' : 'excerpt',
      }
      // Prefer the connected representation when another selected message already included this node.
      const key = summary.id + ':' + message.id
      const previous = events.get(key)
      if (previous?.context !== 'complete') events.set(key, { ...event, eventId: snapshotId(event) })
    }
    for (const node of tree.values()) {
      const { message } = node
      const selected = broad || (direct && (scope.messages.has(message.id) || branchMembers.has(message.id)))
      if (!selected || message.provenance) continue
      if (safe(node)) scopeConversationIds.add(summary.id)
      if (!safe(node)) { blocked++; continue }
      if (selection.context === 'excerpt') { add(node, false); continue }
      const path = ancestors(node, tree)
      if (!path || !path.every(safe)) {
        blocked++
        continue
      }
      const needed = path.slice(0, -1).filter(({ message: parent }) =>
        parent.provenance || (!broad && !scope.messages.has(parent.id)))
      if (approvedDependencies && needed.some(({ message: parent }) => !approvedDependencies.has(parent.id))) {
        blocked++
        continue
      }
      for (const part of needed) {
        const parent = part.message
        dependencies.set(parent.id, { messageId: parent.id, text: content(parent).slice(0, 240), reference: !!parent.provenance })
      }
      path.forEach((part) => add(part, true))
    }
    if (events.size > 10_000) throw new Error('Choose a smaller sharing scope (up to 10,000 messages)')
  }
  const selected = [...events.values()]
  return {
    scopeConversationIds: [...scopeConversationIds].sort(),
    events: selected, dependencies: [...dependencies.values()], attachmentBytesOmitted, blocked,
    confirmation: digest([selection, selected, [...dependencies.keys()], attachmentBytesOmitted]),
  }
}
