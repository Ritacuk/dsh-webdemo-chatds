type Bundle = {
  name: string
  enabled: boolean
  availability: string
  error?: unknown
  rows: { entryId?: string; rowId: string }[]
}

const integrations = {
  reasoningTranslation: {
    bundle: '@deepseek-ai/dsh-experimental-cot-translation-bundle',
    activeRows: ['translator', 'cot-translation'],
  },
  historySearch: {
    bundle: '@deepseek-ai/dsh-experimental-session-search',
    activeRows: ['optional-session-query-sqlite', 'optional-tool-session-query'],
  },
  updatingTitle: {
    bundle: '@deepseek-ai/dsh-experimental-session-titles-bundle',
    activeRows: ['optional-session-title-all-prompts'],
  },
} as const

export function describeNativeCapabilities(bundles: readonly Bundle[], activeRows: ReadonlySet<string>) {
  return Object.fromEntries(Object.entries(integrations).map(([name, def]) => {
    const bundle = bundles.find((entry) => entry.name === def.bundle)
    const installed = bundle !== undefined && bundle.availability !== 'missing'
    const enabled = installed && bundle.enabled
    const active = enabled && !bundle.error && def.activeRows.every((rowId) =>
      bundle.rows.some((row) => row.rowId === rowId && row.entryId !== undefined && activeRows.has(row.entryId)))
    return [name, { installed, enabled, active }]
  }))
}
