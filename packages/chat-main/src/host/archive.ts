/** WebChat ZIP backups and compatible v3 history import through the DSH Session writer. */
import { zipSync, strToU8 } from 'fflate'
import { readArchive, readEntry, skipEntry } from './archive-zip.js'
import { unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { SessionLogOffset, SessionSeq as makeSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionTitleProviderId } from '@deepseek-ai/dsh-session-title'
import { replyBlocksToDshContent } from '@dsh-chat/shared'
import type {
  ReplyBlock, TextCitation,
  AssistantMessage as DemoAssistant,
  Message as DemoMessage,
} from '@dsh-chat/shared'
import { readStoredFile, storeArchivedFile } from './files.js'
import type { AttachmentRecord, WorkspaceStore } from './store.js'
import { writePluginRecord } from './plugin-record.js'
import { eventsToWireMessages, replayChatSession } from './sessions.js'
import type { WorkspaceSessions } from './sessions.js'

/** 导入标题来源标识(官方 session/title provider 品牌)。 */
const TITLE_PROVIDER = brandString<SessionTitleProviderId>('chat-workspace-import')

/** 本插件的导入来源记录(经官方 PluginRecordMap 合并声明)。 */
declare module '@deepseek-ai/dsh-session' {
  interface PluginRecordMap {
    'plugin:chat-workspace/import': {
      source: string
      messageCount: number
    }
  }
}

export const EXPORT_FORMAT_VERSION = 3
const MANIFEST_PATH = 'manifest.json'
const INDEX_PATH = 'chat_session_index.json'
const SESSION_DIR = 'chat_sessions/'
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
const MAX_EXPORT_SESSIONS = 200
export const MAX_IMPORT_ARCHIVE_BYTES = 256 * 1024 * 1024
const MAX_IMPORT_EXPANDED_BYTES = 256 * 1024 * 1024
const MAX_IMPORT_SESSIONS = 1_000
const MAX_MESSAGES_PER_SESSION = 5_000

const iso = (ms: number) => new Date(ms).toISOString()

// ── 导出 ──

interface ExportFragment { type: string; [key: string]: unknown }
interface ExportChatMessage {
  id: number
  parent_id: number | null
  role: 'USER' | 'ASSISTANT'
  status: 'WIP' | 'FINISHED' | 'INCOMPLETE' | 'FAILED' | 'CONTENT_FILTER' | 'TIMEOUT' | 'CONTEXT_LENGTH_EXCEEDED'
  webchat_model?: string
  thinking_enabled: boolean
  search_enabled: boolean
  accumulated_token_usage: number
  inserted_at: string
  fragments: ExportFragment[]
}
interface ExportSessionFile {
  webchat_archived?: true
  id: string
  title: string | null
  pinned: boolean
  current_message_id: number
  inserted_at: string
  updated_at: string
  messages: ExportChatMessage[]
}
interface ExportIndexEntry {
  id: string
  title: string | null
  pinned: boolean
  message_count: number
  inserted_at: string
  updated_at: string
}

function replyStatus(reply: DemoAssistant): ExportChatMessage['status'] {
  if (reply.status === 'stopped') return 'INCOMPLETE'
  if (reply.status === 'error') return 'FAILED'
  if (reply.stopReason === 'refusal') return 'CONTENT_FILTER'
  return 'FINISHED'
}

function usageTotal(reply: DemoAssistant): number {
  const usage = reply.usage
  if (usage === undefined) return 0
  return usage.input_tokens + usage.output_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
}

function userFragments(message: Extract<DemoMessage, { role: 'user' }>): ExportFragment[] {
  const files = message.files.map((file) => ({
    id: file.id,
    file_name: file.name,
    file_size: file.size,
    token_usage: null,
    inserted_at: iso(message.createdAt),
    export_path: null,
    is_image: file.isImage,
    width: null,
    height: null,
  }))
  return [
    ...(files.length > 0 ? [{ type: 'FILE', files }] : []),
    { type: 'REQUEST', content: message.content },
  ]
}

function assistantFragments(reply: DemoAssistant): ExportFragment[] {
  const fragments: ExportFragment[] = []
  const tools = new Map<string, Extract<ReplyBlock, { type: 'server_tool_use' }>>()
  for (const block of reply.blocks) {
    if (block.type === 'thinking' && block.thinking.trim()) {
      fragments.push({ type: 'THINK', content: block.thinking, elapsed_secs: block.elapsedSeconds ?? null })
    } else if (block.type === 'text' && block.text.trim()) {
      fragments.push({ type: block.isTemplate ? 'TEMPLATE_RESPONSE' : 'RESPONSE', content: block.text,
        ...(block.citations?.length ? { webchat_citations: block.citations } : {}) })
    } else if (block.type === 'server_tool_use') {
      tools.set(block.id, block)
    } else if (block.type === 'web_search_tool_result') {
      const input = tools.get(block.tool_use_id)?.input
      fragments.push({
        type: 'TOOL_SEARCH', queries: input?.action === 'search' ? input.queries : [],
        status: block.content.some((item) => item.type === 'web_search_tool_result_error') ? 'FAILED' : 'FINISHED',
        results: block.content.flatMap((item) => item.type === 'web_search_result' ? [{
          url: item.url, title: item.title, snippet: item.snippet, published_at: item.page_age,
          site_name: item.site_name, site_icon: item.site_icon,
        }] : []),
      })
    } else if (block.type === 'web_fetch_tool_result' && block.content.type === 'web_fetch_result') {
      if (block.kind === 'read_link') fragments.push({
        type: 'READ_LINK', results: [{ url: block.content.url, title: block.content.content.title, signature: block.signature ?? '' }],
      })
      else fragments.push({ type: 'TOOL_OPEN', status: 'FINISHED', url: block.content.url })
    }
  }
  return fragments
}

/** 单会话 → DeepChat v3 SessionFile(可见线性路径)。 */
export function toSessionFile(
  id: string,
  title: string | null,
  pinned: boolean,
  createdAt: number,
  updatedAt: number,
  messages: readonly DemoMessage[],
): ExportSessionFile {
  const chat: ExportChatMessage[] = []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!
    const parent = index === 0 ? null : index - 1
    chat.push(message.role === 'user'
      ? {
          id: index + 1,
          parent_id: parent === null ? null : parent + 1,
          role: 'USER',
          status: 'FINISHED',
          thinking_enabled: false,
          search_enabled: false,
          accumulated_token_usage: 0,
          inserted_at: iso(message.createdAt),
          fragments: userFragments(message),
        }
      : {
          id: index + 1,
          parent_id: parent === null ? null : parent + 1,
          role: 'ASSISTANT',
          status: replyStatus(message),
          ...(message.model ? { webchat_model: message.model } : {}),
          thinking_enabled: message.thinking === true,
          search_enabled: message.search === true,
          accumulated_token_usage: usageTotal(message),
          inserted_at: iso(message.createdAt),
          fragments: assistantFragments(message),
        })
  }
  return {
    id,
    title,
    pinned,
    current_message_id: chat.length > 0 ? chat.length : 0,
    inserted_at: iso(createdAt),
    updated_at: iso(updatedAt),
    messages: chat,
  }
}

export function archivedSession(
  id: string,
  summary: { title: string; pinned?: boolean; archived?: boolean; createdAt: number; updatedAt: number } | undefined,
  events: Parameters<typeof replayChatSession>[0],
): ExportSessionFile {
  const { messages, tree } = replayChatSession(events)
  const file = toSessionFile(id, summary?.title ?? null, summary?.pinned === true,
    summary?.createdAt ?? events[0]?.time ?? Date.now(),
    summary?.updatedAt ?? events.at(-1)?.time ?? Date.now(), tree.map(({ message }) => message))
  if (summary?.archived) file.webchat_archived = true
  const ids = new Map(tree.map(({ message }, index) => [message.id, index + 1]))
  for (const [index, node] of tree.entries()) {
    file.messages[index]!.parent_id = node.parent ? ids.get(node.parent) ?? null : null
  }
  const active = messages.at(-1)
  file.current_message_id = active ? ids.get(active.id) ?? 0 : 0
  return file
}

type ArchiveAssets = Map<string, Uint8Array>

export function exportSessionZip(file: ExportSessionFile, assets?: ArchiveAssets): Uint8Array {
  return exportSessionsZip([file], assets)
}

export function attachArchiveAssets(file: ExportSessionFile, records: readonly AttachmentRecord[], entries: ArchiveAssets): void {
  const known = new Map(records.map((record) => [record.id, record]))
  let bytes = [...entries.values()].reduce((sum, entry) => sum + entry.byteLength, 0)
  for (const message of file.messages) for (const fragment of message.fragments) {
    if (fragment.type !== 'FILE' || !Array.isArray(fragment.files)) continue
    for (const attachment of fragment.files) {
      const record = known.get(attachment.id)
      if (!record?.storedPath) continue
      const leaf = record.name.normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '_').slice(0, 100) || 'attachment'
      const path = `${SESSION_DIR}${file.id}_files/${record.id}_${leaf}`
      if (!entries.has(path)) {
        if (record.size > MAX_ARCHIVE_BYTES - bytes) throw new Error('附件原件超过 ZIP 上限，请分批导出或使用 JSON。')
        const data = tryReadStoredFile(record)
        if (!data) continue
        entries.set(path, data)
        bytes += data.byteLength
      }
      attachment.export_path = path
    }
  }
}

function tryReadStoredFile(record: AttachmentRecord): Buffer | undefined {
  try { return readStoredFile(record) } catch { return undefined }
}

export function exportSessionsZip(files: readonly ExportSessionFile[], assets: ArchiveAssets = new Map()): Uint8Array {
  if (!files.length || files.length > MAX_EXPORT_SESSIONS) throw new Error('请选择 1 至 200 个会话。')
  const entries: Record<string, Uint8Array> = {
    [MANIFEST_PATH]: strToU8(JSON.stringify({ export_format_version: EXPORT_FORMAT_VERSION, webchat_archive_version: 1 })),
  }
  let size = [...assets.values()].reduce((sum, entry) => sum + entry.byteLength, 0)
  const index: ExportIndexEntry[] = []
  for (const file of files) {
    const bytes = strToU8(JSON.stringify(file))
    size += bytes.byteLength
    if (bytes.byteLength > 16 * 1024 * 1024 || size > MAX_ARCHIVE_BYTES - 1024 * 1024) {
      throw new Error('归档超过大小上限，请分批导出。')
    }
    entries[`${SESSION_DIR}${file.id}.json`] = bytes
    const { id, title, pinned, inserted_at, updated_at, messages } = file
    index.push({ id, title, pinned, inserted_at, updated_at, message_count: messages.length })
  }
  entries[INDEX_PATH] = strToU8(JSON.stringify(index))
  for (const [path, data] of assets) entries[path] = data
  return zipSync(entries, { level: 0 })
}

export function readableMarkdown(title: string, events: Parameters<typeof eventsToWireMessages>[0]): string {
  const messages = eventsToWireMessages(events)
  return [`# ${title.replace(/[\r\n]/g, ' ')}`, ...messages.map((message) =>
    message.role === 'user' ? `## 用户\n\n${message.content}`
      : `## 助手\n\n${message.blocks.filter((block) => block.type === 'text' && !block.isTemplate)
           .map((block) => block.type === 'text' ? block.text : '').join('\n\n')}`)].join('\n\n') + '\n'
}

// ── 导入 ──

export interface ImportPreviewEntry {
  index: number
  id: string
  title: string | null
  messageCount: number
  attachmentCount: number
  retainedAttachmentCount: number
  missingAttachmentCount: number
  unsupportedFragmentCount: number
  insertedAt: string
  updatedAt: string
}

export interface ImportPreview {
  formatVersion: number
  format: 'webchat' | 'v3' | 'json'
  size: number
  sessions: ImportPreviewEntry[]
  skipped: { path: string; reason: string }[]
}

interface ParsedSession {
  webchat_archived: boolean
  id: string
  title: string | null
  pinned: boolean
  current_message_id: number
  inserted_at: string
  updated_at: string
  messages: ExportChatMessage[]
  assets: ArchiveAssets
}

/** 解析 ZIP 或会话 JSON。上传的 ZIP 由文件支持的 Blob 按需分块读取。 */
export async function parseArchive(input: Blob | Uint8Array): Promise<{ preview: ImportPreview; sessions: ParsedSession[] }> {
  const size = input instanceof Blob ? input.size : input.byteLength
  if (size > MAX_IMPORT_ARCHIVE_BYTES) {
    throw new Error(`归档超过大小上限(${MAX_IMPORT_ARCHIVE_BYTES / 1024 / 1024} MiB)。`)
  }
  const blob = input instanceof Blob ? input : new Blob([new Uint8Array(input)])
  const header = new Uint8Array(await blob.slice(0, 4).arrayBuffer())
  let manifest: { export_format_version?: unknown; webchat_archive_version?: unknown } | undefined
  const sessionRecords: { path: string; value: unknown }[] = []
  const assets: ArchiveAssets = new Map()
  const skipped: ImportPreview['skipped'] = []
  const isZip = header[0] === 0x50 && header[1] === 0x4b
  if (isZip) {
    for await (const entry of readArchive(blob, { bytes: MAX_IMPORT_EXPANDED_BYTES, entries: 4096 })) {
      const path = entry.path
      if (/^chat_sessions\/[^/]+_files\/[^/]+$/u.test(path)) {
        assets.set(path, new Uint8Array(await (await readEntry(entry)).arrayBuffer()))
        continue
      }
      const sessionEntry = /^chat_sessions\/[^/]+\.json$/u.test(path)
      if (path !== MANIFEST_PATH && !sessionEntry) {
        await skipEntry(entry)
        continue
      }
      if (entry.size > 16 * 1024 * 1024) throw new Error('归档中单个会话超过 16 MB。')
      const json = await (await readEntry(entry)).text()
      if (path === MANIFEST_PATH) {
        const value: unknown = JSON.parse(json)
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('归档版本清单无效。')
        manifest = value
        continue
      }
      try {
        sessionRecords.push({ path, value: JSON.parse(json) })
      } catch {
        skipped.push({ path, reason: '会话 JSON 格式错误' })
      }
    }
  } else {
    // 兼容直接导入单会话 JSON(DeepChat chat_sessions/*.json 或 ChatDS 导出的裸文件)
    if (size > MAX_ARCHIVE_BYTES) throw new Error('单会话 JSON 超过 64 MiB。')
    try {
      const value = JSON.parse(await blob.text()) as unknown
      if (!Array.isArray(value) && (value === null || typeof value !== 'object' ||
          !Array.isArray((value as { messages?: unknown }).messages))) throw new Error('JSON 缺少 messages 数组。')
      manifest = { export_format_version: EXPORT_FORMAT_VERSION }
      if (Array.isArray(value)) {
        if (value.length > MAX_IMPORT_SESSIONS) throw new Error('会话数量超过单次导入上限。')
        value.forEach((session, index) => sessionRecords.push({ path: SESSION_DIR + index + '.json', value: session }))
      } else sessionRecords.push({ path: 'chat_sessions/imported.json', value })
    } catch (error) {
      throw new Error(`无法识别的归档:${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (manifest === undefined) {
    throw new Error('归档缺少 manifest.json,不是 DeepChat v3 导出格式。')
  }
  if (manifest.export_format_version !== EXPORT_FORMAT_VERSION) {
    throw new Error(`归档格式版本不支持:${String(manifest.export_format_version)}(需要 ${EXPORT_FORMAT_VERSION})。`)
  }
  if (manifest.webchat_archive_version !== undefined && manifest.webchat_archive_version !== 1) {
    throw new Error('WebChat 归档版本不受支持。')
  }
  if (sessionRecords.length === 0) {
    throw new Error('归档中没有会话(chat_sessions/*.json)。')
  }
  if (sessionRecords.length > MAX_IMPORT_SESSIONS) {
    throw new Error(`归档包含 ${sessionRecords.length} 个会话,超过单次导入上限 ${MAX_IMPORT_SESSIONS}。`)
  }
  const sessions: ParsedSession[] = []
  for (const record of sessionRecords) {
    const value = record.value as Record<string, unknown>
    if (value === null || typeof value !== 'object' || !Array.isArray(value.messages)) {
      skipped.push({ path: record.path, reason: '会话缺少 messages 数组' })
      continue
    }
    const messages = value.messages as unknown[]
    if (messages.length > MAX_MESSAGES_PER_SESSION) {
      skipped.push({ path: record.path, reason: `会话消息数 ${messages.length} 超过上限 ${MAX_MESSAGES_PER_SESSION}` })
      continue
    }
    const parsed = validateMessages(messages, value.current_message_id)
    if (!parsed) {
      skipped.push({ path: record.path, reason: '消息内容、父节点或当前分支无效' })
      continue
    }
    sessions.push({
      id: typeof value.id === 'string' ? value.id : record.path,
      title: typeof value.title === 'string' ? value.title.slice(0, 200) : null,
      pinned: value.pinned === true,
      webchat_archived: value.webchat_archived === true,
      current_message_id: parsed.current,
      inserted_at: safeDate(value.inserted_at),
      updated_at: safeDate(value.updated_at),
      messages: parsed.ordered,
      assets: new Map([...assets].filter(([path]) => {
        const sessionPrefix = record.path.replace(/\.json$/u, '_files/')
        return path.startsWith(sessionPrefix)
      })),
    })
  }
  if (sessions.length === 0) {
    throw new Error(`归档中没有可导入的会话(${skipped.length} 条被跳过)。`)
  }
  return {
    preview: {
      formatVersion: EXPORT_FORMAT_VERSION,
      format: !isZip ? 'json' : manifest.webchat_archive_version === 1 ? 'webchat' : 'v3',
      size,
      sessions: sessions.map((session, index) => {
        const fragments = session.messages.flatMap((message) => message.fragments)
        const attachments = fragments.flatMap((fragment) => fragment.type === 'FILE' && Array.isArray(fragment.files) ? fragment.files : [])
        const available = attachments.flatMap((entry) => {
          const path = typeof entry?.export_path === 'string' ? entry.export_path.normalize('NFC') : ''
          return session.assets.has(path) ? [path] : []
        })
        return {
          index,
          id: session.id,
          title: session.title,
          messageCount: session.messages.length,
          attachmentCount: attachments.length,
          retainedAttachmentCount: new Set(available).size,
          missingAttachmentCount: attachments.length - available.length,
          unsupportedFragmentCount: fragments.filter(({ type }) => !['FILE', 'REQUEST', 'RESPONSE', 'THINK', 'TEMPLATE_RESPONSE'].includes(type)).length,
          insertedAt: session.inserted_at,
          updatedAt: session.updated_at,
        }
      }),
      skipped,
    },
    sessions,
  }
}

const allowedStatuses = new Set(['WIP', 'FINISHED', 'INCOMPLETE', 'FAILED', 'CONTENT_FILTER', 'TIMEOUT', 'CONTEXT_LENGTH_EXCEEDED'])

const safeDate = (value: unknown): string => typeof value === 'string' && Number.isFinite(Date.parse(value))
  ? iso(Date.parse(value)) : iso(0)

function validateMessages(input: unknown[], current: unknown): { ordered: ExportChatMessage[]; current: number } | undefined {
  if (!input.length) return
  const messages = new Map<number, ExportChatMessage>()
  const children = new Map<number | null, ExportChatMessage[]>()
  for (const value of input) {
    const item = value as ExportChatMessage | null
    if (!item || !Number.isSafeInteger(item.id) || item.id < 1 || messages.has(item.id)
      || (item.parent_id !== null && !Number.isSafeInteger(item.parent_id))
      || (item.role !== 'USER' && item.role !== 'ASSISTANT')
      || !allowedStatuses.has(item.status)
      || !Number.isSafeInteger(item.accumulated_token_usage) || item.accumulated_token_usage < 0
      || !Array.isArray(item.fragments) || item.fragments.length > 500
      || item.fragments.some((fragment) => !fragment || typeof fragment.type !== 'string'
        || (['REQUEST', 'RESPONSE', 'THINK', 'TEMPLATE_RESPONSE'].includes(fragment.type) && typeof fragment.content !== 'string')
        || (fragment.type === 'FILE' && !Array.isArray(fragment.files)))) return
    messages.set(item.id, item)
    const siblings = children.get(item.parent_id) ?? []
    siblings.push(item)
    children.set(item.parent_id, siblings)
  }
  const ordered = [...children.get(null) ?? []]
  for (let index = 0; index < ordered.length; index++) {
    for (const child of children.get(ordered[index]!.id) ?? []) ordered.push(child)
  }
  if (ordered.length !== messages.size) return
  const selected = current === undefined ? ordered.at(-1)!.id : current
  if (typeof selected !== 'number' || !messages.has(selected)) return
  return { ordered, current: selected }
}

export function archiveFingerprint(session: ParsedSession): string {
  return createHash('sha256').update(JSON.stringify([session.id, session.messages])).digest('hex')
}

/**
 * 将解析后的会话写入 WebChat 专用日志。
 * 仅导入 REQUEST→user 与 RESPONSE/THINK→assistant;工具/提示片段不导入。
 */
export async function importParsedSession(
  sessions: WorkspaceSessions,
  parsed: ParsedSession,
  store?: WorkspaceStore,
): Promise<{ id: string; messageCount: number }> {
  const key = sessions.newKey()
  await sessions.reserveImport(key, Date.parse(parsed.inserted_at))
  const session = await sessions.create(key)
  const copies = new Map<string, AttachmentRecord>()
  try {
    const turnBoundary = (turn: number, kind: 'start' | 'end', failed = false): void => {
      if (kind === 'start') {
        session.append('turn/start', { turn })
        session.append('step/start', { turn, step: 1 })
      } else {
        session.append('step/end', { turn, step: 1 })
        session.append('turn/end', { turn, reason: failed
          ? { kind: 'error', error: { message: '导入的历史回复未正常结束', code: 'IMPORT_INCOMPLETE' } }
          : { kind: 'completed' } })
      }
    }
    let turn = 0
    let openTurn = false
    const titleSeqs: SessionSeq[] = []
    const ids = new Map<number, string>()
    let parent: string | null = null
    for (const message of parsed.messages) {
      parent = message.parent_id === null ? null : ids.get(message.parent_id) ?? null
      let messageId: string
      if (message.role === 'USER') {
        if (openTurn) turnBoundary(turn, 'end')
        turn += 1
        turnBoundary(turn, 'start')
        openTurn = true
        const content = fragmentText(message.fragments, 'REQUEST')
        const user = createUserRecord(content)
        const event = session.append('user/message', user, { surfaceOp: 'append' })
        messageId = user.id
        titleSeqs.push(makeSeq(Number(event.seq)))
        const files = await importedFileMetadata(message.fragments, parsed.assets, copies, session.id, store)
        if (files.length) writePluginRecord(session, 'plugin:chat-workspace/attachments', {
          userMessageId: messageId, attachments: files,
        })
      } else {
        if (!openTurn) {
          turn += 1
          turnBoundary(turn, 'start')
          openTurn = true
        }
        const content = assistantContent(message.fragments)
        const reply = createAssistantRecord(content, message.webchat_model)
        messageId = reply.id
        session.append('assistant/message', {
          turn,
          step: 1,
          message: reply,
          stream: [],
          ...(message.accumulated_token_usage > 0 ? { usage: { inputTokens: 0, outputTokens: message.accumulated_token_usage, totalTokens: message.accumulated_token_usage } } : {}),
          ...(['INCOMPLETE', 'WIP'].includes(message.status) ? { interrupted: true as const } : {}),
        }, { surfaceOp: 'append' })
        turnBoundary(turn, 'end', ['FAILED', 'INCOMPLETE', 'TIMEOUT', 'CONTEXT_LENGTH_EXCEEDED'].includes(message.status))
        openTurn = false
      }
      ids.set(message.id, messageId)
      writePluginRecord(session, 'plugin:chat-workspace/imported-message', {
        id: messageId, parent, createdAt: Date.parse(safeDate(message.inserted_at)),
        thinking: message.thinking_enabled === true, search: message.search_enabled === true,
        status: message.status,
        templates: message.fragments.filter(({ type }) => type === 'TEMPLATE_RESPONSE').flatMap((fragment) =>
          typeof fragment.content === 'string' ? [fragment.content] : []),
      })
    }
    writePluginRecord(session, 'plugin:chat-workspace/branch-selection', { messageId: ids.get(parsed.current_message_id), exact: true })
    if (openTurn) turnBoundary(turn, 'end')
    if (parsed.title !== null && parsed.title.trim().length > 0 && titleSeqs.length > 0) {
      session.append('session/title', {
        title: parsed.title.trim().slice(0, 200),
        messageSeqs: titleSeqs,
        source: { kind: 'provider', provider: TITLE_PROVIDER },
      })
    }
    const fingerprint = archiveFingerprint(parsed)
    markImportRecord(session, 'deepseek-compatible-v3', parsed.messages.length)
    await sessions.flushSession(session)
    await sessions.publishImport(session.id, parsed.title, Date.parse(parsed.updated_at), parsed.pinned, fingerprint, parsed.webchat_archived)
    return { id: session.id, messageCount: parsed.messages.length }
  } catch (error) {
    // 导入失败不留半条损坏会话:隐藏并继续抛出
    await sessions.hide(session.id).catch(() => {})
    if (store) for (const copy of copies.values()) {
      await store.deleteAttachment(copy.id).catch(() => {})
      await unlink(copy.storedPath).catch(() => {})
    }
    throw error
  }
}

async function importedFileMetadata(
  fragments: ExportFragment[], assets: ArchiveAssets, copies: Map<string, AttachmentRecord>,
  sessionId: string, store?: WorkspaceStore,
) {
  const files = []
  for (const fragment of fragments) {
    if (fragment.type !== 'FILE' || !Array.isArray(fragment.files)) continue
    for (const entry of fragment.files.slice(0, 100)) {
      if (!entry || typeof entry.file_name !== 'string' || !entry.file_name) continue
      const name = entry.file_name.slice(0, 260)
      const path = typeof entry.export_path === 'string' ? entry.export_path.normalize('NFC') : ''
      const bytes = assets.get(path)
      let record = copies.get(path)
      if (bytes && !record && store) {
        record = await storeArchivedFile(store, sessionId, name, bytes)
        copies.set(path, record)
      }
      files.push(record
        ? { id: record.id, name, size: record.size, handling: 'archive-only', mimeType: record.mimeType }
        : {
          id: 'imported-' + randomUUID(), name,
          size: typeof entry.file_size === 'number' && Number.isSafeInteger(entry.file_size) ? Math.max(0, entry.file_size) : 0,
          handling: 'unavailable', mimeType: 'application/octet-stream',
        })
    }
  }
  return files
}

function fragmentText(fragments: ExportFragment[], type: string): string {
  return fragments.filter((fragment) => fragment.type === type)
    .map((fragment) => typeof fragment.content === 'string' ? fragment.content : '')
    .join('\n\n')
}

/** REQUEST → 官方 user 消息记录(dsh-llm 构造器,保证日志形状)。 */
function createUserRecord(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

function webUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4096) return
  try {
    const url = new URL(value)
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) return value
  } catch { /* 忽略归档中无法显示的来源 */ }
}

function archiveCitations(input: unknown): TextCitation[] {
  if (!Array.isArray(input)) return []
  return input.slice(0, 100).flatMap((entry) => {
    const url = webUrl(entry?.url)
    return url ? [{
      type: 'web_search_result_location', url,
      title: typeof entry.title === 'string' ? entry.title.slice(0, 300) : null,
      cited_text: typeof entry.cited_text === 'string' ? entry.cited_text.slice(0, 30_000) : '',
      encrypted_index: '',
    }] : []
  })
}

function assistantContent(fragments: ExportFragment[]) {
  const blocks: ReplyBlock[] = []
  for (const fragment of fragments) {
    if (fragment.type === 'RESPONSE' && typeof fragment.content === 'string' && fragment.content.trim()) {
      const citations = archiveCitations(fragment.webchat_citations)
      blocks.push({ type: 'text', text: fragment.content, ...(citations.length ? { citations } : {}) })
    } else if (fragment.type === 'THINK' && typeof fragment.content === 'string' && fragment.content.trim()) {
      blocks.push({ type: 'thinking', thinking: fragment.content,
        ...(typeof fragment.elapsed_secs === 'number' && fragment.elapsed_secs >= 0 ? { elapsedSeconds: fragment.elapsed_secs } : {}) })
    } else if (fragment.type === 'TOOL_SEARCH' && Array.isArray(fragment.results)) {
      const queries = (Array.isArray(fragment.queries) ? fragment.queries : [])
        .filter((value): value is string => typeof value === 'string').slice(0, 30)
      const id = 'history-' + randomUUID()
      blocks.push({
        type: 'server_tool_use', id, name: 'deepseek_web_search', caller: { type: 'direct' },
        kind: 'search', input: { action: 'search', queries },
      }, {
        type: 'web_search_tool_result', tool_use_id: id, kind: 'search',
        content: fragment.results.slice(0, 100).flatMap((item) => {
          const url = webUrl(item?.url)
          return url ? [{
            type: 'web_search_result', url, title: typeof item.title === 'string' ? item.title.slice(0, 512) : '',
            snippet: typeof item.snippet === 'string' ? item.snippet.slice(0, 8000) : '',
            site_name: typeof item.site_name === 'string' ? item.site_name.slice(0, 512) : null,
            site_icon: null, encrypted_content: '',
            page_age: typeof item.published_at === 'string' ? item.published_at.slice(0, 64) : null,
          }] : []
        }),
      })
    } else if (fragment.type === 'READ_LINK' || fragment.type === 'TOOL_OPEN') {
      const kind = fragment.type === 'READ_LINK' ? 'read_link' : 'deep_search'
      const results = Array.isArray(fragment.results) ? fragment.results.slice(0, 30) : [fragment]
      for (const item of results) {
        const url = webUrl(item?.url)
        if (!url) continue
        const id = 'history-' + randomUUID()
        const title = typeof item.title === 'string' ? item.title.slice(0, 512) : null
        blocks.push({
          type: 'server_tool_use', id, name: kind === 'read_link' ? 'deepseek_read_url' : 'deepseek_web_search',
          caller: { type: 'direct' }, kind,
          input: { action: kind === 'read_link' ? 'read_link' : 'open_page', url },
        }, {
          type: 'web_fetch_tool_result', tool_use_id: id, kind,
          content: { type: 'web_fetch_result', url, published_at: null,
            content: { type: 'document', source: { type: 'text', media_type: 'text/plain', data: '' }, title } },
          ...(kind === 'read_link' && typeof item.signature === 'string' && item.signature.length <= 256_000 && item.signature
            ? { signature: item.signature } : {}),
        })
      }
    }
  }
  return replyBlocksToDshContent(blocks.length ? blocks : [{ type: 'text', text: '' }])
}

function createAssistantRecord(content: unknown, model?: string) {
  return createAssistantMessage({
    content: content as never,
    source: { provider: 'chat-workspace-import', model: typeof model === 'string' ? model.slice(0, 300) : 'imported' },
  })
}

// ── 前情提要与交接单(R8 §4.4;deterministic,不调用模型) ──

export interface Handover {
  sessionId: string
  title: string
  goal: string
  completedTurns: number
  recentRequests: string[]
  files: string[]
  lastActivity: number
  messageCount: number
}

/** 从会话事件确定性生成前情提要(不调用模型;工具输出不混入)。 */
export function buildHandover(
  sessionId: string,
  title: string,
  events: readonly import('@deepseek-ai/dsh-session').SessionEvent[],
  attachments: readonly { name: string }[],
): Handover {
  const messages = eventsToWireMessages(events)
  const firstQuestion = messages.find((message) => message.role === 'user')
  const recentRequests = messages.filter((message) => message.role === 'user').slice(-5)
    .map((message) => message.content.slice(0, 200))
  const completedTurns = messages.filter((message) => message.role === 'assistant' && message.status === 'done').length
  return {
    sessionId,
    title,
    goal: firstQuestion !== undefined ? firstQuestion.content.slice(0, 500) : '',
    completedTurns,
    recentRequests,
    files: attachments.map((record) => record.name),
    lastActivity: events.at(-1)?.time ?? Date.now(),
    messageCount: messages.length,
  }
}

/** 交接单 → 可带到新会话的文本(用户消息;工具输出不混入)。 */
export function handoverText(handover: Handover): string {
  const lines = [
    `【前情提要 · ${handover.title}】`,
    handover.goal ? `- 会话目标:${handover.goal}` : '- 会话目标:未记录。',
    `- 已完成回复轮数:${handover.completedTurns}(共 ${handover.messageCount} 条消息)。`,
    ...(handover.recentRequests.length > 0 ? ['- 最近请求:', ...handover.recentRequests.map((request) => `  · ${request}`)] : []),
    ...(handover.files.length > 0 ? [`- 涉及文件:${handover.files.join('、')}`] : []),
  ]
  return lines.join('\n')
}

/** 会话日志写一条导入来源 plugin 记录(可追溯)。 */
export function markImportRecord(session: Session, source: string, messageCount: number): void {
  writePluginRecord(session, 'plugin:chat-workspace/import', { source, messageCount })
}
