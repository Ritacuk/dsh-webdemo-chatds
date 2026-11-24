import { createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createIdentity, createPrekey, deriveLanSessionKeys, ephemeralShared, lanTranscript, newEphemeral, openEnvelope,
  payloadDigest, publicKeyFromPrivate, seal, sessionOpen, sessionSeal, signTranscript, verifyTranscript,
  wipeLanKeys, type Envelope, type Identity,
} from '../src/host/sharing/crypto.js'
import { digest, snapshotId, type DeviceCard, type SyncSnapshot } from '../src/host/sharing/protocol.js'
import { SharingStateFile } from '../src/host/sharing/state.js'

function eventFor(senderId: string): SyncSnapshot {
  const event: Omit<SyncSnapshot, 'eventId'> = {
    senderId, conversationId: 'chatws-' + randomUUID(), messageId: randomUUID(), role: 'assistant',
    parentId: null, context: 'excerpt', createdAt: '2020-01-02T02:00:00.000Z', conversationCreatedAt: null,
    text: 'Historical secret reply that must not survive key compromise',
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

function wrapAad(envelope: Envelope): string {
  return headerOf(envelope) + '|key'
}

function contentAad(envelope: Envelope): string {
  return headerOf(envelope) + '|content'
}

function tryOpen(key: Buffer, nonce: string, tag: string, cipher: string, aad: string): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64url'), { authTagLength: 16 })
    .setAAD(Buffer.from(aad)).setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(cipher, 'base64url')), decipher.final()])
}

/** The exact static-static key used by 0.11.9-rc.1, kept only to prove it no longer decrypts v2 objects. */
function legacyStaticKey(identity: Identity, peer: DeviceCard): Buffer {
  const secret = diffieHellman({ publicKey: publicOf(peer), privateKey: x25519(identity.privateKey) })
  const pair = [identity.card, peer].sort((a, b) => a.id.localeCompare(b.id))
  return derive(secret, Buffer.from(digest(pair.map((card) => [card.id, card.key])), 'hex'), 'chatds-sharing-v1')
}

function expectCannotUnwrap(envelope: Envelope, key: Buffer) {
  const salt = createHash('sha256').update(headerOf(envelope)).digest()
  const wrap = derive(key, salt, 'chatds-wrap-v2')
  expect(() => tryOpen(wrap, envelope.wnonce, envelope.wtag, envelope.wcipher, wrapAad(envelope))).toThrow()
}

describe('forward secrecy of asynchronous sharing objects', () => {
  it('does not let the sender long-term identity decrypt a captured historical envelope', () => {
    const sender = createIdentity('Sender')
    const receiver = createIdentity('Receiver')
    const material = createPrekey()
    const event = eventFor(sender.card.id)
    const { envelope } = seal(sender, receiver.card, event, { id: material.id, key: material.publicKey })
    expect(envelope.cipher).not.toContain('Historical secret reply')

    // Attacker exports the current sender identity after the message was sent.
    expectCannotUnwrap(envelope, legacyStaticKey(sender, receiver.card))
    const ephemeralPublic = createPublicKey({ key: Buffer.from(envelope.eph, 'base64url'), type: 'spki', format: 'der' })
    const senderToEphemeral = diffieHellman({ publicKey: ephemeralPublic, privateKey: x25519(sender.privateKey) })
    expectCannotUnwrap(envelope, senderToEphemeral)
    // The payload key is random; no long-term key can open the content box either.
    expect(() => tryOpen(legacyStaticKey(sender, receiver.card), envelope.nonce, envelope.tag, envelope.cipher, contentAad(envelope))).toThrow()
  })

  it('does not let the recipient long-term identity decrypt a captured historical envelope', () => {
    const sender = createIdentity('Sender')
    const receiver = createIdentity('Receiver')
    const material = createPrekey()
    const event = eventFor(sender.card.id)
    const { envelope } = seal(sender, receiver.card, event, { id: material.id, key: material.publicKey })

    // Attacker exports the current recipient identity. The prekey private
    // half is a separate one-time secret and is not derived from it.
    expectCannotUnwrap(envelope, legacyStaticKey(receiver, sender.card))
    const ephemeralPublic = createPublicKey({ key: Buffer.from(envelope.eph, 'base64url'), type: 'spki', format: 'der' })
    const recipientToEphemeral = diffieHellman({ publicKey: ephemeralPublic, privateKey: x25519(receiver.privateKey) })
    expectCannotUnwrap(envelope, recipientToEphemeral)
    expect(() => tryOpen(recipientToEphemeral, envelope.nonce, envelope.tag, envelope.cipher, contentAad(envelope))).toThrow()
  })

  it('still refuses the old static-key ciphertext and old key identifiers', () => {
    const sender = createIdentity('Sender')
    const receiver = createIdentity('Receiver')
    const event = eventFor(sender.card.id)
    const legacy = {
      version: 1, from: sender.card.id, to: receiver.card.id, eventId: event.eventId,
      keyId: digest([sender.card.key, receiver.card.key]).slice(0, 16),
      nonce: 'aaaaaaaaaaaaaaaa', tag: 'bbbbbbbbbbbbbbbbbbbbbb', cipher: 'cccc',
    }
    expect(() => openEnvelope(receiver, [sender.card], legacy, [])).toThrow()
    expect(() => openEnvelope(receiver, [sender.card], { ...legacy, v: 2 }, [])).toThrow()
  })

  it('consumes the prekey so a replayed envelope cannot be decrypted after state compromise', () => {
    const sender = createIdentity('Sender')
    const receiver = createIdentity('Receiver')
    const material = createPrekey()
    const stored = { id: material.id, privateKey: material.privateKey }
    const event = eventFor(sender.card.id)
    const { envelope } = seal(sender, receiver.card, event, { id: material.id, key: material.publicKey })
    expect(openEnvelope(receiver, [sender.card], envelope, [stored]).event).toEqual(event)

    // The engine deletes the stored prekey after a successful open. A replay
    // and an attacker holding both long-term identities still fail.
    expect(() => openEnvelope(receiver, [sender.card], envelope, [])).toThrow(/prekey/i)
    expectCannotUnwrap(envelope, legacyStaticKey(receiver, sender.card))
    expectCannotUnwrap(envelope, legacyStaticKey(sender, receiver.card))
  })

  it('rejects tampering, recipient substitution and an unpaired sender', () => {
    const sender = createIdentity('Sender')
    const receiver = createIdentity('Receiver')
    const material = createPrekey()
    const stored = { id: material.id, privateKey: material.privateKey }
    const event = eventFor(sender.card.id)
    const { envelope } = seal(sender, receiver.card, event, { id: material.id, key: material.publicKey })
    const flip = (value: string) => {
      const bytes = Buffer.from(value, 'base64url')
      bytes[0] = bytes[0]! ^ 0x01
      return bytes.toString('base64url')
    }
    expect(() => openEnvelope(receiver, [sender.card], { ...envelope, cipher: flip(envelope.cipher) }, [stored])).toThrow()
    expect(() => openEnvelope(receiver, [sender.card], { ...envelope, wcipher: flip(envelope.wcipher) }, [stored])).toThrow()
    expect(() => openEnvelope(receiver, [sender.card], { ...envelope, sig: flip(envelope.sig) }, [stored])).toThrow()
    expect(() => openEnvelope(receiver, [sender.card], { ...envelope, payloadDigest: '0'.repeat(64) }, [stored])).toThrow()
    const rotated = createIdentity('Rotated')
    rotated.card.id = receiver.card.id
    expect(() => openEnvelope(rotated, [sender.card], envelope, [stored])).toThrow(/recipient/i)
    const stranger = createIdentity('Stranger')
    expect(() => openEnvelope(receiver, [stranger.card], envelope, [stored])).toThrow()
    expect(() => openEnvelope(receiver, [sender.card], envelope, [{ id: material.id, privateKey: createPrekey().privateKey }])).toThrow()
  })

  it('survives a host restart because unused prekeys are persisted, not the ephemeral chain', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chatds-fs-'))
    try {
      const file = new SharingStateFile(directory)
      const created = await file.load()
      const sender = createIdentity('Sender')
      const material = created.prekeys[0]!
      const event = eventFor(sender.card.id)
      const { envelope } = seal(sender, created.identity.card, event,
        { id: material.id, key: publicKeyFromPrivate(material.privateKey) })

      const reopened = await new SharingStateFile(directory).load()
      expect(reopened.identity).toEqual(created.identity)
      expect(reopened.prekeys.map(({ id }) => id)).toContain(material.id)
      expect(openEnvelope(reopened.identity, [sender.card], envelope, reopened.prekeys).event).toEqual(event)
      expect(() => openEnvelope(reopened.identity, [sender.card], envelope, reopened.prekeys.filter(({ id }) => id !== material.id))).toThrow()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('supports multiple senders claiming independent one-time prekeys', () => {
    const receiver = createIdentity('Receiver')
    const first = createPrekey()
    const second = createPrekey()
    const senderA = createIdentity('Sender A')
    const senderB = createIdentity('Sender B')
    const eventA = eventFor(senderA.card.id)
    const eventB = eventFor(senderB.card.id)
    const sealedA = seal(senderA, receiver.card, eventA, { id: first.id, key: first.publicKey })
    const sealedB = seal(senderB, receiver.card, eventB, { id: second.id, key: second.publicKey })
    expect(sealedA.envelope.prekey).not.toBe(sealedB.envelope.prekey)
    const openedA = openEnvelope(receiver, [senderA.card], sealedA.envelope, [{ id: first.id, privateKey: first.privateKey }])
    const openedB = openEnvelope(receiver, [senderB.card], sealedB.envelope, [{ id: second.id, privateKey: second.privateKey }])
    expect(openedA.event).toEqual(eventA)
    expect(openedB.event).toEqual(eventB)
  })
})

describe('forward secrecy of LAN sessions', () => {
  it('derives directional keys from ephemeral secrets and wipes them after use', () => {
    const initiator = createIdentity('Initiator')
    const responder = createIdentity('Responder')
    const a = newEphemeral()
    const b = newEphemeral()
    const transcript = lanTranscript(initiator.card.id, responder.card.id, a.publicKey, b.publicKey,
      'n'.repeat(22), 'm'.repeat(22))
    const sharedA = ephemeralShared(a.privateKey, b.publicKey)
    const sharedB = ephemeralShared(b.privateKey, a.publicKey)
    expect(sharedA.equals(sharedB)).toBe(true)
    const keysA = deriveLanSessionKeys(sharedA, transcript, true)
    const keysB = deriveLanSessionKeys(sharedB, transcript, false)
    expect(keysA.send.equals(keysB.receive)).toBe(true)
    expect(keysA.receive.equals(keysB.send)).toBe(true)

    const aad = JSON.stringify(['chatds-lan-message-v2', transcript.toString('hex'), 1, initiator.card.id, responder.card.id])
    const box = sessionSeal(keysA.send, Buffer.from(JSON.stringify({ secret: 'lan secret' })), aad)
    expect(sessionOpen(keysB.receive, box, aad).toString()).toContain('lan secret')
    expect(() => sessionOpen(keysB.receive, box, aad + 'x')).toThrow()
    wipeLanKeys(keysA)
    wipeLanKeys(keysB)
    expect(keysA.send.equals(Buffer.alloc(32))).toBe(true)
    expect(keysB.receive.equals(Buffer.alloc(32))).toBe(true)

    // A later leak of both long-term identities does not recreate the session
    // secret: it was produced by ephemeral private keys that no longer exist.
    const leakedA = diffieHellman({ publicKey: publicOf(responder.card), privateKey: x25519(initiator.privateKey) })
    const leakedB = diffieHellman({ publicKey: publicOf(initiator.card), privateKey: x25519(responder.privateKey) })
    expect(() => sessionOpen(deriveLanSessionKeys(leakedA, transcript, true).send, box, aad)).toThrow()
    expect(() => sessionOpen(deriveLanSessionKeys(leakedB, transcript, false).receive, box, aad)).toThrow()
  })

  it('binds the complete handshake transcript so a replayed signature is useless', () => {
    const initiator = createIdentity('Initiator')
    const responder = createIdentity('Responder')
    const first = newEphemeral()
    const second = newEphemeral()
    const oldTranscript = lanTranscript(initiator.card.id, responder.card.id, first.publicKey, second.publicKey,
      'a'.repeat(22), 'b'.repeat(22))
    const signature = signTranscript(responder, oldTranscript)
    expect(verifyTranscript(responder.card, oldTranscript, signature)).toBe(true)
    const fresh = newEphemeral()
    const replayedTranscript = lanTranscript(initiator.card.id, responder.card.id, first.publicKey, fresh.publicKey,
      'a'.repeat(22), 'c'.repeat(22))
    expect(verifyTranscript(responder.card, replayedTranscript, signature)).toBe(false)
    expect(verifyTranscript(initiator.card, oldTranscript, signature)).toBe(false)
  })

  it('does not expose a stable pairwise shared secret', () => {
    const sender = createIdentity('Sender')
    const receiver = createIdentity('Receiver')
    const event = eventFor(sender.card.id)
    const material = createPrekey()
    const one = seal(sender, receiver.card, event, { id: material.id, key: material.publicKey })
    expect(one.envelope.payloadDigest).toBe(payloadDigest(event, sender.card.name))
    expect(JSON.stringify(one.envelope)).not.toContain(sender.privateKey)
    expect(JSON.stringify(one.envelope)).not.toContain(material.privateKey)
    expect(JSON.stringify(one.envelope)).not.toContain(receiver.privateKey)
  })
})
