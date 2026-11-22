import { memo } from 'react'
import type { AssistantMessage } from '@dsh-chat/shared'
import { useTranslate } from '../../i18n/index.js'
import styles from './AssistantMessage.module.css'

/**
 * R8 每轮用量行:输入/输出/缓存命中率 + 实际费用(cost-meter 账目存在时)。
 * 无 usage 的回复不显示;费用缺失时绝不显示估算数字。
 * R8.6:Rich 轮的费用由 Host 按 dsh-cost-meter 价表与峰谷规则逐条计算(richCost),
 * 不再显示"已计入统一费用账本"文案——只显示金额。token 值带单位。
 */

const compactTokens = (value: number): string =>
  value >= 10_000 ? `${(value / 1000).toFixed(1)}K` : String(value)

const formatCost = (value: number): string => {
  // Rich 单轮金额可能小到 1e-6 量级,4 位小数会显示成 $0.0000;按量级给出有效位。
  if (value >= 1) return `$${value.toFixed(2)}`
  if (value >= 0.0001) return `$${value.toFixed(4)}`
  return `$${value.toFixed(6)}`
}

interface TurnCostShape {
  found?: boolean
  cost?: number
  apiCost?: number
}

export const UsageLine = memo(function UsageLine({ message, richCost }: { message: AssistantMessage; richCost?: number }) {
  const t = useTranslate()
  const usage = message.usage
  if (usage === undefined || (usage.input_tokens === 0 && usage.output_tokens === 0)) return null
  const input = usage.input_tokens
  const output = usage.output_tokens
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  const cacheTotal = input + cacheRead + cacheWrite
  const cacheHit = cacheTotal > 0 && cacheRead > 0 ? Math.round((cacheRead / cacheTotal) * 100) : null
  const cost = message.cost as TurnCostShape | undefined
  const nativeCost = cost !== undefined && cost.found === true && typeof cost.cost === 'number' && cost.cost > 0
    ? cost.cost
    : null
  const amount = nativeCost ?? (typeof richCost === 'number' && richCost > 0 ? richCost : null)
  return (
    <div className={styles.usageLine} title={t('usageFromServerTooltip')}>
      <span>{t('usageInput', { count: `${compactTokens(input)} tok` })}</span>
      <span>{t('usageOutput', { count: `${compactTokens(output)} tok` })}</span>
      {cacheHit !== null && <span>{t('usageCacheHit', { count: cacheHit })}</span>}
      {amount !== null && <span className={styles.usageCost}>· {formatCost(amount)}</span>}
    </div>
  )
})
