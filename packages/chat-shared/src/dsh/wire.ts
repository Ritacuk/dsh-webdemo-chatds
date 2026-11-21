/**
 * Chat Workspace 页面 ↔ DSH Host 插件路由 的线协议(P2)。
 *
 * 页面只与 Host 的插件路由通信(`/chat-workspace/api/...`),凭证与对模型 API 的
 * 真实请求全部由 Host 执行;此协议本身不含任何凭证字段。
 * 流式回合用 SSE(text/event-stream),每帧 data 为一行 JSON 的 ChatStreamFrame。
 *
 * P2 新增:模型选择(provider+model+思考档位)、Chat/Plan 模式、附件、本地检索、设置。
 */

import type { MessageStreamEvent } from '../protocol/types.js'
import type { Message, AssistantMessage } from '../chat/types.js'

/** 工作模式(P2-B):chat=普通聊天;plan=只读多步检索的分析/规划模式。 */
export type WorkspaceMode = 'chat' | 'plan'

/** 思考档位(P2-C):Rich 通路实际只支持 off/enabled(官方 demo 协议);通用通路按模型能力透传。 */
/** Rich uses off/enabled. Generic models declare their own effort IDs. */
export type ThinkingEffort = string

/** 模型通路标识。 */
export type ModelChannel =
  /** DeepSeek Rich 通路(demo 的 Messages API,完整特殊响应)。 */
  | 'rich'
  /** DSH 通用通路(ctx.llm,通用 ContentBlock/StreamChunk)。 */
  | 'generic'

/**
 * 消息编辑/重新生成/继续生成(demo 基础动作;V0 接线)。
 *
 * 语义(demo store.ts 的 editMessage/regenerateReply/continueReply 对齐):
 * - edit:改写某条用户提问,从该消息起整段旧路径被替换为本轮新的一对问答;
 * - regenerate:对某条回答重新生成(其提问保留,旧回答及其后续被替换);
 * - continue:续写某条未完成回答(原回答块保留,新流块追加;本轮提问是原提问的副本)。
 */
export interface TurnEdit {
  action: 'edit' | 'regenerate' | 'continue'
  /**
   * 目标消息 id(会话日志中的持久 id):
   * edit=被编辑的用户消息;regenerate=被替换的助手回复;continue=被续写的助手回复。
   */
  targetMessageId: string
}

/** 页面发出的回合请求(P2)。 */
export interface TurnRequest {
  sessionId: string
  locale?: 'zh-CN' | 'en-US'
  timeZone?: string
  /** 用户输入文本(edit=编辑后的文本;regenerate/continue=原提问文本,Host 以日志为准) */
  content: string
  /** 编辑/重新生成/继续生成;缺省=普通新消息 */
  edit?: TurnEdit
  /** 工作模式(Host 按模式实施后端权限)。 */
  mode: WorkspaceMode
  /** 模型通路(rich/generic;决定 Host 用哪个执行链)。 */
  channel: ModelChannel
  /** Rich 通路模型 id(deepseek-flash / deepseek-v4-pro)。 */
  model?: string
  /** 通用通路 provider(ctx.llm 注册的 provider route)。 */
  provider?: string
  /** 通用通路模型 id。 */
  genericModel?: string
  /** 思考:rich 用 off/enabled;generic 传 off/low/high/max(模型声明支持才生效)。 */
  thinking: ThinkingEffort
  /** 是否声明 deepseek_web_search(rich 通路;deepseek_read_url 恒开)。 */
  search: boolean
  /** 附件引用(Host 已接收的文件 id)。 */
  attachments: string[]
  allowAttachmentUpload?: boolean
  /** 本地检索是否允许注入(开启时 Host 可执行确定性只读检索预取)。 */
  localSearch: boolean
}

/** 一条已接收附件的元数据。 */
export interface WireAttachment {
  id: string
  name: string
  /** 上报给页面的 MIME(Host 识别)。 */
  mimeType: string
  /** 字节数。 */
  size: number
  /** 处理方式,页面必须如实展示:P2-F 隐私要求。 */
  handling: 'local-inline' | 'local-extract' | 'cloud-files-api' | 'unsupported'
  /** 处理方式的人类可读说明(含解析能力限制)。 */
  handlingNote?: string
  /** 解析失败原因(handling=unsupported 时)。 */
  error?: string
}

/** 检索命中的一条文件片段(P2-G)。 */
export interface LocalSearchHit {
  dirId?: string
  /** 绝对路径(授权目录内)。 */
  path: string
  /** 授权目录内相对路径。 */
  relativePath: string
  /** 1-based 行号(文本命中时)。 */
  line?: number
  /** 命中行文本(截断)。 */
  preview: string
  /** 文件大小(字节)。 */
  size: number
  /** 修改时间(ms)。 */
  modifiedAt: number
}

/** 本地检索结果。 */
export interface LocalSearchResult {
  exactMatches?: number
  searchedDirectories?: number
  hits: LocalSearchHit[]
  /** 被拒绝/跳过的条目说明(权限、符号链接逃逸等)。 */
  skipped: { path: string; reason: string }[]
  /** 是否被截断(超过 maxHits)。 */
  truncated: boolean
  truncationReasons?: string[]
}

/** SSE 帧载体。 */
export type ChatStreamFrame =
  | {
      type: 'start'
      /** 本轮用户消息 id(Host 已写入 Session) */
      userMessageId: string
      /** 本轮助手回复 id(占位已创建) */
      replyId: string
      /** 是否把本轮作为续写前缀(由 Host 判定) */
      prefix: boolean
      /** 本轮实际生效的通路与模型(能力降级时可能与请求不同,页面以此为准)。 */
      channel: ModelChannel
      model: string
      /** 本轮生效的思考档位(模型不支持时可能被降级,如 enabled→off)。 */
      thinking: ThinkingEffort
      /** 请求体中实际生效的检索注入说明(Plan/本地检索预取结果)。 */
      retrievalNote?: string
    }
  | { type: 'event'; event: MessageStreamEvent }
  /** 正常或主动停止收尾;reply 为最终回复状态;cost 为本回合真实账单(cost-meter 可用时) */
  | { type: 'settled'; reply: AssistantMessage; sessionId: string; title?: string; cost?: unknown }
  | { type: 'error'; error: { kind: string; message: string; status?: number; code?: string } }

/** 会话摘要(列表)。 */
export interface WireSessionSummary {
  archived?: boolean
  pinned?: boolean
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** 消息条数,用于列表展示 */
  messageCount: number
}

/** 会话完整恢复载荷:与 demo 的 Session 形状一致,页面 store 无需第二套模型 */
export interface WireSession {
  versions?: Record<string, string[]>
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: Message[]
  /** 会话当前工作模式(P2-B,重启后恢复)。 */
  mode: WorkspaceMode
}

/** 一个模型条目的经过验证的能力描述(P2-E)。 */
export interface WireModelCapability {
  /** 普通文本聊天(流式)。 */
  chat: boolean
  /** 思考模式可用。 */
  thinking: boolean
  /** 思考档位(空数组=仅开/关)。 */
  thinkingEfforts: ThinkingEffort[]
  thinkingEffortNames?: Record<string, string>
  defaultThinkingEffort?: ThinkingEffort
  /** 视觉输入。 */
  vision: boolean
  /** 文件输入形式。 */
  fileInput: ('local-inline' | 'local-extract' | 'cloud-files-api')[]
  /** DeepSeek 原生联网搜索(仅 rich 通路)。 */
  nativeSearch: boolean
  /** 流式输出。 */
  streaming: boolean
  /** 用量统计。 */
  usage: boolean
  /** 结构化响应(Rich 内容块)。 */
  structured: boolean
}

/** 模型白名单里的一次模型引用(channel + provider + model)。 */
export interface ModelRef {
  channel: ModelChannel
  provider?: string
  model: string
}

export interface WireModelEntry {
  /** 展示名。 */
  name: string
  /** 通路。 */
  channel: ModelChannel
  /** rich:模型 id;generic:ctx.llm 模型 id。 */
  model: string
  /** generic 通路的 provider。 */
  provider?: string
  capability: WireModelCapability
  /** 能力来源说明(检测依据,页面可展示)。 */
  capabilityNote?: string
  /** R8:白名单状态(modelScope=whitelist 时 false=已被用户禁用;缺省=启用)。 */
  enabled?: boolean
}

/** 模型目录:Rich 通路 + DSH 通用通路。 */
export type WireModelCatalog = {
  /** Rich 通路可用性(凭证 + endpoint 就绪) */
  richReady: boolean
  richUnavailableReason?: string
  richModels: WireModelEntry[]
  /** DSH 通用通路(ctx.llm)当前已注册的 provider 与模型 */
  genericProviders: { provider: string; name: string; models: WireModelEntry[] }[]
  /** R8:模型范围模式(all=全部可用;whitelist=仅用户启用的模型)。 */
  modelScope: 'all' | 'whitelist'
}

/** 健康检查载荷 */
export type WireHealth = {
  ok: true
  plugin: 'dsh-webdemo-ChatDS' | 'chat-workspace-main'
  /** 插件版本:唯一权威来源 = 安装包 package.json(不再用源码常量)。 */
  version: string
  /** 构建该安装包时的 Git Commit(短哈希);dev 构建为 'dev'。 */
  commit: string
}

/** 设置(P2-I):运行时可变默认值,存 KV 域 global;部署级默认在插件行 Config。 */
export interface WorkspaceSettings {
  interfaceLanguage: 'browser' | 'zh-CN' | 'en-US'
  sendShortcut: 'enter' | 'ctrl-enter'
  enableVoiceInput: boolean
  appearanceMode: 'dsh' | 'light' | 'dark' | 'system'
  appearanceStyle: 'default' | 'gpt' | 'gemini' | 'claude'
  appearanceGlass: 'off' | 'light' | 'strong'
  readingFontSize: number
  readingWidth: 'preset' | 'narrow' | 'wide'
  /** 默认工作模式。 */
  defaultMode: WorkspaceMode
  /** 默认思考。 */
  defaultThinking: ThinkingEffort
  /** 默认联网搜索(rich)。 */
  defaultSearch: boolean
  /** 默认本地检索。 */
  defaultLocalSearch: boolean
  /** 是否记住上次模型(下次新会话用)。 */
  rememberLastModel: boolean
  /** 上次使用的模型(channel+model 对)。 */
  lastModel?: { channel: ModelChannel; provider?: string; model: string }
  /** 本地检索授权目录(Host 强制执行的白名单)。 */
  authorizedDirs: string[]
  /** 单文件上限(字节)。 */
  maxFileBytes: number
  /** 检索片段上限(每文件注入字符数)。 */
  maxSnippetChars: number
  /** Plan 模式只读检索步数上限。 */
  maxPlanSteps: number
  /** 基础请求诊断(记录每轮请求/用量摘要到日志)。 */
  requestDiagnostics: boolean
  /** R8:模型范围(all=全部 DSH 可路由模型;whitelist=仅白名单模型)。 */
  modelScope: 'all' | 'whitelist'
  /** R8:白名单模型(modelScope=whitelist 时生效;新发现模型默认不在其中)。 */
  modelWhitelist: ModelRef[]
  /** R8:收藏的常用模型(仅排序/标记,不影响可用性)。 */
  favoriteModels: ModelRef[]
  /** R8:WebChat 默认模型(新会话输入态)。 */
  defaultModel?: ModelRef
  /** R8:全局附加提示词开关。 */
  globalPromptEnabled: boolean
  /** R8:全局附加提示词正文(追加在 demo 身份指令之后,单次注入)。 */
  globalPromptText: string
  /** R8:全局授权的第三方工具名(默认空;执行前另校验会话授权)。 */
  authorizedTools: string[]
  /** R8:费用预算提醒阈值比例(0.1-1)。 */
  budgetWarnThresholds: number[]
  /** R8:预算提醒开关。 */
  budgetRemindersEnabled: boolean
}

/** 会话级持久化偏好(P2-A:随会话保存,切换会话恢复)。 */
export interface SessionTurnPrefs {
  mode: WorkspaceMode
  channel: ModelChannel
  provider?: string
  model: string
  thinking: ThinkingEffort
  search: boolean
  localSearch: boolean
}

/** R8:提示词模板(设置与聊天输入框共用;存 KV 域,Profile 隔离)。 */
export interface PromptTemplate {
  id: string
  name: string
  /** 分类(自由文本;空=未分类)。 */
  category: string
  /** 简介。 */
  summary: string
  /** 正文(支持 {{date}}/{{model}}/{{sessionTitle}}/{{workspace}}/{{selection}} 变量)。 */
  body: string
  /** 标签。 */
  tags: string[]
  createdAt: number
  updatedAt: number
}

/** R8:模板列表响应(带默认模板标记)。 */
export interface WirePromptList {
  templates: (PromptTemplate & { builtin?: boolean })[]
}

/** R8:模板变量预览请求。 */
export interface PromptVariableRequest {
  template: string
  sessionId?: string
  /** 用户当前选中文本(仅真实可获取时由页面传入)。 */
  selection?: string
}

/** R8:模板变量预览结果(明确区分已解析与未解析)。 */
export interface PromptVariablePreview {
  resolved: string
  variables: { name: string; value?: string; resolved: boolean }[]
}
