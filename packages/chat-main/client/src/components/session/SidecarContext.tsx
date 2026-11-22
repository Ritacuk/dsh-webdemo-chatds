import { useEffect, useState, type ReactNode } from 'react'
import { openSession } from '../../store/workspace.js'
import { translate, useTranslate } from '../../i18n/index.js'
import styles from './SidecarContext.module.css'

export const parentSession = new URLSearchParams(window.location.search).get('parent')

interface ParentDescription {
  checkpoints: { seq: number; time: number }[]
  unavailable?: boolean
  sessionId?: string
  selected?: number | null
  transcript?: string
}

export function SidecarContext({ children, streaming }: { children: ReactNode; streaming: boolean }) {
  const [description, setDescription] = useState<ParentDescription>()
  const [checkpoint, setCheckpoint] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const t = useTranslate()
  const path = 'api/parent?' + new URLSearchParams({ id: parentSession ?? '' })

  const refresh = async (signal?: AbortSignal, initialize = false) => {
    setBusy(true)
    setError('')
    try {
      const response = await fetch(path, { signal })
      if (!response.ok) throw new Error(translate('sidecarReadCheckpointsFailed'))
      const data = await response.json() as ParentDescription
      if (signal?.aborted) return
      if (data.unavailable) {
        setDescription(undefined)
        setError(translate('sidecarUnsafeOpen'))
        return
      }
      if (initialize && !data.sessionId) {
        const created = await fetch(path, {
          method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: '{}',
        })
        if (!created.ok) throw new Error(translate('sidecarOpenFailed'))
        const initial = await created.json() as ParentDescription
        Object.assign(data, initial)
      }
      if (signal?.aborted) return
      setDescription(data)
      setCheckpoint(String(data.selected ?? data.checkpoints[0]?.seq ?? ''))
      if (data.sessionId) await openSession(data.sessionId)
    } catch (reason) {
      if (!signal?.aborted) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (!signal?.aborted) setBusy(false)
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal, true)
    return () => controller.abort()
  }, [path])

  const sync = async (latest: boolean) => {
    setError('')
    setBusy(true)
    try {
      const response = await fetch(path, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(latest ? {} : { checkpoint: Number(checkpoint) }),
      })
      if (!response.ok) throw new Error(translate('sidecarSyncFailed'))
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return <section className={styles.layout} aria-label={t('sidecarAriaLabel')}>
    <header className={styles.bar} aria-busy={busy}>
      <strong>{t('sidecarTitle')}</strong>
      <small>{description?.sessionId ? (description.selected === null ? t('sidecarStatusWaitingCheckpoint') : t('sidecarStatusLinked')) : busy ? t('sidecarStatusOpening') : t('sidecarStatusUnavailable')}</small>
      <details className={styles.context}>
        <summary>{t('sidecarContextSummary')}</summary>
        <div className={styles.menu}>
          <label htmlFor="chatds-checkpoint">{t('sidecarCheckpointLabel')}</label>
          <select id="chatds-checkpoint" value={checkpoint} disabled={busy || streaming}
            onChange={(event) => setCheckpoint(event.target.value)}>
            {!description?.checkpoints.length && <option value="">{t('sidecarNoCheckpoints')}</option>}
            {description?.checkpoints.map(({ seq, time }) => <option key={seq} value={seq}>{new Date(time).toLocaleString()}</option>)}
          </select>
          <button type="button" disabled={busy || streaming} onClick={() => void refresh(undefined, !description?.sessionId)}>{t('sidecarRefreshCheckpoints')}</button>
          <button type="button" disabled={busy || streaming || !description?.sessionId} onClick={() => void sync(true)}>{t('sidecarSyncLatest')}</button>
          <button type="button" disabled={busy || streaming || checkpoint === ''} onClick={() => void sync(false)}>{t('sidecarSwitchCheckpoint')}</button>
          {description?.transcript && <details><summary>{t('sidecarInheritedSummary')}</summary><pre>{description.transcript}</pre></details>}
        </div>
      </details>
    </header>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {description?.sessionId && <div className={styles.conversation}>{children}</div>}
  </section>
}
