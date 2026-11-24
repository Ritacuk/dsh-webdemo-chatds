import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ChatPartitions } from '@dsh-chat/shared'
import type { WorkspaceStore } from './store.js'
import type { WorkspaceSessions } from './sessions.js'

const name = z.string().trim().min(1).max(80)
export const partitionStateSchema = z.object({
  partitions: z.array(z.object({ id: z.uuid(), name })).max(200),
  assignments: z.record(z.string(), z.uuid()),
})

const partitionChange = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), name }),
  z.object({ action: z.literal('rename'), id: z.uuid(), name }),
  z.object({ action: z.literal('reorder'), id: z.uuid(), direction: z.enum(['up', 'down']) }),
  z.object({ action: z.literal('delete'), id: z.uuid() }),
  z.object({ action: z.literal('move'), sessionId: z.string().max(120), partitionId: z.uuid().nullable() }),
])

export class ChatPartitionStore {
  private writes: Promise<unknown> = Promise.resolve()
  private readonly listeners = new Set<() => void>()

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  constructor(private readonly store: WorkspaceStore, private readonly sessions: WorkspaceSessions) {}

  async read(): Promise<ChatPartitions> {
    await this.writes
    return this.current()
  }

  private async current(): Promise<ChatPartitions> {
    const table = (await this.store.ensure()).table('partitions')
    return table.get('history') ?? { partitions: [], assignments: {} }
  }

  change(input: unknown): Promise<ChatPartitions> {
    const change = partitionChange.parse(input)
    for (const listener of this.listeners) listener()
    const write = this.writes.then(async () => {
      const previous = await this.current()
      const state = structuredClone(previous)
      const { partitions, assignments } = state
      if (change.action === 'create') {
        partitions.push({ id: randomUUID(), name: change.name })
      } else if (change.action === 'move') {
        if (!(await this.sessions.list()).some(({ id }) => id === change.sessionId)) throw new Error('Chat not found')
        if (change.partitionId === null) delete assignments[change.sessionId]
        else {
          if (!partitions.some(({ id }) => id === change.partitionId)) throw new Error('Partition not found')
          assignments[change.sessionId] = change.partitionId
        }
      } else {
        const index = partitions.findIndex(({ id }) => id === change.id)
        const partition = partitions[index]
        if (!partition) throw new Error('Partition not found')
        if (change.action === 'delete') {
          partitions.splice(index, 1)
          for (const [sessionId, partitionId] of Object.entries(assignments)) {
            if (partitionId === change.id) delete assignments[sessionId]
          }
        } else if (change.action === 'rename') {
          partition.name = change.name
        } else {
          const target = index + (change.direction === 'up' ? -1 : 1)
          if (target >= 0 && target < partitions.length) {
            partitions.splice(index, 1)
            partitions.splice(target, 0, partition)
          }
        }
      }
      const validated = partitionStateSchema.parse(state)
      const table = (await this.store.ensure()).table('partitions')
      await table.put('history', validated)
      for (const listener of this.listeners) listener()
      return validated
    })
    this.writes = write.catch(() => {})
    return write
  }
}
