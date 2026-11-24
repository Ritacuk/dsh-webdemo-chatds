/**
 * 本机偏好设置 — demo services/settings.ts 的最小适配版。
 *
 * demo 完整版包含 API Key、位置、朗读音色、主题偏好等;P1 阶段没有设置页
 * (SettingsDialog 属 P2),这里只保留组件移植所需的字段:
 * 语言、主题偏好、深度思考 / 智能搜索开关、侧边栏收起状态。
 * 持久化仍走 localStorage(纯 UI 偏好,不属于 Host 权威数据)。
 */

import { create } from 'zustand'

export type Locale = 'zh-CN' | 'en-US' | 'ja-JP'

/** 主题偏好;默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

type Settings = {
  locale: Locale
  themePreference: ThemePreference
  thinking: boolean
  search: boolean
  siderCollapsed: boolean
}

const KEYS = {
  locale: 'dsh-chat:locale',
  themePreference: 'dsh-chat:theme-preference',
  thinking: 'dsh-chat:thinking',
  search: 'dsh-chat:search',
  siderCollapsed: 'dsh-chat:sider-collapsed',
} as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

/** 应用语言默认跟随浏览器语言 */
export const browserLocale = (): Locale => {
  const language = (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase()
  return language.startsWith('zh') ? 'zh-CN' : language.startsWith('ja') ? 'ja-JP' : 'en-US'
}

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US' || saved === 'ja-JP') {
    return saved
  }
  return browserLocale()
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

export const useSettings = create<Settings>(() => ({
  locale: initialLocale(),
  themePreference: initialThemePreference(),
  thinking: read(KEYS.thinking) === 'true',
  search: read(KEYS.search) === 'true',
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
}))

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale)
  useSettings.setState({ locale })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setThinking = (thinking: boolean) => {
  write(KEYS.thinking, String(thinking))
  useSettings.setState({ thinking })
}

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  useSettings.setState({ search })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}
