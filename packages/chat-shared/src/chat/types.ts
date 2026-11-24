import type { MessageProvenance } from '../dsh/sharing.js'
/**
 * 聊天数据模型 — 回复块、消息、会话。
 * 移植自官方 chat-demo 上游提交 5d5dd754… 的 `src/services/chat/types.ts`,
 * 差异:移除 i18n 依赖(error.localMessage),移除 IndexedDB 附件相关的 serverId 语义注释
 * (P1 阶段不支持附件,字段保留以维持协议结构)。
 */

import type { ApiErrorKind } from '../protocol/client.js'
import type {
  ChatModel,
  MessageUsage,
  ServerToolBlock,
  StopDetails,
  StopReason,
  TextCitation,
} from '../protocol/types.js'

/**
 * 消息附件。id 是本地标识,所有引用同一 id 的消息共用一份原件;
 * serverId 是 Files API 返回的 file_id(导入的数据或尚未上传成功的文件为 null)。
 * P1 阶段不支持附件发送,结构保留以维持协议兼容。
 */
export type FileAttachment = {
  unavailable?: boolean
  archivedCopy?: boolean
  id: string
  serverId: string | null
  name: string
  size: number
  /** 附件类别;导入时沿用归档的 is_image,不由 MIME 识别结果决定。 */
  isImage: boolean
  /** 具体 MIME;导入时没有原件或无法识别的为空字符串,不影响图片身份。 */
  mimeType: string
}

/** 本地消息的分支关系;字段缺省时按线性消息列表处理。 */
export type MessageBranch = {
  provenance?: MessageProvenance
  parentId?: string | null
  /** 当前选中的下一条消息;切换版本时保留每条分支原有的选择。 */
  selectedChildId?: string
}

export type UserMessage = MessageBranch & {
  id: string
  role: 'user'
  content: string
  files: FileAttachment[]
  createdAt: number
}

/** 思考块:thinking_delta 累积,签名随 signature_delta 到达;历史轮次的思考服务端会丢弃,不回传 */
export type ThinkingPart = {
  type: 'thinking'
  thinking: string
  signature?: string
  /** content_block_start 的时间;没有事件时间的历史块缺省 */
  startedAt?: number
  /** content_block_stop(或回复结束)的时间 */
  endedAt?: number
  /** 仅有耗时、没有事件时间时保存秒数。 */
  elapsedSeconds?: number
}

/** 文本块:text_delta 累积,citations_delta 追加引用 */
export type TextPart = {
  type: 'text'
  text: string
  citations?: TextCitation[]
  /** 服务端提示文案,仅用于展示,不作为模型回答参与上下文或续写。 */
  isTemplate?: boolean
}

/** 服务端工具调用与结果块按协议原样保存;历史请求只回传 read_link 调用与结果 */
export type ReplyBlock = ThinkingPart | TextPart | ServerToolBlock

/**
 * pending:已发出请求,还没收到事件;streaming:正在接收;
 * done:收到 message_stop;stopped:用户停止或页面关闭;error:请求或流出错
 */
export type ReplyStatus = 'pending' | 'streaming' | 'done' | 'stopped' | 'error'

export type AssistantMessage = MessageBranch & {
  id: string
  role: 'assistant'
  createdAt: number
  /** 实际使用的模型 id(P2-E:双通路下可以是任意已配置模型;rich 通路取值仍为 ChatModel)。 */
  model: string | null
  /** Provider from the existing DSH source, used to resolve model-specific display preferences. */
  modelProvider?: string
  /** 请求时是否开启深度思考 */
  thinking?: boolean
  /** 请求时是否声明 deepseek_web_search;关闭时仍声明 deepseek_read_url */
  search?: boolean
  /** 本轮请求的系统信息快照;各回答版本独立保存,续写沿用。历史消息中缺省的快照保持为空。 */
  latestReminder?: string
  /** 是否允许作为续写前缀;仍需满足回复状态与内容限制。 */
  prefix: boolean
  status: ReplyStatus
  /** 可识别的内容块按接收顺序排列;续写产生的块追加在已有块之后 */
  blocks: ReplyBlock[]
  stopReason?: StopReason
  stopDetails?: StopDetails
  /** 最近一次请求的用量,续写后更新 */
  usage?: MessageUsage
  usageSource?: 'rich'
  /** R8:本回合真实账单(cost-meter 产物,原样透传;展示层负责解释,重启后按需取会话账目)。 */
  cost?: unknown
  error?: {
    /** upload:发送前补传附件失败,请求没有发出 */
    kind: ApiErrorKind | 'upload'
    message: string
    code?: string
    status?: number
    /** 仅 upload:重新上传是否可能成功(网络、限流、服务端繁忙);过大、格式不支持为 false */
    retryable?: boolean
  }
}

export type Message = UserMessage | AssistantMessage

export type Session = {
  id: string
  provenance?: MessageProvenance
  versionSources?: Record<string, MessageProvenance>
  title: string
  createdAt: number
  updatedAt: number
  /** 包含所有分支的消息,按创建顺序存储。 */
  messages: Message[]
  /** undefined 表示线性消息列表;null 表示空会话。 */
  rootMessageId?: string | null
  versions?: Record<string, string[]>
}

/** 会话列表元数据;消息只在打开会话时加载。 */
export type SessionSummary = Pick<Session, 'id' | 'title' | 'createdAt' | 'updatedAt'> & { pinned?: boolean; archived?: boolean; provenance?: MessageProvenance }

/** 显式提取字段,避免将完整会话的消息带进列表。 */
export const toSessionSummary = (session: SessionSummary): SessionSummary => ({
  id: session.id,
  title: session.title,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  ...(session.pinned ? { pinned: true } : {}),
  ...(session.archived ? { archived: true } : {}),
})
