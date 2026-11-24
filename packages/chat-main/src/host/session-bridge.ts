import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@dsh-chat/shared'
import type { ChatPartitionStore } from './partitions.js'
import { replayChatSession, type WorkspaceSessions } from './sessions.js'
import type { WorkspaceStore } from './store.js'

declare module '@deepseek-ai/dsh-llm' {
  interface LlmRequestPurposeMap {
    'chatds-title': true
    'chatds-memory-extraction': true
  }
}

type Provider = 'bing' | 'google'
type TranslationRequest = { text: string; targetLanguage: string; provider: Provider }
type Translator = {
  maxTextChars: number
  resolve(request: TranslationRequest): unknown
  translate(spec: unknown, signal: AbortSignal): Promise<string>
}
type TranslationSettings = {
  limits(signal: AbortSignal): Promise<{ preferences: { provider: string; targetLanguage: string } }>
}

export function messageText(message: Message): string {
  if (message.role === 'user') return message.content
  if (message.stopReason === 'refusal') return ''
  return message.blocks.flatMap((block) => block.type === 'text' && !block.isTemplate ? [block.text] : []).join('\n')
}

export function splitTranslation(text: string, max: number): string[] {
  const chunks: string[] = []
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + max)
    if (end < text.length) {
      const boundary = text.lastIndexOf('\n', end - 1) + 1
      if (boundary > start + max / 2) end = boundary
      if (/[\uD800-\uDBFF]/.test(text[end - 1]!)) end--
    }
    chunks.push(text.slice(start, end))
    start = end
  }
  return chunks
}

export class BridgeError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

export class ChatDSSessionBridge {
  private readonly auxiliary = new Map<string, AbortController>()
  private readonly auxiliaryTasks = new Set<Promise<void>>()
  private readonly translationAbort = new AbortController()
  private translating = 0
  private searching = 0
  constructor(
    private readonly ctx: Context,
    private readonly store: WorkspaceStore,
    private readonly sessions: WorkspaceSessions,
    private readonly partitions: ChatPartitionStore,
  ) {}

  private translator(): Translator | undefined {
    const candidate = this.ctx.get('translator' as never) as Translator | undefined
    return typeof candidate?.resolve === 'function' && typeof candidate.translate === 'function' ? candidate : undefined
  }

  async translationOptions(signal: AbortSignal) {
    const translator = this.translator()
    if (!translator) return { available: false as const, reason: 'Enable the DSH reasoning translation plugin.' }
    const cot = this.ctx.get('cotTranslation' as never) as TranslationSettings | undefined
    const preferences = typeof cot?.limits === 'function' ? (await cot.limits(signal)).preferences : undefined
    const configured = preferences?.provider
    if (configured && configured !== 'bing' && configured !== 'google') {
      return { available: false as const, reason: 'The configured paid translator requires a managed DSH Session. Choose Bing or Google in DSH.' }
    }
    const resolved = translator.resolve({ text: ' ', targetLanguage: 'en',
      ...(configured ? { provider: configured } : {}) } as TranslationRequest) as { provider?: string }
    if (resolved.provider !== 'bing' && resolved.provider !== 'google') {
      return { available: false as const, reason: 'Configure a free DSH translation provider.' }
    }
    return { available: true as const, provider: resolved.provider as Provider, language: preferences?.targetLanguage || 'auto' }
  }

  async translate(id: string, messageId: string, span: number, locale: string, providerConsent: string, caller: AbortSignal) {
    const signal = AbortSignal.any([caller, this.translationAbort.signal, AbortSignal.timeout(60_000)])
    const translator = this.translator()
    const options = await this.translationOptions(signal)
    if (!translator || !options.available) throw new BridgeError(503, options.available ? 'Translation unavailable.' : options.reason)
    if (providerConsent !== options.provider) throw new BridgeError(409, 'The translation provider changed. Confirm the new provider.')
    if (!this.sessions.owns(id) || !(await this.sessions.list()).some((row) => row.id === id)) {
      throw new BridgeError(404, 'ChatDS conversation not found.')
    }
    const events = await this.sessions.readEvents(id)
    const message = events && replayChatSession(events).messages.find((item) => item.id === messageId)
    const thinking = message?.role === 'assistant' && message.status !== 'pending' && message.stopReason !== 'refusal'
      ? message.blocks.filter((block) => block.type === 'thinking')[span]?.thinking : undefined
    if (!thinking || thinking.length > 100_000) throw new BridgeError(404, 'Available reasoning paragraph not found.')
    const targetLanguage = options.language === 'auto' ? locale : options.language
    const cacheKey = createHash('sha256').update(JSON.stringify([id, messageId, span, options.provider, targetLanguage, thinking])).digest('hex')
    const table = (await this.store.ensure()).table('reasoning_translations')
    const hit = table.get(cacheKey)
    if (hit) return { text: hit.text, cached: true }
    if (this.translating >= 3) throw new BridgeError(429, 'Too many translations are running. Retry in a moment.')
    this.translating++
    try {
      const limit = Math.min(4500, translator.maxTextChars)
      if (!Number.isSafeInteger(limit) || limit < 16) throw new BridgeError(503, 'Unsupported translator limit.')
      const parts: string[] = []
      for (const text of splitTranslation(thinking, limit)) {
        signal.throwIfAborted()
        if (!text.trim()) { parts.push(text); continue }
        const spec = translator.resolve({ text, provider: options.provider, targetLanguage })
        parts.push(await translator.translate(spec, signal))
      }
      const text = parts.join('\n')
      signal.throwIfAborted()
      if (text.length > 500_000) throw new BridgeError(502, 'The translation is too long.')
      if ([...table.entries()].length < 2000) await table.put(cacheKey, { text })
      return { text, cached: false }
    } finally { this.translating-- }
  }

  async search(options: { query: string; partition?: string; from?: number; to?: number }, signal: AbortSignal) {
    if (this.searching >= 2) throw new BridgeError(429, 'Too many searches are running.')
    this.searching++
    try {
      const query = options.query.toLowerCase()
      const { assignments } = await this.partitions.read()
      const rows = (await this.sessions.list()).filter((row) => this.sessions.owns(row.id) &&
        (options.partition === undefined || (assignments[row.id] ?? '') === options.partition))
      const hits: { id: string; title: string; messageId?: string; excerpt: string; at: number }[] = []
      const inRange = (at: number) => (options.from === undefined || options.from <= at)
        && (options.to === undefined || at <= options.to)
      let truncated = rows.length > 250
      for (const row of rows.slice(0, 250)) {
        signal.throwIfAborted()
        if (inRange(row.updatedAt) && row.title.toLowerCase().includes(query)) hits.push({ id: row.id, title: row.title, excerpt: '', at: row.updatedAt })
        const events = await this.sessions.readEvents(row.id)
        if (events) {
          for (const message of replayChatSession(events).messages) {
            if (!inRange(message.createdAt)) continue
            const content = messageText(message)
            const index = content.toLowerCase().indexOf(query)
            if (index >= 0) hits.push({ id: row.id, title: row.title, messageId: message.id,
              excerpt: content.slice(Math.max(0, index - 75), index + query.length + 100), at: message.createdAt })
            if (hits.length >= 50) break
          }
        }
        if (hits.length >= 50) { truncated = true; break }
      }
      return { hits, truncated }
    } finally { this.searching-- }
  }

  async memories() { return [...(await this.store.ensure()).table('memories').entries()].map(([, value]) => value) }

  async saveMemory(input: { id?: string; text: string; category: string; partition: string | null; source?: string }) {
    const { partitions } = await this.partitions.read()
    if (input.partition && !partitions.some((entry) => entry.id === input.partition)) throw new BridgeError(400, 'Unknown ChatDS partition.')
    const table = (await this.store.ensure()).table('memories')
    const previous = input.id ? table.get(input.id) : undefined
    if (input.id && !previous) throw new BridgeError(404, 'Memory not found.')
    if (!previous && [...table.entries()].length >= 1000) throw new BridgeError(409, 'The local memory limit was reached.')
    const value = { id: previous?.id ?? randomUUID(), text: input.text, category: input.category,
      partition: input.partition, source: previous?.source ?? input.source, updatedAt: Date.now() }
    await table.put(value.id, value)
    return value
  }

  async deleteMemory(id: string) {
    await (await this.store.ensure()).table('memories').delete(id)
  }

  async memoryContext(sessionId: string, prompt: string, budget: number): Promise<string> {
    const { assignments } = await this.partitions.read()
    const partition = assignments[sessionId]
    const words = new Set([...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(prompt.toLowerCase())]
      .filter((word) => word.isWordLike && word.segment.length >= 2).map((word) => word.segment))
    const relevant = (await this.memories()).flatMap((entry) => {
      if (entry.partition !== null && entry.partition !== partition) return []
      const text = entry.text.toLowerCase()
      const score = [...words].filter((word) => text.includes(word)).length
      return score ? [{ entry, score }] : []
    }).sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt)
    let result = ''
    for (const { entry } of relevant.slice(0, 8)) {
      const line = JSON.stringify(entry.text) + '\n'
      if (Buffer.byteLength(result + line) <= budget) result += line
    }
    return result
  }

  cancelAuxiliary(id: string) { this.auxiliary.get(id)?.abort() }

  afterTurn(input: { id: string; prompt: string; provider?: string; model: string }) {
    this.cancelAuxiliary(input.id)
    if (this.auxiliary.size >= 4 || !input.provider || !input.prompt.trim()) return
    const controller = new AbortController()
    this.auxiliary.set(input.id, controller)
    const task = this.runAuxiliary(input, input.provider, controller.signal)
      .catch(() => { if (!controller.signal.aborted) this.ctx.logger.warn('[ChatDS] Optional title or memory operation failed.') })
      .finally(() => {
        if (this.auxiliary.get(input.id) === controller) this.auxiliary.delete(input.id)
        this.auxiliaryTasks.delete(task)
      })
    this.auxiliaryTasks.add(task)
  }

  private async runAuxiliary(input: { id: string; prompt: string; model: string }, provider: string, cancellation: AbortSignal) {
    const settings = await this.store.getSettings({})
    if (!settings.compatTitle && !settings.memoryExtract) return
    const table = (await this.store.ensure()).table('sessions')
    const before = table.get(input.id)
    if (!before || before.hidden || !await this.store.modelAllowed({ channel: 'generic', provider, model: input.model })) return
    const signal = AbortSignal.any([cancellation, AbortSignal.timeout(25_000)])
    const ask = async (purpose: 'chatds-title' | 'chatds-memory-extraction', system: string, maxTokens: number, text: string) => {
      signal.throwIfAborted()
      const stream = this.ctx.llm.stream({ provider, model: input.model, maxTokens, signal, system, purpose, messages: [
        createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
      ] })
      let response = ''
      for await (const part of stream) {
        if (part.type === 'block-end' && part.block.type === 'text') response += part.block.text
      }
      signal.throwIfAborted()
      return response.trim()
    }
    if (settings.compatTitle && !before.manualTitle) {
      const data = JSON.stringify({ title: before.compatTitle, latestPrompt: input.prompt.slice(0, 2000) })
      const title = (await ask('chatds-title',
        'Return a short title in the input language on one line. If the current title still describes the conversation, return SAME.',
        64, data)).split('\n')[0]?.trim().slice(0, 80)
      if (title && title !== 'SAME' && (await this.store.getSettings({})).compatTitle) {
        await table.update(input.id, (current) => current.hidden || current.manualTitle || current.updatedAt !== before.updatedAt || signal.aborted
          ? current : { ...current, title, compatTitle: title })
      }
    }
    if (settings.memoryExtract && (await this.store.getSettings({})).memoryExtract) {
      const text = await ask('chatds-memory-extraction',
        'Extract one explicitly stated durable user preference or fact. Omit secrets and sensitive information. Return NONE if absent. Otherwise return only the short memory.',
        96, input.prompt.slice(0, 2000))
      if (text && text.toUpperCase() !== 'NONE' && text.length <= 600 && !signal.aborted
        && !(await this.memories()).some((entry) => entry.text === text)) {
        const { assignments } = await this.partitions.read()
        if (!signal.aborted && (await this.store.getSettings({})).memoryExtract) await this.saveMemory({ text, category: 'Extracted', partition: assignments[input.id] ?? null, source: input.id })
      }
    }
  }

  async dispose() {
    this.translationAbort.abort()
    for (const controller of this.auxiliary.values()) controller.abort()
    await Promise.allSettled(this.auxiliaryTasks)
  }
}
