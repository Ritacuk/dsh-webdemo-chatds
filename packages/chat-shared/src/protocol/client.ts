/**
 * Rich 通路请求客户端(Anthropic 兼容 Messages API)。
 * 移植自官方 chat-demo 上游提交 5d5dd754… 的 `src/services/api/client.ts`。
 * 与上游的差异(见 README 差异说明):
 * - 移除 i18n 依赖与构建期 `__API_ORIGIN__` 占位:origin 由调用方显式传入
 *   (DSH Host 侧从设置节解析,浏览器侧由 Host 注入);
 * - P1 不携带附件上传,uploadFile/deleteFile/verifyApiKey 暂不移植;
 * - 凭证由调用方(DSH Host)提供,浏览器侧永远不接触 key —— 页面只调
 *   DSH Host 的插件路由,由 Host 注入凭证后发起真实请求。
 */

import { readMessageEvent } from './parse-event.js'
import { readServerSentEvents } from './sse.js'
import type { ApiErrorBody, CreateMessageRequest, MessageStreamEvent } from './types.js'

/** Anthropic 兼容接口前缀(拼在 origin 之后) */
export const ANTHROPIC_BASE_PATH = '/anthropic/v1'
/** 引用 Files API 上传的图片、调用 Anthropic 兼容 Files API 时必须携带(P1 未使用) */
export const FILES_BETA = 'files-api-2025-04-14'

export type ApiErrorKind =
  /** 非 2xx 响应 */
  | 'http'
  /** 流中返回的错误帧(如等待生成超时),随后连接关闭 */
  | 'stream'
  /** 请求没有到达服务端(断网、跨域被拦截等) */
  | 'network'
  /** 流在 message_stop 之前结束 */
  | 'interrupted'
  /** 响应不符合协议(如非 SSE 响应) */
  | 'protocol'

export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

const isErrorBody = (value: unknown): value is ApiErrorBody =>
  typeof value === 'object' &&
  value !== null &&
  'error' in value &&
  typeof (value as ApiErrorBody).error?.message === 'string'

const readErrorResponse = async (
  response: Response,
  kind: 'http' | 'protocol' = 'http',
  fallback = response.statusText
): Promise<ApiError> => {
  const text = await response.text().catch(() => '')
  let message = text || fallback
  try {
    const body: unknown = JSON.parse(text)
    if (isErrorBody(body)) {
      message = body.error.message
    }
  } catch {
    // 非 JSON 响应体直接展示原文
  }
  return new ApiError(kind, message, response.status)
}

const request = async (url: string, init: RequestInit): Promise<Response> => {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    if (init.signal?.aborted) {
      throw error
    }
    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  }
  if (!response.ok) {
    throw await readErrorResponse(response)
  }
  return response
}

const anthropicHeaders = (apiKey: string): Record<string, string> => ({
  // DeepSeek 兼容接口的鉴权方式,也可使用 Authorization: Bearer。
  'x-api-key': apiKey,
})

const hasFile = (body: CreateMessageRequest) =>
  body.messages.some(
    (message) =>
      typeof message.content !== 'string' &&
      message.content.some((block) => block.type === 'image' || block.type === 'document')
  )

/**
 * 消费一个 SSE 响应:逐个产出流式事件,收到 message_stop 时结束。
 * ping、保活注释与无法解析的内容不产出;中止请求时抛出 signal 的 AbortError。
 * (独立导出以便用模拟响应体做协议测试;生产路径由 streamMessage 调用。)
 */
export async function* streamFromResponse(
  response: Response,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }
  for await (const { event: eventName, data } of readServerSentEvents(response.body, signal)) {
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      if (eventName !== 'error') {
        continue
      }
    }
    if (isErrorBody(payload)) {
      throw new ApiError('stream', payload.error.message)
    }
    if (eventName === 'error') {
      throw new ApiError('stream', data)
    }
    const event = readMessageEvent(payload)
    if (!event) {
      continue
    }
    yield event
    if (event.type === 'message_stop') {
      return
    }
  }
  // 服务端没有提供错误内容时保持为空,不推测断流原因。
  throw new ApiError('interrupted', '')
}

/**
 * POST {origin}{ANTHROPIC_BASE_PATH}/messages(stream: true),逐个产出流式事件,
 * 收到 message_stop 时结束。ping、保活注释与无法解析的内容不产出;
 * 中止请求时抛出 signal 的 AbortError。
 */
export async function* streamMessage(
  apiKey: string,
  origin: string,
  body: CreateMessageRequest,
  signal: AbortSignal,
  // 覆盖默认 x-api-key 鉴权(如 DSH 账号 token 的 x-dsh-auth-token 头)。
  authHeaders?: Record<string, string>
): AsyncGenerator<MessageStreamEvent> {
  const response = await request(`${origin}${ANTHROPIC_BASE_PATH}/messages`, {
    method: 'POST',
    headers: {
      ...(authHeaders ?? anthropicHeaders(apiKey)),
      // Files API 与 file_id 引用图片时必传;纯文本聊天无需携带。
      ...(hasFile(body) ? { 'anthropic-beta': FILES_BETA } : {}),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  })
  yield* streamFromResponse(response, signal)
}
