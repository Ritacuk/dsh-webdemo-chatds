import type { Context } from '@deepseek-ai/cordis'
import { Config, type MainConfig } from './config.js'
import { inject, mountWorkspace } from './index.js'

export { Config, inject }
export const name = 'chatds-agent-side-chat'

export function apply(ctx: Context, config: MainConfig): void {
  if (config.pagePath === '/chat-workspace') throw new Error('ChatDS Side Chat must have a separate page path')
  mountWorkspace(ctx, config, true)
}
