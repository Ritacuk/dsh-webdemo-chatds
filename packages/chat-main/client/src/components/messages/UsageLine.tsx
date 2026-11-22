import { memo } from 'react'
import type { AssistantMessage } from '@dsh-chat/shared'
import { useTranslate } from '../../i18n/index.js'
import { useChatStore } from '../../store/workspace.js'
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
  const t = useTranslate()
  // R8.5:Rich 用量按外部账本状态显示口径(已入账 / 未入账)。
  const richLedgerOk = useChatStore((state) => state.richLedgerOk)
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
    <div className={styles.usageLine} title={t('usageFromServerTooltip')}>
      <span>{t('usageInput', { count: compactTokens(input) })}</span>
      <span>{t('usageOutput', { count: compactTokens(output) })}</span>
      {cacheHit !== null && <span>{t('usageCacheHit', { count: cacheHit })}</span>}
      {message.usageSource === 'rich' && <span>{t(richLedgerOk === true ? 'usageRichIngested' : 'usageRichNote')}</span>}
      {realCost !== null && <span className={styles.usageCost}>· {formatCost(realCost)}</span>}
    </div>
  )
})
