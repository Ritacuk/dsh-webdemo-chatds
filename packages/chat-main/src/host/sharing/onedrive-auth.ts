import { z } from 'zod'

const authority = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/'
const scope = 'https://graph.microsoft.com/Files.ReadWrite.AppFolder offline_access'
const opaque = z.string().min(16).max(16_384)
const result = z.object({
  access_token: opaque, refresh_token: opaque.optional(), token_type: z.literal('Bearer'),
  expires_in: z.number().int().positive().max(86400),
})
export const graphCredentials = z.strictObject({
  provider: z.literal('onedrive'),
  token: opaque,
  clientId: z.uuid().optional(),
  refreshToken: opaque.optional(),
  expiresAt: z.number().int().positive().optional(),
}).refine((value) => !value.refreshToken || !!value.clientId && !!value.expiresAt)
export type GraphCredentials = z.infer<typeof graphCredentials>

async function exchange(endpoint: 'token' | 'devicecode', data: Record<string, string>, signal: AbortSignal) {
  const response = await fetch(authority + endpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(data), redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
  })
  return { ok: response.ok, data: await response.json() as unknown }
}

export interface DeviceGrant {
  clientId: string
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresAt: number
  interval: number
  nextPoll: number
}

export async function beginDeviceGrant(clientId: string, signal: AbortSignal): Promise<DeviceGrant> {
  const response = await exchange('devicecode', { client_id: clientId, scope }, signal)
  if (!response.ok) throw new Error('OneDrive authorization could not start. Check the Microsoft public client registration.')
  const grant = z.object({
    device_code: opaque, user_code: z.string().min(4).max(24),
    verification_uri: z.string().url().max(200),
    expires_in: z.number().int().min(60).max(1800),
    interval: z.number().int().min(1).max(60),
  }).parse(response.data)
  const uri = new URL(grant.verification_uri)
  if (!['https://www.microsoft.com', 'https://microsoft.com', 'https://login.microsoftonline.com'].includes(uri.origin) ||
      uri.username || uri.password) throw new Error('Invalid OneDrive verification URL')
  const now = Date.now()
  return {
    clientId, deviceCode: grant.device_code, userCode: grant.user_code, verificationUri: uri.href,
    expiresAt: now + grant.expires_in * 1000, interval: grant.interval * 1000, nextPoll: now + grant.interval * 1000,
  }
}

function credentials(input: unknown, clientId: string, previous?: string): GraphCredentials {
  const data = result.parse(input)
  const refreshToken = data.refresh_token ?? previous
  if (!refreshToken) throw new Error('OneDrive did not grant offline access')
  return { provider: 'onedrive', clientId, token: data.access_token, refreshToken, expiresAt: Date.now() + data.expires_in * 1000 }
}

export async function finishDeviceGrant(grant: DeviceGrant, signal: AbortSignal): Promise<GraphCredentials | undefined> {
  const now = Date.now()
  if (now >= grant.expiresAt) throw new Error('OneDrive authorization expired')
  if (now < grant.nextPoll) return
  grant.nextPoll = now + grant.interval
  const response = await exchange('token', {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: grant.clientId, device_code: grant.deviceCode,
  }, signal)
  if (response.ok) return credentials(response.data, grant.clientId)
  const error = z.object({ error: z.string().max(128) }).parse(response.data).error
  if (error === 'authorization_pending') return
  if (error === 'slow_down') {
    grant.interval += 5000
    grant.nextPoll = Date.now() + grant.interval
    return
  }
  throw new Error('OneDrive authorization was declined or expired')
}

export async function refreshGrant(previous: GraphCredentials, signal: AbortSignal): Promise<GraphCredentials> {
  if (!previous.clientId || !previous.refreshToken) throw new Error('OneDrive authorization needs renewal')
  const response = await exchange('token', {
    grant_type: 'refresh_token', client_id: previous.clientId, refresh_token: previous.refreshToken, scope,
  }, signal)
  if (!response.ok) throw new Error('OneDrive authorization needs renewal')
  return credentials(response.data, previous.clientId, previous.refreshToken)
}
