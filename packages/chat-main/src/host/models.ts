/**
 * 模型目录与能力检测(P2-E / R8)— 全部来自 DSH 官方目录与适配器声明,不硬编码假列表。
 *
 * - Rich 通路:官方 dsh-llm-deepseek 的目录(listing/models.ts:8-23 DEFAULT_MODELS,官方
 *   origin 时还会跟随 GET /models 列表)→ 经 ctx.llm.listModels('deepseek-official') 查询,
 *   不可达时回退插件行配置的目录;能力声明固定为 demo 已验证事实:
 *   思考(开/关)、原生搜索(rich 独有)、流式、用量、结构化响应。
 * - 通用通路:优先使用官方 sessionController.modelCatalog()(Host 生成选择器的
 *   官方目录:provider 分组 + 可路由模型 + 探测失败项);不可用时回退
 *   ctx.llm.listProviders()/listModels(provider) 实时枚举;能力来自
 *   ctx.llm.resolveModelInfo 的官方声明(inputModalities/reasoning),未知能力
 *   如实标注 unknown/false,绝不虚报。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { WireModelCatalog, WireModelEntry, WireModelCapability, ThinkingEffort } from '@dsh-chat/shared'

/** Rich 模型条目(行配置可覆盖目录)。 */
export interface RichCatalogModel {
  id: string
  name: string
  /** 是否声明 DeepSeek 原生联网搜索(服务端工具)。 */
  nativeSearch: boolean
}

const DEFAULT_RICH_MODELS: RichCatalogModel[] = [
  { id: 'deepseek-flash', name: 'DeepSeek Flash', nativeSearch: true },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', nativeSearch: true },
]

function richCapability(model: RichCatalogModel): WireModelCapability {
  return {
    chat: true,
    thinking: true,
    // 官方 demo 协议的 thinking 只有 enabled/disabled 两态(create-message 文档),
    // 不假设 off/low/high/max 全档位可用。
    thinkingEfforts: ['off', 'enabled'],
    vision: false,
    fileInput: ['local-inline', 'local-extract', 'cloud-files-api'],
    nativeSearch: model.nativeSearch,
    streaming: true,
    usage: true,
    structured: true,
  }
}

/** 通用通路条目的能力:来自官方 resolveModelInfo 声明。 */
function genericCapability(
  info: { inputModalities?: readonly string[]; reasoning?: { defaultEffort?: string; efforts: readonly { id: string; name: string }[] } | undefined } | undefined,
): WireModelCapability {
  const efforts: ThinkingEffort[] = info === undefined ? [] : info.reasoning?.efforts.map(({ id }) => id) ?? ['off']
  const modalities = info?.inputModalities
  const capability: WireModelCapability = {
    chat: true,
    thinking: efforts.some((id) => id !== 'off'),
    thinkingEfforts: efforts,
    ...(info?.reasoning ? {
      thinkingEffortNames: Object.fromEntries(info.reasoning.efforts.map(({ id, name }) => [id, name])),
      defaultThinkingEffort: info.reasoning.defaultEffort,
    } : {}),
    // inputModalities 缺省=未知(负面能力标注为 false 并在 note 说明)。
    vision: modalities !== undefined && modalities.includes('image'),
    fileInput: ['local-inline', 'local-extract'],
    nativeSearch: false,
    streaming: true,
    usage: false,
    structured: false,
  }
  return capability
}

/** 官方 sessionController.modelCatalog() 的形状(Host 生成选择器的官方目录)。 */
interface OfficialModelCatalog {
  providers?: readonly { id: string; name: string; models: readonly { id: string; name: string }[] }[]
  failures?: readonly { id: string; name: string; message: string }[]
}

/** 组装完整目录(Rich 就绪状态 + 通用 provider 实时枚举)。 */
export async function buildCatalog(options: {
  ctx: Context
  richReady: boolean
  richUnavailableReason?: string
  richModels: RichCatalogModel[]
}): Promise<WireModelCatalog> {
  const { ctx, richReady, richUnavailableReason, richModels } = options
  const catalog: WireModelCatalog = {
    richReady,
    ...(richUnavailableReason !== undefined ? { richUnavailableReason } : {}),
    richModels: richModels.map((model) => ({
      name: model.name,
      channel: 'rich' as const,
      model: model.id,
      capability: richCapability(model),
      capabilityNote: 'DeepSeek 官方 Messages API(demo 同款协议);能力为 demo 已验证事实',
    })),
    genericProviders: [],
    modelScope: 'all',
  }
  try {
    // R8:优先用官方目录(sessionController.modelCatalog);dsh-web-app 未挂载
    // controller(如纯 Host 测试环境)时回退 ctx.llm 直查。
    const withGet = ctx as unknown as { get?: (name: never) => unknown }
    const controller = typeof withGet.get === 'function'
      ? withGet.get('sessionController' as never) as { modelCatalog?: () => Promise<OfficialModelCatalog> } | undefined
      : undefined
    const official = await controller?.modelCatalog?.().catch(() => undefined)
    const providers = official?.providers !== undefined && official.providers.length > 0
      ? official.providers.map((provider) => ({ id: provider.id, name: provider.name, models: provider.models.map(({ id, name }) => ({ id, name })) }))
      : undefined
    const failures = new Map((official?.failures ?? []).map((failure) => [failure.id, failure.message]))
    const source = providers !== undefined
      ? providers
      : ctx.llm.listProviders().map((provider) => ({ id: provider.id, name: provider.name, models: [] as { id: string; name: string }[] }))
    for (const provider of source) {
      const models = providers !== undefined && provider.models.length > 0
        ? provider.models
        : await ctx.llm.listModels(provider.id).catch(() => [])
      const entries: WireModelEntry[] = []
      for (const model of models) {
        // 能力检测:resolveModelInfo 给出官方声明(inputModalities/reasoning),逐模型实时解析。
        const info = await ctx.llm.resolveModelInfo(provider.id, model.id).catch(() => undefined)
        const note = info === undefined
          ? (failures.get(provider.id) ?? '模型信息解析失败:能力未知,按最低能力处理(无思考/无图片)')
          : '能力来自 DSH 适配器声明(resolveModelInfo)'
        entries.push({
          name: model.name,
          channel: 'generic',
          model: model.id,
          provider: provider.id,
          capability: genericCapability(info),
          capabilityNote: note,
        })
      }
      catalog.genericProviders.push({ provider: provider.id, name: provider.name, models: entries })
    }
  } catch {
    // ctx.llm 不可用不阻塞目录(Rich 仍可用)
  }
  return catalog
}
