import clsx from 'clsx'
import { useEffect, useMemo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { IconPanelLeftOutline16, NewChatIcon, IconEllipsisOutline16, IconDownloadOutline16 } from '../base/icons.js'
import { setSiderCollapsed } from '../../services/settings.js'
import { groupSessions } from '../../services/chat/sessionGroups.js'
import { closeSession, deleteSession, useChatStore } from '../../store/workspace.js'
import type { SessionSummary } from '@dsh-chat/shared'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Menu } from '../base/Menu.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { closeMobileSider, useMobileSider } from './mobileSiderState.js'
import { SessionItem } from './SessionItem.js'
import styles from './Sider.module.css'

/**
 * 展开的侧边栏：名称与收起按钮、开启新对话、按时间分组的会话列表；移动端放在抽屉里，收起按钮关闭抽屉。
 * P2-I: 底部设置入口打开工作区设置对话框(SettingsDialog)。
 * R8.5:与 demo 的 newChat 一致——只清空 activeId 回到欢迎页,首条消息提交才创建会话。
 */
type DataAction = (action: 'import' | 'export') => void

export const Sider = ({ mobile = false, onData }: { mobile?: boolean; onData: DataAction }) => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeId)
  const [now, setNow] = useState(Date.now)
  const [archived, setArchived] = useState(false)
  const [query, setQuery] = useState('')
  const groups = useMemo(() => {
    const term = query.trim().toLocaleLowerCase()
    const matching = sessions.filter((session) => Boolean(session.archived) === archived &&
      (!term || session.title.toLocaleLowerCase().includes(term)))
    return groupSessions(matching, now, t)
  }, [sessions, now, query, t, archived])
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  // R8.5:历史遗留的空白会话(从未发送消息)识别与一次性整理建议。只按真实消息数判断,不按标题。
  const emptySessions = useMemo(
    () => sessions.filter((session) => session.messageCount === 0 && !session.archived),
    [sessions],
  )
  const [cleanupPending, setCleanupPending] = useState(false)
  const hideEmptySessions = async () => {
    if (emptySessions.length === 0 || cleanupPending) return
    if (!window.confirm(t('emptyHistoryCleanupConfirm').replace('{count}', String(emptySessions.length)))) return
    setCleanupPending(true)
    try {
      for (const session of emptySessions) {
        await deleteSession(session.id).catch(() => {})
      }
      showToast(t('emptyHistoryCleanupDone'))
    } finally {
      setCleanupPending(false)
    }
  }

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => {
      clearTimeout(timer)
      const time = Date.now()
      setNow(time)
      const midnight = new Date(time).setHours(24, 0, 0, 0)
      timer = setTimeout(refresh, midnight - time)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refresh()
      }
    }
    refresh()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', refresh)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  return (
    <div className={clsx(styles.sider, mobile && styles.mobile)} data-webchat-sider={mobile ? "mobile" : "desktop"}>
      <div className={styles.top}>
        <div className={styles.appName} data-webchat-appname="">{t('appName')}</div>
        <Menu options={[
          { key: 'archive', label: t(archived ? 'showActiveChats' : 'showArchivedChats'), icon: null, onSelect: () => setArchived(!archived) },
          { key: 'import', label: t('historyImport'), icon: null, onSelect: () => { closeMobileSider(); onData('import') } },
          { key: 'export', label: t('exportChatHistory'), icon: <IconDownloadOutline16 />, onSelect: () => { closeMobileSider(); onData('export') } },
        ]}>
          {({ toggle }) => <IconButton icon={<IconEllipsisOutline16 />} aria-label={t('sessionListMoreActions')} onClick={toggle} />}
        </Menu>
        <IconButton
          size="m"
          icon={<IconPanelLeftOutline16 />}
          tooltip={t('collapseSiderbarButton')}
          tooltipPlacement="bottom"
          onClick={() => (mobile ? closeMobileSider() : setSiderCollapsed(true))}
        />
      </div>
      <button
        type="button"
        className={styles.newChat}
        data-webchat-newchat=""
        onClick={() => {
          setArchived(false)
          // R8.5:新对话 = 回到欢迎页(纯本地);首条消息提交才创建会话,不再产生空白历史。
          closeSession()
          closeMobileSider()
        }}
      >
        <span className={styles.newChatIcon}>
          <NewChatIcon />
        </span>
        {t('newChat')}
      </button>
      <input className={styles.search} type="search" aria-label={t('searchSessionsAria')} placeholder={t('searchSessionsPlaceholder')} data-webchat-search=""
        value={query} onChange={(event) => setQuery(event.target.value)} />
      {!archived && emptySessions.length >= 3 && (
        <button type="button" className={styles.cleanupHint} onClick={() => void hideEmptySessions()} disabled={cleanupPending}>
          {t('emptyHistoryCleanupHint').replace('{count}', String(emptySessions.length))}
        </button>
      )}
      <div className={styles.listWrap}>
        <div className={styles.list}>
          {archived && <button type="button" className={styles.newChat} onClick={() => setArchived(false)}>{t('showActiveChats')}</button>}
          {!groups.length && archived && !query.trim() && <p className={styles.empty}>{t('noArchivedChats')}</p>}
          {!groups.length && query.trim() && <p className={styles.empty}>{t('noMatchingSessions')}</p>}
          {groups.map((group) => (
            <div key={group.key} className={styles.section}>
              <div className={styles.sectionHeader}>{group.label}</div>
              {group.sessions.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  active={session.id === activeId}
                  onDelete={() => setDeleting(session)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      {deleting ? (
        <Modal
          title={t('deleteSessionModalContentTitle')}
          onClose={() => {
            if (!deletePending) {
              setDeleting(null)
            }
          }}
          footer={
            <>
              <Button variant="outlined" disabled={deletePending} onClick={() => setDeleting(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={deletePending}
                onClick={async () => {
                  setDeletePending(true)
                  try {
                    await deleteSession(deleting.id)
                    setDeleting(null)
                  } catch {
                    showToast({ key: 'sessionDeleteFailed', type: 'error' })
                  } finally {
                    setDeletePending(false)
                  }
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('deleteSessionWithFilesDescription')}
        </Modal>
      ) : null}
    </div>
  )
}

/** 移动端抽屉：浮在页面上方，点空白区域关闭。 */
export const MobileSider = ({ onData }: { onData: DataAction }) => {
  const open = useMobileSider((state) => state.open)
  if (!open) {
    return null
  }
  return (
    <>
      <div className={styles.drawerMask} onClick={closeMobileSider} />
      <div className={styles.drawer}>
        <Sider mobile onData={onData} />
      </div>
    </>
  )
}
