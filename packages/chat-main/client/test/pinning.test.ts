import { beforeEach, expect, it, vi } from 'vitest'
import type { WireSessionSummary } from '@dsh-chat/shared'
import { api } from '../src/services/api.js'
import { refreshSessions, setSessionPinned, useChatStore } from '../src/store/workspace.js'
import { groupSessions } from '../src/services/chat/sessionGroups.js'

const now = new Date(2026, 10, 23, 12).getTime()
const make = (id: string, days: number): WireSessionSummary => ({
  id, title: id, createdAt: now - days * 86400_000, updatedAt: now - days * 86400_000, messageCount: 2,
})
const sessions = [make('today', 0), make('recent', 2), make('older', 10), make('oldest', 11)]
beforeEach(() => {
  vi.restoreAllMocks()
  useChatStore.setState({ sessions, activeId: 'recent', pinPending: {} })
})

it('keeps pinned and time groups stable while suppressing a duplicate pending click', async () => {
  let resolve!: () => void
  const pin = vi.spyOn(api, 'setPinned').mockReturnValueOnce(new Promise((done) => { resolve = () => done({ ok: true }) }))
    .mockResolvedValue({ ok: true })
  const pending = setSessionPinned('older', true)
  await setSessionPinned('older', false)
  await setSessionPinned('today', true)
  expect(pin.mock.calls).toEqual([['older', true], ['today', true]])
  expect(useChatStore.getState().pinPending.older).toBe(true)
  const groups = groupSessions(useChatStore.getState().sessions, now)
  expect(groups[0]?.sessions.map(({ id }) => id)).toEqual(['today', 'older'])
  expect(new Set(groups.map(({ key }) => key)).size).toBe(groups.length)
  resolve()
  await pending
  await setSessionPinned('older', false)
  expect(useChatStore.getState().sessions.find(({ id }) => id === 'older')).toEqual({ ...sessions[2], pinned: false })
  expect(useChatStore.getState().activeId).toBe('recent')
})

it('rolls back rejected writes and ignores a response that began before a successful pin', async () => {
  let finishList!: () => void
  vi.spyOn(api, 'listSessions').mockReturnValue(new Promise((done) => { finishList = () => done({ sessions }) }))
  vi.spyOn(api, 'setPinned').mockRejectedValueOnce(new Error('storage unavailable')).mockResolvedValue({ ok: true })
  await expect(setSessionPinned('today', true)).rejects.toThrow('storage unavailable')
  expect(useChatStore.getState().sessions[0]?.pinned).toBe(false)
  const refreshing = refreshSessions()
  await setSessionPinned('today', true)
  finishList()
  await refreshing
  expect(useChatStore.getState().sessions[0]?.pinned).toBe(true)
})
