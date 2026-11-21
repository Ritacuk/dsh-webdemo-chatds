import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  // Linux DSH 宿主实测 node 22;与 chat-main 保持一致的语法目标。
  target: 'node22',
  external: [/^@deepseek-ai\//, /^node:/],
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  dts: { build: true },
  sourcemap: true,
})
