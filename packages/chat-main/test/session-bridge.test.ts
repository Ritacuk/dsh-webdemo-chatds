import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ChatDSSessionBridge, splitTranslation } from '../src/host/session-bridge.js'
import type { WorkspaceStore } from '../src/host/store.js'
import type { WorkspaceSessions } from '../src/host/sessions.js'
import type { ChatPartitionStore } from '../src/host/partitions.js'

function setup() {
  const data = new Map<string, Map<string, any>>()
  const table = (name: string) => {
    const values = data.get(name) ?? new Map()
    data.set(name, values)
    return {
      entries: () => values.entries(),
      get: (key: string) => values.get(key),
      put: async (key: string, value: unknown) => { values.set(key, value) },
      delete: async (key: string) => { values.delete(key) },
      update: async (key: string, patch: (value: unknown) => unknown) => { values.set(key, patch(values.get(key))) },
    }
  }
  const settings = { compatTitle: true, memoryExtract: false }
  const resolved = vi.fn((request) => ({ ...request, provider: request.provider ?? 'bing' }))
  const translate = vi.fn(async () => 'translated')
  const stream = vi.fn(async function* () {
    yield { type: 'block-end', block: { type: 'text', text: 'Fixture title' } }
  })
  const ctx = {
    get: (name: string) => name === 'translator' ? { maxTextChars: 20, resolve: resolved, translate } : undefined,
    llm: { stream }, logger: { warn: () => {} },
  }
  const store = { ensure: async () => ({ table }), getSettings: async () => settings, modelAllowed: async () => true }
  const events: unknown[] = []
  const sessions = { list: async () => [
    { id: 'chatws-local-visible', title: 'Garden fixture', updatedAt: 1000 },
    { id: 'session-native', title: 'Garden forbidden', updatedAt: 1000 },
  ], owns: (id: string) => id.startsWith('chatws-'), readEvents: async () => events }
  const partitions = { read: async () => ({ partitions: [{ id: 'partition', name: 'A' }], assignments: { 'chatws-local-visible': 'partition' } }) }
  const bridge = new ChatDSSessionBridge(ctx as unknown as Context, store as unknown as WorkspaceStore,
    sessions as unknown as WorkspaceSessions, partitions as unknown as ChatPartitionStore)
  return { bridge, table, settings, resolved, translate, stream, events }
}

describe('ChatDS detached session bridge', () => {
  it('splits complete text without slicing surrogate pairs', () => {
    const text = 'A'.repeat(17) + '🎧\n' + 'B'.repeat(35)
    const chunks = splitTranslation(text, 18)
    expect(chunks.join('')).toBe(text)
    expect(chunks.every((chunk) => chunk.length <= 18 && !/[\uD800-\uDBFF]$/.test(chunk))).toBe(true)
  })

  it('requires a visible owned conversation and confirmed provider before any text is sent', async () => {
    const { bridge, translate } = setup()
    const signal = new AbortController().signal
    expect(await bridge.translationOptions(signal)).toMatchObject({ available: true, provider: 'bing' })
    await expect(bridge.translate('chatws-local-visible', 'missing', 0, 'en-US', 'google', signal)).rejects.toMatchObject({ status: 409 })
    await expect(bridge.translate('session-native', 'missing', 0, 'en-US', 'bing', signal)).rejects.toMatchObject({ status: 404 })
    expect(translate).not.toHaveBeenCalled()
  })

  it('uses native translation for stored reasoning and reuses successful output on replay', async () => {
    const { bridge, events, translate } = setup()
    events.push({
      type: 'assistant/message', seq: 1, time: 1000, surfaceOp: 'append',
      data: { turn: 1, step: 1, stream: [], message: {
        id: 'reply', role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'fake' },
        content: [{ type: 'reasoning', text: 'Stored reasoning paragraph for the translator' }, { type: 'text', text: 'Final answer' }],
      } },
    })
    const signal = new AbortController().signal
    const id = 'chatws-local-visible'
    expect(await bridge.translate(id, 'reply', 0, 'en-US', 'bing', signal)).toMatchObject({ cached: false })
    expect(translate).toHaveBeenCalledTimes(3)
    expect(await bridge.translate(id, 'reply', 0, 'en-US', 'bing', signal)).toMatchObject({ cached: true })
    expect(translate).toHaveBeenCalledTimes(3)
  })

  it('scopes history and memory to visible conversations and selected partitions', async () => {
    const { bridge } = setup()
    const signal = new AbortController().signal
    expect((await bridge.search({ query: 'garden', partition: 'partition' }, signal)).hits.map(({ id }) => id)).toEqual(['chatws-local-visible'])
    const memory = await bridge.saveMemory({ text: 'A garden needs watering', category: 'notes', partition: 'partition' })
    expect(await bridge.memoryContext('chatws-local-visible', 'garden', 128)).toContain('garden')
    expect(await bridge.memoryContext('chatws-local-other', 'garden', 128)).toBe('')
    expect(await bridge.memoryContext('chatws-local-visible', 'garden', 2)).toBe('')
    await bridge.deleteMemory(memory.id)
    expect(await bridge.memories()).toEqual([])
  })

  it('runs a labeled optional title call, preserving manual titles', async () => {
    const { bridge, table, stream } = setup()
    const id = 'chatws-local-visible'
    await table('sessions').put(id, { title: 'fallback', updatedAt: 10, hidden: false })
    bridge.afterTurn({ id, prompt: 'Garden', provider: 'mock', model: 'fake' })
    await vi.waitFor(() => expect(table('sessions').get(id).title).toBe('Fixture title'))
    expect(stream).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'chatds-title', maxTokens: 64 }))
    await table('sessions').put(id, { title: 'Manual', manualTitle: 'Manual', updatedAt: 20, hidden: false })
    bridge.afterTurn({ id, prompt: 'Garden', provider: 'mock', model: 'fake' })
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(stream).toHaveBeenCalledTimes(1)
    expect(table('sessions').get(id).title).toBe('Manual')
    await bridge.dispose()
  })
  it('extracts memory only when explicitly enabled and labels the model call', async () => {
    const { bridge, table, settings, stream } = setup()
    const id = 'chatws-local-visible'
    await table('sessions').put(id, { title: 'fallback', updatedAt: 10, hidden: false })
    settings.compatTitle = false
    bridge.afterTurn({ id, prompt: 'Garden', provider: 'mock', model: 'fake' })
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(stream).not.toHaveBeenCalled()
    settings.memoryExtract = true
    bridge.afterTurn({ id, prompt: 'Garden', provider: 'mock', model: 'fake' })
    await vi.waitFor(async () => expect(await bridge.memories()).toEqual([
      expect.objectContaining({ source: id, partition: 'partition' }),
    ]))
    expect(stream).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'chatds-memory-extraction', maxTokens: 96 }))
    await bridge.dispose()
  })

})
