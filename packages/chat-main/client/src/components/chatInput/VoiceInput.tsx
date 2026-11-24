import { useEffect, useRef, useState } from 'react'
import { useChatDesign } from '../../services/chatDesign.js'
import { api } from '../../services/api.js'
import { startRecording, type Recording } from '../../services/speech/recorder.js'
import { Modal } from '../base/Modal.js'
import { Button } from '../base/Button.js'
import { useTranslate } from '../../i18n/index.js'

type Stage = 'idle' | 'starting' | 'recording' | 'ready' | 'sending'

interface BridgeResult {
  ok: boolean
  blob?: Blob
  name?: string
  cancelled?: boolean
}

/**
 * R8.6(修2):语音输入 = 顶层采集桥(优先)或本地直采(官方 demo 链路)。
 * 现象:DSH 原生语音在顶层页面录音正常,但 WebChat iframe 内 getUserMedia 得到 NotAllowedError
 * (Desktop 的权限处理只放行顶层媒体请求)。桥接:顶层(与 DSH 原生语音同权限)录音 →
 * WAV Blob postMessage 回传 → 走同一条转写链路;只同源、单任务、音量回传、停止/取消/卸载即释放设备。
 * 本地直采保留给无 shell 的独立页面;错误按类型分类,不循环弹窗、不自动重试。
 */
export function VoiceInput({ localEngine, onText, onClose }: { localEngine?: boolean; onText: (text: string) => void; onClose: () => void }) {
  const t = useTranslate()
  const [stage, setStage] = useState<Stage>('idle')
  const [error, setError] = useState('')
  const [level, setLevel] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const recording = useRef<Recording | null>(null)
  const audio = useRef<Blob | null>(null)
  const controller = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  const [bridge, setBridge] = useState<boolean | null>(null)
  const bridgeRef = useRef<boolean | null>(null)
  bridgeRef.current = bridge
  const bridgeRequest = useRef<string | null>(null)
  const bridgeResult = useRef<(value: BridgeResult) => void>(() => {})

  // 桥接探测 + 桥接事件接收(只认顶层同源消息)。
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== location.origin || window.parent === window || event.source !== window.parent) return
      const data = event.data as { type?: string; available?: boolean; requestId?: string; level?: number; ok?: boolean; blob?: Blob; name?: string }
      if (data.type === 'chatds:voice-bridge-ready') {
        setBridge(data.available === true)
      } else if (data.type === 'chatds:voice-level' && data.requestId === bridgeRequest.current) {
        setLevel(Number.isFinite(data.level) ? Number(data.level) : 0)
      } else if (data.type === 'chatds:voice-capture-result' && data.requestId === bridgeRequest.current) {
        bridgeRequest.current = null
        bridgeResult.current({ ok: data.ok === true, blob: data.blob, name: data.name })
      } else if (data.type === 'chatds:voice-capture-cancelled' && data.requestId === bridgeRequest.current) {
        bridgeRequest.current = null
        bridgeResult.current({ ok: false, cancelled: true })
      }
    }
    window.addEventListener('message', onMessage)
    if (window.parent !== window) window.parent.postMessage({ type: 'chatds:voice-bridge-query' }, location.origin)
    // 老版本 shell 不应答 → 700ms 后按无桥处理(走 iframe 直采兜底)。
    const fallback = window.setTimeout(() => setBridge((current) => current ?? false), 700)
    return () => { window.removeEventListener('message', onMessage); window.clearTimeout(fallback) }
  }, [])

  // 录音计时(含 120s 上限提示)。
  useEffect(() => {
    if (stage !== 'recording' && stage !== 'starting') {
      setElapsed(0)
      return
    }
    const started = Date.now()
    const timer = window.setInterval(() => { setElapsed(Math.floor((Date.now() - started) / 1000)) }, 500)
    return () => window.clearInterval(timer)
  }, [stage])

  // 卸载:释放一切(本地录音取消 / 桥接录音取消)。
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      recording.current?.cancel()
      controller.current?.abort()
      recording.current = null
      audio.current = null
      if (bridgeRequest.current !== null) {
        window.parent.postMessage({ type: 'chatds:voice-capture-cancel', requestId: bridgeRequest.current }, location.origin)
        bridgeRequest.current = null
      }
    }
  }, [])

  const classifyMicError = (name: string): string => {
    if (name === 'NotAllowedError' || name === 'SecurityError') return t('voiceMicDenied')
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return t('voiceMicNotFound')
    if (name === 'NotReadableError') return t('voiceMicBusy')
    if (name === 'BusyError') return t('voiceRecording')
    if (name === 'TimeoutError') return t('voiceMicTimeout')
    return t('voiceMicError')
  }

  const stop = async () => {
    const current = recording.current
    if (current) {
      recording.current = null
      audio.current = await current.stop()
      if (!mounted.current) return
      if (!audio.current) setError(t('voiceNoAudio'))
      setStage(audio.current ? 'ready' : 'idle')
      return
    }
    if (bridgeRef.current === true) {
      // 桥接模式:等待顶层回传 WAV(结果回调里推进状态);重复点击停止直接忽略。
      if (bridgeRequest.current === null) return
      window.parent.postMessage({ type: 'chatds:voice-capture-stop', requestId: bridgeRequest.current }, location.origin)
      return
    }
    setStage((current) => (current === 'recording' ? 'idle' : current))
  }

  const record = async () => {
    setStage('starting')
    setError('')
    setLevel(0)
    // 桥接探测若尚未应答,短暂等待(最多 ~700ms,与探测兜底一致)。
    for (let i = 0; i < 8 && bridgeRef.current === null; i += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 100))
    }
    if (bridgeRef.current === true) {
      const requestId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `voice-${Date.now()}-${Math.random().toString(16).slice(2)}`
      bridgeRequest.current = requestId
      const done = new Promise<BridgeResult>((resolve) => { bridgeResult.current = resolve })
      window.parent.postMessage({ type: 'chatds:voice-capture-start', requestId }, location.origin)
      // R8.6(修):桥接受理后立即进入录音界面(电平/计时/停止按钮)。
      // 此前停在"正在打开"直到停止才推进——录音实际已在进行,但用户看不到任何反馈、无法停止,
      // 看起来像"一直在检查麦克风"。失败/取消仍经 done 回调推进到对应状态。
      setStage('recording')
      const result = await done
      if (!mounted.current) return
      if (result.cancelled) {
        setStage('idle')
        return
      }
      if (result.ok && result.blob) {
        audio.current = result.blob
        setStage('ready')
        return
      }
      setError(result.name ? classifyMicError(result.name) : t('voiceMicError'))
      setStage('idle')
      return
    }
    // 本地直采(独立页面 / 无桥环境)。
    try {
      const value = await startRecording(() => void stop())
      if (!mounted.current) { value.cancel(); return }
      recording.current = value
      setStage('recording')
    } catch (reason) {
      if (mounted.current) {
        const name = reason instanceof DOMException ? reason.name : reason instanceof Error && 'name' in reason ? (reason as { name?: string }).name : ''
        setError(classifyMicError(String(name)))
        setStage('idle')
      }
    }
  }

  const transcribe = async () => {
    if (!audio.current || controller.current) return
    const request = new AbortController()
    controller.current = request
    setError('')
    setStage('sending')
    try {
      const text = await api.transcribe(audio.current, request.signal, useChatDesign.getState().design.speechProvider)
      if (request.signal.aborted || !mounted.current) return
      if (!text) throw new Error(t('voiceNoAudio'))
      onText(text)
    } catch (reason) {
      if (!request.signal.aborted && mounted.current) {
        setStage('ready')
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    } finally {
      controller.current = null
    }
  }

  return <Modal title={t('voiceInput')} onClose={onClose} closable footer={
    <>
      <Button variant="outlined" onClick={onClose}>{t('cancel')}</Button>
      {stage === 'idle' && <Button onClick={() => void record()}>{t('voiceRecord')}</Button>}
      {stage === 'recording' && <Button onClick={() => void stop()}>{t('voiceStop')}</Button>}
      {stage === 'ready' && <Button onClick={() => void transcribe()}>{t('voiceTranscribe')}</Button>}
    </>
  }>
    {/* R8.6(4.6):费用说明按实际转写引擎区分——DSH 本地/已配置引擎不描述为 DeepSeek 云转写。 */}
    <p>{localEngine ? t('voicePrivacyLocal') : t('voicePrivacy')}</p>
    {stage === 'recording' && (
      <>
        <p role="status">{t('voiceRecording')}</p>
        {/* 音量反馈:顶层/本地录音的实时电平(R8.6 修2)。 */}
        <div style={{ height: 6, borderRadius: 3, background: 'color-mix(in srgb, currentColor 12%, transparent)', overflow: 'hidden' }}>
          <div style={{
            height: '100%',
            width: `${Math.round(Math.min(1, Math.max(level, 0.02)) * 100)}%`,
            background: 'var(--chat-accent, var(--dsw-alias-brand-primary, #3b64ed))',
            transition: 'width 120ms ease',
          }} />
        </div>
        <p style={{ fontSize: 12, opacity: 0.75, margin: 0 }}>
          {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')} / 2:00
        </p>
      </>
    )}
    {stage === 'starting' && <p role="status">{t('voiceOpening')}</p>}
    {stage === 'sending' && <p role="status">{t('voiceSending')}</p>}
    {error && <p role="alert">{error}</p>}
  </Modal>
}
