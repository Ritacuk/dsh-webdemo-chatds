import { describe, expect, it } from 'vitest'
import { createDemoReminder, demoServerTools } from '../src/host/demo-reminder.js'

describe('pinned chat-demo Messages request', () => {
  it('uses the client calendar around midnight', () => {
    const instant = new Date('2026-11-18T17:15:00.000Z')
    expect(createDemoReminder('zh-CN', 'Asia/Shanghai', instant)).toBe('2026-11-19,星期四,,Web,中文')
    expect(createDemoReminder('en-US', 'UTC', instant)).toBe('2026-11-18,Wednesday,,Web,English')
    expect(createDemoReminder('en-US', 'not-a-time-zone', instant))
      .toBe(createDemoReminder('en-US', undefined, instant))
  })

  it('keeps URL reading available with search off and matches Demo tool order', () => {
    const read = { type: 'deepseek_read_url', name: 'deepseek_read_url' }
    const search = { type: 'deepseek_web_search', name: 'deepseek_web_search' }
    expect(demoServerTools(false)).toEqual([read])
    expect(demoServerTools(true)).toEqual([read, search])
  })
})
