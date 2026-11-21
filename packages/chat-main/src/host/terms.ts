/**
 * 本地检索预取的候选词提取(D1 修复,独立模块便于单测)。
 *
 * V0 实机的零命中根因有两条,都在这里:
 * 1. 旧实现用 `[\p{L}\p{N}_-]{3,}` 取词,中文整句是一段连续字母 → 整句被当成一个词,
 *    要求文件包含整句才命中;而 2 字中文关键词("口令")又因 `{3,}` 被直接丢弃。
 * 2. 旧实现是"全部词命中"语义,自然语言提问几乎不可能全部命中同一文件。
 *
 * 现实现:拉丁/数字词按 ≥2 字取;中日韩连续段取 2 元组(整段命中率极低);
 * 过滤常见虚词;预取调用方使用 `match: 'any'` + 命中数排序,按相关性取前若干条。
 */

/** 常见虚词/功能词(避免 2 字组噪声占满结果)。 */
const SEARCH_STOPWORDS = new Set([
  '什么', '怎么', '怎样', '如何', '为何', '为什么', '请问', '帮我', '帮忙', '请你', '请帮',
  '可以', '能否', '是否', '是不是', '这个', '那个', '这些', '那些', '这样', '那样',
  '我们', '你们', '他们', '它们', '一个', '一些', '一下', '现在', '然后', '因为', '所以',
  '但是', '如果', '以及', '还有', '里面', '里边', '其中', '关于', '对于', '通过', '进行',
  '需要', '应该', '告诉', '查找', '搜索', '哪些', '哪个', '多少', '有没有',
  'the', 'and', 'for', 'with', 'that', 'this', 'what', 'how', 'why', 'please', 'help',
])

/**
 * 从一句话里提取检索候选词(拉丁词 ≥2 字 + CJK 二元组;上限 12 个)。
 * @param content - 用户提问原文。
 * @returns 去重后的候选词;空数组表示没有可检索的词。
 */
export function extractSearchTerms(content: string): string[] {
  const terms: string[] = []
  const push = (value: string): void => {
    const term = value.trim().toLowerCase()
    if (term.length === 0 || SEARCH_STOPWORDS.has(term) || terms.includes(term)) return
    terms.push(term)
  }
  for (const word of content.toLowerCase().match(/[a-z0-9][a-z0-9_.-]+/g) ?? []) push(word)
  for (const run of content.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) ?? []) {
    if (run.length < 2) continue
    for (let index = 0; index + 2 <= run.length; index++) push(run.slice(index, index + 2))
  }
  return terms.slice(0, 12)
}

/** Keep quoted names with spaces and unquoted Unicode filename/path mentions intact. */
export function extractFilenameTargets(content: string): string[] {
  const filenames = new Set<string>()
  const extension = /\.(?:xlsx?|docx?|pdf|txt|csv|tsv|pptx?|md|json|png|jpe?g|zip)\b/iu
  for (const match of content.matchAll(/["'“‘「\x60]([^"'”’」\x60\r\n]+)["'”’」\x60]|([\p{L}\p{N}_./\\:-]+\.[a-z0-9]+)\b/giu)) {
    const value = (match[1] ?? match[2]).trim()
    const suffix = extension.exec(value)
    if (suffix && suffix.index + suffix[0].length === value.length) filenames.add(value)
    if (filenames.size >= 12) break
  }
  return [...filenames]
}
