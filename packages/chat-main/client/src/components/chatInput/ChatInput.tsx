import clsx from 'clsx'
import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import { DragMask, useFileDrop } from './DragMask.js'
import { Modal } from '../base/Modal.js'
import { FileCard } from '../files/FileCard.js'
import { showToast } from '../base/toastState.js'
import { VoiceInput } from './VoiceInput.js'
import { TemplateMenu } from './TemplateMenu.js'
import { ImportModal } from '../session/ImportModal.js'
import {
  IconChevronDownOutline14,
  IconSendOutline16,
  IconStopFill16,
} from '../base/icons.js'
import { useIsMobile } from '../../app/viewport.js'
import {
  sendMessage,
  stopStreaming,
  takeDraftText,
  useChatStore,
  useInputState,
  updateInputState,
  uploadAttachment,
  removeAttachment,
  selectModel,
  createSession,
} from '../../store/workspace.js'
import { useTranslate } from '../../i18n/index.js'
import { api } from '../../services/api.js'
import type { WireModelEntry } from '@dsh-chat/shared'
import styles from './ChatInput.module.css'

// P2: 语音输入(VoiceButton / useVoiceInput / Spectrum)暂不移植。
// P2: 草稿服务(services/chat/drafts.ts)暂不移植,输入内容不跨会话保留。

const EMPTY_ATTACHMENTS: never[] = []

/** 输入框(P2-A):输入 + 附件预览;左下角模式/思考/搜索/本地检索;右下角模型选择与发送/停止 */
export const ChatInput = memo(function ChatInput({ sessionId }: { sessionId: string | null }) {
  // 切换目标时重建输入状态(会话偏好由 store 恢复)
  return <Input key={sessionId === null ? 'new' : `session:${sessionId}`} sessionId={sessionId} />
})

const Input = ({ sessionId }: { sessionId: string | null }) => {
  const t = useTranslate()
  const [text, setText] = useState(() => takeDraftText(sessionId ?? 'new') ?? '')
  const streaming = useChatStore(
    (state) => sessionId !== null && Object.hasOwn(state.streaming, sessionId)
  )
  const session = useChatStore((state) =>
    sessionId !== null && Object.hasOwn(state.sessionCache, sessionId)
      ? state.sessionCache[sessionId]
      : null
  )
  const models = useChatStore((state) => state.models)
  const input = useInputState(sessionId)
  const pending = useChatStore((state) =>
    sessionId !== null ? (state.pendingAttachments[sessionId] ?? EMPTY_ATTACHMENTS) : EMPTY_ATTACHMENTS
  )
  const isMobile = useIsMobile()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const creatingSession = useRef<Promise<string> | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadQueue, setUploadQueue] = useState<{ file: File; error?: string }[]>([])
  const [permissionsOpen, setPermissionsOpen] = useState(false)
  /** R8 模板「插入并发送」:先写入草稿再在下一帧自动发送。 */
  const autoSendRef = useRef(false)
  const [importOpen, setImportOpen] = useState(false)
  const [voiceOpen, setVoiceOpen] = useState(false)
  const voiceEnabled = useChatStore((state) => state.settings?.enableVoiceInput === true)
  const sendShortcut = useChatStore((state) => state.settings?.sendShortcut ?? 'enter')

  // 模板「插入并发送」:文本就绪且无上传占用时自动触发一次发送
  useEffect(() => {
    if (!autoSendRef.current) return
    if (streaming || uploading) return
    autoSendRef.current = false
    if (text.trim() !== '') {
      const cloud = pending.some((file) => file.handling === 'cloud-files-api')
      void sendMessage(session, text, input, cloud)
      setText('')
    }
  })

  const send = () => {
    if (!canSend) {
      return
    }
    // 文本由提交动作读取最新快照,不使用上一次渲染的草稿。
    const cloud = pending.some((file) => file.handling === 'cloud-files-api')
    void sendMessage(session, text, input, cloud)
    setText('')
    if (isMobile) {
      textareaRef.current?.blur()
    } else {
      textareaRef.current?.focus()
    }
  }

  const richReady = models?.richReady === true
  const searchSupported = input.channel === 'rich' && richReady
    && models?.richModels.some((entry) => entry.model === input.model && entry.capability.nativeSearch) === true
  const currentModel = input.channel === 'rich'
    ? models?.richModels.find((entry) => entry.model === input.model)
    : models?.genericProviders.find((group) => group.provider === input.provider)?.models.find((entry) => entry.model === input.model)
  // R8 白名单:当前模型被禁用时不静默切换——显著提示,禁止发送(Host 亦强制 MODEL_BLOCKED)
  const currentModelBlocked = models?.modelScope === 'whitelist' && currentModel?.enabled === false
  const efforts = currentModel?.capability.thinkingEfforts ?? []
  const canSend = !streaming && !uploading && !currentModelBlocked
    && (text.trim() !== '' || pending.some((file) => file.handling !== 'unsupported'))
  const canToggleThinking = (input.channel !== 'rich' || richReady)
    && efforts.includes('off') && efforts.some((effort) => effort !== 'off')
  const handleFiles = async (files: FileList | File[]) => {
    const selected = Array.from(files)
    if (selected.length === 0) return
    setUploading(true)
    try {
      const id = sessionId ?? await (creatingSession.current ??= createSession(input))
      setUploadQueue((queue) => [...queue.filter((item) => !selected.includes(item.file)), ...selected.map((file) => ({ file }))])
      for (const file of selected) {
        try {
          await uploadAttachment(id, file)
          setUploadQueue((queue) => queue.filter((item) => item.file !== file))
        } catch (error) {
          setUploadQueue((queue) => queue.map((item) => item.file === file
            ? { file, error: error instanceof Error ? error.message : String(error) }
            : item))
        }
      }
    } catch (error) {
      creatingSession.current = null
      showToast(error instanceof Error ? error.message : String(error))
    } finally {
      setUploading(false)
    }
  }
  const dragging = useFileDrop((files) => { void handleFiles(files) })

  return (
    // 外层仅承载布局;composer 视觉盒子由内层 .wrapper 承担。
    // 菜单展开方向由 ComposerMenu/TemplateMenu 按视口空间自适应(向下放不下即向上翻)。
    <div className={styles.safeSpaceHost}>
    <div
      className={clsx(styles.wrapper, sessionId === null ? styles.home : styles.session)}
      data-webchat-composer=""
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          textareaRef.current?.focus({ preventScroll: true })
        }
      }}
      onPaste={(event) => {
        // 粘贴图片(P2-F;仅图片文件走上传,文本走默认粘贴)
        const files = [...event.clipboardData.files].filter((file) => file.type.startsWith('image/'))
        if (files.length > 0) {
          event.preventDefault()
          void handleFiles(files)
        }
      }}
    >
      {dragging && <DragMask />}
      {currentModelBlocked && (
        <div className={styles.blockedBanner} role="alert">
          <span>当前模型已被禁用，发送已被阻止。请重新选择模型，或在 ChatDS 设置 → 模型中重新启用。</span>
        </div>
      )}
      {permissionsOpen && <Modal title="插件权限" onClose={() => setPermissionsOpen(false)}>
        <ToolPermissions sessionId={sessionId} />
      </Modal>}
      {voiceOpen && <VoiceInput onClose={() => setVoiceOpen(false)} onText={(value) => {
        setText((previous) => previous.trim() ? previous + '\n' + value : value)
        setVoiceOpen(false)
        textareaRef.current?.focus({ preventScroll: true })
      }} />}
      {importOpen && <ImportModal onClose={() => setImportOpen(false)} />}
      <div className={styles.textareaWrapper}>
        <textarea
          ref={textareaRef}
          className={styles.textarea}
          placeholder={t('chatInputPlaceholderChat')}
          rows={2}
          // 移动端不自动聚焦，避免一打开就弹出键盘
          autoFocus={!isMobile}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onMouseDown={(event) => {
            // 首次点击时手动聚焦，避免 Safari 把整个页面滚到输入框位置。
            if (isMobile && event.button === 0 && document.activeElement !== event.currentTarget) {
              event.preventDefault()
              event.currentTarget.focus({ preventScroll: true })
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing
                && (sendShortcut === 'ctrl-enter' ? event.ctrlKey || event.metaKey : !event.ctrlKey && !event.metaKey)) {
              event.preventDefault()
              send()
            }
          }}
        />
        <div className={styles.mirror} aria-hidden>
          {`${text}\n`}
        </div>
      </div>
      {/* 附件预览(P2-F):文件名/大小/处理方式;可删除 */}
      {(pending.length > 0 || uploadQueue.length > 0) && (
        <div className={styles.fileRow}>
          {pending.map((attachment) => (
            <FileCard key={attachment.id} name={attachment.name} size={attachment.size}
              status={attachment.handling === 'unsupported' ? 'error' : 'done'} error={attachment.error}
              onRemove={sessionId === null ? undefined : () => void removeAttachment(sessionId, attachment.id).catch((error: Error) => showToast(error.message))} />
          ))}
          {uploadQueue.map(({ file, error }, index) => <FileCard key={`${file.name}-${index}`} name={file.name} size={file.size}
            status={error ? 'error' : 'uploading'} error={error} onRetry={error ? () => void handleFiles([file]) : undefined}
            onRemove={error ? () => setUploadQueue((queue) => queue.filter((item) => item.file !== file)) : undefined} />)}
          {pending.some((attachment) => attachment.handling === 'cloud-files-api') &&
            <small>发送时由 DeepSeek 云端解析 PDF 或图片。文件引用可用于后续对话。</small>}
        </div>
      )}
      <div className={styles.functionRow}>
        <div className={styles.toggles}>
          <input ref={fileInputRef} type="file" multiple hidden onChange={(event) => {
            if (event.target.files) void handleFiles(event.target.files)
            event.target.value = ''
          }} />
          <TemplateMenu sessionId={sessionId}
            onInsert={(inserted) => {
              setText((current) => (current.trim().length === 0 ? inserted : `${current}\n\n${inserted}`))
              textareaRef.current?.focus({ preventScroll: true })
            }}
            onInsertAndSend={(resolved) => {
              setText((current) => (current.trim().length === 0 ? resolved : `${current}\n\n${resolved}`))
              autoSendRef.current = true
            }} />
          <ComposerMenu label="聊天设置" caption="⚙" triggerClass={styles.gearTrigger}>
            {(close) => <>
              <h3>工作模式</h3>
              <button type="button" aria-pressed={input.mode === 'chat'} onClick={() => updateInputState(sessionId, { mode: 'chat' })}>Chat</button>
              <button type="button" aria-pressed={input.mode === 'plan'} onClick={() => updateInputState(sessionId, { mode: 'plan' })}>Plan（只读）</button>
              <h3>聊天能力</h3>
              <CapabilitySwitch label="深度思考" disabled={!canToggleThinking} checked={efforts.includes(input.thinking) && input.thinking !== 'off'}
                toggle={() => updateInputState(sessionId, { thinking: input.thinking === 'off'
                  ? efforts.find((effort) => effort !== 'off') : 'off' })} />
              <CapabilitySwitch label="智能搜索" disabled={!searchSupported} checked={searchSupported && input.search}
                toggle={() => updateInputState(sessionId, { search: !input.search })} />
              <CapabilitySwitch label="本地检索" checked={input.localSearch}
                toggle={() => updateInputState(sessionId, { localSearch: !input.localSearch })} />
              <h3>附件和扩展</h3>
              <button type="button" onClick={() => { close(); fileInputRef.current?.click() }}>添加附件</button>
              {voiceEnabled && <button type="button" onClick={() => { close(); setVoiceOpen(true) }}>{t('voiceInput')}</button>}
              <button type="button" onClick={() => { close(); setPermissionsOpen(true) }}>插件权限</button>
              <button type="button" onClick={() => { close(); setImportOpen(true) }}>导入会话归档…</button>
              <button type="button" onClick={() => {
                close()
                if (window.parent !== window) window.parent.postMessage({ type: 'chatds:open-settings' }, location.origin)
                else showToast('请在 DSH 原生设置中选择 ChatDS 设置')
              }}>更多设置</button>
            </>}
          </ComposerMenu>
        </div>
        <div className={styles.right}>
          <ComposerMenu label="选择模型" align="end" triggerClass={styles.modelTrigger}
            caption={<>
              <span className={styles.modelTriggerName}>{currentModel?.name ?? input.model}</span>
              {efforts.length > 0 && <span className={styles.modelTriggerEffort}>
                {currentModel?.capability.thinkingEffortNames?.[input.thinking] ?? effortLabels[input.thinking] ?? input.thinking}
              </span>}
              <span className={styles.modelTriggerChevron}><IconChevronDownOutline14 /></span>
            </>}>
            {(close) => <ModelOptions current={currentModel} sessionId={sessionId} close={close} />}
          </ComposerMenu>
          {streaming && sessionId ? (
            <button
              type="button"
              className={styles.sendButton}
              aria-label={t('chatInputStopButtonTooltip')}
              onClick={() => {
                void stopStreaming(sessionId)
              }}
            >
              <IconStopFill16 />
            </button>
          ) : (
            <button
              type="button"
              className={clsx(styles.sendButton, !canSend && styles.disabled)}
              aria-label={t('send')}
              aria-disabled={!canSend}
              onClick={send}
            >
              <IconSendOutline16 />
            </button>
          )}
        </div>
      </div>
    </div>
    </div>
  )
}

const effortLabels: Record<string, string> = { off: '关闭', enabled: '开启', low: '低', medium: '中', high: '高', max: '最高' }

function ModelOptions({ current, sessionId, close }: { current?: WireModelEntry; sessionId: string | null; close: () => void }) {
  const catalog = useChatStore((state) => state.models)
  const input = useInputState(sessionId)
  const [pane, setPane] = useState<'root' | 'model' | 'effort'>('root')
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const effortName = (id: string) => current?.capability.thinkingEffortNames?.[id] ?? effortLabels[id] ?? id
  const efforts = current?.capability.thinkingEfforts ?? []
  // R8 白名单:whitelist 模式下仅展示 enabled !== false 的模型
  const whitelist = catalog?.modelScope === 'whitelist'
  const groups = [
    { name: 'DeepSeek Messages', provider: 'rich', models: catalog?.richModels ?? [], disabled: !catalog?.richReady },
    ...(catalog?.genericProviders ?? []).map((group) => ({ ...group, disabled: false })),
  ].map((group) => ({ ...group, models: group.models.filter((entry) =>
    (whitelist ? entry.enabled !== false : true)
    && (group.name + ' ' + entry.name + ' ' + entry.model).toLowerCase().includes(query.trim().toLowerCase())) }))
  const choices = groups.filter((group) => !group.disabled).flatMap((group) => group.models)
  const choose = (entry: WireModelEntry) => {
    void selectModel(sessionId, entry).catch(() => showToast('本次选择已生效，记忆模型设置保存失败。'))
    close()
  }
  useEffect(() => {
    const container = root.current
    const target = container?.querySelector<HTMLElement>('input, [aria-pressed="true"], button:not(:disabled)')
    target?.focus({ preventScroll: true })
  }, [pane])
  return <div ref={root} className={styles.modelOptions} onKeyDown={(event) => {
    if (event.key === 'Escape' && pane !== 'root') {
      event.stopPropagation()
      setPane('root')
    } else if (event.target instanceof HTMLInputElement && ['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) {
      event.preventDefault()
      const selected = choices[highlight]
      if (event.key === 'Enter') {
        if (selected) choose(selected)
      } else if (choices.length) {
        const next = (highlight + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length
        setHighlight(next)
        root.current?.querySelectorAll('button[data-model-choice]')[next]?.scrollIntoView({ block: 'nearest' })
      }
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const buttons = [...(root.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      if (buttons.length) {
        event.preventDefault()
        buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
      }
    }
  }}>
    {pane === 'root' && <>
      <button type="button" onClick={() => { setQuery(''); setHighlight(0); setPane('model') }}>模型 <span>{current?.name ?? input.model} ›</span></button>
      <button type="button" disabled={!efforts.length} onClick={() => setPane('effort')}>推理等级 <span>{effortName(input.thinking)} ›</span></button>
    </>}
    {pane !== 'root' && <div className={styles.paneHeader}>
      <button type="button" onClick={() => setPane('root')}>‹ {pane === 'model' ? '模型' : '推理等级'}</button>
      {pane === 'model' && <input type="search" aria-label="搜索模型" placeholder="搜索模型" value={query}
        onChange={(event) => { setQuery(event.target.value); setHighlight(0); root.current?.closest('[data-composer-menu]')?.scrollTo(0, 0) }} />}
    </div>}
    {pane === 'model' && (groups.some((group) => group.models.length) ? groups.map((group) => group.models.length > 0 && <div key={group.provider}>
      <h3>{group.name}</h3>
      {group.models.map((entry) => <button key={entry.model} type="button" disabled={group.disabled}
        title={group.disabled ? catalog?.richUnavailableReason ?? '未配置 DeepSeek 凭证' : undefined}
        data-model-choice={group.disabled ? undefined : ''}
        data-highlighted={choices[highlight] === entry ? '' : undefined}
        aria-pressed={input.channel === entry.channel && input.model === entry.model && input.provider === entry.provider}
        onClick={() => choose(entry)}>{entry.name}{group.disabled && ' · 不可用'}</button>)}
    </div>) : <p role="status">{catalog ? '没有匹配的模型' : '模型目录暂不可用'}</p>)}
    {pane === 'effort' && efforts.map((effort) => <button key={effort} type="button"
      aria-pressed={input.thinking === effort} onClick={() => { updateInputState(sessionId, { thinking: effort }); close() }}>
      {effortName(effort)}
    </button>)}
  </div>
}

function CapabilitySwitch({ label, checked, disabled, toggle }: {
  label: string; checked: boolean; disabled?: boolean; toggle: () => void
}) {
  return <button type="button" role="switch" aria-checked={checked} disabled={disabled} className={styles.capabilitySwitch}
    title={disabled ? '当前模型不支持' : undefined} onClick={toggle}>
    {label}<span className={styles.switchTrack} aria-hidden="true" />
  </button>
}

/**
 * R8 插件权限(DSH 官方工具注册表):
 * - ChatDS 本地只读工具(检索/读片段)按会话授权,仅 Plan+本地检索可用;
 * - 其他真实注册工具:全局授权(设置页)+ 会话授权双重门;执行前再次校验,
 *   写入类/未标记工具执行时需要本次确认。
 */
function ToolPermissions({ sessionId }: { sessionId: string | null }) {
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof api.toolPermissions>>>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    if (sessionId !== null) {
      void api.toolPermissions(sessionId).then((result) => { if (active) setCatalog(result) }, (reason: Error) => {
        if (active) setError(reason.message)
      })
    }
    return () => { active = false }
  }, [sessionId])
  if (sessionId === null) return <p>打开一条会话后,可以为该会话单独授权工具。</p>
  const toggle = async (name: string) => {
    if (!catalog || busy) return
    setBusy(true)
    setError('')
    const next = catalog.supported.map((tool) => tool.name === name ? { ...tool, enabled: !tool.enabled } : tool)
    try {
      await api.setToolGrants(sessionId, next.filter((tool) => tool.enabled).map((tool) => tool.name))
      setCatalog({ ...catalog, supported: next })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }
  return <div className={styles.toolPermissions}>
    {error && <p role="alert">{error}</p>}
    {catalog ? <>
      <p>ChatDS 本地只读工具(不收费):仅在兼容模型的 Plan 模式启用本地检索时可用。</p>
      {catalog.supported.map((tool) => <CapabilitySwitch key={tool.name}
        label={tool.name === 'chatds_search_files' ? '搜索授权目录' : '读取授权文件片段'}
        checked={tool.enabled} disabled={busy} toggle={() => void toggle(tool.name)} />)}
    </> : sessionId !== null ? <p role="status">正在读取本地工具权限…</p> : null}
    <p>需要审批的工具可在 DSH Agent 中使用。</p>
  </div>
}

/** 菜单浮层纵向高度上限 */
const MENU_MAX_HEIGHT = 380

/**
 * Composer 浮层菜单(R8.4 用户反馈修订):默认向下展开;composer 贴近视口底部
 * (有聊天记录的会话、Side Chat 侧栏)下方放不下时自动向上翻面,由定位钩子
 * 按空间收口高度;菜单自身独立滚动。
 */
function ComposerMenu({ label, caption, triggerClass, align = 'start', children }: {
  label: string
  caption: ReactNode
  triggerClass?: string
  align?: 'start' | 'end'
  children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const { anchorRef, floatingRef, position } = useAnchoredPosition<HTMLButtonElement, HTMLDivElement>(
    open, { side: 'bottom', align, maxHeight: MENU_MAX_HEIGHT },
  )
  const close = () => {
    setOpen(false)
    anchorRef.current?.focus()
  }
  useDismiss(open, [anchorRef, floatingRef], close)
  useEffect(() => {
    if (open) floatingRef.current?.querySelector<HTMLElement>('input, button:not(:disabled)')?.focus()
  }, [open, floatingRef])
  return <>
    <button type="button" ref={anchorRef} className={triggerClass ?? styles.menuTrigger} aria-label={label}
      aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>{caption}</button>
    {open && createPortal(
      <div ref={floatingRef} role="menu" aria-label={label} data-composer-menu="" className={styles.composerMenu}
        style={position ?? { visibility: 'hidden' }}>
        {children(close)}
      </div>, document.body,
    )}
  </>
}
