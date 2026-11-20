/**
 * lib/qr.js — 扫码一键创建机器人（飞书 / QQ / 微信）。
 *
 * 为什么需要这个模块：
 *   手填 AppID / AppSecret / Token 是整条链路里最容易劝退的一步。三个平台其实
 *   都提供了官方扫码授权流程，扫一下就能拿到凭据，人不用去开放平台翻页面。
 *
 * 三条流程的形态完全不同，所以这里按通道分派：
 *   - 飞书：@larksuiteoapi/node-sdk 的 registerApp()，回调给二维码 URL，
 *           成功 resolve { client_id, client_secret }。
 *   - QQ  ：@tencent-connect/qqbot-connector 的 startQrConnect()，回调给二维码
 *           URL，成功回调给 [{ appId, appSecret }]。
 *   - 微信：iLink 私有协议（两个无 token 的 GET），confirmed 时回 bot_token 等。
 *           注意 get_bot_qrcode 回的 qrcode_img_content 实测是 **URL 字符串**
 *           （https://liteapp.weixin.qq.com/q/...），不是 base64 图片，所以也要
 *           走 qrcode 库渲染。
 *
 * 依赖解析：统一走 lib/deps.js（v0.31.0 起）。它先查插件自身的 node_modules、
 * 再回落 DSH profile —— 顺序不能反，否则用户装了插件自带版本也白装。
 * 别改回裸 import：动态 import 的解析基准是本文件目录，裸包名照样 MODULE_NOT_FOUND。
 *
 * 安全约定：
 *   1. 二维码与凭据只在内存里存到会话结束，落盘的只有最终凭据（写进 own_bots）；
 *   2. 任何返回给浏览器的结构都不含明文凭据，只给账号摘要；
 *   3. 飞书 SDK / QQ 连接器缺失时给出可读中文提示，不抛裸 Error。
 *
 * @module qr
 */

import { getJson } from './http.js'
import { loadDep as sharedLoadDep } from './deps.js'

/* ------------------------------------------------------------------ *
 * iLink（微信）协议常量 —— 与 dsh-bridge/lib/wechat/gateway.js 保持一致
 * ------------------------------------------------------------------ */
const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'
const ILINK_APP_ID = 'bot'
/** (2<<16)|(2<<8)|0 = 131584，iLink 客户端版本号，写错会被拒。 */
const ILINK_APP_CLIENT_VERSION = String((2 << 16) | (2 << 8) | 0)
const EP_GET_BOT_QR = 'ilink/bot/get_bot_qrcode'
const EP_GET_QR_STATUS = 'ilink/bot/get_qrcode_status'
const WECHAT_POLL_MS = 1200
const WECHAT_TOTAL_MS = 300_000

/** 会话最长存活时间：超过就丢弃，避免内存里堆一堆僵尸会话。 */
const SESSION_TTL_MS = 10 * 60 * 1000

/** 支持的扫码通道（telegram 没有扫码协议，只能手填 BotFather token）。 */
export const QR_CHANNELS = ['feishu', 'qq', 'wechat']

const sessions = new Map()

/* ------------------------------------------------------------------ *
 * 依赖解析 —— 实现已收编到 lib/deps.js（v0.31.0）
 * ------------------------------------------------------------------ */

/**
 * 解析一个依赖：先查插件自身的 node_modules，再回落 DSH profile。
 *
 * 保留这个本地别名是因为本文件有 5 处调用（qrcode / 飞书 / QQ / capabilities）；
 * 解析规则的唯一实现在 deps.js，这里不复制一份 —— 两处各写一份，迟早只有一处跟上。
 */
const loadDep = sharedLoadDep

async function toDataUrl(kind, payload) {
  if (typeof payload !== 'string' || payload === '') return null
  if (kind === 'img') {
    if (/^data:/i.test(payload)) return payload
    return 'data:image/png;base64,' + payload
  }
  const loaded = await loadDep('qrcode')
  if (!loaded.ok) return null
  try {
    return await loaded.mod.toDataURL(payload, {
      width: 300,
      margin: 2,
      color: { dark: '#1F2421', light: '#FFFFFF' },
    })
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * 会话管理
 * ------------------------------------------------------------------ */

function newId() {
  return 'qr_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
}

function sweep() {
  const now = Date.now()
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      try {
        session.stop?.()
      } catch {
        // 停不掉也不影响清理
      }
      sessions.delete(id)
    }
  }
}

/** 给浏览器看的安全快照（绝不含明文凭据）。 */
function snapshot(session) {
  return {
    ok: true,
    sessionId: session.id,
    channel: session.channel,
    phase: session.phase,
    message: session.message,
    qr: session.qr,
    account: session.account,
  }
}

function setPhase(session, phase, message) {
  session.phase = phase
  if (typeof message === 'string') session.message = message
}

/* ------------------------------------------------------------------ *
 * 飞书
 * ------------------------------------------------------------------ */

async function startFeishu(session) {
  const loaded = await loadDep('@larksuiteoapi/node-sdk')
  if (!loaded.ok) {
    setPhase(session, 'error', '本机 profile 里没有 @larksuiteoapi/node-sdk，无法扫码创建飞书机器人；请改用手填 App ID / App Secret。')
    return
  }
  const sdk = loaded.mod
  if (typeof sdk.registerApp !== 'function') {
    setPhase(session, 'error', '当前 @larksuiteoapi/node-sdk 版本不含 registerApp（需 1.76+），请改用手填 App ID / App Secret。')
    return
  }
  setPhase(session, 'waiting', '正在向飞书申请二维码…')

  // registerApp 是一次性 Promise：二维码过期 / 用户拒绝都会 reject，
  // 所以这里不 await（会话生命周期由轮询端点读 state，不能被这个 Promise 卡住）。
  sdk
    .registerApp({
      source: 'dsh-push-hub',
      onQRCodeReady: async (info) => {
        const qr = await toDataUrl('url', info?.url)
        session.qr = qr
        setPhase(session, 'waiting', '请用飞书 App 扫码并确认授权（约 ' + Math.round((info?.expireIn ?? 600) / 60) + ' 分钟内有效）')
      },
      onStatusChange: (info) => {
        const status = String(info?.status ?? '')
        if (status === 'polling') setPhase(session, 'waiting', '等待扫码确认…')
        else if (status === 'slow_down') setPhase(session, 'waiting', '飞书要求放慢轮询，稍候…')
        else if (status === 'domain_switched') setPhase(session, 'waiting', '识别为 Lark 租户，已切换域名，继续等待扫码…')
      },
    })
    .then((result) => {
      const appId = String(result?.client_id ?? '')
      const appSecret = String(result?.client_secret ?? '')
      if (appId === '' || appSecret === '') {
        setPhase(session, 'error', '飞书授权成功但没拿到 App ID / Secret，请改用手填。')
        return
      }
      const tenant = String(result?.user_info?.tenant_brand ?? '')
      session.account = {
        name: String(result?.user_info?.tenant_name ?? '') || '飞书扫码机器人',
        appId,
        appSecret,
        ...(tenant === 'lark' ? { domain: 'larksuite' } : {}),
      }
      setPhase(session, 'success', '飞书机器人已创建：' + appId)
    })
    .catch((error) => {
      const code = String(error?.code ?? '')
      const readable = code === 'expired_token'
        ? '二维码已过期，请重新点「扫码创建」。'
        : code === 'access_denied'
          ? '你在飞书里拒绝了授权。'
          : code === 'slow_down'
            ? '飞书要求放慢轮询，请稍后重试。'
            : '飞书扫码失败：' + String(error?.message ?? error)
      setPhase(session, 'error', readable)
    })
}

/* ------------------------------------------------------------------ *
 * QQ
 * ------------------------------------------------------------------ */

async function startQq(session) {
  const loaded = await loadDep('@tencent-connect/qqbot-connector')
  if (!loaded.ok) {
    setPhase(session, 'error', '本机没装 @tencent-connect/qqbot-connector，无法扫码创建 QQ 机器人；请改用手填 AppID / AppSecret（或先在 dsh-bridge 里扫码再点「从 dsh-bridge 导入」）。')
    return
  }
  const mod = loaded.mod
  const startQrConnect = mod?.startQrConnect ?? mod?.default?.startQrConnect
  if (typeof startQrConnect !== 'function') {
    setPhase(session, 'error', '当前 @tencent-connect/qqbot-connector 没有导出 startQrConnect，请升级该包或改用手填。')
    return
  }
  setPhase(session, 'waiting', '正在向 QQ 开放平台申请二维码…')

  try {
    session.stop = startQrConnect(
      {
        onQrDisplayed: async (url) => {
          session.qr = await toDataUrl('url', url)
          setPhase(session, 'waiting', '请用手机 QQ 扫码，并在页面里确认创建机器人')
        },
        onQrExpired: () => setPhase(session, 'expired', '二维码已过期，请重新点「扫码创建」。'),
        onSuccess: (creds) => {
          const first = Array.isArray(creds) ? creds[0] : creds
          const appId = String(first?.appId ?? '')
          const appSecret = String(first?.appSecret ?? '')
          if (appId === '' || appSecret === '') {
            setPhase(session, 'error', 'QQ 扫码成功但没拿到 AppID / AppSecret，请改用手填。')
            return
          }
          session.account = { name: 'QQ扫码机器人', appId, appSecret }
          setPhase(session, 'success', 'QQ 机器人已创建：' + appId)
        },
        onFailure: (error) => {
          setPhase(session, 'error', 'QQ 扫码失败：' + String(error?.message ?? error ?? '未知原因'))
        },
      },
      {
        // 关键：默认 true 会往终端打 ASCII 二维码，在宿主里毫无意义且污染日志。
        displayQrCodeToConsole: false,
        source: 'dsh-push-hub',
      },
    )
  } catch (error) {
    setPhase(session, 'error', 'QQ 扫码启动失败：' + String(error?.message ?? error))
  }
}

/* ------------------------------------------------------------------ *
 * 微信（iLink 私有协议）
 * ------------------------------------------------------------------ */

function ilinkHeaders() {
  return {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': ILINK_APP_CLIENT_VERSION,
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 拉一张新的微信登录二维码。失败返回 null，不抛。 */
async function fetchWechatQr(baseUrl) {
  const url = baseUrl.replace(/\/+$/, '') + '/' + EP_GET_BOT_QR + '?bot_type=3'
  const res = await getJson(url, { headers: ilinkHeaders(), timeoutMs: 35000 })
  if (res.status === null) return { error: '连不上微信 iLink：' + res.body }
  if (res.status < 200 || res.status >= 300) return { error: 'iLink 返回 HTTP ' + res.status + '：' + res.body.slice(0, 200) }
  let json
  try {
    json = JSON.parse(res.body)
  } catch {
    return { error: 'iLink 返回的不是合法 JSON：' + res.body.slice(0, 200) }
  }
  const qrcode = String(json?.qrcode ?? '')
  if (qrcode === '') return { error: 'iLink 没给 qrcode：' + res.body.slice(0, 200) }
  return { qrcode, img: String(json?.qrcode_img_content ?? '') }
}

async function startWechat(session) {
  let baseUrl = ILINK_BASE_URL
  let qr = await fetchWechatQr(baseUrl)
  if (qr.error) {
    setPhase(session, 'error', qr.error)
    return
  }
  session.qr = await toDataUrl('url', qr.img)
  setPhase(session, 'waiting', '请用微信扫码并在手机上确认登录')
  const qrcode0 = qr.qrcode
  session.qrValue = qrcode0

  let stopped = false
  session.stop = () => {
    stopped = true
  }

  // 后台轮询：不阻塞 HTTP 请求。轮询端点只是读内存里的 phase。
  const deadline = Date.now() + WECHAT_TOTAL_MS
  void (async () => {
    let current = qrcode0
    let refresh = 0
    while (!stopped && Date.now() < deadline) {
      await sleep(WECHAT_POLL_MS)
      if (stopped) return
      const url = baseUrl.replace(/\/+$/, '') + '/' + EP_GET_QR_STATUS + '?qrcode=' + encodeURIComponent(current)
      const res = await getJson(url, { headers: ilinkHeaders(), timeoutMs: 35000 })
      if (res.status === null) continue
      let json
      try {
        json = JSON.parse(res.body)
      } catch {
        continue
      }
      const state = String(json?.status ?? 'wait')
      if (state === 'scaned_but_redirect' && typeof json?.redirect_host === 'string' && json.redirect_host !== '') {
        baseUrl = 'https://' + json.redirect_host
        continue
      }
      if (state === 'scaned') {
        setPhase(session, 'scanned', '已扫码，请在手机上点确认')
        continue
      }
      if (state === 'expired') {
        refresh += 1
        if (refresh > 3) {
          setPhase(session, 'expired', '二维码多次过期，请重新点「扫码创建」。')
          return
        }
        const next = await fetchWechatQr(baseUrl)
        if (next.error) {
          setPhase(session, 'error', next.error)
          return
        }
        current = next.qrcode
        session.qr = await toDataUrl('url', next.img)
        setPhase(session, 'waiting', '二维码已刷新，请重新扫码')
        continue
      }
      if (state === 'confirmed') {
        const accountId = String(json?.ilink_bot_id ?? '')
        const token = String(json?.bot_token ?? '')
        if (accountId === '' || token === '') {
          setPhase(session, 'error', '微信确认成功但没拿到 bot_token，请重试。')
          return
        }
        session.account = {
          name: '微信扫码机器人',
          token,
          accountId,
          ...(typeof json?.baseurl === 'string' && json.baseurl !== '' ? { baseUrl: json.baseurl } : {}),
        }
        setPhase(session, 'success', '微信机器人已登录：' + accountId)
        return
      }
    }
    if (!stopped && session.phase !== 'success') setPhase(session, 'expired', '等待超时，请重新点「扫码创建」。')
  })()
}

/* ------------------------------------------------------------------ *
 * 对外入口
 * ------------------------------------------------------------------ */

/**
 * 开始一次扫码会话。
 * @param {string} channel feishu | qq | wechat
 * @returns {Promise<object>} 安全快照或 { ok:false, error }
 */
export async function start(channel) {
  const name = String(channel ?? '').trim().toLowerCase()
  if (!QR_CHANNELS.includes(name)) {
    return { ok: false, error: '该通道不支持扫码创建（可选：' + QR_CHANNELS.join(' / ') + '）。Telegram 只能手填 BotFather 给的 token。' }
  }
  sweep()
  const session = { id: newId(), channel: name, phase: 'waiting', message: '正在申请二维码…', qr: null, account: null, createdAt: Date.now(), stop: null }
  sessions.set(session.id, session)

  if (name === 'feishu') await startFeishu(session)
  else if (name === 'qq') await startQq(session)
  else await startWechat(session)

  return snapshot(session)
}

/** 读会话状态（只读，不改任何东西）。 */
export function poll(sessionId) {
  sweep()
  const session = sessions.get(String(sessionId ?? ''))
  if (!session) return { ok: false, error: '扫码会话不存在或已过期，请重新点「扫码创建」。' }
  return snapshot(session)
}

/** 主动放弃一次会话。 */
export function cancel(sessionId) {
  const session = sessions.get(String(sessionId ?? ''))
  if (!session) return { ok: true, cancelled: false }
  try {
    session.stop?.()
  } catch {
    // 忽略：停不掉也不影响删除
  }
  sessions.delete(session.id)
  return { ok: true, cancelled: true }
}

/** 取走成功会话里的凭据（一次性，取完就删，避免凭据长期驻留内存）。 */
export function takeAccount(sessionId) {
  const session = sessions.get(String(sessionId ?? ''))
  if (!session || session.account === null) return null
  const account = session.account
  session.account = null
  return account
}

/** 只读探测本机能不能扫码（界面据此决定按钮是否置灰）。 */
export async function capabilities() {
  const feishu = await loadDep('@larksuiteoapi/node-sdk')
  const qq = await loadDep('@tencent-connect/qqbot-connector')
  const qrcode = await loadDep('qrcode')
  return {
    feishu: { available: feishu.ok, detail: feishu.ok ? '' : feishu.error },
    qq: { available: qq.ok, detail: qq.ok ? '' : qq.error },
    // 微信走 iLink 纯 HTTP，不需要任何依赖，只要能联网就行
    wechat: { available: true, detail: '' },
    qrCodeLib: { available: qrcode.ok, detail: qrcode.ok ? '' : qrcode.error },
  }
}
