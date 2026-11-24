import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  createIdentity, createPrekey, decryptBackup, encryptBackup, fingerprint, invite, openEnvelope, publishableBundle,
  readInvite, seal, shortCode, verifyPrekeyBundle, verifyStoredEnvelope, type PrekeyPublic, type StoredPrekey,
} from '../src/host/sharing/crypto.js'
import { shareableText, snapshotId, validateSnapshot, type SyncSnapshot } from '../src/host/sharing/protocol.js'

function eventFor(senderId: string): SyncSnapshot {
  const event: Omit<SyncSnapshot, 'eventId'> = {
    senderId, conversationId: 'chatws-' + randomUUID(), messageId: randomUUID(), role: 'assistant',
    parentId: null, context: 'excerpt', createdAt: '2020-01-02T02:00:00.000Z', conversationCreatedAt: null, text: 'Visible reply',
  }
  return { ...event, eventId: snapshotId(event) }
}

function prekey(): { public: PrekeyPublic; stored: StoredPrekey } {
  const material = createPrekey()
  return { public: { id: material.id, key: material.publicKey }, stored: { id: material.id, privateKey: material.privateKey } }
}

describe('data sharing wire boundary', () => {
  it('authenticates the intended recipient, metadata and delivery acknowledgement', () => {
    const sender = createIdentity('Sender')
    const receiver = createIdentity('Receiver')
    const unrelated = createIdentity('Unrelated')
    const event = eventFor(sender.card.id)
    const key = prekey()
    const { envelope, ack } = seal(sender, receiver.card, event, key.public)
    const copy = openEnvelope(receiver, [sender.card], envelope, [key.stored])
    expect(copy.event).toEqual(event)
    expect(copy.ack).toBe(ack)
    expect(envelope.cipher).not.toContain(event.text)
    expect(() => openEnvelope(unrelated, [sender.card], envelope, [])).toThrow()
    expect(() => openEnvelope(receiver, [], envelope, [key.stored])).toThrow()
    expect(() => openEnvelope(receiver, [sender.card], { ...envelope, eventId: '1'.repeat(64) }, [key.stored])).toThrow()
    expect(() => openEnvelope(receiver, [sender.card], envelope, [prekey().stored])).toThrow()
  })

  it('uses a fresh one-time key for each event while keeping the event identity stable', () => {
    const sender = createIdentity('Sender')
    const receiver = createIdentity('Receiver')
    const event = eventFor(sender.card.id)
    const first = prekey()
    const second = prekey()
    const a = seal(sender, receiver.card, event, first.public)
    const b = seal(sender, receiver.card, event, second.public)
    expect(a.envelope.prekey).not.toBe(b.envelope.prekey)
    expect(a.envelope.eph).not.toBe(b.envelope.eph)
    expect(a.envelope.eventId).toBe(b.envelope.eventId)
    expect(openEnvelope(receiver, [sender.card], a.envelope, [first.stored]).event).toEqual(event)
    expect(openEnvelope(receiver, [sender.card], b.envelope, [second.stored]).event).toEqual(event)

    const rotated = createIdentity('Receiver')
    rotated.card.id = receiver.card.id
    const c = seal(sender, rotated.card, event, prekey().public)
    expect(c.envelope.eventId).toBe(a.envelope.eventId)
    expect(c.envelope.from).toBe(a.envelope.from)
    expect(() => openEnvelope(rotated, [sender.card], a.envelope, [first.stored])).toThrow()
  })

  it('distinguishes an authenticated immutable conflict from a damaged DAV object', () => {
    const sender = createIdentity('Sender')
    const receiver = createIdentity('Receiver')
    const original = eventFor(sender.card.id)
    const key = prekey()
    const { envelope } = seal(sender, receiver.card, original, key.public)
    expect(verifyStoredEnvelope(sender, receiver.card, original, envelope)).toBe('match')
    expect(verifyStoredEnvelope(sender, receiver.card, { ...original, text: 'Changed reply' }, envelope)).toBe('conflict')
    const bytes = Buffer.from(envelope.cipher, 'base64url')
    bytes[0] = bytes[0]! ^ 0x01
    expect(verifyStoredEnvelope(sender, receiver.card, original, { ...envelope, cipher: bytes.toString('base64url') })).toBe('invalid')
    expect(verifyStoredEnvelope(receiver, sender.card, original, envelope)).toBe('invalid')
  })

  it('binds fingerprints and short check codes to both identity keys', () => {
    const identity = createIdentity('Device')
    const card = identity.card
    expect(fingerprint(card)).toMatch(/^(?:[a-f0-9]{8} ){7}[a-f0-9]{8}$/)
    expect(shortCode(card)).toMatch(/^[A-F0-9]{4}-[A-F0-9]{4}$/)
    expect(readInvite(invite(card))).toEqual(card)
    const other = { ...card, signKey: createIdentity('Other').card.signKey }
    expect(fingerprint(other)).not.toBe(fingerprint(card))
    expect(shortCode(other)).not.toBe(shortCode(card))
  })

  it('publishes only signed public prekeys and rejects a swapped bundle', () => {
    const identity = createIdentity('Device')
    const keys = [createPrekey(), createPrekey()]
    const bundle = publishableBundle(identity, keys.map(({ id, publicKey }) => ({ id, key: publicKey })))
    expect(verifyPrekeyBundle(identity.card, bundle).prekeys).toHaveLength(2)
    const attacker = createIdentity('Attacker')
    const forged = publishableBundle(attacker, keys.map(({ id, publicKey }) => ({ id, key: publicKey })))
    expect(() => verifyPrekeyBundle(identity.card, forged)).toThrow()
    expect(JSON.stringify(bundle)).not.toContain(keys[0]!.privateKey)
  })

  it('rejects unapproved structure and recognizable secrets before projection', () => {
    const event = eventFor(createIdentity('Sender').card.id)
    expect(() => validateSnapshot({ ...event, parentId: 'hidden-parent' })).toThrow()
    expect(() => validateSnapshot({ ...event, text: 'api_key=sk-abcdefghijklmnopqrst' })).toThrow()
    expect(() => validateSnapshot({ ...event, hiddenPrompt: 'Injected field' })).toThrow()
    expect(shareableText('See /mnt/workspace/project/file.md')).toBe(false)
    expect(shareableText('See https://example.com/docs/start')).toBe(true)
  })

  it('protects recovery data using an independent passphrase', () => {
    const data = { recovery: 'private test material' }
    const encrypted = encryptBackup('synthetic recovery password', data)
    expect(encrypted).not.toContain(data.recovery)
    expect(decryptBackup('synthetic recovery password', encrypted)).toEqual(data)
    expect(() => decryptBackup('another synthetic password', encrypted)).toThrow()
  })
})
