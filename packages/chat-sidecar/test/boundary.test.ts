/**
 * sidecar 边界测试(P1–P2 保持):插件只声明接入边界,无路由/请求/Session/凭证访问。
 */

import { describe, expect, it } from 'vitest'
import { Config, name } from '../src/index.js'

// schemastery 的 schema 是可调用对象:调用即校验并应用默认值。
const schema = Config as unknown as (value: unknown) => { reservedPath: string }

describe('sidecar 接入边界', () => {
  it('插件名固定,配置默认保留独立路由前缀', () => {
    expect(name).toBe('chat-workspace-sidecar')
    const resolved = schema({})
    expect(resolved.reservedPath).toBe('/chat-workspace-sidecar')
    expect(resolved.reservedPath.startsWith('/chat-workspace/')).toBe(false)
  })

  it('显式前缀被保留(不与主组件冲突即可)', () => {
    const resolved = schema({ reservedPath: '/chat-ws-side' })
    expect(resolved.reservedPath).toBe('/chat-ws-side')
  })

  it('Config 校验拒绝非法前缀(无斜杠开头)', () => {
    expect(() => schema({ reservedPath: 'chat-workspace-sidecar' })).toThrow()
  })
})
