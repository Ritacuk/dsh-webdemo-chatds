import { hkdfSync, randomUUID } from 'node:crypto'
import * as opaque from '@serenity-kit/opaque'
import { z } from 'zod'
import { sessionOpen, sessionSeal, signTranscript, verifyTranscript, type Identity } from './crypto.js'
import { deviceCard, deviceIdSchema } from './protocol.js'

const opaqueMessage = z.string().min(1).max(1024).regex(/^[A-Za-z0-9+/=_-]+$/)
export const passwordRegistration = z.strictObject({ setup: opaqueMessage, record: opaqueMessage })
export type PasswordRegistration = z.infer<typeof passwordRegistration>
const beginRequest = z.strictObject({ to: deviceIdSchema, login: opaqueMessage })
const beginResponse = z.strictObject({ attempt: z.uuid(), login: opaqueMessage })
const boxSchema = z.strictObject({
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  tag: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  cipher: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/),
})
const finishRequest = z.strictObject({ attempt: z.uuid(), login: opaqueMessage, box: boxSchema })
const signedCard = z.strictObject({
  card: deviceCard,
  platform: z.string().regex(/^[a-z0-9]+$/).max(16),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
})
type Box = z.infer<typeof boxSchema>
export type PairingDevice = Omit<z.infer<typeof signedCard>, 'signature'>
type Role = 'joining' | 'accepting'

const identifiers = (id: string) => ({ client: 'chatds-sync-device-v1', server: 'chatds-sync-host-v1:' + id })
const userIdentifier = 'chatds-device-sync-password-v1'
const keyStretching = 'memory-constrained' as const

export class PasswordPairingError extends Error {}

export async function registerPassword(password: string, id: string): Promise<PasswordRegistration> {
  await opaque.ready
  const setup = opaque.server.createSetup()
  const start = opaque.client.startRegistration({ password })
  const { registrationResponse } = opaque.server.createRegistrationResponse({
    serverSetup: setup, userIdentifier, registrationRequest: start.registrationRequest,
  })
  const { registrationRecord } = opaque.client.finishRegistration({
    clientRegistrationState: start.clientRegistrationState, registrationResponse,
    password, identifiers: identifiers(id), keyStretching,
  })
  return { setup, record: registrationRecord }
}

const context = (attempt: string, host: string, role: Role) => JSON.stringify(['chatds-password-device-v1', attempt, host, role])

function cardTranscript(label: string, card: PairingDevice): Buffer {
  return Buffer.from(JSON.stringify([label, card.card.id, card.card.key, card.card.signKey, card.card.name, card.platform]))
}

function cardKey(sessionKey: string, label: string): Buffer {
  const secret = Buffer.from(sessionKey, 'base64')
  try { return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), label, 32)) }
  finally { secret.fill(0) }
}

function sealCard(sessionKey: string, label: string, identity: Identity): Box {
  const device = { card: identity.card, platform: process.platform }
  const signature = signTranscript(identity, cardTranscript(label, device))
  const key = cardKey(sessionKey, label)
  try { return sessionSeal(key, Buffer.from(JSON.stringify({ ...device, signature })), label) }
  finally { key.fill(0) }
}

function openCard(sessionKey: string, label: string, box: Box): PairingDevice {
  const key = cardKey(sessionKey, label)
  try {
    const { signature, ...device } = signedCard.parse(JSON.parse(sessionOpen(key, box, label).toString('utf8')))
    if (!verifyTranscript(device.card, cardTranscript(label, device), signature)) throw new Error('Invalid device signature')
    return device
  } finally { key.fill(0) }
}

/** OPAQUE attempts are one-shot, short-lived and limited across all source addresses. */
export class PasswordPairing {
  private readonly pending = new Map<string, { state: string; remote: string; expires: number; credential: PasswordRegistration }>()
  private attempts: number[] = []
  private readonly attemptsByAddress = new Map<string, number[]>()

  async handle(stage: 'begin' | 'finish', body: unknown, remote: string, identity: Identity,
    credential: PasswordRegistration, accept: (peer: PairingDevice, credential: PasswordRegistration) => Promise<void>) {
    await opaque.ready
    const now = Date.now()
    for (const [id, value] of this.pending) if (value.expires <= now) this.pending.delete(id)
    if (stage === 'begin') {
      const request = beginRequest.parse(body)
      if (request.to !== identity.card.id) throw new Error('Invalid target')
      const window = now - 60_000
      this.attempts = this.attempts.filter((time) => time > window)
      for (const [address, times] of this.attemptsByAddress) if (times.at(-1)! <= window) this.attemptsByAddress.delete(address)
      const source = (this.attemptsByAddress.get(remote) ?? []).filter((time) => time > window)
      if (source.length >= 5 || this.attempts.length >= 20) throw new Error('Pairing temporarily limited')
      source.push(now)
      this.attemptsByAddress.set(remote, source)
      this.attempts.push(now)
      const { loginResponse, serverLoginState } = opaque.server.startLogin({
        serverSetup: credential.setup, registrationRecord: credential.record, userIdentifier,
        startLoginRequest: request.login, identifiers: identifiers(request.to),
      })
      const attempt = randomUUID()
      this.pending.set(attempt, { state: serverLoginState, remote, credential, expires: now + 45_000 })
      return { attempt, login: loginResponse }
    }
    const request = finishRequest.parse(body)
    const pending = this.pending.get(request.attempt)
    if (!pending || pending.remote !== remote) throw new Error('Invalid pairing attempt')
    this.pending.delete(request.attempt)
    if (pending.credential.record !== credential.record) throw new Error('Password changed')
    const { sessionKey } = opaque.server.finishLogin({
      serverLoginState: pending.state, finishLoginRequest: request.login, identifiers: identifiers(identity.card.id),
    })
    const peer = openCard(sessionKey, context(request.attempt, identity.card.id, 'joining'), request.box)
    await accept(peer, credential)
    return { box: sealCard(sessionKey, context(request.attempt, identity.card.id, 'accepting'), identity) }
  }

  invalidate() { this.pending.clear() }
}

export async function joinWithPassword(password: string, identity: Identity, host: string,
  call: (stage: 'begin' | 'finish', body: unknown) => Promise<unknown>): Promise<PairingDevice> {
  await opaque.ready
  const start = opaque.client.startLogin({ password })
  const begin = beginResponse.parse(await call('begin', { to: host, login: start.startLoginRequest }))
  const finish = opaque.client.finishLogin({
    password, clientLoginState: start.clientLoginState, loginResponse: begin.login,
    identifiers: identifiers(host), keyStretching,
  })
  if (!finish) throw new PasswordPairingError('同步密码不正确，或对方刚修改了密码。')
  const response = z.strictObject({ box: boxSchema }).parse(await call('finish', {
    attempt: begin.attempt, login: finish.finishLoginRequest,
    box: sealCard(finish.sessionKey, context(begin.attempt, host, 'joining'), identity),
  }))
  const peer = openCard(finish.sessionKey, context(begin.attempt, host, 'accepting'), response.box)
  if (peer.card.id !== host) throw new Error('Unexpected device')
  return peer
}

const resetBegin = z.strictObject({ from: deviceIdSchema, nonce: z.uuid(), request: opaqueMessage, sig: signedCard.shape.signature })
const resetBeginReply = z.strictObject({ attempt: z.uuid(), response: opaqueMessage, sig: signedCard.shape.signature })
const resetFinish = z.strictObject({ from: deviceIdSchema, attempt: z.uuid(), record: opaqueMessage, sig: signedCard.shape.signature })
const resetAck = z.strictObject({ sig: signedCard.shape.signature })
const resetTranscript = (stage: string, host: string, peer: string, ...fields: string[]) =>
  Buffer.from(JSON.stringify(['chatds-password-reset-v1', stage, host, peer, ...fields]))

/** Only a device with a current, individually authorized identity can request a reset. */
export class PasswordReset {
  private pending?: { attempt: string; from: string; setup: string; record: string; expires: number }
  private readonly used = new Map<string, number>()

  async handle(stage: 'begin' | 'finish', body: unknown, identity: Identity, credential: PasswordRegistration,
    findPeer: (id: string) => PairingDevice['card'] | undefined,
    commit: (registration: PasswordRegistration, prior: string, from: string) => Promise<void>) {
    await opaque.ready
    const host = identity.card.id
    const now = Date.now()
    if (stage === 'begin') {
      const request = resetBegin.parse(body)
      const { from, nonce } = request
      const peer = findPeer(from)
      if (!peer || !verifyTranscript(peer, resetTranscript('begin', host, from, nonce, request.request), request.sig)) {
        throw new Error('Unauthorized password reset')
      }
      for (const [id, expires] of this.used) if (expires <= now) this.used.delete(id)
      if (this.used.has(nonce) || this.used.size >= 10 || this.pending && this.pending.expires > now) {
        throw new Error('Password reset temporarily limited')
      }
      this.used.set(nonce, now + 60_000)
      const setup = opaque.server.createSetup()
      const { registrationResponse: response } = opaque.server.createRegistrationResponse({
        serverSetup: setup, userIdentifier, registrationRequest: request.request,
      })
      const attempt = randomUUID()
      this.pending = { attempt, from, setup, record: credential.record, expires: now + 20_000 }
      return { attempt, response, sig: signTranscript(identity, resetTranscript('reply', host, from, nonce, attempt, response)) }
    }
    const request = resetFinish.parse(body)
    const { attempt, from, record } = request
    const peer = findPeer(from)
    const pending = this.pending
    if (!peer || !pending || pending.attempt !== attempt || pending.from !== from || pending.expires <= now ||
        !verifyTranscript(peer, resetTranscript('finish', host, from, attempt, record), request.sig)) {
      throw new Error('Invalid password reset')
    }
    this.pending = undefined
    await commit({ setup: pending.setup, record }, pending.record, from)
    return { sig: signTranscript(identity, resetTranscript('ack', host, from, attempt)) }
  }

  invalidate() { this.pending = undefined }
}

export async function resetHostPassword(password: string, identity: Identity, peer: PairingDevice['card'],
  call: (stage: 'begin' | 'finish', body: unknown) => Promise<unknown>): Promise<void> {
  await opaque.ready
  const host = peer.id
  const from = identity.card.id
  const nonce = randomUUID()
  const { registrationRequest: request, clientRegistrationState } = opaque.client.startRegistration({ password })
  const begin = resetBeginReply.parse(await call('begin', {
    from, nonce, request, sig: signTranscript(identity, resetTranscript('begin', host, from, nonce, request)),
  }))
  if (!verifyTranscript(peer, resetTranscript('reply', host, from, nonce, begin.attempt, begin.response), begin.sig)) {
    throw new Error('Unverified password reset host')
  }
  const { registrationRecord: record } = opaque.client.finishRegistration({
    clientRegistrationState, registrationResponse: begin.response, password, identifiers: identifiers(host), keyStretching,
  })
  const ack = resetAck.parse(await call('finish', {
    from, attempt: begin.attempt, record, sig: signTranscript(identity, resetTranscript('finish', host, from, begin.attempt, record)),
  }))
  if (!verifyTranscript(peer, resetTranscript('ack', host, from, begin.attempt), ack.sig)) {
    throw new Error('Unverified password reset acknowledgment')
  }
}
