/**
 * R8 归档测试 — DeepChat v3 导出/导入往返:格式、线性化、校验拒绝。
 */

import { describe, expect, it } from 'vitest'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import {
  EXPORT_FORMAT_VERSION,
  exportSessionZip,
  exportSessionsZip,
  parseArchive,
  toSessionFile,
  handoverText,
} from '../src/host/archive.js'
import type { AssistantMessage, Message, UserMessage } from '@dsh-chat/shared'

const user = (id: string, content: string, createdAt = 1_700_000_000_000): UserMessage => ({
  id, role: 'user', content, files: [], createdAt,
})

const assistant = (id: string, text: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage => ({
  id, role: 'assistant', createdAt: 1_700_000_010_000, model: 'deepseek-flash', prefix: true, status: 'done',
  blocks: [{ type: 'text', text }],
  ...overrides,
})

describe('R8:归档导出(DeepChat v3)', () => {
  it('生成 manifest/index/session 三条目;消息角色顺序与状态映射正确', () => {
    const messages: Message[] = [
      user('u1', '你好'),
      assistant('a1', '你好!', { thinking: true, usage: { input_tokens: 12, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }),
    ]
    const file = toSessionFile('chatws-x', '测试会话', true, 1_700_000_000_000, 1_700_000_020_000, messages)
    expect(file.messages).toHaveLength(2)
    expect(file.messages[0]).toMatchObject({ id: 1, role: 'USER', status: 'FINISHED', fragments: [{ type: 'REQUEST', content: '你好' }] })
    expect(file.messages[1]).toMatchObject({ id: 2, parent_id: 1, role: 'ASSISTANT', status: 'FINISHED', accumulated_token_usage: 15 })
    expect(file.current_message_id).toBe(2)

    const zip = unzipSync(exportSessionZip(file))
    const manifest = JSON.parse(strFromU8(zip['manifest.json']!))
    expect(manifest.export_format_version).toBe(EXPORT_FORMAT_VERSION)
    const session = JSON.parse(strFromU8(zip['chat_sessions/chatws-x.json']!))
    expect(session.title).toBe('测试会话')
    expect(session.pinned).toBe(true)
    const index = JSON.parse(strFromU8(zip['chat_session_index.json']!))
    expect(index).toHaveLength(1)
    expect(index[0].message_count).toBe(2)
  })

  it('错误/中断/拒绝状态映射为 FAILED/INCOMPLETE/CONTENT_FILTER', () => {
    const file = toSessionFile('s', null, false, 0, 0, [
      assistant('a1', '', { status: 'stopped' }),
      assistant('a2', '', { status: 'error', error: { kind: 'stream', message: 'x' } }),
      assistant('a3', '模板', { stopReason: 'refusal' }),
    ])
    expect(file.messages.map((message) => message.status)).toEqual(['INCOMPLETE', 'FAILED', 'CONTENT_FILTER'])
  })
})

describe('R8:归档导入', () => {
  const buildZip = (messages: unknown[], manifestVersion = EXPORT_FORMAT_VERSION) =>
    exportSessionZip(toSessionFile('imported', '导入测试', false, 0, 0, messages as Message[]))

  it('预览返回会话列表与消息数(不写盘)', async () => {
    const { preview, sessions } = await parseArchive(buildZip([user('u1', '问题'), assistant('a1', '回答')]))
    expect(preview.formatVersion).toBe(3)
    expect(preview.sessions).toHaveLength(1)
    expect(preview.sessions[0]).toMatchObject({ title: '导入测试', messageCount: 2 })
    expect(sessions[0]!.messages).toHaveLength(2)
  })

  it('accepts a DeepSeek ZIP with more than 200 conversations through a Blob', async () => {
    const entries: Record<string, Uint8Array> = {
      'manifest.json': strToU8(JSON.stringify({ export_format_version: EXPORT_FORMAT_VERSION })),
    }
    for (let i = 0; i < 201; i++) {
      const id = `chat-${i}`
      const session = toSessionFile(id, id, false, 0, 0, [user('u1', 'Hello')])
      entries[`chat_sessions/${id}.json`] = strToU8(JSON.stringify(session))
    }
    const archive = new Blob([new Uint8Array(zipSync(entries))])
    const { preview } = await parseArchive(archive)
    expect(preview).toMatchObject({ format: 'v3', size: archive.size, skipped: [] })
    expect(preview.sessions).toHaveLength(201)
  })

  it('拒绝错误版本与损坏归档', async () => {
    const wrongVersion = zipSync({
      'manifest.json': strToU8(JSON.stringify({ export_format_version: 2 })),
      'chat_sessions/x.json': strToU8('{}'),
    })
    await expect(parseArchive(wrongVersion)).rejects.toThrow(/格式版本/)
    await expect(parseArchive(new TextEncoder().encode('not a zip'))).rejects.toThrow()
  })

  it('批量 ZIP 保留会话原件并拒绝越界条目', async () => {
    const file = toSessionFile('files', '含图片', false, 0, 0, [user('u1', '保留附件')])
    const path = 'chat_sessions/files_files/id_图片.png'
    file.messages[0]!.fragments.unshift({ type: 'FILE', files: [{ file_name: '图片.png', export_path: path }] })
    const bytes = new Uint8Array([137, 80, 78, 71])
    const zip = exportSessionsZip([file], new Map([[path, bytes]]))
    const result = await parseArchive(zip)
    expect(result.sessions[0]!.assets.get(path)).toEqual(bytes)
    expect(result.preview.sessions[0]).toMatchObject({ attachmentCount: 1, retainedAttachmentCount: 1 })
    await expect(parseArchive(zipSync({ '../outside.json': strToU8('{}') }))).rejects.toThrow()
  })

  it('单会话裸 JSON 也可导入(兼容 ChatDS 导出)', async () => {
    const json = new TextEncoder().encode(JSON.stringify({
      id: 'bare', title: '裸导入', messages: [{ id: 1, parent_id: null, role: 'USER', status: 'FINISHED', thinking_enabled: false, search_enabled: false, accumulated_token_usage: 0, inserted_at: new Date().toISOString(), fragments: [{ type: 'REQUEST', content: '问题' }] }],
    }))
    const { preview } = await parseArchive(json)
    expect(preview.sessions[0]).toMatchObject({ id: 'bare', title: '裸导入', messageCount: 1 })
  })

  it('交接单文本包含目标/进度/最近请求,不含工具输出', () => {
    const text = handoverText({
      sessionId: 's',
      title: '任务',
      goal: '完成某事',
      completedTurns: 2,
      recentRequests: ['先做甲', '再做乙'],
      files: ['报告.docx'],
      lastActivity: 0,
      messageCount: 4,
    })
    expect(text).toContain('会话目标:完成某事')
    expect(text).toContain('已完成回复轮数:2')
    expect(text).toContain('先做甲')
    expect(text).toContain('报告.docx')
    expect(text).not.toMatch(/tool|Tool|工具结果/)
  })
})
