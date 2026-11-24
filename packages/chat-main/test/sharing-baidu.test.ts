import { createHash } from 'node:crypto'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { afterEach, expect, it, vi } from 'vitest'
import { BaiduAccount, BaiduTransport } from '../src/host/sharing/baidu.js'
import { createIdentity, createPrekey, openEnvelope, seal, verifyStoredEnvelope } from '../src/host/sharing/crypto.js'
import { snapshotId, type SyncSnapshot } from '../src/host/sharing/protocol.js'

const signal = new AbortController().signal
const app = { applicationName: '测试应用', appKey: 'test-app', appSecret: 'test-secret' }
const md5 = (text: string) => createHash('md5').update(text).digest('hex')
const json = (value: unknown, status = 200) => Response.json(value, { status })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function filesystem() {
  const objects = new Map<string, string>()
  const slices = new Map<string, string>()
  const fsId = '12345678901234567890'
  let requests = 0
  const fake = vi.fn(async (input: URL, init?: RequestInit): Promise<Response> => {
    requests++
    const url = new URL(input)
    const method = url.searchParams.get('method')
    const path = (init?.body instanceof URLSearchParams ? init.body.get('path') : url.searchParams.get('path')) ?? ''
    if (method === 'precreate') return json({ errno: 0, return_type: 1, uploadid: path, block_list: [0] })
    if (method === 'upload') {
      const file = (init?.body as FormData).get('file') as Blob
      const text = await file.text()
      slices.set(path, text)
      return json({ md5: md5(text) })
    }
    if (method === 'create') {
      const body = init!.body as URLSearchParams
      if (body.get('isdir') === '1') return json({ errno: 0, path })
      if (objects.has(path) && body.get('rtype') === '0') return json({ errno: -8 })
      const text = slices.get(path)!
      objects.set(path, text)
      return json({ errno: 0, path, md5: md5(text), size: Buffer.byteLength(text) })
    }
    if (method === 'list') {
      const parent = url.searchParams.get('dir') + '/'
      return json({ errno: 0, list: [...objects].filter(([key]) => key.startsWith(parent) && !key.slice(parent.length).includes('/'))
        .map(([path, value]) => ({ path, isdir: 0, fs_id: fsId, size: Buffer.byteLength(value) })) })
    }
    if (method === 'filemetas') {
      expect(url.searchParams.get('fsids')).toBe('[' + fsId + ']')
      // The actual data plane only requests metadata for one mock object in this test.
      const [path, text] = [...objects].find(([key]) => /[a-f0-9]{64}\.json$/.test(key))!
      return json({ errno: 0, list: [{ path, fs_id: fsId, isdir: 0, size: Buffer.byteLength(text),
        md5: md5(text), dlink: 'https://d.pcs.baidu.com/mock-download' }] })
    }
    if (url.pathname === '/mock-download') {
      expect(url.searchParams.get('access_token')).toBe('test-token')
      return new Response([...objects].find(([key]) => /[a-f0-9]{64}\.json$/.test(key))![1])
    }
    throw new Error('Unexpected mock request')
  })
  return { fake, objects, requests: () => requests }
}

it('authorizes through the official device flow, verifies the folder and refreshes a DSH credential record', async () => {
  vi.useFakeTimers()
  let record: CredentialRecord | undefined
  const creds = {
    readRecord: vi.fn(async () => record),
    modifyRecord: vi.fn(async (_key, mutate) => {
      record = (await mutate(record)) ?? record
      return record
    }),
    deleteRecord: vi.fn(async () => { record = undefined }),
  } as unknown as CredentialProvider
  let polls = 0
  const mock = vi.fn(async (url: URL, init?: RequestInit) => {
    if (url.pathname.endsWith('/device/code')) {
      expect(url.searchParams.get('scope')).toBe('basic,netdisk')
      expect(url.searchParams.has('client_secret')).toBe(false)
      return json({ device_code: 'private-device-code', user_code: 'PUBLIC-CODE', verification_url: 'https://openapi.baidu.com/device',
        interval: 1, expires_in: 600 })
    }
    if (url.pathname.endsWith('/token')) {
      expect(url.hostname).toBe('openapi.baidu.com')
      expect(url.searchParams.get('client_secret')).toBe(app.appSecret)
      if (url.searchParams.get('grant_type') === 'refresh_token') {
        expect(url.searchParams.get('refresh_token')).toBe('test-refresh')
        return json({ access_token: 'refreshed-token', refresh_token: 'rotated-refresh', expires_in: 600 })
      }
      if (++polls === 1) return json({ error: 'authorization_pending' }, 400)
      return json({ access_token: 'test-token', refresh_token: 'test-refresh', expires_in: 600 })
    }
    switch (url.searchParams.get('method')) {
      case 'uinfo': return new Response('{"errno":0,"netdisk_name":"Tester","uk":12345678901234567890}')
      case 'list':
        expect(url.searchParams.get('dir')).toBe('/apps/测试应用')
        return json({ errno: 0, list: [] })
      case 'create':
        expect((init!.body as URLSearchParams).get('path')).toBe('/apps/测试应用/ChatDS-sync-v2')
        return json({ errno: 0 })
      default: throw new Error('Unexpected mock request')
    }
  })
  vi.stubGlobal('fetch', mock)
  const account = new BaiduAccount(creds, 'test')
  expect(await account.begin(app, signal)).toMatchObject({ phase: 'pending', userCode: 'PUBLIC-CODE' })
  expect(await account.poll(signal)).toBeUndefined()
  expect(polls).toBe(0)
  await vi.advanceTimersByTimeAsync(1000)
  expect(await account.poll(signal)).toBeUndefined()
  expect(record).toBeUndefined()
  await vi.advanceTimersByTimeAsync(1000)
  const connected = (await account.poll(signal))!
  expect(connected).toMatchObject({ account: 'Tester', accountId: '12345678901234567890', auto: false })
  await account.setAuto(true)
  const restarted = new BaiduAccount(creds, 'test')
  expect(await restarted.read()).toMatchObject({ auto: true, connectionId: connected.connectionId })
  expect(await restarted.access(connected.connectionId, signal, 'test-token')).toBe('refreshed-token')
  expect((await restarted.read())?.refresh).toBe('rotated-refresh')
  await restarted.disconnect()
  await expect(restarted.access(connected.connectionId, signal)).rejects.toThrow('authorized again')
})

it('uploads and downloads only encrypted envelopes, verifies deduplication, and refuses reused prekey claims', async () => {
  const { fake, objects, requests } = filesystem()
  vi.stubGlobal('fetch', fake)
  const transport = new BaiduTransport(app, async () => 'test-token')
  const alice = createIdentity('Alice')
  const bob = createIdentity('Bob')
  const prekey = createPrekey()
  const base: Omit<SyncSnapshot, 'eventId'> = {
    senderId: alice.card.id, conversationId: 'chatws-test', messageId: 'message-test', parentId: null,
    role: 'user', text: 'SYNTHETIC_PRIVATE_MESSAGE', context: 'excerpt', createdAt: new Date().toISOString(),
    conversationCreatedAt: null,
  }
  const event = { ...base, eventId: snapshotId(base) }
  const verify = (value: unknown) => verifyStoredEnvelope(alice, bob.card, event, value)
  expect(await transport.claimPrekey(bob.card.id, prekey.id, signal)).toBe(true)
  expect(await transport.claimPrekey(bob.card.id, prekey.id, signal)).toBe(false)
  const sealed = seal(alice, bob.card, event, { id: prekey.id, key: prekey.publicKey })
  await transport.put(sealed.envelope, signal, verify)
  await transport.put(sealed.envelope, signal, verify)
  expect([...objects.values()].join('\n')).not.toContain(base.text)
  expect([...objects.values()].join('\n')).not.toContain(bob.privateKey)
  const received = vi.fn(async (value: unknown) => {
    expect(openEnvelope(bob, [alice.card], value, [prekey]).event).toEqual(event)
    expect(() => openEnvelope(bob, [alice.card], value, [])).toThrow(/prekey/i)
  })
  await transport.pull(bob.card.id, new Set(), received, signal)
  expect(received).toHaveBeenCalledTimes(1)
  const before = requests()
  await transport.pull(bob.card.id, new Set([event.eventId]), received, signal)
  expect(received).toHaveBeenCalledTimes(1)
  expect(requests() - before).toBe(1)
})

it('rejects unsafe browser authorization URLs and honors cloud retry backoff', async () => {
  const fake = vi.fn(async () => json({ device_code: 'server-code', user_code: 'CODE', interval: 1, expires_in: 120,
    verification_url: 'https://baidu.com.example.org/device' }))
  vi.stubGlobal('fetch', fake)
  await expect(new BaiduAccount({} as CredentialProvider, 'test').begin(app, signal)).rejects.toThrow('unexpected address')
  const limited = vi.fn(async () => new Response('{}', { status: 429, headers: { 'retry-after': '60' } }))
  vi.stubGlobal('fetch', limited)
  const transport = new BaiduTransport(app, async () => 'test-token')
  await expect(transport.prepare(signal)).rejects.toThrow('429')
  await expect(transport.prepare(signal)).rejects.toThrow('rate limited')
  expect(limited).toHaveBeenCalledTimes(1)
})
