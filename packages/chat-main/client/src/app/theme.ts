import { useSyncExternalStore } from 'react'
import type { WorkspaceSettings } from '@dsh-chat/shared'
import { useChatStore } from '../store/workspace.js'
import './appearance.css'

export type Theme = 'light' | 'dark'

const query = window.matchMedia('(prefers-color-scheme: dark)')

const subscribeOsTheme = (listener: () => void) => {
  query.addEventListener('change', listener)
  window.addEventListener('chatds:host-theme', listener)
  return () => {
    query.removeEventListener('change', listener)
    window.removeEventListener('chatds:host-theme', listener)
  }
}

let hostTheme: Theme | undefined
type Appearance = Pick<WorkspaceSettings, 'appearanceMode' | 'appearanceStyle' | 'appearanceGlass' | 'readingFontSize' | 'readingWidth'>
let parentProfileAppearance: Appearance | undefined
const getOsTheme = (): Theme => query.matches ? 'dark' : 'light'

const resolveTheme = (mode = parentProfileAppearance?.appearanceMode ?? useChatStore.getState().settings?.appearanceMode): Theme =>
  mode === 'light' || mode === 'dark' ? mode : mode === 'system' ? getOsTheme() : hostTheme ?? getOsTheme()

/** 当前实际生效的深浅色：手动选择优先，「跟随系统」时取系统设置 */
export const useTheme = (): Theme => {
  const mode = useChatStore((state) => state.settings?.appearanceMode)
  return useSyncExternalStore(subscribeOsTheme, () => resolveTheme(parentProfileAppearance?.appearanceMode ?? mode))
}

const syncPageBackground = () => {
  const backgroundColor = getComputedStyle(document.body).backgroundColor
  document.documentElement.style.backgroundColor = backgroundColor
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', backgroundColor)
}

/** 同步页面主题、根画布背景和支持 theme-color 的浏览器栏。 */
const applyTheme = (theme: Theme) => {
  const body = document.body
  // 主题切换帧禁用过渡，使页面颜色同步更新
  body.classList.add('change-theme')
  body.classList.toggle('dark', theme === 'dark')
  body.classList.toggle('light', theme === 'light')
  if (theme === 'dark') {
    body.setAttribute('data-ds-dark-theme', 'dark')
  } else {
    body.removeAttribute('data-ds-dark-theme')
  }
  document.documentElement.style.colorScheme = theme
  // 首次背景色同步在样式表加载完成后执行，适配 WebKit 的 defer 脚本执行顺序。
  if (document.readyState === 'complete') {
    syncPageBackground()
  }
  setTimeout(() => {
    body.classList.remove('change-theme')
  }, 0)
}

let appliedTheme: Theme | null = null

const syncTheme = () => {
  const settings = parentProfileAppearance ?? useChatStore.getState().settings
  const theme = resolveTheme(settings?.appearanceMode)
  const style = settings?.appearanceStyle ?? 'default'
  const { body } = document
  const styleChanged = body.dataset.chatStyle !== style
  body.dataset.chatStyle = style
  body.dataset.chatGlass = settings?.appearanceGlass ?? 'off'
  body.dataset.chatWidth = settings?.readingWidth ?? 'preset'
  body.style.setProperty('--chat-reading-size', `${settings?.readingFontSize ?? 16}px`)
  if (theme !== appliedTheme || styleChanged) {
    appliedTheme = theme
    applyTheme(theme)
  }
}

/** 首屏渲染前同步应用一次，之后随主题设置与系统深浅色变化更新 */
export const setupTheme = () => {
  syncTheme()
  if (document.readyState !== 'complete') {
    window.addEventListener('load', syncPageBackground, { once: true })
  }
  query.addEventListener('change', syncTheme)
  const unsubscribe = useChatStore.subscribe((state, previous) => {
    if (state.settings !== previous.settings) syncTheme()
  })
  const message = (event: MessageEvent) => {
    if (window.parent === window || event.origin !== location.origin || event.source !== window.parent) return
    if (event.data?.type !== 'chatds:theme' || !['light', 'dark'].includes(event.data.mode)) return
    hostTheme = event.data.mode
    syncTheme()
    window.dispatchEvent(new Event('chatds:host-theme'))
  }
  window.addEventListener('message', message)
  const sidecar = new URLSearchParams(location.search).has('parent')
  const abort = new AbortController()
  let revision = 0
  const channel = sidecar && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('chatds:settings') : null
  const loadProfileAppearance = async () => {
    const attempt = ++revision
    try {
      const result = await fetch('/chat-workspace/api/settings', { cache: 'no-store', signal: abort.signal })
      if (!result.ok) return
      const data = await result.json() as Appearance
      if (abort.signal.aborted || attempt !== revision) return
      parentProfileAppearance = data
      syncTheme()
      window.dispatchEvent(new Event('chatds:host-theme'))
    } catch { /* 独立侧聊可用自己的外观配置。 */ }
  }
  if (sidecar) void loadProfileAppearance()
  if (channel) channel.onmessage = () => void loadProfileAppearance()
  return () => {
    abort.abort()
    channel?.close()
    parentProfileAppearance = undefined
    query.removeEventListener('change', syncTheme)
    window.removeEventListener('load', syncPageBackground)
    window.removeEventListener('message', message)
    unsubscribe()
  }
}
