/**
 * V0:消息编辑 / 重新生成 / 继续生成 —— 分支记录(plugin:chat-workspace/branch)回放测试。
 * 覆盖:edit 旧尾段替换、regenerate 原提问 id 保留、continue 块并入原回复、
 * 多次编辑叠加、隐藏消息不进上下文(toRequestMessages)。
 */

import { describe, expect, it } from 'vitest'
import { eventsToWireMessages, replayChatSession } from '../src/host/sessions.js'
import { toRequestMessages } from '@dsh-chat/shared'
import type { Message } from '@dsh-chat/shared'

type SyntheticEvent = {
  type: string
  seq: number
  time: number
  surfaceOp?: 'append'
  data: unknown
  ignorable?: true
}

function pushUser(events: SyntheticEvent[], id: string, text: string, seq: number): number {
  events.push({
    type: 'user/message', seq, time: 1700000000000 + seq * 1000, surfaceOp: 'append',
    data: { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
  })
  return seq + 1
}

function pushAssistant(events: SyntheticEvent[], id: string, text: string, seq: number, extra: { thinking?: string; status?: 'stopped' } = {}): number {
  const content = extra.thinking !== undefined
    ? [{ type: 'reasoning', text: extra.thinking, signature: `sig-${id}` }, { type: 'text', text }]
    : [{ type: 'text', text }]
  events.push({
    type: 'assistant/message', seq, time: 1700000000000 + seq * 1000, surfaceOp: 'append',
    data: {
      turn: 0, step: 0,
      message: {
        id, role: 'assistant', content,
        source: { kind: 'model', provider: 'deepseek-rich', model: 'deepseek-flash' },
      },
      stream: [{
        type: 'chunk', time: 1700000000000, chunk: {
          type: 'finish', reason: { kind: 'stop' },
          replayState: { response: { stopReason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 } } },
        },
      }],
      usage: { inputTokens: 10, outputTokens: 20 },
      ...(extra.status === 'stopped' ? { interrupted: true } : {}),
    },
  })
  return seq + 1
}

function pushBranch(events: SyntheticEvent[], seq: number, data: Record<string, unknown>): number {
  events.push({
    type: 'plugin:chat-workspace/branch', seq, time: 1700000000000 + seq * 1000, ignorable: true, data: { turn: 0, ...data },
  })
  return seq + 1
}

/** 3 轮基础日志:u1/a1, u2/a2, u3/a3 */
function baseThreeTurnLog(): SyntheticEvent[] {
  const events: SyntheticEvent[] = []
  let seq = 0
  for (let turn = 1; turn <= 3; turn++) {
    seq = pushUser(events, `u${String(turn)}`, `问题 ${String(turn)}`, seq)
    seq = pushAssistant(events, `a${String(turn)}`, `回答 ${String(turn)}`, seq, turn === 2 ? { thinking: '思考 2' } : {})
  }
  return events
}

describe('V0:分支记录回放(edit/regenerate/continue)', () => {
  it('preserves prior answers and the selected path without writing another user event', () => {
    const events = baseThreeTurnLog()
    const seq = pushBranch(events, events.length, { action: 'regenerate', hideIds: ['a2', 'u3', 'a3'], reuseUser: true })
    pushAssistant(events, 'a2-new', 'Second response', seq)
    const replay = replayChatSession(events as never)
    expect(replay.versions['a2-new']).toEqual(['a2', 'a2-new'])
    expect(replay.messages.map((message) => message.id)).toEqual(['u1', 'a1', 'u2', 'a2-new'])
    events.push({ type: 'plugin:chat-workspace/branch-selection', seq: seq + 1, time: 0, data: { messageId: 'a2' }, ignorable: true })
    expect(eventsToWireMessages(events as never).map((message) => message.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3'])
  })
  it('edit:被编辑提问起的旧尾段整体替换为新的一对问答', () => {
    const events = baseThreeTurnLog()
    let seq = events.length
    // 编辑 u1 → 新提问 u1' + 新回答 a1';u1/a1/u2/a2/u3/a3 整段隐藏
    seq = pushUser(events, 'u1x', '问题 1(改)', seq)
    seq = pushAssistant(events, 'a1x', '回答 1(新)', seq)
    seq = pushBranch(events, seq, { action: 'edit', hideIds: ['u1', 'a1', 'u2', 'a2', 'u3', 'a3'] })
    const messages = eventsToWireMessages(events as never)
    expect(messages.map((m) => m.id)).toEqual(['u1x', 'a1x'])
    expect(messages[0]).toMatchObject({ role: 'user', content: '问题 1(改)' })
    expect(messages[1]).toMatchObject({ role: 'assistant', blocks: [{ type: 'text', text: '回答 1(新)' }] })
  })

  it('regenerate:原提问 id 保留,旧回答及其后续被替换', () => {
    const events = baseThreeTurnLog()
    let seq = events.length
    // 重新生成 a2:本轮提问副本 u2x 与旧回答 a2、后续 u3/a3 一起隐藏;u2 保留
    seq = pushUser(events, 'u2x', '问题 2', seq)
    seq = pushAssistant(events, 'a2x', '回答 2(重新生成)', seq)
    seq = pushBranch(events, seq, { action: 'regenerate', hideIds: ['a2', 'u3', 'a3', 'u2x'] })
    const messages = eventsToWireMessages(events as never)
    expect(messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2x'])
    const question = messages[2] as Message & { content: string }
    expect(question.id).toBe('u2')
    expect(question.content).toBe('问题 2')
    const reply = messages[3] as Message & { blocks: { type: string; text?: string }[] }
    expect(reply.blocks[0]).toMatchObject({ type: 'text', text: '回答 2(重新生成)' })
  })

  it('continue:续写块并入原回复,提问副本与续写消息隐藏', () => {
    const events = baseThreeTurnLog()
    let seq = events.length
    // 续写 a3:u3x(提问副本)与 a3x(续写块)隐藏;a3x 的块并入 a3
    seq = pushUser(events, 'u3x', '问题 3', seq)
    seq = pushAssistant(events, 'a3x', '(续写段落)', seq)
    seq = pushBranch(events, seq, {
      action: 'continue', hideIds: ['u3x', 'a3x'], mergeIntoId: 'a3', continueReplyId: 'a3x',
    })
    const messages = eventsToWireMessages(events as never)
    expect(messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3'])
    const reply = messages[5] as Message & { blocks: { type: string; text?: string }[] }
    expect(reply.blocks.map((b) => b.text)).toEqual(['回答 3', '(续写段落)'])
  })

  it('多次编辑叠加:每个记录各自隐藏旧尾段', () => {
    const events = baseThreeTurnLog()
    let seq = events.length
    seq = pushUser(events, 'u1x', '问题 1(改1)', seq)
    seq = pushAssistant(events, 'a1x', '回答 1(新1)', seq)
    seq = pushBranch(events, seq, { action: 'edit', hideIds: ['u1', 'a1', 'u2', 'a2', 'u3', 'a3'] })
    seq = pushUser(events, 'u1y', '问题 1(改2)', seq)
    seq = pushAssistant(events, 'a1y', '回答 1(新2)', seq)
    seq = pushBranch(events, seq, { action: 'edit', hideIds: ['u1x', 'a1x'] })
    const messages = eventsToWireMessages(events as never)
    expect(messages.map((m) => m.id)).toEqual(['u1y', 'a1y'])
    expect(messages[0]).toMatchObject({ content: '问题 1(改2)' })
  })

  it('隐藏消息不进上下文(toRequestMessages 只见可见路径)', () => {
    const events = baseThreeTurnLog()
    let seq = events.length
    seq = pushUser(events, 'u2x', '问题 2', seq)
    seq = pushAssistant(events, 'a2x', '回答 2(重新生成)', seq)
    seq = pushBranch(events, seq, { action: 'regenerate', hideIds: ['a2', 'u3', 'a3', 'u2x'] })
    const messages = eventsToWireMessages(events as never)
    const question: Message = { id: 'q', role: 'user', content: '下一问', files: [], createdAt: 1 }
    const request = toRequestMessages(messages, question)
    const users = request.filter((m) => m.role === 'user')
    const assistants = request.filter((m) => m.role === 'assistant')
    // u1/a1 一对 + u2/a2x 一对 + 本轮提问
    expect(users).toHaveLength(3)
    expect(assistants).toHaveLength(2)
    expect(JSON.stringify(request)).not.toContain('回答 3')
    expect(JSON.stringify(request)).not.toContain('回答 2(原)')
  })

  it('无分支记录时行为不变(线性回放)', () => {
    const messages = eventsToWireMessages(baseThreeTurnLog() as never)
    expect(messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3'])
    const withThinking = messages[3] as Message & { blocks: { type: string; thinking?: string }[] }
    expect(withThinking.blocks[0]).toMatchObject({ type: 'thinking', thinking: '思考 2' })
  })

  it('edit 后重新生成:替换链上各记录独立生效', () => {
    const events = baseThreeTurnLog()
    let seq = events.length
    // 编辑 u2 → u2x/a2x(隐藏 a2 及其后续);再对 a2x 重新生成 → a2y(隐藏 a2x 与 u2y)
    seq = pushUser(events, 'u2x', '问题 2(改)', seq)
    seq = pushAssistant(events, 'a2x', '回答 2(改)', seq)
    seq = pushBranch(events, seq, { action: 'edit', hideIds: ['u2', 'a2', 'u3', 'a3'] })
    seq = pushUser(events, 'u2y', '问题 2(改)', seq)
    seq = pushAssistant(events, 'a2y', '回答 2(再生成)', seq)
    seq = pushBranch(events, seq, { action: 'regenerate', hideIds: ['a2x', 'u2y'] })
    const messages = eventsToWireMessages(events as never)
    expect(messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2x', 'a2y'])
    expect(messages[3]).toMatchObject({ blocks: [{ type: 'text', text: '回答 2(再生成)' }] })
  })
})
