/**
 * lib/edits.js — 改消息与撤回消息的通道无关中间层。
 *
 * 为什么要有这一层：v0.28.0 之前十二个通道发完就忘，连「发出去的那条叫什么」
 * 都没留下，于是改 / 撤 / 加表情三件事一件也做不了。v0.28.0 把 message id 记进了
 * 发件箱，但 id 只是「名字」—— 要在平台上动那一条，还得三样东西凑齐：
 *
 *   1. 通道      telegram / slack / discord / matrix / 飞书
 *   2. 凭据      该通道该账号的 token（从 config.json 的 own_bots 取）
 *   3. 位置      chat_id / channel / room  —— 光有消息 id 平台不知道去哪找
 *
 * 这一层只回答「哪几个通道能做、名字怎么验、位置从哪来」，
 * 具体协议仍在各自的 channels/*.js 里（每家的差异太大，硬抽会把三家都写歪）。
 *
 * 五家的改，语义其实不是一回事：
 *   telegram  editMessageText   原地改，客户端看到「已编辑」
 *   slack     chat.update       原地改，客户端看到「已编辑」
 *   discord   PATCH messages/:id 原地改
 *   matrix    m.replace 事件     再发一条带 m.new_content 的事件，客户端把它
 *                                渲染成原事件的修改版 —— 严格说不是编辑
 *   feishu    PATCH messages/:id 原地改
 *
 * 撤则是四家真删、matrix 走 redact（客户端显示为「消息已被删除」）。
 *
 * @module edits
 */

/** 能改消息的通道。 */
export const EDIT_CHANNELS = Object.freeze(['telegram', 'slack', 'discord', 'matrix'])

/** 能撤回消息的通道。目前与 EDIT_CHANNELS 一致，但分开写 —— 以后某家只支持其中一项时不用改调用方。 */
export const DELETE_CHANNELS = Object.freeze(['telegram', 'slack', 'discord', 'matrix'])

/** 改不了的原因（按通道）。 */
export const NO_EDIT_REASON = Object.freeze({
  // 飞书单独说明：官方确有 PATCH /open-apis/im/v1/messages/:message_id，
  // 但它的 msg_type / content 参数形态在不同版本上不一致（社区里有
  // 「invalid msg_type」的实测报错），本机没有可用飞书凭据去实测，
  // 所以先不做 —— 宁可不给按钮，也不给一个按下去必然报错的按钮。
  feishu: '飞书官方有 PATCH 改消息的接口，但本机无凭据实测过它的参数形态，暂时不做（宁可没有，也不要一个按下去必然报错的按钮）',
  qq: 'QQ 官方接口没有编辑消息的能力',
  wechat: '微信 iLink 没有编辑消息的接口',
  dingtalk: '钉钉机器人只能发新消息，发出去的改不了',
  wecom: '企业微信群机器人只能发新消息',
  wecom_app: '企业微信自建应用没有编辑已发消息的接口',
  synology_chat: '群晖 Chat 只能往里推新消息（改消息需要能定位到原消息，这两种整合都没有接口）',
  email: '邮件发出去了就收不回，没有编辑接口（真要更正只能再发一封）',
})

/** 撤不了的原因（按通道）。 */
export const NO_DELETE_REASON = Object.freeze({
  feishu: '飞书官方有 DELETE 撤回接口，但本机无凭据实测过，暂时不做',
  qq: 'QQ 官方接口没有撤回第三方消息的能力（只有客户端里手动撤回自己发的）',
  wechat: '微信 iLink 没有撤回接口',
  dingtalk: '钉钉机器人发出去的消息撤不回',
  wecom: '企业微信群机器人撤不回已发消息',
  wecom_app: '企业微信自建应用没有撤回接口',
  synology_chat: '群晖 Chat 是单向推送，撤不回',
  email: '邮件已经投递到对方信箱，撤不回',
})

/** 消息 id 最长多少。Discord 的 snowflake 19 位、Matrix 的 event_id 可以上百字符，给足余量。 */
export const MAX_MESSAGE_ID_LENGTH = 512

/**
 * 校验一个消息 id。
 *
 * undefined / null / 空串一律返回空 id 且 ok:true —— 「没指定」不是错误，
 * 由调用方决定这时候要报什么。
 */
export function normalizeMessageId(input) {
  if (input === undefined || input === null) return { ok: true, id: '' }
  if (typeof input !== 'string' && typeof input !== 'number') {
    return { ok: false, detail: '消息 ID 必须是字符串（现在给的是 ' + typeof input + '）' }
  }
  const id = String(input).trim()
  if (id === '') return { ok: true, id: '' }
  if (id.length > MAX_MESSAGE_ID_LENGTH) {
    return { ok: false, detail: '消息 ID 有 ' + id.length + ' 个字符，超过 ' + MAX_MESSAGE_ID_LENGTH + ' —— 大概是整段消息正文被当成 ID 了' }
  }
  return { ok: true, id }
}

/** 给人看的短描述（长的截断，日志与界面都用它）。 */
export function describeMessageId(id) {
  const text = String(id ?? '').trim()
  if (text === '') return '（没指定消息 ID）'
  return text.length <= 16 ? text : text.slice(0, 8) + '…' + text.slice(-4)
}

/** 这个通道能不能改。 */
export function canEdit(channel) {
  return EDIT_CHANNELS.includes(String(channel ?? ''))
}

/** 这个通道能不能撤。 */
export function canDelete(channel) {
  return DELETE_CHANNELS.includes(String(channel ?? ''))
}

/** 改不了时给人看的理由；能改则返回空串。 */
export function editBlocker(channel) {
  const name = String(channel ?? '')
  if (EDIT_CHANNELS.includes(name)) return ''
  return NO_EDIT_REASON[name] ?? '这个通道还没有改消息的实现'
}

/** 撤不了时给人看的理由；能撤则返回空串。 */
export function deleteBlocker(channel) {
  const name = String(channel ?? '')
  if (DELETE_CHANNELS.includes(name)) return ''
  return NO_DELETE_REASON[name] ?? '这个通道还没有撤回消息的实现'
}

/**
 * 从一条发件箱记录里取出「在哪个位置动哪几条消息」。
 *
 * 为什么需要它：发件箱条目里的 messageIds 是**摊平**的数组 —— 一个账号发到多个
 * 目标时，数组里混着几个聊天的 id，谁属于谁分不清。所以记账时同时存 places
 * （每组 {id, messageIds}）。老条目没有 places 时退回「单目标」假设。
 */
export function placesOf(entry) {
  const places = Array.isArray(entry?.places) ? entry.places : []
  const clean = []
  for (const one of places) {
    if (one === null || typeof one !== 'object') continue
    const id = String(one?.id ?? '').trim()
    if (id === '') continue
    const ids = Array.isArray(one?.messageIds)
      ? one.messageIds.map((v) => String(v ?? '').trim()).filter((v) => v !== '')
      : []
    clean.push({ id, messageIds: ids })
  }
  if (clean.length > 0) return clean
  // 老条目（v0.28.0 记的）没有 places：target 是单值时能用，多目标 join 的
  // 「A、B」分不清，这时只回去一条并标明不可定位。
  const target = String(entry?.target ?? '').trim()
  const ids = Array.isArray(entry?.messageIds)
    ? entry.messageIds.map((v) => String(v ?? '').trim()).filter((v) => v !== '')
    : []
  if (target === '' || target.includes('、')) return []
  return [{ id: target, messageIds: ids }]
}

/** 一条记录里总共有多少个可操作的消息 id。 */
export function countIds(entry) {
  return placesOf(entry).reduce((sum, one) => sum + one.messageIds.length, 0)
}
