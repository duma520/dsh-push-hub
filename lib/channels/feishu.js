/**
 * lib/channels/feishu.js — 飞书 / Lark 自建应用机器人。
 *
 * 与 Python 版 pushhub/channels/feishu.py 对齐，两个易踩点：
 *   1. content 字段必须是「二次 JSON 字符串」，不是对象；
 *   2. receive_id_type 要按对端 ID 前缀选：oc_ 开头是 chat_id，否则 open_id。
 *
 * 群聊与 @：
 *   - 发群就用 chat_id（oc_ 开头），与单聊是同一端点，靠 receive_id_type 区分。
 *   - @ 用富文本语法写在 text 里：`<at user_id="ou_xxx">名字</at>`，
 *     @所有人 写 `<at user_id="all">所有人</at>`。这是飞书官方的 text 消息内联语法，
 *     不需要换 msg_type=post。
 *   - 用 user_id 而不是 open_id 时，属性名要换成 user_id="..."；本插件统一按
 *     ID 前缀自动选属性名，避免用户填错。
 *
 * @module channels/feishu
 */

import { postJson, parseJson } from '../http.js'
import { splitBlocks, sleep } from '../text.js'
import { targetOf, mentionOf, describeTarget } from '../mentions.js'

export const NAME = 'feishu'
export const MAX_CHARS = 2000
export const TITLE = '飞书'

/** 国内飞书 / 国际 Lark 域名不同。 */
function base(acc) {
  return String(acc?.domain ?? '').toLowerCase() === 'larksuite'
    ? 'https://open.larksuite.com'
    : 'https://open.feishu.cn'
}

/** 按 ID 前缀选 <at> 的属性名：ou_ = open_id，on_ = union_id，其余当 user_id。 */
function atAttr(id) {
  if (id.startsWith('ou_')) return 'open_id'
  if (id.startsWith('on_')) return 'union_id'
  return 'user_id'
}

/** 把 @ 拼进正文。 */
function withMentions(block, mention) {
  if (mention.mode === 'none') return block
  if (mention.mode === 'all') return '<at user_id="all">所有人</at> ' + block
  const prefix = mention.ids
    .map((id) => '<at ' + atAttr(id) + '="' + id + '"></at> ')
    .join('')
  return prefix + block
}

/** 取 tenant_access_token。 */
async function tenantToken(acc, host, proxy) {
  const { status, body } = await postJson(
    host + '/open-apis/auth/v3/tenant_access_token/internal',
    {
      app_id: String(acc?.appId ?? acc?.app_id ?? '').trim(),
      app_secret: String(acc?.appSecret ?? acc?.app_secret ?? acc?.secret ?? '').trim(),
    },
    { proxy },
  )
  if (status === null) return { ok: false, detail: '取 token 连不上: ' + body }
  const data = parseJson(body, {}) ?? {}
  const code = data?.code ?? null
  if (status !== 200 || (code !== 0 && code !== null)) {
    return { ok: false, detail: '取 token 失败 HTTP ' + status + ' code=' + code + ' msg=' + String(data?.msg ?? '') }
  }
  const token = String(data?.tenant_access_token ?? '').trim()
  if (token === '') return { ok: false, detail: '取 token 成功但返回为空' }
  return { ok: true, token }
}

/** 发一条消息（内部按 MAX_CHARS 分块）。 */
export async function send(text, acc, options = {}) {
  const appId = String(acc?.appId ?? acc?.app_id ?? '').trim()
  const secret = String(acc?.appSecret ?? acc?.app_secret ?? acc?.secret ?? '').trim()
  if (appId === '' || secret === '') return { ok: false, detail: '账号缺少 app_id / app_secret' }

  const target = targetOf(acc)
  if (target === null) {
    return { ok: false, detail: '还没选「发送到」。凭据没问题，只是不知道发给谁 —— 在账号那一行点「获取会话」选一个群（需要先把机器人拉进群），或手填对方 open_id（ou_ 开头）。' }
  }

  // 显式 target.kind='group' 时按 chat_id 发（哪怕 ID 不是 oc_ 前缀，例如自定义群 ID）。
  const receiveType = target.kind === 'group' || target.id.startsWith('oc_') ? 'chat_id' : 'open_id'
  const mention = mentionOf(acc)
  const host = base(acc)
  const proxy = String(acc?.proxy ?? '').trim()
  const limit = Number(acc?.maxMessageChars) > 0 ? Number(acc.maxMessageChars) : MAX_CHARS
  const delay = Number(options.delayMs) >= 0 ? Number(options.delayMs) : 350

  const auth = await tenantToken(acc, host, proxy)
  if (!auth.ok) return { ok: false, detail: auth.detail }

  const url = host + '/open-apis/im/v1/messages?receive_id_type=' + receiveType
  const blocks = splitBlocks(text, limit)
  let sent = 0
  // v0.28.0：飞书成功时回包里有 message_id（om_ 开头）。飞书官方有 PATCH 改消息的
  // 接口，但 dsh-im 也没实现，所以先只记下来，暂时不能改 / 撤。
  const ids = []
  for (let i = 0; i < blocks.length; i += 1) {
    const body = withMentions(blocks[i], mention)
    const { status, body: raw } = await postJson(
      url,
      { receive_id: target.id, msg_type: 'text', content: JSON.stringify({ text: body }) },
      { headers: { Authorization: 'Bearer ' + auth.token }, proxy },
    )
    if (status === null) return { ok: false, detail: '第 ' + (i + 1) + '/' + blocks.length + ' 块连不上: ' + raw }
    const data = parseJson(raw, {}) ?? {}
    const code = data?.code ?? null
    if (status !== 200 || (code !== 0 && code !== null)) {
      return { ok: false, detail: '第 ' + (i + 1) + '/' + blocks.length + ' 块失败 HTTP ' + status + ' code=' + code + ' msg=' + String(data?.msg ?? '') }
    }
    const mid = String(data?.message_id ?? '').trim()
    if (mid !== '') ids.push(mid)
    sent += 1
    if (i < blocks.length - 1) await sleep(delay)
  }
  return { ok: true, detail: '已发送 ' + sent + ' 块（' + receiveType + ' ' + target.id + '）', messageIds: ids }
}

/** 探测：用 tenant_access_token 端点到 token，就说明 appId/appSecret 可用。 */
export async function probe(acc) {
  const appId = String(acc?.appId ?? acc?.app_id ?? '').trim()
  const secret = String(acc?.appSecret ?? acc?.app_secret ?? acc?.secret ?? '').trim()
  if (appId === '' || secret === '') return { ok: false, detail: '缺少 appId / appSecret' }
  const host = base(acc)
  const r = await tenantToken(acc, host, String(acc?.proxy ?? '').trim())
  if (!r.ok) return { ok: false, detail: r.detail }
  return { ok: true, detail: '凭据可用（appId=' + appId + '）' }
}
