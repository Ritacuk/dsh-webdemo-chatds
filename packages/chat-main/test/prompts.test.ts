/**
 * R8 提示词系统测试 — 全局附加提示词注入、模板变量解析、默认模板种子化。
 */

import { describe, expect, it } from 'vitest'
import {
  BASE_SYSTEM_PROMPT,
  effectiveSystemPrompt,
  normalizePromptInput,
  resolveTemplateVariables,
  ensureDefaultPrompts,
  markDefaultPromptDeleted,
  PROMPT_VARIABLES,
} from '../src/host/prompts.js'
import { WorkspaceStore } from '../src/host/store.js'

describe('R8:全局附加提示词', () => {
  it('关闭时只包含 demo 身份指令(不追加任何内容)', () => {
    const prompt = effectiveSystemPrompt({ globalPromptEnabled: true, globalPromptText: '' })
    const disabled = effectiveSystemPrompt({ globalPromptEnabled: false, globalPromptText: '用户指令' })
    expect(prompt).toBe(BASE_SYSTEM_PROMPT)
    expect(disabled).toBe(BASE_SYSTEM_PROMPT)
  })

  it('启用时追加在身份指令之后(追加方式,不覆盖)', () => {
    const prompt = effectiveSystemPrompt({ globalPromptEnabled: true, globalPromptText: '  始终用中文回答。  ' })
    expect(prompt.startsWith(BASE_SYSTEM_PROMPT)).toBe(true)
    expect(prompt).toBe(`${BASE_SYSTEM_PROMPT}\n\n始终用中文回答。`)
  })
})

describe('R8:模板变量解析', () => {
  it('解析已提供变量并保留未解析变量(不静默删除)', () => {
    const preview = resolveTemplateVariables('今天是 {{date}},模型 {{model}},会话 {{sessionTitle}}。', {
      date: '2026-11-20',
      model: 'deepseek-flash',
    })
    expect(preview.resolved).toBe('今天是 2026-11-20,模型 deepseek-flash,会话 {{sessionTitle}}。')
    const unresolved = preview.variables.filter((variable) => !variable.resolved)
    expect(unresolved.map((variable) => variable.name)).toEqual(['sessionTitle'])
  })

  it('变量声明集合完整(页面与 Host 端一致)', () => {
    expect(PROMPT_VARIABLES).toEqual(['date', 'model', 'sessionTitle', 'workspace', 'selection'])
  })

  it('同一变量只上报一次', () => {
    const preview = resolveTemplateVariables('{{date}} {{date}}', { date: '2026-11-20' })
    expect(preview.variables).toHaveLength(1)
  })
})

describe('R8:模板载荷校验', () => {
  it('丢弃非法字段;路由层要求 name 与 body 同时存在', () => {
    // 空名称被丢弃 → patch.name undefined → 路由层拒绝
    expect(normalizePromptInput({ name: '', body: 'x' })?.name).toBeUndefined()
    expect(normalizePromptInput({ name: 'x', body: '  ' })?.body).toBeUndefined()
    const ok = normalizePromptInput({ name: '  译名  ', body: '正文', category: ' 语言 ', tags: ['a', '', 'b'] })
    expect(ok).toMatchObject({ name: '译名', category: '语言', tags: ['a', 'b'] })
    expect(normalizePromptInput(null)).toBeUndefined()
  })
})

describe('R8:默认模板种子化(删除后不复活)', () => {
  it('首次访问种子化 6 个默认模板;删除后再访问不复活', async () => {
    const store = new WorkspaceStore({ get: () => undefined } as never, 'chat_workspace_test_prompts')
    // 直接操作内存域假件:replace ensure() 返回的域(测试不依赖真实 storageDomain)
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

    await ensureDefaultPrompts(store)
    let list = await store.listPrompts()
    expect(list.length).toBe(6)
    expect(list.every((template) => template.builtin === true)).toBe(true)

    await markDefaultPromptDeleted(store, 'tpl-translation')
    await store.deletePrompt('tpl-translation')
    await ensureDefaultPrompts(store)
    list = await store.listPrompts()
    expect(list.length).toBe(5)
    expect(list.some((template) => template.id === 'tpl-translation')).toBe(false)
  })
})
