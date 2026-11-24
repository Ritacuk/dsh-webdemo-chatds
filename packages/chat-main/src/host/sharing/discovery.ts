import { createSocket, type Socket } from 'node:dgram'
import { Bonjour, type Browser, type Service } from 'bonjour-service'
import { z } from 'zod'
import {
  deviceIdSchema, deviceName, sharingProtocolVersion,
} from './protocol.js'
import { endpointFor, pickPeerAddress, sharesLocalSubnet, stripZone, type InterfaceCandidate } from './network.js'

export const serviceType = 'chatds-sync'
export const serviceProtocol = 'tcp'
export const fallbackGroup = '239.255.46.61'
export const fallbackPort = 46_832

const shortCodePattern = /^[A-F0-9]{4}-[A-F0-9]{4}$/
const lifetime = 60_000
const multicastAdvertisement = z.strictObject({
  v: z.literal(sharingProtocolVersion),
  proto: z.literal(sharingProtocolVersion),
  id: deviceIdSchema,
  name: deviceName,
  code: z.string().regex(shortCodePattern),
  port: z.number().int().min(1).max(65_535),
})

export interface DiscoveryInfo {
  id: string
  name: string
  code: string
  port: number
  /** Usable local interfaces. One mDNS socket is opened per IPv4 address. */
  local?: readonly InterfaceCandidate[]
}

export interface DiscoveredDevice {
  id: string
  name: string
  code: string
  address: string
  port: number
  version: number
  endpoint: string
  seenAt: number
}

export interface DiscoveryStatus {
  mechanism: 'mdns' | 'multicast' | 'mdns+multicast'
  published: boolean
  browsing: boolean
  error?: string
  devices: number
}

interface Instance {
  bonjour: Bonjour
  browser?: Browser
  published?: Service
  local: InterfaceCandidate
}

/**
 * DNS-SD/mDNS advertiser and browser.
 *
 * One socket is created per selected local IPv4 address with an explicit
 * multicast interface. Relying on the OS default route is wrong on a
 * multi-homed host: a response can leave through a Wi-Fi or VPN interface and
 * never reach the peer on the wired LAN.
 *
 * Only discovery metadata is published: Device ID, display name, a short
 * visual check code, protocol version and TCP port. No key material, token,
 * chat text or user name is placed in TXT records.
 */
export class MdnsDiscovery {
  private instances: Instance[] = []
  private devices = new Map<string, DiscoveredDevice>()
  private errors: string[] = []
  private info?: DiscoveryInfo
  private refresh?: ReturnType<typeof setInterval>
  private fallbacks: Socket[] = []
  private fallbackTimers: ReturnType<typeof setInterval>[] = []

  async start(info: DiscoveryInfo) {
    await this.stop()
    this.info = info
    const local = (info.local ?? []).filter(({ family, address }) => family === 'IPv4' && !address.includes(':'))
    if (local.length === 0) {
      // Isolated tests or a host with no usable LAN interface: a single
      // default-routed socket is still useful for same-host verification.
      local.push({ name: 'default', address: '', family: 'IPv4', scope: 'private', eligible: true })
    }
    for (const candidate of local) {
      try {
        const bonjour = new Bonjour(candidate.address ? ({ interface: candidate.address, bind: '0.0.0.0' } as unknown as {}) : {}, (error: Error) => {
          this.errors.push(error.message.slice(0, 160))
        })
        const published = bonjour.publish({
          name: candidate.address
            ? `ChatDS ${info.id.slice(0, 8)} ${candidate.address}`
            : `ChatDS ${info.id.slice(0, 8)}`,
          type: serviceType,
          protocol: serviceProtocol,
          port: info.port,
          txt: { v: String(sharingProtocolVersion), proto: String(sharingProtocolVersion), id: info.id, name: info.name, code: info.code },
        })
        published.on('error', (error: Error) => this.errors.push(error.message.slice(0, 160)))
        const browser = bonjour.find({ type: serviceType, protocol: serviceProtocol })
        browser.on('up', (service: Service) => this.add(service, candidate))
        browser.on('txt-update', (service: Service) => this.add(service, candidate))
        browser.on('down', (service: Service) => this.remove(service))
        browser.start()
        this.instances.push({ bonjour, browser, published, local: candidate })
      } catch (error) {
        this.errors.push(error instanceof Error ? error.message.slice(0, 160) : 'mDNS could not start')
      }
    }
    this.startFallback(info, local)
    this.refresh = setInterval(() => {
      for (const instance of this.instances) {
        try { instance.browser?.update() } catch { /* Polling is best effort. */ }
      }
      this.prune()
    }, 20_000)
    this.refresh.unref()
  }

  private startFallback(info: DiscoveryInfo, local: readonly InterfaceCandidate[]) {
    for (const candidate of local) {
      if (!candidate.address) continue
      try {
        const socket = createSocket({ type: 'udp4', reuseAddr: true })
        socket.on('error', (error) => { this.errors.push(error.message.slice(0, 160)) })
        socket.on('message', (data, sender) => this.addFallback(data, sender.address))
        socket.bind(fallbackPort, '0.0.0.0', () => {
          try {
            socket.addMembership(fallbackGroup, candidate.address)
            socket.setMulticastInterface(candidate.address)
            socket.setMulticastTTL(2)
            socket.setMulticastLoopback(true)
          } catch (error) {
            this.errors.push(error instanceof Error ? error.message.slice(0, 160) : 'multicast could not start')
          }
          const announce = () => {
            const payload = Buffer.from(JSON.stringify({ v: sharingProtocolVersion, proto: sharingProtocolVersion,
              id: info.id, name: info.name, code: info.code, port: info.port }))
            socket.send(payload, fallbackPort, fallbackGroup, () => {})
          }
          announce()
          const timer = setInterval(announce, 10_000)
          timer.unref()
          this.fallbackTimers.push(timer)
        })
        this.fallbacks.push(socket)
      } catch (error) {
        this.errors.push(error instanceof Error ? error.message.slice(0, 160) : 'multicast could not start')
      }
    }
  }

  private addFallback(data: Buffer, sender: string) {
    try {
      if (data.length > 512) return
      const message = multicastAdvertisement.parse(JSON.parse(data.toString('utf8')))
      if (message.id === this.info?.id) return
      const address = pickPeerAddress([sender], this.info?.local ?? [])
      if (!address) return
      this.remember({ id: message.id, name: message.name, code: message.code, address, port: message.port,
        version: sharingProtocolVersion, endpoint: endpointFor(address, message.port), seenAt: Date.now() })
    } catch { /* Ignore unrelated multicast traffic. */ }
  }

  private remember(device: DiscoveredDevice) {
    const allLocal = this.info?.local ?? []
    const existing = this.devices.get(device.id)
    if (existing && sharesLocalSubnet(existing.address, allLocal) && !sharesLocalSubnet(device.address, allLocal)) {
      existing.seenAt = Date.now()
      return
    }
    this.devices.set(device.id, device)
  }

  private add(service: Service, local: InterfaceCandidate) {
    try {
      const txt = new Map<string, string>()
      for (const [key, value] of Object.entries(service.txt ?? {})) {
        if (typeof value === 'string') txt.set(key.toLowerCase(), value)
        else if (Buffer.isBuffer(value)) txt.set(key.toLowerCase(), value.toString('utf8'))
      }
      const id = deviceIdSchema.parse(txt.get('id'))
      if (id === this.info?.id) return
      const name = deviceName.parse(txt.get('name'))
      const code = txt.get('code') ?? ''
      if (!shortCodePattern.test(code)) return
      if ((txt.get('proto') ?? txt.get('v')) !== String(sharingProtocolVersion)) return
      const port = service.port
      if (!Number.isInteger(port) || port < 1 || port > 65_535) return
      const referer = service.referer?.address ? stripZone(service.referer.address) : ''
      const addresses = [...new Set([referer, ...(service.addresses ?? []).map(stripZone)])]
        .filter((address) => address.length > 0)
      const address = pickPeerAddress(addresses, [local]) ?? pickPeerAddress(addresses, this.info?.local ?? [])
      if (!address) return
      this.remember({ id, name, code, address, port, version: sharingProtocolVersion,
        endpoint: endpointFor(address, port), seenAt: Date.now() })
    } catch { /* Ignore unrelated or malformed mDNS services. */ }
  }

  private remove(service: Service) {
    const id = String(service.txt?.['id'] ?? '')
    if (id) this.devices.delete(id)
  }

  private prune() {
    const cutoff = Date.now() - lifetime
    for (const [id, device] of this.devices) if (device.seenAt < cutoff) this.devices.delete(id)
  }

  list(): DiscoveredDevice[] {
    this.prune()
    return [...this.devices.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  found(id: string): DiscoveredDevice | undefined {
    this.prune()
    return this.devices.get(id)
  }

  status(): DiscoveryStatus {
    return {
      mechanism: this.instances.length > 0 && this.fallbacks.length > 0 ? 'mdns+multicast'
        : this.instances.length > 0 ? 'mdns' : 'multicast',
      published: this.instances.some(({ published }) => !!published) || this.fallbacks.length > 0,
      browsing: this.instances.some(({ browser }) => !!browser) || this.fallbacks.length > 0,
      error: this.instances.length === 0 && this.fallbacks.length === 0
        ? this.errors[0] ?? 'LAN discovery could not start' : undefined,
      devices: this.devices.size,
    }
  }

  async stop() {
    if (this.refresh) clearInterval(this.refresh)
    this.refresh = undefined
    for (const timer of this.fallbackTimers.splice(0)) clearInterval(timer)
    for (const socket of this.fallbacks.splice(0)) {
      try { socket.dropMembership(fallbackGroup) } catch { /* Not joined. */ }
      try { socket.close() } catch { /* Already closed. */ }
    }
    for (const instance of this.instances.splice(0)) {
      try { instance.browser?.stop() } catch { /* Already stopped. */ }
      try { instance.published?.stop?.() } catch { /* Already stopped. */ }
      try { instance.bonjour.unpublishAll() } catch { /* Already stopped. */ }
      try { instance.bonjour.destroy() } catch { /* Already destroyed. */ }
    }
    this.devices.clear()
    this.errors = []
    this.info = undefined
  }
}
