import type { CreateMessageRequest } from '@dsh-chat/shared'

/** Match chat-demo's date, weekday, region, surface and language fields. */
export function createDemoReminder(
  locale: 'zh-CN' | 'en-US' | 'ja-JP' = 'zh-CN',
  timeZone?: string,
  now = new Date(),
): string {
  let formatter: Intl.DateTimeFormat
  const options: Intl.DateTimeFormatOptions = {
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
  }
  try {
    formatter = new Intl.DateTimeFormat(locale, { ...options, timeZone })
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
    formatter = new Intl.DateTimeFormat(locale, options)
  }
  const parts = Object.fromEntries(formatter.formatToParts(now).map(({ type, value }) => [type, value]))
  return [`${parts.year}-${parts.month}-${parts.day}`, parts.weekday, '', 'Web', locale === 'en-US' ? 'English' : locale === 'ja-JP' ? '日本語' : '中文'].join(',')
}
export function demoServerTools(search: boolean): CreateMessageRequest['tools'] {
  const tools: CreateMessageRequest['tools'] = [
    { type: 'deepseek_read_url', name: 'deepseek_read_url' },
  ]
  if (search) tools.push({ type: 'deepseek_web_search', name: 'deepseek_web_search' })
  return tools
}
