import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { cloudTransport, type CloudTransport } from '../src/host/sharing/cloud.js'
import {
  createIdentity, createPrekey, openEnvelope, publishableBundle, seal, verifyPrekeyBundle, verifyStoredEnvelope,
  type PrekeyBundle, type PrekeyPublic, type StoredPrekey,
} from '../src/host/sharing/crypto.js'
import { snapshotId, type SyncSnapshot } from '../src/host/sharing/protocol.js'

function eventFor(senderId: string, text = 'WebDAV reply'): SyncSnapshot {
  const event: Omit<SyncSnapshot, 'eventId'> = {
    senderId, conversationId: 'chatws-' + randomUUID(), messageId: randomUUID(), role: 'assistant',
    parentId: null, context: 'excerpt', createdAt: '2020-01-02T02:00:00.000Z', conversationCreatedAt: null, text,
  }
  return { ...event, eventId: snapshotId(event) }
}

class DavServer {
  readonly files = new Map<string, { body: string; etag: string }>()
  readonly collections = new Set<string>()
  private server?: Server
  private sequence = 0
  base = ''

  async start() {
    this.server = createServer((req, res) => this.handle(req, res))
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', () => resolve()))
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('DAV did not bind')
    this.base = `http://127.0.0.1:${address.port}/dav/`
  }

  async stop() {
    if (!this.server) return
    const server = this.server
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections() })
    this.server = undefined
  }

  private authorize(req: IncomingMessage): boolean {
    return req.headers.authorization === 'Basic ' + Buffer.from('user:pass').toString('base64')
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    if (!this.authorize(req)) { res.writeHead(401).end(); return }
    const path = new URL(req.url ?? '/', 'http://dav').pathname
    if (req.method === 'MKCOL') {
      this.collections.add(path)
      res.writeHead(201).end()
      return
    }
    if (req.method === 'PUT') {
      const existing = this.files.get(path)
      if (req.headers['if-none-match'] === '*' && existing) { res.writeHead(412).end(); return }
      if (req.headers['if-match'] !== undefined && existing?.etag !== req.headers['if-match']) { res.writeHead(412).end(); return }
      const etag = `"v${++this.sequence}"`
      this.files.set(path, { body: Buffer.concat(chunks).toString('utf8'), etag })
      res.writeHead(existing ? 204 : 201, { etag }).end()
      return
    }
    if (req.method === 'GET') {
      const file = this.files.get(path)
      if (!file) { res.writeHead(404).end(); return }
      res.writeHead(200, { etag: file.etag, 'content-type': 'application/json' }).end(file.body)
      return
    }
    if (req.method === 'PROPFIND') {
      const entries = [...this.files.keys()].filter((file) => file.startsWith(path) && !file.slice(path.length).includes('/'))
      const body = '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">' +
        entries.map((file) => `<D:response><D:href>${file}</D:href><D:propstat><D:prop><D:resourcetype/></D:prop></D:propstat></D:response>`).join('') +
        '</D:multistatus>'
      res.writeHead(207, { 'content-type': 'application/xml' }).end(body)
      return
    }
    res.writeHead(405).end()
  }
}

const servers: DavServer[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
})

async function setup() {
  const dav = new DavServer()
  servers.push(dav)
  await dav.start()
  const transport = cloudTransport({ provider: 'webdav', url: dav.base, username: 'user', password: 'pass' }, async () => {})
  return { dav, transport }
}

function keys(count = 3): { public: PrekeyPublic[]; stored: StoredPrekey[] } {
  const created = Array.from({ length: count }, () => createPrekey())
  return {
    public: created.map(({ id, publicKey }) => ({ id, key: publicKey })),
    stored: created.map(({ id, privateKey }) => ({ id, privateKey })),
  }
}

describe('WebDAV forward-secret object transport', () => {
  it('publishes and verifies a signed prekey bundle and enforces single claims', async () => {
    const { transport } = await setup()
    const receiver = createIdentity('Receiver')
    const material = keys()
    const bundle = publishableBundle(receiver, material.public)
    await transport.publishBundle(bundle, new AbortController().signal)
    const fetched = await transport.fetchBundle(receiver.card.id, new AbortController().signal)
    const verified = verifyPrekeyBundle(receiver.card, fetched)
    expect(verified.prekeys).toHaveLength(3)
    expect(await transport.claimPrekey(receiver.card.id, material.public[0]!.id, new AbortController().signal)).toBe(true)
    expect(await transport.claimPrekey(receiver.card.id, material.public[0]!.id, new AbortController().signal)).toBe(false)
    expect(await transport.claimPrekey(receiver.card.id, material.public[1]!.id, new AbortController().signal)).toBe(true)
  })

  it('stores, pulls and opens a forward-secret envelope; replays and conflicts stay immutable', async () => {
    const { transport } = await setup()
    const sender = createIdentity('Sender')
    const receiver = createIdentity('Receiver')
    const material = keys()
    const signal = new AbortController().signal
    await transport.publishBundle(publishableBundle(receiver, material.public), signal)
    const event = eventFor(sender.card.id)
    const sealed = seal(sender, receiver.card, event, material.public[0]!)
    await transport.put(sealed.envelope, signal, (value) => verifyStoredEnvelope(sender, receiver.card, event, value))
    // A repeated PUT of the same event is accepted only after authenticating the stored object.
    await transport.put(sealed.envelope, signal, (value) => verifyStoredEnvelope(sender, receiver.card, event, value))

    const opened: SyncSnapshot[] = []
    await transport.pull(receiver.card.id, new Set(), async (value, filename) => {
      const copy = openEnvelope(receiver, [sender.card], value, material.stored)
      expect(filename).toBe(event.eventId)
      opened.push(copy.event)
    }, signal)
    expect(opened).toEqual([event])

    const changed = { ...event, text: 'Different authenticated content for the same event identity' }
    const conflicting = seal(sender, receiver.card, changed, material.public[1]!)
    await expect(transport.put(conflicting.envelope, signal, (value) => verifyStoredEnvelope(sender, receiver.card, changed, value)))
      .rejects.toThrow(/immutable event conflict/)
  })

  it('repairs a damaged create-only object only with a matching ETag', async () => {
    const { dav, transport } = await setup()
    const sender = createIdentity('Sender')
    const receiver = createIdentity('Receiver')
    const material = keys()
    const signal = new AbortController().signal
    await transport.publishBundle(publishableBundle(receiver, material.public), signal)
    const event = eventFor(sender.card.id, 'Repairable reply')
    const sealed = seal(sender, receiver.card, event, material.public[0]!)
    await transport.put(sealed.envelope, signal, (value) => verifyStoredEnvelope(sender, receiver.card, event, value))

    const path = `/dav/chatds-v2-${receiver.card.id}/${event.eventId}.json`
    const file = dav.files.get(path)!
    dav.files.set(path, { ...file, body: '{"v":1,"corrupt":true}' })
    const replacement = seal(sender, receiver.card, event, material.public[1]!)
    await transport.put(replacement.envelope, signal, (value) => verifyStoredEnvelope(sender, receiver.card, event, value))
    const repaired = JSON.parse(dav.files.get(path)!.body) as { sig: string }
    expect(repaired.sig).toBe(replacement.envelope.sig)
  })

  it('refuses a wrong WebDAV password', async () => {
    const dav = new DavServer()
    servers.push(dav)
    await dav.start()
    const bad = cloudTransport({ provider: 'webdav', url: dav.base, username: 'user', password: 'wrong' }, async () => {})
    await expect(bad.fetchBundle(createIdentity('Receiver').card.id, new AbortController().signal)).rejects.toThrow(/401/)
  })
})

describe('prekey bundle shape', () => {
  it('never includes private prekeys or the identity private keys', () => {
    const identity = createIdentity('Device')
    const material = keys(2)
    const bundle: PrekeyBundle = publishableBundle(identity, material.public)
    const text = JSON.stringify(bundle)
    for (const { privateKey } of material.stored) expect(text).not.toContain(privateKey)
    expect(text).not.toContain(identity.privateKey)
    expect(text).not.toContain(identity.signPrivateKey)
  })
})
