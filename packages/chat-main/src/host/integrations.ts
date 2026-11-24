import type { Context } from '@deepseek-ai/cordis'
import { contextProjectionAvailable, costMeterAvailable } from './bridges.js'

type Localized = string | Record<string, string>
interface Meta { title?: Localized; description?: Localized; icon?: string }
interface Manager {
  listBundles(): Promise<{
    name: string; enabled: boolean; availability: string; error?: unknown; meta?: Meta
    rows: { entryId?: string; rowId: string; moduleName: string; meta?: Meta }[]
  }[]>
  listPlugins(): Promise<{ entryId: string; enabled: boolean; fiberPhase: string | null; meta?: Meta }[]>
}

const chinese = (value?: Localized) => {
  if (typeof value === 'string') return /[\u3400-\u9fff]/u.test(value) ? value : undefined
  return value?.['zh-cn'] ?? value?.zh
}

/** Match only documented integrations to inventory rows; the tool registry does not publish ownership. */
export async function pluginIntegrations(ctx: Context) {
  const manager = ctx.get('pluginManager' as never) as Manager | undefined
  const registry = {
    'dsh-webdemo-chatds': {
      title: 'WebChat',
      description: '在 WebChat 中聊天和检索授权文件夹。',
      rows: {
        'chatds-main': { title: '本地文件检索', description: '按会话授权搜索和读取片段。', kind: 'local' },
        'chatds-sharing': { title: '数据共享', description: '在配对设备之间加密共享所选聊天。', kind: 'passive' },
        'chatds-sidecar': { title: 'Agent 侧聊', description: '提供独立的侧聊界面，无需模型工具授权。', kind: 'passive' },
      },
    },
    'dsh-cost-meter': {
      title: '费用统计',
      description: '显示聊天用量、费用和预算。',
      rows: costMeterAvailable(ctx) ? {
        'cost-meter': { title: '费用服务', description: '已连接费用服务，无需模型工具授权。', kind: 'passive' },
      } : {},
    },
    'dsh-context': {
      title: '上下文统计',
      description: '在聊天中查看当前会话上下文。',
      rows: contextProjectionAvailable(ctx) ? {
        'dsh-context': { title: '上下文投影', description: '已连接上下文服务，无需模型工具授权。', kind: 'passive' },
      } : {},
    },
  } satisfies Record<string, { title: string; description: string; rows: Record<string, { title: string; description: string; kind: string }> }>
  if (!manager?.listBundles || !manager.listPlugins) return { managementAvailable: false, bundles: [] }
  const [bundles, entries] = await Promise.all([manager.listBundles(), manager.listPlugins()])
  const live = new Map(entries.filter((entry) => entry.enabled && entry.fiberPhase === 'active').map((entry) => [entry.entryId, entry]))
  return {
    managementAvailable: true,
    bundles: bundles.flatMap((bundle) => {
      const integration = (registry as Record<string, typeof registry[keyof typeof registry]>)[bundle.name]
      if (!integration || !bundle.enabled || bundle.availability === 'missing' || bundle.error) return []
      const definitions: Record<string, { title: string; description: string; kind: string } | undefined> = integration.rows
      const components = bundle.rows.flatMap((row) => {
        const entry = row.entryId && live.get(row.entryId)
        const definition = definitions[row.rowId]
        if (!entry || !definition) return []
        return [{
          id: entry.entryId, kind: definition.kind,
          title: chinese(entry.meta?.title ?? row.meta?.title) ?? definition.title,
          description: definition.description,
        }]
      })
      if (!components.length) return []
      return [{
        name: bundle.name, title: chinese(bundle.meta?.title) ?? integration.title,
        description: bundle.name === 'dsh-webdemo-chatds' ? integration.description : chinese(bundle.meta?.description) ?? integration.description,
        icon: bundle.meta?.icon, components,
      }]
    }),
  }
}
