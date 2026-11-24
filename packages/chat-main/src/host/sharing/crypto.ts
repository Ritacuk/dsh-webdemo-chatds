import {
  createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman,
  generateKeyPairSync, hkdfSync, randomBytes, randomUUID, scryptSync, sign as signBytes, timingSafeEqual,
  verify as verifyBytes, type KeyObject,
} from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import {
  deviceCard, deviceIdSchema, digest, eventIdSchema, prekeyIdSchema, publicKeySchema, sharingProtocolVersion,
  signatureSchema, validateSnapshot, type DeviceCard, type SyncSnapshot,
} from './protocol.js'

const privateKeySchema = z.string().regex(/^[A-Za-z0-9_-]{64}$/)

/**
 * Long-term identity.
 *
 * - `privateKey` is X25519. It is never used as a data-encryption key.
 * - `signPrivateKey` is Ed25519. It authenticates device cards, LAN handshake
 *   transcripts and asynchronous envelopes; it never encrypts chat content.
 *
 * Historical ciphertexts must stay unreadable after either long-term key leaks.
 * That property is provided by one-time prekeys (async) and ephemeral X25519
 * exchanges (LAN), not by these long-term keys.
 */
export const identitySchema = z.strictObject({
  version: z.literal(sharingProtocolVersion),
  card: deviceCard,
  privateKey: privateKeySchema,
  signPrivateKey: privateKeySchema,
})
export type Identity = z.infer<typeof identitySchema>

export const prekeySchema = z.strictObject({
  id: prekeyIdSchema,
  privateKey: privateKeySchema,
})
export type StoredPrekey = z.infer<typeof prekeySchema>

export const prekeyPublicSchema = z.strictObject({ id: prekeyIdSchema, key: publicKeySchema })
export type PrekeyPublic = z.infer<typeof prekeyPublicSchema>

export const prekeyBundleSchema = z.strictObject({
  version: z.literal(sharingProtocolVersion),
  deviceId: deviceIdSchema,
  name: deviceCard.shape.name,
  key: publicKeySchema,
  signKey: publicKeySchema,
  issuedAt: z.iso.datetime(),
  prekeys: z.array(prekeyPublicSchema).min(1).max(64),
  sig: signatureSchema,
})
export type PrekeyBundle = z.infer<typeof prekeyBundleSchema>

export interface SealedEnvelope {
  envelope: Envelope
  ack: string
}

export interface OpenedEnvelope {
  event: SyncSnapshot
  deviceName: string
  ack: string
  prekeyId: string
}

export class UnknownPrekeyError extends Error {}

function spki(key: KeyObject): string {
  return key.export({ type: 'spki', format: 'der' }).toString('base64url')
}

function pkcs8(key: KeyObject): string {
  return key.export({ type: 'pkcs8', format: 'der' }).toString('base64url')
}

function privateX25519(value: string): KeyObject {
  const key = createPrivateKey({ key: Buffer.from(value, 'base64url'), type: 'pkcs8', format: 'der' })
  if (key.asymmetricKeyType !== 'x25519') throw new Error('Invalid X25519 key')
  return key
}

function privateEd25519(value: string): KeyObject {
  const key = createPrivateKey({ key: Buffer.from(value, 'base64url'), type: 'pkcs8', format: 'der' })
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Invalid Ed25519 key')
  return key
}

function publicX25519(value: string): KeyObject {
  const key = createPublicKey({ key: Buffer.from(value, 'base64url'), type: 'spki', format: 'der' })
  if (key.asymmetricKeyType !== 'x25519') throw new Error('Invalid pairing key')
  return key
}

function publicEd25519(value: string): KeyObject {
  const key = createPublicKey({ key: Buffer.from(value, 'base64url'), type: 'spki', format: 'der' })
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Invalid signing key')
  return key
}

export function createIdentity(name: string): Identity {
  const agreement = generateKeyPairSync('x25519')
  const signing = generateKeyPairSync('ed25519')
  return {
    version: sharingProtocolVersion,
    card: {
      version: sharingProtocolVersion,
      id: randomUUID(),
      name,
      key: spki(agreement.publicKey),
      signKey: spki(signing.publicKey),
    },
    privateKey: pkcs8(agreement.privateKey),
    signPrivateKey: pkcs8(signing.privateKey),
  }
}

export function identityKeyMatches(identity: Identity): boolean {
  try {
    return spki(createPublicKey(privateX25519(identity.privateKey))) === identity.card.key &&
      spki(createPublicKey(privateEd25519(identity.signPrivateKey))) === identity.card.signKey
  } catch { return false }
}

/** Full safety number, grouped for out-of-band comparison. */
export function fingerprint(card: DeviceCard): string {
  return digest([sharingProtocolVersion, card.id, card.key, card.signKey]).match(/.{8}/g)!.join(' ')
}

/**
 * Short check code derived from the complete card. This is only a convenience
 * for visual comparison; pairing still requires the full fingerprint so a
 * short code cannot be brute-forced into trust.
 */
export function shortCode(card: DeviceCard): string {
  const hex = digest(['chatds-pair-code-v2', card.id, card.key, card.signKey]).slice(0, 8).toUpperCase()
  return hex.slice(0, 4) + '-' + hex.slice(4)
}

export function invite(card: DeviceCard): string {
  return Buffer.from(JSON.stringify(card)).toString('base64url')
}

export function readInvite(value: string): DeviceCard {
  const card = deviceCard.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')))
  publicX25519(card.key)
  publicEd25519(card.signKey)
  return card
}

/** Generate a one-time X25519 prekey. The public half is published; the private half stays local. */
export function createPrekey(): { id: string; publicKey: string; privateKey: string } {
  const pair = generateKeyPairSync('x25519')
  return { id: randomBytes(16).toString('base64url'), publicKey: spki(pair.publicKey), privateKey: pkcs8(pair.privateKey) }
}

function bundleSignature(identity: Identity, value: Omit<PrekeyBundle, 'sig' | 'name'> & { name: string }): string {
  return signBytes(null, Buffer.from(JSON.stringify(['chatds-prekey-bundle-v2', value.deviceId, value.name, value.key,
    value.signKey, value.issuedAt, value.prekeys.map(({ id, key }) => [id, key])])), privateEd25519(identity.signPrivateKey)).toString('base64url')
}

export function publishableBundle(identity: Identity, prekeys: readonly PrekeyPublic[], issuedAt = new Date().toISOString()): PrekeyBundle {
  const body = { version: sharingProtocolVersion as 2, deviceId: identity.card.id, name: identity.card.name,
    key: identity.card.key, signKey: identity.card.signKey, issuedAt, prekeys: [...prekeys] }
  return { ...body, sig: bundleSignature(identity, body) }
}

/** Authenticate a peer's bundle against the signing key learned at pairing time. */
export function verifyPrekeyBundle(card: DeviceCard, input: unknown): PrekeyBundle {
  const bundle = prekeyBundleSchema.parse(input)
  if (bundle.deviceId !== card.id || bundle.key !== card.key || bundle.signKey !== card.signKey) throw new Error('Prekey bundle identity mismatch')
  if (new Set(bundle.prekeys.map(({ id }) => id)).size !== bundle.prekeys.length) throw new Error('Duplicate prekey id')
  const ok = verifyBytes(null, Buffer.from(JSON.stringify(['chatds-prekey-bundle-v2', bundle.deviceId, bundle.name, bundle.key,
    bundle.signKey, bundle.issuedAt, bundle.prekeys.map(({ id, key }) => [id, key])])),
  publicEd25519(card.signKey), Buffer.from(bundle.sig, 'base64url'))
  if (!ok) throw new Error('Prekey bundle signature is invalid')
  return bundle
}

const boxSchema = z.strictObject({
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  tag: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  cipher: z.string().regex(/^[A-Za-z0-9_-]+$/).max(750_000),
})
export type Box = z.infer<typeof boxSchema>

const envelopeSchema = z.strictObject({
  v: z.literal(sharingProtocolVersion),
  from: deviceIdSchema,
  to: deviceIdSchema,
  eventId: eventIdSchema,
  recipient: z.string().regex(/^[a-f0-9]{64}$/),
  eph: publicKeySchema,
  prekey: prekeyIdSchema,
  payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
  nonce: boxSchema.shape.nonce,
  tag: boxSchema.shape.tag,
  cipher: boxSchema.shape.cipher,
  wnonce: boxSchema.shape.nonce,
  wtag: boxSchema.shape.tag,
  wcipher: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  sig: signatureSchema,
})
export type Envelope = z.infer<typeof envelopeSchema>

export const maximumPrekeyCipher = 750_000

function sealBox(key: Buffer, plaintext: Buffer, aad: string): Box {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce).setAAD(Buffer.from(aad))
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return { nonce: nonce.toString('base64url'), cipher: data.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') }
}

function openBox(key: Buffer, data: Box, aad: string): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(data.nonce, 'base64url'), { authTagLength: 16 })
    .setAAD(Buffer.from(aad)).setAuthTag(Buffer.from(data.tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(data.cipher, 'base64url')), decipher.final()])
}

function hkdf(ikm: Buffer, salt: Buffer, info: string, length = 32): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from(info), length))
}

function sha256(...parts: (string | Buffer)[]): Buffer {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part)
  return hash.digest()
}

function wipe(...values: (Buffer | undefined)[]) {
  for (const value of values) value?.fill(0)
}

export function payloadText(event: SyncSnapshot, deviceName: string): string {
  return JSON.stringify({ snapshot: event, deviceName })
}

export function payloadDigest(event: SyncSnapshot, deviceName: string): string {
  return sha256(payloadText(event, deviceName)).toString('hex')
}

function cardDigest(card: DeviceCard): string {
  return sha256(JSON.stringify(['chatds-card-v2', card.id, card.key, card.signKey])).toString('hex')
}

function envelopeHeader(header: Omit<Envelope, 'sig' | 'nonce' | 'tag' | 'cipher' | 'wnonce' | 'wtag' | 'wcipher'>) {
  return JSON.stringify(['chatds-envelope-v2', header.v, header.from, header.to, header.eventId, header.recipient, header.eph, header.prekey, header.payloadDigest])
}

function envelopeSignatureInput(envelope: Omit<Envelope, 'sig'>): Buffer {
  return Buffer.from(JSON.stringify(['chatds-envelope-signature-v2', envelope.v, envelope.from, envelope.to, envelope.eventId,
    envelope.recipient, envelope.eph, envelope.prekey, envelope.payloadDigest, envelope.nonce, envelope.tag, envelope.cipher,
    envelope.wnonce, envelope.wtag, envelope.wcipher]))
}

function wrapAad(envelope: Omit<Envelope, 'sig' | 'wnonce' | 'wtag' | 'wcipher'>): string {
  return envelopeHeader(envelope) + '|key'
}

function contentAad(envelope: Omit<Envelope, 'sig' | 'nonce' | 'tag' | 'cipher' | 'wnonce' | 'wtag' | 'wcipher'>): string {
  return envelopeHeader(envelope) + '|content'
}

function prekeyKey(shared: Buffer, header: ReturnType<typeof envelopeHeader>): { wrap: Buffer; ack: Buffer } {
  const salt = sha256(header)
  const wrap = hkdf(shared, salt, 'chatds-wrap-v2', 32)
  const ack = hkdf(shared, salt, 'chatds-ack-v2', 32)
  return { wrap, ack }
}

/**
 * Encrypt one event to one recipient prekey.
 *
 * Forward secrecy: the sender uses a fresh ephemeral X25519 key and a fresh
 * random message key. The ephemeral private key and message key are discarded
 * after this call. The recipient's one-time prekey private half is deleted
 * after a successful open. Consequently, neither party's long-term identity
 * key can decrypt this ciphertext later.
 */
export function seal(identity: Identity, peer: DeviceCard, event: SyncSnapshot, prekey: PrekeyPublic): SealedEnvelope {
  const payload = Buffer.from(payloadText(event, identity.card.name))
  const digestHex = sha256(payload).toString('hex')
  const ephemeral = generateKeyPairSync('x25519')
  const shared = diffieHellman({ publicKey: publicX25519(prekey.key), privateKey: ephemeral.privateKey })
  const header = {
    v: sharingProtocolVersion as 2,
    from: identity.card.id,
    to: peer.id,
    eventId: event.eventId,
    recipient: cardDigest(peer),
    eph: spki(ephemeral.publicKey),
    prekey: prekey.id,
    payloadDigest: digestHex,
  }
  const keys = prekeyKey(shared, envelopeHeader(header))
  const messageKey = randomBytes(32)
  const content = sealBox(messageKey, payload, contentAad(header))
  const wrapped = sealBox(keys.wrap, messageKey, wrapAad({ ...header, ...content }))
  const unsigned = { ...header, ...content, wnonce: wrapped.nonce, wtag: wrapped.tag, wcipher: wrapped.cipher }
  const sig = signBytes(null, envelopeSignatureInput(unsigned), privateEd25519(identity.signPrivateKey)).toString('base64url')
  const envelope: Envelope = { ...unsigned, sig }
  const ack = createHmac('sha256', keys.ack).update(sig).digest('base64url')
  wipe(shared, keys.wrap, keys.ack, messageKey)
  return { envelope, ack }
}

export function openEnvelope(identity: Identity, peers: readonly DeviceCard[], input: unknown, prekeys: readonly StoredPrekey[]): OpenedEnvelope {
  const envelope = envelopeSchema.parse(input)
  const peer = peers.find(({ id }) => id === envelope.from)
  if (!peer || envelope.to !== identity.card.id || envelope.recipient !== cardDigest(identity.card)) throw new Error('Unpaired or different recipient')
  const signed = verifyBytes(null, envelopeSignatureInput(envelope), publicEd25519(peer.signKey), Buffer.from(envelope.sig, 'base64url'))
  if (!signed) throw new Error('Envelope signature is invalid')
  const stored = prekeys.find(({ id }) => id === envelope.prekey)
  if (!stored) throw new UnknownPrekeyError('Unknown or already used prekey')
  const ephemeral = publicX25519(envelope.eph)
  const shared = diffieHellman({ publicKey: ephemeral, privateKey: privateX25519(stored.privateKey) })
  const keys = prekeyKey(shared, envelopeHeader(envelope))
  let messageKey: Buffer | undefined
  let payload: Buffer | undefined
  try {
    messageKey = openBox(keys.wrap, { nonce: envelope.wnonce, tag: envelope.wtag, cipher: envelope.wcipher }, wrapAad(envelope))
    payload = openBox(messageKey, { nonce: envelope.nonce, tag: envelope.tag, cipher: envelope.cipher }, contentAad(envelope))
    if (sha256(payload).toString('hex') !== envelope.payloadDigest) throw new Error('Envelope payload digest mismatch')
    const content = devicePayload.parse(JSON.parse(payload.toString('utf8')))
    const event = validateSnapshot(content.snapshot)
    if (event.eventId !== envelope.eventId || event.senderId !== peer.id) throw new Error('Invalid event identity')
    const ack = createHmac('sha256', keys.ack).update(envelope.sig).digest('base64url')
    return { event, deviceName: content.deviceName, ack, prekeyId: envelope.prekey }
  } finally {
    wipe(shared, keys.wrap, keys.ack, messageKey, payload)
  }
}

const devicePayload = z.strictObject({ snapshot: z.unknown(), deviceName: deviceCard.shape.name })

/**
 * Verify a create-only WebDAV object without needing the recipient's private
 * prekey. A stored object is equivalent when it is signed by this device for
 * the same recipient and commits to the same payload; otherwise it is either
 * an authenticated conflict or a damaged object.
 */
export function verifyStoredEnvelope(identity: Identity, peer: DeviceCard, expected: SyncSnapshot, value: unknown): 'match' | 'conflict' | 'invalid' {
  try {
    const envelope = envelopeSchema.parse(value)
    if (envelope.from !== identity.card.id || envelope.to !== peer.id || envelope.recipient !== cardDigest(peer) || envelope.eventId !== expected.eventId) return 'invalid'
    if (!verifyBytes(null, envelopeSignatureInput(envelope), publicEd25519(identity.card.signKey), Buffer.from(envelope.sig, 'base64url'))) return 'invalid'
    const expectedDigest = payloadDigest(expected, identity.card.name)
    if (envelope.payloadDigest !== expectedDigest) {
      // A valid signature over the same event with different payload is an
      // immutable authenticated conflict, not a damaged object.
      return 'conflict'
    }
    return isDeepStrictEqual(envelope.payloadDigest, expectedDigest) ? 'match' : 'invalid'
  } catch { return 'invalid' }
}

export function mailboxName(envelope: Envelope): string {
  return envelope.eventId + '.json'
}

/**
 * Derive directional keys for an authenticated ephemeral LAN session.
 * The transcript hash binds the protocol, both device ids, both ephemeral
 * public keys and both nonces.
 */
export function lanTranscript(from: string, to: string, fromEphemeral: string, toEphemeral: string, fromNonce: string, toNonce: string): Buffer {
  return sha256(JSON.stringify(['chatds-lan-v2', sharingProtocolVersion, from, to, fromEphemeral, toEphemeral, fromNonce, toNonce]))
}

export interface LanSessionKeys {
  send: Buffer
  receive: Buffer
  sendAck: Buffer
  receiveAck: Buffer
}

export function deriveLanSessionKeys(shared: Buffer, transcript: Buffer, initiator: boolean): LanSessionKeys {
  const salt = transcript
  const a2b = hkdf(shared, salt, 'chatds-lan-a2b', 32)
  const b2a = hkdf(shared, salt, 'chatds-lan-b2a', 32)
  const a2bAck = hkdf(shared, salt, 'chatds-lan-a2b-ack', 32)
  const b2aAck = hkdf(shared, salt, 'chatds-lan-b2a-ack', 32)
  const keys = initiator
    ? { send: a2b, receive: b2a, sendAck: a2bAck, receiveAck: b2aAck }
    : { send: b2a, receive: a2b, sendAck: b2aAck, receiveAck: a2bAck }
  return keys
}

export function wipeLanKeys(keys: LanSessionKeys | undefined) {
  if (!keys) return
  wipe(keys.send, keys.receive, keys.sendAck, keys.receiveAck)
}

export function signTranscript(identity: Identity, transcript: Buffer): string {
  return signBytes(null, Buffer.concat([Buffer.from('chatds-lan-sign-v2'), transcript]), privateEd25519(identity.signPrivateKey)).toString('base64url')
}

export function verifyTranscript(card: DeviceCard, transcript: Buffer, signature: string): boolean {
  try {
    return verifyBytes(null, Buffer.concat([Buffer.from('chatds-lan-sign-v2'), transcript]), publicEd25519(card.signKey), Buffer.from(signature, 'base64url'))
  } catch { return false }
}

export function ephemeralShared(privateKey: KeyObject, publicKey: string): Buffer {
  return diffieHellman({ publicKey: publicX25519(publicKey), privateKey })
}

export function newEphemeral(): { privateKey: KeyObject; publicKey: string } {
  const pair = generateKeyPairSync('x25519')
  return { privateKey: pair.privateKey, publicKey: spki(pair.publicKey) }
}

export function sessionSeal(key: Buffer, plaintext: Buffer, aad: string): Box {
  return sealBox(key, plaintext, aad)
}

export function sessionOpen(key: Buffer, box: Box, aad: string): Buffer {
  return openBox(key, box, aad)
}

export function secureEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

const backupLabel = 'chatds-sharing-backup-v2'
function backupKey(password: string, salt: Buffer) {
  return scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
}

export function encryptBackup(password: string, value: unknown) {
  const salt = randomBytes(16)
  return JSON.stringify({ format: backupLabel, salt: salt.toString('base64url'),
    ...sealBox(backupKey(password, salt), Buffer.from(JSON.stringify(value)), backupLabel) })
}

export function decryptBackup(password: string, text: string): unknown {
  const value = z.strictObject({ format: z.literal(backupLabel), salt: z.string().length(22),
    nonce: z.string().length(16), tag: z.string().length(22), cipher: z.string().max(16 * 1024 * 1024) }).parse(JSON.parse(text))
  return JSON.parse(openBox(backupKey(password, Buffer.from(value.salt, 'base64url')), value, backupLabel).toString('utf8'))
}

/** Test helper: export a private key object for a historical-ciphertext simulation. */
export function privateKeyObject(identity: Identity): { agreement: KeyObject; signing: KeyObject } {
  return { agreement: privateX25519(identity.privateKey), signing: privateEd25519(identity.signPrivateKey) }
}

export function publicKeyOf(privateKey: KeyObject): string {
  return spki(createPublicKey(privateKey))
}

export function publicKeyFromPrivate(privateKey: string): string {
  return spki(createPublicKey(privateX25519(privateKey)))
}
