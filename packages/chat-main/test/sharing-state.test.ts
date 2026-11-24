import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createIdentity, fingerprint, invite, shortCode } from '../src/host/sharing/crypto.js'
import * as network from '../src/host/sharing/network.js'
import { SharingEngine } from '../src/host/sharing/engine.js'
import { snapshotId, type SyncSnapshot } from '../src/host/sharing/protocol.js'
import { SharingStateFile } from '../src/host/sharing/state.js'
import type { SharingWorkspace } from '../src/host/sharing/workspace.js'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function directory() {
  const value = await mkdtemp(join(tmpdir(), 'chatds-engine-'))
  directories.push(value)
  return value
}

function eventFor(senderId: string): SyncSnapshot {
  const event: Omit<SyncSnapshot, 'eventId'> = {
    senderId, conversationId: 'chatws-' + randomUUID(), messageId: randomUUID(), role: 'assistant',
    parentId: null, context: 'excerpt', createdAt: '2020-01-02T02:00:00.000Z', conversationCreatedAt: null, text: 'Legacy reply',
  }
  return { ...event, eventId: snapshotId(event) }
}

function workspace(): SharingWorkspace {
  return {
    pagePath: '/chat-workspace',
    partitions: { subscribe: () => () => {}, read: async () => ({ assignments: {} }) },
    turns: { isRunning: () => false },
    sessions: { sharingTarget: async () => false, list: async () => [], readEvents: async () => [] },
  } as unknown as SharingWorkspace
}

describe('sharing state migration and engine commands', () => {
  it('migrates a 0.11.9 static-key state without keeping the old shared-secret path', async () => {
    const directoryPath = await directory()
    const oldId = randomUUID()
    const other = createIdentity('Old peer')
    const legacy = {
      version: 1,
      identity: { card: { id: oldId, name: 'Legacy device', key: other.card.key }, privateKey: other.privateKey },
      peers: [{ card: other.card, lastName: 'Old peer' }],
      revoked: [],
      audit: [],
      policies: [],
      exclusions: ['keep-me'],
      incoming: [{ event: eventFor(other.card.id), deviceName: 'Old peer', receivedAt: '2026-01-01T00:00:00.000Z', merged: false }],
      delivered: { 'old:event:lan': true },
      lan: true,
      cloud: null,
      lastSyncAt: '2026-01-01T00:00:00.000Z',
    }
    await writeFile(join(directoryPath, 'state.json'), JSON.stringify(legacy))
    const state = await new SharingStateFile(directoryPath).load()
    expect(state.version).toBe(2)
    expect(state.identity.card.id).toBe(oldId)
    expect(state.identity.card.signKey).toBeTruthy()
    expect(state.identity.card.key).not.toBe(other.card.key)
    expect(state.peers).toEqual([])
    expect(state.policies).toEqual([])
    expect(state.lan).toBe(false)
    expect(state.migratedFrom).toBe(1)
    expect(state.exclusions).toEqual(['keep-me'])
    expect(state.incoming).toHaveLength(1)
    expect(state.prekeys).toHaveLength(32)
    expect(state.delivered).toEqual({})
    const saved = JSON.parse(await readFile(join(directoryPath, 'state.json'), 'utf8')) as { version: number }
    expect(saved.version).toBe(2)
  })

  it('pairs, revokes, rotates and restores without leaking private material in status', async () => {
    const directoryPath = await directory()
    const engine = new SharingEngine(new SharingStateFile(directoryPath), workspace())
    try {
      const initial = await engine.status()
      expect(initial.enabled).toBe(true)
      expect(initial.device?.id).toBeTruthy()
      expect(initial.prekeys?.available).toBe(32)
      const inviteText = initial.device!.invite
      const other = createIdentity('Other device')
      const inspected = await engine.command({ action: 'inspect-invite', invite: invite(other.card) }) as { fingerprint: string; code: string }
      expect(inspected.fingerprint).toBe(fingerprint(other.card))
      expect(inspected.code).toBe(shortCode(other.card))
      await engine.command({ action: 'pair', invite: invite(other.card), fingerprint: inspected.fingerprint })
      const paired = await engine.status()
      expect(paired.peers?.map(({ id }) => id)).toEqual([other.card.id])
      expect(JSON.stringify(paired)).not.toContain(other.privateKey)
      expect(JSON.stringify(paired)).not.toContain(other.signPrivateKey)
      expect(inviteText).toBeTruthy()

      await expect(engine.command({ action: 'revoke', id: other.card.id, confirmed: true })).resolves.toBeTruthy()
      const revoked = await engine.status()
      expect(revoked.peers).toEqual([])

      const backup = await engine.command({ action: 'backup', password: 'a synthetic backup password' }) as { backup: string }
      const before = await engine.status()
      await engine.command({ action: 'rotate', confirmed: true })
      const rotated = await engine.status()
      expect(rotated.device?.id).toBe(before.device?.id)
      expect(rotated.device?.fingerprint).not.toBe(before.device?.fingerprint)
      await engine.command({ action: 'restore', password: 'a synthetic backup password', backup: backup.backup, confirmed: true })
      const restored = await engine.status()
      expect(restored.device?.fingerprint).toBe(before.device?.fingerprint)
      expect(restored.prekeys?.available).toBe(32)
      expect(restored.peers).toEqual([])
    } finally {
      await engine.stop()
    }
  })

  it('keeps sharing inert when the main workspace has no target', async () => {
    const directoryPath = await directory()
    const engine = new SharingEngine(new SharingStateFile(directoryPath), workspace())
    try {
      const result = await engine.command({ action: 'diagnose' }) as { hints: string[]; lan?: unknown }
      expect(result.hints.length).toBeGreaterThan(0)
      expect(result.lan).toBeUndefined()
      await expect(engine.command({ action: 'firewall', confirmed: true })).rejects.toThrow(/Enable LAN sync/)
    } finally {
      await engine.stop()
    }
  })

  it('reports requested LAN state separately from a bind failure and retries after an interface returns', async () => {
    const interfaces = vi.spyOn(network, 'interfaceSnapshot')
    interfaces.mockImplementationOnce(() => { throw new Error('Simulated interface permission failure') })
    interfaces.mockReturnValue({ eligible: [], candidates: [] })
    const engine = new SharingEngine(new SharingStateFile(await directory()), workspace())
    try {
      expect(await engine.status()).toMatchObject({ lanEnabled: false, lanState: 'off' })
      expect(await engine.command({ action: 'lan', enabled: true }))
        .toMatchObject({ lan: false, lanEnabled: true, lanState: 'unavailable' })
      expect(await engine.command({ action: 'diagnose' }))
        .toMatchObject({ hints: expect.arrayContaining(['Simulated interface permission failure']) })
      expect(await engine.command({ action: 'lan-recheck' }))
        .toMatchObject({ lan: true, lanEnabled: true, lanState: 'local-only' })
      expect(await engine.command({ action: 'lan', enabled: false }))
        .toMatchObject({ lan: false, lanEnabled: false, lanState: 'off' })
    } finally {
      await engine.stop()
      interfaces.mockRestore()
    }
  })

})
