import { useEffect, useRef, useState } from 'react'
import { api } from '../../services/api.js'
import { startRecording, type Recording } from '../../services/speech/recorder.js'
import { Modal } from '../base/Modal.js'
import { Button } from '../base/Button.js'
import { useTranslate } from '../../i18n/index.js'

export function VoiceInput({ onText, onClose }: { onText: (text: string) => void; onClose: () => void }) {
  const t = useTranslate()
  const [stage, setStage] = useState<'idle' | 'starting' | 'recording' | 'ready' | 'sending'>('idle')
  const [error, setError] = useState('')
  const recording = useRef<Recording | null>(null)
  const audio = useRef<Blob | null>(null)
  const controller = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      recording.current?.cancel()
      controller.current?.abort()
      recording.current = null
      audio.current = null
    }
  }, [])
  // R8.5(F03):从麦克风按钮打开即开始录音(官方 demo 交互);用户仍可停止/取消,识别文字需确认后才插入草稿。
  const startedRef = useRef(false)
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    void record()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const stop = async () => {
    const current = recording.current
    if (!current) return
    recording.current = null
    audio.current = await current.stop()
    if (!mounted.current) return
    if (!audio.current) setError(t('voiceNoAudio'))
    setStage(audio.current ? 'ready' : 'idle')
  }
  const record = async () => {
    setStage('starting')
    setError('')
    try {
      const value = await startRecording(() => void stop())
      if (!mounted.current) { value.cancel(); return }
      recording.current = value
      setStage('recording')
    } catch {
      if (mounted.current) {
        setError(t('voiceMicError'))
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
      const text = await api.transcribe(audio.current, request.signal)
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
    <p>{t('voicePrivacy')}</p>
    {stage === 'recording' && <p role="status">{t('voiceRecording')}</p>}
    {stage === 'starting' && <p role="status">{t('voiceOpening')}</p>}
    {stage === 'sending' && <p role="status">{t('voiceSending')}</p>}
    {error && <p role="alert">{error}</p>}
  </Modal>
}
