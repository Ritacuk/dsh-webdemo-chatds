/**
 * R8.5:Rich 直连用量 → dsh-cost-meter 统一账本。
 *
 * Rich 通路绕过 ctx.llm,官方 backfill 拿不到 canonical usage;此前只把 usage 写进
 * 会话日志的 ignorable plugin 记录(页面展示用),费用从不进任何账本。本模块把每次
 * Rich 调用按 dsh-cost-meter 的**官方 external_usage.json 文件协议**(docs/external-usage.md)
 * 注入其外部用量账本:
 *   - 逐调用记录模式:provider/model/at 由 cost-meter 按其价表(含峰谷)计价;
 *   - 稳定 id(assistant 消息 id)保证重放/重写快照不重复计费(整份替换,幂等);
 *   - cache_read → cached 桶,cache_creation → cacheWrite 桶,不把缓存读误计为输入。
 *
 * 本插件自己的流水账保存在 <dshHome>/chat-workspace/rich-usage-ledger.json
 * (>30 天自动丢弃;上限 5000 条/512KiB,与协议限制一致),external_usage.json
 * 由流水账整份推导。cost-meter 未安装/价表无该模型时跳过写入并记录原因——
 * 绝不伪造账单,缺口在集成状态与页面如实呈现。
 *
 * 已知边界(如实呈现,不掩饰):cost-meter 原生"预算"图框只统计 DSH 自身账本;
 * Rich 金额进入其外部用量区与今日/合计合计数。WebChat 页面的预算比例用
 * native + external 合并视图计算(bridges.ts)。
 */

import { homedir } from 'node:os'
import { rename, writeFile } from 'node:fs/promises'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { AssistantMessage as DemoAssistant } from '@dsh-chat/shared'

/** 与 cost-meter external_usage.md 协议一致的逐调用记录。 */
interface ExternalUsageRecord {
  id: string
  at: string
  provider: string
  model: string
  input: number
  output: number
  /** 本机 cost-meter 校验必填(与官方文档的"可选"描述不一致,以运行时代码为准)。 */
  cached: number
  cacheWrite?: number
  reasoning?: number
}

interface LedgerFile {
  records: ExternalUsageRecord[]
}

/** 对外状态(集成状态页与设置页显示)。 */
export interface RichLedgerStatus {
  /** cost-meter 是否可用且价表可用。 */
  available: boolean
  /** 不可用的具体原因(available=false 时给出)。 */
  reason?: string
  /** 已写入的记录条数(本地流水账,含 30 天内的全部)。 */
  records: number
  /** 最近一次写入 external_usage.json 是否失败。 */
  lastError?: string
}

/** DeepSeek 官方 Messages API 的 provider 名(与 cost-meter 价表命名对齐)。 */
const PROVIDER = 'deepseek'
const SOURCE_NAME = 'chatds-rich'
const MAX_RECORDS = 5000
const MAX_FILE_BYTES = 512 * 1024
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000
/** 防抖窗口:同一回合的多次落盘合并为一次快照重写。 */
const FLUSH_DEBOUNCE_MS = 2000

/** DeepSeek Harness 用户主目录(语义与 files.ts/dsh-home-paths 一致:DSH_HOME 覆盖,否则 ~/.dsh)。 */
function dshHome(): string {
  const override = process.env['DSH_HOME']
  if (typeof override === 'string' && override.trim() !== '') return override
  return join(homedir(), '.dsh')
}

export class RichUsageLedger {
  private records: ExternalUsageRecord[] = []
  private loaded = false
  private loading: Promise<void> | undefined
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private pricedModels: Set<string> | undefined
  private unavailableReason: string | undefined
  private lastError: string | undefined
  private closed = false

  constructor(private readonly ctx: Context) {}

  /** 记一笔 Rich 用量(fire-and-forget;失败只记状态,绝不影响回合)。 */
  append(info: { messageId: string; at: number; model: string; usage: NonNullable<DemoAssistant['usage']> }): void {
    if (this.closed) return
    void this.appendAsync(info).catch((error) => {
      this.lastError = error instanceof Error ? error.message : String(error)
    })
  }

  private async appendAsync(info: { messageId: string; at: number; model: string; usage: NonNullable<DemoAssistant['usage']> }): Promise<void> {
    const usage = info.usage
    const input = Math.max(0, Math.round(usage.input_tokens ?? 0))
    const output = Math.max(0, Math.round(usage.output_tokens ?? 0))
    const cached = Math.max(0, Math.round(usage.cache_read_input_tokens ?? 0))
    const cacheWrite = Math.max(0, Math.round(usage.cache_creation_input_tokens ?? 0))
    if (input === 0 && output === 0 && cached === 0 && cacheWrite === 0) return
    const record: ExternalUsageRecord = {
      id: `${SOURCE_NAME}:${info.messageId}`,
      at: new Date(info.at).toISOString(),
      provider: PROVIDER,
      model: info.model,
      input,
      output,
      // 本机 cost-meter(1.9.x)校验要求 cached 必填(缺省即整份快照拒收,与文档"可选"不符),
      // 因此恒写入;cacheWrite/reasoning 保留可选语义。
      cached,
      ...(cacheWrite > 0 ? { cacheWrite } : {}),
    }
    await this.ensureLoaded()
    // 稳定 id 幂等:同一消息重放/重写不产生第二条账目。
    const existing = this.records.findIndex((entry) => entry.id === record.id)
    if (existing >= 0) this.records[existing] = record
    else this.records.push(record)
    this.trim()
    this.scheduleFlush()
  }

  /** cost-meter 价表校验:模型无价时整份快照会失效,必须先过滤。 */
  private async ensurePriced(model: string): Promise<boolean> {
    if (this.pricedModels === undefined) {
      const meter = this.ctx.get('costMeter' as never) as
        | { getPriceCatalog?: () => Promise<unknown> }
        | undefined
      if (typeof meter?.getPriceCatalog !== 'function') {
        this.unavailableReason = 'dsh-cost-meter 未安装或未提供价表服务。'
        return false
      }
      try {
        const catalog = await Promise.resolve().then(() => meter.getPriceCatalog!())
        const names = new Set<string>()
        collectModelNames(catalog, names, 0)
        this.pricedModels = names
      } catch (error) {
        this.unavailableReason = `价表读取失败:${error instanceof Error ? error.message : String(error)}`
        return false
      }
    }
    return this.pricedModels.has(model)
  }

  private trim(): void {
    const cutoff = Date.now() - RETENTION_MS
    this.records = this.records.filter((record) => Date.parse(record.at) >= cutoff)
    while (this.records.length > MAX_RECORDS) this.records.shift()
    // 整份快照 ≤512KiB:超限时丢最旧直到满足(协议硬限,超出会被整体忽略)。
    while (JSON.stringify({ fetchedAt: new Date().toISOString(), source: SOURCE_NAME, records: this.records }).length > MAX_FILE_BYTES && this.records.length > 0) {
      this.records.shift()
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== undefined) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      void this.flushNow().catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error)
      })
    }, FLUSH_DEBOUNCE_MS)
  }

  /** 写本地流水账 + 整份替换 external_usage.json(同目录临时文件 + 原子 rename)。 */
  private async flushNow(): Promise<void> {
    if (this.closed) return
    // 只写价表覆盖的模型;未覆盖的留待下次价表刷新后再入账(先记录,不丢弃)。
    // 写出前归一化:cached 恒补(本机 cost-meter 校验必填),历史挂起记录一并修复。
    const writable: ExternalUsageRecord[] = []
    const skippedModels = new Set<string>()
    for (const record of this.records) {
      if (await this.ensurePriced(record.model)) writable.push({ ...record, cached: record.cached ?? 0 })
      else skippedModels.add(record.model)
    }
    if (skippedModels.size > 0 && writable.length === 0 && this.unavailableReason === undefined) {
      this.unavailableReason = `价表未覆盖模型:${[...skippedModels].join(', ')}(账目暂缓,待价表可用后入账)`
    }
    const ledgerDir = join(dshHome(), 'chat-workspace')
    const ledgerPath = join(ledgerDir, 'rich-usage-ledger.json')
    const meterDir = join(dshHome(), 'storages', 'cost-meter')
    const snapshotPath = join(meterDir, 'external_usage.json')
    if (writable.length === 0) {
      await this.writeLedger(ledgerPath)
      if (!existsSync(meterDir)) {
        this.unavailableReason ||= 'dsh-cost-meter 数据目录不存在(未安装或未运行)。'
        return
      }
      return
    }
    if (!existsSync(meterDir)) {
      this.unavailableReason ||= 'dsh-cost-meter 数据目录不存在(未安装或未运行)。'
      await this.writeLedger(ledgerPath)
      return
    }
    const snapshot = JSON.stringify({
      fetchedAt: new Date().toISOString(),
      source: SOURCE_NAME,
      records: writable,
    })
    const tmpLedger = `${ledgerPath}.tmp-${process.pid}`
    await writeFile(tmpLedger, JSON.stringify({ records: this.records }, null, 0), 'utf8')
    await rename(tmpLedger, ledgerPath)
    const tmpSnapshot = `${snapshotPath}.tmp-${process.pid}`
    await writeFile(tmpSnapshot, snapshot, 'utf8')
    await rename(tmpSnapshot, snapshotPath)
    this.lastError = undefined
  }

  private async writeLedger(path: string): Promise<void> {
    const dir = join(dshHome(), 'chat-workspace')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const tmp = `${path}.tmp-${process.pid}`
    await writeFile(tmp, JSON.stringify({ records: this.records }, null, 0), 'utf8')
    await rename(tmp, path)
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.loading ??= (async () => {
      try {
        const path = join(dshHome(), 'chat-workspace', 'rich-usage-ledger.json')
        const raw = await import('node:fs/promises').then((fs) => fs.readFile(path, 'utf8')).catch(() => null)
        if (raw !== null) {
          const parsed = JSON.parse(raw) as LedgerFile
          if (Array.isArray(parsed.records)) {
            this.records = parsed.records.filter((record) =>
              typeof record?.id === 'string' && typeof record?.at === 'string' && typeof record?.model === 'string')
          }
        }
      } catch {
        // 损坏则从空账本开始(external_usage.json 由 cost-meter 侧独立校验,不受影响)
      }
      this.loaded = true
    })()
    await this.loading
  }

  /** 停用:取消防抖并立即落盘一次。 */
  async dispose(): Promise<void> {
    this.closed = true
    if (this.flushTimer !== undefined) clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    try {
      await this.flushNow()
    } catch {
      // 停用路径尽力而为
    }
  }

  status(): RichLedgerStatus {
    return {
      available: this.unavailableReason === undefined && this.lastError === undefined,
      ...(this.unavailableReason !== undefined ? { reason: this.unavailableReason } : {}),
      records: this.records.length,
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
    }
  }

  /** 最近 24h 内已记录的 Rich 调用数(页面显示用)。 */
  recentCount(): number {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    return this.records.filter((record) => Date.parse(record.at) >= cutoff).length
  }
}

/**
 * 从价表结构里收集模型名。cost-meter 官方 PriceCatalog 形状是
 * Record<provider, Record<family, Record<modelId, entry>>>——模型 id 是第三层
 * 对象的键;先按此三层精确提取,再退回通用的属性名扫描兜底。
 */
function collectModelNames(value: unknown, out: Set<string>, depth = 0): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return
  const record = value as Record<string, unknown>
  // 精确形状:provider → family → modelId(第三层对象的键 = 模型 id)
  const providers = Object.values(record).filter((child) => child !== null && typeof child === 'object' && !Array.isArray(child))
  if (providers.length > 0) {
    for (const provider of providers) {
      for (const family of Object.values(provider as Record<string, unknown>)) {
        if (family === null || typeof family !== 'object' || Array.isArray(family)) continue
        for (const [modelId, entry] of Object.entries(family as Record<string, unknown>)) {
          if (modelId.length <= 200 && entry !== null && typeof entry === 'object') out.add(modelId)
        }
      }
    }
    if (out.size > 0) return
  }
  if (depth > 6) return
  for (const [key, child] of Object.entries(record)) {
    if ((key === 'model' || key === 'modelId' || key === 'id' || key === 'name') && typeof child === 'string' && child.length <= 200) {
      out.add(child)
    }
    collectModelNames(child, out, depth + 1)
  }
}
