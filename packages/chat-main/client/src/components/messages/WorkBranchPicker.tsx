import { useEffect, useState } from 'react'
import { Modal } from '../base/Modal.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import { api, pickWorkBranchDirectory } from '../../services/api.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './WorkBranchPicker.module.css'

/**
 * R8.5(F10):创建 Agent 工作分支时选择 **DSH 工作区**(workspace registry 实体),
 * 不再直接弹 Windows 目录选择器。默认选中父会话所在工作区;
 * "创建新的 DSH 工作区"才走官方目录选择器 → Host 经 workspaceRegistry.create 注册。
 */

export function WorkBranchPicker({
  sessionId, messageId, onClose, onCreated,
}: {
  sessionId: string
  messageId: string
  onClose: () => void
  onCreated: (branchSessionId: string) => void
}) {
  const t = useTranslate()
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const [reason, setReason] = useState('')
  const [workspaces, setWorkspaces] = useState<{ id: string; title?: string; path: string; sessions: number }[]>([])
  const [parentWorkspaceId, setParentWorkspaceId] = useState<string | undefined>(undefined)
  const [selected, setSelected] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    let active = true
    api.workBranchWorkspaces(sessionId)
      .then((value) => {
        if (!active) return
        if (value.available !== true) {
          setReason(value.reason ?? '')
          setState('unavailable')
          return
        }
        setWorkspaces(value.workspaces)
        setParentWorkspaceId(value.parentWorkspaceId)
        setSelected(value.parentWorkspaceId ?? value.workspaces[0]?.id ?? null)
        setState('ready')
      })
      .catch((error: Error) => {
        if (!active) return
        setReason(error.message)
        setState('unavailable')
      })
    return () => { active = false }
  }, [sessionId])

  const create = async (options: { workspaceId?: string; directory?: string }) => {
    setPending(true)
    try {
      const { sessionId: branchId } = await api.createWorkBranch(sessionId, messageId, options)
      showToast(t('workBranchCreated'))
      onCreated(branchId)
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error))
      setPending(false)
    }
  }

  const createNewWorkspace = async () => {
    try {
      const directory = await pickWorkBranchDirectory()
      if (!directory) return
      void create({ directory })
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <Modal title={t('workBranchPickerTitle')} onClose={onClose} closable footer={
      <>
        <Button variant="outlined" disabled={pending} onClick={onClose}>{t('cancel')}</Button>
        <Button disabled={pending || selected === null} onClick={() => selected !== null && void create({ workspaceId: selected })}>
          {t('workBranchPickerConfirm')}
        </Button>
      </>
    }>
      <p className={styles.description}>{t('workBranchPickerDescription')}</p>
      {state === 'loading' && <p role="status">{t('workBranchPickerLoading')}</p>}
      {state === 'unavailable' && <p role="alert">{reason || t('workBranchPickerUnavailable')}</p>}
      {state === 'ready' && (
        <div className={styles.list} role="radiogroup" aria-label={t('workBranchPickerTitle')}>
          {workspaces.length === 0 && <p className={styles.muted}>{t('workBranchPickerEmpty')}</p>}
          {workspaces.map((workspace) => {
            const isParent = workspace.id === parentWorkspaceId
            return (
              <button
                key={workspace.id}
                type="button"
                role="radio"
                aria-checked={selected === workspace.id}
                className={styles.row}
                data-selected={selected === workspace.id || undefined}
                disabled={pending}
                onClick={() => setSelected(workspace.id)}
              >
                <span className={styles.main}>
                  <span className={styles.name}>{workspace.title || workspace.path.split(/[\\/]/).pop() || workspace.path}</span>
                  {isParent && <span className={styles.badge}>{t('workBranchPickerParent')}</span>}
                </span>
                <span className={styles.path}>{workspace.path}</span>
              </button>
            )
          })}
        </div>
      )}
      <div className={styles.footerRow}>
        <button type="button" className={styles.createNew} disabled={pending} onClick={() => void createNewWorkspace()}>
          {t('workBranchPickerCreateNew')}
        </button>
      </div>
      <p className={styles.muted}>{t('workBranchPickerCreateHint')}</p>
    </Modal>
  )
}
