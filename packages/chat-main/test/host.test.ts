/**
 * Host 侧可独立测试的部分:端点解析与事件→页面模型映射。
 * (需要 DSH 运行时的集成路径在隔离 Profile 验收时覆盖,见 docs/acceptance.md。)
 */

import { describe, expect, it } from 'vitest'
import { resolveEndpoint, type MainConfig } from '../src/host/config.js'
import { eventsToWireMessages, type RichReplayResponse } from '../src/host/sessions.js'

const baseConfig: MainConfig = {
  pagePath: '/chat-workspace',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  baseURL: '',
  thinking: 'enabled',
  search: true,
  title: true,
}

describe('resolveEndpoint', () => {
  it('默认回退官方 API', () => {
    const result = resolveEndpoint(baseConfig, {})
    expect(result.origin).toBe('https://api.deepseek.com')
    expect(result.source).toBe('official-api')
  })

  it('config.baseURL 优先,兼容带 /anthropic 后缀的官方写法', () => {
    expect(resolveEndpoint({ ...baseConfig, baseURL: 'https://api.example.com/anthropic' }, {}).origin)
      .toBe('https://api.example.com')
    expect(resolveEndpoint({ ...baseConfig, baseURL: 'https://api.example.com' }, {}).origin)
      .toBe('https://api.example.com')
  })

  it('DEEPSEEK_BASE_URL 作为第二候选;非法 URL 被跳过', () => {
    expect(resolveEndpoint(baseConfig, { DEEPSEEK_BASE_URL: 'http://127.0.0.1:9999' }).origin)
      .toBe('http://127.0.0.1:9999')
    expect(resolveEndpoint({ ...baseConfig, baseURL: '::::' }, { DEEPSEEK_BASE_URL: 'https://fallback.example' }).origin)
      .toBe('https://fallback.example')
  })
})

describe('eventsToWireMessages', () => {
  it('user/message 与 assistant/message 映射为 demo 模型;finish.replayState 提供终态', () => {
    const replay: { response: RichReplayResponse } = {
      response: {
        stopReason: 'end_turn',
        usage: { input_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 3, output_tokens: 40 },
      },
    }
    const events = [
      {
        type: 'user/message', seq: 0, time: 100, surfaceOp: 'append' as const,
        data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } },
      },
      {
        type: 'assistant/message', seq: 1, time: 200, surfaceOp: 'append' as const,
        data: {
          turn: 1, step: 0,
          message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '回答' }], source: { kind: 'model', provider: 'deepseek-rich', model: 'deepseek-flash' } },
          stream: [{ type: 'chunk', time: 300, chunk: { type: 'finish', reason: { kind: 'stop' }, replayState: replay } }],
        },
      },
    ]
    const messages = eventsToWireMessages(events as never)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ id: 'u1', role: 'user', content: '你好' })
    expect(messages[1]).toMatchObject({
      id: 'a1', role: 'assistant', status: 'done', stopReason: 'end_turn',
    })
    expect(messages[1]!.blocks[0]).toMatchObject({ type: 'text', text: '回答' })
    expect(messages[1]!.usage).toMatchObject({ input_tokens: 12, output_tokens: 40 })
  })

  it('interrupted:true 映射为 stopped 状态(恢复被中止的会话)', () => {
    const events = [
      {
        type: 'assistant/message', seq: 0, time: 1, surfaceOp: 'append' as const,
        data: {
          turn: 1, step: 0, interrupted: true,
          message: { id: 'a2', role: 'assistant', content: [], source: { kind: 'model', provider: 'deepseek-rich', model: 'deepseek-flash' } },
          stream: [],
        },
      },
    ]
    const messages = eventsToWireMessages(events as never)
    expect(messages[0]).toMatchObject({ id: 'a2', status: 'stopped' })
  })
})
