import { memo } from 'react'
import type { AssistantMessage } from '@dsh-chat/shared'
import styles from './AssistantMessage.module.css'

/**
 * R8 每轮用量行:输入/输出/缓存命中率 + 实际费用(cost-meter 账目存在时)。
 * 无 usage 的回复不显示;费用缺失时绝不显示估算数字。
 */

const compactTokens = (value: number): string =>
  value >= 10_000 ? `${(value / 1000).toFixed(1)}K` : String(value)

const formatCost = (value: number): string =>
  value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`

interface TurnCostShape {
  found?: boolean
  cost?: number
  apiCost?: number
}

export const UsageLine = memo(function UsageLine({ message }: { message: AssistantMessage }) {
  const usage = message.usage
  if (usage === undefined || (usage.input_tokens === 0 && usage.output_tokens === 0)) return null
  const input = usage.input_tokens
  const output = usage.output_tokens
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  const cacheTotal = input + cacheRead + cacheWrite
  const cacheHit = cacheTotal > 0 && cacheRead > 0 ? Math.round((cacheRead / cacheTotal) * 100) : null
  const cost = message.cost as TurnCostShape | undefined
  const realCost = cost !== undefined && cost.found === true && typeof cost.cost === 'number' && cost.cost > 0
    ? cost.cost
    : null
  return (
    <div className={styles.usageLine} title="本回合用量来自模型服务返回的数据">
      <span>输入 {compactTokens(input)}</span>
      <span>输出 {compactTokens(output)}</span>
      {cacheHit !== null && <span>缓存命中 {cacheHit}%</span>}
      {message.usageSource === 'rich' && <span>· Rich 独立用量，未纳入费用总账</span>}
      {realCost !== null && <span className={styles.usageCost}>· {formatCost(realCost)}</span>}
    </div>
  )
})
