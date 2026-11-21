/**
 * P2-E 模型测试 — 目录能力映射(官方声明驱动)、通用通路 StreamChunk 翻译。
 */

import { describe, expect, it } from 'vitest'
import { buildCatalog, type RichCatalogModel } from '../src/host/models.js'
import { translateGenericChunks, usageToWire } from '../src/host/generic.js'
import type { Context } from '@deepseek-ai/cordis'
import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'

/** 假 ctx.llm(官方接口形状):mock provider + 一个支持思考的模型 + 一个文本模型。 */
function fakeLlmCtx(): Context {
  const providers = [{ id: 'mock-provider', name: 'Mock Provider' }]
  const models: Record<string, { id: string; name: string }[]> = {
    'mock-provider': [{ id: 'mock-reasoning', name: 'Mock Reasoning' }, { id: 'mock-text', name: 'Mock Text' }],
  }
  const resolve = (model: string) =>
    model === 'mock-reasoning'
      ? {
          provider: 'mock-provider',
          id: model,
          name: model,
          reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
          inputModalities: ['text'],
        }
      : { provider: 'mock-provider', id: model, name: model, inputModalities: ['text'] }
  return {
    llm: {
      listProviders: () => providers,
      listModels: async (provider: string) => models[provider] ?? [],
      resolveModelInfo: async (_provider: string, model: string) => resolve(model),
    },
  } as never
}

describe('P2-E:模型目录与能力检测', () => {
  it('Rich 条目:能力为 demo 已验证事实(思考开/关、原生搜索、流式、用量、结构化)', async () => {
    const richModels: RichCatalogModel[] = [{ id: 'deepseek-flash', name: 'DeepSeek Flash', nativeSearch: true }]
    const catalog = await buildCatalog({ ctx: fakeLlmCtx(), richReady: true, richModels })
    expect(catalog.richReady).toBe(true)
    expect(catalog.richModels).toHaveLength(1)
    const capability = catalog.richModels[0]!.capability
    expect(capability).toMatchObject({
      chat: true, thinking: true, vision: false, nativeSearch: true,
      streaming: true, usage: true, structured: true,
    })
    expect(capability.thinkingEfforts).toEqual(['off', 'enabled'])
    expect(capability.fileInput).toContain('local-inline')
    expect(capability.fileInput).toContain('cloud-files-api')
  })

  it('通用条目:能力来自 resolveModelInfo 官方声明(思考档位/视觉)', async () => {
    const catalog = await buildCatalog({ ctx: fakeLlmCtx(), richReady: false, richModels: [] })
    expect(catalog.genericProviders).toHaveLength(1)
    const entries = catalog.genericProviders[0]!.models
    const reasoning = entries.find((entry) => entry.model === 'mock-reasoning')!
    const text = entries.find((entry) => entry.model === 'mock-text')!
    expect(reasoning.capability.thinking).toBe(true)
    expect(reasoning.capability.thinkingEfforts).toEqual(['off', 'low', 'high'])
    expect(reasoning.capability.nativeSearch).toBe(false)
    expect(text.capability.thinking).toBe(false)
    expect(text.capability.thinkingEfforts).toEqual(['off'])
    expect(text.capability.vision).toBe(false)
  })

  it('ctx.llm 不可用时不阻塞目录(Rich 仍可用)', async () => {
    const catalog = await buildCatalog({ ctx: {} as Context, richReady: true, richModels: [{ id: 'deepseek-flash', name: 'Flash', nativeSearch: true }] })
    expect(catalog.richModels).toHaveLength(1)
    expect(catalog.genericProviders).toHaveLength(0)
  })
})

describe('P2-E:通用通路 StreamChunk → Rich 事件翻译', () => {
  async function collect(chunks: StreamChunk[]) {
    const out = []
    for await (const event of translateGenericChunks(chunks)) {
      out.push(event.rich)
    }
    return out
  }

  it('文本块:content_block_start/delta/stop + message_delta + message_stop', async () => {
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '你好' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '你好' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const events = await collect(chunks)
    expect(events.map((event) => event.type)).toEqual([
      'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop',
    ])
    expect(events[0]).toMatchObject({ content_block: { type: 'text' } })
    expect(events[1]).toMatchObject({ delta: { type: 'text_delta', text: '你好' } })
    expect(events[3]).toMatchObject({ delta: { stop_reason: 'end_turn' } })
  })

  it('思考块:reasoning-delta 翻译为 thinking_delta(页面复用同一合并层)', async () => {
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: '想一想' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: '想一想' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const events = await collect(chunks)
    expect(events[1]).toMatchObject({ delta: { type: 'thinking_delta', thinking: '想一想' } })
  })

  it('usage 块 → message_delta 用量(缓存命中口径分离)', async () => {
    const usage: TokenUsage = { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 2 }
    const events = await collect([{ type: 'usage', usage }, { type: 'finish', reason: { kind: 'stop' } }])
    expect(events[0]).toMatchObject({
      usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
    })
    expect(usageToWire(usage).input_tokens).toBe(10)
  })

  it('finish(error) 抛出(与 Rich 通路 error 帧语义一致)', async () => {
    await expect(collect([
      { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'X' } } },
    ])).rejects.toThrow('boom')
  })

  it('流在 finish 前结束 → 抛 interrupted 语义错误', async () => {
    await expect(collect([
      { type: 'block-start', index: 0, blockType: 'text' },
    ])).rejects.toThrow('ended before finish')
  })
})
