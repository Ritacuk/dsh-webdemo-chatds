import { constants, createDecipheriv, generateKeyPair, privateDecrypt, randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { z } from 'zod'

const generate = promisify(generateKeyPair)
const encoded = (length: number) => z.string().length(length).regex(/^[A-Za-z0-9_-]+$/)
const passwordBox = z.strictObject({
  ticket: z.uuid(), key: encoded(342), iv: encoded(16), tag: encoded(22),
  cipher: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/),
})

/** Protects device password input across the local browser-to-host boundary. */
export class PasswordInput {
  private keys?: ReturnType<typeof generatePair>
  private readonly tickets = new Map<string, number>()

  async issue() {
    const now = Date.now()
    for (const [ticket, expiry] of this.tickets) if (expiry <= now) this.tickets.delete(ticket)
    if (this.tickets.size >= 16) throw new Error('Password input temporarily limited')
    const ticket = randomUUID()
    this.tickets.set(ticket, now + 60_000)
    const { publicKey } = await (this.keys ??= generatePair().catch((error) => {
      this.keys = undefined
      throw error
    }))
    return { ticket, publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url') }
  }

  async open(value: unknown): Promise<string> {
    const input = passwordBox.parse(value)
    const expiry = this.tickets.get(input.ticket)
    this.tickets.delete(input.ticket)
    if (!expiry || expiry <= Date.now() || !this.keys) throw new Error('Password input expired')
    const { privateKey } = await this.keys
    const key = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(input.key, 'base64url'))
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(input.iv, 'base64url'))
      decipher.setAAD(Buffer.from(input.ticket))
      decipher.setAuthTag(Buffer.from(input.tag, 'base64url'))
      const password = Buffer.concat([decipher.update(Buffer.from(input.cipher, 'base64url')), decipher.final()])
      try { return new TextDecoder('utf-8', { fatal: true }).decode(password) }
      finally { password.fill(0) }
    } finally { key.fill(0) }
  }
}

function generatePair() {
  return generate('rsa', { modulusLength: 2048 })
}
