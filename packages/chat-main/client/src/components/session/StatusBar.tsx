import { memo, useCallback, useEffect, useState } from 'react'
import { api } from '../../services/api.js'
import { setRichLedgerOk, useChatStore } from '../../store/workspace.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './StatusBar.module.css'

/**
 * R8.6(11.3):会话状态条——DSH 原生底栏同款信息形态(轮数/输入/缓存/输出/缓存命中/本会话费用/预算),
 * 数字全部来自真实数据(cost-meter 会话账本 / dsh-context 投影 / 合并预算),不伪造。
 * 分段可点击,直达对应原生插件页(自制详情弹窗按用户要求移除,不再维护第二份统计 UI):
 * - 费用/用量/预算段 → dsh-cost-meter 的「费用」设置区(shell openSettings('cost-meter'))
 * - 上下文段 → dsh-context 原生面板(selectPanel('dsh-context'))
 * 预算为合并口径(原生账本 + Rich 外部账本),Rich 会话在费用段标注来源。
 */

interface ContextView {
  available: boolean
  reason?: string
  usage?: { system?: number; tools?: number; user?: number; inject?: number; skill?: number; assistant?: number; tool?: number; total?: number }
  contextWindow?: number
  ratio?: number
  nearLimit?: boolean
}

interface SessionCostView {
  available: boolean
  reason?: string
  /** 数据来源——native=dsh-cost-meter 原生会话账本;rich=WebChat Rich 外部记录。 */
  source?: 'native' | 'rich'
  cost?: { own?: { cost?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number; calls?: number }; found?: boolean }
}

interface TodayCostView {
  available: boolean
  reason?: string
  budget?: { period?: string; cap?: number; used?: number; ratio?: number }
  /** 合并预算视图(native + external)。 */
  budgetMerged?: { period?: string; cap?: number; used?: number; ratio?: number }
  richLedger?: { available: boolean; reason?: string; records24h: number }
}

const compact = (value: number | undefined): string | null => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return value >= 10_000 ? `${(value / 1000).toFixed(1)}K` : String(Math.round(value))
}

const formatCost = (value: number | undefined): string | null => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  // Rich 单轮金额可能小到 1e-6 量级,按量级给出有效位,避免显示成 $0.0000。
  if (value >= 1) return `$${value.toFixed(2)}`
  if (value >= 0.0001) return `$${value.toFixed(4)}`
  return `$${value.toFixed(6)}`
}

/** 预算/占比:<10% 显示一位小数(与 DSH 原生底栏一致,0.9% 不被吞成 0%)。 */
const formatPercent = (ratio: number): string =>
  ratio < 0.1 ? `${(ratio * 100).toFixed(1)}%` : `${Math.round(ratio * 100)}%`

export const StatusBar = memo(function StatusBar({ sessionId }: { sessionId: string | null }) {
  const t = useTranslate()
  const [context, setContext] = useState<ContextView | null>(null)
  const [sessionCost, setSessionCost] = useState<SessionCostView | null>(null)
  const [today, setToday] = useState<TodayCostView | null>(null)
  const settledTick = useChatStore((state) => state.settledTick)

  const refresh = useCallback(() => {
    if (sessionId === null) {
      setContext(null)
      setSessionCost(null)
    } else {
      void api.contextStatus(sessionId).then(setContext).catch(() => setContext({ available: false, reason: '读取失败' }))
      void api.costSession(sessionId).then((value) => setSessionCost(value as SessionCostView)).catch(() => setSessionCost({ available: false, reason: '读取失败' }))
    }
    void api.costToday().then((value) => {
      setToday(value)
      setRichLedgerOk(value.richLedger ? value.richLedger.available : null)
    }).catch(() => setToday({ available: false, reason: '读取失败' }))
  }, [sessionId])

  useEffect(refresh, [refresh, settledTick])

  // 会话/今日费用每 60 秒轻量刷新(cost-meter 账本可能被其他面板更新)
  useEffect(() => {
    const timer = window.setInterval(() => {
      void api.costToday().then(setToday).catch(() => {})
      if (sessionId !== null) void api.costSession(sessionId).then((value) => setSessionCost(value as SessionCostView)).catch(() => {})
    }, 60_000)
    return () => window.clearInterval(timer)
  }, [sessionId])

  // 费用段数据(会话级,轮数/输入/缓存/输出/命中/金额)
  const own = sessionCost?.cost?.own
  const calls = typeof own?.calls === 'number' && own.calls > 0 ? own.calls : null
  const input = compact(own?.input)
  const cached = compact(own?.cacheRead)
  const output = compact(own?.output)
  const cacheHit = own && typeof own.cacheRead === 'number' && typeof own.input === 'number' && own.cacheRead + own.input > 0
    ? Math.round((own.cacheRead / (own.cacheRead + own.input)) * 100) + '%'
    : null
  const sessionCostValue = formatCost(own?.cost)
  const hasCost = own !== undefined && (calls !== null || input !== null || output !== null || sessionCostValue !== null || sessionCost?.source === 'rich')

  const contextTotal = compact(context?.usage?.total)
  const contextWindow = compact(context?.contextWindow)
  const ratio = context?.ratio

  const merged = today?.budgetMerged ?? today?.budget
  const budgetRatio = merged?.ratio ?? (merged && typeof merged.cap === 'number' && merged.cap > 0 && typeof merged.used === 'number'
    ? merged.used / merged.cap
    : undefined)

  const openCost = () => {
    if (window.parent !== window) window.parent.postMessage({ type: 'chatds:open-cost' }, location.origin)
  }
  const openContext = () => {
    if (window.parent !== window) window.parent.postMessage({ type: 'chatds:open-context' }, location.origin)
  }

  if (!hasCost && context === null && today === null) return null

  return (
    <div className={styles.bar} data-webchat-statusbar="">
      {!hasCost && <span className={styles.muted}>{t('statusNoData')}</span>}
      {hasCost && (
        <button type="button" className={styles.segment} onClick={openCost}
          title={sessionCost?.source === 'rich' ? t('statusSessionRichNote') : t('statusOpenCostMeter')}>
          {calls !== null && <span>{calls} {t('statusTurnsUnit')}</span>}
          {input !== null && <span>{t('statusInput')} {input} tok</span>}
          {cached !== null && <span>{t('statusCacheLabel')} {cached} tok</span>}
          {output !== null && <span>{t('statusOutput')} {output} tok</span>}
          {cacheHit !== null && <span>{t('statusCacheHit')} {cacheHit}</span>}
          {(sessionCostValue !== null || sessionCost?.source === 'rich') && (
            <span>{t('statusSession')} {sessionCostValue ?? t('statusNoAmount')}</span>
          )}
        </button>
      )}
      {contextTotal !== null && (
        <button type="button" className={styles.segment} onClick={openContext} title={t('statusOpenDshContext')}>
          <span className={ratio !== undefined && ratio >= 0.85 ? styles.nearLimit : styles.item}>
            {t('statusContext')} {contextTotal}{contextWindow !== null ? `/${contextWindow}` : ''} tok{ratio !== undefined ? ` (${formatPercent(ratio)})` : ''}
          </span>
        </button>
      )}
      {budgetRatio !== undefined && merged?.cap !== undefined && (
        <button type="button" className={styles.segment} onClick={openCost} title={t('statusOpenCostMeter')}>
          <span className={budgetRatio >= 0.8 ? styles.nearLimit : styles.item}>{t('statusBudget')} {formatPercent(budgetRatio)}</span>
        </button>
      )}
    </div>
  )
})
