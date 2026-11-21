/**
 * 接口失败的统一分类 — demo services/api/errors.ts 的最小移植。
 * 只保留 classifyStatus(回复错误提示 describeReply 需要);
 * 其余(ApiError 类、附件错误识别)随上传功能属 P2,暂不移植。
 */

/**
 * 按 HTTP 状态码归类;没有状态码(请求没到达服务端)时按网络问题处理。
 * 各调用方按自己的场景给同一种情况配不同文案,这里只归类,不生成文案。
 */
export type ApiErrorCondition =
  | 'unauthorized'
  | 'insufficientBalance'
  | 'tooLarge'
  | 'rateLimited'
  | 'serverBusy'
  | 'network'
  | 'other'

export const classifyStatus = (status: number | undefined): ApiErrorCondition => {
  if (status === 401) {
    return 'unauthorized'
  }
  if (status === 402) {
    return 'insufficientBalance'
  }
  if (status === 413) {
    return 'tooLarge'
  }
  if (status === 429) {
    return 'rateLimited'
  }
  if ((status ?? 0) >= 500) {
    return 'serverBusy'
  }
  return 'other'
}
