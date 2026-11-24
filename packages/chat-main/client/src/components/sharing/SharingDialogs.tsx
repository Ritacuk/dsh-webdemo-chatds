import { useEffect, useState } from 'react'
import type { SharingStatus, SyncSelection } from '@dsh-chat/shared'
import { useTranslate } from '../../i18n/index.js'
import { api } from '../../services/api.js'
import { closeSession, queueDraftText, readDraftText, refreshSessions, refreshVersionPath, useChatStore } from '../../store/workspace.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { SharedSource } from './SharedSource.js'
import styles from './Sharing.module.css'

interface Preview {
  messageCount: number
  blocked: number
  attachmentBytesOmitted: number
  dependencies: { messageId: string; text: string; reference: boolean }[]
  confirmation: string
}

export function useSharingPresence(sideChat: boolean) {
  const [status, setStatus] = useState<SharingStatus>({ enabled: false })
  const timestamp = status.lastSyncAt
  useEffect(() => {
    if (sideChat) return
    let closed = false
    let running = false
    const update = async () => {
      if (running) return
      running = true
      try {
        const next = await api.sharing(true)
        if (!closed) setStatus(next)
      } catch { /* Keep last confirmed status on transient errors. */ }
      finally { running = false }
    }
    void update()
    const poll = status.enabled ? window.setInterval(() => void update(), 8_000) : undefined
    const channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel('chatds:sharing')
    if (channel) channel.onmessage = () => void update()
    const focus = () => void update()
    window.addEventListener('focus', focus)
    return () => {
      closed = true
      window.removeEventListener('focus', focus)
      if (poll !== undefined) window.clearInterval(poll)
      channel?.close()
    }
  }, [sideChat, status.enabled])
  useEffect(() => {
    if (!timestamp || sideChat) return
    const active = useChatStore.getState().activeId
    void refreshSessions().catch(() => {})
    if (active && !useChatStore.getState().streaming[active]) void refreshVersionPath(active).catch(() => {})
  }, [timestamp, sideChat])
  return status
}

export function ShareMessagesDialog({ sessionId, ids, peers, onClose }: {
  sessionId: string
  ids: string[]
  peers: NonNullable<SharingStatus['peers']>
  onClose: () => void
}) {
  const t = useTranslate()
  const [recipients, setRecipients] = useState<string[]>([])
  const [context, setContext] = useState<SyncSelection['context']>('excerpt')
  const [branch, setBranch] = useState(false)
  const [preview, setPreview] = useState<Preview>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const selection: SyncSelection = {
    all: false, partitionIds: [], conversationIds: [], conversationScopeId: sessionId,
    messageIds: branch ? [] : ids, branchIds: branch ? ids : [],
    excludedIds: [], recipientDeviceIds: recipients, syncMode: 'once', context, attachmentPolicy: 'omit',
  }
  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      if (!preview) setPreview(await api.sharingCommand<Preview>({ action: 'preview', selection }))
      else {
        await api.sharingCommand({ action: 'save-policy', selection, confirmation: preview.confirmation })
        showToast(t('sharingQueued'))
        onClose()
      }
    } catch (reason) {
      setPreview(undefined)
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setBusy(false) }
  }
  return <Modal title={t('shareToDevices')} closable={!busy} onClose={() => { if (!busy) onClose() }} footer={
    <Button variant="outlined" disabled={busy || !recipients.length || preview?.messageCount === 0} onClick={() => void submit()}>
      {t(preview ? 'confirmSharing' : 'previewSharing')}
    </Button>
  }>
    <div className={styles.picker}>
      <fieldset disabled={busy}>
        <legend>{t('chooseSharingDevices')}</legend>
        {peers.map((peer) => <label key={peer.id}><input type="checkbox" checked={recipients.includes(peer.id)}
          onChange={(event) => { setPreview(undefined); setRecipients(event.target.checked
            ? [...recipients, peer.id] : recipients.filter((id) => id !== peer.id)) }} />{peer.name}</label>)}
      </fieldset>
      <fieldset disabled={busy}>
        {[['excerpt', 'sharingExcerpt'], ['complete', 'sharingContext']].map(([value, label]) =>
          <label key={value}><input type="radio" name="share-context" checked={context === value}
            onChange={() => { setContext(value as SyncSelection['context']); setPreview(undefined) }} />
            {t(label as 'sharingExcerpt' | 'sharingContext')}</label>)}
        {ids.length === 1 && <label><input type="checkbox" checked={branch}
          onChange={(event) => { setBranch(event.target.checked); if (event.target.checked) setContext('complete'); setPreview(undefined) }} />
          {t('sharingBranch')}</label>}
      </fieldset>
      {error && <p role="alert">{error}</p>}
      {preview && <>
        <p>{t('sharingSummary', { count: preview.messageCount, blocked: preview.blocked,
          size: Math.ceil(preview.attachmentBytesOmitted / 1024).toLocaleString() + ' KiB' })}</p>
        {preview.dependencies.length > 0 && <details open>
          <summary>{t('sharingDependencies')}</summary>
          <ul>{preview.dependencies.map(({ messageId, text, reference }) =>
            <li key={messageId}>{text}{reference && <small> · {t('sharingReference')}</small>}</li>)}</ul>
        </details>}
      </>}
    </div>
  </Modal>
}

export function SharedExcerptsDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslate()
  const [status, setStatus] = useState<SharingStatus>()
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void api.sharing().then((value) => { if (active) setStatus(value) }).catch((error: Error) => { if (active) setError(error.message) })
    return () => { active = false }
  }, [])
  return <Modal title={t('sharedExcerpts')} closable onClose={onClose}>
    <div className={styles.excerpts}>
      {error && <p role="alert">{error}</p>}
      {status && !status.excerpts?.length && <p>{t('noSharedExcerpts')}</p>}
      {status?.excerpts?.map((excerpt) => <article key={excerpt.eventId}>
        <SharedSource source={excerpt.source} />
        <p>{excerpt.text}</p>
        <Button size="s" variant="outlined" onClick={() => {
          queueDraftText('new', [readDraftText('new'), excerpt.text].filter(Boolean).join('\n\n'))
          closeSession()
          onClose()
        }}>{t('copyToNewChat')}</Button>
      </article>)}
    </div>
  </Modal>
}
