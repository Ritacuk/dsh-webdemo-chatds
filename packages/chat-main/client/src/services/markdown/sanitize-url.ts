/**
 * Markdown 链接地址的安全解析（供 Link/ImageAsLink 渲染使用）。
 *
 * 规则（R8.4 回归修复）：
 * - 带协议（`x://`）→ 仅放行 http/https/mailto，其余协议（如 javascript:）拒绝；
 * - 无协议 → 取首个 `/` 之前的主机段判定是否"像域名"：含点、无空白、且不是
 *   常见文档扩展名结尾（`.md`/`.pdf` 等）→ 补全 `https://`（上游 demo 行为，
 *   兼容模型输出的 `github.com` 裸域名与 `example.com/path` 带路径域名）；
 * - 其余（`LICENSE`、`README.zh-CN.md`、`docs/x.md` 等相对路径）→ 返回 null：
 *   模型输出的相对链接在聊天上下文中无从解析，渲染为纯文本，绝不伪装成
 *   可点击地址（曾把 `LICENSE` 补成 `https://license/` 假链接）。
 */
const DOCUMENT_EXTENSION = /\.(md|txt|html?|xhtml|json|pdf|docx?|xlsx?|pptx?|yaml|yml|xml|csv|tsv|log|png|jpe?g|gif|webp|svg|zip|7z|tar|gz|mp3|mp4|wav|ogg)$/i

export function sanitizeUrl(url: string): string | null {
  if (!url) return null
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) {
    // 已带协议:仅放行 http/https/mailto,其余协议一律拒绝。
    try {
      const parsed = new URL(url)
      return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) ? parsed.toString() : null
    } catch {
      return null
    }
  }
  const slash = url.indexOf('/')
  const host = slash === -1 ? url : url.slice(0, slash)
  const looksLikeDomain = !/\s/.test(host) && host.includes('.') && !DOCUMENT_EXTENSION.test(host)
  if (!looksLikeDomain) return null
  try {
    const parsed = new URL(`https://${url}`)
    return parsed.toString()
  } catch {
    return null
  }
}
