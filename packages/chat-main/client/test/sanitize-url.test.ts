import { describe, expect, it } from 'vitest'
import { sanitizeUrl } from '../src/services/markdown/sanitize-url.js'

describe('markdown 链接地址安全解析（R8.4 回归：LICENSE 假链接）', () => {
  it('相对路径（如 LICENSE）不补协议，返回 null 渲染为纯文本', () => {
    expect(sanitizeUrl('LICENSE')).toBeNull()
    expect(sanitizeUrl('docs/x.md')).toBeNull()
    expect(sanitizeUrl('README.zh-CN.md')).toBeNull()
  })
  it('裸域名补全 https://（上游 demo 行为保留）', () => {
    expect(sanitizeUrl('github.com')).toBe('https://github.com/')
    expect(sanitizeUrl('example.com/path')).toBe('https://example.com/path')
  })
  it('已有协议的 URL 原样规范化', () => {
    expect(sanitizeUrl('https://github.com/deepseek-ai/chat-demo')).toBe('https://github.com/deepseek-ai/chat-demo')
    expect(sanitizeUrl('http://example.com')).toBe('http://example.com/')
    expect(sanitizeUrl('mailto:a@b.c')).toBe('mailto:a@b.c')
  })
  it('危险协议拒绝', () => {
    expect(sanitizeUrl('javascript:alert(1)')).toBeNull()
    expect(sanitizeUrl('data:text/html,x')).toBeNull()
  })
  it('空串返回 null', () => {
    expect(sanitizeUrl('')).toBeNull()
  })
})
