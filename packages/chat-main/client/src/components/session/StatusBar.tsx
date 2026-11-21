import { memo, useCallback, useEffect, useState } from 'react'
import { Modal } from '../base/Modal.js'
import { api } from '../../services/api.js'
import { useChatStore } from '../../store/workspace.js'
import styles from './StatusBar.module.css'

/**
 * R8 会话状态条:上下文用量(dsh-context 官方投影)+ 会话/今日费用(dsh-cost-meter)。
 * 数据不可用时按官方事实显示「暂无数据」,不伪造。点击打开详情(含 dsh-context 联动入口)。
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
    void api.costToday().then(setToday).catch(() => setToday({ available: false, reason: '读取失败' }))
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
  const todayCost = formatCost(today?.cost)
  const budgetRatio = today?.budget?.ratio

  const hasAnything = contextTotal !== null || sessionCostValue !== undefined || todayCost !== null
  if (!hasAnything && context === null && today === null) return null

  return <>
    <button type="button" className={styles.bar} onClick={() => {
      refresh()
      if (sessionId !== null) {
        void api.costEstimate(sessionId, 0).then(setEstimate).catch(() => setEstimate({ available: false, reason: '读取失败' }))
      }
      setDetail(true)
    }}
      aria-label="查看上下文与费用详情">
      {!hasAnything && <span className={styles.muted}>上下文 / 费用 暂无数据</span>}
      {contextTotal !== null && (
        <span className={ratio !== undefined && ratio >= 0.85 ? styles.nearLimit : styles.item}>
          上下文 {contextTotal}{contextWindow !== null ? `/${contextWindow}` : ''}{ratio !== undefined ? ` (${Math.round(ratio * 100)}%)` : ''}
        </span>
      )}
      {sessionCostValue !== undefined && sessionCostValue > 0 && (
        <span className={styles.item}>本会话 {formatCost(sessionCostValue)}{sessionTokens !== null ? ` · ${sessionTokens} tok` : ''}</span>
      )}
      {todayCost !== null && <span className={styles.item}>今日 {todayCost}{today?.calls !== undefined ? ` · ${today.calls} 次` : ''}</span>}
      {budgetRatio !== undefined && today?.budget?.cap !== undefined && (
        <span className={budgetRatio >= 0.8 ? styles.nearLimit : styles.item}>预算 {Math.round(budgetRatio * 100)}%</span>
      )}
    </button>
    {detail && (
      <Modal title="上下文与费用" onClose={() => setDetail(false)}>
        <div className={styles.detail}>
          <p>DeepSeek Rich 的 API 用量显示在各条回复下方，未纳入 dsh-cost-meter 账本和预算。</p>
          <section>
            <h3>上下文(dsh-context 官方投影)</h3>
            {context?.available === true && context.usage !== undefined ? (
              <table>
                <tbody>
                  {Object.entries({ system: '系统指令', tools: '工具定义', user: '用户消息', inject: '注入内容', skill: '技能', assistant: '助手回复', tool: '工具结果' })
                    .filter(([key]) => typeof context.usage![key as keyof typeof context.usage] === 'number')
                    .map(([key, label]) => (
                      <tr key={key}><td>{label}</td><td>{compact(context.usage![key as keyof typeof context.usage] as number) ?? '0'} tok</td></tr>
                    ))}
                  <tr><td>合计</td><td>{contextTotal ?? '暂无数据'} tok</td></tr>
                  <tr><td>模型上下文上限</td><td>{contextWindow ?? '暂无数据'}</td></tr>
                </tbody>
              </table>
            ) : (
              <p className={styles.muted}>{context?.reason ?? '暂无数据'}</p>
            )}
          </section>
          <section>
            <h3>本会话费用(dsh-cost-meter 官方账目)</h3>
            {sessionCost?.available === true && sessionCost.cost?.own !== undefined ? (
              <p>
                费用 {formatCost(sessionCost.cost.own.cost) ?? '暂无金额'} · 输入 {compact(sessionCost.cost.own.input) ?? '—'} tok ·
                输出 {compact(sessionCost.cost.own.output) ?? '—'} tok · 请求 {sessionCost.cost.own.calls ?? '—'} 次
              </p>
            ) : (
              <p className={styles.muted}>{sessionCost?.reason ?? '暂无数据'}</p>
            )}
          </section>
          <section>
            <h3>发送前预估(不含本次输出计费)</h3>
            {estimate?.available === true ? (
              <p className={styles.muted}>
                预估输入 ≈{estimate.inputTokens ?? '—'} tok(当前上下文,按缓存命中 {Math.round((estimate.cacheHitAssumption ?? 0) * 100)}% 假设)·
                输出区间 {estimate.outputTokens?.[0] ?? '—'}–{estimate.outputTokens?.[1] ?? '—'} tok。
                实际用量以回复完成后的账单为准(消息下方显示实际费用)。
                {estimate.inputCost !== undefined && ` · 输入部分按当前模型价格约 $${estimate.inputCost.toFixed(4)}(估算,非账单)。`}
              </p>
            ) : (
              <p className={styles.muted}>{estimate?.reason ?? '预估不可用(需要 dsh-context 上下文数据与 dsh-cost-meter 价格目录)。'}</p>
            )}
          </section>
          <section>
            <h3>今日费用与预算</h3>
            {today?.available === true ? (
              <>
                <p>费用 {formatCost(today.cost) ?? '暂无金额'} · 输入 {compact(today.input) ?? 0} tok · 输出 {compact(today.output) ?? 0} tok · 请求 {today.calls ?? 0} 次</p>
                {today.budget?.cap !== undefined
                  ? <p>预算({today.budget.period === 'day' ? '每日' : today.budget.period === 'month' ? '每月' : today.budget.period ?? '周期'}):
                    已用 {formatCost(today.budget.used) ?? '暂无金额'} / 上限 ${today.budget.cap}
                    {budgetRatio !== undefined ? `(${Math.round(budgetRatio * 100)}%)` : ''}</p>
                  : <p className={styles.muted}>未设置预算。可在 dsh-cost-meter 设置中配置每日预算,ChatDS 将按其账目提醒。</p>}
                <p className={styles.muted}>完整仪表盘与价格设置请打开 DSH 原生设置 → dsh-cost-meter(不在两处维护两份价格)。</p>
              </>
            ) : (
              <p className={styles.muted}>{today?.reason ?? '暂无数据'}</p>
            )}
          </section>
        </div>
      </Modal>
    )}
  </>
})
