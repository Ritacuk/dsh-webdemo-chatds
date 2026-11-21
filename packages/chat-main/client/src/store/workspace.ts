/**
 * 工作区 store — demo store.ts 的移植(zustand),持久化从 IndexedDB 换成
 * Host 插件路由(权威存储是 DSH Session,页面不落第二份盘)。
 *
 * 与 demo 的差异(见 docs/diff-vs-demo.md):
 * - 会话列表/历史经 api.listSessions/api.getSession 加载(页面只做缓存);
 * - 流式回合消费 Host 的 ChatStreamFrame SSE,合并逻辑仍是共享包的
 *   applyEvent/settleReply(与 demo 逐行一致);
 * - P2:会话级模式/模型/思考/搜索偏好(切会话恢复)、模型目录、附件、设置;
 * - 分支 UI 暂不暴露(P2 保留数据结构)。
 */

import { create } from 'zustand'
import { api, streamTurn } from '../services/api.js'
import { useSettings } from '../services/settings.js'
import { showToast } from '../components/base/toastState.js'
import {
  applyEvent,
  canContinueReply,
  settleReply,
  type AssistantMessage,
  type ChatStreamFrame,
  type Session,
  type WireSessionSummary,
  type UserMessage,
  type WireAttachment,
  type WireModelCatalog,
  type WireModelEntry,
  type WorkspaceSettings,
  type WorkspaceMode,
  type ModelChannel,
  type ThinkingEffort,
  type LocalSearchResult,
} from '@dsh-chat/shared'

/** deepseek-flash 同时支持深度思考与图片输入(demo store.ts:30 同款默认)。 */
export const DEFAULT_MODEL = 'deepseek-flash'

/** 单个会话的输入区状态(P2-A:随会话保存,切换会话恢复)。 */
export interface SessionInputState {
  mode: WorkspaceMode
  channel: ModelChannel
  provider?: string
  model: string
  thinking: ThinkingEffort
  search: boolean
  localSearch: boolean
}

type ChatState = {
  ready: boolean
  initError: boolean
  /** 仅列表元数据,按 updatedAt 降序;流式消息更新不会改变此数组。 */
  sessions: WireSessionSummary[]
  sessionCache: Record<string, Session>
  sessionLoadErrors: Record<string, boolean>
  /** null 表示新对话(欢迎页) */
  activeId: string | null
  /** 正在生成回复的会话 */
  streaming: Record<string, AbortController>
  /** 模型目录(P2-E) */
  models: WireModelCatalog | null
  /** 会话输入状态(P2-A;按会话保存) */
  input: Record<string, SessionInputState>
  /** 新会话(未创建)的输入状态 */
  draftInput: SessionInputState
  /** 待上传附件(按会话;发送后由消息携带) */
  pendingAttachments: Record<string, WireAttachment[]>
  /** 设置(P2-I) */
  settings: WorkspaceSettings | null
  /** R8:回合完成计数(状态条等轻量订阅按它刷新,避免读取整个会话)。 */
  settledTick: number
  /** R8:挂载时注入 Input 草稿的队列(交接单「带去新会话」);键为 sessionId。 */
  draftTexts: Record<string, string>
}

const defaultInput = (settings: WorkspaceSettings | null, last?: SessionInputState): SessionInputState => ({
  mode: settings?.defaultMode ?? 'chat',
  channel: 'rich',
  model: DEFAULT_MODEL,
  thinking: settings?.defaultThinking ?? 'off',
  search: settings?.defaultSearch ?? false,
  localSearch: settings?.defaultLocalSearch ?? false,
  ...(last !== undefined && (settings?.rememberLastModel ?? true)
    ? { channel: last.channel, provider: last.provider, model: last.model }
    : settings?.rememberLastModel ? settings.lastModel : {}),
})

export const useChatStore = create<ChatState>(() => ({
  ready: false,
  initError: false,
  sessions: [],
  sessionCache: {},
  sessionLoadErrors: {},
  activeId: null,
  streaming: {},
  models: null,
  input: {},
  draftInput: defaultInput(null),
  pendingAttachments: {},
  settings: null,
  settledTick: 0,
  draftTexts: {},
}))

/** R8:把文本排入指定会话 Input 的挂载草稿(交接单「带去新会话」)。 */
export const queueDraftText = (sessionId: string, text: string): void => {
  set((state) => ({ draftTexts: { ...state.draftTexts, [sessionId]: text } }))
}

/** R8:Input 挂载时取出排队的草稿文本(取完即清)。 */
export const takeDraftText = (sessionId: string): string | undefined => {
  const text = get().draftTexts[sessionId]
  if (text !== undefined) {
    set((state) => {
      const draftTexts = { ...state.draftTexts }
      delete draftTexts[sessionId]
      return { draftTexts }
    })
  }
  return text
}

const { getState: get, setState: set } = useChatStore

const sortSessions = (sessions: WireSessionSummary[]) =>
  [...sessions].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt)

export const setSessionPinned = async (sessionId: string, pinned: boolean) => {
  await api.setPinned(sessionId, pinned)
  await refreshSessions()
}

export const setSessionArchived = async (sessionId: string, archived: boolean) => {
  await api.setArchived(sessionId, archived)
  set((state) => ({
    sessions: state.sessions.map((session) => session.id === sessionId ? { ...session, archived } : session),
  }))
  await refreshSessions()
}

const getSession = (id: string) => {
  const cache = get().sessionCache
  return Object.hasOwn(cache, id) ? cache[id]! : undefined
}

const updateSession = (id: string, updater: (session: Session) => Session) => {
  const cached = getSession(id)
  if (cached === undefined) return
  const next = updater(cached)
  set((state) => ({ sessionCache: { ...state.sessionCache, [id]: next } }))
  void refreshSessions()
}

/** 刷新列表(不打断流式;失败静默,下次操作再试)。 */
export const refreshSessions = async (): Promise<void> => {
  try {
    const { sessions } = await api.listSessions()
    set(() => ({ sessions: sortSessions(sessions) }))
  } catch {
    // 列表刷新失败不打扰聊天
  }
}

export const initStore = async (): Promise<void> => {
  try {
    const [models, settings] = await Promise.all([
      api.models().catch(() => null),
      api.getSettings().catch(() => null),
      refreshSessions(),
    ] as const)
    const resolved = settings as WorkspaceSettings | null
    set(() => ({
      ready: true,
      models: models as WireModelCatalog | null,
      settings: resolved,
      draftInput: defaultInput(resolved),
    }))
  } catch {
    set(() => ({ ready: true, initError: true }))
  }
}

const getStreamController = (id: string) => get().streaming[id]

/** 当前生效的输入状态(会话已创建则取会话级,否则取草稿)。 */
export const useInputState = (sessionId: string | null): SessionInputState => {
  const input = useChatStore((state) => state.input)
  const draft = useChatStore((state) => state.draftInput)
  return sessionId !== null && Object.hasOwn(input, sessionId) ? input[sessionId]! : draft
}

const readInputState = (sessionId: string): SessionInputState => {
  const { input, draftInput } = get()
  return input[sessionId] ?? draftInput
}

/** 更新输入状态(会话已创建则更新会话级)。 */
export const updateInputState = (sessionId: string | null, patch: Partial<SessionInputState>): void => {
  set((state) => {
    if (sessionId === null) {
      return { draftInput: { ...state.draftInput, ...patch } }
    }
    const current = state.input[sessionId]
      ?? state.draftInput
      ?? defaultInput(state.settings)
    return { input: { ...state.input, [sessionId]: { ...current, ...patch } } }
  })
}

/** 打开会话:拉取历史(Host → DSH Session 权威回放)+ 恢复会话偏好。 */
export const openSession = async (id: string): Promise<void> => {
  set(() => ({ activeId: id }))
  if (getSession(id) !== undefined) return
  try {
    const [wire, prefs] = await Promise.all([
      api.getSession(id),
      api.getSessionPrefs(id).catch(() => null),
    ] as const)
    set((state) => {
      const restored: SessionInputState = prefs !== null
        ? {
            mode: prefs.mode,
            channel: prefs.channel,
            provider: prefs.provider,
            model: prefs.model,
            thinking: prefs.thinking,
            search: prefs.search,
            localSearch: prefs.localSearch,
          }
        : (state.input[id] ?? defaultInput(state.settings))
      return {
        sessionCache: {
          ...state.sessionCache,
          [id]: {
            id: wire.id,
            title: wire.title,
            createdAt: wire.createdAt,
            updatedAt: wire.updatedAt,
            messages: wire.messages,
            versions: wire.versions,
          },
        },
        sessionLoadErrors: { ...state.sessionLoadErrors, [id]: false },
        input: { ...state.input, [id]: state.input[id] ?? restored },
      }
    })
  } catch {
    set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: true } }))
  }
}

export const closeSession = (): void => {
  set(() => ({ activeId: null }))
}

export const selectSessionVersion = async (id: string, messageId: string) => {
  await api.selectVersion(id, messageId)
  await refreshVersionPath(id)
}

async function refreshVersionPath(id: string): Promise<void> {
  const wire = await api.getSession(id)
  updateSession(id, (session) => ({ ...session, messages: wire.messages, versions: wire.versions }))
}

export const createSession = async (options?: SessionInputState): Promise<string> => {
  const { id } = await api.createSession()
  set((state) => ({
    sessionCache: {
      ...state.sessionCache,
      [id]: { id, title: '新对话', createdAt: Date.now(), updatedAt: Date.now(), messages: [] },
    },
    input: { ...state.input, [id]: options ?? state.draftInput },
  }))
  set(() => ({ activeId: id }))
  await refreshSessions()
  return id
}

/** 删除会话(P1 语义:Host 侧隐藏;持久日志保留)。 */
export const deleteSession = async (id: string): Promise<void> => {
  const controller = getStreamController(id)
  controller?.abort()
  await api.deleteSession(id).catch(() => {})
  set((state) => {
    const cache = { ...state.sessionCache }
    delete cache[id]
    const input = { ...state.input }
    delete input[id]
    const pending = { ...state.pendingAttachments }
    delete pending[id]
    return {
      sessionCache: cache,
      input,
      pendingAttachments: pending,
      activeId: state.activeId === id ? null : state.activeId,
    }
  })
  await refreshSessions()
}

export const renameSession = async (id: string, title: string): Promise<void> => {
  const renamed = await api.renameSession(id, title)
  updateSession(id, (session) => ({ ...session, title: renamed.title }))
  await refreshSessions()
}

export const stopStreaming = async (sessionId: string): Promise<void> => {
  const controller = getStreamController(sessionId)
  if (controller === undefined) return
  // Host 端同时中止真实请求;这里取消本地消费
  void api.stop(sessionId).catch(() => {})
  controller.abort()
}

/** 待上传附件管理(P2-F)。 */
export const uploadAttachment = async (sessionId: string, file: File): Promise<void> => {
  const attachment = await api.uploadFile(sessionId, file)
  set((state) => ({
    pendingAttachments: {
      ...state.pendingAttachments,
      [sessionId]: [...(state.pendingAttachments[sessionId] ?? []), attachment],
    },
  }))
}

export const removeAttachment = async (sessionId: string, id: string): Promise<void> => {
  await api.deleteAttachment(sessionId, id)
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) => message.role === 'user'
      ? { ...message, files: message.files.filter((file) => file.id !== id) }
      : message),
  }))
  set((state) => ({
    pendingAttachments: {
      ...state.pendingAttachments,
      [sessionId]: (state.pendingAttachments[sessionId] ?? []).filter((a) => a.id !== id),
    },
  }))
}

/** 本地检索预览(P2-G:发送前的手动检索)。 */
export const runLocalSearchPreview = async (query: string): Promise<LocalSearchResult> =>
  await api.localSearch(query)

export const updateSettings = async (patch: Partial<WorkspaceSettings>): Promise<WorkspaceSettings> => {
  const settings = await api.updateSettings(patch)
  applySettings(settings)
  return settings
}

export const reloadSettings = async (): Promise<void> => {
  applySettings(await api.getSettings())
}

function applySettings(settings: WorkspaceSettings): void {
  set((state) => {
    const previous = defaultInput(state.settings)
    const next = defaultInput(settings, state.draftInput)
    const sync = (input: SessionInputState): SessionInputState => ({
      ...input,
      mode: input.mode === previous.mode ? next.mode : input.mode,
      thinking: input.channel === 'rich' && input.thinking === previous.thinking ? next.thinking : input.thinking,
      search: input.search === previous.search ? next.search : input.search,
      localSearch: input.localSearch === previous.localSearch ? next.localSearch : input.localSearch,
    })
    return {
      settings,
      draftInput: sync(state.draftInput),
      input: Object.fromEntries(Object.entries(state.input).map(([id, input]) => [id, sync(input)])),
    }
  })
}

let saveModel: Promise<unknown> = Promise.resolve()

/** 选择模型:立即生效于输入态 + Host 会话偏好记录(R8;失败仅提示,不阻断聊天)。 */
export const selectModel = (sessionId: string | null, entry: WireModelEntry): Promise<unknown> => {
  const current = sessionId === null ? get().draftInput : readInputState(sessionId)
  const efforts = entry.capability.thinkingEfforts
  const thinking = efforts.includes(current.thinking) ? current.thinking : entry.capability.defaultThinkingEffort ?? efforts[0] ?? 'off'
  updateInputState(sessionId, {
    channel: entry.channel,
    provider: entry.provider,
    model: entry.model,
    thinking,
  })
  // R8:模型切换调用 Host 会话接口(白名单校验 + KV 偏好立即落盘;官方 selectModel 绑定
  // 原生 Agent Session,chatws 会话由 Host 回退到会话偏好记录,下一回合落 request/header)。
  if (sessionId !== null) {
    void api.selectSessionModel(sessionId, { channel: entry.channel, provider: entry.provider, model: entry.model, thinking })
      .catch(() => showToast('本次选择已生效，会话模型记忆保存失败。'))
  }
  saveModel = saveModel.catch(() => {}).then(() => api.updateSettings({
    lastModel: { channel: entry.channel, provider: entry.provider, model: entry.model },
  }))
  return saveModel
}

/** 编辑/重新生成/继续生成的回合动作(与 Host 分支记录语义一致)。 */
export type EditAction = { action: 'edit' | 'regenerate' | 'continue'; targetMessageId: string }

/**
 * 流式回合消费(普通发送/编辑/重新生成/继续生成共用)。
 * settled 帧携带 Host 落盘的权威消息 id:start 帧对齐提问 id,settled 对齐回答 id,
 * 使后续编辑/重新生成能以日志 id 为目标。
 */
const streamTurnLoop = async (args: {
  sessionId: string
  content: string
  options: SessionInputState
  attachments: readonly { id: string }[]
  allowAttachmentUpload?: boolean
  edit?: EditAction
  /** 本地回复占位 id(补丁定位) */
  replyId: string
  /** 本地提问 id(start 帧对齐权威 id;continue 无新提问) */
  questionId?: string
  /** continue:原回复已有块(settled 时把新块并入其后) */
  baseBlocks?: AssistantMessage['blocks']
}): Promise<void> => {
  const { sessionId, content, options, attachments, allowAttachmentUpload, edit, replyId, questionId, baseBlocks } = args
  const controller = new AbortController()
  set((state) => ({ streaming: { ...state.streaming, [sessionId]: controller } }))
  const patchReply = (updater: (current: AssistantMessage) => AssistantMessage) => {
    updateSession(sessionId, (session) => ({
      ...session,
      messages: session.messages.map((message) =>
        message.id === replyId && message.role === 'assistant' ? updater(message) : message
      ),
    }))
  }
  const blockIndexes = new Map<number, number>()
  let settled = false
  let current = (get().sessionCache[sessionId]?.messages.find((m) => m.id === replyId && m.role === 'assistant') as AssistantMessage | undefined) ?? {
    id: replyId,
    role: 'assistant',
    createdAt: Date.now(),
    model: null,
    prefix: true,
    status: 'pending',
    blocks: [],
  }
  try {
    for await (const frame of streamTurn({
      sessionId,
      locale: useSettings.getState().locale,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      content,
      mode: options.mode,
      channel: options.channel,
      model: options.channel === 'rich' ? options.model : undefined,
      provider: options.channel === 'generic' ? options.provider : undefined,
      genericModel: options.channel === 'generic' ? options.model : undefined,
      thinking: options.thinking,
      search: options.search && options.channel === 'rich',
      attachments: attachments.map((a) => a.id),
      allowAttachmentUpload,
      localSearch: options.localSearch,
      ...(edit !== undefined ? { edit } : {}),
    }, controller.signal)) {
      switch (frame.type) {
        case 'event': {
          const merged = applyEvent(current, frame.event, Date.now(), blockIndexes)
          current = merged
          patchReply(() => merged)
          break
        }
        case 'settled': {
          settled = true
          const authoritative = frame.reply
          // 续写:Host 只回新块,并入原回复;其余:采用权威回复与其持久 id
          const merged: AssistantMessage = baseBlocks !== undefined
            ? { ...authoritative, id: replyId, blocks: [...baseBlocks, ...authoritative.blocks], prefix: true }
            : { ...authoritative, id: authoritative.id !== 'pending' && authoritative.id !== '' ? authoritative.id : replyId }
          // R8:回合真实账单(cost-meter 产物;仅当回合有账目时携带)
          if (frame.cost !== undefined) merged.cost = frame.cost
          current = merged
          patchReply(() => merged)
          // 通知状态条等轻量订阅刷新费用/上下文
          set((state) => ({ settledTick: state.settledTick + 1 }))
          if (frame.title !== undefined) {
            updateSession(sessionId, (session) => ({ ...session, title: frame.title ?? session.title }))
          }
          break
        }
        case 'error': {
          const failed = settleReply(
            current,
            'error',
            Date.now(),
            { kind: 'stream', message: frame.error.message, code: frame.error.code, status: frame.error.status },
          )
          current = failed
          patchReply(() => failed)
          break
        }
        case 'start':
          if (edit === undefined) {
            const submitted = new Set(attachments.map((attachment) => attachment.id))
            set((state) => ({
              pendingAttachments: {
                ...state.pendingAttachments,
                [sessionId]: (state.pendingAttachments[sessionId] ?? []).filter((attachment) => !submitted.has(attachment.id)),
              },
            }))
          }
          // Host 已确认本轮(含实际通路/模型/思考);提问 id 对齐日志权威 id
          if (questionId !== undefined) {
            updateSession(sessionId, (session) => ({
              ...session,
              messages: session.messages.map((message) =>
                message.id === questionId && message.role === 'user'
                  ? { ...message, id: frame.userMessageId }
                  : message
              ),
            }))
          }
          updateInputState(sessionId, {
            channel: frame.channel,
            model: frame.model,
            thinking: frame.thinking,
          })
          break
      }
    }
  } catch (error) {
    // fetch 中断(用户取消)→ 按 stopped 收尾;Host 已按 stopped 落盘
    if (!controller.signal.aborted) {
      const failed = settleReply(
        current,
        'error',
        Date.now(),
        { kind: 'network', message: error instanceof Error ? error.message : String(error) },
      )
      patchReply(() => failed)
    } else {
      const stopped = settleReply(current, 'stopped', Date.now())
      patchReply(() => stopped)
    }
  } finally {
    if (settled && edit !== undefined) await refreshVersionPath(sessionId).catch(() => {})
    set((state) => {
      const streaming = { ...state.streaming }
      delete streaming[sessionId]
      return { streaming }
    })
    // 拉权威终态(标题/用量已由 Host 落盘)
    await refreshSessions()
  }
}

/** 提交一条用户消息并启动流式回合(Host 持久化 + 双通路)。 */
export const sendMessage = async (sessionArg: Session | null, content: string, options: SessionInputState, allowAttachmentUpload = false): Promise<void> => {
  const contentTrimmed = content.trim()
  if (contentTrimmed.length === 0 && !sessionArg) return
  let sessionId: string
  if (sessionArg !== null) {
    sessionId = sessionArg.id
  } else {
    sessionId = await createSession()
  }
  if (getStreamController(sessionId) !== undefined) return
  updateInputState(sessionId, options)
  const attachments = get().pendingAttachments[sessionId] ?? []
  const usableAttachments = attachments.filter((a) => a.handling !== 'unsupported')
  if (contentTrimmed.length === 0 && usableAttachments.length === 0) return

  const question: UserMessage = {
    id: `local-${Date.now()}`,
    role: 'user',
    content: contentTrimmed,
    files: usableAttachments.map((a) => ({
      id: a.id, serverId: null, name: a.name, size: a.size,
      isImage: a.mimeType.startsWith('image/'), mimeType: a.mimeType,
    })),
    createdAt: Date.now(),
  }
  const reply: AssistantMessage = {
    id: `local-r-${Date.now()}`,
    role: 'assistant',
    createdAt: Date.now(),
    model: options.channel === 'rich' ? options.model : `${options.provider ?? ''}:${options.model}`,
    thinking: options.thinking !== 'off',
    search: options.search && options.channel === 'rich',
    prefix: true,
    status: 'pending',
    blocks: [],
  }
  updateSession(sessionId, (session) => ({
    ...session,
    messages: [...session.messages, question, reply],
  }))
  await streamTurnLoop({
    sessionId,
    content: contentTrimmed,
    options,
    attachments: usableAttachments,
    allowAttachmentUpload,
    replyId: reply.id,
    questionId: question.id,
  })
}

/**
 * 编辑提问并重新发送(demo editMessage):从被编辑消息起的旧路径整体被替换为
 * 新的一对问答;旧问题的附件随新提问重发(原件复用,不重复上传)。
 */
export const editMessage = async (sessionId: string, messageId: string, content: string): Promise<boolean> => {
  const text = content.trim()
  const session = getSession(sessionId)
  if (session === undefined || getStreamController(sessionId) !== undefined) return false
  const index = session.messages.findIndex((message) => message.id === messageId)
  const previous = session.messages[index]
  if (previous?.role !== 'user' || (text.length === 0 && previous.files.length === 0)) return false
  const options = readInputState(sessionId)
  const question: UserMessage = {
    id: `local-${Date.now()}`,
    role: 'user',
    content: text,
    files: previous.files,
    createdAt: Date.now(),
  }
  const reply: AssistantMessage = {
    id: `local-r-${Date.now()}`,
    role: 'assistant',
    createdAt: Date.now(),
    model: options.channel === 'rich' ? options.model : `${options.provider ?? ''}:${options.model}`,
    thinking: options.thinking !== 'off',
    search: options.search && options.channel === 'rich',
    prefix: true,
    status: 'pending',
    blocks: [],
  }
  updateSession(sessionId, (s) => ({
    ...s,
    messages: [...s.messages.slice(0, index), question, reply],
  }))
  await streamTurnLoop({
    sessionId,
    content: text,
    options,
    // D1 修复:demo 语义是"旧附件随新提问重发(原件复用)";此前传空数组,
    // 编辑后本轮附件被静默丢弃。这里把原提问的附件 id 交回 Host 重新挂载。
    attachments: previous.files.filter((file) => typeof file.id === 'string' && file.id.length > 0),
    edit: { action: 'edit', targetMessageId: messageId },
    replyId: reply.id,
    questionId: question.id,
  })
  return true
}

/** 重新生成回答(demo regenerateReply):原提问保留,旧回答及其后续被替换。 */
export const regenerateReply = async (sessionId: string, messageId?: string): Promise<boolean> => {
  const session = getSession(sessionId)
  if (session === undefined || getStreamController(sessionId) !== undefined) return false
  const path = session.messages
  const index = messageId === undefined ? path.length - 1 : path.findIndex((m) => m.id === messageId)
  const question = index > 0 ? path[index - 1] : undefined
  const target = index >= 0 ? path[index] : undefined
  if (question?.role !== 'user' || target?.role !== 'assistant') return false
  const options = readInputState(sessionId)
  // 原提问 id 与附件展示保留(demo 语义);Host 侧本轮提问副本与旧回答同批隐藏
  const reply: AssistantMessage = {
    id: `local-r-${Date.now()}`,
    role: 'assistant',
    createdAt: Date.now(),
    model: options.channel === 'rich' ? options.model : `${options.provider ?? ''}:${options.model}`,
    thinking: options.thinking !== 'off',
    search: options.search && options.channel === 'rich',
    prefix: true,
    status: 'pending',
    blocks: [],
  }
  updateSession(sessionId, (s) => ({
    ...s,
    // slice(0, index) 保留原提问(index-1)及其之前;旧回答起整体由新回复替换
    messages: [...s.messages.slice(0, index), reply],
  }))
  await streamTurnLoop({
    sessionId,
    content: question.content,
    options,
    // D1 修复:重新生成同样要保留原提问的附件(V0 后代码传空数组会丢文件)。
    attachments: question.files.filter((file) => typeof file.id === 'string' && file.id.length > 0),
    edit: { action: 'regenerate', targetMessageId: target.id },
    replyId: reply.id,
  })
  return true
}

/** 继续生成(demo continueReply):保留原回答块,新流块追加;仅对路径末尾未完成回答有效。 */
export const continueReply = async (sessionId: string, messageId: string): Promise<boolean> => {
  const session = getSession(sessionId)
  if (session === undefined || getStreamController(sessionId) !== undefined) return false
  const path = session.messages
  const index = path.findIndex((m) => m.id === messageId)
  const question = index > 0 ? path[index - 1] : undefined
  const target = index >= 0 ? path[index] : undefined
  if (
    question?.role !== 'user' || target?.role !== 'assistant'
    || index !== path.length - 1 || !canContinueReply(target)
  ) return false
  const options = readInputState(sessionId)
  const pending: AssistantMessage = { ...target, status: 'pending', stopReason: undefined, stopDetails: undefined, error: undefined }
  updateSession(sessionId, (s) => ({
    ...s,
    messages: s.messages.map((m) => (m.id === messageId ? pending : m)),
  }))
  await streamTurnLoop({
    sessionId,
    content: question.content,
    options,
    // D1 修复:续写沿用原提问上下文,附件一并重放(原件复用)。
    attachments: question.files.filter((file) => typeof file.id === 'string' && file.id.length > 0),
    edit: { action: 'continue', targetMessageId: messageId },
    replyId: messageId,
    baseBlocks: target.blocks,
  })
  return true
}

/** 是否可对本轮续写(P2 暴露;逻辑与 demo 一致)。 */
export const replyCanContinue = (reply: AssistantMessage): boolean => canContinueReply(reply)

/** 供组件读取当前会话。 */
export const useActiveSession = (): Session | null => {
  const state = useChatStore()
  return state.activeId === null ? null : (state.sessionCache[state.activeId] ?? null)
}
