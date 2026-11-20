/**
 * lib/channels/dingtalk.js — 钉钉（群自定义机器人 Webhook）。
 *
 * 为什么只做 webhook 这一种：钉钉的内部应用机器人要先换 access_token 再调
 * /v1.0/robot/oToMessages/batchSend，还得给每个收件人算 userid；而群自定义
 * 机器人只要一条 URL 就能发，凭据少一半、出错面小得多。企业内应用那套等有人
 * 真要用再加（届时走 appKey/appSecret + api.dingtalk.com）。
 *
 * 端点：POST https://oapi.dingtalk.com/robot/send?access_token=xxx
 * 请求体：{ msgtype: 'text', text: { content } }
 * 成功判据：HTTP 200 且响应体 errcode === 0。
 *
 * 加签（可选）：机器人安全设置里勾了「加签」就必须带 timestamp + sign，
 * sign = base64(HMAC-SHA256(key = secret, data = timestamp + '\n' + secret))。
 * 只用「自定义关键词」或「IP 白名单」的机器人不需要它。
 *
 * 已知限流：每个机器人每分钟最多 20 条，超了返 errcode 130101。
 *
 * @module channels/dingtalk
 */

import { createHmac } from 'node:crypto'
import { postJson, parseJson } from '../http.js'
import { splitBlocks, sleep } from '../text.js'

export const NAME = 'dingtalk'
export const MAX_CHARS = 3000
export const TITLE = '钉钉'

/** oapi 的业务错误码 → 能直接照做的中文（100/300xxx 都是钉钉自定义机器人那套）。 */
const DINGTALK_ERRORS = new Map([
  [300001, 'token 不对：webhook 地址里的 access_token 是错的，或者这个机器人已经被删了'],
  [300005, '这个机器人没开任何安全方式：去钉钉群 → 群设置 → 机器人里选「加签」或「自定义关键词」'],
  [310000, '加签校验失败：secret 填错了，或者本机时间偏太多（允许差 1 小时）'],
  [130101, '发太快了：每个机器人每分钟最多 20 条，等一分钟再试'],
])

/** 把 oapi 的错误码翻成人话；不认识的码原样带回。 */
function explain(code, msg) {
  const hit = DINGTALK_ERRORS.get(code)
  if (hit !== undefined) return hit + '（errcode=' + code + '）'
  return 'errcode=' + code + ' ' + String(msg ?? '')
}

/** 取 access_token：允许直接给整条 webhook URL，也允许只给 token。 */
function accessTokenOf(acc) {
  const raw = String(acc?.webhookUrl ?? acc?.resource ?? acc?.accessToken ?? '').trim()
  if (raw === '') return ''
  const m = raw.match(/[?&]access_token=([^&\s]+)/)
  if (m) return decodeURIComponent(m[1])
  return raw
}

/** 按加签规则算出查询串；secret 为空则不签。 */
function signedQuery(secret) {
  if (secret === '') return ''
  const timestamp = String(Date.now())
  const sign = createHmac('sha256', secret).update(timestamp + '\n' + secret).digest('base64')
  return '&timestamp=' + encodeURIComponent(timestamp) + '&sign=' + encodeURIComponent(sign)
}

/**
 * 发一条消息（内部按 MAX_CHARS 分块）。
 * @param {string} text
 * @param {Record<string,any>} acc
 * @param {{delayMs?: number}} [options]
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
export async function send(text, acc, options = {}) {
  const token = accessTokenOf(acc)
  if (token === '') return { ok: false, detail: '账号缺少 webhook 地址（钉钉群 → 机器人 → 自定义 → 复制 Webhook）' }
  const secret = String(acc?.secret ?? acc?.signSecret ?? '').trim()
  const proxy = String(acc?.proxy ?? '').trim()
  const limit = Number(acc?.maxMessageChars) > 0 ? Number(acc.maxMessageChars) : MAX_CHARS
  const delay = Number(options.delayMs) >= 0 ? Number(options.delayMs) : 1200
  const url = 'https://oapi.dingtalk.com/robot/send?access_token=' + encodeURIComponent(token) + signedQuery(secret)
  const blocks = splitBlocks(text, limit)

  let sent = 0
  for (let i = 0; i < blocks.length; i += 1) {
    const { status, body } = await postJson(url, { msgtype: 'text', text: { content: blocks[i] } }, { proxy })
    if (status === null) return { ok: false, detail: '第 ' + (i + 1) + '/' + blocks.length + ' 块连不上: ' + body }
    const data = parseJson(body, {}) ?? {}
    const code = Number(data.errcode ?? 0)
    if (status !== 200 || code !== 0) {
      const detail = explain(Number.isFinite(code) ? code : -1, data.errmsg ?? String(body).slice(0, 200))
      return { ok: false, detail: '第 ' + (i + 1) + '/' + blocks.length + ' 块失败 HTTP ' + status + ': ' + detail }
    }
    sent += 1
    if (i < blocks.length - 1) await sleep(delay)
  }
  return { ok: true, detail: '已发送 ' + sent + ' 块（钉钉群机器人）' }
}

/**
 * 探测：钉钉的自定义机器人没有只读接口（发空文本会被当成空消息拒掉），
 * 所以这里只校验地址与加签 secret 的形状，真通不通要看「发条测试消息」。
 */
export async function probe(acc) {
  const token = accessTokenOf(acc)
  if (token === '') {
    return { ok: false, detail: '缺少 webhook 地址（去钉钉群 → 机器人 → 自定义 → 复制 Webhook，形如 https://oapi.dingtalk.com/robot/send?access_token=…）' }
  }
  const secret = String(acc?.secret ?? acc?.signSecret ?? '').trim()
  if (secret !== '' && !secret.startsWith('SEC')) {
    return { ok: false, detail: '加签 secret 一般以 SEC 开头，现在填的看起来不像（如果你的机器人用的是关键词或 IP 白名单，把 secret 留空即可）' }
  }
  const note = secret === '' ? '（未配加签）' : '（含加签）'
  return { ok: true, detail: 'webhook 地址已就绪' + note + '；钉钉没有只读探测接口，真通不通要点「发条测试消息」' }
}