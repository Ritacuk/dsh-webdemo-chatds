/**
 * 工作区 KV 存储(P2)— 单一 KV 域 chat_workspace,三张表:
 * - sessions: 会话索引缓存(权威=Session 日志)
 * - prefs:    运行时默认值(defaults)与会话偏好(sess:<id>;权威=会话日志 settings 记录)
 * - files:    附件元数据索引(权威=会话日志 user 事件中的附件引用;字节在文件目录)
 *
 * dsh-storage-domain 要求每域名单开,因此全插件共用本类持有的一把句柄。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type {
  SessionTurnPrefs,
  WorkspaceSettings,
  ModelRef,
  PromptTemplate,
} from '@dsh-chat/shared'
import { currentProfile } from './profile.js'
import { writePluginRecord } from './plugin-record.js'
import { prefsFromSession as prefsFromSessionEvents } from './prefs.js'

/** 运行时默认值(页面可改;授权目录由 Host 强制执行)。 */
export const DEFAULT_SETTINGS: WorkspaceSettings = {
  interfaceLanguage: 'browser',
  sendShortcut: 'enter',
  enableVoiceInput: false,
  appearanceMode: 'dsh',
  appearanceStyle: 'default',
  appearanceGlass: 'off',
  readingFontSize: 16,
  readingWidth: 'preset',
  defaultMode: 'chat',
  defaultThinking: 'off',
  defaultSearch: false,
  defaultLocalSearch: false,
  rememberLastModel: true,
  authorizedDirs: [],
  maxFileBytes: 20 * 1024 * 1024,
  maxSnippetChars: 12_000,
  maxPlanSteps: 3,
  requestDiagnostics: false,
  modelScope: 'all',
  modelWhitelist: [],
  favoriteModels: [],
  globalPromptEnabled: false,
  globalPromptText: '',
  authorizedTools: [],
  budgetWarnThresholds: [0.5, 0.8, 1],
  budgetRemindersEnabled: true,
}

const ModelRefSchema = z.object({
  channel: z.enum(['rich', 'generic']),
  provider: z.string().max(200).optional(),
  model: z.string().min(1).max(300),
})

const SettingsPatchSchema = z.object({
  interfaceLanguage: z.enum(['browser', 'zh-CN', 'en-US', 'ja-JP']).optional(),
  sendShortcut: z.enum(['enter', 'ctrl-enter']).optional(),
  enableVoiceInput: z.boolean().optional(),
  appearanceMode: z.enum(['dsh', 'light', 'dark', 'system']).optional(),
  appearanceStyle: z.enum(['default', 'gpt', 'gemini', 'claude']).optional(),
  appearanceGlass: z.enum(['off', 'light', 'strong']).optional(),
  readingFontSize: z.number().int().min(14).max(20).optional(),
  readingWidth: z.enum(['preset', 'narrow', 'wide']).optional(),
  // R8.6(七):自由外观系统(全部可选;null = 恢复默认;缺省 = 官方 demo 默认观感)。
  appearanceAccent: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullish(),
  appearanceBgAlpha: z.number().min(0.4).max(1).nullish(),
  appearancePanelAlpha: z.number().min(0.4).max(1).nullish(),
  appearanceComposerAlpha: z.number().min(0.4).max(1).nullish(),
  appearanceLineHeight: z.number().min(1.4).max(1.9).nullish(),
  appearanceRadius: z.number().int().min(0).max(30).nullish(),
  appearanceDensity: z.enum(['compact', 'standard', 'relaxed']).nullish(),
  appearanceComposerWidth: z.number().int().min(480).max(1040).nullish(),
  defaultMode: z.enum(['chat', 'plan']).optional(),
  defaultThinking: z.enum(['off', 'enabled', 'low', 'high', 'max']).optional(),
  defaultSearch: z.boolean().optional(),
  defaultLocalSearch: z.boolean().optional(),
  rememberLastModel: z.boolean().optional(),
  lastModel: z.object({
    channel: z.enum(['rich', 'generic']),
    provider: z.string().optional(),
    model: z.string(),
  }).optional(),
  authorizedDirs: z.array(z.string()).max(16).optional(),
  maxFileBytes: z.number().int().positive().max(512 * 1024 * 1024).optional(),
  maxSnippetChars: z.number().int().positive().max(200_000).optional(),
  maxPlanSteps: z.number().int().min(1).max(20).optional(),
  requestDiagnostics: z.boolean().optional(),
  modelScope: z.enum(['all', 'whitelist']).optional(),
  modelWhitelist: z.array(ModelRefSchema).max(500).optional(),
  favoriteModels: z.array(ModelRefSchema).max(100).optional(),
  defaultModel: ModelRefSchema.optional(),
  globalPromptEnabled: z.boolean().optional(),
  globalPromptText: z.string().max(20_000).optional(),
  /** R8:全局授权的第三方工具名(默认空;会话内另有 planGrants 双重门)。 */
  authorizedTools: z.array(z.string().max(200)).max(200).optional(),
  /** R8:费用预算提醒阈值比例(0-1;基于 cost-meter 预算视图)。 */
  budgetWarnThresholds: z.array(z.number().min(0.1).max(1)).max(5).optional(),
  budgetRemindersEnabled: z.boolean().optional(),
})

type SettingsPatch = z.infer<typeof SettingsPatchSchema>

const KEY_DEFAULTS = 'defaults'

/** R8.6(七):外观字段支持 null(= 恢复默认);读取时剥离,使缺省观感生效。 */
const appearanceNullableKeys = [
  'appearanceAccent', 'appearanceBgAlpha', 'appearancePanelAlpha', 'appearanceComposerAlpha',
  'appearanceLineHeight', 'appearanceRadius', 'appearanceDensity', 'appearanceComposerWidth',
] as const

const SESSION_PREFS_SCHEMA = z.object({
  // 键本身编码会话 id(sess-<sessionId>),记录内不再重复。
  mode: z.enum(['chat', 'plan']),
  channel: z.enum(['rich', 'generic']),
  provider: z.string().optional(),
  model: z.string(),
  thinking: z.string().min(1).max(128),
  search: z.boolean(),
  localSearch: z.boolean(),
})

/** 附件元数据索引(files 字节存放于附件目录,不进 KV)。 */
const ATTACHMENT_SCHEMA = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  name: z.string().min(1),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  storedPath: z.string(),
  archiveOnly: z.boolean().optional(),
  handling: z.enum(['local-inline', 'local-extract', 'cloud-files-api', 'unsupported']),
  handlingNote: z.string().optional(),
  error: z.string().optional(),
  createdAt: z.number().int().nonnegative(),
  cloudReference: z.object({
    id: z.string().min(1),
    origin: z.string().url(),
    credentialRef: z.string().min(1),
  }).optional(),
})
export type AttachmentRecord = z.infer<typeof ATTACHMENT_SCHEMA>

const workspaceDomainSpec = (name: string) => defineDomain({
  name,
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    sessions: domainTable(z.object({
      id: z.string().min(1),
      title: z.string().nullable(),
      importFingerprint: z.string().optional(),
      manualTitle: z.string().optional(),
      pinned: z.boolean().optional(),
      archived: z.boolean().optional(),
      /** R8.5:附件上传/交接单预建的占位会话;首条用户消息落盘前不出现在历史列表。 */
      draft: z.boolean().optional(),
      createdAt: z.number().int().nonnegative(),
      updatedAt: z.number().int().nonnegative(),
      messageCount: z.number().int().nonnegative(),
      hidden: z.boolean(),
    })),
    prefs: domainTable(z.object({
      key: z.string().min(1),
      /** 严格子对象:defaults 或会话偏好。 */
      defaults: SettingsPatchSchema.optional(),
      session: SESSION_PREFS_SCHEMA.optional(),
      /** R8:会话级工具授权(本地工具名或官方注册表工具名)。 */
      planGrants: z.array(z.string().max(200)).optional(),
      /** R8:已删除默认模板 id(删除后不复活)。 */
      deletedPrompts: z.array(z.string().max(80)).max(200).optional(),
    })),
    files: domainTable(ATTACHMENT_SCHEMA),
    /** R8:提示词模板(id 即键;Profile 隔离由 storageDomain 保证)。 */
    prompts: domainTable(z.object({
      id: z.string().min(1).max(80),
      name: z.string().min(1).max(120),
      category: z.string().max(60),
      summary: z.string().max(500),
      body: z.string().min(1).max(40_000),
      tags: z.array(z.string().max(40)).max(12),
      builtin: z.boolean().optional(),
      createdAt: z.number().int().nonnegative(),
      updatedAt: z.number().int().nonnegative(),
    })),
  },
})

type WorkspaceDomain = Domain<ReturnType<typeof workspaceDomainSpec>>

export class WorkspaceStore {
  private domain: WorkspaceDomain | undefined
  private opening: Promise<WorkspaceDomain> | undefined

  private readonly profile: string
  private readonly defaultsKey: string

  constructor(private readonly ctx: Context, private readonly domainName = 'chat_workspace') {
    this.profile = currentProfile(ctx)
    this.defaultsKey = 'defaults-' + encodeURIComponent(this.profile)
  }

  validateSettings(patch: unknown): SettingsPatch {
    return SettingsPatchSchema.parse(patch)
  }

  private storedDefaults(domain: WorkspaceDomain): SettingsPatch {
    const prefs = domain.table('prefs')
    return prefs.get(this.defaultsKey)?.defaults
      ?? (this.profile === 'desktop' ? prefs.get('defaults-default')?.defaults ?? prefs.get(KEY_DEFAULTS)?.defaults : undefined)
      ?? {}
  }

  /** 惰性打开(进程内单例)。 */
  async ensure(): Promise<WorkspaceDomain> {
    if (this.domain !== undefined) return this.domain
    if (this.opening === undefined) {
      this.opening = this.ctx.storageDomain.open(workspaceDomainSpec(this.domainName)).then((domain) => {
        this.domain = domain
        return domain
      })
    }
    return await this.opening
  }

  /** 停用时关闭。 */
  async close(): Promise<void> {
    await this.domain?.close().catch(() => {})
    this.domain = undefined
    this.opening = undefined
  }

  // ── 运行时设置 ──

  /**
   * R8.6(7.5):旧多品牌风格(appearanceStyle)一次性迁移到自由外观字段。
   * 只补齐用户未自定义的字段,尽量保留既有颜色与阅读偏好;迁移后写回,appearanceStyle 归位 default。
   */
  private migrateAppearance(stored: SettingsPatch): SettingsPatch {
    if (stored.appearanceStyle === undefined || stored.appearanceStyle === 'default') return stored
    const legacy: SettingsPatch = { ...stored }
    const style = stored.appearanceStyle
    if (style === 'gpt') {
      legacy.appearanceAccent ??= '#488374'
      legacy.appearanceDensity ??= 'compact'
      legacy.appearanceRadius ??= 18
    } else if (style === 'gemini') {
      legacy.appearanceAccent ??= '#6467bd'
      legacy.appearanceDensity ??= 'standard'
      legacy.appearanceRadius ??= 30
    } else if (style === 'claude') {
      legacy.appearanceAccent ??= '#a9624b'
      legacy.appearanceDensity ??= 'relaxed'
      legacy.appearanceLineHeight ??= 1.75
    }
    legacy.appearanceStyle = 'default'
    return legacy
  }

  async getSettings(rowDefaults: Partial<WorkspaceSettings>): Promise<WorkspaceSettings> {
    const domain = await this.ensure()
    const stored = this.storedDefaults(domain)
    const migrated = this.migrateAppearance(stored)
    // R8.6(七):null = 恢复默认——读取时剥离,null 不外发(字段缺省即默认观感)。
    const cleaned: SettingsPatch = { ...migrated }
    for (const key of appearanceNullableKeys) {
      if (cleaned[key] === null) delete cleaned[key]
    }
    if (cleaned !== stored) {
      // 迁移结果持久化,避免每次读取重复映射(幂等;失败时下次重试)。
      void this.editSettings(() => cleaned).catch(() => {})
    }
    // 上一循环已在运行时剥离所有 null;TS 无法据此收窄 SettingsPatch 的可空字段,这里显式断言。
    return { ...DEFAULT_SETTINGS, ...rowDefaults, ...cleaned } as WorkspaceSettings
  }

  private settingsWrite: Promise<unknown> = Promise.resolve()

  updateSettings(patch: SettingsPatch): Promise<WorkspaceSettings> {
    return this.editSettings(() => patch)
  }

  editSettings(edit: (current: WorkspaceSettings) => SettingsPatch | Promise<SettingsPatch>): Promise<WorkspaceSettings> {
    const operation = this.settingsWrite.then(() => this.writeSettings(edit))
    this.settingsWrite = operation.catch(() => {})
    return operation
  }

  private async writeSettings(edit: (current: WorkspaceSettings) => SettingsPatch | Promise<SettingsPatch>): Promise<WorkspaceSettings> {
    const domain = await this.ensure()
    const current = this.storedDefaults(domain)
    const patch = await edit({ ...DEFAULT_SETTINGS, ...current } as WorkspaceSettings)
    const next = { ...current, ...patch }
    await domain.table('prefs').put(this.defaultsKey, { key: this.defaultsKey, defaults: next })
    // R8.6(七):响应与 GET 同口径——剥离 null(null 仅作为「恢复默认」的存储语义)。
    const resolved: SettingsPatch = { ...next }
    for (const key of appearanceNullableKeys) {
      if (resolved[key] === null) delete resolved[key]
    }
    return { ...DEFAULT_SETTINGS, ...resolved } as WorkspaceSettings
  }

  async lastModel(): Promise<WorkspaceSettings['lastModel']> {
    const domain = await this.ensure()
    return this.storedDefaults(domain).lastModel
  }

  async setLastModel(last: NonNullable<WorkspaceSettings['lastModel']>): Promise<void> {
    await this.updateSettings({ lastModel: last })
  }

  // ── 会话偏好 ──

  async planGrants(sessionId: string): Promise<string[]> {
    const table = (await this.ensure()).table('prefs')
    return table.get(`plan-grants-${sessionId}`)?.planGrants ?? []
  }

  async setPlanGrants(sessionId: string, grants: string[]): Promise<void> {
    const key = `plan-grants-${sessionId}`
    await (await this.ensure()).table('prefs').put(key, { key, planGrants: [...new Set(grants)] })
  }

  private prefsKey(sessionId: string): string {
    return `sess-${sessionId}`
  }

  /** 从会话日志(权威)恢复偏好;日志无记录时用运行时默认。 */
  async sessionPrefs(session: Session, fallback: SessionTurnPrefs): Promise<SessionTurnPrefs> {
    const fromLog = prefsFromSessionEvents(session, fallback)
    const domain = await this.ensure()
    const cached = domain.table('prefs').get(this.prefsKey(session.id))?.session
    return cached ?? fromLog
  }

  /** 保存会话偏好(KV 缓存)+ 写入会话日志(权威)。 */
  async saveSessionPrefs(session: Session, prefs: SessionTurnPrefs, turn: number): Promise<void> {
    const domain = await this.ensure()
    await domain.table('prefs').put(this.prefsKey(session.id), {
      key: this.prefsKey(session.id),
      session: prefs,
    })
    writePluginRecord(session, 'plugin:chat-workspace/settings', {
      turn,
      mode: prefs.mode,
      channel: prefs.channel,
      provider: prefs.provider,
      model: prefs.model,
      thinking: prefs.thinking,
      search: prefs.search,
      localSearch: prefs.localSearch,
    })
  }

  /** R8:仅写 KV 缓存(会话内切换模型;不向日志写事件,回合时再落权威记录)。 */
  async saveSessionPrefsCached(sessionId: string, prefs: SessionTurnPrefs): Promise<void> {
    const key = this.prefsKey(sessionId)
    await (await this.ensure()).table('prefs').put(key, { key, session: prefs })
  }

  // ── 附件索引 ──

  async putAttachment(record: AttachmentRecord): Promise<void> {
    const domain = await this.ensure()
    await domain.table('files').put(record.id, record)
  }

  async getAttachment(id: string): Promise<AttachmentRecord | undefined> {
    const domain = await this.ensure()
    return domain.table('files').get(id)
  }

  async deleteAttachment(id: string): Promise<void> {
    const domain = await this.ensure()
    await domain.table('files').delete(id)
  }

  async listAttachments(sessionId: string): Promise<AttachmentRecord[]> {
    const domain = await this.ensure()
    const out: AttachmentRecord[] = []
    for (const record of domain.table('files').entries()) {
      if (record[1].sessionId === sessionId) out.push(record[1])
    }
    out.sort((a, b) => a.createdAt - b.createdAt)
    return out
  }

  // ── R8:模型白名单 ──

  /** 模型引用的唯一键(白名单匹配用)。 */
  static modelKey(ref: Pick<ModelRef, 'channel' | 'model' | 'provider'>): string {
    return `${ref.channel}:${ref.provider ?? ''}:${ref.model}`
  }

  /** 指定模型当前是否可用(modelScope=whitelist 时须在白名单内)。 */
  async modelAllowed(ref: Pick<ModelRef, 'channel' | 'model' | 'provider'>): Promise<boolean> {
    const settings = await this.getSettings({})
    if (settings.modelScope !== 'whitelist') return true
    const key = WorkspaceStore.modelKey(ref)
    return settings.modelWhitelist.some((entry) => WorkspaceStore.modelKey(entry) === key)
  }

  // ── R8:提示词模板 ──

  async listPrompts(): Promise<(PromptTemplate & { builtin?: boolean })[]> {
    const table = (await this.ensure()).table('prompts')
    const out = [...table.entries()].map(([, record]) => record)
    out.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    return out
  }

  async getPrompt(id: string): Promise<(PromptTemplate & { builtin?: boolean }) | undefined> {
    return (await this.ensure()).table('prompts').get(id)
  }

  async putPrompt(record: PromptTemplate & { builtin?: boolean }): Promise<void> {
    await (await this.ensure()).table('prompts').put(record.id, record)
  }

  async deletePrompt(id: string): Promise<boolean> {
    const table = (await this.ensure()).table('prompts')
    if (table.get(id) === undefined) return false
    await table.delete(id)
    return true
  }
}

export type { SettingsPatch }
