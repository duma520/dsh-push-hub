/**
 * lib/targets.js — 「这个账号能发给谁」的现实清单。
 *
 * 为什么需要它：界面上「发送到」那一栏原本要用户手填 chat_id / open_id /
 * group_openid，而这些 ID 在五个平台里**没有一个能在网页上复制到**——
 * 它们只能从「机器人收到过的那条消息」里反查，或者在 NAS 用户列表里翻。
 * 结果就是四个通道全部报「账号没有发送目标」，用户以为通道坏了。
 *
 * 所以这里做「能列就列、列不到就说清怎么拿」：
 *   telegram      getUpdates 拉最近 100 条，把 chat 去重（最可靠，说句话就有）
 *   wechat        读本插件自己记的已发对端（没有列会话接口，这是唯一线索）
 *   feishu        im/v1/chats 列机器人所在的群（要 im:chat:readonly 权限）
 *   synology bot  method=user_list 拉 NAS 用户（数字 ID）
 *   qq            官方不给列，如实说明只能从群设置 / 后台日志取
 *
 * 所有函数都返回结构归一的结果，绝不抛异常：
 *   { ok: true,  items: [{ id, kind, label, detail }], note? }
 *   { ok: false, items: [], note: '为什么列不出来 + 怎么手动拿' }
 *
 * @module targets
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { getJson, postJson, parseJson } from './http.js'
import { explainChatError } from './channels/synology.js'

/** 与 channels/synology.js 的 normalizeType 同一口径（老值 'webhook' 归到 incoming）。 */
function normalizeSynType(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (text === 'bot') return 'bot'
  if (text === 'outgoing') return 'outgoing'
  return 'incoming'
}
import { PEERS_STORE } from './channels/wechat.js'

/** Telegram：getUpdates 里出现过的会话。 */
async function telegramTargets(acc, proxy) {
  const token = String(acc?.botToken ?? acc?.token ?? '').trim()
  if (token === '') return { ok: false, items: [], note: '先填 Bot Token' }
  const url = 'https://api.telegram.org/bot' + token + '/getUpdates?limit=100&timeout=0'
  const { status, body } = await getJson(url, { proxy })
  if (status === null) return { ok: false, items: [], note: '连不上 Telegram：' + body }
  const data = parseJson(body, {}) ?? {}
  if (status !== 200 || data.ok !== true) {
    return { ok: false, items: [], note: 'HTTP ' + status + '：' + String(data?.description ?? body).slice(0, 160) }
  }
  const updates = Array.isArray(data.result) ? data.result : []
  const seen = new Map()
  for (const item of updates) {
    const msg = item?.message ?? item?.edited_message ?? item?.channel_post ?? item?.my_chat_member
    const chat = msg?.chat
    if (!chat || chat.id === undefined) continue
    const id = String(chat.id)
    if (seen.has(id)) continue
    const kind = chat.type === 'private' ? 'user' : 'group'
    const name = chat.title ?? chat.username ?? [chat.first_name, chat.last_name].filter(Boolean).join(' ') ?? ''
    seen.set(id, {
      id,
      kind,
      label: name === '' ? id : name,
      detail: chat.type === 'private' ? '私聊' : '群 / 频道（' + chat.type + '）',
    })
  }
  const items = Array.from(seen.values())
  if (items.length === 0) {
    return {
      ok: false,
      items: [],
      note: '机器人还没收到过任何消息。在 Telegram 里找到它，随便发一句「你好」，再点一次「获取」。',
    }
  }
  return { ok: true, items, note: '来自机器人最近收到的消息；发过言的人/群都在这里。' }
}

/**
 * 微信：iLink 没有「列会话」接口，唯一线索是「这个机器人成功发给过谁」。
 *
 * v0.10.0 改成本插件自己记的 wechat-peers.json（旧版读 dsh-bridge 的
 * context-token 缓存，切断后就不能再依赖别人的文件）。代价写在 note 里：
 * 装本插件之前就互动过的人不会自动出现，需要手填 o9cq…@im.wechat。
 */
async function wechatTargets() {
  let raw = ''
  try {
    raw = await readFile(PEERS_STORE, 'utf8')
  } catch {
    return {
      ok: false,
      items: [],
      note: '本插件还没成功给谁发过消息。微信 iLink 没有列会话的接口，只能手填对方 user id（形如 o9cq…@im.wechat）—— 或者先用「发条测试消息」发成功一次，这里就会记住他。',
    }
  }
  const data = parseJson(raw, null)
  if (data === null || typeof data !== 'object') {
    return { ok: false, items: [], note: '对端记录文件读不懂：' + PEERS_STORE + '（可以直接删掉它，下次发送会重建）' }
  }
  const keys = Object.keys(data).filter((key) => key.includes('@'))
  const items = keys.map((id) => ({ id, kind: 'user', label: id.split('@')[0].slice(0, 12) + '…', detail: '本插件发过消息的微信号' }))
  if (items.length === 0) {
    return {
      ok: false,
      items: [],
      note: '记录里还没有对端。先手填对方 user id 发一次，成功后这里就会列出来。',
    }
  }
  return { ok: true, items, note: '这些是本插件成功发过的微信号（iLink 只能发给跟机器人互动过的人）。' }
}

/** 飞书：列机器人所在的群。需要 im:chat:readonly 权限，没权限就如实说。 */
async function feishuTargets(acc, proxy) {
  const appId = String(acc?.appId ?? acc?.app_id ?? '').trim()
  const secret = String(acc?.appSecret ?? acc?.app_secret ?? acc?.secret ?? '').trim()
  if (appId === '' || secret === '') return { ok: false, items: [], note: '先填 App ID 与 App Secret' }
  const host = String(acc?.domain ?? '').toLowerCase() === 'larksuite' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'
  const auth = await postJson(host + '/open-apis/auth/v3/tenant_access_token/internal', { app_id: appId, app_secret: secret }, { proxy })
  if (auth.status === null) return { ok: false, items: [], note: '取 token 连不上：' + auth.body }
  const authData = parseJson(auth.body, {}) ?? {}
  const token = String(authData?.tenant_access_token ?? '').trim()
  if (token === '') return { ok: false, items: [], note: '取 token 失败：' + String(authData?.msg ?? auth.body).slice(0, 160) }
  const res = await getJson(host + '/open-apis/im/v1/chats?page_size=50', { headers: { Authorization: 'Bearer ' + token }, proxy })
  if (res.status === null) return { ok: false, items: [], note: '列群失败：' + res.body }
  const data = parseJson(res.body, {}) ?? {}
  const code = data?.code ?? null
  if (code !== 0 && code !== null) {
    return {
      ok: false,
      items: [],
      note: '列不出群（code=' + code + ' ' + String(data?.msg ?? '') + '）。多半是没开 im:chat:readonly 权限；' +
        '也可以在飞书里把机器人拉进群，然后手填群 chat_id（oc_ 开头）。',
    }
  }
  const list = Array.isArray(data?.data?.items) ? data.data.items : []
  const items = list
    .filter((c) => typeof c?.chat_id === 'string' && c.chat_id !== '')
    .map((c) => ({ id: c.chat_id, kind: 'group', label: String(c.name ?? c.chat_id), detail: '群（' + String(c.chat_mode ?? 'group') + '）' }))
  if (items.length === 0) {
    return { ok: false, items: [], note: '机器人还没被拉进任何群。在飞书里把它加进群，或手填对方的 open_id（ou_ 开头）。' }
  }
  return { ok: true, items, note: '这些是机器人所在的群。单聊对方 ID 需要从对方发来的消息里取，无法主动列。' }
}

/** 群晖「机器人」：user_list 给的是数字用户 ID。 */
async function synologyTargets(acc, proxy) {
  const token = String(acc?.token ?? acc?.botToken ?? '').trim()
  let base = String(acc?.nasUrl ?? '').trim().replace(/\/+$/, '')
  if (base === '') return { ok: false, items: [], note: '先填 NAS 地址（例如 https://192.168.1.10:5001）' }
  if (!/^https?:\/\//i.test(base)) base = 'https://' + base
  const entry = base.endsWith('/webapi/entry.cgi') ? base : base + '/webapi/entry.cgi'
  const url = entry + '?api=SYNO.Chat.External&method=user_list&version=2&token=' + encodeURIComponent(token)
  const { status, body } = await getJson(url, { proxy })
  if (status === null) return { ok: false, items: [], note: '连不上 NAS：' + body }
  const data = parseJson(body, null)
  if (status !== 200 || data?.success !== true) {
    return { ok: false, items: [], note: '列不出 NAS 用户：' + explainChatError(data, status, body) }
  }
  const users = Array.isArray(data?.data?.users) ? data.data.users : []
  const items = users
    .filter((u) => Number.isInteger(Number(u?.user_id)))
    .map((u) => ({ id: String(u.user_id), kind: 'user', label: String(u.nickname ?? u.username ?? u.user_id), detail: 'NAS 用户' }))
  if (items.length === 0) return { ok: false, items: [], note: 'NAS 上没有可见用户。' }
  return { ok: true, items, note: '群晖「机器人」只能点对点发，用户 ID 就是这些数字 ID。' }
}

/** QQ：官方不提供列群 / 列好友接口。 */
function qqTargets() {
  return {
    ok: false,
    items: [],
    note: 'QQ 开放平台不提供「列出可发会话」接口。单聊 openid 与群 group_openid 只能在用户先跟机器人说过话之后，' +
      '从 QQ 开放平台后台的「消息推送」日志里看到。群聊请先在群里 @ 一次机器人，再去后台复制 group_openid。',
  }
}

/**
 * 列出某个账号可发送的目标。
 *
 * @param {string} channel
 * @param {Record<string,any>} acc 单个通道账号（明文字段）
 * @returns {Promise<{ok:boolean, items:Array<{id:string,kind:string,label:string,detail:string}>, note?:string}>}
 */
export async function listTargets(channel, acc) {
  const proxy = String(acc?.proxy ?? '').trim()
  try {
    if (channel === 'telegram') return await telegramTargets(acc, proxy)
    if (channel === 'wechat') return await wechatTargets()
    if (channel === 'feishu') return await feishuTargets(acc, proxy)
    if (channel === 'synology_chat') {
      // v0.40.0：三种整合类型里只有「机器人」有可列举的收件人。
      const type = normalizeSynType(acc?.type)
      if (type === 'outgoing') {
        return { ok: false, items: [], note: '「发出的 Webhook」是群晖回调你的方向，本插件没有可发送目标 —— 要发消息请把类型改成「传入的 Webhook」或「机器人」。' }
      }
      if (type !== 'bot') {
        return { ok: false, items: [], note: '「传入的 Webhook」不需要填发送目标 —— 它天然发到生成这条 webhook 的那个频道。' }
      }
      return await synologyTargets(acc, proxy)
    }
    if (channel === 'qq') return qqTargets()
    return { ok: false, items: [], note: '这个通道没有实现「获取会话」。' }
  } catch (error) {
    return { ok: false, items: [], note: '获取失败：' + String(error?.message ?? error) }
  }
}
