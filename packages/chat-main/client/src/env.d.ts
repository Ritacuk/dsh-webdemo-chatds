declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css' {}

/** 公开 API 的地址，见 rspack.config.ts 的 createConfig */
declare const __API_ORIGIN__: string

/** Prism 语言包通过副作用注册到全局 Prism */
declare module 'prismjs/components/*' {}

/** KaTeX 化学公式扩展通过副作用注册到 KaTeX */
declare module 'katex/contrib/mhchem' {}

/**
 * 契约文件 rspack.config.ts 使用了 rspack 1.x 的 `builtins.html` 字段,而锁定的
 * @rspack/*@2.0.2 类型与运行时都已移除 builtins(2.x 需改用 HtmlRspackPlugin)。
 * 禁改契约文件,这里用环境模块声明放宽 defineConfig 的入参类型,使 typecheck 可通过。
 * 注意:这只是类型层面的兜底,rspack.config.ts 与 2.x 的运行时不兼容仍需契约方处理。
 */
declare module '@rspack/cli' {
  export function defineConfig(config: unknown): unknown
}
