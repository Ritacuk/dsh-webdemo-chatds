import { useEffect, useState, type ReactNode } from 'react'
import { openSession } from '../../store/workspace.js'
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
  const path = 'api/parent?' + new URLSearchParams({ id: parentSession ?? '' })

  const refresh = async (signal?: AbortSignal, initialize = false) => {
    setBusy(true)
    setError('')
    try {
      const response = await fetch(path, { signal })
      if (!response.ok) throw new Error('无法读取父任务检查点。')
      const data = await response.json() as ParentDescription
      if (signal?.aborted) return
      if (data.unavailable) {
        setDescription(undefined)
        setError('这条旁聊暂时无法安全打开。原始会话已保留。')
        return
      }
      if (initialize && !data.sessionId) {
        const created = await fetch(path, {
          method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: '{}',
        })
        if (!created.ok) throw new Error('无法打开独立旁聊，请重试。')
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
      if (!response.ok) throw new Error('无法同步所选检查点。请刷新后重试。')
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return <section className={styles.layout} aria-label="Agent 旁聊">
    <header className={styles.bar} aria-busy={busy}>
      <strong>Agent 旁聊</strong>
      <small>{description?.sessionId ? (description.selected === null ? '等待父任务检查点' : '已关联父任务') : busy ? '正在打开…' : '父任务上下文暂不可用'}</small>
      <details className={styles.context}>
        <summary>上下文</summary>
        <div className={styles.menu}>
          <label htmlFor="chatds-checkpoint">已完成的父任务检查点</label>
          <select id="chatds-checkpoint" value={checkpoint} disabled={busy || streaming}
            onChange={(event) => setCheckpoint(event.target.value)}>
            {!description?.checkpoints.length && <option value="">暂无检查点</option>}
            {description?.checkpoints.map(({ seq, time }) => <option key={seq} value={seq}>{new Date(time).toLocaleString()}</option>)}
          </select>
          <button type="button" disabled={busy || streaming} onClick={() => void refresh(undefined, !description?.sessionId)}>刷新检查点</button>
          <button type="button" disabled={busy || streaming || !description?.sessionId} onClick={() => void sync(true)}>同步最新进度</button>
          <button type="button" disabled={busy || streaming || checkpoint === ''} onClick={() => void sync(false)}>切换检查点</button>
          {description?.transcript && <details><summary>继承摘要</summary><pre>{description.transcript}</pre></details>}
        </div>
      </details>
    </header>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {description?.sessionId && <div className={styles.conversation}>{children}</div>}
  </section>
}
