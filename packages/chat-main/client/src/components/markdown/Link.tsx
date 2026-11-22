import type { Image, Link as LinkNode } from 'mdast'
import { memo, type ReactNode } from 'react'
import { sanitizeUrl } from '../../services/markdown/sanitize-url.js'

export const Link = memo(function Link({
  node,
  children,
}: {
  node: LinkNode
  children: ReactNode
}) {
  // 页内锚点显示链接文字。
  if (node.url.startsWith('#')) {
    return children
  }

  // 邮件地址显示链接文字。
  if (node.url.startsWith('mailto:')) {
    return children
  }

  // 无法安全解析（含相对路径）时 href 为空，链接文字仍可显示。
  const href = sanitizeUrl(node.url) ?? undefined

  return (
    <a href={href} title={node.title || undefined} target="_blank" rel="noreferrer">
      {children}
    </a>
  )
})

/** Markdown 图片显示为指向图片地址的链接 */
export function ImageAsLink({ node }: { node: Image }) {
  const url = sanitizeUrl(node.url)
  if (url === null) {
    return <span>{node.url}</span>
  }
  return (
    <a href={url} title={node.title ?? ''} target="_blank" rel="noreferrer">
      {url}
    </a>
  )
}
