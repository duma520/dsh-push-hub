/**
 * lib/channels/wecom_app.js — 企业微信自建应用（应用消息）。
 *
 * 与 wecom.js（群机器人）是两套完全不同的东西：
 *   - 群机器人：一条 Webhook URL，发到「那个群」，没法指定人；
 *   - 自建应用：corpId + secret 换 access_token，再调 /cgi-bin/message/send，
 *     能按成员账号（touser）或部门（toparty）精确投递，也能发给「全部成员」。
 *
 * 端点：POST https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=…&corpsecret=…
 *       POST https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=…
 * 请求体：{ touser, msgtype: 'text', agentid, text: { content } }
 * 成功判据：HTTP 200 且 errcode === 0（注意：即使部分成员无效，errcode 也可能是 0，
 * 无效成员在 invaliduser 字段里 —— 那种情况按成功处理但在 detail 里点出来）。
 *
 * access_token 有效期 7200 秒且调用会顶掉旧 token，所以这里**每次发信都重新换一次**，
 * 不做缓存 —— 缓存反而会跟其它程序互相顶掉，换来换去更容易出错。
 *
 * 单条 content 上限 2048 字节（中文按 UTF-8 占 3 字节），按 600 字符保守切块。
 * 限流：每个应用每分钟最多 600 次（比群机器人宽得多）。
 *
 * @module channels/wecom_app
 */

import { postJson, getJson, parseJson } from '../http.js'
import { splitBlocks, sleep } from '../text.js'

export const NAME = 'wecom_app'
export const MAX_CHARS = 600
export const TITLE = '企业微信（自建应用）'

/** qyapi 错误码 → 中文。 */
const WECOM_APP_ERRORS = new Map([
  [40001, 'secret 不对，或者 corpId 与 secret 不配套'],
  [40013, 'corpId 不对（企业微信「我的企业」里那串 ww 开头的 ID）'],
  [40056, 'agentid 不对：在「应用管理 → 你的应用」页顶部的 AgentId'],
  [40014, 'access_token 无效（本插件每次发送都会重新换，出现这个通常是 corpId/secret 刚被改过）'],
  [60020, '这台机器的 IP 不在应用的「企业可信IP」里，去应用详情页加上'],
  [81013, '收件人全部无效：touser 里的成员账号不存在（成员账号不是昵称，是「账号」那栏）'],
  [45009, '发太快被限流了，等一分钟再试'],
])

function explainWecomApp(code, msg) {
  const hit = WECOM_APP_ERRORS.get(code)
  if (hit !== undefined) return hit + '（errcode=' + code + '）'
  return 'errcode=' + code + ' ' + String(msg ?? '')
}

/** 换 access_token；失败返回 { ok:false, detail }。 */
async function fetchToken(acc, proxy) {
  const corpId = String(acc?.corpId ?? acc?.corpid ?? '').trim()
  const secret = String(acc?.corpSecret ?? acc?.secret ?? '').trim()
  if (corpId === '') return { ok: false, detail: '账号缺少 corpId（企业微信「我的企业」页底部的企业 ID，ww 开头）' }
  if (secret === '') return { ok: false, detail: '账号缺少应用 secret（「应用管理 → 你的应用」里的 Secret）' }
  const url = 'https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=' + encodeURIComponent(corpId) + '&corpsecret=' + encodeURIComponent(secret)
  const { status, body } = await getJson(url, { proxy })
  if (status === null) return { ok: false, detail: '换 token 连不上: ' + body }
  const data = parseJson(body, {}) ?? {}
  const code = Number(data.errcode ?? 0)
  if (status !== 200 || code !== 0) {
    return { ok: false, detail: '换 token 失败: ' + explainWecomApp(Number.isFinite(code) ? code : -1, data.errmsg ?? String(body).slice(0, 200)) }
  }
  const token = String(data.access_token ?? '').trim()
  if (token === '') return { ok: false, detail: '换 token 失败：企业微信返回里没有 access_token' }
  return { ok: true, token }
}

/**
 * 发一条消息（内部按 MAX_CHARS 分块）。
 * @param {string} text
 * @param {Record<string,any>} acc
 * @param {{delayMs?: number}} [options]
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
export async function send(text, acc, options = {}) {
  const agentId = String(acc?.agentId ?? acc?.agentid ?? '').trim()
  if (agentId === '') return { ok: false, detail: '账号缺少 agentId（「应用管理 → 你的应用」页顶部的 AgentId，纯数字）' }
  const toUser = String(acc?.target?.id ?? acc?.toUser ?? acc?.touser ?? '').trim()
  if (toUser === '') {
    return { ok: false, detail: '还没填「发送到」。自建应用要收件人的成员账号（不是昵称，是「通讯录 → 成员 → 账号」那栏），也可以填 @all 发给全部成员。' }
  }
  const proxy = String(acc?.proxy ?? '').trim()
  const tokenResult = await fetchToken(acc, proxy)
  if (tokenResult.ok !== true) return { ok: false, detail: tokenResult.detail }
  const token = tokenResult.token

  const limit = Number(acc?.maxMessageChars) > 0 ? Number(acc.maxMessageChars) : MAX_CHARS
  const delay = Number(options.delayMs) >= 0 ? Number(options.delayMs) : 1200
  const url = 'https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=' + encodeURIComponent(token)
  const blocks = splitBlocks(text, limit)

  let sent = 0
  const invalid = new Set()
  for (let i = 0; i < blocks.length; i += 1) {
    const { status, body } = await postJson(url, {
      touser: toUser,
      msgtype: 'text',
      agentid: Number(agentId),
      text: { content: blocks[i] },
    }, { proxy })
    if (status === null) return { ok: false, detail: '第 ' + (i + 1) + '/' + blocks.length + ' 块连不上: ' + body }
    const data = parseJson(body, {}) ?? {}
    const code = Number(data.errcode ?? 0)
    if (status !== 200 || code !== 0) {
      const detail = explainWecomApp(Number.isFinite(code) ? code : -1, data.errmsg ?? String(body).slice(0, 200))
      return { ok: false, detail: '第 ' + (i + 1) + '/' + blocks.length + ' 块失败 HTTP ' + status + ': ' + detail }
    }
    // errcode 0 也可能有部分成员无效，这种情况按成功处理但要点出来。
    const bad = String(data.invaliduser ?? '').trim()
    if (bad !== '') for (const one of bad.split('|')) if (one !== '') invalid.add(one)
    sent += 1
    if (i < blocks.length - 1) await sleep(delay)
  }

  let note = '已发送 ' + sent + ' 块（自建应用 → ' + toUser + '）'
  if (invalid.size > 0) note += '；这些账号无效已跳过：' + [...invalid].join('、')
  return { ok: true, detail: note }
}

/** 探测：换一次 token 就说明 corpId/secret 这一组是对的（不碰 agentId 与收件人）。 */
export async function probe(acc) {
  const proxy = String(acc?.proxy ?? '').trim()
  const result = await fetchToken(acc, proxy)
  if (result.ok !== true) return { ok: false, detail: result.detail }
  const agentId = String(acc?.agentId ?? acc?.agentid ?? '').trim()
  const tail = agentId === '' ? '；但还没填 agentId，发消息时需要它' : ''
  return { ok: true, detail: 'corpId + secret 可用（已换到 access_token）' + tail }
}