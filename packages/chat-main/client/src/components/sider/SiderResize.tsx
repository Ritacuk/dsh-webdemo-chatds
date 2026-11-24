import { useRef, useState } from 'react'
import { useSettings } from '../../services/settings.js'
import { updateDesign, useChatDesign } from '../../services/chatDesign.js'
import styles from './Sider.module.css'

const clamp = (value: number) => Math.min(480, Math.max(200, Math.round(value)))

export function SiderResize() {
  const locale = useSettings((state) => state.locale)
  const { side, width } = useChatDesign((state) => state.design)
  const active = useRef<{ id: number; start: number; initial: number; value: number; root: HTMLElement }>()
  const [draft, setDraft] = useState<number>()
  const label = { 'zh-CN': '调整会话导航栏宽度', 'en-US': 'Resize conversation sidebar', 'ja-JP': '会話サイドバーの幅を調整' }[locale]
  const save = (value: number) => updateDesign((current) => ({ ...current, width: value }))

  return <div className={styles.resize} role="separator" aria-label={label} aria-orientation="vertical"
    tabIndex={0} aria-valuemin={200} aria-valuemax={480} aria-valuenow={draft ?? width ?? Math.max(252, Math.min(292, Math.round(innerWidth * .2)))}
    onKeyDown={(event) => {
      const current = width ?? (event.currentTarget.parentElement?.offsetWidth || 252)
      const delta = side === 'right' ? -10 : 10
      const next = { ArrowLeft: current - delta, ArrowRight: current + delta, Home: 200, End: 480 }[event.key]
      if (next === undefined) return
      event.preventDefault()
      save(clamp(next))
    }}
    onPointerDown={(event) => {
      if (!event.isPrimary || event.button !== 0) return
      const root = event.currentTarget.parentElement
      if (!root) return
      const initial = root.offsetWidth
      active.current = { id: event.pointerId, start: event.clientX, initial, value: initial, root }
      event.currentTarget.setPointerCapture(event.pointerId)
    }}
    onPointerMove={(event) => {
      const drag = active.current
      if (drag?.id !== event.pointerId) return
      drag.value = clamp(drag.initial + (event.clientX - drag.start) * (side === 'right' ? -1 : 1))
      drag.root.style.setProperty('--chatds-sidebar-drag', `${drag.value}px`)
      setDraft(drag.value)
    }}
    onLostPointerCapture={(event) => {
      const drag = active.current
      if (drag?.id !== event.pointerId) return
      drag.root.style.removeProperty('--chatds-sidebar-drag')
      setDraft(undefined)
      active.current = undefined
    }}
    onPointerUp={(event) => {
      const drag = active.current
      if (drag?.id === event.pointerId && drag.initial !== drag.value) save(drag.value)
    }}
  />
}
