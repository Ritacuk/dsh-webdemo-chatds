import { useEffect, useRef, useState } from 'react'
import { useSettings } from '../../services/settings.js'
import { api } from '../../services/api.js'
import { useBridgeCopy } from './bridge-copy.js'
import styles from './SessionTools.module.css'

export function ReasoningTranslation({ sessionId, messageId, index, children }: {
  sessionId: string; messageId: string; index: number; children: React.ReactNode
}) {
  const t = useBridgeCopy()
  const locale = useSettings((state) => state.locale)
  const [options, setOptions] = useState<Awaited<ReturnType<typeof api.translationOptions>>>()
  const [text, setText] = useState<string>()
  const [showTranslation, setShowTranslation] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const request = useRef<AbortController>()
  useEffect(() => () => request.current?.abort(), [])

  const run = async (confirm: boolean) => {
    if (request.current) return
    const abort = new AbortController()
    request.current = abort
    setError('')
    setPending(true)
    try {
      if (!confirm || !options?.provider) {
        setOptions(await api.translationOptions(abort.signal))
      } else {
        const result = await api.translateReasoning({ id: sessionId, messageId, index, locale, provider: options.provider }, abort.signal)
        setText(result.text)
        setShowTranslation(true)
      }
    } catch (reason) {
      if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (!abort.signal.aborted) setPending(false)
      if (request.current === abort) request.current = undefined
    }
  }
  const cancel = () => {
    request.current?.abort()
    request.current = undefined
    setPending(false)
  }
  const toggleLabel = showTranslation
    ? t('原文', 'Original', '原文')
    : t('译文', 'Translation', '翻訳')
  return <div className={styles.translation}>
    {showTranslation ? <div className={styles.translated}>{text}</div> : children}
    {error && <div role="alert">{error}</div>}
    {options && !options.available && <div role="status">{options.reason}</div>}
    {options?.available && text === undefined && <small>{
      t('此段思考文本将由所选服务接收。', 'The selected service will receive this reasoning paragraph.', '選択したサービスにこの推論段落が送信されます。')
    } {options.provider === 'bing' ? 'Bing' : 'Google'}</small>}
    <div className={styles.buttons}>
      {pending ? <button type="button" onClick={cancel}>{t('取消', 'Cancel', 'キャンセル')}</button>
        : text !== undefined ? <button type="button" onClick={() => setShowTranslation(!showTranslation)}>{toggleLabel}</button>
          : options?.available ? <>
            <button type="button" onClick={() => void run(true)}>{t('确认并翻译', 'Confirm and translate', '確認して翻訳')}</button>
            <button type="button" onClick={() => void run(false)}>{t('刷新服务状态', 'Refresh service', 'サービスを更新')}</button>
          </>
            : <button type="button" onClick={() => void run(false)}>{t('翻译此段', 'Translate paragraph', '段落を翻訳')}</button>}
    </div>
  </div>
}
