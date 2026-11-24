import { useState, type ReactNode } from 'react'
import type { ChatPartition, PartitionChange } from '@dsh-chat/shared'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Menu } from '../base/Menu.js'
import { IconButton } from '../base/IconButton.js'
import { IconEllipsisOutline16 } from '../base/icons.js'
import styles from './Sider.module.css'

export function PartitionNameForm({ initial = '', save, cancel }: {
  initial?: string
  save: (name: string) => Promise<boolean>
  cancel: () => void
}) {
  const t = useTranslate()
  const [name, setName] = useState(initial)
  const [saving, setSaving] = useState(false)
  return <form className={styles.partitionForm} onSubmit={(event) => {
    event.preventDefault()
    if (!name.trim() || saving) return
    setSaving(true)
    void save(name.trim()).then((ok) => { if (ok) cancel(); else setSaving(false) })
  }}>
    <input autoFocus value={name} maxLength={80} aria-label={t('partitionName')} placeholder={t('partitionName')}
      onChange={(event) => setName(event.target.value)} />
    <Button size="s" variant="outlined" type="submit" disabled={saving || !name.trim()}>{t('savePartition')}</Button>
    <Button size="s" variant="outlined" disabled={saving} onClick={cancel}>{t('cancel')}</Button>
  </form>
}

export function PartitionGroup({ partition, expanded, toggle, change, children, first, last }: {
  partition: ChatPartition | null
  expanded: boolean
  toggle: () => void
  change: (change: PartitionChange) => Promise<boolean>
  children: ReactNode
  first?: boolean
  last?: boolean
}) {
  const t = useTranslate()
  const [renaming, setRenaming] = useState(false)
  const name = partition?.name ?? t('unpartitioned')
  return <section className={styles.partition}>
    <div className={styles.partitionHeader}>
      <button type="button" className={styles.partitionToggle} aria-expanded={expanded} onClick={toggle}>
        <span aria-hidden>{expanded ? '▾' : '▸'}</span> {name}
      </button>
      {partition && <Menu options={[
        { key: 'rename', label: t('renamePartition'), icon: null, onSelect: () => setRenaming(true) },
        ...(!first ? [{ key: 'up', label: t('movePartitionUp'), icon: null, onSelect: () => void change({ action: 'reorder', id: partition.id, direction: 'up' }) }] : []),
        ...(!last ? [{ key: 'down', label: t('movePartitionDown'), icon: null, onSelect: () => void change({ action: 'reorder', id: partition.id, direction: 'down' }) }] : []),
        { key: 'delete', label: t('deletePartition'), icon: null, danger: true,
          onSelect: () => { if (window.confirm(t('confirmDeletePartition'))) void change({ action: 'delete', id: partition.id }) } },
      ]}>
        {({ toggle: open, open: shown }) => <IconButton aria-label={name + ' · ' + t('more')} aria-expanded={shown}
          icon={<IconEllipsisOutline16 />} onClick={open} />}
      </Menu>}
    </div>
    {renaming && partition && <PartitionNameForm initial={name}
      save={(value) => change({ action: 'rename', id: partition.id, name: value })} cancel={() => setRenaming(false)} />}
    {expanded && children}
  </section>
}
