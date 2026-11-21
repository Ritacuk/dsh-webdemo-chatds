import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { contextStatus, costPriceCatalog, costSession, costToday } from '../src/host/bridges.js'

const service = (value?: unknown) => ({ get: () => value }) as unknown as Context
const session = { id: 'chatws-test' } as Session

describe('optional plugin services', () => {
  it('reports missing and incompatible cost services without an amount', async () => {
    for (const ctx of [service(), service({ version: 'old' })]) {
      await expect(costToday(ctx)).resolves.toMatchObject({ available: false })
      await expect(costSession(ctx, session.id)).resolves.toMatchObject({ available: false })
    }
  })

  it('contains both synchronous and asynchronous plugin errors', async () => {
    const ctx = service({
      getDaySessions() { throw new Error('sync failure') },
      async getSessionCost() { throw new Error('async failure') },
      getPriceCatalog() { throw new Error('incompatible service') },
    })
    await expect(costToday(ctx)).resolves.toMatchObject({ available: false })
    await expect(costSession(ctx, session.id)).resolves.toMatchObject({ available: false })
    await expect(costPriceCatalog(ctx)).resolves.toMatchObject({ available: false })
  })

  it('does not show an amount for an empty or unpriced daily ledger', async () => {
    for (const calls of [0, 1]) {
      const state = await costToday(service({ getDaySessions: () => ({ calls, input: 0, output: 0, cost: 0 }) }))
      expect(state.available).toBe(true)
      expect(state.cost).toBeUndefined()
    }
  })

  it('does not mistake found:false for a session bill', async () => {
    const data = { found: false, own: { calls: 0, cost: 0 } }
    await expect(costSession(service({ getSessionCost: () => data }), session.id)).resolves.toMatchObject({ available: false })
  })

  it('distinguishes a missing, throwing, or unpublished context projection', () => {
    expect(contextStatus(service(), session).available).toBe(false)
    expect(contextStatus(service({ snapshot: () => ({ values: {} }) }), session).available).toBe(false)
    expect(contextStatus(service({ snapshot() { throw new Error('projection error') } }), session).available).toBe(false)
    const valid = service({ snapshot: () => ({ values: { contextTimeline: { current: { total: 150 } } } }) })
    expect(contextStatus(valid, session)).toEqual({ available: true, sessionId: session.id, usage: { total: 150 } })
  })
})
