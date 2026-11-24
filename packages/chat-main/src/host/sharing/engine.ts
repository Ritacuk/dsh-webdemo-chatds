import { randomUUID } from 'node:crypto'
import { baiduApplication, BaiduAccount, BaiduTransport } from './baidu.js'
import { z } from 'zod'
import type { MessageProvenance, SharingStatus, SyncSelection } from '@dsh-chat/shared'
import { cloudConfigSchema, cloudTransport, InvalidCloudEvent, validateCloudConfig, type CloudConfig, type CloudTransport } from './cloud.js'
import {
  createIdentity, createPrekey, decryptBackup, encryptBackup, fingerprint, identityKeyMatches, invite, openEnvelope,
  publishableBundle, publicKeyFromPrivate, readInvite, seal, shortCode,
  UnknownPrekeyError, verifyPrekeyBundle, verifyStoredEnvelope, type Identity, type PrekeyBundle, type PrekeyPublic,
  type StoredPrekey,
} from './crypto.js'
import { changeFirewallRule, firewallStatus, type FirewallStatus } from './firewall.js'
import { LanTransport, type LanDiagnostics } from './lan.js'
import { lanEndpoint } from './network.js'
import { beginDeviceGrant, finishDeviceGrant, type DeviceGrant } from './onedrive-auth.js'
import { joinWithPassword, PasswordPairing, PasswordPairingError, PasswordReset, registerPassword, resetHostPassword, type PasswordRegistration, type PairingDevice } from './password-pairing.js'
import { sharingPlan } from './policy.js'
import { deviceIdSchema, deviceName, digest, exclusionsSchema, selectionSchema, type DeviceCard } from './protocol.js'
import {
  prekeyFloor, prekeyTarget, SharingStateFile, sharingStateSchema, type PendingEvent, type SharingState,
} from './state.js'
import { receiveInWorkspace, type SharingWorkspace } from './workspace.js'

const clock = () => new Date().toISOString()
const proof = z.string().regex(/^[a-f0-9 ]{64,71}$/i)
const password = z.string().min(12).max(256)
const commandSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('set-sync-password'), password, confirmed: z.boolean().default(false) }),
  z.strictObject({ action: z.literal('join-with-password'), password, id: deviceIdSchema, name: deviceName }),
  z.strictObject({ action: z.literal('lan-permission'), enabled: z.boolean() }),
  z.strictObject({ action: z.literal('rename'), name: deviceName }),
  z.strictObject({ action: z.literal('inspect-invite'), invite: z.string().max(1024) }),
  z.strictObject({ action: z.literal('discover-invite'), id: deviceIdSchema }),
  z.strictObject({ action: z.literal('pair'), invite: z.string().max(1024), fingerprint: proof, replace: z.boolean().default(false) }),
  z.strictObject({ action: z.literal('revoke'), id: deviceIdSchema, confirmed: z.literal(true) }),
  z.strictObject({ action: z.literal('rotate'), confirmed: z.literal(true) }),
  z.strictObject({ action: z.literal('endpoint'), id: deviceIdSchema, endpoint: z.string().max(512).nullable() }),
  z.strictObject({ action: z.literal('lan'), enabled: z.boolean() }),
  z.strictObject({ action: z.literal('lan-interfaces'), interfaces: z.array(z.string().max(128)).max(32) }),
  z.strictObject({ action: z.literal('diagnose') }),
  z.strictObject({ action: z.literal('lan-recheck') }),
  z.strictObject({ action: z.literal('baidu-start'), application: baiduApplication }),
  z.strictObject({ action: z.enum(['baidu-poll', 'baidu-cancel', 'baidu-disconnect']) }),
  z.strictObject({ action: z.literal('baidu-auto'), enabled: z.boolean() }),
  z.strictObject({ action: z.enum(['firewall', 'firewall-remove']), confirmed: z.literal(true) }),
  z.strictObject({ action: z.literal('cloud'), config: cloudConfigSchema.options[0].nullable() }),
  z.strictObject({ action: z.literal('onedrive-start'), clientId: z.uuid() }),
  z.strictObject({ action: z.literal('onedrive-poll') }),
  z.strictObject({ action: z.literal('onedrive-cancel') }),
  z.strictObject({ action: z.literal('preview'), selection: selectionSchema }),
  z.strictObject({ action: z.literal('save-policy'), selection: selectionSchema, confirmation: z.string().length(64) }),
  z.strictObject({ action: z.literal('remove-policy'), id: z.uuid() }),
  z.strictObject({ action: z.enum(['exclude', 'exclude-add']), ids: exclusionsSchema }),
  z.strictObject({ action: z.literal('audit') }),
  z.strictObject({ action: z.literal('sync') }),
  z.strictObject({ action: z.literal('backup'), password }),
  z.strictObject({ action: z.literal('restore'), password, backup: z.string().max(17 * 1024 * 1024), confirmed: z.literal(true) }),
])

function exclusions(state: SharingState): Set<string> {
  return new Set([...state.exclusions, ...state.policies.flatMap((item) => item.policy.excludedIds)])
}

function provenance(row: PendingEvent): MessageProvenance {
  return { deviceId: row.event.senderId, deviceName: row.deviceName, createdAt: row.event.createdAt, receivedAt: row.receivedAt }
}

function policyVersion(state: SharingState): number { return (state.audit.at(-1)?.version ?? 0) + 1 }

function publicPrekeys(prekeys: readonly StoredPrekey[]): PrekeyPublic[] {
  return prekeys.map(({ id, privateKey }) => ({ id, key: publicKeyFromPrivate(privateKey) }))
}

export interface SharingStatusV2 extends SharingStatus {
  passwordSet?: boolean
  joinedDevice?: string
  platform?: string
  lan?: boolean
  lanEnabled?: boolean
  lanState?: 'off' | 'ready' | 'local-only' | 'unavailable'
  baidu?: { account: string; directory: string; auto: boolean; pendingUploads?: number; pendingDownloads?: number; lastSyncAt?: string }
  lanPort?: number
  lanAddresses?: string[]
  lanDetails?: LanDiagnostics
  discovery?: LanDiagnostics['discovery']
  devices?: { id: string; name: string; code: string; address: string; port: number; endpoint: string; paired: boolean }[]
  interfaces?: LanDiagnostics['interfaces']
  interfaceSelection?: string[]
  firewall?: FirewallStatus
  pairingCode?: string
  prekeys?: { available: number; consumed: number }
  migrated?: boolean
  exclusions?: string[]
}

export class SharingEngine {
  private readonly lifecycle = new AbortController()
  private readonly ready: Promise<void>
  private state?: SharingState
  private tail: Promise<unknown> = Promise.resolve()
  private cycle?: Promise<void>
  private cycleAbort?: AbortController
  private timer?: ReturnType<typeof setInterval>
  private readonly passwordPairing = new PasswordPairing()
  private readonly passwordReset = new PasswordReset()
  private joining = false
  private lan?: LanTransport
  private lanKey?: string
  private lastLanPort?: number
  private firewallBinding?: string
  private refreshingLan = false
  private cloud?: CloudTransport
  private bundleTask: Promise<unknown> = Promise.resolve()
  private baiduStatus?: SharingStatusV2['baidu']
  private lanFailure?: string
  private error?: string
  private oneDriveGrant?: DeviceGrant
  private pending = 0
  private policyChanges = 0
  private readonly stopPartitionSubscription: () => void
  private readonly bundles = new Map<string, { bundle: PrekeyBundle; fetchedAt: number }>()
  private readonly claimed = new Map<string, Set<string>>()
  private firewallCache?: { at: number; value: FirewallStatus }

  constructor(private readonly file: SharingStateFile, private readonly workspace: SharingWorkspace,
    private readonly baidu?: BaiduAccount) {
    this.stopPartitionSubscription = workspace.partitions.subscribe(() => this.cycleAbort?.abort())
    this.ready = this.initialize().catch(() => { this.error = 'Sharing storage could not start. Existing data was preserved.' })
  }

  private async initialize() {
    this.state = await this.file.load()
    if (this.lifecycle.signal.aborted) return
    await this.configure()
    if (this.lifecycle.signal.aborted) return
    this.timer = setInterval(() => {
      void this.recoverLan()
      void this.synchronize()
    }, 12_000)
    this.timer.unref()
  }

  private get data(): SharingState {
    this.lifecycle.signal.throwIfAborted()
    if (!this.state) throw new Error('Sharing storage is unavailable')
    return this.state
  }

  private async configure() {
    await this.configureLan()
    const account = await this.baidu?.read().catch(() => {
      this.error = 'Baidu Netdisk credentials could not be opened.'
      return undefined
    })
    if (account && !this.lifecycle.signal.aborted) {
      const cloud = new BaiduTransport(account, (signal, rejected) => this.baidu!.access(account.connectionId, signal, rejected))
      this.cloud = cloud
      this.baiduStatus = { account: account.account, directory: cloud.directory, auto: account.auto,
        ...(this.baiduStatus?.directory === cloud.directory && this.baiduStatus?.account === account.account
          ? { lastSyncAt: this.baiduStatus.lastSyncAt } : {}) }
      return
    }
    this.baiduStatus = undefined
    this.cloud = this.data.cloud && !this.lifecycle.signal.aborted ? cloudTransport(this.data.cloud, (previous, next) =>
      this.serialize(async () => {
        await this.commit((candidate) => {
          if (candidate.cloud?.provider !== 'onedrive' || candidate.cloud.token !== previous.token) throw new Error('Cloud configuration changed')
          candidate.cloud = next
        })
      })) : undefined
    if (this.cloud) void this.ensureBundle(true).catch(() => {})
  }

  private lanKeyFor(data: SharingState): string {
    return [data.identity.card.id, data.identity.card.signKey, data.identity.card.name, data.lanInterfaces.join(',')].join(':')
  }

  private async configureLan(force = false) {
    const data = this.data
    const key = this.lanKeyFor(data)
    if (!data.lan) {
      this.firewallBinding = undefined
      this.firewallCache = undefined
      this.lanFailure = undefined
      const lan = this.lan
      this.lan = undefined
      this.lanKey = undefined
      await lan?.close()
      return
    }
    if (!force && this.lan && this.lanKey === key) return
    const previous = this.lan
    this.lan = undefined
    this.lastLanPort = previous?.diagnostics().port ?? this.lastLanPort
    await previous?.close()
    this.lifecycle.signal.throwIfAborted()
    const lan = new LanTransport({
      identity: data.identity,
      peers: () => this.state?.peers.filter((peer) => !peer.needsVerification).map(({ card }) => card) ?? [],
      verificationPeer: (id) => this.state?.peers.find(({ card }) => card.id === id),
      passwordReset: (stage, input) => {
        const { identity, syncPassword } = this.data
        if (!syncPassword) throw new Error('Password reset unavailable')
        return this.passwordReset.handle(stage, input, identity, syncPassword,
          (id) => this.state?.peers.find(({ card, needsVerification }) => !needsVerification && card.id === id)?.card,
          (credential, prior, from) => this.changePolicy(async () => {
            if (this.data.syncPassword?.record !== prior || !this.data.lan ||
                !this.data.peers.some(({ card, needsVerification }) => card.id === from && !needsVerification)) {
              throw new Error('Device authorization changed')
            }
            await this.replacePassword(credential, from)
          }))
      },
      passwordPairing: (stage, body, remote) => {
        const { identity, syncPassword } = this.data
        if (!syncPassword) throw new Error('Pairing unavailable')
        return this.passwordPairing.handle(stage, body, remote, identity, syncPassword, (peer, credential) =>
          this.changePolicy(async () => {
            await this.commit((candidate) => {
              if (!candidate.lan || candidate.syncPassword?.record !== credential.record) throw new Error('Pairing changed')
              this.authorizePasswordPeer(candidate, peer)
            })
          }))
      },
      receive: (event, name) => this.receiveEvent(event, name),
      allowInterfaces: data.lanInterfaces,
      port: this.lastLanPort,
    })
    try {
      await lan.start()
      if (this.lifecycle.signal.aborted) await lan.close()
      else { this.lan = lan; this.lanKey = key; this.lanFailure = undefined; this.error = this.lanError() }
    } catch (error) {
      await lan.close()
      this.lanFailure = error instanceof Error ? error.message.slice(0, 200) : 'LAN listener could not start'
      this.error = this.lanError()
    }
  }

  private async recoverLan() {
    if (this.refreshingLan || this.lifecycle.signal.aborted || !this.state?.lan) return
    this.refreshingLan = true
    try {
      await this.serialize(async () => {
        await this.configureLan()
        if (process.platform !== 'win32' || !this.data.managedFirewall) return
        const binding = this.lan?.diagnostics()
        const key = JSON.stringify([binding?.port, binding?.addresses])
        if (!binding?.port || binding.loopbackOnly) return
        if (this.firewallBinding === key) {
          await this.firewall()
          return
        }
        this.firewallBinding = key
        await this.refreshLanPermission('apply', false)
      })
    } catch { /* The listener or firewall diagnostics retain the failure. */ }
    finally { this.refreshingLan = false }
  }

  private async refreshLanPermission(action: 'apply' | 'remove', rebind = true): Promise<FirewallStatus & { applied: boolean; error?: string }> {
    const lan = this.lan?.diagnostics()
    if (process.platform !== 'win32') return { supported: false, applied: true }
    if (action === 'apply' && (!lan?.port || lan.loopbackOnly)) {
      return { supported: true, applied: false, error: '当前没有可用的局域网网卡。连接网络后请重新检测。' }
    }
    const owner = this.file.firewallOwner
    const result = await changeFirewallRule(owner, action, lan?.port, lan?.addresses[0])
    if (action === 'apply' && result.applied && rebind) {
      await this.configureLan(true)
      const current = this.lan?.diagnostics()
      if (current?.port && current.port !== lan?.port) return this.refreshLanPermission(action, false)
      if (!current?.port || current.loopbackOnly || !await this.lan?.checkListener(this.lifecycle.signal)) {
        return { ...result, applied: false, error: '防火墙规则已保存，但局域网服务未恢复。请重新检测。' }
      }
    }
    this.firewallCache = { at: Date.now(), value: result }
    const binding = this.lan?.diagnostics()
    this.firewallBinding = JSON.stringify([binding?.port, binding?.addresses])
    return result
  }

  private lanError(): string | undefined {
    const details = this.lan?.diagnostics()
    if (this.lanFailure || details?.error && !details.port) return 'LAN sync is unavailable. Check network permissions and run diagnostics.'
    if (!details) return undefined
    if (details.loopbackOnly) return 'No private LAN interface was found. LAN sync is listening on loopback only.'
    if (details.discovery.error) return 'mDNS discovery could not start. Manual LAN addresses still work.'
    return undefined
  }

  async status(includeExcerpts = true): Promise<SharingStatusV2> {
    await this.ready
    if (this.lifecycle.signal.aborted) return { enabled: false }
    const data = this.state
    if (!data) return { enabled: true, error: this.error }
    const { card } = data.identity
    const merged = new Set((includeExcerpts ? data.incoming : []).filter((row) => row.merged).map((row) => row.event.conversationId + ':' + row.event.messageId))
    const shown = new Set<string>()
    const lan = this.lan?.diagnostics()
    const firewall = this.firewallCache?.value ?? { supported: process.platform === 'win32' }
    return {
      enabled: true,
      passwordSet: !!data.syncPassword, joinedDevice: data.joinedDevice, platform: process.platform,
      device: { id: card.id, name: card.name, invite: invite(card), fingerprint: fingerprint(card), code: shortCode(card) },
      peers: data.peers.map((peer) => ({
        id: peer.card.id, name: peer.lastName ?? peer.card.name, fingerprint: fingerprint(peer.card),
        code: shortCode(peer.card), platform: peer.platform, lastSyncAt: peer.lastSyncAt,
        needsVerification: peer.needsVerification,
        reachable: !!this.lan && !!this.lan.discovered(peer.card.id),
        discovered: this.lan?.discovered(peer.card.id),
        endpoint: peer.endpoint,
      })),
      lan: !!lan?.port, lanEnabled: data.lan,
      lanState: !data.lan ? 'off' : !lan?.port ? 'unavailable' : lan.loopbackOnly ? 'local-only' : 'ready',
      lanPort: lan?.port, lanAddresses: lan?.addresses, lanDetails: lan,
      discovery: lan?.discovery, interfaces: lan?.interfaces, interfaceSelection: data.lanInterfaces,
      devices: this.lan?.devices().map((device) => ({ ...device, paired: data.peers.some(({ card: peer }) => peer.id === device.id) })),
      firewall,
      pairingCode: shortCode(card),
      prekeys: { available: data.prekeys.length, consumed: data.consumedPrekeys.length },
      migrated: data.migratedFrom === 1,
      cloud: this.baiduStatus ? { provider: 'baidu' } : data.cloud ? { provider: data.cloud.provider } : undefined,
      baidu: this.baiduStatus,
      running: !!this.cycle, pending: this.pending, lastSyncAt: data.lastSyncAt ?? undefined,
      error: this.error, policies: data.policies.map(({ policy }) => policy), exclusions: data.exclusions,
      excerpts: !includeExcerpts ? undefined : data.incoming.filter((row) => {
        const key = row.event.conversationId + ':' + row.event.messageId
        if (merged.has(key) || shown.has(key)) return false
        shown.add(key)
        return true
      }).map(({ event, ...row }) => ({
        eventId: event.eventId, conversationId: event.conversationId, messageId: event.messageId,
        role: event.role, text: event.text, source: provenance({ ...row, event }),
      })),
    }
  }

  private async firewall(): Promise<FirewallStatus> {
    if (this.firewallCache && Date.now() - this.firewallCache.at < 60_000) return this.firewallCache.value
    const lan = this.lan?.diagnostics()
    const value = await firewallStatus(this.file.firewallOwner, lan?.port, lan?.addresses[0])
    this.firewallCache = { at: Date.now(), value }
    return value
  }

  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const operation = this.tail.then(run)
    this.tail = operation.catch(() => {})
    return operation
  }

  private async commit(update: (candidate: SharingState) => void) {
    const candidate = structuredClone(this.data)
    update(candidate)
    await this.file.save(candidate)
    this.state = candidate
  }

  private ensureBundle(force = false): Promise<void> {
    const task = this.bundleTask.then(async () => {
      const cloud = this.cloud
      if (!cloud) return
      if (this.data.prekeys.length < prekeyFloor) await this.refillPrekeys()
      if (!force && this.data.prekeysPublishedAt &&
          Date.now() - Date.parse(this.data.prekeysPublishedAt) < 60 * 60_000) return
      const { identity, prekeys } = this.data
      const bundle = publishableBundle(identity, publicPrekeys(prekeys))
      await cloud.publishBundle(bundle, this.lifecycle.signal)
      await this.serialize(async () => {
        const current = this.data
        if (this.cloud !== cloud || identity.card.signKey !== current.identity.card.signKey ||
            prekeys.map(({ id }) => id).join() !== current.prekeys.map(({ id }) => id).join()) return
        await this.commit((candidate) => { candidate.prekeysPublishedAt = clock() })
      })
    })
    this.bundleTask = task.catch(() => {})
    return task
  }

  private async refillPrekeys(): Promise<void> {
    await this.serialize(async () => {
      const data = this.data
      if (data.prekeys.length >= prekeyFloor) return
      const next = [...data.prekeys]
      while (next.length < prekeyTarget) {
        const key = createPrekey()
        next.push({ id: key.id, privateKey: key.privateKey })
      }
      await this.commit((candidate) => { candidate.prekeys = next; candidate.prekeysPublishedAt = null })
    })
  }

  private async prekeyFor(peer: { card: DeviceCard }, signal: AbortSignal): Promise<PrekeyPublic> {
    const cloud = this.cloud
    if (!cloud) throw new Error('Cloud sync is not configured')
    const peerId = peer.card.id
    const cached = this.bundles.get(peerId)
    if (!cached || Date.now() - cached.fetchedAt > 10 * 60_000) await this.refreshBundle(peer, signal)
    let bundle = this.bundles.get(peerId)!.bundle
    const claimed = this.claimed.get(peerId) ?? new Set<string>()
    this.claimed.set(peerId, claimed)
    const tryBundle = async (value: PrekeyBundle) => {
      for (const prekey of value.prekeys) {
        if (claimed.has(prekey.id)) continue
        if (await cloud.claimPrekey(peerId, prekey.id, signal)) {
          claimed.add(prekey.id)
          if (claimed.size > 128) for (const id of [...claimed].slice(0, claimed.size - 128)) claimed.delete(id)
          return prekey
        }
        claimed.add(prekey.id)
      }
      return undefined
    }
    let found = await tryBundle(bundle)
    if (!found) {
      await this.refreshBundle(peer, signal)
      bundle = this.bundles.get(peerId)!.bundle
      found = await tryBundle(bundle)
    }
    if (!found) throw new Error('No recipient prekey is available. Ask the other device to come online and sync, then retry.')
    return found
  }

  private async refreshBundle(peer: { card: DeviceCard }, signal: AbortSignal): Promise<void> {
    const cloud = this.cloud
    if (!cloud) throw new Error('Cloud sync is not configured')
    const raw = await cloud.fetchBundle(peer.card.id, signal)
    if (raw === undefined) throw new Error('The other device has not published encryption prekeys yet. Ask it to enable cloud sync and come online.')
    this.bundles.set(peer.card.id, { bundle: verifyPrekeyBundle(peer.card, raw), fetchedAt: Date.now() })
  }

  private async receiveEvent(event: import('./protocol.js').SyncSnapshot, deviceName: string): Promise<void> {
    await this.serialize(async () => {
      const data = this.data
      if (!data.peers.some(({ card, needsVerification }) => !needsVerification && card.id === event.senderId)) throw new Error('Unpaired device')
      if (data.incoming.some(({ event: row }) => row.eventId === event.eventId)) return
      const now = clock()
      await this.commit((candidate) => {
        const peer = candidate.peers.find(({ card }) => card.id === event.senderId)!
        peer.lastSyncAt = clock()
        peer.lastName = deviceName
        candidate.incoming.push({ event, deviceName, receivedAt: now, merged: false })
        candidate.lastSyncAt = now
      })
    })
  }

  private async receiveCloud(value: unknown, filename?: string): Promise<string> {
    let needsPublish = false
    const result = await this.serialize(async () => {
      const data = this.data
      let opened
      try {
        opened = openEnvelope(data.identity, data.peers.filter((peer) => !peer.needsVerification).map(({ card }) => card), value, data.prekeys)
      } catch (error) {
        if (error instanceof UnknownPrekeyError) throw new InvalidCloudEvent('Unknown or already used prekey')
        throw new InvalidCloudEvent('Invalid encrypted event')
      }
      if (filename && filename !== opened.event.eventId) throw new InvalidCloudEvent('Unexpected cloud event name')
      const known = data.incoming.some(({ event }) => event.eventId === opened.event.eventId)
      const now = clock()
      await this.commit((candidate) => {
        candidate.prekeys = candidate.prekeys.filter(({ id }) => id !== opened.prekeyId)
        candidate.consumedPrekeys = [...candidate.consumedPrekeys.filter((id) => id !== opened.prekeyId), opened.prekeyId].slice(-4096)
        if (!known) {
          const peer = candidate.peers.find(({ card }) => card.id === opened.event.senderId)!
          peer.lastSyncAt = clock()
          peer.lastName = opened.deviceName
          candidate.incoming.push({ event: opened.event, deviceName: opened.deviceName, receivedAt: now, merged: false })
        }
        candidate.lastSyncAt = now
        if (candidate.prekeys.length < prekeyFloor) {
          const next = [...candidate.prekeys]
          while (next.length < prekeyTarget) {
            const key = createPrekey()
            next.push({ id: key.id, privateKey: key.privateKey })
          }
          candidate.prekeys = next
          candidate.prekeysPublishedAt = null
          needsPublish = true
        }
      })
      return opened.ack
    })
    if (needsPublish) void this.ensureBundle(true).catch(() => {})
    return result
  }

  private reconcile(): Promise<number> {
    return this.serialize(async () => {
      const waiting = this.data.incoming.filter((row) => !row.merged && row.event.context === 'complete')
      const completed = new Set<string>()
      const failures = new Set<string>()
      let progress: boolean
      do {
        progress = false
        for (const row of waiting) {
          this.lifecycle.signal.throwIfAborted()
          if (completed.has(row.event.eventId) || failures.has(row.event.eventId)) continue
          const outcome = await receiveInWorkspace(this.workspace, row.event, provenance(row)).catch(() => {
            failures.add(row.event.eventId)
            return 'busy'
          })
          if (outcome !== 'merged') continue
          completed.add(row.event.eventId)
          progress = true
        }
      } while (progress && completed.size < waiting.length)
      if (completed.size) await this.commit((candidate) => {
        for (const row of candidate.incoming) if (completed.has(row.event.eventId)) row.merged = true
        candidate.lastSyncAt = clock()
      })
      return failures.size
    })
  }

  private ensureRecipients(selection: SyncSelection) {
    const known = new Set(this.data.peers.filter((peer) => !peer.needsVerification).map(({ card }) => card.id))
    if (selection.recipientDeviceIds.some((id) => !known.has(id))) throw new Error('Choose paired, authorized devices')
  }

  private changePolicy<T>(run: () => Promise<T>): Promise<T> {
    this.policyChanges++
    this.cycleAbort?.abort()
    return this.serialize(run).finally(() => { this.policyChanges-- })
  }

  private confirmedScope(selection: SyncSelection, plan: string): string {
    const peers = this.data.peers
    const recipients = selection.recipientDeviceIds.map((id) => {
      const card = peers.find(({ card }) => card.id === id)?.card
      return card ? [card.key, card.signKey] : undefined
    })
    return digest([plan, this.data.identity.card.key, this.data.identity.card.signKey, recipients])
  }

  private authorizePasswordPeer(state: SharingState, peer: PairingDevice, endpoint?: string) {
    const { card, platform } = peer
    if (card.id === state.identity.card.id || card.signKey === state.identity.card.signKey || state.revoked.includes(card.id)) {
      throw new PasswordPairingError('此设备无法加入。设备可能已被移除。')
    }
    const known = state.peers.find((entry) => entry.card.id === card.id)
    if (known) {
      if (known.card.signKey !== card.signKey || known.card.key !== card.key) {
        throw new PasswordPairingError('对方设备身份已变化，请检查设备授权。')
      }
      known.card = card
      known.platform = platform
      if (endpoint) known.endpoint = endpoint
      delete known.needsVerification
      return
    }
    if (state.peers.length >= 20) throw new PasswordPairingError('共享设备数量已达上限。')
    state.peers.push({ card, platform, ...(endpoint ? { endpoint } : {}) })
  }

  private async joinDevice(id: string, name: string, password: string) {
    const lan = this.lan
    const data = this.data
    const endpoint = lan?.discovered(id) ?? data.peers.find(({ card }) => card.id === id)?.endpoint
    if (!lan || !endpoint) throw new PasswordPairingError('找不到对方设备。请确认它已开启局域网连接，并与本机连接同一网络。')
    if (this.joining) throw new PasswordPairingError('正在验证，请稍候。')
    if (data.revoked.includes(id)) throw new PasswordPairingError('该设备已被移除。')
    this.joining = true
    const identity = { ...data.identity, card: { ...data.identity.card, name } }
    try {
      const peer = await joinWithPassword(password, identity, id,
        (stage, body) => lan.pair(endpoint, stage, body, this.lifecycle.signal))
      await this.changePolicy(async () => {
        await this.commit((candidate) => {
          if (!candidate.lan || candidate.identity.card.signKey !== identity.card.signKey) throw new Error('Local identity changed')
          this.authorizePasswordPeer(candidate, peer, endpoint)
          candidate.identity.card.name = name
          candidate.joinedDevice = id
        })
        await this.configureLan()
      })
    } catch (error) {
      if (error instanceof PasswordPairingError) throw error
      throw new PasswordPairingError('设备验证未完成。请检查对方是否已设置密码，稍后重试。')
    } finally {
      this.joining = false
    }
    return this.status(false)
  }

  private async replacePassword(credential: PasswordRegistration, except?: string) {
    await this.commit((candidate) => {
      const changing = !!candidate.syncPassword
      candidate.syncPassword = credential
      if (changing) for (const peer of candidate.peers) if (peer.card.id !== except) peer.needsVerification = true
    })
    this.passwordPairing.invalidate()
    this.passwordReset.invalidate()
  }

  private async changeSyncPassword(password: string, confirmed: boolean) {
    const { joinedDevice, syncPassword, identity, peers } = this.data
    if ((syncPassword || joinedDevice) && !confirmed) throw new PasswordPairingError('请先确认修改同步密码。')
    if (syncPassword || !joinedDevice) {
      await this.changePolicy(async () => {
        if (!confirmed && (this.data.syncPassword || this.data.joinedDevice)) {
          throw new PasswordPairingError('请先确认修改同步密码。')
        }
        await this.replacePassword(await registerPassword(password, this.data.identity.card.id))
      })
      return
    }
    const lan = this.lan
    const peer = peers.find(({ card, needsVerification }) => card.id === joinedDevice && !needsVerification)
    const endpoint = peer && (lan?.discovered(joinedDevice) ?? peer.endpoint)
    if (!lan || !peer || !endpoint) {
      throw new PasswordPairingError('请先连接原设备，再重设密码。也可以直接在原设备上重设。')
    }
    try {
      await resetHostPassword(password, identity, peer.card,
        (stage, input) => lan.pair(endpoint, stage, input, this.lifecycle.signal, true))
    } catch {
      throw new PasswordPairingError('未能在原设备上确认密码修改。请检查它是否在线，或在原设备上重设密码。')
    }
  }

  async command(input: unknown): Promise<unknown> {
    await this.ready
    const command = commandSchema.parse(input)
    if (command.action === 'join-with-password') return this.joinDevice(command.id, command.name, command.password)
    if (command.action === 'set-sync-password') {
      await this.changeSyncPassword(command.password, command.confirmed)
      return this.status(false)
    }
    if (command.action === 'preview') {
      this.ensureRecipients(command.selection)
      const plan = await sharingPlan(this.workspace, command.selection, this.data.identity.card.id, exclusions(this.data))
      return { messageCount: plan.events.length, blocked: plan.blocked, attachmentBytes: 0,
        attachmentBytesOmitted: plan.attachmentBytesOmitted, dependencies: plan.dependencies, confirmation: this.confirmedScope(command.selection, plan.confirmation) }
    }
    if (command.action === 'inspect-invite') {
      const card = readInvite(command.invite)
      return { id: card.id, name: card.name, fingerprint: fingerprint(card), code: shortCode(card) }
    }
    if (command.action === 'discover-invite') {
      const device = this.lan?.devices().find(({ id }) => id === command.id)
      if (!device) throw new Error('Device was not discovered on this LAN')
      const card = await this.lan!.card(device.endpoint)
      if (card.id !== command.id) throw new Error('Discovered device identity changed. Refresh discovery and retry.')
      return { id: card.id, name: card.name, invite: invite(card), fingerprint: fingerprint(card), code: shortCode(card) }
    }
    if (command.action === 'audit') return this.data.audit
    if (command.action === 'diagnose') return this.diagnose()
    if (command.action === 'sync') {
      await this.cycle
      await this.synchronize(true)
      return this.status(false)
    }
    if (command.action === 'baidu-start') {
      this.data
      if (!this.baidu) throw new Error('Baidu Netdisk requires a DSH credential provider.')
      return this.serialize(() => this.baidu!.begin(command.application, this.lifecycle.signal))
    }
    if (command.action === 'baidu-cancel') {
      await this.serialize(async () => this.baidu?.cancel())
      return { phase: 'cancelled' }
    }
    if (command.action === 'baidu-poll') {
      if (!this.baidu) throw new Error('Baidu Netdisk requires a DSH credential provider.')
      return this.changePolicy(async () => {
        const previous = await this.baidu!.read()
        const account = await this.baidu!.poll(this.lifecycle.signal)
        if (!account) return { phase: 'pending' }
        if (previous?.connectionId !== account.connectionId) {
          await this.resetCloudDeliveries(null)
        }
        await this.configure()
        return { phase: 'connected' }
      })
    }
    if (command.action === 'baidu-auto' || command.action === 'baidu-disconnect') {
      if (!this.baidu) throw new Error('Baidu Netdisk requires a DSH credential provider.')
      await this.changePolicy(async () => {
        if (command.action === 'baidu-auto') await this.baidu!.setAuto(command.enabled)
        else await this.baidu!.disconnect()
        await this.configure()
      })
      return this.status(false)
    }
    if (command.action === 'onedrive-start' || command.action === 'onedrive-poll' || command.action === 'onedrive-cancel') {
      return this.changePolicy(async () => {
        const signal = this.lifecycle.signal
        signal.throwIfAborted()
        if (command.action === 'onedrive-start') {
          const grant = await beginDeviceGrant(command.clientId, signal)
          this.oneDriveGrant = grant
          return { phase: 'pending', verificationUri: grant.verificationUri, userCode: grant.userCode, expiresAt: grant.expiresAt }
        }
        if (command.action === 'onedrive-cancel') {
          this.oneDriveGrant = undefined
          return { phase: 'cancelled' }
        }
        const grant = this.oneDriveGrant
        if (!grant) throw new Error('OneDrive authorization has not started')
        try {
          const config = await finishDeviceGrant(grant, signal)
          if (!config) return { phase: 'pending' }
          this.cycleAbort?.abort()
          await this.saveCloud(config)
          this.oneDriveGrant = undefined
          return { phase: 'connected' }
        } catch (error) {
          this.oneDriveGrant = undefined
          throw error
        }
      })
    }
    if (command.action === 'backup') {
      const { syncPassword, managedFirewall, ...backup } = this.data
      return { backup: encryptBackup(command.password, { ...backup, lan: false, cloud: null }) }
    }
    if (command.action === 'firewall' || command.action === 'firewall-remove') {
      if (command.action === 'firewall' && !this.lan?.diagnostics().port) throw new Error('Enable LAN sync before adding a firewall rule')
      return this.changePolicy(() => this.refreshLanPermission(command.action === 'firewall' ? 'apply' : 'remove'))
    }
    if (command.action === 'lan-permission') {
      const result = await this.changePolicy(async () => {
        await this.commit((next) => {
          next.lan = command.enabled
          if (command.enabled && process.platform === 'win32') next.managedFirewall = true
        })
        await this.configureLan()
        const result = await this.refreshLanPermission(command.enabled ? 'apply' : 'remove')
        if (!command.enabled && result.applied && this.data.managedFirewall) {
          await this.commit((next) => { delete next.managedFirewall })
        }
        return result
      })
      return { ...await this.status(false), permissionError: result.error }
    }
    // Stop in-flight requests before committing a narrower scope, revocation or channel change.
    await this.changePolicy(async () => {
      const data = this.data
      switch (command.action) {
        case 'rename':
          await this.commit((next) => { next.identity.card.name = command.name })
          await this.configureLan()
          break
        case 'pair': {
          const card = readInvite(command.invite)
          if (card.id === data.identity.card.id || card.signKey === data.identity.card.signKey) throw new Error('Choose another device')
          if (fingerprint(card).replaceAll(' ', '') !== command.fingerprint.replaceAll(' ', '').toLowerCase()) throw new Error('Device fingerprint does not match')
          const old = data.peers.find((peer) => peer.card.id === card.id)
          if ((data.revoked.includes(card.id) || !!old && old.card.signKey !== card.signKey) && !command.replace) throw new Error('Confirm replacement of this pairing')
          if (!old && data.peers.length >= 20) throw new Error('Device limit reached')
          await this.commit((next) => {
            if (old && old.card.signKey !== card.signKey) this.removeRecipient(next, card.id)
            next.revoked = next.revoked.filter((id) => id !== card.id)
            next.peers = next.peers.filter((peer) => peer.card.id !== card.id)
            next.peers.push({ card, endpoint: old?.endpoint })
          })
          this.bundles.delete(card.id)
          this.claimed.delete(card.id)
          await this.configureLan()
          if (this.cloud && (this.baiduStatus?.auto ?? true)) void this.ensureBundle(true).catch(() => {})
          break
        }
        case 'revoke':
          await this.commit((next) => {
            next.peers = next.peers.filter((item) => item.card.id !== command.id)
            next.revoked = [...next.revoked.filter((id) => id !== command.id), command.id].slice(-200)
            this.removeRecipient(next, command.id)
            if (next.joinedDevice === command.id) delete next.joinedDevice
          })
          this.passwordPairing.invalidate()
          this.bundles.delete(command.id)
          this.claimed.delete(command.id)
          await this.configureLan()
          break
        case 'rotate': {
          await this.commit((next) => {
            const id = next.identity.card.id
            for (const { card } of next.peers) this.removeRecipient(next, card.id)
            next.revoked = [...new Set([...next.revoked, ...next.peers.map(({ card }) => card.id)])].slice(-200)
            next.peers = []
            delete next.syncPassword
            delete next.joinedDevice
            next.identity = createIdentity(next.identity.card.name)
            next.identity.card.id = id
            next.delivered = {}
            next.prekeys = []
            next.consumedPrekeys = []
            next.prekeysPublishedAt = null
            const fresh: StoredPrekey[] = []
            while (fresh.length < prekeyTarget) {
              const key = createPrekey()
              fresh.push({ id: key.id, privateKey: key.privateKey })
            }
            next.prekeys = fresh
          })
          this.bundles.clear()
          this.claimed.clear()
          await this.configureLan()
          if (this.cloud && (this.baiduStatus?.auto ?? true)) void this.ensureBundle(true).catch(() => {})
          break
        }
        case 'endpoint': {
          const endpoint = command.endpoint === null ? undefined : lanEndpoint(command.endpoint)
          await this.commit((next) => {
            const peer = next.peers.find(({ card }) => card.id === command.id)
            if (!peer) throw new Error('Device is not paired')
            peer.endpoint = endpoint
          })
          break
        }
        case 'lan':
          await this.commit((next) => { next.lan = command.enabled })
          await this.configureLan()
          break
        case 'lan-recheck':
          await this.configureLan(true)
          this.firewallCache = undefined
          this.firewallBinding = undefined
          if (process.platform === 'win32' && this.data.lan && this.data.managedFirewall) {
            const result = await this.refreshLanPermission('apply', false)
            if (!result.applied) this.error = result.error
          } else await this.firewall()
          break
        case 'lan-interfaces':
          await this.commit((next) => { next.lanInterfaces = [...new Set(command.interfaces)].sort() })
          await this.configureLan()
          break
        case 'cloud': {
          const config = command.config && validateCloudConfig(command.config)
          this.oneDriveGrant = undefined
          await this.saveCloud(config)
          break
        }
        case 'exclude':
        case 'exclude-add':
          await this.commit((next) => {
            next.exclusions = command.action === 'exclude' ? command.ids : exclusionsSchema.parse([...new Set([...next.exclusions, ...command.ids])])
            this.audit(next, { action: 'exclude', excludedIds: next.exclusions })
          })
          break
        case 'save-policy': {
          this.ensureRecipients(command.selection)
          const plan = await sharingPlan(this.workspace, command.selection, data.identity.card.id, exclusions(data))
          if (command.confirmation !== this.confirmedScope(command.selection, plan.confirmation)) throw new Error('Sharing scope changed. Preview it again before confirming.')
          if (!plan.events.length && (command.selection.syncMode === 'once' ||
              !(command.selection.all || command.selection.partitionIds.length || command.selection.conversationIds.length))) {
            throw new Error('No eligible messages in this scope')
          }
          await this.commit((next) => {
            if (next.policies.length >= 30) throw new Error('Remove an old sharing policy first')
            const policy = { ...command.selection, syncSpaceId: next.identity.card.id, policyId: randomUUID(), policyVersion: policyVersion(next) }
            next.policies.push({ policy, scopeDigest: digest(plan.scopeConversationIds), approvedEvents: policy.syncMode === 'once' ? plan.events.map((event) => digest(event)) : [],
              approvedDependencies: plan.dependencies.map(({ messageId }) => messageId) })
            this.audit(next, { action: 'save', policy })
          })
          break
        }
        case 'remove-policy':
          await this.commit((next) => {
            next.policies = next.policies.filter(({ policy }) => policy.policyId !== command.id)
            this.audit(next, { action: 'remove', policyId: command.id })
          })
          break
        case 'restore': {
          const restored = sharingStateSchema.parse(decryptBackup(command.password, command.backup))
          if (!identityKeyMatches(restored.identity)) throw new Error('Backup identity does not match its key')
          const consumed = new Set(restored.consumedPrekeys)
          let prekeys = restored.prekeys.filter(({ id }) => !consumed.has(id))
          while (prekeys.length < prekeyTarget) {
            const key = createPrekey()
            prekeys.push({ id: key.id, privateKey: key.privateKey })
          }
          const next: SharingState = { ...restored, syncPassword: undefined, managedFirewall: undefined, lan: false, cloud: null, policies: [], delivered: {}, prekeys, prekeysPublishedAt: null }
          await this.baidu?.disconnect()
          await this.file.save(next)
          this.state = next
          this.bundles.clear()
          this.claimed.clear()
          await this.configure()
          break
        }
      }
    })
    return this.status(false)
  }

  private async saveCloud(config: CloudConfig | null) {
    await this.baidu?.disconnect()
    await this.resetCloudDeliveries(config)
    await this.configure()
  }

  private async resetCloudDeliveries(config: CloudConfig | null) {
    this.bundles.clear()
    this.claimed.clear()
    await this.commit((next) => {
      next.cloud = config
      for (const key of Object.keys(next.delivered)) if (key.endsWith(':cloud')) delete next.delivered[key]
      next.prekeysPublishedAt = null
    })
  }

  private audit(next: SharingState, entry: Omit<SharingState['audit'][number], 'version' | 'at'>) {
    next.audit.push({ ...entry, version: policyVersion(next), at: clock() })
    if (next.audit.length > 1000) next.audit.shift()
  }

  private removeRecipient(next: SharingState, id: string) {
    // Narrowing the approved audience keeps the original content scope and the other devices' deliveries.
    next.policies = next.policies.filter(({ policy }) => {
      if (!policy.recipientDeviceIds.includes(id)) return true
      policy.recipientDeviceIds = policy.recipientDeviceIds.filter((recipient) => recipient !== id)
      if (!policy.recipientDeviceIds.length) {
        this.audit(next, { action: 'remove', policyId: policy.policyId })
        return false
      }
      policy.policyVersion = policyVersion(next)
      this.audit(next, { action: 'save', policy: { ...policy, recipientDeviceIds: [...policy.recipientDeviceIds] } })
      return true
    })
    for (const key of Object.keys(next.delivered)) if (key.startsWith(id + ':')) delete next.delivered[key]
  }

  private synchronize(manual = false): Promise<void> {
    if (this.cycle) return this.cycle
    if (!this.state || this.lifecycle.signal.aborted || this.policyChanges) return Promise.resolve()
    const controller = new AbortController()
    this.cycleAbort = controller
    const signal = AbortSignal.any([controller.signal, this.lifecycle.signal])
    this.cycle = this.synchronizeOnce(signal, manual).catch(() => {
      if (!signal.aborted) this.error = 'Could not finish synchronization. Check the device, connection and storage, then retry.'
    }).finally(() => { this.cycle = undefined; this.cycleAbort = undefined })
    return this.cycle
  }

  private async synchronizeOnce(signal: AbortSignal, manual: boolean) {
    const initial = this.data
    const lan = this.lan
    const cloud = manual || !this.baiduStatus || this.baiduStatus.auto ? this.cloud : undefined
    const baidu = this.baiduStatus
    const pendingCloud = new Set<string>()
    let cloudPullSucceeded = false
    const errors = new Set<string>()
    const host = initial.peers.find(({ card, needsVerification }) => !needsVerification && card.id === initial.joinedDevice)
    const address = host && (lan?.discovered(host.card.id) ?? host.endpoint)
    if (lan && host && address) {
      const required = await lan.verifyAuthorization(address, host.card, signal).catch(() => false)
      if (required) await this.serialize(async () => {
        signal.throwIfAborted()
        await this.commit((next) => {
          const matching = next.peers.find(({ card }) => card.id === host.card.id && card.signKey === host.card.signKey)
          if (matching && next.joinedDevice === host.card.id) matching.needsVerification = true
        })
      })
    }
    const invitations = this.data.peers.filter((peer) => !peer.needsVerification)
    if (cloud && invitations.length) {
      try { await this.ensureBundle() } catch { if (!signal.aborted) errors.add('Prekeys could not be published yet') }
      try {
        const known = new Set(initial.incoming.map(({ event }) => event.eventId))
        await cloud.pull(initial.identity.card.id, known, async (value, key) => {
          signal.throwIfAborted()
          await this.receiveCloud(value, key)
        }, signal)
        cloudPullSucceeded = true
      } catch (error) { if (!signal.aborted) errors.add(error instanceof Error && /(?:returned HTTP \d{3}$|^Cloud is waiting|^Baidu Netdisk)/.test(error.message) ? error.message : 'Cloud download failed') }
    }
    signal.throwIfAborted()
    if (await this.reconcile()) errors.add('Some conversations could not be safely merged. Their received records were kept.')
    this.pending = 0
    const deliveries = new Set<string>()
    const offline = new Set<string>()
    const prekeyUnavailable = new Set<string>()
    let cloudFailed = false
    const denied = exclusions(initial)
    for (const { policy, approvedEvents, approvedDependencies, scopeDigest } of initial.policies) {
      signal.throwIfAborted()
      if (!policy.conversationScopeId && (policy.messageIds.length || policy.branchIds.length)) {
        errors.add('Review and recreate message or branch policies from before this upgrade.')
        continue
      }
      const plan = await sharingPlan(this.workspace, selectionOf(policy), initial.identity.card.id, denied, new Set(approvedDependencies))
      const currentScope = digest(plan.scopeConversationIds)
      if (policy.syncMode === 'automatic' && scopeDigest !== currentScope) {
        await this.serialize(async () => {
          signal.throwIfAborted()
          await this.commit((candidate) => {
            const entry = candidate.policies.find((item) => item.policy.policyId === policy.policyId)
            if (!entry) throw new Error('Sharing policy was removed')
            entry.scopeDigest = currentScope
            entry.policy.policyVersion = policyVersion(candidate)
            this.audit(candidate, { action: 'scope', policy: entry.policy, scopeDigest: currentScope,
              conversationCount: plan.scopeConversationIds.length })
          })
        })
      }
      const approved = new Set(approvedEvents)
      for (const event of plan.events) {
        if (policy.syncMode === 'once' && !approved.has(digest(event))) continue
        if (!await this.workspace.sessions.sharingTarget(event.conversationId) || this.workspace.turns.isRunning(event.conversationId)) continue
        for (const peer of invitations) {
          if (!policy.recipientDeviceIds.includes(peer.card.id)) continue
          signal.throwIfAborted()
          const state = this.data
          if (!state.peers.some(({ card, needsVerification }) => !needsVerification && card.id === peer.card.id && card.signKey === peer.card.signKey)) continue
          const prefix = peer.card.id + ':' + event.eventId + ':'
          const address = lan && (lan.discovered(peer.card.id) ?? peer.endpoint)
          const sendLan = lan && address && !offline.has(peer.card.id) && !(state.delivered[prefix + 'lan'] || deliveries.has(prefix + 'lan'))
          if (baidu && !state.delivered[prefix + 'cloud'] && !deliveries.has(prefix + 'cloud')) pendingCloud.add(prefix)
          const sendCloud = cloud && !cloudFailed && !prekeyUnavailable.has(peer.card.id) &&
            !(state.delivered[prefix + 'cloud'] || deliveries.has(prefix + 'cloud'))
          if (!sendLan && !sendCloud) {
            if (!state.delivered[prefix + 'lan'] && !state.delivered[prefix + 'cloud'] && !deliveries.has(prefix + 'lan') && !deliveries.has(prefix + 'cloud')) this.pending++
            continue
          }
          if (sendLan) {
            try {
              await lan.send(peer.card, event, address!, signal)
              deliveries.add(prefix + 'lan')
            } catch {
              if (!signal.aborted) {
                errors.add(process.platform === 'win32'
                  ? 'LAN delivery is waiting for a paired device. Windows Defender Firewall may block inbound TCP.'
                  : 'LAN delivery is waiting for a paired device')
                offline.add(peer.card.id)
              }
            }
          }
          signal.throwIfAborted()
          if (sendCloud) {
            try {
              const prekey = await this.prekeyFor(peer, signal)
              const { envelope } = seal(initial.identity, peer.card, event, prekey)
              await cloud!.put(envelope, signal, (value) => verifyStoredEnvelope(initial.identity, peer.card, event, value))
              deliveries.add(prefix + 'cloud')
              pendingCloud.delete(prefix)
            } catch (error) {
              if (!signal.aborted) {
                const message = error instanceof Error ? error.message : ''
                if (/prekey/i.test(message)) {
                  prekeyUnavailable.add(peer.card.id)
                  errors.add(message)
                } else {
                  cloudFailed = true
                  errors.add(error instanceof Error && /(?:returned HTTP \d{3}$|^OneDrive authorization|^Cloud is waiting|^WebDAV immutable event conflict|^Baidu Netdisk)/.test(error.message) ? error.message : 'Cloud upload failed')
                }
              }
            }
          }
          if (!deliveries.has(prefix + 'lan') && !deliveries.has(prefix + 'cloud')) this.pending++
        }
      }
    }
    signal.throwIfAborted()
    if (deliveries.size) await this.serialize(async () => {
      signal.throwIfAborted()
      await this.commit((candidate) => {
        const recipients = new Set<string>()
        for (const key of deliveries) {
          candidate.delivered[key] = true
          recipients.add(key.slice(0, key.indexOf(':')))
        }
        const at = clock()
        for (const peer of candidate.peers) if (recipients.has(peer.card.id)) peer.lastSyncAt = at
        candidate.lastSyncAt = at
      })
    })
    if (baidu && this.baiduStatus === baidu) {
      baidu.pendingUploads = pendingCloud.size
      if (cloud instanceof BaiduTransport && invitations.length) {
        baidu.pendingDownloads = cloudPullSucceeded ? cloud.pendingDownloads : undefined
        if (cloudPullSucceeded && !errors.size) baidu.lastSyncAt = clock()
      }
    }
    this.error = [...errors].join(' · ') || this.lanError()
  }

  private async diagnose() {
    const lan = this.lan?.diagnostics()
    const hints: string[] = []
    if (!lan) hints.push(this.lanFailure ?? 'LAN sync is disabled. Enable it to listen for paired devices.')
    else {
      if (lan.error) hints.push(lan.error)
      if (lan.loopbackOnly) hints.push('No private IPv4/IPv6 LAN interface was found. Multi-device discovery cannot work on loopback.')
      if (lan.discovery.error) hints.push('mDNS could not start: ' + lan.discovery.error + ' Manual addresses still work.')
      if (lan.discovery.devices === 0) hints.push('No ChatDS device has been discovered on this subnet yet. Check that both devices are on the same LAN and multicast is allowed.')
      if (process.platform === 'win32' && !lan.loopbackOnly) hints.push('Windows inbound TCP may be blocked by Defender Firewall. Use the scoped rule in the firewall section; never disable the firewall.')
    }
    if (!this.data.peers.length) hints.push('Pair a device after discovery before sharing any chat.')
    if (this.data.migratedFrom === 1) hints.push('This profile was migrated from the static-key protocol. Paired devices must be paired again.')
    return { lan, firewall: await this.firewall(), hints, identity: { id: this.data.identity.card.id, fingerprint: fingerprint(this.data.identity.card) } }
  }

  async stop() {
    this.lifecycle.abort()
    this.passwordPairing.invalidate()
    this.passwordReset.invalidate()
    this.oneDriveGrant = undefined
    this.baidu?.cancel()
    this.stopPartitionSubscription()
    this.cycleAbort?.abort()
    if (this.timer) clearInterval(this.timer)
    await this.ready
    await this.lan?.close()
    this.lan = undefined
    await this.cycle
    await this.bundleTask
    await this.tail
    this.state = undefined
    this.cloud = undefined
    this.bundles.clear()
    this.claimed.clear()
  }
}

function selectionOf(policy: SyncSelection & { syncSpaceId: string; policyId: string; policyVersion: number }): SyncSelection {
  const { syncSpaceId, policyId, policyVersion, ...selection } = policy
  return selection
}
