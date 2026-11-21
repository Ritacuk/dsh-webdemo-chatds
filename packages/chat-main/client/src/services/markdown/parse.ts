import type { Node as MdAstNode, Nodes, Parent, RootContent, Root, Text } from 'mdast'
import { findAndReplace } from 'mdast-util-find-and-replace'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { mathFromMarkdown } from 'mdast-util-math'
import { gfm } from 'micromark-extension-gfm'
import { math } from 'micromark-extension-llm-math'
import type { Source } from '../chat/view.js'

/** 正文里的 [citation:N]，已换成对应来源 */
export interface CitationNode extends MdAstNode {
  type: 'citation'
  source: Source
}

declare module 'mdast' {
  interface RootContentMap {
    citation: CitationNode
  }

  interface PhrasingContentMap {
    citation: CitationNode
  }
}

const text = (value: string): Text => ({ type: 'text', value })

/**
 * 解析正文，并把渲染器不单独处理的节点提前换掉，渲染时无需再读原文：
 * - 传入 sources 时，[citation:N] 换成角标节点，找不到来源的直接去掉
 * - disableLink 时链接只保留文字
 * - 删除线保留原样的 ~ 定界符，脚注、引用式链接与定义显示原文
 */
export function toMdAst(
  input: string,
  { sources, disableLink }: { sources: Source[] | undefined; disableLink: boolean }
): Root {
  const options = {
    extensions: [
      // codeIndented 语法导致有前导空格的列表无法正常渲染
      { ...gfm(), disable: { null: ['codeIndented'] } },
      math({ singleDollarTextMath: true }),
    ],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  }
  let ast = fromMarkdown(input, options)
  // A missing close after a complete display environment can consume the
  // rest of the answer as one math node. Detect it using the Demo AST, so
  // fenced examples and inline code keep their original interpretation.
  const insertions: { at: number; delimiter: string }[] = []
  const visit = (node: Nodes) => {
    if (node.type === 'math' && node.position) {
      const body = node.value
      const environment = /^\\begin\{(aligned|gathered|cases)\}/.exec(body.trimStart())?.[1]
      const end = environment ? new RegExp('^[ \\t]*\\\\end\\{' + environment + '\\}[ \\t]*(?:\\r?\\n|$)', 'm').exec(body) : null
      const tail = end ? body.slice(end.index + end[0].length) : ''
      const raw = input.slice(node.position.start.offset, node.position.end.offset)
      const open = /^(\\\[|[$]{2,})[^\r\n]*\r?\n/.exec(raw)
      if (end && open && /^\s*(?:#{1,6}\s|\|)/m.test(tail)) {
        const closeLine = raw.indexOf('\\end{' + environment + '}', open[0].length)
        const newline = raw.indexOf('\n', closeLine)
        if (closeLine >= 0 && newline >= 0) {
          insertions.push({ at: (node.position.start.offset ?? 0) + newline + 1, delimiter: open[1] === '\\[' ? '\\]' : open[1] })
        }
      }
    } else if ('children' in node) {
      node.children.forEach(visit)
    }
  }
  visit(ast)
  if (insertions.length > 0) {
    for (const { at, delimiter } of insertions.reverse()) input = input.slice(0, at) + delimiter + '\n\n' + input.slice(at)
    ast = fromMarkdown(input, options)
  }
  if (sources) {
    const sourcesByIndex = new Map(sources.map((source) => [source.index, source]))
    findAndReplace(
      ast,
      [
        /\[citation:(\d+)\]/g,
        (_: string, index: string): CitationNode | '' => {
          const source = sourcesByIndex.get(Number(index))
          return source ? { type: 'citation', source } : ''
        },
      ],
      { ignore: ['linkReference'] }
    )
  }
  const raw = (node: Nodes) => input.slice(node.position?.start.offset, node.position?.end.offset)
  // 先处理子节点，再按需把当前节点换成若干节点
  const simplify = (node: Nodes): Nodes[] => {
    if ('children' in node) {
      ;(node as Parent).children = node.children.flatMap(simplify) as RootContent[]
    }
    switch (node.type) {
      case 'link':
        return disableLink ? node.children : [node]
      case 'delete': {
        // 解析器保证首尾定界符等长
        const delimiter = raw(node).match(/^~+/)?.[0] ?? ''
        return [text(delimiter), ...node.children, text(delimiter)]
      }
      case 'footnoteReference':
      case 'imageReference':
      case 'linkReference':
        return [text(raw(node))]
      case 'footnoteDefinition':
      case 'definition':
        return [{ type: 'paragraph', children: [text(raw(node))] }]
      default:
        return [node]
    }
  }
  simplify(ast)
  return ast
}
