/**
 * DSH 通用通路(P2-E)— 经 ctx.llm 正式接口执行任意已配置模型的回合。
 *
 * 翻译约定:ctx.llm 的 StreamChunk 被规范化为页面已有的 Rich 事件词表
 * (content_block_start/delta/stop + message_delta + message_stop),页面的
 * applyEvent 合并逻辑与 UI 无需第二套通路代码。原始 StreamChunk 同时保留,
 * 供 assistant/message 的 stream 字段(AssistantStreamRecord)持久化。
 *
 * 边界(任务书 P2-E/P2-H):
 * - 绝不传 DSH Agent 工具定义(tools 字段恒省略);
 * - 历史思考文本不回传(与 demo 语义一致);
 * - usage 只有适配器声明时才有(usage 块);
 * - DeepSeek Rich 特性(搜索/引用/签名)在此通路不存在,不做任何假装。
 */

import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage as DemoAssistant, MessageStreamEvent } from '@dsh-chat/shared'

/** 通道事件:Rich 规范化事件 + 可选的原始 StreamChunk(持久化用)。 */
export interface ChannelEvent {
  rich: MessageStreamEvent
  raw?: StreamChunk
}

/** TokenUsage → demo 的 MessageUsage(页面显示口径)。 */
export function usageToWire(usage: TokenUsage): DemoAssistant['usage'] {
  return {
    input_tokens: usage.inputTokens,
    cache_creation_input_tokens: usage.cacheWriteTokens ?? 0,
    cache_read_input_tokens: usage.cacheReadTokens ?? 0,
    output_tokens: usage.outputTokens,
  }
}

/** ctx.llm StreamChunk → 页面 Rich 事件流。 */
export async function* translateGenericChunks(
  chunks: AsyncIterable<StreamChunk>,
): AsyncGenerator<ChannelEvent> {
  let blockIndex = -1
  let opened = false
  let usageEmitted = false
  for await (const chunk of chunks) {
    switch (chunk.type) {
      case 'block-start': {
        if (chunk.blockType === 'text' || chunk.blockType === 'reasoning') {
          blockIndex += 1
          opened = true
          yield {
            rich: (chunk.blockType === 'text'
              ? { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } }
              : { type: 'content_block_start', index: blockIndex, content_block: { type: 'thinking', thinking: '' } }) as MessageStreamEvent,
            raw: chunk,
          }
        } else {
          // 未声明工具却出现的块:按 tool_use 透传(页面 applyEvent 关闭续写,不执行任何工具)
          blockIndex += 1
          opened = true
          yield {
            rich: { type: 'content_block_start', index: blockIndex, content_block: { type: 'tool_use', id: `generic-${chunk.blockType}`, name: chunk.blockType, input: {} } } as unknown as MessageStreamEvent,
            raw: chunk,
          }
        }
        break
      }
      case 'text-delta': {
        yield { rich: { type: 'content_block_delta', index: chunk.index, delta: { type: 'text_delta', text: chunk.text } } as MessageStreamEvent }
        break
      }
      case 'reasoning-delta': {
        yield { rich: { type: 'content_block_delta', index: chunk.index, delta: { type: 'thinking_delta', thinking: chunk.text } } as MessageStreamEvent }
        break
      }
      case 'tool-call-delta': {
        if (!opened) {
          blockIndex += 1
          opened = true
          yield {
            rich: { type: 'content_block_start', index: blockIndex, content_block: { type: 'tool_use', id: chunk.id, name: chunk.name ?? 'tool', input: {} } } as unknown as MessageStreamEvent,
          }
        }
        break
      }
      case 'block-end': {
        yield { rich: { type: 'content_block_stop', index: chunk.index } as MessageStreamEvent, raw: chunk }
        break
      }
      case 'usage': {
        usageEmitted = true
        yield {
          rich: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: usageToWire(chunk.usage) } as MessageStreamEvent,
          raw: chunk,
        }
        break
      }
      case 'finish': {
        if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
          throw new Error(chunk.reason.failure.message)
        }
        const stopReason = chunk.reason.kind === 'max-tokens'
          ? 'max_tokens'
          : chunk.reason.kind === 'tool-calls'
            ? 'tool_use'
            : 'end_turn'
        yield { rich: { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, ...(usageEmitted ? {} : { usage: undefined }) } as MessageStreamEvent, raw: chunk }
        yield { rich: { type: 'message_stop' } as MessageStreamEvent }
        return
      }
    }
  }
  // 流在 finish 前结束:与 Rich 通路 interrupted 语义一致,由调用方 catch
  throw new Error('generic stream ended before finish')
}
