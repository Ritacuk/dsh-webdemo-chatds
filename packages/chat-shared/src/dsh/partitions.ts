export interface ChatPartition {
  id: string
  name: string
}

export interface ChatPartitions {
  partitions: ChatPartition[]
  assignments: Record<string, string>
}

export type PartitionChange =
  | { action: 'create'; name: string }
  | { action: 'rename'; id: string; name: string }
  | { action: 'reorder'; id: string; direction: 'up' | 'down' }
  | { action: 'delete'; id: string }
  | { action: 'move'; sessionId: string; partitionId: string | null }
