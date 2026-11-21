import { useRef, useState } from 'react'
import { Modal } from '../base/Modal.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import { api } from '../../services/api.js'
import { refreshSessions } from '../../store/workspace.js'
import styles from './ImportModal.module.css'

/**
 * R8 历史导入:DeepChat v3 ZIP 归档。
 * 流程:选择文件 → Host 校验并返回预览 → 用户勾选确认 → 官方写入路径创建新会话。
 * 导入失败不留半条损坏会话(Host 逐会话回滚隐藏)。
 */

type Preview = Awaited<ReturnType<typeof api.importPreview>>

export function ImportModal({ onClose }: { onClose: () => void }) {
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
      if (value.imported.length > 0) showToast(`已导入 ${value.imported.length} 个会话`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="导入聊天记录" onClose={() => { if (!busy) onClose() }} closable={!busy} footer={
      result === null ? (
        <>
          <Button variant="outlined" disabled={busy} onClick={() => fileRef.current?.click()}>选择归档文件…</Button>
          <Button variant="outlined" disabled={busy || file === null || preview === null || selected.size === 0} onClick={() => void confirm()}>
            导入所选({selected.size})
          </Button>
          <Button variant="outlined" disabled={busy} onClick={onClose}>关闭</Button>
        </>
      ) : (
        <Button variant="outlined" onClick={onClose}>完成</Button>
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
        {busy && <p role="status">处理中…</p>}
        {preview !== null && result === null && (
          <>
            <p>{preview.format === 'webchat' ? 'WebChat ZIP' : preview.format === 'v3' ? 'DeepSeek / DeepChat v3 ZIP' : '会话 JSON'} · {preview.sessions.length} 个会话 · {preview.sessions.reduce((sum, item) => sum + item.messageCount, 0)} 条消息 · {preview.sessions.reduce((sum, item) => sum + item.attachmentCount, 0)} 个附件</p>
            <p>归档大小 {Math.ceil(preview.size / 1024).toLocaleString()} KB · {preview.sessions.filter((entry) => entry.duplicate).length} 个重复会话</p>
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
                  <span className={styles.title}>{entry.title ?? '(无标题)'}</span>
                  <small>{entry.duplicate ? '已导入' : `${entry.messageCount} 条消息 · ${entry.attachmentCount} 个附件（${entry.retainedAttachmentCount} 个原件）`}</small>
                </label>
              ))}
            </div>
            {preview.skipped.length > 0 && (
              <details><summary>跳过的条目({preview.skipped.length})</summary>
                <ul>{preview.skipped.map((item, index) => <li key={index}>{item.path}: {item.reason}</li>)}</ul>
              </details>
            )}
            <p className={styles.note}>导入会创建新会话并跳过重复项。ZIP 有原件时保留本地副本，点击附件卡片可下载。需要向模型引用时，请重新添加附件。部分工具数据和费用明细可能无法恢复。</p>
          </>
        )}
        {result !== null && (
          <>
            <p>已导入 {result.imported.length} 个会话，跳过 {result.duplicates.length} 个重复项，{result.failures.length} 个失败。</p>
            <ul>
              {result.imported.map((entry, index) => <li key={index}>{entry.title ?? entry.id}({entry.messageCount} 条)</li>)}
              {result.failures.map((failure, index) => <li key={`f${index}`}>失败 #{failure.index}: {failure.reason}</li>)}
            </ul>
          </>
        )}
      </div>
    </Modal>
  )
}
