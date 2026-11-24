import { hostname, homedir } from 'node:os'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { passwordRegistration } from './password-pairing.js'
import { cloudConfigSchema } from './cloud.js'
import { createIdentity, createPrekey, identitySchema, prekeySchema, type StoredPrekey } from './crypto.js'
import {
  deviceCard, deviceIdSchema, eventIdSchema, exclusionsSchema, policySchema, prekeyIdSchema, safeId, sharingProtocolVersion,
  snapshotSchema,
} from './protocol.js'

export const prekeyTarget = 32
export const prekeyFloor = 8

const peerSchema = z.strictObject({ card: deviceCard, endpoint: z.string().max(512).optional(),
  platform: z.string().max(16).optional(), lastSyncAt: z.iso.datetime().optional(),
  needsVerification: z.literal(true).optional(), lastName: z.string().max(64).optional() })
export type Peer = z.infer<typeof peerSchema>

const entry = z.strictObject({ policy: policySchema, scopeDigest: eventIdSchema.optional(), approvedEvents: z.array(eventIdSchema).max(10_000),
  approvedDependencies: z.array(safeId).max(10_000) })
const incoming = z.strictObject({
  event: snapshotSchema, deviceName: deviceCard.shape.name, receivedAt: z.iso.datetime(), merged: z.boolean(),
})
export const sharingStateSchema = z.strictObject({
  version: z.literal(sharingProtocolVersion),
  identity: identitySchema,
  peers: z.array(peerSchema).max(20),
  revoked: z.array(deviceIdSchema).max(200),
  audit: z.array(z.strictObject({ version: z.number().int().positive(), at: z.iso.datetime(),
    action: z.enum(['save', 'remove', 'exclude', 'scope']), policy: policySchema.optional(), policyId: z.uuid().optional(),
    excludedIds: exclusionsSchema.optional(), scopeDigest: eventIdSchema.optional(),
    conversationCount: z.number().int().nonnegative().optional() })).max(1000),
  policies: z.array(entry).max(30),
  exclusions: exclusionsSchema,
  incoming: z.array(incoming).max(20_000),
  delivered: z.record(z.string(), z.literal(true)),
  prekeys: z.array(prekeySchema).max(128),
  consumedPrekeys: z.array(prekeyIdSchema).max(4096),
  prekeysPublishedAt: z.iso.datetime().nullable(),
  syncPassword: passwordRegistration.optional(),
  joinedDevice: deviceIdSchema.optional(),
  managedFirewall: z.boolean().optional(),
  lan: z.boolean(),
  lanInterfaces: z.array(z.string().max(128)).max(32).default([]),
  cloud: cloudConfigSchema.nullable(),
  lastSyncAt: z.iso.datetime().nullable(),
  migratedFrom: z.literal(1).optional(),
})
export type SharingState = z.infer<typeof sharingStateSchema>
export type PendingEvent = z.infer<typeof incoming>

const legacyCard = z.object({ id: deviceIdSchema, name: deviceCard.shape.name, key: z.string().max(256) }).passthrough()
const legacyState = z.object({
  version: z.literal(1),
  identity: z.object({ card: legacyCard, privateKey: z.string().max(512) }).passthrough(),
  peers: z.array(z.object({ card: legacyCard, endpoint: z.string().max(512).optional(), lastName: z.string().max(64).optional() }).passthrough()).max(20).default([]),
  revoked: z.array(deviceIdSchema).max(200).default([]),
  audit: z.array(z.unknown()).max(1000).default([]),
  exclusions: exclusionsSchema.default([]),
  incoming: z.array(z.unknown()).max(20_000).default([]),
  lan: z.boolean().default(false),
  lastSyncAt: z.iso.datetime().nullable().default(null),
}).passthrough()

function freshPrekeys(): StoredPrekey[] {
  return Array.from({ length: prekeyTarget }, () => {
    const key = createPrekey()
    return { id: key.id, privateKey: key.privateKey }
  })
}

/**
 * 0.11.9-rc.1 used static X25519 keys for both authentication and content
 * encryption. Those keys cannot be upgraded into a forward-secret identity, so
 * v1 state is migrated to a fresh v2 identity with the same Device ID. The
 * plaintext inbox, exclusions, audit and revocation list are preserved; peers
 * and policies must be re-established because old cards carry no signing key.
 */
function migrateV1(input: unknown): SharingState {
  const old = legacyState.parse(input)
  const identity = createIdentity(old.identity.card.name)
  identity.card.id = old.identity.card.id
  const inbox = old.incoming.flatMap((value) => {
    try {
      const row = z.strictObject({ event: snapshotSchema, deviceName: deviceCard.shape.name,
        receivedAt: z.iso.datetime(), merged: z.boolean() }).parse(value)
      return [row]
    } catch { return [] }
  })
  return {
    version: sharingProtocolVersion,
    identity,
    peers: [],
    revoked: old.revoked,
    audit: [],
    policies: [],
    exclusions: old.exclusions,
    incoming: inbox,
    delivered: {},
    prekeys: freshPrekeys(),
    consumedPrekeys: [],
    prekeysPublishedAt: null,
    lan: false,
    lanInterfaces: [],
    cloud: null,
    lastSyncAt: old.lastSyncAt,
    migratedFrom: 1,
  }
}

export function stateDirectory(profile: string) {
  const home = process.env['DSH_HOME'] || join(homedir(), '.dsh')
  return resolve(home, 'chat-workspace', 'sharing', 'profile-' + encodeURIComponent(profile))
}

export class SharingStateFile {
  private readonly path: string
  constructor(private readonly directory: string) { this.path = join(directory, 'state.json') }

  get firewallOwner() { return this.path.toLowerCase() }

  async load(): Promise<SharingState> {
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(this.path, 'utf8'))
    } catch (error) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (raw !== undefined) {
      if (typeof raw === 'object' && raw !== null && (raw as { version?: unknown }).version === 1) {
        const migrated = migrateV1(raw)
        await this.save(migrated)
        return migrated
      }
      const state = sharingStateSchema.parse(raw)
      if (state.cloud !== null) {
        // Scrub credentials written by 0.11.9. Require fresh authorization after upgrading.
        state.cloud = null
        await this.save(state)
      }
      return state
    }
    const value: SharingState = {
      version: sharingProtocolVersion,
      identity: createIdentity(hostname().slice(0, 64) || 'WebChat'),
      peers: [], revoked: [], audit: [], policies: [], exclusions: [], incoming: [], delivered: {},
      prekeys: freshPrekeys(), consumedPrekeys: [], prekeysPublishedAt: null,
      lan: false, lanInterfaces: [], cloud: null, lastSyncAt: null,
    }
    await this.save(value)
    return value
  }

  async save(value: SharingState) {
    // OAuth tokens and WebDAV credentials are live only for this engine activation.
    const json = JSON.stringify({ ...value, cloud: null })
    if (Buffer.byteLength(json) > 12 * 1024 * 1024) throw new Error('Sharing storage is full')
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const temporary = join(this.directory, 'state-' + randomUUID() + '.tmp')
    const handle = await open(temporary, 'wx', 0o600)
    try {
      try { await handle.writeFile(json); await handle.sync() } finally { await handle.close() }
      await rename(temporary, this.path)
      // Directory sync makes the rename durable on platforms that support it.
      if (process.platform !== 'win32') {
        const directory = await open(this.directory, 'r')
        try { await directory.sync() } finally { await directory.close() }
      }
    } finally {
      await rm(temporary, { force: true })
    }
  }
}
