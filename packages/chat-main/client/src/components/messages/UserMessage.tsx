import clsx from 'clsx'
import { memo, useLayoutEffect, useRef, useState } from 'react'
import type { UserMessage as UserMessageType } from '@dsh-chat/shared'
import { useTranslate } from '../../i18n/index.js'
import { editMessage, removeAttachment } from '../../store/workspace.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { FileCard } from '../files/FileCard.js'
import { IconEditOutline16 } from '../base/icons.js'
import { api } from '../../services/api.js'
import { CopyButton } from './CopyButton.js'
import styles from './UserMessage.module.css'

export const UserMessage = memo(function UserMessage({
  sessionId,
  message,
  isFirst,
  isLast,
  busy,
}: {
  sessionId: string
  message: UserMessageType
  isFirst: boolean
  isLast: boolean
  /** 流式进行中禁用编辑 */
  busy: boolean
}) {
  const t = useTranslate()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.content)
  const [attachmentError, setAttachmentError] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const canSend = !busy && (draft.trim() !== '' || message.files.some((file) => !file.unavailable && !file.archivedCopy))

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (editing && textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 202)}px`
    }
  }, [editing, draft])

  const sendEdit = () => {
    if (!canSend) return
    void editMessage(sessionId, message.id, draft.trim()).then((sent) => {
      if (sent) setEditing(false)
    })
  }

  return (
    <div className={clsx(styles.container, isFirst && styles.isFirst)} data-chat-message={message.id}>
      {/* P2-F: 附件信息(文件名/大小;处理方式已在上传时展示) */}
      {message.files.length > 0 ? (
        <div className={styles.files}>
          {message.files.map((file) => (
            <FileCard key={file.id} name={file.name} size={file.size} status={file.unavailable ? 'error' : undefined}
              error={file.unavailable ? '历史附件 · 需重新上传' : undefined} onOpen={file.archivedCopy ? () => {
                setAttachmentError('')
                void api.downloadArchivedAttachment(sessionId, file.id, file.name).catch((error: Error) => setAttachmentError(error.message))
              } : undefined}
              onRemove={busy || file.unavailable || file.archivedCopy ? undefined : () => {
              setAttachmentError('')
              void removeAttachment(sessionId, file.id).catch((error: Error) => setAttachmentError(error.message))
            }} />
          ))}
        </div>
      ) : null}
      {attachmentError && <p role="alert">{attachmentError}</p>}
      {editing ? (
        <div className={styles.editor}>
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            aria-label={t('editMessage')}
            autoFocus
            rows={1}
            value={draft}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'Escape') {
                setEditing(false)
              } else if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey) {
                event.preventDefault()
                sendEdit()
              }
            }}
          />
          <div className={styles.editorActions}>
            <Button size="s" variant="outlined" onClick={() => setEditing(false)}>
              {t('cancel')}
            </Button>
            <Button size="s" disabled={!canSend} onClick={sendEdit}>
              {t('send')}
            </Button>
          </div>
        </div>
      ) : (
        <>
          {message.content ? <div className={styles.bubble}>{message.content}</div> : null}
          <div className={styles.bottom}>
            <div className={clsx(styles.actions, isLast && styles.alwaysShow)}>
              {message.content ? <CopyButton text={message.content} /> : null}
              <IconButton
                icon={<IconEditOutline16 />}
                tooltip={t('editMessage')}
                tooltipPlacement="bottom"
                disabled={busy}
                onClick={() => {
                  setDraft(message.content)
                  setEditing(true)
                }}
              />
            </div>
          </div>
        </>
      )}
    </div>
  )
})
