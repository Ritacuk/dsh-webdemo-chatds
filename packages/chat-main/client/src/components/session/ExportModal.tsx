import { useState } from 'react'
import { api } from '../../services/api.js'
import { useChatStore } from '../../store/workspace.js'
import { useTranslate } from '../../i18n/index.js'
import { Modal } from '../base/Modal.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import styles from './ImportModal.module.css'

export function ExportModal({ onClose, sessionId }: { onClose: () => void; sessionId?: string }) {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const [selected, setSelected] = useState(new Set(sessionId ? [sessionId] : []))
  const [format, setFormat] = useState<'zip' | 'json' | 'md'>('zip')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const visible = sessions.filter((session) => session.messageCount > 0 && (!sessionId || sessionId === session.id))
  const ids = visible.filter((session) => selected.has(session.id)).map((session) => session.id)

  const download = async () => {
    setBusy(true)
    setError('')
    try {
      const id = ids[0]
      const saved = ids.length === 1 && id
        ? await api.exportSession(id, `webchat-${id}.${format}`, format)
        : await api.exportSessions(ids)
      if (!saved) return
      showToast(location.protocol === 'dsh-app:' ? t('exportSavedToast') : t('exportDownloadStartedToast'))
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }
  return <Modal title={t('exportModalTitle')} onClose={() => { if (!busy) onClose() }} closable={!busy} footer={
    <Button variant="outlined" disabled={busy || !ids.length} onClick={() => void download()}>{busy ? t('exportDownloading') : t('exportAllDownload')}</Button>
  }>
    <div className={styles.body}>
      {error && <p role="alert">{error}</p>}
      {!sessionId && visible.length > 0 &&
        <Button variant="outlined" disabled={busy} onClick={() => {
          setSelected(ids.length === visible.length ? new Set() : new Set(visible.map((session) => session.id)))
          setFormat('zip')
        }}>{ids.length === visible.length ? t('exportDeselectAll') : t('exportSelectAll')}</Button>}
      {!visible.length && <p>{t('exportEmpty')}</p>}
      <div className={styles.list}>
        {visible.map((session) => <label key={session.id} className={styles.row}>
          <input type="checkbox" disabled={busy || Boolean(sessionId)} checked={selected.has(session.id)}
            onChange={(event) => {
              const next = new Set(selected)
              if (event.target.checked) next.add(session.id)
              else next.delete(session.id)
              setSelected(next)
              setFormat('zip')
            }} />
          <span className={styles.title}>{session.title}</span>
          <small>{t('exportMessageCount', { count: session.messageCount })}</small>
        </label>)}
      </div>
      {ids.length === 1 && <label>{t('exportFormatLabel')} <select disabled={busy} value={format}
        onChange={(event) => setFormat(event.target.value as typeof format)}>
        <option value="zip">{t('exportFormatZip')}</option>
        <option value="json">{t('formatSessionJson')}</option>
        <option value="md">Markdown</option>
      </select></label>}
      <p className={styles.note}>{t('exportFormatNote')}</p>
    </div>
  </Modal>
}
