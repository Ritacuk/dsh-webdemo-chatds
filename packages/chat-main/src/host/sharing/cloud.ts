import { z } from 'zod'
import { maximumEnvelopeBytes } from './protocol.js'
import { graphCredentials, refreshGrant, type GraphCredentials } from './onedrive-auth.js'
import { mailboxName, type Envelope, type PrekeyBundle } from './crypto.js'

export const cloudConfigSchema = z.discriminatedUnion('provider', [
  z.strictObject({ provider: z.literal('webdav'), url: z.string().url().max(2000),
    username: z.string().min(1).max(256), password: z.string().min(1).max(1024) }),
  graphCredentials,
])
export type CloudConfig = z.infer<typeof cloudConfigSchema>

export const maximumBundleBytes = 32 * 1024

export function validateCloudConfig(config: CloudConfig): CloudConfig {
  if (config.provider === 'onedrive') {
    if (!/^[A-Za-z0-9._~+/=-]+$/.test(config.token)) throw new Error('Invalid Microsoft Graph access token')
    return config
  }
  if (config.username.includes(':')) throw new Error('Invalid WebDAV username')
  const url = new URL(config.url)
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error('Use an authenticated HTTPS WebDAV collection URL')
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return { ...config, url: url.href }
}

function check(response: Response, allowed: readonly number[], operation: string) {
  if (!allowed.includes(response.status)) {
    void response.body?.cancel().catch(() => {})
    throw new Error(`${operation} returned HTTP ${response.status}`)
  }
}

export function retryAfterMs(value: string | null, now = Date.now()): number {
  if (!value) return 60_000
  const target = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now
  return Number.isFinite(target) ? Math.max(1000, Math.min(target, Number.MAX_SAFE_INTEGER - now)) : 60_000
}

class CloudRequests {
  private retryAt = 0

  async send(url: string | URL, signal: AbortSignal, init: RequestInit) {
    if (Date.now() < this.retryAt) throw new Error('Cloud is waiting for Retry-After')
    const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) })
    if (response.status === 429 || response.status === 503) {
      this.retryAt = Date.now() + retryAfterMs(response.headers.get('retry-after'))
    }
    return response
  }
}

export async function readLimited(response: Response, limit: number): Promise<string> {
  const chunks: Uint8Array[] = []
  const reader = response.body?.getReader()
  if (!reader) return ''
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return Buffer.concat(chunks).toString('utf8')
      size += value.byteLength
      if (size > limit) throw new Error('Response exceeds sharing limit')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export interface CloudTransport {
  put(envelope: Envelope, signal: AbortSignal, verify: (value: unknown) => 'match' | 'conflict' | 'invalid'): Promise<void>
  pull(deviceId: string, known: ReadonlySet<string>, receive: (value: unknown, filename: string) => Promise<void>, signal: AbortSignal): Promise<void>
  publishBundle(bundle: PrekeyBundle, signal: AbortSignal): Promise<void>
  fetchBundle(deviceId: string, signal: AbortSignal): Promise<unknown | undefined>
  claimPrekey(deviceId: string, prekeyId: string, signal: AbortSignal): Promise<boolean>
}

class WebDav implements CloudTransport {
  private readonly authorization: string
  private readonly requests = new CloudRequests()
  private readonly created = new Set<string>()

  constructor(private readonly config: Extract<CloudConfig, { provider: 'webdav' }>) {
    this.authorization = 'Basic ' + Buffer.from(config.username + ':' + config.password).toString('base64')
  }

  private async collection(id: string, signal: AbortSignal) {
    const url = new URL(`chatds-v2-${id}/`, this.config.url)
    if (!this.created.has(id)) {
      const response = await this.requests.send(url, signal, { method: 'MKCOL', headers: { authorization: this.authorization } })
      check(response, [201, 405], 'WebDAV MKCOL')
      await response.body?.cancel()
      this.created.add(id)
    }
    return url
  }

  async put(envelope: Envelope, signal: AbortSignal, verify: (value: unknown) => 'match' | 'conflict' | 'invalid') {
    const url = new URL(mailboxName(envelope), await this.collection(envelope.to, signal))
    const headers = { authorization: this.authorization, 'content-type': 'application/json' }
    const body = JSON.stringify(envelope)
    const response = await this.requests.send(url, signal, {
      method: 'PUT', headers: { ...headers, 'if-none-match': '*' }, body,
    })
    check(response, [201, 204, 412], 'WebDAV PUT')
    await response.body?.cancel()
    if (response.status !== 412) return

    const existing = await this.requests.send(url, signal, { headers: { authorization: this.authorization } })
    check(existing, [200], 'WebDAV conflict verification')
    const etag = existing.headers.get('etag')
    const text = await readLimited(existing, maximumEnvelopeBytes)
    let result: ReturnType<typeof verify>
    try { result = verify(JSON.parse(text)) } catch { result = 'invalid' }
    if (result === 'match') return
    if (result === 'conflict' || !etag || !/^"[^"\r\n]+"$/.test(etag)) {
      throw new Error('WebDAV immutable event conflict')
    }
    const repaired = await this.requests.send(url, signal, {
      method: 'PUT', headers: { ...headers, 'if-match': etag }, body,
    })
    check(repaired, [200, 201, 204], 'WebDAV conditional repair')
    await repaired.body?.cancel()
  }

  async pull(id: string, known: ReadonlySet<string>, receive: (value: unknown, filename: string) => Promise<void>, signal: AbortSignal) {
    const folder = await this.collection(id, signal)
    const response = await this.requests.send(folder, signal, {
      method: 'PROPFIND',
      headers: { authorization: this.authorization, depth: '1', 'content-type': 'application/xml' },
      body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>',
    })
    check(response, [207], 'WebDAV PROPFIND')
    const xml = await readLimited(response, 8 * 1024 * 1024)
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Invalid WebDAV response')
    const seen = new Set<string>()
    for (const match of xml.matchAll(/<(?:[\w-]+:)?href\b[^>]*>[^<>]*\/([a-f0-9]{64})\.json\s*<\//giu)) {
      const file = match[1]!
      if (known.has(file) || seen.has(file)) continue
      seen.add(file)
      const item = await this.requests.send(new URL(file + '.json', folder), signal, { headers: { authorization: this.authorization } })
      if (item.status === 404) { await item.body?.cancel(); continue }
      check(item, [200], 'WebDAV GET')
      const body = await readLimited(item, maximumEnvelopeBytes)
      try { await receive(JSON.parse(body), file) } catch (error) {
        if (!(error instanceof InvalidCloudEvent || error instanceof SyntaxError)) throw error
      }
    }
  }

  async publishBundle(bundle: PrekeyBundle, signal: AbortSignal) {
    const url = new URL('bundle.json', await this.collection(bundle.deviceId, signal))
    const response = await this.requests.send(url, signal, {
      method: 'PUT', headers: { authorization: this.authorization, 'content-type': 'application/json' }, body: JSON.stringify(bundle),
    })
    check(response, [200, 201, 204], 'WebDAV bundle upload')
    await response.body?.cancel()
  }

  async fetchBundle(deviceId: string, signal: AbortSignal) {
    const url = new URL('bundle.json', await this.collection(deviceId, signal))
    const response = await this.requests.send(url, signal, { headers: { authorization: this.authorization } })
    if (response.status === 404) { await response.body?.cancel(); return undefined }
    check(response, [200], 'WebDAV bundle download')
    return JSON.parse(await readLimited(response, maximumBundleBytes))
  }

  async claimPrekey(deviceId: string, prekeyId: string, signal: AbortSignal) {
    const url = new URL(`claim-${prekeyId}.json`, await this.collection(deviceId, signal))
    const response = await this.requests.send(url, signal, {
      method: 'PUT',
      headers: { authorization: this.authorization, 'content-type': 'application/json', 'if-none-match': '*' },
      body: JSON.stringify({ v: 2, prekeyId, at: new Date().toISOString() }),
    })
    if (response.status === 412) { await response.body?.cancel(); return false }
    check(response, [200, 201, 204], 'WebDAV prekey claim')
    await response.body?.cancel()
    return true
  }
}

/** OneDrive app folder. Only the fixed Graph host receives the user's delegated token. */
class OneDrive implements CloudTransport {
  private readonly graph = 'https://graph.microsoft.com/v1.0/me/drive'
  private readonly requests = new CloudRequests()
  private readonly directories = new Map<string, string>()

  constructor(private config: GraphCredentials, private readonly saveRefresh: (previous: GraphCredentials, next: GraphCredentials) => Promise<void>) {}

  private async headers(signal: AbortSignal) {
    const previous = this.config
    if (previous.refreshToken && previous.expiresAt! < Date.now() + 60_000) {
      const next = await refreshGrant(previous, signal)
      signal.throwIfAborted()
      await this.saveRefresh(previous, next)
      this.config = next
    }
    return { authorization: 'Bearer ' + this.config.token }
  }

  private async collection(id: string, signal: AbortSignal): Promise<string> {
    const previous = this.directories.get(id)
    if (previous) return previous
    const rootRequest = await this.requests.send(this.graph + '/special/approot', signal, { headers: await this.headers(signal) })
    check(rootRequest, [200], 'OneDrive app folder')
    const root = z.object({ id: z.string().max(512) }).parse(await rootRequest.json()).id
    const folderName = 'chatds-v2-' + id
    const link = `${this.graph}/items/${encodeURIComponent(root)}`
    let folderRequest = await this.requests.send(`${link}:/${folderName}`, signal, { headers: await this.headers(signal) })
    if (folderRequest.status === 404) {
      await folderRequest.body?.cancel()
      folderRequest = await this.requests.send(link + '/children', signal, {
        method: 'POST', headers: { ...await this.headers(signal), 'content-type': 'application/json' },
        body: JSON.stringify({ name: folderName, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
      })
      if (folderRequest.status === 409) {
        await folderRequest.body?.cancel()
        folderRequest = await this.requests.send(`${link}:/${folderName}`, signal, { headers: await this.headers(signal) })
      }
    }
    check(folderRequest, [200, 201], 'OneDrive device folder')
    const folder = z.object({ id: z.string().max(512), folder: z.object({}) }).parse(await folderRequest.json()).id
    const path = `${this.graph}/items/${encodeURIComponent(folder)}`
    this.directories.set(id, path)
    return path
  }

  private async download(url: string, signal: AbortSignal, limit: number): Promise<string> {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
        !/(^|\.)(?:1drv\.com|sharepoint\.com|onedrive\.com|storage\.live\.com|windows\.net)$/i.test(parsed.hostname)) {
      throw new Error('Invalid OneDrive download link')
    }
    const fetched = await this.requests.send(parsed, signal, {})
    check(fetched, [200], 'OneDrive download')
    return readLimited(fetched, limit)
  }

  private async head(path: string, signal: AbortSignal) {
    const response = await this.requests.send(path, signal, { headers: await this.headers(signal) })
    return response
  }

  async put(envelope: Envelope, signal: AbortSignal, verify: (value: unknown) => 'match' | 'conflict' | 'invalid') {
    const folder = await this.collection(envelope.to, signal)
    const path = `${folder}:/${mailboxName(envelope)}`
    const headers = { ...await this.headers(signal), 'content-type': 'application/json' }
    const body = JSON.stringify(envelope)
    const response = await this.requests.send(`${path}:/content`, signal, { method: 'PUT', headers: { ...headers, 'if-none-match': '*' }, body })
    if (response.status === 200 || response.status === 201) { await response.body?.cancel(); return }
    if (response.status !== 409 && response.status !== 412) check(response, [200, 201], 'OneDrive PUT')
    await response.body?.cancel()

    const existing = await this.head(path, signal)
    if (existing.status !== 200) { await existing.body?.cancel(); throw new Error('OneDrive conflict verification failed') }
    const meta = z.object({ id: z.string().max(512), eTag: z.string().optional(),
      '@microsoft.graph.downloadUrl': z.string().url().optional() }).parse(await existing.json())
    if (!meta['@microsoft.graph.downloadUrl']) throw new Error('OneDrive conflict verification failed')
    let result: ReturnType<typeof verify>
    try { result = verify(JSON.parse(await this.download(meta['@microsoft.graph.downloadUrl'], signal, maximumEnvelopeBytes))) } catch { result = 'invalid' }
    if (result === 'match') return
    if (result === 'conflict') throw new Error('OneDrive immutable event conflict')
    if (!meta.eTag) throw new Error('OneDrive immutable event conflict')
    const repaired = await this.requests.send(`${path}:/content`, signal, {
      method: 'PUT', headers: { ...headers, 'if-match': meta.eTag }, body,
    })
    check(repaired, [200, 201], 'OneDrive conditional repair')
    await repaired.body?.cancel()
  }

  async pull(id: string, known: ReadonlySet<string>, receive: (value: unknown, filename: string) => Promise<void>, signal: AbortSignal) {
    const folder = await this.collection(id, signal)
    let url: string | undefined = folder + '/children?$select=id,name,eTag,@microsoft.graph.downloadUrl'
    const entry = z.object({ name: z.string().max(255), '@microsoft.graph.downloadUrl': z.string().url().optional() })
    const page = z.object({ value: z.array(entry).max(1000), '@odata.nextLink': z.string().url().optional() })
    const pages = new Set<string>()
    while (url && !pages.has(url) && pages.size < 100) {
      if (new URL(url).origin !== 'https://graph.microsoft.com') throw new Error('Invalid OneDrive page link')
      pages.add(url)
      const response = await this.requests.send(url, signal, { headers: await this.headers(signal) })
      check(response, [200], 'OneDrive list')
      const result = page.parse(JSON.parse(await readLimited(response, 2 * 1024 * 1024)))
      for (const item of result.value) {
        if (!/^[a-f0-9]{64}\.json$/.test(item.name) || known.has(item.name.slice(0, -5)) || !item['@microsoft.graph.downloadUrl']) continue
        try { await receive(JSON.parse(await this.download(item['@microsoft.graph.downloadUrl'], signal, maximumEnvelopeBytes)), item.name.slice(0, -5)) } catch (error) {
          if (!(error instanceof InvalidCloudEvent || error instanceof SyntaxError)) throw error
        }
      }
      url = result['@odata.nextLink']
    }
  }

  async publishBundle(bundle: PrekeyBundle, signal: AbortSignal) {
    const folder = await this.collection(bundle.deviceId, signal)
    const response = await this.requests.send(`${folder}:/bundle.json:/content`, signal, {
      method: 'PUT', headers: { ...await this.headers(signal), 'content-type': 'application/json' }, body: JSON.stringify(bundle),
    })
    check(response, [200, 201], 'OneDrive bundle upload')
    await response.body?.cancel()
  }

  async fetchBundle(deviceId: string, signal: AbortSignal) {
    const folder = await this.collection(deviceId, signal)
    const response = await this.head(`${folder}:/bundle.json`, signal)
    if (response.status === 404) { await response.body?.cancel(); return undefined }
    check(response, [200], 'OneDrive bundle metadata')
    const meta = z.object({ '@microsoft.graph.downloadUrl': z.string().url().optional() }).parse(await response.json())
    if (!meta['@microsoft.graph.downloadUrl']) throw new Error('OneDrive bundle download link is missing')
    return JSON.parse(await this.download(meta['@microsoft.graph.downloadUrl'], signal, maximumBundleBytes))
  }

  async claimPrekey(deviceId: string, prekeyId: string, signal: AbortSignal) {
    const folder = await this.collection(deviceId, signal)
    const response = await this.requests.send(`${folder}:/claim-${prekeyId}.json:/content`, signal, {
      method: 'PUT',
      headers: { ...await this.headers(signal), 'content-type': 'application/json', 'if-none-match': '*' },
      body: JSON.stringify({ v: 2, prekeyId, at: new Date().toISOString() }),
    })
    if (response.status === 409 || response.status === 412) { await response.body?.cancel(); return false }
    check(response, [200, 201], 'OneDrive prekey claim')
    await response.body?.cancel()
    return true
  }
}

export class InvalidCloudEvent extends Error {}

export function cloudTransport(
  config: CloudConfig,
  saveRefresh: (previous: GraphCredentials, next: GraphCredentials) => Promise<void>,
): CloudTransport {
  return config.provider === 'webdav' ? new WebDav(config) : new OneDrive(config, saveRefresh)
}
