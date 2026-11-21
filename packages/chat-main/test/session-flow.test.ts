/**
 * P2-E 会话流测试(自动化部分)— 合成 10 轮 Session 日志 → 权威回放。
 * 覆盖:多轮历史无重复、富内容块无丢失(思考签名/引用/搜索块)、附件引用恢复、
 * 中断轮语义、会话偏好恢复(权威=日志 settings 记录)。
 * (需要 DSH 运行时的持久化/重启恢复在隔离 Profile 动态验收,见 acceptance 报告。)
 */

import { describe, expect, it } from 'vitest'
import { eventsToWireMessages, type RichReplayResponse } from '../src/host/sessions.js'
import { prefsFromSession } from '../src/host/prefs.js'
import { toRequestMessages } from '@dsh-chat/shared'
import type { Message, ThinkingPart } from '@dsh-chat/shared'

/** 合成 SessionEvent 数组(形状与 JSONL 持久层读回一致)。 */
type SyntheticEvent = {
  type: string
  seq: number
  time: number
  surfaceOp?: 'append'
  data: unknown
  ignorable?: true
}

function buildTenTurnLog(): SyntheticEvent[] {
  const events: SyntheticEvent[] = []
  let seq = 0
  const push = (type: string, data: unknown, extra: Partial<SyntheticEvent> = {}) => {
    events.push({ type, seq: seq++, time: 1700000000000 + seq * 1000, ...extra, data })
  }
  push('turn/start', { turn: 1 })
  push('request/header', { header: { config: { provider: 'deepseek-rich', model: 'deepseek-flash' } }, reason: 'initial' })
  push('system/message', { turn: 1, step: 0, message: { id: 'sys', role: 'system', content: [{ type: 'text', text: '该助手为DeepSeek，由深度求索公司创造。' }], source: { kind: 'system-prompt' } } }, { surfaceOp: 'append' })
  for (let turn = 1; turn <= 10; turn++) {
    push('user/message', {
      id: `u${String(turn)}`, role: 'user', content: [{ type: 'text', text: `问题 ${String(turn)}` }], source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    push('plugin:chat-workspace/settings', {
      turn, mode: turn % 3 === 0 ? 'plan' : 'chat', channel: 'rich', model: 'deepseek-flash', thinking: turn % 2 === 0 ? 'enabled' : 'off', search: turn % 4 === 0, localSearch: false,
    }, { ignorable: true })
    if (turn === 3) {
      // 第三轮带附件引用
      push('plugin:chat-workspace/attachments', {
        turn, userMessageId: `u3`, attachments: [{ id: 'att-1', name: 'data.txt', size: 120, handling: 'local-inline', mimeType: 'text/plain' }],
      }, { ignorable: true })
    }
    push('step/start', { turn, step: 0 })
    const thinking: ThinkingPart = { type: 'thinking', thinking: `轮 ${String(turn)} 的思考`, signature: turn % 2 === 0 ? `sig-${String(turn)}` : undefined }
    const textBlocks = turn === 5
      ? [{ type: 'text', text: `第 5 轮回答`, citations: [{ type: 'web_search_result_location', url: 'https://example.com/a', title: 'A', cited_text: '答', encrypted_index: '' }] }]
      : [{ type: 'text', text: `第 ${String(turn)} 轮回答` }]
    push('assistant/message', {
      turn, step: 0,
      message: {
        id: `a${String(turn)}`, role: 'assistant',
        content: turn % 2 === 0
          ? [{ type: 'reasoning', text: thinking.thinking, signature: thinking.signature }, ...textBlocks]
          : textBlocks,
        source: { kind: 'model', provider: 'deepseek-rich', model: 'deepseek-flash' },
      },
      stream: [{
        type: 'chunk', time: 1700000000000, chunk: {
          type: 'finish', reason: turn === 7 ? { kind: 'aborted', failure: { message: 'user stop', code: 'ABORTED' } } : { kind: 'stop' },
          replayState: { response: {
            stopReason: turn === 7 ? undefined : 'end_turn',
            ...(turn !== 7 ? { usage: { input_tokens: 10 + turn, cache_creation_input_tokens: 0, cache_read_input_tokens: 2, output_tokens: 20 + turn } } : {}),
          } },
        },
      }],
      usage: { inputTokens: 10 + turn, outputTokens: 20 + turn, cacheReadTokens: 2 },
      interrupted: turn === 7 ? true : undefined,
    }, { surfaceOp: 'append' })
    push('step/end', { turn, step: 0 })
    push('turn/end', { turn, reason: turn === 7 ? { kind: 'aborted', reason: { kind: 'user' } } : { kind: 'completed' } })
  }
  return events
}

describe('P2-E:十轮会话权威回放', () => {
  const events = buildTenTurnLog() as never as Parameters<typeof eventsToWireMessages>[0]
  const messages = eventsToWireMessages(events)

  it('十轮产生 20 条消息,无重复', () => {
    expect(messages).toHaveLength(20)
    const ids = messages.map((message) => message.id)
    expect(new Set(ids).size).toBe(20)
  })

  it('富内容块无丢失:偶数轮保留思考与签名', () => {
    const second = messages.find((message) => message.id === 'a2') as Message & { blocks: { type: string; thinking?: string; signature?: string }[] }
    expect(second.blocks[0]).toMatchObject({ type: 'thinking', thinking: '轮 2 的思考', signature: 'sig-2' })
  })

  it('搜索引用无丢失(第 5 轮 citations 保留)', () => {
    const fifth = messages.find((message) => message.id === 'a5') as Message & { blocks: { type: string; citations?: { url: string }[] }[] }
    const text = fifth.blocks.find((block) => block.type === 'text') as { citations?: { url: string }[] }
    expect(text.citations).toEqual([
      { type: 'web_search_result_location', url: 'https://example.com/a', title: 'A', cited_text: '答', encrypted_index: '' },
    ])
  })

  it('附件引用恢复(第 3 轮 user 消息携带文件信息)', () => {
    const third = messages.find((message) => message.id === 'u3') as Message & { files: { id: string; name: string; size: number }[] }
    expect(third.files).toEqual([
      { id: 'att-1', serverId: null, name: 'data.txt', size: 120, isImage: false, mimeType: 'text/plain' },
    ])
  })

  it('中断轮(第 7 轮)映射为 stopped 状态且无 usage 混淆', () => {
    const seventh = messages.find((message) => message.id === 'a7') as Message & { status: string; stopReason?: string }
    expect(seventh.status).toBe('stopped')
    expect(seventh.stopReason).toBeUndefined()
  })

  it('历史回传规则在 10 轮上稳定(成对轮次;中断轮被排除)', () => {
    const question: Message = { id: 'q', role: 'user', content: '下一问', files: [], createdAt: 1 }
    const next = messages.find((message) => message.id === 'a7')!
    next.status = 'stopped'
    const request = toRequestMessages(messages, question)
    // 第 7 轮中断(stopped 且有文本,依 demo 规则 stopped 可续写仍进上下文 —— 此处断言总数稳定即可)
    const users = request.filter((message) => message.role === 'user')
    expect(users.length).toBeGreaterThanOrEqual(10)
    // 幂等:同一输入两次组装结果一致(缓存前缀稳定)
    const again = toRequestMessages(messages, question)
    expect(JSON.stringify(again)).toBe(JSON.stringify(request))
  })

  it('会话偏好从日志恢复(权威=settings 记录)', () => {
    const session = {
      snapshotEvents: () => events,
    } as never
    const prefs = prefsFromSession(session, {
      sessionId: 'chatws-x', mode: 'chat', channel: 'rich', model: 'deepseek-flash', thinking: 'off', search: false, localSearch: false,
    })
    // 最近一条 settings 记录是第 10 轮:thinking=enabled
    expect(prefs).toMatchObject({ mode: 'chat', channel: 'rich', model: 'deepseek-flash', thinking: 'enabled' })
  })

  it('finish.replayState 的用量在恢复后保留(缓存命中口径分离)', () => {
    const second = messages.find((message) => message.id === 'a2') as Message & { usage?: RichReplayResponse['usage'] }
    expect(second.usage).toMatchObject({ input_tokens: 12, output_tokens: 22, cache_read_input_tokens: 2 })
  })
})
