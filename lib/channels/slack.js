/**
 * lib/channels/slack.js — Slack（Web API chat.postMessage）。
 *
 * 端点：POST https://slack.com/api/chat.postMessage
 * 头：Authorization: Bearer xoxb-…（Bot User OAuth Token）
 * 体：{ channel, text }
 *
 * 成功判据是响应体 ok === true —— **Slack 出业务错时 HTTP 仍是 200**，
 * 只看状态码会把失败当成功，这是 Slack Web API 的通用坑。
 *
 * channel 可以填 #频道名（需要机器人已被拉进该频道）或频道 ID（C 开头）。
 * 机器人 scope 至少要有 chat:write。
 *
 * 已知限流：chat.postMessage 大约每秒 1 条，超了返 ok:false + error='ratelimited'。
 *
 * @module channels/slack
 */

import { postJson, postForm, postBytes, parseJson } from '../http.js'
import { splitBlocks, sleep } from '../text.js'
import { targetOf, describeTarget } from '../mentions.js'
import { parseButtons, toSlack, describeButtons } from '../buttons.js'
import { replyFor, describeReply, normalizeReplyId } from '../reply.js'

export const NAME = 'slack'
export const MAX_CHARS = 3800
export const TITLE = 'Slack'

/** Web API 的 error 字段 → 中文可执行说明（Slack 的错误全是短字符串码）。 */
const SLACK_ERRORS = new Map([
  ['not_authed', '没带 token'],
  ['invalid_auth', 'token 无效，去 Slack App 的 OAuth & Permissions 重新安装一次拿 Bot Token'],
  ['token_revoked', 'token 已被撤销，重新安装应用'],
  ['missing_scope', 'token 缺 chat:write 权限，去 OAuth & Permissions 里加上再重装'],
  ['channel_not_found', '找不到这个频道 —— 确认频道 ID/名字对，而且机器人已被邀请进这个频道（在频道里发 /invite @你的机器人）'],
  ['not_in_channel', '机器人不在这个频道里，先在频道里发 /invite @你的机器人'],
  ['is_archived', '这个频道已归档，发不进去'],
  ['ratelimited', '发太快被限流了，等几秒再试'],
  ['msg_too_long', '这一块太长，Slack 不收（把 maxMessageChars 调小）'],
])

function explainSlack(err) {
  const key = String(err ?? '')
  const hit = SLACK_ERRORS.get(key)
  return hit !== undefined ? hit + '（' + key + '）' : key
}

/**
 * 发一条消息（内部按 MAX_CHARS 分块）。
 * @param {string} text
 * @param {Record<string,any>} acc
 * @param {{delayMs?: number}} [options]
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
export async function send(text, acc, options = {}) {
  const token = String(acc?.botToken ?? acc?.token ?? '').trim()
  if (token === '') return { ok: false, detail: '账号缺少 Bot Token（xoxb- 开头）' }
  const target = targetOf(acc)
  if (target === null) {
    return { ok: false, detail: '还没填「发送到」。Slack 必须给频道：填 #频道名 或频道 ID（C 开头）。凭据本身没问题。' }
  }
  // 按钮只挂在最后一块（与 Telegram 同理：挂每一块会导致按一次触发多次）。
  // Slack 的 blocks 与 text 同时给时，客户端优先渲染 blocks，text 退化成
  // 通知预览与无障碍朗读 —— 所以 text 本来就要照传，不是多余字段。
  const parsed = parseButtons(options?.buttons)
  if (parsed.ok !== true) return { ok: false, detail: '按钮格式不对：' + parsed.detail }
  const blockList = parsed.rows.length > 0 ? toSlack(parsed.rows) : null

  // v0.25.0：Slack 没有「引用」概念，回复 = 进线程（thread_ts）。
  const parsedReply = normalizeReplyId(options?.replyTo)
  if (parsedReply.ok !== true) return { ok: false, detail: '要回复的消息 ID 不对：' + parsedReply.detail }
  const replyTo = parsedReply.id

  const proxy = String(acc?.proxy ?? '').trim()
  const limit = Number(acc?.maxMessageChars) > 0 ? Number(acc.maxMessageChars) : MAX_CHARS
  const delay = Number(options.delayMs) >= 0 ? Number(options.delayMs) : 1100
  const blocks = splitBlocks(text, limit)

  let sent = 0
  // v0.28.0：Slack 的消息 id 是 ts（形如 1699999999.123456），改 / 撤都用它。
  const ids = []
  for (let i = 0; i < blocks.length; i += 1) {
    const last = i === blocks.length - 1
    const { status, body } = await postJson(
      'https://slack.com/api/chat.postMessage',
      {
        channel: target.id,
        text: blocks[i],
        ...(blockList !== null && last ? { blocks: blockList } : {}),
        ...(replyTo !== '' && last ? replyFor('slack', replyTo) : {}),
      },
      { proxy, headers: { Authorization: 'Bearer ' + token } },
    )
    if (status === null) return { ok: false, detail: '第 ' + (i + 1) + '/' + blocks.length + ' 块连不上: ' + body }
    const data = parseJson(body, {}) ?? {}
    if (status !== 200 || data.ok !== true) {
      const why = data?.error ? explainSlack(data.error) : String(body).slice(0, 200)
      return { ok: false, detail: '第 ' + (i + 1) + '/' + blocks.length + ' 块失败 HTTP ' + status + ': ' + why }
    }
    const ts = String(data?.ts ?? '').trim()
    if (ts !== '') ids.push(ts)
    sent += 1
    if (i < blocks.length - 1) await sleep(delay)
  }
  return {
    ok: true,
    detail: '已发送 ' + sent + ' 块（' + describeTarget(target) + '）' + (blockList === null ? '' : '；带 ' + describeButtons(parsed.rows)) + (replyTo === '' ? '' : '；回进线程 ' + describeReply(replyTo).replace('引用 ', '')),
    messageIds: ids,
  }
}

/**
 * 发一个文件到频道。
 *
 * Slack 从 2025 年起停用了老的 files.upload，改三段式：
 *   1. files.getUploadURLExternal  → 拿到 file_id + 一次性 upload_url
 *   2. POST 那个 upload_url（裸字节，**不是** multipart）
 *   3. files.completeUploadExternal → 绑定到频道，这一步才真正「发出去」
 *
 * 三步里任何一步成功都不代表发成了：只有第 3 步成功、且回包里能查到自己的
 * file_id，才算真的到了频道里。中途断掉就是「文件已在 Slack 上但没人看得到」，
 * 这里如实这么报，不谎称成功。
 *
 * 需要 scope：files:write。
 *
 * @param {{fileName: string, bytes: Buffer|Uint8Array, mediaType?: string}} file
 * @param {Record<string,any>} acc
 * @param {{caption?: string, delayMs?: number}} [options]
 */
export async function sendFile(file, acc, options = {}) {
  const token = String(acc?.botToken ?? acc?.token ?? '').trim()
  if (token === '') return { ok: false, detail: '账号缺少 Bot Token（xoxb- 开头）' }
  const target = targetOf(acc)
  if (target === null) {
    return { ok: false, detail: '还没填「发送到」。Slack 必须给频道：填 #频道名 或频道 ID（C 开头）。凭据本身没问题。' }
  }
  if (!file || typeof file !== 'object' || typeof file.fileName !== 'string' || file.fileName === '') {
    return { ok: false, detail: '没有可发的文件（缺少文件名）' }
  }
  const proxy = String(acc?.proxy ?? '').trim()
  const bytes = Buffer.isBuffer(file.bytes) ? file.bytes : Buffer.from(file.bytes ?? [])
  const auth = { proxy, headers: { Authorization: 'Bearer ' + token } }

  // 第 1 步：换一次性上传地址。这个接口吃 form-urlencoded，不是 JSON。
  const ticket = await postForm(
    'https://slack.com/api/files.getUploadURLExternal',
    { filename: file.fileName, length: String(bytes.byteLength) },
    auth,
  )
  if (ticket.status === null) return { ok: false, detail: '申请上传地址时连不上: ' + ticket.body }
  const ticketData = parseJson(ticket.body, {}) ?? {}
  if (ticket.status !== 200 || ticketData.ok !== true) {
    const why = ticketData?.error ? explainSlack(ticketData.error) : String(ticket.body).slice(0, 200)
    return { ok: false, detail: '申请上传地址失败 HTTP ' + ticket.status + ': ' + why }
  }
  const fileId = String(ticketData.file_id ?? '')
  const uploadUrl = String(ticketData.upload_url ?? '')
  if (fileId === '' || uploadUrl === '') {
    return { ok: false, detail: '申请上传地址的返回里没有 file_id / upload_url，无法继续' }
  }

  // 第 2 步：把裸字节 POST 到那个地址。这里**不能**带 Authorization ——
  // upload_url 是预签名的，多带一个头反而可能被拒。
  const uploaded = await postBytes(uploadUrl, bytes, file.mediaType || 'application/octet-stream', { proxy })
  if (uploaded.status === null) return { ok: false, detail: '上传文件内容时连不上: ' + uploaded.body }
  if (uploaded.status !== 200) {
    return { ok: false, detail: '上传文件内容失败 HTTP ' + uploaded.status + '（文件已申请到上传位但没传上去）' }
  }

  // 第 3 步：绑定到频道。到这一步才算真的发出去了。
  const completed = await postJson(
    'https://slack.com/api/files.completeUploadExternal',
    {
      files: [{ id: fileId, title: file.fileName }],
      channel_id: target.id,
      ...(String(options.caption ?? '').trim() !== '' ? { initial_comment: String(options.caption).trim() } : {}),
    },
    auth,
  )
  if (completed.status === null) {
    return { ok: false, detail: '文件已上传但绑定时连不上（文件在 Slack 上但没进频道）: ' + completed.body }
  }
  const doneData = parseJson(completed.body, {}) ?? {}
  if (completed.status !== 200 || doneData.ok !== true) {
    const why = doneData?.error ? explainSlack(doneData.error) : String(completed.body).slice(0, 200)
    return { ok: false, detail: '文件已上传但绑定频道失败 HTTP ' + completed.status + ': ' + why }
  }
  return { ok: true, detail: '已发送文件 ' + file.fileName + '（' + describeTarget(target) + '）' }
}

/** 探测：auth.test 只验 token 与工作区，不碰任何频道。 */
export async function probe(acc) {
  const token = String(acc?.botToken ?? acc?.token ?? '').trim()
  if (token === '') return { ok: false, detail: '缺少 Bot Token' }
  const proxy = String(acc?.proxy ?? '').trim()
  const { status, body } = await postJson(
    'https://slack.com/api/auth.test',
    {},
    { proxy, headers: { Authorization: 'Bearer ' + token } },
  )
  if (status === null) return { ok: false, detail: '连不上: ' + body }
  const data = parseJson(body, {}) ?? {}
  if (status !== 200 || data.ok !== true) {
    const why = data?.error ? explainSlack(data.error) : String(body).slice(0, 200)
    return { ok: false, detail: 'token 不可用: ' + why }
  }
  return { ok: true, detail: 'token 可用（工作区 ' + String(data.team ?? '?') + '，机器人 ' + String(data.user ?? '?') + '）' }
}

/**
 * 改一条已发的消息（v0.29.0）。
 *
 * Slack 的 chat.update 是原地改，ts 不变 —— 所以「回复进线程」「表情回应」
 * 这些挂在原消息上的东西都还在。
 *
 * 与 chat.postMessage 的区别：这里**必须**同时给 channel 与 ts，
 * 且不接受 blocks 与 text 混着用时的降级（blocks 给了就完全按 blocks 渲染）。
 * 本插件只传 text，让 Slack 自己按 mrkdwn 解析。
 */
export async function editMessage(messageId, text, acc, options = {}) {
  const token = String(acc?.botToken ?? acc?.token ?? '').trim()
  if (token === '') return { ok: false, detail: '账号缺少 Bot Token（xoxb- 开头）' }
  const ts = String(messageId ?? '').trim()
  if (ts === '') return { ok: false, detail: '要给消息时间戳（ts）才能改' }
  const body = String(text ?? '')
  if (body.trim() === '') return { ok: false, detail: '改成的正文不能为空（Slack 不接受空消息，要清掉请用撤回）' }

  const target = targetOf(acc)
  const channel = String(options?.chatId ?? '').trim() !== '' ? String(options.chatId).trim() : (target === null ? '' : target.id)
  if (channel === '') return { ok: false, detail: '不知道这条消息在哪个频道里 —— 账号没配「发送到」，记录里也没有位置' }

  const proxy = String(acc?.proxy ?? '').trim()
  const limit = Number(acc?.maxMessageChars) > 0 ? Number(acc.maxMessageChars) : MAX_CHARS
  if (body.length > limit) {
    return { ok: false, detail: '要改成的正文有 ' + body.length + ' 字，超过这个账号的 ' + limit + ' 字上限 —— 改消息不能分块，只能缩短' }
  }

  const { status, body: raw } = await postJson(
    'https://slack.com/api/chat.update',
    { channel, ts, text: body },
    { proxy, headers: { Authorization: 'Bearer ' + token } },
  )
  if (status === null) return { ok: false, detail: '连不上: ' + raw }
  const data = parseJson(raw, {}) ?? {}
  if (status !== 200 || data.ok !== true) {
    const why = data?.error ? explainSlack(String(data.error)) : String(raw).slice(0, 200)
    return { ok: false, detail: '改不动 HTTP ' + status + ': ' + why }
  }
  return { ok: true, detail: '已改（ts ' + ts + '）' }
}

/**
 * 撤回一条消息（v0.29.0）。
 *
 * chat.delete 需要 chat:write scope（通常发消息就有），但**只能删自己发的**。
 * 频道里删别人的消息要管理员权限，本插件用的是 bot token，做不到就如实报错。
 *
 * 另外：Slack 对超过一定时间的消息会拒绝删除（企业版策略可配），
 * 那种情况把平台原文转述出来，不猜它能删多久。
 */
export async function deleteMessage(messageId, acc, options = {}) {
  const token = String(acc?.botToken ?? acc?.token ?? '').trim()
  if (token === '') return { ok: false, detail: '账号缺少 Bot Token（xoxb- 开头）' }
  const ts = String(messageId ?? '').trim()
  if (ts === '') return { ok: false, detail: '要给消息时间戳（ts）才能撤回' }

  const target = targetOf(acc)
  const channel = String(options?.chatId ?? '').trim() !== '' ? String(options.chatId).trim() : (target === null ? '' : target.id)
  if (channel === '') return { ok: false, detail: '不知道这条消息在哪个频道里 —— 账号没配「发送到」，记录里也没有位置' }

  const proxy = String(acc?.proxy ?? '').trim()
  const { status, body: raw } = await postJson(
    'https://slack.com/api/chat.delete',
    { channel, ts },
    { proxy, headers: { Authorization: 'Bearer ' + token } },
  )
  if (status === null) return { ok: false, detail: '连不上: ' + raw }
  const data = parseJson(raw, {}) ?? {}
  if (status !== 200 || data.ok !== true) {
    const why = data?.error ? explainSlack(String(data.error)) : String(raw).slice(0, 200)
    return { ok: false, detail: '撤不回 HTTP ' + status + ': ' + why }
  }
  return { ok: true, detail: '已撤回（ts ' + ts + '）' }
}

/**
 * 给一条消息加表情回应（v0.30.0）。
 *
 * ★ Slack 这里交出去的是**名字**（thumbsup），不是 Unicdoe 字符。
 *   传 👍 会回 invalid_name，而 HTTP 依然是 200 —— 只看状态码会以为成功。
 *   所以名字的转换在 lib/reactions.js 里做（带对照表），这里只负责发。
 *
 * ★ 还需要 reactions:write scope。只有 chat:write 的 bot 调这个会回
 *   missing_scope，那种情况如实转述 Slack 的原文，不猜。
 */
export async function addReaction(messageId, emoji, acc, options = {}) {
  const token = String(acc?.botToken ?? acc?.token ?? '').trim()
  if (token === '') return { ok: false, detail: '账号缺少 Bot Token（xoxb- 开头）' }
  const ts = String(messageId ?? '').trim()
  if (ts === '') return { ok: false, detail: '要给消息时间戳（ts）才能加表情' }
  const name = String(emoji ?? '').trim().replace(/^:+|:+$/g, '')
  if (name === '') return { ok: false, detail: '要给表情名字（例如 thumbsup）' }

  const target = targetOf(acc)
  const channel = String(options?.chatId ?? '').trim() !== '' ? String(options.chatId).trim() : (target === null ? '' : target.id)
  if (channel === '') return { ok: false, detail: '不知道这条消息在哪个频道里 —— 账号没配「发送到」，记录里也没有位置' }

  const proxy = String(acc?.proxy ?? '').trim()
  const { status, body: raw } = await postJson(
    'https://slack.com/api/reactions.add',
    { channel, timestamp: ts, name },
    { proxy, headers: { Authorization: 'Bearer ' + token } },
  )
  if (status === null) return { ok: false, detail: '连不上: ' + raw }
  const data = parseJson(raw, {}) ?? {}
  // already_reacted 是幂等成功：这个机器人已经挂过同一个表情了
  if (data?.error === 'already_reacted') return { ok: true, detail: '这个表情已经挂着（' + name + '）' }
  if (status !== 200 || data.ok !== true) {
    const why = data?.error ? explainSlack(String(data.error)) : String(raw).slice(0, 200)
    return { ok: false, detail: '加不上 HTTP ' + status + ': ' + why }
  }
  return { ok: true, detail: '已加 :' + name + ':（ts ' + ts + '）' }
}

/**
 * 去掉一条消息上的表情回应（v0.30.0）。
 *
 * reactions.remove 删的是**这个机器人自己**挂的那个表情，
 * 别人挂的删不掉（也不需要管理员权限 —— 这是 Slack 的设计）。
 */
export async function removeReaction(messageId, emoji, acc, options = {}) {
  const token = String(acc?.botToken ?? acc?.token ?? '').trim()
  if (token === '') return { ok: false, detail: '账号缺少 Bot Token（xoxb- 开头）' }
  const ts = String(messageId ?? '').trim()
  if (ts === '') return { ok: false, detail: '要给消息时间戳（ts）才能去表情' }
  const name = String(emoji ?? '').trim().replace(/^:+|:+$/g, '')
  if (name === '') return { ok: false, detail: '要给表情名字才能去掉' }

  const target = targetOf(acc)
  const channel = String(options?.chatId ?? '').trim() !== '' ? String(options.chatId).trim() : (target === null ? '' : target.id)
  if (channel === '') return { ok: false, detail: '不知道这条消息在哪个频道里' }

  const proxy = String(acc?.proxy ?? '').trim()
  const { status, body: raw } = await postJson(
    'https://slack.com/api/reactions.remove',
    { channel, timestamp: ts, name },
    { proxy, headers: { Authorization: 'Bearer ' + token } },
  )
  if (status === null) return { ok: false, detail: '连不上: ' + raw }
  const data = parseJson(raw, {}) ?? {}
  if (data?.error === 'no_reaction') return { ok: true, detail: '本来就没挂这个表情（' + name + '）' }
  if (status !== 200 || data.ok !== true) {
    const why = data?.error ? explainSlack(String(data.error)) : String(raw).slice(0, 200)
    return { ok: false, detail: '去不掉 HTTP ' + status + ': ' + why }
  }
  return { ok: true, detail: '已去掉 :' + name + ':（ts ' + ts + '）' }
}
