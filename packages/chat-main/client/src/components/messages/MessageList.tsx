import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { Modal } from '../base/Modal.js'
import { useIsMobile } from '../../app/viewport.js'
import { getVisibleMessages } from '../../services/chat/branches.js'
import type { Session } from '@dsh-chat/shared'
import { closeSearchPanel } from '../search/searchPanelState.js'
import { AssistantMessage } from './AssistantMessage.js'
import { ScrollToBottomContext } from './scrollContext.js'
import { SharedSource } from '../sharing/SharedSource.js'
import sharingStyles from '../sharing/Sharing.module.css'
import { UserMessage } from './UserMessage.js'
import { BranchSwitcher } from './BranchSwitcher.js'
import { selectSessionVersion, useChatStore } from '../../store/workspace.js'
import { api } from '../../services/api.js'
import { showToast } from '../base/toastState.js'
import styles from './MessageList.module.css'

// P2: 消息分支切换 UI(BranchSwitcher + selectMessageVersion)暂不接线;
// 分支版本计算 buildMessageVersions 已随 services/chat/branches.ts 移植。
// P2: 附件上传失败重试入口(getUploadRetryId)暂不移植。

/** 距底部小于该值时视为在底部，流式内容增长时跟随 */
const STICKY_THRESHOLD = 40

export const MessageList = ({
  session,
  streaming,
  footer,
  selection,
  toggleSelection,
  navigationOpen,
  onNavigationOpenChange,
  registerOpenNavigation,
}: {
  session: Session
  streaming: boolean
  footer: React.ReactNode
  selection?: string[] | null
  toggleSelection?: (id: string) => void
  /** R8.6(11.2):定位入口移到 Composer 图标;弹层开合状态由 SessionView 提升。 */
  navigationOpen?: boolean
  onNavigationOpenChange?: (open: boolean) => void
  registerOpenNavigation?: (open: () => void) => void
}) => {
  const t = useTranslate()
  const [navigation, setNavigation] = useState<{ id: string; label: string; element: HTMLElement; level: number }[] | null>(null)
  const [messageQuery, setMessageQuery] = useState('')
  const isMobile = useIsMobile()
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const stickyRef = useRef(true)
  const scrollTopRef = useRef(0)
  const messages = getVisibleMessages(session)
  const lastMessageId = messages.at(-1)?.id
  // R8.6(修4):Rich 轮逐消息金额(Host 按 dsh-cost-meter 价表+峰谷规则计算;原生轮自带 message.cost)。
  const settledTick = useChatStore((state) => state.settledTick)
  const [richCosts, setRichCosts] = useState<Record<string, number> | null>(null)
  useEffect(() => {
    let active = true
    void api.costMessages(session.id).then((value) => {
      if (active) setRichCosts(value.available === true && value.amounts !== undefined ? value.amounts : null)
    }).catch(() => {
      if (active) setRichCosts(null)
    })
    return () => { active = false }
  }, [session.id, settledTick])
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (el && stickyRef.current) {
      el.scrollTop = el.scrollHeight
      scrollTopRef.current = el.scrollTop
    }
  }, [])

  // 内容、键盘和输入框高度变化时，继续遵循当前跟随状态。
  useLayoutEffect(() => {
    const content = contentRef.current
    const scroll = scrollRef.current
    if (!content || !scroll) {
      return
    }
    const observer = new ResizeObserver(scrollToBottom)
    observer.observe(content)
    observer.observe(scroll)
    return () => observer.disconnect()
  }, [isMobile, scrollToBottom])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    if (stickyRef.current) {
      scrollToBottom()
    } else {
      el.scrollTop = scrollTopRef.current
    }
    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_THRESHOLD
      // 仅在用户向上滚动时停止跟随底部，布局或内容增高时保持跟随状态。
      if (nearBottom) {
        stickyRef.current = true
      } else if (el.scrollTop < scrollTopRef.current) {
        stickyRef.current = false
      }
      scrollTopRef.current = el.scrollTop
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [isMobile, scrollToBottom])

  useEffect(closeSearchPanel, [session.id, lastMessageId])

  function openNavigation() {
    const nodes = new Map(Array.from(contentRef.current?.querySelectorAll<HTMLElement>('[data-chat-message]') ?? [])
      .map((node) => [node.dataset.chatMessage, node]))
    setMessageQuery('')
    setNavigation(messages.flatMap((message) => {
      const element = nodes.get(message.id)
      if (!element) return []
      const text = message.role === 'user' ? message.content || message.files.map((file) => file.name).join(', ')
        : Array.from(element.querySelectorAll('.ds-assistant-message-main-content')).map((node) => node.textContent).join(' ')
      const label = text.trim().replace(/\s+/g, ' ') || t(message.role === 'user' ? 'userMessage' : 'assistantReply')
      const headings = element.querySelectorAll<HTMLElement>(
        '.ds-assistant-message-main-content :is(h1, h2, h3, h4, h5, h6)',
      )
      return [
        { id: message.id, label, element, level: 0 },
        ...Array.from(headings, (heading, index) => ({
          id: message.id + ':' + index,
          label: heading.textContent?.trim() || '',
          element: heading,
          level: Number(heading.tagName.slice(1)),
        })).filter((entry) => entry.label),
      ]
    }))
  }

  function closeNavigation() {
    setNavigation(null)
    onNavigationOpenChange?.(false)
  }

  // R8.6(11.2):把「定位消息」入口交给 Composer 图标;每次渲染后重新登记最新闭包。
  const openNavigationRef = useRef<() => void>(() => {})
  openNavigationRef.current = openNavigation
  useEffect(() => {
    registerOpenNavigation?.(() => openNavigationRef.current())
  })

  function revealMessage(element: HTMLElement) {
    closeNavigation()
    const scroll = scrollRef.current
    if (!scroll || !element.isConnected) return
    stickyRef.current = false
    scroll.scrollTop += element.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 12
    scrollTopRef.current = scroll.scrollTop
    element.tabIndex = -1
    element.focus({ preventScroll: true })
  }

  const term = messageQuery.trim().toLocaleLowerCase()
  const navigationMatches = navigation?.filter((entry) => entry.label.toLocaleLowerCase().includes(term))
  const lastIndex = messages.length - 1
  return (
    <ScrollToBottomContext.Provider value={scrollToBottom}>
      <div ref={isMobile ? undefined : scrollRef} className={styles.container} data-webchat-messages="">
        <div ref={isMobile ? scrollRef : undefined} className={styles.scroll}>
          <div ref={contentRef} className={styles.column} data-webchat-column="">
            {messages.map((message, index) => {
              const siblings = session.versions?.[message.id]
              return <Fragment key={message.id}>
              {(message.provenance || (selection && !message.provenance)) && <div className={sharingStyles.messageLabel}>
                {message.provenance && <SharedSource source={message.provenance} />}
                {selection && !message.provenance && <label><input type="checkbox" checked={selection.includes(message.id)}
                  onChange={() => toggleSelection?.(message.id)} /> {t(message.role === 'user' ? 'userMessage' : 'assistantReply')}</label>}
              </div>}
              {message.role === 'user' ? (
                <UserMessage
                  key={message.id}
                  sessionId={session.id}
                  message={message}
                  isFirst={index === 0}
                  isLast={index === lastIndex || index === lastIndex - 1}
                  busy={streaming}
                />
              ) : (
                <AssistantMessage
                  key={message.id}
                  sessionId={session.id}
                  message={message}
                  isLast={index === lastIndex}
                  streaming={streaming && index === lastIndex}
                  busy={streaming}
                  richCost={richCosts?.[message.id]}
                />
              )}
              {siblings && <BranchSwitcher versions={{ ids: siblings, index: siblings.indexOf(message.id) }}
                disabled={streaming} onSelect={(id, anchorTop) => {
                  void selectSessionVersion(session.id, id).then(() => {
                    requestAnimationFrame(() => {
                      const anchor = Array.from(contentRef.current?.querySelectorAll('[data-message-version]') ?? [])
                        .find((node) => node.getAttribute('data-message-version') === id)
                      if (scrollRef.current && anchor) scrollRef.current.scrollTop += anchor.getBoundingClientRect().top - anchorTop
                    })
                  }).catch((error: Error) => showToast(error.message))
                }} />}
              {siblings?.some((id) => session.versionSources?.[id]) && <details className={sharingStyles.source}>
                <summary>{t('branchSourceDetails')}</summary>
                <ol>{siblings.map((id) => <li key={id}>
                  {session.versionSources?.[id] ? <SharedSource source={session.versionSources[id]!} /> : t('localSource')}
                </li>)}</ol>
              </details>}
              </Fragment>
            })}
          </div>
        </div>
        {footer}
        {(navigation !== null && navigationOpen !== false) && <Modal title={t('messageNavigation')} closable onClose={closeNavigation}>
          <input autoFocus type="search" className={styles.navigationSearch} aria-label={t('searchMessageNavigation')}
            placeholder={t('searchMessageNavigation')} value={messageQuery} onChange={(event) => setMessageQuery(event.target.value)} />
          {navigationMatches?.length ? <ul className={styles.navigationList}>
            {navigationMatches.map((entry) => <li key={entry.id}>
              <button type="button" style={{ paddingInlineStart: 8 + entry.level * 5 }} onClick={() => revealMessage(entry.element)}>
                {entry.label.length > 140 ? entry.label.slice(0, 140) + '…' : entry.label}
              </button>
            </li>)}
          </ul> : <p>{t('noMatchingMessages')}</p>}
        </Modal>}
      </div>
    </ScrollToBottomContext.Provider>
  )
}
