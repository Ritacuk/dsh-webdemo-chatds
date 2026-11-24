/**
 * ignorable plugin 记录写入(跨 @deepseek-ai/dsh-session 副本兼容)。
 *
 * V0 实测:官方 `appendPluginRecord` 经类私有方法 `#appendRecord` 写入,只在与
 * Session 实例同属一个模块副本时可用。插件的 `@deepseek-ai/dsh-session` 由
 * node_modules 解析到自己的副本(与运行时 asar 副本类身份不同),调用会抛
 * `TypeError: Receiver must be an instance of class Session`(私有品牌校验)。
 *
 * 本模块用 Session 实例的公开方法 commit()/publicationEntry() 复刻等价语义:
 * 事件信封 `{ type, seq, time, data, ignorable: true }` 与 #appendRecord 完全一致
 * —— 该信封是 v4 持久格式的稳定契约(未知 type 必须 ignorable 才能回读,
 * 见 dsh-session-format 的行准入校验)。记录经官方语义保留:不进模型可见
 * surface,读端不识别时原样跳过,fork/resume 随日志携带。
 *
 * D1 加固(独立审计后):
 * - 复刻官方 `assertPluginRecordEvent` 的类型语法校验,非法 type 在写入前失败,
 *   不让一条非法记录进入正式 Session 日志;
 * - 复刻官方 `snapshotJsonValue` 的可序列化校验(circular/undefined/BigInt 直接拒绝);
 * - 显式校验 `seq` 与 `commit` 的存在,跨副本缺接口时给出可诊断错误而不是静默写坏日志。
 *
 * 兼容性说明(保留 shim 的理由):官方导出入口在跨副本场景下不可用(类私有品牌),
 * 而 `publicationEntry()`/`commit()` 是 Session 上公开声明的成员,且 commit 内部执行
 * 与官方相同的 `surfaceManager.validateNext` 与 observer 派发。回归测试见
 * test/plugin-record.test.ts;残余局限见 reports/desktop-deployment/known-issues.md。
 *
 * 类型字符串须符合 plugin 记录语法:"plugin:" + 小写斜杠分段(可用 -._)。
 */

import { appendPluginRecord, SessionLogOffset, type PluginRecordMap, type Session } from '@deepseek-ai/dsh-session'

/** Session 实例上被公开声明之外、但实现上可调用的日志写入原语。 */
type SessionCommitSurface = {
  readonly seq: number
  publicationEntry: () => unknown
  commit: (event: unknown, entry: unknown) => void
}

/** 官方 plugin 记录类型语法:`plugin:` + 小写字母/数字/`._-` 分段(每段以字母或数字开头)。 */
const PLUGIN_RECORD_TYPE = /^plugin:[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/

/** 与官方 assertPluginRecordEvent 同语义:类型不在 plugin 记录语法内即拒绝。 */
function assertPluginRecordType(type: string): void {
  if (!PLUGIN_RECORD_TYPE.test(type)) {
    throw new Error(`plugin record type "${type}" must be "plugin:" followed by lowercase slash-separated segments`)
  }
}

/**
 * 与官方 snapshotJsonValue 同语义的负载快照:拒绝无法无损 JSON 序列化的值。
 * 返回独立副本,调用方之后修改原对象不会影响已提交记录。
 */
function snapshotPluginData(type: string, data: unknown): unknown {
  let text: string | undefined
  try {
    text = JSON.stringify(data)
  } catch (cause) {
    throw new Error(`plugin record "${type}" carries non-JSON-serializable data: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  if (text === undefined) {
    throw new Error(`plugin record "${type}" carries non-JSON-serializable data`)
  }
  return JSON.parse(text) as unknown
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
  }
  return value
}

export function writePluginRecord(session: Session, type: string, data: unknown): void {
  assertPluginRecordType(type)
  const surface = session as unknown as SessionCommitSurface
  if (typeof surface.commit !== 'function' || typeof surface.publicationEntry !== 'function') {
    throw new Error('plugin record shim: this Session copy does not expose commit()/publicationEntry()')
  }
  const entry = surface.publicationEntry()
  const snapshot = snapshotPluginData(type, data)
  const previous = surface.seq > 0 ? session.snapshotEvents(SessionLogOffset(surface.seq - 1)).at(-1) : undefined
  const seq = previous ? Number(previous.seq) + 1 : 0
  if (surface.seq !== seq) throw new Error('ChatDS Session sequence contract does not match the installed runtime')
  try {
    appendPluginRecord(session, type as keyof PluginRecordMap, snapshot as PluginRecordMap[keyof PluginRecordMap])
    return
  } catch (error) {
    // Desktop loads its Session class from a separate module instance.
    if (!(error instanceof TypeError && /Receiver must be an instance of class Session|private (?:member|method)/i.test(error.message))) throw error
  }
  const record = deepFreeze({
    type,
    seq,
    time: Date.now(),
    data: snapshot,
    ignorable: true,
  })
  surface.commit(record, entry)
}
