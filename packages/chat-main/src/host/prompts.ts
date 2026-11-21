/**
 * R8 提示词系统 — 全局附加提示词 + 模板库。
 *
 * - 全局附加提示词:追加在 demo 身份指令之后(system 参数单次注入;
 *   会话日志的 system/message 仅在内容变化时改写一次,不逐轮重复)。
 * - 模板库:存 KV 域 chat_workspace 的 prompts 表(Profile 隔离),
 *   默认模板首次访问时种子化,用户可删除,删除后不再复活。
 * - 变量替换:确定性注入前解析;未解析变量保留原文并明确上报,不静默删除。
 */

import type { PromptTemplate, PromptVariablePreview } from '@dsh-chat/shared'
import type { WorkspaceStore } from './store.js'

export const GLOBAL_PROMPT_MAX = 20_000

/** demo 身份指令(turns.ts 同源);全局附加提示词只追加,不覆盖。 */
export const BASE_SYSTEM_PROMPT = '该助手为DeepSeek，由深度求索公司创造。'

/** 生效的系统提示词(demo 指令 + 用户全局附加提示词)。 */
export function effectiveSystemPrompt(settings: { globalPromptEnabled: boolean; globalPromptText: string }): string {
  const text = settings.globalPromptEnabled ? settings.globalPromptText.trim() : ''
  return text.length > 0 ? `${BASE_SYSTEM_PROMPT}\n\n${text}` : BASE_SYSTEM_PROMPT
}

export interface PromptVariableContext {
  date?: string
  model?: string
  sessionTitle?: string
  workspace?: string
  selection?: string
}

/** 模板支持的变量集合。 */
export const PROMPT_VARIABLES = ['date', 'model', 'sessionTitle', 'workspace', 'selection'] as const

const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g

/** 解析模板变量;未解析变量保留原文(明确列出,不静默删除)。 */
export function resolveTemplateVariables(template: string, context: PromptVariableContext): PromptVariablePreview {
  const variables: PromptVariablePreview['variables'] = []
  const seen = new Set<string>()
  const resolved = template.replace(VARIABLE_PATTERN, (original, name: string) => {
    if (!seen.has(name)) {
      seen.add(name)
      const value = context[name as keyof PromptVariableContext]
      variables.push({ name, ...(value !== undefined && value !== '' ? { value, resolved: true } : { resolved: false }) })
    }
    const value = context[name as keyof PromptVariableContext]
    return value !== undefined && value !== '' ? value : original
  })
  return { resolved, variables }
}

/** 默认模板(用户可删除;删除后不再复活)。 */
const DEFAULT_TEMPLATES: Omit<PromptTemplate, 'createdAt' | 'updatedAt'>[] = [
  {
    id: 'tpl-academic-analysis',
    name: '学术论文分析',
    category: '学术',
    summary: '对论文的结构、贡献与局限做系统分析。',
    body: `请按以下框架分析我提供的学术论文:

1. 研究问题与动机:论文要解决什么问题,为什么重要。
2. 方法概述:核心方法/模型/实验设计,关键创新点。
3. 实验与证据:主要结果、数据集、对照设置。
4. 局限与风险:作者承认的局限与你补充的局限。
5. 相关工作定位:与哪些已有工作最接近,差异是什么。
6. 一句话总结:用一句话概括这篇论文的价值。

输出使用中文,保留必要的英文术语。`,
    tags: ['学术', '论文'],
  },
  {
    id: 'tpl-literature-reading',
    name: '文献精读',
    category: '学术',
    summary: '逐段精读文献并给出批注式笔记。',
    body: `请对我提供的文献做精读笔记:

- 逐段归纳段落要点(不超过三句)。
- 标出关键概念、公式与数据,并解释含义。
- 指出论证链条中证据最强与最弱的环节。
- 最后给出 3-5 条值得追问的问题。

如果文献内容不完整,请明确指出缺失部分,不要臆测。`,
    tags: ['学术', '精读'],
  },
  {
    id: 'tpl-code-review',
    name: '代码审查',
    category: '开发',
    summary: '按正确性、安全、可读性与性能四个维度审查代码。',
    body: `请审查以下代码,按四个维度输出:

1. 正确性:边界条件、错误处理、并发与资源释放。
2. 安全性:注入、越权、敏感信息泄漏、不安全反序列化。
3. 可读性:命名、结构、注释与测试覆盖。
4. 性能:明显的复杂度或内存问题。

每个问题给出:位置、严重程度(高/中/低)、修改建议。没有问题的维度请写"未发现",不要编造。`,
    tags: ['开发', '审查'],
  },
  {
    id: 'tpl-translation',
    name: '翻译',
    category: '语言',
    summary: '忠实且自然的翻译,保留专有名词原文。',
    body: `请翻译我提供的内容,遵循:

- 按原文语言判断目标语言:中文→英文,其他语言→中文。
- 忠实原意,语句自然,符合目标语言的书面习惯。
- 专有名词首次出现时在括号内保留原文。
- 不添加原文没有的解释;确有歧义时在译文后列出可选译法。`,
    tags: ['翻译'],
  },
  {
    id: 'tpl-japanese-reading',
    name: '日语文章研读',
    category: '语言',
    summary: '日语原文标注、语法讲解与中文翻译。',
    body: `请对我提供的日语文章做研读:

1. 全文中文翻译(自然流畅)。
2. 重点句逐句标注:原句 / 读音(汉字标注假名)/ 语法点 / 中文释义。
3. 列出文中的 N2 及以上语法点与生词。
4. 总结文章主旨与写作风格。`,
    tags: ['日语', '语言学习'],
  },
  {
    id: 'tpl-qa',
    name: '普通问答',
    category: '通用',
    summary: '先给结论再给解释的问答格式。',
    body: `请回答我的问题,遵循:

- 第一句直接给结论。
- 再用要点列出理由或步骤。
- 涉及事实时注明信息可能的时效限制。
- 不确定的内容明确说"不确定",不要编造。`,
    tags: ['通用'],
  },
]

/** 首次访问时种子化默认模板(已删除的 id 不再复活)。 */
export async function ensureDefaultPrompts(store: WorkspaceStore): Promise<void> {
  const existing = new Set((await store.listPrompts()).map((template) => template.id))
  const deleted = await deletedPrompts(store)
  const now = Date.now()
  for (const template of DEFAULT_TEMPLATES) {
    if (existing.has(template.id) || deleted.has(template.id)) continue
    await store.putPrompt({ ...template, builtin: true, createdAt: now, updatedAt: now })
  }
}

const DELETED_KEY = 'deleted-default-prompts'

async function deletedPrompts(store: WorkspaceStore): Promise<Set<string>> {
  const table = (await store.ensure()).table('prefs')
  const record = table.get(DELETED_KEY)?.deletedPrompts
  return new Set(record ?? [])
}

/** 记住被删除的默认模板 id,确保不再复活。 */
export async function markDefaultPromptDeleted(store: WorkspaceStore, id: string): Promise<void> {
  const deleted = await deletedPrompts(store)
  deleted.add(id)
  const table = (await store.ensure()).table('prefs')
  await table.put(DELETED_KEY, { key: DELETED_KEY, deletedPrompts: [...deleted] })
}

/** 校验并规范化模板载荷(路由层使用)。 */
export function normalizePromptInput(input: unknown): Partial<PromptTemplate> | undefined {
  if (input === null || typeof input !== 'object') return undefined
  const raw = input as Record<string, unknown>
  const out: Partial<PromptTemplate> = {}
  if (typeof raw.name === 'string' && raw.name.trim().length > 0 && raw.name.length <= 120) out.name = raw.name.trim()
  if (typeof raw.category === 'string' && raw.category.length <= 60) out.category = raw.category.trim()
  if (typeof raw.summary === 'string' && raw.summary.length <= 500) out.summary = raw.summary.trim()
  if (typeof raw.body === 'string' && raw.body.trim().length > 0 && raw.body.length <= 40_000) out.body = raw.body
  if (Array.isArray(raw.tags)) {
    const tags = raw.tags.filter((tag): tag is string => typeof tag === 'string' && tag.length > 0 && tag.length <= 40)
    if (tags.length <= 12) out.tags = tags
  }
  return Object.keys(out).length > 0 ? out : undefined
}
