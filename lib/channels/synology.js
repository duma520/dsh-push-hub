/**
 * lib/channels/synology.js — 群晖 Chat（Synology Chat）。
 *
 * v0.40.0 起，账号字段 type 与群晖面板「整合」的三种类型一一对应：
 *
 *   1) type='incoming'（默认，兼容老值 'webhook' 与空值）——「整合 → 传入的 Webhook」
 *      POST 用户自建 URL，body 是**表单编码** payload=<json>，json 形如 {"text": "..."}；
 *      成功只认 HTTP 200 / 201。token 已嵌在 URL 里（...&token=%22xxxx%22）。
 *      协议依据：Home Assistant core synology_chat/notify.py。
 *
 *   2) type='outgoing' ——「整合 → 发出的 Webhook」
 *      面板上要填的是**你自己服务器上的 URL**：群晖在事件发生时向它发请求，
 *      令牌用于你这一侧验签。也就是说这个方向是 **群晖 → 你**，不是 **你 → 群晖**。
 *      本插件不监听公网（DSH 宿主只监听 127.0.0.1:9429），所以这一项**发不出消息**，
 *      只做登记与展示；send() 遇到它会在本地直接拒绝，不发任何网络请求。
 *
 *   3) type='bot' ——「整合 → 机器人」
 *      面板给三项：传入 URL / 传出 URL / 令牌。**传入 URL** 就是发消息要 POST 的地址；
 *      没填时回落成 {nasUrl}/webapi/entry.cgi?api=SYNO.Chat.External&method=chatbot&version=2&token=<token>。
 *      body 同为表单编码 payload=<json>，json 形如 {"text": "...", "user_ids": [5]}
 *      协议依据：synology-api 库 synology_api/chat.py 的 ChatBot.send_message
 *      （注释原文：Uses method=chatbot which is the correct endpoint for
 *      bot-originated messages. The incoming method only works with webhook
 *      tokens, not bot tokens.）
 *      **注意**：bot 只能发单聊（user_ids 是数字用户 ID），不能发频道。
 *      「传出 URL」同样只是群晖回调你的地址，本插件只登记、不使用。
 *
 * 群聊语义：群晖的「频道」= 群，传入的 Webhook 天然发到它绑定的那个频道；
 * bot 走 user_ids 只能点对点。此差异在 detail 里如实说明。
 *
 * 【NAS 地址怎么填（踩过两次的坑）】
 *  - DSM 的 Chat 端口（默认 5001）是 **HTTPS**。填 http:// 会得到
 *    「400 The plain HTTP request was sent to HTTPS port」。
 *  - 用局域网 IP（https://192.0.2.65:65001）会撞 NAS 自签证书：
 *    Node 的 fetch 报 `ERR_TLS_CERT_ALTNAME_INVALID`，而 lib/http.js 的直连
 *    走全局 fetch 没法关证书校验。
 *  - 正解是填 **QuickConnect 传入 URL 的域名**（证书是有效的）：
 *    `https://192-168-1-10.xxx.quickconnect.cn:5001`，例如实测可用的
 *    `https://192-168-1-10.xxxx.quickconnect.cn:65001`。
 *  - 协议细节仍以 synology-api 的 chat.py 为准。
 *
 * @module channels/synology
 */

import { postForm, getJson, parseJson } from '../http.js'
import { splitBlocks, sleep } from '../text.js'

export const NAME = 'synology_chat'
export const MAX_CHARS = 2000
export const TITLE = '群晖 Chat'

const EP = '/webapi/entry.cgi'

/** 三种整合类型的规范值（界面下拉就用这三个）。 */
export const TYPES = ['incoming', 'outgoing', 'bot']

/**
 * 把存盘的 type 归一成三个规范值之一。
 *
 * 老配置里可能是 'webhook'（v0.39.x 及更早）或根本没有这个键，
 * 两者都按「传入的 Webhook」处理 —— 那正是它当年的行为。
 *
 * @param {any} value
 * @returns {'incoming'|'outgoing'|'bot'}
 */
export function normalizeType(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (text === 'bot') return 'bot'
  if (text === 'outgoing') return 'outgoing'
  // 'webhook' / 'incoming' / '' / 其它未知值 → 传入的 Webhook
  return 'incoming'
}

/** 规范化 NAS 地址：去掉尾部斜杠与已经带上来的 entry.cgi。 */
function nasEntry(nasUrl) {
  let base = String(nasUrl ?? '').trim().replace(/\/+$/, '')
  if (base === '') return ''
  if (!/^https?:\/\//i.test(base)) base = 'https://' + base
  if (base.endsWith('/webapi/entry.cgi')) return base
  return base + EP
}

/**
 * 群晖 Chat 的错误码 → 中文可操作提示。
 *
 * 这些码来自 SYNO.Chat.External 的 error.code（DSM 7.3.2 / Chat Server 2.4.5 实测）：
 * 最坑的一条是 404 —— 它不代表「地址错了」，而是「token 类型用错了」：
 * webhook token 调只读接口（channel_list / user_list）恒返回 404。
 */
const CHAT_ERRORS = {
  101: '参数不对（token 或 user_ids 的格式有问题）',
  102: '这个 API 在 NAS 上不存在，多半是没装或没启用 Chat Server',
  103: '方法不存在，检查 NAS 上的 Chat Server 版本',
  105: '没有权限，通常是 token 类型用错了（webhook token 不能调只读接口，bot token 不能用 incoming）',
  117: '已经加入过了（不是错误）',
  119: '当前身份没有这个权限',
  401: 'bot 不是该频道成员，先在群晖 Chat 里把它拉进频道',
}

// 404 在两种场景下含义完全不同，不能一句话糊过去（实测确认过）：
//  - 探测 / 只读调用：token 类型不对，webhook token 调 channel_list / user_list 恒返回 404。
//  - 发送消息：URL 里的令牌已经失效。整合被删除或重建、或重新生成过一次令牌之后，
//    旧 Webhook URL 里的 token 就不再匹配任何整合；此时随便换一个 64 位串都会返回
//    一模一样的 404（用垃圾 token 交叉验证过），所以它跟「类型不对」没关系。
const ERR_404_PROBE = 'token 类型不对：webhook token 调只读接口会返回 404，请改用 bot token'
const ERR_404_SEND = 'URL 里的令牌已失效（整合被删除或重建后，旧 URL 里的 token 就不再匹配了）—— ' +
  '回群晖面板「整合 → 传入的 Webhook」重新复制整条 Webhook URL 覆盖掉现在这条'

/**
 * 把接口返回的 error 翻成一句人话。
 *
 * @param {any} data parseJson 之后的响应体（可能为 null）
 * @param {number|null} status HTTP 状态码
 * @param {string} body 原始响应文本（解析失败时兜底展示）
 * @param {'send'|'probe'|string} [context] 调用场景，只有 404 的措辞会因此不同
 * @returns {string}
 */
export function explainChatError(data, status, body, context) {
  const code = Number(data?.error?.code)
  if (code === 404) return (context === 'send' ? ERR_404_SEND : ERR_404_PROBE) + '（code=404）'
  const hint = Number.isInteger(code) ? CHAT_ERRORS[code] : undefined
  if (hint !== undefined) return hint + '（code=' + code + '）'
  const raw = data === null ? String(body ?? '') : JSON.stringify(data?.error ?? data)
  return 'HTTP ' + String(status) + '：' + raw.slice(0, 200)
}

/**
 * 解析「传入的 Webhook」的发送地址。
 *
 * 两种填法都认：
 *   1) 直接填完整的「Webhook URL」（推荐，群晖 UI 里复制得到）；
 *   2) 只填 NAS 地址 + 64 位 webhook token —— 由这里拼成 incoming URL。
 *      很多人手里只有一个 token，硬要求他手拼 URL 是多余的。
 *
 * @param {Record<string,any>} acc
 * @returns {string} 完整 URL；拼不出来返回 ''
 */
export function resolveWebhookUrl(acc) {
  const direct = String(acc?.webhookUrl ?? acc?.resource ?? '').trim()
  if (direct !== '') return direct
  const token = String(acc?.token ?? '').trim()
  if (token === '') return ''
  const entry = nasEntry(acc?.nasUrl)
  if (entry === '') return ''
  return entry + '?api=SYNO.Chat.External&method=incoming&version=2&token=' + encodeURIComponent(token)
}

/**
 * 解析「机器人」的发送地址。
 *
 * 优先进面板给的「传入 URL」（它已经带好了 method 与 token，原样用最稳）；
 * 没填才回落到 NAS 地址 + 令牌拼 chatbot 端点（老配置走的就是这条路）。
 *
 * @param {Record<string,any>} acc
 * @returns {string} 完整 URL；拼不出来返回 ''
 */
export function resolveBotUrl(acc) {
  const direct = String(acc?.incomingUrl ?? '').trim()
  if (direct !== '') return direct
  const token = String(acc?.token ?? acc?.botToken ?? '').trim()
  if (token === '') return ''
  const entry = nasEntry(acc?.nasUrl)
  if (entry === '') return ''
  return entry + '?api=SYNO.Chat.External&method=chatbot&version=2&token=' + encodeURIComponent(token)
}

/** 发一条消息（内部按 MAX_CHARS 分块）。 */
export async function send(text, acc, options = {}) {
  const proxy = String(acc?.proxy ?? '').trim()
  const limit = Number(acc?.maxMessageChars) > 0 ? Number(acc.maxMessageChars) : MAX_CHARS
  const delay = Number(options.delayMs) >= 0 ? Number(options.delayMs) : 1500
  const blocks = splitBlocks(text, limit)
  const type = normalizeType(acc?.type)

  if (type === 'outgoing') {
    // 这个方向的箭头是反的：群晖往「你填的 URL」发请求，不是我们往群晖发。
    // 拿它去发消息在协议上没有对应接口，所以这里直接本地拒绝，连一个请求都不发。
    return {
      ok: false,
      detail: '「发出的 Webhook」是“群晖 → 你”的方向：你在面板里填的是自己的回调地址，群晖在事件发生时往那里发请求，' +
        '它没有“发消息进群晖”的接口。要发消息请把类型改成「传入的 Webhook」或「机器人」。',
    }
  }
  if (type === 'bot') return sendBot(blocks, acc, proxy, delay)
  return sendWebhook(blocks, acc, proxy, delay)
}

/** 传入的 Webhook：token 已在 URL 里。 */
async function sendWebhook(blocks, acc, proxy, delay) {
  const url = resolveWebhookUrl(acc)
  if (url === '') {
    return {
      ok: false,
      detail: '「传入的 Webhook」需要「Webhook URL」，或者填 NAS 地址 + 令牌（群晖 Chat 里「整合 → 传入的 Webhook」生成）',
    }
  }
  if (!/^https?:\/\//i.test(url)) return { ok: false, detail: 'Webhook URL 必须以 http:// 或 https:// 开头' }
  // 局域网 IP 一定撞 NAS 的自签证书：与其等 fetch 抛 TLS 异常再倒推原因，
  // 不如在发请求之前就把「换成 QuickConnect 域名」这条出路直接说出来。
  const lanBlock = lanCertHint(url)
  if (lanBlock !== '') return { ok: false, detail: lanBlock }

  let sent = 0
  for (let i = 0; i < blocks.length; i += 1) {
    const payload = JSON.stringify({ text: blocks[i] })
    const { status, body } = await postForm(url, { payload }, { proxy })
    if (status === null) return { ok: false, detail: '第 ' + (i + 1) + '/' + blocks.length + ' 块连不上: ' + explainNet(body) }
    if (status !== 200 && status !== 201) {
      const data = parseJson(body, null)
      return {
        ok: false,
        detail: '第 ' + (i + 1) + '/' + blocks.length + ' 块失败 ' + explainChatError(data, status, body, 'send'),
      }
    }
    sent += 1
    if (i < blocks.length - 1) await sleep(delay)
  }
  return { ok: true, detail: '已发送 ' + sent + ' 块（传入的 Webhook）' }
}

/** 机器人（Bot）：传入 URL（或 NAS 地址 + 令牌）+ user_ids。 */
async function sendBot(blocks, acc, proxy, delay) {
  const url = resolveBotUrl(acc)
  if (url === '') {
    return { ok: false, detail: '「机器人」需要「传入 URL」，或者填 NAS 地址 + 令牌（群晖 Chat 里「整合 → 机器人」生成）' }
  }
  if (!/^https?:\/\//i.test(url)) return { ok: false, detail: '传入 URL 必须以 http:// 或 https:// 开头' }
  const lanBlockBot = lanCertHint(url)
  if (lanBlockBot !== '') return { ok: false, detail: lanBlockBot }

  // userIds 可能是数组，也可能是界面填的逗号串（"5,6"）——两种都要认，
  // 否则界面上填了用户 ID 却永远发不出去（会被判成「没有 userIds」）。
  const rawIds = Array.isArray(acc?.userIds)
    ? acc.userIds
    : String(acc?.userIds ?? '').trim() !== ''
      ? String(acc.userIds).split(/[,，\s]+/)
      : Array.isArray(acc?.allowFrom) ? acc.allowFrom : []
  const userIds = rawIds
    .map((v) => Number(String(v).trim()))
    .filter((v) => Number.isInteger(v) && v > 0)
  if (userIds.length === 0) {
    return { ok: false, detail: '「机器人」需要用户 ID（群晖 Chat 用户 ID 是数字，可在「用户」列表里看到）' }
  }

  let sent = 0
  for (let i = 0; i < blocks.length; i += 1) {
    const payload = JSON.stringify({ text: blocks[i], user_ids: userIds })
    const { status, body } = await postForm(url, { payload }, { proxy })
    if (status === null) return { ok: false, detail: '第 ' + (i + 1) + '/' + blocks.length + ' 块连不上: ' + explainNet(body) }
    const data = parseJson(body, null)
    const success = data?.success
    if (status !== 200 || success === false) {
      return {
        ok: false,
        detail: '第 ' + (i + 1) + '/' + blocks.length + ' 块失败 ' + explainChatError(data, status, body, 'send'),
      }
    }
    sent += 1
    if (i < blocks.length - 1) await sleep(delay)
  }
  return { ok: true, detail: '已发送 ' + sent + ' 块（机器人 → user_ids=' + userIds.join(',') + '）' }
}

/**
 * 局域网 IP 的预警：NAS 的自签证书一定过不了 Node 的 fetch 校验。
 *
 * 实测 `https://192.0.2.65/` 会得到 ERR_TLS_CERT_ALTNAME_INVALID（证书 CN 对不上），
 * 而 lib/http.js 的直连走全局 fetch，没法关掉证书校验。所以命中私有网段时
 * 直接给出「换 QuickConnect 域名」这条唯一可行路径，而不是等 TLS 报错再解释。
 *
 * @param {string} url 拼好的发送地址
 * @returns {string} 命中局域网 IP 时返回提示，否则空串（公网域名/IP 一律放行）
 */
export function lanCertHint(url) {
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    return ''
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (m === null) return ''
  const a = Number(m[1])
  const b = Number(m[2])
  const isPrivate = a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
  if (!isPrivate) return ''
  return '这个地址是局域网 IP（' + host + '），NAS 用的是自签证书，Node 的 fetch 会因证书校验失败（ERR_TLS_CERT_ALTNAME_INVALID）而连不上。' +
    '把地址换成群晖 QuickConnect 的域名（形如 https://192-168-1-10.xxxx.quickconnect.cn:5001…），它的证书是有效的'
}

/**
 * 把网络层异常翻成一句带解决办法的中文。
 *
 * 这两条都实测踩过，用户看到原文只会以为是「地址填错了」：
 *  - 400 + plain HTTP ... HTTPS port  → 协议写错了（该用 https）
 *  - fetch failed / ALTNAME_INVALID   → 自签证书，改 QuickConnect 域名
 */
function explainNet(detail) {
  const text = String(detail ?? '')
  if (/plain HTTP request was sent to HTTPS port/i.test(text)) {
    return '这个端口是 HTTPS，地址却写了 http:// —— 把 NAS 地址改成 https:// 开头（' + text.slice(0, 120) + '）'
  }
  if (/ALTNAME_INVALID|CERT_|self.signed|fetch failed/i.test(text)) {
    return '连不上 NAS 的证书校验（NAS 用的是自签证书，Node 的 fetch 不认）。' +
      '改用 QuickConnect 的传入 URL 域名，例如 https://192-168-1-10.xxxx.quickconnect.cn:5001，它的证书是有效的（' + text.slice(0, 120) + '）'
  }
  return text
}

/**
 * 探测凭据：机器人用 channel_list（webhook token 会返回 404），
 * 「传入的 Webhook」没有只读接口只能查地址是否拼得出，
 * 「发出的 Webhook」方向相反，本插件不参与发送。
 */
export async function probe(acc) {
  const type = normalizeType(acc?.type)
  const proxy = String(acc?.proxy ?? '').trim()

  if (type === 'outgoing') {
    return {
      ok: false,
      detail: '「发出的 Webhook」不需要检查凭据 —— 它是群晖回调你的地址，本插件既不发也不收。' +
        (String(acc?.outgoingUrl ?? '').trim() === ''
          ? '面板上的「URL」与「令牌」建议先填上留档。'
          : '已登记回调地址：' + String(acc.outgoingUrl).trim().slice(0, 80)),
    }
  }

  if (type === 'incoming') {
    // webhook token 只有 incoming 一个方法，任何只读调用都返回 404，
    // 所以这里不能假装探测成功 —— 但可以先把「URL 拼得出来吗」查掉，
    // 这是这种类型唯一能在不发消息时排除的失败原因。
    const url = resolveWebhookUrl(acc)
    if (url === '') {
      return { ok: false, detail: '「传入的 Webhook」需要「Webhook URL」，或 NAS 地址 + 令牌；两样都没填' }
    }
    return { ok: true, detail: 'Webhook URL 已就绪，但它没有只读接口，真通不通要看「发条测试消息」' }
  }

  const token = String(acc?.token ?? acc?.botToken ?? '').trim()
  const entry = nasEntry(acc?.nasUrl)
  if (token === '') return { ok: false, detail: '缺少令牌（群晖 Chat 里「整合 → 机器人」生成）' }
  if (entry === '') return { ok: false, detail: '缺少 NAS 地址（例如 https://192.168.1.10:5001）' }

  const call = async (method) => {
    const url = entry + '?api=SYNO.Chat.External&method=' + method + '&version=2&token=' + encodeURIComponent(token)
    const { status, body } = await getJson(url, { proxy })
    if (status === null) return { ok: false, detail: '连不上 NAS: ' + explainNet(body) }
    const data = parseJson(body, null)
    if (status !== 200 || data?.success !== true) {
      return { ok: false, detail: explainChatError(data, status, body) }
    }
    return { ok: true, data }
  }

  // channel_list 验证 token 本身；user_list 验证能不能真发（bot 只认 user_ids）。
  const ch = await call('channel_list')
  if (!ch.ok) return { ok: false, detail: '令牌不可用：' + ch.detail }
  const channels = Array.isArray(ch.data?.data?.channels) ? ch.data.data.channels.length : null

  const us = await call('user_list')
  if (!us.ok) {
    return {
      ok: true,
      detail: '令牌可用（可见 ' + (channels === null ? '若干' : channels) + ' 个频道），但列不出用户：' + us.detail +
        '。机器人只能点对点发，列不出用户就发不出去',
    }
  }
  const users = Array.isArray(us.data?.data?.users) ? us.data.data.users.length : 0
  if (users === 0) {
    return { ok: false, detail: '令牌可用，但 NAS 上没有对机器人可见的用户，用户 ID 无从填起' }
  }
  return {
    ok: true,
    detail: '令牌可用；可见 ' + (channels === null ? '若干' : channels) + ' 个频道、' + users + ' 个用户',
  }
}
