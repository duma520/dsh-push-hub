/**
 * lib/ratelimit.js — 每分钟发送配额（v0.35.0）。
 *
 * 为什么要有这一层：
 * 通道实现里已经有 chunkDelayMs（块间延迟），但那是**块与块之间**的间隔，
 * 不是**每分钟最多几条**。两者的区别在长消息上特别明显：一条两万字的正文
 * 切成 10 块、块间延迟 350 毫秒，总耗时 3.5 秒全部发出 —— 单看间隔毫秒数完全
 * 合规，但平台侧看到的是「3.5 秒内来了 10 条消息」，Telegram 每聊天每分钟的
 * 配额就是这么被打穿的。延迟控制得越快，越容易撞配额。
 *
 * 三条纪律：
 *
 * ① 限流只让请求变慢，不让它失败（除非等待超出单次上限）。
 *    超配额时的正确反应是等，不是拒绝。真等不了（比如配额设成 1 条/分钟
 *    而这条消息有 20 块，要等 19 分钟）才如实报失败，并且**一块都不发** ——
 *    发一半比不发更糟：用户既没收到完整内容，又消耗了配额。
 *
 * ② 计数单位是「块」，不是「一次 send 调用」。
 *    一条长消息切 5 块，平台视作 5 次 API 调用，配额也是扣 5 次。
 *    按「一次调用」计数会低估 5 倍，看着没超其实早就超了。
 *
 * ③ 预约制，不是检查制。
 *    take(n) 直接把 n 个槽位预约到未来（压入时间戳），返回要等多久。
 *    调用方 sleep 后直接发，不需要再检查一遍。这样并发多个 send 也不会互相插队，
 *    检查制的经典 bug 是两个请求同时「检查通过」然后一起发出去。
 *
 * 刻意不做的事：不落盘。限流窗口是易失的，重启后清空是正确行为 ——
 * 重启本身就是一次足够的停顿，把昨天的窗口带到今天没有意义。
 *
 * @module ratelimit
 */

import { splitBlocks } from './text.js'

/** 默认每分钟条数。Telegram 每聊天每分钟约 20 条，这里取更保守的 15。 */
export const DEFAULT_PER_MINUTE = 15

/** 下限：填得比 1 小没有意义（1 条/分钟已经极慢）。 */
export const MIN_PER_MINUTE = 1

/**
 * 上限 30。
 *
 * 为什么封顶：这不是平台的真实上限，而是本插件愿意替你跑的最大速度。
 * 填 600 等于关掉限流，那不如直接填 0（不限）—— 让「想关掉」有一个明确的写法，
 * 而不是靠填一个大数字来绕过，后者会让配置里出现一堆没人看得懂的数。
 */
export const MAX_PER_MINUTE = 30

/** 窗口长度：一分钟。 */
export const WINDOW_MS = 60 * 1000

/**
 * 单次等待上限：60 秒。
 *
 * 超过这个数就不等了，整条不发并报错。理由：等 19 分钟的那次调用，
 * 调用方八成已经超时、用户已经放弃，而配额照样被占着。
 */
export const MAX_WAIT_MS = 60 * 1000

/**
 * 不适用限流的通道。
 *
 * 只有 email：一次 send 就是一封（lib/channels/email.js 刻意不分块），
 * 没有「一分钟内第 16 封就被拒」这回事；它的限制是服务商的日配额（几百封量级）。
 * 用每分钟 15 去卡邮件，反而会挡住正常的日报 / 汇总。
 */
export const NO_LIMIT_REASON = Object.freeze({
  email: '邮件没有「每分钟几条」的硬配额 —— 一次 send 就是一封，平台限制的是每天几百封这种量级。用每分钟配额去卡它反而会挡住正常的日报。',
})

/** 这个通道适不适用每分钟配额。 */
export function canLimit(channel) {
  const name = String(channel ?? '').trim().toLowerCase()
  if (name === '') return false
  return !Object.hasOwn(NO_LIMIT_REASON, name)
}

/** 不适用时返回原因；适用返回空串（与 lib/edits.js 的 editBlocker 同一套约定）。 */
export function limitBlocker(channel) {
  const name = String(channel ?? '').trim().toLowerCase()
  if (name === '') return '要给通道名 —— 每分钟配额是按通道 + 账号 + 目标分开算的'
  return NO_LIMIT_REASON[name] ?? ''
}

/**
 * 归一化「每分钟条数」配置。
 *
 * 三种取值语义完全不同，不能合并：
 *
 * | 配置 | 含义 | 为什么不能合并 |
 * |---|---|---|
 * | 留空 | 用默认 15 | 「没表态」不等于「不想限」 |
 * | 0 | 明确不限 | 这是唯一能关掉限流的写法，合并掉就没有关掉的途径了 |
 * | 数字 | 该数字（夹到 1~30） | 夹值必须回 detail，静默改用户给的值会骗人 |
 *
 * @param {unknown} input
 * @returns {{ok: boolean, perMinute: number, detail: string}}
 */
export function normalizePerMinute(input) {
  if (input === undefined || input === null || String(input).trim() === '') {
    return { ok: true, perMinute: DEFAULT_PER_MINUTE, detail: '' }
  }
  const n = Number(input)
  if (!Number.isFinite(n)) {
    return {
      ok: true,
      perMinute: DEFAULT_PER_MINUTE,
      detail: '每分钟配额给的是 ' + String(input).slice(0, 20) + '，不是数字 —— 按默认 ' + DEFAULT_PER_MINUTE + ' 条/分钟走',
    }
  }
  if (n === 0) return { ok: true, perMinute: 0, detail: '该账号不限每分钟条数（填 0 即关闭）' }
  if (n < 0) {
    return { ok: true, perMinute: DEFAULT_PER_MINUTE, detail: '每分钟配额是负数（' + n + '），按默认 ' + DEFAULT_PER_MINUTE + ' 条/分钟走' }
  }
  const whole = Math.floor(n)
  if (whole < MIN_PER_MINUTE) {
    return { ok: true, perMinute: MIN_PER_MINUTE, detail: '每分钟 ' + n + ' 条太密了，按下限 ' + MIN_PER_MINUTE + ' 条/分钟走' }
  }
  if (whole > MAX_PER_MINUTE) {
    return {
      ok: true,
      perMinute: MAX_PER_MINUTE,
      detail: '每分钟 ' + whole + ' 条超出本插件的上限，按 ' + MAX_PER_MINUTE + ' 条/分钟走（真想关掉请填 0）',
    }
  }
  return { ok: true, perMinute: whole, detail: '' }
}

/**
 * 估算这条正文会切成几块。
 *
 * 用的就是通道内部那个表达式（acc.maxMessageChars 或通道 MAX_CHARS）与同一个
 * splitBlocks，所以预估块数等于实际块数，不是猜。
 * 邮件不分块，恒为 1。
 */
export function countBlocks(text, limit) {
  const blocks = splitBlocks(String(text ?? ''), limit)
  return Math.max(1, blocks.length)
}

/**
 * 一个限流器（滑动窗口 + 预约制）。
 *
 * slots 存的是「已经被预约掉的发送时刻」。take(n) 时：
 *   1. 清掉早于 now - window 的槽位（那一分钟的账翻篇了）
 *   2. 算出要腾几个位置、要等多久
 *   3. 把 n 个槽位预约到「等完之后」的时刻并返回等待量
 *
 * 第 3 步是预约制的关键：调用方还在 sleep 的时候，别的 send 已经能看到
 * 这些未来的槽位了，不会误以为还有空位。
 *
 * @param {{perMinute?: number, windowMs?: number, now?: () => number}} [options]
 */
export function createLimiter(options = {}) {
  const perMinute = Number.isFinite(Number(options.perMinute)) ? Number(options.perMinute) : DEFAULT_PER_MINUTE
  const windowMs = Number.isFinite(Number(options.windowMs)) && Number(options.windowMs) > 0
    ? Number(options.windowMs)
    : WINDOW_MS
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  let slots = []
  let waits = 0
  let blocked = 0

  function prune() {
    const edge = now() - windowMs
    if (slots.length === 0) return
    slots = slots.filter((at) => at > edge)
  }

  /**
   * 预约 n 个发送槽位。
   * @param {number} n 块数（至少 1）
   * @returns {{ok: boolean, waitMs: number, used: number, perMinute: number, detail: string}}
   */
  function take(n) {
    const want = Math.max(1, Math.floor(Number(n) || 1))
    if (perMinute <= 0) {
      return { ok: true, waitMs: 0, used: 0, perMinute: 0, detail: '不限' }
    }
    prune()
    // 先接住「这一条本身就超配额」的情况：切成 20 块而配额是 1 条/分钟，
    // 那就永远发不完 —— 等多久都没用，如实报错比让调用方干等更诚实。
    // 这也是 slots[overflow - 1] 会取到 undefined 的唯一成因（want > perMinute
    // 时 overflow 必然大于 slots.length），所以必须放在算 waitMs 之前。
    if (want > perMinute) {
      blocked += 1
      return {
        ok: false,
        waitMs: windowMs,
        used: slots.length,
        perMinute,
        detail:
          '这条要切成 ' + want + ' 块，但配额是 ' + perMinute + ' 条/分钟 —— 永远发不完，一块都没发。' +
          '请调高配额、或把分块长度调大让它少切几块。',
      }
    }
    // 要腾出多少个位置：现有 + 这次的 - 配额。小于等于 0 说明还有空位。
    const overflow = slots.length + want - perMinute
    let waitMs = 0
    if (overflow > 0) {
      // 等最老的那 overflow 个过期就够了（slots 按时间升序）。
      const bottleneck = slots[overflow - 1]
      waitMs = Math.max(0, Math.round(bottleneck + windowMs - now()))
    }
    // 单次要等太久：不预约、不发送，让调用方如实报失败。
    if (waitMs > MAX_WAIT_MS) {
      blocked += 1
      return {
        ok: false,
        waitMs,
        used: slots.length,
        perMinute,
        detail:
          '这条要等 ' + Math.ceil(waitMs / 1000) + ' 秒（配额 ' + perMinute + ' 条/分钟，这次 ' + want + ' 块），' +
          '超出单次等待上限 ' + Math.round(MAX_WAIT_MS / 1000) + ' 秒 —— 一块都没发，稍后再试或调高配额',
      }
    }
    if (waitMs > 0) waits += 1
    // 预约：全部落在「等完之后」的那个时刻。同一批块的发送时刻相同，
    // 因为它们本来就是在 sleep 结束后连续发出的。
    const at = now() + waitMs
    for (let i = 0; i < want; i += 1) slots.push(at)
    slots.sort((a, b) => a - b)
    return {
      ok: true,
      waitMs,
      used: slots.length,
      perMinute,
      detail: waitMs > 0 ? '配额已满，等了 ' + (waitMs / 1000).toFixed(1) + ' 秒' : '',
    }
  }

  return {
    take,
    get stats() {
      prune()
      return { perMinute, windowMs, used: slots.length, waits, blocked }
    },
    reset() {
      slots = []
      waits = 0
      blocked = 0
    },
  }
}
