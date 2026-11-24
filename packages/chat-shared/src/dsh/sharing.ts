export interface MessageProvenance {
  deviceId: string
  deviceName: string
  createdAt: string
  receivedAt: string
}

export interface SyncPolicy {
  syncSpaceId: string
  policyId: string
  policyVersion: number
  partitionIds: string[]
  conversationIds: string[]
  /** Required when selecting individual messages or branches. */
  conversationScopeId?: string
  messageIds: string[]
  branchIds: string[]
  excludedIds: string[]
  recipientDeviceIds: string[]
  all: boolean
  syncMode: 'once' | 'automatic'
  context: 'excerpt' | 'complete'
  attachmentPolicy: 'omit'
}

export type SyncSelection = Omit<SyncPolicy, 'syncSpaceId' | 'policyId' | 'policyVersion'>

export interface SharedExcerpt {
  eventId: string
  conversationId: string
  messageId: string
  role: 'user' | 'assistant'
  text: string
  source: MessageProvenance
}

export interface DiscoveredDevice {
  id: string
  name: string
  code: string
  address: string
  port: number
  endpoint: string
  paired: boolean
}

export interface SharingDiscoveryStatus {
  mechanism: 'mdns' | 'multicast' | 'mdns+multicast'
  published: boolean
  browsing: boolean
  error?: string
  devices: number
}

export interface SharingFirewallStatus {
  supported: boolean
  elevated?: boolean
  profile?: string
  rulePresent?: boolean
  interfaceAlias?: string
  hint?: string
  command?: string
  removeCommand?: string
  applied?: boolean
  error?: string
}

export interface SharingInterface {
  name: string
  address: string
  family: 'IPv4' | 'IPv6'
  scope: string
  eligible: boolean
  reason?: string
}

export interface SharingStatus {
  enabled: boolean
  device?: { id: string; name: string; invite: string; fingerprint: string; code?: string }
  peers?: {
    id: string; name: string; fingerprint: string; code?: string; reachable: boolean;
    discovered?: string; endpoint?: string; platform?: string; lastSyncAt?: string; needsVerification?: boolean;
  }[]
  lan?: boolean
  lanPort?: number
  lanAddresses?: string[]
  discovery?: SharingDiscoveryStatus
  devices?: DiscoveredDevice[]
  interfaces?: SharingInterface[]
  interfaceSelection?: string[]
  lanDetails?: {
    port?: number
    addresses: string[]
    loopbackOnly: boolean
    interfaces: SharingInterface[]
    candidates: SharingInterface[]
    discovery: SharingDiscoveryStatus
    error?: string
    platform: string
  }
  firewall?: SharingFirewallStatus
  pairingCode?: string
  prekeys?: { available: number; consumed: number }
  migrated?: boolean
  cloud?: { provider: 'webdav' | 'onedrive' | 'baidu' }
  lastSyncAt?: string
  running?: boolean
  pending?: number
  error?: string
  policies?: SyncPolicy[]
  excerpts?: SharedExcerpt[]
}
