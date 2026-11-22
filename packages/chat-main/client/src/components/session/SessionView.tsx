import clsx from 'clsx'
import { useRef, useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import type { Session } from '@dsh-chat/shared'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MessageList } from '../messages/MessageList.js'
import { StatusBar } from './StatusBar.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './SessionView.module.css'

/** 会话页：标题栏（移动端为顶栏）+ 消息列表，输入框吸底 */
export const SessionView = ({
  session,
  streaming,
  siderCollapsed,
  embedded = false,
}: {
  session: Session
  streaming: boolean
  siderCollapsed: boolean
  embedded?: boolean
}) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const title = session.title || t('untitledChat')
  // R8.6(11.2):「定位消息」入口移入 Composer 图标;弹层在 MessageList 内渲染,开合状态在此提升。
  const [navigationOpen, setNavigationOpen] = useState(false)
  const openNavigationRef = useRef<() => void>(() => {})
  return (
    <div className={clsx(styles.view, embedded && styles.embedded)} data-webchat-session={embedded ? "embedded" : "full"}>
      {embedded ? null : isMobile ? (
        <MobileHeader title={title} />
      ) : (
        <div className={styles.header} data-webchat-header="">
          <div className={clsx(styles.title, siderCollapsed && styles.withCollapsedSider)}>
            {title}
          </div>
        </div>
      )}
      <MessageList
        session={session}
        streaming={streaming}
        navigationOpen={navigationOpen}
        onNavigationOpenChange={setNavigationOpen}
        registerOpenNavigation={(open) => { openNavigationRef.current = open }}
        footer={
          <div className={styles.inputContainer}>
            <StatusBar key={session.id} sessionId={session.id} />
            <ChatInput
              sessionId={session.id}
              navigationAvailable={session.messages.length > 0}
              onOpenNavigation={() => {
                openNavigationRef.current()
                setNavigationOpen(true)
              }}
            />
            <div className={styles.caveat}>{t('contentCaveat')}</div>
          </div>
        }
      />
    </div>
  )
}
