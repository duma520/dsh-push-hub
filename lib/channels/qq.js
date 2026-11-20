/**
 * lib/channels/qq.js — QQ 官方机器人（QQ 开放平台）。
 *
 * 与 Python 版 pushhub/channels/qq.py 对齐。最大的坑是授权头：
 *   Authorization: QQBot <access_token>     ← 正确
 *   Authorization: Bearer <access_token>    ← 会 401
 *
 * 群聊与 @（2026-11 官方协议）：
 *   - 单聊：POST /v2/users/<openid>/messages
 *   - 群聊：POST /v2/groups/<group_openid>/messages   ← 完全不同的端点
 *     所以账号必须显式声明 target.kind='group'，不能靠 ID 猜。
 *   - @ 用内联标签（旧的 <@userid> / @everyone 官方已标记即将弃用）：
 *       <qqbot-at-user id="<member_openid>" />    @单个成员
 *       <qqbot-at-everyone />                     @所有人（需群管理员，每群每天 1 次）
 *     注意 id 填的是 **member_openid**，不是 QQ 号数字。
 *
 * @module channels/qq
 */

import { postJson, parseJson } from '../http.js'
import { splitBlocks, sleep } from '../text.js'
import { targetOf, mentionOf, describeTarget } from '../mentions.js'
import { replyFor, describeReply, normalizeReplyId } from '../reply.js'

export const NAME = 'qq'
export const MAX_CHARS = 1800
export const TITLE = 'QQ'

/** 把 @ 标签拼进正文。 */
function withMentions(block, mention, isGroup) {
  if (mention.mode === 'none') return { text: block, note: '' }
  if (mention.mode === 'all') {
    if (!isGroup) return { text: block, note: '；单聊里不能 @所有人，已忽略' }
    return { text: '<qqbot-at-everyone /> ' + block, note: '' }
  }
  const tags = mention.ids.map((id) => '<qqbot-at-user id="' + id + '" /> ').join('')
  const note = isGroup ? '' : '；单聊里 @ 群成员可能被忽略'
  return { text: tags + block, note }
}

/**
 * 取 app access token。
 *
 * 导出是为了给 lib/receiver.js 的 QQ 接收用 —— 发消息与收消息用的是同一把
 * token（都从 appId + clientSecret 换），复制一份逻辑迟早会漂移。
 */
export async function appToken(acc, proxy) {
  const { status, body } = await postJson(
    'https://bots.qq.com/app/getAppAccessToken',
    { appId: String(acc?.appId ?? acc?.app_id ?? ''), clientSecret: String(acc?.appSecret ?? acc?.clientSecret ?? acc?.secret ?? '') },
    { proxy },
  )
  if (status === null) return { ok: false, detail: '取 token 连不上: ' + body }
  const data = parseJson(body, {}) ?? {}
  if (status !== 200) return { ok: false, detail: '取 token 失败 HTTP ' + status + ': ' + body.slice(0, 200) }
  const token = String(data?.access_token ?? '').trim()
  if (token === '') return { ok: false, detail: '取 token 成功但返回为空: ' + body.slice(0, 200) }
  return { ok: true, token }
}

/** 发一条消息（内部按 MAX_CHARS 分块）。 */
export async function send(text, acc, options = {}) {
  const appId = String(acc?.appId ?? acc?.app_id ?? '').trim()
  const secret = String(acc?.appSecret ?? acc?.clientSecret ?? acc?.secret ?? '').trim()
  if (appId === '' || secret === '') return { ok: false, detail: '账号缺少 appId / clientSecret' }

  const target = targetOf(acc)
  if (target === null) {
    return { ok: false, detail: '还没选「发送到」。凭据没问题，只是不知道发给谁 —— QQ 官方不提供列会话接口，需要先在群里 @ 一次机器人，再到开放平台后台「消息推送」日志里复制 group_openid（群）或 openid（单聊），填到「发送到」里。' }
  }
  const isGroup = target.kind === 'group'

  const mention = mentionOf(acc)
  const proxy = String(acc?.proxy ?? '').trim()
  const limit = Number(acc?.maxMessageChars) > 0 ? Number(acc.maxMessageChars) : MAX_CHARS
  const delay = Number(options.delayMs) >= 0 ? Number(options.delayMs) : 350

  // v0.25.0：QQ 是被动回复（msg_id + msg_seq），只能回刚收到的那条且有窗口期。
  const parsedReply = normalizeReplyId(options?.replyTo)
  if (parsedReply.ok !== true) return { ok: false, detail: '要回复的消息 ID 不对：' + parsedReply.detail }
  const replyTo = parsedReply.id

  const auth = await appToken(acc, proxy)
  if (!auth.ok) return { ok: false, detail: auth.detail }

  const seg = isGroup ? 'groups' : 'users'
  const url = 'https://api.sgroup.qq.com/v2/' + seg + '/' + encodeURIComponent(target.id) + '/messages'
  const blocks = splitBlocks(text, limit)
  let sent = 0
  let note = ''
  // v0.28.0：QQ 的回包里有 id，但官方没有「编辑消息 / 撤回 / 加表情」接口，
  // 所以这个 id 只用于留痕（看出去了几条），动不了。
  const ids = []
  for (let i = 0; i < blocks.length; i += 1) {
    const packed = withMentions(blocks[i], mention, isGroup)
    if (packed.note !== '') note = packed.note
    const { status, body } = await postJson(
      url,
      { content: packed.text, msg_type: 0, ...(replyTo !== '' && i === blocks.length - 1 ? replyFor('qq', replyTo) : {}) },
      { headers: { Authorization: 'QQBot ' + auth.token }, proxy },
    )
    if (status === null) return { ok: false, detail: '第 ' + (i + 1) + '/' + blocks.length + ' 块连不上: ' + body }
    if (status !== 200 && status !== 201) {
      return { ok: false, detail: '第 ' + (i + 1) + '/' + blocks.length + ' 块失败 HTTP ' + status + ': ' + body.slice(0, 200) }
    }
    const qid = String(parseJson(body, {})?.id ?? '').trim()
    if (qid !== '') ids.push(qid)
    sent += 1
    if (i < blocks.length - 1) await sleep(delay)
  }
  return { ok: true, detail: '已发送 ' + sent + ' 块（' + describeTarget(target) + '）' + note + (replyTo === '' ? '' : '；' + describeReply(replyTo)), messageIds: ids }
}

/** 探测：拉一次 access_token 就说明凭据可用（不依赖有没有互动的用户）。 */
export async function probe(acc) {
  const appId = String(acc?.appId ?? '').trim()
  const secret = String(acc?.appSecret ?? '').trim()
  if (appId === '' || secret === '') return { ok: false, detail: '缺少 appId / appSecret' }
  const r = await appToken(acc, String(acc?.proxy ?? '').trim())
  return r.ok ? { ok: true, detail: '凭据可用（appId=' + appId + '）' } : { ok: false, detail: r.detail }
}
