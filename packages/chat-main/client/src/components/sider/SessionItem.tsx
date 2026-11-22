import clsx from 'clsx'
import { memo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { IconDownloadOutline16, IconEditOutline16, IconEllipsisOutline16, IconTrashOutline16, IconDataOutline16 } from '../base/icons.js'
import { openSession, renameSession, setSessionArchived, setSessionPinned } from '../../store/workspace.js'
import type { SessionSummary } from '@dsh-chat/shared'
import { IconButton } from '../base/IconButton.js'
import { Menu } from '../base/Menu.js'
import { showToast } from '../base/toastState.js'
import { ExportModal } from '../session/ExportModal.js'
import { closeMobileSider } from './mobileSiderState.js'
import { HandoverModal } from '../session/HandoverModal.js'
import styles from './SessionItem.module.css'

export const SessionItem = memo(function SessionItem({
  session,
  active,
  onDelete,
}: {
  session: SessionSummary
  active: boolean
  onDelete: () => void
}) {
  const t = useTranslate()
  const [editing, setEditing] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [handover, setHandover] = useState(false)
  const displayTitle = session.title || t('untitledChat')

  if (editing) {
    const finish = (title: string) => {
      setEditing(false)
      if (title.trim() && title.trim() !== displayTitle) {
        void renameSession(session.id, title.trim()).catch((error: Error) => showToast(error.message))
      }
    }
    return (
      <input
        className={styles.renameInput}
        defaultValue={displayTitle}
        autoFocus
        onFocus={(event) => event.target.select()}
        onBlur={(event) => finish(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            finish(event.currentTarget.value)
          } else if (event.key === 'Escape') {
            setEditing(false)
          }
        }}
      />
    )
  }

  return (
    <div
      className={clsx(styles.item, active && styles.active)}
      onClick={() => {
        void openSession(session.id)
        closeMobileSider()
      }}
    >
      <div className={styles.title}>{displayTitle}</div>
      <div className={styles.action} onClick={(event) => event.stopPropagation()}>
        <Menu
          options={[
            {
              key: 'pin',
              label: session.pinned ? t('sessionUnpinOption') : t('sessionPinOption'),
              icon: null,
              onSelect: () => void setSessionPinned(session.id, !session.pinned).catch((error: Error) => showToast(error.message)),
            },
            {
              key: 'archive',
              label: t(session.archived ? 'restoreArchivedChat' : 'archiveChat'),
              icon: null,
              onSelect: () => void setSessionArchived(session.id, !session.archived).catch((error: Error) => showToast(error.message)),
            },
            {
              key: 'rename',
              label: t('sessionItemMenuRenameOption'),
              icon: <IconEditOutline16 />,
              onSelect: () => setEditing(true),
            },
            {
              key: 'handover',
              label: t('sessionHandoverMenuOption'),
              icon: <IconDataOutline16 />,
              onSelect: () => setHandover(true),
            },
            {
              key: 'export',
              label: t('sessionExportMenuOption'),
              icon: <IconDownloadOutline16 />,
              onSelect: () => setExporting(true),
            },
            {
              key: 'delete',
              label: t('delete'),
              icon: <IconTrashOutline16 />,
              danger: true,
              onSelect: onDelete,
            },
          ]}
        >
          {({ open, toggle }) => (
            // R8.6(修):菜单打开期间保持 ⋯ 可见(否则鼠标移开 → 行失焦 → .action 隐藏 →
            // 锚点失去盒子,浮层重定位飞到视口左上角)。data-menu-open 驱动 CSS 保持显示。
            <span data-menu-open={open ? 'true' : undefined} style={{ display: 'contents' }}>
              <IconButton icon={<IconEllipsisOutline16 />} aria-label={t('more')} aria-expanded={open} onClick={toggle} />
            </span>
          )}
        </Menu>
      </div>
      {exporting && <ExportModal sessionId={session.id} onClose={() => setExporting(false)} />}
      {handover && <HandoverModal sessionId={session.id} title={displayTitle} onClose={() => setHandover(false)} />}
    </div>
  )
})
