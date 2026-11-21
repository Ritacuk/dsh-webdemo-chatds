/**
 * 附件处理(P2-F)— 最小只读适配,不重复造解析引擎。
 *
 * 处理方式分级(页面必须如实展示,见 WireAttachment.handling):
 * - local-inline:  文本类(TXT/Markdown/JSON/常见代码)— 本地提取后将节选交给所选模型;
 * - local-extract: DOCX — 本地最小提取(fflate 解压 document.xml,仅纯文本,
 *                  版式/表格/公式不完整,页面提示);
 * - cloud-files-api: PDF/图片 — 发送轮通过官方 Demo 同款 Files API 上传
 *                  (deepseek_read_url 同源端点;云端处理,页面明示);未配置凭证时报错;
 * - unsupported:   其余格式(PPTX/XLSX 待核实 DSH 原生附件服务能力后再启用)。
 *
 * 字节存放于 $DSH_HOME/chat-workspace/files/<id>__<安全文件名>;KV 索引记录元数据。
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync, realpathSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { decodeText, extractOfficeText } from './file-text.js'
import type { WireAttachment } from '@dsh-chat/shared'
import type { WorkspaceStore, AttachmentRecord } from './store.js'

/** P2-F 支持的文本类扩展名(本地内联)。 */
const INLINE_TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.csv', '.tsv', '.log', '.xml', '.svg', '.html', '.htm', '.css', '.scss', '.less',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.pyi', '.rb', '.rs', '.go', '.java',
  '.kt', '.swift', '.c', '.h', '.cpp', '.hpp', '.cc', '.cs', '.php', '.sh', '.bash', '.zsh',
  '.ps1', '.bat', '.cmd', '.sql', '.lua', '.pl', '.r', '.dart', '.vue', '.svelte', '.graphql',
])

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

/** DeepSeek Harness 用户主目录(语义与 dsh-home-paths 一致:DSH_HOME 覆盖,否则 ~/.dsh)。 */
function dshHome(): string {
  const override = process.env['DSH_HOME']
  if (override !== undefined && override.length > 0) return resolve(override)
  return join(homedir(), '.dsh')
}

export function attachmentsDir(): string {
  const dir = join(dshHome(), 'chat-workspace', 'files')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** 安全文件名:仅保留白名单字符,防止路径成分混入。 */
function safeFileName(name: string): string {
  const base = basename(name).replace(/[^A-Za-z0-9._() -]/g, '_').slice(0, 120)
  return base.length > 0 ? base : 'file'
}

function extLower(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot).toLowerCase()
}

/** DOCX 最小文本提取:解压 word/document.xml,剥掉标签拼接 <w:t> 文本。 */
function extractDocxText(bytes: Uint8Array): { text: string; note: string } {
  return {
    text: extractOfficeText(bytes, '.docx'),
    note: 'DOCX 本地提取:仅纯文本,表格/公式/图片与版式信息不完整',
  }
}

/** 单文件上传接收与分类(只读原文件;副本存放于附件目录)。 */
export async function receiveUpload(options: {
  store: WorkspaceStore
  sessionId: string
  name: string
  bytes: Uint8Array
  maxFileBytes: number
}): Promise<WireAttachment> {
  const { store, sessionId, name, bytes } = options
  const ext = extLower(name)
  const size = bytes.byteLength
  const id = `att-${randomUUID()}`
  let handling: WireAttachment['handling']
  let handlingNote: string | undefined
  let error: string | undefined

  if (size > options.maxFileBytes) {
    handling = 'unsupported'
    error = `file exceeds the ${String(options.maxFileBytes)}-byte limit (${String(size)} bytes)`
  } else if (INLINE_TEXT_EXTENSIONS.has(ext)) {
    handling = 'local-inline'
    handlingNote = '本地读取 UTF-8 或带编码标记的 UTF-16 文本，发送时将相关内容交给所选模型'
  } else if (ext === '.docx') {
    try {
      extractDocxText(bytes)
      handling = 'local-extract'
      handlingNote = '在本地提取纯文本，发送时将相关内容交给所选模型。版式和图片不参与解析'
    } catch (cause) {
      handling = 'unsupported'
      error = `DOCX 解析失败: ${cause instanceof Error ? cause.message : String(cause)}`
    }
  } else if (ext === '.pdf') {
    handling = 'cloud-files-api'
    handlingNote = 'PDF 需服务端版面解析:发送时上传至 DeepSeek Files API(云端处理);扫描件/复杂版式以服务端能力为准'
  } else if (IMAGE_EXTENSIONS.has(ext)) {
    handling = 'cloud-files-api'
    handlingNote = '图片以 Files API file_id 引用上传(云端处理)'
  } else {
    handling = 'unsupported'
    error = `unsupported file type "${ext || '(no extension)'}"; supported: text/code files, .docx, .pdf, images`
  }

  // 仅在可处理时落盘(unsupported 不留副本)。
  let storedPath = ''
  if (handling !== 'unsupported') {
    const dir = attachmentsDir()
    storedPath = join(dir, `${id}__${safeFileName(name)}`)
    writeFileSync(storedPath, bytes)
  }

  const record: AttachmentRecord = {
    id,
    sessionId,
    name,
    mimeType: mimeTypeOf(name),
    size,
    storedPath,
    handling,
    ...(handlingNote !== undefined ? { handlingNote } : {}),
    ...(error !== undefined ? { error } : {}),
    createdAt: Date.now(),
  }
  await store.putAttachment(record)
  return wireAttachment(record)
}

/** 归档保留文件原件，下载需显式操作。不会复用归档的云端引用。 */
export async function storeArchivedFile(store: WorkspaceStore, sessionId: string, name: string, bytes: Uint8Array): Promise<AttachmentRecord> {
  const id = `att-${randomUUID()}`
  const storedPath = join(attachmentsDir(), `${id}__${safeFileName(name)}`)
  const record: AttachmentRecord = {
    id, sessionId, name, storedPath, mimeType: mimeTypeOf(name), size: bytes.byteLength,
    handling: 'unsupported', archiveOnly: true, createdAt: Date.now(),
  }
  writeFileSync(storedPath, bytes, { flag: 'wx' })
  try {
    await store.putAttachment(record)
  } catch (error) {
    unlinkSync(storedPath)
    throw error
  }
  return record
}

export function readStoredFile(record: AttachmentRecord, limit = 64 * 1024 * 1024): Buffer {
  if (!record.storedPath || !existsSync(record.storedPath) || record.size > limit) {
    throw new Error(`attachment "${record.name}" is unavailable: ${record.error ?? 'missing stored copy'}`)
  }
  const path = realpathSync(record.storedPath)
  if (dirname(path) !== realpathSync(attachmentsDir()) || basename(path) !== `${record.id}__${safeFileName(record.name)}`) {
    throw new Error('stored attachment path does not match its identity')
  }
  const { size } = statSync(path)
  if (size > limit || size !== record.size) throw new Error('stored attachment size changed')
  return readFileSync(path)
}

/** 读取已存附件的解析内容(发送时使用)。 */
export function loadAttachment(record: AttachmentRecord): { text?: string; bytes?: Uint8Array; note?: string } {
  if (record.handling === 'unsupported') throw new Error('attachment cannot be used by this model')
  const bytes = readStoredFile(record, Math.max(record.size, 64 * 1024 * 1024))
  if (record.handling === 'local-inline') {
    return { text: decodeText(bytes), note: record.handlingNote }
  }
  if (record.handling === 'local-extract') {
    const { text, note } = extractDocxText(new Uint8Array(bytes))
    return { text, note: `${record.handlingNote ?? ''}; ${note}` }
  }
  return { bytes: new Uint8Array(bytes), note: record.handlingNote }
}

export function wireAttachment(record: AttachmentRecord): WireAttachment {
  return {
    id: record.id,
    name: record.name,
    mimeType: record.mimeType,
    size: record.size,
    handling: record.handling,
    ...(record.handlingNote !== undefined ? { handlingNote: record.handlingNote } : {}),
    ...(record.error !== undefined ? { error: record.error } : {}),
  }
}

function mimeTypeOf(name: string): string {
  const ext = extLower(name)
  const map: Record<string, string> = {
    '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
    '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }
  return map[ext] ?? 'application/octet-stream'
}

/**
 * 文本片段确定性选择(P2-H 成本策略):围绕关键词取窗口,不足时取头部。
 * 不调用模型、不引入向量检索;长文件只注入与当前问题相关的片段。
 */
export function selectSnippet(text: string, query: string, maxChars: number): { content: string; truncated: boolean } {
  if (text.length <= maxChars) return { content: text, truncated: false }
  const terms = query.trim().toLowerCase().split(/\s+/).filter((term) => term.length > 0)
  if (terms.length === 0) return { content: text.slice(0, maxChars), truncated: true }
  const lower = text.toLowerCase()
  const windows: { index: number; score: number }[] = []
  const windowSize = Math.max(400, Math.floor(maxChars / 3))
  for (const term of terms) {
    let from = 0
    for (;;) {
      const at = lower.indexOf(term, from)
      if (at === -1) break
      const index = Math.max(0, at - windowSize / 2)
      const existing = windows.find((w) => Math.abs(w.index - index) < windowSize)
      if (existing !== undefined) existing.score++
      else windows.push({ index, score: 1 })
      from = at + term.length
      if (windows.length >= 8) break
    }
  }
  if (windows.length === 0) return { content: text.slice(0, maxChars), truncated: true }
  windows.sort((a, b) => b.score - a.score)
  const parts: string[] = []
  let used = 0
  for (const window of windows) {
    if (used >= maxChars) break
    const slice = text.slice(window.index, window.index + Math.min(windowSize, maxChars - used))
    parts.push(`…\n${slice}`)
    used += slice.length
  }
  return { content: parts.join('\n'), truncated: true }
}

/** 校验统计(用于诊断:文件读取前后原始文件不变)。 */
export function fileFingerprint(record: AttachmentRecord): string {
  if (!existsSync(record.storedPath)) return 'missing'
  const stat = statSync(record.storedPath)
  const bytes = readFileSync(record.storedPath)
  return `${String(stat.size)}:${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}`
}
