import { describe, expect, it } from 'vitest'
import { createIdentity } from '../src/host/sharing/crypto.js'
import { joinWithPassword, PasswordPairing, PasswordReset, registerPassword, resetHostPassword } from '../src/host/sharing/password-pairing.js'

const password = 'synthetic apple walnut sea breeze'
const replacement = 'synthetic maple fern morning sky'

describe('password enrollment', () => {
  it('limits attempts and consumes the authenticated finish exactly once', async () => {
    const host = createIdentity('Host')
    const joining = createIdentity('Joining device')
    const registration = await registerPassword(password, host.card.id)
    const pairing = new PasswordPairing()
    let commits = 0
    let finish: unknown
    const handle = (stage: 'begin' | 'finish', input: unknown) => {
      if (stage === 'finish') finish = input
      expect(JSON.stringify(input)).not.toContain(password)
      return pairing.handle(stage, input, '127.0.0.1', host, registration, async ({ card }) => {
        expect(card).toEqual(joining.card)
        commits++
      })
    }
    expect(JSON.stringify(registration)).not.toContain(password)
    expect((await joinWithPassword(password, joining, host.card.id, handle)).card).toEqual(host.card)
    await expect(handle('finish', finish)).rejects.toThrow('Invalid pairing attempt')
    for (let attempt = 0; attempt < 4; attempt++) {
      await expect(joinWithPassword(replacement, joining, host.card.id, handle)).rejects.toThrow('同步密码不正确')
    }
    await expect(joinWithPassword(password, joining, host.card.id, handle)).rejects.toThrow('temporarily limited')
    expect(commits).toBe(1)
  }, 15_000)

  it('allows authenticated delegated reset without transmitting the new password', async () => {
    const host = createIdentity('Host')
    const member = createIdentity('Member')
    const stranger = createIdentity('Stranger')
    const reset = new PasswordReset()
    let registration = await registerPassword(password, host.card.id)
    const before = registration
    const handle = (stage: 'begin' | 'finish', input: unknown) => {
      expect(JSON.stringify(input)).not.toContain(replacement)
      return reset.handle(stage, input, host, registration, (id) => id === member.card.id ? member.card : undefined,
        async (next, prior, from) => {
          expect(prior).toBe(before.record)
          expect(from).toBe(member.card.id)
          registration = next
        })
    }
    await expect(resetHostPassword(replacement, stranger, host.card, handle)).rejects.toThrow('Unauthorized')
    await resetHostPassword(replacement, member, host.card, handle)
    expect(registration).not.toEqual(before)
    const pairing = new PasswordPairing()
    const join = (stage: 'begin' | 'finish', input: unknown) =>
      pairing.handle(stage, input, '127.0.0.1', host, registration, async () => {})
    await expect(joinWithPassword(password, stranger, host.card.id, join)).rejects.toThrow('同步密码不正确')
    expect((await joinWithPassword(replacement, stranger, host.card.id, join)).card).toEqual(host.card)
  }, 15_000)
})
