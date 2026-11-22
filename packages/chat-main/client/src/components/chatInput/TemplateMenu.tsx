import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { api } from '../../services/api.js'
import type { PromptTemplate } from '@dsh-chat/shared'
import { useChatStore } from '../../store/workspace.js'
import { useTranslate } from '../../i18n/index.js'
import { IconDataOutline16 } from '../base/icons.js'
import styles from './ChatInput.module.css'
import managerStyles from './TemplateManager.module.css'

/**
 * R8 模板入口:输入框左下角的紧凑图标按钮(不破坏输入框简洁性)。
 * 菜单默认向下展开(与齿轮菜单同一浮层机制,composer 贴底时自动向上翻面),
 * 支持预览/插入到草稿/插入并发送/管理。
 */

const MENU_MAX_HEIGHT = 340

/** 模板变量在页面侧的真实取值(取不到的变量由 Host 端标记为未解析)。 */
export function templateVariables(sessionId: string | null, composer?: HTMLTextAreaElement | null): { model?: string; sessionTitle?: string; workspace?: string; selection?: string } {
  const state = useChatStore.getState()
  const input = sessionId !== null ? state.input[sessionId] : state.draftInput
  const session = sessionId !== null ? state.sessionCache[sessionId] : undefined
  let selection: string | undefined
  const active = composer ?? document.activeElement
  const inComposer = active instanceof HTMLTextAreaElement && active.closest('[data-webchat-composer]') !== null
  const selectionText = inComposer ? active.value.slice(active.selectionStart, active.selectionEnd) : ''
  if (selectionText.length > 0 && selectionText.length <= 2000 && inComposer) selection = selectionText
  return {
    ...(input?.model !== undefined ? { model: `${input.channel === 'generic' && input.provider ? input.provider + '/' : ''}${input.model}` } : {}),
    ...(session?.title !== undefined && session.title !== '' && session.title !== '新对话' ? { sessionTitle: session.title } : {}),
    workspace: 'WebChat(ChatDS)',
    ...(selection !== undefined ? { selection } : {}),
  }
}

export function TemplateMenu({ sessionId, onInsert, onInsertAndSend }: {
  sessionId: string | null
  /** 插入到草稿(保留原有内容,自动补空行;不自动发送)。 */
  onInsert: (text: string) => void
  /** 解析后直接发送。 */
  onInsertAndSend: (text: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [templates, setTemplates] = useState<(PromptTemplate & { builtin?: boolean })[] | null>(null)
  const [query, setQuery] = useState('')
  const [preview, setPreview] = useState<{ template: PromptTemplate; resolved: string; unresolved: string[] } | null>(null)
  const [managing, setManaging] = useState(false)
  const t = useTranslate()
  const variables = useRef<ReturnType<typeof templateVariables>>({})
  const { anchorRef, floatingRef, position } = useAnchoredPosition<HTMLButtonElement, HTMLDivElement>(
    open, { side: 'bottom', align: 'start', maxHeight: MENU_MAX_HEIGHT },
  )
  useEffect(() => {
    if (!open) return
    void api.listPrompts().then((value) => setTemplates(value.templates), (reason: Error) => showToast(reason.message))
  }, [open])
  const close = () => {
    setOpen(false)
    anchorRef.current?.focus()
  }
  useDismiss(open, [anchorRef, floatingRef], close)

  const needle = query.trim().toLowerCase()
  const filtered = (templates ?? []).filter((template) =>
    needle.length === 0 || (template.name + ' ' + template.category + ' ' + template.summary + ' ' + template.tags.join(' ')).toLowerCase().includes(needle))

  const resolve = (template: PromptTemplate, previewOnly: boolean) => {
    void api.previewPromptVariables(template.body, variables.current).then((result) => {
      const unresolved = result.variables.filter((variable) => !variable.resolved).map((variable) => `{{${variable.name}}}`)
      close()
      if (previewOnly || unresolved.length > 0) {
        setPreview({ template, resolved: result.resolved, unresolved })
      } else {
        onInsert(result.resolved)
      }
    }, (reason: Error) => showToast(reason.message))
  }
  const insertPreview = (send: boolean) => {
    if (preview === null) return
    if (send) onInsertAndSend(preview.resolved)
    else onInsert(preview.resolved)
    setPreview(null)
  }
  const groups = new Map<string, PromptTemplate[]>()
  for (const template of filtered) {
    const category = template.category || t('templateCategoryUncategorized')
    const group = groups.get(category) ?? []
    group.push(template)
    groups.set(category, group)
  }

  return <>
    <button type="button" ref={anchorRef} className={styles.gearTrigger} aria-label={t('templateMenuLabel')}
      aria-haspopup="menu" aria-expanded={open} title={t('templateMenuLabel')}
      onClick={() => {
        if (open) close()
        else {
          variables.current = templateVariables(sessionId, anchorRef.current?.closest('[data-webchat-composer]')?.querySelector('textarea'))
          setOpen(true)
        }
      }}><IconDataOutline16 /></button>
    {open && createPortal(
      <div ref={floatingRef} aria-label={t('templateMenuLabel')} data-composer-menu="" className={styles.composerMenu + ' ' + styles.templateMenu}
        style={position ?? { visibility: 'hidden' }}>
        <input type="search" aria-label={t('templateSearchPlaceholder')} placeholder={t('templateSearchPlaceholder')} value={query}
          onChange={(event) => setQuery(event.target.value)} />
        {templates === null ? <p role="status">{t('templateLoading')}</p> : null}
        {templates !== null && filtered.length === 0 ? <p role="status">{templates.length === 0 ? t('templateEmptyNone') : t('templateNoMatch')}</p> : null}
        {[...groups].map(([category, items]) => <section key={category}>
          <h3>{category}</h3>
          {items.map((template) => <div key={template.id} className={styles.templateRow}>
            <button type="button" className={styles.templateMain} title={template.name}
              onClick={() => resolve(template, false)}>
              <strong>{template.name}</strong>
              {template.summary && <small title={template.summary}>{template.summary}</small>}
            </button>
            <button type="button" className={styles.templateMore} title={t('templatePreviewTooltip')}
              aria-label={t('templatePreviewName', { name: template.name })} onClick={() => resolve(template, true)}>⋯</button>
          </div>)}
        </section>)}
        <div>
          <button type="button" onClick={() => { close(); setManaging(true) }}>{t('templateManageOpen')}</button>
        </div>
      </div>, document.body,
    )}
    {preview !== null && <Modal title={t('templatePreviewTitle', { name: preview.template.name })} onClose={() => setPreview(null)} closable>
      <div className={managerStyles.previewBody}>
        {preview.unresolved.length > 0 && <p role="alert" className={managerStyles.unresolved}>
          {t('templateUnresolvedVars', { vars: preview.unresolved.join('、') })}
        </p>}
        <pre>{preview.resolved}</pre>
        <div className={managerStyles.previewActions}>
          <button type="button" className={managerStyles.primary} onClick={() => insertPreview(false)}>{t('templateInsertDraft')}</button>
          <button type="button" onClick={() => insertPreview(true)}>{t('templateInsertAndSend')}</button>
        </div>
      </div>
    </Modal>}
    {managing && <TemplateManagerModal onClose={() => setManaging(false)} />}
  </>
}

/** 模板管理弹窗(完整 CRUD;与原生设置页共用 Host 路由)。 */
export function TemplateManagerModal({ onClose }: { onClose: () => void }) {
  const [templates, setTemplates] = useState<(PromptTemplate & { builtin?: boolean })[] | null>(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Partial<PromptTemplate> & { id?: string } | null>(null)
  const [query, setQuery] = useState('')
  const t = useTranslate()
  const reload = () => {
    void api.listPrompts().then((value) => setTemplates(value.templates), (reason: Error) => setError(reason.message))
  }
  useEffect(reload, [])
  const save = async () => {
    if (editing === null) return
    try {
      const payload = { name: editing.name ?? '', category: editing.category ?? '', summary: editing.summary ?? '', body: editing.body ?? '', tags: editing.tags ?? [] }
      if (editing.id !== undefined) await api.updatePrompt(editing.id, payload)
      else await api.createPrompt(payload)
      setEditing(null)
      reload()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  const needle = query.trim().toLowerCase()
  const filtered = (templates ?? []).filter((template) =>
    needle.length === 0 || (template.name + ' ' + template.category + ' ' + template.tags.join(' ')).toLowerCase().includes(needle))
  return <Modal title={t('templateManagerTitle')} onClose={onClose} closable>
    <div className={managerStyles.manager}>
      {error !== '' && <p role="alert">{error}</p>}
      <div className={managerStyles.toolbar}>
        <input type="search" placeholder={t('templateSearchPlaceholder')} value={query} onChange={(event) => setQuery(event.target.value)} />
        <button type="button" className={managerStyles.primary} onClick={() => setEditing({ name: '', category: '', summary: '', body: '', tags: [] })}>{t('templateNew')}</button>
      </div>
      {templates === null ? <p role="status">{t('templateManagerLoading')}</p> : null}
      {editing !== null ? <div className={managerStyles.editor}>
        <label>{t('templateFieldName')}<input value={editing.name ?? ''} onChange={(event) => setEditing({ ...editing, name: event.target.value })} /></label>
        <label>{t('templateFieldCategory')}<input value={editing.category ?? ''} onChange={(event) => setEditing({ ...editing, category: event.target.value })} /></label>
        <label>{t('templateFieldSummary')}<input value={editing.summary ?? ''} onChange={(event) => setEditing({ ...editing, summary: event.target.value })} /></label>
        <label>{t('templateFieldTags')}<input value={(editing.tags ?? []).join(', ')} onChange={(event) => setEditing({ ...editing, tags: event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean) })} /></label>
        <label>{t('templateFieldBody')}<textarea value={editing.body ?? ''} rows={8}
          onChange={(event) => setEditing({ ...editing, body: event.target.value })} />
        </label>
        <div className={managerStyles.editorActions}>
          <button type="button" className={managerStyles.primary} disabled={!editing.name?.trim() || !editing.body?.trim()} onClick={() => void save()}>{t('templateSave')}</button>
          <button type="button" onClick={() => setEditing(null)}>{t('cancel')}</button>
        </div>
      </div> : null}
      <div className={managerStyles.list}>
        {filtered.map((template) => <div key={template.id} className={managerStyles.row}>
          <div className={managerStyles.rowMain}>
            <strong>{template.name}</strong>
            {template.category !== '' && <span className={managerStyles.category}>{template.category}</span>}
            {template.builtin === true && <span className={managerStyles.category}>{t('templateBuiltinBadge')}</span>}
            <small>{template.summary}</small>
          </div>
          <button type="button" onClick={() => setEditing({ ...template })}>{t('templateEdit')}</button>
          <button type="button" onClick={() => {
            void api.createPrompt({ name: t('templateCopyName', { name: template.name }), category: template.category, summary: template.summary, body: template.body, tags: template.tags })
              .then(reload, (reason: Error) => showToast(reason.message))
          }}>{t('copy')}</button>
          <button type="button" onClick={() => {
            if (!window.confirm(t('templateDeleteConfirm', { name: template.name }))) return
            void api.deletePrompt(template.id).then(reload, (reason: Error) => showToast(reason.message))
          }}>{t('delete')}</button>
        </div>)}
        {templates !== null && filtered.length === 0 ? <p role="status">{t('templateNoMatch')}</p> : null}
      </div>
    </div>
  </Modal>
}
