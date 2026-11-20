/**
 * lib/channels/wechat.js — 微信（iLink 机器人通道）。
 *
 * 协议常量照 iLink 官方 bot 接口；这里只做「主动推送」，不接收消息。
 * v0.10.0 起不再依赖 dsh-bridge 落盘的 context_token 缓存（用户要求取消连接）：
 * 实测不带 context_token 也能发成功（见 README 十一·已知限制），
 * 「能发给谁」改由本插件自己记在 ~/.dsh/dsh-push-hub/wechat-peers.json。
 *
 * 已知故障（2026-11-15 实测 9 个账号全部命中）：
 *   服务端对这些 bot 的 sendmessage RPC 恒返 { ret: -2, errmsg: 'prepare failed' }，
 *   同一 token 的 getconfig / sendtyping 却 ret=0。说明不是参数错，是该 bot 的
 *   发送能力本身没就绪，唯一修法是人在微信客户端重新扫码绑定。
 *   因此微信在 push_hub 里被当成「尽力而为通道」：它失败不影响整体判定。
 *
 * @module channels/wechat
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomBytes } from 'node:crypto'
import { postJson, parseJson } from '../http.js'
import { splitBlocks, sleep } from '../text.js'
import { targetOf, describeTarget } from '../mentions.js'

export const NAME = 'wechat'
export const MAX_CHARS = 2000
export const TITLE = '微信'

const ILINK_APP_ID = 'bot'
const CHANNEL_VERSION = '2.2.0'
// (2 << 16) | (2 << 8) | 0
const ILINK_APP_CLIENT_VERSION = 131584
const EP_SEND_MESSAGE = 'ilink/bot/sendmessage'
const MSG_TYPE_BOT = 2
const MSG_STATE_FINISH = 2
const ITEM_TEXT = 1
const DEFAULT_BASE = 'https://ilinkai.weixin.qq.com'
const RET_CONTEXT_INVALID = -14

/** 本插件自己记的「发过消息的对端」，给「获取会话」下拉用（替代读 dsh-bridge 的缓存）。 */
export const PEERS_STORE = path.join(os.homedir(), '.dsh', 'dsh-push-hub', 'wechat-peers.json')

/** base64url(4 随机字节)，去掉尾部 '=' —— 模拟客户端每请求刷新的 UIN。 */
function randomUin() {
  return randomBytes(4).toString('base64url').replace(/=+$/, '')
}

/**
 * 记住一个成功发过的对端（给「获取会话」用）。
 *
 * 为什么要自己记：微信 iLink 没有「列会话」接口，唯一线索就是「谁跟机器人说过话」。
 * 旧版读 dsh-bridge 的 wechat-context-tokens.json，但它属于另一个插件、
 * 且 v0.10.0 已切断。自己记一份，代价是这个插件装好之前就互动过的人不会自动出现
 * （需手填 o9cq…@im.wechat），但至少不会因为别人删文件而突然清空。
 */
async function rememberPeer(peer) {
  try {
    let data = {}
    try {
      const raw = await readFile(PEERS_STORE, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed
    } catch {
      data = {}
    }
    data[peer] = new Date().toISOString()
    await mkdir(path.dirname(PEERS_STORE), { recursive: true })
    await writeFile(PEERS_STORE, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
  } catch {
    // 记不住不影响发送，静默降级
  }
}

/** 单次发送尝试（不做分块）。 */
async function sendOnce(url, token, peer, block, ctxToken, proxy) {
  const msg = {
    from_user_id: '',
    to_user_id: peer,
    client_id: 'pushhub-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
    message_type: MSG_TYPE_BOT,
    message_state: MSG_STATE_FINISH,
    item_list: [{ type: ITEM_TEXT, text_item: { text: block } }],
  }
  if (ctxToken !== '') msg.context_token = ctxToken

  const { status, body } = await postJson(
    url,
    { msg, base_info: { channel_version: CHANNEL_VERSION } },
    {
      headers: {
        AuthorizationType: 'ilink_bot_token',
        'iLink-App-Id': ILINK_APP_ID,
        'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
        'X-WECHAT-UIN': randomUin(),
        Authorization: 'Bearer ' + token,
      },
      proxy,
    },
  )
  if (status === null) return { ok: false, ret: null, detail: '连不上: ' + body }
  const data = parseJson(body, null)
  if (data === null) return { ok: false, ret: null, detail: 'HTTP ' + status + ' 返回非 JSON: ' + body.slice(0, 200) }
  const ret = data?.ret ?? null
  if (status === 200 && (ret === 0 || ret === null)) return { ok: true, ret, detail: 'ok' }
  return {
    ok: false,
    ret,
    detail: 'HTTP ' + status + ' ret=' + ret + ' errmsg=' + String(data?.errmsg ?? ''),
  }
}

/** 发一条消息（内部按 MAX_CHARS 分块）。 */
export async function send(text, acc, options = {}) {
  const token = String(acc?.token ?? '').trim()
  if (token === '') return { ok: false, detail: '账号缺少 token' }

  // 微信 iLink 协议没有群概念，target 只能是单聊对端 user id。
  const target = targetOf(acc)
  if (target === null) {
    return { ok: false, detail: '还没选「发送到」。微信 iLink 只能发给跟机器人说过话的人 —— 让对方先给机器人发一条消息，再点「获取会话」从下拉里选（形如 o9cq…@im.wechat），不要手填微信昵称。' }
  }
  const peer = target.id

  const base = String(acc?.baseUrl ?? '').trim() || DEFAULT_BASE
  const url = base.replace(/\/+$/, '') + '/' + EP_SEND_MESSAGE
  const proxy = String(acc?.proxy ?? '').trim()
  const configured = Number(acc?.maxMessageChars) > 0 ? Number(acc.maxMessageChars) : MAX_CHARS
  // 留 20 字余量，避免贴着上限被服务端判超长
  const limit = Math.max(200, configured - 20)
  const delay = Number(options.delayMs) >= 0 ? Number(options.delayMs) : 350

  const blocks = splitBlocks(text, limit)
  let sent = 0
  for (let i = 0; i < blocks.length; i += 1) {
    // v0.10.0：不再带 context_token。实测（2026-11-16）不带也能发成功，
    // 而那份缓存属于 dsh-bridge，切断后不该再依赖别人的文件。
    const r = await sendOnce(url, token, peer, blocks[i], '', proxy)
    if (!r.ok) {
      return { ok: false, detail: '第 ' + (i + 1) + '/' + blocks.length + ' 块失败 ' + r.detail }
    }
    sent += 1
    if (i < blocks.length - 1) await sleep(delay)
  }
  await rememberPeer(peer)
  return { ok: true, detail: '已发送 ' + sent + ' 块（' + describeTarget(target) + '）' }
}
/**
 * 探测：调 getconfig 看这个 token 到底是不是有效。
 *
 * v0.10.0 重写（旧实现恒失败）。实测矩阵（2026-11-16，token 58 位）：
 *   - 真 token + 带 ilink_user_id → `{ ret: -4, errmsg: "GetTypingTicket rpc failed" }`
 *   - 真 token + 不带 ilink_user_id → `{ ret: -2, errmsg: "ilink_user_id required" }`
 *   - **假 token（不管带不带）→ `{ errcode: -14, errmsg: "session timeout" }`**
 * 关键差别是字段名：真 token 返 `ret`，假 token 返 `errcode`。
 * 所以判据是「有没有 ret 字段」，而不是「ret 等不等于 0」——
 * 旧实现要求 ret===0，导致所有真 token 都被误判为不可用。
 */
export async function probe(acc) {
  const token = String(acc?.token ?? '').trim()
  if (token === '') return { ok: false, detail: '缺少 token' }
  const host = String(acc?.baseUrl ?? '').trim() || DEFAULT_BASE
  const url = host.replace(/\/+$/, '') + '/ilink/bot/getconfig'
  const accountId = String(acc?.accountId ?? '').trim()
  const payload = { base_info: { channel_version: CHANNEL_VERSION } }
  // 不带它恒返 ret=-2，看不出 token 好坏；带了才能走到真正的校验分支。
  if (accountId !== '') payload.ilink_user_id = accountId
  const { status, body } = await postJson(url, payload, {
    headers: {
      AuthorizationType: 'ilink_bot_token',
      'iLink-App-Id': ILINK_APP_ID,
      'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
      'X-WECHAT-UIN': randomUin(),
      Authorization: 'Bearer ' + token,
    },
    proxy: String(acc?.proxy ?? '').trim(),
  })
  if (status === null) return { ok: false, detail: '连不上: ' + body }
  const data = parseJson(body, null)
  if (data === null) return { ok: false, detail: 'HTTP ' + status + ' 返回非 JSON: ' + body.slice(0, 160) }

  // 假 token 走 errcode（iLink 网关层直接挡掉），没有 ret 字段。
  if (!Object.hasOwn(data, 'ret')) {
    const code = data?.errcode ?? null
    return {
      ok: false,
      detail: 'token 无效或已过期（errcode=' + code + ' errmsg=' + String(data?.errmsg ?? '') + '），需要重新扫码绑定',
    }
  }

  const ret = data.ret
  const errmsg = String(data?.errmsg ?? '')
  // ret=-2：缺 ilink_user_id。账号里没填 accountId 时会走到这里 —— 不算 token 坏。
  if (ret === -2) {
    return { ok: true, detail: 'token 可用（服务端要求 ilink_user_id，填上「账号 ID」后可看到更详细状态）' }
  }
  // ret=-4：token 有效，但 typing ticket 子服务拉不到（上游 RPC 故障，不影响发消息）。
  if (ret === -4) {
    return { ok: true, detail: 'token 可用（getconfig ret=-4，GetTypingTicket 上游故障，不影响发消息）' }
  }
  if (ret === 0) return { ok: true, detail: 'token 可用（getconfig ret=0）' }
  return { ok: true, detail: 'token 可用（getconfig ret=' + ret + (errmsg === '' ? '' : ' ' + errmsg) + '）' }
}
