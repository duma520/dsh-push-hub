/**
 * lib/channels/matrix.js — Matrix（Client-Server API）。
 *
 * 端点：PUT https://<homeserver>/_matrix/client/v3/rooms/{roomId}/send/m.room.message/{txnId}
 * 头：Authorization: Bearer <access_token>
 * 体：{ msgtype: 'm.text', body }
 * 成功是 200，响应体 { event_id }。
 *
 * 认证只要一个 access_token（Element 里：设置 → 帮助与关于 → 访问令牌），
 * 不需要用户名密码，也不用处理 E2EE —— 加密房间里的机器人得先加入房间并共享
 * 会话密钥，那部分这里不做，遇到加密房间会如实报错而不是假装发出去。
 *
 * roomId 形如 !abcdef:matrix.org，**必须带 ! 前缀与冒号后面的服务器名**。
 *
 * @module channels/matrix
 */

import { request, postBytes, parseJson } from '../http.js'
import { isImageMime } from '../files.js'
import { splitBlocks, sleep } from '../text.js'
import { targetOf, describeTarget } from '../mentions.js'
import { replyFor, describeReply, normalizeReplyId, matrixQuotePrefix } from '../reply.js'

export const NAME = 'matrix'
export const MAX_CHARS = 30000
export const TITLE = 'Matrix'

/** Matrix 标准错误码（errcode）→ 中文。 */
const MATRIX_ERRORS = new Map([
  ['M_UNKNOWN_TOKEN', 'access_token 无效或已过期，重新去 Element 里复制'],
  ['M_MISSING_TOKEN', '没带 access_token'],
  ['M_FORBIDDEN', '这个 token 没有往该房间发消息的权限 —— 确认机器人已加入房间'],
  ['M_NOT_FOUND', '找不到这个房间：roomId 不对（要 !xxx:服务器名 的完整形式）'],
  ['M_LIMIT_EXCEEDED', '发太快被限流了，等几秒再试'],
  ['M_UNKNOWN', '服务器不认识这个请求，检查 homeserver 地址'],
  ['M_UNRECOGNIZED', 'homeserver 版本太旧，不支持 v3 接口'],
])

function explainMatrix(data, status, body) {
  const code = String(data?.errcode ?? '')
  const hit = MATRIX_ERRORS.get(code)
  if (hit !== undefined) return hit + '（' + code + '）'
  const msg = data?.error ? String(data.error) : String(body).slice(0, 200)
  return code === '' ? 'HTTP ' + status + ': ' + msg : msg + '（' + code + '）'
}

/** 把 homeserver 归一成无尾斜杠的 https 地址。 */
function homeOf(acc) {
  const raw = String(acc?.homeserver ?? acc?.baseUrl ?? '').trim()
  if (raw === '') return ''
  const withProto = raw.includes('://') ? raw : 'https://' + raw
  return withProto.replace(/\/+$/, '')
}

/**
 * 发一条消息（内部按 MAX_CHARS 分块）。
 * @param {string} text
 * @param {Record<string,any>} acc
 * @param {{delayMs?: number}} [options]
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
export async function send(text, acc, options = {}) {
  const token = String(acc?.accessToken ?? acc?.token ?? '').trim()
  if (token === '') return { ok: false, detail: '账号缺少 access_token' }
  const home = homeOf(acc)
  if (home === '') return { ok: false, detail: '账号缺少 homeserver 地址（例 https://matrix.org）' }
  const target = targetOf(acc)
  if (target === null) {
    return { ok: false, detail: '还没填「发送到」。Matrix 要的是房间 ID，形如 !abcdef:matrix.org（带 ! 前缀和服务器名）。' }
  }
  const proxy = String(acc?.proxy ?? '').trim()
  const limit = Number(acc?.maxMessageChars) > 0 ? Number(acc.maxMessageChars) : MAX_CHARS
  const delay = Number(options.delayMs) >= 0 ? Number(options.delayMs) : 500

  // v0.25.0：Matrix 的引用放在 content 里（m.relates_to），不是顶层字段；
  // 另外正文要加一行 '> 原文' 前缀，否则老客户端只看到一段孤立文本。
  const parsedReply = normalizeReplyId(options?.replyTo)
  if (parsedReply.ok !== true) return { ok: false, detail: '要回复的消息 ID 不对：' + parsedReply.detail }
  const replyTo = parsedReply.id

  const blocks = splitBlocks(text, limit)
  const room = encodeURIComponent(target.id)

  let sent = 0
  // v0.28.0：Matrix 的消息 id 是 event_id（$ 开头）。它与别的平台不同 ——
  // 改一条 Matrix 消息不是「编辑原事件」，而是再发一条 m.replace 事件，
  // 所以这里存的 id 是「能作为 redact / m.replace 目标的那个」。
  const ids = []
  for (let i = 0; i < blocks.length; i += 1) {
    // txnId 只要在同一个设备内唯一即可，用时间戳 + 序号，重试时同一条不会重复落库。
    const txnId = 'dsh' + Date.now() + '-' + i
    const last = i === blocks.length - 1
    const url = home + '/_matrix/client/v3/rooms/' + room + '/send/m.room.message/' + txnId
    const { status, body } = await request(url, {
      method: 'PUT',
      body: JSON.stringify({
        msgtype: 'm.text',
        body: replyTo !== '' && last ? matrixQuotePrefix(blocks[i], replyTo) : blocks[i],
        ...(replyTo !== '' && last ? replyFor('matrix', replyTo) : {}),
      }),
      contentType: 'application/json; charset=utf-8',
      proxy,
      headers: { Authorization: 'Bearer ' + token },
    })
    if (status === null) return { ok: false, detail: '第 ' + (i + 1) + '/' + blocks.length + ' 块连不上: ' + body }
    const data = parseJson(body, {}) ?? {}
    if (status !== 200) {
      return { ok: false, detail: '第 ' + (i + 1) + '/' + blocks.length + ' 块失败: ' + explainMatrix(data, status, body) }
    }
    const eid = String(data?.event_id ?? '').trim()
    if (eid !== '') ids.push(eid)
    sent += 1
    if (i < blocks.length - 1) await sleep(delay)
  }
  return { ok: true, detail: '已发送 ' + sent + ' 块（' + describeTarget(target) + '）' + (replyTo === '' ? '' : '；' + describeReply(replyTo)), messageIds: ids }
}

/**
 * 发一个文件到房间。
 *
 * 两步：
 *   1. POST /_matrix/media/v3/upload?filename=… 把字节传上去，拿回 mxc:// 地址
 *   2. 发一条 m.room.message，msgtype 是 m.file（图片用 m.image），body 里带
 *      那个 mxc:// 地址
 *
 * 加密房间发不进去 —— 那需要在客户端侧做 Megolm 加密，本插件不做，遇到时
 * 会由第 2 步返回 M_FORBIDDEN，这里如实转述，不假装成功。
 *
 * @param {{fileName: string, bytes: Buffer|Uint8Array, mediaType?: string}} file
 * @param {Record<string,any>} acc
 * @param {{caption?: string, delayMs?: number}} [options]
 */
export async function sendFile(file, acc, options = {}) {
  const token = String(acc?.accessToken ?? acc?.token ?? '').trim()
  if (token === '') return { ok: false, detail: '账号缺少 access_token' }
  const home = homeOf(acc)
  if (home === '') return { ok: false, detail: '账号缺少 homeserver 地址（例 https://matrix.org）' }
  const target = targetOf(acc)
  if (target === null) {
    return { ok: false, detail: '还没填「发送到」。Matrix 要的是房间 ID，形如 !abcdef:matrix.org（带 ! 前缀和服务器名）。' }
  }
  if (!file || typeof file !== 'object' || typeof file.fileName !== 'string' || file.fileName === '') {
    return { ok: false, detail: '没有可发的文件（缺少文件名）' }
  }
  const proxy = String(acc?.proxy ?? '').trim()
  const bytes = Buffer.isBuffer(file.bytes) ? file.bytes : Buffer.from(file.bytes ?? [])
  const mediaType = file.mediaType || 'application/octet-stream'

  // 第 1 步：上传媒体。
  const uploadUrl = home + '/_matrix/media/v3/upload?filename=' + encodeURIComponent(file.fileName)
  const uploaded = await postBytes(uploadUrl, bytes, mediaType, {
    proxy,
    headers: { Authorization: 'Bearer ' + token },
  })
  if (uploaded.status === null) return { ok: false, detail: '上传媒体时连不上 homeserver: ' + uploaded.body }
  const upData = parseJson(uploaded.body, {}) ?? {}
  if (uploaded.status !== 200) {
    return { ok: false, detail: '上传媒体失败: ' + explainMatrix(upData, uploaded.status, uploaded.body) }
  }
  const mxc = String(upData.content_uri ?? '')
  if (!mxc.startsWith('mxc://')) {
    return { ok: false, detail: '上传返回里没有 content_uri（mxc:// 地址），无法发文件消息' }
  }

  // 第 2 步：发文件消息。图片用 m.image 客户端才会直接显示预览。
  const image = isImageMime(mediaType)
  const content = {
    msgtype: image ? 'm.image' : 'm.file',
    body: file.fileName,
    filename: file.fileName,
    url: mxc,
    info: { mimetype: mediaType, size: bytes.byteLength },
  }
  const caption = String(options.caption ?? '').trim()
  if (caption !== '') content.body = caption.slice(0, 500)
  const txnId = 'dshfile' + Date.now()
  const sendUrl = home + '/_matrix/client/v3/rooms/' + encodeURIComponent(target.id) + '/send/m.room.message/' + txnId
  const sent = await request(sendUrl, {
    method: 'PUT',
    body: JSON.stringify(content),
    contentType: 'application/json; charset=utf-8',
    proxy,
    headers: { Authorization: 'Bearer ' + token },
  })
  if (sent.status === null) {
    return { ok: false, detail: '媒体已上传但发消息时连不上（文件在服务器上但没进房间）: ' + sent.body }
  }
  const sentData = parseJson(sent.body, {}) ?? {}
  if (sent.status !== 200) {
    return { ok: false, detail: '媒体已上传但发消息失败: ' + explainMatrix(sentData, sent.status, sent.body) }
  }
  return { ok: true, detail: '已发送' + (image ? '图片' : '文件') + ' ' + file.fileName + '（' + describeTarget(target) + '）' }
}

/** 探测：GET /_matrix/client/v3/account/whoami 只验 token，不碰房间。 */
export async function probe(acc) {
  const token = String(acc?.accessToken ?? acc?.token ?? '').trim()
  if (token === '') return { ok: false, detail: '缺少 access_token（Element → 设置 → 帮助与关于 → 访问令牌）' }
  const home = homeOf(acc)
  if (home === '') return { ok: false, detail: '缺少 homeserver 地址（例 https://matrix.org）' }
  const proxy = String(acc?.proxy ?? '').trim()
  const { status, body } = await request(home + '/_matrix/client/v3/account/whoami', {
    method: 'GET',
    proxy,
    headers: { Authorization: 'Bearer ' + token },
  })
  if (status === null) return { ok: false, detail: '连不上 homeserver: ' + body }
  const data = parseJson(body, {}) ?? {}
  if (status !== 200) return { ok: false, detail: 'token 不可用: ' + explainMatrix(data, status, body) }
  return { ok: true, detail: 'token 可用（@' + String(data.user_id ?? '?') + '）' }
}

/**
 * 改一条已发的消息（v0.29.0）。
 *
 * Matrix 的「改」是**再发一条事件**，不是编辑原事件：
 *   新事件 content 里带 m.new_content（新内容）与
 *   m.relates_to = { event_id: 原事件id, rel_type: 'm.replace' }
 * 客户端看到 m.replace 就把原事件渲染成修改版，原事件本身一个字都没变。
 *
 * 所以这里的 messageId 必须是被改的那条**原事件**的 event_id，
 * 用改完之后新事件的 id 再去改会变成「改一次改出来的改」—— 能链下去但没必要。
 *
 * 与 redact 的区别：redact 是不可逆删除，m.replace 是可继续改的版本链。
 */
export async function editMessage(messageId, text, acc, options = {}) {
  const token = String(acc?.accessToken ?? acc?.token ?? '').trim()
  if (token === '') return { ok: false, detail: '账号缺少 access_token' }
  const home = homeOf(acc)
  if (home === '') return { ok: false, detail: '账号缺少 homeserver 地址（例 https://matrix.org）' }
  const eventId = String(messageId ?? '').trim()
  if (eventId === '') return { ok: false, detail: '要给事件 ID（$ 开头）才能改' }
  const body = String(text ?? '')
  if (body.trim() === '') return { ok: false, detail: '改成的正文不能为空（要清掉请用撤回）' }

  const target = targetOf(acc)
  const roomId = String(options?.chatId ?? '').trim() !== '' ? String(options.chatId).trim() : (target === null ? '' : target.id)
  if (roomId === '') return { ok: false, detail: '不知道这条消息在哪个房间里 —— 账号没配「发送到」，记录里也没有位置' }

  const proxy = String(acc?.proxy ?? '').trim()
  const limit = Number(acc?.maxMessageChars) > 0 ? Number(acc.maxMessageChars) : MAX_CHARS
  if (body.length > limit) {
    return { ok: false, detail: '要改成的正文有 ' + body.length + ' 字，超过这个账号的 ' + limit + ' 字上限 —— 改消息不能分块，只能缩短' }
  }

  // Matrix 的 m.new_content 里 body 是**新正文原文**（不带 '* ' 前缀）；
  // 外层 body 才要求加 '* '，那是给不认 m.replace 的老客户端的降级显示。
  const newContent = { msgtype: 'm.text', body }
  const content = {
    msgtype: 'm.text',
    body: '* ' + body,
    'm.new_content': newContent,
    'm.relates_to': { event_id: eventId, rel_type: 'm.replace' },
  }
  const txnId = 'dshedit' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
  const url = home + '/_matrix/client/v3/rooms/' + encodeURIComponent(roomId) + '/send/m.room.message/' + txnId
  const { status, body: raw } = await request(url, {
    method: 'PUT',
    body: JSON.stringify(content),
    contentType: 'application/json; charset=utf-8',
    proxy,
    headers: { Authorization: 'Bearer ' + token },
  })
  if (status === null) return { ok: false, detail: '连不上: ' + raw }
  const data = parseJson(raw, {}) ?? {}
  if (status !== 200) return { ok: false, detail: '改不动: ' + explainMatrix(data, status, raw) }
  const newId = String(data?.event_id ?? '').trim()
  return { ok: true, detail: '已发出修改事件（原事件 ' + eventId + (newId === '' ? '' : '，修改事件 ' + newId) + '）—— Matrix 的『改』是再发一条带 m.replace 的事件，不是编辑原事件' }
}

/**
 * 撤回一条消息（v0.29.0）。
 *
 * redact 是不可逆的：平台上那条消息会被替换成「消息已被删除」，
 * 而且**客户端可能还留着旧内容的本地缓存** —— 这是 Matrix 的协议特性，
 * 不是本插件的问题。所以文案里说「已在服务器上撤回」，不说「对方一定看不到了」。
 *
 * 端点要三段：/rooms/{roomId}/redact/{eventId}/{txnId} 且是 PUT。
 */
export async function deleteMessage(messageId, acc, options = {}) {
  const token = String(acc?.accessToken ?? acc?.token ?? '').trim()
  if (token === '') return { ok: false, detail: '账号缺少 access_token' }
  const home = homeOf(acc)
  if (home === '') return { ok: false, detail: '账号缺少 homeserver 地址（例 https://matrix.org）' }
  const eventId = String(messageId ?? '').trim()
  if (eventId === '') return { ok: false, detail: '要给事件 ID（$ 开头）才能撤回' }

  const target = targetOf(acc)
  const roomId = String(options?.chatId ?? '').trim() !== '' ? String(options.chatId).trim() : (target === null ? '' : target.id)
  if (roomId === '') return { ok: false, detail: '不知道这条消息在哪个房间里 —— 账号没配「发送到」，记录里也没有位置' }

  const proxy = String(acc?.proxy ?? '').trim()
  const txnId = 'dshdel' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
  const url = home + '/_matrix/client/v3/rooms/' + encodeURIComponent(roomId) + '/redact/' + encodeURIComponent(eventId) + '/' + txnId
  const { status, body: raw } = await request(url, {
    method: 'PUT',
    body: JSON.stringify({}),
    contentType: 'application/json; charset=utf-8',
    proxy,
    headers: { Authorization: 'Bearer ' + token },
  })
  if (status === null) return { ok: false, detail: '连不上: ' + raw }
  const data = parseJson(raw, {}) ?? {}
  if (status !== 200) return { ok: false, detail: '撤不回: ' + explainMatrix(data, status, raw) }
  return { ok: true, detail: '已在服务器上撤回（事件 ' + eventId + '）—— Matrix 的撤回是不可逆的 redact，客户端可能还留着本地缓存' }
}

/**
 * 给一条消息加表情回应（v0.30.0）。
 *
 * Matrix 的表情是**发一个新事件**，不是改原消息：
 *   { 'm.relates_to': { event_id, rel_type: 'm.annotation' }, 'm.reaction': key }
 * 所以这跟改消息一样走 /send/m.room.message/ 端点（PUT + txnId）。
 *
 * key 可以是任意字符串 —— Unicode 直接当 key 用，不需要名字对照表。
 */
export async function addReaction(messageId, emoji, acc, options = {}) {
  const token = String(acc?.accessToken ?? acc?.token ?? '').trim()
  if (token === '') return { ok: false, detail: '账号缺少 access_token' }
  const home = homeOf(acc)
  if (home === '') return { ok: false, detail: '账号缺少 homeserver 地址（例 https://matrix.org）' }
  const eventId = String(messageId ?? '').trim()
  if (eventId === '') return { ok: false, detail: '要给事件 ID（$ 开头）才能加表情' }
  const key = String(emoji ?? '').trim()
  if (key === '') return { ok: false, detail: '要给表情（Unicode 字符或任意 key）' }

  const target = targetOf(acc)
  const roomId = String(options?.chatId ?? '').trim() !== '' ? String(options.chatId).trim() : (target === null ? '' : target.id)
  if (roomId === '') return { ok: false, detail: '不知道这条消息在哪个房间里 —— 账号没配「发送到」，记录里也没有位置' }

  const proxy = String(acc?.proxy ?? '').trim()
  const content = { 'm.relates_to': { event_id: eventId, rel_type: 'm.annotation' }, 'm.reaction': key }
  const txnId = 'dshreact' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
  const url = home + '/_matrix/client/v3/rooms/' + encodeURIComponent(roomId) + '/send/m.reaction/' + txnId
  const { status, body: raw } = await request(url, {
    method: 'PUT',
    body: JSON.stringify(content),
    contentType: 'application/json; charset=utf-8',
    proxy,
    headers: { Authorization: 'Bearer ' + token },
  })
  if (status === null) return { ok: false, detail: '连不上: ' + raw }
  const data = parseJson(raw, {}) ?? {}
  if (status !== 200) return { ok: false, detail: '加不上: ' + explainMatrix(data, status, raw) }
  const newId = String(data?.event_id ?? '').trim()
  return { ok: true, detail: '已加 ' + key + '（原事件 ' + eventId + (newId === '' ? '' : '，回应事件 ' + newId) + '）' }
}

/**
 * 去掉表情回应（v0.30.0）。
 *
 * ★ Matrix 没有「删掉某个人的某个表情」的接口 —— 表情本身就是一个事件，
 *   要去掉只能**撤回那个回应事件**（redact）。所以这里必须先知道
 *   回应事件的 event_id，而发件箱里只存了原消息的 id。
 *
 *   本函数因此不接受「从原消息上摘掉表情」，而是要求**直接给回应事件的 id**，
 *   走 redact。这不是偷懒：编一个「看起来能去」的实现，按下去必然失败。
 */
export async function removeReaction(reactionEventId, acc, options = {}) {
  const token = String(acc?.accessToken ?? acc?.token ?? '').trim()
  if (token === '') return { ok: false, detail: '账号缺少 access_token' }
  const home = homeOf(acc)
  if (home === '') return { ok: false, detail: '账号缺少 homeserver 地址（例 https://matrix.org）' }
  const eventId = String(reactionEventId ?? '').trim()
  if (eventId === '') return { ok: false, detail: '要给回应事件 ID 才能去掉 —— Matrix 的表情是一个独立事件，撤回它才能去掉' }

  const target = targetOf(acc)
  const roomId = String(options?.chatId ?? '').trim() !== '' ? String(options.chatId).trim() : (target === null ? '' : target.id)
  if (roomId === '') return { ok: false, detail: '不知道这条消息在哪个房间里' }

  const proxy = String(acc?.proxy ?? '').trim()
  const txnId = 'dshunreact' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
  const url = home + '/_matrix/client/v3/rooms/' + encodeURIComponent(roomId) + '/redact/' + encodeURIComponent(eventId) + '/' + txnId
  const { status, body: raw } = await request(url, {
    method: 'PUT',
    body: JSON.stringify({}),
    contentType: 'application/json; charset=utf-8',
    proxy,
    headers: { Authorization: 'Bearer ' + token },
  })
  if (status === null) return { ok: false, detail: '连不上: ' + raw }
  const data = parseJson(raw, {}) ?? {}
  if (status !== 200) return { ok: false, detail: '去不掉: ' + explainMatrix(data, status, raw) }
  return { ok: true, detail: '已撤回回应事件（' + eventId + '）' }
}
