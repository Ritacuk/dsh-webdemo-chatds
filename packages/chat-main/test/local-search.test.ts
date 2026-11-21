/**
 * P2-G 安全测试 — 本地检索引擎的权限边界(真实临时目录,只读断言)。
 * 覆盖:授权目录白名单、路径穿越、符号链接逃逸、绝对路径/UNC 拒绝、
 * 未授权目录、文件读取不变性、只读 API 面。
 */

import { mkdtempSync, mkdirSync, rmSync, rmdirSync, symlinkSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalSearchEngine, dirIdOf } from '../src/host/local-search.js'
import { extractFilenameTargets, extractSearchTerms } from '../src/host/terms.js'
import { strToU8, zipSync } from 'fflate'

let root: string
let authorized: string[]
let engine: LocalSearchEngine

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'chatws-search-'))
  authorized = [join(root, 'docs')]
  mkdirSync(join(root, 'docs', 'sub'), { recursive: true })
  writeFileSync(join(root, 'docs', 'notes.txt'), 'alpha keyword here\nsecond line\nbeta keyword\n')
  writeFileSync(join(root, 'docs', 'sub', 'code.py'), 'def alpha():\n    return "keyword"\n')
  writeFileSync(join(root, 'secret.txt'), 'outside authorized dir\n')
  engine = new LocalSearchEngine(async () => authorized)
})

afterEach(() => {
  // D1:junction 必须先用 rmdir 摘除再递归删除;直接 rmSync 在有 junction
  // 指向自身根目录时会以 "Unknown error / 系统无法识别文件名" 失败(Windows 实测)。
  for (const junction of [join(root, 'docs', 'escape'), join(root, 'docs', 'inner'), join(root, 'link-root')]) {
    try { rmdirSync(junction) } catch { /* 不存在或不是 junction */ }
  }
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    // 临时目录清理失败不影响断言结论
  }
})

describe('P2-G:授权目录与检索', () => {
  it('prioritizes a quoted Unicode XLSX filename over text matches and honors revocation', async () => {
    const name = '预算-月 11.XLSX'
    writeFileSync(join(root, 'docs', 'sub', name), 'not parsed as a spreadsheet')
    const request = { query: 'keyword', match: 'any' as const, filenames: extractFilenameTargets('查找“预算-月 11.xlsx”') }
    const result = await engine.search(request)
    expect(result).toMatchObject({ exactMatches: 1, searchedDirectories: 1 })
    expect(result.hits.map((hit) => hit.relativePath.replaceAll('\\', '/'))).toEqual(['sub/' + name])
    authorized = []
    expect((await engine.search(request)).hits).toEqual([])
  })
  it('授权目录内的关键词检索返回命中(带相对路径与行号)', async () => {
    const result = await engine.search({ query: 'keyword' })
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.hits.map((hit) => hit.relativePath.replaceAll('\\', '/'))).toContain('notes.txt')
    expect(result.hits.some((hit) => hit.line === 1 && hit.preview.includes('alpha'))).toBe(true)
  })

  it('未授权目录中的文件不可见(secret.txt 不出现)', async () => {
    const result = await engine.search({ query: 'outside authorized' })
    expect(result.hits).toHaveLength(0)
  })

  it('撤销授权后立即不可见(并发授权变更:每次请求实时读取)', async () => {
    const before = await engine.search({ query: 'alpha' })
    expect(before.hits.length).toBeGreaterThan(0)
    authorized = []
    const after = await engine.search({ query: 'alpha' })
    expect(after.hits).toHaveLength(0)
    expect(after.skipped).toContainEqual({ path: '*', reason: 'no authorized directory' })
  })
})

describe('P2-G:路径穿越与拒绝', () => {
  it('目录 id 不在白名单 → 拒绝', async () => {
    const dirs = await engine.listDirs()
    const fakeId = dirIdOf(join(root, 'other'))
    const result = await engine.search({ query: 'x' })
    void result
    void fakeId
    void dirs
    // readSnippet 的直接拒绝路径:
    const read = await engine.readSnippet({ dirId: dirIdOf(join(root, 'not-auth')), relativePath: 'docs/notes.txt' })
    expect(read).toMatchObject({ refused: 'directory not authorized' })
  })

  it('readSnippet 绝对路径拒绝', async () => {
    const dirs = await engine.listDirs()
    const read = await engine.readSnippet({ dirId: dirs[0]!.id, relativePath: join(root, 'secret.txt') })
    expect(read).toMatchObject({ refused: 'absolute or UNC path rejected' })
  })

  it('readSnippet 路径穿越(..\\..\\secret.txt)拒绝', async () => {
    const dirs = await engine.listDirs()
    const read = await engine.readSnippet({ dirId: dirs[0]!.id, relativePath: '..\\..\\secret.txt' })
    if (process.platform === 'win32') {
      expect(read).toMatchObject({ refused: 'path traversal rejected' })
    } else {
      // POSIX 上反斜杠是合法文件名字符,不构成 `..` 穿越;仍必须拒绝读出内容,不得泄露。
      expect(read).toMatchObject({ refused: expect.any(String) })
      expect(read).not.toHaveProperty('content')
    }
  })

  it('readSnippet 路径穿越(../../secret.txt)拒绝', async () => {
    const dirs = await engine.listDirs()
    const read = await engine.readSnippet({ dirId: dirs[0]!.id, relativePath: '../../secret.txt' })
    expect(read).toMatchObject({ refused: 'path traversal rejected' })
  })

  it('readSnippet UNC 形态拒绝', async () => {
    const dirs = await engine.listDirs()
    const read = await engine.readSnippet({ dirId: dirs[0]!.id, relativePath: '\\\\server\\share\\x.txt' })
    expect(read).toMatchObject({ refused: 'absolute or UNC path rejected' })
  })

  it('readSnippet 非文本文件拒绝', async () => {
    writeFileSync(join(root, 'docs', 'blob.bin'), Buffer.from([0, 1, 2, 3]))
    const dirs = await engine.listDirs()
    const read = await engine.readSnippet({ dirId: dirs[0]!.id, relativePath: 'blob.bin' })
    expect(read).toMatchObject({ refused: 'text extraction unavailable for this format' })
  })
})

it('检索并读取中文工作表、幻灯片、UTF-16 和明确指定的 GB18030 文本', async () => {
  const dir = authorized[0]!
  writeFileSync(join(dir, '数据.xlsx'), zipSync({
    'xl/sharedStrings.xml': strToU8('<sst><si><t>紫水晶</t></si></sst>'),
    'xl/worksheets/sheet1.xml': strToU8('<worksheet><row><c t="s"><v>0</v></c></row></worksheet>'),
  }))
  writeFileSync(join(dir, '幻灯.pptx'), zipSync({
    'ppt/slides/slide1.xml': strToU8('<p:sld><a:p><a:t>紫水晶</a:t></a:p></p:sld>'),
  }))
  writeFileSync(join(dir, '编码.txt'), Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('紫水晶', 'utf16le').swap16()]))
  writeFileSync(join(dir, '传统.txt'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))
  const result = await engine.search({ query: '紫水晶' })
  expect(result.hits.map(({ relativePath }) => relativePath)).toEqual(expect.arrayContaining(['数据.xlsx', '幻灯.pptx', '编码.txt']))
  expect(await engine.readSnippet({ dirId: dirIdOf(dir), relativePath: '传统.txt', encoding: 'gb18030' })).toMatchObject({ content: '中文' })
  expect(await engine.search({ query: '紫水晶', signal: AbortSignal.abort() })).toMatchObject({ truncated: true, truncationReasons: ['cancelled'] })
})

describe('P2-G:符号链接逃逸(junction:Windows 免权限的等价逃逸面)', () => {
  it('指向授权目录外的 junction 被拒绝', async () => {
    try {
      symlinkSync(root, join(root, 'docs', 'escape'), 'junction')
    } catch (cause) {
      console.log('junction not permitted on this environment; skipping', cause instanceof Error ? cause.code : '')
      return
    }
    const dirs = await engine.listDirs()
    // 经 junction 读取授权目录外的 secret.txt:必须在 lstat/realpath 检查处被拒
    const read = await engine.readSnippet({ dirId: dirs[0]!.id, relativePath: 'escape/secret.txt' })
    expect('refused' in read).toBe(true)
    // 检索也不返回授权目录外的内容
    const result = await engine.search({ query: 'outside authorized' })
    expect(result.hits).toHaveLength(0)
  })

  it('指向授权目录内部的 junction 允许(逃逸检查通过)', async () => {
    try {
      symlinkSync(join(root, 'docs', 'sub'), join(root, 'docs', 'inner'), 'junction')
    } catch (cause) {
      console.log('junction not permitted on this environment; skipping', cause instanceof Error ? cause.code : '')
      return
    }
    const dirs = await engine.listDirs()
    const read = await engine.readSnippet({ dirId: dirs[0]!.id, relativePath: 'inner/code.py' })
    expect('refused' in read).toBe(false)
    expect((read as { content: string }).content).toContain('keyword')
  })
})

describe('P2-G:只读保证', () => {
  it('文件读取前后内容与元数据不变(原始文件不被修改)', async () => {
    const target = join(root, 'docs', 'notes.txt')
    const before = { content: readFileSync(target, 'utf8'), mtime: statSync(target).mtimeMs, size: statSync(target).size }
    const dirs = await engine.listDirs()
    await engine.readSnippet({ dirId: dirs[0]!.id, relativePath: 'docs/notes.txt' })
    await engine.search({ query: 'keyword' })
    const after = { content: readFileSync(target, 'utf8'), mtime: statSync(target).mtimeMs, size: statSync(target).size }
    expect(after).toEqual(before)
  })

  it('模块 API 面只有只读操作(结构性强制:无写/删/执行入口)', async () => {
    const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(engine))
    const writeOps = proto.filter((name) => /write|delete|unlink|rename|exec|rmdir|mkdir|append/i.test(name))
    expect(writeOps).toEqual([])
    expect(proto).toContain('search')
    expect(proto).toContain('readSnippet')
    expect(proto).toContain('listDirs')
  })
})

describe('D1:自然语言提问的检索口径(实机零命中的回归)', () => {
  it('中文整句拆成二元组:2 字关键词不再被丢弃,整句不再当作单一查询词', () => {
    const terms = extractSearchTerms('项目里的口令是什么')
    expect(terms).toContain('口令')
    expect(terms).toContain('项目')
    expect(terms).not.toContain('项目里的口令是什么')
    // 2 字英文/数字词(V0 恰好被 {3,} 丢弃的那类)
    expect(extractSearchTerms('V0 版本')).toContain('v0')
  })

  it('match:any 返回任一词命中的文件,并按命中词数优先排序', async () => {
    writeFileSync(join(root, 'docs', 'single.txt'), 'alpha only here\n')
    writeFileSync(join(root, 'docs', 'both.txt'), 'alpha and gamma together\n')
    const result = await engine.search({ query: 'alpha gamma', match: 'any' })
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.hits[0]?.relativePath).toBe('both.txt')
  })

  it('match:all 保持原有严格语义(全部词必须命中)', async () => {
    writeFileSync(join(root, 'docs', 'single.txt'), 'alpha only here\n')
    writeFileSync(join(root, 'docs', 'both2.txt'), 'alpha and gamma together\n')
    const result = await engine.search({ query: 'alpha gamma', match: 'all' })
    expect(result.hits.map((hit) => hit.relativePath)).toContain('both2.txt')
    expect(result.hits.map((hit) => hit.relativePath)).not.toContain('single.txt')
  })

  it('依赖/构建目录(node_modules)不参与检索,不占遍历预算', async () => {
    mkdirSync(join(root, 'docs', 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(root, 'docs', 'node_modules', 'pkg', 'noise.txt'), 'unique-zzz-token\n')
    const result = await engine.search({ query: 'unique-zzz-token' })
    expect(result.hits).toHaveLength(0)
  })

  it('中文关键词在真实 TXT 中正向命中(实机验证口径的最小化版本)', async () => {
    writeFileSync(join(root, 'docs', 'secret-note.txt'), '测试口令是蓝鲸731\n这是第二行\n')
    const result = await engine.search({ query: '蓝鲸731' })
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.hits.some((hit) => hit.line === 1 && hit.preview.includes('蓝鲸731'))).toBe(true)
  })
})

describe('D1:授权根归一与 any 模式精度(审计发现的同类缺陷)', () => {
  it('以 junction 作为授权根时仍能检索(授权根按 realpath 归一)', async () => {
    try {
      symlinkSync(join(root, 'docs', 'sub'), join(root, 'link-root'), 'junction')
    } catch (cause) {
      console.log('junction not permitted; skip', cause instanceof Error ? cause.code : '')
      return
    }
    authorized = [join(root, 'link-root')]
    const result = await engine.search({ query: 'keyword' })
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.hits.some((hit) => hit.relativePath === 'code.py')).toBe(true)
  })

  it('any 模式下扩展名词不产生文件名假阳性(问 pdf 不应命中所有 PDF)', async () => {
    writeFileSync(join(root, 'docs', 'brief.pdf'), '%PDF-1.4 binary-ish placeholder\n')
    const result = await engine.search({ query: 'pdf', match: 'any' })
    expect(result.hits.map((hit) => hit.relativePath)).not.toContain('brief.pdf')
  })
})
