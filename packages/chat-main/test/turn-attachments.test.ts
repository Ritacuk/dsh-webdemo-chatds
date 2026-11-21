import { expect, it, vi } from 'vitest'
import { toRequestMessages, type UserMessage } from '@dsh-chat/shared'
import { TurnAttachments } from '../src/host/turn-attachments.js'
import type { AttachmentRecord, WorkspaceStore } from '../src/host/store.js'
import type { RichGateway } from '../src/host/rich.js'

const question: UserMessage = { id: 'question', role: 'user', content: 'Read the original', files: [], createdAt: 0 }

function fixture() {
  const records = new Map<string, AttachmentRecord>()
  for (const [name, mimeType] of [['a.pdf', 'application/pdf'], ['b.png', 'image/png']] as const) {
    records.set(name, {
      id: name, name, mimeType, size: 10, sessionId: 'session', handling: 'cloud-files-api', storedPath: '', createdAt: 0,
    })
  }
  const store = {
    getAttachment: async (id: string) => records.get(id),
    putAttachment: async (record: AttachmentRecord) => { records.set(record.id, record) },
  }
  let origin = 'https://example.com'
  const uploadToFilesApi = vi.fn(async ({ name }: { name: string }) => ({ id: 'cloud-' + name }))
  const gateway = { fileScope: () => ({ origin, credentialRef: 'DEEPSEEK_API_KEY' }), uploadToFilesApi }
  return {
    records, uploadToFilesApi, changeOrigin: () => { origin = 'https://other.example.com' },
    runner: (channel: 'rich' | 'generic' = 'rich') => new TurnAttachments(
      store as unknown as WorkspaceStore, gateway as unknown as RichGateway,
      'session', channel, question.content, 1000, new AbortController().signal,
    ),
  }
}

it('uploads PDF and image once and rebuilds both references from saved metadata', async () => {
  const f = fixture()
  await expect(f.runner().current(question, ['a.pdf'], false)).rejects.toMatchObject({ code: 'ATTACHMENT_REFERENCE_UNAVAILABLE' })
  const first = await f.runner().current(question, ['a.pdf', 'b.png'], false, true)
  const replay = { ...first, files: first.files.map((file) => ({ ...file, serverId: null })) }
  for (let i = 0; i < 2; i++) {
    const historical = await f.runner().historical(replay)
    const messages = toRequestMessages([], historical, undefined, false)
    expect(messages[0]?.content).toEqual(expect.arrayContaining([
      { type: 'document', source: { type: 'file', file_id: 'cloud-a.pdf' } },
      { type: 'image', source: { type: 'file', file_id: 'cloud-b.png' } },
    ]))
  }
  expect(f.uploadToFilesApi).toHaveBeenCalledTimes(2)
  f.records.delete('a.pdf')
  expect((await f.runner().historical(replay)).files.map((file) => file.name)).toEqual(['b.png'])
})

it('blocks incompatible models and stale service scopes without uploading again', async () => {
  const f = fixture()
  const first = await f.runner().current(question, ['a.pdf'], false, true)
  await expect(f.runner('generic').historical(first)).rejects.toMatchObject({ code: 'ATTACHMENT_MODEL_UNSUPPORTED' })
  f.changeOrigin()
  await expect(f.runner().historical(first)).rejects.toMatchObject({ code: 'ATTACHMENT_REFERENCE_UNAVAILABLE' })
  expect(f.uploadToFilesApi).toHaveBeenCalledTimes(1)
})
