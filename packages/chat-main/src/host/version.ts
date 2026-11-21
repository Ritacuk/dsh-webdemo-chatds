/**
 * 版本与环境标识(D1 修复:统一版本来源,回答"桌面端加载的是哪一份源码")。
 *
 * 版本唯一权威 = 安装包自己的 package.json,不在源码里再写一份常量。
 * V0 的 `0.1.0 清单 / 0.2.0 Health` 漂移就是双常量造成的。
 *
 * Commit 在构建期由 tsdown `define` 注入(`__DSH_CHAT_BUILD_COMMIT__`),
 * 因此安装包能自证由哪一个提交构建;源码/测试环境下回退 'dev'。
 */

import { readFileSync } from 'node:fs'

/** 构建期注入的提交哈希(tsdown define);未注入时为 undefined。 */
declare const __DSH_CHAT_BUILD_COMMIT__: string | undefined

let cached: string | undefined

/** 本包名:用于确认读到的 package.json 确实是本插件,而不是上级 node_modules 的。 */
const PACKAGE_NAME = 'dsh-webdemo-chatds'

/**
 * 读取本包的版本号(不传 baseUrl 时读真实模块位置并缓存)。
 *
 * 两种布局都要成立(这正是首次安装实测抓到的坑):
 * - 构建产物 `lib/index.js` → `../package.json`(包根);
 * - 源码/测试 `src/host/version.ts` → `../../package.json`(包根)。
 * 只用一种相对路径会让构建产物读到 `node_modules/package.json` 而返回 unknown。
 * 候选按 `name` 字段校验,避免误读上级清单。
 *
 * @param baseUrl - 覆盖模块基准 URL(仅测试用,不缓存)。
 * @returns 版本字符串;候选全部失败时返回 `0.0.0-unknown`(Health 会暴露该值)。
 */
export function pluginVersion(baseUrl?: string | URL): string {
  const useCache = baseUrl === undefined
  if (useCache && cached !== undefined) return cached
  const base = baseUrl ?? import.meta.url
  for (const relative of ['../package.json', '../../package.json']) {
    try {
      const raw = readFileSync(new URL(relative, base), 'utf8')
      const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown }
      if (parsed.name !== PACKAGE_NAME) continue
      if (typeof parsed.version === 'string' && parsed.version.length > 0) {
        if (useCache) cached = parsed.version
        return parsed.version
      }
    } catch {
      // 尝试下一个布局
    }
  }
  if (useCache) cached = '0.0.0-unknown'
  return '0.0.0-unknown'
}

/** 构建期注入的完整 Git 提交，未注入的测试模块返回 'dev'。 */
export function buildCommit(): string {
  return typeof __DSH_CHAT_BUILD_COMMIT__ === 'string' && __DSH_CHAT_BUILD_COMMIT__.length > 0
    ? __DSH_CHAT_BUILD_COMMIT__
    : 'dev'
}
