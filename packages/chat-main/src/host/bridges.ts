/**
 * R8 官方服务桥 — dsh-context / dsh-cost-meter / DSH 工具注册表。
 *
 * 原则(任务 §11):
 * - 只读数据一律走官方服务/投影;全部经 ctx.get() 可选读取,服务未安装时
 *   返回 available:false 与真实原因,绝不伪造数据、绝不自建第二份数据库。
 * - dsh-context:上下文用量来自官方 sessionProjections 投影(contextTimeline/
 *   contextHeaders/contextActivity,由 dsh-context 插件注册)。
 * - dsh-cost-meter:费用/价格/预算来自官方 costMeter 服务(ctx.provide('costMeter'));
 *   不复制价格表,不重扫 Session 文件。
 * - 工具目录来自 ctx.tools；WebChat 不执行需要 Agent 审批的外部工具。
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'

// ── dsh-context 上下文投影(R8 §四) ──

/** dsh-context contextTimeline 投影中本插件消费的字段。 */
interface ContextTimelineView {
  current?: { system?: number; tools?: number; user?: number; inject?: number; skill?: number; assistant?: number; tool?: number; total?: number }
  contextWindow?: number
  requests?: readonly { seq?: number; time?: number; model?: string; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; cost?: number }[]
  events?: readonly { seq?: number; time?: number; kind?: string; title?: string; detail?: string }[]
}

export interface ContextStatus {
  available: boolean
  reason?: string
  sessionId?: string
  usage?: NonNullable<ContextTimelineView['current']>
  contextWindow?: number
  ratio?: number
  nearLimit?: boolean
  requests?: ContextTimelineView['requests']
  recentEvents?: ContextTimelineView['events']
}

type ProjectionSnapshotFn = (session: Session, keys?: string[]) => { asOfSeq?: number; values?: Record<string, unknown> } | undefined

/**
 * 读取当前会话的上下文状态(官方投影;数据由 dsh-context 提供)。
 * dsh-context 未安装或投影尚未产出时 available:false。
 */
export function contextStatus(ctx: Context, session: Session): ContextStatus {
  const projections = ctx.get('sessionProjections') as { snapshot?: ProjectionSnapshotFn } | undefined
  if (typeof projections?.snapshot !== 'function') {
    return { available: false, reason: 'DSH 会话投影服务不可用(sessionProjections 未挂载)', sessionId: session.id }
  }
  let snapshot: ReturnType<ProjectionSnapshotFn>
  try {
    snapshot = projections.snapshot(session, ['contextTimeline'])
  } catch {
    return { available: false, reason: 'dsh-context 暂时无法读取上下文投影。', sessionId: session.id }
  }
  const timeline = snapshot?.values?.['contextTimeline'] as ContextTimelineView | undefined
  if (timeline == null || typeof timeline !== 'object') {
    return {
      available: false,
      reason: 'dsh-context 未安装或尚未为该会话生成上下文统计。',
      sessionId: session.id,
    }
  }
  const usage = timeline.current
  const contextWindow = timeline.contextWindow
  const total = usage?.total
  const ratio = typeof total === 'number' && typeof contextWindow === 'number' && contextWindow > 0
    ? total / contextWindow
    : undefined
  return {
    available: true,
    sessionId: session.id,
    ...(usage !== undefined ? { usage } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(ratio !== undefined ? { ratio, nearLimit: ratio >= 0.85 } : {}),
    ...(Array.isArray(timeline.requests) ? { requests: timeline.requests.slice(-12) } : {}),
    ...(Array.isArray(timeline.events) ? { recentEvents: timeline.events.slice(-12) } : {}),
  }
}

// ── dsh-cost-meter 费用桥(R8 §五) ──

export interface CostMeterDay {
  date: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  calls: number
  cost: number
  apiCost: number
  byProviderModel?: Record<string, unknown>
}

export interface CostBudgetView {
  period?: string
  cap?: number
  used?: number
  /** 当前周期用量相对上限的比例(cap 存在时)。 */
  ratio?: number
}

/** R8.5:cost-meter 外部用量账本(chatds-rich 经官方 external_usage.json 注入)的日视图。 */
export interface CostExternalDay {
  input?: number
  output?: number
  cached?: number
  cacheWrite?: number
  calls?: number
  cost?: number
}

export interface CostTodayView {
  available: boolean
  reason?: string
  date?: string
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  calls?: number
  cost?: number
  apiCost?: number
  byProviderModel?: Record<string, unknown>
  budget?: CostBudgetView
  /** R8.5:外部用量合计(Rich 直连账目;cost-meter externalUsage.combined.today)。 */
  external?: CostExternalDay
  externalStale?: boolean
  /** R8.5:合并预算视图(native used + external today cost / cap)。 */
  budgetMerged?: CostBudgetView
  /** R8.5:Rich 流水账状态(由 host rich-ledger 维护)。 */
  richLedger?: { available: boolean; reason?: string; records24h: number }
}

interface CostMeterService {
  getDaySessions?: (date: string) => Promise<CostMeterDay>
  getSessionCost?: (sessionId: string) => Promise<unknown>
  getPriceCatalog?: () => Promise<unknown>
  updateConfig?: (patch: unknown) => unknown
  getState?: () => Promise<CostStateLike> | CostStateLike
}

interface CostStateLike {
  config?: { budget?: { period?: string; cap?: number; /** cost-meter 实际字段名:金额上限(显示币种)。 */ amount?: number; customStart?: string; customEnd?: string },
    /** 显示币种代码(cost-meter config.currency)。 */ currency?: string,
    /** USD→显示币种汇率(cost-meter config.exchangeRate,formatMoney 同语义)。 */ exchangeRate?: number, main?: boolean }
  budgetUsed?: number
  today?: { cost?: number; input?: number; output?: number }
  externalUsage?: {
    fetchedAt?: number
    stale?: boolean
    combined?: { today?: CostExternalDay }
  }
  history?: unknown
}

/** 本地日期键(与 cost-meter 账本日界一致:按 Host 本地时区)。 */
function localDayKey(now = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function costMeter(ctx: Context): CostMeterService | undefined {
  return ctx.get('costMeter' as never) as CostMeterService | undefined
}

function budgetView(state: CostStateLike | undefined): CostBudgetView | undefined {
  const budget = state?.config?.budget
  if (budget === undefined) return undefined
  // R8.5:cost-meter 预算金额字段为 amount(cap 是旧别名),两者取其一。
  const capSource = typeof budget.cap === 'number' ? budget.cap : budget.amount
  const cap = typeof capSource === 'number' && capSource > 0 ? capSource : undefined
  const period = budget.period
  const used = typeof state?.budgetUsed === 'number' ? state.budgetUsed : undefined
  const ratio = cap !== undefined && used !== undefined ? used / cap : undefined
  return { ...(period !== undefined ? { period } : {}), ...(cap !== undefined ? { cap } : {}), ...(used !== undefined ? { used } : {}), ...(ratio !== undefined ? { ratio } : {}) }
}

/** 今日费用(官方 costMeter 日账本 + 外部用量合计 + 合并预算视图)。 */
export async function costToday(ctx: Context): Promise<CostTodayView> {
  const meter = costMeter(ctx)
  if (meter === undefined || typeof meter.getDaySessions !== 'function') {
    return { available: false, reason: 'dsh-cost-meter 未安装或版本过旧,费用数据不可用。' }
  }
  const date = localDayKey()
  const day = await Promise.resolve().then(() => meter.getDaySessions!(date)).catch(() => undefined)
  let state: CostStateLike | undefined
  if (typeof meter.getState === 'function') {
    state = await Promise.resolve().then(() => meter.getState!()).catch(() => undefined)
  }
  // R8.5:外部用量(Rich 直连)与原生账本合并。原生日账本缺失时按零处理,以外部数据为准。
  const externalDay = state?.externalUsage?.combined?.today
  const externalHasData = externalDay != null && Object.values(externalDay).some((value) => typeof value === 'number' && value > 0)
  const nativeUsable = day != null && Number.isFinite(day.input) && Number.isFinite(day.output)
  if (!nativeUsable && !externalHasData) {
    return { available: false, reason: '费用账本不可用或返回了不兼容的数据。', date }
  }
  const native = nativeUsable
    ? day!
    : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, cost: 0, apiCost: 0, byProviderModel: undefined }
  const budget = budgetView(state)
  const external = externalHasData
    ? {
        ...(Number.isFinite(externalDay!.input) ? { input: externalDay!.input } : {}),
        ...(Number.isFinite(externalDay!.output) ? { output: externalDay!.output } : {}),
        ...(Number.isFinite(externalDay!.cached) ? { cached: externalDay!.cached } : {}),
        ...(Number.isFinite(externalDay!.cacheWrite) ? { cacheWrite: externalDay!.cacheWrite } : {}),
        ...(Number.isFinite(externalDay!.calls) ? { calls: externalDay!.calls } : {}),
        ...(Number.isFinite(externalDay!.cost) ? { cost: externalDay!.cost } : {}),
      }
    : undefined
  // 合并预算:原生 budgetUsed(显示币种)+ 外部今日费用(账本 USD,按汇率换算到显示币种)。
  const externalUsd = Number.isFinite(external?.cost) ? (external!.cost as number) : 0
  const displayPerUsd = (state?.config?.currency ?? 'USD') === 'USD'
    ? 1
    : (typeof state?.config?.exchangeRate === 'number' && state.config.exchangeRate > 0 ? state.config.exchangeRate : 1)
  const externalDisplayCost = externalUsd * displayPerUsd
  const budgetMerged = ((): CostBudgetView | undefined => {
    const rawBudget = state?.config?.budget
    const capSource = rawBudget === undefined ? undefined : (typeof rawBudget.cap === 'number' ? rawBudget.cap : rawBudget.amount)
    const cap = typeof capSource === 'number' && capSource > 0 ? capSource : undefined
    if (budget === undefined || cap === undefined) return budget
    const nativeUsed = typeof state?.budgetUsed === 'number' ? state.budgetUsed : budget.used
    const mergedUsed = nativeUsed !== undefined ? nativeUsed + externalDisplayCost : externalDisplayCost > 0 ? externalDisplayCost : undefined
    if (mergedUsed === undefined) return budget
    return { ...budget, used: mergedUsed, ratio: mergedUsed / cap }
  })()
  return {
    available: true,
    date,
    input: native.input,
    output: native.output,
    cacheRead: native.cacheRead,
    cacheWrite: native.cacheWrite,
    calls: native.calls,
    ...(native.calls > 0 && Number.isFinite(native.cost) && native.cost > 0 ? { cost: native.cost } : {}),
    ...(native.calls > 0 && Number.isFinite(native.apiCost) && native.apiCost > 0 ? { apiCost: native.apiCost } : {}),
    byProviderModel: native.byProviderModel,
    ...(budget !== undefined ? { budget } : {}),
    ...(external !== undefined ? { external } : {}),
    ...(state?.externalUsage?.stale === true ? { externalStale: true } : {}),
    ...(budgetMerged !== undefined ? { budgetMerged } : {}),
  }
}

/** 单会话费用(官方 costMeter 会话账目;原生账本无记录时回退 Rich 外部用量,来源如实标注)。 */
export async function costSession(
  ctx: Context,
  sessionId: string,
  ledger?: { sessionTotals(sessionId: string): { calls: number; input: number; output: number; cached: number; cacheWrite: number } | null },
): Promise<{ available: boolean; reason?: string; source?: 'native' | 'rich'; cost?: unknown }> {
  const meter = costMeter(ctx)
  if (meter === undefined || typeof meter.getSessionCost !== 'function') {
    return { available: false, reason: 'dsh-cost-meter 未安装或版本过旧,费用数据不可用。' }
  }
  const cost = await Promise.resolve().then(() => meter.getSessionCost!(sessionId)).catch(() => undefined)
  if (cost && typeof cost === 'object' && 'own' in cost && (!('found' in cost) || cost.found === true)) {
    return { available: true, source: 'native', cost }
  }
  // R8.6(6.3):纯 Rich 会话不在原生账本,但 WebChat 自己有外部记录——如实展示 tokens 与来源,
  // 不再显示含糊的"暂无账单"(金额仍以 dsh-cost-meter 外部用量区为准,不在插件内二次计价)。
  const rich = ledger?.sessionTotals(sessionId)
  if (rich) {
    return {
      available: true,
      source: 'rich',
      cost: { own: { input: rich.input, output: rich.output, cacheRead: rich.cached, cacheWrite: rich.cacheWrite, calls: rich.calls } },
    }
  }
  return { available: false, reason: '本会话暂无可用的 dsh-cost-meter 账单。' }
}

/** 官方价格目录(只读透传;不在本插件存储第二份价格)。 */
export async function costPriceCatalog(ctx: Context): Promise<{ available: boolean; reason?: string; catalog?: unknown }> {
  const meter = costMeter(ctx)
  if (meter === undefined || typeof meter.getPriceCatalog !== 'function') {
    return { available: false, reason: 'dsh-cost-meter 未安装,价格目录不可用。' }
  }
  const catalog = await Promise.resolve().then(() => meter.getPriceCatalog!()).catch(() => undefined)
  return catalog != null && typeof catalog === 'object'
    ? { available: true, catalog }
    : { available: false, reason: 'dsh-cost-meter 价格目录不可用。' }
}

/** 事前预估(R8 §5.6):输入取上下文实际用量,输出按近期回复长度估算,价格取官方目录。 */
export async function costEstimate(
  ctx: Context,
  session: Session,
  draftChars: number,
): Promise<{
  available: boolean
  reason?: string
  inputTokens?: number
  outputTokens?: [number, number]
  inputCost?: number
  totalEstimate?: [number, number]
  currency?: string
  cacheHitAssumption?: number
}> {
  const meter = costMeter(ctx)
  if (meter === undefined) {
    return { available: false, reason: 'dsh-cost-meter 未安装,无法估算费用。' }
  }
  const status = contextStatus(ctx, session)
  const contextTokens = status.usage?.total
  if (typeof contextTokens !== 'number') {
    return { available: false, reason: '上下文用量数据不可用(dsh-context),输入 Token 无法估算。' }
  }
  // 输出区间:近 5 条助手回复的字符量 → token(≈4 字符/token,中文≈1.6 字符/token,取保守区间)。
  const events = session.snapshotEvents(SessionLogOffset(0))
  const replyChars: number[] = []
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    let text = ''
    for (const block of (event.data as { message?: { content?: readonly { type?: string; text?: string }[] } }).message?.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string') text += block.text
    }
    if (text.length > 0) replyChars.push(text.length)
  }
  const recent = replyChars.slice(-5)
  const avgChars = recent.length > 0 ? recent.reduce((sum, value) => sum + value, 0) / recent.length : 800
  const toTokens = (chars: number) => Math.max(32, Math.round(chars / 2.4))
  const outputTokens: [number, number] = [Math.round(toTokens(avgChars) * 0.6), Math.round(toTokens(avgChars) * 1.5)]
  const inputTokens = Math.round(contextTokens + draftChars / 2.4)
  // 价格:官方目录中匹配当前模型(ctx.llm 价格仅 image 有官方接口;目录由 cost-meter 维护)。
  let inputCost: number | undefined
  let currency: string | undefined
  const catalog = await costPriceCatalog(ctx).catch(() => undefined)
  if (catalog?.available === true) {
    const header = session.requestHeader()
    const model = (header?.config as { model?: string } | undefined)?.model
    const entry = model !== undefined ? findCatalogEntry(catalog.catalog, model) : undefined
    const price = entry?.input ?? entry?.prompt ?? entry?.price?.input
    if (typeof price === 'number') {
      inputCost = price * inputTokens / 1_000_000
      currency = typeof entry?.currency === 'string' ? entry.currency : undefined
    }
  }
  const cacheHitAssumption = 0.6
  return {
    available: true,
    inputTokens,
    outputTokens,
    ...(inputCost !== undefined ? { inputCost, currency } : {}),
    cacheHitAssumption,
  }
}

/** 在官方价格目录中尽力匹配一个模型条目(仅估算展示用;权威计费永远在 cost-meter)。 */
function findCatalogEntry(catalog: unknown, model: string): { input?: number; prompt?: number; currency?: string; price?: { input?: number } } | undefined {
  if (catalog === null || typeof catalog !== 'object') return undefined
  const visit = (node: unknown, depth: number): { input?: number; prompt?: number; currency?: string; price?: { input?: number } } | undefined => {
    if (depth > 4 || node === null || typeof node !== 'object') return undefined
    const record = node as Record<string, unknown>
    const id = record.id ?? record.model ?? record.name
    if (typeof id === 'string' && (id === model)) {
      return record as { input?: number; prompt?: number; currency?: string; price?: { input?: number } }
    }
    for (const value of Object.values(record)) {
      if (value !== null && typeof value === 'object') {
        const found = visit(value, depth + 1)
        if (found !== undefined) return found
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          const found = visit(item, depth + 1)
          if (found !== undefined) return found
        }
      }
    }
    return undefined
  }
  return visit(catalog, 0)
}

// ── DSH 工具注册表桥(R8 §六) ──

export function costMeterAvailable(ctx: Context): boolean {
  return Boolean(costMeter(ctx)?.getSessionCost)
}

export function contextProjectionAvailable(ctx: Context): boolean {
  const projections = ctx.get('sessionProjections') as { snapshot?: unknown } | undefined
  return typeof projections?.snapshot === 'function'
}

export interface ListedTool {
  name: string
  description: string
  parameters: unknown
  /** 授权状态:全局授权(设置)与会话授权(聊天)分别由调用方合并。 */
  registered: boolean
  /** 官方注册表中是否带执行条件(when)——执行前需解析工具集,当前不支持独立执行。 */
  conditional: boolean
  executable: false
}

interface ToolsRegistryLike {
  schemas?: (scope?: unknown) => { name: string; description?: string; parameters?: unknown }[]
  executable?: (name: string, scope?: unknown) => unknown
}

/** 列出官方注册表中的工具(真实已注册能力;不含授权状态)。 */
export function listRegisteredTools(ctx: Context, max = 200): ListedTool[] {
  const registry = ctx.get('tools' as never) as ToolsRegistryLike | undefined
  const schemas = registry?.schemas?.() ?? []
  return schemas.slice(0, max).map((schema) => {
    return {
      name: schema.name,
      description: (schema.description ?? '').slice(0, 500),
      parameters: schema.parameters ?? {},
      registered: true,
      conditional: typeof registry?.executable === 'function' && registry.executable(schema.name) === undefined,
      executable: false,
    }
  })
}

// rc.5 does not expose trusted read-only declarations or a one-shot approval
// capability for standalone calls. Legacy grants therefore confer no execution rights.
export const DSH_TOOL_APPROVAL_REQUIRED = '此工具需要 DSH Agent 审批，当前 WebChat 不支持直接执行。'
