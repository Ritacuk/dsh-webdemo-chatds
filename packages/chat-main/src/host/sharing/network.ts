import { isIPv4, isIPv6 } from 'node:net'
import { networkInterfaces } from 'node:os'

export type AddressScope = 'private' | 'unique-local' | 'carrier' | 'loopback' | 'link-local' | 'public' | 'unspecified'
export type AddressFamily = 'IPv4' | 'IPv6'

export interface InterfaceCandidate {
  name: string
  address: string
  family: AddressFamily
  scope: AddressScope
  /** Prefix length from the OS interface, used to prefer peers on a shared subnet. */
  prefix?: number
  /** True when the address is a private/ULA unicast address fit for LAN sync. */
  eligible: boolean
  /** Why an otherwise private address was excluded by the default policy. */
  reason?: string
}

/**
 * Virtual adapters are not LAN peers by default: Docker bridges, WSL/Hyper-V
 * switches, VM host-only adapters and VPN tunnels would advertise addresses
 * that the other physical device cannot reach. An explicit user selection
 * (interface name or address) overrides this list.
 */
const virtualName = /^(?:lo|loopback|docker|br-|veth|virbr|vmnet|vboxnet|tailscale|zt|wg|tun|tap|utun|awdl|llw|wsl|vethernet)/i
const virtualWords = /(?:docker|virtualbox|vmware|hyper-v|tailscale|zerotier|wsl|loopback|npcap|host-only|vethernet)/i

export function stripZone(address: string): string {
  return address.replace(/%.+$/, '')
}

export function normalizeRemote(address: string | undefined): string {
  if (!address) return ''
  const value = stripZone(address)
  return value.startsWith('::ffff:') && isIPv4(value.slice(7)) ? value.slice(7) : value
}

export function addressScope(address: string): AddressScope {
  const value = stripZone(address)
  if (isIPv4(value)) {
    const octets = value.split('.').map(Number)
    const a = octets[0]!
    const b = octets[1]!
    if (a === 0) return 'unspecified'
    if (a === 127) return 'loopback'
    if (a === 169 && b === 254) return 'link-local'
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private'
    if (a === 100 && b >= 64 && b <= 127) return 'carrier'
    return 'public'
  }
  if (isIPv6(value)) {
    const lower = value.toLowerCase()
    if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return 'loopback'
    if (/^fe[89ab]/.test(lower)) return 'link-local'
    if (/^f[cd]/.test(lower)) return 'unique-local'
    if (lower === '::' || lower === '0:0:0:0:0:0:0:0') return 'unspecified'
    return 'public'
  }
  return 'public'
}

export function isLanAddress(address: string): boolean {
  const scope = addressScope(address)
  return scope === 'private' || scope === 'unique-local'
}

export function classifyInterface(name: string, address: string, prefix?: number): InterfaceCandidate {
  const family: AddressFamily = isIPv4(stripZone(address)) ? 'IPv4' : 'IPv6'
  const scope = addressScope(address)
  const lan = scope === 'private' || scope === 'unique-local'
  if (!lan) return { name, address, family, scope, prefix, eligible: false, reason: scope }
  if (virtualName.test(name) || virtualWords.test(name)) {
    return { name, address, family, scope, prefix, eligible: false, reason: 'virtual-adapter' }
  }
  return { name, address, family, scope, prefix, eligible: true }
}

export interface InterfaceSnapshot {
  candidates: InterfaceCandidate[]
  eligible: InterfaceCandidate[]
}

/**
 * Enumerate addresses for LAN sync.
 *
 * `allow` may contain interface names or addresses the user explicitly chose;
 * those bypass the virtual-adapter exclusion but still must be private/ULA.
 * `includeLoopback` is only for isolated tests and never advertised by default.
 */
export function interfaceSnapshot(options: { allow?: readonly string[]; includeLoopback?: boolean } = {}): InterfaceSnapshot {
  const allow = new Set(options.allow ?? [])
  const candidates: InterfaceCandidate[] = []
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' && entry.family !== 'IPv6') continue
      const prefix = entry.cidr && entry.cidr.includes('/') ? Number(entry.cidr.split('/')[1]) : undefined
      const candidate = classifyInterface(name, entry.address, prefix)
      const chosen = allow.has(name) || allow.has(entry.address)
      if (candidate.eligible || (chosen && (candidate.scope === 'private' || candidate.scope === 'unique-local'))) {
        candidates.push(chosen ? { ...candidate, eligible: true, reason: undefined } : candidate)
      } else {
        candidates.push(candidate)
      }
    }
  }
  if (options.includeLoopback) {
    candidates.push({ name: 'loopback (test)', address: '127.0.0.1', family: 'IPv4', scope: 'loopback', prefix: 8, eligible: true })
  }
  const eligible = candidates.filter(({ eligible, name, address, scope }) =>
    eligible && (!allow.size || allow.has(name) || allow.has(address) || options.includeLoopback && scope === 'loopback'))
    .sort((a, b) => (a.family === b.family ? a.name.localeCompare(b.name) : a.family === 'IPv4' ? -1 : 1))
  return { candidates, eligible }
}

export function endpointFor(address: string, port: number): string {
  const host = isIPv6(stripZone(address)) ? `[${stripZone(address)}]` : stripZone(address)
  return `http://${host}:${port}`
}

/** Validate a manually entered LAN endpoint. Public addresses are refused. */
export function lanEndpoint(input: string): string {
  const url = new URL(input)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const scope = addressScope(host)
  const loopback = scope === 'loopback'
  if (url.protocol !== 'http:' || url.username || url.password || !url.port ||
      url.pathname !== '/' || url.search || url.hash || (scope !== 'private' && scope !== 'unique-local' && !loopback)) {
    throw new Error('Use a private IPv4/IPv6 address and port for a LAN device')
  }
  return url.origin
}

export function isLoopback(address: string): boolean {
  return addressScope(address) === 'loopback'
}

/** Whether an inbound socket is from a local/private network, never the public internet. */
export function isTrustedRemote(address: string | undefined): boolean {
  const value = normalizeRemote(address)
  const scope = addressScope(value)
  return scope === 'private' || scope === 'unique-local' || scope === 'loopback'
}

export function sameInterfaceSet(a: readonly InterfaceCandidate[], b: readonly InterfaceCandidate[]): boolean {
  const key = (items: readonly InterfaceCandidate[]) => items.map(({ address, family, name, prefix }) => JSON.stringify([family, address, name, prefix])).sort().join('|')
  return key(a) === key(b)
}

function ipv4ToInt(address: string): number {
  return address.split('.').reduce((value, octet) => (value * 256 + Number(octet)) >>> 0, 0) >>> 0
}

function ipv6ToBigInt(address: string): bigint {
  const [head, tail] = address.toLowerCase().split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const groups = address.includes('::')
    ? [...left, ...Array.from({ length: Math.max(0, 8 - left.length - right.length) }, () => '0'), ...right]
    : left
  return groups.reduce((value, group) => (value << 16n) + BigInt(parseInt(group || '0', 16)), 0n)
}

/** Whether a peer address is on the same subnet as one of our usable interfaces. */
export function sharesLocalSubnet(address: string, local: readonly InterfaceCandidate[]): boolean {
  const value = stripZone(address)
  const family: AddressFamily = isIPv4(value) ? 'IPv4' : 'IPv6'
  for (const candidate of local) {
    if (candidate.family !== family || candidate.prefix === undefined) continue
    if (family === 'IPv4' && candidate.prefix >= 0 && candidate.prefix <= 32) {
      const mask = candidate.prefix === 0 ? 0 : (0xffffffff << (32 - candidate.prefix)) >>> 0
      if ((ipv4ToInt(value) & mask) === (ipv4ToInt(stripZone(candidate.address)) & mask)) return true
    }
    if (family === 'IPv6' && candidate.prefix >= 0 && candidate.prefix <= 128) {
      const shift = 128n - BigInt(candidate.prefix)
      const mask = ((1n << 128n) - 1n) ^ ((1n << shift) - 1n)
      if ((ipv6ToBigInt(value) & mask) === (ipv6ToBigInt(stripZone(candidate.address)) & mask)) return true
    }
  }
  return false
}

/**
 * Pick the peer address that is routable from our selected LAN interfaces.
 * mDNS advertises every address of the peer (including virtual adapters), so
 * selecting the first private address can point at an unreachable subnet.
 */
export function pickPeerAddress(addresses: readonly string[], local: readonly InterfaceCandidate[]): string | undefined {
  const unique = [...new Set(addresses.map(stripZone))].filter((address) => isLanAddress(address))
  const ipv4 = unique.filter((address) => isIPv4(address))
  return ipv4.find((address) => sharesLocalSubnet(address, local)) ??
    unique.find((address) => sharesLocalSubnet(address, local)) ??
    ipv4[0] ?? unique[0]
}
