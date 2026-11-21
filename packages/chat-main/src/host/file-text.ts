import { unzipSync } from 'fflate'

export const officeTextExtensions = new Set(['.docx', '.xlsx', '.pptx'])
const maxExtractedBytes = 16 * 1024 * 1024

export function decodeText(bytes: Uint8Array, encoding?: 'gb18030'): string {
  const [first, second] = bytes
  if (first === 0xff && second === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(bytes)
  if (first === 0xfe && second === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(bytes)
  return new TextDecoder(encoding ?? 'utf-8', { fatal: true }).decode(bytes)
}

function unescapeXml(text: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (source, entity: string) => {
    if (entity[0] !== '#') return entities[entity] ?? source
    const hex = entity[1]?.toLowerCase() === 'x'
    const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10)
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : source
  })
}

function xmlText(source: string, tag: 'w:t' | 'a:t' | 't'): string {
  return [...source.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, 'g'))]
    .map((match) => unescapeXml(match[1] ?? '')).join('')
}

/** Only extract bounded, known text parts from an Office ZIP container. */
export function extractOfficeText(bytes: Uint8Array, extension: string): string {
  const kind = extension === '.docx' ? /^word\/document\.xml$/
    : extension === '.pptx' ? /^ppt\/slides\/slide\d+\.xml$/
      : /^xl\/(?:sharedStrings|worksheets\/sheet\d+)\.xml$/
  let size = 0
  const parts = unzipSync(bytes, { filter: (entry) => {
    if (!kind.test(entry.name)) return false
    size += entry.originalSize
    if (size > maxExtractedBytes) throw new Error('Office 文本超出解压预算。')
    return true
  } })
  const read = (name: string) => new TextDecoder('utf-8', { fatal: true }).decode(parts[name])
  const names = Object.keys(parts).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  if (extension === '.docx') {
    if (!parts['word/document.xml']) throw new Error('DOCX 缺少正文。')
    return read('word/document.xml').split('</w:p>').map((line) => xmlText(line, 'w:t')).filter(Boolean).join('\n')
  }
  if (extension === '.pptx') {
    if (!names.length) throw new Error('PPTX 缺少可读取的幻灯片。')
    return names.flatMap((name) => read(name).split('</a:p>').map((line) => xmlText(line, 'a:t'))).filter(Boolean).join('\n')
  }
  const sheets = names.filter((name) => name !== 'xl/sharedStrings.xml')
  if (!sheets.length) throw new Error('XLSX 缺少可读取的工作表。')
  const shared = parts['xl/sharedStrings.xml'] ? [...read('xl/sharedStrings.xml').matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)]
    .map((match) => xmlText(match[1] ?? '', 't')) : []
  return sheets.flatMap((name) => [...read(name).matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g)].map((row) =>
    [...(row[1] ?? '').matchAll(/<c(\s[^>]*?)?>([\s\S]*?)<\/c>/g)].map(([, attributes, cell = '']) => {
      const value = /<v>([^<]*)<\/v>/.exec(cell)?.[1]
      if (/\bt="s"/.test(attributes ?? '')) return value === undefined ? '' : (shared[Number(value)] ?? '')
      return xmlText(cell, 't') || (value === undefined ? '' : unescapeXml(value))
    }).join('\t'),
  )).filter((row) => row.trim()).join('\n')
}
