import { describe, expect, it } from 'vitest'
import { describeNativeCapabilities } from '../src/host/native-capabilities.js'

describe('DSH native capability inventory', () => {
  const translation = {
    name: '@deepseek-ai/dsh-experimental-cot-translation-bundle',
    availability: 'installation',
    enabled: true,
    rows: [
      { entryId: 'translator-1', rowId: 'translator' },
      { entryId: 'translation-1', rowId: 'cot-translation' },
    ],
  }
  const active = new Set(translation.rows.map(({ entryId }) => entryId))

  it('distinguishes missing, disabled, incomplete and active native translation', () => {
    const state = (bundle = translation, enabledRows = active) => describeNativeCapabilities([bundle], enabledRows).reasoningTranslation
    expect(state({ ...translation, availability: 'missing' })).toEqual({ installed: false, enabled: false, active: false })
    expect(state({ ...translation, enabled: false })).toEqual({ installed: true, enabled: false, active: false })
    expect(state(translation, new Set(['translator-1']))).toEqual({ installed: true, enabled: true, active: false })
    expect(state()).toEqual({ installed: true, enabled: true, active: true })
  })
})
