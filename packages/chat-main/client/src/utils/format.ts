import { useSettings } from '../services/settings.js'

const pad = (value: number, length = 2): string => String(value).padStart(length, '0')

const toDate = (value: string | number | Date): Date | null => {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export const formatDate = (
  value: string | number | Date,
  separator: '/' | '-' = '-'
): string | null => {
  const date = toDate(value)
  if (!date) {
    return null
  }
  return [pad(date.getFullYear(), 4), pad(date.getMonth() + 1), pad(date.getDate())].join(separator)
}

// R8.5(F06):月分组标签按界面语言格式化(日语用「YYYY年M月」)。
export const monthKey = (value: string | number | Date): string | null => {
  const date = toDate(value)
  if (!date) return null
  if (useSettings.getState().locale === 'ja-JP') {
    return `${date.getFullYear()}年${date.getMonth() + 1}月`
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`
}
