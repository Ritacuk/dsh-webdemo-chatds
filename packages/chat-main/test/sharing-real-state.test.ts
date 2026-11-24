import { createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  createIdentity, openEnvelope, publicKeyFromPrivate, seal, type Envelope, type Identity,
} from '../src/host/sharing/crypto.js'
import { digest, snapshotId, type DeviceCard, type SyncSnapshot } from '../src/host/sharing/protocol.js'
import { sharingStateSchema } from '../src/host/sharing/state.js'

const realState = process.env.CHATDS_REAL_STATE

function eventFor(senderId: string): SyncSnapshot {
  const event: Omit<SyncSnapshot, 'eventId'> = {
    senderId, conversationId: 'chatws-' + randomUUID(), messageId: randomUUID(), role: 'assistant',
    parentId: null, context: 'excerpt', createdAt: '2020-01-02T02:00:00.000Z', conversationCreatedAt: null,
    text: 'Real-state historical secret',
  }
  return { ...event, eventId: snapshotId(event) }
}

function x25519(privateKey: string) {
  return createPrivateKey({ key: Buffer.from(privateKey, 'base64url'), type: 'pkcs8', format: 'der' })
}

function publicOf(card: DeviceCard) {
  return createPublicKey({ key: Buffer.from(card.key, 'base64url'), type: 'spki', format: 'der' })
}

function derive(ikm: Buffer, salt: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from(info), 32))
}

function headerOf(envelope: Envelope): string {
  return JSON.stringify(['chatds-envelope-v2', 2, envelope.from, envelope.to, envelope.eventId, envelope.recipient,
    envelope.eph, envelope.prekey, envelope.payloadDigest])
}

function tryOpen(key: Buffer, nonce: string, tag: string, cipher: string, aad: string): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64url'), { authTagLength: 16 })
    .setAAD(Buffer.from(aad)).setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(cipher, 'base64url')), decipher.final()])
}

function expectCannotUnwrap(envelope: Envelope, key: Buffer) {
  const salt = createHash('sha256').update(headerOf(envelope)).digest()
  const wrap = derive(key, salt, 'chatds-wrap-v2')
  expect(() => tryOpen(wrap, envelope.wnonce, envelope.wtag, envelope.wcipher, headerOf(envelope) + '|key')).toThrow()
}

function legacyStaticKey(identity: Identity, peer: DeviceCard): Buffer {
  const secret = diffieHellman({ publicKey: publicOf(peer), privateKey: x25519(identity.privateKey) })
  const pair = [identity.card, peer].sort((a, b) => a.id.localeCompare(b.id))
  return derive(secret, Buffer.from(digest(pair.map((card) => [card.id, card.key])), 'hex'), 'chatds-sharing-v1')
}

describe.skipIf(!realState)('real installed-state forward secrecy', () => {
  it('cannot decrypt a historical envelope after exporting the real device keys', () => {
    const state = sharingStateSchema.parse(JSON.parse(readFileSync(realState!, 'utf8')))
    const receiver = state.identity
    const material = state.prekeys[0]!
    const sender = createIdentity('Historical sender')
    const event = eventFor(sender.card.id)
    const sealed = seal(sender, receiver.card, event, { id: material.id, key: publicKeyFromPrivate(material.privateKey) })

    // The real installed identity can open it with the one-time prekey.
    expect(openEnvelope(receiver, [sender.card], sealed.envelope, [material]).event).toEqual(event)

    // Simulate exporting the current long-term keys. Neither the exported
    // receiver key nor the exported sender key can derive the message key.
    expectCannotUnwrap(sealed.envelope, legacyStaticKey(receiver, sender.card))
    expectCannotUnwrap(sealed.envelope, legacyStaticKey(sender, receiver.card))
    const ephemeral = createPublicKey({ key: Buffer.from(sealed.envelope.eph, 'base64url'), type: 'spki', format: 'der' })
    expectCannotUnwrap(sealed.envelope, diffieHellman({ publicKey: ephemeral, privateKey: x25519(receiver.privateKey) }))
    expectCannotUnwrap(sealed.envelope, diffieHellman({ publicKey: ephemeral, privateKey: x25519(sender.privateKey) }))
    expect(() => tryOpen(legacyStaticKey(receiver, sender.card), sealed.envelope.nonce, sealed.envelope.tag,
      sealed.envelope.cipher, headerOf(sealed.envelope) + '|content')).toThrow()

    // Once the prekey is consumed, a replay cannot be opened even with the
    // real identity and all other state.
    expect(() => openEnvelope(receiver, [sender.card], sealed.envelope, [])).toThrow(/prekey/i)
    expect(JSON.stringify(sealed.envelope)).not.toContain(receiver.privateKey)
    expect(JSON.stringify(sealed.envelope)).not.toContain(receiver.signPrivateKey)
    expect(JSON.stringify(sealed.envelope)).not.toContain(material.privateKey)
    console.log('REAL_STATE_FORWARD_SECRECY_OK', receiver.card.id, receiver.card.name, 'prekey', material.id)
  })
})
