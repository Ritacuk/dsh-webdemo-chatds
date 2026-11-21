/**
 * dsh-chat-workspace-sidecar — Agent 执行上下文旁聊(侧聊)组件。
 *
 * P1 边界(任务书第十节):本包与 chat-workspace-main 是两个独立可管理的插件节点,
 * 共享 @dsh-chat/shared 协议核心但不依赖 main 的运行实例。本阶段交付:
 * 1. 独立的 Cordis 插件节点(独立 install/enable/disable/卸载);
 * 2. 生命周期接口:ctx.effect 管理的全部注册/释放(本阶段只有服务声明与配置校验);
 * 3. 接入边界:SidecarService 的形状 + reservedPath 占有声明(未来阶段在
 *    该前缀下注册自己的路由,不与 main 的 /chat-workspace 冲突)。
 *
 * 明确不做(未经验证的功能一律不假装完成):
 * - 不注册任何 HTTP 路由或页面;
 * - 不发起任何模型请求;
 * - 不创建/读取任何 Session;
 * - 不读取凭证。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Stable Cordis plugin name。 */
export const name = 'chat-workspace-sidecar'

export interface SidecarConfig {
  /** 未来旁聊页面/路由的独立前缀(本阶段仅声明占有)。 */
  reservedPath: string
}

export const Config: z<SidecarConfig> = z.object({
  reservedPath: z.string().pattern(/^\/[A-Za-z0-9._-]+$/).default('/chat-workspace-sidecar'),
}) as z<SidecarConfig>

/**
 * 旁聊服务(P1 形状)。未来阶段在此接口上扩展:
 * - `attachAgent(sessionId)` — 绑定一个 Agent 执行上下文;
 * - `route()` — 在 reservedPath 下注册独立页面;
 * - 与 main 相同的 Rich 通路(经 @dsh-chat/shared)。
 */
export interface SidecarService {
  readonly reservedPath: string
  /** P1 恒为 'boundary' — 标识该节点当前只承载接入边界。 */
  readonly stage: 'boundary'
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    chatWorkspaceSidecar?: SidecarService
  }
}

/**
 * 挂载旁聊组件边界。
 * @param ctx - 插件上下文。
 * @param config - 校验后的行配置。
 */
export function apply(ctx: Context, config: SidecarConfig): void {
  const service: SidecarService = {
    reservedPath: config.reservedPath,
    stage: 'boundary',
  }
  // 服务随插件 fiber 释放(禁用/卸载时一并消失),无全局监听、无路由、无 IO。
  ctx.effect(() => {
    ctx.provide('chatWorkspaceSidecar', service)
    return () => undefined
  }, 'chat-workspace-sidecar.boundary')
}
