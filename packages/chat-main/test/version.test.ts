/**
 * D1:版本单一来源回归测试。
 *
 * V0 的 `0.1.0 安装清单 / 0.2.0 Health` 漂移源于源码常量与 package.json 双份版本。
 * 现在 Health 读取安装包自己的 package.json,断言语义即"两者必须一致"。
 *
 * 首次安装实测还暴露了一个更隐蔽的问题:构建产物在 `lib/` 下时,`../../package.json`
 * 指向 `node_modules/package.json` → Health 返回 `0.0.0-unknown`。因此这里同时覆盖
 * "lib 布局"与"src/host 布局"两种模块位置。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { buildCommit, pluginVersion } from '../src/host/version.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string
  version: string
}

let temp: string | undefined

afterEach(() => {
  if (temp !== undefined) rmSync(temp, { recursive: true, force: true })
  temp = undefined
})

describe('D1:版本单一来源', () => {
  it('源码布局(src/host)读取到与 package.json 一致的版本', () => {
    expect(pluginVersion()).toBe(pkg.version)
    expect(pluginVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('构建产物布局(lib/index.js)同样读取到正确版本(不是 node_modules/package.json)', () => {
    temp = mkdtempSync(join(tmpdir(), 'chatws-version-'))
    mkdirSync(join(temp, 'lib'), { recursive: true })
    writeFileSync(join(temp, 'package.json'), JSON.stringify({ name: pkg.name, version: '9.9.9-test' }))
    const base = pathToFileURL(join(temp, 'lib', 'index.js'))
    expect(pluginVersion(base)).toBe('9.9.9-test')
  })

  it('读不到本包清单时明确回退(不静默编造版本)', () => {
    temp = mkdtempSync(join(tmpdir(), 'chatws-version-empty-'))
    mkdirSync(join(temp, 'lib'), { recursive: true })
    expect(pluginVersion(pathToFileURL(join(temp, 'lib', 'index.js')))).toBe('0.0.0-unknown')
  })

  it('源码/测试构建的 commit 回退为 dev(安装包构建时注入真实短哈希)', () => {
    expect(buildCommit()).toBe('dev')
  })
})
