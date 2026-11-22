import { memo, useCallback, useEffect, useState } from 'react'
import { Modal } from '../base/Modal.js'
import { api } from '../../services/api.js'
import { setRichLedgerOk, useChatStore } from '../../store/workspace.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './StatusBar.module.css'

/**
 * R8 会话状态条:上下文用量(dsh-context 官方投影)+ 会话/今日费用(dsh-cost-meter)。
 * 数据不可用时按官方事实显示「暂无数据」,不伪造。点击打开详情(含 dsh-context 联动入口)。
 * R8.5:今日费用与预算比例使用合并口径(原生账本 + Rich 外部账本),并显示外部账本状态。
 */

interface ContextView {
  available: boolean
  reason?: string
  usage?: { system?: number; tools?: number; user?: number; inject?: number; skill?: number; assistant?: number; tool?: number; total?: number }
  contextWindow?: number
  ratio?: number
  nearLimit?: boolean
  requests?: readonly Record<string, unknown>[]
}

interface SessionCostView {
  available: boolean
  reason?: string
  cost?: { own?: { cost?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number; calls?: number }; found?: boolean }
}

interface TodayCostView {
  available: boolean
  reason?: string
  cost?: number
  input?: number
  output?: number
  calls?: number
  budget?: { period?: string; cap?: number; used?: number; ratio?: number }
  /** R8.5:外部用量(Rich 直连,经官方 external_usage.json 注入 cost-meter)。 */
  external?: { input?: number; output?: number; cached?: number; cacheWrite?: number; calls?: number; cost?: number }
  externalStale?: boolean
  /** R8.5:合并预算视图(native + external)。 */
  budgetMerged?: { period?: string; cap?: number; used?: number; ratio?: number }
  richLedger?: { available: boolean; reason?: string; records24h: number }
}

const compact = (value: number | undefined): string | null => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return value >= 10_000 ? `${(value / 1000).toFixed(1)}K` : String(Math.round(value))
}

const formatCost = (value: number | undefined): string | null => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`
}

interface EstimateView {
  available: boolean
  reason?: string
  inputTokens?: number
  outputTokens?: [number, number]
  inputCost?: number
  currency?: string
  cacheHitAssumption?: number
}

export const StatusBar = memo(function StatusBar({ sessionId }: { sessionId: string | null }) {
  const t = useTranslate()
  const [context, setContext] = useState<ContextView | null>(null)
  const [sessionCost, setSessionCost] = useState<SessionCostView | null>(null)
  const [today, setToday] = useState<TodayCostView | null>(null)
  const [estimate, setEstimate] = useState<EstimateView | null>(null)
  const [detail, setDetail] = useState(false)
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

  const contextTotal = compact(context?.usage?.total)
  const contextWindow = compact(context?.contextWindow)
  const ratio = context?.ratio
  const sessionCostValue = sessionCost?.cost?.own?.cost
  const sessionTokens = compact(sessionCost?.cost?.own?.input)
  // R8.5:今日展示合并口径(原生 + Rich 外部);两者都无金额时保持原展示。
  const externalCostValue = (today?.cost ?? 0) + (today?.external?.cost ?? 0)
  const todayCost = formatCost(externalCostValue)
  const todayCalls = (today?.calls ?? 0) + (today?.external?.calls ?? 0)
  const merged = today?.budgetMerged ?? today?.budget
  const budgetRatio = merged?.ratio

  const hasAnything = contextTotal !== null || sessionCostValue !== undefined || todayCost !== null
  if (!hasAnything && context === null && today === null) return null

  return <>
    <button type="button" className={styles.bar} data-webchat-statusbar="" onClick={() => {
      refresh()
      if (sessionId !== null) {
        void api.costEstimate(sessionId, 0).then(setEstimate).catch(() => setEstimate({ available: false, reason: '读取失败' }))
      }
      setDetail(true)
    }}
      aria-label={t('statusDetailAria')}>
      {!hasAnything && <span className={styles.muted}>{t('statusNoData')}</span>}
      {contextTotal !== null && (
        <span className={ratio !== undefined && ratio >= 0.85 ? styles.nearLimit : styles.item}>
          {t('statusContext')} {contextTotal}{contextWindow !== null ? `/${contextWindow}` : ''}{ratio !== undefined ? ` (${Math.round(ratio * 100)}%)` : ''}
        </span>
      )}
      {sessionCostValue !== undefined && sessionCostValue > 0 && (
        <span className={styles.item}>{t('statusSession')} {formatCost(sessionCostValue)}{sessionTokens !== null ? ` · ${sessionTokens} tok` : ''}</span>
      )}
      {todayCost !== null && <span className={styles.item}>{t('statusToday')} {todayCost}{todayCalls > 0 ? ` · ${todayCalls} ${t('statusCallsUnit')}` : ''}</span>}
      {budgetRatio !== undefined && merged?.cap !== undefined && (
        <span className={budgetRatio >= 0.8 ? styles.nearLimit : styles.item}>{t('statusBudget')} {Math.round(budgetRatio * 100)}%</span>
      )}
    </button>
    {detail && (
      <Modal title={t('statusDetailTitle')} onClose={() => setDetail(false)}>
        <div className={styles.detail}>
          {/* R8.5:Rich 用量已经官方 external_usage 协议入账;仅在账本不可用时给出原因。 */}
          {today?.richLedger?.available === false && today.richLedger.reason !== undefined
            ? <p>{t('statusRichLedgerUnavailable').replace('{reason}', today.richLedger.reason)}</p>
            : <p>{t('statusRichLedgerOk')}</p>}
          <section>
            <h3>{t('statusDetailContextSection')}</h3>
            {context?.available === true && context.usage !== undefined ? (
              <table>
                <tbody>
                  {Object.entries({ system: t('statusUsageSystem'), tools: t('statusUsageTools'), user: t('statusUsageUser'), inject: t('statusUsageInject'), skill: t('statusUsageSkill'), assistant: t('statusUsageAssistant'), tool: t('statusUsageTool') })
                    .filter(([key]) => typeof context.usage![key as keyof typeof context.usage] === 'number')
                    .map(([key, label]) => (
                      <tr key={key}><td>{label}</td><td>{compact(context.usage![key as keyof typeof context.usage] as number) ?? '0'} tok</td></tr>
                    ))}
                  <tr><td>{t('statusUsageTotal')}</td><td>{contextTotal ?? t('statusNoDataShort')} tok</td></tr>
                  <tr><td>{t('statusContextWindow')}</td><td>{contextWindow ?? t('statusNoDataShort')}</td></tr>
                </tbody>
              </table>
            ) : (
              <p className={styles.muted}>{context?.reason ?? t('statusNoDataShort')}</p>
            )}
          </section>
          <section>
            <h3>{t('statusDetailSessionSection')}</h3>
            {sessionCost?.available === true && sessionCost.cost?.own !== undefined ? (
              <p>
                {t('statusCostLabel')} {formatCost(sessionCost.cost.own.cost) ?? t('statusNoAmount')} · {t('statusInput')} {compact(sessionCost.cost.own.input) ?? '—'} tok ·
                {t('statusOutput')} {compact(sessionCost.cost.own.output) ?? '—'} tok · {t('statusRequests')} {sessionCost.cost.own.calls ?? '—'}
              </p>
            ) : (
              <p className={styles.muted}>{sessionCost?.reason ?? t('statusNoDataShort')}</p>
            )}
          </section>
          <section>
            <h3>{t('statusDetailEstimateSection')}</h3>
            {estimate?.available === true ? (
              <p className={styles.muted}>
                {t('statusEstimateInput').replace('{input}', String(estimate.inputTokens ?? '—')).replace('{cache}', String(Math.round((estimate.cacheHitAssumption ?? 0) * 100)))} ·
                {t('statusEstimateOutput').replace('{low}', String(estimate.outputTokens?.[0] ?? '—')).replace('{high}', String(estimate.outputTokens?.[1] ?? '—'))}
                {t('statusEstimateBillNote')}
                {estimate.inputCost !== undefined && ` ${t('statusEstimateInputCost').replace('{cost}', estimate.inputCost.toFixed(4))}`}
              </p>
            ) : (
              <p className={styles.muted}>{estimate?.reason ?? t('statusEstimateUnavailable')}</p>
            )}
          </section>
          <section>
            <h3>{t('statusDetailTodaySection')}</h3>
            {today?.available === true ? (
              <>
                <p>{t('statusCostLabel')} {formatCost(externalCostValue) ?? t('statusNoAmount')} · {t('statusInput')} {compact(today.input) ?? 0}+{compact(today.external?.input) ?? 0} tok · {t('statusOutput')} {compact(today.output) ?? 0}+{compact(today.external?.output) ?? 0} tok · {t('statusRequests')} {today.calls ?? 0}+{today.external?.calls ?? 0}</p>
                {today.external?.cost !== undefined && today.external.cost > 0 && (
                  <p className={styles.muted}>{t('statusExternalBreakdown')
                    .replace('{native}', formatCost(today.cost) ?? '$0')
                    .replace('{rich}', formatCost(today.external.cost) ?? '$0')
                    .replace('{cached}', compact(today.external.cached) ?? '0')}</p>
                )}
                {today.externalStale === true && <p className={styles.muted}>{t('statusExternalStale')}</p>}
                {merged?.cap !== undefined
                  ? <p>{t('statusBudgetLine')
                      .replace('{period}', merged.period === 'day' ? t('statusPeriodDay') : merged.period === 'month' ? t('statusPeriodMonth') : merged.period ?? t('statusPeriodGeneric'))
                      .replace('{used}', formatCost(merged.used) ?? t('statusNoAmount'))
                      .replace('{cap}', `$${merged.cap}`)
                      .replace('{ratio}', budgetRatio !== undefined ? `(${Math.round(budgetRatio * 100)}%)` : '')}</p>
                  : <p className={styles.muted}>{t('statusBudgetNotSet')}</p>}
                <p className={styles.muted}>{t('statusCostMeterNote')}</p>
              </>
            ) : (
              <p className={styles.muted}>{today?.reason ?? t('statusNoDataShort')}</p>
            )}
          </section>
        </div>
      </Modal>
    )}
  </>
})
