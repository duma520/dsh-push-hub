/**
 * lib/reactions.js — 表情回应（v0.30.0）。
 *
 * 这一层只管两件事：**谁能做**、**表情怎么交出去**。真正发请求在
 * lib/channels/*.js 的 addReaction / removeReaction 里。
 *
 * 四家支持的形态差别很大，这是本模块存在的唯一理由：
 *
 *   | 通道     | 交出去的是什么                       | 清除的方式             |
 *   |----------|--------------------------------------|------------------------|
 *   | telegram | Unicode 字符（👍）                   | reaction: []（空数组） |
 *   | slack    | **名字**（thumbsup，不带冒号）       | reactions.remove       |
 *   | discord  | Unicode 或 name:id（自定义表情）     | @me 的 DELETE          |
 *   | matrix   | 任意字符串 key（Unicode 直接当 key） | 发新的 m.reaction      |
 *
 * ★ 最容易踩的坑：**Slack 不认 Unicode**。
 *   reactions.add 的 name 参数要的是 `thumbsup` 这种名字，你传 `👍`
 *   它会回 invalid_name —— 但 HTTP 还是 200，只看状态码会以为成功。
 *   所以这里带一张 Unicode → Slack 名字的对照表；表里没有的，
 *   直接让用户填名字，而不是猜一个名字发出去。
 *
 * ★ 第二个坑：**Discord 的自定义表情必须是 `name:id`**。
 *   服务器自定义表情有数字 id，只写 `:blob:` 是找不到的，必须写
 *   `blob:1234567890`。Unicode 字符则原样 URL 编码后放进路径。
 *
 * @module reactions
 */

/** 能加表情回应的通道。与改/撤恰好是同一批，但这是巧合 —— 分开写，谁变了不影响谁。 */
export const REACTION_CHANNELS = Object.freeze(['telegram', 'slack', 'discord', 'matrix'])

/** 表情 key 的长度上限。emoji 再长也就几个码点，超过这个数大概是整段正文被当成表情了。 */
export const MAX_EMOJI_LENGTH = 64

/**
 * 不能加表情的通道，以及为什么。
 *
 * 写「为什么」而不是只写「不支持」，是因为用户看到「不支持」只会反复试；
 * 看到「飞书开放平台没有表情回应接口」才知道这是平台天花板。
 */
export const NO_REACTION_REASON = Object.freeze({
  feishu: '飞书开放平台没有「给消息加表情回应」的接口（本机也没飞书凭据实测过）',
  qq: 'QQ 机器人开放接口没有表情回应能力',
  wechat: '微信通道连发送都恒返 ret=-2（服务端故障），谈表情没有意义',
  synology_chat: '群晖 Chat 只能发文本，没有表情接口',
  dingtalk: '钉钉自定义机器人只有 text/markdown/link 等消息类型，不能对已有消息加表情',
  wecom: '企业微信群机器人只能发消息，不能对已有消息加表情',
  wecom_app: '企业微信自建应用的发消息接口没有表情回应字段',
  email: '邮件没有「表情回应」这个概念',
})

/**
 * Unicode → Slack 名字。
 *
 * 只收确定的、Slack 官方名字没变过的那些。**不追求全覆盖** ——
 * 猜错名字比不映射更糟：用户会以为「这个表情 Slack 不支持」，
 * 实际是名字写错了。表里没有的，让用户直接填名字。
 */
const SLACK_NAMES = Object.freeze({
  '👍': 'thumbsup',
  '👎': 'thumbsdown',
  '❤️': 'heart',
  '❤': 'heart',
  '💔': 'broken_heart',
  '🔥': 'fire',
  '🎉': 'tada',
  '🚀': 'rocket',
  '👀': 'eyes',
  '✅': 'white_check_mark',
  '☑️': 'ballot_box_with_check',
  '❌': 'x',
  '⚠️': 'warning',
  '🙏': 'pray',
  '😄': 'smile',
  '😀': 'grinning',
  '😁': 'grin',
  '😂': 'joy',
  '😊': 'blush',
  '😍': 'heart_eyes',
  '🤔': 'thinking_face',
  '😢': 'cry',
  '😭': 'sob',
  '😅': 'sweat_smile',
  '😎': 'sunglasses',
  '🤝': 'handshake',
  '💯': '100',
  '⭐': 'star',
  '✨': 'sparkles',
  '💡': 'bulb',
  '📌': 'pushpin',
  '🐛': 'bug',
  '⚡': 'zap',
  '🎯': 'dart',
})

/** 剪空白；`:name:` 这种带冒号的写法把冒号去掉（Slack 的名字不带冒号）。 */
export function normalizeEmoji(input) {
  let text = String(input ?? '').trim()
  if (text === '') return { ok: true, emoji: '' }
  // :thumbsup: → thumbsup（只处理两端都有冒号且中间没有冒号的情况）
  if (text.length > 2 && text.startsWith(':') && text.endsWith(':')) {
    const inner = text.slice(1, -1)
    if (inner !== '' && !inner.includes(':')) text = inner
  }
  if (text.length > MAX_EMOJI_LENGTH) {
    return {
      ok: false,
      emoji: '',
      detail: '表情有 ' + text.length + ' 个字符，太长了 —— 大概是整段消息正文被当成表情了',
    }
  }
  return { ok: true, emoji: text }
}

/**
 * 把表情转成 Slack 要的名字。
 *
 * 已经是纯 ASCII 名字（thumbsup / +1 / 100）→ 原样用，但 +1 / -1 转成
 * thumbsup / thumbsdown（Slack 两个都认，规范化一下更好排错）。
 * 是 Unicode → 查表。查不到就**明确失败**，不猜。
 */
export function slackNameOf(emoji) {
  const raw = String(emoji ?? '').trim()
  if (raw === '') return { ok: true, name: '' }
  // 纯 ASCII 名字：字母数字下划线加减号
  if (/^[A-Za-z0-9_+-]+$/.test(raw)) {
    if (raw === '+1') return { ok: true, name: 'thumbsup' }
    if (raw === '-1') return { ok: true, name: 'thumbsdown' }
    return { ok: true, name: raw }
  }
  // 首尾冒号再去一次（调用方可能直接传 :thumbsup:）
  const stripped = raw.startsWith(':') && raw.endsWith(':') ? raw.slice(1, -1) : raw
  if (/^[A-Za-z0-9_+-]+$/.test(stripped)) {
    if (stripped === '+1') return { ok: true, name: 'thumbsup' }
    if (stripped === '-1') return { ok: true, name: 'thumbsdown' }
    return { ok: true, name: stripped }
  }
  const mapped = SLACK_NAMES[raw] ?? SLACK_NAMES[stripped]
  if (mapped !== undefined) return { ok: true, name: mapped }
  return {
    ok: false,
    name: '',
    detail: 'Slack 认的是表情名字（例如 thumbsup），不是这个字符。它不在本插件的对照表里 —— 请直接填 Slack 的名字，别填 emoji',
  }
}

/** 人能看的写法：太长的截断，空的写「全部」。 */
export function describeEmoji(emoji) {
  const text = String(emoji ?? '').trim()
  if (text === '') return '全部'
  if (text.length <= 8) return text
  return text.slice(0, 8) + '…'
}

export function canReact(channel) {
  return REACTION_CHANNELS.includes(String(channel ?? '').trim())
}

/** 能加就返回空串，不能就返回理由（给界面与错误信息直接用）。 */
export function reactionBlocker(channel) {
  const name = String(channel ?? '').trim()
  if (name === '') return '未知通道'
  if (canReact(name)) return ''
  const why = NO_REACTION_REASON[name]
  if (why !== undefined) return why
  return '这个通道没有表情回应能力'
}
