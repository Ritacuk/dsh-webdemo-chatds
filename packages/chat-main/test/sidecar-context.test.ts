import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { SidecarContext, checkpointTranscript } from '../src/host/sidecar-context.js'

it('只继承检查点以内的人类消息和 Agent 正文，排除自动运行时提示', () => {
  const content = (text: string) => [{ type: 'text', text }]
  const events = [
    { seq: 0, type: 'user/message', data: { source: { kind: 'user' }, content: content('用户问题') } },
    { seq: 1, type: 'user/message', data: { source: { kind: 'runtime-context' }, content: content('自动工作区策略') } },
    { seq: 2, type: 'user/message', data: { source: { kind: 'skill-catalog' }, content: content('自动技能列表') } },
    { seq: 3, type: 'assistant/message', data: { message: { content: content('Agent 回答') } } },
    { seq: 4, type: 'user/message', data: { source: { kind: 'user' }, content: content('检查点之后的问题') } },
  ]
  expect(checkpointTranscript(events as never, 3)).toBe('用户：用户问题\n\nAgent：Agent 回答')
})

it('原生 desktop Profile 忽略缺省环境变量，优先恢复已有的旁聊', async () => {
  const parent = 'session-parent'
  const idFor = (name: string) => 'chatws-side-' + createHash('sha256').update(name + '\0' + parent).digest('hex').slice(0, 32)
  const record = { type: 'plugin:chat-workspace/sidecar-context', data: { parent, checkpoint: 2, transcript: '已同步' } }
  const blank = { snapshotEvents: () => [record] }
  const withHistory = { snapshotEvents: () => [record, { type: 'assistant/message' }] }
  const handle = { read: async () => ({ events: [] }), close: async () => {}, [Symbol.asyncDispose]: async () => {} }
  let canonical = withHistory
  let legacy = blank
  const sessions = { liveSession: async (id: string) => id === idFor('desktop') ? canonical : id === idFor('default') ? legacy : undefined }
  const ctx = { get: () => ({ name: 'desktop' }), sessionPersistence: { open: async () => handle } }
  const sidecar = new SidecarContext(ctx as never, sessions as never, {} as never)
  await expect(sidecar.describe(parent)).resolves.toMatchObject({ sessionId: idFor('desktop'), selected: 2 })
  canonical = blank
  legacy = withHistory
  await expect(sidecar.describe(parent)).resolves.toMatchObject({ sessionId: idFor('default'), selected: 2 })
})
