/**
 * @dsh-chat/shared — DSH Chat Workspace 共享协议核心。
 * 供 chat-workspace-main(Host + 页面)与 chat-workspace-sidecar(未来)复用;
 * 不依赖任一组件的运行实例,也不依赖 DSH 运行时(纯 TS,Node 20+/浏览器皆可)。
 * @module @dsh-chat/shared
 */

export * from './protocol/types.js'
export * from './protocol/sse.js'
export * from './protocol/parse-event.js'
export * from './protocol/client.js'
export * from './chat/types.js'
export * from './chat/reply.js'
export * from './dsh/session-mapping.js'
export * from './dsh/wire.js'
export * from './dsh/partitions.js'
export * from './dsh/sharing.js'
