import { describe, expect, it } from 'vitest'
import { defaultDesign, designVariables, parseDesign } from '../src/services/chatDesign.js'

describe('ChatDS design preferences', () => {
  it('uses defaults for existing profiles and recovers from corrupt or unsupported records', () => {
    for (const data of [null, '{', '{"version":99}', '{"version":"1"}']) {
      expect(parseDesign(data)).toEqual(defaultDesign())
    }
  })

  it('keeps palettes, width and assistant preferences independent and validates input', () => {
    const design = parseDesign(JSON.stringify({
      version: 1, side: 'right', width: 600,
      palettes: { light: { background: { color: '#aabbcc', alpha: 0 }, text: 'url(https://invalid)' }, dark: { sidebar: { color: '#112233' } } },
      assistant: { name: 'Ada', avatar: 'https://invalid/avatar.png' },
      models: { 'native:gpt': { name: 'GPT', avatar: 'data:image/png;base64,AA==' } },
      image: 'data:image/svg+xml;base64,AA==',
    }))
    expect(design.width).toBe(480)
    expect(design.side).toBe('right')
    expect(design.assistant).toMatchObject({ name: 'Ada', avatar: undefined })
    expect(design.models['native:gpt'].avatar).toBe('data:image/png;base64,AA==')
    expect(design.image).toBeUndefined()
    expect(designVariables(design.palettes.light)).toEqual({ '--chatds-background-alpha': '0%', '--chatds-background-color': '#aabbcc' })
    expect(designVariables(design.palettes.dark)).toEqual({ '--chatds-sidebar-color': '#112233' })
  })
})
