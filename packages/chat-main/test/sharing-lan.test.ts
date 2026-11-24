import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createIdentity } from '../src/host/sharing/crypto.js'
import { LanTransport } from '../src/host/sharing/lan.js'
import { endpointFor } from '../src/host/sharing/network.js'
import { snapshotId, type DeviceCard, type SyncSnapshot } from '../src/host/sharing/protocol.js'

function eventFor(senderId: string, text = 'LAN test reply'): SyncSnapshot {
  const event: Omit<SyncSnapshot, 'eventId'> = {
    senderId, conversationId: 'chatws-' + randomUUID(), messageId: randomUUID(), role: 'assistant',
    parentId: null, context: 'excerpt', createdAt: '2020-01-02T02:00:00.000Z', conversationCreatedAt: null, text,
  }
  return { ...event, eventId: snapshotId(event) }
}

function transport(identity: ReturnType<typeof createIdentity>, peers: () => DeviceCard[],
  receive: (event: SyncSnapshot, deviceName: string) => Promise<void>) {
  return new LanTransport({ identity, peers, receive, includeLoopback: true, discovery: false, port: 0 })
}

const running: LanTransport[] = []
afterEach(async () => {
  for (const item of running.splice(0)) await item.close().catch(() => {})
})

describe('LAN direct transport', () => {
  it('delivers authenticated events in both directions after a fresh ephemeral handshake', async () => {
    const a = createIdentity('Linux')
    const b = createIdentity('Windows')
    const receivedA: SyncSnapshot[] = []
    const receivedB: SyncSnapshot[] = []
    const aPeers: DeviceCard[] = [b.card]
    const bPeers: DeviceCard[] = [a.card]
    const transportA = transport(a, () => aPeers, async (event) => { receivedA.push(event) })
    const transportB = transport(b, () => bPeers, async (event) => { receivedB.push(event) })
    running.push(transportA, transportB)
    await transportA.start()
    await transportB.start()
    const portA = transportA.diagnostics().port!
    const portB = transportB.diagnostics().port!
    expect(transportA.diagnostics().loopbackOnly).toBe(false)
    expect(portA).not.toBe(portB)

    const fromA = eventFor(a.card.id, 'Linux to Windows')
    const fromB = eventFor(b.card.id, 'Windows to Linux')
    await transportA.send(b.card, fromA, endpointFor('127.0.0.1', portB), new AbortController().signal)
    await transportB.send(a.card, fromB, endpointFor('127.0.0.1', portA), new AbortController().signal)
    expect(receivedB).toEqual([fromA])
    expect(receivedA).toEqual([fromB])
  })

  it('serializes concurrent sends and reconnects after a transport restart', async () => {
    const a = createIdentity('A')
    const b = createIdentity('B')
    const received: SyncSnapshot[] = []
    const receivedA: SyncSnapshot[] = []
    const aPeers: DeviceCard[] = [b.card]
    const bPeers: DeviceCard[] = [a.card]
    let transportA = transport(a, () => aPeers, async (event) => { receivedA.push(event) })
    const transportB = transport(b, () => bPeers, async (event) => { received.push(event) })
    running.push(transportA, transportB)
    await transportA.start()
    await transportB.start()
    const portB = transportB.diagnostics().port!
    const events = [eventFor(a.card.id, 'one'), eventFor(a.card.id, 'two'), eventFor(a.card.id, 'three')]
    await Promise.all(events.map((event) => transportA.send(b.card, event, endpointFor('127.0.0.1', portB), new AbortController().signal)))
    expect(received.map(({ text }) => text).sort()).toEqual(['one', 'three', 'two'])

    await transportA.close()
    transportA = transport(a, () => aPeers, async (event) => { receivedA.push(event) })
    running.push(transportA)
    await transportA.start()
    const portA = transportA.diagnostics().port!
    const fromB = eventFor(b.card.id, 'after reconnect')
    await transportB.send(a.card, fromB, endpointFor('127.0.0.1', portA), new AbortController().signal)
    expect(receivedA.map(({ text }) => text)).toContain('after reconnect')
  })

  it('rejects an unpaired device, a swapped identity and an event from a different device', async () => {
    const a = createIdentity('A')
    const b = createIdentity('B')
    const stranger = createIdentity('Stranger')
    const bPeers: DeviceCard[] = [a.card]
    const transportB = transport(b, () => bPeers, async () => {})
    running.push(transportB)
    await transportB.start()
    const portB = transportB.diagnostics().port!

    const impostor = createIdentity('Impostor')
    impostor.card.id = a.card.id
    const transportImpostor = transport(impostor, () => [b.card], async () => {})
    running.push(transportImpostor)
    await transportImpostor.start()
    await expect(transportImpostor.send(b.card, eventFor(impostor.card.id), endpointFor('127.0.0.1', portB),
      new AbortController().signal)).rejects.toThrow()

    const transportStranger = transport(stranger, () => [b.card], async () => {})
    running.push(transportStranger)
    await transportStranger.start()
    await expect(transportStranger.send(b.card, eventFor(stranger.card.id), endpointFor('127.0.0.1', portB),
      new AbortController().signal)).rejects.toThrow()

    const transportA = transport(a, () => [b.card], async () => {})
    running.push(transportA)
    await transportA.start()
    await expect(transportA.send(b.card, eventFor(stranger.card.id), endpointFor('127.0.0.1', portB),
      new AbortController().signal)).rejects.toThrow()
  })

  it('does not accept an unauthenticated card swap by id', async () => {
    const a = createIdentity('A')
    const b = createIdentity('B')
    const transportA = transport(a, () => [b.card], async () => {})
    const transportB = transport(b, () => [a.card], async () => {})
    running.push(transportA, transportB)
    await transportA.start()
    await transportB.start()
    const portB = transportB.diagnostics().port!
    const card = await transportA.card(endpointFor('127.0.0.1', portB))
    expect(card).toEqual(b.card)
  })
})
