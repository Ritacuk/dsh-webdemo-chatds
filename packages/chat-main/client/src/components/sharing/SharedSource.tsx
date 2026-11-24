import type { MessageProvenance } from '@dsh-chat/shared'
import { useTranslate } from '../../i18n/index.js'
import styles from './Sharing.module.css'

export function SharedSource({ source }: { source: MessageProvenance }) {
  const t = useTranslate()
  const created = new Date(source.createdAt).toLocaleString()
  const received = new Date(source.receivedAt).toLocaleString()
  return <small className={styles.source} title={t('deviceSourceDetails', { created, received })}>
    {t('fromDevice', { name: source.deviceName })} · <time dateTime={source.createdAt}>{created}</time>
  </small>
}
