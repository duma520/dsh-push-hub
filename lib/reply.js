/**
 * lib/reply.js — 「回复某条消息」的通道无关中间表示。
 *
 * 为什么要有这一层，和 lib/buttons.js 是同一个理由：五家的「回复」根本不是一回事。
 *
 *   Telegram  reply_parameters: { message_id, allow_sending_without_reply: true }
 *             —— 消息下面挂一条引用条，被引用消息删了也不会发失败
 *   Slack     thread_ts: "1699999999.123456"
 *             —— **不是引用，是开线程**。Slack 没有「引用某条消息」这个概念，
 *                回复就是进那条消息所在的线程；顶层消息的 ts 即线程根
 *   Discord   message_reference: { message_id, channel_id, fail_if_not_exists: false }
 *             —— 显示成一条被引用的消息块
 *   Matrix    content 里 m.relates_to: { "m.in_reply_to": { event_id } }
 *             —— 同时 body 要以 "> <@user> ..." 开头，否则老客户端只看到一段普通文本
 *   QQ        msg_id + msg_seq（被动回复）
 *             —— 只能回**别人刚发给你的那条**，且有窗口期；主动发消息填不了
 *
 * 如果让调用方自己拼，那「同一句话回给五个通道」就没法写了。
 *
 * 一条纪律：**reply 只挂在最后一块**。本插件把长文本切块发，
 * 若每块都带引用，Telegram 里会出现 N 条并排引用条，用户看不出哪条是主回复。
 *
 * @module reply
 */

/** 一条消息 ID 的最大可接受长度。四家最长的（Matrix event_id）是 `$` + 随机串，远小于此。 */
export const MAX_REPLY_ID_LENGTH = 512

/**
 * 归一化一个消息 ID。
 *
 * @param {any} input
 * @returns {{ok: true, id: string} | {ok: false, detail: string}}
 */
export function normalizeReplyId(input) {
  if (input === undefined || input === null) return { ok: true, id: '' }
  if (typeof input !== 'string' && typeof input !== 'number') {
    return { ok: false, detail: '要回复的消息 ID 必须是字符串（现在给的是 ' + typeof input + '）' }
  }
  const id = String(input).trim()
  if (id === '') return { ok: true, id: '' }
  if (id.length > MAX_REPLY_ID_LENGTH) {
    return { ok: false, detail: '消息 ID 有 ' + id.length + ' 个字符，超过上限 ' + MAX_REPLY_ID_LENGTH + ' —— 大概是把整段消息正文当成 ID 了' }
  }
  return { ok: true, id }
}

/**
 * 去掉一个消息 ID 的可读描述，用来写进「已发送」的 detail。
 *
 * @param {string} id
 * @returns {string}
 */
export function describeReply(id) {
  const s = String(id ?? '').trim()
  if (s === '') return '不引用'
  return '引用 ' + (s.length > 16 ? s.slice(0, 8) + '…' + s.slice(-4) : s)
}

/**
 * 按通道生成「回复」所需的字段。返回 `null` 表示该通道不支持。
 *
 * @param {string} channel
 * @param {string} messageId
 * @param {{channelId?: string}} [extra]  Discord 的 message_reference 要带 channel_id
 * @returns {object|null}
 */
export function replyFor(channel, messageId, extra = {}) {
  const id = String(messageId ?? '').trim()
  if (id === '') return null
  if (channel === 'telegram') {
    // allow_sending_without_reply：被引用的那条被删了也照发，不要整条 400。
    return { reply_parameters: { message_id: id, allow_sending_without_reply: true } }
  }
  if (channel === 'slack') {
    // Slack 的「回复」= 进线程。thread_ts 用被回复消息的 ts。
    return { thread_ts: id }
  }
  if (channel === 'discord') {
    const channelId = String(extra?.channelId ?? '').trim()
    return {
      message_reference: {
        message_id: id,
        ...(channelId === '' ? {} : { channel_id: channelId }),
        fail_if_not_exists: false,
      },
    }
  }
  if (channel === 'matrix') {
    // m.in_reply_to 放在 content 里，不是顶层字段 —— 由通道实现合并进去。
    return { 'm.relates_to': { 'm.in_reply_to': { event_id: id } } }
  }
  if (channel === 'qq') {
    // QQ 是被动回复：msg_id 指向刚收到的那条，msg_seq 保证同一 msg_id 下不撞。
    return { msg_id: id, msg_seq: 1 }
  }
  return null
}

/**
 * Matrix 的引用还需要在正文前加一行 `> <event_id>`。
 *
 * 官方客户端认得 m.relates_to，但第三方客户端（尤其是老的）只渲染正文；
 * 不带这一行，对方看到的是一段孤立的文本，完全不知道在回谁。
 *
 * @param {string} text
 * @param {string} messageId
 * @returns {string}
 */
export function matrixQuotePrefix(text, messageId) {
  const id = String(messageId ?? '').trim()
  if (id === '') return text
  const body = String(text ?? '')
  const NL = String.fromCharCode(10)
  const first = body.split(NL)[0]
  return '> ' + (first.length > 80 ? first.slice(0, 80) + '…' : first) + NL + NL + body
}

/** 支持「回复」的通道（按实际实现了翻译来定，不是「我猜它能」）。 */
export const REPLY_CHANNELS = Object.freeze(['telegram', 'slack', 'discord', 'matrix', 'qq'])

/** 该通道不支持回复时，给人看的原因。 */
export const NO_REPLY_REASON = Object.freeze({
  feishu: '飞书要回某条消息得走 POST /open-apis/im/v1/messages/:message_id/reply，与本插件现在用的 send 端点不是同一个，还没做',
  wechat: '微信 iLink 的 sendmessage 没有引用字段',
  dingtalk: '钉钉群机器人只能发新消息，没有引用字段',
  wecom: '企业微信群机器人只能发新消息，没有引用字段',
  wecom_app: '企业微信自建应用的引用要 message/appchat 的 quote 参数，还没做',
  synology_chat: '群晖 Chat 只收文本与附件，没有引用字段',
  email: '邮件用 In-Reply-To / References 头标准引用，与本插件的「一次性发信」定位不同，还没做',
})
