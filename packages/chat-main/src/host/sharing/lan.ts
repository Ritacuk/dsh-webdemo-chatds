import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { isIPv6 } from 'node:net'
import { z } from 'zod'
import { readLimited } from './cloud.js'
import {
  deriveLanSessionKeys, ephemeralShared, fingerprint, lanTranscript, newEphemeral, sessionOpen, sessionSeal,
  shortCode, signTranscript, verifyTranscript, wipeLanKeys, type Identity, type LanSessionKeys,
} from './crypto.js'
import { MdnsDiscovery, type DiscoveredDevice, type DiscoveryStatus } from './discovery.js'
import {
  endpointFor, interfaceSnapshot, isTrustedRemote, lanEndpoint, normalizeRemote, sameInterfaceSet, sharesLocalSubnet, isLoopback,
  type InterfaceCandidate, type InterfaceSnapshot,
} from './network.js'
import {
  deviceCard, deviceIdSchema, deviceName, maximumEnvelopeBytes, publicKeySchema, sharingProtocolVersion,
  validateSnapshot, type DeviceCard, type SyncSnapshot,
} from './protocol.js'

export const preferredLanPort = 46_830
const portAttempts = 10
const sessionLifetime = 5 * 60_000
const pendingLifetime = 60_000
const maxMessagesPerSession = 256

const nonceSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/)
const boxSchema = z.strictObject({
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  tag: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  cipher: z.string().regex(/^[A-Za-z0-9_-]+$/).max(maximumEnvelopeBytes),
})
const helloRequest = z.strictObject({
  v: z.literal(sharingProtocolVersion),
  from: deviceIdSchema,
  to: deviceIdSchema,
  eph: publicKeySchema,
  nonce: nonceSchema,
})
const helloResponse = z.strictObject({
  v: z.literal(sharingProtocolVersion),
  from: deviceIdSchema,
  to: deviceIdSchema,
  eph: publicKeySchema,
  nonce: nonceSchema,
  sig: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
})
const confirmRequest = z.strictObject({
  v: z.literal(sharingProtocolVersion),
  session: z.string().regex(/^[a-f0-9]{64}$/),
  from: deviceIdSchema,
  sig: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  ...boxSchema.shape,
})
const messageRequest = z.strictObject({
  v: z.literal(sharingProtocolVersion),
  session: z.string().regex(/^[a-f0-9]{64}$/),
  from: deviceIdSchema,
  seq: z.number().int().positive().max(1_000_000_000),
  ...boxSchema.shape,
})
const verificationQuery = z.strictObject({
  from: deviceIdSchema, to: deviceIdSchema, nonce: nonceSchema, sig: helloResponse.shape.sig,
})
const verificationReply = z.strictObject({ required: z.boolean(), sig: helloResponse.shape.sig })
const inboundPayload = z.strictObject({ snapshot: z.unknown(), deviceName: deviceName })

interface SessionState {
  id: string
  peer: DeviceCard
  keys: LanSessionKeys
  lastSeq: number
  expiresAt: number
  messages: number
}

interface PendingState {
  transcript: Buffer
  peer: DeviceCard
  keys: LanSessionKeys
  expiresAt: number
}

export interface LanDiagnostics {
  port?: number
  addresses: string[]
  loopbackOnly: boolean
  interfaces: InterfaceCandidate[]
  candidates: InterfaceCandidate[]
  discovery: DiscoveryStatus
  error?: string
  platform: NodeJS.Platform
}

export interface LanTransportOptions {
  identity: Identity
  peers: () => readonly DeviceCard[]
  receive: (event: SyncSnapshot, deviceName: string) => Promise<void>
  allowInterfaces?: readonly string[]
  includeLoopback?: boolean
  verificationPeer?: (id: string) => { card: DeviceCard; needsVerification?: boolean } | undefined
  passwordReset?: (stage: 'begin' | 'finish', body: unknown) => Promise<unknown>
  passwordPairing?: (stage: 'begin' | 'finish', body: unknown, remote: string) => Promise<unknown>
  discovery?: boolean
  port?: number
}

function aad(...parts: (string | number)[]): string {
  return JSON.stringify(parts)
}

function bufferAad(...parts: (string | number)[]): Buffer {
  return Buffer.from(aad(...parts))
}

function listen(server: Server, port: number, address: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error) }
    const onListening = () => {
      server.off('error', onError)
      const value = server.address()
      if (!value || typeof value === 'string') reject(new Error('LAN listener has no port'))
      else resolve(value.port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen({ port, host: address, ipv6Only: isIPv6(address) })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })
}

/**
 * Authenticated, forward-secret LAN transport.
 *
 * Each connection performs an ephemeral X25519 exchange authenticated by the
 * long-term Ed25519 device identity over the complete transcript. Directional
 * AES-256-GCM keys are derived with HKDF-SHA-256 and exist only in memory for
 * five minutes. Old session keys are wiped when the session ends.
 */
export class LanTransport {
  private readonly discovery = new MdnsDiscovery()
  private servers = new Map<string, Server>()
  private addresses: InterfaceCandidate[] = []
  private snapshot?: InterfaceSnapshot
  private port?: number
  private error?: string
  private loopbackOnly = false
  private incoming = 0
  private readonly sessions = new Map<string, SessionState>()
  private readonly pending = new Map<string, PendingState>()
  private readonly outgoing = new Map<string, { session: SessionState; address: string }>()
  private readonly locks = new Map<string, Promise<unknown>>()
  private rebinding?: Promise<void>
  private monitor?: ReturnType<typeof setInterval>
  private sweeper?: ReturnType<typeof setInterval>
  private closed = false
  private lastNetworkCheck = Date.now()

  constructor(private readonly options: LanTransportOptions) {}

  async start() {
    this.closed = false
    try {
      await this.refreshBindings()
    } catch (error) {
      this.error = error instanceof Error ? error.message.slice(0, 200) : 'LAN listener could not start'
      throw error
    }
    this.monitor = setInterval(() => {
      const now = Date.now()
      const resumed = now - this.lastNetworkCheck > 25_000
      this.lastNetworkCheck = now
      if (!this.rebinding) this.rebinding = this.refreshBindings(resumed).catch((error: unknown) => {
        this.error = error instanceof Error ? error.message.slice(0, 200) : 'LAN interface change could not be applied'
      }).finally(() => { this.rebinding = undefined })
    }, 15_000)
    this.monitor.unref()
    this.sweeper = setInterval(() => this.sweep(), 15_000)
    this.sweeper.unref()
  }

  private async bind(startPort: number) {
    const attempts = startPort === 0 ? [0] : Array.from(
      { length: Math.min(portAttempts, 65_536 - startPort) }, (_, index) => startPort + index)
    if (startPort !== 0) attempts.push(0)
    let lastError: unknown
    for (const port of attempts) {
      const servers = new Map<string, Server>()
      let chosen = port
      let failed = false
      for (const candidate of this.addresses) {
        const server = createServer({ requestTimeout: 10_000, headersTimeout: 5_000, maxHeaderSize: 4096, keepAliveTimeout: 1_000 },
          (req, res) => void this.handle(req, res))
        server.setTimeout(10_000, (socket) => socket.destroy())
        server.on('error', () => { /* A later request reports the failure; avoid an unhandled error event. */ })
        try {
          const bound = await listen(server, chosen, candidate.address)
          if (port === 0) chosen = bound
          servers.set(candidate.address, server)
        } catch (error) {
          lastError = error
          await closeServer(server).catch(() => {})
          if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
            failed = true
            break
          }
        }
      }
      if (!failed && servers.size > 0) {
        this.servers = servers
        this.port = chosen
        this.error = undefined
        return
      }
      for (const server of servers.values()) await closeServer(server).catch(() => {})
    }
    throw lastError instanceof Error ? lastError : new Error('No LAN interface could be bound')
  }

  private async refreshBindings(force = false) {
    if (this.closed) return
    const next = interfaceSnapshot({ allow: this.options.allowInterfaces, includeLoopback: this.options.includeLoopback })
    this.snapshot = next
    const loopbackOnly = next.eligible.every(({ scope }) => scope === 'loopback')
    const candidates: InterfaceCandidate[] = next.eligible.length ? next.eligible : [
      { name: 'loopback', address: '127.0.0.1', family: 'IPv4', scope: 'loopback', eligible: true },
    ]
    if (!force && this.port && sameInterfaceSet(candidates, this.addresses) && !this.error && !this.discovery.status().error) return
    const preferred = this.port ?? this.options.port ?? preferredLanPort
    this.port = undefined
    const previous = [...this.servers.values()]
    this.servers.clear()
    await this.discovery.stop()
    await Promise.all(previous.map(closeServer))
    if (this.closed) return
    this.addresses = candidates
    this.loopbackOnly = loopbackOnly
    await this.bind(preferred)
    if (this.closed || this.options.discovery === false || this.loopbackOnly) return
    await this.discovery.start({
      id: this.options.identity.card.id,
      name: this.options.identity.card.name,
      code: shortCode(this.options.identity.card),
      port: this.port!,
      local: candidates.filter(({ address }) => this.servers.has(address)),
    })
  }

  private sweep() {
    const now = Date.now()
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now || session.messages >= maxMessagesPerSession) {
        wipeLanKeys(session.keys)
        this.sessions.delete(id)
      }
    }
    for (const [id, session] of this.outgoing) {
      if (session.session.expiresAt <= now) {
        wipeLanKeys(session.session.keys)
        this.outgoing.delete(id)
      }
    }
    for (const [id, pending] of this.pending) {
      if (pending.expiresAt <= now) {
        wipeLanKeys(pending.keys)
        this.pending.delete(id)
      }
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('connection', 'close')
    res.setHeader('cache-control', 'no-store')
    if (!isTrustedRemote(req.socket.remoteAddress) || this.incoming >= 16) {
      res.writeHead(404).end()
      return
    }
    let counted = false
    try {
      const url = new URL(req.url ?? '/', 'http://lan')
      const operation = /^\/chatds-sync\/pair\/v1\/(reset\/)?(begin|finish)$/.exec(url.pathname)
      if (req.method === 'POST' && operation) {
        const remote = normalizeRemote(req.socket.remoteAddress)
        if (!isLoopback(remote) && !sharesLocalSubnet(remote, this.addresses)) throw new Error('Pairing source is outside the local subnet')
        this.incoming++
        counted = true
        const stage = operation[2] === 'begin' ? 'begin' : 'finish'
        const input = await this.readBody(req, 4096)
        const result = operation[1] ? await this.options.passwordReset?.(stage, input)
          : await this.options.passwordPairing?.(stage, input, remote)
        if (!result) throw new Error('Pairing unavailable')
        this.json(res, 200, result)
        return
      }
      if (req.method === 'POST' && url.pathname === '/chatds-sync/pair/v1/verification' && this.options.verificationPeer) {
        this.incoming++
        counted = true
        const query = verificationQuery.parse(await this.readBody(req, 1024))
        const identity = this.options.identity
        const peer = this.options.verificationPeer(query.from)
        if (!peer || query.to !== identity.card.id ||
            !verifyTranscript(peer.card, bufferAad('chatds-verification-query', query.from, query.to, query.nonce), query.sig)) {
          throw new Error('Unknown verification peer')
        }
        const required = !!peer.needsVerification
        const sig = signTranscript(identity, bufferAad('chatds-verification-reply', query.from, query.to, query.nonce, Number(required)))
        this.json(res, 200, { required, sig })
        return
      }
      if (req.method === 'GET' && url.pathname === '/chatds-sync/v2/ping') {
        this.json(res, 200, { v: sharingProtocolVersion, id: this.options.identity.card.id, ts: Date.now() })
        return
      }
      if (req.method === 'GET' && url.pathname === '/chatds-sync/v2/card') {
        const identity = this.options.identity
        this.json(res, 200, { card: identity.card, code: shortCode(identity.card) })
        return
      }
      if (req.method !== 'POST' || url.pathname !== '/chatds-sync/v2/hello' &&
          url.pathname !== '/chatds-sync/v2/confirm' && url.pathname !== '/chatds-sync/v2/message') {
        res.writeHead(404).end()
        return
      }
      this.incoming++
      counted = true
      const body = await this.readBody(req)
      if (url.pathname === '/chatds-sync/v2/hello') await this.hello(body, res)
      else if (url.pathname === '/chatds-sync/v2/confirm') await this.confirm(body, res)
      else await this.message(body, res)
    } catch {
      if (!res.headersSent) res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'LAN request rejected' }))
      else if (!res.destroyed) res.destroy()
    } finally {
      if (counted) this.incoming--
    }
  }

  private json(res: ServerResponse, status: number, value: unknown) {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
  }

  private async readBody(req: IncomingMessage, limit = maximumEnvelopeBytes): Promise<unknown> {
    const chunks: Buffer[] = []
    let length = 0
    for await (const data of req) {
      const chunk = data as Buffer
      length += chunk.length
      if (length > limit) throw new Error('LAN envelope too large')
      chunks.push(chunk)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  private peer(id: string): DeviceCard | undefined {
    return this.options.peers().find(({ id: peerId }) => peerId === id)
  }

  private async hello(input: unknown, res: ServerResponse) {
    const request = helloRequest.parse(input)
    const identity = this.options.identity
    if (request.to !== identity.card.id || request.from === identity.card.id) throw new Error('Wrong recipient')
    const peer = this.peer(request.from)
    if (!peer) throw new Error('Unpaired device')
    const ephemeral = newEphemeral()
    const nonce = randomBytes(16).toString('base64url')
    const transcript = lanTranscript(request.from, request.to, request.eph, ephemeral.publicKey, request.nonce, nonce)
    const shared = ephemeralShared(ephemeral.privateKey, request.eph)
    const keys = deriveLanSessionKeys(shared, transcript, false)
    shared.fill(0)
    const id = transcript.toString('hex')
    this.pending.set(id, { transcript, peer, keys, expiresAt: Date.now() + pendingLifetime })
    while (this.pending.size > 32) {
      const oldest = this.pending.keys().next().value
      if (oldest === undefined) break
      const dropped = this.pending.get(oldest)
      if (dropped) wipeLanKeys(dropped.keys)
      this.pending.delete(oldest)
    }
    this.json(res, 200, {
      v: sharingProtocolVersion,
      from: identity.card.id,
      to: request.from,
      eph: ephemeral.publicKey,
      nonce,
      sig: signTranscript(identity, transcript),
    })
  }

  private async confirm(input: unknown, res: ServerResponse) {
    const request = confirmRequest.parse(input)
    const pending = this.pending.get(request.session)
    if (!pending || pending.peer.id !== request.from || pending.expiresAt <= Date.now()) throw new Error('Unknown LAN handshake')
    if (!verifyTranscript(pending.peer, pending.transcript, request.sig)) throw new Error('LAN handshake signature is invalid')
    const aad = bufferAad('chatds-lan-confirm-v2', request.session)
    const proof = sessionOpen(pending.keys.receive, { nonce: request.nonce, tag: request.tag, cipher: request.cipher }, aad.toString())
    if (proof.toString('utf8') !== 'confirm') throw new Error('LAN handshake proof is invalid')
    this.pending.delete(request.session)
    this.sessions.set(request.session, { id: request.session, peer: pending.peer, keys: pending.keys,
      lastSeq: 0, expiresAt: Date.now() + sessionLifetime, messages: 0 })
    while (this.sessions.size > 64) {
      const oldest = this.sessions.keys().next().value
      if (oldest === undefined) break
      const dropped = this.sessions.get(oldest)
      if (dropped) wipeLanKeys(dropped.keys)
      this.sessions.delete(oldest)
    }
    const box = sessionSeal(pending.keys.send, Buffer.from('confirmed'), bufferAad('chatds-lan-confirmed-v2', request.session).toString())
    this.json(res, 200, { v: sharingProtocolVersion, session: request.session, ...box })
  }

  private async message(input: unknown, res: ServerResponse) {
    const request = messageRequest.parse(input)
    const session = this.sessions.get(request.session)
    if (!session || session.peer.id !== request.from || session.expiresAt <= Date.now()) throw new Error('Unknown LAN session')
    if (request.seq !== session.lastSeq + 1) throw new Error('LAN message sequence is invalid')
    const to = this.options.identity.card.id
    const payload = sessionOpen(session.keys.receive, { nonce: request.nonce, tag: request.tag, cipher: request.cipher },
      bufferAad('chatds-lan-message-v2', request.session, request.seq, request.from, to).toString())
    const content = inboundPayload.parse(JSON.parse(payload.toString('utf8')))
    const event = validateSnapshot(content.snapshot)
    if (event.senderId !== session.peer.id) throw new Error('LAN event identity mismatch')
    await this.options.receive(event, content.deviceName)
    session.lastSeq = request.seq
    session.messages++
    const box = sessionSeal(session.keys.send, Buffer.from('ok'), bufferAad('chatds-lan-ack-v2', request.session, request.seq).toString())
    this.json(res, 200, { v: sharingProtocolVersion, session: request.session, seq: request.seq, ...box })
  }

  private async call(address: string, path: string, body: unknown | undefined, signal: AbortSignal, timeout: number, limit = maximumEnvelopeBytes): Promise<unknown> {
    const response = await fetch(address + path, {
      redirect: 'error', method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    })
    const text = await readLimited(response, limit)
    if (!response.ok) throw new Error(`LAN device rejected the request (HTTP ${response.status})`)
    return JSON.parse(text)
  }

  async checkListener(signal: AbortSignal): Promise<boolean> {
    const port = this.port
    if (!port || !this.servers.size) return false
    const healthy = await Promise.all([...this.servers.keys()].map(async (address) => {
      try {
        const pong = z.object({ id: deviceIdSchema }).parse(await this.call(endpointFor(address, port),
          '/chatds-sync/v2/ping', undefined, signal, 1800, 1024))
        return pong.id === this.options.identity.card.id
      } catch { return false }
    }))
    return healthy.some(Boolean)
  }

  async verifyAuthorization(address: string, peer: DeviceCard, signal: AbortSignal): Promise<boolean> {
    const identity = this.options.identity
    const from = identity.card.id
    const to = peer.id
    const nonce = randomBytes(16).toString('base64url')
    const sig = signTranscript(identity, bufferAad('chatds-verification-query', from, to, nonce))
    const reply = verificationReply.parse(await this.call(lanEndpoint(address), '/chatds-sync/pair/v1/verification',
      { from, to, nonce, sig }, signal, 2500, 1024))
    if (!verifyTranscript(peer, bufferAad('chatds-verification-reply', from, to, nonce, Number(reply.required)), reply.sig)) {
      throw new Error('Unverified device authorization response')
    }
    return reply.required
  }

  async pair(address: string, stage: 'begin' | 'finish', body: unknown, signal: AbortSignal, reset = false): Promise<unknown> {
    return this.call(lanEndpoint(address), '/chatds-sync/pair/v1/' + (reset ? 'reset/' : '') + stage, body, signal, 8_000, 4096)
  }

  /** Fetch and authenticate the public card of a discovered device. */
  async card(address: string): Promise<DeviceCard> {
    const base = lanEndpoint(address)
    const value = z.object({ card: deviceCard, code: z.string().max(16) }).parse(await this.call(base, '/chatds-sync/v2/card', undefined, new AbortController().signal, 4_000))
    if (value.code !== shortCode(value.card)) throw new Error('LAN device check code does not match its card')
    return value.card
  }

  discovered(id: string): string | undefined {
    return this.discovery.found(id)?.endpoint
  }

  devices(): DiscoveredDevice[] {
    return this.discovery.list()
  }

  diagnostics(): LanDiagnostics {
    return {
      port: this.port,
      addresses: [...this.servers.keys()],
      loopbackOnly: this.loopbackOnly,
      interfaces: this.snapshot?.eligible ?? [],
      candidates: this.snapshot?.candidates ?? [],
      discovery: this.discovery.status(),
      error: this.error,
      platform: process.platform,
    }
  }

  private async withLock<T>(peerId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(peerId) ?? Promise.resolve()
    const operation = previous.then(run, run)
    this.locks.set(peerId, operation)
    try { return await operation } finally {
      if (this.locks.get(peerId) === operation) this.locks.delete(peerId)
    }
  }

  async send(peer: DeviceCard, event: SyncSnapshot, address: string, signal: AbortSignal): Promise<void> {
    const base = lanEndpoint(address)
    await this.withLock(peer.id, async () => {
      let session = this.outgoing.get(peer.id)
      if (!session || session.address !== base || session.session.expiresAt <= Date.now() ||
          session.session.messages >= maxMessagesPerSession) {
        if (session) {
          wipeLanKeys(session.session.keys)
          this.outgoing.delete(peer.id)
        }
        session = { session: await this.handshake(peer, base, signal), address: base }
        this.outgoing.set(peer.id, session)
      }
      const state = session.session
      const seq = state.lastSeq + 1
      const payload = Buffer.from(JSON.stringify({ snapshot: event, deviceName: this.options.identity.card.name }))
      try {
        const box = sessionSeal(state.keys.send, payload, bufferAad('chatds-lan-message-v2', state.id, seq, this.options.identity.card.id, state.peer.id).toString())
        const response = z.object({ v: z.literal(sharingProtocolVersion), session: z.literal(state.id), seq: z.literal(seq), ...boxSchema.shape })
          .parse(await this.call(base, '/chatds-sync/v2/message', {
            v: sharingProtocolVersion, session: state.id, from: this.options.identity.card.id, seq, ...box,
          }, signal, 5_000))
        const ack = sessionOpen(state.keys.receive, response, bufferAad('chatds-lan-ack-v2', state.id, seq).toString())
        if (ack.toString('utf8') !== 'ok') throw new Error('LAN device did not authenticate delivery')
        state.lastSeq = seq
        state.messages++
      } catch (error) {
        wipeLanKeys(state.keys)
        this.outgoing.delete(peer.id)
        throw error
      }
    })
  }

  private async handshake(peer: DeviceCard, base: string, signal: AbortSignal): Promise<SessionState> {
    const ephemeral = newEphemeral()
    const nonce = randomBytes(16).toString('base64url')
    const identity = this.options.identity
    const response = helloResponse.parse(await this.call(base, '/chatds-sync/v2/hello', {
      v: sharingProtocolVersion, from: identity.card.id, to: peer.id, eph: ephemeral.publicKey, nonce,
    }, signal, 5_000))
    if (response.from !== peer.id || response.to !== identity.card.id) throw new Error('LAN device identity mismatch')
    const transcript = lanTranscript(identity.card.id, peer.id, ephemeral.publicKey, response.eph, nonce, response.nonce)
    if (!verifyTranscript(peer, transcript, response.sig)) throw new Error('LAN device signature is invalid')
    const shared = ephemeralShared(ephemeral.privateKey, response.eph)
    const keys = deriveLanSessionKeys(shared, transcript, true)
    shared.fill(0)
    const id = transcript.toString('hex')
    try {
      const proof = sessionSeal(keys.send, Buffer.from('confirm'), bufferAad('chatds-lan-confirm-v2', id).toString())
      const confirmed = z.object({ v: z.literal(sharingProtocolVersion), session: z.literal(id), ...boxSchema.shape })
        .parse(await this.call(base, '/chatds-sync/v2/confirm', {
          v: sharingProtocolVersion, session: id, from: identity.card.id, sig: signTranscript(identity, transcript), ...proof,
        }, signal, 5_000))
      const value = sessionOpen(keys.receive, confirmed, bufferAad('chatds-lan-confirmed-v2', id).toString())
      if (value.toString('utf8') !== 'confirmed') throw new Error('LAN device did not confirm the session')
      return { id, peer, keys, lastSeq: 0, expiresAt: Date.now() + sessionLifetime, messages: 0 }
    } catch (error) {
      wipeLanKeys(keys)
      throw error
    }
  }

  async close() {
    this.closed = true
    if (this.monitor) clearInterval(this.monitor)
    if (this.sweeper) clearInterval(this.sweeper)
    this.monitor = undefined
    this.sweeper = undefined
    await this.rebinding
    await this.discovery.stop()
    const servers = [...this.servers.values()]
    this.servers = new Map()
    await Promise.all(servers.map((server) => closeServer(server).catch(() => {})))
    for (const session of this.sessions.values()) wipeLanKeys(session.keys)
    for (const pending of this.pending.values()) wipeLanKeys(pending.keys)
    for (const session of this.outgoing.values()) wipeLanKeys(session.session.keys)
    this.sessions.clear()
    this.pending.clear()
    this.outgoing.clear()
    this.addresses = []
    this.port = undefined
  }
}
