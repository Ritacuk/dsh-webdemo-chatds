/**
 * Rich 通路网关 — 凭证解析与对 DeepSeek Messages API 的直连。
 *
 * 设计依据(P0 审计):
 * - 官方适配器(dsh-llm-deepseek)对 server_tool_use / citations_delta 是"熔断"
 *   (translate.ts:60 UNSUPPORTED_CONTENT、:87 MALFORMED_RESPONSE),因此 Rich 请求
 *   绝不进入 ctx.llm 通用通路,由本网关直连,但凭证仍走正式凭证接口
 *   (resolveDeepSeekApiKey → ctx.credentials.resolve,credential.ts:15-23),
 *   每次请求实时解析、不缓存,浏览器永不接触 key。
 * - 官方适配器默认 baseURL 'https://api.deepseek.com/anthropic'(config.ts:116 默认值),
 *   与官方 demo 的 ANTHROPIC_BASE_URL(`${API_ORIGIN}/anthropic/v1`)指向同一端点。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { resolveDeepSeekApiKey, resolveDeepSeekAccountToken } from '@deepseek-ai/dsh-llm-deepseek'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { streamMessage, ApiError } from '@dsh-chat/shared'
import type { CreateMessageRequest, MessageStreamEvent } from '@dsh-chat/shared'
import type { MainConfig, RichEndpoint } from './config.js'
import { resolveEndpoint } from './config.js'

/** 官方公共 API origin(demo 构建期默认 __API_ORIGIN__ = https://api.deepseek.com)。 */
export const DEFAULT_RICH_BASE_URL = 'https://api.deepseek.com'

/** Rich 通路失败:与页面 wire 协议对齐的可序列化错误。 */
export interface RichFailure {
  kind: 'credential' | 'http' | 'stream' | 'network' | 'interrupted' | 'protocol'
  message: string
  status?: number
}

/**
 * Rich 通路网关。每次请求实时解析凭证与端点;不保存任何 key 值。
 */
export class RichGateway {
  constructor(
    private readonly ctx: Context,
    private readonly config: MainConfig,
  ) {}

  /** 当前端点(供目录与诊断)。 */
  endpoint(): RichEndpoint {
    return resolveEndpoint(this.config, launchEnvironmentOf(this.ctx) as unknown as Record<string, string>)
  }

  fileScope(): { origin: string; credentialRef: string } {
    return { origin: this.endpoint().origin, credentialRef: this.config.apiKeyEnv }
  }

  /**
   * 解析当前可用的鉴权;未配置返回 undefined(不抛错,由调用方决定提示)。
   * 值只存在于本方法返回值的作用域内,绝不进入日志或浏览器响应。
   * 优先 API Key 凭证;否则回退 DSH 登录账号 token(官方 account 服务按目的地放行;
   * Linux Web 部署常见账号登录、无独立 API Key 的形态)。
   */
  private async resolveAuth(): Promise<{ kind: 'api-key' | 'account'; value: string } | undefined> {
    const ref = credentialRef(this.config.apiKeyEnv) as CredentialRef
    const key = await resolveDeepSeekApiKey(this.ctx, ref)
    if (key !== undefined) return { kind: 'api-key', value: key }
    const token = await resolveDeepSeekAccountToken(this.ctx, this.endpoint().origin)
    if (token !== undefined) return { kind: 'account', value: token }
    return undefined
  }

  /** 兼容读取:纯 key 值(语音转写 Bearer 等既有形态)。 */
  private async resolveKey(): Promise<string | undefined> {
    return (await this.resolveAuth())?.value
  }

  /** Rich 通路就绪状态(凭证已配置且端点可解析)。 */
  async readiness(): Promise<{ ready: boolean; reason?: string }> {
    const key = await this.resolveKey()
    if (key === undefined) {
      return { ready: false, reason: `credential ${this.config.apiKeyEnv} is not configured and no signed-in DeepSeek account is available; set an API key on the DSH Models page, in $DSH_HOME/.credentials.yaml, or sign in to your DeepSeek account` }
    }
    return { ready: true }
  }

  /**
   * 发起一次 Rich 流式对话。signal 取消 → AbortError 由调用方按用户停止处理。
   */
  async *stream(
    body: CreateMessageRequest,
    signal: AbortSignal,
  ): AsyncGenerator<MessageStreamEvent, void, unknown> {
    const auth = await this.resolveAuth()
    if (auth === undefined) {
      throw new ApiError('http', `credential ${this.config.apiKeyEnv} is not configured and no signed-in DeepSeek account is available`, 401)
    }
    const endpoint = this.endpoint()
    // 账号 token 走 DSH 账号头(dsh-llm-deepseek-account 同源);API Key 维持 x-api-key。
    yield* streamMessage(auth.value, endpoint.origin, body, signal,
      auth.kind === 'account' ? { 'x-dsh-auth-token': auth.value } : undefined)
  }

  async transcribe(wav: Uint8Array<ArrayBuffer>, signal: AbortSignal): Promise<string> {
    const auth = await this.resolveAuth()
    if (!auth) throw new Error('请先在 DSH 中配置 DeepSeek 凭证或登录 DeepSeek 账号。')
    const data = new FormData()
    data.append('file', new Blob([wav], { type: 'audio/wav' }), 'recording.wav')
    const headers = auth.kind === 'account'
      ? { 'x-dsh-auth-token': auth.value }
      : { Authorization: `Bearer ${auth.value}` }
    const result = await fetch(`${this.endpoint().origin}/v1/tools/asr`, {
      method: 'POST', headers, body: data, signal, redirect: 'error',
    })
    if (!result.ok) throw new Error(`DeepSeek 语音转写失败（${result.status}）。`)
    const response = await result.json() as { text?: unknown }
    if (typeof response.text !== 'string' || response.text.length > 200_000) throw new Error('转写接口返回的文本无效。')
    return response.text.trim()
  }

  /**
   * 上传一个附件到 DeepSeek Files API(demo 同款;云端处理,页面已明示)。
   * PDF 用 rich_layout_recognition;图片省略 purpose(demo 语义)。
   * 必须携带 anthropic-beta: files-api-2025-04-14(demo client.ts:17)。
   */
  async uploadToFilesApi(
    record: { name: string; bytes: () => Uint8Array },
    signal: AbortSignal,
  ): Promise<{ id: string }> {
    const auth = await this.resolveAuth()
    if (auth === undefined) {
      throw new ApiError('http', `credential ${this.config.apiKeyEnv} is not configured and no signed-in DeepSeek account is available`, 401)
    }
    const endpoint = this.endpoint()
    const isImage = /\.(png|jpe?g|webp|gif)$/i.test(record.name)
    const form = new FormData()
    if (!isImage) form.append('purpose', 'rich_layout_recognition')
    form.append('file', new Blob([record.bytes()] as unknown as ConstructorParameters<typeof Blob>[0], { type: 'application/octet-stream' }), record.name)
    let response: Response
    try {
      response = await fetch(`${endpoint.origin}/anthropic/v1/files`, {
        method: 'POST',
        headers: {
          // 账号 token 走 DSH 账号头;API Key 维持 x-api-key(demo 同款)。
          ...(auth.kind === 'account' ? { 'x-dsh-auth-token': auth.value } : { 'x-api-key': auth.value }),
          'anthropic-beta': 'files-api-2025-04-14',
        },
        body: form,
        signal,
      })
    } catch (error) {
      if (signal.aborted) throw error
      throw new ApiError('network', error instanceof Error ? error.message : String(error))
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new ApiError('http', text.length > 0 ? text : `Files API upload failed (${String(response.status)})`, response.status)
    }
    const body = (await response.json()) as { id?: unknown }
    if (typeof body.id !== 'string' || body.id.length === 0) {
      throw new ApiError('protocol', 'Files API response missing file id')
    }
    return { id: body.id }
  }
}

/** 把任意错误归一为页面可展示的 RichFailure(与 ApiError.kind 词表一致)。 */
export function toRichFailure(error: unknown): RichFailure {
  if (error instanceof ApiError) {
    return { kind: error.kind, message: error.message, ...(error.status !== undefined ? { status: error.status } : {}) }
  }
  if (error instanceof Error && error.name === 'AbortError') {
    // 由调用方(取消路径)单独处理,这里兜底为 network 以防漏网。
    return { kind: 'network', message: 'aborted' }
  }
  return { kind: 'network', message: error instanceof Error ? error.message : String(error) }
}
