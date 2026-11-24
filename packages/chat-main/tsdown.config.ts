import { execFileSync } from 'node:child_process'
import { defineConfig } from 'tsdown'

/** 构建期 Commit 注入:Health 接口据此自证安装包来自哪个提交(D1)。 */
function buildCommit(): string {
  const source = process.env.CHATDS_BUILD_COMMIT
  if (source && /^[a-f0-9]{40}(-dirty)?$/.test(source)) return source
  const commit = execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { encoding: 'utf8' }).trim()
  const changes = execFileSync('git', ['status', '--porcelain', '--untracked-files=no', '--', 'src', 'client/src', 'client.js', 'package.json'], { encoding: 'utf8' })
  return changes.trim() ? commit + '-dirty' : commit
}

export default defineConfig({
  entry: { index: 'src/host/index.ts', sidecar: 'src/host/sidecar.ts', sharing: 'src/host/sharing.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  // Linux DSH 宿主实测 node 22;产物语法保持 node 22 兼容(源码不使用 `await using`)。
  target: 'node22',
  // 官方 DSH 运行时与 node 内建模块在宿主 profile 中解析;@dsh-chat/shared 打包进产物,
  // 保证安装包自包含(profile 安装只装这一个包)。
  external: [/^@deepseek-ai\//, /^node:/],
  // 这些包是构建期依赖(包里已内联),不能作为运行时 dependency:
  // 从 `.tgz` 安装时 pnpm 无法解析 workspace 协议,私有包也不在 registry。
  noExternal: ['@dsh-chat/shared', 'zod', 'fflate', 'bonjour-service', '@serenity-kit/opaque'],
  define: {
    __DSH_CHAT_BUILD_COMMIT__: JSON.stringify(buildCommit()),
  },
  // 与 DSH 生态一致:产物为 lib/index.js + lib/index.d.ts(package.json main/types 指向它们)。
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  dts: { build: true },
  sourcemap: true,
  onSuccess() {
    // eslint-disable-next-line no-console
    console.log('[chat-main] host build ok')
  },
})
