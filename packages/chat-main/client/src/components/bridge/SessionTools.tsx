import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { ChatDSMemory, ChatPartitions, HistoryHit } from '@dsh-chat/shared'
import { api, saveDownload } from '../../services/api.js'
import { openSession, updateSettings, useChatStore } from '../../store/workspace.js'
import { Modal } from '../base/Modal.js'
import { useBridgeCopy } from './bridge-copy.js'
import styles from './SessionTools.module.css'

export function SessionTools({ feature, onClose }: { feature: 'history' | 'memory'; onClose: () => void }) {
  const t = useBridgeCopy()
  const [partitions, setPartitions] = useState<ChatPartitions['partitions']>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<Awaited<ReturnType<typeof api.historySearch>>>()
  const [memories, setMemories] = useState<ChatDSMemory[]>([])
  const [editing, setEditing] = useState<ChatDSMemory>()
  const request = useRef<AbortController>()
  const settings = useChatStore((state) => state.settings)
  const captureError = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))
  const loadMemory = () => api.listMemories().then(({ memories }) => setMemories(memories))
  useEffect(() => {
    void api.listPartitions().then((value) => setPartitions(value.partitions), captureError)
    if (feature === 'memory') void loadMemory().catch(captureError)
    return () => request.current?.abort()
  }, [feature])

  const run = (action: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    void action().catch(captureError).finally(() => setBusy(false))
  }
  const search = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    const query = String(fields.get('query') ?? '').trim()
    if (query.length < 2) return
    request.current?.abort()
    const abort = new AbortController()
    request.current = abort
    const partition = String(fields.get('partition') ?? 'all')
    const from = String(fields.get('from') ?? '')
    const to = String(fields.get('to') ?? '')
    run(async () => {
      const value = await api.historySearch({ query, partition: partition === 'all' ? undefined : partition,
        from: from ? new Date(from + 'T00:00:00').getTime() : undefined,
        to: to ? new Date(to + 'T23:59:59.999').getTime() : undefined,
      }, abort.signal)
      if (!abort.signal.aborted) setResults(value)
    })
  }
  const choose = async (hit: HistoryHit) => {
    await openSession(hit.id)
    onClose()
    if (hit.messageId) requestAnimationFrame(() => requestAnimationFrame(() => {
      document.querySelector(`[data-chat-message="${CSS.escape(hit.messageId!)}"]`)?.scrollIntoView({ block: 'center' })
    }))
  }
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const fields = new FormData(form)
    run(async () => {
      await api.saveMemory({ id: editing?.id, text: String(fields.get('text') ?? ''), category: String(fields.get('category') ?? ''),
        partition: String(fields.get('partition') ?? '') || null })
      form.reset()
      setEditing(undefined)
      await loadMemory()
    })
  }
  const scope = (value?: string) => <select name="partition" defaultValue={value ?? ''}>
    {feature === 'history' && <option value="all">{t('所有分区', 'All partitions', '全てのグループ')}</option>}
    <option value="">{feature === 'history' ? t('未分区', 'Unpartitioned', '未分類') : t('全局', 'Global', '全体')}</option>
    {partitions.map((partition) => <option key={partition.id} value={partition.id}>{partition.name}</option>)}
  </select>
  return <Modal title={feature === 'history' ? t('搜索聊天历史', 'Search chat history', 'チャット履歴を検索')
    : t('ChatDS 本地记忆', 'ChatDS local memory', 'ChatDS ローカル記憶')} closable className={styles.dialog} mainClassName={styles.body} onClose={onClose}>
    {error && <div role="alert">{error}</div>}
    {feature === 'history' ? <>
      <form className={styles.form} onSubmit={search}>
        <label>{t('关键词', 'Keyword', 'キーワード')} <input name="query" type="search" minLength={2} maxLength={160} required /></label>
        <label>{t('分区', 'Partition', 'グループ')} {scope('all')}</label>
        <label>{t('起始日', 'From', '開始日')} <input name="from" type="date" /></label>
        <label>{t('结束日', 'To', '終了日')} <input name="to" type="date" /></label>
        <button type="submit" disabled={busy}>{t('搜索', 'Search', '検索')}</button>
      </form>
      {results && <p role="status">{results.hits.length} {t('条结果', 'results', '件')}{results.truncated && ' · ' +
        t('结果已截取，请缩小范围。', 'Results limited. Narrow the search.', '検索範囲を絞ってください。')}</p>}
      <ul className={styles.results}>{results?.hits.map((hit) => <li key={hit.id + ':' + (hit.messageId ?? '')}>
        <button type="button" onClick={() => void choose(hit).catch(captureError)}>{hit.title}</button>
        {hit.excerpt && <span>{hit.excerpt}</span>}
      </li>)}</ul>
    </> : <>
      <p>{t('选用注入时，相关记忆会随消息发给当前模型。自动提炼会额外调用当前通用模型。', 'Selected memories go to the current model when injection is enabled. Auto extraction makes an additional request to the current generic model.', '注入を有効にすると関連する記憶が選択中のモデルに送信されます。自動抽出は追加のモデル呼び出しを行います。')}</p>
      <label><input type="checkbox" checked={settings?.memoryInject === true} disabled={busy}
        onChange={(event) => { const value = event.target.checked; run(() => updateSettings({ memoryInject: value })) }} />
        {t('注入相关记忆', 'Inject relevant memories', '関連記憶を注入')}</label>
      <label><input type="checkbox" checked={settings?.memoryExtract === true} disabled={busy}
        onChange={(event) => { const value = event.target.checked; run(() => updateSettings({ memoryExtract: value })) }} />
        {t('自动提炼', 'Auto extract', '自動抽出')}</label>
      <label><input type="checkbox" checked={settings?.compatTitle === true} disabled={busy}
        onChange={(event) => { const value = event.target.checked; run(() => updateSettings({ compatTitle: value })) }} />
        {t('用当前通用模型更新标题（额外请求）', 'Update titles with the current generic model (extra request)', '現在の汎用モデルでタイトルを更新（追加リクエスト）')}</label>
      <label>{t('保守注入预算（字节）', 'Conservative injection budget (bytes)', '注入上限（バイト）')} <select value={settings?.memoryBudget ?? 512} disabled={busy}
        onChange={(event) => { const value = Number(event.target.value); run(() => updateSettings({ memoryBudget: value })) }}>
        {[128, 256, 512, 1024, 2048].map((size) => <option key={size}>{size}</option>)}</select></label>
      <form key={editing?.id ?? 'new'} className={styles.form} onSubmit={save}>
        <label>{t('记忆', 'Memory', '記憶')} <textarea name="text" defaultValue={editing?.text} maxLength={600} required /></label>
        <label>{t('分类', 'Category', '分類')} <input name="category" defaultValue={editing?.category} maxLength={80} /></label>
        <label>{t('范围', 'Scope', '範囲')} {scope(editing?.partition ?? undefined)}</label>
        <button type="submit" disabled={busy}>{t('保存', 'Save', '保存')}</button>
        {editing && <button type="button" onClick={() => setEditing(undefined)}>{t('取消编辑', 'Cancel edit', '編集を中止')}</button>}
      </form>
      <div className={styles.buttons}>
        <button type="button" disabled={busy} onClick={() => run(loadMemory)}>{t('刷新', 'Refresh', '更新')}</button>
        <button type="button" disabled={busy} onClick={() => run(() => saveDownload(new Blob([JSON.stringify({ version: 1, memories }, null, 2)],
          { type: 'application/json' }), 'chatds-memories.json'))}>{t('导出备份', 'Export backup', 'バックアップを出力')}</button>
      </div>
      <ul className={styles.results}>{memories.map((item) => <li key={item.id}>
        <span>{item.text}</span>
        <small>{[item.category, partitions.find(({ id }) => id === item.partition)?.name ?? (item.partition ? t('已移除的分区', 'Removed partition', '削除済みのグループ') : t('全局', 'Global', '全体')),
          item.source ?? t('手动录入', 'Manual entry', '手動入力'), new Date(item.updatedAt).toLocaleDateString()].filter(Boolean).join(' · ')}</small>
        <div className={styles.buttons}>
          <button type="button" disabled={busy} onClick={() => setEditing(item)}>{t('编辑', 'Edit', '編集')}</button>
          <button type="button" disabled={busy} onClick={() => run(async () => { await api.deleteMemory(item.id); await loadMemory() })}>
            {t('删除', 'Delete', '削除')}</button>
        </div>
      </li>)}</ul>
    </>}
  </Modal>
}
