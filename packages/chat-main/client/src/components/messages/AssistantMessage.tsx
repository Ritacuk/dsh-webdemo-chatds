import { useTranslate } from '../../i18n/index.js'
import clsx from 'clsx'
import { memo, useEffect, useRef, useState } from 'react'
import { IconEllipsisOutline16, IconRefreshOutline16, IconWarningOutline16 } from '../base/icons.js'
import { describeReply } from '../../services/chat/describe.js'
import type { AssistantMessage as AssistantMessageType } from '@dsh-chat/shared'
import { continueReply, regenerateReply, replyCanContinue } from '../../store/workspace.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Menu, type MenuOption } from '../base/Menu.js'
import { showToast } from '../base/toastState.js'
import { api, saveDownload } from '../../services/api.js'
import { WorkBranchPicker } from './WorkBranchPicker.js'
import { Markdown } from '../markdown/Markdown.js'
import { SiteThumbnails } from '../search/SiteLogo.js'
import { toggleSearchPanel, useSearchPanel } from '../search/searchPanelState.js'
import { CopyButton } from './CopyButton.js'
import { ReplyArea } from './ReplyArea.js'
import { UsageLine } from './UsageLine.js'
import { useReplyView } from './useReplyView.js'
import styles from './AssistantMessage.module.css'

const TOP_UP_URL = 'https://platform.deepseek.com/top_up'

export const AssistantMessage = memo(function AssistantMessage({
  sessionId,
  message,
  isLast,
  streaming,
  busy,
  richCost,
}: {
  sessionId: string
  message: AssistantMessageType
  isLast: boolean
  streaming: boolean
  busy: boolean
  /** R8.6:Rich 轮金额(Host 按价表+峰谷规则计算;原生轮自带 message.cost)。 */
  richCost?: number
}) {
  const t = useTranslate()
  const utterance = useRef<SpeechSynthesisUtterance | null>(null)
  const [reading, setReading] = useState(false)
  useEffect(() => () => {
    if (utterance.current) window.speechSynthesis.cancel()
  }, [])
  const view = useReplyView(message, streaming)
  const panelEntry = useSearchPanel((state) => state.entry)
  const notice = streaming ? null : describeReply(message)
  // 安全拒绝：已下发的思考与正文按协议丢弃，只显示模板答复。
  const refused = message.stopReason === 'refusal'
  const answer = refused ? null : view.answer
  const fetchFailed = message.blocks.some((block) => block.type === 'web_fetch_tool_result' && block.content.type === 'web_fetch_tool_result_error')
  const responseText = [answer?.text, notice?.presentation === 'response' ? notice.text : null]
    .filter(Boolean)
    .join('\n\n')
  const copyText = responseText || notice?.text
  const waiting = streaming && view.steps.length === 0 && !view.answer && !message.thinking
  const summaryEntry = `${message.id}-summary`
  // R8.5(F10):工作分支改走 DSH 工作区选择器(默认父会话工作区);不再直接弹目录选择。
  const [branchPickerOpen, setBranchPickerOpen] = useState(false)
  const openBranch = (branchId: string) => {
    setBranchPickerOpen(false)
    window.parent.postMessage({ type: 'chatds:open-work-branch', sessionId: branchId }, location.origin)
  }
  const actions: MenuOption[] = [{
    key: 'work-branch', label: t('workBranchMenuOption'), icon: null,
    onSelect: () => setBranchPickerOpen(true),
  }]
  if (copyText) {
    actions.push({
      key: 'download', label: t('exportAnswer'), icon: null,
      onSelect: () => void saveDownload(new Blob([copyText + '\n'], { type: 'text/markdown;charset=utf-8' }), 'webchat-answer.md')
        .catch((error: Error) => showToast(error.message)),
    })
    if ('speechSynthesis' in window) actions.push({
      key: 'read', label: t(reading ? 'stopReading' : 'readAloudLocal'), icon: null,
      onSelect: () => {
        const speech = window.speechSynthesis
        if (utterance.current) {
          speech.cancel()
          utterance.current = null
          setReading(false)
          return
        }
        const lang = /[\u3400-\u9fff]/u.test(copyText) ? 'zh' : 'en'
        const voice = speech.getVoices().find((voice) => voice.localService && voice.lang.toLowerCase().startsWith(lang))
        if (!voice) { showToast(t('noLocalVoice')); return }
        speech.cancel()
        const request = new SpeechSynthesisUtterance(copyText
          .replace(/^`{3}[^\n]*[\s\S]*?^`{3}/gm, '').replace(/^#{1,6}\s/gm, ''))
        request.voice = voice
        request.lang = voice.lang
        const finished = () => { if (utterance.current === request) { utterance.current = null; setReading(false) } }
        request.onend = finished
        request.onerror = finished
        utterance.current = request
        setReading(true)
        speech.speak(request)
      },
    })
  }
  if (sessionId.startsWith('chatws-side-')) actions.push({
    key: 'deliver', label: t('deliverConclusionOption'), icon: null,
    onSelect: () => {
      if (window.confirm(t('deliverConclusionConfirm'))) {
        void api.deliverConclusion(sessionId, message.id)
          .then(() => showToast(t('deliverConclusionDone')))
          .catch((error: Error) => showToast(error.message))
      }
    },
  })
  return (
    <div className={styles.message} data-chat-message={message.id} data-chat-role="assistant">
      {branchPickerOpen && (
        <WorkBranchPicker sessionId={sessionId} messageId={message.id} onClose={() => setBranchPickerOpen(false)} onCreated={openBranch} />
      )}
      {refused ? null : (
        <ReplyArea
          message={message}
          view={view}
          streaming={streaming}
          hasResponse={!!responseText}
        />
      )}
      {answer ? (
        <Markdown
          className="ds-assistant-message-main-content"
          content={answer.markdown}
          loading={streaming}
          cacheKey={message.id}
          disableLink={false}
          sources={view.sources}
        />
      ) : null}
      {!streaming && message.status === 'done' && fetchFailed && !answer && !refused && (
        <p className={styles.notice} role="status">{t('toolOpenFailNoAnswer')}</p>
      )}
      {waiting ? (
        <div className={styles.waiting}>
          {[0, 1, 2].map((index) => (
            <span key={index} className={styles.waitingDot} />
          ))}
        </div>
      ) : null}
      {notice?.presentation === 'response' ? (
        <Markdown
          className="ds-assistant-message-main-content"
          content={notice.text}
          loading={false}
          cacheKey={`${message.id}-template`}
          disableLink={false}
        />
      ) : notice ? (
        <div className={styles.notice}>
          <IconWarningOutline16 />
          <span>
            {notice.text}
            {/* P2: 更换 API Key 需要设置页(settingsDialogState),暂不提供入口 */}
            {notice.action === 'topUp' ? (
              <>
                {' '}
                <a
                  className={styles.noticeAction}
                  href={TOP_UP_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t('topUp')}
                </a>
              </>
            ) : null}
          </span>
        </div>
      ) : null}
      {!streaming && !refused && view.searchResults.length > 0 ? (
        <div
          className={clsx(styles.summary, panelEntry === summaryEntry && styles.summaryActive)}
          onClick={() => toggleSearchPanel(summaryEntry, view.searchResults)}
        >
          <SiteThumbnails sources={view.searchResults} />
          <span>
            {t(
              view.searchResults.length === 1 ? 'messageSearchSummary' : 'messageSearchSummaries',
              { count: view.searchResults.length }
            )}
          </span>
        </div>
      ) : null}
      {!streaming && message.status === 'stopped' ? (
        <div className={styles.modelBadge} role="status">{t('replyStopped')}</div>
      ) : null}
      {!streaming && !refused && message.model !== null ? (
        <div className={styles.modelBadge}>模型: {String(message.model)}</div>
      ) : null}
      {!streaming && !refused ? <UsageLine message={message} richCost={richCost} /> : null}
      {streaming ? null : (
        <div className={styles.bottom}>
          {/* P2: 分支切换 UI(BranchSwitcher)暂不接线 */}
          <div className={clsx(styles.actions, isLast && styles.alwaysShow)}>
            {copyText ? <CopyButton text={copyText} /> : null}
            <IconButton
              icon={<IconRefreshOutline16 />}
              tooltip={t('regenerate')}
              tooltipPlacement="bottom"
              disabled={busy || refused}
              onClick={() => {
                void regenerateReply(sessionId, message.id)
              }}
            />
            {message.status === 'done' && !busy && !refused && (
              <Menu options={actions}>
                {({ toggle }) => <IconButton icon={<IconEllipsisOutline16 />} tooltip="消息操作" onClick={toggle} />}
              </Menu>
            )}
          </div>
          {isLast && !refused && replyCanContinue(message) ? (
            <Button
              variant="outlined"
              size="s"
              className={styles.continueButton}
              disabled={busy}
              onClick={() => {
                void continueReply(sessionId, message.id)
              }}
            >
              {t('continueGenerating')}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  )
})
