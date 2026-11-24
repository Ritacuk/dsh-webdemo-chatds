// @vitest-environment jsdom
/**
 * L3 设置区集成测试(R8.6 P0 回归网)。
 *
 * 用真实 React Runtime + 真实 client.js 手写工厂(不 mock 组件代码),只 mock:
 * - window.__ModuleLoader__(DSH 客户端模块装载器)
 * - ctx(用与 DSH 同形状的最小 slot/theme/layout 假件)
 * - fetch(用隔离实例抓到的真实 /api 响应形状)
 *
 * R8.5 教训:160 项单测全绿但"插件与工具"页渲染即 ReferenceError(busy 未定义),
 * 因没有任何测试真正渲染过设置页。本文件保证:八个设置页逐一点开、挂载、
 * 插件目录含畸形条目时跳过而非白屏、目录请求失败可手动重试且不做无限自动重试、
 * 任意一页渲染异常只降级该页而不拖垮设置区。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))

const React = require('react') as typeof import('react')
const ReactDOMClient = require('react-dom/client') as typeof import('react-dom/client')
const h = React.createElement
/** React 18.3 起 act 由 react 包导出;兜底走 react-dom/test-utils。 */
const act: (fn: () => unknown) => Promise<unknown> =
  (React as unknown as { act?: typeof act }).act ?? (require('react-dom/test-utils') as { act: typeof act }).act

const integrationsFixture = JSON.parse(readFileSync(join(here, 'fixtures/integrations.json'), 'utf8'))
const settingsFixture = JSON.parse(readFileSync(join(here, 'fixtures/settings.json'), 'utf8'))

/** jsdom 的 AbortSignal 无 .timeout 静态方法,client.js apiSend 用到;补一个直通桩。 */
const abortSignalCtor = (globalThis as unknown as { AbortSignal?: { timeout?: unknown } }).AbortSignal
if (abortSignalCtor && typeof abortSignalCtor.timeout !== 'function') {
  abortSignalCtor.timeout = () => undefined
}

const SESSION_ID = 'chatws-local-123e4567-e89b-42d3-a456-426614174000'

type FetchCall = { url: string; method: string; body: unknown }
type RouteHandler = (call: FetchCall) => unknown

interface Harness {
  container: HTMLDivElement
  fetchCalls: FetchCall[]
  setRoute: (prefix: string, handler: RouteHandler) => void
  clickNav: (label: string) => Promise<void>
  clickButton: (label: string) => Promise<void>
  /** 模拟主聊天 iframe 通知当前活动会话(ToolManager 以此取得 sessionId)。 */
  announceSession: () => Promise<void>
  text: () => string
  unmountAll: () => Promise<void>
}

const findButton = (h: Harness, label: string) => {
  const buttons = Array.from(h.container.querySelectorAll('button'))
  const match = buttons.filter((b) => (b.textContent ?? '').trim() === label || b.getAttribute('aria-label') === label)
  if (match.length !== 1) throw new Error(`按钮「${label}」匹配到 ${match.length} 个`)
  return match[0]
}

async function makeHarness(): Promise<Harness> {
  // ── 装载真实 client.js 工厂 ──
  const source = readFileSync(join(here, '../../client.js'), 'utf8')
  let mod: { id: string; factory: (req: NodeRequire) => { inject: string[]; apply: (ctx: unknown) => void } } | null = null
  ;(window as unknown as { __ModuleLoader__: unknown }).__ModuleLoader__ = {
    load(m: unknown) { mod = m as typeof mod },
  }
  new Function('window', source)(window)
  if (!mod) throw new Error('client.js 未注册到 __ModuleLoader__')

  // ── 最小 DSH 形状 ctx ──
  const registered = new Map<string, { config: Record<string, unknown>; component: (props: { close?: () => void }) => unknown }>()
  const ctx = {
    slots: {
      inject(name: string, prepare: () => unknown) { registered.set(name, prepare() as never) },
      register(config: Record<string, unknown>, component: (props: { close?: () => void }) => unknown) {
        return { config, component }
      },
    },
    theme: { getTheme: () => ({ active: { colorScheme: 'dark' } }) },
    on: () => () => {},
    // DSH 运行时语义:ctx.effect(fn, label) 立即执行 fn(注册行为发生在回调里)。
    effect: (fn?: () => unknown) => (typeof fn === 'function' ? fn() : undefined),
    inject: () => {},
    get: () => undefined,
    layout: { selectPanel: () => {} },
  }
  mod.factory(require).apply(ctx)
  const section = registered.get('settings.section')
  if (!section) throw new Error('settings.section 未注册')

  // ── 浏览器能力 stub(jsdom 缺失项) ──
  const media = () => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
  ;(window as unknown as { matchMedia: unknown }).matchMedia = media
  ;(globalThis as unknown as { matchMedia: unknown }).matchMedia = media
  const cssApi = { supports: () => true }
  ;(window as unknown as { CSS?: unknown }).CSS = cssApi
  ;(globalThis as unknown as { CSS?: unknown }).CSS = cssApi

  // ── fetch mock(默认路由用真实夹具形状) ──
  const fetchCalls: FetchCall[] = []
  const routes = new Map<string, RouteHandler>()
  const settings = { ...settingsFixture }
  routes.set('/api/settings', (call) => {
    if (call.method === 'PUT') { Object.assign(settings, call.body as object); return { ...settings } }
    return { ...settings }
  })
  routes.set('/api/integrations', () => JSON.parse(JSON.stringify(integrationsFixture)))
  routes.set('/api/models', () => ({ richModels: [{ name: 'DeepSeek Chat', model: 'deepseek-chat', capability: { nativeSearch: true, vision: true, thinkingEfforts: [] } }], genericProviders: [] }))
  routes.set('/api/prompts', () => ({ templates: [{ id: 't1', name: '模板', category: '通用', summary: '', body: '正文', tags: [] }] }))
  routes.set('/api/cost/today', () => ({ available: true, budgetMerged: { cap: 0.5, used: 0.01 }, budget: { cap: 0.5 } }))
  routes.set('/api/file-access', () => ({ dirs: [] }))
  routes.set('/api/partitions', () => ({ partitions: [] }))
  routes.set('/api/sessions/', (call) => {
    if (call.method === 'PUT') return { ok: true }
    return { supported: [{ name: 'chatds_search_files', enabled: true }, { name: 'chatds_read_files', enabled: false }] }
  })
  routes.set('/api/sessions', () => ({ sessions: [] }))
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
  ;(globalThis as unknown as { fetch: unknown }).fetch = (async (url: unknown, init?: { method?: string; body?: string }) => {
    const call: FetchCall = { url: String(url), method: (init?.method ?? 'GET').toUpperCase(), body: init?.body ? JSON.parse(init.body) : null }
    fetchCalls.push(call)
    for (const [prefix, handler] of routes) {
      if (call.url.includes(prefix)) {
        const value = handler(call)
        if (value instanceof Error) return json({ error: { message: value.message } }, 503)
        // { __raw: value } 直通:跳过 JSON 序列化/解析,让带活对象(如 Proxy 投毒)的响应保持原样。
        if (value && typeof value === 'object' && '__raw' in (value as Record<string, unknown>)) {
          const raw = (value as { __raw: unknown }).__raw
          return { ok: true, status: 200, json: async () => raw } as unknown as Response
        }
        return json(value)
      }
    }
    return json({ error: { message: 'not found: ' + call.url } }, 404)
  }) as never

  // 主聊天 iframe:必须在挂载前就位,ToolManager 的 effect 只查询一次。
  const frame = document.createElement('iframe')
  frame.setAttribute('data-chatds-main', '')
  document.body.appendChild(frame)

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  await act(async () => { root.render(section.component({ close: () => {} })) })

  const harness: Harness = {
    container,
    fetchCalls,
    setRoute: (prefix, handler) => routes.set(prefix, handler),
    clickNav: async (label) => { await act(async () => { findButton(harness, label).click() }) },
    clickButton: async (label) => { await act(async () => { findButton(harness, label).click() }) },
    announceSession: async () => {
      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', {
          source: frame.contentWindow,
          origin: window.location.origin,
          data: { type: 'chatds:active-session', id: SESSION_ID },
        }))
      })
      // 等待会话权限请求落地(权限载入后"正在读取会话权限…"消失)
      for (let i = 0; i < 50 && (harness.container.textContent ?? '').includes('正在读取会话权限…'); i += 1) {
        await act(async () => { await Promise.resolve() })
      }
    },
    text: () => container.textContent ?? '',
    unmountAll: async () => { await act(async () => { root.unmount() }) },
  }
  return harness
}

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  document.body.innerHTML = ''
})

const enabledSharing = {
  enabled: true,
  device: { id: '11111111-1111-4111-8111-111111111111', name: 'Windows', invite: 'invite', fingerprint: 'aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa', code: 'AAAA-BBBB' },
  peers: [{ id: '22222222-2222-4222-8222-222222222222', name: 'ritacuk-X99', fingerprint: 'bbbb bbbb bbbb bbbb bbbb bbbb bbbb bbbb', code: 'CCCC-DDDD', reachable: true, discovered: 'http://10.0.0.2:46830' }],
  lan: true, lanPort: 46830, lanAddresses: ['10.0.0.1'],
  discovery: { mechanism: 'mdns+multicast', published: true, browsing: true, devices: 1 },
  devices: [{ id: '22222222-2222-4222-8222-222222222222', name: 'ritacuk-X99', code: 'CCCC-DDDD', address: '10.0.0.2', port: 46830, endpoint: 'http://10.0.0.2:46830', paired: true }],
  interfaces: [{ name: 'eth0', address: '10.0.0.1', family: 'IPv4', scope: 'private', prefix: 24, eligible: true }],
  interfaceSelection: [],
  lanDetails: { port: 46830, addresses: ['10.0.0.1'], loopbackOnly: false,
    interfaces: [{ name: 'eth0', address: '10.0.0.1', family: 'IPv4', scope: 'private', prefix: 24, eligible: true }],
    candidates: [{ name: 'eth0', address: '10.0.0.1', family: 'IPv4', scope: 'private', prefix: 24, eligible: true },
      { name: 'vEthernet', address: '172.18.0.1', family: 'IPv4', scope: 'private', prefix: 16, eligible: false, reason: 'virtual-adapter' }],
    discovery: { mechanism: 'mdns+multicast', published: true, browsing: true, devices: 1 }, platform: 'linux' },
  firewall: { supported: true, elevated: false, profile: 'Private', rulePresent: false,
    hint: 'Windows blocked the inbound connection.', command: 'New-NetFirewallRule -DisplayName [0m"ChatDS"' },
  pairingCode: 'AAAA-BBBB', prekeys: { available: 32, consumed: 4 },
  policies: [], exclusions: [], pending: 0, running: false,
}

describe('R8.6 P0:ChatDS 设置区(真实 client.js + React 渲染)', () => {
  it('挂载后默认渲染常规页,无错误降级框', async () => {
    const h = await makeHarness()
    expect(h.text()).toContain('聊天界面语言')
    expect(h.container.querySelector('.chatds-settings-errorbox')).toBeNull()
    await h.unmountAll()
  })

  it('设置页逐一点开:每页都渲染内容且不出现错误边界降级(R8.5 崩溃回归)', async () => {
    const h = await makeHarness()
    for (const label of ['模型与接口', '提示词', '用量与费用', '插件与工具', '长期记忆', '原生能力', '聊天界面设计', '位置与隐私', '数据共享', '外观', '常规']) {
      await h.clickNav(label)
      expect(h.container.querySelector('.chatds-settings-errorbox'), `页面「${label}」出现错误降级框`).toBeNull()
      expect(h.text().length, `页面「${label}」渲染为空`).toBeGreaterThan(0)
    }
    await h.unmountAll()
  })

  it('外观页保存侧边栏标题、字号、颜色和字重，并支持单独恢复默认', async () => {
    const h = await makeHarness()
    await h.clickNav('外观')
    const input = (label: string) => h.container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
    const title = input('侧边栏标题')
    await act(async () => {
      title.focus()
      title.value = '  我的聊天  '
      title.blur()
    })
    for (const [label, value] of [['标题字号', '28'], ['标题颜色', '#ab1245']]) {
      await act(async () => {
        const field = input(label)
        field.value = value
        field.dispatchEvent(new Event('change', { bubbles: true }))
      })
    }
    await act(async () => {
      const weight = h.container.querySelector<HTMLSelectElement>('select[aria-label="标题字重"]')!
      weight.value = '700'
      weight.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await h.clickButton('恢复默认标题')
    expect(h.fetchCalls.filter((call) => call.method === 'PUT').map((call) => call.body)).toEqual([
      { sidebarTitle: '我的聊天' },
      { sidebarTitleSize: 28 },
      { sidebarTitleColor: '#ab1245' },
      { sidebarTitleWeight: 700 },
      { sidebarTitle: null, sidebarTitleSize: null, sidebarTitleColor: null, sidebarTitleWeight: null },
    ])
    await h.unmountAll()
  })

  it('插件与工具页:渲染真实集成目录,会话权限就绪后可切换授权开关(R8.5 ToolManager ReferenceError 回归)', async () => {
    const h = await makeHarness()
    await h.clickNav('插件与工具')
    expect(h.container.querySelectorAll('.chatds-bundle').length).toBe(integrationsFixture.bundles.length)
    expect(h.text()).toContain('打开一条 WebChat 会话后可授权。')
    // 模拟主聊天 iframe 通告活动会话 → 权限载入 → 开关可用
    await h.announceSession()
    expect(h.text()).not.toContain('打开一条 WebChat 会话后可授权。')
    const switches = h.container.querySelectorAll('button[role="switch"]:not(:disabled)')
    expect(switches.length).toBeGreaterThan(0)
    const putBefore = h.fetchCalls.filter((c) => c.method === 'PUT' && c.url.includes('/tools')).length
    await act(async () => { (switches[0] as HTMLButtonElement).click() })
    const putAfter = h.fetchCalls.filter((c) => c.method === 'PUT' && c.url.includes('/tools')).length
    expect(putAfter).toBe(putBefore + 1)
    await h.unmountAll()
  })

  it('单个插件条目畸形时跳过并提示,不影响其他条目', async () => {
    const h = await makeHarness()
    h.setRoute('/api/integrations', () => ({
      managementAvailable: true,
      bundles: [
        { name: 'bad-bundle', title: '畸形条目' }, // 缺 components
        ...JSON.parse(JSON.stringify(integrationsFixture.bundles)),
        'not-an-object' as unknown as object,
      ],
    }))
    await h.clickNav('插件与工具')
    expect(h.text()).toContain('已跳过 2 个无法解析的插件条目。')
    expect(h.container.querySelectorAll('.chatds-bundle').length).toBe(integrationsFixture.bundles.length)
    expect(h.container.querySelector('.chatds-settings-errorbox')).toBeNull()
    await h.unmountAll()
  })

  it('目录请求失败:显示错误与重试;自动重试 2 次后停止(共 3 次请求),手动重试恢复', async () => {
    vi.useFakeTimers()
    try {
      const h = await makeHarness()
      let attempts = 0
      h.setRoute('/api/integrations', () => { attempts += 1; throw new Error('目录服务不可用') })
      await h.clickNav('插件与工具')
      expect(attempts).toBe(1)
      expect(h.text()).toContain('目录服务不可用')
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      expect(attempts).toBe(2)
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      expect(attempts).toBe(3)
      await act(async () => { await vi.advanceTimersByTimeAsync(30000) })
      expect(attempts).toBe(3) // 连续失败 3 次后不再自动重试
      await h.clickButton('重试')
      expect(attempts).toBe(4) // 手动重试立即恢复一次请求
      await h.unmountAll()
    } finally {
      vi.useRealTimers()
    }
  })

  it('页面渲染异常被边界捕获:显示降级文案与诊断信息,其他页仍可切换', async () => {
    const h = await makeHarness()
    // components 是数组 Proxy,渲染期 .some/.map 访问即抛错(序列化不受影响)
    // → BundleCard 渲染抛错 → 条目级边界接管,该条目降级、其余条目与其他页不受影响。
    const poisonComponents = new Proxy(
      [{ id: 'c1', kind: 'local', title: '本地组件', description: '测试' }],
      { get(target, prop) {
          if (prop === 'some' || prop === 'map' || prop === 'filter') throw new Error('元数据访问失败')
          return Reflect.get(target, prop)
        } },
    )
    h.setRoute('/api/integrations', () => ({
      __raw: { managementAvailable: true, bundles: [{ name: 'poison-bundle', title: '投毒条目', description: '', components: poisonComponents }] },
    }))
    await h.clickNav('插件与工具')
    expect(h.text()).toContain('插件能力加载失败，可以重试或查看诊断信息。')
    expect(h.text()).toContain('诊断信息')
    // 其他设置页仍正常切换(导航未受影响)
    await h.clickNav('常规')
    expect(h.text()).toContain('聊天界面语言')
    await h.unmountAll()
  })
  it('数据共享启用态:渲染设备密码和网络诊断，并隐藏旧配对信息', async () => {
    const h = await makeHarness()
    const discovery = { mechanism: 'mdns+multicast', published: true, browsing: true, devices: 1 }
    const interfaces = [{ name: 'eth0', address: '10.0.0.1', family: 'IPv4', scope: 'private', prefix: 24, eligible: true }]
    h.setRoute('/api/sharing', (call) => call.method === 'POST' ? enabledSharing : enabledSharing)
    await h.clickNav('数据共享')
    expect(h.container.querySelector('.chatds-settings-errorbox')).toBeNull()
    expect(h.text()).toContain('加入已有设备')
    expect(h.text()).toContain('局域网网卡选择')
    expect(h.text()).toContain('Windows 防火墙与入站连接')
    expect(h.text()).not.toContain('可用预密钥 32 枚')
    expect(h.text()).not.toContain('AAAA-BBBB')
    expect(h.text()).toContain('ritacuk-X99')
    await h.unmountAll()
  })


  it('shows general data controls in their own view and lets users recheck a failed LAN listener', async () => {
    const h = await makeHarness()
    h.setRoute('/api/local-data', () => ({ sessions: 3, logBytes: 1024, attachmentBytes: 2048 }))
    expect(h.container.querySelector('.chatds-settings-group:not([hidden]) h2')?.textContent).toBe('基本偏好')
    await h.clickButton('数据管理')
    expect(h.container.querySelector('.chatds-settings-group:not([hidden])')?.textContent).toContain('3 个会话')
    h.setRoute('/api/sharing', () => ({ ...enabledSharing, lanEnabled: true, lan: false, lanState: 'unavailable' }))
    await h.clickNav('数据共享')
    expect(h.container.querySelector('.chatds-share-section:not([hidden]) h2')?.textContent).toBe('概览')
    expect(h.container.querySelector('.chatds-share-section:not([hidden])')?.textContent).toContain('局域网同步暂不可用')
    const recheck = Array.from(h.container.querySelectorAll<HTMLButtonElement>('.chatds-share-section:not([hidden]) button'))
      .find((button) => button.textContent === '重新检测网络')!
    await act(async () => recheck.click())
    expect(h.fetchCalls.some(({ body }) => (body as { action?: string } | null)?.action === 'lan-recheck')).toBe(true)
    const channels = Array.from(h.container.querySelectorAll<HTMLButtonElement>('.chatds-share nav button'))
      .find((button) => button.textContent === '同步通道')!
    await act(async () => channels.click())
    const toggle = h.container.querySelector('[role="switch"][aria-label="允许局域网设备连接本机"]')
    expect(toggle?.getAttribute('aria-checked')).toBe('true')
    expect(toggle?.textContent).toContain('开启')
    await h.unmountAll()
  })

})
