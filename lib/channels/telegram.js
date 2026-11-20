/**
 * lib/channels/telegram.js — Telegram Bot API。
 *
 * 与 Python 版 pushhub/channels/telegram.py 逐字段对齐。
 * 注意：本机直连 api.telegram.org 必然超时，必须走账号配置里的 proxy。
 *
 * 群聊与 @：
 *   - Telegram 的 chat_id 为负数就是群/频道，所以「发群」与「发单聊」是同一个
 *     接口，靠 chat_id 区分，不需要换端点。
 *   - **Bot API 没有「@所有人」**：它只有 parse_mode 里的 markdown 文本和
 *     entities[].text_mention（必须给具体 user.id）。所以在 Telegram 上
 *     mention.mode='all' 只能退化成正文里写 @username 或 @all 的字面文字，
 *     这里如实降级并在 detail 里说明，不假装成功。
 *   - mention.mode='user' 走 entities[].text_mention，需要数字 user id
 *     （不是 @username 字符串），所以配置里填的必须是数字 ID。
 *
 * @module channels/telegram
 */

import { postJson, postMultipart, getJson, parseJson } from '../http.js'
import { isImageMime } from '../files.js'
import { splitBlocks, sleep } from '../text.js'
import { targetOf, mentionOf, describeTarget } from '../mentions.js'
import { parseButtons, toTelegram, describeButtons } from '../buttons.js'
import { replyFor, describeReply, normalizeReplyId, REPLY_CHANNELS } from '../reply.js'

export const NAME = 'telegram'
export const MAX_CHARS = 4096
export const TITLE = 'Telegram'

/** 把正文包成带 text_mention 实体的形式。 */
function withMentions(block, mention) {
  if (mention.mode === 'none') return { text: block, extra: {} }
  if (mention.mode === 'all') {
    // 没有真 @所有人 的协议，只能写进正文；Telegram 客户端会把 @all 当普通文字。
    return { text: '@all\n' + block, extra: {}, degraded: true }
  }
  // mode === 'user'：给每个 id 拼一段前缀，再用 entities 明确指向。
  const parts = []
  const entities = []
  let offset = 0
  for (const id of mention.ids) {
    const label = '@' + id + ' '
    parts.push(label)
    entities.push({
      type: 'text_mention',
      offset: offset + 1,
      length: String(id).length,
      user: { id: Number(id) },
    })
    offset += label.length
  }
  parts.push(block)
  return { text: parts.join(''), extra: { entities }, degraded: false }
}

/**
 * 发一条消息（内部按 MAX_CHARS 分块）。
 * @param {string} text
 * @param {Record<string,any>} acc 单个 telegram 账号
 * @param {{delayMs?: number}} [options]
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
export async function send(text, acc, options = {}) {
  const token = String(acc?.botToken ?? acc?.token ?? '').trim()
  if (token === '') return { ok: false, detail: '账号缺少 token' }
  const target = targetOf(acc)
  if (target === null) {
    return { ok: false, detail: '还没选「发送到」。凭据没问题，只是不知道发给谁 —— 在账号那一行点「获取会话」从下拉里选，或点开 Telegram 给机器人发一句话再来获取。' }
  }

  // 按钮只挂在最后一块上：分块是为了绕开 4096 字符上限，而按钮是「对这一整条
  // 消息的操作」，挂到每一块会变成按一次触发 N 个 callback。
  const parsed = parseButtons(options?.buttons)
  if (parsed.ok !== true) return { ok: false, detail: '按钮格式不对：' + parsed.detail }
  const replyMarkup = parsed.rows.length > 0 ? toTelegram(parsed.rows) : null

  // v0.25.0：回复某条消息。parseButtons 与这里都只认「一个 ID」，格式不对直接报，
  // 不要静默降级成普通消息 —— 用户以为回了，实际是发散的。
  const parsedReply = normalizeReplyId(options?.replyTo)
  if (parsedReply.ok !== true) return { ok: false, detail: '要回复的消息 ID 不对：' + parsedReply.detail }
  const replyTo = parsedReply.id

  const mention = mentionOf(acc)
  const proxy = String(acc?.proxy ?? '').trim()
  const limit = Number(acc?.maxMessageChars) > 0 ? Number(acc.maxMessageChars) : MAX_CHARS
  const delay = Number(options.delayMs) >= 0 ? Number(options.delayMs) : 350
  const url = 'https://api.telegram.org/bot' + token + '/sendMessage'
  const blocks = splitBlocks(text, limit)

  let sent = 0
  let degraded = false
  // v0.28.0：把每一块在 Telegram 那边的 message_id 收集起来。改 / 撤 / 加表情
  // 都要靠它，少收一块就等于那一块以后动不了。
  const ids = []
  for (let i = 0; i < blocks.length; i += 1) {
    const packed = withMentions(blocks[i], mention)
    if (packed.degraded === true) degraded = true
    const last = i === blocks.length - 1
    const { status, body } = await postJson(
      url,
      {
        chat_id: target.id,
        text: packed.text,
        disable_web_page_preview: true,
        ...packed.extra,
        ...(replyMarkup !== null && last ? { reply_markup: replyMarkup } : {}),
        ...(replyTo !== '' && last ? replyFor('telegram', replyTo) : {}),
      },
      { proxy },
    )
    if (status === null) return { ok: false, detail: '第 ' + (i + 1) + '/' + blocks.length + ' 块连不上: ' + body }
    const data = parseJson(body, {}) ?? {}
    if (status !== 200 || data.ok !== true) {
      const desc = data?.description ? String(data.description) : body.slice(0, 200)
      return { ok: false, detail: '第 ' + (i + 1) + '/' + blocks.length + ' 块失败 HTTP ' + status + ': ' + desc }
    }
    const mid = data?.result?.message_id
    if (mid !== undefined && mid !== null && String(mid) !== '') ids.push(String(mid))
    sent += 1
    if (i < blocks.length - 1) await sleep(delay)
  }
  let note = '已发送 ' + sent + ' 块（' + describeTarget(target) + '）'
  if (replyMarkup !== null) note += '；带 ' + describeButtons(parsed.rows)
  if (replyTo !== '') note += '；' + describeReply(replyTo)
  if (degraded) note += '；Telegram 不支持 @所有人，已退化为正文里的 @all 文字'
  return { ok: true, detail: note, messageIds: ids }
}

/**
 * 发一个文件（图片走 sendPhoto，其余走 sendDocument）。
 *
 * 为什么不复用 send()：Bot API 的媒体接口是 multipart，参数名和 JSON 那条路
 * 完全不一样（chat_id 走表单字段，文件走 document/photo 字段），混在一个函数里
 * 会让「文本分块」那套逻辑白跑一遍。
 *
 * 图片单独走 sendPhoto 是因为 Telegram 客户端会把 sendPhoto 渲染成缩略图预览，
 * 而 sendDocument 发图片只是一条可下载的附件 —— 同样是「发一张图」，对方体验差别很大。
 *
 * @param {{fileName: string, bytes: Buffer|Uint8Array, mediaType?: string}} file
 * @param {Record<string,any>} acc
 * @param {{caption?: string, delayMs?: number}} [options]
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
export async function sendFile(file, acc, options = {}) {
  const token = String(acc?.botToken ?? acc?.token ?? '').trim()
  if (token === '') return { ok: false, detail: '账号缺少 token' }
  const target = targetOf(acc)
  if (target === null) {
    return { ok: false, detail: '还没选「发送到」。凭据没问题，只是不知道发给谁 —— 在账号那一行点「获取会话」从下拉里选。' }
  }
  if (!file || typeof file !== 'object' || typeof file.fileName !== 'string' || file.fileName === '') {
    return { ok: false, detail: '没有可发的文件（缺少文件名）' }
  }
  const proxy = String(acc?.proxy ?? '').trim()
  const image = isImageMime(file.mediaType)
  const method = image ? 'sendPhoto' : 'sendDocument'
  const fieldName = image ? 'photo' : 'document'
  const url = 'https://api.telegram.org/bot' + token + '/' + method

  const fields = { chat_id: String(target.id) }
  // caption 上限 1024（Telegram 的规定），超了截断而不是让整条失败。
  const caption = String(options.caption ?? '').trim()
  if (caption !== '') fields.caption = caption.slice(0, 1024)

  const { status, body } = await postMultipart(url, fields, {
    field: fieldName,
    fileName: file.fileName,
    bytes: file.bytes,
    mediaType: file.mediaType,
  }, { proxy })
  if (status === null) return { ok: false, detail: '连不上: ' + body }
  const data = parseJson(body, {}) ?? {}
  if (status !== 200 || data.ok !== true) {
    const desc = data?.description ? String(data.description) : String(body).slice(0, 200)
    return { ok: false, detail: '发送失败 HTTP ' + status + ': ' + desc }
  }
  return { ok: true, detail: '已发送' + (image ? '图片' : '文件') + ' ' + file.fileName + '（' + describeTarget(target) + '）' }
}

/** 探测：调 getMe 确认 token 可用（不依赖有没有聊过天的对方）。 */
export async function probe(acc) {
  const token = String(acc?.botToken ?? acc?.token ?? '').trim()
  if (token === '') return { ok: false, detail: '缺少 botToken' }
  const proxy = String(acc?.proxy ?? '').trim()
  const { status, body } = await getJson('https://api.telegram.org/bot' + token + '/getMe', { proxy })
  if (status === null) return { ok: false, detail: '连不上: ' + body }
  const data = parseJson(body, {}) ?? {}
  if (status !== 200 || data.ok !== true) {
    return { ok: false, detail: 'HTTP ' + status + ': ' + String(data?.description ?? body).slice(0, 200) }
  }
  return { ok: true, detail: 'token 可用（@' + String(data.result?.username ?? '?') + '）' }
}

/**
 * 改一条已发的消息（v0.29.0）。
 *
 * Telegram 是真的原地改：客户端会在消息下方显示「已编辑」，原消息 id 不变。
 * 所以这里不需要先删再发 —— 那样会把对方的回复关系、表情回应一起弄丢。
 *
 * 注意 editMessageText 只认 text（富文本 rich_message 那条路本插件不用），
 * 并且**不能**带 reply_markup 以外的额外字段；改文字时把键盘清掉是常见需求，
 * 这里交给调用方决定（不给 replyMarkup 就保持原样）。
 *
 * @param {string} messageId
 * @param {string} text
 * @param {Record<string,any>} acc
 * @param {{chatId?: string}} [options]
 */
export async function editMessage(messageId, text, acc, options = {}) {
  const token = String(acc?.botToken ?? acc?.token ?? '').trim()
  if (token === '') return { ok: false, detail: '账号缺少 token' }
  const id = String(messageId ?? '').trim()
  if (id === '') return { ok: false, detail: '要给消息 ID 才能改' }
  const body = String(text ?? '')
  if (body.trim() === '') return { ok: false, detail: '改成的正文不能为空（Telegram 不允许把消息改成空，要清掉请用撤回）' }

  const target = targetOf(acc)
  const chatId = String(options?.chatId ?? '').trim() !== '' ? String(options.chatId).trim() : (target === null ? '' : target.id)
  if (chatId === '') return { ok: false, detail: '不知道这条消息在哪个会话里 —— 账号没配「发送到」，记录里也没有位置' }

  const proxy = String(acc?.proxy ?? '').trim()
  const limit = Number(acc?.maxMessageChars) > 0 ? Number(acc.maxMessageChars) : MAX_CHARS
  if (body.length > limit) {
    return { ok: false, detail: '要改成的正文有 ' + body.length + ' 字，超过这个账号的 ' + limit + ' 字上限 —— 改消息不能分块，只能缩短' }
  }

  const { status, body: raw } = await postJson(
    'https://api.telegram.org/bot' + token + '/editMessageText',
    { chat_id: chatId, message_id: id, text: body, disable_web_page_preview: true },
    { proxy },
  )
  if (status === null) return { ok: false, detail: '连不上: ' + raw }
  const data = parseJson(raw, {}) ?? {}
  if (status !== 200 || data.ok !== true) {
    const desc = String(data?.description ?? raw).slice(0, 200)
    // 「message is not modified」= 内容一模一样，结果上等于成功。
    if (desc.includes('message is not modified')) return { ok: true, detail: '内容没变，Telegram 说无需修改（等同于成功）' }
    return { ok: false, detail: '改不动 HTTP ' + status + ': ' + desc }
  }
  return { ok: true, detail: '已改（消息 ' + id + '）' }
}

/**
 * 撤回一条消息（v0.29.0）。
 *
 * Telegram 的限制：机器人只能撤自己发的，且**超过 48 小时就撤不了**
 * （官方会在那种情况下回 400 Bad Request: message can't be deleted）。
 * 这个 48 小时是平台的硬限制，本插件无法绕过，所以原样把平台的拒绝转述出来。
 */
export async function deleteMessage(messageId, acc, options = {}) {
  const token = String(acc?.botToken ?? acc?.token ?? '').trim()
  if (token === '') return { ok: false, detail: '账号缺少 token' }
  const id = String(messageId ?? '').trim()
  if (id === '') return { ok: false, detail: '要给消息 ID 才能撤回' }

  const target = targetOf(acc)
  const chatId = String(options?.chatId ?? '').trim() !== '' ? String(options.chatId).trim() : (target === null ? '' : target.id)
  if (chatId === '') return { ok: false, detail: '不知道这条消息在哪个会话里 —— 账号没配「发送到」，记录里也没有位置' }

  const proxy = String(acc?.proxy ?? '').trim()
  const { status, body: raw } = await postJson(
    'https://api.telegram.org/bot' + token + '/deleteMessage',
    { chat_id: chatId, message_id: id },
    { proxy },
  )
  if (status === null) return { ok: false, detail: '连不上: ' + raw }
  const data = parseJson(raw, {}) ?? {}
  if (status !== 200 || data.ok !== true) {
    const desc = String(data?.description ?? raw).slice(0, 200)
    return { ok: false, detail: '撤不回 HTTP ' + status + ': ' + desc + '（Telegram 只允许撤自己发的、48 小时内的消息）' }
  }
  return { ok: true, detail: '已撤回（消息 ' + id + '）' }
}

/**
 * 给一条消息加表情回应（v0.30.0）。
 *
 * 交出去的是 **Unicode 字符本身**（👍），Telegram 的 reaction 参数形状是
 * `reaction: [{ type: 'emoji', emoji: '👍' }]` —— 是个数组，因为一条消息可以挂多个。
 * 本插件一次只挂一个，所以数组长度恒为 1。
 *
 * 传空 emoji = **清掉这个机器人挂过的所有表情**（reaction: []）。
 * 这是 Telegram 的语义：空数组等于「不再有任何反应」，不是「什么都不做」。
 */
export async function addReaction(messageId, emoji, acc, options = {}) {
  const token = String(acc?.botToken ?? acc?.token ?? '').trim()
  if (token === '') return { ok: false, detail: '账号缺少 token' }
  const id = String(messageId ?? '').trim()
  if (id === '') return { ok: false, detail: '要给消息 ID 才能加表情' }
  const key = String(emoji ?? '').trim()
  if (key.length > 64) return { ok: false, detail: '表情太长（' + key.length + ' 字符）—— 大概是整段正文被当成表情了' }

  const target = targetOf(acc)
  const chatId = String(options?.chatId ?? '').trim() !== '' ? String(options.chatId).trim() : (target === null ? '' : target.id)
  if (chatId === '') return { ok: false, detail: '不知道这条消息在哪个会话里 —— 账号没配「发送到」，记录里也没有位置' }

  const proxy = String(acc?.proxy ?? '').trim()
  const { status, body: raw } = await postJson(
    'https://api.telegram.org/bot' + token + '/setMessageReaction',
    { chat_id: chatId, message_id: id, reaction: key === '' ? [] : [{ type: 'emoji', emoji: key }] },
    { proxy },
  )
  if (status === null) return { ok: false, detail: '连不上: ' + raw }
  const data = parseJson(raw, {}) ?? {}
  if (status !== 200 || data.ok !== true) {
    const desc = String(data?.description ?? raw).slice(0, 200)
    // 「REACTION_INVALID」= 这个 emoji 不是 Telegram 认可的（有些字符不是 reaction）
    return { ok: false, detail: '加不上 HTTP ' + status + ': ' + desc + '（Telegram 只认它自己的 reaction 表情集，不是所有 emoji 都能当回应）' }
  }
  return { ok: true, detail: key === '' ? '已清掉表情（消息 ' + id + '）' : '已加 ' + key + '（消息 ' + id + '）' }
}

/**
 * 去掉一条消息上的表情回应。
 *
 * 删的方式是「把它清空」—— 传 []; 不是另有一个 deleteReaction 接口。
 * 注意这会把**机器人自己**挂的所有反应一起清掉（不是只清这一个）。
 */
export async function removeReaction(messageId, emoji, acc, options = {}) {
  const token = String(acc?.botToken ?? acc?.token ?? '').trim()
  if (token === '') return { ok: false, detail: '账号缺少 token' }
  const id = String(messageId ?? '').trim()
  if (id === '') return { ok: false, detail: '要给消息 ID 才能去表情' }

  const target = targetOf(acc)
  const chatId = String(options?.chatId ?? '').trim() !== '' ? String(options.chatId).trim() : (target === null ? '' : target.id)
  if (chatId === '') return { ok: false, detail: '不知道这条消息在哪个会话里' }

  const proxy = String(acc?.proxy ?? '').trim()
  const { status, body: raw } = await postJson(
    'https://api.telegram.org/bot' + token + '/setMessageReaction',
    { chat_id: chatId, message_id: id, reaction: [] },
    { proxy },
  )
  if (status === null) return { ok: false, detail: '连不上: ' + raw }
  const data = parseJson(raw, {}) ?? {}
  if (status !== 200 || data.ok !== true) {
    const desc = String(data?.description ?? raw).slice(0, 200)
    return { ok: false, detail: '去不掉 HTTP ' + status + ': ' + desc }
  }
  return { ok: true, detail: '已清掉机器人挂的表情（消息 ' + id + '）—— Telegram 没有「只删某一个」的接口，一次清空' }
}
