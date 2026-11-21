import {
  createAssistantMessage, createToolResultMessage,
  type ContentBlock, type GenerateOptions, type StreamChunk, type TokenUsage, type ToolCallBlock, type ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { LocalSearchEngine } from './local-search.js'
import { extractFilenameTargets } from './terms.js'

export const planTools: ToolSchema[] = [
  {
    name: 'chatds_search_files',
    description: 'Search the user-authorized directories for relevant text files. Returns directory IDs and relative paths.',
    parameters: { type: 'object', additionalProperties: false, required: ['query'],
      properties: { query: { type: 'string', maxLength: 200 } } },
  },
  {
    name: 'chatds_read_file',
    description: 'Read at most 60 lines of a text file returned by chatds_search_files.',
    parameters: { type: 'object', additionalProperties: false, required: ['dirId', 'relativePath'],
      properties: { dirId: { type: 'string' }, relativePath: { type: 'string' }, startLine: { type: 'integer', minimum: 1 } } },
  },
]

async function execute(search: LocalSearchEngine, call: ToolCallBlock) {
  let args: Record<string, unknown>
  try {
    args = JSON.parse(call.arguments.slice(0, 2048))
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error()
  } catch {
    return { refused: 'Invalid tool arguments.' }
  }
  if (call.name === 'chatds_search_files' && typeof args.query === 'string' && args.query.trim() && args.query.length <= 200) {
    const filenames = extractFilenameTargets(args.query)
    const result = await search.search({ query: args.query, match: 'any', ...(filenames.length > 0 ? { filenames } : {}) })
    return { hits: result.hits.slice(0, 12).map(({ path: _path, ...hit }) => hit), truncated: result.truncated || result.hits.length > 12 }
  }
  if (call.name === 'chatds_read_file' && typeof args.dirId === 'string' && typeof args.relativePath === 'string') {
    const startLine = typeof args.startLine === 'number' && Number.isSafeInteger(args.startLine) && args.startLine > 0
      ? args.startLine : 1
    const result = await search.readSnippet({ dirId: args.dirId, relativePath: args.relativePath, startLine, maxLines: 60 })
    if ('refused' in result) return { refused: 'File is unavailable or outside the authorized directory.' }
    return { content: result.content.slice(0, 6000), truncated: result.truncated || result.content.length > 6000 }
  }
  return { refused: 'Unsupported tool or arguments.' }
}

function addUsage(previous: TokenUsage | undefined, next: TokenUsage): TokenUsage {
  if (!previous) return next
  return {
    inputTokens: previous.inputTokens + next.inputTokens,
    outputTokens: previous.outputTokens + next.outputTokens,
    cacheReadTokens: (previous.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0),
    cacheWriteTokens: (previous.cacheWriteTokens ?? 0) + (next.cacheWriteTokens ?? 0),
    totalTokens: (previous.totalTokens ?? previous.inputTokens + previous.outputTokens)
      + (next.totalTokens ?? next.inputTokens + next.outputTokens),
  }
}

export async function* streamReadOnlyPlan(
  stream: (request: GenerateOptions) => AsyncIterable<StreamChunk>,
  options: GenerateOptions,
  search: LocalSearchEngine,
  maxSteps: number,
  grants: () => Promise<readonly string[]>,
): AsyncGenerator<StreamChunk> {
  const messages = [...options.messages]
  let remaining = maxSteps
  let usage: TokenUsage | undefined
  while (remaining > 0) {
    options.signal?.throwIfAborted()
    const allowed = await grants()
    const tools = planTools.filter((tool) => allowed.includes(tool.name))
    const chunks: StreamChunk[] = []
    const blocks: ContentBlock[] = []
    const calls: ToolCallBlock[] = []
    let finish: Extract<StreamChunk, { type: 'finish' }> | undefined
    for await (const chunk of stream({ ...options, messages, ...(tools.length > 0 ? { tools } : {}), maxTokens: 4096 })) {
      options.signal?.throwIfAborted()
      if (chunk.type === 'usage') usage = addUsage(usage, chunk.usage)
      else if (chunk.type === 'finish') finish = chunk
      else {
        chunks.push(chunk)
        if (chunk.type === 'block-end') {
          blocks[chunk.index] = chunk.block
          if (chunk.block.type === 'tool-call') calls.push(chunk.block)
        }
      }
    }
    if (finish?.reason.kind !== 'tool-calls' || calls.length === 0) {
      yield* chunks
      if (usage) yield { type: 'usage', usage }
      if (finish) yield finish
      return
    }
    messages.push(createAssistantMessage({
      content: blocks.filter(Boolean),
      source: {
        provider: options.provider,
        model: options.model,
        ...(finish.replayState === undefined ? {} : { replayState: finish.replayState }),
      },
    }))
    for (const call of calls) {
      options.signal?.throwIfAborted()
      const currentAllowed = await grants()
      let result: unknown
      if (remaining <= 0) {
        result = { refused: 'Plan step limit reached.' }
      } else if (!tools.some((tool) => tool.name === call.name) || !currentAllowed.includes(call.name)) {
        result = { refused: 'Tool is unavailable or not authorized in this session.' }
      } else {
        result = await execute(search, call)
      }
      remaining -= 1
      messages.push(createToolResultMessage({
        callId: call.id, isError: typeof result === 'object' && result !== null && 'refused' in result,
        content: [{ type: 'text', text: JSON.stringify(result) }],
      }))
    }
  }
  options.signal?.throwIfAborted()
  for await (const chunk of stream({ ...options, messages })) {
    if (chunk.type === 'usage') usage = addUsage(usage, chunk.usage)
    else {
      if (chunk.type === 'finish' && usage) yield { type: 'usage', usage }
      yield chunk
    }
  }
}
