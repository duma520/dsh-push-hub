/**
 * lib/config.js — 凭据与偏好加载。
 *
 * 来源优先级（高 → 低，**按通道 / 按账号名 / 按字段三级合并**）：
 *   1. 显式传入的 path（工具参数 config 覆盖上面全部）
 *   2. ~/.dsh/dsh-push-hub/config.json  本插件自有（设置页写的那份，用户最后一次明确意图）
 *   3. 本插件根目录 config.json          旧版覆盖配置，仅兼容读取
 *   4. 环境变量 PUSH_HUB_CONFIG 指向的文件
 *
 * v0.10.0 起不再读 dsh-bridge / dsh-im-connect（用户要求「取消连接，避免账号混乱」）。
 *
 * 为什么不再是「顶层键整体替换」：那样自有层只要写一次 telegram，
 * 就会把 dsh-bridge 里那个能用的 telegram 账号整个盖掉（连 botToken 一起丢）。
 * 现在改为账号名相同则字段级合并 —— 自有层填了 botToken 就用自有的，
 * 留空/没写的字段回落到下层，两边能各管一半。
 *
 * 取舍（沿用 Python 版）：凭据只有一份，本插件只读、不复制、不落盘、不打印。
 *
 * @module config
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件包根目录（本文件在 lib/ 下，上一级即包根）。 */
export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 旧版覆盖配置（包内）。仅作向后兼容读取，新配置不再写这里。 */
export const LOCAL_CONFIG = path.join(PKG_ROOT, 'config.json')

/**
 * 本插件自己的用户级配置（新）。
 *
 * 为什么不放包内：包目录是代码目录，写进去会污染仓库、也跟着版本备份一起被复制；
 * 更重要的是不能写 dsh-bridge 那份 —— 它的面板「保存」是整表重写，
 * 会把我们手填的 synology_chat 冲掉（见 docs/通道说明.md 的说明）。
 */
export const USER_CONFIG = path.join(os.homedir(), '.dsh', 'dsh-push-hub', 'config.json')

/**
 * 敏感值掩码占位符。
 *
 * 前端拿到的 webhook / token 永远是这个形状（形如 <已配置 e4f1>），
 * 提交时原样传回来就表示「不改」，后端据此保留旧值，
 * 这样既不会把凭据送进浏览器，也不会因为「没填」把它清空。
 */
export const MASK_PREFIX = '<已配置 '

/** 默认通道：原版三个（telegram / feishu / qq）。 */
export const DEFAULT_CHANNELS = ['telegram', 'feishu', 'qq']

/** 全部已知通道。 */
/**
 * 全部已知通道。
 *
 * 顺序即界面左侧列表的默认顺序：先放国内最常用的（微信/飞书/钉钉/企微/QQ），
 * 再放国际的（Telegram/Slack/Discord/Matrix），最后是群晖与邮件这两个小众的。
 * 注意：这里只决定「展示顺序」，配置里出现别的键也不会被丢弃（未知通道原样保留）。
 */
export const ALL_CHANNELS = [
  'wechat',
  'feishu',
  'dingtalk',
  'wecom',
  'wecom_app',
  'qq',
  'telegram',
  'slack',
  'discord',
  'matrix',
  'synology_chat',
  'email',
]

/** 通道名集合：合并配置时用来把「通道键」与普通键分开。 */
const CHANNEL_SET = new Set(ALL_CHANNELS)

// v0.10.0 起不再读 dsh-im-connect（用户要求取消连接，避免账号混乱）。
// im-connect 的平台名映射、credentialRef 规则、readImConnect() 一并删除。

/** 读一个 JSON 文件，失败返回 {}。 */
function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** 值是否「算填了」：空串 / null / undefined 都当没填，回落下层。 */
function filled(value) {
  return value !== undefined && value !== null && value !== ''
}

/**
 * 字段级合并一个账号：upper 里填了的字段覆盖 lower，留空的字段保留下层。
 *
 * 这条是「自有优先」能安全落地的关键：如果按账号整体替换，
 * 用户在设置页点一次保存（自有层只写了 name + 部分字段），
 * 就会把 bridge 里那个能用的账号连同 botToken 一起盖成残缺对象。
 */
function mergeAccount(lower, upper) {
  const out = { ...(lower ?? {}) }
  for (const [key, value] of Object.entries(upper ?? {})) {
    if (filled(value)) out[key] = value
  }
  return out
}

/** 账号集合按 name 对齐合并；上层新增的账号追加在后面。 */
function mergeAccounts(lowerList, upperList) {
  const lower = Array.isArray(lowerList) ? lowerList : []
  const upper = Array.isArray(upperList) ? upperList : []
  const out = lower.map((item) => ({ ...(item ?? {}) }))
  const indexOf = (list, name) => list.findIndex((item) => item && String(item.name ?? '') === name)
  for (const item of upper) {
    if (!item || typeof item !== 'object') continue
    const name = String(item.name ?? '')
    const at = name === '' ? -1 : indexOf(out, name)
    if (at >= 0) out[at] = mergeAccount(out[at], item)
    else out.push({ ...item })
  }
  return out
}

/**
 * 合并两层配置。
 *
 * 通道键（telegram / feishu / ...）走账号级 + 字段级合并；
 * 其余顶层键（auth、cloudflared、default_channels ...）整键覆盖。
 */
function mergeLayer(lower, upper) {
  const out = { ...(lower ?? {}) }
  for (const [key, value] of Object.entries(upper ?? {})) {
    if (CHANNEL_SET.has(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      const base = out[key]
      const merged = { ...(base && typeof base === 'object' ? base : {}), ...value }
      if (Object.hasOwn(value, 'accounts')) {
        merged.accounts = mergeAccounts(base?.accounts, value.accounts)
      }
      out[key] = merged
    } else {
      out[key] = value
    }
  }
  return out
}

/** 自有机器人账号在本插件配置里的键名（与任何第三方插件完全隔离）。 */
export const OWN_BOTS_KEY = 'own_bots'

/**
 * 把自有配置里的 `own_bots` 展开成标准的通道结构，作为最高优先级的账号层。
 *
 * 为什么不直接把自有账号写进 `telegram.accounts`：那样就分不清一个账号
 * 到底是用户在界面上填的、扫码创建的、还是从别处导入的，界面没法标注来源，
 * 也没法在「删掉自有账号」时干净地回落到下层的同名账号。
 *
 * @param {Record<string, any>} raw USER_CONFIG 原文
 * @returns {Record<string, any>} 形如 `{ telegram: { accounts: [...] } }`
 */
function ownBotsLayer(raw) {
  const own = raw?.[OWN_BOTS_KEY]
  if (!own || typeof own !== 'object' || Array.isArray(own)) return {}
  const out = {}
  for (const [channel, value] of Object.entries(own)) {
    if (!CHANNEL_SET.has(channel)) continue
    const accounts = Array.isArray(value) ? value : Array.isArray(value?.accounts) ? value.accounts : []
    const list = accounts.filter((item) => item && typeof item === 'object')
    if (list.length === 0) continue
    out[channel] = { accounts: list }
  }
  return out
}

/**
 * 解析全部配置层（低 → 高），每层带 label 供界面标注账号来源。
 * @param {string} [explicitPath]
 * @returns {{label: string, data: Record<string, any>}[]}
 */
function resolveLayers(explicitPath) {
  // v0.10.0：首层不再有 imconnect / bridge。凭据唯一来源就是下面这些层里
  // 用户自己填的账号（user / own）+ 环境变量与包内旧配置的兼容读取。
  const layers = []

  const envPath = process.env.PUSH_HUB_CONFIG
  if (envPath && String(envPath).trim() !== '') {
    layers.push({ label: 'env', data: readJson(expandHome(String(envPath).trim())) })
  }
  // 旧版包内配置：只为兼容已经手工填过的人，新写入一律走 USER_CONFIG。
  layers.push({ label: 'local', data: readJson(LOCAL_CONFIG) })

  const user = readJson(USER_CONFIG)
  layers.push({ label: 'user', data: user })
  // 自有机器人：同一个文件里的 own_bots，但优先级更高（它就是「自有」）。
  const own = ownBotsLayer(user)
  if (Object.keys(own).length > 0) layers.push({ label: 'own', data: own })

  if (explicitPath && String(explicitPath).trim() !== '') {
    layers.push({ label: 'explicit', data: readJson(expandHome(String(explicitPath).trim())) })
  }
  return layers
}

/** 依次叠加全部层。 */
function foldLayers(layers) {
  let cfg = {}
  for (const layer of layers) cfg = mergeLayer(cfg, layer.data)
  return cfg
}

/**
 * 把来源为 own 的账号提到同通道账号列表最前面。
 *
 * 为什么需要这一步：account(cfg, channel) 在不指定名字时取**第一个**账号，
 * 而 mergeAccounts 是把上层新账号追加在末尾。不重排的话，「自有账号优先」
 * 只是文案，实际发消息仍然走 bridge 的账号 —— 行为和承诺对不上。
 */
function promoteOwnAccounts(cfg, sources) {
  for (const [channel, origin] of Object.entries(sources ?? {})) {
    const accounts = Array.isArray(cfg?.[channel]?.accounts) ? cfg[channel].accounts : []
    if (accounts.length < 2) continue
    const isOwn = (item) => origin?.[String(item?.name ?? '')] === 'own'
    const own = accounts.filter(isOwn)
    if (own.length === 0) continue
    const rest = accounts.filter((item) => !isOwn(item))
    cfg[channel] = { ...cfg[channel], accounts: own.concat(rest) }
  }
  return cfg
}

/**
 * 按优先级合并出最终配置（低 → 高依次叠加）。
 *
 * 顺序即需求里的「机器人来源优先级」：
 *   dsh-im-connect  <  dsh-bridge  <  PUSH_HUB_CONFIG  <  包内 config.json
 *     <  自有配置(default_channels / synology_chat)  <  自有机器人(own_bots)  <  显式 path
 *
 * 说明：dsh-bridge 之上再放自有配置，是因为用户最后明确表达的意图
 * 一定发生在扫码之后（扫码写 bridge，之后才来设置页改）。
 * @param {string} [explicitPath] 调用方显式指定的覆盖文件
 * @returns {Record<string, any>}
 */
export function load(explicitPath) {
  return loadWithSources(explicitPath).cfg
}

/**
 * 同 load()，但额外返回每个账号来自哪一层，供设置界面标注来源。
 *
 * 规则：账号在某一层出现过，来源就记为该层（最高命中层胜出）。
 * 这样界面上「自有」的账号标 own、「扫码来的」标 bridge，一眼能看出
 * 这条通道到底是本插件自己配的还是从 dsh-bridge 借的。
 *
 * @param {string} [explicitPath]
 * @returns {{cfg: Record<string, any>, sources: Record<string, Record<string, string>>}}
 */
export function loadWithSources(explicitPath) {
  const layers = resolveLayers(explicitPath)
  const sources = {}
  for (const layer of layers) {
    for (const [channel, value] of Object.entries(layer.data ?? {})) {
      if (!CHANNEL_SET.has(channel)) continue
      const accounts = Array.isArray(value?.accounts) ? value.accounts : []
      for (const item of accounts) {
        if (!item || typeof item !== 'object') continue
        const name = String(item.name ?? '')
        if (name === '') continue
        if (!sources[channel]) sources[channel] = {}
        sources[channel][name] = layer.label
      }
    }
  }
  const cfg = promoteOwnAccounts(foldLayers(layers), sources)
  return { cfg, sources }
}

/** 展开 ~ 前缀。 */
export function expandHome(target) {
  const value = String(target ?? '')
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2))
  return value
}

/**
 * 取某个通道的账号。
 * @param {Record<string,any>} cfg
 * @param {string} channel
 * @param {string} [name] 指定账号名；不传则取第 index 个
 * @param {number} [index]
 * @returns {Record<string,any>|null}
 */
export function account(cfg, channel, name, index = 0) {
  const accounts = cfg?.[channel]?.accounts
  const list = Array.isArray(accounts) ? accounts : []
  if (name) {
    const found = list.find((item) => item && item.name === name)
    return found ?? null
  }
  return list.length > index ? list[index] : null
}

/** 列出某个通道的全部账号名（不返回值，只给名字）。 */
export function accountNames(cfg, channel) {
  const accounts = cfg?.[channel]?.accounts
  const list = Array.isArray(accounts) ? accounts : []
  return list.map((item, i) => (item && typeof item.name === 'string' && item.name.trim() !== '' ? item.name : '#' + (i + 1)))
}

/** 显式清空默认通道时写的判别位（见 docs/通道说明.md 的说明）。 */
export const DEFAULT_CHANNELS_EXPLICIT = 'default_channels_explicit'

/**
 * 默认通道列表。
 *
 * 「没配过」与「明确配成空」是两件事，必须区分：
 *  - 没配过（无 default_channels 或不是数组）→ 回落内置三通道；
 *  - 配过但清空了 → 用户在设置页取消了所有勾选，语义就是「一个都不默认」，
 *    此时必须返回 []。旧实现只看 length > 0，导致空数组被当成没配，
 *    用户怎么取消都取消不掉（缺陷记录见软件升级迭代记录.md）。
 *
 * 判别位 `default_channels_explicit`：只要它存在（无论 true/false），
 * 就说明自有层对 default_channels 表过态，按配置走；否则才回落内置值。
 */
export function defaultChannels(cfg) {
  const configured = cfg?.default_channels
  if (!Array.isArray(configured)) return [...DEFAULT_CHANNELS]
  if (configured.length > 0) return configured.map(String)
  const explicit = cfg?.[DEFAULT_CHANNELS_EXPLICIT]
  if (explicit === true) return []
  return [...DEFAULT_CHANNELS]
}

/**
 * 诊断用：把凭据替换成占位，只暴露「有没有配」。
 * 任何回给用户 / 写进日志的配置摘要都必须先过这一层。
 */
export function redact(cfg) {
  const sensitive = /token|secret|password|key|cookie|hash|salt/i
  const walk = (value, depth) => {
    if (depth > 6 || value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1))
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (sensitive.test(key) && item !== null && item !== undefined && item !== '') {
        out[key] = '<' + String(item).length + ' 字符，已隐藏>'
      } else {
        out[key] = walk(item, depth + 1)
      }
    }
    return out
  }
  return walk(cfg, 0)
}
// ── 用户级配置的读写（设置界面用）──────────────────────────────────────────

/** 已存在就返回原值的掩码（形如 <已配置 e4f1>）；空值返回 ''。 */
export function maskValue(value) {
  const text = value === null || value === undefined ? '' : String(value)
  if (text === '') return ''
  const tail = text.length <= 4 ? text : text.slice(-4)
  return MASK_PREFIX + tail + '>'
}

/** 判断一个值是不是我们发出去的掩码占位（是则表示「保持原值」）。 */
export function isMasked(value) {
  return typeof value === 'string' && value.startsWith(MASK_PREFIX)
}

/**
 * 通道级代理配置。
 *
 * 为什么不是「一个全局代理开关」：本机实测 Telegram 直连 api.telegram.org 必然超时，
 * 必须走代理；而微信 iLink / 飞书 / QQ 直连就能通 —— 全开代理反而让本来通的通道
 * 多绕一跳、多一个失败点。所以按通道各开各的。
 *
 * 配置形态（写在用户级 config.json 顶层）：
 *   "proxy": { "url": "http://192.0.2.10:20808", "channels": { "telegram": true } }
 *
 * 账号级仍可单独覆盖（账号对象里的 proxy 字段优先），沿用老行为。
 */
/**
 * 附件下载策略的配置键（v0.36.0）。三个子项：maxFileMB / retainDays / maxTotalMB。
 * 放顶层而不是账号层 —— 它是「本机硬盘怎么用」，不是「某个通道的偏好」。
 */
export const DOWNLOAD_KEY = 'download'

export const PROXY_KEY = 'proxy'

/** 默认代理地址（本机实测可用）与默认开代理的通道。 */
export const DEFAULT_PROXY = {
  url: 'http://192.0.2.10:20808',
  channels: {
    telegram: true,
    wechat: false, feishu: false, dingtalk: false, wecom: false, wecom_app: false,
    qq: false, slack: false, discord: false, matrix: false, synology_chat: false, email: false,
  },
}

/** 规整代理地址：去首尾空白与末尾斜杠；缺协议时补 http:// */
export function normalizeProxyUrl(value) {
  let text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return ''
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = 'http://' + text
  return text.replace(/\/+$/, '')
}

/**
 * 归一化代理配置：缺字段补默认，非法值丢弃。
 * @param {Record<string, any>} cfg 合并后的完整配置
 * @returns {{url: string, channels: Record<string, boolean>}}
 */
export function proxyPolicy(cfg) {
  const raw = cfg?.[PROXY_KEY]
  const url = normalizeProxyUrl(raw?.url) || DEFAULT_PROXY.url
  const channels = { ...DEFAULT_PROXY.channels }
  const given = raw?.channels
  if (given && typeof given === 'object') {
    for (const name of ALL_CHANNELS) {
      if (typeof given[name] === 'boolean') channels[name] = given[name]
    }
  }
  return { url, channels }
}

/**
 * 某个通道该用的代理地址；返回空串表示直连。
 * @param {Record<string, any>} cfg
 * @param {string} channel 已归一化的通道名
 */
/**
 * 通道显示偏好（v0.26.0）。
 *
 * 只影响「设置界面左侧列表显示哪些通道」，**不碰发送、不碰接收**：
 * 隐藏一个通道 ≠ 停用它。用户要求原话：「只隐藏界面，发送与接收完全不变」。
 * 所以这个键只被 lib/client.js 读，bus / receiver 一个字都不读。
 *
 * mode：
 *   'all'   —— 全部显示，再减去 hidden（默认）
 *   'bound' —— 只显示「有账号」的通道，再减去 hidden
 *
 * 两种模式叠加：先按 mode 决定基础集合，再统一减 hidden。
 * 这样「只看已绑定的」和「这条我暂时不想看到」两件事能同时用。
 */
export const VISIBILITY_KEY = 'channel_visibility'

/**
 * 把磁盘上的显示偏好归一成界面能直接用的形状。
 *
 * 归一而不是原样透传的理由：手改配置文件时很容易写出
 * {"mode":"Bound"} 或 hidden 里塞一个拼错的通道名，
 * 原样透传会让界面对着一个不存在的 key 空转。
 *
 * @param {Record<string, any>} cfg 合并后的完整配置
 * @returns {{mode: 'all'|'bound', hidden: string[]}}
 */
export function channelVisibility(cfg) {
  const raw = cfg?.[VISIBILITY_KEY]
  const mode = raw?.mode === 'bound' ? 'bound' : 'all'
  const hidden = Array.isArray(raw?.hidden)
    ? raw.hidden.map(String).filter((name) => ALL_CHANNELS.includes(name))
    : []
  return { mode, hidden: [...new Set(hidden)] }
}

export function proxyForChannel(cfg, channel) {
  const policy = proxyPolicy(cfg)
  return policy.channels?.[channel] === true ? policy.url : ''
}

/** 只读用户级配置原文（不存在返回 {}）。 */
export function readUserConfig() {
  return readJson(USER_CONFIG)
}

/**
 * 写用户级配置。原子写：先写 .tmp 再 rename，避免半个 JSON 留在盘上。
 * @param {Record<string, any>} data
 */
export function writeUserConfig(data) {
  const dir = path.dirname(USER_CONFIG)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = USER_CONFIG + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data ?? {}, null, 2), { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, USER_CONFIG)
}

/**
 * 凭据指纹：让用户认出「这是哪个机器人的 token」，但不泄漏完整密钥。
 *
 * 为什么需要它：旧版掩码只留末 4 位（`<已配置 e4f1>`），多个 token 摆在一起
 * 谁是谁完全分不出来 —— 用户明确反馈过「都不知道 token 是谁的」。
 *
 * 取舍：短值（< 12 位）仍只留末 4 位（长度本身就是信息，不能暴露太多）；
 * 长值给「前 6 … 后 4」，因为 Telegram token 的前几位正是 bot ID
 * （形如 `123456789:AAH...`），飞书 appSecret / 群晖 64 位 token 的前 6 位
 * 也足以区分不同账号。完整值只能通过 POST /reveal 现取。
 *
 * @param {string} value
 * @returns {string} 空串返回 ''，否则形如 `123456…e4f1`
 */
export function fingerprintSecret(value) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (text === '') return ''
  if (text.length < 12) return maskValue(text)
  return text.slice(0, 6) + '…' + text.slice(-4)
}

/**
 * 判断一个掩码 / 指纹字符串是不是「占位符」而不是真凭据。
 *
 * 前端把 `<已配置 xxxx>` 或 `123456…e4f1` 原样提交回来表示「不改」，
 * 后端据此保留旧值。`…` 是指纹的特征，`MASK_PREFIX` 是旧掩码的特征。
 *
 * @param {unknown} value
 */
export function isSecretPlaceholder(value) {
  if (typeof value !== 'string') return false
  return isMasked(value) || value.includes('…')
}

