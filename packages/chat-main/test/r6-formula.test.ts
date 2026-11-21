import { expect, it } from 'vitest'
import { toMdAst } from '../client/src/services/markdown/parse.js'

const parse = (markdown: string) => toMdAst(markdown, { sources: undefined, disableLink: false })

it('recovers a complete aligned display when its missing closer swallows subsequent Markdown', () => {
  const markdown = [
    '$$ ', '\\begin{aligned}', '\\nabla \\cdot E &= \\rho / \\epsilon_0', '\\end{aligned}', '',
    '## Differential form', '', '| Law | Formula |', '| --- | --- |', '| Gauss | \\(\\nabla \\cdot E\\) |',
  ].join('\n')
  expect(parse(markdown).children.map((node) => node.type)).toEqual(['math', 'heading', 'table'])
})

it('preserves intentional fenced LaTeX examples', () => {
  const input = ['~~~tex', '$$', '\\begin{cases}', 'x', '\\end{cases}', '## Source', '~~~'].join('\n')
  expect(parse(input).children.map((node) => node.type)).toEqual(['code'])
})
