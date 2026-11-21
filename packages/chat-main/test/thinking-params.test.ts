/**
 * P2-C/D 测试 — 思考与搜索参数的真实请求体捕获(Mock fetch)。
 * 任务书 P2-C:"必须通过 Mock 请求检查实际发出的参数,而不是只看 UI 开关。"
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { RichGateway } from '../src/host/rich.js'
import { missingAnswer, resolveThinking } from '../src/host/turns.js'
import type { MainConfig } from '../src/host/config.js'

const config: MainConfig = {
  pagePath: '/chat-workspace',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  baseURL: 'https://api.example.com',
  thinking: 'enabled',
  search: true,
  title: true,
  richModels: [
    { id: 'deepseek-flash', name: 'DeepSeek Flash', nativeSearch: true },
  ],
}

/** 假 ctx:credentials.resolve 返回测试 key;不读取真实凭证。 */
function fakeCtx() {
  return {
    get(name: string) {
      if (name === 'credentials') {
        return {
          resolve: async () => ({ value: 'sk-test-key', source: 'test' }),
        }
      }
      return undefined
    },
  } as never
}

interface CapturedRequest {
  url: string
  init: RequestInit
}

/** 捕获 fetch 并回放一段最小 SSE 流。 */
function captureFetch(): { requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} })
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"r","model":"deepseek-flash"}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":5,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":2}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      '',
    ].join('\n')
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }))
  return { requests }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

it('区分搜索失败、无正文、部分失败后有效答复与拒绝', () => {
  const failed = { type: 'web_search_tool_result', kind: 'search', tool_use_id: 'search',
    content: [{ type: 'web_search_tool_result_error', error_code: 'unavailable' }] } as const
  const block = { ...failed, content: [...failed.content] }
  expect(missingAnswer([block], true, 'end_turn')?.code).toBe('SEARCH_NO_FINAL_ANSWER')
  expect(missingAnswer([{ ...block, content: [] }], true, 'end_turn')?.code).toBe('SEARCH_EMPTY_REPLY')
  expect(missingAnswer([block, { type: 'text', text: '有效答复' }], true, 'end_turn')).toBeUndefined()
  expect(missingAnswer([], false, 'refusal')?.code).toBe('REFUSAL')
  expect(missingAnswer([], false, 'end_turn')?.code).toBe('EMPTY_REPLY')
})

const minimalBody = {
  model: 'deepseek-flash',
  system: '该助手为DeepSeek，由深度求索公司创造。',
  messages: [{ role: 'user', content: '你好' }],
  safety_check: { level: 'high' },
  tools: [{ type: 'deepseek_read_url', name: 'deepseek_read_url' }],
}

describe('P2-C:实际发出的请求参数(Mock fetch 捕获)', () => {
  it('思考关闭:thinking.type === "disabled",且参数完整(safety_check/system/model)', async () => {
    const { requests } = captureFetch()
    const gateway = new RichGateway(fakeCtx(), config)
    const events = []
    for await (const event of gateway.stream({ ...minimalBody, thinking: { type: 'disabled' } }, new AbortController().signal)) {
      events.push(event)
    }
    expect(events.at(-1)?.type).toBe('message_stop')
    expect(requests).toHaveLength(1)
    const body = JSON.parse(String(requests[0]!.init.body)) as Record<string, unknown>
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.safety_check).toEqual({ level: 'high' })
    expect(body.system).toBe('该助手为DeepSeek，由深度求索公司创造。')
    expect(body.model).toBe('deepseek-flash')
    // 认证头由 Host 注入,浏览器不可见
    expect((requests[0]!.init.headers as Record<string, string>)['x-api-key']).toBe('sk-test-key')
  })

  it('思考开启:thinking.type === "enabled"', async () => {
    const { requests } = captureFetch()
    const gateway = new RichGateway(fakeCtx(), config)
    for await (const _ of gateway.stream({ ...minimalBody, thinking: { type: 'enabled' } }, new AbortController().signal)) {
      void _
    }
    const body = JSON.parse(String(requests[0]!.init.body)) as Record<string, unknown>
    expect(body.thinking).toEqual({ type: 'enabled' })
  })

  it('搜索关闭:tools 只有 deepseek_read_url;搜索开启:追加 deepseek_web_search', async () => {
    const { requests } = captureFetch()
    const gateway = new RichGateway(fakeCtx(), config)
    for await (const _ of gateway.stream({ ...minimalBody, tools: [{ type: 'deepseek_read_url', name: 'deepseek_read_url' }] }, new AbortController().signal)) {
      void _
    }
    const off = JSON.parse(String(requests[0]!.init.body)) as { tools: { name: string }[] }
    expect(off.tools.map((tool) => tool.name)).toEqual(['deepseek_read_url'])
    for await (const _ of gateway.stream({ ...minimalBody, tools: [{ type: 'deepseek_read_url', name: 'deepseek_read_url' }, { type: 'deepseek_web_search', name: 'deepseek_web_search' }] }, new AbortController().signal)) {
      void _
    }
    const on = JSON.parse(String(requests[1]!.init.body)) as { tools: { name: string }[] }
    expect(on.tools.map((tool) => tool.name)).toEqual(['deepseek_read_url', 'deepseek_web_search'])
  })

  it('P2-D:URL 阅读(read_url)与主动搜索(web_search)是独立声明,关闭搜索时 URL 阅读仍恒开', async () => {
    const { requests } = captureFetch()
    const gateway = new RichGateway(fakeCtx(), config)
    for await (const _ of gateway.stream({ ...minimalBody, tools: [{ type: 'deepseek_read_url', name: 'deepseek_read_url' }] }, new AbortController().signal)) {
      void _
    }
    const body = JSON.parse(String(requests[0]!.init.body)) as { tools: { type: string; name: string }[] }
    expect(body.tools).toContainEqual({ type: 'deepseek_read_url', name: 'deepseek_read_url' })
    expect(body.tools).not.toContainEqual({ type: 'deepseek_web_search', name: 'deepseek_web_search' })
  })
})

describe('P2-C:思考档位解析(不静默升降档)', () => {
  it('Rich 通路:off/enabled 直通;low/high/max 按"开启"执行并说明(协议只有两态)', () => {
    expect(resolveThinking('off', 'rich')).toMatchObject({ thinking: 'off', richEnabled: false })
    const enabled = resolveThinking('enabled', 'rich')
    expect(enabled).toMatchObject({ thinking: 'enabled', richEnabled: true })
    expect(enabled.note).toBeUndefined()
    const raised = resolveThinking('max', 'rich')
    expect(raised).toMatchObject({ thinking: 'enabled', richEnabled: true })
    expect(raised.note).toContain('开/关两态')
  })

  it('通用通路显式传递 off，并拒绝适配器未声明的档位', () => {
    const reasoning = { defaultEffort: 'high', efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }] }
    expect(resolveThinking('high', 'generic', reasoning)).toMatchObject({ thinking: 'high', genericEffort: 'high' })
    expect(resolveThinking('off', 'generic', reasoning)).toMatchObject({ thinking: 'off', genericEffort: 'off' })
    expect(resolveThinking('off', 'generic', { ...reasoning, efforts: reasoning.efforts.slice(1) })).toMatchObject({ unsupported: true })
    expect(resolveThinking('high', 'generic')).toMatchObject({ unsupported: true })
  })
})
