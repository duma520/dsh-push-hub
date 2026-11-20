/**
 * lib/stream.js — 流式可编辑消息（v0.32.0）。
 *
 * 要解决的问题：长任务推送要么「憋到最后一次发」——用户盯着空白等几分钟，
 * 以为没动静；要么「每进展一步发一条」——对方手机上连刷二十条通知。
 * 第三条路是：先发一条「正在处理…」，过程中反复**编辑同一条**，最后定稿。
 * 这一路要求的能力本插件 v0.29.0 已经有了（editMessage），这里只是把它
 * 组装成一个节流的状态机。
 *
 * 为什么是纯调度器、不 import bus：
 *   调度逻辑（节流 / 串行 / 幂等 / TTL 回收）和「怎么发」是两件事。把发送
 *   能力从参数注入，这个模块就能在探针里用假实现跑完整状态机，不需要真凭据、
 *   不需要联网。index.js 才负责把 bus 的真能力接进来。
 *
 * 四条纪律（每一条都对应一个真坑，不是洁癖）：
 *   1. **必须节流**。平台对「编辑同一条消息」有频控（Telegram 每秒约 1 次/聊天、
 *      Slack chat.update 是 Tier 3），每来一个字就 edit 一次必然被限流，而且
 *      限流后界面停在半句话上，比不流式更难看。
 *   2. **同一时刻只有一个 edit 在飞**。上一条还没回就发下一条，回来的顺序
 *      不保证 —— 后发的先到会让界面**退回**到旧文本，然后卡在那里。
 *      所以所有 edit 走一条 Promise 链串行。
 *   3. **中途失败不能中断流**。一次 edit 失败（限流 / 网络抖动）只记账，
 *      继续收后续更新；真正定稿时再试一次。否则一次抖动整条流就废了。
 *   4. **finish 必须幂等**。调用方可能重复 finish（比如两个代码路径都收尾），
 *      第一次给结果，之后原样返回同一个结果，不重复发消息。
 *
 * @module stream
 */

import { EDIT_CHANNELS, NO_EDIT_REASON } from './edits.js'

/**
 * 能流式编辑的通道 —— 与「能改消息」完全同一批。
 * 刻意从 EDIT_CHANNELS 派生而不是另抄一份：抄一份迟早有一边没跟上。
 */
export const STREAM_CHANNELS = Object.freeze([...EDIT_CHANNELS])

/** 默认节流间隔（毫秒）。900 是「跟得上又不惹限流」的折中。 */
export const DEFAULT_INTERVAL_MS = 900

/** 间隔下限。低于这个值等于没节流，直接按限流处理。 */
export const MIN_INTERVAL_MS = 300

/** 间隔上限。再长就不叫流式了，叫「偶尔刷一下」。 */
export const MAX_INTERVAL_MS = 10000

/** 一条流最长活多久（毫秒）。没人 finish 的流不能永久占着内存。 */
export const STREAM_TTL_MS = 30 * 60 * 1000

/** 同时最多开多少条流。挡住「循环里每次都 open 不 finish」的写法。 */
export const MAX_ACTIVE_STREAMS = 64

/**
 * 做不了流式的八个通道，各给一条平台级原因。
 * 前四条（feishu / qq / wechat / email 里能改的）直接沿用 NO_EDIT_REASON ——
 * 改不了自然也就流不了，理由完全一样，没必要换个说法。
 */
export const NO_STREAM_REASON = Object.freeze({
  feishu: NO_EDIT_REASON.feishu,
  qq: NO_EDIT_REASON.qq,
  wechat: NO_EDIT_REASON.wechat,
  synology_chat: NO_EDIT_REASON.synology_chat,
  dingtalk: NO_EDIT_REASON.dingtalk,
  wecom: NO_EDIT_REASON.wecom,
  wecom_app: NO_EDIT_REASON.wecom_app,
  email: '邮件发出去就到对方信箱了，没有「改一封已经投递的邮件」这回事',
})

/** 这个通道能不能流式编辑。 */
export function canStream(channel) {
  return STREAM_CHANNELS.includes(String(channel ?? '').trim())
}

/**
 * 不能流式时给一句人话；能做返回空串（与 edits.js 的 blocker 同一套约定）。
 */
export function streamBlocker(channel) {
  const name = String(channel ?? '').trim()
  if (name === '') return '要给通道名 —— 流式消息必须指定在哪个通道里进行'
  if (canStream(name)) return ''
  const known = NO_STREAM_REASON[name]
  if (known !== undefined) return known
  return '未知通道 ' + name + '，本插件没有这个通道'
}

/**
 * 归一化节流间隔。给得离谱就用默认值，并把「实际用了多少」告诉调用方 ——
 * 静默改成默认值会让调用方以为自己的设置生效了。
 *
 * @param {unknown} input
 * @returns {{ok: boolean, ms: number, detail: string}}
 */
export function normalizeInterval(input) {
  if (input === undefined || input === null || input === '') {
    return { ok: true, ms: DEFAULT_INTERVAL_MS, detail: '' }
  }
  const num = Number(input)
  if (!Number.isFinite(num)) {
    return { ok: true, ms: DEFAULT_INTERVAL_MS, detail: '间隔不是数字，按默认 ' + DEFAULT_INTERVAL_MS + ' 毫秒走' }
  }
  if (num < MIN_INTERVAL_MS) {
    return { ok: true, ms: MIN_INTERVAL_MS, detail: '间隔 ' + num + ' 毫秒太密，按下限 ' + MIN_INTERVAL_MS + ' 毫秒走' }
  }
  if (num > MAX_INTERVAL_MS) {
    return { ok: true, ms: MAX_INTERVAL_MS, detail: '间隔 ' + num + ' 毫秒太长，按上限 ' + MAX_INTERVAL_MS + ' 毫秒走' }
  }
  return { ok: true, ms: Math.floor(num), detail: '' }
}

/**
 * 把最终正文切成「首块 + 余块」。
 *
 * 首块要放进那条已经在编辑的消息里，余块只能另发新消息 —— 因为一条消息的
 * 字数上限是通道定的，改不出来。
 *
 * 切法与 lib/text.js 的 splitBlocks 一致（按行切、单行超长才硬切），
 * 这里不重复实现，由调用方把 splitBlocks 注进来；这样两处切法永远一致。
 *
 * @param {(text: string, limit: number) => string[]} split
 * @param {string} text
 * @param {number} limit
 */
export function planChunks(split, text, limit) {
  const blocks = split(String(text ?? ''), limit)
  return { first: blocks[0] ?? '', rest: blocks.slice(1) }
}

/**
 * 造一条流。所有发送能力从参数注入，本函数不碰网络。
 *
 * @param {object} options
 * @param {string} [options.initialText] 一开始就显示出来的那句话
 * @param {number} options.limit 单条消息字数上限（通道定的）
 * @param {number} [options.intervalMs] 节流间隔
 * @param {(text: string) => Promise<any>} options.create 造一条新消息，返回消息 id
 * @param {(messageId: string, text: string) => Promise<{ok: boolean, detail?: string}>} options.edit 编辑一条消息
 * @param {(text: string) => Promise<any>} options.sendRemainder 发余块，返回该块的发送结果
 * @param {(split: Function, text: string, limit: number) => {first: string, rest: string[]}} [options.splitter]
 * @param {(level: string, message: string) => void} [options.onLog]
 * @returns {object}
 */
export function createStream(options = {}) {
  const initialText = String(options.initialText ?? '正在处理…')
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : 2000
  const gap = normalizeInterval(options.intervalMs).ms
  const create = options.create
  const edit = options.edit
  const sendRemainder = options.sendRemainder
  const splitter = options.splitter
  const onLog = typeof options.onLog === 'function' ? options.onLog : () => {}

  /** @type {'new'|'opening'|'open'|'finished'|'cancelled'|'failed'} */
  let status = 'new'
  let messageId = ''
  let lastSent = initialText
  let pending = ''
  let timer = null
  let chain = Promise.resolve()
  let closedResult = null
  const messageIds = []
  const failures = []
  let updates = 0
  let edits = 0
  let createdAt = Date.now()

  const remember = (id) => {
    const text = String(id ?? '').trim()
    if (text !== '' && !messageIds.includes(text)) messageIds.push(text)
  }

  /**
   * 把所有对外发送串到一条链上。链上的错误不会打断链本身 ——
   * 这正是「一次抖动不废整条流」的落点。
   */
  const enqueue = (task) => {
    chain = chain.then(task).catch((err) => {
      failures.push({ at: Date.now(), detail: String(err?.message ?? err).slice(0, 200) })
      onLog('warn', '流式编辑失败：' + String(err?.message ?? err))
    })
    return chain
  }

  const flush = () => {
    if (status !== 'open' || pending === '' || timer !== null) return
    timer = setTimeout(() => {
      timer = null
      if (status !== 'open' || pending === '') return
      const text = pending
      pending = ''
      if (text === lastSent) return
      // 只送首块：正在编辑的这条消息只能放得下 limit 个字。
      const first = planChunks(splitter ?? ((t, l) => [t]), text, limit).first
      if (first === lastSent) return
      enqueue(async () => {
        if (status !== 'open') return
        const outcome = await edit(messageId, first)
        edits += 1
        if (outcome?.ok === true) {
          lastSent = first
        } else {
          failures.push({ at: Date.now(), detail: String(outcome?.detail ?? '编辑失败').slice(0, 200) })
        }
      })
    }, gap)
    if (typeof timer?.unref === 'function') timer.unref()
  }

  return {
    get status() { return status },
    get messageId() { return messageId },
    get messageIds() { return [...messageIds] },
    get failures() { return failures.map((one) => ({ ...one })) },
    get stats() { return { updates, edits, failures: failures.length, createdAt, intervalMs: gap } },

    /** 造出第一条消息，进入 open 状态。 */
    async start() {
      if (status !== 'new') throw new Error('这条流已经开过了（当前状态：' + status + '）')
      status = 'opening'
      try {
        const id = await create(initialText)
        messageId = String(id ?? '').trim()
        remember(messageId)
        lastSent = initialText
        status = 'open'
        return messageId
      } catch (err) {
        status = 'failed'
        failures.push({ at: Date.now(), detail: '开流失败：' + String(err?.message ?? err).slice(0, 200) })
        throw err
      }
    },

    /**
     * 送一次更新。真正的发送由节流定时器决定，这里只记下来。
     * 空文本不覆盖 —— 把「还没想好」误当成「清空」是很糟的默认值。
     */
    update(text) {
      if (status !== 'open') return false
      const body = String(text ?? '')
      if (body.trim() === '') return false
      pending = body
      updates += 1
      flush()
      return true
    },

    /**
     * 定稿。把首块放进原消息，其余块逐条补发。
     * 幂等：第二次调用原样返回第一次的结果，不重复发。
     */
    async finish(text) {
      if (status === 'finished' || status === 'cancelled') return closedResult
      if (status !== 'open') throw new Error('这条流没开成（当前状态：' + status + '），没法定稿')
      status = 'finished'
      if (timer !== null) { clearTimeout(timer); timer = null }
      pending = ''

      const finalText = String(text ?? '')
      const plan = planChunks(splitter ?? ((t) => [t]), finalText, limit)
      const first = plan.first === '' ? initialText : plan.first
      let finalOk = true
      let finalDetail = ''

      await chain
      enqueue(async () => {
        if (first === lastSent) return
        const outcome = await edit(messageId, first)
        edits += 1
        if (outcome?.ok === true) {
          lastSent = first
        } else {
          finalOk = false
          finalDetail = String(outcome?.detail ?? '定稿编辑失败')
          failures.push({ at: Date.now(), detail: finalDetail.slice(0, 200) })
        }
      })
      await chain

      for (const chunk of plan.rest) {
        try {
          const result = await sendRemainder(chunk)
          const id = result?.messageIds?.[0] ?? result?.messageId ?? result?.id ?? result
          remember(id)
        } catch (err) {
          finalOk = false
          finalDetail = '余块补发失败：' + String(err?.message ?? err).slice(0, 200)
          failures.push({ at: Date.now(), detail: finalDetail })
        }
      }

      closedResult = {
        ok: finalOk,
        detail: finalOk ? '已定稿' : finalDetail,
        messageId,
        messageIds: [...messageIds],
        chunks: plan.rest.length + 1,
        edits,
        updates,
        failures: failures.length,
      }
      return closedResult
    },

    /** 放弃这条流。已经发出去的那条消息保留原样（不删 —— 删是另一个语义，要用 deleteMessage）。 */
    cancel() {
      if (status === 'finished' || status === 'cancelled') return closedResult
      status = 'cancelled'
      if (timer !== null) { clearTimeout(timer); timer = null }
      pending = ''
      closedResult = { ok: true, detail: '已放弃（已经发出去的那条消息留在那里）', messageId, messageIds: [...messageIds], edits, updates, failures: failures.length }
      return closedResult
    },
  }
}

/**
 * 一个进程里管多条流：造 id、查状态、定稿、回收超时的。
 *
 * 单独抽一层是因为「谁来记着这些流」不该由每条流自己管 —— 流自己不知道
 * 还有多少同类活着，也不知道该在什么时候被回收。
 *
 * @param {object} [options]
 * @param {number} [options.ttlMs]
 * @param {number} [options.maxActive]
 * @param {() => number} [options.now]
 */
export function createStreamHub(options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : STREAM_TTL_MS
  const maxActive = Number.isFinite(options.maxActive) ? options.maxActive : MAX_ACTIVE_STREAMS
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  /** @type {Map<string, {stream: any, meta: any}>} */
  const live = new Map()
  let counter = 0

  const sweep = () => {
    const edge = now() - ttlMs
    const dropped = []
    for (const [id, one] of live) {
      if (one.meta.createdAt < edge) {
        try { one.stream.cancel() } catch { /* 回收失败不该影响别人 */ }
        live.delete(id)
        dropped.push(id)
      }
    }
    return dropped
  }

  return {
    /** 现在活着几条。 */
    get size() { return live.size },
    /** 把超时的流掐掉，返回被掐掉的 id。由调用方在合适的时机调（本模块不开定时器）。 */
    sweep,
    /**
     * 开一条流。id 由这里发，调用方不用自己编。
     * @returns {{ok: boolean, detail: string, id?: string, stream?: any}}
     */
    open(factory) {
      sweep()
      if (live.size >= maxActive) {
        return { ok: false, detail: '同时最多 ' + maxActive + ' 条流，先把不用的 finish 或 cancel 掉（当前 ' + live.size + ' 条）' }
      }
      counter += 1
      const id = 'st' + now().toString(36) + '-' + counter.toString(36)
      const stream = factory()
      live.set(id, { stream, meta: { createdAt: now(), id } })
      return { ok: true, detail: '', id, stream }
    },
    get(id) {
      const one = live.get(String(id ?? ''))
      return one === undefined ? null : one.stream
    },
    /** 拿不到就返回 null，不抛 —— 调用方要能区分「没这条流」和「流报错」。 */
    drop(id) {
      return live.delete(String(id ?? ''))
    },
    /** 只读快照，给状态接口用。 */
    list() {
      const out = []
      for (const [id, one] of live) {
        out.push({ id, status: one.stream.status, createdAt: one.meta.createdAt, stats: one.stream.stats })
      }
      return out
    },
  }
}
