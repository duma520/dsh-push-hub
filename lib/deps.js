/**
 * lib/deps.js — 第三方依赖的统一解析入口（v0.31.0 新增）。
 *
 * 为什么需要它：本插件原先「零依赖」，所有第三方包都从 DSH profile 借
 * （~/.dsh/profiles/desktop/node_modules）。这套做法在 2026-11-17 坏过一次：
 * dsh-im 5.10.0 把 @larksuiteoapi/node-sdk 从 dependencies 挪进了 devDependencies，
 * 随后一次 npm 操作把 profile 里那个包清成了空目录壳 —— 飞书扫码与飞书接收
 * 同时失效，而本插件一行代码都没改。
 *
 * 所以改成「两级查找」：
 *   1. 插件自己的 node_modules —— 有就用。版本由本插件的 package.json 钉死，
 *      宿主怎么折腾都动不了它。
 *   2. 回落 DSH profile —— 沿用老行为；没装就仍然是零依赖。
 *
 * 顺序不能反：必须先查插件自身。反过来的话，用户装了插件自带的版本也白装，
 * 仍会被 profile 里那个「碰巧还在、但版本不同」的包盖掉。
 *
 * 另一个必须保留的设计：查不到时不抛裸 ERR_MODULE_NOT_FOUND。本插件的界面要
 * 照常显示，只在用到该能力的按钮上给出中文原因 —— 这是从 v0.15.0 起就定下的
 * 约定，别改成抛异常。
 *
 * @module deps
 */

import os from 'node:os'
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 插件根目录：本文件在 <root>/lib/ 下，往上一级就是根。 */
export const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** 插件自带的依赖目录（npm install 装出来的那个）。 */
export const PLUGIN_NODE_MODULES = path.join(PLUGIN_ROOT, 'node_modules')

/** DSH desktop profile 的依赖目录 —— 老行为的回落位置，保留以兼容「没装插件依赖」的机器。 */
export const PROFILE_NODE_MODULES = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules')

/**
 * 依赖查找顺序：插件自身优先，然后环境变量指定的 profile，最后三个常见 profile。
 *
 * 每一项都是「可以放 node_modules 的目录」，不是 profile 根本身 —— 调用方直接
 * 拿它拼 path.join(dir, 'package.json') 当 createRequire 的锚点。
 *
 * @returns {string[]}
 */
export function depCandidates() {
  const list = []
  // ① 插件自身：装了就在这里，宿主怎么动都不影响
  list.push(PLUGIN_NODE_MODULES)
  // ② 环境变量指定的 profile（DSH_PROFILE_DIR 指向 profile 根，依赖在它下面的 node_modules）
  const fromEnv = process.env.DSH_PROFILE_DIR
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    list.push(path.join(fromEnv.trim(), 'node_modules'))
  }
  // ③ 三个常见 profile
  const profiles = path.join(os.homedir(), '.dsh', 'profiles')
  for (const name of ['desktop', 'web', 'cli']) list.push(path.join(profiles, name, 'node_modules'))
  // 去重：DSH_PROFILE_DIR 常常就指到 desktop，不去重会白跑一遍解析
  return [...new Set(list)]
}

/**
 * 用 createRequire 在候选目录里同步解析一个包。
 *
 * 注意这条路径会踩一个坑：`"type": "module"` 且 exports.require 指向 .js 的包
 * （例如 @tencent-connect/qqbot-connector）—— createRequire 命中 require 条件
 * 拿到 dist/cjs/index.js，Node 又按 type:module 把它当 ESM 解析，于是抛
 * `exports is not defined in ES module scope`。这种必须走下边的 loadDep 兜底。
 *
 * @param {string} specifier 包名
 * @returns {{ok: true, mod: any, from: string, via: string} | {ok: false}}
 */
export function tryRequire(specifier) {
  for (const dir of depCandidates()) {
    // 锚点是 dir 下的任意路径 —— createRequire 只用它的**所在目录**当解析基准，
    // 文件本身不必存在。这里不能拿 package.json 当锚点：候选目录是 node_modules
    // 本身，npm 不会在它根下写 package.json，existsSync 会全部落空。
    if (!existsSync(dir)) continue
    const anchor = path.join(dir, 'noop.js')
    try {
      const req = createRequire(anchor)
      return { ok: true, mod: req(specifier), from: dir, via: 'require' }
    } catch {
      // 这个目录里没有 / 或命中了上面那个 ESM 坑，试下一个
    }
  }
  return { ok: false }
}

/**
 * 定位一个包的 ESM 入口（exports["."].import → exports["."].default → module → main），
 * 返回 file:// href；找不到返回 null。
 *
 * 为什么不能直接 `import(specifier)`：动态 import 的解析基准是本文件所在目录，
 * 裸包名只会去 <插件根>/lib/node_modules 找，找不到就 MODULE_NOT_FOUND ——
 * 哪怕包里就在插件根的 node_modules 下。所以先 createRequire 的 resolve 找到
 * 包目录，再自己读该包 package.json 挑 ESM 入口，最后按绝对路径 import。
 *
 * @param {string} specifier
 * @returns {string|null}
 */
export function resolveEsmEntry(specifier) {
  for (const dir of depCandidates()) {
    // 同 tryRequire：锚点只用来定解析基准目录，别拿 package.json 当存在性判据。
    if (!existsSync(dir)) continue
    const anchor = path.join(dir, 'noop.js')
    try {
      const req = createRequire(anchor)
      // 纯 ESM 包（package.json 的 exports 只有 import、没有 default/require）
      // 在这里会抛 ERR_PACKAGE_PATH_NOT_EXPORTED —— 例如
      // @tencent-connect/qqbot-nodejs@1.0.4。这种包不可能被 require 到，
      // 但也确实装着，所以退回「按目录直查」：自己拼 node_modules/<包名>。
      let entry
      try {
        entry = req.resolve(specifier)
      } catch (resolveError) {
        const direct = path.join(dir, specifier)
        if (!existsSync(path.join(direct, 'package.json'))) throw resolveError
        entry = path.join(direct, 'package.json')
      }
      let pkgDir = path.dirname(entry)
      let manifest = null
      // 往上找最多 6 层，直到找到 name 与包名一致的 package.json
      for (let i = 0; i < 6; i += 1) {
        const candidate = path.join(pkgDir, 'package.json')
        if (existsSync(candidate)) {
          try {
            const parsed = JSON.parse(readFileSync(candidate, 'utf8'))
            if (parsed?.name === specifier) {
              manifest = parsed
              break
            }
          } catch {
            // package.json 坏了就当没找到，继续往上
          }
        }
        const up = path.dirname(pkgDir)
        if (up === pkgDir) break
        pkgDir = up
      }
      if (manifest === null) continue
      const exported = manifest?.exports?.['.']
      const rel = typeof exported === 'string'
        ? exported
        : (exported?.import ?? exported?.default ?? manifest?.module ?? manifest?.main)
      if (typeof rel !== 'string' || rel === '') continue
      return pathToFileURL(path.join(pkgDir, rel)).href
    } catch {
      // 这个目录解析不出来，试下一个
    }
  }
  return null
}

/**
 * 解析一个依赖：先同步 require，失败再按 ESM 入口 import。
 *
 * 返回值形态与 v0.30.0 的 qr.js 内部实现保持一致，方便各模块直接接。
 *
 * @param {string} specifier 包名
 * @returns {Promise<{ok: true, mod: any, from: string, via: string} | {ok: false, error: string}>}
 */
export async function loadDep(specifier) {
  const direct = tryRequire(specifier)
  if (direct.ok) return direct
  const href = resolveEsmEntry(specifier)
  if (href !== null) {
    try {
      const mod = await import(href)
      return { ok: true, mod, from: href, via: 'import' }
    } catch (error) {
      return { ok: false, error: '加载依赖 ' + specifier + ' 失败：' + String(error?.message ?? error) }
    }
  }
  return { ok: false, error: missingText(specifier) }
}

/**
 * 同步取一个依赖；取不到**抛异常**（供已有的 try/catch 结构直接换过来）。
 *
 * 与 loadDep 的分工：loadDep 给「要渲染成界面提示」的场景（扫码、发送），
 * requireDep 给「外面已经有一层 try/catch、失败只记原因」的场景（接收 worker）。
 *
 * @param {string} specifier
 * @returns {any}
 */
export function requireDep(specifier) {
  const direct = tryRequire(specifier)
  if (direct.ok) return direct.mod
  const href = resolveEsmEntry(specifier)
  if (href !== null) {
    // createRequire 都解析不到、但 ESM 入口能定位时，这里没法同步 import。
    // 如实抛一个说明清楚的错误，让调用方记下原因 —— 别返回 undefined 假装成功。
    throw new Error(missingText(specifier) + '（该包只有 ESM 入口，请改用 loadDep 异步加载）')
  }
  throw new Error(missingText(specifier))
}

/**
 * 「找不到依赖」的中文说明。把**查过哪两个地方**写出来，用户才知道该怎么修。
 *
 * 不写绝对路径列表：那是噪音，而且会把用户名带进界面与日志。只写两个层级，
 * 真要排查再去看 depCandidates()。
 *
 * @param {string} specifier
 * @returns {string}
 */
export function missingText(specifier) {
  return '找不到依赖 ' + specifier + '：插件自身的 node_modules 与 DSH profile 里都没有。'
    + '修复办法：在插件目录执行 npm install（本插件的 package.json 已声明该依赖）；'
    + '或在 DSH profile 里装一份。'
}

/**
 * 给能力探测用：这个依赖现在能不能解析到，以及从哪来的。
 *
 * @param {string} specifier
 * @returns {Promise<{available: boolean, from: string, detail: string}>}
 */
export async function probeDep(specifier) {
  const loaded = await loadDep(specifier)
  if (loaded.ok) return { available: true, from: String(loaded.from), detail: '' }
  return { available: false, from: '', detail: loaded.error }
}
