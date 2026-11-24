import { useSyncExternalStore } from 'react'
import type { WorkspaceSettings } from '@dsh-chat/shared'
import { useChatStore } from '../store/workspace.js'
import { designVariables, useChatDesign } from '../services/chatDesign.js'
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
type Appearance = Pick<WorkspaceSettings, 'appearanceMode' | 'appearanceStyle' | 'appearanceGlass' | 'readingFontSize' | 'readingWidth'
  | 'appearanceAccent' | 'appearanceBgAlpha' | 'appearancePanelAlpha' | 'appearanceComposerAlpha' | 'appearanceLineHeight'
  | 'appearanceRadius' | 'appearanceDensity' | 'appearanceComposerWidth'>
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
  document.documentElement.style.removeProperty('background-color')
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
let appliedDesignVariables: string[] = []

const syncTheme = () => {
  const settings = parentProfileAppearance ?? useChatStore.getState().settings
  const theme = resolveTheme(settings?.appearanceMode)
  const { body } = document
  // R8.6(七):自由外观 → CSS 变量层。变量缺省时不写入,保持官方 demo 默认观感。
  const vars = body.style
  const set = (name: string, value: string | undefined) => {
    if (value === undefined) vars.removeProperty(name)
    else vars.setProperty(name, value)
  }
  const design = useChatDesign.getState().design
  const palette = design.palettes[theme]
  for (const name of appliedDesignVariables) vars.removeProperty(name)
  const designValues = designVariables(palette, design)
  for (const [name, value] of Object.entries(designValues)) set(name, value)
  appliedDesignVariables = Object.keys(designValues)
  set('--chatds-sidebar-width', design.width === undefined ? undefined : `${design.width}px`)
  set('--dsw-alias-label-primary', palette.text)
  set('--dsw-alias-label-secondary', palette.secondary)
  set('--chat-accent', settings?.appearanceAccent || undefined)
  set('--chat-bg-alpha', settings?.appearanceBgAlpha !== undefined ? String(settings.appearanceBgAlpha) : undefined)
  set('--chat-panel-alpha', settings?.appearancePanelAlpha !== undefined ? String(settings.appearancePanelAlpha) : undefined)
  set('--chat-composer-alpha', settings?.appearanceComposerAlpha !== undefined ? String(settings.appearanceComposerAlpha) : undefined)
  set('--chat-reading-line', settings?.appearanceLineHeight !== undefined ? String(settings.appearanceLineHeight) : undefined)
  set('--chat-radius-px', settings?.appearanceRadius !== undefined ? String(settings.appearanceRadius) : undefined)
  set('--chat-composer-max-width-px', settings?.appearanceComposerWidth !== undefined ? String(settings.appearanceComposerWidth) : undefined)
  body.dataset.chatDensity = settings?.appearanceDensity ?? 'standard'
  if (settings?.appearanceRadius !== undefined) body.dataset.chatRadius = ''
  else delete body.dataset.chatRadius
  if (settings?.appearanceComposerWidth !== undefined) body.dataset.chatComposerWidth = ''
  else delete body.dataset.chatComposerWidth
  body.dataset.chatGlass = settings?.appearanceGlass ?? 'off'
  body.dataset.chatWidth = settings?.readingWidth ?? 'preset'
  body.style.setProperty('--chat-reading-size', `${settings?.readingFontSize ?? 16}px`)
  if (theme !== appliedTheme) {
    appliedTheme = theme
    applyTheme(theme)
  } else if (document.readyState === 'complete') syncPageBackground()
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
  const stopDesign = useChatDesign.subscribe(syncTheme)
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
    stopDesign()
  }
}
