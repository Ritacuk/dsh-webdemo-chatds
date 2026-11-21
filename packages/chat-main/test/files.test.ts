/**
 * P2-F 文件处理测试 — 分类、DOCX 本地提取、片段选择、原文件不变性。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fileFingerprint, loadAttachment, receiveUpload, selectSnippet } from '../src/host/files.js'
import type { WorkspaceStore } from '../src/host/store.js'

let root: string
let store: WorkspaceStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'chatws-files-'))
  vi.stubEnv('DSH_HOME', root)
  // 内存版 store(仅 putAttachment/getAttachment/listAttachments/deleteAttachment)
  const records = new Map()
  store = {
    async putAttachment(record: never) {
      records.set((record as { id: string }).id, record)
    },
    async getAttachment(id: string) {
      return records.get(id)
    },
    async deleteAttachment(id: string) {
      records.delete(id)
    },
    async listAttachments(sessionId: string) {
      return [...records.values()].filter((r) => (r as { sessionId: string }).sessionId === sessionId)
    },
  } as unknown as WorkspaceStore
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

const upload = (name: string, bytes: Uint8Array, sessionId = 'chatws-test') =>
  receiveUpload({ store, sessionId, name, bytes, maxFileBytes: 1024 * 1024 })

describe('P2-F:分类与处理方式', () => {
  it('discloses that extracted text is sent to the selected model', async () => {
    const attachment = await upload('hello.txt', new TextEncoder().encode('你好,本地内容'))
    expect(attachment.handling).toBe('local-inline')
    expect(attachment.handlingNote).toContain('交给所选模型')
  })

  it('Markdown/代码文件 → local-inline', async () => {
    expect((await upload('readme.md', new TextEncoder().encode('# hi'))).handling).toBe('local-inline')
    expect((await upload('app.ts', new TextEncoder().encode('const x = 1'))).handling).toBe('local-inline')
  })

  it('DOCX → local-extract,可提取纯文本(最小构造的 docx 包)', async () => {
    const docx = zipSync({
      'word/document.xml': strToU8('<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>第一段内容</w:t></w:r></w:p><w:p><w:r><w:t>第二段内容</w:t></w:r></w:p></w:body></w:document>'),
    })
    const attachment = await upload('report.docx', docx)
    expect(attachment.handling).toBe('local-extract')
    expect(attachment.handlingNote).toContain('版式和图片不参与解析')
    const loaded = loadAttachment({ ...(await store.getAttachment(attachment.id))! })
    expect(loaded.text).toContain('第一段内容')
    expect(loaded.text).toContain('第二段内容')
  })

  it('PDF → cloud-files-api(云端处理,页面明示)', async () => {
    const attachment = await upload('doc.pdf', new TextEncoder().encode('%PDF-fake'))
    expect(attachment.handling).toBe('cloud-files-api')
    expect(attachment.handlingNote).toContain('云端')
  })

  it('PNG → cloud-files-api', async () => {
    const attachment = await upload('img.png', new Uint8Array([137, 80, 78, 71]))
    expect(attachment.handling).toBe('cloud-files-api')
  })

  it('不支持的类型(如 .exe)→ unsupported + 明确原因', async () => {
    const attachment = await upload('evil.exe', new Uint8Array([77, 90]))
    expect(attachment.handling).toBe('unsupported')
    expect(attachment.error).toContain('unsupported file type')
  })

  it('超限文件 → unsupported(不落盘副本)', async () => {
    const attachment = await upload('big.txt', new Uint8Array(2 * 1024 * 1024).fill(97))
    expect(attachment.handling).toBe('unsupported')
    expect(attachment.error).toContain('limit')
  })

  it('损坏的 DOCX → unsupported + 解析失败提示(P2-F 要求 7)', async () => {
    const attachment = await upload('broken.docx', new TextEncoder().encode('not a zip'))
    expect(attachment.handling).toBe('unsupported')
    expect(attachment.error).toContain('DOCX 解析失败')
  })
})

describe('P2-F:原文件不变与指纹', () => {
  it('读取前后原文件指纹一致(只读保证)', async () => {
    const bytes = new TextEncoder().encode('stable content for fingerprint')
    const attachment = await upload('stable.txt', bytes)
    const record = (await store.getAttachment(attachment.id))!
    const before = fileFingerprint(record)
    void loadAttachment(record)
    void loadAttachment(record)
    const after = fileFingerprint(record)
    expect(after).toBe(before)
    // 存储副本字节数与上传一致
    expect(statSync(record.storedPath).size).toBe(bytes.byteLength)
  })
})

describe('P2-H:文本片段确定性选择(成本策略)', () => {
  it('短文本全文返回,不截断', () => {
    const result = selectSnippet('短内容', '问题', 1200)
    expect(result).toEqual({ content: '短内容', truncated: false })
  })

  it('长文本围绕关键词取窗口,标注截断', () => {
    const filler = '无关填充。'.repeat(2000)
    const target = '关键词出现在这里: QUANTUM-答案-42'
    const text = filler + target + filler
    const result = selectSnippet(text, 'QUANTUM-答案-42', 1200)
    expect(result.truncated).toBe(true)
    expect(result.content).toContain('QUANTUM-答案-42')
    expect(result.content.length).toBeLessThanOrEqual(1200 + 100)
  })

  it('无关键词命中时取头部并标注截断', () => {
    const text = '头部内容' + 'x'.repeat(5000)
    const result = selectSnippet(text, '不存在词', 1000)
    expect(result.truncated).toBe(true)
    expect(result.content.startsWith('头部内容')).toBe(true)
  })
})

describe('P2-F:附件与会话归属', () => {
  it('附件按会话隔离(列出只含本会话)', async () => {
    await upload('a.txt', new TextEncoder().encode('a'), 'chatws-a')
    await upload('b.txt', new TextEncoder().encode('b'), 'chatws-b')
    const listA = await store.listAttachments('chatws-a')
    const listB = await store.listAttachments('chatws-b')
    expect(listA).toHaveLength(1)
    expect(listB).toHaveLength(1)
    expect(listA[0]!.sessionId).toBe('chatws-a')
    expect(listB[0]!.sessionId).toBe('chatws-b')
  })
})
