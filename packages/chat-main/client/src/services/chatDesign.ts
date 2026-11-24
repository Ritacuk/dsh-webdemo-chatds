import { create } from 'zustand'

export const designKey = 'chatds:chat-design'
export const surfaces = ['background', 'sidebar', 'user', 'assistant', 'composer', 'panel', 'divider'] as const
export type Surface = typeof surfaces[number]
export type Tone = 'light' | 'dark'
export type SurfaceStyle = { color?: string; alpha?: number; border?: string; radius?: number }
export type Palette = Partial<Record<Surface, SurfaceStyle>> & { text?: string; secondary?: string }
export type Identity = { name: string; avatar?: string; hideName?: boolean; hideAvatar?: boolean }
export type Reasoning = 'collapsed' | 'expanded' | 'completed' | 'native'
export type Design = {
  version: 1
  side: 'left' | 'right'
  width?: number
  navigationLabel: string
  reasoning: Reasoning
  palettes: Record<Tone, Palette>
  presets: { name: string; palette: Palette }[]
  image?: string
  fit: 'cover' | 'contain'
  assistant: Identity
  models: Record<string, Identity>
  speechProvider: string
  autoRead: boolean
  refusal: { enabled: boolean; keywords: string; caseSensitive: boolean; message: string }
  city: string
  location: boolean
}

export const defaultDesign = (): Design => ({
  version: 1, side: 'left', navigationLabel: '', reasoning: 'completed',
  palettes: { light: {}, dark: {} }, presets: [], fit: 'cover',
  assistant: { name: '' }, models: {}, speechProvider: '', autoRead: false,
  refusal: { enabled: false, keywords: '', caseSensitive: false, message: '' }, city: '', location: false,
})
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const string = (value: unknown, limit = 80) => typeof value === 'string' ? value.slice(0, limit) : ''
const color = (value: unknown) => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value : undefined
const number = (value: unknown, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.min(max, Math.max(min, value))) : undefined
const raster = (value: unknown) => typeof value === 'string' && value.length <= 1_400_000
  && /^data:image\/(png|jpeg|webp);base64,[\w+/]+=*$/.test(value) ? value : undefined
const palette = (value: unknown): Palette => {
  const data = record(value)
  const result: Palette = { text: color(data.text), secondary: color(data.secondary) }
  for (const key of surfaces) {
    const style = record(data[key])
    result[key] = { color: color(style.color), alpha: number(style.alpha, 0, 100), border: color(style.border), radius: number(style.radius, 0, 48) }
  }
  return result
}
const identity = (value: unknown): Identity => {
  const item = record(value)
  return { name: string(item.name), avatar: raster(item.avatar), hideName: item.hideName === true, hideAvatar: item.hideAvatar === true }
}

export function parseDesign(raw: string | null): Design {
  try {
    const data = record(JSON.parse(raw ?? 'null'))
    if (data.version !== 1) return defaultDesign()
    const tones = record(data.palettes)
    const presets = Array.isArray(data.presets) ? data.presets.slice(0, 12).map((value) => {
      const preset = record(value)
      return { name: string(preset.name), palette: palette(preset.palette) }
    }).filter((preset) => preset.name.trim()) : []
    const reasoning = data.reasoning
    const refusal = record(data.refusal)
    return {
      version: 1, side: data.side === 'right' ? 'right' : 'left', width: number(data.width, 200, 480),
      navigationLabel: string(data.navigationLabel, 48), reasoning: reasoning === 'expanded' || reasoning === 'collapsed' || reasoning === 'native' ? reasoning : 'completed',
      palettes: { light: palette(tones.light), dark: palette(tones.dark) }, presets,
      image: raster(data.image), fit: data.fit === 'contain' ? 'contain' : 'cover',
      assistant: identity(data.assistant), models: Object.fromEntries(Object.entries(record(data.models)).map(([key, value]) => [key, identity(value)])),
      speechProvider: string(data.speechProvider, 128), autoRead: data.autoRead === true,
      refusal: { enabled: refusal.enabled === true, keywords: string(refusal.keywords, 2000), caseSensitive: refusal.caseSensitive === true, message: string(refusal.message, 300) },
      city: string(data.city, 100), location: data.location === true,
    }
  } catch { return defaultDesign() }
}

const load = () => {
  try { return parseDesign(localStorage.getItem(designKey)) } catch { return defaultDesign() }
}
export const useChatDesign = create<{ design: Design; saveError: boolean }>(() => ({ design: load(), saveError: false }))
export function updateDesign(update: (current: Design) => Design) {
  const design = update(useChatDesign.getState().design)
  try {
    localStorage.setItem(designKey, JSON.stringify(design))
  } catch {
    useChatDesign.setState({ saveError: true })
    return
  }
  useChatDesign.setState({ design, saveError: false })
}

export const readDesignImage = (file: File, maxBytes: number) => new Promise<string>((resolve, reject) => {
  if (file.size > maxBytes || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    reject(new Error('Invalid image'))
    return
  }
  const reader = new FileReader()
  reader.onerror = () => reject(reader.error)
  reader.onload = () => {
    const data = raster(reader.result)
    if (data) resolve(data)
    else reject(new Error('Invalid image'))
  }
  reader.readAsDataURL(file)
})

export function designVariables(palette: Palette, design?: Pick<Design, 'image' | 'fit'>): Record<string, string> {
  const variables: Record<string, string> = {}
  for (const key of surfaces) {
    const style = palette[key]
    if (style?.color) variables[`--chatds-${key}-color`] = style.color
    if (style?.alpha !== undefined) variables[`--chatds-${key}-alpha`] = `${style.alpha}%`
    if (style?.border) variables[`--chatds-${key}-border`] = style.border
    if (style?.radius !== undefined) variables[`--chatds-${key}-radius`] = `${style.radius}px`
  }
  if (palette.text) variables['--chatds-text'] = palette.text
  if (palette.secondary) variables['--chatds-secondary'] = palette.secondary
  if (design?.image) {
    variables['--chatds-image'] = `url("${design.image}")`
    variables['--chatds-image-fit'] = design.fit
  }
  return variables
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === designKey || event.key === null) useChatDesign.setState({ design: load(), saveError: false })
  })
}

export function matchesRefusal(content: string, policy: Design['refusal']): boolean {
  if (!policy.enabled || !content) return false
  const normalize = (value: string) => policy.caseSensitive ? value : value.toLowerCase()
  const input = normalize(content)
  return policy.keywords.split(/\r?\n/).map((keyword) => keyword.trim()).some((keyword) => keyword !== '' && input.includes(normalize(keyword)))
}
