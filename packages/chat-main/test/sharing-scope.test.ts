import { randomUUID } from 'node:crypto'
import type { SyncSelection } from '@dsh-chat/shared'
import { expect, it } from 'vitest'
import { sharingPlan } from '../src/host/sharing/policy.js'
import type { SharingWorkspace } from '../src/host/sharing/workspace.js'

it('scopes duplicate originating message IDs to the explicitly selected conversation', async () => {
  const id = randomUUID()
  const first = 'chatws-' + randomUUID()
  const second = 'chatws-' + randomUUID()
  const createdAt = 1_600_000_000_000
  const workspace = {
    partitions: { read: async () => ({ assignments: {} }) },
    turns: { isRunning: () => false },
    sessions: {
      list: async () => [{ id: first, createdAt }, { id: second, createdAt }],
      readEvents: async (sessionId: string) => [{
        type: 'user/message', time: createdAt, seq: 0, surfaceOp: 'append',
        data: { id, role: 'user', content: [{ type: 'text', text: sessionId === first ? 'Allowed text' : 'Other branch text' }] },
      }],
    },
  } as unknown as SharingWorkspace
  const sender = randomUUID()
  const base: SyncSelection = {
    all: false, partitionIds: [], conversationIds: [], messageIds: [id], branchIds: [], excludedIds: [],
    recipientDeviceIds: [randomUUID()], syncMode: 'once', context: 'excerpt', attachmentPolicy: 'omit',
  }
  await expect(sharingPlan(workspace, base, sender, new Set())).rejects.toThrow(/Choose a conversation/)
  const scoped = { ...base, conversationScopeId: first }
  const plan = await sharingPlan(workspace, scoped, sender, new Set())
  expect(plan.events).toMatchObject([{ conversationId: first, text: 'Allowed text' }])
  expect((await sharingPlan(workspace, scoped, sender, new Set([id]))).events).toEqual([])
})
