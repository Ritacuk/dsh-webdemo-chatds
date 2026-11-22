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
        '聊天界面语言': 'Interface language', '跟随浏览器': 'Follow browser',
        '发送快捷键': 'Send shortcut', 'Enter': 'Enter', 'Ctrl + Enter': 'Ctrl + Enter', '⌘ + Enter': '⌘ + Enter',
        '语音输入': 'Voice input',
        '点击录音并确认转写后，音频会发送到已配置的 DeepSeek 接口，可能产生费用。': 'After you record and confirm transcription, audio is sent to the configured DeepSeek endpoint. Charges may apply.',
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
        '输入 1–100 的整数百分比,失焦保存。': 'Enter 1–100 (%); saved on blur.',
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
        '聊天界面语言': '表示言語', '跟随浏览器': 'ブラウザに従う',
        '发送快捷键': '送信ショートカット',
        '语音输入': '音声入力',
        '点击录音并确认转写后，音频会发送到已配置的 DeepSeek 接口，可能产生费用。': '録音して文字起こしを確定すると、音声は設定済みの DeepSeek エンドポイントへ送信されます。課金が発生する場合があります。',
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
        '输入 1–100 的整数百分比,失焦保存。': '1–100 の整数(%)を入力。フォーカスを外すと保存します。',
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
    /** R8.5(F02):开关五态可辨——关闭灰轨/开启品牌色轨/禁用降透明/保存中脉动/失败由状态行提示。 */
    function Switch({ label, enabled, disabled, busy, onToggle }) {
      return h('button', { type: 'button', className: 'chatds-settings-switch', role: 'switch', 'aria-label': label,
        'aria-checked': enabled, 'aria-busy': busy === true || undefined, 'data-busy': busy === true || undefined,
        disabled: disabled || busy === true, onClick: onToggle }, h('span', { 'aria-hidden': true }))
    }

    let pendingSave = null
    let failedSave = null

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
          h(Row, { keyId: 'voice', label: L('语音输入'), description: L('点击录音并确认转写后，音频会发送到已配置的 DeepSeek 接口，可能产生费用。'),
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
        select('appearanceMode', L('颜色模式'), [['dsh', L('跟随 DSH')], ['light', L('浅色')], ['dark', L('深色')], ['system', navigator.platform.startsWith('Win') ? L('跟随 Windows') : L('跟随系统')]]),
        h('h3', { key: 'title' }, L('聊天界面风格')),
        h('div', { key: 'styles', className: 'chatds-preview-grid' }, presets.map(([key, label, color]) =>
          h('button', { key, type: 'button', className: 'chatds-preview', 'data-style': key, 'data-dark': dark,
            'aria-label': L(label), 'aria-pressed': settings.appearanceStyle === key, disabled: busy,
            style: { '--preview-accent': color }, onClick: () => void transact(() => ({ appearanceStyle: key })) },
          h('span', { 'aria-hidden': true, className: 'chatds-preview-chat' },
            h('span', null, '周末去哪儿？'), h('span', null, '去书店坐坐。'), h('span', null, '发消息　　 ＋　↑')),
          h('strong', null, L(label))))),
        select('appearanceGlass', L('磨砂效果'), [['off', L('标准纯色')], ['light', L('轻度磨砂')], ['strong', L('明显磨砂')]]),
        !CSS.supports('backdrop-filter', 'blur(8px)') && h('p', { key: 'fallback' }, L('当前环境使用纯色背景。')),
        select('readingFontSize', L('正文字号'), [14, 15, 16, 17, 18, 19, 20].map((size) => [size, size + ' px'])),
        select('readingWidth', L('阅读宽度'), [['preset', L('跟随风格')], ['narrow', L('较窄')], ['wide', L('较宽')]]),
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
      const quickValues = [50, 80, 100]
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
        h(Row, { keyId: 'thresholds', label: L('预算提醒阈值(%)'), description: L('达到比例时提醒一次(按今日已用/预算上限)。') + ' ' + L('输入 1–100 的整数百分比,失焦保存。'),
          children: h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
            h('input', { type: 'number', 'aria-label': L('预算提醒阈值(%)'), min: 1, max: 100, step: 1,
              key: 'threshold-' + thresholdPercent, defaultValue: thresholdPercent, disabled: busy,
              style: { width: 76 }, 'aria-describedby': undefined,
              onBlur: (event) => {
                const value = Math.round(event.target.valueAsNumber)
                if (!Number.isInteger(value) || value < 1 || value > 100) {
                  event.target.value = String(thresholdPercent)
                  return
                }
                if (value !== thresholdPercent) void transact(() => ({ budgetWarnThresholds: [value / 100] }))
              } }),
            h('span', { 'aria-hidden': true }, '%'),
            quickValues.map((value) => h('button', { key: value, type: 'button', className: 'chatds-mini',
              'aria-pressed': thresholdPercent === value, disabled: busy,
              onClick: () => void transact(() => ({ budgetWarnThresholds: [value / 100] })) }, value + '%'))) }),
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
          h('div', null, h('strong', null, L('已启用的集成')), h('br'), h('small', null, L('模型工具权限只应用于当前 WebChat 会话。'))),
          h('button', { type: 'button', onClick: openPlugins }, L('前往 DSH 插件管理器'))),
        error && h('p', { key: 'error', role: 'alert' }, error),
        catalog === null && h('p', { key: 'loading', role: 'status' }, L('正在读取插件状态…')),
        catalog && !catalog.managementAvailable && h('p', { key: 'unavailable' }, L('当前 Host 未提供插件管理服务。')),
        catalog?.managementAvailable && !catalog.bundles.length && h('p', { key: 'empty' }, L('当前没有可用的 WebChat 插件集成。')),
        ...((catalog && catalog.bundles) || []).map((bundle) => {
          const includesLocal = bundle.components.some((component) => component.kind === 'local')
          const enabled = permissions?.filter((tool) => tool.enabled).length ?? 0
          return h('details', { key: bundle.name, className: 'chatds-bundle' },
            h('summary', null,
              bundle.icon && h('img', { src: bundle.icon, width: 18, height: 18, alt: '' }),
              h('strong', null, bundle.title), h('small', null, L('已连接 · ') + (includesLocal ? '1' + L(' 个可授权组件') : L('服务集成'))),
              includesLocal && permissions && h('small', null, enabled === permissions.length ? L('已授权 1 个组件') : enabled ? L('部分授权') : L('未授权'))),
            h('p', null, bundle.description),
            bundle.components.map((component) => h('section', { key: component.id, className: 'chatds-component' },
              h(Row, { label: component.title, description: component.description, children: component.kind === 'local'
                ? Switch({ label: L('允许 WebChat 使用 {name}', { name: component.title }), enabled: Boolean(enabled), disabled: !permissions?.length || pending, busy,
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
        }),
        h('p', { key: 'approval' }, L('需要审批的工具可在 DSH Agent 中使用。')),
      ]
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
          name: 'settings.section', id: 'chatds', order: 60, label: () => L('ChatDS 设置'),
        }, ({ close }) => h(ChatDSSettings, { theme, pickDirectory, openCostMeter: () => ctx.layout.selectPanel('settings'), openData(action) {
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
              label: () => 'WebChat',
            },
            ChatWorkspaceIcon,
          ))
        // ── R8.5(F09):Side Chat —— 右栏 tab(kind 全局唯一,与 dsh-better-sidebar 的 sidechat 不冲突)──
        // tab 类型注册经 ctx.inject 等待 sidebarRightTabs 服务就绪(官方 ui-subagent 同款模式);
        // guide 入口出现在右栏"+"页面。
        ctx.inject(['sidebarRightTabs'], (scope) => {
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
        })
        // tab 体(keyed 槽,key = definition.id)。
        ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register({ name: 'sidebar.right.pane.tab', key: SIDECHAT_ID }, SideChatTab))
        // 会话标题栏入口(kind=list, scope=session;inject 提供 sessionId 与 open 动作)。
        ctx.slots.inject('conversation.session.header.actions', () =>
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
          }, SideChatHeaderAction))
      },
    }
  },
})
