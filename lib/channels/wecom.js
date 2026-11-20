/**
 * lib/channels/wecom.js — 企业微信群机器人（Webhook）。
 *
 * 端点：POST https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<UUID>
 * 请求体：{ msgtype: 'text', text: { content, mentioned_list?, mentioned_mobile_list? } }
 * 成功判据：HTTP 200 且响应体 errcode === 0。
 *
 * 为什么只做群机器人：企业微信「自建应用」要先拿 corpId + secret 换 access_token，
 * 再用 /cgi-bin/message/send 按 touser（成员账号或 @all）发，配置面大得多；
 * 群机器人一条 Webhook URL 就够，且它是「发到群里」这个最常见的用途。
 *
 * @ 人是靠 mentioned_list（企业微信成员 userid，或写 '@all'）与
 * mentioned_mobile_list（手机号）——两者都在 text 对象里，不是独立字段。
 *
 * 已知限流：每个机器人每分钟最多 20 条，超了返 errcode 45009。
 * 单条 content 上限 2048 字节（不是字符），中文按 UTF-8 占 3 字节，所以这里
 * 按 600 个字符保守切块，避免中文长文被服务端截断。
 *
 * @module channels/wecom
 */

import { postJson, parseJson } from '../http.js'
import { splitBlocks, sleep } from '../text.js'
import { mentionOf } from '../mentions.js'

export const NAME = 'wecom'
export const MAX_CHARS = 600
export const TITLE = '企业微信（群机器人）'

/** qyapi 错误码 → 中文。只收最常见的，其余原样带回。 */
const WECOM_ERRORS = new Map([
  [93000, 'webhook key 不对：去群机器人设置里重新复制 Webhook 地址'],
  [45009, '发太快了：每个机器人每分钟最多 20 条，等一分钟再试'],
  [40058, '消息内容为空或超长（单条上限 2048 字节）'],
  [40008, '消息类型不对（这里只发 text）'],
  [40014, 'access_token 无效（群机器人不需要它，检查 URL 里是不是把 key 弄成了 token）'],
])

function explainWecom(code, msg) {
  const hit = WECOM_ERRORS.get(code)
  if (hit !== undefined) return hit + '（errcode=' + code + '）'
  return 'errcode=' + code + ' ' + String(msg ?? '')
}

/** 取 webhook 里的 key：允许给整条 URL，也允许只给 key。 */
function keyOf(acc) {
  const raw = String(acc?.webhookUrl ?? acc?.resource ?? acc?.key ?? '').trim()
  if (raw === '') return ''
  const m = raw.match(/[?&]key=([^&\s]+)/)
  if (m) return decodeURIComponent(m[1])
  return raw
}

/**
 * 发一条消息（内部按 MAX_CHARS 分块）。
 * @param {string} text
 * @param {Record<string,any>} acc
 * @param {{delayMs?: number}} [options]
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
export async function send(text, acc, options = {}) {
  const key = keyOf(acc)
  if (key === '') return { ok: false, detail: '账号缺少 webhook 地址（企业微信群 → 群机器人 → 复制 Webhook）' }
  const mention = mentionOf(acc)
  const proxy = String(acc?.proxy ?? '').trim()
  const limit = Number(acc?.maxMessageChars) > 0 ? Number(acc.maxMessageChars) : MAX_CHARS
  const delay = Number(options.delayMs) >= 0 ? Number(options.delayMs) : 1200
  const url = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=' + encodeURIComponent(key)
  const blocks = splitBlocks(text, limit)

  // 企业微信的 @ 语法：mentioned_list 里写成员 userid，或直接写 '@all'。
  const mentioned = mention.mode === 'none' ? [] : mention.mode === 'all' ? ['@all'] : mention.ids
  let sent = 0
  for (let i = 0; i < blocks.length; i += 1) {
    const body = { msgtype: 'text', text: { content: blocks[i] } }
    // 只在最后一块里 @ 人，否则每块都会响一次提醒。
    if (mentioned.length > 0 && i === blocks.length - 1) body.text.mentioned_list = mentioned
    const { status, body: raw } = await postJson(url, body, { proxy })
    if (status === null) return { ok: false, detail: '第 ' + (i + 1) + '/' + blocks.length + ' 块连不上: ' + raw }
    const data = parseJson(raw, {}) ?? {}
    const code = Number(data.errcode ?? 0)
    if (status !== 200 || code !== 0) {
      const detail = explainWecom(Number.isFinite(code) ? code : -1, data.errmsg ?? String(raw).slice(0, 200))
      return { ok: false, detail: '第 ' + (i + 1) + '/' + blocks.length + ' 块失败 HTTP ' + status + ': ' + detail }
    }
    sent += 1
    if (i < blocks.length - 1) await sleep(delay)
  }
  return { ok: true, detail: '已发送 ' + sent + ' 块（企业微信群机器人）' }
}

/** 探测：群机器人没有只读接口，只校验 key 形状。 */
export async function probe(acc) {
  const key = keyOf(acc)
  if (key === '') {
    return { ok: false, detail: '缺少 webhook 地址（企业微信群 → 右上角 → 群机器人 → 添加 → 复制 Webhook，形如 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…）' }
  }
  // 企业微信的 webhook key 是 UUID 形式（8-4-4-4-12）。
  if (!/^[0-9a-fA-F-]{32,40}$/.test(key)) {
    return { ok: false, detail: 'key 看起来不像企业微信的 webhook key（应为 UUID 形式，36 位带连字符）；注意别把「自建应用」的 corpsecret 填到这里' }
  }
  return { ok: true, detail: 'webhook 地址已就绪；企业微信没有只读探测接口，真通不通要点「发条测试消息」' }
}