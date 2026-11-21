/**
 * 会话偏好恢复 — 从 Session 日志的 plugin:chat-workspace/settings 记录读取(权威)。
 */

import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionTurnPrefs } from '@dsh-chat/shared'

/** 从会话日志恢复最近一次会话偏好;无记录时返回 fallback。 */
export function prefsFromSession(session: Session, fallback: SessionTurnPrefs): SessionTurnPrefs {
  const events = session.snapshotEvents(SessionLogOffset(0)) as unknown as { type: string; data?: unknown }[]
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type === 'plugin:chat-workspace/settings') {
      const data = event.data as Record<string, unknown>
      return {
        mode: data.mode === 'plan' ? 'plan' : 'chat',
        channel: data.channel === 'generic' ? 'generic' : 'rich',
        provider: typeof data.provider === 'string' ? data.provider : undefined,
        model: typeof data.model === 'string' ? data.model : fallback.model,
        thinking: normalizeThinking(data.thinking, fallback.thinking),
        search: data.search === true,
        localSearch: data.localSearch === true,
      }
    }
  }
  return fallback
}

function normalizeThinking(value: unknown, fallback: SessionTurnPrefs['thinking']): SessionTurnPrefs['thinking'] {
  if (typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value)) {
    return value
  }
  return fallback
}
