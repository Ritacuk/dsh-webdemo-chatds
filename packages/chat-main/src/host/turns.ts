/**
 * Rich/通用 双通路回合管线(P2)— 官方 demo 的流式语义 + DSH Session 持久化。
 *
 * 每轮事件序列(与官方 agent-loop 序列对齐;顺序为 v4 格式状态机契约):
 *   turn/start → [request/header(仅首次或变更)] → [plugin 记录(settings/attachments/branch)]
 *   → step/start → [system/message(仅首次或变更;必须在 step 内且为 surface 首事件)]
 *   → user/message(append) → assistant/message(append,含 usage/stream/interrupted,source.model=实际模型)
 *   → step/end → turn/end{completed|aborted|error} → [session/title(API 标题)]
 *
 * 权限落实(P2-B/P2-D/P2-G,后端强制):
 * - 工具定义只含官方服务端工具(deepseek_web_search 与 deepseek_read_url 随联网开关启停);
 *   DSH Agent 工具在两条通路都从不传入(tools 缺省);
 * - Chat 保持一次生成。Plan 在通用通路启用本地检索时可请求有界只读工具。
 * - 本地检索/文件读取全部经 host/local-search.ts 的白名单强制,页面无法绕过;
 * - 未授权工具即便被模型异常调用也无执行面:Rich 的 tool_use 块仅记录并关闭续写,
 *   通用通路不带任何工具。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import { SessionId, SessionLogOffset as makeOffset, SessionSeq as makeSeq } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import type { SessionTitleProviderId } from '@deepseek-ai/dsh-session-title'
import {
  AssistantStreamAccumulator,
  createAssistantMessage,
  createSystemMessage,
  createUserMessage,
  ReasoningEffortId,
  type ContentBlock,
  type ContentBlockMap,
  type LlmFailure,
  type LlmResolvedModelInfo,
  type RequestMessage,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  applyEvent,
  canContinueReply,
  settleReply,
  toRequestMessages,
  type AssistantMessage as DemoAssistant,
  type Message as DemoMessage,
  type MessageStreamEvent,
  type CreateMessageRequest,
  type WebFetchToolResultBlock,
  type WebSearchToolResultBlock,
  type ServerToolUseBlock,
  type TurnRequest,
  type ChatStreamFrame,
  type ThinkingEffort,
} from '@dsh-chat/shared'
import { replyBlocksToDshContent } from '@dsh-chat/shared'
import { AttachmentContextError, TurnAttachments } from './turn-attachments.js'
import { streamReadOnlyPlan } from './read-only-plan.js'
import { sidecarParentContext } from './sidecar-context.js'
import type { RichGateway } from './rich.js'
import { toRichFailure } from './rich.js'
import { translateGenericChunks, type ChannelEvent } from './generic.js'
import { writePluginRecord } from './plugin-record.js'
import { extractFilenameTargets, extractSearchTerms } from './terms.js'
import { createDemoReminder, demoServerTools } from './demo-reminder.js'
import { eventsToWireMessages, type RichReplayResponse } from './sessions.js'
import { effectiveSystemPrompt } from './prompts.js'
import type { WorkspaceStore } from './store.js'
import type { LocalSearchEngine } from './local-search.js'
import type { WorkspaceSessions } from './sessions.js'

/** demo 的助手身份说明与安全审核常量(上游 chat-demo store.ts:31-34,原样保留);
 *  R8:全局附加提示词经 effectiveSystemPrompt 追加,不修改本常量。 */
const SYSTEM_PROMPT = '该助手为DeepSeek，由深度求索公司创造。'
const SAFETY_CHECK = { level: 'high' } as const

/** 本插件的 ContentBlockMap 扩展:Rich 服务端工具块按 payload 原样承载。 */
declare module '@deepseek-ai/dsh-llm' {
  interface ContentBlockMap {
    'server-tool-use': { type: 'server-tool-use'; tool: ServerToolUseBlock }
    'web-search-tool-result': { type: 'web-search-tool-result'; tool: WebSearchToolResultBlock }
    'web-fetch-tool-result': { type: 'web-fetch-tool-result'; tool: WebFetchToolResultBlock }
  }
}

/** 本插件的日志内插件记录(设置快照/附件引用),经官方 PluginRecordMap 合并声明。 */
declare module '@deepseek-ai/dsh-session' {
  interface PluginRecordMap {
    'plugin:chat-workspace/settings': {
      turn: number
      mode: 'chat' | 'plan'
      channel: 'rich' | 'generic'
      provider?: string
      model: string
      thinking: ThinkingEffort
      search: boolean
      localSearch: boolean
    }
    'plugin:chat-workspace/attachments': {
      turn: number
      userMessageId: string
      attachments: { id: string; name: string; size: number; handling: string; mimeType: string }[]
    }
    'plugin:chat-workspace/branch': {
      turn: number
      action: 'edit' | 'regenerate' | 'continue'
      hideIds: string[]
      reuseUser?: true
      mergeIntoId?: string
      continueReplyId?: string
    }
  }
}

const RICH_PROVIDER = 'deepseek-rich'
const TITLE_PROVIDER = brandString<SessionTitleProviderId>('chat-workspace-rich-title')

/** Rich 协议的 stop_reason → 通用 FinishReason 的粗映射(原值保存在 finish.replayState)。 */
function richFinishReason(stopReason: NonNullable<DemoAssistant['stopReason']>): Extract<StreamChunk, { type: 'finish' }>['reason'] {
  switch (stopReason) {
    case 'end_turn': return { kind: 'stop' }
    case 'tool_use': return { kind: 'tool-calls' }
    case 'max_tokens': return { kind: 'max-tokens' }
    case 'refusal':
      return { kind: 'error', failure: { message: 'refusal', code: 'REFUSAL' } }
  }
}

function toTokenUsage(usage: NonNullable<DemoAssistant['usage']>): import('@deepseek-ai/dsh-llm').TokenUsage {
  const total = usage.input_tokens + usage.output_tokens
    + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...(total > 0 ? { totalTokens: total } : {}),
    ...(usage.cache_read_input_tokens > 0 ? { cacheReadTokens: usage.cache_read_input_tokens } : {}),
    ...(usage.cache_creation_input_tokens > 0 ? { cacheWriteTokens: usage.cache_creation_input_tokens } : {}),
  }
}

export interface TurnEmit {
  (frame: ChatStreamFrame): void
}

/** 一个进行中的回合。 */
interface ActiveTurn {
  controller: AbortController
  done: Promise<void>
}

export function missingAnswer(blocks: DemoAssistant['blocks'], search: boolean, stopReason: DemoAssistant['stopReason']): { code: string; message: string } | undefined {
  if (stopReason === 'refusal') return { code: 'REFUSAL', message: '模型拒绝了本次请求。' }
  if (blocks.some((block) => block.type === 'text' && !block.isTemplate && block.text.trim())) return undefined
  const results = blocks.filter((block) => block.type === 'web_search_tool_result' || block.type === 'web_fetch_tool_result')
  if (!search && results.length === 0) return { code: 'EMPTY_REPLY', message: '模型没有返回正文。可以重新生成。' }
  const failed = results.some((block) => block.type === 'web_search_tool_result'
    ? block.content.some((item) => item.type === 'web_search_tool_result_error')
    : block.content.type === 'web_fetch_tool_result_error')
  return failed
    ? { code: 'SEARCH_NO_FINAL_ANSWER', message: '搜索或网页读取遇到错误，模型没有返回正文。可以检查已有来源或重新生成。' }
    : { code: 'SEARCH_EMPTY_REPLY', message: '搜索结束后模型没有返回正文。可以检查已有来源或重新生成。' }
}

/** 思考档位的通路级解析(不静默提升,也不静默降低到用户未选择的语义之下)。 */
export function resolveThinking(request: ThinkingEffort, channel: 'rich' | 'generic', reasoning?: LlmResolvedModelInfo['reasoning']): {
  thinking: ThinkingEffort
  richEnabled: boolean
  genericEffort: string | undefined
  note?: string
  unsupported?: true
} {
  if (channel === 'rich') {
    // 官方 Messages API(demo 协议)只有 enabled/disabled 两态;low/high/max 按可用最高档执行并说明。
    const richEnabled = request !== 'off'
    const note = request === 'off' || request === 'enabled'
      ? undefined
      : 'Rich 通路协议仅支持开/关两态思考,已按"开启"执行'
    return { thinking: request === 'off' ? 'off' : 'enabled', richEnabled, genericEffort: undefined, ...(note !== undefined ? { note } : {}) }
  }
  if (!reasoning) {
    if (request === 'off') return { thinking: 'off', richEnabled: false, genericEffort: undefined }
    return {
      thinking: request,
      richEnabled: false,
      genericEffort: undefined,
      note: '该模型未声明思考档位。',
      unsupported: true,
    }
  }
  const effort = request === 'enabled'
    ? [reasoning.defaultEffort, ...reasoning.efforts.map(({ id }) => id)].find((id) => id !== undefined && id !== 'off')
    : reasoning.efforts.find(({ id }) => id === request)?.id
  if (effort === undefined) {
    return { thinking: request, richEnabled: false, genericEffort: undefined, unsupported: true,
      note: request === 'off' ? '此模型没有声明可关闭思考。请选择其支持的推理等级。' : '此模型不支持所选推理等级。' }
  }
  return { thinking: effort, richEnabled: false, genericEffort: effort }
}

/**
 * 回合运行器。同一会话同时只允许一个回合;停止生成 = 中止当前回合并
 * 以 interrupted 语义落盘。
 */
export class TurnRunner {
  private readonly active = new Map<string, ActiveTurn>()

  constructor(
    private readonly ctx: Context,
    private readonly workspace: WorkspaceSessions,
    private readonly store: WorkspaceStore,
    private readonly gateway: RichGateway,
    private readonly search: LocalSearchEngine,
    private readonly diagnostics: () => Promise<{ requestDiagnostics: boolean }>,
    /** R8.5:Rich 用量 → cost-meter 外部账本(旁聊实例为 undefined)。 */
    private readonly ledger?: { append(info: { messageId: string; at: number; model: string; usage: NonNullable<DemoAssistant['usage']> }): void },
  ) {}

  /** 停止某会话正在进行的生成(用户主动取消)。 */
  stop(sessionId: string): boolean {
    const turn = this.active.get(sessionId)
    if (turn === undefined) return false
    turn.controller.abort()
    return true
  }

  /** 是否有进行中的回合。 */
  isRunning(sessionId: string): boolean {
    return this.active.has(sessionId)
  }

  /** 停用:中止全部活动回合(各自按 stopped 收尾落盘)。 */
  async dispose(): Promise<void> {
    const turns = [...this.active.values()]
    for (const turn of turns) turn.controller.abort()
    await Promise.all(turns.map((turn) => turn.done))
  }

  /**
   * 运行一个回合并持久化。emit 把 ChatStreamFrame 推给浏览器(SSE);
   * disconnected() 探测客户端断开(断开按用户停止处理,demo 语义)。
   */
  async runTurn(options: {
    sessionId: string
    request: TurnRequest
    emit: TurnEmit
    disconnected: () => boolean
    disconnectSignal?: AbortSignal
  }): Promise<void> {
    const { sessionId, request, emit, disconnected, disconnectSignal } = options
    if (this.active.has(sessionId)) {
      emit({ type: 'error', error: { kind: 'http', message: 'a turn is already running for this session', status: 409 } })
      return
    }
    const controller = new AbortController()
    const cancel = () => controller.abort()
    if (disconnectSignal?.aborted) return
    disconnectSignal?.addEventListener('abort', cancel, { once: true })
    let complete!: () => void
    const done = new Promise<void>((resolve) => { complete = resolve })
    this.active.set(sessionId, { controller, done })
    try {
      const session = await this.workspace.liveSession(sessionId)
      if (session === undefined) {
        emit({ type: 'error', error: { kind: 'http', message: `session not found: ${sessionId}`, status: 404 } })
        return
      }
      await this.runTurnInner(session, request, { emit, controller, disconnected })
    } finally {
      disconnectSignal?.removeEventListener('abort', cancel)
      this.active.delete(sessionId)
      complete()
    }
  }

  private async runTurnInner(
    session: Session,
    request: TurnRequest,
    options: {
      emit: TurnEmit
      controller: AbortController
      disconnected: () => boolean
    },
  ): Promise<void> {
    const { emit, controller, disconnected } = options
    const signal = controller.signal
    const settings = await this.store.getSettings({})
    const systemPrompt = effectiveSystemPrompt(settings)

    // ── 通路解析(P2-E):ready 检查 + 能力校验,失败以 error 帧明确报告 ──
    const channel = request.channel === 'generic' ? 'generic' : 'rich'
    if (channel === 'rich') {
      const readiness = await this.gateway.readiness()
      if (!readiness.ready) {
        emit({ type: 'error', error: { kind: 'credential', message: readiness.reason ?? 'Rich 通路不可用', code: 'RICH_NOT_READY' } })
        return
      }
    }
    let reasoning: LlmResolvedModelInfo['reasoning']
    if (channel === 'generic') {
      const genericProvider = request.provider ?? ''
      const genericModelName = request.genericModel ?? request.model
      if (genericModelName === undefined || genericModelName.length === 0) {
        emit({ type: 'error', error: { kind: 'http', message: 'generic channel requires a model id', status: 400, code: 'MODEL_REQUIRED' } })
        return
      }
      const registered = this.ctx.llm.listProviders().some((info) => info.id === genericProvider)
      if (!registered) {
        emit({ type: 'error', error: { kind: 'http', message: `provider "${genericProvider}" is not registered in DSH llm service`, status: 400, code: 'PROVIDER_NOT_FOUND' } })
        return
      }
      const info = await this.ctx.llm.resolveModelInfo(genericProvider, genericModelName).catch(() => undefined)
      if (info === undefined) {
        emit({ type: 'error', error: { kind: 'http', message: '暂时无法确认此模型支持的推理等级，请刷新模型目录后重试。', status: 400, code: 'MODEL_INFO_UNAVAILABLE' } })
        return
      }
      reasoning = info.reasoning
    }
    // 联网搜索是 Rich 通路独有(P2-D 要求 9/10:非 DeepSeek 模型不支持原生搜索时明确报错,不静默)
    if (request.search && channel !== 'rich') {
      emit({ type: 'error', error: { kind: 'http', message: 'native web search is a DeepSeek Messages API capability; disable search or switch to a DeepSeek model', status: 400, code: 'SEARCH_UNSUPPORTED' } })
      return
    }
    const usePlanTools = request.mode === 'plan' && request.localSearch
    if (usePlanTools && channel === 'rich') {
      emit({ type: 'error', error: { kind: 'http', status: 400, code: 'PLAN_TOOLS_UNSUPPORTED',
        message: 'Plan 本地工具需要支持工具调用的 DSH 通用模型。可切换模型，或关闭本地检索继续使用 DeepSeek 智能搜索。' } })
      return
    }
    const model = channel === 'rich'
      ? (request.model ?? 'deepseek-flash')
      : (request.genericModel ?? request.model ?? 'unknown')
    const provider = channel === 'generic' ? request.provider : undefined

    // R8 白名单安全规则(先于推理等级校验):被禁用模型不允许发送(不静默切换,明确报错)。
    if (!(await this.store.modelAllowed({ channel, provider, model }))) {
      emit({
        type: 'error',
        error: {
          kind: 'http',
          message: '当前模型已被禁用。请在 ChatDS 设置 → 模型中重新启用,或改选其他模型。',
          status: 403,
          code: 'MODEL_BLOCKED',
        },
      })
      return
    }
    const thinking = resolveThinking(request.thinking, channel, reasoning)
    if (thinking.unsupported) {
      emit({ type: 'error', error: { kind: 'http', message: thinking.note ?? '此模型不支持所选推理等级。', status: 400, code: 'REASONING_UNSUPPORTED' } })
      return
    }

    const turn = this.nextTurn(session)
    const needsTitle = channel === 'rich' && titleOf(session) === null

    // Chat 的本地检索仍为单次预取，不增加模型请求。
    let retrievalNote: string | undefined
    if (request.localSearch && !usePlanTools) {
      const terms = extractSearchTerms(request.content)
      const filenames = extractFilenameTargets(request.content)
      const results = await this.search.search({ query: terms.join(' '), match: 'any', filenames, signal })
      {
        // any 语义下命中可能较多:注入前 12 条(按相关度),其余只报数量。
        const shown = results.hits.slice(0, 12)
        const lines = shown.map((hit) =>
          `- ${hit.relativePath}${hit.line !== undefined ? `:${String(hit.line)}` : ''}: ${hit.preview}`)
        if (results.hits.length > shown.length) lines.push(`- …(另有 ${String(results.hits.length - shown.length)} 条命中未列出)`)
        retrievalNote = `本地检索（${results.searchedDirectories ?? 0} 个授权目录，精确匹配 ${results.exactMatches ?? 0}，展示 ${shown.length} 条）`
          + (lines.length > 0 ? `\n${lines.join('\n')}` : '\n在已检查范围内无命中。')
          + (results.truncated ? `\n检索未完成（${results.truncationReasons?.join('、') ?? '达到预算'}）。` : '')
          + (results.skipped.length ? `\n${results.skipped.length} 项未能检查。` : '')
      }
    }

    // ── 请求组装:demo 成对轮次规则 → 通道路径 ──
    const events = session.snapshotEvents(makeOffset(0))
    const visible = eventsToWireMessages(events)
    // 编辑/重新生成/继续生成(V0 接线):demo 语义 —— 截断上下文 + 分支记录替换旧路径
    let history: DemoMessage[] = visible
    let prefixReply: DemoAssistant | undefined
    let questionContent = request.content
    let branchAction: 'edit' | 'regenerate' | 'continue' | undefined
    let branchHideIds: string[] = []
    let branchMergeIntoId: string | undefined
    let originalQuestionId: string | undefined
    if (request.edit !== undefined) {
      const { action, targetMessageId } = request.edit
      const index = visible.findIndex((message) => message.id === targetMessageId)
      const target = index >= 0 ? visible[index] : undefined
      const roleOk = target !== undefined
        && (action === 'edit' ? target.role === 'user' : target.role === 'assistant')
      if (!roleOk) {
        emit({ type: 'error', error: { kind: 'http', message: `edit target not found on the visible path: ${targetMessageId}`, status: 400 } })
        return
      }
      if (action === 'continue') {
        const question = index > 0 ? visible[index - 1] : undefined
        const last = index === visible.length - 1
        if (question?.role !== 'user' || !last || target.role !== 'assistant' || !canContinueReply(target)) {
          emit({ type: 'error', error: { kind: 'http', message: 'continue requires the last reply on the path to be continuable', status: 400 } })
          return
        }
        history = visible.slice(0, index - 1)
        questionContent = question.content
        originalQuestionId = question.id
        prefixReply = target
        branchAction = 'continue'
        branchMergeIntoId = target.id
      } else if (action === 'regenerate') {
        const question = index > 0 ? visible[index - 1] : undefined
        if (question?.role !== 'user') {
          emit({ type: 'error', error: { kind: 'http', message: 'regenerate target must directly follow a user question', status: 400 } })
          return
        }
        history = visible.slice(0, index - 1)
        questionContent = question.content
        originalQuestionId = question.id
        // 旧回答起的尾段 + 本轮提问副本一起隐藏;原提问 id 保留(demo 语义)
        branchAction = 'regenerate'
        branchHideIds = visible.slice(index).map((message) => message.id)
      } else {
        // edit:从被编辑提问起的旧尾段被替换为本轮新的一对问答
        history = visible.slice(0, index)
        branchAction = 'edit'
        branchHideIds = visible.slice(index).map((message) => message.id)
      }
    }
    const question: Extract<DemoMessage, { role: 'user' }> = {
      id: `pending-${Date.now()}`,
      role: 'user',
      content: questionContent,
      files: [],
      createdAt: Date.now(),
    }
    const latestReminder = channel === 'rich'
      ? (prefixReply ? prefixReply.latestReminder : createDemoReminder(request.locale, request.timeZone))
      : undefined
    const attachments = new TurnAttachments(this.store, this.gateway, session.id, channel, questionContent, settings.maxSnippetChars, signal)
    let requestQuestion: typeof question
    const requestHistory: DemoMessage[] = [...history]
    try {
      requestQuestion = await attachments.current(question, request.attachments, request.edit !== undefined, request.allowAttachmentUpload === true)
      for (let index = history.length - 1; index >= 0; index--) {
        const message = history[index]
        if (message?.role === 'user' && message.files.length > 0) {
          requestHistory[index] = await attachments.historical(message)
        }
      }
    } catch (error) {
      if (signal.aborted) return
      if (!(error instanceof AttachmentContextError)) throw error
      emit({ type: 'error', error: { kind: 'http', message: error.message, code: error.code, status: 400 } })
      return
    }
    if (signal.aborted) return
    if (retrievalNote !== undefined) {
      requestQuestion.content = `【本地检索结果】\n${retrievalNote}\n\n---\n\n${requestQuestion.content}`
    }
    if (session.id.startsWith('chatws-side-')) {
      const snapshot = sidecarParentContext(session)
      if (!snapshot) {
        emit({ type: 'error', error: { kind: 'http', message: '请先选择父任务检查点', status: 400 } })
        return
      }
      if (snapshot.transcript) {
        requestQuestion.content = `以下是用户选定的父任务检查点摘录，仅供参考：\n\n${snapshot.transcript}\n\n---\n\n${requestQuestion.content}`
      }
    }
    const richMessages = toRequestMessages(requestHistory, requestQuestion, prefixReply, thinking.richEnabled, latestReminder)

    // ── 事件序列(顺序即 v4 格式状态机契约,见 dsh-session-format 的行关系校验)──
    // turn/start → request/header → [plugin 记录] → step/start → system/message
    // → user/message → assistant/message → step/end → turn/end。
    // system/message 与 assistant/message 必须落在打开的 step 内(STEP_EVENT_TYPES
    // 走 requireStep);system/message 还必须是 surface 首事件。V0 实测修正:
    // 此前 system/user 先于 step/start 写入,冷读时报
    // "system/message does not match an open turn and step"。
    const turnStartEvent = session.append('turn/start', { turn })
    if (this.headerChanged(session, channel, provider, model, thinking.genericEffort)) {
      session.append('request/header', {
        header: {
          config: channel === 'rich'
            ? { provider: RICH_PROVIDER, model }
            : { provider: provider ?? 'generic', model, ...(thinking.genericEffort !== undefined ? { reasoningEffort: ReasoningEffortId(thinking.genericEffort) } : {}) },
        },
        reason: this.headerCount(session) === 0 ? 'initial' : 'change',
      })
    }
    const userMessage = createUserMessage({
      content: [{ type: 'text', text: questionContent }],
      source: { kind: 'user' },
    })
    // 编辑/重新生成:旧路径尾段 + (regenerate)本轮提问副本一起隐藏
    if (branchAction === 'edit' || branchAction === 'regenerate') {
      writePluginRecord(session, 'plugin:chat-workspace/branch', {
        turn,
        action: branchAction,
        hideIds: branchHideIds,
        ...(branchAction === 'regenerate' ? { reuseUser: true as const } : {}),
      })
    }
    await this.store.saveSessionPrefs(session, {
      mode: request.mode,
      channel,
      provider,
      model,
      thinking: thinking.thinking,
      search: request.search && channel === 'rich',
      localSearch: request.localSearch,
    }, turn)
    if (originalQuestionId === undefined && attachments.records.length > 0) {
      writePluginRecord(session, 'plugin:chat-workspace/attachments', {
        turn,
        userMessageId: userMessage.id,
        attachments: attachments.records.map((record) => ({
          id: record.id, name: record.name, size: record.size, handling: record.handling, mimeType: record.mimeType,
        })),
      })
    }
    session.append('step/start', { turn, step: 1 })
    if (this.systemPromptChanged(session, systemPrompt)) {
      session.append('system/message', { turn, step: 1, message: createSystemMessage(systemPrompt) }, { surfaceOp: 'append' })
    }
    // append 返回已落日志事件(含分配的 seq);title 的 messageSeqs 必须引用
    // user/message 事件自身的 seq(V0 实测:误用 session.seq 会偏 1,冷读校验拒绝)。
    const userSeq = originalQuestionId === undefined
      ? makeSeq(session.append('user/message', userMessage, { surfaceOp: 'append' }).seq)
      : events.find((event) => event.type === 'user/message' && event.data.id === originalQuestionId)?.seq
    await this.workspace.flushSession(session)
    const diagnose = (await this.diagnostics()).requestDiagnostics
    const requestId = crypto.randomUUID()
    const startedAt = Date.now()
    if (diagnose) {
      this.ctx.logger.warn(
        JSON.stringify({ requestId, model, state: 'started' }),
      )
    }

    emit({
      type: 'start',
      userMessageId: originalQuestionId ?? userMessage.id,
      replyId: `reply-${turn}-${Date.now()}`,
      prefix: prefixReply !== undefined,
      channel,
      model,
      thinking: thinking.thinking,
      ...(retrievalNote !== undefined ? { retrievalNote } : {}),
    })
    let reply: DemoAssistant = {
      id: 'pending',
      role: 'assistant',
      createdAt: Date.now(),
      model,
      thinking: thinking.thinking !== 'off',
      search: request.search && channel === 'rich',
      prefix: true,
      status: 'pending',
      blocks: [],
      latestReminder,
    }
    const blockIndexes = new Map<number, number>()
    const accumulator = new AssistantStreamAccumulator()
    let usage: DemoAssistant['usage'] | undefined
    let stopReason: DemoAssistant['stopReason'] | undefined
    let stopDetails: DemoAssistant['stopDetails'] | undefined
    let apiTitle: string | undefined
    let aborted = false
    const timeout = AbortSignal.timeout(300_000)
    const streamSignal = AbortSignal.any([signal, timeout])

    try {
      const stream = channel === 'rich'
        ? this.streamRich(richMessages, request, model, thinking.richEnabled, needsTitle, streamSignal, systemPrompt)
        : this.streamGeneric(provider ?? '', request.genericModel ?? model, richMessages, thinking.genericEffort, streamSignal,
          usePlanTools ? settings.maxPlanSteps : 0, session.id, systemPrompt)
      for await (const channelEvent of stream) {
        if (disconnected()) {
          aborted = true
          controller.abort()
        }
        const now = Date.now()
        reply = applyEvent(reply, channelEvent.rich, now, blockIndexes)
        if (channelEvent.raw !== undefined) {
          accumulator.push({ time: now, chunk: channelEvent.raw })
        } else {
          for (const chunk of richEventToChunks(channelEvent.rich, reply, blockIndexes)) {
            accumulator.push({ time: now, chunk })
          }
        }
        const event = channelEvent.rich
        if (diagnose && event.type === 'content_block_start') {
          const block = event.content_block
          const toolError = block.type === 'web_fetch_tool_result'
            && block.content.type === 'web_fetch_tool_result_error'
            && /^[a-z_]{1,64}$/.test(block.content.error_code)
            ? block.content.error_code
            : undefined
          console.info('[ChatDS]', JSON.stringify({ requestId, index: event.index, blockType: block.type, toolError }))
        }
        if (event.type === 'message_delta') {
          stopReason = event.delta.stop_reason
          stopDetails = event.delta.stop_details
          usage = event.usage ?? usage
          if (
            needsTitle
            && (event.delta.stop_reason === 'end_turn' || event.delta.stop_reason === 'max_tokens')
            && event.delta.title?.trim()
            && !signal.aborted
          ) {
            apiTitle = event.delta.title.trim()
          }
        }
        if (event.type === 'message_start' && event.message.usage !== undefined) {
          usage = event.message.usage
        }
        emit({ type: 'event', event })
      }
    } catch (error) {
      if (signal.aborted) {
        aborted = true
      } else {
        const failure = timeout.aborted
          ? { kind: 'network' as const, message: '等待模型回复超时。可以重新生成。' }
          : toRichFailure(error)
        if (!failure.message) failure.message = '连接在答复结束前中断。可以重新生成。'
        if (attachments.hasCloud && /(?:file[_ -]?(?:id|reference)|(?:pdf|image|document) file).{0,80}(?:expir|invalid|not found|does not exist)|(?:expir|invalid|unknown).{0,30}file[_ -]?id/i.test(failure.message)) {
          failure.message = 'DeepSeek 拒绝了文件引用。请移除有问题的附件，重新添加后发送以授权上传。'
        }
        if (diagnose) {
          console.info('[ChatDS]', JSON.stringify({ requestId, model, state: 'failed', errorType: failure.kind, code: failure.status, elapsedMs: Date.now() - startedAt, usage }))
        }
        const llmFailure: LlmFailure = {
          message: failure.message,
          code: timeout.aborted ? 'REQUEST_TIMEOUT' : `CHATWORKSPACE_${failure.kind.toUpperCase()}`,
          ...(failure.status !== undefined ? { status: failure.status } : {}),
        }
        const failed = settleReply(reply, 'error', Date.now(), {
          kind: 'stream',
          message: llmFailure.message,
          code: llmFailure.code,
          ...(llmFailure.status !== undefined ? { status: llmFailure.status } : {}),
        })
        const persistedId = await this.finishTurn(session, {
          turn,
          reply: failed,
          accumulator,
          usage,
          outcome: { kind: 'error', failure: llmFailure },
          model,
          provider,
          ...(branchAction === 'continue' && branchMergeIntoId !== undefined
            ? { branch: { mergeIntoId: branchMergeIntoId, userMessageId: userMessage.id } }
            : {}),
        })
        // R8:回合真实账单(cost-meter 未安装时无字段)
        const failedCost = channel === 'rich' ? undefined : await this.turnCost(session.id, turnStartEvent.seq, persistedId.turnEndSeq)
        // 落盘后回一个 settled(带持久 id 与错误态),页面以此对齐权威消息 id
        emit({ type: 'settled', reply: { ...failed, id: persistedId.id, usage, ...(channel === 'rich' ? { usageSource: 'rich' as const } : {}) }, sessionId: session.id,
          ...(failedCost !== undefined ? { cost: failedCost } : {}) })
        return
      }
    }

    aborted ||= signal.aborted
    if (diagnose) {
      console.info('[ChatDS]', JSON.stringify({ requestId, model, state: aborted ? 'cancelled' : 'settled', reason: stopReason, elapsedMs: Date.now() - startedAt, usage }))
    }

    // ── 收尾落盘(demo settleReply 语义;refusal 丢思考/正文) ──
    const providerFailure = aborted ? undefined : missingAnswer(reply.blocks, request.search, stopReason)
    const settled = settleReply(
      { ...reply, stopReason, stopDetails, usage },
      aborted ? 'stopped' : providerFailure ? 'error' : 'done',
      Date.now(),
      providerFailure ? { kind: 'stream', ...providerFailure } : undefined,
    )
    const persistedId = await this.finishTurn(session, {
      turn,
      reply: settled,
      accumulator,
      usage,
      outcome: aborted ? { kind: 'aborted' } : providerFailure ? { kind: 'error', failure: providerFailure } : { kind: 'completed' },
      apiTitle: providerFailure ? undefined : apiTitle,
      userSeq,
      model,
      provider,
      ...(branchAction === 'continue' && branchMergeIntoId !== undefined
        ? { branch: { mergeIntoId: branchMergeIntoId, userMessageId: userMessage.id } }
        : {}),
    })
    // R8:回合真实账单(dsh-cost-meter 官方账目;失败或缺服务时省略字段)
    const turnCostRecord = channel === 'rich' ? undefined : await this.turnCost(session.id, turnStartEvent.seq, persistedId.turnEndSeq)
    emit({
      type: 'settled',
      reply: { ...settled, id: persistedId.id, ...(channel === 'rich' ? { usageSource: 'rich' as const } : {}) },
      sessionId: session.id,
      ...(!providerFailure && apiTitle !== undefined ? { title: apiTitle } : {}),
      ...(turnCostRecord !== undefined ? { cost: turnCostRecord } : {}),
    })
  }

  /** Rich 通路流(官方 Messages API;demo 同款请求体;system 含全局附加提示词)。 */
  private async *streamRich(
    richMessages: ReturnType<typeof toRequestMessages>,
    request: TurnRequest,
    model: string,
    thinkingEnabled: boolean,
    needsTitle: boolean,
    signal: AbortSignal,
    systemPrompt: string,
  ): AsyncGenerator<ChannelEvent> {
    const body: CreateMessageRequest = {
      model: model as CreateMessageRequest['model'],
      system: systemPrompt,
      messages: richMessages,
      thinking: { type: thinkingEnabled ? 'enabled' : 'disabled' },
      safety_check: SAFETY_CHECK,
      tools: demoServerTools(request.search),
      ...(needsTitle ? { title: { enabled: true } } : {}),
    }
    for await (const event of this.gateway.stream(body, signal)) {
      yield { rich: event }
    }
  }

  /** 通用通路流(ctx.llm 正式接口;无工具;demo 历史规则;system 含全局附加提示词)。 */
  private async *streamGeneric(
    provider: string,
    model: string,
    richMessages: ReturnType<typeof toRequestMessages>,
    effort: string | undefined,
    signal: AbortSignal,
    planSteps: number,
    sessionId: string,
    systemPrompt: string,
  ): AsyncGenerator<ChannelEvent> {
    const messages: RequestMessage[] = richMessages.flatMap((message): RequestMessage[] => {
      if (message.role === 'latest_reminder') return []
      if (message.role === 'user') {
        const text = typeof message.content === 'string'
          ? message.content
          : message.content
            .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
            .map((block) => block.text)
            .join('')
        return [createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })]
      }
      // assistant:仅文本块(思考/工具块不回传,demo 语义)
      const text = (message.content as { type?: string; text?: string }[])
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('\n\n')
      return [createAssistantMessage({ content: [{ type: 'text', text }] as ContentBlock[], source: { provider: 'chat-workspace-history', model: 'history' } })]
    })
    const options = {
      provider,
      model,
      messages,
      system: systemPrompt,
      sessionId: SessionId(sessionId),
      ...(effort !== undefined ? { reasoningEffort: ReasoningEffortId(effort) } : {}),
      signal,
    }
    const chunks = planSteps > 0
      ? streamReadOnlyPlan((input) => this.ctx.llm.stream(input), options, this.search, planSteps, () => this.store.planGrants(sessionId))
      : this.ctx.llm.stream(options)
    yield* translateGenericChunks(chunks)
  }

  /** 落盘 assistant/message → step/end → turn/end → [title] → flush(持久屏障)。返回持久消息 id。 */
  private async finishTurn(
    session: Session,
    args: {
      turn: number
      reply: DemoAssistant
      accumulator: AssistantStreamAccumulator
      usage: DemoAssistant['usage'] | undefined
      outcome: { kind: 'completed' } | { kind: 'aborted' } | { kind: 'error'; failure: { message: string; code: string; status?: number } }
      apiTitle?: string
      userSeq?: SessionSeq
      model: string
      provider?: string
      /** 续写分支记录(块并入原回复;hideIds 含本轮提问副本与续写块)。 */
      branch?: { mergeIntoId: string; userMessageId: string }
    },
  ): Promise<{ id: string; turnEndSeq: SessionSeq }> {
    const { turn, reply, accumulator, usage, outcome } = args
    const rich = args.provider === undefined
    // The cost-meter backfill consumes canonical usage even for calls outside ctx.llm.
    // WebChat keeps direct Rich API usage in an ignorable record keyed to the reply.
    const stream: import('@deepseek-ai/dsh-llm').AssistantStreamRecord[] = accumulator.snapshot().filter(
      (record) => !rich || record.type !== 'chunk' || record.chunk.type !== 'usage',
    )
    const content = replyBlocksToDshContent(reply.blocks) as ContentBlock[]
    const message = createAssistantMessage({
      content,
      source: {
        provider: args.provider ?? RICH_PROVIDER,
        model: reply.model ?? args.model,
      },
    })
    session.append('assistant/message', {
      turn,
      step: 1,
      message,
      stream,
      ...(!rich && usage !== undefined ? { usage: toTokenUsage(usage) } : {}),
      ...(outcome.kind === 'aborted' ? { interrupted: true as const } : {}),
    }, { surfaceOp: 'append' })
    if (rich && usage !== undefined) {
      writePluginRecord(session, 'plugin:chat-workspace/rich-usage', { messageId: message.id, usage })
      // R8.5:同一用量按官方 external_usage.json 协议进 dsh-cost-meter 统一账本(幂等,失败不影响回合)。
      this.ledger?.append({
        messageId: message.id,
        at: Date.now(),
        model: message.source.model ?? args.model,
        usage,
      })
    }
    if (args.branch !== undefined) {
      writePluginRecord(session, 'plugin:chat-workspace/branch', {
        turn,
        action: 'continue',
        hideIds: [args.branch.userMessageId, message.id],
        mergeIntoId: args.branch.mergeIntoId,
        continueReplyId: message.id,
      })
    }
    session.append('step/end', { turn, step: 1 })
    const reason = outcome.kind === 'completed'
      ? { kind: 'completed' as const }
      : outcome.kind === 'aborted'
        ? { kind: 'aborted' as const, reason: { kind: 'user' as const } }
        : { kind: 'error' as const, error: outcome.failure }
    const turnEndEvent = session.append('turn/end', { turn, reason })
    if (args.apiTitle !== undefined) {
      session.append('session/title', {
        title: args.apiTitle,
        messageSeqs: args.userSeq !== undefined ? [args.userSeq] : [],
        source: { kind: 'provider', provider: TITLE_PROVIDER },
      })
    }
    await this.workspace.flushSession(session)
    return { id: message.id, turnEndSeq: makeSeq(Number(turnEndEvent.seq)) }
  }

  /**
   * R8:本回合真实账单(dsh-cost-meter 官方 getTurnCost;按回合 start/end seq)。
   * cost-meter 未安装或账目未生成时返回 undefined,页面不显示费用。
   */
  async turnCost(sessionId: string, startSeq: SessionSeq, endSeq: SessionSeq): Promise<unknown | undefined> {
    const meter = this.ctx.get('costMeter' as never) as
      | { getTurnCost?: (sessionId: string, startSeq: number, endSeq: number) => Promise<unknown> }
      | undefined
    if (typeof meter?.getTurnCost !== 'function') return undefined
    return await Promise.resolve().then(() => meter.getTurnCost!(sessionId, Number(startSeq), Number(endSeq))).catch(() => undefined)
  }
  /** 下一轮号 = 既有 turn/start 事件数 + 1。 */
  private nextTurn(session: Session): number {
    return session.snapshotEvents(makeOffset(0)).filter((event) => event.type === 'turn/start').length + 1
  }

  /** 既有 request/header 数。 */
  private headerCount(session: Session): number {
    return session.snapshotEvents(makeOffset(0)).filter((event) => event.type === 'request/header').length
  }

  /** 请求头是否与最近一次不同(provider/model/effort)。 */
  private headerChanged(session: Session, channel: 'rich' | 'generic', provider: string | undefined, model: string, effort?: string): boolean {
    const events = session.snapshotEvents(makeOffset(0))
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (event?.type === 'request/header') {
        const config = event.data.header.config
        const expectedProvider = channel === 'rich' ? RICH_PROVIDER : (provider ?? 'generic')
        return !(config.provider === expectedProvider && config.model === model && config.reasoningEffort === effort)
      }
    }
    return true
  }

  /** 系统提示是否与最新 system/message 节点不同(R8:比较动态生效提示,变更只改写一次)。 */
  private systemPromptChanged(session: Session, expected: string): boolean {
    const events = session.snapshotEvents(makeOffset(0))
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (event?.type === 'system/message') {
        let text = ''
        for (const block of event.data.message.content) {
          if (block.type === 'text') text += block.text
        }
        return text !== expected
      }
    }
    return true
  }
}

function titleOf(session: Session): string | null {
  const events = session.snapshotEvents(makeOffset(0))
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type === 'session/title') {
      const title = (event.data as { title?: unknown }).title
      return typeof title === 'string' ? title : null
    }
  }
  return null
}

/**
 * Rich 流式事件 → 通用 StreamChunk 时间线(AssistantStreamRecord 的素材)。
 * 服务端工具块原子下发,一次给出 block-start + block-end;正文/思考在 stop 时
 * 以带 citations/signature 的完整块收尾。stop 通过 blockIndexes 找回对应块。
 */
function* richEventToChunks(
  event: MessageStreamEvent,
  reply: DemoAssistant,
  blockIndexes: ReadonlyMap<number, number>,
): Generator<StreamChunk> {
  switch (event.type) {
    case 'content_block_start': {
      const block = event.content_block
      if (block.type === 'text') {
        yield { type: 'block-start', index: event.index, blockType: 'text' }
        if (block.text) yield { type: 'text-delta', index: event.index, text: block.text }
        return
      }
      if (block.type === 'thinking') {
        yield { type: 'block-start', index: event.index, blockType: 'reasoning' }
        if (block.thinking) yield { type: 'reasoning-delta', index: event.index, text: block.thinking }
        return
      }
      if (block.type === 'server_tool_use') {
        yield { type: 'block-start', index: event.index, blockType: 'server-tool-use' }
        yield { type: 'block-end', index: event.index, block: { type: 'server-tool-use', tool: block } }
        return
      }
      if (block.type === 'web_search_tool_result') {
        yield { type: 'block-start', index: event.index, blockType: 'web-search-tool-result' }
        yield { type: 'block-end', index: event.index, block: { type: 'web-search-tool-result', tool: block } }
        return
      }
      if (block.type === 'web_fetch_tool_result') {
        yield { type: 'block-start', index: event.index, blockType: 'web-fetch-tool-result' }
        yield { type: 'block-end', index: event.index, block: { type: 'web-fetch-tool-result', tool: block } }
        return
      }
      return // tool_use:客户端工具块不进时间线(demo 不展示、不续写、无执行面)
    }
    case 'content_block_delta': {
      if (event.delta.type === 'text_delta') {
        yield { type: 'text-delta', index: event.index, text: event.delta.text }
        return
      }
      if (event.delta.type === 'thinking_delta') {
        yield { type: 'reasoning-delta', index: event.index, text: event.delta.thinking }
        return
      }
      return // signature_delta / citations_delta 累积进收尾块
    }
    case 'content_block_stop': {
      const mapped = blockIndexes.get(event.index)
      const block = mapped === undefined ? undefined : reply.blocks[mapped]
      if (block?.type === 'text') {
        yield { type: 'block-end', index: mapped!, block: { type: 'text', text: block.text, ...(block.citations !== undefined ? { citations: block.citations } : {}) } }
        return
      }
      if (block?.type === 'thinking') {
        yield { type: 'block-end', index: mapped!, block: { type: 'reasoning', text: block.thinking, ...(block.signature !== undefined ? { signature: block.signature } : {}) } }
        return
      }
      return
    }
    case 'message_stop': {
      const usage = reply.usage
      if (usage !== undefined) {
        yield { type: 'usage', usage: toTokenUsage(usage) }
      }
      const reason = reply.stopReason !== undefined ? richFinishReason(reply.stopReason) : { kind: 'stop' as const }
      yield {
        type: 'finish',
        reason,
        replayState: {
          response: {
            ...(reply.stopReason !== undefined ? { stopReason: reply.stopReason } : {}),
            ...(reply.stopDetails !== undefined ? { stopDetails: reply.stopDetails } : {}),
            ...(reply.latestReminder !== undefined ? { latestReminder: reply.latestReminder } : {}),
            ...(usage !== undefined ? { usage } : {}),
          },
        },
      }
      return
    }
    default:
      return
  }
}
