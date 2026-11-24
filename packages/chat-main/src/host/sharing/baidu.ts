import { createHash, randomUUID } from 'node:crypto'
import { credentialKey, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { z } from 'zod'
import { InvalidCloudEvent, maximumBundleBytes, readLimited, retryAfterMs, type CloudTransport } from './cloud.js'
import { mailboxName, type Envelope, type PrekeyBundle } from './crypto.js'
import { maximumEnvelopeBytes } from './protocol.js'

const oauthOrigin = 'https://openapi.baidu.com'
const apiOrigin = 'https://pan.baidu.com'
const pcsOrigin = 'https://d.pcs.baidu.com'
const token = z.string().min(1).max(4096)
export const baiduApplication = z.object({
  appKey: z.string().regex(/^[A-Za-z0-9_-]{4,128}$/),
  appSecret: z.string().regex(/^[A-Za-z0-9_-]{4,256}$/),
  applicationName: z.string().trim().min(1).max(80).refine((name) =>
    name !== '.' && name !== '..' && !/[\\/:*?"<>|\u0000-\u001f]/u.test(name)),
})
const accountSchema = baiduApplication.extend({
  access: token, refresh: token, expiresAt: z.number(), auto: z.boolean(),
  account: z.string().max(120), accountId: z.string().regex(/^\d+$/), connectionId: z.uuid(),
})
type Account = z.infer<typeof accountSchema>
type Application = z.infer<typeof baiduApplication>
const oauthToken = z.object({
  access_token: token, refresh_token: token.optional(), expires_in: z.coerce.number().positive().max(365 * 86400),
})
const deviceCode = z.object({
  device_code: token, user_code: z.string().min(1).max(80), verification_url: z.string().url(),
  expires_in: z.coerce.number().positive().max(1800), interval: z.coerce.number().positive().max(120),
})
type Grant = { application: Application; code: string; expiresAt: number; interval: number; nextPoll: number }
type Json = Record<string, unknown>
const apiError = (code: number | string) => new BaiduError(code)

export class BaiduError extends Error {
  constructor(readonly code: number | string) {
    super(code === 'reauthorize' ? 'Baidu Netdisk needs to be authorized again.' : `Baidu Netdisk request failed (${code}).`)
  }
}

function baiduUrl(raw: string, hosts: RegExp): URL {
  const url = new URL(raw)
  if (url.protocol !== 'https:' || !hosts.test(url.hostname) || url.port || url.username || url.password) {
    throw apiError('unexpected address')
  }
  return url
}

function query(origin: string, path: string, values: Record<string, string>): URL {
  const url = new URL(path, origin)
  url.search = new URLSearchParams(values).toString()
  return url
}

function parseJson(text: string): Json {
  // Baidu's file and account identifiers are int64 and may exceed JavaScript's safe integer range.
  return z.record(z.string(), z.unknown()).parse(JSON.parse(text, (key, value, context?: { source?: string }) =>
    ['fs_id', 'uk'].includes(key) && typeof value === 'number' ? context?.source ?? String(value) : value))
}

class BaiduRequests {
  private retryAt = 0

  async fetch(url: URL, signal: AbortSignal, options: RequestInit = {}): Promise<Response> {
    if (Date.now() < this.retryAt) throw apiError('rate limited')
    const response = await fetch(url, {
      ...options, redirect: options.redirect ?? 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
    }).catch((error) => { signal.throwIfAborted(); throw apiError('network unavailable') })
    if (response.status === 429 || response.status === 503) {
      this.retryAt = Date.now() + retryAfterMs(response.headers.get('retry-after'))
    }
    return response
  }

  async json(url: URL, signal: AbortSignal, options?: RequestInit): Promise<Json> {
    const response = await this.fetch(url, signal, options)
    let body: Json
    try { body = parseJson(await readLimited(response, 2 * 1024 * 1024)) }
    catch { throw apiError(response.ok ? 'invalid response' : response.status) }
    const code = Number(body.errno ?? body.error_code ?? 0)
    if (code && Number.isSafeInteger(code)) {
      if (code === 31034) this.retryAt = Date.now() + 60_000
      throw apiError(code)
    }
    if (!response.ok && typeof body.error !== 'string') throw apiError(response.status)
    return body
  }
}

const oauthFailure = (value: unknown) => typeof value === 'string' && /^[a-z_]{3,64}$/.test(value) ? value : 'authorization failed'

function authorized(body: Json, refresh?: string) {
  if (body.error) throw apiError(oauthFailure(body.error) === 'invalid_grant' ? 'reauthorize' : oauthFailure(body.error))
  const result = oauthToken.parse(body)
  return {
    access: result.access_token, refresh: token.parse(result.refresh_token ?? refresh),
    expiresAt: Date.now() + result.expires_in * 1000,
  }
}

export class BaiduAccount {
  private readonly key
  private readonly requests = new BaiduRequests()
  private grant?: Grant

  constructor(private readonly credentials: CredentialProvider, profile: string) {
    this.key = credentialKey('chatds-sharing', 'baidu-' + createHash('sha256').update(profile).digest('hex').slice(0, 32))
  }

  async read(): Promise<Account | undefined> {
    const record = await this.credentials.readRecord(this.key)
    return record?.kind === 'grant' ? accountSchema.parse(record.payload) : undefined
  }

  async begin(application: Application, signal: AbortSignal) {
    this.grant = undefined
    const body = await this.requests.json(query(oauthOrigin, '/oauth/2.0/device/code', {
      client_id: application.appKey, response_type: 'device_code', scope: 'basic,netdisk',
    }), signal)
    if (body.error) throw apiError(oauthFailure(body.error))
    const result = deviceCode.parse(body)
    const verificationUri = baiduUrl(result.verification_url, /^(?:[a-z0-9-]+\.)*baidu\.com$/i).href
    const expiresAt = Date.now() + result.expires_in * 1000
    this.grant = { application, code: result.device_code, expiresAt, interval: result.interval * 1000,
      nextPoll: Date.now() + result.interval * 1000 }
    return { phase: 'pending', verificationUri, userCode: result.user_code, expiresAt }
  }

  cancel() { this.grant = undefined }

  async poll(signal: AbortSignal): Promise<Account | undefined> {
    const grant = this.grant
    if (!grant || grant.expiresAt <= Date.now()) {
      this.cancel()
      throw apiError('device code expired')
    }
    if (Date.now() < grant.nextPoll) return
    grant.nextPoll = Date.now() + grant.interval
    const { application } = grant
    const body = await this.requests.json(query(oauthOrigin, '/oauth/2.0/token', {
      grant_type: 'device_token', code: grant.code, client_id: application.appKey, client_secret: application.appSecret,
    }), signal)
    if (body.error === 'authorization_pending') return
    if (body.error === 'slow_down') {
      grant.interval += 5000
      grant.nextPoll = Date.now() + grant.interval
      return
    }
    this.cancel()
    const tokens = authorized(body)
    const info = await this.requests.json(query(apiOrigin, '/rest/2.0/xpan/nas', {
      method: 'uinfo', access_token: tokens.access,
    }), signal)
    const accountId = z.string().regex(/^\d+$/).parse(info.uk)
    const account = String(info.netdisk_name || info.baidu_name || '').slice(0, 120)
    const current = await this.read()
    const sameAccount = current?.accountId === accountId && current.appKey === application.appKey &&
      current.applicationName === application.applicationName
    const next: Account = {
      ...application, ...tokens, accountId, account, auto: sameAccount ? current.auto : false,
      connectionId: sameAccount ? current.connectionId : randomUUID(),
    }
    await new BaiduTransport(next, async () => tokens.access).prepare(signal)
    await this.credentials.modifyRecord(this.key, async () => ({ kind: 'grant', payload: next }))
    return next
  }

  async setAuto(auto: boolean) {
    await this.credentials.modifyRecord(this.key, async (record) => {
      if (record?.kind !== 'grant') throw apiError('connect the account first')
      return { kind: 'grant', payload: { ...accountSchema.parse(record.payload), auto } }
    })
  }

  async disconnect() {
    this.cancel()
    await this.credentials.deleteRecord(this.key)
  }

  async access(connectionId: string, signal: AbortSignal, rejected?: string): Promise<string> {
    const current = await this.read()
    if (!current || current.connectionId !== connectionId) throw apiError('reauthorize')
    const usable = (account: Account) => account.expiresAt - 60_000 > Date.now() && account.access !== rejected
    if (usable(current)) return current.access
    const next = await this.credentials.modifyRecord(this.key, async (record) => {
      if (record?.kind !== 'grant') throw apiError('reauthorize')
      const account = accountSchema.parse(record.payload)
      if (account.connectionId !== connectionId) throw apiError('reauthorize')
      if (usable(account)) return undefined
      const body = await this.requests.json(query(oauthOrigin, '/oauth/2.0/token', {
        grant_type: 'refresh_token', refresh_token: account.refresh, client_id: account.appKey, client_secret: account.appSecret,
      }), signal)
      return { kind: 'grant', payload: { ...account, ...authorized(body, account.refresh) } }
    })
    if (next?.kind !== 'grant') throw apiError('reauthorize')
    return accountSchema.parse(next.payload).access
  }
}

const remoteFile = z.object({ path: z.string(), fs_id: z.string().regex(/^\d+$/), isdir: z.number(),
  size: z.number().int().nonnegative(), md5: z.string().regex(/^[a-f0-9]{32}$/i).optional() })
const md5 = (text: string | Buffer) => createHash('md5').update(text).digest('hex')

export class BaiduTransport implements CloudTransport {
  private readonly requests = new BaiduRequests()
  private readonly folders = new Set<string>()
  private readonly appDirectory: string
  readonly directory: string
  pendingDownloads?: number

  constructor(account: Pick<Account, 'applicationName'>,
    private readonly access: (signal: AbortSignal, rejected?: string) => Promise<string>) {
    this.appDirectory = '/apps/' + baiduApplication.shape.applicationName.parse(account.applicationName)
    this.directory = this.appDirectory + '/ChatDS-sync-v2'
  }

  private async api(method: string, values: Record<string, string>, signal: AbortSignal,
    body?: URLSearchParams | FormData, pcs = false) {
    const request = (access_token: string) => this.requests.json(query(pcs ? pcsOrigin : apiOrigin,
      pcs ? '/rest/2.0/pcs/superfile2' : '/rest/2.0/xpan/' + (method === 'filemetas' ? 'multimedia' : 'file'),
      { ...values, method, access_token }), signal, body ? { method: 'POST', body } : undefined)
    const access = await this.access(signal)
    try { return await request(access) }
    catch (error) {
      if (!(error instanceof BaiduError) || ![-6, 20016, 20017, 31045, 401].includes(Number(error.code))) throw error
      return request(await this.access(signal, access))
    }
  }

  private async list(path: string, start: number, limit: number, signal: AbortSignal) {
    const response = await this.api('list', { dir: path, start: String(start), limit: String(limit), order: 'name', desc: '0' }, signal)
    const list = z.array(z.unknown()).parse(response.list)
    return { scanned: list.length, files: list.flatMap((item) => {
      const file = remoteFile.safeParse(item)
      return file.success ? [file.data] : []
    }) }
  }

  async prepare(signal: AbortSignal) {
    // The product name is assigned by Baidu. Verify that the resulting application folder is accessible.
    await this.list(this.appDirectory, 0, 1, signal)
    await this.ensureFolder(this.directory, signal)
  }

  private async ensureFolder(path: string, signal: AbortSignal) {
    if (this.folders.has(path)) return
    try {
      await this.api('create', {}, signal, new URLSearchParams({ path, isdir: '1', size: '0', rtype: '0' }))
    } catch (error) {
      if (!(error instanceof BaiduError) || error.code !== -8) throw error
      await this.list(path, 0, 1, signal)
    }
    this.folders.add(path)
  }

  private async mailbox(id: string, signal: AbortSignal) {
    await this.ensureFolder(this.directory, signal)
    const path = this.directory + '/' + id
    await this.ensureFolder(path, signal)
    return path
  }

  private async upload(path: string, text: string, signal: AbortSignal, replace = false): Promise<boolean> {
    // Envelopes are bounded below one Baidu 4 MiB slice. precreate reports slices the server has already retained.
    const bytes = Buffer.from(text)
    const hash = md5(bytes)
    const fields = { path, size: String(bytes.length), isdir: '0', block_list: JSON.stringify([hash]), rtype: replace ? '2' : '0' }
    try {
      const pre = await this.api('precreate', {}, signal, new URLSearchParams({ ...fields, autoinit: '1' }))
      if (pre.return_type === 2) {
        if (replace && pre.path === path) return true
        return false
      }
      const uploadid = z.string().min(1).max(512).parse(pre.uploadid)
      const parts = z.array(z.literal(0)).max(1).parse(pre.block_list)
      if (parts.length) {
        const form = new FormData()
        form.set('file', new Blob([new Uint8Array(bytes)]), 'slice')
        const part = await this.api('upload', { type: 'tmpfile', path, uploadid, partseq: '0' }, signal, form, true)
        if (part.md5 !== hash) throw apiError('slice checksum mismatch')
      }
      const file = await this.api('create', {}, signal, new URLSearchParams({ ...fields, uploadid }))
      if (file.path !== path || file.md5 !== hash || file.size !== bytes.length) throw apiError('upload checksum or path mismatch')
      return true
    } catch (error) {
      if (error instanceof BaiduError && error.code === -8 && !replace) return false
      throw error
    }
  }

  private async *files(path: string, signal: AbortSignal) {
    const size = 500
    for (let start = 0; start < 50_000; start += size) {
      const page = await this.list(path, start, size, signal)
      for (const file of page.files) if (file.isdir === 0 && file.path.slice(0, file.path.lastIndexOf('/')) === path) yield file
      if (page.scanned < size) return
    }
    throw apiError('mailbox exceeds list limit')
  }

  private async get(file: z.infer<typeof remoteFile>, limit: number, signal: AbortSignal): Promise<unknown> {
    if (file.size > limit) throw new InvalidCloudEvent()
    const value = await this.api('filemetas', { fsids: '[' + file.fs_id + ']', dlink: '1' }, signal)
    const meta = z.array(remoteFile.extend({ dlink: z.string() })).length(1).parse(value.list)[0]!
    if (meta.fs_id !== file.fs_id || meta.path !== file.path || meta.size > limit || !meta.md5) throw new InvalidCloudEvent()
    const validate = (url: string) => baiduUrl(url, /^(?:pan\.baidu\.com|(?:[a-z0-9-]+\.)*pcs\.baidu\.com|(?:[a-z0-9-]+\.)*baidupcs\.com)$/i)
    let url = validate(meta.dlink)
    url.searchParams.set('access_token', await this.access(signal))
    for (let hop = 0; hop < 4; hop++) {
      const response = await this.requests.fetch(url, signal, { redirect: 'manual', headers: { 'user-agent': 'ChatDS (pan.baidu.com)' } })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        await response.body?.cancel()
        if (!location) throw apiError('invalid download redirect')
        url = validate(new URL(location, url).href)
        continue
      }
      if (!response.ok) { await response.body?.cancel(); throw apiError(response.status) }
      const body = await readLimited(response, limit)
      if (Buffer.byteLength(body) !== meta.size || md5(body) !== meta.md5.toLowerCase()) throw new InvalidCloudEvent()
      return JSON.parse(body)
    }
    throw apiError('download redirect limit')
  }

  async put(envelope: Envelope, signal: AbortSignal, verify: (value: unknown) => 'match' | 'conflict' | 'invalid') {
    const folder = await this.mailbox(envelope.to, signal)
    const path = folder + '/' + mailboxName(envelope)
    if (await this.upload(path, JSON.stringify(envelope), signal)) return
    for await (const file of this.files(folder, signal)) {
      if (file.path === path && verify(await this.get(file, maximumEnvelopeBytes, signal)) === 'match') return
    }
    throw apiError('immutable event conflict')
  }

  async pull(id: string, known: ReadonlySet<string>, receive: (value: unknown, filename: string) => Promise<void>, signal: AbortSignal) {
    const folder = await this.mailbox(id, signal)
    const pending = new Map<string, z.infer<typeof remoteFile>>()
    for await (const file of this.files(folder, signal)) {
      const event = /^([a-f0-9]{64})\.json$/.exec(file.path.slice(folder.length + 1))?.[1]
      if (event && !known.has(event)) pending.set(event, file)
    }
    this.pendingDownloads = pending.size
    for (const [event, file] of pending) {
      try { await receive(await this.get(file, maximumEnvelopeBytes, signal), event) }
      catch (error) { if (!(error instanceof InvalidCloudEvent || error instanceof SyntaxError)) throw error }
      this.pendingDownloads--
    }
  }

  async publishBundle(bundle: PrekeyBundle, signal: AbortSignal) {
    const folder = await this.mailbox(bundle.deviceId, signal)
    if (!await this.upload(folder + '/bundle.json', JSON.stringify(bundle), signal, true)) throw apiError('bundle upload incomplete')
  }

  async fetchBundle(id: string, signal: AbortSignal) {
    const folder = await this.mailbox(id, signal)
    for await (const file of this.files(folder, signal)) {
      if (file.path === folder + '/bundle.json') return this.get(file, maximumBundleBytes, signal)
    }
    return undefined
  }

  async claimPrekey(id: string, prekeyId: string, signal: AbortSignal) {
    const folder = await this.mailbox(id, signal)
    return this.upload(folder + '/claim-' + prekeyId + '.json', JSON.stringify({ v: 2, nonce: randomUUID() }), signal)
  }
}
