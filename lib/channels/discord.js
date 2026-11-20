/**
 * lib/channels/discord.js — Discord（Bot HTTP API v10）。
 *
 * 端点：POST https://discord.com/api/v10/channels/{channelId}/messages
 * 头：Authorization: Bot <token>
 * 体：{ content }
 * 成功是 200（不是 201）。限流时返回 429，body 里有 retry_after（秒）。
 *
 * 要点：
 *   - Bot 必须已被邀请进目标服务器，且在该频道有「查看频道 / 发送消息」权限；
 *   - 「发送到」要填**频道 ID**（纯数字 Snowflake），不是频道名；
 *   - 单条 content 上限 2000 字符，超了要自己分块（这里已做）。
 *
 * 获取频道 ID：Discord 设置 → 高级 → 打开「开发者模式」，右键频道 → 复制频道 ID。
 *
 * @module channels/discord
 */

import { postJson, postMultipart, getJson, parseJson, request } from '../http.js'
import { splitBlocks, sleep } from '../text.js'
import { targetOf, describeTarget } from '../mentions.js'
import { parseButtons, toDiscord, describeButtons } from '../buttons.js'
import { replyFor, describeReply, normalizeReplyId } from '../reply.js'

export const NAME = 'discord'
export const MAX_CHARS = 1900
export const TITLE = 'Discord'

/** Discord 的 JSON 错误码 → 中文（沿用官方 API 错误码表里最常见的几个）。 */
const DISCORD_ERRORS = new Map([
  [50001, 'Bot 没有访问这个频道的权限'],
  [50007, 'Bot 不在这个服务器里，或者没有「发送消息」权限'],
  [10003, '找不到频道：频道 ID 不对，或者那个频道已删除'],
  [10004, '找不到服务器'],
  [40001, 'token 不对（要 Bot Token，不是 Application ID）'],
  [50035, '请求体格式被拒：多半是 content 超长或含非法字符'],
])

function explainDiscord(data, status, body) {
  const code = Number(data?.code)
  if (Number.isFinite(code)) {
    const hit = DISCORD_ERRORS.get(code)
    if (hit !== undefined) return hit + '（code=' + code + '）'
  }
  if (status === 429) {
    const wait = data?.retry_after
    return '被限流了' + (typeof wait === 'number' ? '，等 ' + Math.ceil(wait) + ' 秒再试' : '，等几秒再试')
  }
  const msg = data?.message ? String(data.message) : String(body).slice(0, 200)
  return Number.isFinite(code) ? msg + '（code=' + code + '）' : msg
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
  if (token === '') return { ok: false, detail: '账号缺少 Bot Token' }
  const target = targetOf(acc)
  if (target === null) {
    return { ok: false, detail: '还没填「发送到」。Discord 要的是频道 ID（纯数字，开发者模式里右键频道 → 复制频道 ID），不是频道名。' }
  }
  // 按钮只挂最后一块。Discord 的 components 上限是 5 行 action row、每行 5 个，
  // 超了整条 400 —— 折行与总量校验在 buttons.js 里统一做，这里只管翻译。
  const parsed = parseButtons(options?.buttons)
  if (parsed.ok !== true) return { ok: false, detail: '按钮格式不对：' + parsed.detail }
  const components = parsed.rows.length > 0 ? toDiscord(parsed.rows) : null

  // v0.25.0：Discord 的引用要同时给 message_id 与 channel_id。
  const parsedReply = normalizeReplyId(options?.replyTo)
  if (parsedReply.ok !== true) return { ok: false, detail: '要回复的消息 ID 不对：' + parsedReply.detail }
  const replyTo = parsedReply.id

  const proxy = String(acc?.proxy ?? '').trim()
  const limit = Number(acc?.maxMessageChars) > 0 ? Number(acc.maxMessageChars) : MAX_CHARS
  const delay = Number(options.delayMs) >= 0 ? Number(options.delayMs) : 600
  const url = 'https://discord.com/api/v10/channels/' + encodeURIComponent(target.id) + '/messages'
  const blocks = splitBlocks(text, limit)

  let sent = 0
  // v0.28.0：Discord 的消息 id 在响应顶层的 id 字段，改 / 撤 / 加表情都靠它。
  const ids = []
  for (let i = 0; i < blocks.length; i += 1) {
    const last = i === blocks.length - 1
    const { status, body } = await postJson(
      url,
      { content: blocks[i], ...(components !== null && last ? { components } : {}), ...(replyTo !== '' && last ? replyFor('discord', replyTo, { channelId: target.id }) : {}) },
      { proxy, headers: { Authorization: 'Bot ' + token } },
    )
    if (status === null) return { ok: false, detail: '第 ' + (i + 1) + '/' + blocks.length + ' 块连不上: ' + body }
    const data = parseJson(body, {}) ?? {}
    if (status !== 200) {
      return { ok: false, detail: '第 ' + (i + 1) + '/' + blocks.length + ' 块失败 HTTP ' + status + ': ' + explainDiscord(data, status, body) }
    }
    const mid = String(data?.id ?? '').trim()
    if (mid !== '') ids.push(mid)
    sent += 1
    if (i < blocks.length - 1) await sleep(delay)
  }
  return {
    ok: true,
    detail: '已发送 ' + sent + ' 块（' + describeTarget(target) + '）' + (components === null ? '' : '；带 ' + describeButtons(parsed.rows)) + (replyTo === '' ? '' : '；' + describeReply(replyTo)),
    messageIds: ids,
  }
}

/**
 * 发一个文件到频道。
 *
 * Discord 的 multipart 是「一份 JSON 描述 + 若干文件」：
 *   payload_json = {"attachments":[{"id":0,"filename":"..."}], "content": "..."}
 *   files[0]     = 文件字节
 * 少了 attachments 那段描述，Discord 会把文件丢掉但照样回 200 —— 这是最容易
 * 「看起来成功、实际什么都没发出去」的地方，所以下面显式构造它。
 *
 * @param {{fileName: string, bytes: Buffer|Uint8Array, mediaType?: string}} file
 * @param {Record<string,any>} acc
 * @param {{caption?: string, delayMs?: number}} [options]
 */
export async function sendFile(file, acc, options = {}) {
  const token = String(acc?.botToken ?? acc?.token ?? '').trim()
  if (token === '') return { ok: false, detail: '账号缺少 Bot Token' }
  const target = targetOf(acc)
  if (target === null) {
    return { ok: false, detail: '还没填「发送到」。Discord 要的是频道 ID（纯数字，开发者模式里右键频道 → 复制频道 ID），不是频道名。' }
  }
  if (!file || typeof file !== 'object' || typeof file.fileName !== 'string' || file.fileName === '') {
    return { ok: false, detail: '没有可发的文件（缺少文件名）' }
  }
  const proxy = String(acc?.proxy ?? '').trim()
  const url = 'https://discord.com/api/v10/channels/' + encodeURIComponent(target.id) + '/messages'

  const payload = {
    attachments: [{ id: 0, filename: file.fileName }],
  }
  const caption = String(options.caption ?? '').trim()
  if (caption !== '') payload.content = caption.slice(0, 2000)

  const { status, body } = await postMultipart(
    url,
    { payload_json: JSON.stringify(payload) },
    { field: 'files[0]', fileName: file.fileName, bytes: file.bytes, mediaType: file.mediaType },
    { proxy, headers: { Authorization: 'Bot ' + token } },
  )
  if (status === null) return { ok: false, detail: '连不上: ' + body }
  const data = parseJson(body, {}) ?? {}
  if (status !== 200) {
    return { ok: false, detail: '发送失败 HTTP ' + status + ': ' + explainDiscord(data, status, body) }
  }
  return { ok: true, detail: '已发送文件 ' + file.fileName + '（' + describeTarget(target) + '）' }
}

/** 探测：GET /users/@me 只验 token，不碰频道。 */
export async function probe(acc) {
  const token = String(acc?.botToken ?? acc?.token ?? '').trim()
  if (token === '') return { ok: false, detail: '缺少 Bot Token' }
  const proxy = String(acc?.proxy ?? '').trim()
  const { status, body } = await getJson(
    'https://discord.com/api/v10/users/@me',
    { proxy, headers: { Authorization: 'Bot ' + token } },
  )
  if (status === null) return { ok: false, detail: '连不上: ' + body }
  const data = parseJson(body, {}) ?? {}
  if (status !== 200) return { ok: false, detail: 'token 不可用: ' + explainDiscord(data, status, body) }
  return { ok: true, detail: 'token 可用（Bot ' + String(data.username ?? '?') + '）' }
}

/**
 * 改一条已发的消息（v0.29.0）。
 *
 * Discord 是 PATCH messages/:id 原地改，需要 channel id 定位 ——
 * 光有 message id 平台不知道去哪个频道找（同一条消息 id 全局唯一，但
 * 端点路径里必须带频道）。
 *
 * allowed_mentions 显式清空：改完的文字里如果带 @everyone，
 * 不写这个字段 Discord 会真的去 ping 全频道。
 */
export async function editMessage(messageId, text, acc, options = {}) {
  const token = String(acc?.botToken ?? acc?.token ?? '').trim()
  if (token === '') return { ok: false, detail: '账号缺少 Bot Token' }
  const id = String(messageId ?? '').trim()
  if (id === '') return { ok: false, detail: '要给消息 ID 才能改' }
  const body = String(text ?? '')
  if (body.trim() === '') return { ok: false, detail: '改成的正文不能为空（Discord 不接受空消息，要清掉请用撤回）' }

  const target = targetOf(acc)
  const channelId = String(options?.chatId ?? '').trim() !== '' ? String(options.chatId).trim() : (target === null ? '' : target.id)
  if (channelId === '') return { ok: false, detail: '不知道这条消息在哪个频道里 —— 账号没配「发送到」，记录里也没有位置' }

  const proxy = String(acc?.proxy ?? '').trim()
  const limit = Number(acc?.maxMessageChars) > 0 ? Number(acc.maxMessageChars) : MAX_CHARS
  if (body.length > limit) {
    return { ok: false, detail: '要改成的正文有 ' + body.length + ' 字，超过这个账号的 ' + limit + ' 字上限 —— 改消息不能分块，只能缩短' }
  }

  const url = 'https://discord.com/api/v10/channels/' + encodeURIComponent(channelId) + '/messages/' + encodeURIComponent(id)
  const { status, body: raw } = await request(url, {
    method: 'PATCH',
    body: JSON.stringify({ content: body, allowed_mentions: { parse: [], replied_user: false } }),
    contentType: 'application/json; charset=utf-8',
    proxy,
    headers: { Authorization: 'Bot ' + token },
  })
  if (status === null) return { ok: false, detail: '连不上: ' + raw }
  const data = parseJson(raw, {}) ?? {}
  if (status !== 200) return { ok: false, detail: '改不动 HTTP ' + status + ': ' + explainDiscord(data, status, raw) }
  return { ok: true, detail: '已改（消息 ' + id + '）' }
}

/**
 * 撤回一条消息（v0.29.0）。
 *
 * DELETE 成功时 Discord 回 204 且**没有响应体** —— 所以不能按「body 能 parse」
 * 判断成功，只能看状态码。这是三家协议里唯一一个「成功但没内容」的。
 */
export async function deleteMessage(messageId, acc, options = {}) {
  const token = String(acc?.botToken ?? acc?.token ?? '').trim()
  if (token === '') return { ok: false, detail: '账号缺少 Bot Token' }
  const id = String(messageId ?? '').trim()
  if (id === '') return { ok: false, detail: '要给消息 ID 才能撤回' }

  const target = targetOf(acc)
  const channelId = String(options?.chatId ?? '').trim() !== '' ? String(options.chatId).trim() : (target === null ? '' : target.id)
  if (channelId === '') return { ok: false, detail: '不知道这条消息在哪个频道里 —— 账号没配「发送到」，记录里也没有位置' }

  const proxy = String(acc?.proxy ?? '').trim()
  const url = 'https://discord.com/api/v10/channels/' + encodeURIComponent(channelId) + '/messages/' + encodeURIComponent(id)
  const { status, body: raw } = await request(url, {
    method: 'DELETE',
    proxy,
    headers: { Authorization: 'Bot ' + token },
  })
  if (status === null) return { ok: false, detail: '连不上: ' + raw }
  if (status === 204 || status === 200) return { ok: true, detail: '已撤回（消息 ' + id + '）' }
  const data = parseJson(raw, {}) ?? {}
  return { ok: false, detail: '撤不回 HTTP ' + status + ': ' + explainDiscord(data, status, raw) }
}

/**
 * 给一条消息加表情回应（v0.30.0）。
 *
 * 端点是 **PUT**（不是 POST），路径末段是 /@me —— 意思是「以当前机器人的身份
 * 加这个表情」。重复加同一个表情是幂等的（还是 204）。
 *
 * ★ 自定义表情必须是 `name:id`（例：blob:1234567890），只写名字找不到；
 *   Unicode 字符则原样 encodeURIComponent 后放进路径（👍 → %F0%9F%91%8D）。
 *   这个区分由调用方保证，这里不猜。
 *
 * ★ 成功是 **204 No Content**，没有响应体 —— 不能靠 body 判断结果。
 */
export async function addReaction(messageId, emoji, acc, options = {}) {
  const token = String(acc?.botToken ?? acc?.token ?? '').trim()
  if (token === '') return { ok: false, detail: '账号缺少 Bot Token' }
  const id = String(messageId ?? '').trim()
  if (id === '') return { ok: false, detail: '要给消息 ID 才能加表情' }
  const key = String(emoji ?? '').trim()
  if (key === '') return { ok: false, detail: '要给表情（Unicode 字符，或自定义表情的 name:id）' }

  const target = targetOf(acc)
  const channelId = String(options?.chatId ?? '').trim() !== '' ? String(options.chatId).trim() : (target === null ? '' : target.id)
  if (channelId === '') return { ok: false, detail: '不知道这条消息在哪个频道里 —— 账号没配「发送到」，记录里也没有位置' }

  const proxy = String(acc?.proxy ?? '').trim()
  const url = 'https://discord.com/api/v10/channels/' + encodeURIComponent(channelId)
    + '/messages/' + encodeURIComponent(id)
    + '/reactions/' + encodeURIComponent(key) + '/@me'
  const { status, body: raw } = await request(url, {
    method: 'PUT',
    proxy,
    headers: { Authorization: 'Bot ' + token },
  })
  if (status === null) return { ok: false, detail: '连不上: ' + raw }
  if (status === 204 || status === 200) return { ok: true, detail: '已加 ' + key + '（消息 ' + id + '）' }
  const data = parseJson(raw, {}) ?? {}
  return { ok: false, detail: '加不上 HTTP ' + status + ': ' + explainDiscord(data, status, raw) }
}

/**
 * 去掉自己挂的表情回应（v0.30.0）。
 *
 * 与加是**同一个 URL，只是 DELETE**。删的是「机器人自己挂的」那一个，
 * 别人挂的删不掉（要 Manage Messages 权限）。
 */
export async function removeReaction(messageId, emoji, acc, options = {}) {
  const token = String(acc?.botToken ?? acc?.token ?? '').trim()
  if (token === '') return { ok: false, detail: '账号缺少 Bot Token' }
  const id = String(messageId ?? '').trim()
  if (id === '') return { ok: false, detail: '要给消息 ID 才能去表情' }
  const key = String(emoji ?? '').trim()
  if (key === '') return { ok: false, detail: '要给表情才能去掉' }

  const target = targetOf(acc)
  const channelId = String(options?.chatId ?? '').trim() !== '' ? String(options.chatId).trim() : (target === null ? '' : target.id)
  if (channelId === '') return { ok: false, detail: '不知道这条消息在哪个频道里' }

  const proxy = String(acc?.proxy ?? '').trim()
  const url = 'https://discord.com/api/v10/channels/' + encodeURIComponent(channelId)
    + '/messages/' + encodeURIComponent(id)
    + '/reactions/' + encodeURIComponent(key) + '/@me'
  const { status, body: raw } = await request(url, {
    method: 'DELETE',
    proxy,
    headers: { Authorization: 'Bot ' + token },
  })
  if (status === null) return { ok: false, detail: '连不上: ' + raw }
  if (status === 204 || status === 200) return { ok: true, detail: '已去掉 ' + key + '（消息 ' + id + '）' }
  const data = parseJson(raw, {}) ?? {}
  return { ok: false, detail: '去不掉 HTTP ' + status + ': ' + explainDiscord(data, status, raw) }
}
