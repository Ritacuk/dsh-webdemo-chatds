import { afterEach, describe, expect, it } from 'vitest'
import { createIdentity, shortCode } from '../src/host/sharing/crypto.js'
import { MdnsDiscovery } from '../src/host/sharing/discovery.js'
import {
  classifyInterface, endpointFor, interfaceSnapshot, isTrustedRemote, lanEndpoint,
} from '../src/host/sharing/network.js'

const started: MdnsDiscovery[] = []
afterEach(async () => {
  for (const discovery of started.splice(0)) await discovery.stop()
})

async function waitFor(check: () => boolean, timeout = 12_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('Timed out waiting for mDNS discovery')
}

describe('LAN interface policy', () => {
  it('accepts physical private addresses and rejects virtual, public and link-local ones', () => {
    expect(classifyInterface('enp3s0f0', '192.168.10.205')).toMatchObject({ eligible: true, scope: 'private' })
    expect(classifyInterface('mig-lan-100', '10.50.10.103')).toMatchObject({ eligible: true })
    expect(classifyInterface('Wi-Fi', 'fdec:4d99:9d88::57e')).toMatchObject({ eligible: true, scope: 'unique-local' })
    expect(classifyInterface('docker0', '172.17.0.1')).toMatchObject({ eligible: false })
    expect(classifyInterface('br-a57afd47c6b2', '172.25.0.1')).toMatchObject({ eligible: false })
    expect(classifyInterface('vEthernet (Default Switch)', '172.18.240.1')).toMatchObject({ eligible: false })
    expect(classifyInterface('tailscale0', '100.100.1.1')).toMatchObject({ eligible: false })
    expect(classifyInterface('enp3s0f0', '169.254.10.1')).toMatchObject({ eligible: false, scope: 'link-local' })
    expect(classifyInterface('enp3s0f0', '8.8.8.8')).toMatchObject({ eligible: false, scope: 'public' })
    expect(classifyInterface('lo', '127.0.0.1')).toMatchObject({ eligible: false, scope: 'loopback' })
  })

  it('lets an explicit user selection override the virtual-adapter exclusion', () => {
    const snapshot = interfaceSnapshot({ allow: ['br-a57afd47c6b2'] })
    const chosen = snapshot.eligible.find(({ name }) => name === 'br-a57afd47c6b2')
    if (chosen) expect(chosen.eligible).toBe(true)
    expect(interfaceSnapshot({ allow: ['8.8.8.8'] }).eligible.every(({ address }) => address !== '8.8.8.8')).toBe(true)
  })

  it('validates manual endpoints and formats IPv6 URLs', () => {
    expect(lanEndpoint('http://192.168.1.23:40000/')).toBe('http://192.168.1.23:40000')
    expect(lanEndpoint('http://[fdec::1]:40000/')).toBe('http://[fdec::1]:40000')
    expect(lanEndpoint('http://127.0.0.1:40000/')).toBe('http://127.0.0.1:40000')
    expect(() => lanEndpoint('http://8.8.8.8:40000/')).toThrow()
    expect(() => lanEndpoint('http://user:pass@10.0.0.1:40000/')).toThrow()
    expect(() => lanEndpoint('http://10.0.0.1:40000/path')).toThrow()
    expect(endpointFor('fdec::1', 46830)).toBe('http://[fdec::1]:46830')
  })

  it('never treats the public internet as a trusted LAN peer', () => {
    expect(isTrustedRemote('10.50.10.103')).toBe(true)
    expect(isTrustedRemote('::ffff:192.168.10.205')).toBe(true)
    expect(isTrustedRemote('fdec::1')).toBe(true)
    expect(isTrustedRemote('127.0.0.1')).toBe(true)
    expect(isTrustedRemote('8.8.8.8')).toBe(false)
    expect(isTrustedRemote('2606:4700:4700::1111')).toBe(false)
    expect(isTrustedRemote(undefined)).toBe(false)
  })
})

describe('mDNS / DNS-SD discovery', () => {
  it('finds another ChatDS service without publishing secrets', async () => {
    const alpha = createIdentity('Alpha')
    const beta = createIdentity('Beta')
    const a = new MdnsDiscovery()
    const b = new MdnsDiscovery()
    started.push(a, b)
    await a.start({ id: alpha.card.id, name: alpha.card.name, code: shortCode(alpha.card), port: 46990 })
    await b.start({ id: beta.card.id, name: beta.card.name, code: shortCode(beta.card), port: 46991 })
    await waitFor(() => !!a.found(beta.card.id) && !!b.found(alpha.card.id))
    const foundByA = a.found(beta.card.id)!
    const foundByB = b.found(alpha.card.id)!
    expect(foundByA.name).toBe('Beta')
    expect(foundByA.port).toBe(46991)
    expect(foundByB.name).toBe('Alpha')
    expect(foundByB.port).toBe(46990)
    expect(foundByA.endpoint).toMatch(/^http:\/\/[^/]+:46991$/)
    expect(a.found(alpha.card.id)).toBeUndefined()
    const text = JSON.stringify(foundByA)
    expect(text).not.toContain(alpha.privateKey)
    expect(text).not.toContain(beta.privateKey)
    expect(text).not.toContain(alpha.card.signKey)
  }, 20_000)
})
