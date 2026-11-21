/**
 * Rich 协议可靠性测试 — 对应任务书第七节的 14 个场景。
 * 全部使用可复现的模拟 SSE 字节流,不依赖真实 API。
 */

import { describe, expect, it, vi } from 'vitest'
import { ServerSentEventDecoder, readServerSentEvents } from '../src/protocol/sse.js'
import { readMessageEvent } from '../src/protocol/parse-event.js'
import {
  applyEvent, settleReply, getReplyText, canContinueReply, toRequestMessages,
} from '../src/chat/reply.js'
import { replyBlocksToDshContent, dshContentToReplyBlocks } from '../src/dsh/session-mapping.js'
import { streamMessage, streamFromResponse, ApiError } from '../src/protocol/client.js'
import type { AssistantMessage, Message, UserMessage } from '../src/chat/types.js'

const encoder = new TextEncoder()

/** 把文本切片数组装成字节流;支持注入 Uint8Array 与 {abort} 模拟中断 */
function mockStream(chunks: (string | Uint8Array | { abort: Error })[]): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close()
        return
      }
      const item = chunks[i++]!
      if (item instanceof Uint8Array) {
        controller.enqueue(item)
      } else if (typeof item === 'string') {
        controller.enqueue(encoder.encode(item))
      } else {
        controller.error(item.abort)
      }
    },
  })
}

const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

it('keeps streaming an answer and citations after one URL read fails', () => {
  const readFailed = {
    type: 'web_fetch_tool_result',
    tool_use_id: 'srvtoolu_page',
    content: { type: 'web_fetch_tool_result_error', error_code: 'url_not_accessible' },
    kind: 'deep_search',
  }
  const extra = [
    sse('content_block_start', { type: 'content_block_start', index: 3, content_block: readFailed }),
    sse('content_block_stop', { type: 'content_block_stop', index: 3 }),
  ].join('')
  const textStart = 'event: content_block_start\ndata: {"type":"content_block_start","index":4,'
  const wire = fullTurnStream().replaceAll('"index":3', '"index":4')
  const reply = consumeEvents(wire.replace(textStart, extra + textStart))
  expect(reply.blocks).toContainEqual(expect.objectContaining(readFailed))
  expect(reply.blocks.find((block) => block.type === 'web_fetch_tool_result')).not.toHaveProperty('signature')
  expect(reply.blocks).toContainEqual(expect.objectContaining({
    type: 'text',
    citations: [expect.objectContaining({ url: 'https://a.example/x' })],
  }))
  expect(reply.stopReason).toBe('end_turn')
})

/** 组装一条流式 SSE 全序列(思考 + 搜索 + 引用正文) */
function fullTurnStream(stopReason: 'end_turn' | 'refusal' = 'end_turn'): string {
  const delta = stopReason === 'refusal'
    ? { type: 'message_delta', delta: { stop_reason: 'refusal', stop_sequence: null, stop_details: { type: 'refusal', category: null, explanation: null } } }
    : { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 4, output_tokens: 42, server_tool_use: { web_search_requests: 1, tool_search: 0 } } }
  return [
    sse('message_start', { type: 'message_start', message: { id: 'r1', model: 'deepseek-v4-pro', usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } } }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '想一' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '想二' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-abc' } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'deepseek_web_search', input: { action: 'search', queries: ['q1', 'q2'] }, caller: { type: 'direct' }, kind: 'search' } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 1 }),
    sse('content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', title: 'T1', url: 'https://a.example/x', snippet: 's', site_icon: null, site_name: 'A', encrypted_content: 'e', page_age: null }], kind: 'search' } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 2 }),
    sse('content_block_start', { type: 'content_block_start', index: 3, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: '答案' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 3, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: 'https://a.example/x', title: 'T1', cited_text: '答', encrypted_index: '' } } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: '继续' } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 3 }),
    sse('message_delta', delta),
    sse('message_stop', { type: 'message_stop' }),
  ].join('')
}

/** 逐事件跑完 applyEvent(模拟合并循环)并收尾 */
function consumeEvents(text: string): AssistantMessage {
  const decoder = new ServerSentEventDecoder()
  let reply: AssistantMessage = {
    id: 'reply-1', role: 'assistant', createdAt: 1, model: 'deepseek-v4-pro',
    prefix: true, status: 'pending', blocks: [],
  }
  const blockIndexes = new Map<number, number>()
  for (const ev of decoder.push(text)) {
    const parsed = readMessageEvent(JSON.parse(ev.data))
    if (parsed) reply = applyEvent(reply, parsed, 100, blockIndexes)
  }
  return settleReply(reply, 'done', 200)
}

function mkUser(content: string, id = 'u'): UserMessage {
  return { id, role: 'user', content, files: [], createdAt: 1 }
}

function mkAssistant(blocks: AssistantMessage['blocks'], id: string, stopReason: AssistantMessage['stopReason'] = 'end_turn'): AssistantMessage {
  return { id, role: 'assistant', createdAt: 2, model: 'deepseek-flash', prefix: true, status: 'done', blocks, stopReason }
}

describe('SSE 解码器边界(WHATWG)', () => {
  it('场景2/3:事件跨多个 push(分包);一次 push 携带多个事件', () => {
    const decoder = new ServerSentEventDecoder()
    const whole = sse('ping', { type: 'ping' })
    expect(decoder.push(whole.slice(0, 10))).toEqual([]) // 半个事件不派发
    const events = decoder.push(whole.slice(10))
    expect(events).toHaveLength(1)
    expect(events[0]!.event).toBe('ping')
    // 两个完整事件在一次 push 中全部派发
    const two = sse('message_stop', { type: 'message_stop' }) + sse('ping', { type: 'ping' })
    expect(decoder.push(two)).toHaveLength(2)
  })

  it('场景4:保活注释、空行、无效 JSON 帧不影响后续事件', () => {
    const decoder = new ServerSentEventDecoder()
    const text = ': keep-alive\n\n' + sse('message_stop', { type: 'message_stop' }) + '\n\n'
    const events = decoder.push(text)
    expect(events).toHaveLength(1)
    expect(events[0]!.event).toBe('message_stop')
    // 无 data 字段的空事件组不派发
    expect(decoder.push('event: x\n\n')).toEqual([])
  })

  it('CRLF 与孤立 CR 的处理符合规范', () => {
    const decoder = new ServerSentEventDecoder()
    // 结尾 CR 可能是 CRLF 前半,等待下一段
    expect(decoder.push('data: 1\r')).toEqual([])
    expect(decoder.push('\ndata: 2\r\n\n')).toHaveLength(1)
    // 孤立 CR 在 push 阶段等待(CRLF 二义性);end() 把它按换行处理,
    // 但未以空行结尾的事件按 WHATWG 规范丢弃(demo 注释同义)
    expect(decoder.push('data: 3\r')).toEqual([])
    expect(decoder.end()).toEqual([])
    expect(decoder.end()).toEqual([]) // end 后无残留
  })
})

describe('场景1:UTF-8 多字节字符拆分在多个网络块中', () => {
  it('中文字符跨块不乱码', async () => {
    const text = sse('content_block_delta', { type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: '深度求索' } })
    const bytes = encoder.encode(text)
    const events = await collect(readServerSentEvents(mockStream([
      bytes.slice(0, bytes.length - 6),
      bytes.slice(bytes.length - 6),
    ])))
    const parsed = readMessageEvent(JSON.parse(events[0]!.data))
    expect(parsed).toMatchObject({ delta: { type: 'text_delta', text: '深度求索' } })
  })
})

describe('场景5:正文与思考交错', () => {
  it('交错增量分别落到正确块,索引映射不串块', () => {
    const text = [
      sse('message_start', { type: 'message_start', message: { id: 'r', model: 'deepseek-flash' } }),
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      sse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '思' } }),
      sse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '文' } }),
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '考' } }),
      sse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '字' } }),
      sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
      sse('content_block_stop', { type: 'content_block_stop', index: 1 }),
      sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } }),
      sse('message_stop', { type: 'message_stop' }),
    ].join('')
    const reply = consumeEvents(text)
    expect(reply.blocks).toHaveLength(2)
    expect(reply.blocks[0]).toMatchObject({ type: 'thinking', thinking: '思考' })
    expect(reply.blocks[1]).toMatchObject({ type: 'text', text: '文字' })
  })
})

describe('场景6:多个搜索步骤与结果配对', () => {
  it('多轮调用结果按协议顺序保存,tool_use_id 保留供配对', () => {
    const mkSearch = (i: number) => [
      sse('content_block_start', { type: 'content_block_start', index: i * 2, content_block: { type: 'server_tool_use', id: `srvtoolu_${i}`, name: 'deepseek_web_search', input: { action: 'search', queries: [`q${i}`] }, caller: { type: 'direct' }, kind: 'search' } }),
      sse('content_block_stop', { type: 'content_block_stop', index: i * 2 }),
      sse('content_block_start', { type: 'content_block_start', index: i * 2 + 1, content_block: { type: 'web_search_tool_result', tool_use_id: `srvtoolu_${i}`, content: [{ type: 'web_search_result', title: `T${i}`, url: `https://x/${i}`, snippet: 's', site_icon: null, site_name: null, encrypted_content: 'e', page_age: null }], kind: 'search' } }),
      sse('content_block_stop', { type: 'content_block_stop', index: i * 2 + 1 }),
    ].join('')
    const text = [
      sse('message_start', { type: 'message_start', message: { id: 'r', model: 'deepseek-flash' } }),
      mkSearch(1), mkSearch(2), mkSearch(3),
      sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } }),
      sse('message_stop', { type: 'message_stop' }),
    ].join('')
    const reply = consumeEvents(text)
    const calls = reply.blocks.filter((b) => b.type === 'server_tool_use')
    const results = reply.blocks.filter((b) => b.type === 'web_search_tool_result')
    expect(calls).toHaveLength(3)
    expect(results).toHaveLength(3)
    expect(results.map((r) => (r as { tool_use_id: string }).tool_use_id))
      .toEqual(['srvtoolu_1', 'srvtoolu_2', 'srvtoolu_3'])
  })
})

describe('场景7/8:citations_delta 关联与 signature_delta 保存', () => {
  it('引用挂到发生引用的文本块,签名完整保留在思考块', () => {
    const reply = consumeEvents(fullTurnStream())
    const thinking = reply.blocks.find((b) => b.type === 'thinking') as { signature?: string }
    expect(thinking?.signature).toBe('sig-abc')
    const text = reply.blocks.find((b) => b.type === 'text') as { text: string; citations?: unknown[] }
    expect(text.text).toBe('答案继续')
    expect(text.citations).toHaveLength(1)
    expect((text.citations![0] as { url: string }).url).toBe('https://a.example/x')
  })
})

describe('场景9:正常 message_stop 与用量', () => {
  it('done 状态,stop_reason 与最终用量齐备', () => {
    const reply = consumeEvents(fullTurnStream())
    expect(reply.status).toBe('done')
    expect(reply.stopReason).toBe('end_turn')
    expect(reply.usage).toMatchObject({ input_tokens: 10, output_tokens: 42, cache_read_input_tokens: 4 })
  })
})

describe('场景10:流意外中断', () => {
  it('message_stop 之前流结束 → streamMessage 抛 interrupted', async () => {
    const head = fullTurnStream().split(sse('message_stop', { type: 'message_stop' }))[0]!
    await expect(collectStream([head])).rejects.toMatchObject({ kind: 'interrupted' })
  })

  it('stopReason 已知但流断开:合并层保留内容,由调用方按已收到内容收尾(demo 语义)', () => {
    const head = fullTurnStream().split(sse('message_stop', { type: 'message_stop' }))[0]!
    const reply = consumeEvents(head) // 合并层不抛错
    expect(reply.stopReason).toBe('end_turn')
    expect(getReplyText(reply)).not.toBe('')
  })

  it('底层连接错误按 demo 语义原样透传(由调用方映射种类)', async () => {
    await expect(collectStream(['event: message_start\ndata: {"type":"message_start","message":{"id":"r","model":"m"}}\n\n', { abort: new Error('boom') }]))
      .rejects.toThrow('boom')
  })
})

describe('场景11:用户主动取消', () => {
  it('AbortController 取消后 reader 释放,迭代器及时结束', async () => {
    const controller = new AbortController()
    let cancelled = false
    let pullCount = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pullCount++
        if (pullCount === 1) {
          c.enqueue(encoder.encode(sse('message_start', { type: 'message_start', message: { id: 'r', model: 'm' } })))
        } else {
          return new Promise(() => {}) // 慢流:不 close,等取消
        }
      },
      cancel() {
        cancelled = true
      },
    })
    const iterator = readServerSentEvents(stream, controller.signal)[Symbol.asyncIterator]()
    await iterator.next()
    const pending = iterator.next()
    setTimeout(() => controller.abort(), 10)
    const result = await pending
    expect(result.done).toBe(true) // abort → reader.cancel → 流关闭,pending read 以 done 结束
    expect(cancelled).toBe(true)
    expect(pullCount).toBe(2)
  })
})

describe('场景12:服务端拒绝与失败', () => {
  it('refusal 停止原因:思考与正文块被丢弃,工具块保留,且不进上下文', () => {
    const reply = consumeEvents(fullTurnStream('refusal'))
    expect(reply.stopReason).toBe('refusal')
    expect(reply.blocks.some((b) => b.type === 'thinking' || b.type === 'text')).toBe(false)
    expect(reply.blocks.some((b) => b.type === 'server_tool_use')).toBe(true)
    // refusal 轮在上下文回传中被整轮排除
    const user = mkUser('q')
    const messages = toRequestMessages([user, reply], mkUser('q2'))
    expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(0)
  })

  it('流中 error 帧 → ApiError(stream)', async () => {
    const text = sse('error', { error: { message: 'quota exceeded', type: 'rate_limit' } })
    await expect(collectStream([text])).rejects.toBeInstanceOf(ApiError)
    await expect(collectStream([text])).rejects.toMatchObject({ kind: 'stream', message: 'quota exceeded' })
  })

  it('非 2xx 响应:错误体解析为 http 错误', async () => {
    const response = new Response(JSON.stringify({ error: { message: 'auth failed' } }), { status: 401 })
    vi.stubGlobal('fetch', vi.fn(async () => response))
    try {
      await expect(collect(streamMessage('key', 'https://api.example.com', minimalRequest(), new AbortController().signal)))
        .rejects.toMatchObject({ kind: 'http', status: 401, message: 'auth failed' })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('场景13:不重复写入', () => {
  it('同 index 重发不追加重复块;收尾后的迟到增量不修改内容', () => {
    const reply: AssistantMessage = { id: 'r', role: 'assistant', createdAt: 1, model: 'deepseek-flash', prefix: true, status: 'pending', blocks: [] }
    const idx = new Map<number, number>()
    let next = applyEvent(reply, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'a' } }, 1, idx)
    next = applyEvent(next, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'b' } }, 1, idx)
    next = applyEvent(next, { type: 'content_block_stop', index: 0 }, 1, idx)
    // 服务端异常地重发同一 index:demo 语义是 delete + 重映射,不重复追加
    next = applyEvent(next, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'c' } }, 1, idx)
    expect(next.blocks).toHaveLength(2)
    expect(next.blocks[0]).toMatchObject({ type: 'text', text: 'ab' })
    expect(next.blocks[1]).toMatchObject({ type: 'text', text: 'c' })
    // 收尾(done)后的迟到增量不改变文本
    const settled = settleReply(next, 'done', 2)
    const after = applyEvent(settled, { type: 'content_block_delta', index: 9, delta: { type: 'text_delta', text: 'late' } }, 3, idx)
    expect(getReplyText(after)).toBe(getReplyText(settled))
  })
})

describe('场景14:未知内容块不破坏历史', () => {
  it('未知块被解析层丢弃,合并层与映射层都不抛错', () => {
    const text = [
      sse('message_start', { type: 'message_start', message: { id: 'r', model: 'm' } }),
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'client_tool', input: {} } }),
      sse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'brand_new_block', foo: 'bar' } }),
      sse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'future_delta', x: 1 } }),
      sse('content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'text', text: 'ok' } }),
      sse('content_block_stop', { type: 'content_block_stop', index: 2 }),
      sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } }),
      sse('message_stop', { type: 'message_stop' }),
    ].join('')
    const reply = consumeEvents(text)
    expect(reply.blocks).toEqual([{ type: 'text', text: 'ok', citations: [] }])
    // 历史 DSH 映射同样跳过未知块
    const dsh = replyBlocksToDshContent([{ type: 'text', text: 'ok', citations: [] } as never, { type: 'mystery' } as never])
    expect(dshContentToReplyBlocks(dsh)).toEqual([{ type: 'text', text: 'ok', citations: [] }])
    // 上下文回传仍正常
    const messages = toRequestMessages([mkUser('q'), reply], mkUser('q2'))
    expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(1)
  })
})

describe('上下文回传规则(第九节)', () => {
  it('失败/无回答轮次不进上下文;历史思考不回传;read_link 保留签名', () => {
    const failed = mkAssistant([{ type: 'text', text: 'x' }], 'r2')
    failed.status = 'error'
    const refusal = mkAssistant([{ type: 'thinking', thinking: 't', signature: 's' }], 'r3', 'refusal')
    const empty = mkAssistant([], 'r4')
    const good = mkAssistant([{ type: 'text', text: '回答' }], 'r5')
    const readLink = mkAssistant([
      { type: 'server_tool_use', id: 's1', name: 'deepseek_read_url', input: { action: 'read_link', url: 'https://y' }, caller: { type: 'direct' }, kind: 'read_link' },
      { type: 'web_fetch_tool_result', tool_use_id: 's1', content: { type: 'web_fetch_result', url: 'https://y', content: { type: 'document', source: { type: 'text', media_type: 'text/plain', data: '' }, title: 'Y' }, published_at: null }, kind: 'read_link', signature: 'sig9' },
      { type: 'text', text: '页面要点' },
    ], 'r6')
    const thinking = mkAssistant([{ type: 'thinking', thinking: '内部', signature: 'sig' }, { type: 'text', text: '可见' }], 'r7')

    const history: Message[] = [
      mkUser('q1', 'u1'), failed,
      mkUser('q2', 'u2'), refusal,
      mkUser('q3', 'u3'), empty,
      mkUser('q4', 'u4'), good,
      mkUser('q5', 'u5'), readLink,
      mkUser('q6', 'u6'), thinking,
    ]
    const messages = toRequestMessages(history, mkUser('q7', 'u7'))
    // 排除 failed/refusal/empty;包含 good/readLink/thinking 的轮次 + 本轮提问
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(4)
    expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(3)
    // 历史思考不回传
    const last = messages.filter((m) => m.role === 'assistant').at(-1)!
    expect(JSON.stringify(last)).not.toContain('内部')
    // read_link 调用与结果保留,signature 原样
    const readLinkParam = messages.filter((m) => m.role === 'assistant').at(-2)!
    expect(JSON.stringify(readLinkParam)).toContain('sig9')
  })

  it('续写 prefill 保留本轮思考与签名', () => {
    const stopped = mkAssistant([{ type: 'text', text: '半' }], 'r1')
    stopped.status = 'stopped'
    stopped.thinking = true
    const messages = toRequestMessages([], mkUser('q', 'u'), stopped, true)
    const assistant = messages.filter((m) => m.role === 'assistant')
    expect(assistant).toHaveLength(1)
    expect(JSON.stringify(assistant[0])).toContain('半')
  })

  it('可续写性:refusal/tool_use/含搜索结果/报错不可续写', () => {
    const base = mkAssistant([{ type: 'text', text: 'x' }], 'r')
    base.status = 'stopped'
    expect(canContinueReply(base)).toBe(true)
    expect(canContinueReply({ ...base, stopReason: 'refusal' })).toBe(false)
    expect(canContinueReply({ ...base, stopReason: 'tool_use' })).toBe(false)
    expect(canContinueReply({ ...base, blocks: [{ type: 'web_search_tool_result', tool_use_id: 't', content: [], kind: 'search' }] })).toBe(false)
    expect(canContinueReply({ ...base, status: 'error' })).toBe(false)
  })
})

// ---------- helpers ----------

async function collect(gen: AsyncGenerator<{ event: string; data: string }>): Promise<{ event: string; data: string }[]> {
  const out: { event: string; data: string }[] = []
  for await (const item of gen) out.push(item)
  return out
}

function minimalRequest() {
  return {
    model: 'deepseek-flash',
    system: '',
    messages: [{ role: 'user', content: 'hi' }],
    thinking: { type: 'disabled' },
    tools: [{ type: 'deepseek_read_url', name: 'deepseek_read_url' }],
    safety_check: { level: 'high' },
  }
}

async function collectStream(chunks: (string | Uint8Array | { abort: Error })[]): Promise<{ event: string; data: string }[]> {
  const response = new Response(mockStream(chunks), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
  return collect(streamFromResponse(response, new AbortController().signal))
}
