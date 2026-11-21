import { useEffect, useState } from 'react'
import { Modal } from '../base/Modal.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import { api } from '../../services/api.js'
import { createSession, queueDraftText, useChatStore } from '../../store/workspace.js'
import styles from './HandoverModal.module.css'

/**
 * R8 前情提要 / 交接单(确定性生成,不调用模型)。
 * 展示会话目标/已完成/最近请求/涉及文件;可复制交接单或带去新会话
 * (带去新会话经官方 createSession 接口,把交接单文本放入草稿,不自动发送)。
 */

interface HandoverView {
  sessionId: string
  title: string
  goal: string
  completedTurns: number
  recentRequests: string[]
  files: string[]
  lastActivity: number
  messageCount: number
  text: string
}

export function HandoverModal({ sessionId, title, onClose }: { sessionId: string; title: string; onClose: () => void }) {
  const [handover, setHandover] = useState<HandoverView | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void api.handover(sessionId).then((value) => {
      if (active) setHandover(value)
    }, (reason: Error) => {
      if (active) setError(reason.message)
    })
    return () => { active = false }
  }, [sessionId])

  const bringToNewSession = async () => {
    if (handover === null) return
    try {
      const id = await createSession()
      // 交接单放入新会话草稿(store 队列;Input 挂载时读取;不自动发送)
      queueDraftText(id, handover.text)
      showToast('交接单已放入新会话草稿')
      onClose()
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : String(reason))
    }
  }

  return (
    <Modal title={`前情提要 · ${title}`} onClose={onClose} closable footer={
      <>
        <Button variant="outlined" onClick={() => {
          void navigator.clipboard.writeText(handover?.text ?? '')
            .then(() => showToast('交接单已复制'))
            .catch(() => showToast('复制失败:剪贴板不可用'))
        }}>复制交接单</Button>
        <Button variant="outlined" disabled={handover === null} onClick={() => void bringToNewSession()}>带去新会话</Button>
        <Button variant="outlined" onClick={onClose}>关闭</Button>
      </>
    }>
      <div className={styles.body}>
        {error !== '' && <p role="alert">{error}</p>}
        {handover === null && error === '' ? <p role="status">正在生成前情提要…</p> : null}
        {handover !== null && (
          <>
            <p><strong>会话目标</strong></p>
            <p className={styles.goal}>{handover.goal !== '' ? handover.goal : '未记录(会话没有用户提问)。'}</p>
            <p><strong>进度</strong></p>
            <p>已完成回复 {handover.completedTurns} 轮 · 共 {handover.messageCount} 条消息 · 最近活动 {new Date(handover.lastActivity).toLocaleString()}</p>
            {handover.recentRequests.length > 0 && (
              <>
                <p><strong>最近请求</strong></p>
                <ul>{handover.recentRequests.map((request, index) => <li key={index}>{request}</li>)}</ul>
              </>
            )}
            {handover.files.length > 0 && (
              <>
                <p><strong>涉及文件</strong></p>
                <p>{handover.files.join('、')}</p>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
