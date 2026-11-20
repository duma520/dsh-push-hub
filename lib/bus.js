/**
 * lib/bus.js — 通道注册表 + 群发调度。
 *
 * 这一层负责三件事：
 *   1. 把 lib/channels/*.js 汇总成注册表（新增通道只需要在这里挂一行）；
 *   2. 按配置找出每个通道该用哪个账号（支持一个通道多账号，按名字挑）；
 *   3. 群发，并按「硬通道 / 尽力而为通道」规则判定整体成功。
 *
 * 整体成功语义（与 Python 版 pushhub/api.py 一致）：
 *   - 硬通道（telegram / feishu / qq / synology_chat）任意一个成功 → 整体成功；
 *   - 只有尽力而为通道（wechat）被选中时，看它的实际结果；
 *   - 全部失败 → 整体失败。
 *   这么定是因为微信通道目前服务端恒返 ret=-2（见 channels/wechat.js 顶部说明），
 *   它是「附赠通知」，不该把它拖垮整条推送链。
 *
 * @module bus
 */

import * as telegram from './channels/telegram.js'
import * as feishu from './channels/feishu.js'
import * as qq from './channels/qq.js'
import * as wechat from './channels/wechat.js'
import * as synology from './channels/synology.js'
import * as dingtalk from './channels/dingtalk.js'
import * as wecom from './channels/wecom.js'
import * as wecomApp from './channels/wecom_app.js'
import * as slack from './channels/slack.js'
import * as discord from './channels/discord.js'
import * as matrix from './channels/matrix.js'
import * as email from './channels/email.js'
import { account, defaultChannels, ALL_CHANNELS, proxyForChannel } from './config.js'
import { readForSend } from './files.js'
import { targetsOf } from './mentions.js'
import { BUTTON_CHANNELS, NO_BUTTON_REASON } from './buttons.js'
import { REPLY_CHANNELS, NO_REPLY_REASON } from './reply.js'
import { EDIT_CHANNELS, DELETE_CHANNELS, editBlocker, deleteBlocker } from './edits.js'
import { REACTION_CHANNELS, reactionBlocker, normalizeEmoji, slackNameOf } from './reactions.js'
import { STREAM_CHANNELS, NO_STREAM_REASON, streamBlocker, createStream, createStreamHub, normalizeInterval } from './stream.js'
import { splitBlocks, sleep } from './text.js'
import { PROGRESS_CHANNELS, NO_PROGRESS_REASON, canProgress, progressBlocker, normalizeEmojiSet, createProgress, PROGRESS_TTL_MS, MAX_ACTIVE_PROGRESS, expiredIds } from './progress.js'
import { readProgressStore, writeProgressStore, upsertRecord, removeRecord, PROGRESS_PATH } from './progressstore.js'
// v0.35.0：每分钟配额。放在 bus 这一层是因为四条发送路径（send / sendOne /
// 流式开流 / 流式补发）全部经过 sendToTargets，闸门只该有一处。
import { canLimit, normalizePerMinute, countBlocks, createLimiter, NO_LIMIT_REASON, DEFAULT_PER_MINUTE, MIN_PER_MINUTE, MAX_PER_MINUTE, WINDOW_MS, MAX_WAIT_MS } from './ratelimit.js'

/** 注册表：通道名 → 通道实现。顺序即默认展示顺序。 */
export const REGISTRY = new Map([
  [telegram.NAME, telegram],
  [feishu.NAME, feishu],
  [qq.NAME, qq],
  [wechat.NAME, wechat],
  [synology.NAME, synology],
  [dingtalk.NAME, dingtalk],
  [wecom.NAME, wecom],
  [wecomApp.NAME, wecomApp],
  [slack.NAME, slack],
  [discord.NAME, discord],
  [matrix.NAME, matrix],
  [email.NAME, email],
])

/**
 * 尽力而为通道：失败不拖垮整体。
 *
 * v0.13.0 起把「只做发送、没有只读探测」的那几个也算进来（钉钉 / 企业微信群机器人 /
 * 企业微信自建应用 / 邮件）：它们的失败往往是凭据没配好或收件人不对，不该把
 * 「同时发到 Telegram 群」那条成功的路也判成整体失败。Slack / Discord / Matrix
 * 有稳定的只读探测（auth.test / users/@me / whoami），仍按硬通道算。
 */
export const BEST_EFFORT = new Set([wechat.NAME, dingtalk.NAME, wecom.NAME, wecomApp.NAME, email.NAME])

/**
 * 给通道实现准备一份「带代理」的账号副本。
 *
 * 为什么必须复制而不是就地改：config.account() 返回的是 cfg 里的共享对象引用，
 * 就地写 proxy 会把「这个通道该走代理」污染成「这个账号永久走代理」，写回配置后
 * 用户关掉开关也不生效。账号自己填了 proxy 就尊重账号的，没填才用通道级策略。
 *
 * @param {Record<string,any>} cfg
 * @param {string} channel 已归一化的通道名
 * @param {Record<string,any>} acc
 */
export function withChannelProxy(cfg, channel, acc) {
  if (acc === null || acc === undefined || typeof acc !== 'object') return acc
  const own = typeof acc.proxy === 'string' ? acc.proxy.trim() : ''
  if (own !== '') return acc
  const proxy = proxyForChannel(cfg, channel)
  if (proxy === '') return acc
  return { ...acc, proxy }
}


/**
 * v0.35.0：给探针用的钩子 —— 直接调配额闸门，不经过真实通道。
 *
 * 为什么需要它：gatedSend 是模块私有函数，正常只能通过 send / sendOne
 * 走完整链路才碰得到，而那条路会真的往平台上发消息。探针要验的恰恰是
 * 「闸门在什么情况下拦住、拦几条、等多久」，不该拿真账号去换这个答案。
 * 命名用双下划线，与 __resetProgressCache / receiver.js 的 __test 同一套约定：
 * 见到双下划线就知道「这是给测试用的，业务代码别调」。
 */
export const __testGated = gatedSend
/**
 * 一个账号配了多个投递目标时，逐个扇出。
 *
 * 为什么放在 bus 而不是通道里：12 个通道实现全部按「一次发一个会话」写，
 * 让每个通道自己循环会把「失败怎么汇总」重复 12 遍，且以后加通道还得再写一遍。
 * 这里把 acc.target 依次换成每个目标、复用同一个 send()，通道零改动。
 *
 * 成功判据：**全部目标都成功才算 ok**（有一个没发出去就如实报失败，
 * 但 detail 会列出每个目标各自的结果，不掩盖「部分成功」）。
 *
 * @param {{send: Function}} mod 通道实现
 * @param {string} body 正文
 * @param {Record<string,any>} acc 已带代理的账号
 * @param {{delayMs?: number}} options
 */
/**
 * v0.35.0：每分钟配额的桶。
 *
 * 键是「通道|账号|目标」三元组 —— 不能只按通道算：同一个 Telegram 机器人
 * 往两个群发，两个群各有各的每分钟配额；按通道合成一个桶会把 A 群的用量
 * 算到 B 群头上，看起来没超实际上超了。
 *
 * 桶里的限流器是易失的（进程重启即清空），理由写在 lib/ratelimit.js 头注释里。
 */
const LIMITERS = new Map()

/** 拿这个桶的限流器；配额变了就换一个新的（旧窗口作废，别让改配置后还按老账算）。 */
function limiterFor(key, perMinute) {
  const hit = LIMITERS.get(key)
  if (hit !== undefined && hit.perMinute === perMinute) return hit
  const limiter = createLimiter({ perMinute })
  LIMITERS.set(key, { perMinute, limiter })
  return LIMITERS.get(key)
}

/**
 * 真正调用通道之前过一道配额闸门。
 *
 * 为什么放在这里而不是四个调用方各写一遍：send / sendOne / 流式开流 /
 * 流式补发最后都落到 sendToTargets，闸门只该有一处，多写三处必然漏一处。
 *
 * 失败语义（见 lib/ratelimit.js 纪律①）：要么全等完再发，要么一块都不发。
 * 这里返回 ok:false 时一个字节都还没发出去，调用方照常按失败汇总即可。
 *
 * @param {{send: Function, NAME: string, MAX_CHARS: number}} mod
 * @param {string} body
 * @param {Record<string,any>} acc 已经钉好 target 的账号副本
 * @param {Record<string,any>} options 原样透传给通道
 */
async function gatedSend(mod, body, acc, options) {
  const channel = String(mod?.NAME ?? '')
  // 通道级不支持（目前只有邮件）或账号明确填 0：直接发，不做任何等待。
  if (!canLimit(channel)) return mod.send(body, acc, options)
  const norm = normalizePerMinute(acc?.perMinute)
  if (norm.perMinute <= 0) return mod.send(body, acc, options)

  const limit = Number(acc?.maxMessageChars) > 0 ? Number(acc.maxMessageChars) : mod.MAX_CHARS
  const blocks = countBlocks(body, limit)
  const bucketKey = channel + '|' + String(acc?.name ?? '') + '|' + String(acc?.target?.id ?? '')
  const bucket = limiterFor(bucketKey, norm.perMinute)
  const slot = bucket.limiter.take(blocks)
  if (slot.ok !== true) {
    return { ok: false, detail: slot.detail }
  }
  if (slot.waitMs > 0) await sleep(slot.waitMs)
  const outcome = await mod.send(body, acc, options)
  // 等过就如实说等了多久 —— 不然用户只看到「变慢了」，不知道是谁在等。
  if (slot.waitMs > 0 && outcome?.ok === true) {
    return {
      ...outcome,
      detail: String(outcome?.detail ?? '') + '；' + slot.detail,
    }
  }
  return outcome
}
async function sendToTargets(mod, body, acc, options = {}) {
  // v0.17.0：账号级「块间延迟」优先于调用方传的 delayMs。
  // 用户给某个账号单独调过延迟，就是想让它慢一点（避免被平台限流），
  // 不能被上层一个全局 delayMs 盖掉。
  const ownDelay = Number(acc?.chunkDelayMs)
  const effective = Number.isFinite(ownDelay) && ownDelay >= 0
    ? { ...options, delayMs: ownDelay }
    : options
  const targets = targetsOf(acc)
  if (targets.length === 0) {
    // 一个目标都没有：交给通道自己去报「还没填发送到」，这里不替它编造。
    // v0.35.0：仍然过配额闸门 —— 没有目标时通道会自己报错，不该白占配额，
    // 但它一样可能因为 acc.chatId 之类的方式真的发出去，所以闸门不能跳。
    const outcome = await gatedSend(mod, body, acc, effective)
    return {
      ok: outcome?.ok === true,
      detail: String(outcome?.detail ?? ''),
      deliveries: [],
      // v0.28.0：把通道收回来的消息 id 原样往上带。没实现 / 平台不给 id 的通道
      // 这里就是空数组，调用方据此知道「这条发出去了但以后动不了」。
      messageIds: Array.isArray(outcome?.messageIds) ? outcome.messageIds.map(String) : [],
      // 零目标时连位置都没有（通道自己会报「还没填发送到」），所以 places 为空。
      places: [],
    }
  }
  if (targets.length === 1) {
    // 单目标也把 target 显式钉上：手改配置只写了 targets 没写 target 时，
    // 通道里的 targetOf(acc) 会去回落 allowFrom 而发错人。
    const outcome = await gatedSend(mod, body, { ...acc, target: targets[0] }, effective)
    const oneIds = Array.isArray(outcome?.messageIds) ? outcome.messageIds.map(String) : []
    return {
      ok: outcome?.ok === true,
      detail: String(outcome?.detail ?? ''),
      deliveries: [],
      messageIds: oneIds,
      // v0.29.0：单目标也要给 places —— 改 / 撤的调用方统一按 places 取位置，
      // 单目标不填的话它就得自己判断「是单目标还是多目标」，那是调用方的负担。
      places: oneIds.length === 0 ? [] : [{ id: targets[0].id, messageIds: oneIds }],
    }
  }
  const deliveries = []
  for (const t of targets) {
    let outcome
    try {
      outcome = await gatedSend(mod, body, { ...acc, target: t }, effective)
    } catch (err) {
      outcome = { ok: false, detail: '异常 ' + (err?.name ?? 'Error') + ': ' + (err?.message ?? String(err)) }
    }
    deliveries.push({
      kind: t.kind,
      id: t.id,
      ok: outcome?.ok === true,
      detail: String(outcome?.detail ?? ''),
      // v0.28.0：多目标时每个目标各有一条消息（或多条分块），id 必须挂在
      // 各自的目标下面 —— 摊平成一个数组就分不清哪个 id 属于哪个聊天了。
      messageIds: Array.isArray(outcome?.messageIds) ? outcome.messageIds.map(String) : [],
    })
  }
  const failed = deliveries.filter((d) => d.ok !== true)
  const ok = failed.length === 0
  const detail = ok
    ? '已发送 ' + deliveries.length + ' 个目标（' + deliveries.map((d) => d.id).join('、') + '）'
    : '' + deliveries.length + ' 个目标里 ' + failed.length + ' 个失败：' + failed.map((d) => d.id + ' → ' + d.detail).join('；')
  // v0.28.0：顶层再摊平一份，方便「只想看看有没有 id」的调用方不用自己遍历。
  // v0.29.0：places 保留「哪条 id 属于哪个目标」—— 改 / 撤必须按聊天定位，
  // 摊平的 allIds 只够回答「一共发出去几条」，回答不了「这条在哪个聊天里」。
  const allIds = []
  const places = []
  for (const d of deliveries) {
    for (const id of d.messageIds) allIds.push(id)
    if (d.messageIds.length > 0) places.push({ id: d.id, messageIds: d.messageIds })
  }
  return { ok, detail, deliveries, messageIds: allIds, places }
}

/** 通道清单（给工具 / API 展示用）。 */
export function listChannels() {
  return [...REGISTRY.values()].map((mod) => ({
    name: mod.NAME,
    title: mod.TITLE,
    maxChars: mod.MAX_CHARS,
    bestEffort: BEST_EFFORT.has(mod.NAME),
  }))
}

/**
 * v0.35.0：把限流器的现状摊开给人看。
 *
 * 为什么要有这个只读入口：每分钟配额是一个「悄悄生效」的东西 —— 消息只是变慢了，
 * 界面上没有任何提示。没有这块面板，用户只会觉得「今天怎么发得这么慢」，
 * 然后把 chunkDelayMs 调来调去（那是管块间隔的，调它没用）。
 *
 * 桶是易失的，重启后这里会是空数组 —— 那是正确状态，不是 bug。
 */
export function listLimits() {
  const buckets = []
  for (const [key, one] of LIMITERS.entries()) {
    const stats = one.limiter.stats
    buckets.push({ key, perMinute: stats.perMinute, used: stats.used, waits: stats.waits, blocked: stats.blocked })
  }
  return {
    ok: true,
    detail: '',
    defaults: { perMinute: DEFAULT_PER_MINUTE, min: MIN_PER_MINUTE, max: MAX_PER_MINUTE, windowMs: WINDOW_MS, maxWaitMs: MAX_WAIT_MS },
    reasons: NO_LIMIT_REASON,
    channels: ALL_CHANNELS.filter((name) => canLimit(name)),
    buckets,
    size: buckets.length,
  }
}
/** 未知通道 / 拼错的通道名归一化。 */
export function normalizeChannel(name) {
  const key = String(name ?? '').trim().toLowerCase().replace(/-/g, '_')
  if (key === '') return ''
  if (REGISTRY.has(key)) return key
  // 常见别名
  const alias = {
    tg: telegram.NAME,
    lark: feishu.NAME,
    feishu_lark: feishu.NAME,
    qqbot: qq.NAME,
    wx: wechat.NAME,
    weixin: wechat.NAME,
    synology: synology.NAME,
    'synology.chat': synology.NAME,
    syonology_chat: synology.NAME,
    chat: synology.NAME,
  }
  return alias[key] ?? ''
}

/**
 * 解析要发给哪些通道。
 * @param {string[]|undefined} wanted 显式指定；空则用配置默认
 * @param {Record<string,any>} cfg
 * @returns {string[]}
 */
export function resolveChannels(wanted, cfg) {
  // v0.18.0 修：以前只认数组，传进来的逗号字符串（界面和工具参数都是这种形式）
  // 会被静默当成「没指定」而回落到 default_channels —— 用户以为只发了飞书，
  // 实际把消息群发到了所有默认通道。这里先归一成数组再判断。
  const list = typeof wanted === 'string'
    ? wanted.split(/[,，\s]+/).map((item) => item.trim()).filter((item) => item !== '')
    : wanted
  const raw = Array.isArray(list) && list.length > 0 ? list : defaultChannels(cfg)
  const out = []
  for (const item of raw) {
    const name = normalizeChannel(item)
    if (name !== '' && !out.includes(name)) out.push(name)
  }
  return out
}

/** 能发文件的通道（有 sendFile 的才算，不是「我猜它能」）。 */
export const FILE_CHANNELS = Object.freeze(
  [...REGISTRY.entries()].filter(([, mod]) => typeof mod.sendFile === 'function').map(([name]) => name),
)

/**
 * 一个账号配了多个投递目标时，把同一个文件逐个发出去。
 *
 * 与 sendToTargets 的差别：这里**每个目标都要重新读一遍文件吗？不用** ——
 * 字节已经在内存里，但每次 mod.sendFile 都拿同一份 Buffer，所以通道实现
 * 里绝不能就地改 bytes（写文件头之类的）。这条约定写在这里，免得以后有人
 * 图省事在通道里 patch buffer，变成「第二个目标收到的文件是坏的」。
 *
 * @param {{sendFile: Function}} mod
 * @param {{fileName: string, bytes: Buffer, mediaType: string}} file
 * @param {Record<string,any>} acc
 * @param {{caption?: string}} options
 */
async function sendFileToTargets(mod, file, acc, options = {}) {
  const targets = targetsOf(acc)
  if (targets.length === 0) {
    const outcome = await mod.sendFile(file, acc, options)
    return { ok: outcome?.ok === true, detail: String(outcome?.detail ?? ''), deliveries: [] }
  }
  if (targets.length === 1) {
    const outcome = await mod.sendFile(file, { ...acc, target: targets[0] }, options)
    return { ok: outcome?.ok === true, detail: String(outcome?.detail ?? ''), deliveries: [] }
  }
  const deliveries = []
  for (const t of targets) {
    let outcome
    try {
      outcome = await mod.sendFile(file, { ...acc, target: t }, options)
    } catch (err) {
      outcome = { ok: false, detail: '异常 ' + (err?.name ?? 'Error') + ': ' + (err?.message ?? String(err)) }
    }
    deliveries.push({
      kind: t.kind,
      id: t.id,
      ok: outcome?.ok === true,
      detail: String(outcome?.detail ?? ''),
      // v0.28.0：多目标时每个目标各有一条消息（或多条分块），id 必须挂在
      // 各自的目标下面 —— 摊平成一个数组就分不清哪个 id 属于哪个聊天了。
      messageIds: Array.isArray(outcome?.messageIds) ? outcome.messageIds.map(String) : [],
    })
  }
  const failed = deliveries.filter((d) => d.ok !== true)
  const ok = failed.length === 0
  const detail = ok
    ? '已发送 ' + deliveries.length + ' 个目标（' + deliveries.map((d) => d.id).join('、') + '）'
    : '' + deliveries.length + ' 个目标里 ' + failed.length + ' 个失败：' + failed.map((d) => d.id + ' → ' + d.detail).join('；')
  return { ok, detail, deliveries }
}

/**
 * 发一个本地文件到若干通道。
 *
 * 文件只读一次（不是每个通道读一遍盘）：同一份字节交给所有通道，省 IO，
 * 也保证「发给三个通道」拿到的是完全相同的文件。
 *
 * @param {Record<string,any>} cfg
 * @param {{filePath: string, caption?: string, channels?: string[], accounts?: Record<string,string|number>}} input
 */
export async function sendFile(cfg, input = {}) {
  const loaded = readForSend(input?.filePath)
  if (loaded.ok !== true) return { ok: false, results: {}, error: loaded.detail }

  const channels = resolveChannels(input?.channels, cfg)
  const results = {}
  let hardOk = false
  let softOk = false
  let hardTried = false
  let anyFileChannel = false

  for (const name of channels) {
    const mod = REGISTRY.get(name)
    const bestEffort = BEST_EFFORT.has(name)
    if (mod === undefined) {
      results[name] = { ok: false, detail: '未知通道', account: null, title: name, bestEffort }
      continue
    }
    if (typeof mod.sendFile !== 'function') {
      results[name] = {
        ok: false,
        detail: '「' + mod.TITLE + '」这个通道还不支持发文件（只有文字）。能发文件的是：' + FILE_CHANNELS.join(' / '),
        account: null,
        title: mod.TITLE,
        bestEffort,
      }
      if (!bestEffort) hardTried = true
      continue
    }
    anyFileChannel = true

    const picked = input?.accounts?.[name]
    const acc = account(cfg, name, picked)
    if (acc === null || acc === undefined) {
      results[name] = {
        ok: false,
        detail: picked === undefined ? '未配置该通道账号' : '未配置名为 ' + String(picked) + ' 的账号',
        account: picked === undefined ? null : String(picked),
        title: mod.TITLE,
        bestEffort,
      }
      if (!bestEffort) hardTried = true
      continue
    }

    if (!bestEffort) hardTried = true
    let outcome
    try {
      outcome = await sendFileToTargets(mod, loaded.file, withChannelProxy(cfg, name, acc), { caption: input?.caption })
    } catch (err) {
      outcome = { ok: false, detail: '异常 ' + (err?.name ?? 'Error') + ': ' + (err?.message ?? String(err)) }
    }
    results[name] = {
      ok: outcome?.ok === true,
      detail: String(outcome?.detail ?? ''),
      account: acc?.name ? String(acc.name) : null,
      title: mod.TITLE,
      bestEffort,
      deliveries: Array.isArray(outcome?.deliveries) ? outcome.deliveries : [],
    }
    if (outcome?.ok === true) {
      if (bestEffort) softOk = true
      else hardOk = true
    }
  }

  if (!anyFileChannel) {
    return { ok: false, results, error: '选中的通道都不支持发文件。能发文件的是：' + FILE_CHANNELS.join(' / ') }
  }
  const ok = hardOk || (!hardTried && softOk)
  return { ok, results, file: { name: loaded.file.fileName, size: loaded.file.size, mediaType: loaded.file.mediaType } }
}

/**
 * 只发一个指定账号（「每个账号一个发文件按钮」的实现基础）。
 *
 * @param {Record<string,any>} cfg
 * @param {{channel: string, account?: string|number, filePath: string, caption?: string}} input
 */
export async function sendFileOne(cfg, input = {}) {
  const name = normalizeChannel(input?.channel)
  if (name === '') {
    return { ok: false, detail: '未知通道 ' + String(input?.channel ?? ''), channel: String(input?.channel ?? ''), account: null, title: '' }
  }
  const mod = REGISTRY.get(name)
  if (typeof mod.sendFile !== 'function') {
    return { ok: false, detail: '「' + mod.TITLE + '」不支持发文件。能发文件的是：' + FILE_CHANNELS.join(' / '), channel: name, account: null, title: mod.TITLE }
  }
  const loaded = readForSend(input?.filePath)
  if (loaded.ok !== true) {
    return { ok: false, detail: loaded.detail, channel: name, account: null, title: mod.TITLE }
  }
  const wanted = input?.account
  const acc = account(cfg, name, wanted)
  if (acc === null || acc === undefined) {
    const label = wanted === undefined || wanted === null || String(wanted) === ''
      ? '该通道没有任何账号'
      : '没有名为 ' + String(wanted) + ' 的账号'
    return { ok: false, detail: label, channel: name, account: null, title: mod.TITLE }
  }
  const accountName = acc?.name ? String(acc.name) : null
  let outcome
  try {
    outcome = await sendFileToTargets(mod, loaded.file, withChannelProxy(cfg, name, acc), { caption: input?.caption })
  } catch (err) {
    outcome = { ok: false, detail: '异常 ' + (err?.name ?? 'Error') + ': ' + (err?.message ?? String(err)) }
  }
  return {
    ok: outcome?.ok === true,
    detail: String(outcome?.detail ?? ''),
    channel: name,
    account: accountName,
    title: mod.TITLE,
    deliveries: Array.isArray(outcome?.deliveries) ? outcome.deliveries : [],
    file: { name: loaded.file.fileName, size: loaded.file.size, mediaType: loaded.file.mediaType },
  }
}

/**
 * 群发。
 *
 * @param {Record<string,any>} cfg 完整配置（config.load 的返回值）
 * @param {string} text 正文
 * @param {{channels?: string[], accounts?: Record<string, string|number>, delayMs?: number, progress?: boolean, emojis?: Record<string, unknown>}} [options]
 * @returns {Promise<{ok: boolean, results: Record<string, {ok: boolean, detail: string, account: string|null, title: string, bestEffort: boolean}>}>}
 */
export async function send(cfg, text, options = {}) {
  const body = String(text ?? '')
  if (body.trim() === '') {
    return { ok: false, results: {}, error: '正文为空，没东西可发' }
  }

  const channels = resolveChannels(options.channels, cfg)
  /** @type {Record<string, any>} */
  const results = {}
  let hardOk = false
  let softOk = false
  let hardTried = false

  for (const name of channels) {
    const mod = REGISTRY.get(name)
    const bestEffort = BEST_EFFORT.has(name)
    if (mod === undefined) {
      results[name] = { ok: false, detail: '未知通道', account: null, title: name, bestEffort }
      continue
    }

    const picked = options.accounts?.[name]
    const acc = account(cfg, name, picked)
    if (acc === null || acc === undefined) {
      results[name] = {
        ok: false,
        detail: picked === undefined ? '未配置该通道账号' : '未配置名为 ' + String(picked) + ' 的账号',
        account: picked === undefined ? null : String(picked),
        title: mod.TITLE,
        bestEffort,
      }
      if (!bestEffort) { hardTried = true }
      continue
    }

    if (!bestEffort) hardTried = true
    // v0.20.0：按钮是「通道能力」，不是「消息属性」。不支持按钮的通道照常把
    // 文字发出去，只在 detail 里点名 —— 不能因为一条消息带了按钮就整批失败，
    // 那会让「群发到 12 个通道」变成「只要有一个不支持就发不出去」。
    let outcome
    try {
      outcome = await sendToTargets(mod, body, withChannelProxy(cfg, name, acc), {
        delayMs: options.delayMs,
        buttons: options.buttons,
        replyTo: options.replyTo,
      })
      // v0.25.0：回复同理 —— 「回复」是通道能力，不是消息属性。不支持引用的通道
      // 照常把文字发出去，只在 detail 里说清「这句话没挂引用」。
      if (options.replyTo !== undefined && options.replyTo !== null && String(options.replyTo).trim() !== '' && !REPLY_CHANNELS.includes(name) && outcome?.ok === true) {
        outcome = {
          ok: true,
          detail: String(outcome.detail ?? '') + '；该通道不支持引用回复，这句是当新消息发的' + (NO_REPLY_REASON[name] ? '（' + NO_REPLY_REASON[name] + '）' : ''),
          deliveries: outcome?.deliveries,
          messageIds: outcome?.messageIds,
          // v0.29.0：降级包装不能把 places 丢掉 —— 丢了之后这条消息明明发出去了，
          // 界面上却「查不到位置、改不了也撤不了」。
          places: outcome?.places,
        }
      }
      if (options.buttons !== undefined && options.buttons !== null && !BUTTON_CHANNELS.includes(name) && outcome?.ok === true) {
        outcome = {
          ok: true,
          detail: String(outcome.detail ?? '') + '；该通道不支持按钮，按钮已丢弃' + (NO_BUTTON_REASON[name] ? '（' + NO_BUTTON_REASON[name] + '）' : ''),
          deliveries: outcome?.deliveries,
          messageIds: outcome?.messageIds,
          places: outcome?.places,
        }
      }
    } catch (err) {
      // 通道实现按约定不该抛，但 CPU/JSON 之类的意外也要兜住，别让一条通道炸掉整批
      outcome = { ok: false, detail: '异常 ' + (err?.name ?? 'Error') + ': ' + (err?.message ?? String(err)) }
    }
    /** @type {Record<string, any>} */
    const base = {
      ok: outcome?.ok === true,
      detail: String(outcome?.detail ?? ''),
      account: acc?.name ? String(acc.name) : null,
      title: mod.TITLE,
      bestEffort,
      deliveries: Array.isArray(outcome?.deliveries) ? outcome.deliveries : [],
      // v0.28.0：让上层能直接把 id 记进 outbox。单目标时就是那一条；多目标时
      // 看 deliveries[i].messageIds；平台不给 id 的通道这里是空数组。
      messageIds: Array.isArray(outcome?.messageIds) ? outcome.messageIds.map(String) : [],
      // v0.29.0：places 是「每条 id 属于哪个目标」。改 / 撤按它定位，
      // 摊平的 messageIds 回答不了「这条在哪个聊天里」。
      places: Array.isArray(outcome?.places) ? outcome.places : [],
    }

    // v0.33.0：群发也能一个请求就把「进行中」表情挂上。挂不上不把发送判成失败 ——
    // 消息已经在对方手机上了，表情是锦上添花。详见 lib/progress.js 的纪律①。
    if (base.ok === true && options.progress === true) {
      const opened = await beginProgress(cfg, {
        channel: name,
        account: base.account,
        messageId: base.messageIds[0] ?? '',
        emojis: options.emojis,
      })
      if (opened.ok === true) {
        base.progressId = opened.progressId
        base.progress = opened.emoji
      } else {
        base.progressId = ''
        base.progressDetail = String(opened.detail ?? '')
      }
    }

    results[name] = base
    if (outcome?.ok === true) {
      if (bestEffort) softOk = true
      else hardOk = true
    }
  }

  // 成功判定：硬通道优先；只选了尽力而为通道时看它自己
  const ok = hardOk || (!hardTried && softOk)
  return { ok, results }
}

/**
 * 只发一个指定账号（「每个账号一个测试按钮」的实现基础）。
 *
 * 与 send() 的区别：不猜、不回落 —— 通道名与账号名必须都能精确命中，
 * 找不到就直说是哪个找不到。测试按钮要能定位问题，不能悄悄换一个账号发。
 *
 * @param {Record<string,any>} cfg
 * @param {{channel: string, account?: string|number, text: string}} input
 * @returns {Promise<{ok: boolean, detail: string, channel: string, account: string|null, title: string}>}
 */
export async function sendOne(cfg, input) {
  const name = normalizeChannel(input?.channel)
  if (name === '') {
    return { ok: false, detail: '未知通道 ' + String(input?.channel ?? ''), channel: String(input?.channel ?? ''), account: null, title: '' }
  }
  const mod = REGISTRY.get(name)
  const body = String(input?.text ?? '')
  if (body.trim() === '') {
    return { ok: false, detail: '测试正文为空', channel: name, account: null, title: mod.TITLE }
  }

  const wanted = input?.account
  const acc = account(cfg, name, wanted)
  if (acc === null || acc === undefined) {
    const label = wanted === undefined || wanted === null || String(wanted) === ''
      ? '该通道没有任何账号'
      : '没有名为 ' + String(wanted) + ' 的账号'
    return { ok: false, detail: label, channel: name, account: null, title: mod.TITLE }
  }

  const accountName = acc?.name ? String(acc.name) : null
  let outcome
  try {
    outcome = await sendToTargets(mod, body, withChannelProxy(cfg, name, acc), { replyTo: input?.replyTo })
  } catch (err) {
    outcome = { ok: false, detail: '异常 ' + (err?.name ?? 'Error') + ': ' + (err?.message ?? String(err)) }
  }
  const messageIds = Array.isArray(outcome?.messageIds) ? outcome.messageIds.map(String) : []
  const base = {
    ok: outcome?.ok === true,
    detail: String(outcome?.detail ?? ''),
    channel: name,
    account: accountName,
    title: mod.TITLE,
    deliveries: Array.isArray(outcome?.deliveries) ? outcome.deliveries : [],
    messageIds,
  }

  // v0.33.0：发完就挂「进行中」表情。挂不上不影响发送结果 ——
  // 这是 best-effort，详见 lib/progress.js 的纪律①。
  if (base.ok === true && input?.progress === true) {
    const opened = await beginProgress(cfg, {
      channel: name,
      account: accountName,
      messageId: messageIds[0] ?? '',
      emojis: input?.emojis,
    })
    if (opened.ok === true) {
      return { ...base, progressId: opened.progressId, progress: opened.emoji === '' ? '' : opened.emoji }
    }
    // 挂不上要把原因带回去，但不能把发送判成失败。
    return { ...base, progressId: '', progressDetail: String(opened.detail ?? '') }
  }
  return base
}

/**
 * 改一条已经发出去的消息（v0.29.0）。
 *
 * 与 send() 的分工：send 造一条新的，这里动一条旧的 —— 所以必须给出具体的
 * 通道 + 账号 + 消息 id，不做任何回落。找不到就直说是哪个找不到，
 * 因为「改错了消息」比「没改成」严重得多。
 *
 * @param {Record<string,any>} cfg
 * @param {{channel: string, account?: string|number, messageId: string, text: string, chatId?: string}} input
 */
export async function editMessage(cfg, input) {
  const name = normalizeChannel(input?.channel)
  const messageId = String(input?.messageId ?? '').trim()
  const text = String(input?.text ?? '')
  if (name === '') {
    return { ok: false, detail: '未知通道 ' + String(input?.channel ?? ''), channel: String(input?.channel ?? ''), account: null, title: '', messageId }
  }
  const mod = REGISTRY.get(name)
  const base = { channel: name, account: null, title: mod.TITLE, messageId }
  const blocked = editBlocker(name)
  if (blocked !== '') return { ok: false, detail: blocked, ...base }
  if (messageId === '') return { ok: false, detail: '要给消息 id —— 发件箱里那条没有 id 就改不了', ...base }
  if (text.trim() === '') return { ok: false, detail: '改成的正文不能为空（要清掉请用撤回）', ...base }

  const acc = account(cfg, name, input?.account)
  if (acc === null || acc === undefined) {
    const wanted = input?.account
    const label = wanted === undefined || wanted === null || String(wanted) === ''
      ? '该通道没有任何账号'
      : '没有名为 ' + String(wanted) + ' 的账号'
    return { ok: false, detail: label, ...base }
  }
  const accountName = acc?.name ? String(acc.name) : null
  if (typeof mod.editMessage !== 'function') {
    return { ok: false, detail: '该通道还没有实现改消息', ...base, account: accountName }
  }
  let outcome
  try {
    outcome = await mod.editMessage(messageId, text, withChannelProxy(cfg, name, acc), { chatId: input?.chatId })
  } catch (err) {
    outcome = { ok: false, detail: '异常 ' + (err?.name ?? 'Error') + ': ' + (err?.message ?? String(err)) }
  }
  return { ok: outcome?.ok === true, detail: String(outcome?.detail ?? ''), ...base, account: accountName }
}

/**
 * 撤回一条已经发出去的消息（v0.29.0）。
 *
 * @param {Record<string,any>} cfg
 * @param {{channel: string, account?: string|number, messageId: string, chatId?: string}} input
 */
export async function deleteMessage(cfg, input) {
  const name = normalizeChannel(input?.channel)
  const messageId = String(input?.messageId ?? '').trim()
  if (name === '') {
    return { ok: false, detail: '未知通道 ' + String(input?.channel ?? ''), channel: String(input?.channel ?? ''), account: null, title: '', messageId }
  }
  const mod = REGISTRY.get(name)
  const base = { channel: name, account: null, title: mod.TITLE, messageId }
  const blocked = deleteBlocker(name)
  if (blocked !== '') return { ok: false, detail: blocked, ...base }
  if (messageId === '') return { ok: false, detail: '要给消息 id —— 发件箱里那条没有 id 就撤不了', ...base }

  const acc = account(cfg, name, input?.account)
  if (acc === null || acc === undefined) {
    const wanted = input?.account
    const label = wanted === undefined || wanted === null || String(wanted) === ''
      ? '该通道没有任何账号'
      : '没有名为 ' + String(wanted) + ' 的账号'
    return { ok: false, detail: label, ...base }
  }
  const accountName = acc?.name ? String(acc.name) : null
  if (typeof mod.deleteMessage !== 'function') {
    return { ok: false, detail: '该通道还没有实现撤回', ...base, account: accountName }
  }
  let outcome
  try {
    outcome = await mod.deleteMessage(messageId, withChannelProxy(cfg, name, acc), { chatId: input?.chatId })
  } catch (err) {
    outcome = { ok: false, detail: '异常 ' + (err?.name ?? 'Error') + ': ' + (err?.message ?? String(err)) }
  }
  return { ok: outcome?.ok === true, detail: String(outcome?.detail ?? ''), ...base, account: accountName }
}

/**
 * 给一条已经发出去的消息加表情回应（v0.30.0）。
 *
 * 与 editMessage / deleteMessage 同一套纪律：必须精确指定通道 + 账号 + 消息 id，
 * 不做回落。表情本身在交给通道之前先过 lib/reactions.js：
 *
 *   - Slack 要的是**名字**（thumbsup），不是字符。这一步转换放在这里，
 *     通道实现保持「收到什么就发什么」，{`slack`} 不做业务判断。
 *   - 其余三家收 Unicode 原样。
 *
 * @param {Record<string,any>} cfg
 * @param {{channel: string, account?: string|number, messageId: string, emoji: string, chatId?: string}} input
 */
export async function addReaction(cfg, input) {
  const name = normalizeChannel(input?.channel)
  const messageId = String(input?.messageId ?? '').trim()
  if (name === '') {
    return { ok: false, detail: '未知通道 ' + String(input?.channel ?? ''), channel: String(input?.channel ?? ''), account: null, title: '', messageId }
  }
  const mod = REGISTRY.get(name)
  const base = { channel: name, account: null, title: mod.TITLE, messageId }
  const blocked = reactionBlocker(name)
  if (blocked !== '') return { ok: false, detail: blocked, ...base }
  if (messageId === '') return { ok: false, detail: '要给消息 id —— 发件箱里那条没有 id 就加不了表情', ...base }

  const normalized = normalizeEmoji(input?.emoji)
  if (normalized.ok !== true) return { ok: false, detail: normalized.detail, ...base }
  if (normalized.emoji === '') return { ok: false, detail: '要给表情（Unicode 字符，或 Slack 的名字）', ...base }

  // Slack 认名字不认字符 —— 转换失败就在这里停，不猜一个名字发出去。
  let emoji = normalized.emoji
  if (name === 'slack') {
    const named = slackNameOf(emoji)
    if (named.ok !== true) return { ok: false, detail: named.detail, ...base }
    emoji = named.name
  }

  const acc = account(cfg, name, input?.account)
  if (acc === null || acc === undefined) {
    const wanted = input?.account
    const label = wanted === undefined || wanted === null || String(wanted) === ''
      ? '该通道没有任何账号'
      : '没有名为 ' + String(wanted) + ' 的账号'
    return { ok: false, detail: label, ...base }
  }
  const accountName = acc?.name ? String(acc.name) : null
  if (typeof mod.addReaction !== 'function') {
    return { ok: false, detail: '该通道还没有实现加表情', ...base, account: accountName }
  }
  let outcome
  try {
    outcome = await mod.addReaction(messageId, emoji, withChannelProxy(cfg, name, acc), { chatId: input?.chatId })
  } catch (err) {
    outcome = { ok: false, detail: '异常 ' + (err?.name ?? 'Error') + ': ' + (err?.message ?? String(err)) }
  }
  return { ok: outcome?.ok === true, detail: String(outcome?.detail ?? ''), ...base, account: accountName, emoji }
}

/**
 * 去掉一条消息上的表情回应（v0.30.0）。
 *
 * ★ Matrix 是特例：它的表情是一个**独立事件**，「去掉」等于撤回那个回应事件，
 *   所以要给的是**回应事件的 id**，不是原消息的 id。管道里已经写明这一点，
 *   不假装「传原消息 id 也能去掉」。
 *
 * @param {Record<string,any>} cfg
 * @param {{channel: string, account?: string|number, messageId: string, emoji?: string, chatId?: string}} input
 */
export async function removeReaction(cfg, input) {
  const name = normalizeChannel(input?.channel)
  const messageId = String(input?.messageId ?? '').trim()
  if (name === '') {
    return { ok: false, detail: '未知通道 ' + String(input?.channel ?? ''), channel: String(input?.channel ?? ''), account: null, title: '', messageId }
  }
  const mod = REGISTRY.get(name)
  const base = { channel: name, account: null, title: mod.TITLE, messageId }
  const blocked = reactionBlocker(name)
  if (blocked !== '') return { ok: false, detail: blocked, ...base }
  if (messageId === '') {
    const hint = name === 'matrix' ? '要给回应事件 id' : '要给消息 id'
    return { ok: false, detail: hint + ' —— 发件箱里那条没有 id 就去不掉表情', ...base }
  }

  let emoji = ''
  if (name !== 'matrix') {
    const normalized = normalizeEmoji(input?.emoji)
    if (normalized.ok !== true) return { ok: false, detail: normalized.detail, ...base }
    emoji = normalized.emoji
    if (name === 'slack') {
      const named = slackNameOf(emoji)
      if (named.ok !== true) return { ok: false, detail: named.detail, ...base }
      emoji = named.name
    }
    if (emoji === '' && name !== 'telegram') {
      return { ok: false, detail: '要给表情才能去掉', ...base }
    }
  }

  const acc = account(cfg, name, input?.account)
  if (acc === null || acc === undefined) {
    const wanted = input?.account
    const label = wanted === undefined || wanted === null || String(wanted) === ''
      ? '该通道没有任何账号'
      : '没有名为 ' + String(wanted) + ' 的账号'
    return { ok: false, detail: label, ...base }
  }
  const accountName = acc?.name ? String(acc.name) : null
  if (typeof mod.removeReaction !== 'function') {
    return { ok: false, detail: '该通道还没有实现去表情', ...base, account: accountName }
  }
  let outcome
  try {
    // Matrix 的 removeReaction 第二个参数就是事件 id（没有 emoji 参数）
    outcome = name === 'matrix'
      ? await mod.removeReaction(messageId, withChannelProxy(cfg, name, acc), { chatId: input?.chatId })
      : await mod.removeReaction(messageId, emoji, withChannelProxy(cfg, name, acc), { chatId: input?.chatId })
  } catch (err) {
    outcome = { ok: false, detail: '异常 ' + (err?.name ?? 'Error') + ': ' + (err?.message ?? String(err)) }
  }
  return { ok: outcome?.ok === true, detail: String(outcome?.detail ?? ''), ...base, account: accountName, emoji }
}

/** 能加表情的通道（界面与工具从这一处取）。 */
export { REACTION_CHANNELS }

/**
 * 探测一个账号的凭据是否可用（只读，尽量不产生消息）。
 *
 * 通道没实现 probe() 时如实说明「不支持只读探测」，不伪装成成功。
 *
 * @param {Record<string,any>} cfg
 * @param {{channel: string, account?: string|number}} input
 */
export async function probeAccount(cfg, input) {
  const name = normalizeChannel(input?.channel)
  if (name === '') {
    return { ok: false, detail: '未知通道 ' + String(input?.channel ?? ''), supported: false, channel: String(input?.channel ?? ''), account: null }
  }
  const mod = REGISTRY.get(name)
  const acc = account(cfg, name, input?.account)
  if (acc === null || acc === undefined) {
    return { ok: false, detail: '找不到该账号', supported: true, channel: name, account: null }
  }
  const accountName = acc?.name ? String(acc.name) : null
  if (typeof mod.probe !== 'function') {
    return {
      ok: false,
      detail: '该通道没有只读探测接口，请用「测试发送」',
      supported: false,
      channel: name,
      account: accountName,
    }
  }
  let outcome
  try {
    outcome = await mod.probe(withChannelProxy(cfg, name, acc))
  } catch (err) {
    outcome = { ok: false, detail: '异常 ' + (err?.name ?? 'Error') + ': ' + (err?.message ?? String(err)) }
  }
  return {
    ok: outcome?.ok === true,
    detail: String(outcome?.detail ?? ''),
    supported: true,
    channel: name,
    account: accountName,
  }
}

/**
 * 给「一行摘要」用的紧凑格式，例如：
 *   telegram ✓ 已发送 1 块 · wechat ✗ ret=-2
 * @param {Record<string, any>} results
 * @returns {string}
 */
export function summarize(results) {
  const parts = []
  for (const [name, r] of Object.entries(results ?? {})) {
    const mark = r?.ok === true ? '✓' : '✗'
    const note = r?.ok === true ? String(r?.detail ?? '') : String(r?.detail ?? '失败')
    parts.push(name + ' ' + mark + ' ' + note)
  }
  return parts.join(' · ')
}

/** 导出供外部校验：ALL_CHANNELS 应覆盖注册表。 */
export function registryCoversAll() {
  return ALL_CHANNELS.every((name) => REGISTRY.has(name))
}

/**
 * 进程内所有流式会话。放这一层而不是 index.js，是因为「谁记着这些流」
 * 属于调度职责：index 只该转 HTTP，不该管状态机。
 */
const STREAM_HUB = createStreamHub()

/**
 * 开一条流式会话（v0.32.0）。
 *
 * 干的事只有三件：校验通道能不能流、发一条「正在处理…」拿到消息 id、
 * 把 bus 的真能力包成 stream.js 要的三个回调。状态机本身在 lib/stream.js，
 * 这里不做任何节流判断 —— 一处实现一处改。
 *
 * @param {Record<string,any>} cfg
 * @param {{channel: string, account?: string|number, initialText?: string, intervalMs?: number, chatId?: string}} input
 */
export async function openStream(cfg, input) {
  const name = normalizeChannel(input?.channel)
  if (name === '') {
    return { ok: false, detail: '未知通道 ' + String(input?.channel ?? ''), channel: String(input?.channel ?? '') }
  }
  const mod = REGISTRY.get(name)
  const blocked = streamBlocker(name)
  if (blocked !== '') return { ok: false, detail: blocked, channel: name, account: null, title: mod.TITLE }

  const acc = account(cfg, name, input?.account)
  if (acc === null || acc === undefined) {
    const wanted = input?.account
    const label = wanted === undefined || wanted === null || String(wanted) === ''
      ? '该通道没有任何账号'
      : '没有名为 ' + String(wanted) + ' 的账号'
    return { ok: false, detail: label, channel: name, account: null, title: mod.TITLE }
  }
  const accountName = acc?.name ? String(acc.name) : null
  const chatId = String(input?.chatId ?? '').trim()
  const scoped = withChannelProxy(cfg, name, acc)
  const interval = normalizeInterval(input?.intervalMs)

  const opened = STREAM_HUB.open(() => createStream({
    initialText: String(input?.initialText ?? '正在处理…'),
    limit: mod.MAX_CHARS,
    intervalMs: interval.ms,
    splitter: splitBlocks,
    // 造第一条：走 sendToTargets，这样按钮 / 多目标 / 代理那套既有逻辑全部照旧生效。
    create: async (text) => {
      const outcome = await sendToTargets(mod, text, scoped, {})
      if (outcome?.ok !== true) throw new Error(String(outcome?.detail ?? '开流时第一条没发出去'))
      const id = Array.isArray(outcome?.messageIds) ? String(outcome.messageIds[0] ?? '') : ''
      if (id === '') throw new Error('这个通道的回包不给消息 id，没法事后编辑 —— 用普通发送吧')
      return id
    },
    // 过程中改：直接调通道的 editMessage，不经 bus.editMessage ——
    // 那条路要重新查账号、重新做四层校验，每一次更新都查一遍账号是白费。
    edit: async (messageId, text) => mod.editMessage(messageId, text, scoped, { chatId }),
    // 余块：超出单条上限的部分只能另发新消息。
    sendRemainder: async (text) => sendToTargets(mod, text, scoped, {}),
    onLog: () => {},
  }))

  if (opened.ok !== true) {
    return { ok: false, detail: opened.detail, channel: name, account: accountName, title: mod.TITLE }
  }

  try {
    await opened.stream.start()
  } catch (err) {
    STREAM_HUB.drop(opened.id)
    return {
      ok: false,
      detail: '开流失败：' + String(err?.message ?? err).slice(0, 200),
      channel: name,
      account: accountName,
      title: mod.TITLE,
    }
  }

  return {
    ok: true,
    detail: '已开流' + (interval.detail === '' ? '' : '（' + interval.detail + '）'),
    channel: name,
    account: accountName,
    title: mod.TITLE,
    streamId: opened.id,
    messageId: opened.stream.messageId,
    intervalMs: interval.ms,
  }
}

/** 往一条流里送一次更新。还没开成 / 已收尾都返回 false，不抛。 */
export function updateStream(streamId, text) {
  const stream = STREAM_HUB.get(streamId)
  if (stream === null) return { ok: false, detail: '没有这条流（可能已经收尾，或进程重启过）', streamId: String(streamId ?? '') }
  const took = stream.update(text)
  return {
    ok: took,
    detail: took ? '已记下，稍后合并刷新' : '这条流不在可更新状态（当前：' + stream.status + '）',
    streamId: String(streamId ?? ''),
    status: stream.status,
    stats: stream.stats,
  }
}

/** 定稿。幂等：重复调用返回第一次的结果，不重复发消息。 */
export async function finishStream(streamId, text) {
  const stream = STREAM_HUB.get(streamId)
  if (stream === null) return { ok: false, detail: '没有这条流（可能已经收尾，或进程重启过）', streamId: String(streamId ?? '') }
  let result
  try {
    result = await stream.finish(text)
  } catch (err) {
    return { ok: false, detail: '定稿失败：' + String(err?.message ?? err).slice(0, 200), streamId: String(streamId ?? '') }
  }
  STREAM_HUB.drop(streamId)
  return { ...result, streamId: String(streamId ?? '') }
}

/** 放弃一条流。已经发出去的那条消息留在那里（不删 —— 删是另一个语义）。 */
export function cancelStream(streamId) {
  const stream = STREAM_HUB.get(streamId)
  if (stream === null) return { ok: false, detail: '没有这条流（可能已经收尾，或进程重启过）', streamId: String(streamId ?? '') }
  const result = stream.cancel()
  STREAM_HUB.drop(streamId)
  return { ...result, streamId: String(streamId ?? '') }
}

/** 当前活着的流（给状态接口用）。 */
export function listStreams() {
  // v0.33.0：顺手把超时的流掐掉。v0.32.0 留的坑是「sweep 没有任何地方调」——
  // 读列表时清一次是最自然的时机：这个接口本来就是给人看「现在有几条」的，
  // 让它报出来的数字是清理后的真实数字，比另开一个定时器干净。
  const swept = STREAM_HUB.sweep()
  return {
    ok: true,
    detail: swept.length === 0 ? '' : '顺手清掉了 ' + swept.length + ' 条超时的流',
    channels: [...STREAM_CHANNELS],
    reasons: NO_STREAM_REASON,
    streams: STREAM_HUB.list(),
    size: STREAM_HUB.size,
    swept,
  }
}

/**
 * 进程内活着的进度表情（v0.33.0）。
 *
 * 为什么不塞进 stream 那一层：流式管的是「一条消息反复改正文」，进度表情管的是
 * 「一条已经定稿的消息换个符号」。两者的生命周期与失败语义都不一样 ——
 * 流的失败会让正文失真，表情的失败什么都不影响。混在一起会让后者被前者的
 * 复杂度拖着走。
 */
const PROGRESS_HUB = new Map()
let progressCounter = 0

/**
 * 待收尾记录（v0.34.0）。与 `PROGRESS_HUB` 是两份视图：
 *   - `PROGRESS_HUB`：活着的状态机（能调 transition 的那个对象）
 *   - `PROGRESS_RECORDS`：要落盘的那份快照（只留能重建状态机的信息）
 *
 * 为什么不全靠 Map 迭代：Map 里的是对象，落盘要的是可序列化的最小集合；
 * 而且「重启前挂着的」与「本次进程里挂的」在恢复后必须能区分 —— 恢复出来的
 * 状态机 `status` 直接是 running，它不会重新挂一次表情（那会重复挂）。
 */
let PROGRESS_RECORDS = []
let restoredOnce = null

/** 落盘文件位置。允许用环境变量覆盖，探针跑测试时不污染真实文件。 */
function progressStorePath() {
  const fromEnv = String(process.env.DSH_PUSH_HUB_PROGRESS_PATH ?? '').trim()
  return fromEnv === '' ? PROGRESS_PATH : fromEnv
}

/** 把当前记录写回磁盘。失败只回 detail，不抛 —— 落盘失败不该让一次发送失败。 */
async function persistProgress() {
  const outcome = await writeProgressStore(PROGRESS_RECORDS, progressStorePath())
  return outcome
}

/**
 * 第一次需要时把磁盘上的待收尾记录恢复成状态机。
 *
 * 只在第一次调用时读盘，之后走缓存 —— 每次 listProgress 都读一遍磁盘没有意义，
 * 而且会让「顺手 sweep」变成磁盘 IO。
 *
 * 恢复出来的状态机带 `initialEmoji`：它知道那条消息现在挂着什么，
 * 所以收尾时会先把它摘掉；它**不会**重新挂一次（挂两次在平台上就是两个符号）。
 */
async function ensureProgressRestored() {
  if (restoredOnce !== null) return restoredOnce
  const store = await readProgressStore(progressStorePath())
  let restored = 0
  for (const one of store.records) {
    if (PROGRESS_HUB.has(one.id)) continue
    const mod = REGISTRY.get(one.channel)
    if (mod === undefined) continue
    const emojis = { ...(one.emojis ?? {}) }
    const machine = createProgress({
      messageId: one.messageId,
      emojis,
      initialEmoji: one.emoji ?? '',
      addReaction: () => Promise.resolve({ ok: false, detail: '进程重启过，缺账号凭据，这次只摘不挂' }),
      removeReaction: () => Promise.resolve({ ok: false, detail: '进程重启过，缺账号凭据，只能按记录摘掉' }),
      onLog: () => {},
    })
    PROGRESS_HUB.set(one.id, { machine, meta: { channel: one.channel, account: one.account ?? null, messageId: one.messageId, createdAt: Number(one.createdAt) || Date.now(), restored: true } })
    restored += 1
  }
  PROGRESS_RECORDS = store.records
  restoredOnce = { ok: true, detail: '', restored }
  return restoredOnce
}

/** 从一条活着的记录造落盘快照。 */
function recordOf(id, one, emojis) {
  return {
    id,
    channel: one.meta.channel,
    account: one.meta.account,
    messageId: one.meta.messageId,
    emojis: emojis ?? {},
    emoji: one.machine.emoji,
    createdAt: one.meta.createdAt,
  }
}

/**
 * 把超时的进度掐掉（v0.34.0）。超时的调 `machine.clear()` 把表情摘干净，
 * 然后从内存与磁盘一起删掉。
 *
 * 返回被掐掉的 id。由 `listProgress()` 顺手调用 —— 与流式那边同一个模式：
 * 读列表时清一次，报出来的数字就是清理后的真实数字，不用另开定时器。
 */
async function sweepProgress() {
  await ensureProgressRestored()
  const stale = expiredIds(PROGRESS_RECORDS, PROGRESS_TTL_MS)
  if (stale.length === 0) return []
  for (const id of stale) {
    const one = PROGRESS_HUB.get(id)
    if (one !== undefined) {
      try { await one.machine.clear() } catch { /* 摘不掉也得从表里删，否则永远占位 */ }
      PROGRESS_HUB.delete(id)
    }
    PROGRESS_RECORDS = removeRecord(PROGRESS_RECORDS, id)
  }
  await persistProgress()
  return stale
}

/**
 * 给一条已经发出去的消息挂「进行中」表情，返回一个 progressId 供收尾用。
 *
 * @param {Record<string,any>} cfg
 * @param {{channel: string, account?: string|number, messageId: string, emojis?: Record<string, unknown>}} input
 */
export async function beginProgress(cfg, input) {
  const name = normalizeChannel(input?.channel)
  if (name === '') {
    return { ok: false, detail: '未知通道 ' + String(input?.channel ?? ''), channel: String(input?.channel ?? '') }
  }
  const mod = REGISTRY.get(name)
  const base = { channel: name, account: null, title: mod.TITLE }
  const blocked = progressBlocker(name)
  if (blocked !== '') return { ok: false, detail: blocked, ...base }

  const messageId = String(input?.messageId ?? '').trim()
  if (messageId === '') {
    return { ok: false, detail: '要给消息 id —— 发件箱里那条没有 id 就挂不了进度表情', ...base }
  }
  const acc = account(cfg, name, input?.account)
  if (acc === null || acc === undefined) {
    const wanted = input?.account
    const label = wanted === undefined || wanted === null || String(wanted) === ''
      ? '该通道没有任何账号'
      : '没有名为 ' + String(wanted) + ' 的账号'
    return { ok: false, detail: label, ...base }
  }
  const accountName = acc?.name ? String(acc.name) : null
  const scoped = withChannelProxy(cfg, name, acc)
  const set = normalizeEmojiSet(input?.emojis, name)

  // 落盘前必须先恢复一次：否则 PROGRESS_RECORDS 还是空的，
  // 下一次 persistProgress() 会把磁盘上别人（重启前）的记录整份冲掉。
  await ensureProgressRestored()
  await sweepProgress()
  if (PROGRESS_HUB.size >= MAX_ACTIVE_PROGRESS) {
    return {
      ok: false,
      detail: '同时最多挂 ' + MAX_ACTIVE_PROGRESS + ' 条进度表情，先把不用的收尾掉（当前 ' + PROGRESS_HUB.size + ' 条，大多是忘了 end 的）',
      ...base,
    }
  }

  progressCounter += 1
  const progressId = 'pg' + Date.now().toString(36) + '-' + progressCounter.toString(36)
  const machine = createProgress({
    messageId,
    emojis: set.emojis,
    addReaction: (emoji) => mod.addReaction(messageId, emoji, scoped, {}),
    removeReaction: (emoji) => mod.removeReaction(messageId, emoji, scoped, {}),
    onLog: () => {},
  })
  PROGRESS_HUB.set(progressId, { machine, meta: { channel: name, account: accountName, messageId, createdAt: Date.now() } })
  const started = await machine.start()
  // 挂完就落盘：哪怕挂失败了也记 —— 因为「挂失败」这条消息在平台上可能什么都没挂，
  // 但它仍然是一条「调用方以为自己在跟踪」的进度，留在表里才能被 sweep 掉。
  PROGRESS_RECORDS = upsertRecord(PROGRESS_RECORDS, recordOf(progressId, PROGRESS_HUB.get(progressId), set.emojis))
  const persisted = await persistProgress()
  return {
    ok: true,
    detail: [started.detail, set.detail, persisted.ok === true ? '' : persisted.detail].filter((one) => one !== '').join('；'),
    ...base,
    account: accountName,
    messageId,
    progressId,
    emoji: machine.emoji,
    emojis: set.emojis,
  }
}

/**
 * 给一条进度表情收尾。outcome 传 'success' / 'error' / null（只清干净）。
 * 幂等：收尾后条目从表里摘掉，再次调用返回「没有这条」而不是重复改表情。
 */
export async function endProgress(progressId, outcome) {
  const id = String(progressId ?? '')
  // v0.34.0：先恢复一次 —— 重启前挂上的那条也要能收尾（这正是落盘的全部意义）。
  await ensureProgressRestored()
  const one = PROGRESS_HUB.get(id)
  if (one === undefined) {
    return { ok: false, detail: '没有这条进度（可能已经收尾，或进程重启过）', progressId: id }
  }
  const result = await one.machine.finish(outcome)
  PROGRESS_HUB.delete(id)
  PROGRESS_RECORDS = removeRecord(PROGRESS_RECORDS, id)
  const persisted = await persistProgress()
  const restoredNote = one.meta.restored === true ? '（这条是重启前挂的，凭据已失效，只能按记录摘）' : ''
  return {
    ...result,
    detail: [result.detail, restoredNote, persisted.ok === true ? '' : persisted.detail].filter((x) => x !== '').join('；'),
    progressId: id,
    channel: one.meta.channel,
    account: one.meta.account,
    title: REGISTRY.get(one.meta.channel)?.TITLE ?? '',
  }
}

/**
 * 当前还挂着的进度表情（给状态接口 / 界面用）。
 *
 * v0.34.0 起是 async：要先恢复磁盘上的记录，再顺手把超时的掐掉。
 * 这个接口本来就是给人看「现在有几条」的，让它报出来的数字是清理后的真实数字，
 * 比另开一个定时器干净 —— 与 listStreams() 同一个模式。
 */
export async function listProgress() {
  await ensureProgressRestored()
  const swept = await sweepProgress()
  const items = []
  for (const [id, one] of PROGRESS_HUB) {
    items.push({
      id,
      channel: one.meta.channel,
      account: one.meta.account,
      messageId: one.meta.messageId,
      createdAt: one.meta.createdAt,
      restored: one.meta.restored === true,
      ttlMs: PROGRESS_TTL_MS,
      ...one.machine.stats,
    })
  }
  return {
    ok: true,
    detail: swept.length === 0 ? '' : '顺手清掉了 ' + swept.length + ' 条超时的进度（超过 ' + Math.round(PROGRESS_TTL_MS / 60000) + ' 分钟没收尾）',
    channels: [...PROGRESS_CHANNELS],
    reasons: NO_PROGRESS_REASON,
    items,
    size: items.length,
    swept,
    maxActive: MAX_ACTIVE_PROGRESS,
  }
}

/**
 * 测试钩子：把「已恢复」的缓存清掉，并丢掉内存里的状态机。
 *
 * 只在探针里用 —— 真实场景里这份缓存是**对的**（一个进程只该读一次盘，
 * 重启自然就是新进程）。但探针跑在同一个进程里，要模拟「重启」就必须
 * 显式把缓存清掉，否则第二步永远看不到第一步之后写进文件的东西。
 *
 * 命名用双下划线前缀，与 receiver.js 的 __test 同一套约定：一眼看出不是公开 API。
 */
export function __resetProgressCache() {
  PROGRESS_HUB.clear()
  PROGRESS_RECORDS = []
  restoredOnce = null
  progressCounter = 0
}

/**
 * v0.29.0：能改 / 能撤的通道清单在这里再导出一次。
 * 界面与工具都从这一处取，免得某天通道表变了、三处各写一份就有一处没跟上。
 * v0.32.0 起流式能力表也从这里出；v0.33.0 起进度表情同样。
 */
export { EDIT_CHANNELS, DELETE_CHANNELS, STREAM_CHANNELS, PROGRESS_CHANNELS }