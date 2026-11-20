'use strict'

/**
 * dsh-push-hub / lib/progress.js — 进度表情（v0.33.0 新增）。
 *
 * 干的事：一条消息发出去之后，先在它上面挂一个「进行中」的表情，跑完换成
 * 成功或失败的表情。用户不用翻记录就知道这条任务到哪一步了。
 *
 * 为什么单独成文件，而不是塞进 lib/reactions.js：
 * reactions.js 管的是「给一条消息加/去一个表情」这一件事；进度表情管的是
 * 「一个状态机」—— 当前挂着什么、要不要先摘掉再挂、终态只能进一次、
 * 失败的加表情不能污染发送结果。两件事的复杂度不在一个量级。
 *
 * 三条纪律（每一条都对应一个真实会踩的坑）：
 *
 * ① **best-effort，绝不影响发送结果。** 消息已经发出去了，表情挂不上是小事。
 *    把「加表情失败」升级成「发送失败」是错的 —— 用户明明收到了消息。
 * ② **同一时刻只有一条 transition 在飞。** 先摘旧的再挂新的，两步是有顺序的；
 *    并发发出去会出现「旧的摘了新的没挂上」或者「同时挂着两个」。
 * ③ **终态只能进一次。** 调用方可能重试，重复 finish 会来回改表情，
 *    用户看到目标状态被改回去 —— 比根本不挂更糟。
 *
 * 另有一条不是纪律但必须说清的事实：**Telegram 只认它自己的 reaction 表情集**，
 * 不是所有 emoji 都能当回应。所以默认给的三个表情**不保证**一定挂得上；
 * 挂不上会在 detail 里说明，不影响消息。要稳妥就自己传三个已知可用的。
 *
 * @module progress.js
 */

import { REACTION_CHANNELS, NO_REACTION_REASON, normalizeEmoji, slackNameOf } from './reactions.js'

/** 能做进度表情的通道 —— 与「能加表情」是同一批，不另抄一份。 */
export const PROGRESS_CHANNELS = Object.freeze([...REACTION_CHANNELS])

/** 单次 provider 调用最多等多久。超时就当失败，继续走下一步 —— 不能卡住整条链。 */
export const PROGRESS_TIMEOUT_MS = 2000

/**
 * 一条进度最多挂多久（v0.34.0）。
 *
 * 30 分钟与流式那边一致。超过这个时间还没收尾的，基本可以断定是调用方忘了 ——
 * 真跑 30 分钟以上的任务极少，而一条永远「在跑」的消息比没有进度更糟：
 * 用户会一直等一个永远不会来的结果。
 */
export const PROGRESS_TTL_MS = 30 * 60 * 1000

/**
 * 同时最多挂多少条（v0.34.0）。
 *
 * 64 与 MAX_ACTIVE_STREAMS 同一个量级。这不是性能上限，是「忘了收尾」的
 * 探测阈值 —— 真到 64 条，说明调用方在批量挂而从不收，该报警了。
 */
export const MAX_ACTIVE_PROGRESS = 64

/**
 * 默认三态表情（Unicode）。
 *
 * 为什么是这三个：⏳ 一看就是「在跑」，✅ / ❌ 是全世界都认的成败符号。
 * **但 Telegram 只认它自己的 reaction 集**，这三个不一定在里面 —— 见模块头注释。
 */
export const DEFAULT_EMOJI = Object.freeze({ processing: '⏳', success: '✅', error: '❌' })

/**
 * Slack 用的默认三态（**名字，不是字符**）。
 *
 * Slack 的 reactions.add 要的是 :hourglass_flowing_sand: 这种名字，传 ⏳ 会回
 * invalid_name 而 HTTP 依然是 200（v0.30.0 踩过）。这三个是 Slack 内置的标准
 * emoji 名字，直接可用；**没有实测过**，如果哪天真挂了，detail 会写清楚。
 */
export const DEFAULT_SLACK = Object.freeze({
  processing: 'hourglass_flowing_sand',
  success: 'white_check_mark',
  error: 'x',
})

/** 八家为什么不能做进度表情 —— 前七条直接沿用 NO_REACTION_REASON（原因完全一样）。 */
export const NO_PROGRESS_REASON = Object.freeze({
  ...NO_REACTION_REASON,
  email: '邮件没有「给一封已经投递的信加个表情」这回事；发送结果看返回的 messageId 与日志',
})

/** 这个通道能不能做进度表情。 */
export function canProgress(channel) {
  return PROGRESS_CHANNELS.includes(String(channel ?? '').trim())
}

/** 不能做时给一句人话；能做返回空串（与 edits / reactions / stream 同一套约定）。 */
export function progressBlocker(channel) {
  const name = String(channel ?? '').trim()
  if (name === '') return '要给通道名 —— 进度表情必须指定在哪个通道里进行'
  if (canProgress(name)) return ''
  const known = NO_PROGRESS_REASON[name]
  if (known !== undefined) return known
  return '未知通道 ' + name + '，本插件没有这个通道'
}

/**
 * 归一化三态表情。给了就用给的，没给或给得不合法就用该通道的默认值。
 *
 * @param {{processing?: unknown, success?: unknown, error?: unknown}} [input]
 * @param {string} [channel]
 * @returns {{ok: boolean, emojis: {processing: string, success: string, error: string}, detail: string}}
 */
export function normalizeEmojiSet(input, channel) {
  const name = String(channel ?? '').trim()
  const base = name === 'slack' ? DEFAULT_SLACK : DEFAULT_EMOJI
  /** @type {{processing: string, success: string, error: string}} */
  const emojis = { ...base }
  const notes = []

  for (const key of ['processing', 'success', 'error']) {
    const given = input?.[key]
    if (given === undefined || given === null || String(given).trim() === '') continue
    const one = normalizeEmoji(given)
    if (one.ok !== true || one.emoji === '') {
      notes.push(key + ' 给的表情不合法（' + String(one.detail ?? '空') + '），用默认值')
      continue
    }
    if (name === 'slack') {
      // Slack 认名字不认字符。给的是表内 Unicode 就翻译过去；表外直接拒。
      const asName = slackNameOf(one.emoji)
      if (asName.ok !== true) {
        notes.push(key + ' 在 Slack 上不认（' + String(asName.detail ?? '') + '），用默认名字')
        continue
      }
      emojis[key] = asName.name
      continue
    }
    emojis[key] = one.emoji
  }

  return { ok: true, emojis, detail: notes.join('；') }
}

/**
 * 给一个 Promise 加超时。超时后拒，但**不会**取消已经在飞的请求
 * （通道的 addReaction 不接受 AbortSignal）—— 所以我们只是不再等它。
 *
 * @template T
 * @param {() => Promise<T>} make
 * @param {number} ms
 * @returns {Promise<T>}
 */
function withTimeout(make, ms) {
  let timer = null
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('超时 ' + ms + ' 毫秒没回')), ms)
    if (typeof timer?.unref === 'function') timer.unref()
  })
  return Promise.race([
    Promise.resolve().then(make),
    guard,
  ]).finally(() => { if (timer !== null) clearTimeout(timer) })
}

/**
 * 从一组待收尾记录里挑出已经超时的 id（v0.34.0）。
 *
 * 纯函数，不碰 Map 也不碰磁盘 —— 这样才能在探针里用固定时钟测，
 * 不用真的等 30 分钟。
 *
 * @param {Array<{id: string, createdAt: number}>} records
 * @param {number} [ttlMs]
 * @param {number} [now]
 * @returns {string[]}
 */
export function expiredIds(records, ttlMs = PROGRESS_TTL_MS, now = Date.now()) {
  const edge = now - (Number.isFinite(ttlMs) ? ttlMs : PROGRESS_TTL_MS)
  const out = []
  for (const one of Array.isArray(records) ? records : []) {
    const id = String(one?.id ?? '')
    if (id === '') continue
    const at = Number(one?.createdAt)
    if (Number.isFinite(at) && at < edge) out.push(id)
  }
  return out
}

/**
 * 造一个进度状态机。所有发送能力从参数注入，本函数不碰网络。
 *
 * @param {object} options
 * @param {string} options.messageId 要挂表情的那条消息
 * @param {{processing: string, success: string, error: string}} options.emojis
 * @param {(emoji: string) => Promise<{ok: boolean, detail?: string}>} options.addReaction
 * @param {(emoji: string) => Promise<{ok: boolean, detail?: string}>} options.removeReaction
 * @param {number} [options.timeoutMs]
 * @param {(level: string, message: string) => void} [options.onLog]
 * @returns {object}
 */
export function createProgress(options = {}) {
  const messageId = String(options.messageId ?? '').trim()
  const emojis = { ...DEFAULT_EMOJI, ...(options.emojis ?? {}) }
  // v0.34.0：从落盘记录恢复时，要知道「这条消息现在挂着什么」。
  // 不传就是空串（全新的一条）。恢复出来的状态机 finish 时会先把它摘掉。
  const initialEmoji = String(options.initialEmoji ?? '').trim()
  const addReaction = options.addReaction
  const removeReaction = options.removeReaction
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : PROGRESS_TIMEOUT_MS
  const onLog = typeof options.onLog === 'function' ? options.onLog : () => {}

  /** @type {'new'|'running'|'finished'} */
  let status = initialEmoji === '' ? 'new' : 'running'
  let current = initialEmoji
  let chain = Promise.resolve()
  let closedResult = null
  let added = 0
  let removed = 0
  const errors = []

  /**
   * 把一次 provider 调用包成「不抛、只记账」。
   * 这就是纪律①的落点：返回 false 而已，绝不往外抛。
   */
  const safely = async (kind, emoji) => {
    try {
      const call = kind === 'add' ? addReaction : removeReaction
      if (typeof call !== 'function') throw new Error('通道没有 ' + kind + 'Reaction')
      const outcome = await withTimeout(() => call(emoji), timeoutMs)
      if (outcome?.ok !== true) {
        throw new Error(String(outcome?.detail ?? (kind === 'add' ? '加表情失败' : '去表情失败')))
      }
      if (kind === 'add') added += 1
      else removed += 1
      return { ok: true }
    } catch (err) {
      const text = String(err?.message ?? err).slice(0, 200)
      errors.push({ at: Date.now(), kind, emoji, detail: text })
      onLog('warn', '进度表情 ' + kind + ' 失败：' + text)
      return { ok: false, detail: text }
    }
  }

  /**
   * 换一个表情：先把旧的摘掉，再挂新的。emoji 为空 = 只摘不挂（收尾清干净）。
   * 串到同一条链上 —— 这就是纪律②的落点。
   */
  const transition = (emoji) => {
    chain = chain.then(async () => {
      if (current !== '') {
        const previous = current
        current = ''
        await safely('remove', previous)
      }
      if (emoji === '') return
      const outcome = await safely('add', emoji)
      if (outcome.ok === true) current = emoji
    })
    return chain
  }

  return {
    get status() { return status },
    get emoji() { return current },
    get stats() { return { added, removed, errors: errors.length, status, emoji: current } },
    get failures() { return errors.map((one) => ({ ...one })) },

    /** 挂上「进行中」。重复调用直接返回，不重复挂。 */
    async start() {
      if (status !== 'new') return { ok: status === 'running', detail: '已经开过了（当前：' + status + '）' }
      if (messageId === '') return { ok: false, detail: '没有消息 id —— 挂不了进度表情' }
      status = 'running'
      await transition(emojis.processing)
      return { ok: true, detail: current === '' ? '没挂上（原因见 failures）' : '已挂上进行中表情' }
    },

    /**
     * 收尾。outcome 传 success / error / 其他（其他一律当 error）。传 null 表示只清干净、不留表情。
     * 幂等：第二次调用原样返回第一次的结果。
     */
    async finish(outcome) {
      if (status === 'finished') return closedResult
      status = 'finished'
      let emoji = ''
      if (outcome === 'success') emoji = emojis.success
      else if (outcome === 'error' || outcome === undefined) emoji = emojis.error
      else emoji = ''
      await transition(emoji)
      // 不用 this.stats：调用方可能把 finish 解构出来单独用，那时 this 是 undefined。
      closedResult = {
        ok: true,
        detail: errors.length === 0 ? '已收尾' : '已收尾（有 ' + errors.length + ' 次表情操作失败，详见 failures）',
        messageId,
        emoji,
        stats: { added, removed, errors: errors.length, status, emoji: current },
        failures: errors.length,
      }
      return closedResult
    },

    /** 等所有已排队的 transition 走完（调用方要确保收尾真落盘时用）。 */
    settled() { return chain.then(() => ({ ok: true }), () => ({ ok: false })) },

    /** 只清干净，不留表情。等价于 finish(null)。 */
    async clear() { return this.finish(null) },
  }
}
