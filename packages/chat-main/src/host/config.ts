/**
 * 行配置 schema — cordis.patch.yml 中本插件行的 config。
 * 默认值与官方 DeepSeek 适配器对齐:
 * - apiKeyEnv 默认 DEEPSEEK_API_KEY(dsh-base/cordis.patch.yml:490-494 同源引用);
 * - baseURL 缺省回退 DEEPSEEK_BASE_URL,再回退官方 API
 *   (dsh-llm-deepseek/src/config.ts:31 注释原文);
 * - thinking: 'enabled' | 'disabled'(dsh-llm-deepseek/src/config.ts:33-35)。
 */

import z from '@deepseek-ai/schemastery'
import { DEFAULT_RICH_BASE_URL } from './rich.js'

export interface MainConfig {
  /** 页面与 API 的路由前缀。 */
  pagePath: string
  /** Rich 通路凭证引用(环境变量名);走 ctx.credentials 正式凭证接口解析。 */
  apiKeyEnv: string
  /** Rich 通路 endpoint 覆盖;空串回退 DEEPSEEK_BASE_URL,再回退官方 API。 */
  baseURL: string
  /** 默认深度思考开关(P1 兼容字段)。 */
  thinking: 'enabled' | 'disabled'
  /** 默认是否声明 deepseek_web_search(deepseek_read_url 随联网搜索启停)。 */
  search: boolean
  /** 是否采用同请求返回的会话标题(message_delta.delta.title)。 */
  title: boolean
  /** Rich 模型目录(可覆盖;默认 deepseek-flash / deepseek-v4-pro)。 */
  richModels: { id: string; name: string; nativeSearch: boolean }[]
}

export const Config: z<MainConfig> = z.object({
  pagePath: z.string().pattern(/^\/[A-Za-z0-9._-]+$/).default('/chat-workspace'),
  apiKeyEnv: z.string().pattern(/^[A-Za-z_][A-Za-z0-9_]*$/).default('DEEPSEEK_API_KEY'),
  // 空串表示未覆盖(回退 DEEPSEEK_BASE_URL → 官方 API)。
  baseURL: z.string().default(''),
  thinking: z.union([z.const('enabled'), z.const('disabled')]).default('disabled'),
  search: z.boolean().default(false),
  title: z.boolean().default(true),
  richModels: z.array(z.object({
    id: z.string().required(),
    name: z.string().required(),
    nativeSearch: z.boolean().default(true),
  })).default([
    { id: 'deepseek-flash', name: 'DeepSeek Flash', nativeSearch: true },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', nativeSearch: true },
  ]),
}) as z<MainConfig>

/** 请求端点解析结果。 */
export interface RichEndpoint {
  /** DeepSeek API origin(如 https://api.deepseek.com)。 */
  origin: string
  /** 供诊断的来源描述。 */
  source: string
}

/**
 * 解析 Rich 通路 endpoint:行配置 → DEEPSEEK_BASE_URL(launch environment)→ 官方 API。
 * 兼容两种写法:https://api.deepseek.com 与 https://api.deepseek.com/anthropic
 * (官方适配器默认 baseURL 即带 /anthropic 后缀,dsh-llm-deepseek 请求 {baseURL}/v1/messages)。
 */
export function resolveEndpoint(config: MainConfig, launchEnv: Readonly<Record<string, string>>): RichEndpoint {
  const candidates: { value: string; source: string }[] = []
  if (config.baseURL) candidates.push({ value: config.baseURL, source: 'config.baseURL' })
  const envBase = launchEnv['DEEPSEEK_BASE_URL']
  if (envBase) candidates.push({ value: envBase, source: 'DEEPSEEK_BASE_URL' })
  candidates.push({ value: DEFAULT_RICH_BASE_URL, source: 'official-api' })
  for (const candidate of candidates) {
    const trimmed = candidate.value.replace(/\/+$/, '')
    if (trimmed.length === 0) continue
    const origin = trimmed.endsWith('/anthropic') ? trimmed.slice(0, -'/anthropic'.length) : trimmed
    try {
      const url = new URL(origin)
      if (url.protocol === 'https:' || url.protocol === 'http:') {
        return { origin: url.origin, source: candidate.source }
      }
    } catch {
      // 非法 URL 尝试下一候选
    }
  }
  return { origin: DEFAULT_RICH_BASE_URL, source: 'official-api' }
}
