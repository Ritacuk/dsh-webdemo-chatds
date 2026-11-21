/**
 * 路由注册(P2)— 页面、静态资源与 API,全部经 ctx.webServer.register()(官方路由接口),
 * 用 ctx.effect 包裹由调用方释放;停用插件即摘路由。
 *
 * 鉴权:与官方 /api 网关同一道栅栏 —— ctx.connection.requestRejection(req)
 * (dsh-client-connection/src/rpc-host.ts;better-sidebar 的官方范本同款写法)。
 * 页面未认证时 303 到官方认证入口(authenticatedUrl);API 未认证一律 403。
 *
 * 静态资源缓存策略照抄官方 dsh-client-modules:HTML no-cache;版本化资产 immutable;
 * 其余 no-cache + 弱 ETag + 304。
 */

import { createReadStream, existsSync, statSync } from 'node:fs'
import { access, readFile, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
// Context 合并来源(connection 的 requestRejection 栅栏、webServer 路由)。
import type {} from '@deepseek-ai/dsh-client-connection'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type {
  ChatStreamFrame,
  LocalSearchResult,
  TurnRequest,
  WireAttachment,
  WireHealth,
  WireSession,
  WorkspaceSettings,
  WorkspaceMode,
  ModelChannel,
  ThinkingEffort,
} from '@dsh-chat/shared'
import { replayChatSession, WorkspaceSessionUnavailable } from './sessions.js'
import type { WorkspaceSessions } from './sessions.js'
import type { TurnRunner } from './turns.js'
import type { RichGateway } from './rich.js'
import { receiveUpload, wireAttachment, attachmentsDir, readStoredFile } from './files.js'
import { unlinkSync } from 'node:fs'
import type { LocalSearchEngine } from './local-search.js'
import type { WorkspaceStore } from './store.js'
import type { MainConfig } from './config.js'
import { pluginIntegrations } from './integrations.js'
import { buildCatalog } from './models.js'
import { prefsFromSession } from './prefs.js'
import { buildCommit, pluginVersion } from './version.js'
import { createWorkBranch, WorkBranchDirectoryRequired } from './agent-bridge.js'
import { planTools } from './read-only-plan.js'
import {
  ensureDefaultPrompts,
  markDefaultPromptDeleted,
  normalizePromptInput,
  resolveTemplateVariables,
  type PromptVariableContext,
} from './prompts.js'
import {
  contextStatus,
  costEstimate,
  costPriceCatalog,
  costSession,
  costToday,
  DSH_TOOL_APPROVAL_REQUIRED,
  listRegisteredTools,
} from './bridges.js'
import {
  archiveFingerprint,
  archivedSession,
  attachArchiveAssets,
  buildHandover,
  exportSessionZip,
  exportSessionsZip,
  readableMarkdown,
  handoverText,
  importParsedSession,
  parseArchive,
} from './archive.js'
import type { WireModelCatalog, WireModelEntry, PromptTemplate } from '@dsh-chat/shared'

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

export interface RouteDeps {
  config: MainConfig
  sessions: WorkspaceSessions
  turns: TurnRunner
  gateway: RichGateway
  search: LocalSearchEngine
  store: WorkspaceStore
  clientDist: string
  sidecar?: import('./sidecar-context.js').SidecarContext
}

/** 读取请求体(原始字节,带上限)。 */
async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > maxBytes) throw new Error('request body too large')
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

/** 读取请求体(JSON,带上限)。 */
async function readJsonBody(req: IncomingMessage, maxBytes = 1_048_576): Promise<unknown> {
  const raw = await readBody(req, maxBytes)
  const text = raw.toString('utf8')
  if (text.length === 0) return undefined
  return JSON.parse(text) as unknown
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
  res.end(JSON.stringify(body))
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: { message, status } })
}

/** SSE 写入器:每帧一行 JSON;周期性注释保活;结束时关流。 */
function openSse(res: ServerResponse): { emit: (frame: ChatStreamFrame) => void; close: () => void } {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  let closed = false
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': keep-alive\n\n')
  }, 15_000)
  return {
    emit: (frame) => {
      if (closed) return
      res.write(`data: ${JSON.stringify(frame)}\n\n`)
    },
    close: () => {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      res.end()
    },
  }
}

/** 注册全部路由;返回释放函数。 */
function sendDownload(res: ServerResponse, contentType: string, name: string, body: string | Buffer): void {
  res.writeHead(200, {
    'content-type': contentType, 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store',
  })
  res.end(body)
}

export function registerRoutes(ctx: Context, deps: RouteDeps): () => void {
  const pagePath = deps.config.pagePath.replace(/\/+$/, '')
  const apiPrefix = `${pagePath}/api`
  const assetsPrefix = `${pagePath}/assets`
  const disposers: (() => void)[] = []
  const register = (route: WebRoute) => ctx.webServer.register({
    ...route,
    handler: async (req, res) => {
      try {
        await route.handler(req, res)
      } catch (error) {
        if (!(error instanceof WorkspaceSessionUnavailable)) throw error
        sendJson(res, 409, { error: { message: error.message, status: 409, code: 'SESSION_UNAVAILABLE' } })
      }
    },
  })

  /** 官方栅栏:非可信请求(Host/Origin fence)一律 403。 */
  const fenced = (req: IncomingMessage): boolean =>
    ctx.connection.requestRejection(req) === undefined

  const guard = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (!fenced(req)) {
      sendError(res, 403, 'forbidden')
      return false
    }
    return true
  }

  /**
   * 页面守卫:未认证(无 dsh-auth cookie)时 303 跳转到官方认证入口
   * (connection.authenticatedUrl = 官方根路径 + 进程启动 token;官方在 '/' 完成
   * token→cookie 交换,与全新浏览器打开官方 SPA 的路径一致)。已认证直接放行。
   */
  const guardPage = (req: IncomingMessage, res: ServerResponse): boolean => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection === undefined) return true
    if (rejection === 401) {
      const origin = ctx.webServer.getOrigin()
      res.writeHead(303, { 'cache-control': 'no-store', location: ctx.connection.authenticatedUrl(origin) })
      res.end()
      return false
    }
    sendError(res, 403, 'forbidden')
    return false
  }

  if (deps.sidecar !== undefined) {
    const context = deps.sidecar
    disposers.push(register({
      kind: 'exact',
      path: `${apiPrefix}/parent`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const parent = new URL(req.url ?? '/', 'http://x').searchParams.get('id') ?? ''
        try {
          if (req.method === 'GET') {
            sendJson(res, 200, await context.describe(parent))
          } else if (req.method === 'POST') {
            const body = await readJsonBody(req, 4096) as { checkpoint?: unknown }
            sendJson(res, 200, await context.sync(parent, body?.checkpoint))
          } else {
            sendError(res, 405, 'method not allowed')
          }
        } catch (error) {
          if (error instanceof WorkspaceSessionUnavailable) throw error
          console.info('[ChatDS Sidecar]', error instanceof Error ? error.name : 'unknown error')
          sendError(res, 400, '无法访问父任务或选定的已完成检查点')
        }
      },
    }))
  }

  // ── 页面 HTML(注入 <base href="{pagePath}/">,使相对资源路径正确解析)──
  disposers.push(register({
    kind: 'exact',
    path: pagePath,
    handler: async (req, res) => {
      if (!guardPage(req, res)) return
      try {
        const raw = await readFile(join(deps.clientDist, 'index.html'), 'utf8')
        const baseTag = `<base href="${pagePath}/">`
        const html = /<head[^>]*>/i.test(raw)
          ? raw.replace(/<head[^>]*>/i, (match) => `${match}\n    ${baseTag}`)
          : `${baseTag}\n${raw}`
        res.writeHead(200, { 'content-type': MIME_BY_EXT['.html']!, 'cache-control': 'no-cache' })
        res.end(html)
      } catch {
        sendError(res, 500, 'chat workspace page assets are missing; reinstall the plugin')
      }
    },
  }))

  // ── 静态资源(产物在 client-dist/assets/ 下;前缀已剥掉 /assets,这里补回)──
  disposers.push(register({
    kind: 'prefix',
    path: assetsPrefix,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      const url = new URL(req.url ?? '/', 'http://x')
      const relative = decodeURIComponent(url.pathname.slice(assetsPrefix.length + 1))
      const assetsRoot = resolve(join(deps.clientDist, 'assets'))
      const target = resolve(assetsRoot, normalize(relative).replace(/^([/\\])+/, ''))
      if (!target.startsWith(assetsRoot + sep)) {
        sendError(res, 403, 'forbidden')
        return
      }
      if (!existsSync(target) || !statSync(target).isFile()) {
        sendError(res, 404, 'not found')
        return
      }
      const info = await stat(target)
      const etag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304)
        res.end()
        return
      }
      const ext = extname(target).toLowerCase()
      res.writeHead(200, {
        'content-type': MIME_BY_EXT[ext] ?? 'application/octet-stream',
        'cache-control': /-[A-Za-z0-9_-]{8,}\./.test(relative) ? 'public, max-age=31536000, immutable' : 'no-cache',
        etag,
      })
      createReadStream(target).pipe(res)
    },
  }))

  // ── 健康检查 ──
  disposers.push(register({
    kind: 'exact',
    path: `${apiPrefix}/health`,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      const health: WireHealth = {
        ok: true,
        plugin: 'dsh-webdemo-ChatDS',
        version: pluginVersion(),
        commit: buildCommit(),
      }
      sendJson(res, 200, health)
    },
  }))

  // ── 模型目录(P2-E:Rich + 通用 + 能力;R8:白名单标记)──
  disposers.push(register({
    kind: 'exact',
    path: `${apiPrefix}/models`,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      const readiness = await deps.gateway.readiness()
      const catalog: WireModelCatalog = await buildCatalog({
        ctx,
        richReady: readiness.ready,
        ...(readiness.reason !== undefined ? { richUnavailableReason: readiness.reason } : {}),
        richModels: deps.config.richModels,
      })
      // R8:白名单模式下为每个条目标注 enabled;列表本身不删条目,
      // 页面按 enabled 过滤选择器,同时能识别「当前模型已被禁用」。
      const settings = await deps.store.getSettings({})
      const scope = settings.modelScope
      catalog.modelScope = scope
      if (scope === 'whitelist') {
        const allowed = new Set(settings.modelWhitelist.map((ref) => `${ref.channel}:${ref.provider ?? ''}:${ref.model}`))
        const mark = (entry: WireModelEntry): WireModelEntry => ({
          ...entry,
          enabled: allowed.has(`${entry.channel}:${entry.provider ?? ''}:${entry.model}`),
        })
        catalog.richModels = catalog.richModels.map(mark)
        catalog.genericProviders = catalog.genericProviders.map((group) => ({
          ...group,
          models: group.models.map(mark),
        }))
      }
      sendJson(res, 200, catalog)
    },
  }))

  // ── 会话列表/创建 ──
  disposers.push(register({
    kind: 'exact',
    path: `${apiPrefix}/sessions`,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if (req.method === 'GET') {
        sendJson(res, 200, { sessions: await deps.sessions.list() })
        return
      }
      if (req.method === 'POST') {
        if (deps.sidecar !== undefined) {
          sendError(res, 400, '请先选择父任务检查点')
          return
        }
        const session = await deps.sessions.create()
        sendJson(res, 201, { id: session.id, title: '新对话' })
        return
      }
      sendError(res, 405, 'method not allowed')
    },
  }))

  // ── 单会话:读取/隐藏/恢复/偏好 ──
  // 注意:prefix 路由不得带尾斜杠 —— webServer 的子路径匹配是 `prefix + '/'`,
  // 带尾斜杠会变成 `sessions//` 永不匹配(V0 实测 404)。列表路由是 exact,优先命中。
  disposers.push(register({
    kind: 'prefix',
    path: `${apiPrefix}/sessions`,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      const url = new URL(req.url ?? '/', 'http://x')
      const rest = url.pathname.slice(`${apiPrefix}/sessions/`.length)
      const id = rest.split('/')[0] ?? ''
      if (!deps.sessions.owns(id)) {
        sendError(res, 404, 'not found')
        return
      }
      const action = rest.slice(id.length).replace(/^\//, '')
      if (action === 'tools') {
        if (!(await deps.sessions.liveSession(id))) {
          sendError(res, 404, 'session not found')
          return
        }
        if (req.method === 'GET') {
          const registry = ctx.get('tools' as never) as { schemas?(): { name: string; description?: string }[] } | undefined
          const granted = await deps.store.planGrants(id)
          sendJson(res, 200, {
            supported: planTools.map(({ name, description }) => ({ name, description, enabled: granted.includes(name) })),
            discovered: (registry?.schemas?.() ?? []).slice(0, 100).map(({ name, description }) => ({ name, description: (description ?? '').slice(0, 180) })),
          })
        } else if (req.method === 'PUT') {
          const body = await readJsonBody(req, 4096).catch(() => undefined) as { grants?: unknown } | undefined
          if (!Array.isArray(body?.grants) || !body.grants.every((key) => typeof key === 'string' && key.length > 0 && key.length <= 200)) {
            sendError(res, 400, 'grants must be an array of tool names')
            return
          }
          await deps.store.setPlanGrants(id, body.grants)
          sendJson(res, 200, { ok: true })
        } else {
          sendError(res, 405, 'method not allowed')
        }
        return
      }
      if (req.method === 'PUT' && action === 'version') {
        const body = await readJsonBody(req, 4096).catch(() => undefined) as { messageId?: unknown } | undefined
        if (typeof body?.messageId !== 'string' || deps.turns.isRunning(id)) {
          sendError(res, 400, '请在回复结束后切换消息版本')
        } else {
          try {
            if (await deps.sessions.selectVersion(id, body.messageId)) sendJson(res, 200, { ok: true })
            else sendError(res, 404, '消息版本不存在')
          } catch (error) {
            if ((await deps.store.getSettings({})).requestDiagnostics) {
              console.info('[WebChat branch]', error instanceof Error ? error.message : String(error))
            }
            sendError(res, 409, '无法保存选中的消息版本')
          }
        }
        return
      }
      if (req.method === 'PUT' && action === 'archive') {
        const body = await readJsonBody(req, 4096).catch(() => undefined) as { archived?: unknown } | undefined
        if (typeof body?.archived !== 'boolean') {
          sendError(res, 400, '归档状态无效')
        } else if (deps.turns.isRunning(id)) {
          sendError(res, 409, '请在当前回复结束后归档或恢复会话')
        } else if (await deps.sessions.setArchived(id, body.archived)) {
          sendJson(res, 200, { ok: true })
        } else {
          sendError(res, 404, '会话不存在')
        }
        return
      }
      if (req.method === 'PUT' && action === 'pin') {
        const body = await readJsonBody(req, 4096).catch(() => undefined) as { pinned?: unknown } | undefined
        if (typeof body?.pinned !== 'boolean' || deps.turns.isRunning(id)) {
          sendError(res, 400, '请在回复结束后变更置顶状态')
        } else if (await deps.sessions.setPinned(id, body.pinned)) {
          sendJson(res, 200, { ok: true })
        } else {
          sendError(res, 404, 'session not found')
        }
        return
      }
      if (req.method === 'POST' && (action === 'work-branch' || action === 'deliver')) {
        const body = await readJsonBody(req, 160 * 1024).catch(() => undefined) as { messageId?: unknown; confirmed?: unknown; directory?: unknown } | undefined
        if (body?.confirmed !== true || typeof body.messageId !== 'string' || deps.turns.isRunning(id)) {
          sendError(res, 400, '请选择已保存的消息并确认操作')
          return
        }
        try {
          if (action === 'deliver' && deps.sidecar !== undefined) {
            await deps.sidecar.deliver(id, body.messageId)
            sendJson(res, 200, { ok: true })
          } else if (action === 'work-branch') {
            const events = await deps.sessions.readEvents(id)
            if (events === undefined) throw new Error('Session unavailable')
            const directory = typeof body.directory === 'string' && body.directory.length <= 32_767 ? body.directory : undefined
            sendJson(res, 201, await createWorkBranch(ctx, id, events, body.messageId, directory))
          } else {
            sendError(res, 404, '操作不可用')
          }
        } catch (error) {
          if (error instanceof WorkBranchDirectoryRequired) {
            sendError(res, 400, error.message)
            return
          }
          console.info('[ChatDS Agent]', error instanceof Error ? error.name : 'unknown error')
          if ((await deps.store.getSettings({})).requestDiagnostics) {
            console.info('[WebChat Agent branch]', error instanceof Error ? error.message : String(error))
          }
          sendError(res, 409, '当前 Host 无法完成该 Agent 操作')
        }
        return
      }
      if (req.method === 'PUT' && action === 'title') {
        const body = await readJsonBody(req).catch(() => undefined) as { title?: unknown } | undefined
        const title = typeof body?.title === 'string' ? body.title.trim() : ''
        if (!title || title.length > 200) {
          sendError(res, 400, '会话标题须为 1 至 200 个字符')
        } else if (deps.turns.isRunning(id)) {
          sendError(res, 409, '请在当前回复结束后重命名')
        } else if (await deps.sessions.rename(id, title)) {
          sendJson(res, 200, { title })
        } else {
          sendError(res, 404, 'session not found')
        }
        return
      }
      if (req.method === 'GET' && action === '') {
        const events = await deps.sessions.readEvents(id)
        if (events === undefined) {
          sendError(res, 404, 'session not found')
          return
        }
        const summaries = await deps.sessions.list()
        const summary = summaries.find((s) => s.id === id)
        const session = await deps.sessions.liveSession(id)
        const settings = await deps.store.getSettings({})
        const mode = session !== undefined
          ? (await deps.store.sessionPrefs(session, {
              mode: settings.defaultMode,
              channel: 'rich',
              model: 'deepseek-flash',
              thinking: settings.defaultThinking,
              search: settings.defaultSearch,
              localSearch: settings.defaultLocalSearch,
            })).mode
          : settings.defaultMode
        const availableFiles = new Set((await deps.store.listAttachments(id)).map((record) => record.id))
        const replay = replayChatSession(events)
        const wire: WireSession = {
          versions: replay.versions,
          id,
          title: summary?.title ?? '新对话',
          createdAt: summary?.createdAt ?? (events[0]?.time ?? Date.now()),
          updatedAt: summary?.updatedAt ?? (events.at(-1)?.time ?? Date.now()),
          messages: replay.messages.map((message) => message.role === 'user'
            ? { ...message, files: message.files.filter((file) => file.unavailable || availableFiles.has(file.id)) }
            : message),
          mode,
        }
        sendJson(res, 200, wire)
        return
      }
      if (req.method === 'GET' && action === 'prefs') {
        const session = await deps.sessions.liveSession(id)
        if (session === undefined) {
          sendError(res, 404, 'session not found')
          return
        }
        const settings = await deps.store.getSettings({})
        const fallback = {
          mode: settings.defaultMode,
          channel: 'rich' as ModelChannel,
          model: 'deepseek-flash',
          thinking: settings.defaultThinking,
          search: settings.defaultSearch,
          localSearch: settings.defaultLocalSearch,
        }
        const prefs = await deps.store.sessionPrefs(session, fallback)
        sendJson(res, 200, prefs)
        return
      }
      // ── R8:会话归档导出(DeepChat v3 格式 ZIP;附件仅元数据)──
      if (req.method === 'GET' && action === 'export') {
        const events = await deps.sessions.readEvents(id)
        if (events === undefined) {
          sendError(res, 404, 'session not found')
          return
        }
        const summary = (await deps.sessions.list()).find((entry) => entry.id === id)
        const format = url.searchParams.get('format') ?? 'zip'
        const file = archivedSession(id, summary, events)
        if (format === 'md') {
          sendDownload(res, 'text/markdown; charset=utf-8', `webchat-${id}.md`, readableMarkdown(summary?.title ?? '聊天记录', events))
        } else if (format === 'json') {
          sendDownload(res, 'application/json', `webchat-${id}.json`, JSON.stringify(file, null, 2))
        } else if (format === 'zip') {
          try {
            const assets = new Map<string, Uint8Array>()
            attachArchiveAssets(file, await deps.store.listAttachments(id), assets)
            sendDownload(res, 'application/zip', `webchat-${id}.zip`, Buffer.from(exportSessionZip(file, assets)))
          } catch (error) {
            sendError(res, 400, error instanceof Error ? error.message : '导出失败。')
          }
        } else {
          sendError(res, 400, '导出格式不受支持。')
        }
        return
      }

      // ── R8:前情提要与交接单(确定性生成;不调用模型)──
      if (req.method === 'GET' && action === 'handover') {
        const events = await deps.sessions.readEvents(id)
        if (events === undefined) {
          sendError(res, 404, 'session not found')
          return
        }
        const summary = (await deps.sessions.list()).find((entry) => entry.id === id)
        const attachments = await deps.store.listAttachments(id)
        const handover = buildHandover(id, summary?.title ?? '未命名会话', events, attachments)
        sendJson(res, 200, { ...handover, text: handoverText(handover) })
        return
      }

      if (req.method === 'POST' && action === 'open') {
        const session = await deps.sessions.resume(id)
        if (session === undefined) {
          sendError(res, 404, 'session not found')
          return
        }
        sendJson(res, 200, { ok: true })
        return
      }
      // ── R8:会话内真实模型切换(官方机制优先,回退会话偏好记录)──
      if (req.method === 'PUT' && action === 'model') {
        const body = await readJsonBody(req, 8192).catch(() => undefined) as {
          channel?: unknown; provider?: unknown; model?: unknown; thinking?: unknown
        } | undefined
        const channel = body?.channel === 'generic' ? 'generic' : 'rich'
        const thinking = typeof body?.thinking === 'string' && isThinkingEffort(body.thinking) ? body.thinking : undefined
        const model = typeof body?.model === 'string' ? body.model : ''
        const provider = typeof body?.provider === 'string' ? body.provider : undefined
        if (model.length === 0 || model.length > 300) {
          sendError(res, 400, 'model id is required')
          return
        }
        const session = await deps.sessions.liveSession(id)
        if (session === undefined) {
          sendError(res, 404, 'session not found')
          return
        }
        // 白名单安全规则:禁用模型不落任何切换记录
        if (!(await deps.store.modelAllowed({ channel, provider, model }))) {
          sendError(res, 403, '该模型已被禁用。请在 ChatDS 设置 → 模型中重新启用,或改选其他模型。')
          return
        }
        const settings = await deps.store.getSettings({})
        const current = await deps.store.sessionPrefs(session, {
          mode: settings.defaultMode,
          channel: 'rich',
          model: 'deepseek-flash',
          thinking: settings.defaultThinking,
          search: settings.defaultSearch,
          localSearch: settings.defaultLocalSearch,
        })
        // 官方优先:sessionController.selectModel 绑定原生 Agent Session;chatws 会话
        // 无 Agent,记录失败原因后回退到会话偏好记录(request/header 在下一回合落盘)。
        let mechanism: 'official-agent' | 'session-prefs' = 'session-prefs'
        let officialNote: string | undefined
        const controller = ctx.get('sessionController' as never) as
          | { selectModel?: (request: { sessionId: string; provider: string; model: string; reasoningEffort?: string }) => Promise<unknown> }
          | undefined
        if (typeof controller?.selectModel === 'function') {
          const official = await controller.selectModel({
            sessionId: id,
            provider: channel === 'rich' ? 'deepseek-official' : provider ?? 'generic',
            model,
            ...(thinking !== undefined ? { reasoningEffort: thinking } : {}),
          }).then(() => true, (error: unknown) => {
            officialNote = error instanceof Error ? error.message : String(error)
            return false
          })
          if (official) mechanism = 'official-agent'
        }
        await deps.store.saveSessionPrefsCached(id, { ...current, channel, provider, model, thinking: thinking ?? current.thinking })
        sendJson(res, 200, { ok: true, mechanism, ...(officialNote !== undefined ? { officialNote } : {}) })
        return
      }
      if (req.method === 'DELETE' && action === '') {
        const removed = await deps.sessions.hide(id)
        if (!removed) {
          sendError(res, 404, 'session not found')
          return
        }
        res.writeHead(204)
        res.end()
        return
      }
      sendError(res, 405, 'method not allowed')
    },
  }))

  // ── 附件(P2-F):上传/列表/删除 ──
  disposers.push(register({
    kind: 'exact',
    path: `${apiPrefix}/files`,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      const url = new URL(req.url ?? '/', 'http://x')
      if (req.method === 'PUT') {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const name = url.searchParams.get('name') ?? ''
        if (!deps.sessions.owns(sessionId) || name.length === 0) {
          sendError(res, 400, 'sessionId and name are required')
          return
        }
        let bytes: Buffer
        try {
          bytes = await readBody(req, 64 * 1024 * 1024)
        } catch (error) {
          sendError(res, 413, error instanceof Error ? error.message : 'too large')
          return
        }
        const settings = await deps.store.getSettings({})
        const attachment = await receiveUpload({
          store: deps.store,
          sessionId,
          name,
          bytes: new Uint8Array(bytes),
          maxFileBytes: settings.maxFileBytes,
        })
        const wire: WireAttachment = attachment
        sendJson(res, 201, wire)
        return
      }
      if (req.method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        if (!deps.sessions.owns(sessionId)) {
          sendError(res, 400, 'sessionId is required')
          return
        }
        const archivedId = url.searchParams.get('download')
        if (archivedId) {
          const file = await deps.store.getAttachment(archivedId)
          if (!file?.archiveOnly || file.sessionId !== sessionId) {
            sendError(res, 404, '归档附件不存在。')
            return
          }
          try {
            sendDownload(res, 'application/octet-stream', 'webchat-attachment.bin', readStoredFile(file))
          } catch {
            sendError(res, 404, '本地归档附件不可用。')
          }
          return
        }
        sendJson(res, 200, { attachments: (await deps.store.listAttachments(sessionId)).filter((file) => !file.archiveOnly).map(wireAttachment) })
        return
      }
      if (req.method === 'DELETE') {
        const id = url.searchParams.get('id') ?? ''
        const record = await deps.store.getAttachment(id)
        if (record === undefined || record.sessionId !== url.searchParams.get('sessionId')) {
          sendError(res, 404, 'not found')
          return
        }
        if (deps.turns.isRunning(record.sessionId)) {
          sendError(res, 409, '请在当前回复结束后移除附件')
          return
        }
        await deps.store.deleteAttachment(id)
        try {
          if (record.storedPath.startsWith(attachmentsDir())) unlinkSync(record.storedPath)
        } catch {
          // 已不存在则忽略
        }
        res.writeHead(204)
        res.end()
        return
      }
      sendError(res, 405, 'method not allowed')
    },
  }))

  // ── 本地检索(P2-G;只读;白名单由 Host 强制)──
  disposers.push(register({
    kind: 'exact',
    path: `${apiPrefix}/local-search`,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if (req.method !== 'POST') {
        sendError(res, 405, 'method not allowed')
        return
      }
      let body: unknown
      try {
        body = await readJsonBody(req)
      } catch (error) {
        sendError(res, 400, error instanceof Error ? error.message : 'invalid body')
        return
      }
      const parsed = body as { query?: unknown; dirIds?: unknown; encoding?: unknown } | undefined
      const query = typeof parsed?.query === 'string' ? parsed.query : undefined
      if (query === undefined || query.trim().length === 0) {
        sendError(res, 400, 'query is required')
        return
      }
      const dirIds = Array.isArray(parsed?.dirIds) ? parsed.dirIds.filter((id): id is string => typeof id === 'string') : undefined
      if (parsed?.encoding !== undefined && parsed.encoding !== 'gb18030') {
        sendError(res, 400, 'encoding must be gb18030 when specified')
        return
      }
      const controller = new AbortController()
      res.once('close', () => controller.abort())
      const result: LocalSearchResult = await deps.search.search({ query, scopeDirIds: dirIds, encoding: parsed?.encoding, signal: controller.signal })
      if (controller.signal.aborted) return
      sendJson(res, 200, result)
    },
  }))

  // ── 授权目录列表(P2-G;页面展示用;路径白名单在 Host)──
  disposers.push(register({
    kind: 'exact',
    path: `${apiPrefix}/local-dirs`,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      sendJson(res, 200, { dirs: await deps.search.listDirs() })
    },
  }))

  disposers.push(register({
    kind: 'exact',
    path: `${apiPrefix}/file-access`,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if (req.method === 'GET') {
        const { authorizedDirs } = await deps.store.getSettings({})
        const dirs = await Promise.all(authorizedDirs.map(async (path) => ({
          path,
          available: await stat(path).then(async (entry) => {
            if (!entry.isDirectory()) return false
            await access(path, 4)
            return true
          }).catch(() => false),
        })))
        sendJson(res, 200, { dirs })
        return
      }
      if (req.method !== 'POST' && req.method !== 'DELETE') {
        sendError(res, 405, 'method not allowed')
        return
      }
      try {
        const body = await readJsonBody(req, 256 * 1024) as { path?: unknown } | null
        const path = body?.path
        if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('请选择一个绝对路径的文件夹。')
        const settings = await deps.store.editSettings(async ({ authorizedDirs }) => {
          if (req.method === 'DELETE') return { authorizedDirs: authorizedDirs.filter((entry) => entry !== path) }
          const canonical = await realpath(path)
          if (!(await stat(canonical)).isDirectory()) throw new Error('所选路径不是文件夹。')
          await access(canonical, 4)
          const compare = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
          const existing = await Promise.all(authorizedDirs.map((entry) => realpath(entry).catch(() => entry)))
          if (existing.some((entry) => compare(entry) === compare(canonical))) throw new Error('此文件夹已有访问权限。')
          if (authorizedDirs.length >= 16) throw new Error('最多授权 16 个文件夹。')
          return { authorizedDirs: [...authorizedDirs, canonical] }
        })
        sendJson(res, 200, settings)
      } catch (error) {
        sendError(res, 400, error instanceof Error ? error.message : '无法更新文件夹访问权限。')
      }
    },
  }))

  // ── 设置(P2-I)──
  disposers.push(register({
    kind: 'exact',
    path: `${apiPrefix}/settings`,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if (req.method === 'GET') {
        const settings: WorkspaceSettings = await deps.store.getSettings({})
        sendJson(res, 200, settings)
        return
      }
      if (req.method === 'PUT') {
        let body: unknown
        try {
          body = await readJsonBody(req)
        } catch (error) {
          sendError(res, 400, error instanceof Error ? error.message : 'invalid body')
          return
        }
        try {
          const patch = deps.store.validateSettings(body)
          if (patch.authorizedDirs !== undefined) {
            const previous = (await deps.store.getSettings({})).authorizedDirs
            patch.authorizedDirs = [...new Set(await Promise.all(patch.authorizedDirs.map(async (dir) => {
              if (previous.includes(dir)) return dir
              if (!isAbsolute(dir)) throw new Error('授权目录需要绝对路径')
              const canonical = await realpath(dir)
              if (!(await stat(canonical)).isDirectory()) throw new Error('所选路径不是目录')
              await access(canonical, 4)
              return canonical
            })))]
          }
          const settings = await deps.store.updateSettings(patch)
          sendJson(res, 200, settings)
        } catch (error) {
          sendError(res, 400, error instanceof Error ? error.message : 'invalid settings')
        }
        return
      }
      sendError(res, 405, 'method not allowed')
    },
  }))

  // ── R8:提示词模板(设置页与聊天输入框共用;Profile 隔离 KV)──
  disposers.push(register({
    kind: 'prefix',
    path: `${apiPrefix}/prompts`,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      const url = new URL(req.url ?? '/', 'http://x')
      const rest = url.pathname.slice(`${apiPrefix}/prompts/`.length)
      await ensureDefaultPrompts(deps.store)
      if (req.method === 'GET' && rest === '') {
        sendJson(res, 200, { templates: await deps.store.listPrompts() })
        return
      }
      if (req.method === 'GET' && rest === 'preview') {
        // 变量预览:确定性上下文在 Host 解析;selection 等页面侧变量由参数传入。
        const query = url.searchParams
        const template = query.get('template') ?? ''
        if (template.length === 0 || template.length > 40_000) {
          sendError(res, 400, 'template is required (max 40000 chars)')
          return
        }
        const context: PromptVariableContext = {
          date: new Date().toISOString().slice(0, 10),
          ...(typeof query.get('model') === 'string' ? { model: query.get('model') as string } : {}),
          ...(typeof query.get('sessionTitle') === 'string' ? { sessionTitle: query.get('sessionTitle') as string } : {}),
          ...(typeof query.get('workspace') === 'string' ? { workspace: query.get('workspace') as string } : {}),
          ...(typeof query.get('selection') === 'string' ? { selection: query.get('selection') as string } : {}),
        }
        sendJson(res, 200, resolveTemplateVariables(template, context))
        return
      }
      if (req.method === 'POST' && rest === '') {
        const body = await readJsonBody(req, 64 * 1024).catch(() => undefined) as Record<string, unknown> | undefined
        const patch = normalizePromptInput(body)
        if (patch === undefined || patch.name === undefined || patch.body === undefined) {
          sendError(res, 400, '模板需要 name 与 body 字段')
          return
        }
        const now = Date.now()
        const record: PromptTemplate & { builtin?: boolean } = {
          id: `tpl-${crypto.randomUUID().slice(0, 12)}`,
          name: patch.name,
          category: patch.category ?? '',
          summary: patch.summary ?? '',
          body: patch.body,
          tags: patch.tags ?? [],
          createdAt: now,
          updatedAt: now,
        }
        await deps.store.putPrompt(record)
        sendJson(res, 201, record)
        return
      }
      const id = rest.split('/')[0] ?? ''
      if (!/^tpl-[A-Za-z0-9-]{1,40}$/.test(id)) {
        sendError(res, 400, 'invalid template id')
        return
      }
      if (req.method === 'PUT' && rest === id) {
        const body = await readJsonBody(req, 64 * 1024).catch(() => undefined) as Record<string, unknown> | undefined
        const patch = normalizePromptInput(body)
        const existing = await deps.store.getPrompt(id)
        if (existing === undefined) {
          sendError(res, 404, 'template not found')
          return
        }
        if (patch === undefined) {
          sendError(res, 400, '模板载荷为空')
          return
        }
        const next: PromptTemplate & { builtin?: boolean } = {
          ...existing,
          ...patch,
          updatedAt: Date.now(),
        }
        await deps.store.putPrompt(next)
        sendJson(res, 200, next)
        return
      }
      if (req.method === 'DELETE' && rest === id) {
        const removed = await deps.store.deletePrompt(id)
        if (!removed) {
          sendError(res, 404, 'template not found')
          return
        }
        await markDefaultPromptDeleted(deps.store, id)
        res.writeHead(204)
        res.end()
        return
      }
      sendError(res, 405, 'method not allowed')
    },
  }))

  // ── R8:上下文状态(官方 sessionProjections 投影;dsh-context 提供)──
  disposers.push(register({
    kind: 'exact',
    path: `${apiPrefix}/context`,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      const sessionId = new URL(req.url ?? '/', 'http://x').searchParams.get('sessionId') ?? ''
      if (!deps.sessions.owns(sessionId)) {
        sendError(res, 400, 'sessionId is required')
        return
      }
      const session = await deps.sessions.liveSession(sessionId)
      if (session === undefined) {
        sendError(res, 404, 'session not found')
        return
      }
      sendJson(res, 200, contextStatus(ctx, session))
    },
  }))

  // ── R8:费用(官方 costMeter 服务;只读透传)──
  disposers.push(register({
    kind: 'prefix',
    path: `${apiPrefix}/cost`,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      const url = new URL(req.url ?? '/', 'http://x')
      const rest = url.pathname.slice(`${apiPrefix}/cost/`.length)
      if (req.method === 'GET' && rest === 'today') {
        sendJson(res, 200, await costToday(ctx))
        return
      }
      if (req.method === 'GET' && rest === 'session') {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        if (!deps.sessions.owns(sessionId)) {
          sendError(res, 400, 'sessionId is required')
          return
        }
        sendJson(res, 200, await costSession(ctx, sessionId))
        return
      }
      if (req.method === 'GET' && rest === 'prices') {
        sendJson(res, 200, await costPriceCatalog(ctx))
        return
      }
      if (req.method === 'POST' && rest === 'estimate') {
        const body = await readJsonBody(req, 4096).catch(() => undefined) as { sessionId?: unknown; draftChars?: unknown } | undefined
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        const draftChars = typeof body?.draftChars === 'number' && Number.isFinite(body.draftChars)
          ? Math.min(200_000, Math.max(0, Math.round(body.draftChars))) : 0
        if (!deps.sessions.owns(sessionId)) {
          sendError(res, 400, 'sessionId is required')
          return
        }
        const session = await deps.sessions.liveSession(sessionId)
        if (session === undefined) {
          sendError(res, 404, 'session not found')
          return
        }
        sendJson(res, 200, await costEstimate(ctx, session, draftChars))
        return
      }
      sendError(res, 405, 'method not allowed')
    },
  }))

  // ── R8:插件与工具(官方注册表;授权 = 全局 + 会话双重门)──
  disposers.push(register({
    kind: 'prefix',
    path: `${apiPrefix}/tools`,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      const url = new URL(req.url ?? '/', 'http://x')
      const rest = url.pathname.slice(`${apiPrefix}/tools/`.length)
      if (req.method === 'GET' && rest === '') {
        const sessionId = url.searchParams.get('sessionId')
        const settings = await deps.store.getSettings({})
        const sessionGrants = sessionId !== null && deps.sessions.owns(sessionId)
          ? await deps.store.planGrants(sessionId)
          : []
        sendJson(res, 200, {
          tools: listRegisteredTools(ctx),
          authorizedTools: settings.authorizedTools,
          sessionGrants,
          settingsSessionId: sessionId ?? undefined,
        })
        return
      }
      if (req.method === 'POST' && rest === 'invoke') {
        const body = await readJsonBody(req, 1024 * 1024).catch(() => undefined) as {
          sessionId?: unknown; name?: unknown; args?: unknown; confirmed?: unknown
        } | undefined
        const name = typeof body?.name === 'string' ? body.name : ''
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        if (!/^[\w.:-]{1,200}$/.test(name)) {
          sendError(res, 400, 'invalid tool name')
          return
        }
        if (!deps.sessions.owns(sessionId)) {
          sendError(res, 400, 'sessionId is required')
          return
        }
        if (!listRegisteredTools(ctx).some((tool) => tool.name === name)) {
          sendError(res, 404, '此工具未注册，提供该工具的插件可能已停用。')
          return
        }
        sendError(res, 403, DSH_TOOL_APPROVAL_REQUIRED)
        return
      }
      sendError(res, 405, 'method not allowed')
    },
  }))

  disposers.push(register({
    kind: 'exact',
    path: `${apiPrefix}/integrations`,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if (req.method !== 'GET') {
        sendError(res, 405, 'method not allowed')
        return
      }
      try {
        sendJson(res, 200, await pluginIntegrations(ctx))
      } catch {
        sendError(res, 503, '暂时无法读取 DSH 插件状态。')
      }
    },
  }))

  disposers.push(register({
    kind: 'exact',
    path: `${apiPrefix}/export`,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if (req.method !== 'POST') {
        sendError(res, 405, 'method not allowed')
        return
      }
      try {
        const body = await readJsonBody(req, 16384) as { ids?: unknown } | null
        if (body === null || typeof body !== 'object') throw new Error('请选择要导出的会话。')
        const summaries = await deps.sessions.list()
        const ids = body.ids
        if (ids !== undefined && (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string'))) {
          throw new Error('会话选择无效。')
        }
        const selected = ids === undefined ? summaries : [...new Set(ids as string[])].map((id) => {
          const found = summaries.find((summary) => summary.id === id)
          if (!found) throw new Error('所选会话已移除。')
          return found
        })
        if (!selected.length || selected.length > 200) throw new Error('请选择 1 至 200 个会话。')
        const files = []
        const assets = new Map<string, Uint8Array>()
        let size = 0
        for (const summary of selected) {
          const events = await deps.sessions.readEvents(summary.id)
          if (!events) throw new Error('无法读取会话 ' + summary.title)
          const file = archivedSession(summary.id, summary, events)
          size += Buffer.byteLength(JSON.stringify(file), 'utf8')
          if (size > 63 * 1024 * 1024) throw new Error('归档超过大小上限，请分批导出。')
          if (file.messages.length) {
            attachArchiveAssets(file, await deps.store.listAttachments(summary.id), assets)
            files.push(file)
          }
        }
        if (!files.length) throw new Error('所选会话没有可导出的消息。')
        sendDownload(res, 'application/zip', 'webchat-history.zip', Buffer.from(exportSessionsZip(files, assets)))
      } catch (error) {
        sendError(res, 400, error instanceof Error ? error.message : '导出失败。')
      }
    },
  }))

  let importQueue = Promise.resolve()

  // ── R8:历史归档导入(DeepChat v3 ZIP;先预览后确认,失败不留半条会话)──
  disposers.push(register({
    kind: 'exact',
    path: `${apiPrefix}/import`,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if (req.method !== 'POST') {
        sendError(res, 405, 'method not allowed')
        return
      }
      const url = new URL(req.url ?? '/', 'http://x')
      const confirm = url.searchParams.get('confirm') === '1'
      let bytes: Buffer
      try {
        bytes = await readBody(req, 64 * 1024 * 1024)
      } catch (error) {
        sendError(res, 413, error instanceof Error ? error.message : '归档过大')
        return
      }
      let parsed: Awaited<ReturnType<typeof parseArchive>>
      try {
        parsed = await parseArchive(new Uint8Array(bytes))
      } catch (error) {
        sendError(res, 400, error instanceof Error ? error.message : '无法识别的归档')
        return
      }
      if (!confirm) {
        const known = await deps.sessions.importFingerprints()
        sendJson(res, 200, { ...parsed.preview, sessions: parsed.preview.sessions.map((entry) => ({
          ...entry, duplicate: known.has(archiveFingerprint(parsed.sessions[entry.index]!)),
        })) })
        return
      }
      const selection = url.searchParams.get('select')
        ?.split(',').map((value) => Number(value)).filter((value) => Number.isInteger(value))
        ?? parsed.preview.sessions.map((entry) => entry.index)
      const imported: { id: string; title: string | null; messageCount: number }[] = []
      const failures: { index: number; reason: string }[] = []
      const duplicates: number[] = []
      const previousImport = importQueue
      let finishImport!: () => void
      importQueue = new Promise<void>((resolve) => { finishImport = resolve })
      await previousImport
      try {
        const known = await deps.sessions.importFingerprints()
        for (const index of new Set(selection)) {
        const parsedSession = parsed.sessions[index]
        if (parsedSession === undefined) continue
        const fingerprint = archiveFingerprint(parsedSession)
        if (known.has(fingerprint)) {
          duplicates.push(index)
          continue
        }
        try {
          const result = await importParsedSession(deps.sessions, parsedSession, deps.store)
          known.add(fingerprint)
          imported.push({ id: result.id, title: parsedSession.title, messageCount: result.messageCount })
        } catch (error) {
          const reason = error instanceof Error
            ? (error.cause instanceof Error ? `${error.message} < ${error.cause.message}` : error.message)
            : String(error)
          failures.push({ index, reason })
        }
      }
      } finally {
        finishImport()
      }
      sendJson(res, imported.length ? 201 : 200, { imported, failures, duplicates })
    },
  }))

  disposers.push(register({
    kind: 'exact',
    path: `${apiPrefix}/voice/transcribe`,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if (req.method !== 'POST') {
        sendError(res, 405, 'method not allowed')
        return
      }
      if (!(await deps.store.getSettings({})).enableVoiceInput) {
        sendError(res, 403, '请在 ChatDS 设置中启用语音输入。')
        return
      }
      const maximum = 44 + 120 * 16_000 * 2
      const bytes = await readBody(req, maximum).catch(() => null)
      if (!bytes || bytes.length <= 44 || bytes.toString('ascii', 0, 4) !== 'RIFF'
          || bytes.toString('ascii', 8, 16) !== 'WAVEfmt ' || bytes.toString('ascii', 36, 40) !== 'data'
          || bytes.readUInt16LE(20) !== 1 || bytes.readUInt16LE(22) !== 1 || bytes.readUInt32LE(24) !== 16_000
          || bytes.readUInt16LE(34) !== 16 || bytes.readUInt32LE(40) !== bytes.length - 44) {
        sendError(res, 400, '请录制 120 秒以内的单声道语音。')
        return
      }
      const controller = new AbortController()
      const cancel = () => controller.abort()
      res.once('close', cancel)
      try {
        const text = await deps.gateway.transcribe(new Uint8Array(bytes), AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]))
        sendJson(res, 200, { text })
      } catch (error) {
        if (!res.destroyed) sendError(res, 502, error instanceof Error ? error.message : '语音转写失败。')
      } finally {
        res.off('close', cancel)
      }
    },
  }))

  // ── 回合流(SSE)──
  disposers.push(register({
    kind: 'exact',
    path: `${apiPrefix}/turns`,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if (req.method !== 'POST') {
        sendError(res, 405, 'method not allowed')
        return
      }
      let body: unknown
      try {
        body = await readJsonBody(req)
      } catch (error) {
        sendError(res, 400, error instanceof Error ? error.message : 'invalid body')
        return
      }
      const request = body as Partial<TurnRequest> | undefined
      if (
        typeof request?.sessionId !== 'string' || !deps.sessions.owns(request.sessionId)
        || typeof request.content !== 'string'
        || (request.content.trim().length === 0 && !(Array.isArray(request.attachments) && request.attachments.length > 0) && request.edit === undefined)
        || (request.mode !== 'chat' && request.mode !== 'plan')
        || (request.channel !== 'rich' && request.channel !== 'generic')
        || !isThinkingEffort(request.thinking)
      ) {
        sendError(res, 400, 'sessionId, content, mode(chat|plan), channel(rich|generic) and thinking are required')
        return
      }
      const normalized: TurnRequest = {
        sessionId: request.sessionId,
        locale: request.locale === 'en-US' ? 'en-US' : 'zh-CN',
        timeZone: typeof request.timeZone === 'string' && request.timeZone.length <= 100 ? request.timeZone : undefined,
        content: request.content,
        mode: request.mode as WorkspaceMode,
        channel: request.channel as ModelChannel,
        model: typeof request.model === 'string' ? request.model : undefined,
        provider: typeof request.provider === 'string' ? request.provider : undefined,
        genericModel: typeof request.genericModel === 'string' ? request.genericModel : undefined,
        thinking: request.thinking as ThinkingEffort,
        search: request.search === true,
        attachments: Array.isArray(request.attachments)
          ? request.attachments.filter((id): id is string => typeof id === 'string')
          : [],
        allowAttachmentUpload: request.allowAttachmentUpload === true,
        localSearch: request.localSearch === true,
      }
      const edit = (request as { edit?: unknown }).edit as { action?: unknown; targetMessageId?: unknown } | undefined
      if (edit !== undefined) {
        if (
          (edit.action !== 'edit' && edit.action !== 'regenerate' && edit.action !== 'continue')
          || typeof edit.targetMessageId !== 'string' || edit.targetMessageId.length === 0
        ) {
          sendError(res, 400, 'edit.action must be edit|regenerate|continue with a targetMessageId')
          return
        }
        normalized.edit = { action: edit.action, targetMessageId: edit.targetMessageId }
      }
      const sse = openSse(res)
      const disconnect = new AbortController()
      res.once('close', () => disconnect.abort())
      const emit = sse.emit
      try {
        await deps.turns.runTurn({
          sessionId: normalized.sessionId,
          request: normalized,
          emit,
          disconnected: () => disconnect.signal.aborted,
          disconnectSignal: disconnect.signal,
        })
      } catch (error) {
        emit({ type: 'error', error: error instanceof WorkspaceSessionUnavailable
          ? { kind: 'protocol', message: error.message, code: 'SESSION_UNAVAILABLE' }
          : { kind: 'protocol', message: 'Host 未能完成或保存该回合', code: 'TURN_HOST_FAILURE' } })
      } finally {
        sse.close()
      }
    },
  }))

  // ── 停止生成 ──
  disposers.push(register({
    kind: 'exact',
    path: `${apiPrefix}/stop`,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if (req.method !== 'POST') {
        sendError(res, 405, 'method not allowed')
        return
      }
      let body: unknown
      try {
        body = await readJsonBody(req)
      } catch (error) {
        sendError(res, 400, error instanceof Error ? error.message : 'invalid body')
        return
      }
      const sessionId = (body as { sessionId?: unknown } | undefined)?.sessionId
      if (typeof sessionId !== 'string') {
        sendError(res, 400, 'sessionId is required')
        return
      }
      const stopped = deps.turns.stop(sessionId)
      sendJson(res, stopped ? 200 : 409, { stopped })
    },
  }))

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        // 释放失败不阻断其余释放
      }
    }
  }
}

function isThinkingEffort(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value)
}
