import { ChatDSSessionBridge } from './session-bridge.js'
/**
 * dsh-chat-workspace-main — 独立聊天工作区主组件(Cordis 插件)。
 *
 * 集成面(P0 审计核实的官方接口):
 * - 路由: ctx.webServer.register()(dsh-host-webserver/src/index.ts:445),
 *   全部用 ctx.effect 包裹,插件停用即注销(cordis fiber 语义)。
 * - 鉴权: ctx.connection.requestRejection(req)(dsh-client-connection/src/rpc-host.ts),
 *   与官方 /api 网关同一道 Host/Origin 栅栏;永不向浏览器返回凭证。
 * - 会话: ctx.sessions(dsh-session)+ ctx.sessionPersistence(dsh-session-persistence)
 *   + 官方 JSONL 后端(dsh-session-persistence-jsonl,由 dsh-base 挂载)。
 * - 凭证: resolveDeepSeekApiKey(dsh-llm-deepseek/src/credential.ts:15)→ ctx.credentials。
 * - 模型: Rich 直连(P2 专用适配器)+ ctx.llm 通用通路(P2-E 双通路)。
 * - 设置: 插件行 Config(schemastery 官方配置表单)+ KV 运行时默认(chat_workspace 域)。
 *
 * 生命周期:本插件不创建线程、不注册系统服务;停用即释放路由、监听、写句柄与流式请求。
 */

import type { Context } from '@deepseek-ai/cordis'
import { fileURLToPath } from 'node:url'
import type { SharingWorkspace } from './sharing/workspace.js'
import { ChatPartitionStore } from './partitions.js'
import { registerRoutes } from './routes.js'
import { WorkspaceSessions } from './sessions.js'
import { WorkspaceStore } from './store.js'
import { TurnRunner } from './turns.js'
import { RichGateway } from './rich.js'
import { RichUsageLedger } from './rich-ledger.js'
import { LocalSearchEngine } from './local-search.js'
import type { MainConfig } from './config.js'
import { Config } from './config.js'
import type { WorkspaceSettings } from '@dsh-chat/shared'
import { SidecarContext } from './sidecar-context.js'

/** Stable Cordis plugin name。 */
export const name = 'chat-workspace-main'

/**
 * Cordis 服务注入声明(V0 实测补):运行时按 fiber.inject 校验服务访问,
 * 未声明的 `ctx.X` 会抛 `cannot get property "X" without inject` 并中止激活。
 * 可选服务(如 sessionProjections)不在此列,走 `ctx.get(name)` 免注入读取。
 */
export const inject = [
  'webServer',
  'connection',
  'sessions',
  'sessionPersistence',
  'llm',
  'credentials',
  'storageDomain',
  'sessionProjections',
] as const

export { Config }
export type { MainConfig }

/** 解析随包发布的页面静态资源目录(client-dist)。 */
export function resolveClientDist(): string {
  const relative = import.meta.url.endsWith('.ts') ? '../../client-dist' : '../client-dist'
  return fileURLToPath(new URL(relative, import.meta.url))
}

/**
 * 挂载聊天工作区。
 * @param ctx - 插件上下文(webServer/connection/sessions/sessionPersistence/llm/credentials/storageDomain 可用)。
 * @param config - 校验后的行配置。
 */
export function apply(ctx: Context, config: MainConfig): void {
  mountWorkspace(ctx, config, false)
}

export function mountWorkspace(ctx: Context, config: MainConfig, sidecar: boolean): void {
  const store = new WorkspaceStore(ctx, sidecar ? 'chat_workspace_sidecar' : undefined)
  const sessions = new WorkspaceSessions(ctx, store, sidecar)
  const gateway = new RichGateway(ctx, config)
  // R8.5:Rich 用量 → cost-meter 外部用量账本(仅主实例;旁聊回合也经此入账)。
  const ledger = sidecar ? undefined : new RichUsageLedger(ctx)
  // 行 Config 的 P1 字段映射为运行时默认(P2-I 部署级默认;KV 可覆盖)。
  const rowDefaults: Partial<WorkspaceSettings> = {
    defaultThinking: config.thinking === 'enabled' ? 'enabled' : 'off',
    defaultSearch: config.search,
  }
  const search = new LocalSearchEngine(async () => (await store.getSettings(rowDefaults)).authorizedDirs)
  const partitions = sidecar ? undefined : new ChatPartitionStore(store, sessions)
  const bridge = partitions ? new ChatDSSessionBridge(ctx, store, sessions, partitions) : undefined
  if (bridge) ctx.provide('chatdsSessionBridge', bridge)
  const turns = new TurnRunner(ctx, sessions, store, gateway, search, async () => ({ requestDiagnostics: (await store.getSettings(rowDefaults)).requestDiagnostics }), ledger, bridge)

  if (partitions) ctx.provide('chatdsSharingWorkspace', { sessions, partitions, turns, pagePath: config.pagePath } satisfies SharingWorkspace)

  // 路由注册 + 会话监听全部折进一个 effect:停用/重载时按注册的逆序释放,
  // 并 flush + close 全部写句柄与 KV 域(持久性屏障在卸载路径上同样成立)。
  ctx.effect(() => {
    const disposeRoutes = registerRoutes(ctx, {
      config,
      partitions,
      sessions,
      turns,
      gateway,
      search,
      store,
      ledger,
      bridge,
      clientDist: resolveClientDist(),
      sidecar: sidecar ? new SidecarContext(ctx, sessions, turns) : undefined,
    })
    return async () => {
      disposeRoutes()
      await turns.dispose()
      await bridge?.dispose()
      await sessions.disposeAll()
      await ledger?.dispose()
      await store.close()
    }
  }, 'chat-workspace-main.mount')
}
