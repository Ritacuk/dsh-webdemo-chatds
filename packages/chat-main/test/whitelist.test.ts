/**
 * R8 模型白名单测试 — 目录标记、白名单判定与禁用模型拒绝。
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { WorkspaceSettings } from '@dsh-chat/shared'
import { buildCatalog } from '../src/host/models.js'
import { WorkspaceStore, DEFAULT_SETTINGS } from '../src/host/store.js'

function fakeLlmCtx(): Context {
  const providers = [{ id: 'mock-provider', name: 'Mock Provider' }]
  const models: Record<string, { id: string; name: string }[]> = {
    'mock-provider': [{ id: 'mock-text', name: 'Mock Text' }],
  }
  return {
    llm: {
      listProviders: () => providers,
      listModels: async (provider: string) => models[provider] ?? [],
      resolveModelInfo: async () => ({ provider: 'mock-provider', id: 'mock-text', name: 'mock-text', inputModalities: ['text'] }),
    },
  } as never
}

describe('R8:模型白名单', () => {
  it('默认 modelScope=all,目录条目不带 enabled 标记', async () => {
    const catalog = await buildCatalog({ ctx: fakeLlmCtx(), richReady: true, richModels: [{ id: 'deepseek-flash', name: 'DeepSeek Flash', nativeSearch: true }] })
    expect(catalog.modelScope).toBe('all')
    expect(catalog.genericProviders[0]!.models[0]!.enabled).toBeUndefined()
  })

  it('modelAllowed:all 模式恒可用;whitelist 模式仅白名单内可用', async () => {
    const store = new WorkspaceStore({ get: () => undefined } as never, 'chat_workspace_test_wl')
    const tables = new Map<string, Map<string, Record<string, unknown>>>()
    const fakeDomain = {
      table: (name: string) => {
        if (!tables.has(name)) tables.set(name, new Map())
        const table = tables.get(name)!
        return {
          get: (key: string) => table.get(key),
          put: async (key: string, record: Record<string, unknown>) => { table.set(key, record) },
          delete: async (key: string) => { table.delete(key) },
          entries: () => [...table.entries()] as [string, Record<string, unknown>][],
        }
      },
      close: async () => undefined,
    }
    ;(store as unknown as { ensure: () => Promise<unknown> }).ensure = async () => fakeDomain

    const ref = { channel: 'generic' as const, provider: 'mock-provider', model: 'mock-text' }
    expect(await store.modelAllowed(ref)).toBe(true)

    await store.updateSettings({
      modelScope: 'whitelist',
      modelWhitelist: [{ channel: 'rich', model: 'deepseek-flash' }],
    })
    expect(await store.modelAllowed(ref)).toBe(false)
    expect(await store.modelAllowed({ channel: 'rich', model: 'deepseek-flash' })).toBe(true)
  })

  it('默认设置包含白名单/预算提醒字段(R8 新字段的兼容缺省)', () => {
    const settings: WorkspaceSettings = { ...DEFAULT_SETTINGS }
    expect(settings.modelScope).toBe('all')
    expect(settings.authorizedTools).toEqual([])
    expect(settings.budgetRemindersEnabled).toBe(true)
    expect(settings.budgetWarnThresholds).toEqual([0.5, 0.8, 1])
  })
})
