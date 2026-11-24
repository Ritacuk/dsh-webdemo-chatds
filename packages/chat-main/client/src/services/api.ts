import type { ChatDSMemory, HistoryHit, ChatPartitions, PartitionChange, SharingStatus } from '@dsh-chat/shared'
/**
 * 页面 → Host 插件路由 的 API 客户端。
 * 页面只与 /chat-workspace/api 通信;凭证与真实 API 请求全在 Host。
 */

import type {
  ChatStreamFrame,
  LocalSearchResult,
  PromptTemplate,
  PromptVariablePreview,
  SessionTurnPrefs,
  TurnRequest,
  WireAttachment,
  WireHealth,
  WireModelCatalog,
  WireSession,
  WireSessionSummary,
  WorkspaceSettings,
} from '@dsh-chat/shared'

/** SSE 回合流读取:逐帧产出 ChatStreamFrame;AbortSignal 取消。 */
export async function* streamTurn(
  request: TurnRequest,
  signal: AbortSignal
): AsyncGenerator<ChatStreamFrame> {
  const response = await fetch('api/turns', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  })
  if (!response.ok) {
    let message = response.statusText
    try {
      const body = (await response.json()) as { error?: { message?: string } }
      message = body.error?.message ?? message
    } catch {
      // 保持状态文本
    }
    throw new Error(message)
  }
  if (!response.body || !(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    throw new Error('unexpected non-SSE response')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      let index: number
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        for (const line of block.split('\n')) {
          if (line.startsWith('data: ')) {
            yield JSON.parse(line.slice(6)) as ChatStreamFrame
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!response.ok) {
    let message = response.statusText
    try {
      const body = (await response.json()) as { error?: { message?: string } }
      message = body.error?.message ?? message
    } catch {
      // 保持状态文本
    }
    throw new Error(message)
  }
  return (await response.json()) as T
}

export const api = {
  translationOptions: (signal: AbortSignal): Promise<{ available: boolean; provider?: 'bing' | 'google'; language?: string; reason?: string }> =>
    json('api/bridge/translation', { signal }),
  translateReasoning: (data: { id: string; messageId: string; index: number; locale: string; provider: string }, signal: AbortSignal): Promise<{ text: string }> =>
    json('api/bridge/translation', { method: 'POST', body: JSON.stringify(data), signal }),
  historySearch: (data: { query: string; partition?: string; from?: number; to?: number }, signal: AbortSignal): Promise<{ hits: HistoryHit[]; truncated: boolean }> =>
    json('api/bridge/history', { method: 'POST', body: JSON.stringify(data), signal }),
  listMemories: (): Promise<{ memories: ChatDSMemory[] }> => json('api/bridge/memory'),
  saveMemory: (data: { id?: string; text: string; category: string; partition: string | null }): Promise<ChatDSMemory> =>
    json('api/bridge/memory', { method: 'PUT', body: JSON.stringify(data) }),
  deleteMemory: (id: string): Promise<{ ok: boolean }> =>
    json('api/bridge/memory', { method: 'DELETE', body: JSON.stringify({ id }) }),
  health: (): Promise<WireHealth> => json('api/health'),
  models: (): Promise<WireModelCatalog> => json('api/models'),
  listSessions: (): Promise<{ sessions: WireSessionSummary[] }> => json('api/sessions', { signal: AbortSignal.timeout(15_000) }),
  /** R8.5:draft=1 创建占位会话(附件/交接单预建;首条消息前不出现在历史列表)。 */
  createSession: (draft = false): Promise<{ id: string; title: string }> =>
    json(draft ? 'api/sessions?draft=1' : 'api/sessions', { method: 'POST', body: '{}' }),
  getSession: (id: string): Promise<WireSession> => json(`api/sessions/${encodeURIComponent(id)}`),
  toolPermissions: (id: string): Promise<{
    supported: { name: string; description: string; enabled: boolean }[]
    discovered: { name: string; description: string }[]
  }> => json(`api/sessions/${encodeURIComponent(id)}/tools`),
  setToolPermissions: (id: string, grants: string[]): Promise<{ ok: true }> =>
    json(`api/sessions/${encodeURIComponent(id)}/tools`, { method: 'PUT', body: JSON.stringify({ grants }) }),
  selectVersion: (id: string, messageId: string): Promise<{ ok: true }> =>
    json(`api/sessions/${encodeURIComponent(id)}/version`, { method: 'PUT', body: JSON.stringify({ messageId }) }),
  setArchived: (id: string, archived: boolean): Promise<{ ok: true }> =>
    json('api/sessions/' + encodeURIComponent(id) + '/archive', { method: 'PUT', body: JSON.stringify({ archived }) }),
  setPinned: (id: string, pinned: boolean): Promise<{ ok: true }> =>
    json(`api/sessions/${encodeURIComponent(id)}/pin`, { method: 'PUT', body: JSON.stringify({ pinned }), signal: AbortSignal.timeout(15_000) }),
  renameSession: (id: string, title: string): Promise<{ title: string }> =>
    json(`api/sessions/${encodeURIComponent(id)}/title`, { method: 'PUT', body: JSON.stringify({ title }) }),
  /** R8.5:工作分支——优先选已注册 DSH 工作区(workspaceId);directory 仅用于"新建工作区"流程。 */
  createWorkBranch: (id: string, messageId: string, options: { workspaceId?: string; directory?: string }): Promise<{ sessionId: string }> =>
    json(`api/sessions/${encodeURIComponent(id)}/work-branch`, {
      method: 'POST', body: JSON.stringify({ messageId, confirmed: true, ...options }),
    }),
  /** R8.5:DSH 工作区清单(官方 workspaceRegistry 只读透传;parent 用于默认选中)。 */
  workBranchWorkspaces: (parent: string): Promise<{
    available: boolean
    reason?: string
    workspaces: { id: string; title?: string; path: string; sessions: number }[]
    parentWorkspaceId?: string
  }> => json(`api/workspaces?parent=${encodeURIComponent(parent)}`),
  deliverConclusion: (id: string, messageId: string): Promise<{ ok: true }> =>
    json(`api/sessions/${encodeURIComponent(id)}/deliver`, {
      method: 'POST', body: JSON.stringify({ messageId, confirmed: true }),
    }),
  getSessionPrefs: (id: string): Promise<SessionTurnPrefs> =>
    json(`api/sessions/${encodeURIComponent(id)}/prefs`),
  /** R8:会话内真实模型切换(Host 校验白名单 + 官方机制优先)。 */
  selectSessionModel: (id: string, selection: { channel: 'rich' | 'generic'; provider?: string; model: string; thinking: string }): Promise<{ ok: true; mechanism: 'official-agent' | 'session-prefs'; officialNote?: string }> =>
    json(`api/sessions/${encodeURIComponent(id)}/model`, { method: 'PUT', body: JSON.stringify(selection) }),
  deleteSession: (id: string): Promise<void> =>
    json(`api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(() => undefined),
  openSession: (id: string): Promise<{ ok: true }> =>
    json(`api/sessions/${encodeURIComponent(id)}/open`, { method: 'POST', body: '{}' }),
  stop: (sessionId: string): Promise<{ stopped: boolean }> =>
    json('api/stop', { method: 'POST', body: JSON.stringify({ sessionId }) }),
  uploadFile: async (sessionId: string, file: File): Promise<WireAttachment> => {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const response = await fetch(
      `api/files?sessionId=${encodeURIComponent(sessionId)}&name=${encodeURIComponent(file.name)}`,
      { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: bytes },
    )
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null
      throw new Error(body?.error?.message ?? response.statusText)
    }
    return (await response.json()) as WireAttachment
  },
  listAttachments: (sessionId: string): Promise<{ attachments: WireAttachment[] }> =>
    json(`api/files?sessionId=${encodeURIComponent(sessionId)}`),
  deleteAttachment: async (sessionId: string, id: string): Promise<void> => {
    const query = new URLSearchParams({ sessionId, id })
    const response = await fetch(`api/files?${query}`, { method: 'DELETE' })
    if (!response.ok && response.status !== 404) throw new Error(`移除附件失败（${response.status}）`)
  },
  localSearch: (query: string): Promise<LocalSearchResult> =>
    json('api/local-search', { method: 'POST', body: JSON.stringify({ query }) }),
  listPartitions: (): Promise<ChatPartitions> => json('api/partitions'),
  changePartition: (change: PartitionChange): Promise<ChatPartitions> =>
    json('api/partitions', { method: 'POST', body: JSON.stringify(change) }),
  sharing: async (light = false): Promise<SharingStatus> => {
    const response = await fetch('api/sharing' + (light ? '?view=light' : ''), { cache: 'no-store' })
    if (response.status === 404) return { enabled: false }
    if (!response.ok) throw new Error('Unable to load Data Sharing')
    return await response.json() as SharingStatus
  },
  sharingCommand: <T>(command: unknown): Promise<T> =>
    json('api/sharing', { method: 'POST', body: JSON.stringify(command) }),
  getSettings: (): Promise<WorkspaceSettings> => json('api/settings'),
  updateSettings: (patch: Partial<WorkspaceSettings>): Promise<WorkspaceSettings> =>
    json('api/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  localDirs: (): Promise<{ dirs: { id: string; path: string }[] }> => json('api/local-dirs'),
  // ── R8:提示词模板 ──
  listPrompts: (): Promise<{ templates: (PromptTemplate & { builtin?: boolean })[] }> => json('api/prompts'),
  createPrompt: (payload: Partial<PromptTemplate>): Promise<PromptTemplate> =>
    json('api/prompts', { method: 'POST', body: JSON.stringify(payload) }),
  updatePrompt: (id: string, payload: Partial<PromptTemplate>): Promise<PromptTemplate> =>
    json(`api/prompts/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deletePrompt: (id: string): Promise<void> =>
    json(`api/prompts/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(() => undefined),
  previewPromptVariables: (template: string, context: { model?: string; sessionTitle?: string; workspace?: string; selection?: string } = {}): Promise<PromptVariablePreview> => {
    const query = new URLSearchParams({ template, ...Object.fromEntries(Object.entries(context).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) })
    return json(`api/prompts/preview?${query}`)
  },
  // ── R8:上下文(dsh-context 官方投影) ──
  contextStatus: (sessionId: string): Promise<{
    available: boolean
    reason?: string
    sessionId?: string
    usage?: { system?: number; tools?: number; user?: number; inject?: number; skill?: number; assistant?: number; tool?: number; total?: number }
    contextWindow?: number
    ratio?: number
    nearLimit?: boolean
    requests?: readonly Record<string, unknown>[]
    recentEvents?: readonly Record<string, unknown>[]
  }> => json(`api/context?sessionId=${encodeURIComponent(sessionId)}`),
  // ── R8:费用(dsh-cost-meter 官方服务) ──
  costToday: (): Promise<{
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
    external?: { input?: number; output?: number; cached?: number; cacheWrite?: number; calls?: number; cost?: number }
    externalStale?: boolean
    budgetMerged?: { period?: string; cap?: number; used?: number; ratio?: number }
    richLedger?: { available: boolean; reason?: string; records24h: number }
    byProviderModel?: Record<string, unknown>
    budget?: { period?: string; cap?: number; used?: number; ratio?: number }
  }> => json('api/cost/today'),
  costSession: (sessionId: string): Promise<{ available: boolean; reason?: string; cost?: unknown }> =>
    json(`api/cost/session?sessionId=${encodeURIComponent(sessionId)}`),
  /** R8.6:逐消息 Rich 金额(价表+峰谷规则计算;幂等映射 messageId→USD)。 */
  costMessages: (sessionId: string): Promise<{ available: boolean; amounts?: Record<string, number> }> =>
    json(`api/cost/messages?sessionId=${encodeURIComponent(sessionId)}`),
  costEstimate: (sessionId: string, draftChars: number): Promise<{
    available: boolean
    reason?: string
    inputTokens?: number
    outputTokens?: [number, number]
    inputCost?: number
    totalEstimate?: [number, number]
    currency?: string
    cacheHitAssumption?: number
  }> => json('api/cost/estimate', { method: 'POST', body: JSON.stringify({ sessionId, draftChars }) }),
  // ── R8:插件与工具(官方注册表) ──
  listTools: (sessionId?: string): Promise<{
    tools: { name: string; description: string; parameters: unknown; registered: boolean; conditional: boolean; executable: false }[]
    authorizedTools: string[]
    sessionGrants: string[]
  }> => json(`api/tools${sessionId !== undefined ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`),
  invokeTool: (sessionId: string, name: string, args: unknown, confirmed: boolean): Promise<{ requiresConfirmation?: boolean; ok?: boolean; reason?: string; outcome?: unknown; durationMs?: number }> =>
    json('api/tools/invoke', { method: 'POST', body: JSON.stringify({ sessionId, name, args, confirmed }) }),
  setToolGrants: (sessionId: string, grants: string[]): Promise<{ ok: true }> =>
    json(`api/sessions/${encodeURIComponent(sessionId)}/tools`, { method: 'PUT', body: JSON.stringify({ grants }) }),
  // ── R8:前情提要/交接单 ──
  handover: (sessionId: string): Promise<{
    sessionId: string
    title: string
    goal: string
    completedTurns: number
    recentRequests: string[]
    files: string[]
    lastActivity: number
    messageCount: number
    text: string
  }> => json(`api/sessions/${encodeURIComponent(sessionId)}/handover`),
  // ── R8:历史导入导出(DeepChat v3 ZIP) ──
  exportSession: async (sessionId: string, filename: string, format: 'zip' | 'md' | 'json' = 'zip'): Promise<boolean> => {
    const response = await fetch(`api/sessions/${encodeURIComponent(sessionId)}/export?format=${format}`)
    return downloadResponse(response, filename)
  },
  downloadArchivedAttachment: async (sessionId: string, id: string, originalName: string): Promise<boolean> => {
    const params = new URLSearchParams({ sessionId, download: id })
    const extension = /\.(jpe?g|png|webp|gif|pdf|txt|md|csv|json|docx|xlsx|pptx)$/i.exec(originalName)?.[1]?.toLowerCase() ?? 'bin'
    return downloadResponse(await fetch(`api/files?${params}`), `webchat-attachment-${id}.${extension}`)
  },
  transcribe: async (audio: Blob, signal: AbortSignal, providerId?: string): Promise<string> => {
    const query = providerId ? '?' + new URLSearchParams({ provider: providerId }) : ''
    const response = await fetch('api/voice/transcribe' + query, { method: 'POST', body: audio, signal })
    const data = await response.json() as { text?: unknown; error?: { message?: string } }
    if (!response.ok || typeof data.text !== 'string') throw new Error(data.error?.message ?? '语音转写失败。')
    return data.text
  },
  exportSessions: async (ids?: string[]): Promise<boolean> => {
    const response = await fetch('api/export', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }),
    })
    return downloadResponse(response, 'webchat-history.zip')
  },
  importPreview: async (file: File): Promise<{ formatVersion: number; format: 'webchat' | 'v3' | 'json'; size: number; sessions: { index: number; id: string; title: string | null; messageCount: number; attachmentCount: number; retainedAttachmentCount: number; missingAttachmentCount: number; unsupportedFragmentCount: number; duplicate: boolean; insertedAt: string; updatedAt: string }[]; skipped: { path: string; reason: string }[] }> => {
    const response = await fetch('api/import', { method: 'POST', body: file })
    const data = await response.json().catch(() => null) as { error?: { message?: string } } | null
    if (!response.ok) throw new Error(data?.error?.message ?? `读取归档失败(${response.status})`)
    return data as never
  },
  importConfirm: async (file: File, indices: number[]): Promise<{ imported: { id: string; title: string | null; messageCount: number }[]; failures: { index: number; reason: string }[]; duplicates: number[] }> => {
    const response = await fetch(`api/import?confirm=1&select=${indices.join(',')}`, { method: 'POST', body: file })
    const data = await response.json().catch(() => null) as { imported?: { id: string; title: string | null; messageCount: number }[]; failures?: { index: number; reason: string }[]; duplicates?: number[]; error?: { message?: string } } | null
    if (!response.ok) throw new Error(data?.error?.message ?? `导入失败(${response.status})`)
    return { imported: data?.imported ?? [], failures: data?.failures ?? [], duplicates: data?.duplicates ?? [] }
  },
}


async function downloadResponse(response: Response, filename: string): Promise<boolean> {
  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: { message?: string } } | null
    throw new Error(data?.error?.message ?? `导出失败(${response.status})`)
  }
  return saveDownload(await response.blob(), filename)
}

export async function pickWorkBranchDirectory(): Promise<string | undefined> {
  if (location.protocol !== 'dsh-app:' || window.parent === window || location.pathname !== '/chat-workspace') {
    throw new Error('请在 DSH Desktop 主聊天中创建工作分支。')
  }
  const id = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener('message', receive)
      window.clearTimeout(timeout)
    }
    const receive = (event: MessageEvent) => {
      if (event.source !== window.parent || event.origin !== location.origin ||
          event.data?.type !== 'chatds:work-branch-directory-result' || event.data.id !== id) return
      cleanup()
      if (typeof event.data.error === 'string') reject(new Error(event.data.error))
      else resolve(typeof event.data.path === 'string' ? event.data.path : undefined)
    }
    const timeout = window.setTimeout(() => {
      cleanup()
      reject(new Error('等待选择工作目录超时。'))
    }, 300_000)
    window.addEventListener('message', receive)
    window.parent.postMessage({ type: 'chatds:pick-work-branch-directory', id }, location.origin)
  })
}

export async function saveDownload(blob: Blob, filename: string): Promise<boolean> {
  const mainDesktopPanel = location.protocol === 'dsh-app:' && window.parent !== window && location.pathname === '/chat-workspace'
  if (mainDesktopPanel) {
    const id = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        window.clearTimeout(timeout)
        window.removeEventListener('message', receive)
      }
      const receive = (event: MessageEvent) => {
        if (event.origin !== location.origin || event.source !== window.parent ||
            event.data?.type !== 'chatds:save-download-result' || event.data.id !== id) return
        cleanup()
        if (event.data.status === 'saved') resolve(true)
        else if (event.data.status === 'cancelled') resolve(false)
        else reject(new Error(event.data.error ?? '保存失败。'))
      }
      const timeout = window.setTimeout(() => {
        cleanup()
        reject(new Error('等待 Windows 保存文件超时。'))
      }, 300_000)
      window.addEventListener('message', receive)
      window.parent.postMessage({ type: 'chatds:save-download', id, blob, name: filename }, location.origin)
    })
  }
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
  return true
}
