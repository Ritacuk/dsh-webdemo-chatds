/**
 * R8 预算提醒:基于 dsh-cost-meter 预算账目(getState.budgetUsed / cap),
 * 达到用户配置阈值时轻提示(Toast),不打断聊天。
 * 每个阈值每天只提醒一次(按本地日期 + 阈值去重,内存态即可)。
 */

import { api } from './api.js'
import { useChatStore } from '../store/workspace.js'
import { showToast } from '../components/base/toastState.js'

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
    const { budget } = today
    if (budget?.cap === undefined || budget.used === undefined || budget.cap <= 0) return
    const ratio = budget.used / budget.cap
    const day = today.date ?? new Date().toISOString().slice(0, 10)
    for (const threshold of [...(settings.budgetWarnThresholds ?? [])].sort((a, b) => a - b)) {
      const key = `${day}:${threshold}`
      if (notified.has(key)) continue
      if (ratio >= threshold) {
        notified.add(key)
        const percent = Math.round(ratio * 100)
        showToast(threshold >= 1
          ? `今日费用已达预算上限($${budget.cap.toFixed(2)})。可在 dsh-cost-meter 设置中调整预算。`
          : `今日费用已达预算 ${Math.round(threshold * 100)}%(当前 ${percent}%,$${budget.used.toFixed(2)}/$${budget.cap.toFixed(2)})。`)
      }
    }
  } catch {
    // 费用服务不可用:静默(状态条会显示真实原因)
  } finally {
    checking = false
  }
}
