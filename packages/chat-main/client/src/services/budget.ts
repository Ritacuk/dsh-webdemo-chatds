/**
 * R8 预算提醒:基于 dsh-cost-meter 预算账目(getState.budgetUsed / cap),
 * 达到用户配置阈值时轻提示(Toast),不打断聊天。
 * 每个阈值每天只提醒一次(按本地日期 + 阈值去重,内存态即可)。
 * R8.5:比例用合并口径(budgetMerged = 原生账本 + Rich 外部账本今日费用),
 * 与状态条/费用详情一致;无预算(cap 缺失)时静默——状态条显示"尚未设置每日预算"。
 */

import { api } from './api.js'
import { useChatStore } from '../store/workspace.js'
import { showToast } from '../components/base/toastState.js'
import { translate } from '../i18n/index.js'

const notified = new Set<string>()
let checking = false

export const checkBudgetReminder = async (): Promise<void> => {
  if (checking) return
  const settings = useChatStore.getState().settings
  if (settings?.budgetRemindersEnabled !== true) return
  checking = true
  try {
    const today = await api.costToday()
    if (today.available !== true) return
    const merged = today.budgetMerged ?? today.budget
    if (merged?.cap === undefined || merged.used === undefined || merged.cap <= 0) return
    const ratio = merged.used / merged.cap
    const day = today.date ?? new Date().toISOString().slice(0, 10)
    for (const threshold of [...(settings.budgetWarnThresholds ?? [])].sort((a, b) => a - b)) {
      const key = `${day}:${threshold}`
      if (notified.has(key)) continue
      if (ratio >= threshold) {
        notified.add(key)
        const percent = Math.round(ratio * 100)
        // 小金额多精度:避免 $0.00/$0.00(测试预算与低用量场景)。
        const money = (value: number): string => value >= 0.01 ? value.toFixed(2) : value.toFixed(4)
        showToast(threshold >= 1
          ? translate('budgetReachedCap').replace('{cap}', money(merged.cap))
          : translate('budgetReachedThreshold')
              .replace('{threshold}', String(Math.round(threshold * 100)))
              .replace('{percent}', String(percent))
              .replace('{used}', money(merged.used))
              .replace('{cap}', money(merged.cap)))
      }
    }
  } catch {
    // 费用服务不可用:静默(状态条会显示真实原因)
  } finally {
    checking = false
  }
}
