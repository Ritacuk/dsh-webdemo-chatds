// 联合验收证据收集:运行全部测试/类型检查/构建,把输出写入 evidence 目录。
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const outDir = join(repoRoot, 'reports', 'p0-p2-acceptance', 'evidence')
mkdirSync(outDir, { recursive: true })

// 运行环境完全由 DSH_NODE / DSH_PNPM 环境变量提供(无平台相关的默认路径)。
const NODE = process.env['DSH_NODE']
const PNPM = process.env['DSH_PNPM']
if (!NODE || !PNPM) {
  console.error('collect-evidence 需要设置 DSH_NODE 与 DSH_PNPM 环境变量(指向 node 与 pnpm 可执行文件)。')
  process.exit(1)
}
process.env['PATH'] = process.platform === 'win32'
  ? `${dirname(NODE)};${process.env['PATH'] ?? ''}`
  : `${dirname(NODE)}:${process.env['PATH'] ?? ''}`

const tasks = [
  ['test-shared.log', ['--filter', '@dsh-chat/shared', 'test']],
  ['test-main.log', ['--filter', 'dsh-chat-workspace-main', 'test']],
  ['test-sidecar.log', ['--filter', 'dsh-chat-workspace-sidecar', 'test']],
  ['typecheck-shared.log', ['--filter', '@dsh-chat/shared', 'typecheck']],
  ['typecheck-main.log', ['--filter', 'dsh-chat-workspace-main', 'typecheck']],
  ['typecheck-sidecar.log', ['--filter', 'dsh-chat-workspace-sidecar', 'typecheck']],
  ['typecheck-client.log', ['--filter', 'dsh-chat-workspace-client', 'typecheck']],
  ['build-shared.log', ['--filter', '@dsh-chat/shared', 'build']],
  ['build-main-host.log', ['--filter', 'dsh-chat-workspace-main', 'build:host']],
  ['build-sidecar.log', ['--filter', 'dsh-chat-workspace-sidecar', 'build']],
  ['build-client.log', ['--filter', 'dsh-chat-workspace-client', 'run', 'build']],
]

let failures = 0
for (const [name, args] of tasks) {
  console.log(`>>> ${name}: pnpm ${args.join(' ')}`)
  const result = spawnSync(NODE, [PNPM, ...args], { cwd: repoRoot, encoding: 'utf8' })
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  writeFileSync(join(outDir, name), output)
  const failed = result.status !== 0
  if (failed) failures++
  console.log(`    exit=${String(result.status)} ${failed ? 'FAIL' : 'ok'}`)
}
console.log(`\nevidence written to ${outDir}; failures: ${String(failures)}`)
process.exitCode = failures === 0 ? 0 : 1
