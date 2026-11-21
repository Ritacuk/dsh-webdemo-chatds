/**
 * dsh-chat-workspace-main — Web 客户端入口(D1 桌面集成,R8 设置重构)。
 *
 * 只做官方支持的事:
 * - 在 DSH 左侧导航注册一个全局面板入口,面板主区用同源 iframe 承载插件聊天页面;
 * - 在 DSH 原生设置注册 ChatDS 设置区(常规/模型/提示词/用量与费用/插件与工具/文件/外观);
 * - 转发聊天页 postMessage(打开设置/打开工作分支会话)。
 *
 * 聊天页面是独立构建的 React SPA(官方 chat-demo 蓝本),与 DSH 通过插件 Host 路由
 * (同源 iframe + 官方鉴权 cookie)通信。本文件是手写 CJS 工厂(不参与 rspack 构建),
 * 按 dsh-client-modules 的 `window.__ModuleLoader__.load({ id, factory })` 协议注册。
 */
window.__ModuleLoader__.load({
  id: 'dsh-webdemo-chatds',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 导航行的面板 id(与 Host 默认 pagePath 对应)。 */
    const PANEL_ID = 'chat-workspace'
    /** 聊天页面路径(Host 插件行 Config 的 pagePath 默认值 /chat-workspace)。 */
    const PAGE_PATH = '/chat-workspace'
    let pendingDataAction = null

    /** 主面板:同源 iframe 撑满主区,保留聊天 SPA 的完整能力与样式隔离。 */
    function ChatWorkspacePanel({ theme }) {
      const frame = React.useRef(null)
      React.useEffect(() => {
        const element = frame.current
        if (!element) return
        const sendTheme = () => element.contentWindow?.postMessage({ type: 'chatds:theme', mode: theme.getTheme().active.colorScheme }, location.origin)
        const stop = theme.subscribe(sendTheme)
        const ready = (event) => {
          if (event.origin !== location.origin || event.source !== element.contentWindow) return
          if (event.data?.type === 'chatds:ready' && pendingDataAction) {
            element.contentWindow.postMessage({ type: 'chatds:data', action: pendingDataAction }, location.origin)
            pendingDataAction = null
          }
          if (event.data?.type === 'chatds:pick-work-branch-directory' && typeof event.data.id === 'string') {
            void pickWorkBranchDirectory(event.source, event.data.id)
          }
          if (event.data?.type === 'chatds:save-download') void saveDesktopDownload(event.source, event.data)
        }
        window.addEventListener('message', ready)
        element.addEventListener('load', sendTheme)
        sendTheme()
        return () => { window.removeEventListener('message', ready); element.removeEventListener('load', sendTheme); stop() }
      }, [theme])
      return h(
        'div',
        { style: { height: '100%', minHeight: 0, display: 'flex' } },
        h('iframe', {
          ref: frame,
          'data-chatds-main': '',
          src: PAGE_PATH,
          title: 'WebChat',
          // 复制按钮需要剪贴板写权限(同源 iframe 的默认策略之外显式声明)。
          allow: 'clipboard-write; microphone',
          style: {
            border: 0,
            display: 'block',
            flex: '1 1 auto',
            width: '100%',
            height: '100%',
            background: 'var(--dsw-specific-sidebar-fill, Canvas)',
          },
        }),
      )
    }

    async function pickWorkBranchDirectory(frame, id) {
      const post = (data) => frame.postMessage({ type: 'chatds:work-branch-directory-result', id, ...data }, location.origin)
      try {
        const picker = window.__DSH_DIRECTORY_PICKER__
        if (typeof picker?.pick !== 'function') throw new Error('当前 DSH Desktop 无法打开文件夹选择器。')
        post({ path: await picker.pick() })
      } catch (error) {
        post({ error: error instanceof Error ? error.message : '无法打开文件夹选择器。' })
      }
    }

    async function saveDesktopDownload(frame, { id, blob, name }) {
      if (typeof id !== 'string' || !(blob instanceof Blob) || blob.size > 70 * 1024 * 1024 ||
          typeof name !== 'string' || !/^webchat-[a-z0-9-]+\.(zip|json|md|jpe?g|png|webp|gif|pdf|txt|csv|docx|xlsx|pptx|bin)$/.test(name)) return
      const post = (status, error) => frame.postMessage({ type: 'chatds:save-download-result', id, status, error }, location.origin)
      const actions = window.dshDesktop?.fileActions
      if (typeof actions?.save !== 'function') {
        post('error', 'DSH 文件保存服务不可用。')
        return
      }
      const url = URL.createObjectURL(blob)
      try {
        const result = await actions.save({ url, name, mediaType: blob.type, mode: 'saveAs' })
        post(result.status)
      } catch {
        post('error', '无法在 DSH Desktop 保存文件。')
      } finally {
        URL.revokeObjectURL(url)
      }
    }

    /** 侧栏图标。 */
    function ChatWorkspaceIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 16
      return h('img', { src: PAGE_PATH + '/assets/webchat-icon.svg', width: size, height: size, alt: '', style: { display: 'block' } })
    }

    // ────────────────────────── R8 设置(全部经 Host 插件路由,Profile 隔离) ──────────────────────────

    async function apiGet(path) {
      const response = await fetch(PAGE_PATH + path, { cache: 'no-store' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error?.message ?? '请求失败(' + response.status + ')')
      return data
    }
    async function apiSend(path, method, body) {
      const response = await fetch(PAGE_PATH + path, {
        method, signal: AbortSignal.timeout(20000), headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error?.message ?? '请求失败(' + response.status + ')')
      return data
    }
    const settingsGet = () => apiGet('/api/settings')
    const settingsPut = (patch) => apiSend('/api/settings', 'PUT', patch)

    /** 模型引用唯一键(与 Host WorkspaceStore.modelKey 一致)。 */
    const modelKey = (ref) => `${ref.channel}:${ref.provider ?? ''}:${ref.model}`
    const sameKey = (ref, key) => modelKey(ref) === key

    function broadcastSettings() {
      try {
        const channel = new BroadcastChannel('chatds:settings')
        channel.postMessage('changed')
        channel.close()
      } catch { /* 无 BroadcastChannel 时由下次加载兜底 */ }
    }

    const chatDSSettingsStyles = `
      .chatds-settings { display:grid; gap:20px; max-width:760px; min-width:0; font-size:14px; color:var(--dsw-alias-label-primary,CanvasText) }
      .chatds-settings nav { display:flex; gap:4px; overflow:auto; white-space:nowrap; padding:2px; scrollbar-width:thin }
      .chatds-settings button,.chatds-settings select,.chatds-settings input,.chatds-settings textarea { font:inherit; color:inherit; min-height:32px; padding:0 10px; border-radius:8px; border:1px solid var(--dsw-alias-border-l2,#8884); background:var(--dsw-specific-input-major,Canvas); box-sizing:border-box }
      .chatds-settings textarea { padding:8px 10px; width:100%; min-height:96px; resize:vertical; line-height:1.5 }
      .chatds-settings nav button { background:transparent; border-color:transparent; flex:none }
      .chatds-settings nav button[aria-pressed=true],.chatds-settings button:not(:disabled):hover { background:var(--dsw-alias-interactive-bg-hover,#8882) }
      .chatds-settings :focus-visible { outline:2px solid currentColor; outline-offset:2px }
      .chatds-settings-card { border:1px solid var(--dsw-alias-border-l2,#8884); border-radius:14px; padding:0 16px }
      .chatds-settings-card > p { margin:16px 0 }
      .chatds-settings-row { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:14px 0; overflow-wrap:anywhere }
      .chatds-settings-row + .chatds-settings-row { border-top:1px solid var(--dsw-alias-border-l2,#8884) }
      .chatds-settings-row > div { min-width:0 }
      .chatds-settings-label { font-weight:500 }
      .chatds-settings small { color:var(--dsw-alias-label-secondary,#777); font-size:12px }
      .chatds-settings select,.chatds-settings input[type=number],.chatds-settings input[type=search] { width:160px; max-width:46%; box-sizing:border-box }
      .chatds-settings button:disabled,.chatds-settings select:disabled,.chatds-settings input:disabled,.chatds-settings textarea:disabled { opacity:.55 }
      .chatds-settings button.chatds-settings-switch { display:flex; flex:0 0 34px; min-height:20px; padding:2px; border:0; border-radius:999px; background:#858b97; align-items:center }
      .chatds-settings button.chatds-settings-switch[aria-checked=true] { background:#3b64ed }
      .chatds-settings-switch span { width:16px; height:16px; border-radius:50%; background:white; transition:transform 120ms ease }
      .chatds-settings-switch[aria-checked=true] span { transform:translateX(14px) }
      .chatds-model-toolbar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:12px 0; border-bottom:1px solid var(--dsw-alias-border-l2,#8884) }
      .chatds-model-toolbar input[type=search] { flex:1 1 140px; max-width:none }
      .chatds-scope { display:flex; gap:0; border:1px solid var(--dsw-alias-border-l2,#8884); border-radius:8px; overflow:hidden }
      .chatds-scope button { border:0; border-radius:0; background:transparent; min-height:28px }
      .chatds-scope button[aria-pressed=true] { background:var(--dsw-alias-interactive-bg-hover,#8882); font-weight:600 }
      .chatds-model-group { padding:6px 0 }
      .chatds-model-group > button { background:transparent; border:0; width:100%; text-align:start; padding:8px 0; font-weight:600; display:flex; gap:8px; align-items:center }
      .chatds-model-row { display:flex; align-items:center; gap:10px; padding:8px 0; border-top:1px solid var(--dsw-alias-border-l2,#8884); min-width:0 }
      .chatds-model-row:first-of-type { border-top:0 }
      .chatds-model-name { min-width:0; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
      .chatds-model-name small { color:var(--dsw-alias-label-secondary,#777); margin-left:6px; font-size:11px }
      .chatds-chip { flex:none; font-size:11px; padding:1px 8px; border-radius:99px; border:1px solid var(--dsw-alias-border-l2,#8884); color:var(--dsw-alias-label-secondary,#777) }
      .chatds-chip[data-tone=brand] { color:#3b64ed; border-color:#3b64ed66 }
      .chatds-mini { flex:none; min-height:26px; padding:0 8px; font-size:12px }
      .chatds-star { background:transparent; border:0; padding:2px 4px; font-size:14px; line-height:1; cursor:pointer; opacity:.45 }
      .chatds-star[aria-pressed=true] { opacity:1; color:#e0a10f }
      .chatds-tool-row { display:flex; align-items:flex-start; gap:10px; padding:12px 0; border-top:1px solid var(--dsw-alias-border-l2,#8884) }
      .chatds-tool-row:first-of-type { border-top:0 }
      .chatds-tool-main { min-width:0; flex:1 }
      .chatds-tool-main code { font-size:12px; color:var(--dsw-alias-label-secondary,#777) }
      .chatds-details summary { cursor:pointer; margin:12px 0; color:var(--dsw-alias-label-secondary,#777) }
      .chatds-details pre { font-size:11px; overflow:auto; max-height:180px; background:var(--dsw-specific-input-major,Canvas); border:1px solid var(--dsw-alias-border-l2,#8884); border-radius:8px; padding:8px }
      .chatds-template-row { display:flex; align-items:center; gap:8px; padding:10px 0; border-top:1px solid var(--dsw-alias-border-l2,#8884) }
      .chatds-template-row:first-of-type { border-top:0 }
      .chatds-template-main { min-width:0; flex:1 }
      .chatds-template-body { margin:0; white-space:pre-wrap; font-size:12px; color:var(--dsw-alias-label-secondary,#777); max-height:64px; overflow:hidden }
      .chatds-status { padding:10px 0; font-size:12px; color:var(--dsw-alias-label-secondary,#777); min-height:34px }
      .chatds-settings h2 { font-size:18px; margin:16px 0 8px }
      .chatds-settings h3 { font-size:14px; margin:16px 0 8px }
      .chatds-status[data-tone=error] { color:#d03050 }
      .chatds-bundle { border:1px solid var(--dsw-alias-border-l2,#8884); border-radius:12px; margin:12px 0; padding:0 12px }
      .chatds-bundle > summary { padding:12px 0; cursor:pointer }
      .chatds-bundle summary > :is(img,strong,small) { margin-inline:4px; vertical-align:middle }
      .chatds-component + .chatds-component { border-top:1px solid var(--dsw-alias-border-l2,#8884) }
      .chatds-preview-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(132px,1fr)); gap:8px; margin-bottom:12px }
      .chatds-settings button.chatds-preview { display:grid; gap:8px; text-align:left; padding:8px; min-width:0 }
      .chatds-settings button.chatds-preview[aria-pressed=true] { border-color:var(--preview-accent); outline:1px solid var(--preview-accent); outline-offset:1px }
      .chatds-preview-chat { display:grid; gap:5px; padding:8px; min-height:85px; border-radius:6px; font-size:11px; color:#25282d; background:#fff }
      .chatds-preview[data-dark=true] .chatds-preview-chat { background:#262729; color:#f3f1ec }
      .chatds-preview-chat span:first-child { justify-self:end; padding:3px 6px; border-radius:10px; background:color-mix(in srgb,var(--preview-accent) 22%,transparent) }
      .chatds-preview-chat span:last-child { border:1px solid currentColor; border-radius:7px; padding:3px }
      .chatds-preview[data-style=gemini] .chatds-preview-chat { background-image:radial-gradient(ellipse at top,color-mix(in srgb,var(--preview-accent) 20%,transparent),transparent) }
      .chatds-preview[data-style=claude] .chatds-preview-chat { font-family:Georgia,"Microsoft YaHei",serif; background-image:linear-gradient(color-mix(in srgb,var(--preview-accent) 11%,transparent), color-mix(in srgb,var(--preview-accent) 11%,transparent)) }
      @media (prefers-reduced-motion:reduce) { .chatds-settings-switch span { transition:none } }
    `

    function StatusLine({ state }) {
      if (state === null || state === undefined) return h('div', { className: 'chatds-status', 'aria-live': 'polite' })
      return h('div', { className: 'chatds-status', 'data-tone': state.tone, role: state.tone === 'error' ? 'alert' : 'status' }, state.message)
    }

    /** 设置卡片通用行。 */
    function Row({ keyId, label, description, children }) {
      return h('div', { key: keyId, className: 'chatds-settings-row' },
        h('div', null, h('div', { className: 'chatds-settings-label' }, label), description && h('small', null, description)),
        children)
    }
    function Switch({ label, enabled, disabled, onToggle }) {
      return h('button', { type: 'button', className: 'chatds-settings-switch', role: 'switch', 'aria-label': label,
        'aria-checked': enabled, disabled: disabled, onClick: onToggle }, h('span', { 'aria-hidden': true }))
    }

    let pendingSave = null
    let failedSave = null

    /** 设置窗口关闭后，在途保存继续。重新打开可重试上次失败的修改。 */
    function ChatDSSettings({ theme, openData, openPlugins, pickDirectory }) {
      const [page, setPage] = React.useState('常规')
      const [settings, setSettings] = React.useState(null)
      const [error, setError] = React.useState(failedSave?.message ?? '')
      const [busy, setBusy] = React.useState(Boolean(pendingSave))
      const [loadAttempt, retryLoad] = React.useReducer((n) => n + 1, 0)
      const controller = React.useRef(null)


      React.useEffect(() => {
        const request = new AbortController()
        controller.current = request
        Promise.resolve(pendingSave).then(settingsGet).then((value) => {
          if (!request.signal.aborted) {
            setSettings(value)
            setBusy(false)
            setError(failedSave?.message ?? '')
          }
        }, (reason) => {
          if (!request.signal.aborted) setError(reason.message)
        })
        return () => request.abort()
      }, [loadAttempt])

      const transact = async (prepare, save = settingsPut) => {
        if (pendingSave) return
        const signal = controller.current?.signal
        setBusy(true)
        setError('')
        let patch
        const operation = (async () => {
          try {
            patch = await prepare()
            if (!patch) return
            if (save === settingsPut && !signal?.aborted) setSettings((previous) => ({ ...previous, ...patch }))
            const next = await save(patch)
            failedSave = null
            if (!signal?.aborted && next) setSettings(next)
            broadcastSettings()
          } catch (reason) {
            const message = reason.message || '设置保存失败。'
            const retry = patch ? () => patch : prepare
            failedSave = { message, retry, save }
            if (!signal?.aborted) {
              setError(message)
              if (save === settingsPut) setSettings(settings)
              const current = await settingsGet().catch(() => null)
              if (current && !signal?.aborted) setSettings(current)
            }
          }
        })()
        pendingSave = operation
        try {
          await operation
        } finally {
          pendingSave = null
          if (!signal?.aborted) setBusy(false)
        }
      }
      if (!settings) return error
        ? h('div', { role: 'alert' }, error, ' ', h('button', { type: 'button', onClick: () => retryLoad() }, '重试'))
        : h('p', { role: 'status' }, '正在读取 ChatDS 设置…')
      const statusLine = error
        ? h('div', { key: 'status', className: 'chatds-status', 'data-tone': 'error', role: 'alert' }, error, ' ',
            failedSave && h('button', { type: 'button', disabled: busy, onClick: () => {
              const { retry, save } = failedSave
              void transact(retry, save)
            } }, '重试'))
        : busy ? h(StatusLine, { key: 'status', state: { tone: 'pending', message: '正在处理…' } }) : null
      const pages = ['常规', '模型', '提示词', '用量与费用', '插件与工具', '文件', '数据管理', '外观']
      const content = {
        常规: () => [
          h(Row, { keyId: 'language', label: '聊天界面语言',
            children: h('select', { 'aria-label': '聊天界面语言', value: settings.interfaceLanguage, disabled: busy,
              onChange: (event) => { const value = event.target.value; void transact(() => ({ interfaceLanguage: value })) } },
              h('option', { value: 'browser' }, '跟随浏览器'), h('option', { value: 'zh-CN' }, '简体中文'), h('option', { value: 'en-US' }, 'English')) }),
          h(Row, { keyId: 'keys', label: '发送快捷键',
            children: h('select', { 'aria-label': '发送快捷键', value: settings.sendShortcut, disabled: busy,
              onChange: (event) => { const value = event.target.value; void transact(() => ({ sendShortcut: value })) } },
              h('option', { value: 'enter' }, 'Enter'), h('option', { value: 'ctrl-enter' }, 'Ctrl + Enter')) }),
          h(Row, { keyId: 'voice', label: '语音输入', description: '点击录音并确认转写后，音频会发送到已配置的 DeepSeek 接口，可能产生费用。',
            children: Switch({ label: '语音输入', enabled: settings.enableVoiceInput, disabled: busy,
              onToggle: () => void transact(() => ({ enableVoiceInput: !settings.enableVoiceInput })) }) }),
          h(Row, { keyId: 'mode', label: '默认模式', description: '用于新建聊天。',
            children: h('select', { 'aria-label': '默认模式', value: settings.defaultMode, disabled: busy,
              onChange: (event) => { const mode = event.target.value; void transact(() => ({ defaultMode: mode })) } },
            h('option', { value: 'chat' }, 'Chat'), h('option', { value: 'plan' }, 'Plan · 只读工具')) }),
          h(Row, { keyId: 'thinking', label: '默认深度思考', description: '可在聊天中选择当前模型支持的具体等级。',
            children: Switch({ label: '默认深度思考', enabled: settings.defaultThinking !== 'off', disabled: busy,
              onToggle: () => void transact(() => ({ defaultThinking: settings.defaultThinking === 'off' ? 'enabled' : 'off' })) }) }),
          h(Row, { keyId: 'search', label: '默认联网搜索', description: '仅 DeepSeek 官方模型支持。',
            children: Switch({ label: '默认联网搜索', enabled: settings.defaultSearch === true, disabled: busy,
              onToggle: () => void transact(() => ({ defaultSearch: !settings.defaultSearch })) }) }),
          h(Row, { keyId: 'localSearch', label: '默认本地检索', description: '读取已授权目录内文件。',
            children: Switch({ label: '默认本地检索', enabled: settings.defaultLocalSearch === true, disabled: busy,
              onToggle: () => void transact(() => ({ defaultLocalSearch: !settings.defaultLocalSearch })) }) }),
          h(Row, { keyId: 'remember', label: '记住上次使用的模型', description: '新会话沿用上次模型。',
            children: Switch({ label: '记住上次使用的模型', enabled: settings.rememberLastModel === true, disabled: busy,
              onToggle: () => void transact(() => ({ rememberLastModel: !settings.rememberLastModel })) }) }),
          h(Row, { keyId: 'steps', label: 'Plan 本地检索步数上限', description: '每次回复可调用只读工具的最大步数。',
            children: h('input', { type: 'number', 'aria-label': 'Plan 本地检索上限', min: 1, max: 20, key: settings.maxPlanSteps, defaultValue: settings.maxPlanSteps, disabled: busy,
              onBlur: (event) => { const steps = event.target.valueAsNumber; if (Number.isInteger(steps) && steps >= 1 && steps <= 20 && steps !== settings.maxPlanSteps) void transact(() => ({ maxPlanSteps: steps })) } }) }),
          h(Row, { keyId: 'diagnostics', label: '基础请求诊断', description: '把每轮请求/用量摘要写入 Host 日志(不含正文)。',
            children: Switch({ label: '基础请求诊断', enabled: settings.requestDiagnostics === true, disabled: busy,
              onToggle: () => void transact(() => ({ requestDiagnostics: !settings.requestDiagnostics })) }) }),
        ],
        模型: () => h(ModelManager, { settings, busy, transact }),
        提示词: () => h(PromptManager, { settings, busy, transact }),
        用量与费用: () => h(CostManager, { settings, busy, transact }),
        插件与工具: () => h(ToolManager, { openPlugins }),
        文件: () => h(FileAccess, { settings, busy, transact, pickDirectory }),
        数据管理: () => h(DataSettings, { openData }),
        外观: () => h(AppearanceSettings, { settings, busy, transact, theme }),
      }
      return h('section', { className: 'chatds-settings', 'aria-busy': busy },
        h('style', null, chatDSSettingsStyles),
        h('nav', { 'aria-label': 'ChatDS 设置分类' },
          pages.map((label) => h('button', { key: label, type: 'button', 'aria-pressed': page === label, onClick: () => setPage(label) }, label))),
        h('div', { className: 'chatds-settings-card' }, content[page]()), statusLine)
    }

    function FileAccess({ settings, busy, transact, pickDirectory }) {
      const picker = window.__DSH_DIRECTORY_PICKER__
      const [availability, setAvailability] = React.useState({})
      const [manualPath, setManualPath] = React.useState('')
      React.useEffect(() => {
        let active = true
        apiGet('/api/file-access').then(({ dirs }) => {
          if (active) setAvailability(Object.fromEntries(dirs.map(({ path, available }) => [path, available])))
        }).catch(() => {})
        return () => { active = false }
      }, [settings.authorizedDirs])
      // 添加目录的通道:Desktop 原生桥 → DSH 官方 uiWorkspace 目录选择服务(经 remoteAccess 门禁,
      // 无 portal 的服务器上可能不可用)→ 手动输入绝对路径。Host 侧对任何通道都做
      // isAbsolute/realpath/可读校验,手动输入不产生原生选择器之外的额外权限。
      const desktopPick = typeof picker?.pick === 'function' ? () => picker.pick() : null
      const canPick = desktopPick !== null || typeof pickDirectory === 'function'
      const pickViaPicker = () => void transact(async () => {
        const path = desktopPick ? await desktopPick() : await pickDirectory()
        return path ? { path } : null
      }, (body) => apiSend('/api/file-access', 'POST', body))
      const addManual = () => void transact(async () => {
        const path = manualPath.trim()
        if (!path) return null
        setManualPath('')
        return { path }
      }, (body) => apiSend('/api/file-access', 'POST', body))
      return [
        h('h2', { key: 'title' }, '本地文件访问'),
        h('p', { key: 'intro' }, '仅允许 WebChat 访问你选择的文件夹。可以随时添加或移除。'),
        canPick && h('button', { key: 'add', type: 'button', disabled: busy, onClick: pickViaPicker }, '＋ 添加文件夹'),
        h('details', { key: 'manual', className: 'chatds-details' },
          h('summary', null, '手动输入路径授权(无目录选择器的环境)'),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 } },
            h('input', {
              type: 'text', value: manualPath, disabled: busy,
              placeholder: '输入要授权的文件夹绝对路径，如 /home/user/Documents',
              'aria-label': '授权文件夹绝对路径',
              onChange: (event) => setManualPath(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter' && manualPath.trim()) addManual() },
              style: { flex: '1 1 260px', minWidth: 220 },
            }),
            h('button', { type: 'button', disabled: busy || !manualPath.trim(), onClick: addManual }, '授权此文件夹')),
          h('p', { style: { marginTop: 6 } }, 'Host 会校验路径存在且可读；软链接跳出目录的部分不可访问。')),
        settings.authorizedDirs.length
          ? h('h3', { key: 'count' }, '已授权文件夹 · ' + settings.authorizedDirs.length)
          : h('p', { key: 'empty' }, '还没有授权任何文件夹。添加后，开启本地检索即可搜索其中的文件。'),
        ...settings.authorizedDirs.map((path) => h(Row, {
          key: path, label: path.replace(/[\\\/]+$/, '').split(/[\\\/]/).pop() || path,
          description: h(React.Fragment, null, path, h('br'), '只读 · 包含子文件夹 · ',
            availability[path] === true ? '可用' : availability[path] === false ? '当前不可访问' : '待检查'),
          children: h('button', { type: 'button', disabled: busy, onClick: () => void transact(
            () => ({ path }), (body) => apiSend('/api/file-access', 'DELETE', body)) }, '移除访问权限'),
        })),
        h('details', { key: 'help', className: 'chatds-details' },
          h('summary', null, '文件支持与附件上传'),
          h('p', null, '本地检索可按文件名查找 PDF 和图片，并可提取 TXT、Markdown、CSV、DOCX、XLSX、PPTX 等文件的正文。'),
          h('p', null, '聊天附件由你主动选择，可按模型能力发送内容或交由云端解析。开启本地检索时，匹配的文件片段可能随提问发送给当前模型。'),
          h('p', null, '移除文件夹会停止后续本地访问。聊天里已有的内容和已上传的附件会保留。')),
      ]
    }

    function DataSettings({ openData }) {
      return [
        h(Row, { key: 'import', label: '导入聊天记录', description: '从 ZIP 或会话 JSON 预览并合并导入。',
          children: h('button', { onClick: () => openData('import') }, '导入') }),
        h(Row, { key: 'export', label: '导出聊天记录', description: '选择会话下载 ZIP，或从单个会话下载 Markdown、JSON。',
          children: h('button', { onClick: () => openData('export') }, '打开导出') }),
        h('p', { key: 'retention' }, '可在会话菜单中选择移除会话，并在确认前查看影响。'),
      ]
    }

    const presets = [
      ['default', 'WebChat 默认', '#3b64ed'],
      ['gpt', 'GPT 风格', '#488374'],
      ['gemini', 'Gemini 风格', '#6467bd'],
      ['claude', 'Claude 风格', '#a9624b'],
    ]

    function AppearanceSettings({ settings, busy, transact, theme }) {
      const hostMode = React.useSyncExternalStore(theme.subscribe, () => theme.getTheme().active.colorScheme)
      const media = React.useMemo(() => matchMedia('(prefers-color-scheme: dark)'), [])
      const systemDark = React.useSyncExternalStore(React.useCallback((listener) => {
        media.addEventListener('change', listener)
        return () => media.removeEventListener('change', listener)
      }, [media]), () => media.matches)
      const dark = settings.appearanceMode === 'dark' || (settings.appearanceMode === 'dsh' && hostMode === 'dark')
        || (settings.appearanceMode === 'system' && systemDark)
      const select = (field, label, options) => h(Row, { key: field, label, children: h('select', {
        'aria-label': label, value: settings[field], disabled: busy, onChange: (event) => {
          const value = event.target.value
          void transact(() => ({ [field]: field === 'readingFontSize' ? Number(value) : value }))
        },
      }, options.map(([key, label]) => h('option', { key, value: key }, label))) })
      return [
        select('appearanceMode', '颜色模式', [['dsh', '跟随 DSH'], ['light', '浅色'], ['dark', '深色'], ['system', navigator.platform.startsWith('Win') ? '跟随 Windows' : '跟随系统']]),
        h('h3', { key: 'title' }, '聊天界面风格'),
        h('div', { key: 'styles', className: 'chatds-preview-grid' }, presets.map(([key, label, color]) =>
          h('button', { key, type: 'button', className: 'chatds-preview', 'data-style': key, 'data-dark': dark,
            'aria-label': label, 'aria-pressed': settings.appearanceStyle === key, disabled: busy,
            style: { '--preview-accent': color }, onClick: () => void transact(() => ({ appearanceStyle: key })) },
          h('span', { 'aria-hidden': true, className: 'chatds-preview-chat' },
            h('span', null, '周末去哪儿？'), h('span', null, '去书店坐坐。'), h('span', null, '发消息　　 ＋　↑')),
          h('strong', null, label)))),
        select('appearanceGlass', '磨砂效果', [['off', '标准纯色'], ['light', '轻度磨砂'], ['strong', '明显磨砂']]),
        !CSS.supports('backdrop-filter', 'blur(8px)') && h('p', { key: 'fallback' }, '当前环境使用纯色背景。'),
        select('readingFontSize', '正文字号', [14, 15, 16, 17, 18, 19, 20].map((size) => [size, size + ' px'])),
        select('readingWidth', '阅读宽度', [['preset', '跟随风格'], ['narrow', '较窄'], ['wide', '较宽']]),
      ]
    }

    // ── 模型管理(R8:白名单/收藏/默认模型;数据全部来自 DSH 官方目录) ──

    const effortChipNames = { off: '无思考', enabled: '思考', low: '低', medium: '中', high: '高', max: '最高' }

    function ModelManager({ settings, busy, transact, extra }) {
      const [catalog, setCatalog] = React.useState(null)
      const [query, setQuery] = React.useState('')
      const [collapsed, setCollapsed] = React.useState({})

      React.useEffect(() => {
        let active = true
        apiGet('/api/models').then((value) => { if (active) setCatalog(value) }, () => { if (active) setCatalog(false) })
        return () => { active = false }
      }, [savedTickToken(settings)])

      const groups = React.useMemo(() => {
        if (catalog === null || catalog === false) return []
        const needle = query.trim().toLowerCase()
        const filterEntry = (entry) => needle.length === 0
          || entry.name.toLowerCase().includes(needle) || entry.model.toLowerCase().includes(needle)
        return [
          { key: 'rich', name: 'DeepSeek 官方', channel: 'rich', models: catalog.richModels.filter(filterEntry) },
          ...catalog.genericProviders.map((group) => ({ key: group.provider, name: group.name, channel: 'generic', provider: group.provider, models: group.models.filter(filterEntry) })),
        ]
      }, [catalog, query])

      if (catalog === null) return h('p', { role: 'status' }, '正在读取 DSH 模型目录…')
      if (catalog === false) return h('p', { role: 'alert' }, '模型目录读取失败。请确认 DSH 模型服务可用后重试。')
      const whitelistMode = settings.modelScope === 'whitelist'
      const enabledCount = countEnabled(catalog, settings)
      const toggleWhitelist = (ref) => {
        const key = modelKey(ref)
        const has = settings.modelWhitelist.some((item) => sameKey(item, key))
        return { modelWhitelist: has
          ? settings.modelWhitelist.filter((item) => !sameKey(item, key))
          : [...settings.modelWhitelist, { channel: ref.channel, provider: ref.provider, model: ref.model }] }
      }
      const toggleFavorite = (ref) => {
        const key = modelKey(ref)
        const has = settings.favoriteModels.some((item) => sameKey(item, key))
        return { favoriteModels: has
          ? settings.favoriteModels.filter((item) => !sameKey(item, key))
          : [...settings.favoriteModels, { channel: ref.channel, provider: ref.provider, model: ref.model }] }
      }
      const isFavorite = (ref) => settings.favoriteModels.some((item) => sameKey(item, modelKey(ref)))
      const isDefault = (ref) => settings.defaultModel !== undefined && sameKey(settings.defaultModel, modelKey(ref))
      const isAllowed = (ref) => !whitelistMode || settings.modelWhitelist.some((item) => sameKey(item, modelKey(ref)))

      const allRefs = []
      for (const group of groups) for (const entry of group.models) allRefs.push(entry)

      return [
        h('div', { key: 'toolbar', className: 'chatds-model-toolbar' },
          h('div', { className: 'chatds-scope', role: 'group', 'aria-label': '模型范围' },
            h('button', { type: 'button', 'aria-pressed': !whitelistMode, disabled: busy,
              onClick: () => void transact(() => ({ modelScope: 'all' })) }, '全部可用'),
            h('button', { type: 'button', 'aria-pressed': whitelistMode, disabled: busy,
              onClick: () => void transact(() => ({ modelScope: 'whitelist',
                ...(settings.modelWhitelist.length === 0 ? {} : {}) })) }, '自定义白名单')),
          h('input', { type: 'search', 'aria-label': '搜索模型', placeholder: '搜索模型…', value: query,
            onChange: (event) => setQuery(event.target.value) }),
          h('small', null, whitelistMode ? `已启用 ${enabledCount} / ${allRefs.length}` : `共 ${allRefs.length} 个模型`)),
        h('div', { key: 'actions', className: 'chatds-model-toolbar', style: { borderBottom: 'none', paddingTop: 8 } },
          h('button', { type: 'button', disabled: busy || allRefs.length === 0,
            onClick: () => void transact(() => ({ modelScope: 'whitelist', modelWhitelist: allRefs.map((entry) => ({ channel: entry.channel, provider: entry.provider, model: entry.model })) })) }, '一键全选'),
          h('button', { type: 'button', disabled: busy || !whitelistMode || settings.modelWhitelist.length === 0,
            onClick: () => void transact(() => ({ modelWhitelist: [] })) }, '全部关闭'),
          h('button', { type: 'button', disabled: busy, onClick: () => void transact(() => ({ modelScope: 'all', modelWhitelist: [] })) }, '恢复默认(全部可用)')),
        whitelistMode ? h('p', { key: 'scopeNote', style: { margin: '10px 0 0' } },
          h('small', null, '自定义白名单模式下,新发现的模型默认不出现在 WebChat 选择器中,需在此手动启用。禁用不影响 DSH 其他插件与凭证,仅限制 WebChat;当前会话正使用的模型被禁用时会明确提示且拒绝发送。')) : null,
        groups.map((group) => h('div', { key: group.key, className: 'chatds-model-group' },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0' } },
            h('button', { type: 'button', 'aria-expanded': !collapsed[group.key], style: { background: 'transparent', border: 0, padding: 0, fontWeight: 600, display: 'flex', gap: 8, alignItems: 'center' },
              onClick: () => setCollapsed((value) => ({ ...value, [group.key]: !value[group.key] })) },
              (collapsed[group.key] ? '▸' : '▾') + ' ' + group.name,
              h('span', { className: 'chatds-chip' }, String(group.models.length))),
            h('span', { style: { flex: 1 } }),
            h('button', { type: 'button', className: 'chatds-mini', disabled: busy || group.models.length === 0 || !whitelistMode,
              onClick: () => { void transact(() => {
                const keys = new Set(settings.modelWhitelist.map(modelKey))
                const enabled = group.models.every((entry) => keys.has(modelKey(entry)))
                const others = settings.modelWhitelist.filter((item) => !group.models.some((entry) => sameKey(entry, modelKey(item))))
                return { modelScope: 'whitelist', modelWhitelist: enabled ? others : [...others, ...group.models.map((entry) => ({ channel: entry.channel, provider: entry.provider, model: entry.model }))] }
              }) } }, '整组启/停')),
          !collapsed[group.key] && group.models.map((entry) => h('div', { key: modelKey(entry), className: 'chatds-model-row' },
            h('button', { type: 'button', className: 'chatds-star', 'aria-pressed': isFavorite(entry), 'aria-label': '收藏', disabled: busy,
              onClick: () => void transact(() => toggleFavorite(entry)) }, isFavorite(entry) ? '★' : '☆'),
            h('div', { className: 'chatds-model-name' }, entry.name,
              h('small', null, group.name + (whitelistMode && !isAllowed(entry) ? ' · 已禁用' : ''))),
            h('span', { className: 'chatds-chip' }, entry.capability.thinkingEfforts?.map((id) => effortChipNames[id] ?? id).join('/') || '无思考'),
            entry.capability.vision ? h('span', { className: 'chatds-chip' }, '视觉') : null,
            entry.capability.nativeSearch ? h('span', { className: 'chatds-chip' }, '联网') : null,
            isDefault(entry) ? h('span', { className: 'chatds-chip', 'data-tone': 'brand' }, '默认') : null,
            h('button', { type: 'button', className: 'chatds-mini', disabled: busy || isDefault(entry), onClick: () => void transact(() => ({ defaultModel: { channel: entry.channel, provider: entry.provider, model: entry.model } })) }, '设为默认'),
            h('button', { type: 'button', className: 'chatds-settings-switch', role: 'switch', 'aria-label': '启用 ' + entry.name,
              'aria-checked': isAllowed(entry), disabled: busy || !whitelistMode,
              style: { opacity: whitelistMode ? 1 : 0.4 },
              onClick: () => void transact(() => toggleWhitelist(entry)) }, h('span', { 'aria-hidden': true })))),
        )),
        extra,
      ]
    }

    /** 模型行渲染依赖 settings 对象;以引用变化作为重取目录的信号。 */
    function savedTickToken(settings) { return settings }

    function countEnabled(catalog, settings) {
      const keys = new Set(settings.modelWhitelist.map(modelKey))
      let count = 0
      for (const entry of catalog.richModels) if (keys.has(modelKey(entry))) count += 1
      for (const group of catalog.genericProviders) for (const entry of group.models) if (keys.has(modelKey(entry))) count += 1
      return count
    }

    // ── 提示词管理(R8:全局附加提示词 + 模板库 CRUD) ──

    function PromptManager({ settings, busy, transact, extra }) {
      const [templates, setTemplates] = React.useState(null)
      const [error, setError] = React.useState('')
      const [query, setQuery] = React.useState('')
      const [editing, setEditing] = React.useState(null) // null | {id?, name, category, summary, body, tags}
      /** 全局提示词正文:本地状态 + 防抖自动保存(受控回显以服务端为准)。 */
      const [gpText, setGpText] = React.useState(settings.globalPromptText)
      const gpTimer = React.useRef(null)
      React.useEffect(() => { setGpText(settings.globalPromptText) }, [settings.globalPromptText])
      React.useEffect(() => () => window.clearTimeout(gpTimer.current), [])

      const reload = React.useCallback(() => {
        apiGet('/api/prompts').then((value) => setTemplates(value.templates), (reason) => setError(reason.message))
      }, [])
      React.useEffect(reload, [reload])

      const filtered = (templates ?? []).filter((template) => {
        const needle = query.trim().toLowerCase()
        return needle.length === 0 || (template.name + ' ' + template.category + ' ' + template.summary + ' ' + template.tags.join(' ')).toLowerCase().includes(needle)
      })

      const save = async () => {
        if (editing === null) return
        const payload = { name: editing.name, category: editing.category ?? '', summary: editing.summary ?? '', body: editing.body, tags: editing.tags ?? [] }
        try {
          if (editing.id !== undefined) await apiSend('/api/prompts/' + encodeURIComponent(editing.id), 'PUT', payload)
          else await apiSend('/api/prompts', 'POST', payload)
          setEditing(null)
          reload()
        } catch (reason) {
          setError(reason.message)
        }
      }

      return [
        h('div', { key: 'global' },
          h(Row, { keyId: 'gp-enable', label: '全局附加提示词', description: '追加在 DeepSeek 身份指令之后,每轮请求注入一次;不覆盖 DSH 原始指令与安全策略。',
            children: Switch({ label: '启用全局附加提示词', enabled: settings.globalPromptEnabled === true, disabled: busy,
              onToggle: () => void transact(() => ({ globalPromptEnabled: !settings.globalPromptEnabled })) }) }),
          h(Row, { keyId: 'gp-text', label: '提示词正文', description: gpText.length > 0 ? `${gpText.length} 字符 · 停止输入后自动保存` : '为空时不注入。',
            children: h('textarea', { 'aria-label': '全局附加提示词', value: gpText, disabled: busy,
              onChange: (event) => {
                const text = event.target.value
                setGpText(text)
                window.clearTimeout(gpTimer.current)
                gpTimer.current = window.setTimeout(() => { void transact(() => ({ globalPromptText: text })) }, 900)
              } }) }),
          h('div', { key: 'gp-actions', className: 'chatds-model-toolbar', style: { borderBottom: 'none' } },
            h('button', { type: 'button', disabled: busy, onClick: () => void transact(() => ({ globalPromptEnabled: false, globalPromptText: '' })) }, '恢复默认(关闭并清空)')),
        ),
        h('div', { key: 'toolbar', className: 'chatds-model-toolbar' },
          h('input', { type: 'search', 'aria-label': '搜索模板', placeholder: '搜索模板…', value: query, onChange: (event) => setQuery(event.target.value) }),
          h('button', { type: 'button', disabled: busy, onClick: () => setEditing({ name: '', category: '', summary: '', body: '', tags: [] }) }, '新建模板')),
        templates === null && error === '' ? h('p', { key: 'loading', role: 'status' }, '正在读取模板…') : null,
        error !== '' ? h('p', { key: 'error', role: 'alert' }, error) : null,
        editing !== null ? h('div', { key: 'editor' },
          h(Row, { keyId: 't-name', label: '名称', children: h('input', { type: 'search', style: { maxWidth: 'none', flex: 1 }, value: editing.name,
            onChange: (event) => setEditing({ ...editing, name: event.target.value }) }) }),
          h(Row, { keyId: 't-category', label: '分类', children: h('input', { type: 'search', style: { maxWidth: 'none', flex: 1 }, value: editing.category ?? '',
            placeholder: '如:学术 / 开发 / 语言', onChange: (event) => setEditing({ ...editing, category: event.target.value }) }) }),
          h(Row, { keyId: 't-summary', label: '简介', children: h('input', { type: 'search', style: { maxWidth: 'none', flex: 1 }, value: editing.summary ?? '',
            onChange: (event) => setEditing({ ...editing, summary: event.target.value }) }) }),
          h(Row, { keyId: 't-tags', label: '标签', description: '逗号分隔', children: h('input', { type: 'search', style: { maxWidth: 'none', flex: 1 }, value: (editing.tags ?? []).join(', '),
            onChange: (event) => setEditing({ ...editing, tags: event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean) }) }) }),
          h('div', { style: { padding: '12px 0' } },
            h('textarea', { 'aria-label': '模板正文', value: editing.body, onChange: (event) => setEditing({ ...editing, body: event.target.value }),
              placeholder: '支持变量:{{date}} {{model}} {{sessionTitle}} {{workspace}} {{selection}}(未解析变量会保留并在使用时提示)' })),
          h('div', { className: 'chatds-model-toolbar', style: { borderBottom: 'none' } },
            h('button', { type: 'button', disabled: busy || !editing.name.trim() || !editing.body.trim(), onClick: () => void save() }, '保存模板'),
            h('button', { type: 'button', disabled: busy, onClick: () => setEditing(null) }, '取消'))) : null,
        filtered.map((template) => h('div', { key: template.id, className: 'chatds-template-row' },
          h('div', { className: 'chatds-template-main' },
            h('div', null, h('strong', null, template.name),
              template.category ? h('span', { className: 'chatds-chip', style: { marginLeft: 8 } }, template.category) : null,
              template.builtin === true ? h('span', { className: 'chatds-chip', style: { marginLeft: 4 } }, '默认') : null),
            template.summary ? h('small', null, template.summary) : null,
            h('pre', { className: 'chatds-template-body' }, template.body.length > 220 ? template.body.slice(0, 220) + '…' : template.body)),
          h('button', { type: 'button', className: 'chatds-mini', disabled: busy, onClick: () => setEditing({ ...template }) }, '编辑'),
          h('button', { type: 'button', className: 'chatds-mini', disabled: busy, onClick: async () => {
            try {
              await apiSend('/api/prompts', 'POST', { name: template.name + ' (副本)', category: template.category, summary: template.summary, body: template.body, tags: template.tags })
              reload()
            } catch (reason) { setError(reason.message) }
          } }, '复制'),
          h('button', { type: 'button', className: 'chatds-mini', disabled: busy, onClick: async () => {
            if (!window.confirm('删除模板「' + template.name + '」?默认模板删除后不再恢复。')) return
            try {
              await apiSend('/api/prompts/' + encodeURIComponent(template.id), 'DELETE')
              reload()
            } catch (reason) { setError(reason.message) }
          } }, '删除'))),
        filtered.length === 0 && templates !== null ? h('p', { key: 'empty' }, '没有匹配的模板。') : null,
        extra,
      ]
    }

    // ── 用量与费用(R8:今日费用/预算提醒;价格唯一来源是 dsh-cost-meter) ──

    function CostManager({ settings, busy, transact, extra }) {
      const [today, setToday] = React.useState(null)
      React.useEffect(() => {
        let active = true
        apiGet('/api/cost/today').then((value) => { if (active) setToday(value) }, () => { if (active) setToday(false) })
        return () => { active = false }
      }, [])
      const thresholdButtons = [0.5, 0.8, 1]
      return [
        today === null ? h('p', { key: 'loading', role: 'status' }, '正在读取费用数据…') : null,
        today === false ? h('p', { key: 'fail', role: 'alert' }, '费用数据读取失败(dsh-cost-meter 未安装或未运行)。') : null,
        today !== null && today !== false ? [
          h(Row, { keyId: 'today', label: '今日费用', description: today.available ? `Token 输入 ${today.input} / 输出 ${today.output} · 请求 ${today.calls} 次` : today.reason,
            children: h('strong', null, typeof today.cost === 'number' ? '$' + today.cost.toFixed(4) : '暂无金额') }),
          h(Row, { keyId: 'budget', label: '每日预算', description: today.budget?.cap !== undefined
            ? `dsh-cost-meter 预算:已用 $${Number(today.budget.used ?? 0).toFixed(4)} / 上限 $${today.budget.cap}(${today.budget.period === 'day' ? '每日' : today.budget.period ?? '周期'})`
            : '未设置。预算上限请在 dsh-cost-meter 原生设置中维护(ChatDS 不复制第二份预算配置)。',
            children: h('span', null, today.budget?.ratio !== undefined ? Math.round(today.budget.ratio * 100) + '%' : '—') }),
        ] : null,
        h(Row, { keyId: 'reminders', label: '预算提醒', description: '基于 dsh-cost-meter 预算账目,达到阈值时在聊天页轻提示,不打断输入。',
          children: Switch({ label: '预算提醒', enabled: settings.budgetRemindersEnabled === true, disabled: busy,
            onToggle: () => void transact(() => ({ budgetRemindersEnabled: !settings.budgetRemindersEnabled })) }) }),
        h(Row, { keyId: 'thresholds', label: '提醒阈值', description: '达到比例时提醒一次(按今日已用/预算上限)。',
          children: h('div', { style: { display: 'flex', gap: 6 } }, thresholdButtons.map((value) => {
            const active = (settings.budgetWarnThresholds ?? []).includes(value)
            return h('button', { key: value, type: 'button', className: 'chatds-mini', 'aria-pressed': active, disabled: busy,
              onClick: () => void transact(() => ({ budgetWarnThresholds: active
                ? settings.budgetWarnThresholds.filter((item) => item !== value)
                : [...settings.budgetWarnThresholds, value].sort() })) }, Math.round(value * 100) + '%')
          })) }),
        h('p', { key: 'prices' }, h('small', null, '模型价格、历史账单与完整仪表盘以 dsh-cost-meter 为唯一来源,可在其原生设置中查看与配置。DeepSeek Rich 只显示 API 返回的独立用量，未纳入每轮费用、会话、今日与预算的账目。')),
        extra,
      ]
    }

    // ── 插件与工具(R8:官方注册表;全局授权滑块) ──

    function ToolManager({ openPlugins }) {
      const [catalog, setCatalog] = React.useState(null)
      const [error, setError] = React.useState('')
      const [sessionId, setSessionId] = React.useState(null)
      const [permissions, setPermissions] = React.useState(null)
      const [pending, setPending] = React.useState(false)
      const current = React.useRef(null)
      React.useEffect(() => {
        let active = true
        let timer
        const refresh = async () => {
          try {
            const value = await apiGet('/api/integrations')
            if (active) setCatalog(value)
          } catch (reason) {
            if (active) { setCatalog(false); setError(reason.message) }
          } finally {
            if (active) timer = setTimeout(refresh, 5000)
          }
        }
        const frame = document.querySelector('iframe[data-chatds-main]')
        const receive = (event) => {
          if (event.source !== frame?.contentWindow || event.origin !== location.origin || event.data?.type !== 'chatds:active-session') return
          const id = event.data.id
          const next = typeof id === 'string' && /^chatws-[a-f0-9-]{36}$/.test(id) ? id : null
          current.current = next
          setSessionId(next)
        }
        window.addEventListener('message', receive)
        frame?.contentWindow?.postMessage({ type: 'chatds:request-active-session' }, location.origin)
        void refresh()
        return () => { active = false; clearTimeout(timer); window.removeEventListener('message', receive) }
      }, [])
      React.useEffect(() => {
        let active = true
        setPermissions(null)
        if (sessionId) apiGet('/api/sessions/' + encodeURIComponent(sessionId) + '/tools').then((data) => {
          if (active) setPermissions(data.supported)
        }, (reason) => { if (active) setError(reason.message) })
        return () => { active = false }
      }, [sessionId])

      const grant = async (names, allow) => {
        if (!sessionId || !permissions || pending) return
        const granted = permissions.filter((tool) => names.includes(tool.name) ? allow : tool.enabled).map((tool) => tool.name)
        setPending(true)
        setError('')
        try {
          await apiSend('/api/sessions/' + encodeURIComponent(sessionId) + '/tools', 'PUT', { grants: granted })
          if (current.current === sessionId) setPermissions(permissions.map((tool) => ({ ...tool, enabled: granted.includes(tool.name) })))
        } catch (reason) {
          setError(reason.message)
        } finally {
          setPending(false)
        }
      }
      return [
        h('div', { key: 'heading', className: 'chatds-settings-row' },
          h('div', null, h('strong', null, '已启用的集成'), h('br'), h('small', null, '模型工具权限只应用于当前 WebChat 会话。')),
          h('button', { type: 'button', onClick: openPlugins }, '前往 DSH 插件管理器')),
        error && h('p', { key: 'error', role: 'alert' }, error),
        catalog === null && h('p', { key: 'loading', role: 'status' }, '正在读取插件状态…'),
        catalog && !catalog.managementAvailable && h('p', { key: 'unavailable' }, '当前 Host 未提供插件管理服务。'),
        catalog?.managementAvailable && !catalog.bundles.length && h('p', { key: 'empty' }, '当前没有可用的 WebChat 插件集成。'),
        ...((catalog && catalog.bundles) || []).map((bundle) => {
          const includesLocal = bundle.components.some((component) => component.kind === 'local')
          const enabled = permissions?.filter((tool) => tool.enabled).length ?? 0
          return h('details', { key: bundle.name, className: 'chatds-bundle' },
            h('summary', null,
              bundle.icon && h('img', { src: bundle.icon, width: 18, height: 18, alt: '' }),
              h('strong', null, bundle.title), h('small', null, '已连接 · ' + (includesLocal ? '1 个可授权组件' : '服务集成')),
              includesLocal && permissions && h('small', null, enabled === permissions.length ? '已授权 1 个组件' : enabled ? '部分授权' : '未授权')),
            h('p', null, bundle.description),
            bundle.components.map((component) => h('section', { key: component.id, className: 'chatds-component' },
              h(Row, { label: component.title, description: component.description, children: component.kind === 'local'
                ? Switch({ label: '允许 WebChat 使用 ' + component.title, enabled: Boolean(enabled), disabled: !permissions?.length || pending,
                    onToggle: () => void grant(permissions.map((tool) => tool.name), !enabled) })
                : null }),
              component.kind === 'local' && (!permissions
                ? h('p', null, sessionId ? '正在读取会话权限…' : '打开一条 WebChat 会话后可授权。')
                : h('details', { className: 'chatds-details' }, h('summary', null, '查看详细工具'),
                  permissions.map((tool) => {
                    const name = tool.name === 'chatds_search_files' ? '搜索授权文件夹' : '读取授权文件片段'
                    return h(Row, { key: tool.name, label: name, description: h('code', null, tool.name),
                      children: Switch({ label: name, enabled: tool.enabled, disabled: pending,
                        onToggle: () => void grant([tool.name], !tool.enabled) }) })
                  })))))
          )
        }),
        h('p', { key: 'approval' }, '需要审批的工具可在 DSH Agent 中使用。'),
      ]
    }

    // ────────────────────────── 设置入口 / 面板注册 ──────────────────────────

    function SettingsLauncher({ wide, settingsOpen, settingsShortcut, openSettings }) {
      React.useEffect(() => {
        const onMessage = (event) => {
          if (event.origin !== location.origin || event.data?.type !== 'chatds:open-settings') return
          const frame = document.querySelector('iframe[data-chatds-main]')
          if (event.source === frame?.contentWindow) openSettings('chatds')
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
      }, [openSettings])
      return h('button', {
        type: 'button', 'aria-label': '设置', 'aria-haspopup': 'dialog', 'aria-expanded': settingsOpen,
        'aria-keyshortcuts': settingsShortcut?.aria,
        onClick: () => openSettings(),
        style: { color: 'inherit', background: 'transparent', border: 0, padding: 6, cursor: 'pointer' },
      }, wide ? '⚙ 设置' : '⚙')
    }

    return {
      inject: ['slots', 'theme', 'layout'],
      apply(ctx) {
        const theme = { getTheme: () => ctx.theme.getTheme(), subscribe: (listener) => ctx.on('theme/change', listener) }
        ctx.effect(() => {
          const onMessage = (event) => {
            if (event.origin !== location.origin || event.data?.type !== 'chatds:open-work-branch') return
            const frame = document.querySelector('iframe[data-chatds-main]')
            if (event.source !== frame?.contentWindow || !/^session-[a-f0-9-]{36}$/.test(event.data.sessionId)) return
            ctx.get('uiWorkspace')?.openSession(event.data.sessionId)
          }
          window.addEventListener('message', onMessage)
          return () => window.removeEventListener('message', onMessage)
        })
        const Panel = () => h(ChatWorkspacePanel, { theme })
        // DSH 官方目录选择服务(web 平台由 uiWorkspace 提供,经 remoteAccess 门禁;Desktop 走原生桥)。
        const pickDirectory = async () => {
          const workspace = ctx.get('uiWorkspace')
          if (typeof workspace?.pickDirectory !== 'function') throw new Error('DSH 目录选择服务不可用。')
          return await workspace.pickDirectory()
        }
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'chatds', order: 60, label: () => 'ChatDS 设置',
        }, ({ close }) => h(ChatDSSettings, { theme, pickDirectory, openData(action) {
          const frame = document.querySelector('iframe[data-chatds-main]')
          if (frame?.contentWindow) frame.contentWindow.postMessage({ type: 'chatds:data', action }, location.origin)
          else {
            pendingDataAction = action
            ctx.layout.selectPanel(PANEL_ID)
          }
          close?.()
        }, openPlugins: () => { close?.(); ctx.layout.selectPanel('plugins') } })))
        ctx.slots.inject('settings.launcher', () => ctx.slots.register({ name: 'settings.launcher' }, SettingsLauncher))
        // 全局主面板:key 与导航行 id 相同,侧栏选择后由 layout 渲染本组件。
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID }, Panel))
        // 左侧导航行(图标 + 名称)。选中后 layout.selectPanel(PANEL_ID) 切到上面的主面板。
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 10,
              label: () => 'WebChat Web',
            },
            ChatWorkspaceIcon,
          ))
      },
    }
  },
})
