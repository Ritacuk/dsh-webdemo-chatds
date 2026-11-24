import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { useTheme } from '../../app/theme.js'
import { useSettings } from '../../services/settings.js'
import { useChatStore } from '../../store/workspace.js'
import {
  defaultDesign, designVariables, readDesignImage, updateDesign, useChatDesign,
  type Design, type Identity, type Palette, type Surface, type SurfaceStyle, type Tone,
} from '../../services/chatDesign.js'
import { Modal } from '../base/Modal.js'
import styles from './ChatDesign.module.css'

type Copy = readonly [string, string, string]
const useCopy = () => {
  const locale = useSettings((state) => state.locale)
  return ([zh, en, ja]: Copy) => locale === 'zh-CN' ? zh : locale === 'ja-JP' ? ja : en
}
const assistantName = ['助手', 'Assistant', 'アシスタント'] as const
const labels = {
  background: ['聊天背景', 'Chat background', 'チャットの背景'],
  sidebar: ['会话导航', 'Conversation sidebar', '会話サイドバー'],
  user: ['用户气泡', 'User bubble', 'ユーザーの吹き出し'],
  assistant: ['助手气泡', 'Assistant bubble', 'アシスタントの吹き出し'],
  composer: ['输入框', 'Message composer', '入力欄'],
  panel: ['浮动面板', 'Floating panel', 'フローティングパネル'],
  divider: ['分割线', 'Dividers', '区切り線'],
} satisfies Record<Surface, Copy>
const presets: { name: Copy; palette: Palette }[] = [
  { name: ['默认', 'Default', '既定'], palette: {} },
  { name: ['浅色', 'Light', 'ライト'], palette: { background: { color: '#f8faff' }, sidebar: { color: '#e9effc' }, user: { color: '#dce7ff' }, panel: { color: '#ffffff' }, composer: { color: '#ffffff' }, text: '#202e46', secondary: '#425675' } },
  { name: ['暗夜', 'Midnight', 'ミッドナイト'], palette: { background: { color: '#141827' }, sidebar: { color: '#1b2133' }, user: { color: '#283751' }, composer: { color: '#202942' }, panel: { color: '#202942' }, text: '#eff3fe', secondary: '#b7c4dc' } },
  { name: ['低对比度', 'Soft contrast', 'ソフトコントラスト'], palette: { background: { color: '#e8e8e1' }, sidebar: { color: '#deded6' }, user: { color: '#d2d5cd' }, composer: { color: '#e3e5dd' }, panel: { color: '#e3e5dd' }, text: '#323c36', secondary: '#505c55' } },
]

export function AssistantIdentity({ model }: { model?: string | null }) {
  const t = useCopy()
  const design = useChatDesign((state) => state.design)
  const identity = model && Object.hasOwn(design.models, model) ? design.models[model] : design.assistant
  if (identity.hideName && identity.hideAvatar) return null
  return <div className={styles.identity}>
    {!identity.hideAvatar && (identity.avatar
      ? <img src={identity.avatar} alt="" className={styles.avatar} />
      : <span aria-hidden="true" className={styles.avatar}>✦</span>)}
    {!identity.hideName && <span>{identity.name.trim() || t(assistantName)}</span>}
  </div>
}

export function ChatDesign({ onClose, privacy = false, voice = false }: { onClose: () => void; privacy?: boolean; voice?: boolean }) {
  const t = useCopy()
  const theme = useTheme()
  const [selectedTone, setTone] = useState<Tone>()
  const tone = selectedTone ?? theme
  const design = useChatDesign((state) => state.design)
  const saveError = useChatDesign((state) => state.saveError)
  const models = useChatStore((state) => state.models)
  const speechProviders = useChatStore((state) => state.settings?.dshSpeechProviders)
  const patchRefusal = (value: Partial<Design['refusal']>) => updateDesign((current) => ({
    ...current, refusal: { ...current.refusal, ...value },
  }))
  const colors = design.palettes[tone]
  const [model, setModel] = useState('')
  const [presetName, setPresetName] = useState('')
  const [imageError, setImageError] = useState(false)
  const [navLabel, setNavLabel] = useState(design.navigationLabel)
  useEffect(() => setNavLabel(design.navigationLabel), [design.navigationLabel])
  const patch = (value: Partial<Design>) => updateDesign((current) => ({ ...current, ...value }))
  const setPalette = (update: (value: Palette) => Palette) => updateDesign((current) => ({
    ...current, palettes: { ...current.palettes, [tone]: update(current.palettes[tone]) },
  }))
  const setSurface = (key: Surface, value: Partial<SurfaceStyle>) =>
    setPalette((current) => ({ ...current, [key]: { ...current[key], ...value } }))
  const currentIdentity = model ? (design.models[model] ?? design.assistant) : design.assistant
  const editIdentity = (value: Partial<Identity>) => updateDesign((current) => ({
    ...current,
    ...(model ? { models: { ...current.models, [model]: { ...(current.models[model] ?? current.assistant), ...value } } }
      : { assistant: { ...current.assistant, ...value } }),
  }))
  const resetIdentity = () => updateDesign((current) => {
    if (!model) return { ...current, assistant: { name: '' } }
    const next = { ...current.models }
    delete next[model]
    return { ...current, models: next }
  })
  const reset = t(['恢复默认', 'Reset', '既定に戻す'])
  const card = (label: Copy, children: ReactNode) => <fieldset className={styles.card}><legend>{t(label)}</legend>{children}</fieldset>
  const options = (values: [string, Copy][]) => values.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)
  const uploader = (label: Copy, size: number, onImage: (value: string) => void) =>
    <label>{t(label)} <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => {
      const file = event.target.files?.[0]
      event.target.value = ''
      if (file) void readDesignImage(file, size).then((value) => { setImageError(false); onImage(value) }, () => setImageError(true))
    }} /></label>
  const colorPicker = (label: Copy, color: string | undefined, change: (value: string | undefined) => void, defaultColor = tone === 'dark' ? '#242735' : '#ffffff') =>
    <div className={styles.row}><label>{t(label)} <input type="color" value={color ?? defaultColor} onChange={(event) => change(event.target.value)} /></label>
      <button type="button" onClick={() => change(undefined)} disabled={color === undefined} aria-label={reset + ' · ' + t(label)}>{reset}</button></div>
  const surface = (key: Surface, border = false, radius = false, showName = true) => <div className={styles.surface}>
    {showName && <strong>{t(labels[key])}</strong>}
    {colorPicker(['颜色', 'Color', '色'], colors[key]?.color, (color) => setSurface(key, { color }))}
    <div className={styles.row}><label>{t(['不透明度', 'Opacity', '不透明度'])} <input type="range" min="0" max="100" value={colors[key]?.alpha ?? 100}
      onChange={(event) => setSurface(key, { alpha: event.target.valueAsNumber })} /> <output>{colors[key]?.alpha ?? 100}%</output></label>
      <button type="button" disabled={colors[key]?.alpha === undefined} onClick={() => setSurface(key, { alpha: undefined })}>{reset}</button></div>
    {border && colorPicker(['边框颜色', 'Border color', '枠線の色'], colors[key]?.border, (color) => setSurface(key, { border: color }))}
    {radius && <div className={styles.row}><label>{t(['圆角', 'Corner radius', '角の丸み'])} <input type="range" min="0" max="48" value={colors[key]?.radius ?? (key === 'composer' ? 24 : 22)}
      onChange={(event) => setSurface(key, { radius: event.target.valueAsNumber })} /></label>
      <button type="button" disabled={colors[key]?.radius === undefined} onClick={() => setSurface(key, { radius: undefined })}>{reset}</button></div>}
  </div>
  const modelIds = [...new Set([
    ...(models?.richModels.map((entry) => entry.model) ?? []),
    ...(models?.genericProviders.flatMap((provider) => provider.models.map((entry) => `${provider.provider}:${entry.model}`)) ?? []),
    ...Object.keys(design.models),
  ])]

  return <Modal title={voice ? t(['语音识别', 'Speech recognition', '音声認識']) : privacy ? t(['位置与隐私', 'Location and privacy', '位置情報とプライバシー']) : t(['聊天界面设计', 'Chat interface design', 'チャット画面のデザイン'])}
    closable onClose={onClose} className={styles.dialog} mainClassName={styles.content}>
    {saveError && <p role="alert">{t(['本地设置保存失败，请检查浏览器存储空间。', 'Could not save locally. Check the available browser storage.', 'ローカルに保存できませんでした。ブラウザーの空き容量を確認してください。'])}</p>}
    {imageError && <p role="alert">{t(['请选择符合大小限制的 PNG、JPEG 或 WebP 图片。', 'Choose a PNG, JPEG or WebP image within the size limit.', 'サイズ制限内の PNG、JPEG、WebP 画像を選んでください。'])}</p>}
    {voice ? card(['DSH 转写服务', 'DSH transcription service', 'DSH 文字起こしサービス'], <>
      <label>{t(['服务', 'Service', 'サービス'])} <select value={design.speechProvider} onChange={(event) => patch({ speechProvider: event.target.value })}>
        <option value="">{t(['跟随 DSH 默认服务', 'Use DSH default service', 'DSH の既定サービスを使用'])}</option>
        {design.speechProvider && !speechProviders?.some((provider) => provider.id === design.speechProvider)
          && <option value={design.speechProvider}>{design.speechProvider} · {t(['不可用', 'Unavailable', '利用不可'])}</option>}
        {speechProviders?.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
      </select></label>
      {(!speechProviders || speechProviders.length === 0) && <p>{t(['当前 Profile 没有提供 DSH 转写服务。', 'This profile provides no DSH transcription service.', 'このプロファイルには DSH 文字起こしサービスがありません。'])}</p>}
    </>) : privacy ? <>
      {card(['位置服务', 'Location', '位置情報'], <>
      <label><input type="checkbox" checked={design.location} onChange={(event) => patch({ location: event.target.checked })} />
        {t(['启用手动城市', 'Enable manual city', '都市の手動設定を有効にする'])}</label>
      {design.location && <label>{t(['常用城市', 'City', '都市'])} <input value={design.city} maxLength={100} onChange={(event) => patch({ city: event.target.value })} /></label>}
      <p>{t(['城市只保存在本机。需要时可在输入框预览并确认，将城市插入消息发送给所选模型服务。', 'The city is stored on this device. You can preview and confirm adding it to a message sent to your chosen model service.', '都市はこの端末に保存されます。必要なときだけ内容を確認し、選択したモデルサービスへのメッセージに追加できます。'])}</p>
      </>)}
      {card(['关键词拒答', 'Keyword refusal', 'キーワードによる送信拒否'], <>
        <label><input type="checkbox" checked={design.refusal.enabled} onChange={(event) => patchRefusal({ enabled: event.target.checked })} />
          {t(['启用本地输入规则', 'Enable local input rules', 'ローカル入力ルールを有効にする'])}</label>
        {design.refusal.enabled && <>
          <label>{t(['关键词（每行一个）', 'Keywords (one per line)', 'キーワード（1 行に 1 個）'])}
            <textarea value={design.refusal.keywords} rows={3} maxLength={2000} onChange={(event) => patchRefusal({ keywords: event.target.value })} /></label>
          <label><input type="checkbox" checked={design.refusal.caseSensitive} onChange={(event) => patchRefusal({ caseSensitive: event.target.checked })} />
            {t(['区分大小写', 'Match case', '大文字と小文字を区別する'])}</label>
          <label>{t(['拒答提示', 'Refusal notice', '拒否時のメッセージ'])}
            <input value={design.refusal.message} maxLength={300} onChange={(event) => patchRefusal({ message: event.target.value })} /></label>
        </>}
      </>)}
    </> : <>
      <div className={styles.preview} data-tone={tone} data-side={design.side} style={{
        ...designVariables(colors, design),
        '--preview-sidebar-width': design.width ? `${design.width / 3}px` : undefined,
      } as CSSProperties}>
        <div className={styles.previewSidebar}>{t(labels.sidebar)}</div>
        <div className={styles.previewChat}>
          <div className={styles.previewUser}>{t(['你好！', 'Hello!', 'こんにちは！'])}</div>
          <div className={styles.previewAssistant}><AssistantIdentity model={model} />{t(['今天想聊些什么？', 'What would you like to talk about?', '今日は何について話しましょうか？'])}</div>
          <div className={styles.previewComposer}>{t(labels.composer)}</div>
          <div className={styles.previewPanel}>{t(labels.panel)}</div>
        </div>
      </div>
      {card(['布局', 'Layout', 'レイアウト'], <>
        <label>{t(['预览及编辑配色', 'Preview and edit palette', '配色のプレビューと編集'])} <select value={selectedTone ?? ''} onChange={(event) => setTone((event.target.value || undefined) as Tone | undefined)}>
          {options([['', ['当前主题', 'Current theme', '現在のテーマ']], ['light', presets[1].name], ['dark', ['深色', 'Dark', 'ダーク']]])}</select></label>
        <div className={styles.row}>
          {presets.map(({ name, palette }) => <button key={name[1]} type="button" onClick={() => setPalette(() => palette)}>{t(name)}</button>)}
          {design.presets.map(({ name, palette }) => <span key={name} className={styles.row}>
            <button type="button" onClick={() => setPalette(() => palette)}>{name}</button>
            <button type="button" aria-label={t(['删除预设', 'Delete preset', 'プリセットを削除']) + ' · ' + name}
              onClick={() => patch({ presets: design.presets.filter((preset) => preset.name !== name) })}>×</button></span>)}
        </div>
        <form className={styles.row} onSubmit={(event) => {
          event.preventDefault()
          const name = presetName.trim()
          if (!name) return
          const remaining = design.presets.filter((preset) => preset.name !== name)
          patch({ presets: [...remaining.slice(-11), { name, palette: colors }] })
          setPresetName('')
        }}>
          <label>{t(['预设名', 'Preset name', 'プリセット名'])} <input value={presetName} maxLength={60} onChange={(event) => setPresetName(event.target.value)} /></label>
          <button type="submit" disabled={!presetName.trim()}>{t(['保存预设', 'Save preset', 'プリセットを保存'])}</button>
        </form>
      </>)}
      {card(['导航栏', 'Navigation', 'ナビゲーション'], <>
        <form className={styles.row} onSubmit={(event) => { event.preventDefault(); patch({ navigationLabel: navLabel.trim() }) }}>
          <label>{t(['DSH 左侧插件名称', 'DSH sidebar entry name', 'DSH サイドバーの表示名'])} <input value={navLabel} placeholder="WebChat" maxLength={48} onChange={(event) => setNavLabel(event.target.value)} /></label>
          <button type="submit">{t(['应用', 'Apply', '適用'])}</button>
        </form>
        <label>{t(['导航栏位置', 'Sidebar position', 'サイドバーの位置'])} <select value={design.side} onChange={(event) => patch({ side: event.target.value === 'right' ? 'right' : 'left' })}>
          {options([['left', ['左侧', 'Left', '左']], ['right', ['右侧', 'Right', '右']]])}</select></label>
        <div className={styles.row}><label>{t(['导航栏宽度', 'Sidebar width', 'サイドバーの幅'])} <input type="range" min="200" max="480" value={design.width ?? 270}
          onChange={(event) => patch({ width: event.target.valueAsNumber })} /> <output>{design.width === undefined ? t(['自适应', 'Adaptive', '自動']) : design.width + ' px'}</output></label>
          <button type="button" disabled={design.width === undefined} onClick={() => patch({ width: undefined })}>{reset}</button></div>
        {surface('sidebar', true)}
      </>)}
      {card(labels.background, <>
        {surface('background', false, false, false)}
        {uploader(['背景图片（1 MB）', 'Background image (1 MB)', '背景画像（1 MB）'], 1_000_000, (image) => patch({ image }))}
        <div className={styles.row}><label>{t(['图片适配', 'Image fit', '画像の表示方法'])} <select value={design.fit}
          onChange={(event) => patch({ fit: event.target.value === 'contain' ? 'contain' : 'cover' })}>
          {options([['cover', ['填满', 'Fill', '塗りつぶし']], ['contain', ['完整显示', 'Fit', '全体を表示']]])}</select></label>
          <button type="button" disabled={!design.image} onClick={() => patch({ image: undefined })}>{reset}</button></div>
      </>)}
      {card(['消息气泡', 'Message bubbles', '吹き出し'], <>{surface('user', false, true)}{surface('assistant', false, true)}</>)}
      {card(['助手形象', 'Assistant identity', 'アシスタントの外観'], <>
        <label>{t(['应用于模型', 'Apply to model', '適用するモデル'])} <select value={model} onChange={(event) => setModel(event.target.value)}>
          <option value="">{t(['全局默认', 'Global default', '共通の既定設定'])}</option>
          {modelIds.map((id) => <option key={id} value={id}>{id}</option>)}</select></label>
        <label>{t(['昵称', 'Display name', '表示名'])} <input value={currentIdentity.name} placeholder={t(assistantName)} maxLength={80}
          onChange={(event) => editIdentity({ name: event.target.value })} /></label>
        <label><input type="checkbox" checked={!currentIdentity.hideName} onChange={(event) => editIdentity({ hideName: !event.target.checked })} /> {t(['显示昵称', 'Show name', '名前を表示'])}</label>
        <label><input type="checkbox" checked={!currentIdentity.hideAvatar} onChange={(event) => editIdentity({ hideAvatar: !event.target.checked })} /> {t(['显示头像', 'Show avatar', '画像を表示'])}</label>
        {uploader(['头像图片（256 KB）', 'Avatar image (256 KB)', 'プロフィール画像（256 KB）'], 256_000, (avatar) => editIdentity({ avatar }))}
        <button type="button" onClick={resetIdentity}>{reset}</button>
        <label><input type="checkbox" checked={design.autoRead} onChange={(event) => patch({ autoRead: event.target.checked })} />
          {t(['使用本地语音自动朗读新回复', 'Read new replies aloud with a local voice', 'ローカル音声で新しい返信を自動読み上げ'])}</label>
      </>)}
      {card(labels.composer, surface('composer', true, true, false))}
      {card(['高级外观', 'Advanced appearance', '詳細な外観'], <>
        {colorPicker(['正文颜色', 'Main text', '本文の色'], colors.text, (text) => setPalette((current) => ({ ...current, text })), tone === 'dark' ? '#ffffff' : '#18191d')}
        {colorPicker(['辅助文字颜色', 'Secondary text', '補助テキストの色'], colors.secondary, (secondary) => setPalette((current) => ({ ...current, secondary })), '#686e7b')}
        {surface('panel', true)}{surface('divider')}
        <label>{t(['思考过程显示', 'Reasoning visibility', '推論過程の表示'])} <select value={design.reasoning} onChange={(event) => patch({ reasoning: event.target.value as Design['reasoning'] })}>
          {options([['completed', ['仅折叠已完成的思考（默认）', 'Collapse completed reasoning (default)', '完了した推論を折りたたむ（既定）']],
            ['collapsed', ['默认折叠', 'Always start collapsed', '最初は常に折りたたむ']], ['expanded', ['默认展开', 'Start expanded', '最初から展開']],
            ['native', ['保留原有显示行为', 'Keep original display behavior', '従来の表示を維持']]])}</select></label>
        <button type="button" onClick={() => updateDesign((current) => ({ ...defaultDesign(), location: current.location, city: current.city, refusal: current.refusal, speechProvider: current.speechProvider }))}>
          {t(['恢复全部设计默认值', 'Reset all design settings', 'すべてのデザイン設定をリセット'])}</button>
      </>)}
    </>}
  </Modal>
}
