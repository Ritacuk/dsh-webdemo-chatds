/**
 * Rich 响应块 ↔ DSH Session 内容块 的双向映射。
 *
 * 设计依据(P0 审计结论):
 * - DSH Session 对 assistant/message 的 content 只校验"是数组"
 *   (asar-extract/dsh/node_modules/@deepseek-ai/dsh-session/src/index.ts assertMessageEventShape),
 *   未知块类型按 dsh-llm 的 merge-extensible 约定落空(dsh-llm/src/types.ts:140-157)。
 * - text/reasoning 是官方块; Rich 的 citations/signature 作为附加字段随之保存;
 *   server_tool_use / web_search_tool_result / web_fetch_tool_result 没有 DSH 官方块,
 *   以插件扩展块 `server-tool-use` / `web-search-tool-result` / `web-fetch-tool-result`
 *   承载原样 payload(snake_case 保留,回传请求时无需再转换)。
 * - 官方适配器(dsh-llm-deepseek/src/translate.ts:60,87)对未知块是"熔断"而非压平,
 *   因此 Rich 块只出现在本插件的会话里,绝不进入 ctx.llm 通用通路。
 */

import type { ReplyBlock, ThinkingPart, TextPart } from '../chat/types.js'
import type {
  ServerToolBlock,
  TextCitation,
} from '../protocol/types.js'

/** 本插件向 ContentBlockMap 合并扩展的块类型(type 标签) */
export const RICH_TOOL_BLOCK_TYPES = {
  serverToolUse: 'server-tool-use',
  webSearchToolResult: 'web-search-tool-result',
  webFetchToolResult: 'web-fetch-tool-result',
} as const

/** text 块上的 Rich 附加字段:引用列表 */
export interface DshTextBlock {
  type: 'text'
  text: string
  citations?: TextCitation[]
}

/** reasoning 块上的 Rich 附加字段:签名与思考起止时间 */
export interface DshReasoningBlock {
  type: 'reasoning'
  text: string
  signature?: string
  startedAt?: number
  endedAt?: number
  elapsedSeconds?: number
}

/** 服务端工具调用块:payload 原样保留 */
export interface DshServerToolUseBlock {
  type: typeof RICH_TOOL_BLOCK_TYPES.serverToolUse
  tool: Extract<ServerToolBlock, { type: 'server_tool_use' }>
}

/** 服务端搜索结果块:payload 原样保留 */
export interface DshWebSearchToolResultBlock {
  type: typeof RICH_TOOL_BLOCK_TYPES.webSearchToolResult
  tool: Extract<ServerToolBlock, { type: 'web_search_tool_result' }>
}

/** 服务端网页读取结果块:payload 原样保留 */
export interface DshWebFetchToolResultBlock {
  type: typeof RICH_TOOL_BLOCK_TYPES.webFetchToolResult
  tool: Extract<ServerToolBlock, { type: 'web_fetch_tool_result' }>
}

/** 本插件会话中 assistant/message.content 的块联合 */
export type DshChatBlock =
  | DshTextBlock
  | DshReasoningBlock
  | DshServerToolUseBlock
  | DshWebSearchToolResultBlock
  | DshWebFetchToolResultBlock

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * 回复块(Rich 视图)→ DSH 内容块(Session 持久化视图)。
 * 输入即官方 demo 的 ReplyBlock;未知类型跳过,避免未知块污染历史。
 */
export function replyBlocksToDshContent(blocks: readonly ReplyBlock[]): DshChatBlock[] {
  const out: DshChatBlock[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text': {
        const part = block as TextPart
        out.push({
          type: 'text',
          text: part.text,
          ...(part.citations !== undefined ? { citations: part.citations } : {}),
        })
        break
      }
      case 'thinking': {
        const part = block as ThinkingPart
        out.push({
          type: 'reasoning',
          text: part.thinking,
          ...(part.signature !== undefined ? { signature: part.signature } : {}),
          ...(part.startedAt !== undefined ? { startedAt: part.startedAt } : {}),
          ...(part.endedAt !== undefined ? { endedAt: part.endedAt } : {}),
          ...(part.elapsedSeconds !== undefined ? { elapsedSeconds: part.elapsedSeconds } : {}),
        })
        break
      }
      case 'server_tool_use':
        out.push({
          type: RICH_TOOL_BLOCK_TYPES.serverToolUse,
          tool: block as Extract<ServerToolBlock, { type: 'server_tool_use' }>,
        })
        break
      case 'web_search_tool_result':
        out.push({
          type: RICH_TOOL_BLOCK_TYPES.webSearchToolResult,
          tool: block as Extract<ServerToolBlock, { type: 'web_search_tool_result' }>,
        })
        break
      case 'web_fetch_tool_result':
        out.push({
          type: RICH_TOOL_BLOCK_TYPES.webFetchToolResult,
          tool: block as Extract<ServerToolBlock, { type: 'web_fetch_tool_result' }>,
        })
        break
      default:
        break
    }
  }
  return out
}

/**
 * DSH 内容块 → 回复块(恢复视图)。容忍未知块(跳过)与缺字段(保持可读),
 * 保证第三方或旧版本写入的块不会让历史恢复整体失败。
 */
export function dshContentToReplyBlocks(content: readonly unknown[]): ReplyBlock[] {
  const out: ReplyBlock[] = []
  for (const raw of content) {
    if (!isRecord(raw)) continue
    switch (raw.type) {
      case 'text': {
        if (typeof raw.text !== 'string') break
        const citations = Array.isArray(raw.citations)
          ? (raw.citations.filter(isRecord) as TextCitation[])
          : undefined
        out.push({
          type: 'text',
          text: raw.text,
          ...(citations !== undefined ? { citations } : {}),
        } satisfies TextPart)
        break
      }
      case 'reasoning': {
        if (typeof raw.text !== 'string') break
        out.push({
          type: 'thinking',
          thinking: raw.text,
          ...(typeof raw.signature === 'string' ? { signature: raw.signature } : {}),
          ...(typeof raw.startedAt === 'number' ? { startedAt: raw.startedAt } : {}),
          ...(typeof raw.endedAt === 'number' ? { endedAt: raw.endedAt } : {}),
          ...(typeof raw.elapsedSeconds === 'number' ? { elapsedSeconds: raw.elapsedSeconds } : {}),
        } satisfies ThinkingPart)
        break
      }
      case RICH_TOOL_BLOCK_TYPES.serverToolUse: {
        const tool = raw.tool
        if (isRecord(tool) && tool.type === 'server_tool_use') {
          out.push(tool as unknown as Extract<ServerToolBlock, { type: 'server_tool_use' }>)
        }
        break
      }
      case RICH_TOOL_BLOCK_TYPES.webSearchToolResult: {
        const tool = raw.tool
        if (isRecord(tool) && tool.type === 'web_search_tool_result') {
          out.push(tool as unknown as Extract<ServerToolBlock, { type: 'web_search_tool_result' }>)
        }
        break
      }
      case RICH_TOOL_BLOCK_TYPES.webFetchToolResult: {
        const tool = raw.tool
        if (isRecord(tool) && tool.type === 'web_fetch_tool_result') {
          out.push(tool as unknown as Extract<ServerToolBlock, { type: 'web_fetch_tool_result' }>)
        }
        break
      }
      default:
        break
    }
  }
  return out
}
