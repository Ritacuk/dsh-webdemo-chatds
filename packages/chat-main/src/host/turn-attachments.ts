import type { UserMessage } from '@dsh-chat/shared'
import { loadAttachment, selectSnippet } from './files.js'
import { toRichFailure, type RichGateway } from './rich.js'
import type { AttachmentRecord, WorkspaceStore } from './store.js'

export class AttachmentContextError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
  }
}

type FileAttachment = UserMessage['files'][number]

export class TurnAttachments {
  private readonly included = new Set<string>()
  private remainingText: number
  readonly records: AttachmentRecord[] = []
  hasCloud = false

  constructor(
    private readonly store: WorkspaceStore,
    private readonly gateway: RichGateway,
    private readonly sessionId: string,
    private readonly channel: 'rich' | 'generic',
    private readonly query: string,
    maxSnippetChars: number,
    private readonly signal: AbortSignal,
  ) {
    this.remainingText = maxSnippetChars
  }

  async current(message: UserMessage, ids: readonly string[], replay: boolean, allowUpload = false): Promise<UserMessage> {
    const records: AttachmentRecord[] = []
    for (const id of new Set(ids)) {
      const record = await this.store.getAttachment(id)
      if (record?.sessionId !== this.sessionId) {
        if (replay) continue
        throw new AttachmentContextError('附件已移除或不属于当前会话。', 'ATTACHMENT_NOT_FOUND')
      }
      records.push(record)
    }
    const scoped = await this.addContext(message, records, !replay && allowUpload)
    this.records.push(...records)
    return scoped
  }

  async historical(message: UserMessage): Promise<UserMessage> {
    const records: AttachmentRecord[] = []
    for (const file of message.files) {
      if (this.included.has(file.id)) continue
      const record = await this.store.getAttachment(file.id)
      if (record?.sessionId === this.sessionId && !record.archiveOnly) records.push(record)
    }
    return this.addContext(message, records, false)
  }

  private async addContext(message: UserMessage, records: readonly AttachmentRecord[], allowUpload: boolean): Promise<UserMessage> {
    const files: FileAttachment[] = []
    const notes: string[] = []
    for (const record of records) {
      this.signal.throwIfAborted()
      this.included.add(record.id)
      if (record.handling === 'cloud-files-api') {
        if (this.channel !== 'rich') {
          throw new AttachmentContextError(`“${record.name}”需要支持 DeepSeek Files API 的模型。请切换模型或移除附件。`, 'ATTACHMENT_MODEL_UNSUPPORTED')
        }
        const scope = this.gateway.fileScope()
        let reference = record.cloudReference
        if (reference?.origin !== scope.origin || reference?.credentialRef !== scope.credentialRef) {
          if (!allowUpload) {
            throw new AttachmentContextError(`“${record.name}”没有可用于当前服务的文件引用。请移除旧附件后重新添加并发送授权上传。`, 'ATTACHMENT_REFERENCE_UNAVAILABLE')
          }
          try {
            const upload = await this.gateway.uploadToFilesApi({
              name: record.name,
              bytes: () => {
                const bytes = loadAttachment(record).bytes
                if (bytes === undefined) throw new Error('missing attachment bytes')
                return bytes
              },
            }, this.signal)
            reference = { ...scope, id: upload.id }
            await this.store.putAttachment({ ...record, cloudReference: reference })
          } catch (error) {
            this.signal.throwIfAborted()
            const failure = toRichFailure(error)
            throw new AttachmentContextError(`“${record.name}”上传失败（${failure.status ?? failure.kind}）。附件仍可重试。`, 'ATTACHMENT_UPLOAD_FAILED')
          }
        }
        this.hasCloud = true
        files.push({
          id: record.id, serverId: reference.id, name: record.name, size: record.size,
          mimeType: record.mimeType, isImage: record.mimeType.startsWith('image/'),
        })
      } else if (record.handling === 'local-inline' || record.handling === 'local-extract') {
        if (this.remainingText <= 0) {
          notes.push(`【附件 ${record.name}：本轮附件文本已达上限】`)
          continue
        }
        let loaded: ReturnType<typeof loadAttachment>
        try {
          loaded = loadAttachment(record)
        } catch {
          throw new AttachmentContextError(`无法读取“${record.name}”的本地副本。请移除附件或重新添加。`, 'ATTACHMENT_UNREADABLE')
        }
        const snippet = selectSnippet(loaded.text ?? '', this.query, this.remainingText)
        this.remainingText -= snippet.content.length
        notes.push(`【附件 ${record.name}（${snippet.truncated ? '相关节选' : '全文'}）】\n${snippet.content}`)
      } else {
        throw new AttachmentContextError(`不支持附件“${record.name}”。`, 'ATTACHMENT_UNSUPPORTED')
      }
    }
    return {
      ...message,
      files,
      content: notes.length > 0 ? `${notes.join('\n\n')}\n\n---\n\n${message.content}` : message.content,
    }
  }
}
