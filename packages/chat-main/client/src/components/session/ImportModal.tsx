import { useRef, useState } from 'react'
import { Modal } from '../base/Modal.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import { api } from '../../services/api.js'
import { refreshSessions } from '../../store/workspace.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './ImportModal.module.css'

/**
 * R8 历史导入:DeepChat v3 ZIP 归档。
 * 流程:选择文件 → Host 校验并返回预览 → 用户勾选确认 → 官方写入路径创建新会话。
 * 导入失败不留半条损坏会话(Host 逐会话回滚隐藏)。
 */

type Preview = Awaited<ReturnType<typeof api.importPreview>>

export function ImportModal({ onClose }: { onClose: () => void }) {
  const t = useTranslate()
  const fileRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.importConfirm>> | null>(null)

  const pick = async (chosen: File) => {
    setFile(chosen)
    setPreview(null)
    setResult(null)
    setError('')
    setBusy(true)
    try {
      const value = await api.importPreview(chosen)
      setPreview(value)
      setSelected(new Set(value.sessions.filter((entry) => !entry.duplicate).map((entry) => entry.index)))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const confirm = async () => {
    if (file === null || selected.size === 0) return
    setBusy(true)
    setError('')
    try {
      const value = await api.importConfirm(file, [...selected])
      setResult(value)
      await refreshSessions()
      if (value.imported.length > 0) showToast(value.imported.length === 1 ? t('historyImportedOne') : t('historyImported', { count: value.imported.length }))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={t('importModalTitle')} onClose={() => { if (!busy) onClose() }} closable={!busy} footer={
      result === null ? (
        <>
          <Button variant="outlined" disabled={busy} onClick={() => fileRef.current?.click()}>{t('importPickArchiveFile')}</Button>
          <Button variant="outlined" disabled={busy || file === null || preview === null || selected.size === 0} onClick={() => void confirm()}>
            {t('importSelectedButton', { count: selected.size })}
          </Button>
          <Button variant="outlined" disabled={busy} onClick={onClose}>{t('close')}</Button>
        </>
      ) : (
        <Button variant="outlined" onClick={onClose}>{t('importDoneButton')}</Button>
      )
    }>
      <div className={styles.body}>
        <input ref={fileRef} type="file" accept=".zip,.json,application/zip,application/json" hidden
          onChange={(event) => {
            const chosen = event.target.files?.[0]
            if (chosen !== undefined) void pick(chosen)
            event.target.value = ''
          }} />
        {error !== '' && <p role="alert">{error}</p>}
        {busy && <p role="status">{t('importProcessing')}</p>}
        {preview !== null && result === null && (
          <>
            <p>{t('importPreviewSummary', {
              format: preview.format === 'webchat' ? 'WebChat ZIP' : preview.format === 'v3' ? 'DeepSeek / DeepChat v3 ZIP' : t('formatSessionJson'),
              count: preview.sessions.length,
              messages: preview.sessions.reduce((sum, item) => sum + item.messageCount, 0),
              attachments: preview.sessions.reduce((sum, item) => sum + item.attachmentCount, 0),
            })}</p>
            <p>{t('importArchiveSize', { size: Math.ceil(preview.size / 1024).toLocaleString(), count: preview.sessions.filter((entry) => entry.duplicate).length })}</p>
            <div className={styles.list}>
              {preview.sessions.map((entry) => (
                <label key={entry.index} className={styles.row}>
                  <input type="checkbox" checked={selected.has(entry.index)} disabled={busy || entry.duplicate}
                    onChange={(event) => {
                      setSelected((previous) => {
                        const next = new Set(previous)
                        if (event.target.checked) next.add(entry.index)
                        else next.delete(entry.index)
                        return next
                      })
                    }} />
                  <span className={styles.title}>{entry.title ?? t('importUntitledEntry')}</span>
                  <small>{entry.duplicate ? t('importEntryImportedBadge') : t('importEntryStats', { messages: entry.messageCount, attachments: entry.attachmentCount, originals: entry.retainedAttachmentCount })}</small>
                </label>
              ))}
            </div>
            {preview.skipped.length > 0 && (
              <details><summary>{t('importSkippedSummary', { count: preview.skipped.length })}</summary>
                <ul>{preview.skipped.map((item, index) => <li key={index}>{item.path}: {item.reason}</li>)}</ul>
              </details>
            )}
            <p className={styles.note}>{t('importNote')}</p>
          </>
        )}
        {result !== null && (
          <>
            <p>{t('importResultSummary', { imported: result.imported.length, duplicates: result.duplicates.length, failed: result.failures.length })}</p>
            <ul>
              {result.imported.map((entry, index) => <li key={index}>{entry.title ?? entry.id}{t('importResultEntryMessages', { count: entry.messageCount })}</li>)}
              {result.failures.map((failure, index) => <li key={`f${index}`}>{t('importFailureEntry', { index: failure.index, reason: failure.reason })}</li>)}
            </ul>
          </>
        )}
      </div>
    </Modal>
  )
}
