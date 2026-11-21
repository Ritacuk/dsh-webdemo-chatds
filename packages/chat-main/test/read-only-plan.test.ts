import { expect, it, vi } from 'vitest'
import { ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { streamReadOnlyPlan } from '../src/host/read-only-plan.js'
import type { LocalSearchEngine } from '../src/host/local-search.js'

it('lets the model choose two read-only actions and denies a terminal call at the budget boundary', async () => {
  const readSnippet = vi.fn(async () => ({ path: 'private path', content: 'result', truncated: false }))
  const search = vi.fn(async () => ({ hits: [{ relativePath: 'a.txt', dirId: 'allowed' }], truncated: false }))
  const local = { search, readSnippet } as unknown as LocalSearchEngine
  const requests: GenerateOptions[] = []
  const call = (name: string, args: object, index = 0): StreamChunk => ({
    type: 'block-end', index,
    block: { type: 'tool-call', name, id: ToolCallId(name), arguments: JSON.stringify(args) },
  })
  const stream = async function* (options: GenerateOptions): AsyncGenerator<StreamChunk> {
    requests.push({ ...options, messages: [...options.messages] })
    if (requests.length === 1) {
      yield call('chatds_search_files', { query: 'text' })
    } else if (requests.length === 2) {
      yield call('chatds_read_file', { dirId: 'allowed', relativePath: 'a.txt' })
      yield call('terminal', { command: 'unsafe' }, 1)
    }
    yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 1 } }
    yield { type: 'finish', reason: requests.length < 3 ? { kind: 'tool-calls' } : { kind: 'stop' } }
  }
  const output = []
  for await (const chunk of streamReadOnlyPlan(stream, { provider: 'mock', model: 'mock', messages: [] }, local, 2,
    async () => ['chatds_search_files', 'chatds_read_file'])) {
    output.push(chunk)
  }
  expect(search).toHaveBeenCalledExactlyOnceWith({ query: 'text', match: 'any' })
  expect(readSnippet).toHaveBeenCalledExactlyOnceWith({ dirId: 'allowed', relativePath: 'a.txt', startLine: 1, maxLines: 60 })
  expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual(['chatds_search_files', 'chatds_read_file'])
  expect(requests[1]?.messages.at(-1)).toMatchObject({ role: 'tool', isError: false })
  expect(requests[2]?.messages.at(-1)).toMatchObject({ role: 'tool', isError: true })
  expect(requests[2]?.tools).toBeUndefined()
  expect(output).toContainEqual({ type: 'usage', usage: expect.objectContaining({ inputTokens: 9, outputTokens: 3 }) })
})

it('checks a session grant again before executing a tool after revocation', async () => {
  const search = vi.fn()
  const requests: GenerateOptions[] = []
  let allowed = true
  const stream = async function* (request: GenerateOptions): AsyncGenerator<StreamChunk> {
    requests.push({ ...request, messages: [...request.messages] })
    if (requests.length === 1) {
      allowed = false
      yield { type: 'block-end', index: 0, block: {
        type: 'tool-call', name: 'chatds_search_files', id: ToolCallId('request-1'),
        arguments: JSON.stringify({ query: 'fixture' }),
      } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  for await (const _ of streamReadOnlyPlan(stream, { provider: 'mock', model: 'mock', messages: [] },
    { search } as unknown as LocalSearchEngine, 1, async () => allowed ? ['chatds_search_files'] : [])) {
    // Consume the stream to run the permission check.
  }
  expect(search).not.toHaveBeenCalled()
  expect(requests[1]?.messages.at(-1)).toMatchObject({ role: 'tool', isError: true })
})
