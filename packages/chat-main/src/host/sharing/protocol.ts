import { createHash } from 'node:crypto'
import { z } from 'zod'

/**
 * Wire constants for the v2 sharing protocol.
 *
 * v2 separates the long-term device identity into an Ed25519 signing key used
 * only to authenticate devices/handshakes and an X25519 key-agreement key used
 * only to agree on short-lived or one-time secrets. Neither long-term key is
 * ever the key of a stored chat ciphertext.
 */
export const sharingProtocolVersion = 2
export const maximumEnvelopeBytes = 768 * 1024
export const deviceIdSchema = z.uuid()
export const safeId = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/)
export const conversationIdSchema = z.string().regex(/^chatws-(?!side-)[a-zA-Z0-9-]{1,100}$/)
export const eventIdSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const publicKeySchema = z.string().regex(/^[A-Za-z0-9_-]{59}$/)
export const signatureSchema = z.string().regex(/^[A-Za-z0-9_-]{86}$/)
export const prekeyIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/)
export const deviceName = z.string().trim().min(1).max(64).refine((text) => !/[\p{Cc}\p{Cf}]/u.test(text) && shareableText(text))
export const deviceCard = z.strictObject({
  version: z.literal(sharingProtocolVersion),
  id: deviceIdSchema,
  name: deviceName,
  /** X25519 public key (SPKI/DER, base64url). Key agreement only. */
  key: publicKeySchema,
  /** Ed25519 public key (SPKI/DER, base64url). Identity authentication only. */
  signKey: publicKeySchema,
})
export type DeviceCard = z.infer<typeof deviceCard>

const ids = z.array(safeId).max(1000).transform((items) => [...new Set(items)].sort())
export const selectionSchema = z.strictObject({
  all: z.boolean(),
  partitionIds: z.array(z.uuid()).max(200).transform((items) => [...new Set(items)].sort()),
  conversationIds: z.array(conversationIdSchema).max(1000).transform((items) => [...new Set(items)].sort()),
  conversationScopeId: conversationIdSchema.optional(),
  messageIds: ids,
  branchIds: ids,
  excludedIds: ids,
  recipientDeviceIds: z.array(deviceIdSchema).min(1).max(20).transform((items) => [...new Set(items)].sort()),
  syncMode: z.enum(['once', 'automatic']),
  context: z.enum(['complete', 'excerpt']),
  attachmentPolicy: z.literal('omit'),
})
export const policySchema = selectionSchema.extend({
  policyId: z.uuid(),
  syncSpaceId: z.uuid(),
  policyVersion: z.number().int().positive(),
})

export const exclusionsSchema = ids
const date = z.iso.datetime().refine((value) => Date.parse(value) >= 0)
export const snapshotSchema = z.strictObject({
  eventId: eventIdSchema,
  senderId: deviceIdSchema,
  conversationId: conversationIdSchema,
  messageId: safeId,
  parentId: safeId.nullable(),
  role: z.enum(['user', 'assistant']),
  text: z.string().min(1).max(64_000),
  createdAt: date,
  conversationCreatedAt: date.nullable(),
  context: z.enum(['complete', 'excerpt']),
}).refine((event) => event.parentId !== event.messageId &&
  (event.context === 'excerpt'
    ? event.parentId === null && event.conversationCreatedAt === null
    : event.conversationCreatedAt !== null))
export type SyncSnapshot = z.infer<typeof snapshotSchema>

export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function snapshotId(event: Omit<SyncSnapshot, 'eventId'>): string {
  return digest([sharingProtocolVersion, event.senderId, event.conversationId, event.messageId, event.context, event.parentId])
}

/** Do not send known credential and local path shapes even when they occur in visible text. */
export function shareableText(text: string): boolean {
  return text.trim().length > 0 && text.length <= 64_000 &&
    !/(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[\w-]{12,}|gh[pousr]_[\w-]{12,}|github_pat_[\w-]{12,}|AKIA[A-Z0-9]{16}|eyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]+)\b|\b(?:bearer|basic)\s+[\w+/=-]{12,}|\b(?:api[_ -]?key|authorization|cookie|password|client[_ -]?secret|access[_ -]?token|refresh[_ -]?token)\s*[:=]\s*["']?[^\s"',;`]{4,}|(?:^|[\s"'`(])(?:file:\/\/|[a-z]:[\\/]|\\\\[^\\\s]+\\|\/(?:home|users|mnt|volumes|workspace|workspaces|root|tmp|private|var|srv|opt)\/))/iu.test(text)
}

export function validateSnapshot(value: unknown): SyncSnapshot {
  const event = snapshotSchema.parse(value)
  if (snapshotId(event) !== event.eventId || !shareableText(event.text) || [event.createdAt, event.conversationCreatedAt].some((date) => date !== null && Date.parse(date) > Date.now() + 86_400_000)) throw new Error('Invalid sharing event')
  return event
}
