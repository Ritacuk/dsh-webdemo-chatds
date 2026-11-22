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

    /** macOS 键位标注:实现侧(Ctrl 或 ⌘)两者都接受,标签按平台显示(macOS 验收 R1)。 */
    const IS_MAC_LIKE = /Mac|iPhone|iPad/i.test(`${typeof navigator !== 'undefined' ? navigator.platform : ''} ${typeof navigator !== 'undefined' ? navigator.userAgent : ''}`)

    /** R8.5(F09):Side Chat 右栏 tab 身份(kind 全局唯一,避免与官方/第三方插件冲突)。 */
    const SIDECHAT_KIND = 'chatds-side-chat'
    const SIDECHAT_ID = 'dsh-webdemo-chatds/side-chat'
    const SIDECAR_PAGE = '/chat-workspace-sidecar'

    // ── R8.5(F06):设置界面多语言。zh 源文案即 key;en/ja 字典缺译时回退 zh 源文案。 ──
    let uiLanguage = 'zh'
    const fillParams = (text, params) => params === undefined
      ? text
      : text.replace(/\{(\w+)\}/g, (token, name) => Object.hasOwn(params, name) ? String(params[name]) : token)
    const L = (zh, params) => {
      if (uiLanguage === 'en' || uiLanguage === 'ja') {
        const table = STRINGS[uiLanguage]
        if (table !== undefined && Object.hasOwn(table, zh)) return fillParams(table[zh], params)
      }
      return fillParams(zh, params)
    }
    const syncUiLanguage = (value) => {
      uiLanguage = value === 'en-US' ? 'en' : value === 'ja-JP' ? 'ja' : 'zh'
    }
    const STRINGS = {
      en: {
        '常规': 'General', '模型': 'Models', '提示词': 'Prompts', '用量与费用': 'Usage & cost',
        '插件与工具': 'Plugins & tools', '文件': 'Files', '数据管理': 'Data', '外观': 'Appearance',
        'ChatDS 设置': 'ChatDS settings', '设置': 'Settings', '重试': 'Retry',
        '正在读取 ChatDS 设置…': 'Loading ChatDS settings…', '设置保存失败。': 'Failed to save settings.', '正在处理…': 'Working…',
        '插件能力加载失败，可以重试或查看诊断信息。': 'Failed to load plugin capabilities. You can retry or view diagnostics.',
        '设置区暂时无法渲染，可以重试。': 'The settings area failed to render. You can retry.',
        '诊断信息': 'Diagnostics', '已跳过 {count} 个无法解析的插件条目。': 'Skipped {count} plugin entries that could not be parsed.',
        '聊天界面语言': 'Interface language', '跟随浏览器': 'Follow browser',
        '发送快捷键': 'Send shortcut', 'Enter': 'Enter', 'Ctrl + Enter': 'Ctrl + Enter', '⌘ + Enter': '⌘ + Enter',
        '语音输入': 'Voice input',
        '点击录音并确认转写后，音频会发送到已配置的 DeepSeek 接口，可能产生费用。': 'After you record and confirm transcription, audio is sent to the configured DeepSeek endpoint. Charges may apply.',
        '已开启。优先使用 DSH 语音服务转写；服务不可用时回退 DeepSeek 转写(可能产生费用)。': 'On. Prefers the DSH speech service for transcription; falls back to DeepSeek (charges may apply) only when it is unavailable.',
        '已开启。未检测到 DSH 语音服务，转写将使用 DeepSeek 接口，可能产生费用。': 'On. No DSH speech service detected; transcription uses the DeepSeek endpoint. Charges may apply.',
        '默认模式': 'Default mode', '用于新建聊天。': 'Used for new chats.', 'Chat': 'Chat', 'Plan · 只读工具': 'Plan · read-only tools',
        '默认深度思考': 'Default deep thinking', '可在聊天中选择当前模型支持的具体等级。': 'Pick a concrete level supported by the current model inside chats.',
        '默认联网搜索': 'Default web search', '仅 DeepSeek 官方模型支持。': 'Official DeepSeek models only.',
        '默认本地检索': 'Default local search', '读取已授权目录内文件。': 'Reads files inside authorized folders.',
        '记住上次使用的模型': 'Remember last model', '新会话沿用上次模型。': 'New chats reuse the last model.',
        'Plan 本地检索步数上限': 'Plan local-search step limit', '每次回复可调用只读工具的最大步数。': 'Maximum read-only tool steps per reply.',
        '基础请求诊断': 'Request diagnostics', '把每轮请求/用量摘要写入 Host 日志(不含正文)。': 'Write per-turn request/usage summaries to the Host log (no message bodies).',
        '搜索模型…': 'Search models…', '模型范围': 'Model scope', '全部可用': 'All models', '自定义白名单': 'Custom whitelist',
        '一键全选': 'Select all', '全部关闭': 'Disable all', '恢复默认(全部可用)': 'Reset (all models)',
        '整组启/停': 'Toggle group', '收藏': 'Favorite',
        '自定义白名单模式下,新发现的模型默认不出现在 WebChat 选择器中,需在此手动启用。禁用不影响 DSH 其他插件与凭证,仅限制 WebChat;当前会话正使用的模型被禁用时会明确提示且拒绝发送。': 'In whitelist mode, newly discovered models stay hidden from the WebChat picker until enabled here. Disabling affects WebChat only — other DSH plugins and credentials are untouched; sending is blocked with a clear notice while the current chat\'s model is disabled.',
        '正在读取 DSH 模型目录…': 'Loading the DSH model catalog…', '模型目录读取失败。请确认 DSH 模型服务可用后重试。': 'Failed to load the model catalog. Confirm the DSH model service is available and retry.',
        '无思考': 'No thinking', '思考': 'Thinking', '低': 'Low', '中': 'Medium', '高': 'High', '最高': 'Max', '开启': 'On', '关闭': 'Off',
        '视觉': 'Vision', '联网': 'Web', '默认': 'Default', '设为默认': 'Set default', '已禁用': 'Disabled',
        '全局附加提示词': 'Global extra prompt', '追加在 DeepSeek 身份指令之后,每轮请求注入一次;不覆盖 DSH 原始指令与安全策略。': 'Appended after the DeepSeek identity prompt, injected once per turn; never overrides DSH\'s own instructions or safety policies.',
        '启用全局附加提示词': 'Enable global extra prompt',
        '提示词正文': 'Prompt body', '为空时不注入。': 'Not injected while empty.', '停止输入后自动保存': 'auto-saves after you stop typing',
        '恢复默认(关闭并清空)': 'Reset (off and empty)',
        '搜索模板…': 'Search templates…', '新建模板': 'New template', '正在读取模板…': 'Loading templates…',
        '名称': 'Name', '分类': 'Category', '简介': 'Summary', '标签': 'Tags', '逗号分隔': 'comma-separated',
        '正文': 'Body', '保存模板': 'Save template', '取消': 'Cancel', '编辑': 'Edit', '复制': 'Duplicate', '删除': 'Delete',
        '默认模板': 'Built-in', '没有匹配的模板。': 'No matching templates.',
        '正在读取费用数据…': 'Loading cost data…', '费用数据读取失败(dsh-cost-meter 未安装或未运行)。': 'Failed to load cost data (dsh-cost-meter missing or not running).',
        '今日费用': 'Today\'s cost', '暂无金额': 'No amount yet', 'Token 输入 {input} / 输出 {output} · 请求 {calls} 次': 'Tokens in {input} / out {output} · {calls} calls',
        '每日预算': 'Daily budget',
        'dsh-cost-meter 预算:已用 ${used} / 上限 ${cap}({period})': 'dsh-cost-meter budget: ${used} used / ${cap} cap ({period})',
        '每日': 'daily',
        '未设置。预算上限请在 dsh-cost-meter 原生设置中维护(ChatDS 不复制第二份预算配置)。': 'Not set. Maintain the budget cap in dsh-cost-meter\'s native settings (ChatDS keeps no second copy).',
        '预算提醒': 'Budget reminders', '基于 dsh-cost-meter 预算账目,达到阈值时在聊天页轻提示,不打断输入。': 'Based on the dsh-cost-meter budget; shows a gentle toast in the chat at thresholds without interrupting typing.',
        '提醒阈值': 'Reminder threshold', '预算提醒阈值(%)': 'Budget reminder threshold (%)',
        '达到比例时提醒一次(按今日已用/预算上限)。': 'Remind once per day when the ratio is reached (today\'s spend / budget cap).',
        '输入 1–100 的整数百分比。': 'Enter 1–100 (%).',
        '尚未设置每日预算。打开 dsh-cost-meter 原生设置配置预算上限后,提醒才会生效。': 'No budget is set yet. Open dsh-cost-meter\'s native settings to configure a cap; reminders only work after that.',
        '打开 dsh-cost-meter 设置': 'Open dsh-cost-meter settings',
        '模型价格、历史账单与完整仪表盘以 dsh-cost-meter 为唯一来源,可在其原生设置中查看与配置。DeepSeek Rich 用量已按官方 external_usage 协议计入其外部账本(来源 chatds-rich),今日合计与预算合并口径包含 Rich。': 'Model prices, history and the full dashboard live only in dsh-cost-meter; configure them in its native settings. DeepSeek Rich usage is recorded into its external ledger via the official external_usage protocol (source: chatds-rich), and today totals plus the merged budget view include Rich.',
        '已启用的集成': 'Enabled integrations', '模型工具权限只应用于当前 WebChat 会话。': 'Model tool permissions apply only to the current WebChat session.',
        '前往 DSH 插件管理器': 'Open the DSH plugin manager', '当前 Host 未提供插件管理服务。': 'This Host does not provide plugin management.',
        '当前没有可用的 WebChat 插件集成。': 'No WebChat plugin integrations available.',
        '已连接 · ': 'Connected · ', ' 个可授权组件': ' authorizable component(s)', '服务集成': 'service integration',
        '已授权 1 个组件': '1 component authorized', '部分授权': 'Partially authorized', '未授权': 'Not authorized',
        '正在读取会话权限…': 'Loading session permissions…', '打开一条 WebChat 会话后可授权。': 'Open a WebChat session to authorize.',
        '查看详细工具': 'Show tools', '搜索授权文件夹': 'Search authorized folders', '读取授权文件片段': 'Read authorized file snippets',
        '允许 WebChat 使用 {name}': 'Allow WebChat to use {name}',
        '需要审批的工具可在 DSH Agent 中使用。': 'Approval-required tools run inside the DSH Agent.',
        '本地文件访问': 'Local file access', '仅允许 WebChat 访问你选择的文件夹。可以随时添加或移除。': 'WebChat only accesses folders you choose. Add or remove anytime.',
        '＋ 添加文件夹': '＋ Add folder', '手动输入路径授权(无目录选择器的环境)': 'Authorize by path (no directory picker)',
        '输入要授权的文件夹绝对路径，如 /home/user/Documents': 'Absolute folder path to authorize, e.g. /home/user/Documents',
        '授权此文件夹': 'Authorize folder', '授权文件夹绝对路径': 'Absolute path',
        'Host 会校验路径存在且可读；软链接跳出目录的部分不可访问。': 'The Host verifies the path exists and is readable; symlink escapes stay inaccessible.',
        '已授权文件夹 · ': 'Authorized folders · ', '还没有授权任何文件夹。添加后，开启本地检索即可搜索其中的文件。': 'No folders authorized yet. Add one, then enable local search to look inside.',
        '可用': 'Available', '当前不可访问': 'Currently inaccessible', '待检查': 'Pending check', '只读 · 包含子文件夹 · ': 'Read-only · includes subfolders · ',
        '移除访问权限': 'Revoke access',
        '文件支持与附件上传': 'File support and attachments',
        '本地检索可按文件名查找 PDF 和图片，并可提取 TXT、Markdown、CSV、DOCX、XLSX、PPTX 等文件的正文。': 'Local search finds PDFs and images by name and extracts text from TXT, Markdown, CSV, DOCX, XLSX, PPTX and more.',
        '聊天附件由你主动选择，可按模型能力发送内容或交由云端解析。开启本地检索时，匹配的文件片段可能随提问发送给当前模型。': 'Attachments are added by you; content is sent per model capability or parsed in the cloud. With local search on, matching snippets may be sent to the current model.',
        '移除文件夹会停止后续本地访问。聊天里已有的内容和已上传的附件会保留。': 'Removing a folder stops future local access. Existing chat content and uploaded attachments stay.',
        '导入聊天记录': 'Import chat history', '从 ZIP 或会话 JSON 预览并合并导入。': 'Preview and merge from ZIP or session JSON.',
        '导入': 'Import', '导出聊天记录': 'Export chat history', '选择会话下载 ZIP，或从单个会话下载 Markdown、JSON。': 'Select sessions to download a ZIP, or export one chat as Markdown/JSON.',
        '打开导出': 'Open export',
        '可在会话菜单中选择移除会话，并在确认前查看影响。': 'Remove chats from the session menu; the confirmation shows what is affected.',
        '颜色模式': 'Color mode', '跟随 DSH': 'Follow DSH', '浅色': 'Light', '深色': 'Dark', '跟随系统': 'Follow system', '跟随 Windows': 'Follow Windows',
        '聊天界面风格': 'Chat style', 'WebChat 默认': 'WebChat default', 'GPT 风格': 'GPT style', 'Gemini 风格': 'Gemini style', 'Claude 风格': 'Claude style',
        '磨砂效果': 'Frosted glass', '标准纯色': 'Solid', '轻度磨砂': 'Light frost', '明显磨砂': 'Strong frost',
        '当前环境使用纯色背景。': 'This environment falls back to solid backgrounds.',
        '正文字号': 'Reading font size', '阅读宽度': 'Reading width', '跟随风格': 'Follow style', '较窄': 'Narrower', '较宽': 'Wider',
        '主题强调色': 'Accent color', '应用于发送按钮、用户气泡与链接。': 'Applied to the send button, user bubbles and links.',
        '背景透明度': 'Background opacity', '降低后可透出 DSH 桌面/窗口背景。': 'Lower it to let the DSH desktop or window show through.',
        '浮动面板透明度': 'Panel opacity', '弹窗与菜单。': 'Dialogs and menus.', '输入框透明度': 'Composer opacity',
        '布局密度': 'Layout density', '紧凑': 'Compact', '标准': 'Standard', '宽松': 'Relaxed',
        '行距': 'Line height', '圆角': 'Corner radius', '输入框宽度': 'Composer width',
        '恢复 WebChat 默认外观': 'Reset WebChat appearance', '只重置外观设置；聊天历史、模型与提示词不受影响。': 'Only appearance settings are reset; history, models and prompts are not affected.',
        '恢复默认': 'Reset', '默认': 'Default',
        'WebChat 已就绪。若左侧未出现入口，点击刷新界面载入。': 'WebChat is ready. If the entry is missing on the left, refresh the interface to load it.',
        '刷新界面': 'Refresh',
        '当前 DSH Desktop 无法打开文件夹选择器。': 'This DSH Desktop cannot open a folder picker.',
        '无法打开文件夹选择器。': 'Unable to open the folder picker.', 'DSH 文件保存服务不可用。': 'The DSH file-save service is unavailable.', '无法在 DSH Desktop 保存文件。': 'Unable to save the file in DSH Desktop.',
        '请求失败(': 'Request failed (', '会话标题须为 1 至 200 个字符': 'Chat titles need 1–200 characters',
        '请在当前回复结束后重命名': 'Rename after the current reply finishes',
        'WebChat 侧聊': 'WebChat side chat',
        '在右侧栏与当前 Agent 会话并行讨论': 'Discuss alongside the current Agent session in the right sidebar',
        '侧聊': 'Side chat',
        '从一条 DSH Agent 会话的标题栏打开侧聊,讨论不会打断当前工作。结论可按需交回父会话。': 'Open from an Agent session\'s header to discuss without interrupting the work. Conclusions can be handed back when you choose.',
        '在 DSH 中打开一条 Agent 会话,然后点会话标题旁的「侧聊」即可开始。': 'Open an Agent session in DSH, then pick "Side chat" next to its title to start.',
        'Side Chat 组件未启用。启用 WebChat 的 Agent 侧聊组件后即可使用。': 'The Side Chat component is not enabled. Enable WebChat\'s Agent side-chat component to use it.',
        '请先选择父任务检查点': 'Select a parent task checkpoint first',
        '保存失败': 'Save failed',
        '已启用 {a} / {b}': 'Enabled {a} / {b}', '共 {n} 个模型': '{n} models total',
        '启用 {name}': 'Enable {name}', '{n} 字符 · 停止输入后自动保存': '{n} chars · auto-saves after you stop typing',
        '删除模板「{name}」?默认模板删除后不再恢复。': 'Delete template "{name}"? Built-in templates cannot be restored once deleted.',
        'DeepSeek 官方': 'DeepSeek official', '如:学术 / 开发 / 语言': 'e.g. academic / dev / language',
        '支持变量:{{date}} {{model}} {{sessionTitle}} {{workspace}} {{selection}}(未解析变量会保留并在使用时提示)': 'Variables: {{date}} {{model}} {{sessionTitle}} {{workspace}} {{selection}} (unresolved variables are kept and flagged when used)',
        '搜索模型': 'Search models',
        '副本': 'copy', '默认模板': 'Built-in', '正在读取插件状态…': 'Loading plugin status…',
        'WebChat 组件当前已停用。重新启用后此面板会自动恢复。': 'The WebChat component is currently disabled. This panel recovers automatically once it is re-enabled.',
        'Rich 外部账本 ${cost}(合并合计 ${total})': 'Rich external ledger ${cost} (merged total ${total})',
      },
      ja: {
        '常规': '一般', '模型': 'モデル', '提示词': 'プロンプト', '用量与费用': '使用量と料金',
        '插件与工具': 'プラグインとツール', '文件': 'ファイル', '数据管理': 'データ管理', '外观': '外観',
        'ChatDS 设置': 'ChatDS 設定', '设置': '設定', '重试': '再試行',
        '正在读取 ChatDS 设置…': 'ChatDS 設定を読み込み中…', '设置保存失败。': '設定の保存に失敗しました。', '正在处理…': '処理中…',
        '插件能力加载失败，可以重试或查看诊断信息。': 'プラグイン機能の読み込みに失敗しました。再試行するか診断情報を確認できます。',
        '设置区暂时无法渲染，可以重试。': '設定エリアを描画できませんでした。再試行できます。',
        '诊断信息': '診断情報', '已跳过 {count} 个无法解析的插件条目。': '解析できない {count} 個のプラグイン項目をスキップしました。',
        '聊天界面语言': '表示言語', '跟随浏览器': 'ブラウザに従う',
        '发送快捷键': '送信ショートカット',
        '语音输入': '音声入力',
        '点击录音并确认转写后，音频会发送到已配置的 DeepSeek 接口，可能产生费用。': '録音して文字起こしを確定すると、音声は設定済みの DeepSeek エンドポイントへ送信されます。課金が発生する場合があります。',
        '已开启。优先使用 DSH 语音服务转写；服务不可用时回退 DeepSeek 转写(可能产生费用)。': 'オン。DSH 音声サービスを優先して文字起こしします。利用できない場合のみ DeepSeek にフォールバックします（課金の可能性あり）。',
        '已开启。未检测到 DSH 语音服务，转写将使用 DeepSeek 接口，可能产生费用。': 'オン。DSH 音声サービスが検出されないため、文字起こしは DeepSeek エンドポイントを使用します。課金が発生する場合があります。',
        '默认模式': '既定モード', '用于新建聊天。': '新しいチャットで使用します。', 'Plan · 只读工具': 'Plan(読み取り専用ツール)',
        '默认深度思考': '既定の深い思考', '可在聊天中选择当前模型支持的具体等级。': 'チャット内で現在のモデルが対応する具体的なレベルを選択できます。',
        '默认联网搜索': '既定のウェブ検索', '仅 DeepSeek 官方模型支持。': 'DeepSeek 公式モデルのみ対応。',
        '默认本地检索': '既定のローカル検索', '读取已授权目录内文件。': '許可したフォルダ内のファイルを読み取ります。',
        '记住上次使用的模型': '前回のモデルを記憶', '新会话沿用上次模型。': '新しいチャットで前回のモデルを使います。',
        'Plan 本地检索步数上限': 'Plan のローカル検索ステップ上限', '每次回复可调用只读工具的最大步数。': '返信ごとに読み取り専用ツールを呼び出せる最大ステップ数。',
        '基础请求诊断': 'リクエスト診断', '把每轮请求/用量摘要写入 Host 日志(不含正文)。': 'ターンごとのリクエスト/使用量の概要を Host ログに書き込みます(本文は含みません)。',
        '搜索模型…': 'モデルを検索…', '模型范围': 'モデル範囲', '全部可用': 'すべて利用', '自定义白名单': 'カスタム許可リスト',
        '一键全选': 'すべて選択', '全部关闭': 'すべて無効', '恢复默认(全部可用)': '既定に戻す(すべて利用)',
        '整组启/停': 'グループ一括切替', '收藏': 'お気に入り',
        '自定义白名单模式下,新发现的模型默认不出现在 WebChat 选择器中,需在此手动启用。禁用不影响 DSH 其他插件与凭证,仅限制 WebChat;当前会话正使用的模型被禁用时会明确提示且拒绝发送。': '許可リストモードでは、新しく見つかったモデルはここで有効化するまで WebChat のセレクターに表示されません。無効化は WebChat のみに影響し、他の DSH プラグインや認証情報には触れません。使用中のモデルが無効化された場合は明示的に通知し、送信をブロックします。',
        '正在读取 DSH 模型目录…': 'DSH モデルカタログを読み込み中…', '模型目录读取失败。请确认 DSH 模型服务可用后重试。': 'モデルカタログの読み込みに失敗しました。DSH モデルサービスを確認して再試行してください。',
        '无思考': '思考なし', '思考': '思考', '低': '低', '中': '中', '高': '高', '最高': '最大', '开启': 'オン', '关闭': 'オフ',
        '视觉': '視覚', '联网': 'ウェブ', '默认': '既定', '设为默认': '既定にする', '已禁用': '無効',
        '全局附加提示词': 'グローバル追加プロンプト', '追加在 DeepSeek 身份指令之后,每轮请求注入一次;不覆盖 DSH 原始指令与安全策略。': 'DeepSeek のアイデンティティ指示の後に追加され、ターンごとに 1 回注入されます。DSH 自身の指示や安全ポリシーは上書きしません。',
        '启用全局附加提示词': 'グローバル追加プロンプトを有効化',
        '提示词正文': 'プロンプト本文', '为空时不注入。': '空の場合は注入しません。', '停止输入后自动保存': '入力を止めると自動保存',
        '恢复默认(关闭并清空)': '既定に戻す(オフ&クリア)',
        '搜索模板…': 'テンプレートを検索…', '新建模板': 'テンプレートを作成', '正在读取模板…': 'テンプレートを読み込み中…',
        '名称': '名前', '分类': 'カテゴリ', '简介': '概要', '标签': 'タグ', '逗号分隔': 'カンマ区切り',
        '正文': '本文', '保存模板': 'テンプレートを保存', '取消': 'キャンセル', '编辑': '編集', '复制': '複製', '删除': '削除',
        '默认模板': '既定', '没有匹配的模板。': '一致するテンプレートがありません。',
        '正在读取费用数据…': '料金データを読み込み中…', '费用数据读取失败(dsh-cost-meter 未安装或未运行)。': '料金データの読み込みに失敗しました(dsh-cost-meter 未導入または未実行)。',
        '今日费用': '今日の料金', '暂无金额': '金額なし', 'Token 输入 {input} / 输出 {output} · 请求 {calls} 次': 'トークン入力 {input} / 出力 {output} · {calls} 回',
        '每日预算': '1 日の予算',
        'dsh-cost-meter 预算:已用 ${used} / 上限 ${cap}({period})': 'dsh-cost-meter 予算:使用 ${used} / 上限 ${cap}({period})',
        '每日': '毎日',
        '未设置。预算上限请在 dsh-cost-meter 原生设置中维护(ChatDS 不复制第二份预算配置)。': '未設定。予算上限は dsh-cost-meter のネイティブ設定で管理してください(ChatDS では複製しません)。',
        '预算提醒': '予算リマインダー', '基于 dsh-cost-meter 预算账目,达到阈值时在聊天页轻提示,不打断输入。': 'dsh-cost-meter の予算に基づき、しきい値に達したらチャット画面で控えめにお知らせします。入力は妨げません。',
        '提醒阈值': 'リマインダーしきい値', '预算提醒阈值(%)': '予算リマインダーしきい値(%)',
        '达到比例时提醒一次(按今日已用/预算上限)。': '比率に達したら 1 日 1 回お知らせします(今日の使用量/予算上限)。',
        '输入 1–100 的整数百分比。': '1–100 の整数(%)を入力。',
        '尚未设置每日预算。打开 dsh-cost-meter 原生设置配置预算上限后,提醒才会生效。': '1 日の予算が未設定です。dsh-cost-meter のネイティブ設定で上限を設定すると、リマインダーが機能します。',
        '打开 dsh-cost-meter 设置': 'dsh-cost-meter の設定を開く',
        '模型价格、历史账单与完整仪表盘以 dsh-cost-meter 为唯一来源,可在其原生设置中查看与配置。DeepSeek Rich 用量已按官方 external_usage 协议计入其外部账本(来源 chatds-rich),今日合计与预算合并口径包含 Rich。': 'モデル価格・履歴・完全なダッシュボードは dsh-cost-meter が唯一の情報源で、そのネイティブ設定で確認/設定できます。DeepSeek Rich の使用量は公式 external_usage プロトコルで外部台帳(ソース: chatds-rich)に計上され、今日の合計と統合予算ビューに含まれます。',
        '已启用的集成': '有効な統合', '模型工具权限只应用于当前 WebChat 会话。': 'モデルツール権限は現在の WebChat セッションにのみ適用されます。',
        '前往 DSH 插件管理器': 'DSH プラグインマネージャーを開く', '当前 Host 未提供插件管理服务。': 'この Host はプラグイン管理サービスを提供していません。',
        '当前没有可用的 WebChat 插件集成。': '利用可能な WebChat プラグイン統合がありません。',
        '已连接 · ': '接続済み · ', ' 个可授权组件': ' 個の認可可能コンポーネント', '服务集成': 'サービス統合',
        '已授权 1 个组件': '1 コンポーネントを認可済み', '部分授权': '一部認可', '未授权': '未認可',
        '正在读取会话权限…': 'セッション権限を読み込み中…', '打开一条 WebChat 会话后可授权。': 'WebChat セッションを開くと認可できます。',
        '查看详细工具': 'ツールを表示', '搜索授权文件夹': '許可フォルダを検索', '读取授权文件片段': '許可ファイルの断片を読む',
        '允许 WebChat 使用 {name}': 'WebChat に {name} を許可',
        '需要审批的工具可在 DSH Agent 中使用。': '承認が必要なツールは DSH Agent で使用できます。',
        '本地文件访问': 'ローカルファイルアクセス', '仅允许 WebChat 访问你选择的文件夹。可以随时添加或移除。': 'WebChat がアクセスできるのはあなたが選んだフォルダだけです。いつでも追加/削除できます。',
        '＋ 添加文件夹': '＋ フォルダを追加', '手动输入路径授权(无目录选择器的环境)': 'パスを手入力して許可(ディレクトリ選択子のない環境)',
        '输入要授权的文件夹绝对路径，如 /home/user/Documents': '許可するフォルダの絶対パス(例: /home/user/Documents)',
        '授权此文件夹': 'このフォルダを許可', '授权文件夹绝对路径': '絶対パス',
        'Host 会校验路径存在且可读；软链接跳出目录的部分不可访问。': 'Host はパスの存在と読み取り可否を検証します。シンボリックリンクで外へ出る部分にはアクセスできません。',
        '已授权文件夹 · ': '許可済みフォルダ · ', '还没有授权任何文件夹。添加后，开启本地检索即可搜索其中的文件。': '許可されたフォルダはまだありません。追加してローカル検索を有効にすると検索できます。',
        '可用': '利用可', '当前不可访问': '現在アクセス不可', '待检查': '未確認', '只读 · 包含子文件夹 · ': '読み取り専用 · サブフォルダ含む · ',
        '移除访问权限': 'アクセス権を削除',
        '文件支持与附件上传': 'ファイル対応と添付',
        '本地检索可按文件名查找 PDF 和图片，并可提取 TXT、Markdown、CSV、DOCX、XLSX、PPTX 等文件的正文。': 'ローカル検索はファイル名で PDF や画像を探し、TXT・Markdown・CSV・DOCX・XLSX・PPTX などの本文を抽出します。',
        '聊天附件由你主动选择，可按模型能力发送内容或交由云端解析。开启本地检索时，匹配的文件片段可能随提问发送给当前模型。': '添付は自分で選択します。モデルの能力に応じて内容を送信するか、クラウドで解析します。ローカル検索が有効な場合、一致したファイル断片が質問と共に現在のモデルへ送信されることがあります。',
        '移除文件夹会停止后续本地访问。聊天里已有的内容和已上传的附件会保留。': 'フォルダを削除すると今後のローカルアクセスは停止します。既存のチャット内容とアップロード済みの添付は保持されます。',
        '导入聊天记录': 'チャット履歴をインポート', '从 ZIP 或会话 JSON 预览并合并导入。': 'ZIP またはセッション JSON からプレビューして統合インポートします。',
        '导入': 'インポート', '导出聊天记录': 'チャット履歴をエクスポート', '选择会话下载 ZIP，或从单个会话下载 Markdown、JSON。': 'セッションを選んで ZIP をダウンロード、または 1 チャットを Markdown/JSON で出力します。',
        '打开导出': 'エクスポートを開く',
        '可在会话菜单中选择移除会话，并在确认前查看影响。': 'セッションメニューからチャットを削除できます。確認前に影響を確認できます。',
        '颜色模式': 'カラーモード', '跟随 DSH': 'DSH に従う', '浅色': 'ライト', '深色': 'ダーク', '跟随系统': 'システムに従う', '跟随 Windows': 'Windows に従う',
        '聊天界面风格': 'チャットスタイル', 'WebChat 默认': 'WebChat 既定', 'GPT 风格': 'GPT スタイル', 'Gemini 风格': 'Gemini スタイル', 'Claude 风格': 'Claude スタイル',
        '磨砂效果': 'すりガラス効果', '标准纯色': '無地', '轻度磨砂': '弱めのすりガラス', '明显磨砂': '強めのすりガラス',
        '当前环境使用纯色背景。': 'この環境では無地の背景を使用します。',
        '正文字号': '本文フォントサイズ', '阅读宽度': '読書幅', '跟随风格': 'スタイルに従う', '较窄': 'やや狭い', '较宽': 'やや広い',
        '主题强调色': 'アクセントカラー', '应用于发送按钮、用户气泡与链接。': '送信ボタン・ユーザー吹き出し・リンクに適用されます。',
        '背景透明度': '背景の不透明度', '降低后可透出 DSH 桌面/窗口背景。': '下げると DSH デスクトップやウィンドウの背景が透けます。',
        '浮动面板透明度': 'パネルの不透明度', '弹窗与菜单。': 'ダイアログとメニュー。', '输入框透明度': '入力欄の不透明度',
        '布局密度': 'レイアウト密度', '紧凑': 'コンパクト', '标准': '標準', '宽松': 'ゆったり',
        '行距': '行間', '圆角': '角丸', '输入框宽度': '入力欄の幅',
        '恢复 WebChat 默认外观': 'WebChat の外観をリセット', '只重置外观设置；聊天历史、模型与提示词不受影响。': '外観設定のみリセットします。履歴・モデル・プロンプトには影響しません。',
        '恢复默认': 'リセット', '默认': '既定',
        'WebChat 已就绪。若左侧未出现入口，点击刷新界面载入。': 'WebChat は準備できました。左側に入口が表示されない場合は「表示更新」で読み込んでください。',
        '刷新界面': '表示更新',
        '当前 DSH Desktop 无法打开文件夹选择器。': 'この DSH Desktop はフォルダ選択子を開けません。',
        '无法打开文件夹选择器。': 'フォルダ選択子を開けません。', 'DSH 文件保存服务不可用。': 'DSH のファイル保存サービスを利用できません。', '无法在 DSH Desktop 保存文件。': 'DSH Desktop でファイルを保存できません。',
        '请求失败(': 'リクエスト失敗(', '会话标题须为 1 至 200 个字符': 'チャットタイトルは 1〜200 文字で入力してください',
        '请在当前回复结束后重命名': '現在の返信が終わってから名前を変更してください',
        'WebChat 侧聊': 'WebChat サイドチャット',
        '在右侧栏与当前 Agent 会话并行讨论': '右サイドバーで現在の Agent セッションと並行して議論',
        '侧聊': 'サイドチャット',
        '从一条 DSH Agent 会话的标题栏打开侧聊,讨论不会打断当前工作。结论可按需交回父会话。': 'DSH Agent セッションのタイトルバーからサイドチャットを開けます。議論は現在の作業を妨げません。結論は必要に応じて親セッションへ渡せます。',
        '在 DSH 中打开一条 Agent 会话,然后点会话标题旁的「侧聊」即可开始。': 'DSH で Agent セッションを開き、タイトル横の「サイドチャット」を押すと始められます。',
        'Side Chat 组件未启用。启用 WebChat 的 Agent 侧聊组件后即可使用。': 'サイドチャットコンポーネントが無効です。WebChat の Agent サイドチャットを有効化すると使用できます。',
        '请先选择父任务检查点': 'まず親タスクのチェックポイントを選択してください',
        '保存失败': '保存に失敗しました',
        '已启用 {a} / {b}': '有効 {a} / {b}', '共 {n} 个模型': '合計 {n} モデル',
        '启用 {name}': '{name} を有効化', '{n} 字符 · 停止输入后自动保存': '{n} 文字 · 入力を止めると自動保存',
        '删除模板「{name}」?默认模板删除后不再恢复。': 'テンプレート「{name}」を削除しますか？既定テンプレートは削除後もとに戻せません。',
        'DeepSeek 官方': 'DeepSeek 公式', '如:学术 / 开发 / 语言': '例: 学術 / 開発 / 言語',
        '支持变量:{{date}} {{model}} {{sessionTitle}} {{workspace}} {{selection}}(未解析变量会保留并在使用时提示)': '変数: {{date}} {{model}} {{sessionTitle}} {{workspace}} {{selection}}(未解決の変数は保持され、使用時に表示されます)',
        '搜索模型': 'モデルを検索',
        '副本': 'コピー', '默认模板': '既定', '正在读取插件状态…': 'プラグイン状態を読み込み中…',
        'WebChat 组件当前已停用。重新启用后此面板会自动恢复。': 'WebChat コンポーネントは現在無効です。再度有効化すると自動的に復元されます。',
        'Rich 外部账本 ${cost}(合并合计 ${total})': 'Rich 外部台帳 ${cost}(統合合計 ${total})',
      },
    }

    /** 主面板:同源 iframe 撑满主区,保留聊天 SPA 的完整能力与样式隔离。 */
    function ChatWorkspacePanel({ theme }) {
      const frame = React.useRef(null)
      // R8.5(F04 兜底):插件被停用期间(Host 路由 404),面板显示明确的停用提示,
      // 而不是加载失败的白框;重新启用后 fetch 恢复,提示自动消失。
      const [unmounted, setUnmounted] = React.useState(false)
      React.useEffect(() => {
        let active = true
        const probe = () => {
          fetch(PAGE_PATH + '/api/health', { cache: 'no-store' })
            .then((response) => { if (active) setUnmounted(!response.ok) })
            .catch(() => { if (active) setUnmounted(true) })
        }
        probe()
        const timer = window.setInterval(probe, 8000)
        return () => { active = false; window.clearInterval(timer) }
      }, [])
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
      if (unmounted) {
        return h('div', { style: { height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--dsw-alias-label-secondary, inherit)' } },
          h('p', { style: { maxWidth: 360, lineHeight: 1.6, textAlign: 'center' } }, L('WebChat 组件当前已停用。重新启用后此面板会自动恢复。')))
      }
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
        if (typeof picker?.pick !== 'function') throw new Error(L('当前 DSH Desktop 无法打开文件夹选择器。'))
        post({ path: await picker.pick() })
      } catch (error) {
        post({ error: error instanceof Error ? error.message : L('无法打开文件夹选择器。') })
      }
    }

    async function saveDesktopDownload(frame, { id, blob, name }) {
      if (typeof id !== 'string' || !(blob instanceof Blob) || blob.size > 70 * 1024 * 1024 ||
          typeof name !== 'string' || !/^webchat-[a-z0-9-]+\.(zip|json|md|jpe?g|png|webp|gif|pdf|txt|csv|docx|xlsx|pptx|bin)$/.test(name)) return
      const post = (status, error) => frame.postMessage({ type: 'chatds:save-download-result', id, status, error }, location.origin)
      const actions = window.dshDesktop?.fileActions
      if (typeof actions?.save !== 'function') {
        post('error', L('DSH 文件保存服务不可用。'))
        return
      }
      const url = URL.createObjectURL(blob)
      try {
        const result = await actions.save({ url, name, mediaType: blob.type, mode: 'saveAs' })
        post(result.status)
      } catch {
        post('error', L('无法在 DSH Desktop 保存文件。'))
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
      if (!response.ok) throw new Error(data.error?.message ?? L('请求失败({status})', { status: response.status }))
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
      .chatds-settings button.chatds-settings-switch { display:flex; flex:0 0 34px; min-height:20px; padding:2px; border:0; border-radius:999px; background:color-mix(in srgb, var(--dsw-alias-label-secondary,#858b97) 62%, Canvas); align-items:center }
      .chatds-settings button.chatds-settings-switch[aria-checked=true] { background:var(--dsw-alias-brand-primary,#3b64ed) }
      .chatds-settings-switch span { width:16px; height:16px; border-radius:50%; background:white; transition:transform 120ms ease }
      .chatds-settings-switch[aria-checked=true] span { transform:translateX(14px) }
      .chatds-settings button.chatds-settings-switch:focus-visible { outline:2px solid var(--dsw-alias-brand-primary,#3b64ed); outline-offset:2px }
      .chatds-settings button.chatds-settings-switch[data-busy] span { animation:chatds-switch-busy 900ms ease-in-out infinite }
      @keyframes chatds-switch-busy { 0%,100% { opacity:1 } 50% { opacity:.45 } }
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
      .chatds-settings-errorbox { border:1px solid color-mix(in srgb,#d03050 40%,transparent); border-radius:10px; padding:12px 14px; margin:14px 0; display:grid; gap:8px; justify-items:start }
      .chatds-settings-errorbox p { margin:0 }
      .chatds-settings-errorbox pre { width:100%; box-sizing:border-box; font-size:11px; overflow:auto; max-height:160px; background:var(--dsw-specific-input-major,Canvas); border:1px solid var(--dsw-alias-border-l2,#8884); border-radius:8px; padding:8px; margin:0; white-space:pre-wrap }
      .chatds-range { display:flex; align-items:center; gap:10px }
      .chatds-range input[type=range] { width:150px; min-height:20px; padding:0; border:0; background:transparent; accent-color:var(--chat-accent, var(--dsw-alias-brand-primary,#3b64ed)) }
      .chatds-range small { min-width:64px; text-align:right }
      .chatds-settings input[type=color] { width:38px; height:28px; padding:2px; border-radius:8px }
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
    /** R8.5(F02):开关五态可辨——关闭灰轨/开启品牌色轨/禁用降透明/保存中脉动/失败由状态行提示。 */
    function Switch({ label, enabled, disabled, busy, onToggle }) {
      return h('button', { type: 'button', className: 'chatds-settings-switch', role: 'switch', 'aria-label': label,
        'aria-checked': enabled, 'aria-busy': busy === true || undefined, 'data-busy': busy === true || undefined,
        disabled: disabled || busy === true, onClick: onToggle }, h('span', { 'aria-hidden': true }))
    }

    // ── R8.6(P0):设置区错误边界。任何页面/插件条目渲染异常只降级自身区域, ──
    // ── 不再把整块设置区(乃至 DSH slot)渲染成空白;重试必须由用户点击触发,不做自动重试。 ──

    /** 脱敏的异常链文本:消息 + 堆栈前几行;剥离 URL 中的 token 等查询参数。 */
    const describeError = (error) => {
      const lines = [String(error?.message ?? error)]
      const stack = typeof error?.stack === 'string' ? error.stack : ''
      for (const line of stack.split('\n').slice(1, 5)) {
        lines.push(line.replace(/([?&])(token|key|secret)=[^&\s]*/g, '$1$2=…').trim())
      }
      return lines.join('\n')
    }

    class SettingsBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error }
      }
      componentDidCatch(error, info) {
        // 记录完整脱敏异常链,不吞掉详情;组件栈用于定位是哪一页/哪个条目。
        console.error('[chatds] 设置组件渲染失败(' + (this.props.label ?? '未知区域') + '):',
          describeError(error), typeof info?.componentStack === 'string' ? info.componentStack : '')
      }
      render() {
        if (!this.state.error) return this.props.children
        return h('div', { role: 'alert', className: 'chatds-settings-errorbox' },
          h('p', null, this.props.fallbackText ?? L('插件能力加载失败，可以重试或查看诊断信息。')),
          h('button', { type: 'button', onClick: () => this.setState({ error: null }) }, L('重试')),
          h('details', { className: 'chatds-details' },
            h('summary', null, L('诊断信息')),
            h('pre', null, describeError(this.state.error))))
      }
    }

    let pendingSave = null
    let failedSave = null

    // ── R8.6(修2):顶层语音采集桥 ──
    // 现象:DSH 原生语音在顶层页面录音正常,但 WebChat iframe 内 getUserMedia 得到 NotAllowedError
    // (Desktop 的权限处理只放行顶层媒体请求)。桥接方案(任务 4.3/4.4 的正式路径):iframe 请求 →
    // 顶层(与 DSH 原生语音同权限)录音 → WAV Blob 经 postMessage 结构化克隆回传 iframe → 走原转写链路。
    // 安全边界:只接受主聊天 iframe 的同源消息;同一时间只有一个录音任务;音量每 150ms 回传;
    // 120s 自动停止;停止/取消/卸载都立即释放设备;不绕过任何权限——复用的正是 DSH 原生语音已获授权的顶层环境。
    function createVoiceBridge() {
      const SAMPLE_RATE = 16000
      const MAX_MS = 120000
      const LEVEL_INTERVAL_MS = 150
      let active = null

      function frameWindow() {
        return document.querySelector('iframe[data-chatds-main]')?.contentWindow ?? null
      }
      function send(message) {
        const win = frameWindow()
        if (win) win.postMessage(message, location.origin)
      }
      function release(task) {
        if (!task) return
        if (task.timer) clearTimeout(task.timer)
        if (task.levelTimer) clearInterval(task.levelTimer)
        try { if (task.processor) task.processor.onaudioprocess = null } catch { /* 继续释放其余资源 */ }
        for (const node of [task.processor, task.analyser, task.source]) {
          try { node?.disconnect() } catch { /* 逐个释放 */ }
        }
        for (const track of task.stream?.getTracks() ?? []) {
          try { track.stop() } catch { /* 逐个释放 */ }
        }
        try { task.context?.close().catch(() => {}) } catch { /* 释放音频上下文 */ }
        if (active === task) active = null
      }
      function encodeWav(chunks, totalLength) {
        const buffer = new ArrayBuffer(44 + totalLength * 2)
        const view = new DataView(buffer)
        const writeString = (offset, text) => { for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i)) }
        writeString(0, 'RIFF')
        view.setUint32(4, 36 + totalLength * 2, true)
        writeString(8, 'WAVE')
        writeString(12, 'fmt ')
        view.setUint32(16, 16, true)
        view.setUint16(20, 1, true)
        view.setUint16(22, 1, true)
        view.setUint32(24, SAMPLE_RATE, true)
        view.setUint32(28, SAMPLE_RATE * 2, true)
        view.setUint16(32, 2, true)
        view.setUint16(34, 16, true)
        writeString(36, 'data')
        view.setUint32(40, totalLength * 2, true)
        let offset = 44
        for (const chunk of chunks) {
          for (let i = 0; i < chunk.length; i += 1) {
            const sample = Math.max(-1, Math.min(1, chunk[i]))
            view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true)
            offset += 2
          }
        }
        return new Blob([view], { type: 'audio/wav' })
      }
      async function start(requestId) {
        if (!requestId) return
        if (active) {
          send({ type: 'chatds:voice-capture-result', requestId, ok: false, name: 'BusyError' })
          return
        }
        if (typeof navigator.mediaDevices?.getUserMedia !== 'function') {
          send({ type: 'chatds:voice-capture-result', requestId, ok: false, name: 'NotFoundError' })
          return
        }
        let task
        try {
          // 权限应答超时保护:某些环境(无权限 UI 的嵌入视图)getUserMedia 永不落定,
          // 8s 无响应按 TimeoutError 上报,弹窗不无限停在"正在打开";迟到的流在落定后立即释放。
          let settled = false
          const stream = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              settled = true
              const error = new Error('getUserMedia timeout')
              error.name = 'TimeoutError'
              reject(error)
            }, 8000)
            navigator.mediaDevices.getUserMedia({
              // 约束与 DSH 官方语音输入完全一致(官方不含 channelCount;多设备环境下的
              // 额外约束可能造成 OverconstrainedError,没必要在此引入)。
              audio: { echoCancellation: true, noiseSuppression: true },
            }).then((value) => {
              clearTimeout(timeout)
              if (settled) {
                for (const track of value.getTracks()) track.stop()
                return
              }
              settled = true
              resolve(value)
            }, (error) => {
              clearTimeout(timeout)
              settled = true
              reject(error)
            })
          })
          task = { requestId, stream, chunks: [], length: 0 }
          active = task
          const AudioContextCtor = window.AudioContext ?? window.webkitAudioContext
          const context = new AudioContextCtor({ sampleRate: SAMPLE_RATE })
          task.context = context
          task.source = context.createMediaStreamSource(stream)
          task.processor = context.createScriptProcessor(4096, 1, 1)
          task.analyser = context.createAnalyser()
          task.processor.onaudioprocess = (event) => {
            if (active !== task) return
            const input = event.inputChannelData ?? event.inputBuffer.getChannelData(0)
            task.chunks.push(new Float32Array(input))
            task.length += input.length
          }
          task.source.connect(task.processor)
          task.processor.connect(task.analyser)
          // 音量反馈:按固定节奏取 analyser 的时域 RMS 回传(不回传音频本身)。
          const analyserBuffer = new Float32Array(task.analyser.fftSize)
          task.levelTimer = setInterval(() => {
            if (active !== task) return
            try {
              task.analyser.getFloatTimeDomainData(analyserBuffer)
              let sum = 0
              for (let i = 0; i < analyserBuffer.length; i += 1) sum += analyserBuffer[i] * analyserBuffer[i]
              send({ type: 'chatds:voice-level', requestId, level: Math.min(1, Math.sqrt(sum / analyserBuffer.length) * 4) })
            } catch { /* 单次电平失败不影响录音 */ }
          }, LEVEL_INTERVAL_MS)
          task.timer = setTimeout(() => stop(task.requestId), MAX_MS)
        } catch (error) {
          release(task)
          const name = error instanceof DOMException ? error.name : error?.name ?? 'UnknownError'
          send({ type: 'chatds:voice-capture-result', requestId, ok: false, name })
        }
      }
      function stop(requestId) {
        const task = active
        if (!task || task.requestId !== requestId) return
        const blob = task.length > 0 ? encodeWav(task.chunks, task.length) : null
        const stream = task.stream
        release(task)
        if (blob) send({ type: 'chatds:voice-capture-result', requestId, ok: true, blob })
        else send({ type: 'chatds:voice-capture-result', requestId, ok: false, name: 'NoAudioError' })
        void stream
      }
      function cancel(requestId) {
        const task = active
        if (!task || task.requestId !== requestId) return
        release(task)
        send({ type: 'chatds:voice-capture-cancelled', requestId })
      }
      function handle(event) {
        const data = event.data
        if (!data || typeof data.type !== 'string' || !data.type.startsWith('chatds:voice-')) return
        if (data.type === 'chatds:voice-bridge-query') {
          send({ type: 'chatds:voice-bridge-ready', available: typeof navigator.mediaDevices?.getUserMedia === 'function' })
          return
        }
        if (data.type === 'chatds:voice-capture-start') void start(String(data.requestId ?? ''))
        else if (data.type === 'chatds:voice-capture-stop') stop(String(data.requestId ?? ''))
        else if (data.type === 'chatds:voice-capture-cancel') cancel(String(data.requestId ?? ''))
      }
      return { handle }
    }

    /** 设置窗口关闭后，在途保存继续。重新打开可重试上次失败的修改。 */
    function ChatDSSettings({ theme, openData, openPlugins, pickDirectory, openCostMeter }) {
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
            syncUiLanguage(value?.interfaceLanguage)
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
            const message = reason.message || L('设置保存失败。')
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
        ? h('div', { role: 'alert' }, error, ' ', h('button', { type: 'button', onClick: () => retryLoad() }, L('重试')))
        : h('p', { role: 'status' }, L('正在读取 ChatDS 设置…'))
      const statusLine = error
        ? h('div', { key: 'status', className: 'chatds-status', 'data-tone': 'error', role: 'alert' }, error, ' ',
            failedSave && h('button', { type: 'button', disabled: busy, onClick: () => {
              const { retry, save } = failedSave
              void transact(retry, save)
            } }, L('重试')))
        : busy ? h(StatusLine, { key: 'status', state: { tone: 'pending', message: L('正在处理…') } }) : null
      const pages = ['常规', '模型', '提示词', '用量与费用', '插件与工具', '文件', '数据管理', '外观']
      const content = {
        常规: () => [
          h(Row, { keyId: 'language', label: L('聊天界面语言'),
            children: h('select', { 'aria-label': L('聊天界面语言'), value: settings.interfaceLanguage, disabled: busy,
              onChange: (event) => { const value = event.target.value; syncUiLanguage(value); void transact(() => ({ interfaceLanguage: value })) } },
              h('option', { value: 'browser' }, L('跟随浏览器')), h('option', { value: 'zh-CN' }, '简体中文'), h('option', { value: 'en-US' }, 'English'), h('option', { value: 'ja-JP' }, '日本語')) }),
          h(Row, { keyId: 'keys', label: L('发送快捷键'),
            children: h('select', { 'aria-label': L('发送快捷键'), value: settings.sendShortcut, disabled: busy,
              onChange: (event) => { const value = event.target.value; void transact(() => ({ sendShortcut: value })) } },
              h('option', { value: 'enter' }, 'Enter'), h('option', { value: 'ctrl-enter' }, IS_MAC_LIKE ? '⌘ + Enter' : 'Ctrl + Enter')) }),
          h(Row, { keyId: 'voice', label: L('语音输入'),
            description: settings.enableVoiceInput
              ? (settings.dshSpeechAvailable
                ? L('已开启。优先使用 DSH 语音服务转写；服务不可用时回退 DeepSeek 转写(可能产生费用)。')
                : L('已开启。未检测到 DSH 语音服务，转写将使用 DeepSeek 接口，可能产生费用。'))
              : L('点击录音并确认转写后，音频会发送到已配置的 DeepSeek 接口，可能产生费用。'),
            children: Switch({ label: L('语音输入'), enabled: settings.enableVoiceInput, disabled: busy, busy,
              onToggle: () => void transact(() => ({ enableVoiceInput: !settings.enableVoiceInput })) }) }),
          h(Row, { keyId: 'mode', label: L('默认模式'), description: L('用于新建聊天。'),
            children: h('select', { 'aria-label': L('默认模式'), value: settings.defaultMode, disabled: busy,
              onChange: (event) => { const mode = event.target.value; void transact(() => ({ defaultMode: mode })) } },
            h('option', { value: 'chat' }, 'Chat'), h('option', { value: 'plan' }, L('Plan · 只读工具'))) }),
          h(Row, { keyId: 'thinking', label: L('默认深度思考'), description: L('可在聊天中选择当前模型支持的具体等级。'),
            children: Switch({ label: L('默认深度思考'), enabled: settings.defaultThinking !== 'off', disabled: busy, busy,
              onToggle: () => void transact(() => ({ defaultThinking: settings.defaultThinking === 'off' ? 'enabled' : 'off' })) }) }),
          h(Row, { keyId: 'search', label: L('默认联网搜索'), description: L('仅 DeepSeek 官方模型支持。'),
            children: Switch({ label: L('默认联网搜索'), enabled: settings.defaultSearch === true, disabled: busy, busy,
              onToggle: () => void transact(() => ({ defaultSearch: !settings.defaultSearch })) }) }),
          h(Row, { keyId: 'localSearch', label: L('默认本地检索'), description: L('读取已授权目录内文件。'),
            children: Switch({ label: L('默认本地检索'), enabled: settings.defaultLocalSearch === true, disabled: busy, busy,
              onToggle: () => void transact(() => ({ defaultLocalSearch: !settings.defaultLocalSearch })) }) }),
          h(Row, { keyId: 'remember', label: L('记住上次使用的模型'), description: L('新会话沿用上次模型。'),
            children: Switch({ label: L('记住上次使用的模型'), enabled: settings.rememberLastModel === true, disabled: busy, busy,
              onToggle: () => void transact(() => ({ rememberLastModel: !settings.rememberLastModel })) }) }),
          h(Row, { keyId: 'steps', label: L('Plan 本地检索步数上限'), description: L('每次回复可调用只读工具的最大步数。'),
            children: h('input', { type: 'number', 'aria-label': L('Plan 本地检索步数上限'), min: 1, max: 20, key: settings.maxPlanSteps, defaultValue: settings.maxPlanSteps, disabled: busy,
              onBlur: (event) => { const steps = event.target.valueAsNumber; if (Number.isInteger(steps) && steps >= 1 && steps <= 20 && steps !== settings.maxPlanSteps) void transact(() => ({ maxPlanSteps: steps })) } }) }),
          h(Row, { keyId: 'diagnostics', label: L('基础请求诊断'), description: L('把每轮请求/用量摘要写入 Host 日志(不含正文)。'),
            children: Switch({ label: L('基础请求诊断'), enabled: settings.requestDiagnostics === true, disabled: busy, busy,
              onToggle: () => void transact(() => ({ requestDiagnostics: !settings.requestDiagnostics })) }) }),
        ],
        模型: () => h(ModelManager, { settings, busy, transact }),
        提示词: () => h(PromptManager, { settings, busy, transact }),
        用量与费用: () => h(CostManager, { settings, busy, transact, openCostMeter }),
        插件与工具: () => h(ToolManager, { openPlugins }),
        文件: () => h(FileAccess, { settings, busy, transact, pickDirectory }),
        数据管理: () => h(DataSettings, { openData }),
        外观: () => h(AppearanceSettings, { settings, busy, transact, theme }),
      }
      return h('section', { className: 'chatds-settings', 'aria-busy': busy },
        h('style', null, chatDSSettingsStyles),
        h('nav', { 'aria-label': L('ChatDS 设置') },
          pages.map((label) => h('button', { key: label, type: 'button', 'aria-pressed': page === label, onClick: () => setPage(label) }, L(label)))),
        // R8.6(P0):每页独立错误边界——单页渲染异常只降级该页卡片,导航仍可切换其他页。
        h('div', { className: 'chatds-settings-card' },
          h(SettingsBoundary, { key: page, label: page }, content[page]())), statusLine)
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
        h('h2', { key: 'title' }, L('本地文件访问')),
        h('p', { key: 'intro' }, L('仅允许 WebChat 访问你选择的文件夹。可以随时添加或移除。')),
        canPick && h('button', { key: 'add', type: 'button', disabled: busy, onClick: pickViaPicker }, L('＋ 添加文件夹')),
        h('details', { key: 'manual', className: 'chatds-details' },
          h('summary', null, L('手动输入路径授权(无目录选择器的环境)')),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 } },
            h('input', {
              type: 'text', value: manualPath, disabled: busy,
              placeholder: L('输入要授权的文件夹绝对路径，如 /home/user/Documents'),
              'aria-label': L('授权文件夹绝对路径'),
              onChange: (event) => setManualPath(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter' && manualPath.trim()) addManual() },
              style: { flex: '1 1 260px', minWidth: 220 },
            }),
            h('button', { type: 'button', disabled: busy || !manualPath.trim(), onClick: addManual }, L('授权此文件夹'))),
          h('p', { style: { marginTop: 6 } }, L('Host 会校验路径存在且可读；软链接跳出目录的部分不可访问。'))),
        settings.authorizedDirs.length
          ? h('h3', { key: 'count' }, L('已授权文件夹 · ') + settings.authorizedDirs.length)
          : h('p', { key: 'empty' }, L('还没有授权任何文件夹。添加后，开启本地检索即可搜索其中的文件。')),
        ...settings.authorizedDirs.map((path) => h(Row, {
          key: path, label: path.replace(/[\\\/]+$/, '').split(/[\\\/]/).pop() || path,
          description: h(React.Fragment, null, path, h('br'), L('只读 · 包含子文件夹 · ') + ' ',
            availability[path] === true ? L('可用') : availability[path] === false ? L('当前不可访问') : L('待检查')),
          children: h('button', { type: 'button', disabled: busy, onClick: () => void transact(
            () => ({ path }), (body) => apiSend('/api/file-access', 'DELETE', body)) }, L('移除访问权限')),
        })),
        h('details', { key: 'help', className: 'chatds-details' },
          h('summary', null, L('文件支持与附件上传')),
          h('p', null, L('本地检索可按文件名查找 PDF 和图片，并可提取 TXT、Markdown、CSV、DOCX、XLSX、PPTX 等文件的正文。')),
          h('p', null, L('聊天附件由你主动选择，可按模型能力发送内容或交由云端解析。开启本地检索时，匹配的文件片段可能随提问发送给当前模型。')),
          h('p', null, L('移除文件夹会停止后续本地访问。聊天里已有的内容和已上传的附件会保留。'))),
      ]
    }

    function DataSettings({ openData }) {
      return [
        h(Row, { key: 'import', label: L('导入聊天记录'), description: L('从 ZIP 或会话 JSON 预览并合并导入。'),
          children: h('button', { onClick: () => openData('import') }, L('导入')) }),
        h(Row, { key: 'export', label: L('导出聊天记录'), description: L('选择会话下载 ZIP，或从单个会话下载 Markdown、JSON。'),
          children: h('button', { onClick: () => openData('export') }, L('打开导出')) }),
        h('p', { key: 'retention' }, L('可在会话菜单中选择移除会话，并在确认前查看影响。')),
      ]
    }

    // ── R8.6(七):自由外观设置——单一默认布局 + 颜色/透明度/尺寸/密度直接可调。 ──

    /** 外观恢复默认补丁(null = Host 端清除该字段,回落官方 demo 默认观感)。 */
    const appearanceResetPatch = {
      appearanceAccent: null, appearanceBgAlpha: null, appearancePanelAlpha: null, appearanceComposerAlpha: null,
      appearanceLineHeight: null, appearanceRadius: null, appearanceDensity: null, appearanceComposerWidth: null,
    }

    /** 滑杆行:拖动中不提交,松手(native change)才保存;未设置时显示「默认」。 */
    function RangeRow({ keyId, label, description, min, max, step, value, defaultValue, format, disabled, onCommit }) {
      const current = value ?? defaultValue
      return h(Row, { keyId, label, description, children: h('span', { className: 'chatds-range' },
        h('input', { type: 'range', 'aria-label': label, min, max, step, defaultValue: current, disabled, key: String(current),
          ref: (el) => { if (el) el.onchange = (event) => onCommit(event.target.valueAsNumber) } }),
        h('small', null, value === undefined || value === null ? L('默认') : format(current))) })
    }

    function AppearanceSettings({ settings, busy, transact, theme }) {
      const hostMode = React.useSyncExternalStore(theme.subscribe, () => theme.getTheme().active.colorScheme)
      const media = React.useMemo(() => matchMedia('(prefers-color-scheme: dark)'), [])
      const systemDark = React.useSyncExternalStore(React.useCallback((listener) => {
        media.addEventListener('change', listener)
        return () => media.removeEventListener('change', listener)
      }, [media]), () => media.matches)
      const select = (field, label, options) => h(Row, { key: field, label, children: h('select', {
        'aria-label': label, value: settings[field], disabled: busy, onChange: (event) => {
          const value = event.target.value
          void transact(() => ({ [field]: field === 'readingFontSize' ? Number(value) : value }))
        },
      }, options.map(([key, label]) => h('option', { key, value: key }, label))) })
      const alphaRow = (field, label, description) => RangeRow({ keyId: field, label, description, min: 0.4, max: 1, step: 0.05,
        value: settings[field], defaultValue: 1, format: (v) => Math.round(v * 100) + '%',
        disabled: busy, onCommit: (v) => void transact(() => ({ [field]: Math.abs(v - 1) < 0.026 ? null : v })) })
      return [
        select('appearanceMode', L('颜色模式'), [['dsh', L('跟随 DSH')], ['light', L('浅色')], ['dark', L('深色')], ['system', navigator.platform.startsWith('Win') ? L('跟随 Windows') : L('跟随系统')]]),
        h(Row, { key: 'accent', label: L('主题强调色'), description: L('应用于发送按钮、用户气泡与链接。'),
          children: h('span', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            h('input', { type: 'color', 'aria-label': L('主题强调色'), disabled: busy,
              defaultValue: settings.appearanceAccent ?? '#3b64ed', key: settings.appearanceAccent ?? 'follow-dsh',
              ref: (el) => { if (el) el.onchange = (event) => void transact(() => ({ appearanceAccent: event.target.value })) } }),
            settings.appearanceAccent
              ? h('button', { type: 'button', disabled: busy, onClick: () => void transact(() => ({ appearanceAccent: null })) }, L('跟随 DSH'))
              : h('small', null, L('跟随 DSH'))) }),
        alphaRow('appearanceBgAlpha', L('背景透明度'), L('降低后可透出 DSH 桌面/窗口背景。')),
        alphaRow('appearancePanelAlpha', L('浮动面板透明度'), L('弹窗与菜单。')),
        alphaRow('appearanceComposerAlpha', L('输入框透明度'), null),
        select('appearanceDensity', L('布局密度'), [['compact', L('紧凑')], ['standard', L('标准')], ['relaxed', L('宽松')]]),
        RangeRow({ keyId: 'lineHeight', label: L('行距'), min: 1.4, max: 1.9, step: 0.05,
          value: settings.appearanceLineHeight, defaultValue: 1.65, format: (v) => v.toFixed(2),
          disabled: busy, onCommit: (v) => void transact(() => ({ appearanceLineHeight: Math.abs(v - 1.65) < 0.026 ? null : v })) }),
        RangeRow({ keyId: 'radius', label: L('圆角'), min: 0, max: 30, step: 1,
          value: settings.appearanceRadius, defaultValue: 24, format: (v) => v + ' px',
          disabled: busy, onCommit: (v) => void transact(() => ({ appearanceRadius: v === 24 ? null : v })) }),
        RangeRow({ keyId: 'composerWidth', label: L('输入框宽度'), min: 480, max: 1040, step: 20,
          value: settings.appearanceComposerWidth, defaultValue: 840, format: (v) => v + ' px',
          disabled: busy, onCommit: (v) => void transact(() => ({ appearanceComposerWidth: v === 840 ? null : v })) }),
        select('readingFontSize', L('正文字号'), [14, 15, 16, 17, 18, 19, 20].map((size) => [size, size + ' px'])),
        select('readingWidth', L('阅读宽度'), [['preset', L('跟随风格')], ['narrow', L('较窄')], ['wide', L('较宽')]]),
        select('appearanceGlass', L('磨砂效果'), [['off', L('标准纯色')], ['light', L('轻度磨砂')], ['strong', L('明显磨砂')]]),
        !CSS.supports('backdrop-filter', 'blur(8px)') && h('p', { key: 'fallback' }, L('当前环境使用纯色背景。')),
        h(Row, { key: 'reset', label: L('恢复 WebChat 默认外观'), description: L('只重置外观设置；聊天历史、模型与提示词不受影响。'),
          children: h('button', { type: 'button', disabled: busy, onClick: () => void transact(() => appearanceResetPatch) }, L('恢复默认')) }),
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
          { key: 'rich', name: L('DeepSeek 官方'), channel: 'rich', models: catalog.richModels.filter(filterEntry) },
          ...catalog.genericProviders.map((group) => ({ key: group.provider, name: group.name, channel: 'generic', provider: group.provider, models: group.models.filter(filterEntry) })),
        ]
      }, [catalog, query])

      if (catalog === null) return h('p', { role: 'status' }, L('正在读取 DSH 模型目录…'))
      if (catalog === false) return h('p', { role: 'alert' }, L('模型目录读取失败。请确认 DSH 模型服务可用后重试。'))
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
          h('div', { className: 'chatds-scope', role: 'group', 'aria-label': L('模型范围') },
            h('button', { type: 'button', 'aria-pressed': !whitelistMode, disabled: busy,
              onClick: () => void transact(() => ({ modelScope: 'all' })) }, L('全部可用')),
            h('button', { type: 'button', 'aria-pressed': whitelistMode, disabled: busy,
              onClick: () => void transact(() => ({ modelScope: 'whitelist' })) }, L('自定义白名单'))),
          h('input', { type: 'search', 'aria-label': L('搜索模型'), placeholder: L('搜索模型…'), value: query,
            onChange: (event) => setQuery(event.target.value) }),
          h('small', null, whitelistMode ? L('已启用 {a} / {b}', { a: enabledCount, b: allRefs.length }) : L('共 {n} 个模型', { n: allRefs.length }))),
        h('div', { key: 'actions', className: 'chatds-model-toolbar', style: { borderBottom: 'none', paddingTop: 8 } },
          h('button', { type: 'button', disabled: busy || allRefs.length === 0,
            onClick: () => void transact(() => ({ modelScope: 'whitelist', modelWhitelist: allRefs.map((entry) => ({ channel: entry.channel, provider: entry.provider, model: entry.model })) })) }, L('一键全选')),
          h('button', { type: 'button', disabled: busy || !whitelistMode || settings.modelWhitelist.length === 0,
            onClick: () => void transact(() => ({ modelWhitelist: [] })) }, L('全部关闭')),
          h('button', { type: 'button', disabled: busy, onClick: () => void transact(() => ({ modelScope: 'all', modelWhitelist: [] })) }, L('恢复默认(全部可用)'))),
        whitelistMode ? h('p', { key: 'scopeNote', style: { margin: '10px 0 0' } },
          h('small', null, L('自定义白名单模式下,新发现的模型默认不出现在 WebChat 选择器中,需在此手动启用。禁用不影响 DSH 其他插件与凭证,仅限制 WebChat;当前会话正使用的模型被禁用时会明确提示且拒绝发送。'))) : null,
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
              }) } }, L('整组启/停'))),
          !collapsed[group.key] && group.models.map((entry) => h('div', { key: modelKey(entry), className: 'chatds-model-row' },
            h('button', { type: 'button', className: 'chatds-star', 'aria-pressed': isFavorite(entry), 'aria-label': L('收藏'), disabled: busy,
              onClick: () => void transact(() => toggleFavorite(entry)) }, isFavorite(entry) ? '★' : '☆'),
            h('div', { className: 'chatds-model-name' }, entry.name,
              h('small', null, group.name + (whitelistMode && !isAllowed(entry) ? ' · ' + L('已禁用') : ''))),
            h('span', { className: 'chatds-chip' }, entry.capability.thinkingEfforts?.map((id) => effortChipNames[id] ?? id).join('/') || L('无思考')),
            entry.capability.vision ? h('span', { className: 'chatds-chip' }, L('视觉')) : null,
            entry.capability.nativeSearch ? h('span', { className: 'chatds-chip' }, L('联网')) : null,
            isDefault(entry) ? h('span', { className: 'chatds-chip', 'data-tone': 'brand' }, L('默认')) : null,
            h('button', { type: 'button', className: 'chatds-mini', disabled: busy || isDefault(entry), onClick: () => void transact(() => ({ defaultModel: { channel: entry.channel, provider: entry.provider, model: entry.model } })) }, L('设为默认')),
            h('button', { type: 'button', className: 'chatds-settings-switch', role: 'switch', 'aria-label': L('启用 {name}', { name: entry.name }),
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
          h(Row, { keyId: 'gp-enable', label: L('全局附加提示词'), description: L('追加在 DeepSeek 身份指令之后,每轮请求注入一次;不覆盖 DSH 原始指令与安全策略。'),
            children: Switch({ label: L('启用全局附加提示词'), enabled: settings.globalPromptEnabled === true, disabled: busy, busy,
              onToggle: () => void transact(() => ({ globalPromptEnabled: !settings.globalPromptEnabled })) }) }),
          h(Row, { keyId: 'gp-text', label: L('提示词正文'), description: gpText.length > 0 ? L('{n} 字符 · 停止输入后自动保存', { n: gpText.length }) : L('为空时不注入。'),
            children: h('textarea', { 'aria-label': L('提示词正文'), value: gpText, disabled: busy,
              onChange: (event) => {
                const text = event.target.value
                setGpText(text)
                window.clearTimeout(gpTimer.current)
                gpTimer.current = window.setTimeout(() => { void transact(() => ({ globalPromptText: text })) }, 900)
              } }) }),
          h('div', { key: 'gp-actions', className: 'chatds-model-toolbar', style: { borderBottom: 'none' } },
            h('button', { type: 'button', disabled: busy, onClick: () => void transact(() => ({ globalPromptEnabled: false, globalPromptText: '' })) }, L('恢复默认(关闭并清空)'))),
        ),
        h('div', { key: 'toolbar', className: 'chatds-model-toolbar' },
          h('input', { type: 'search', 'aria-label': L('搜索模板…'), placeholder: L('搜索模板…'), value: query, onChange: (event) => setQuery(event.target.value) }),
          h('button', { type: 'button', disabled: busy, onClick: () => setEditing({ name: '', category: '', summary: '', body: '', tags: [] }) }, L('新建模板'))),
        templates === null && error === '' ? h('p', { key: 'loading', role: 'status' }, L('正在读取模板…')) : null,
        error !== '' ? h('p', { key: 'error', role: 'alert' }, error) : null,
        editing !== null ? h('div', { key: 'editor' },
          h(Row, { keyId: 't-name', label: L('名称'), children: h('input', { type: 'search', style: { maxWidth: 'none', flex: 1 }, value: editing.name,
            onChange: (event) => setEditing({ ...editing, name: event.target.value }) }) }),
          h(Row, { keyId: 't-category', label: L('分类'), children: h('input', { type: 'search', style: { maxWidth: 'none', flex: 1 }, value: editing.category ?? '',
            placeholder: L('如:学术 / 开发 / 语言'), onChange: (event) => setEditing({ ...editing, category: event.target.value }) }) }),
          h(Row, { keyId: 't-summary', label: L('简介'), children: h('input', { type: 'search', style: { maxWidth: 'none', flex: 1 }, value: editing.summary ?? '',
            onChange: (event) => setEditing({ ...editing, summary: event.target.value }) }) }),
          h(Row, { keyId: 't-tags', label: L('标签'), description: L('逗号分隔'), children: h('input', { type: 'search', style: { maxWidth: 'none', flex: 1 }, value: (editing.tags ?? []).join(', '),
            onChange: (event) => setEditing({ ...editing, tags: event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean) }) }) }),
          h('div', { style: { padding: '12px 0' } },
            h('textarea', { 'aria-label': L('正文'), value: editing.body, onChange: (event) => setEditing({ ...editing, body: event.target.value }),
              placeholder: L('支持变量:{{date}} {{model}} {{sessionTitle}} {{workspace}} {{selection}}(未解析变量会保留并在使用时提示)') })),
          h('div', { className: 'chatds-model-toolbar', style: { borderBottom: 'none' } },
            h('button', { type: 'button', disabled: busy || !editing.name.trim() || !editing.body.trim(), onClick: () => void save() }, L('保存模板')),
            h('button', { type: 'button', disabled: busy, onClick: () => setEditing(null) }, L('取消')))) : null,
        filtered.map((template) => h('div', { key: template.id, className: 'chatds-template-row' },
          h('div', { className: 'chatds-template-main' },
            h('div', null, h('strong', null, template.name),
              template.category ? h('span', { className: 'chatds-chip', style: { marginLeft: 8 } }, template.category) : null,
              template.builtin === true ? h('span', { className: 'chatds-chip', style: { marginLeft: 4 } }, L('默认模板')) : null),
            template.summary ? h('small', null, template.summary) : null,
            h('pre', { className: 'chatds-template-body' }, template.body.length > 220 ? template.body.slice(0, 220) + '…' : template.body)),
          h('button', { type: 'button', className: 'chatds-mini', disabled: busy, onClick: () => setEditing({ ...template }) }, L('编辑')),
          h('button', { type: 'button', className: 'chatds-mini', disabled: busy, onClick: async () => {
            try {
              await apiSend('/api/prompts', 'POST', { name: template.name + ' (' + L('副本') + ')', category: template.category, summary: template.summary, body: template.body, tags: template.tags })
              reload()
            } catch (reason) { setError(reason.message) }
          } }, L('复制')),
          h('button', { type: 'button', className: 'chatds-mini', disabled: busy, onClick: async () => {
            if (!window.confirm(L('删除模板「{name}」?默认模板删除后不再恢复。', { name: template.name }))) return
            try {
              await apiSend('/api/prompts/' + encodeURIComponent(template.id), 'DELETE')
              reload()
            } catch (reason) { setError(reason.message) }
          } }, L('删除')))),
        filtered.length === 0 && templates !== null ? h('p', { key: 'empty' }, L('没有匹配的模板。')) : null,
        extra,
      ]
    }

    // ── 用量与费用(R8:今日费用/预算提醒;价格唯一来源是 dsh-cost-meter) ──

    function CostManager({ settings, busy, transact, openCostMeter, extra }) {
      const [today, setToday] = React.useState(null)
      React.useEffect(() => {
        let active = true
        apiGet('/api/cost/today').then((value) => { if (active) setToday(value) }, () => { if (active) setToday(false) })
        return () => { active = false }
      }, [])
      // R8.5(F07):阈值改为自由数值输入(1-100 整数),50/80/100 仅作快捷设置;数据源仍是
      // dsh-cost-meter 预算账目 + Rich 外部账本合并口径(budgetMerged)。
      const stored = Array.isArray(settings.budgetWarnThresholds) && settings.budgetWarnThresholds.length > 0
        ? settings.budgetWarnThresholds[0] : 0.8
      const thresholdPercent = Math.round(stored * 100)
      const noBudget = today !== null && today !== false && today.available === true
        && today.budgetMerged?.cap === undefined && today.budget?.cap === undefined
      return [
        today === null ? h('p', { key: 'loading', role: 'status' }, L('正在读取费用数据…')) : null,
        today === false ? h('p', { key: 'fail', role: 'alert' }, L('费用数据读取失败(dsh-cost-meter 未安装或未运行)。')) : null,
        today !== null && today !== false ? [
          h(Row, { keyId: 'today', label: L('今日费用'),
            description: today.available
              ? L('Token 输入 {input} / 输出 {output} · 请求 {calls} 次', { input: today.input, output: today.output, calls: (today.calls ?? 0) + (today.external?.calls ?? 0) })
                + (today.external?.cost !== undefined && today.external.cost > 0
                  ? ' · ' + L('Rich 外部账本 ${cost}(合并合计 ${total})', { cost: today.external.cost.toFixed(4), total: ((today.cost ?? 0) + today.external.cost).toFixed(4) })
                  : '')
              : today.reason,
            children: h('strong', null, typeof today.cost === 'number' || typeof today.external?.cost === 'number'
              ? '$' + ((today.cost ?? 0) + (today.external?.cost ?? 0)).toFixed(4)
              : L('暂无金额')) }),
          h(Row, { keyId: 'budget', label: L('每日预算'),
            description: (today.budgetMerged?.cap ?? today.budget?.cap) !== undefined
              ? L('dsh-cost-meter 预算:已用 ${used} / 上限 ${cap}({period})', {
                  used: Number(today.budgetMerged?.used ?? today.budget?.used ?? 0).toFixed(4),
                  cap: today.budgetMerged?.cap ?? today.budget?.cap,
                  period: today.budget?.period === 'day' ? L('每日') : today.budget?.period ?? 'period',
                })
              : L('未设置。预算上限请在 dsh-cost-meter 原生设置中维护(ChatDS 不复制第二份预算配置)。'),
            children: h('span', null, (today.budgetMerged?.ratio ?? today.budget?.ratio) !== undefined
              ? Math.round((today.budgetMerged?.ratio ?? today.budget?.ratio) * 100) + '%' : '—') }),
        ] : null,
        h(Row, { keyId: 'reminders', label: L('预算提醒'), description: L('基于 dsh-cost-meter 预算账目,达到阈值时在聊天页轻提示,不打断输入。'),
          children: Switch({ label: L('预算提醒'), enabled: settings.budgetRemindersEnabled === true, disabled: busy, busy,
            onToggle: () => void transact(() => ({ budgetRemindersEnabled: !settings.budgetRemindersEnabled })) }) }),
        h(Row, { keyId: 'thresholds', label: L('预算提醒阈值(%)'), description: L('达到比例时提醒一次(按今日已用/预算上限)。') + ' ' + L('输入 1–100 的整数百分比。'),
          children: h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
            h('input', { type: 'number', 'aria-label': L('预算提醒阈值(%)'), min: 1, max: 100, step: 1,
              key: 'threshold-' + thresholdPercent, defaultValue: thresholdPercent, disabled: busy,
              style: { width: 120, flexShrink: 0 }, 'aria-describedby': undefined,
              onBlur: (event) => {
                const value = Math.round(event.target.valueAsNumber)
                if (!Number.isInteger(value) || value < 1 || value > 100) {
                  event.target.value = String(thresholdPercent)
                  return
                }
                if (value !== thresholdPercent) void transact(() => ({ budgetWarnThresholds: [value / 100] }))
              } }),
            h('span', { 'aria-hidden': true }, '%')) }),
        noBudget && h(Row, { keyId: 'noBudget', label: L('每日预算'), description: L('尚未设置每日预算。打开 dsh-cost-meter 原生设置配置预算上限后,提醒才会生效。'),
          children: h('button', { type: 'button', disabled: busy, onClick: () => openCostMeter?.() }, L('打开 dsh-cost-meter 设置')) }),
        h('p', { key: 'prices' }, h('small', null, L('模型价格、历史账单与完整仪表盘以 dsh-cost-meter 为唯一来源,可在其原生设置中查看与配置。DeepSeek Rich 用量已按官方 external_usage 协议计入其外部账本(来源 chatds-rich),今日合计与预算合并口径包含 Rich。'))),
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
      const [loadAttempt, retryLoad] = React.useReducer((n) => n + 1, 0)
      const current = React.useRef(null)
      // R8.6(P0):目录 5s 轮询保留(页面卸载即停);连续失败 3 次后停止自动重试,
      // 改为错误行内"重试"按钮手动恢复,不允许错误期间无限请求。数据未变化时不再触发重渲染。
      React.useEffect(() => {
        let active = true
        let timer
        let failures = 0
        let lastJson = ''
        const refresh = async () => {
          try {
            const value = await apiGet('/api/integrations')
            if (!active) return
            const nextJson = JSON.stringify(value ?? null)
            if (nextJson !== lastJson) { lastJson = nextJson; setCatalog(value) }
            if (failures > 0) { failures = 0; setError('') }
            timer = setTimeout(refresh, 5000)
          } catch (reason) {
            if (!active) return
            failures += 1
            setCatalog(false)
            setError(reason.message)
            if (failures < 3) timer = setTimeout(refresh, 5000)
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
      }, [loadAttempt])
      React.useEffect(() => {
        let active = true
        setPermissions(null)
        if (sessionId) apiGet('/api/sessions/' + encodeURIComponent(sessionId) + '/tools').then((data) => {
          if (active) setPermissions(Array.isArray(data?.supported) ? data.supported : [])
        }, (reason) => { if (active) setError(reason.message) })
        return () => { active = false }
      }, [sessionId])

      const grant = async (names, allow) => {
        if (!sessionId || !Array.isArray(permissions) || pending) return
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
      // R8.6(P0):单个条目数据不合法时跳过并明确提示,不影响其他条目(不允许空白当作降级)。
      const bundles = Array.isArray(catalog?.bundles) ? catalog.bundles : []
      const validBundles = []
      let invalidBundles = 0
      for (const bundle of bundles) {
        if (bundle && typeof bundle === 'object' && typeof bundle.name === 'string' && Array.isArray(bundle.components)) validBundles.push(bundle)
        else invalidBundles += 1
      }
      return [
        h('div', { key: 'heading', className: 'chatds-settings-row' },
          h('div', null, h('strong', null, L('已启用的集成')), h('br'), h('small', null, L('模型工具权限只应用于当前 WebChat 会话。'))),
          h('button', { type: 'button', onClick: openPlugins }, L('前往 DSH 插件管理器'))),
        error && h('p', { key: 'error', role: 'alert' }, error, ' ',
          h('button', { type: 'button', onClick: () => retryLoad() }, L('重试'))),
        catalog === null && h('p', { key: 'loading', role: 'status' }, L('正在读取插件状态…')),
        catalog && !catalog.managementAvailable && h('p', { key: 'unavailable' }, L('当前 Host 未提供插件管理服务。')),
        catalog?.managementAvailable && !bundles.length && h('p', { key: 'empty' }, L('当前没有可用的 WebChat 插件集成。')),
        invalidBundles > 0 && h('p', { key: 'invalid', role: 'status' }, L('已跳过 {count} 个无法解析的插件条目。', { count: invalidBundles })),
        ...validBundles.map((bundle) => h(SettingsBoundary, {
          key: bundle.name, label: bundle.name,
        }, h(BundleCard, { bundle, permissions, sessionId, pending, grant }))),
        h('p', { key: 'approval' }, L('需要审批的工具可在 DSH Agent 中使用。')),
      ]
    }

    /** 单个插件集成卡片:在独立错误边界内渲染,一个条目异常不影响其他条目。 */
    function BundleCard({ bundle, permissions, sessionId, pending, grant }) {
      const includesLocal = bundle.components.some((component) => component && component.kind === 'local')
      const enabled = permissions?.filter((tool) => tool && tool.enabled).length ?? 0
      return h('details', { className: 'chatds-bundle' },
        h('summary', null,
          bundle.icon && h('img', { src: bundle.icon, width: 18, height: 18, alt: '' }),
          h('strong', null, bundle.title), h('small', null, L('已连接 · ') + (includesLocal ? '1' + L(' 个可授权组件') : L('服务集成'))),
          includesLocal && permissions && h('small', null, enabled === permissions.length ? L('已授权 1 个组件') : enabled ? L('部分授权') : L('未授权'))),
        h('p', null, bundle.description),
        bundle.components.map((component) => h('section', { key: component.id, className: 'chatds-component' },
          h(Row, { label: component.title, description: component.description, children: component.kind === 'local'
            ? Switch({ label: L('允许 WebChat 使用 {name}', { name: component.title }), enabled: Boolean(enabled), disabled: !permissions?.length || pending, busy: pending,
                onToggle: () => void grant(permissions.map((tool) => tool.name), !enabled) })
            : null }),
          component.kind === 'local' && (!permissions
            ? h('p', null, sessionId ? L('正在读取会话权限…') : L('打开一条 WebChat 会话后可授权。'))
            : h('details', { className: 'chatds-details' }, h('summary', null, L('查看详细工具')),
              permissions.map((tool) => {
                const name = tool.name === 'chatds_search_files' ? L('搜索授权文件夹') : L('读取授权文件片段')
                return h(Row, { key: tool.name, label: name, description: h('code', null, tool.name),
                  children: Switch({ label: name, enabled: tool.enabled, disabled: pending, busy: pending,
                    onToggle: () => void grant([tool.name], !tool.enabled) }) })
              })))))
      )
    }

    // ────────────────────────── R8.5(F09):Side Chat 右栏 tab ──────────────────────────

    /** 右栏 tab 体:iframe 承载 sidecar 页面(?parent= 自动关联父 Agent 会话)。 */
    function SideChatTab(props) {
      const tabInfo = typeof props?.useTabInfo === 'function' ? props.useTabInfo() : null
      const parent = tabInfo?.tab?.navigation?.params?.parent
      const [sidecar, setSidecar] = React.useState(null) // null=检测中,true=可用,false=未启用
      React.useEffect(() => {
        let active = true
        fetch(SIDECAR_PAGE + '/api/health', { cache: 'no-store' })
          .then((response) => { if (active) setSidecar(response.ok) })
          .catch(() => { if (active) setSidecar(false) })
        return () => { active = false }
      }, [])
      const frameStyle = { border: 0, display: 'block', width: '100%', height: '100%', background: 'var(--dsw-specific-sidebar-fill, Canvas)' }
      if (!parent) {
        return h('div', { style: { height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, color: 'var(--dsw-alias-label-secondary, inherit)', textAlign: 'center' } },
          h('p', { style: { maxWidth: 320, lineHeight: 1.6 } }, L('在 DSH 中打开一条 Agent 会话,然后点会话标题旁的「侧聊」即可开始。')))
      }
      if (sidecar === false) {
        return h('div', { style: { height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 } },
          h('p', { style: { maxWidth: 360, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary, inherit)' } },
            L('Side Chat 组件未启用。启用 WebChat 的 Agent 侧聊组件后即可使用。')))
      }
      return h('iframe', {
        key: parent,
        src: SIDECAR_PAGE + '?parent=' + encodeURIComponent(parent),
        title: L('WebChat 侧聊'),
        allow: 'clipboard-write',
        style: frameStyle,
      })
    }

    /** 会话标题栏入口:带当前 sessionId 打开右栏 tab(自动关联父会话)。 */
    function SideChatHeaderAction(props) {
      return h('button', {
        type: 'button',
        onClick: (event) => {
          event.stopPropagation()
          props?.open?.()
        },
        style: {
          border: 0, background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 12,
          padding: '3px 8px', borderRadius: 8, cursor: 'pointer',
        },
      }, L('侧聊'))
    }

    // ────────────────────────── 设置入口 / 面板注册 ──────────────────────────

    // R8.6(11.3):暂存 DSH 注入的 openSettings(接受 section id),供状态条费用段直达
    // cost-meter 的「费用」设置区;launcher 常驻,引用始终可用。
    const openSettingsRef = { current: null }

    function SettingsLauncher({ wide, settingsOpen, settingsShortcut, openSettings }) {
      React.useEffect(() => {
        openSettingsRef.current = typeof openSettings === 'function' ? openSettings : null
        return () => { openSettingsRef.current = null }
      }, [openSettings])
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
        type: 'button', 'aria-label': L('设置'), 'aria-haspopup': 'dialog', 'aria-expanded': settingsOpen,
        'aria-keyshortcuts': settingsShortcut?.aria,
        onClick: () => openSettings(),
        style: { color: 'inherit', background: 'transparent', border: 0, padding: 6, cursor: 'pointer' },
      }, wide ? '⚙ ' + L('设置') : '⚙')
    }

    return {
      inject: ['slots', 'theme', 'layout'],
      apply(ctx) {
        const theme = { getTheme: () => ctx.theme.getTheme(), subscribe: (listener) => ctx.on('theme/change', listener) }
        // R8.6(修2):顶层语音采集桥(单实例;消息处理在下方统一监听里)。
        const voiceBridge = createVoiceBridge()
        ctx.effect(() => {
          const onMessage = (event) => {
            if (event.origin !== location.origin) return
            const frame = document.querySelector('iframe[data-chatds-main]')
            if (event.source !== frame?.contentWindow) return
            // 语音桥消息优先(采集中事件频繁,不落后面的面板分支)。
            if (typeof event.data?.type === 'string' && event.data.type.startsWith('chatds:voice-')) {
              voiceBridge.handle(event)
              return
            }
            if (event.data?.type === 'chatds:open-work-branch' && /^session-[a-f0-9-]{36}$/.test(event.data.sessionId)) {
              ctx.get('uiWorkspace')?.openSession(event.data.sessionId)
            }
            // R8.6(5.3A):上下文详情 → dsh-context 原生面板(官方 sidebar.panellist id = 'dsh-context')。
            if (event.data?.type === 'chatds:open-context') {
              try { ctx.layout?.selectPanel('dsh-context') } catch { /* 面板不存在时忽略 */ }
            }
            // R8.6(11.3):费用/预算段 → dsh-cost-meter 的「费用」设置区(openSettings 支持 section id)。
            if (event.data?.type === 'chatds:open-cost') {
              const open = openSettingsRef.current
              if (open) open('cost-meter')
              else ctx.layout?.selectPanel('settings')
            }
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
        // R8.6(0.11.3):注册模式重构(对齐 dsh-plugin-magi 等实测可靠的官方社区插件)——
        // 所有槽位注册一律包进 ctx.effect(声明式、可随效果图重放),外层 safeRegister 失败隔离:
        // 单条注册失败只警告自身,不再让整个插件 fiber 失败并把已注册的入口一起回滚
        // (这正是"安装/更新后 WebChat 入口不出现、要关了再开"而 MAGI 不受影响的根因)。
        const safeRegister = (label, fn) => {
          try {
            ctx.effect(fn, 'chatds slot ' + label)
          } catch (error) {
            try { console.warn('[chatds] 槽位注册失败(' + label + '):', error) } catch { /* console 不可用时忽略 */ }
          }
        }
        safeRegister('settings.section', () => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'chatds', order: 60, label: () => L('ChatDS 设置'),
        }, ({ close }) => h(SettingsBoundary, { label: 'ChatDS 设置', fallbackText: L('设置区暂时无法渲染，可以重试。') },
          h(ChatDSSettings, { theme, pickDirectory, openCostMeter: () => ctx.layout.selectPanel('settings'), openData(action) {
            const frame = document.querySelector('iframe[data-chatds-main]')
            if (frame?.contentWindow) frame.contentWindow.postMessage({ type: 'chatds:data', action }, location.origin)
            else {
              pendingDataAction = action
              ctx.layout.selectPanel(PANEL_ID)
            }
            close?.()
          }, openPlugins: () => { close?.(); ctx.layout.selectPanel('plugins') } })))))
        safeRegister('settings.launcher', () => ctx.slots.inject('settings.launcher', () => ctx.slots.register({ name: 'settings.launcher' }, SettingsLauncher)))
        // 全局主面板:key 与导航行 id 相同,侧栏选择后由 layout 渲染本组件。
        safeRegister('main', () => ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID }, Panel)))
        // 左侧导航行(图标 + 名称)。选中后 layout.selectPanel(PANEL_ID) 切到上面的主面板。
        safeRegister('sidebar.panellist', () => ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 10,
              label: () => 'WebChat',
            },
            ChatWorkspaceIcon,
          )))
        // ── R8.5(F09):Side Chat —— 右栏 tab(kind 全局唯一,与 dsh-better-sidebar 的 sidechat 不冲突)──
        // tab 类型注册经 ctx.inject 等待 sidebarRightTabs 服务就绪(官方 ui-subagent 同款模式);
        // guide 入口出现在右栏"+"页面。整条依赖同样失败隔离。
        safeRegister('sidebarRightTabs', () => ctx.inject(['sidebarRightTabs'], (scope) => {
          scope.effect(() => scope.sidebarRightTabs.register({
            id: SIDECHAT_ID,
            kind: SIDECHAT_KIND,
            title: () => L('WebChat 侧聊'),
            guide: [{
              id: 'side-chat',
              order: 30,
              title: () => L('WebChat 侧聊'),
              description: () => L('在右侧栏与当前 Agent 会话并行讨论'),
            }],
          }), 'chatds: side chat tab type')
        }))
        // tab 体(keyed 槽,key = definition.id)。
        safeRegister('sidebar.right.pane.tab', () => ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register({ name: 'sidebar.right.pane.tab', key: SIDECHAT_ID }, SideChatTab)))
        // 会话标题栏入口(kind=list, scope=session;inject 提供 sessionId 与 open 动作)。
        safeRegister('conversation.session.header.actions', () => ctx.slots.inject('conversation.session.header.actions', () =>
          ctx.slots.register({
            name: 'conversation.session.header.actions',
            id: 'chatds-side-chat',
            order: 12,
            inject: (sessionId) => ({
              sessionId,
              open: () => {
                const bar = ctx.get('sidebarRight')
                if (typeof bar?.openTab === 'function') {
                  bar.openTab(SIDECHAT_KIND, { params: { parent: sessionId } })
                }
              },
            }),
          }, SideChatHeaderAction)))
        // R8.6(修1):安装/更新后导航自检兜底(注册模式修复后的最后保险)——最多等 12s,
        // 仍未出现就挂出非阻塞提示条,一键刷新界面(location.reload);导航出现即自动撤条。
        safeRegister('nav self-check', () => {
          let checks = 0
          let banner = null
          const findNav = () => {
            if (document.querySelector('img[src*="webchat-icon"]')) return true
            const navList = document.querySelector('[data-slot="sidebar.panellist"]') ?? document.querySelector('nav[aria-label]')
            if (!navList) return false
            return Array.from(navList.querySelectorAll('button')).some((node) => (node.textContent ?? '').includes('WebChat'))
          }
          const removeBanner = () => {
            if (banner) { banner.remove(); banner = null }
          }
          const timer = setInterval(() => {
            checks += 1
            try {
              if (findNav()) {
                removeBanner()
                clearInterval(timer)
                return
              }
              if (checks > 12 || !document.body) {
                clearInterval(timer)
                removeBanner()
                return
              }
              if (checks < 2 || banner) return
              banner = document.createElement('div')
              banner.setAttribute('data-chatds-refresh-banner', '')
              banner.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483000;display:flex;gap:10px;align-items:center;padding:10px 14px;border-radius:12px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#111);box-shadow:0 8px 24px rgba(0,0,0,.25);font:13px/1.4 var(--dsw-font-family,sans-serif);max-width:min(430px,80vw)'
              const text = document.createElement('span')
              text.textContent = L('WebChat 已就绪。若左侧未出现入口，点击刷新界面载入。')
              const button = document.createElement('button')
              button.type = 'button'
              button.textContent = L('刷新界面')
              button.style.cssText = 'border:0;border-radius:8px;padding:6px 12px;cursor:pointer;color:#fff;background:var(--chat-accent,var(--dsw-alias-brand-primary,#3b64ed));font:inherit;flex:none'
              button.addEventListener('click', () => location.reload())
              banner.append(text, button)
              document.body.append(banner)
            } catch {
              clearInterval(timer)
              removeBanner()
            }
          }, 1000)
          return () => { clearInterval(timer); removeBanner() }
        })
      },
    }
  },
})
