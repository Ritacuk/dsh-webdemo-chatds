import clsx from 'clsx'
import { useRef, useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import type { Session, SharingStatus } from '@dsh-chat/shared'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MessageList } from '../messages/MessageList.js'
import { StatusBar } from './StatusBar.js'
import { SharedSource } from '../sharing/SharedSource.js'
import { ShareMessagesDialog } from '../sharing/SharingDialogs.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import { api } from '../../services/api.js'
import sharingStyles from '../sharing/Sharing.module.css'
import { MobileHeader } from './MobileHeader.js'
import styles from './SessionView.module.css'

/** 会话页：标题栏（移动端为顶栏）+ 消息列表，输入框吸底 */
export const SessionView = ({
  session,
  streaming,
  siderCollapsed,
  embedded = false,
  sharing,
}: {
  session: Session
  streaming: boolean
  siderCollapsed: boolean
  embedded?: boolean
  sharing?: SharingStatus
}) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const title = session.title || t('untitledChat')
  // R8.6(11.2):「定位消息」入口移入 Composer 图标;弹层在 MessageList 内渲染,开合状态在此提升。
  const [selection, setSelection] = useState<string[] | null>(null)
  const [shareOpen, setShareOpen] = useState(false)
  const [excluding, setExcluding] = useState(false)
  const sharingEnabled = !embedded && sharing?.enabled === true
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
            {session.provenance && <SharedSource source={session.provenance} />}
          </div>
        </div>
      )}
      {(sharingEnabled || (isMobile && session.provenance)) && <div className={sharingStyles.actions}>
        {isMobile && session.provenance && <SharedSource source={session.provenance} />}
        {sharingEnabled && session.messages.length > 0 && (selection !== null ? <>
          <Button variant="outlined" size="s" onClick={() => setSelection(null)}>{t('cancel')}</Button>
          <Button variant="outlined" size="s" disabled={selection.length === 0 || streaming}
            onClick={() => setShareOpen(true)}>{t('shareToDevices')} ({selection.length})</Button>
          <Button variant="outlined" size="s" disabled={selection.length === 0 || excluding}
            onClick={() => {
              if (!window.confirm(t('confirmExcludeSharingMessages'))) return
              setExcluding(true)
              void api.sharingCommand({ action: 'exclude-add', ids: selection }).then(() => setSelection(null))
                .catch((error: Error) => showToast(error.message)).finally(() => setExcluding(false))
            }}>{t('excludeSharingMessages')}</Button>
        </> : <Button variant="outlined" size="s" disabled={streaming} onClick={() => setSelection([])}>
          {t('selectShareMessages')}
        </Button>)}
      </div>}
      {sharingEnabled && selection?.length && shareOpen ? <ShareMessagesDialog sessionId={session.id} ids={selection} peers={sharing?.peers ?? []}
        onClose={() => setShareOpen(false)} /> : null}
      <MessageList
        session={session}
        streaming={streaming}
        selection={sharingEnabled ? selection : null}
        toggleSelection={(id) => setSelection((current) => current && (current.includes(id)
          ? current.filter((selected) => selected !== id) : [...current, id]))}
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
