import { useSettings } from '../../services/settings.js'

export function useBridgeCopy() {
  const locale = useSettings((state) => state.locale)
  return (zh: string, en: string, ja: string) => locale === 'zh-CN' ? zh : locale === 'ja-JP' ? ja : en
}
