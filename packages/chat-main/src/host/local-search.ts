/**
 * 本地只读检索引擎(P2-G)— Host 侧强制权限边界。
 *
 * 安全模型(全部在本模块强制,页面无法绕过):
 * - 授权目录白名单是唯一入口;页面只能按目录 id + 相对路径请求。
 * - 目标路径必须落在授权目录内(Windows 大小写不敏感比较;UNC/盘符经 path 规范化);
 * - 符号链接:lstat 检测,realpath 逃逸出授权目录的一律拒绝并记录 skipped;
 * - 不提供任何写入/删除/重命名/执行接口(模块 API 面只有 list/search/read/stat);
 * - 并发授权变更:每次请求实时读取当前白名单,撤销立即生效;
 * - 资源上限:文件数/深度/单文件大小/总时长,防失控遍历。
 */

import { promises as fs, type Dirent } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { LocalSearchHit, LocalSearchResult } from '@dsh-chat/shared'
import { decodeText, extractOfficeText, officeTextExtensions } from './file-text.js'

/** 检索资源上限。 */
const MAX_FILES_VISITED = 5_000
const MAX_DEPTH = 8
const MAX_FILE_BYTES_FOR_CONTENT = 8 * 1024 * 1024
const MAX_HITS = 40
/** 单次检索最多评估的文件数(按分数排序前的候选上限,避免一次读入过多文件)。 */
const MAX_CANDIDATES = 200
const MAX_PREVIEW_CHARS = 240
const TIMEOUT_MS = 10_000

/**
 * 遍历时跳过的依赖/构建目录名(D1 修复)。
 *
 * V0 实机零命中的一条成因:授权目录若包含 node_modules/.git 等目录,
 * 2000 条遍历预算会在到达用户真实文件前耗尽。这些目录不是"用户文档",
 * 跳过它们既提高命中率也避免读入海量无关文本。
 */
const SKIP_DIR_NAMES = new Set([
  'node_modules', '.git', '.svn', '.hg', '.pnpm', '.pnpm-store',
  '__pycache__', '.venv', 'venv', 'site-packages', '.mypy_cache', '.pytest_cache',
  'dist', 'build', 'out', 'target', '.next', '.nuxt', '.svelte-kit',
  '.cache', '.turbo', 'coverage', '.idea', '.vscode',
])

/** 文本检索关心的扩展名(其余文件仅参与文件名匹配)。 */
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.csv', '.log', '.xml', '.html', '.htm', '.css', '.scss', '.less',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.rs', '.go', '.java',
  '.kt', '.swift', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.sh', '.bash', '.ps1', '.bat',
  '.sql', '.lua', '.pl', '.r', '.m', '.dart', '.vue', '.svelte',
])

/** 目录 id ↔ 路径 的稳定映射(页面只见到 id)。win32 大小写不敏感;POSIX 保留大小写,避免不同目录 id 碰撞。 */
export function dirIdOf(dir: string): string {
  const resolved = resolve(dir)
  return 'dir-' + createHash('sha256').update(process.platform === 'win32' ? resolved.toLowerCase() : resolved).digest('hex').slice(0, 12)
}

/** Windows 文件系统大小写不敏感的比较键。 */
function comparablePath(path: string): string {
  const resolved = resolve(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * 目标是否严格落在授权目录内(含相等)。
 * 使用规范化后的 resolve;不做 realpath(调用方另行处理符号链接)。
 */
function isInsideRoot(root: string, target: string): boolean {
  const r = comparablePath(root)
  const t = comparablePath(target)
  if (t === r) return true
  // 授权根可能以分隔符结尾(盘符根 `C:\` 或用户手输尾斜杠):此时不能再补一个分隔符。
  const prefix = r.endsWith(sep) ? r : r + sep
  return t.startsWith(prefix)
}

/** 一个授权目录的运行时视图。 */
interface AuthorizedRoot {
  id: string
  root: string
}

export class LocalSearchEngine {
  /** 当前授权目录(每次请求从设置实时读取)。 */
  constructor(private readonly authorizedDirs: () => Promise<string[]>) {}

  /** 列出当前授权目录(id + 路径)。 */
  async listDirs(): Promise<{ id: string; path: string }[]> {
    const dirs = await this.authorizedDirs()
    const seen = new Set<string>()
    const out: { id: string; path: string }[] = []
    for (const dir of dirs) {
      const resolved = resolve(dir)
      // 授权根统一按 realpath 归一(junction/符号链接/8.3 短名)。否则遍历时对子项
      // 做的 realpath 逃逸检查会把"真实路径不在字面 root 下"误判成逃逸,整棵树静默跳过。
      const root = await fs.realpath(resolved).catch(() => resolved)
      const id = dirIdOf(root)
      if (seen.has(id)) continue
      seen.add(id)
      out.push({ id, path: root })
    }
    return out
  }

  /**
   * 解析"目录 id + 目录内相对路径"为绝对路径,并执行全部安全检查。
   * 返回 undefined 表示拒绝(拒绝理由写入 skipped)。
   */
  private async resolveSafe(
    dirs: AuthorizedRoot[],
    dirId: string,
    relativePath: string,
    skipped: { path: string; reason: string }[],
  ): Promise<{ root: string; target: string } | undefined> {
    const root = dirs.find((dir) => dir.id === dirId)
    if (root === undefined) {
      skipped.push({ path: dirId, reason: 'directory not authorized' })
      return undefined
    }
    if (typeof relativePath !== 'string' || relativePath.length === 0) {
      skipped.push({ path: dirId, reason: 'empty relative path' })
      return undefined
    }
    // 相对路径不得是绝对路径、不得包含盘符/UNC 形态、不得穿越。
    if (isAbsolute(relativePath) || /^[a-zA-Z]:[\\/]/.test(relativePath) || /^\\\\/.test(relativePath)) {
      skipped.push({ path: relativePath, reason: 'absolute or UNC path rejected' })
      return undefined
    }
    const target = resolve(root.root, relativePath)
    if (!isInsideRoot(root.root, target)) {
      skipped.push({ path: relativePath, reason: 'path traversal rejected' })
      return undefined
    }
    // 逃逸检查(无条件 realpath):符号链接与 Windows junction(lstat 下不是 symlink!)
    // 都被 realpath 解析到真实位置;真实位置落在授权目录外的一律拒绝。
    let stat
    try {
      stat = await fs.lstat(target)
    } catch (cause) {
      const code = typeof cause === 'object' && cause !== null && 'code' in cause ? String((cause as { code: unknown }).code) : String(cause)
      skipped.push({ path: `${relativePath} (resolved ${target})`, reason: `not found: ${code}` })
      return undefined
    }
    const real = await fs.realpath(target).catch(() => undefined)
    if (real === undefined || !isInsideRoot(root.root, real)) {
      skipped.push({ path: relativePath, reason: 'symbolic link or junction escapes authorized directory' })
      return undefined
    }
    void stat
    return { root: root.root, target }
  }

  /** 在授权目录内递归收集文本文件与文件名(资源上限内)。 */
  private async walk(
    root: string,
    visited: { count: number },
    deadline: number,
    skipped: LocalSearchResult['skipped'],
    signal?: AbortSignal,
  ): Promise<{ textFiles: string[]; allFiles: string[] }> {
    const textFiles: string[] = []
    const allFiles: string[] = []
    const queue: { path: string; depth: number }[] = [{ path: root, depth: 0 }]
    while (queue.length > 0 && !signal?.aborted && visited.count < MAX_FILES_VISITED && Date.now() < deadline) {
      const current = queue.shift()!
      let entries: Dirent[]
      try {
        entries = await fs.readdir(current.path, { withFileTypes: true })
      } catch {
        skipped.push({ path: current.path, reason: 'directory unavailable' })
        continue
      }
      for (const entry of entries) {
        if (signal?.aborted || visited.count >= MAX_FILES_VISITED || Date.now() >= deadline) break
        const full = join(current.path, entry.name)
        visited.count++
        // 无条件 realpath 逃逸检查(符号链接与 Windows junction 一并覆盖)。
        const real = await fs.realpath(full).catch(() => undefined)
        if (real === undefined || !isInsideRoot(root, real)) continue
        if (entry.isDirectory()) {
          if (SKIP_DIR_NAMES.has(entry.name.toLowerCase())) continue
          if (current.depth < MAX_DEPTH) queue.push({ path: full, depth: current.depth + 1 })
          else skipped.push({ path: relative(root, full), reason: 'directory depth limit' })
          continue
        }
        if (!entry.isFile()) continue
        allFiles.push(full)
        const extension = extLower(entry.name)
        if (TEXT_EXTENSIONS.has(extension) || officeTextExtensions.has(extension)) textFiles.push(full)
      }
    }
    return { textFiles, allFiles }
  }

  /**
   * 内容/文件名检索(P2-G 的核心动作;只读)。
   * @param options.query - 关键词(大小写不敏感;空白分隔)。
   * @param options.match - `all`(默认,全部词命中才命中文件)或 `any`(任一词命中即命中;
   *   供自然语言提问的检索预取使用 —— 一个中文提问拆出的多个候选词很少同时出现在同一行)。
   */
  async search(options: {
    query: string
    scopeDirIds?: string[]
    match?: 'all' | 'any'
    filenames?: readonly string[]
    encoding?: 'gb18030'
    signal?: AbortSignal
  }): Promise<LocalSearchResult> {
    const skipped: { path: string; reason: string }[] = []
    const allDirs = await this.listDirs()
    const dirs: AuthorizedRoot[] = allDirs
      .filter((dir) => options.scopeDirIds === undefined || options.scopeDirIds.includes(dir.id))
      .map((dir) => ({ id: dir.id, root: dir.path }))
    if (dirs.length === 0) {
      return { hits: [], skipped: [{ path: '*', reason: 'no authorized directory' }], truncated: false }
    }
    const terms = options.query.trim().split(/\s+/).filter((term) => term.length > 0)
    if (terms.length === 0 && !options.filenames?.length) {
      return { hits: [], skipped: [{ path: '*', reason: 'empty query' }], truncated: false }
    }
    const matchMode = options.match ?? 'all'
    const lowerTerms = terms.map((term) => term.toLowerCase())
    /** 返回文本命中的候选词个数。 */
    const scoreOf = (text: string): number => {
      const lower = text.toLowerCase()
      let count = 0
      for (const term of lowerTerms) if (lower.includes(term)) count++
      return count
    }
    const accepted = (score: number): boolean => matchMode === 'all' ? score === lowerTerms.length : score > 0
    /**
     * 文件名命中分。`any` 模式下忽略"与文件自身扩展名相同的词":提问里的 "pdf" 不该让
     * 目录下所有 PDF 都算命中(审计实测的假阳性),命中仍可由内容分或其他词提供。
     */
    const nameScoreOf = (name: string): number => {
      const score = scoreOf(name)
      if (matchMode === 'all') return score
      const ext = extLower(name).replace(/^\./, '')
      if (ext.length === 0) return score
      const lower = name.toLowerCase()
      let adjusted = 0
      for (const term of lowerTerms) {
        if (term === ext) continue
        if (lower.includes(term)) adjusted++
      }
      return adjusted
    }
    const deadline = Date.now() + TIMEOUT_MS
    const visited = { count: 0 }
    const hits: LocalSearchHit[] = []
    const exact: LocalSearchHit[] = []
    const compareName = (value: string) => value.normalize('NFC').toLowerCase().replaceAll('\\', '/')
    const targets = (options.filenames ?? []).map(compareName)
    const walked = []
    const truncation = new Set<string>()
    const stopReason = () => options.signal?.aborted ? 'cancelled'
      : Date.now() >= deadline ? 'time limit'
        : visited.count >= MAX_FILES_VISITED ? 'entry limit' : undefined
    for (const dir of dirs) {
      if (stopReason()) break
      const files = await this.walk(dir.root, visited, deadline, skipped, options.signal)
      walked.push({ dir, ...files })
      if (targets.length === 0) continue
      for (const file of files.allFiles) {
        if (options.signal?.aborted || Date.now() >= deadline) break
        const name = relative(dir.root, file)
        if (!targets.some((target) => compareName(name) === target || compareName(file) === target || compareName(basename(file)) === target)) continue
        const info = await fs.stat(file).catch(() => undefined)
        if (!info?.isFile()) continue
        exact.push({ path: file, relativePath: name, dirId: dir.id, preview: '(exact filename match)', size: info.size, modifiedAt: info.mtimeMs })
      }
    }
    const listStop = stopReason()
    if (listStop) truncation.add(listStop)
    if (exact.length > 0 || terms.length === 0) {
      if (exact.length > MAX_HITS) truncation.add('result limit')
      return { hits: exact.slice(0, MAX_HITS), skipped, truncated: truncation.size > 0, truncationReasons: [...truncation], exactMatches: exact.length, searchedDirectories: walked.length }
    }
    for (const { dir, textFiles, allFiles } of walked) {
      const textSet = new Set(textFiles)
      // 候选文件:文件名与内容取较高分;`any` 模式下按分数降序,`all` 模式下稳定保持遍历顺序。
      const candidates: {
        file: string
        name: string
        size: number
        modifiedAt: number
        nameScore: number
        contentScore: number
        content: string | undefined
      }[] = []
      for (const file of allFiles) {
        if (candidates.length >= MAX_CANDIDATES || Date.now() >= deadline || options.signal?.aborted) {
          truncation.add(options.signal?.aborted ? 'cancelled' : Date.now() >= deadline ? 'time limit' : 'candidate limit')
          break
        }
        const name = file.slice(dir.root.length + 1)
        const nameScore = nameScoreOf(name)
        let contentScore = 0
        let content: string | undefined
        if (textSet.has(file)) {
          const info = await fs.stat(file).catch(() => undefined)
          if (info !== undefined && info.size <= MAX_FILE_BYTES_FOR_CONTENT) {
            try {
              content = await readSearchText(file, options.encoding, options.signal)
              contentScore = scoreOf(content)
            } catch {
              if (!options.signal?.aborted) skipped.push({ path: name, reason: 'unable to read or decode text' })
            }
          } else {
            skipped.push({ path: name, reason: info ? 'file size limit' : 'file unavailable' })
          }
        }
        if (!accepted(Math.max(nameScore, contentScore))) continue
        const info = await fs.stat(file).catch(() => undefined)
        candidates.push({
          file,
          name,
          size: info?.size ?? 0,
          modifiedAt: info?.mtimeMs ?? 0,
          nameScore,
          contentScore,
          content,
        })
      }
      candidates.sort((a, b) => (b.nameScore + b.contentScore) - (a.nameScore + a.contentScore))
      for (const candidate of candidates) {
        if (candidate.nameScore > 0 && accepted(candidate.nameScore)) {
          if (hits.length >= MAX_HITS) { truncation.add('result limit'); break }
          hits.push({
            path: candidate.file,
            relativePath: candidate.name,
            dirId: dir.id,
            preview: '(filename match)',
            size: candidate.size,
            modifiedAt: candidate.modifiedAt,
          })
        }
        if (candidate.content === undefined || !accepted(candidate.contentScore)) continue
        // 每个文件最多取前若干个命中行
        let lineHits = 0
        const lines = candidate.content.split(/\r\n|\r|\n/)
        for (let index = 0; index < lines.length && lineHits < 3; index++) {
          const line = lines[index]!
          if (!accepted(scoreOf(line))) continue
          if (hits.length >= MAX_HITS) { truncation.add('result limit'); break }
          hits.push({
            path: candidate.file,
            relativePath: candidate.name,
            dirId: dir.id,
            line: index + 1,
            preview: line.trim().slice(0, MAX_PREVIEW_CHARS),
            size: candidate.size,
            modifiedAt: candidate.modifiedAt,
          })
          lineHits++
        }
      }
    }
    return { hits: hits.slice(0, MAX_HITS), skipped, truncated: truncation.size > 0, truncationReasons: [...truncation], exactMatches: 0, searchedDirectories: walked.length }
  }

  /** 读取一个明确允许的文件片段(只读;文本解码;越界拒绝)。 */
  async readSnippet(options: {
    dirId: string
    relativePath: string
    startLine?: number
    maxLines?: number
    encoding?: 'gb18030'
  }): Promise<{ path: string; content: string; truncated: boolean } | { refused: string }> {
    const skipped: { path: string; reason: string }[] = []
    const dirs: AuthorizedRoot[] = (await this.listDirs()).map((dir) => ({ id: dir.id, root: dir.path }))
    const resolved = await this.resolveSafe(dirs, options.dirId, options.relativePath, skipped)
    if (resolved === undefined) return { refused: skipped[0]?.reason ?? 'rejected' }
    const stat = await fs.stat(resolved.target).catch(() => undefined)
    if (stat === undefined || !stat.isFile()) return { refused: 'not a file' }
    if (stat.size > MAX_FILE_BYTES_FOR_CONTENT) return { refused: `file too large (${String(stat.size)} bytes)` }
    const extension = extLower(resolved.target)
    if (!TEXT_EXTENSIONS.has(extension) && !officeTextExtensions.has(extension)) return { refused: 'text extraction unavailable for this format' }
    const content = await readSearchText(resolved.target, options.encoding).catch(() => undefined)
    if (content === undefined) return { refused: 'unable to read or decode text' }
    if (!content.trim()) return { refused: 'no extractable text' }
    const lines = content.split(/\r\n|\r|\n/)
    const start = Math.max(0, (options.startLine ?? 1) - 1)
    const maxLines = Math.min(options.maxLines ?? 200, 400)
    const slice = lines.slice(start, start + maxLines)
    return {
      path: resolved.target,
      content: slice.join('\n'),
      truncated: start + slice.length < lines.length,
    }
  }
}

async function readSearchText(path: string, encoding?: 'gb18030', signal?: AbortSignal): Promise<string> {
  const bytes = await fs.readFile(path, { signal })
  const extension = extLower(path)
  return officeTextExtensions.has(extension) ? extractOfficeText(bytes, extension) : decodeText(bytes, encoding)
}

function extLower(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot).toLowerCase()
}
