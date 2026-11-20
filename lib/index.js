/**
 * dsh-push-hub — Host 半身（推送中枢）。
 *
 * 为什么是纯 JS、无构建：本机没有可用的 DSH 源码 checkout，也没有 tsc
 * （dev_build_plugin 报「无 DSH checkout，且运行环境解析不到 DSH 依赖/tsc」）。
 * 生态里 dsh-composer-butler / dsh-our-free-model 已用「手写 ES module、零构建」
 * 在同一条桌面端跑通，因此这里沿用同一条路线。
 *
 * 职责：
 *  1. 会话内三个工具：push_hub_send / push_hub_channels / push_hub_selftest；
 *  2. /api 路由：供外部脚本（Python 版 pushhub、定时任务）走 HTTP 触发推送；
 *  3. 凭据只存在 ~/.dsh/dsh-push-hub/config.json（mode 0600），本插件不回显明文。
 *
 * 通道：telegram / feishu / qq / wechat / synology_chat（群晖 Chat）。
 *
 * @module index.js
 */

import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import * as config from './config.js'
import * as bus from './bus.js'
import * as qr from './qr.js'
import * as targets from './targets.js'
import * as receiver from './receiver.js'
import * as buttons from './buttons.js'
import * as reply from './reply.js'
import * as inbox from './inbox.js'
import * as outbox from './outbox.js'
import * as edits from './edits.js'
import * as reactions from './reactions.js'
import * as download from './download.js'
import { splitBlocks, clip } from './text.js'

/** 插件包根目录（本文件在 lib/ 下，上一级即包根）。 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 外部脚本调用的 API 前缀。 */
const API_PREFIX = '/@duma520/dsh-push-hub/api'

/** 版本号只有 package.json 一个来源，避免 /info 与包版本不同步。 */
function readVersion() {
  try {
    const meta = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    return typeof meta?.version === 'string' ? meta.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

export const name = '@duma520/dsh-push-hub'
export const inject = ['webServer', 'tools']

/** 把请求体读完并解析为 JSON；空体返回 {}。 */
async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim() === '') return {}
  return JSON.parse(raw)
}

/** 取查询参数。路由匹配已经剥掉 query，这里重新解析原始 url。 */
function readQuery(req) {
  try {
    return new URL(String(req?.url ?? ''), 'http://127.0.0.1').searchParams
  } catch {
    return new URLSearchParams()
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

/**
 * 通道名输入归一化：接受 `"feishu,qq"` 字符串、`["feishu","qq"]` 数组、或单个名字。
 * @param {unknown} raw
 * @returns {string[]}
 */
function parseChannelList(raw) {
  if (raw === undefined || raw === null || raw === '') return []
  const items = Array.isArray(raw) ? raw : String(raw).split(/[,，\s]+/)
  const out = []
  for (const item of items) {
    const text = String(item ?? '').trim()
    if (text !== '') out.push(text)
  }
  return out
}

/**
 * 账号选择输入归一化：`"wechat=爸爸,qq=默认"` → `{ wechat: '爸爸', qq: '默认' }`。
 * 也接受已经是对象的形式（HTTP 调用方常用）。
 * @param {unknown} raw
 * @returns {Record<string, string|number>}
 */
function parseAccounts(raw) {
  if (raw === undefined || raw === null || raw === '') return {}
  if (typeof raw === 'object' && !Array.isArray(raw)) return { ...raw }
  const out = {}
  for (const pair of String(raw).split(/[,，;；]+/)) {
    const text = pair.trim()
    if (text === '') continue
    const at = text.indexOf('=')
    if (at <= 0) continue
    const key = text.slice(0, at).trim()
    const value = text.slice(at + 1).trim()
    if (key === '') continue
    // 纯数字当序号，其余当账号名
    out[key] = /^\d+$/.test(value) ? Number(value) : value
  }
  return out
}

/** 把标题拼进正文（标题为空则原样返回）。 */
function composeBody(title, text) {
  const body = String(text ?? '')
  const head = String(title ?? '').trim()
  if (head === '') return body
  return '【' + head + '】\n' + body
}

/**
 * 每个通道按自己的上限算会切成几块（dry-run 预览用）。
 * @param {string} text
 * @param {string[]} channels
 * @returns {Record<string, {title: string, maxChars: number, blocks: number, bestEffort: boolean}>}
 */
function planBlocks(text, channels) {
  const meta = new Map(bus.listChannels().map((item) => [item.name, item]))
  const plan = {}
  for (const channel of channels) {
    const info = meta.get(channel)
    if (info === undefined) {
      plan[channel] = { title: channel, maxChars: 0, blocks: 0, bestEffort: false, unknown: true }
      continue
    }
    plan[channel] = {
      title: info.title,
      maxChars: info.maxChars,
      blocks: splitBlocks(text, info.maxChars).length,
      bestEffort: info.bestEffort === true,
    }
  }
  return plan
}

/**
 * 提供推送工具与 HTTP API。
 *
 * inject 声明 webServer 与 tools：前者供外部脚本触发，后者是会话内主入口。
 */
export function apply(ctx, config_in) {
  const configuredPath = typeof config_in?.configPath === 'string' ? config_in.configPath.trim() : ''

  /** 每次调用重新读配置：改完 config.json 不必重启 DSH。 */
  function loadCfg() {
    return config.load(configuredPath === '' ? undefined : configuredPath)
  }

  /**
   * 真正执行一次推送（工具与 HTTP 共用）。
   * @param {{text: string, title?: string, channels?: unknown, accounts?: unknown, dryRun?: boolean}} input
   */
  async function doSend(input) {
    const body = composeBody(input?.title, input?.text)
    if (body.trim() === '') {
      return { ok: false, error: '正文为空，没东西可发' }
    }

    const cfg = loadCfg()
    const channels = bus.resolveChannels(parseChannelList(input?.channels), cfg)
    if (channels.length === 0) {
      return { ok: false, error: '没有可用的通道（检查 default_channels 或显式指定 channels）' }
    }

    // v0.20.0：按钮先在这一层校验，坏格式在伪发送（dry_run）时也能发现，
    // 不用等真发出去才 400。
    const parsedButtons = buttons.parseButtons(input?.buttons)
    if (parsedButtons.ok !== true) {
      return { ok: false, error: '按钮格式不对：' + parsedButtons.detail }
    }
    // v0.25.0：回复目标同样在这一层校验，坏 ID 在 dry_run 时就报出来。
    const parsedReply = reply.normalizeReplyId(input?.replyTo)
    if (parsedReply.ok !== true) {
      return { ok: false, error: '要回复的消息 ID 不对：' + parsedReply.detail }
    }
    const wantReply = parsedReply.id !== ''
    const withReply = wantReply ? channels.filter((name) => reply.REPLY_CHANNELS.includes(name)) : []
    const withoutReply = wantReply ? channels.filter((name) => !reply.REPLY_CHANNELS.includes(name)) : []

    const wantButtons = parsedButtons.rows.length > 0
    const withButtons = wantButtons ? channels.filter((name) => buttons.BUTTON_CHANNELS.includes(name)) : []
    const withoutButtons = wantButtons ? channels.filter((name) => !buttons.BUTTON_CHANNELS.includes(name)) : []

    if (input?.dryRun === true) {
      return {
        ok: true,
        dryRun: true,
        channels,
        plan: planBlocks(body, channels),
        preview: clip(body, 300),
        chars: body.length,
        ...(wantReply ? {
          replyTo: {
            id: parsedReply.id,
            summary: reply.describeReply(parsedReply.id),
            acceptedChannels: withReply,
            droppedChannels: withoutReply,
          },
        } : {}),
        ...(wantButtons ? {
          buttons: {
            rows: parsedButtons.rows,
            summary: buttons.describeButtons(parsedButtons.rows),
            acceptedChannels: withButtons,
            droppedChannels: withoutButtons,
          },
        } : {}),
      }
    }

    const result = await bus.send(cfg, body, {
      channels,
      accounts: parseAccounts(input?.accounts),
      buttons: wantButtons ? parsedButtons.rows : undefined,
      replyTo: wantReply ? parsedReply.id : undefined,
      // v0.33.0：progress 是「发完顺手挂个进行中表情」，不是消息属性 ——
      // 不支持的通道照常发文字，只在自己那条结果里带上不进不来的原因。
      progress: input?.progress === true,
      emojis: input?.emojis,
    })
    // v0.28.0：记账。只记「真的发出去了」的那些通道 —— 失败的那条没有 id，
    // 记进去既不能改也不能撤，还会把真正发出去的挤出保留窗口。
    const sentEntries = []
    for (const [name, one] of Object.entries(result.results ?? {})) {
      if (one?.ok !== true) continue
      sentEntries.push({
        channel: name,
        account: one?.account ?? null,
        target: Array.isArray(one?.deliveries) && one.deliveries.length > 0
          ? one.deliveries.map((d) => d.id).join('、')
          : null,
        kind: 'text',
        text: clip(body, outbox.TEXT_CLIP),
        messageIds: Array.isArray(one?.messageIds) ? one.messageIds : [],
        // v0.29.0：每组的 id 连同它所在的目标一起存。多目标时 target 是
        // 「A、B」这种拼起来的字符串，改 / 撤靠它定位不到具体是哪个聊天。
        places: Array.isArray(one?.places) ? one.places : [],
        detail: String(one?.detail ?? ''),
      })
    }
    // 落盘失败不能让「已经发出去了」变成「发送失败」—— 消息真的出去了，
    // 只是没记上；这种情况只加一句提醒，不改 ok。
    const logged = await outbox.appendSent(sentEntries)
    return {
      ok: result.ok === true,
      channels,
      summary: bus.summarize(result.results),
      results: result.results,
      sent: { recorded: logged.ok === true, kept: logged.kept ?? 0, ...(logged.detail === undefined ? {} : { warn: logged.detail }) },
      ...(wantReply ? {
        replyTo: {
          summary: reply.describeReply(parsedReply.id),
          acceptedChannels: withReply,
          droppedChannels: withoutReply,
        },
      } : {}),
      ...(wantButtons ? {
        buttons: {
          summary: buttons.describeButtons(parsedButtons.rows),
          acceptedChannels: withButtons,
          droppedChannels: withoutButtons,
        },
      } : {}),
      ...(result.error === undefined ? {} : { error: result.error }),
    }
  }

  /**
   * 每个通道「自有机器人」需要填哪些字段。
   *
   * 字段名与各通道模块真正读的键一致（见 lib/channels/*.js），
   * 否则界面填了也发不出去 —— 这是本表唯一的存在理由，别按平台文档另起一套名字。
   */
  /** 通道中文名，仅用于给扫码出来的账号起一个可读名字。 */
  const CHANNEL_LABELS = {
    telegram: 'Telegram',
    feishu: '飞书',
    qq: 'QQ',
    wechat: '微信',
    synology_chat: '群晖 Chat',
  }

  /** 导入来的凭据超过这么多天就在界面标黄（不自动删，凭据可能仍然有效）。 */
  const STALE_DAYS = 30

  /** 判断一条导入凭据是否可能已过期。没有导入时间（手填的）一律不算过期。 */
  function isStale(importedAt) {
    const text = String(importedAt ?? '')
    if (text === '') return false
    const at = Date.parse(text)
    if (!Number.isFinite(at)) return false
    return Date.now() - at > STALE_DAYS * 24 * 60 * 60 * 1000
  }

  // 每个通道的「发送目标」怎么填：群聊与单聊在协议层是不同端点或不同 ID 形态，
  // 所以界面必须让用户显式选，不能靠猜。
  const TARGET_META = {
    telegram: {
      kinds: [{ value: 'user', label: '单聊' }, { value: 'group', label: '群 / 频道' }],
      hint: 'chat_id；负数即群（例：-1001234567890）。不知道填什么就先手填自己的 chat_id 测一次。',
    },
    feishu: {
      kinds: [{ value: 'user', label: '单聊（open_id）' }, { value: 'group', label: '群（chat_id）' }],
      hint: '单聊填 ou_ 开头的 open_id；群填 oc_ 开头的 chat_id。',
    },
    qq: {
      kinds: [{ value: 'user', label: '单聊（openid）' }, { value: 'group', label: '群（group_openid）' }],
      hint: '走 /v2/users 或 /v2/groups 两个不同端点，必须选对类型。@ 要填成员 member_openid。',
    },
    wechat: {
      kinds: [{ value: 'user', label: '单聊' }],
      hint: 'iLink 协议没有群，只能发单聊对端 user id。',
    },
    synology_chat: {
      kinds: [],
      hint: '「传入的 Webhook」发到它绑定的那个频道（相当于群）；「机器人」只能点对点发用户 ID；「发出的 Webhook」是群晖回调你的方向，本插件不发送。',
    },
    dingtalk: {
      kinds: [],
      hint: '群机器人发到它所在的那个群，不需要填收件人；要发给具体的人请用企业微信自建应用或钉钉自建应用。',
    },
    wecom: {
      kinds: [],
      hint: '群机器人发到它所在的那个群；@ 人靠「访问设置」里的成员账号或 @all。',
    },
    wecom_app: {
      kinds: [{ value: 'user', label: '成员账号' }],
      hint: '填通讯录里的「账号」（不是昵称）；填 @all 可以发给全部成员。多个账号用 | 分隔，例 zhangsan|lisi。',
    },
    slack: {
      kinds: [{ value: 'group', label: '频道' }],
      hint: '填 #频道名 或频道 ID（C 开头）；机器人必须已被邀请进该频道。',
    },
    discord: {
      kinds: [{ value: 'group', label: '频道' }],
      hint: '填频道 ID（纯数字）：Discord 设置 → 高级 → 开发者模式，然后右键频道 → 复制频道 ID。',
    },
    matrix: {
      kinds: [{ value: 'group', label: '房间' }],
      hint: '填房间 ID，形如 !abcdef:matrix.org（带 ! 前缀与服务器名）；加密房间暂不支持。',
    },
    email: {
      kinds: [{ value: 'user', label: '收件人' }],
      hint: '收件人邮箱地址，多个用逗号分隔。',
    },
  }

  const OWN_BOT_FIELDS = {
    telegram: [
      { key: 'botToken', label: 'Bot Token', secret: true, placeholder: 'BotFather 给的 123456:ABC-DEF…' },
      { key: 'proxy', label: '代理', secret: false, placeholder: 'http://127.0.0.1:7890（直连超时才需要）' },
    ],
    feishu: [
      { key: 'appId', label: 'App ID', secret: false },
      { key: 'appSecret', label: 'App Secret', secret: true },
      { key: 'domain', label: '域名', secret: false, placeholder: '留空=飞书，填 larksuite=Lark' },
    ],
    qq: [
      { key: 'appId', label: 'AppID', secret: false },
      { key: 'appSecret', label: 'AppSecret', secret: true },
    ],
    wechat: [
      { key: 'token', label: 'Token', secret: true },
      { key: 'accountId', label: '账号 ID', secret: false },
      { key: 'baseUrl', label: '接口地址', secret: false, placeholder: '留空用内置默认' },
    ],
    // v0.40.0：按群晖面板「整合」的三种类型建模（见 lib/channels/synology.js 顶部）：
    //   incoming「传入的 Webhook」/ outgoing「发出的 Webhook」/ bot「机器人」。
    // 字段跟着 type 走，界面上只渲染相关的那几格 —— 九格全铺开没人知道该填哪几个。
    synology_chat: [
      { key: 'type', label: '类型', secret: false, placeholder: 'incoming（传入的 Webhook）/ outgoing（发出的 Webhook）/ bot（机器人）' },
      { key: 'webhookUrl', label: 'Webhook URL', secret: true, placeholder: '「传入的 Webhook」里那条完整 URL（含 token 参数）；留空则用下面的 NAS 地址 + 令牌自动拼' },
      { key: 'incomingUrl', label: '传入 URL', secret: true, placeholder: '「机器人」面板上的「传入 URL」—— 向它发就能把消息发进群晖；留空则用 NAS 地址 + 令牌自动拼' },
      { key: 'outgoingUrl', label: '传出 URL', secret: true, placeholder: '面板上的「URL」/「传出 URL」＝ 你自己的回调地址，群晖往那里发请求；本插件只登记，不发送也不接收' },
      { key: 'channel', label: '频道', secret: false, placeholder: '面板「频道」里选的那一项（例：任何公共频道）。群晖侧的筛选条件，只登记' },
      { key: 'triggerWord', label: '触发字', secret: false, placeholder: '面板「触发字」（可空）。群晖侧的筛选条件，只登记' },
      { key: 'nasUrl', label: 'NAS 地址', secret: false, placeholder: '填 QuickConnect 传入 URL 的域名部分，例 https://192-168-1-10.xxx.quickconnect.cn:5001 —— 别用局域网 IP，NAS 是自签证书会连不上' },
      { key: 'token', label: '令牌', secret: true, placeholder: '面板上的「令牌」（64 位）；传入的 Webhook 填了上面的 URL 就可留空' },
      { key: 'userIds', label: '用户 ID', secret: false, placeholder: '「机器人」必填：群晖 Chat「用户」列表里的数字 ID，多个用逗号分隔' },
    ],
    dingtalk: [
      { key: 'webhookUrl', label: 'Webhook 地址', secret: true, placeholder: '钉钉群 → 群设置 → 机器人 → 自定义 → 复制 Webhook（形如 https://oapi.dingtalk.com/robot/send?access_token=…）' },
      { key: 'secret', label: '加签 Secret', secret: true, placeholder: '机器人安全设置里勾了「加签」才要填（SEC 开头）；留空表示用关键词或 IP 白名单' },
      // v0.24.0：群机器人的 webhook 只能发不能收。要收必须另建「企业内部应用」，
      // 拿 AppKey/AppSecret 走 Stream 模式长连接 —— 与上面的 webhook + 加签是两套凭据。
      { key: 'clientId', label: 'AppKey（接收才要）', secret: false, placeholder: '企业内部应用 → 凭证与基础信息 → AppKey（群机器人的 webhook 收不了消息）' },
      { key: 'clientSecret', label: 'AppSecret（接收才要）', secret: true, placeholder: '同上页的 AppSecret' },
    ],
    wecom: [
      { key: 'webhookUrl', label: 'Webhook 地址', secret: true, placeholder: '企业微信群 → 群机器人 → 添加 → 复制 Webhook（形如 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…）' },
    ],
    wecom_app: [
      { key: 'corpId', label: '企业 ID', secret: false, placeholder: '企业微信「我的企业」页底部，ww 开头' },
      { key: 'corpSecret', label: '应用 Secret', secret: true, placeholder: '「应用管理 → 你的应用 → Secret」' },
      { key: 'agentId', label: 'AgentId', secret: false, placeholder: '「应用管理 → 你的应用」页顶部的 AgentId，纯数字' },
      // v0.24.0：自建应用只能发不能收。收消息要用「智能机器人」的 BotId + Secret，
      // 是同一个企业下的另一套凭据，不是 corpId/corpSecret。
      { key: 'botId', label: 'BotId（接收才要）', secret: false, placeholder: '企业微信「智能机器人」页的 BotId（自建应用的 corpId 收不了消息）' },
      { key: 'botSecret', label: 'Bot Secret（接收才要）', secret: true, placeholder: '同上页的 Secret' },
      { key: 'proxy', label: '代理', secret: false, placeholder: '国内直连，一般不用填' },
    ],
    slack: [
      { key: 'botToken', label: 'Bot Token', secret: true, placeholder: 'xoxb- 开头（OAuth & Permissions → Bot User OAuth Token）' },
      { key: 'appToken', label: 'App Token（接收才要）', secret: true, placeholder: 'xapp- 开头（Basic Information → App-Level Tokens，scopes 勾 connections:write）；只发消息可以不填' },
    ],
    discord: [
      { key: 'botToken', label: 'Bot Token', secret: true, placeholder: 'Bot 页签的 Token（不是 Application ID）' },
    ],
    matrix: [
      { key: 'homeserver', label: 'Homeserver', secret: false, placeholder: '例 https://matrix.org' },
      { key: 'accessToken', label: 'Access Token', secret: true, placeholder: 'Element → 设置 → 帮助与关于 → 访问令牌' },
    ],
    email: [
      { key: 'smtpHost', label: 'SMTP 服务器', secret: false, placeholder: '例 smtp.qq.com' },
      { key: 'smtpPort', label: '端口', secret: false, placeholder: '465（TLS）或 587（STARTTLS）' },
      { key: 'user', label: '登录账号', secret: false, placeholder: '例 someone@qq.com' },
      { key: 'pass', label: '授权码', secret: true, placeholder: '邮箱的「授权码」，不是登录密码' },
      { key: 'from', label: '发件人', secret: false, placeholder: '留空 = 用上面的登录账号' },
      { key: 'subject', label: '默认主题', secret: false, placeholder: '留空 = 「来自推送中枢的消息」' },
      // v0.23.0：收发是两套服务器，SMTP 地址不能拿来收信（多数邮箱两者域名都不同）。
      { key: 'imapHost', label: 'IMAP 服务器（接收才要）', secret: false, placeholder: '例 imap.qq.com；只发信可以不填' },
      { key: 'imapPort', label: 'IMAP 端口', secret: false, type: 'number', placeholder: '留空 = 993（SSL）；143 走明文' },
    ],
  }

  // v0.17.0：三个「界面上一直没入口、但 12 个通道实现都在读」的账号级字段。
  //  - proxy：11 个通道都读 acc.proxy，但只有 telegram / wecom_app 有输入框，
  //    其余通道想单独走代理只能改通道级开关（那是全通道共用的）。
  //  - maxMessageChars：所有通道都按它分块，没有它就只能用通道里写死的上限。
  //  - chunkDelayMs：bus 会折进 options.delayMs，控制分块之间的间隔，
  //    太密会被平台限流（Slack 1.1s、钉钉 1.2s 这类默认值就是这么来的）。
  //  - perMinute（v0.35.0）：每分钟最多几条。chunkDelayMs 管的是「块与块之间」,
  //    它管的是「一分钟内总共几条」—— 一条长消息切 10 块、块间只等 350 毫秒,
  //    3.5 秒全发完，间隔看着合规但平台的每分钟配额已经打穿了。
  // 用 type 区分数字/布尔，否则前端只能一律当字符串，回写时 Number('') 会变 0。
  const PROXY_FIELD = {
    key: 'proxy',
    label: '代理',
    secret: false,
    group: 'advanced',
    placeholder: 'http://127.0.0.1:7890（直连不通才要填；留空则用通道级「代理通道」的开关）',
  }
  for (const list of Object.values(OWN_BOT_FIELDS)) {
    if (!list.some((field) => field.key === 'proxy')) list.push({ ...PROXY_FIELD })
  }

  // 邮件是唯一能关 TLS 证书校验的通道（见 lib/channels/email.js），
  // 自建 SMTP + 自签证书的场景不加这个开关就只能改代码。
  OWN_BOT_FIELDS.email.push({
    key: 'allowSelfSigned',
    label: '允许自签证书',
    secret: false,
    type: 'boolean',
    group: 'advanced',
    placeholder: '自建 SMTP 用自签证书时才勾；勾了就不再校验服务器证书',
  })

  const ADVANCED_FIELDS = [
    {
      key: 'maxMessageChars',
      label: '分块长度',
      secret: false,
      type: 'number',
      group: 'advanced',
      placeholder: '留空 = 用该通道的上限',
    },
    {
      key: 'chunkDelayMs',
      label: '块间延迟（毫秒）',
      secret: false,
      type: 'number',
      group: 'advanced',
      placeholder: '留空 = 用该通道的默认值',
    },
    // v0.35.0：每分钟配额。三种取值语义不同：留空 = 15 条/分钟（默认）、
    // 0 = 明确不限（唯一关掉的写法）、N = 夹到 1~30。详见 lib/ratelimit.js。
    {
      key: 'perMinute',
      label: '每分钟最多几条',
      secret: false,
      type: 'number',
      group: 'advanced',
      placeholder: '留空 = 15 条/分钟；填 0 = 不限（按「块」算，不是按次算）',
    },
  ]
  for (const list of Object.values(OWN_BOT_FIELDS)) {
    if (!list.some((field) => field.key === 'maxMessageChars')) {
      list.push(...ADVANCED_FIELDS.map((field) => ({ ...field })))
    }
  }

  /**
   * 把一份配置里需要展示给浏览器的字段掩码化。
   *
   * 只放行「非敏感、界面确实要显示」的字段：默认通道、自有机器人的掩码凭据、
   * 群晖的 webhook（掩码）与分块参数。任何 token 明文一律不出现在返回值里。
   */
  function maskedUserConfig() {
    const raw = config.readUserConfig()
    const defaults = Array.isArray(raw.default_channels) ? raw.default_channels.map(String) : []

    const synologyRaw = raw?.synology_chat
    const synologyAccounts = Array.isArray(synologyRaw?.accounts) ? synologyRaw.accounts : []
    const synology = {
      accounts: synologyAccounts.map((item, i) => ({
        name: typeof item?.name === 'string' && item.name.trim() !== '' ? item.name : '#' + (i + 1),
        webhookUrl: config.fingerprintSecret(item?.webhookUrl ?? item?.resource),
        hasWebhook: String(item?.webhookUrl ?? item?.resource ?? '') !== '',
        sendChunkDelayMs: Number(item?.sendChunkDelayMs ?? 1500),
        maxMessageChars: Number(item?.maxMessageChars ?? 2000),
      })),
    }

    // 自有机器人：逐字段掩码。secret 字段给指纹（前6…后4），非 secret 字段原样
    // （appId / accountId 这类本来就不是密文，掩起来反而没法核对）。
    const ownRaw = raw?.[config.OWN_BOTS_KEY]
    const own = {}
    for (const [channel, fields] of Object.entries(OWN_BOT_FIELDS)) {
      const list = Array.isArray(ownRaw?.[channel])
        ? ownRaw[channel]
        : Array.isArray(ownRaw?.[channel]?.accounts) ? ownRaw[channel].accounts : []
      if (list.length === 0) continue
      own[channel] = list.map((item, i) => {
        const row = { name: String(item?.name ?? '').trim() !== '' ? String(item.name) : '#' + (i + 1) }
        for (const field of fields) {
          const rawValue = item?.[field.key]
          const value = String(rawValue ?? '')
          // v0.10.0：secret 字段给「前 6…后 4」指纹而不是只留末 4 位 ——
          // 旧掩码下多个 token 摆在一起用户根本认不出谁是谁。
          if (field.type === 'number') {
            // 数字字段原样给数字（不给就是空串），界面用 <input type="number">。
            // 统一转成字符串会让 '' 变成 0，用户清空后反而被写成 0。
            const n = Number(rawValue)
            row[field.key] = rawValue === undefined || rawValue === null || rawValue === '' ? '' : Number.isFinite(n) ? n : ''
          } else if (field.type === 'boolean') {
            row[field.key] = rawValue === true
          } else {
            row[field.key] = field.secret === true ? config.fingerprintSecret(value) : value
          }
          row[field.key + '_set'] = value !== '' && rawValue !== false
        }
        // 发送目标与 @ 设置：结构化字段，界面要能原样回传，所以不掩码。
        // target 决定发单聊还是发群（QQ/飞书在协议层是不同端点），mention 决定 @ 谁。
        const t = item?.target
        row.target = {
          kind: ['user', 'group'].includes(t?.kind) ? t.kind : 'user',
          id: String(t?.id ?? ''),
        }
        // v0.14.0：多投递目标。界面拿到的是去重后的数组，一条一个会话。
        // 数组为空时界面仍显示单个 target（老配置零迁移成本）。
        row.targets = Array.isArray(item?.targets)
          ? item.targets
              .filter((x) => x !== null && typeof x === 'object' && String(x?.id ?? '').trim() !== '')
              .map((x) => ({
                kind: ['user', 'group'].includes(x?.kind) ? x.kind : 'user',
                id: String(x.id).trim(),
              }))
          : []
        const m = item?.mention
        row.mention = {
          mode: ['none', 'user', 'all'].includes(m?.mode) ? m.mode : 'none',
          userIds: Array.isArray(m?.userIds) ? m.userIds.map((v) => String(v)) : [],
        }
        // 来源与时间：从别处导入的账号会在自有层留一份快照，源侧换了 token 后
        // 快照会静默盖住新值。界面上必须能看出「这条是导入的」，
        // 且超过 STALE_DAYS 天标黄提示可能已过期 —— 只提示，不擅自改优先级。
        row.imported_from = typeof item?.imported_from === 'string' ? item.imported_from : ''
        row.imported_at = typeof item?.imported_at === 'string' ? item.imported_at : ''
        row.stale = isStale(item?.imported_at)
        return row
      })
    }

    return {
      default_channels: defaults,
      default_channels_explicit: raw?.[config.DEFAULT_CHANNELS_EXPLICIT] === true,
      synology_chat: synology,
      [config.OWN_BOTS_KEY]: own,
      // 通道级代理：返回归一化后的策略（含默认值），界面照着渲染开关即可，
      // 不用自己再猜默认地址是什么。
      [config.PROXY_KEY]: config.proxyPolicy(next0()),
      // v0.26.0：通道显示偏好。只给界面用，bus / receiver 不读。
      [config.VISIBILITY_KEY]: config.channelVisibility(config.load() ?? {}),
    }
  }

  /** 当前合并后的完整配置（含各层回落），代理策略要以它为准。 */
  function next0() {
    try { return config.load() ?? {} } catch { return {} }
  }

  /**
   * 合并一次界面提交。
   *
   * 关键约定：字段值等于我们发出去的掩码/指纹（isSecretPlaceholder）时表示「用户没动它」，
   * 此时必须保留磁盘上的旧值 —— 否则界面只要点一次保存，
   * 没重新输入的 webhook 就被清空了。
   *
   * @param {Record<string, any>} incoming 前端提交的体
   */
  function mergeUserConfig(incoming) {
    const next = { ...config.readUserConfig() }

    // default_channels：只要前端给了数组就表过态，同步写判别位。
    // 没有这个判别位，空数组会被当成「没配」而回落内置三通道，
    // 用户取消全部勾选后怎么保存都取消不掉（旧缺陷）。
    if (Array.isArray(incoming?.default_channels)) {
      const list = incoming.default_channels.map(String).map((s) => s.trim()).filter((s) => s !== '')
      next.default_channels = list
      next[config.DEFAULT_CHANNELS_EXPLICIT] = true
    }

    // 通道级代理：只收 url 与 channels 两个键。channels 里只认布尔值，
    // 未提到的通道保持原样（界面只回传被改动过的，不该把没提到的通道重置成默认）。
    if (incoming?.[config.PROXY_KEY] !== undefined && incoming[config.PROXY_KEY] !== null) {
      const rawProxy = incoming[config.PROXY_KEY]
      const oldProxy = next?.[config.PROXY_KEY] && typeof next[config.PROXY_KEY] === 'object'
        ? next[config.PROXY_KEY]
        : {}
      const merged = { ...oldProxy }
      if (rawProxy?.url !== undefined) {
        merged.url = config.normalizeProxyUrl(rawProxy.url) || config.DEFAULT_PROXY.url
      }
      if (rawProxy?.channels && typeof rawProxy.channels === 'object') {
        const channels = { ...(oldProxy?.channels && typeof oldProxy.channels === 'object' ? oldProxy.channels : {}) }
        for (const name of config.ALL_CHANNELS) {
          if (typeof rawProxy.channels[name] === 'boolean') channels[name] = rawProxy.channels[name]
        }
        merged.channels = channels
      }
      next[config.PROXY_KEY] = merged
    }

    // 通道显示偏好（v0.26.0）：mode 只认 all / bound，hidden 只收已知通道名。
    // 前端给什么就整组替换 —— 这是「用户此刻想让列表长什么样」的快照，
    // 不是可以逐项累加的开关，留着旧值反而会复活用户刚放开的那条。
    if (incoming?.[config.VISIBILITY_KEY] !== undefined && incoming[config.VISIBILITY_KEY] !== null) {
      const raw = incoming[config.VISIBILITY_KEY]
      next[config.VISIBILITY_KEY] = {
        mode: raw?.mode === 'bound' ? 'bound' : 'all',
        hidden: Array.isArray(raw?.hidden)
          ? [...new Set(raw.hidden.map(String).filter((name) => config.ALL_CHANNELS.includes(name)))]
          : [],
      }
    }

    // 自有机器人：逐通道合并。掩码回传 = 保留旧值；空串 = 明确清空该字段。
    if (incoming?.[config.OWN_BOTS_KEY] !== undefined && incoming[config.OWN_BOTS_KEY] !== null) {
      const incomingOwn = incoming[config.OWN_BOTS_KEY]
      const oldOwn = next?.[config.OWN_BOTS_KEY] && typeof next[config.OWN_BOTS_KEY] === 'object'
        ? next[config.OWN_BOTS_KEY]
        : {}
      const own = { ...oldOwn }
      for (const [channel, fields] of Object.entries(OWN_BOT_FIELDS)) {
        if (!Object.hasOwn(incomingOwn, channel)) continue
        const rows = Array.isArray(incomingOwn[channel]) ? incomingOwn[channel] : []
        const oldRows = Array.isArray(oldOwn?.[channel]) ? oldOwn[channel] : []
        const accounts = []
        for (let i = 0; i < rows.length; i += 1) {
          const item = rows[i] ?? {}
          const old = oldRows[i] ?? {}
          const account = {}
          const name = String(item?.name ?? '').trim()
          account.name = name !== '' ? name : String(old?.name ?? '') !== '' ? String(old.name) : '#' + (i + 1)
          // 导入来源与时间：前端回传时带回来就保留，没带就沿用旧值。
          // 丢了这两个字段，界面就再也标不出「这条是导入的、可能已过期」。
          const from = typeof item?.imported_from === 'string' ? item.imported_from : String(old?.imported_from ?? '')
          const at = typeof item?.imported_at === 'string' ? item.imported_at : String(old?.imported_at ?? '')
          if (from !== '') account.imported_from = from
          if (at !== '') account.imported_at = at
          for (const field of fields) {
            const given = item?.[field.key]
            const oldValue = String(old?.[field.key] ?? '')
            // 数字 / 布尔字段走另一条路：它们没有「掩码回传」这回事，
            // 空值表示「用通道默认」，所以清空就是真的删掉，不沿用旧值
            // （否则用户把分块长度改回默认永远改不掉）。
            if (field.type === 'number') {
              if (given === undefined || given === null || String(given).trim() === '') continue
              const n = Number(given)
              // v0.35.0：perMinute 的 0 是「明确不限」，不能被 `n > 0` 这条通用规则吃掉 ——
              // 那样用户填了 0、界面回读却是空，看起来像没保存，会被当成 bug。
              // 其余数字字段的 0 仍然没有意义（分块长度 0 / 延迟 0 都当「用默认」）。
              if (field.key === 'perMinute') {
                if (Number.isFinite(n) && n >= 0) account[field.key] = Math.floor(n)
                continue
              }
              if (Number.isFinite(n) && n > 0) account[field.key] = Math.floor(n)
              continue
            }
            if (field.type === 'boolean') {
              if (given === undefined || given === null) { if (old?.[field.key] === true) account[field.key] = true; continue }
              if (given === true) account[field.key] = true
              continue
            }
            // 掩码/指纹回传、未给 → 沿用旧值；空串 → 明确清空；其余 → 新值。
            // v0.10.0 起掩码是「前6…后4」指纹，所以判据用 isSecretPlaceholder。
            if (config.isSecretPlaceholder(given) || given === undefined || given === null) {
              if (oldValue !== '') account[field.key] = oldValue
              continue
            }
            const text = String(given).trim()
            if (text !== '') account[field.key] = text
          }
          // 发送目标与 @ 设置：非密文结构化字段，给了就用新值，没给沿用旧值。
          const givenTarget = item?.target
          if (givenTarget !== null && typeof givenTarget === 'object') {
            const kind = ['user', 'group'].includes(givenTarget?.kind) ? givenTarget.kind : 'user'
            account.target = { kind, id: String(givenTarget?.id ?? '').trim() }
          } else if (old?.target) {
            account.target = old.target
          }
          // v0.14.0：多投递目标。给了数组就整组替换（空数组 = 明确清空，回落到单个 target），
          // 没给（undefined）沿用旧值 —— 老前端不会传这个键，不能把它清掉。
          if (Array.isArray(item?.targets)) {
            const list = []
            const seen = new Set()
            for (const x of item.targets) {
              if (x === null || typeof x !== 'object') continue
              const id = String(x?.id ?? '').trim()
              if (id === '' || seen.has(id)) continue
              seen.add(id)
              list.push({ kind: ['user', 'group'].includes(x?.kind) ? x.kind : 'user', id })
            }
            if (list.length > 0) {
              account.targets = list
              // 第一个目标同步写回 target：老通道实现（以及 targetsOf 的回落）只认单个。
              account.target = { kind: list[0].kind, id: list[0].id }
            }
          } else if (Array.isArray(old?.targets) && old.targets.length > 0) {
            account.targets = old.targets
          }
          const givenMention = item?.mention
          if (givenMention !== null && typeof givenMention === 'object') {
            const mode = ['none', 'user', 'all'].includes(givenMention?.mode) ? givenMention.mode : 'none'
            account.mention = {
              mode,
              userIds: Array.isArray(givenMention?.userIds)
                ? givenMention.userIds.map((v) => String(v).trim()).filter((v) => v !== '')
                : [],
            }
          } else if (old?.mention) {
            account.mention = old.mention
          }
          // 一个字段都没填的空行不落盘，避免界面留一堆空账号。
          // 只填了「高级」字段（分块长度 / 块间延迟）不算有账号 —— 那不是凭据。
          // v0.40.0：'type' 是选择项不是凭据 —— 它永远有值（默认 incoming），
          // 算进去的话「只选了类型、什么都没填」的空行会被当成有账号落盘。
          const hasCredential = fields
            .filter((field) => field.group !== 'advanced' && field.key !== 'type')
            .some((field) => String(account?.[field.key] ?? '') !== '')
          if (hasCredential || String(old?.name ?? '') !== '') accounts.push(account)
        }
        if (accounts.length === 0) delete own[channel]
        else own[channel] = accounts
      }
      if (Object.keys(own).length === 0) delete next[config.OWN_BOTS_KEY]
      else next[config.OWN_BOTS_KEY] = own
    }

    const incomingAccounts = incoming?.synology_chat?.accounts
    if (Array.isArray(incomingAccounts)) {
      const oldAccounts = Array.isArray(next?.synology_chat?.accounts) ? next.synology_chat.accounts : []
      const accounts = incomingAccounts.map((item, i) => {
        const old = oldAccounts[i] ?? {}
        const oldUrl = String(old?.webhookUrl ?? old?.resource ?? '')
        const given = item?.webhookUrl ?? item?.resource
        // 掩码/指纹回传、空、未给 → 沿用旧值；只有真正的新值才覆盖。
        const webhookUrl = config.isSecretPlaceholder(given) || given === undefined || given === null || String(given).trim() === ''
          ? oldUrl
          : String(given).trim()

        const account = {
          ...old,
          name: typeof item?.name === 'string' && item.name.trim() !== '' ? item.name.trim() : (old?.name ?? '群晖 Chat'),
          sendChunkDelayMs: Number.isFinite(Number(item?.sendChunkDelayMs)) ? Number(item.sendChunkDelayMs) : Number(old?.sendChunkDelayMs ?? 1500),
          maxMessageChars: Number.isFinite(Number(item?.maxMessageChars)) ? Number(item.maxMessageChars) : Number(old?.maxMessageChars ?? 2000),
        }
        if (webhookUrl !== '') account.webhookUrl = webhookUrl
        else delete account.webhookUrl
        return account
      })
      if (accounts.length === 0) delete next.synology_chat
      else next.synology_chat = { ...(next.synology_chat ?? {}), accounts }
    }

    return next
  }

  /** 通道 + 账号全景（不含任何凭据）。 */
  function describeChannels() {
    const { cfg, sources } = config.loadWithSources(configuredPath === '' ? undefined : configuredPath)
    const defaults = bus.resolveChannels(undefined, cfg)
    const rows = bus.listChannels().map((item) => {
      const names = config.accountNames(cfg, item.name)
      const origin = sources?.[item.name] ?? {}
      return {
        name: item.name,
        title: item.title,
        maxChars: item.maxChars,
        bestEffort: item.bestEffort === true,
        isDefault: defaults.includes(item.name),
        accounts: names,
        // 每个账号来自哪一层：own=本插件自有（界面填的 / 扫码创建的），其余是兼容层
        sources: names.map((name) => origin[name] ?? 'unknown'),
        ownCount: names.filter((name) => origin[name] === 'own').length,
      }
    })
    return {
      ok: true,
      configPath: config.USER_CONFIG,
      legacyConfigPath: config.LOCAL_CONFIG,
      defaults,
      defaultChannelsExplicit: cfg?.[config.DEFAULT_CHANNELS_EXPLICIT] === true,
      channels: rows,
      registryComplete: bus.registryCoversAll(),
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      const url = String(req.url ?? '')
      const sub = url.startsWith(API_PREFIX) ? url.slice(API_PREFIX.length) : url
      const route = sub.split('?')[0].replace(/\/+$/, '') || '/'
      const isPost = req.method === 'POST'

      try {
        if (route === '/send' && isPost) {
          const payload = await readJsonBody(req)
          const outcome = await doSend({
            text: payload.text,
            title: payload.title,
            channels: payload.channels,
            accounts: payload.accounts,
            buttons: payload.buttons,
            replyTo: payload.replyTo ?? payload.reply_to,
            // v0.33.0：进度表情也能一步挂上（dryRun 时用不到，传了也无害）。
            progress: payload.progress,
            emojis: payload.emojis,
            dryRun: payload.dry_run === true || payload.dryRun === true,
          })
          return sendJson(res, outcome.ok === true ? 200 : 502, outcome)
        }

        // ── 发文件（v0.18.0）：正文之外的另一种投递 ──────────────────
        if (route === '/send/file' && isPost) {
          const payload = await readJsonBody(req)
          const outcome = await bus.sendFile(loadCfg(), {
            filePath: payload.filePath ?? payload.file_path,
            caption: payload.caption,
            channels: payload.channels,
            accounts: payload.accounts,
          })
          return sendJson(res, outcome.ok === true ? 200 : 502, outcome)
        }

        // 逐账号发文件（界面上「这个账号能发文件吗」的按钮）。
        if (route === '/send/file/account' && isPost) {
          const payload = await readJsonBody(req)
          const outcome = await bus.sendFileOne(loadCfg(), {
            channel: payload.channel,
            account: payload.account,
            filePath: payload.filePath ?? payload.file_path,
            caption: payload.caption,
          })
          return sendJson(res, outcome.ok === true ? 200 : 502, outcome)
        }

        // 哪些通道能发文件 —— 界面据此决定要不要显示发文件入口，不靠猜。
        if (route === '/send/file/channels') {
          return sendJson(res, 200, { ok: true, channels: bus.FILE_CHANNELS })
        }

        // v0.20.0：谁能带按钮。界面拿它决定「加按钮」入口显不显示。
        if (route === '/buttons/channels') {
          return sendJson(res, 200, {
            ok: true,
            channels: buttons.BUTTON_CHANNELS,
            reasons: buttons.NO_BUTTON_REASON,
          })
        }

        // v0.28.0：最近发出去的那些。带 messageIds，拿到 id 才能改 / 撤。
        if (route === '/send/history') {
          const limitRaw = readQuery(req).get('limit')
          const limit = limitRaw === null ? 50 : Number(limitRaw)
          const list = await outbox.recentSent(Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50)
          return sendJson(res, 200, { ok: true, path: outbox.OUTBOX_PATH, count: list.length, entries: list })
        }

        // v0.29.0：谁能改 / 谁能撤。界面据此决定发件箱那行给不给按钮，
        // 不给「点了必然失败」的按钮 —— 那比没有按钮更糟。
        if (route === '/edit/channels') {
          return sendJson(res, 200, {
            ok: true,
            edit: bus.EDIT_CHANNELS,
            del: bus.DELETE_CHANNELS,
            editReasons: edits.NO_EDIT_REASON,
            deleteReasons: edits.NO_DELETE_REASON,
            // v0.30.0：顺手把表情能力也带上 —— 界面一次加载就能把三种按钮都定好，
            // 不用为「表情」再单独拉一次接口。
            react: bus.REACTION_CHANNELS,
            reactReasons: reactions.NO_REACTION_REASON,
          })
        }

        // v0.30.0：给一条已发出的消息加表情回应。
        if (route === '/send/react' && isPost) {
          const payload = await readJsonBody(req)
          const outcome = await bus.addReaction(loadCfg(), {
            channel: payload.channel,
            account: payload.account,
            messageId: payload.messageId ?? payload.message_id,
            emoji: payload.emoji,
            chatId: payload.chatId ?? payload.chat_id,
          })
          return sendJson(res, outcome.ok === true ? 200 : 502, outcome)
        }

        // v0.30.0：去掉表情回应。
        // Matrix 这里要的是「回应事件 id」而不是原消息 id —— 直接透传给 bus，由它说清楚。
        if (route === '/send/unreact' && isPost) {
          const payload = await readJsonBody(req)
          const outcome = await bus.removeReaction(loadCfg(), {
            channel: payload.channel,
            account: payload.account,
            messageId: payload.messageId ?? payload.message_id,
            emoji: payload.emoji,
            chatId: payload.chatId ?? payload.chat_id,
          })
          return sendJson(res, outcome.ok === true ? 200 : 502, outcome)
        }

        // v0.29.0：改一条已经发出去的消息。
        if (route === '/send/edit' && isPost) {
          const payload = await readJsonBody(req)
          const outcome = await bus.editMessage(loadCfg(), {
            channel: payload.channel,
            account: payload.account,
            messageId: payload.messageId ?? payload.message_id,
            text: payload.text,
            chatId: payload.chatId ?? payload.chat_id,
          })
          return sendJson(res, outcome.ok === true ? 200 : 502, outcome)
        }

        // v0.29.0：撤回一条已经发出去的消息。
        if (route === '/send/delete' && isPost) {
          const payload = await readJsonBody(req)
          const outcome = await bus.deleteMessage(loadCfg(), {
            channel: payload.channel,
            account: payload.account,
            messageId: payload.messageId ?? payload.message_id,
            chatId: payload.chatId ?? payload.chat_id,
          })
          return sendJson(res, outcome.ok === true ? 200 : 502, outcome)
        }

        // v0.32.0：当前活着的流式会话 + 哪几个通道能做。
        // 一次把能力和现状都给出去，界面不用为「能不能流」再拉一次接口。
        if (route === '/send/stream/list') {
          return sendJson(res, 200, bus.listStreams())
        }

        // v0.32.0：开一条流式会话。先发一条「正在处理…」，之后靠 edit 不停改写同一条。
        // 只有 telegram / slack / discord / matrix 四个能做 —— 它们既给消息 id 又能改消息，
        // 两个条件缺一个都流不起来（不能改的话，「流式」就退化成刷屏）。
        if (route === '/send/stream/open' && isPost) {
          const payload = await readJsonBody(req)
          const outcome = await bus.openStream(loadCfg(), {
            channel: payload.channel,
            account: payload.account,
            initialText: payload.initialText ?? payload.initial_text,
            intervalMs: payload.intervalMs ?? payload.interval_ms,
            chatId: payload.chatId ?? payload.chat_id,
          })
          return sendJson(res, outcome.ok === true ? 200 : 502, outcome)
        }

        // v0.32.0：往流里送一次更新。返回 ok=false 不代表出错 ——
        // 可能是还没开成、或已经定稿，界面据 status 字段区分。
        if (route === '/send/stream/update' && isPost) {
          const payload = await readJsonBody(req)
          const outcome = bus.updateStream(
            payload.streamId ?? payload.stream_id,
            payload.text,
          )
          return sendJson(res, outcome.ok === true ? 200 : 502, outcome)
        }

        // v0.32.0：定稿。幂等 —— 重复调用返回第一次结果，不重复发消息。
        if (route === '/send/stream/finish' && isPost) {
          const payload = await readJsonBody(req)
          const outcome = await bus.finishStream(
            payload.streamId ?? payload.stream_id,
            payload.text,
          )
          return sendJson(res, outcome.ok === true ? 200 : 502, outcome)
        }

        // v0.32.0：放弃一条流。已经发出去的那条消息留在那里不动（删是另一个语义，
        // 要用 /send/delete）—— 悄悄删掉用户刚看到的东西比半句话更让人困惑。
        if (route === '/send/stream/cancel' && isPost) {
          const payload = await readJsonBody(req)
          const outcome = bus.cancelStream(payload.streamId ?? payload.stream_id)
          return sendJson(res, outcome.ok === true ? 200 : 502, outcome)
        }

        // v0.33.0：当前还挂着的进度表情 + 哪几个通道能做。
        // v0.34.0 起是 async：它会先恢复磁盘上的记录，再顺手把超时的掐掉。
        if (route === '/send/progress/list') {
          return sendJson(res, 200, await bus.listProgress())
        }

        // v0.33.0：给一条已发出的消息挂「进行中」表情。
        // 拿到 progressId 之后用 /send/progress/end 收尾。
        if (route === '/send/progress/begin' && isPost) {
          const payload = await readJsonBody(req)
          const outcome = await bus.beginProgress(loadCfg(), {
            channel: payload.channel,
            account: payload.account,
            messageId: payload.messageId ?? payload.message_id,
            emojis: payload.emojis,
          })
          return sendJson(res, outcome.ok === true ? 200 : 502, outcome)
        }

        // v0.33.0：进度表情收尾。outcome 传 success / error / 留空（留空=只清干净）。
        // 幂等：收尾后条目就摘掉了，重复调用回「没有这条」而不是来回改表情。
        if (route === '/send/progress/end' && isPost) {
          const payload = await readJsonBody(req)
          const outcome = await bus.endProgress(
            payload.progressId ?? payload.progress_id,
            payload.outcome,
          )
          return sendJson(res, outcome.ok === true ? 200 : 502, outcome)
        }

        // v0.35.0：每分钟配额的现状。只读 —— 配额本身在账号的「高级」页里改。
        if (route === '/send/limits') {
          return sendJson(res, 200, bus.listLimits())
        }

        // v0.25.0：谁能引用回复。界面拿它决定「回复」输入框显不显示。
        if (route === '/reply/channels') {
          return sendJson(res, 200, {
            ok: true,
            channels: reply.REPLY_CHANNELS,
            reasons: reply.NO_REPLY_REASON,
          })
        }

        if (route === '/channels') {
          return sendJson(res, 200, describeChannels())
        }

        // 设置界面读取：只给掩码，不出现任何 token 原文。
        if (route === '/config' && !isPost) {
          const full = describeChannels()
          return sendJson(res, 200, {
            ok: true,
            configPath: config.USER_CONFIG,
            legacyConfigPath: config.LOCAL_CONFIG,
            config: maskedUserConfig(),
            ownBotFields: OWN_BOT_FIELDS,
            targetMeta: TARGET_META,
            channels: full.channels,
            defaults: full.defaults,
            defaultChannelsExplicit: full.defaultChannelsExplicit,
          })
        }

        // 设置界面保存：掩码/指纹占位保留旧值，只写本插件自己的用户级配置。
        if (route === '/config' && isPost) {
          const payload = await readJsonBody(req)
          const next = mergeUserConfig(payload)
          config.writeUserConfig(next)
          const after = describeChannels()
          return sendJson(res, 200, {
            ok: true,
            configPath: config.USER_CONFIG,
            config: maskedUserConfig(),
            ownBotFields: OWN_BOT_FIELDS,
            targetMeta: TARGET_META,
            channels: after.channels,
            defaults: after.defaults,
          })
        }

        // 试发：dryRun=true 只算分块，false 真发。
        if (route === '/test' && isPost) {
          const payload = await readJsonBody(req)
          const outcome = await doSend({
            text: payload.text === undefined || String(payload.text) === '' ? '推送中枢测试消息' : payload.text,
            title: payload.title,
            channels: payload.channels,
            accounts: payload.accounts,
            buttons: payload.buttons,
            replyTo: payload.replyTo ?? payload.reply_to,
            // v0.33.0：进度表情也能一步挂上（dryRun 时用不到，传了也无害）。
            progress: payload.progress,
            emojis: payload.emojis,
            dryRun: payload.dry_run === true || payload.dryRun === true,
          })
          return sendJson(res, outcome.ok === true ? 200 : 502, outcome)
        }

        // 逐账号测试发送：只发指定的那一个账号，不回落不偷换。
        // 用户要的就是「哪个账号能用、哪个不能用」一眼看清，所以结果里必须带账号名。
        if (route === '/test/account' && isPost) {
          const payload = await readJsonBody(req)
          const cfg = loadCfg()
          const text = payload.text === undefined || String(payload.text) === ''
            ? '推送中枢测试消息'
            : String(payload.text)
          const outcome = await bus.sendOne(cfg, {
            channel: payload.channel,
            account: payload.account,
            text,
          })
          return sendJson(res, outcome.ok === true ? 200 : 502, {
            ok: outcome.ok === true,
            channel: outcome.channel,
            account: outcome.account,
            title: outcome.title,
            detail: outcome.detail,
            chars: text.length,
          })
        }

        // 逐账号只读探测：能不发消息就不发，先看凭据本身对不对。
        // 通道没实现 probe 时如实回 supported:false，不伪装成功。
        if (route === '/probe/account' && isPost) {
          const payload = await readJsonBody(req)
          const cfg = loadCfg()
          const outcome = await bus.probeAccount(cfg, {
            channel: payload.channel,
            account: payload.account,
          })
          return sendJson(res, 200, outcome)
        }

        // 列出这个账号「能发给谁」。用户在界面上填不出 chat_id / open_id，
        // 是因为这些 ID 只能从平台侧反查，手填等于让用户猜。这里能列就列，
        // 列不到就说清去哪儿拿 —— 比让用户对着空白框干瞪眼有用。
        if (route === '/targets' && isPost) {
          const payload = await readJsonBody(req)
          const channel = String(payload?.channel ?? '')
          const name = payload?.account
          const cfg = loadCfg()
          const acc = config.account(cfg, channel, name)
          if (acc === null || acc === undefined) {
            return sendJson(res, 404, {
              ok: false,
              items: [],
              note: '找不到账号' + (name === undefined || name === null || String(name) === '' ? '' : '「' + String(name) + '」') + '（先把凭据填好并等它自动保存）',
            })
          }
          // 关键：这里必须和发消息走同一套代理注入，否则 Telegram 的「获取会话」
          // 会用直连去调 api.telegram.org，必然超时（v0.9.0 遗留缺陷）。
          const normalized = bus.normalizeChannel(channel)
          const outcome = await targets.listTargets(normalized, bus.withChannelProxy(cfg, normalized, acc))
          return sendJson(res, 200, outcome)
        }

        // ── 扫码一键创建机器人 ─────────────────────────────────────────
        // 这些路由里任何返回值都不含明文凭据：凭据写进 own_bots 之后就再不出来。
        if (route === '/qr/capabilities') {
          return sendJson(res, 200, { ok: true, channels: qr.QR_CHANNELS, capabilities: await qr.capabilities() })
        }

        if (route === '/qr/start' && isPost) {
          const payload = await readJsonBody(req)
          const outcome = await qr.start(payload.channel)
          return sendJson(res, outcome.ok === true ? 200 : 400, outcome)
        }

        // 轮询用 GET，前端可以直接 setInterval 拉；会话只存在内存里。
        if (route === '/qr/poll') {
          const sessionId = readQuery(req).get('sessionId') ?? ''
          const outcome = qr.poll(sessionId)
          return sendJson(res, outcome.ok === true ? 200 : 404, outcome)
        }

        if (route === '/qr/cancel' && isPost) {
          const payload = await readJsonBody(req)
          return sendJson(res, 200, qr.cancel(payload.sessionId))
        }

        // 扫码成功后落盘：把会话里的凭据合并进 own_bots，然后立刻释放会话。
        if (route === '/qr/apply' && isPost) {
          const payload = await readJsonBody(req)
          const sessionId = String(payload?.sessionId ?? '')
          const state = qr.poll(sessionId)
          if (state.ok !== true) return sendJson(res, 404, state)
          if (state.phase !== 'success') {
            return sendJson(res, 409, { ok: false, error: '这次扫码还没成功（当前状态：' + state.phase + '），稍等再试。' })
          }
          const account = qr.takeAccount(sessionId)
          if (!account || typeof account !== 'object') {
            return sendJson(res, 409, { ok: false, error: '扫码会话里已经没有可用凭据（可能已被保存过），请重新扫一次。' })
          }
          const now = new Date().toISOString()
          const entry = {
            name: String(account.name ?? '').trim() !== '' ? String(account.name) : (CHANNEL_LABELS[state.channel] ?? state.channel) + '扫码机器人',
            imported_from: 'qr',
            imported_at: now,
          }
          for (const [key, value] of Object.entries(account)) {
            if (key === 'name') continue
            if (typeof value !== 'string' || value === '') continue
            entry[key] = value
          }
          const next = mergeUserConfig({ [config.OWN_BOTS_KEY]: { [state.channel]: [entry] } })
          // 关键：mergeUserConfig 是按现有行逐条合并的，扫码进来的是**新账号**，
          // 不能让它按 name 落到旧行上覆盖别人的凭据，所以这里显式追加一份。
          const own = { ...(next?.[config.OWN_BOTS_KEY] ?? {}) }
          const list = Array.isArray(own[state.channel]) ? own[state.channel].filter((item) => item?.imported_from !== 'qr') : []
          own[state.channel] = list.concat([entry])
          next[config.OWN_BOTS_KEY] = own
          config.writeUserConfig(next)
          qr.cancel(sessionId)
          return sendJson(res, 200, {
            ok: true,
            channel: state.channel,
            account: entry.name,
            config: maskedUserConfig(),
            channels: describeChannels().channels,
          })
        }

        // ── 取凭据明文（v0.10.0 新增）────────────────────────────────
        // 用户明确要求：「Token 现在显示明码按键，否则都不知道 token 是谁的」。
        // 这里只放行 OWN_BOT_FIELDS 里标了 secret:true 的键，别的键一律 400 ——
        // 万一以后有人加了个不该外露的字段，也不会被这个口子顺带漏出去。
        // 明文只进浏览器内存，不写日志、不回显终端、不改写配置文件。
        if (route === '/reveal' && isPost) {
          const payload = await readJsonBody(req)
          const channel = String(payload?.channel ?? '')
          const accountName = String(payload?.account ?? '')
          const key = String(payload?.key ?? '')
          const fields = OWN_BOT_FIELDS[channel]
          if (!Array.isArray(fields)) {
            return sendJson(res, 400, { ok: false, error: '未知通道 ' + channel })
          }
          const fieldDef = fields.find((item) => item.key === key)
          if (!fieldDef || fieldDef.secret !== true) {
            return sendJson(res, 400, { ok: false, error: '字段 ' + key + ' 不允许查看明文' })
          }
          const cfg = loadCfg()
          const acc = config.account(cfg, channel, accountName)
          if (acc === null || acc === undefined) {
            return sendJson(res, 404, { ok: false, error: '找不到账号' + (accountName === '' ? '' : '「' + accountName + '」') })
          }
          const value = acc[key]
          if (typeof value !== 'string' || value === '') {
            return sendJson(res, 200, { ok: true, key, value: '', empty: true })
          }
          return sendJson(res, 200, { ok: true, key, value })
        }

        // ── 接收（v0.15.0）：主动去平台拉，不依赖公网回调 ──────────────
        if (route === '/receive/status') {
          return sendJson(res, 200, {
            ok: true,
            receivable: receiver.RECEIVABLE,
            status: receiver.receiveStatus(),
            blocked: Object.fromEntries(
              config.ALL_CHANNELS.filter((ch) => receiver.receiveBlocker(ch) !== '').map((ch) => [ch, receiver.receiveBlocker(ch)]),
            ),
          })
        }

        if (route === '/receive/start' && isPost) {
          const payload = await readJsonBody(req)
          const cfg = loadCfg()
          const channel = String(payload?.channel ?? '')
          const normalized = bus.normalizeChannel(channel)
          const blocker = receiver.receiveBlocker(normalized)
          if (blocker !== '') return sendJson(res, 400, { ok: false, detail: blocker })
          const rows = Array.isArray(cfg?.own_bots?.[normalized]) ? cfg.own_bots[normalized] : []
          if (rows.length === 0) {
            return sendJson(res, 400, { ok: false, detail: '「' + normalized + '」还没有账号，先在上面加一个再开接收' })
          }
          const accounts = rows.map((acc) => ({
            name: String(acc?.name ?? ''),
            acc: bus.withChannelProxy(cfg, normalized, acc),
          }))
          // v0.39.0：startChannel 现在是 async —— 它要先抢接收权、并等同账号的旧循环真退出。
          const outcome = await receiver.startChannel(normalized, accounts)
          return sendJson(res, outcome.ok === true ? 200 : 400, outcome)
        }

        if (route === '/receive/stop' && isPost) {
          const payload = await readJsonBody(req)
          const channel = String(payload?.channel ?? '')
          // v0.39.0：stopChannel 也变成 async —— 等循环真退出再回，避免「停完立刻开」撞 409。
          return sendJson(res, 200, await receiver.stopChannel(channel))
        }

        if (route === '/receive/inbox') {
          const limit = Number(readQuery(req).get('limit') ?? '50')
          return sendJson(res, 200, {
            ok: true,
            path: inbox.INBOX_PATH,
            messages: await inbox.recentMessages(Number.isFinite(limit) ? limit : 50),
          })
        }

        if (route === '/receive/inbox/attachments') {
          // v0.27.0：只列带附件的入站消息。收件箱里混着几百条纯文字时，
          // 「谁给我发过文件」得翻半天 —— 这一条按附件过滤。
          const limit = Number(readQuery(req).get('limit') ?? '50')
          const rows = await inbox.recentMessages(Number.isFinite(limit) ? limit : 50)
          return sendJson(res, 200, {
            ok: true,
            path: inbox.INBOX_PATH,
            messages: rows.filter((item) => Array.isArray(item?.attachments) && item.attachments.length > 0),
          })
        }
        if (route === '/receive/inbox/callbacks') {
          // 按钮回调单独一条：混在普通消息里看不出哪些是需要回应的（v0.22.0）。
          const limit = Number(readQuery(req).get('limit') ?? '50')
          const rows = await inbox.recentMessages(Number.isFinite(limit) ? limit : 50)
          return sendJson(res, 200, {
            ok: true,
            path: inbox.INBOX_PATH,
            messages: rows.filter((item) => item?.kind === 'callback'),
          })
        }

        if (route === '/receive/inbox/clear' && isPost) {
          return sendJson(res, 200, await inbox.clearInbox())
        }

        // ── 附件下载（v0.36.0）────────────────────────────────────────
        // 这四条一组：策略 / 落盘清单 / 清理 / 单条补下。
        // 为什么补下要单独一条：接收时下载失败（网络抖动、平台限流）是常事，
        // 用户看到「下载失败」应该有个按钮能重试，而不是只能等对方重发一遍。
        if (route === '/receive/files') {
          const limit = Number(readQuery(req).get('limit') ?? '200')
          const listed = await download.listFiles({ limit: Number.isFinite(limit) ? limit : 200 })
          // 清单和策略一次给全：界面上「硬盘上有什么」和「为什么少了几个」是同一个问题，
          // 分两次请求会让页面先显示空目录再蹦出文件，看起来像刚被清过。
          const policy = download.strategyOf(download.policyFromConfig(config.load() ?? {}))
          return sendJson(res, 200, { ...listed, policy })
        }

        if (route === '/receive/files/policy') {
          if (isPost) {
            const payload = await readJsonBody(req)
            const merged = { ...config.readUserConfig() }
            const before = merged[config.DOWNLOAD_KEY] && typeof merged[config.DOWNLOAD_KEY] === 'object'
              ? merged[config.DOWNLOAD_KEY]
              : {}
            const next = { ...before }
            // 三个键都只在「真的给了」时才写：没给就沿用旧值，
            // 否则界面上改一个键会把另外两个重置掉。
            for (const key of ['maxFileMB', 'retainDays', 'maxTotalMB']) {
              if (payload?.[key] === undefined || payload?.[key] === null) continue
              const text = String(payload[key]).trim()
              if (text === '') {
                delete next[key]
                continue
              }
              const n = Number(text)
              if (Number.isFinite(n) && n >= 0) next[key] = Math.floor(n)
            }
            if (Object.keys(next).length === 0) delete merged[config.DOWNLOAD_KEY]
            else merged[config.DOWNLOAD_KEY] = next
            config.writeUserConfig(merged)
            return sendJson(res, 200, download.strategyOf(download.policyFromConfig(config.load() ?? {})))
          }
          return sendJson(res, 200, download.strategyOf(download.policyFromConfig(config.load() ?? {})))
        }

        if (route === '/receive/files/sweep' && isPost) {
          const payload = await readJsonBody(req)
          const policy = download.policyFromConfig(config.load() ?? {})
          return sendJson(res, 200, await download.sweepFiles({
            ...policy,
            ...(payload?.retainDays === undefined ? {} : { retainDays: payload.retainDays }),
            ...(payload?.maxTotalMB === undefined ? {} : { maxTotalMB: payload.maxTotalMB }),
          }))
        }

        if (route === '/receive/files/fetch' && isPost) {
          // 补下一条：body 给 { messageId?, channel?, index? } —— 直接在收件箱里定位。
          const payload = await readJsonBody(req)
          const rows = await inbox.recentMessages(200)
          const target = rows.find((item) => String(item?.id ?? '') === String(payload?.messageId ?? ''))
          if (!target) return sendJson(res, 404, { ok: false, detail: '收件箱里找不到这条消息（可能已被清理）' })
          const list = Array.isArray(target?.attachments) ? target.attachments : []
          const index = Number(payload?.index)
          const pick = Number.isInteger(index) && index >= 0 && index < list.length ? [list[index]] : list
          if (pick.length === 0) return sendJson(res, 200, { ok: false, detail: '这条消息没有附件' })
          let acc = null
          try {
            acc = config.account(config.load() ?? {}, String(target.channel ?? ''), String(target.account ?? ''))
          } catch {
            acc = null
          }
          if (!acc) return sendJson(res, 200, { ok: false, detail: '这条消息的账号已从配置里删掉了，没有凭据可用' })
          const done = await download.downloadAll(pick, acc, download.policyFromConfig(config.load() ?? {}))
          const saved = done.filter((one) => one?.localPath)
          if (saved.length > 0) await inbox.updateAttachments(target.id, done)
          return sendJson(res, 200, { ok: saved.length > 0, saved: saved.length, items: done.map((one) => ({ name: one.name, localPath: one.localPath ?? '', state: one?.download?.state ?? '', detail: one?.download?.detail ?? '' })) })
        }

        if (route === '/info') {
          return sendJson(res, 200, {
            ok: true,
            version: readVersion(),
            root: ROOT,
            apiBase: API_PREFIX,
          })
        }

        return sendJson(res, 404, { ok: false, error: '未知路由 ' + route })
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: String(error) })
      }
    },
  }), 'push-hub: api')

  // ── 工具 0：发文件（v0.18.0 新增）──────────────────────────────────────
  ctx.effect(() => ctx.tools.register({
    name: 'push_hub_send_file',
    description: '把一个本地文件推送到支持附件的通道（Telegram / Slack / Discord / Matrix / 邮件）。文件只读一次盘，同一份字节发给所有选中通道。图片在 Telegram / Matrix 上会走「发图片」而不是「发文件」，对方能直接看到预览。文件路径必须是绝对路径。默认按配置里的 default_channels 群发，其中不支持发文件的通道会被逐条点名说明，不会静默跳过。',
    parameters: {
      file_path: { type: 'string', required: true, description: '要发的本地文件绝对路径。相对路径会被拒绝（插件的 cwd 不是你以为的那个目录）。' },
      caption: { type: 'string', description: '可选说明文字，作为附件说明 / 邮件正文。' },
      channels: { type: 'string', description: '可选，逗号分隔的通道名。留空用配置的 default_channels。能发文件的是 telegram/slack/discord/matrix/email。' },
      accounts: { type: 'string', description: '可选，指定每个通道用哪个账号，例如 "telegram=主号"。不写则每个通道取第一个账号。' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const outcome = await bus.sendFile(loadCfg(), {
        filePath: args?.file_path,
        caption: args?.caption,
        channels: args?.channels,
        accounts: args?.accounts,
      })
      return JSON.stringify(outcome, null, 2)
    },
  }), 'push-hub: send-file tool')

  // ── 工具 1：发推送（主入口）────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register({
    name: 'push_hub_send',
    description: '把一段文字推送到 Telegram / 飞书 / QQ / 微信 / 群晖 Chat。默认按配置里的 default_channels 群发；只有非「尽力而为」的通道（telegram/feishu/qq/群晖）至少一个成功，整体才算成功。微信是尽力而为通道（服务端常返回 ret=-2，属于已知故障，失败不影响整体结论）。想先看会切成几块、发到哪些通道而不真发，传 dry_run=true。',
    parameters: {
      text: { type: 'string', required: true, description: '推送正文。可以是多行，会按各通道上限自动分块。' },
      title: { type: 'string', description: '可选标题，会以【标题】形式加在正文最前面。' },
      channels: { type: 'string', description: '可选，逗号分隔的通道名，例如 "feishu,qq"。留空用配置的 default_channels。别名可用：tg/lark/qqbot/wx/weixin/chat。' },
      accounts: { type: 'string', description: '可选，指定每个通道用哪个账号，例如 "wechat=爸爸,qq=默认"。不写则每个通道取第一个账号。' },
      dry_run: { type: 'boolean', description: 'true 时只返回将要发送的通道与分块计划，不真的发出去。' },
      buttons: { type: 'string', description: '可选，JSON 按钮。例 \'[{"text":"通过","callback":"ok"},{"text":"拒绝","callback":"no"}]\'（一维自动每 5 个折行），或二维数组显式分行。只有 telegram/slack/discord 支持；其余通道照常发文字，按钮丢弃并在结果里点名原因。callback 值上限 64 字节（按 Telegram 最严的验）。' },
      reply_to: { type: 'string', description: '可选，要引用回复的那条消息 ID。只有 telegram/slack/discord/matrix/qq 支持；其余通道照常发新消息，并在结果里点名原因。Telegram 用 message_id、Slack 用 ts（回复=进线程）、Discord 用 message id、Matrix 用 event_id、QQ 用刚收到那条的 msg_id（被动回复有窗口期）。收件箱里每条消息都记着这些 ID。' },
      progress: { type: 'boolean', description: '可选，true 表示发完顺手给那条消息挂个「进行中」表情（⏳），跑完用 push_hub_progress_end 换成成功/失败。只有 telegram/slack/discord/matrix 能做；其余通道照常发文字，只在自己那条结果里说明为什么没挂上。**挂不上不会让发送失败**。' },
      emojis: { type: 'string', description: '可选，配合 progress:true 用，JSON 形如 {"processing":"⏳","success":"✅","error":"❌"}。Slack 要填名字（hourglass_flowing_sand / white_check_mark / x）而不是字符。' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      let emojis
      if (typeof args?.emojis === 'string' && args.emojis.trim() !== '') {
        try { emojis = JSON.parse(args.emojis) } catch { emojis = undefined }
      } else if (args?.emojis && typeof args.emojis === 'object') {
        emojis = args.emojis
      }
      const outcome = await doSend({
        text: args?.text,
        title: args?.title,
        buttons: args?.buttons,
        replyTo: args?.reply_to,
        channels: args?.channels,
        accounts: args?.accounts,
        progress: args?.progress === true,
        emojis,
        dryRun: args?.dry_run === true,
      })
      return JSON.stringify(outcome, null, 2)
    },
  }), 'push-hub: send tool')

  // ── 工具 2：看通道与账号 ───────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register({
    name: 'push_hub_channels',
    description: '查看推送中枢当前有哪些通道、哪些是默认通道、每个通道配了几个账号（只给账号名，绝不回显 token）。排查「为什么没发出去」时先看它。',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      return JSON.stringify(describeChannels(), null, 2)
    },
  }), 'push-hub: channels tool')

  // ── 工具 3：自检 ───────────────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register({
    name: 'push_hub_selftest',
    description: '推送中枢自检：确认配置能被读到、12 个通道都注册了、默认通道解析出来是什么。只看配置与装配，不发任何消息，不消耗外部配额。',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      let cfg = null
      let error = ''
      try {
        cfg = loadCfg()
      } catch (err) {
        error = String(err?.message ?? err)
      }
      const report = {
        ok: error === '' && bus.registryCoversAll(),
        root: ROOT,
        localConfig: config.LOCAL_CONFIG,
        configLoaded: cfg !== null,
        ...(error === '' ? {} : { error }),
        registryComplete: bus.registryCoversAll(),
        allChannels: config.ALL_CHANNELS,
        registered: bus.listChannels().map((item) => item.name),
        defaults: cfg === null ? [] : bus.resolveChannels(undefined, cfg),
      }
      return JSON.stringify(report, null, 2)
    },
  }), 'push-hub: selftest tool')

  // ── 工具 4：收消息（v0.15.0 新增）────────────────────────────────────
  ctx.effect(() => ctx.tools.register({
    name: 'push_hub_receive',
    description: '接收方向：查看哪些通道能收、开/关某个通道的接收、读最近收到的消息与按钮回调。能收 7 个通道（Telegram / 微信 / 飞书 / Matrix / Slack / Discord / QQ），全部是「本机主动连出去」的长轮询或 WebSocket 长连接，不需要公网地址；群晖 / 钉钉 / 企业微信 / 企业微信自建应用 / 邮件只有平台回调或纯发送接口，收不了，会如实说明原因。收到的消息落在 ~/.dsh/dsh-push-hub/inbox.json。',
    parameters: {
      action: { type: 'string', required: true, description: 'start=开始收某个通道 / stop=停止 / status=看状态 / inbox=读最近消息 / callbacks=只读按钮回调' },
      channel: { type: 'string', description: 'action=start 或 stop 时必填，通道名，例如 telegram、wechat。' },
      limit: { type: 'number', description: 'action=inbox 时读多少条，默认 50。' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const action = String(args?.action ?? '').trim()
      if (action === 'status') {
        return JSON.stringify({
          receivable: receiver.RECEIVABLE,
          status: receiver.receiveStatus(),
          inbox: inbox.INBOX_PATH,
        }, null, 2)
      }
      if (action === 'inbox') {
        const limit = Number(args?.limit) > 0 ? Number(args.limit) : 50
        return JSON.stringify({ ok: true, path: inbox.INBOX_PATH, messages: await inbox.recentMessages(limit) }, null, 2)
      }
      if (action === 'callbacks') {
        const limit = Number(args?.limit) > 0 ? Number(args.limit) : 50
        const rows = await inbox.recentMessages(limit)
        return JSON.stringify({ ok: true, path: inbox.INBOX_PATH, messages: rows.filter((item) => item?.kind === 'callback') }, null, 2)
      }
      const channel = bus.normalizeChannel(String(args?.channel ?? ''))
      if (action === 'stop') {
        return JSON.stringify(await receiver.stopChannel(channel), null, 2)
      }
      if (action === 'start') {
        const blocker = receiver.receiveBlocker(channel)
        if (blocker !== '') return JSON.stringify({ ok: false, detail: blocker }, null, 2)
        const cfg = loadCfg()
        const rows = Array.isArray(cfg?.own_bots?.[channel]) ? cfg.own_bots[channel] : []
        if (rows.length === 0) {
          return JSON.stringify({ ok: false, detail: '「' + channel + '」还没有账号，先在设置里加一个再开接收' }, null, 2)
        }
        const accounts = rows.map((acc) => ({ name: String(acc?.name ?? ''), acc: bus.withChannelProxy(cfg, channel, acc) }))
        return JSON.stringify(await receiver.startChannel(channel, accounts), null, 2)
      }
      return JSON.stringify({ ok: false, detail: 'action 只能是 start / stop / status / inbox' }, null, 2)
    },
  }), 'push-hub: receive tool')

  // ── 工具 5：发送回执（v0.28.0 新增）──────────────────────────────────
  ctx.effect(() => ctx.tools.register({
    name: 'push_hub_sent',
    description: '发送回执：看最近发出去的消息记录（含平台返回的消息 id）。只记成功的那些 —— 失败的没有 id，记进去既不能改也不能撤。目前 12 个通道里 telegram / slack / discord / matrix 四个能拿到可操作的消息 id（改 / 撤 / 加表情都要它）；飞书、QQ、邮件只记 id 但平台不给编辑接口；微信、钉钉、企业微信、企业微信自建应用、群晖的回包根本没有 id，所以 messageIds 会是空数组。记录落在 ~/.dsh/dsh-push-hub/outbox.json，最多留 500 条。',
    parameters: {
      action: { type: 'string', required: true, description: 'recent=最近发出去的（默认）/ path=只看文件在哪' },
      limit: { type: 'number', description: 'action=recent 时读多少条，默认 20，最多 500。' },
      channel: { type: 'string', description: '可选，只看某个通道，例如 telegram。留空看全部。' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const action = String(args?.action ?? 'recent').trim()
      if (action === 'path' || action === '') {
        return JSON.stringify({ ok: true, path: outbox.OUTBOX_PATH, maxKeep: outbox.MAX_KEEP }, null, 2)
      }
      const limitRaw = Number(args?.limit)
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 20
      const rows = await outbox.recentSent(limit)
      const wantChannel = bus.normalizeChannel(String(args?.channel ?? ''))
      const picked = wantChannel === '' ? rows : rows.filter((item) => item?.channel === wantChannel)
      return JSON.stringify({
        ok: true,
        path: outbox.OUTBOX_PATH,
        count: picked.length,
        // 有 id 和没 id 分开数：只给条数的话，用户会以为「都记下来了」就能改。
        withIds: picked.filter((item) => Array.isArray(item?.messageIds) && item.messageIds.length > 0).length,
        entries: picked,
      }, null, 2)
    },
  }), 'push-hub: sent tool')
  // ── 工具 6：改消息（v0.29.0 新增）────────────────────────────────────
  ctx.effect(() => ctx.tools.register({
    name: 'push_hub_edit',
    description: '改一条已经发出去的消息。只有 telegram / slack / discord / matrix 四个通道支持；其余通道会直说为什么不行，不会假装成功。消息 id 从 push_hub_sent 的发件箱里取（messageIds 数组，长消息分块时每块一个）。注意：改消息不能分块，正文要短于该通道上限；Matrix 的「改」不是编辑原事件，而是再发一条 m.replace 事件，客户端会显示成「已编辑」。',
    parameters: {
      channel: { type: 'string', required: true, description: '通道名，例如 telegram / slack / discord / matrix。' },
      messageId: { type: 'string', required: true, description: '要改的那条消息 id（从 push_hub_sent 的 messageIds 里取）。' },
      text: { type: 'string', required: true, description: '改成什么。不能为空 —— 要清掉请改用 push_hub_delete。' },
      account: { type: 'string', description: '可选，账号名。留空用该通道第一个账号。' },
      chatId: { type: 'string', description: '可选，消息所在的聊天 / 频道 / 房间 id。留空用该账号配置里的发送目标；多投递目标时建议显式给。' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const outcome = await bus.editMessage(loadCfg(), {
        channel: args?.channel,
        account: args?.account,
        messageId: args?.messageId,
        text: args?.text,
        chatId: args?.chatId,
      })
      return JSON.stringify(outcome, null, 2)
    },
  }), 'push-hub: edit tool')

  // ── 工具 7：撤回消息（v0.29.0 新增）──────────────────────────────────
  ctx.effect(() => ctx.tools.register({
    name: 'push_hub_delete',
    description: '撤回一条已经发出去的消息。只有 telegram / slack / discord / matrix 四个通道支持。注意各自的限制：Telegram 只能撤自己发的、48 小时内的；Slack 用 chat.delete 需要 chat:write 权限；Matrix 的撤回是不可逆的 redact（客户端可能还留着本地缓存）；Discord 撤回自己的消息没有时限。其余通道直说为什么不行。',
    parameters: {
      channel: { type: 'string', required: true, description: '通道名，例如 telegram / slack / discord / matrix。' },
      messageId: { type: 'string', required: true, description: '要撤回的那条消息 id。' },
      account: { type: 'string', description: '可选，账号名。留空用该通道第一个账号。' },
      chatId: { type: 'string', description: '可选，消息所在的聊天 / 频道 / 房间 id。留空用该通道配置里的发送目标。' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const outcome = await bus.deleteMessage(loadCfg(), {
        channel: args?.channel,
        account: args?.account,
        messageId: args?.messageId,
        chatId: args?.chatId,
      })
      return JSON.stringify(outcome, null, 2)
    },
  }), 'push-hub: delete tool')

  // ── 工具 8：给消息加表情回应（v0.30.0 新增）──────────────────────────
  ctx.effect(() => ctx.tools.register({
    name: 'push_hub_react',
    description: '给一条已经发出去的消息加表情回应。只有 telegram / slack / discord / matrix 四个支持。**Slack 特殊**：它认的是表情名字（thumbsup），不是 👍 这个字符 —— 本插件带了常见 Unicode→名字 的对照表，表里没有的会直接拒绝并要求填名字，不会猜一个名字发出去。Telegram 只认它自己的 reaction 表情集，不是所有 emoji 都能当回应。Discord 的自定义表情要写成 name:id（例 blob:1234567890）。Matrix 是再发一条 m.annotation 事件。',
    parameters: {
      channel: { type: 'string', required: true, description: '通道名，例如 telegram / slack / discord / matrix。' },
      messageId: { type: 'string', required: true, description: '要给哪条消息加表情（从 push_hub_sent 的 messageIds 里取）。' },
      emoji: { type: 'string', required: true, description: '表情。Telegram / Discord / Matrix 填 Unicode 字符（👍）；Slack 填名字（thumbsup）或本插件认识的 Unicode。' },
      account: { type: 'string', description: '可选，账号名。留空用该通道第一个账号。' },
      chatId: { type: 'string', description: '可选，消息所在的聊天 / 频道 / 房间 id。留空用该账号配置里的发送目标。' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const outcome = await bus.addReaction(loadCfg(), {
        channel: args?.channel,
        account: args?.account,
        messageId: args?.messageId,
        emoji: args?.emoji,
        chatId: args?.chatId,
      })
      return JSON.stringify(outcome, null, 2)
    },
  }), 'push-hub: react tool')

  // ── 工具 9：去掉表情回应（v0.30.0 新增）─────────────────────────────
  ctx.effect(() => ctx.tools.register({
    name: 'push_hub_unreact',
    description: '去掉一条消息上的表情回应。**各家语义不一样，必须看清**：Telegram 没有「只删某一个」的接口，传 messageId 就把它挂的表情一次清空；Slack 用 reactions.remove 删掉该机器人挂的那个名字；Discord 删掉 @me 的那个回应；**Matrix 要的是「回应事件 id」而不是原消息 id** —— 它的表情本身是一个独立事件，只能撤回那个事件。',
    parameters: {
      channel: { type: 'string', required: true, description: '通道名，例如 telegram / slack / discord / matrix。' },
      messageId: { type: 'string', required: true, description: '消息 id；Matrix 请填「回应事件 id」。' },
      emoji: { type: 'string', description: '表情（Slack 填名字）。Telegram 可留空 —— 它是整体清空。' },
      account: { type: 'string', description: '可选，账号名。留空用该通道第一个账号。' },
      chatId: { type: 'string', description: '可选，消息所在的聊天 / 频道 / 房间 id。' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const outcome = await bus.removeReaction(loadCfg(), {
        channel: args?.channel,
        account: args?.account,
        messageId: args?.messageId,
        emoji: args?.emoji,
        chatId: args?.chatId,
      })
      return JSON.stringify(outcome, null, 2)
    },
  }), 'push-hub: unreact tool')

  // ── 工具 10：开一条流式会话（v0.32.0 新增）──────────────────────────
  ctx.effect(() => ctx.tools.register({
    name: 'push_hub_stream_open',
    description: '开一条「流式可编辑消息」：先发一条初始消息，之后用 push_hub_stream_update 反复改写同一条，最后用 push_hub_stream_finish 定稿。适合把长回答一段段推给用户而不是等全部生成完。只有 telegram / slack / discord / matrix 四个通道能做（既要给消息 id、又要能改消息）。同一时刻最多 64 条流。**注意**：update 是合并刷新的，不是每条都立刻发 —— 平台对编辑同一条有频控，每来一个字就改必然被限流。',
    parameters: {
      channel: { type: 'string', required: true, description: '通道名。只有 telegram / slack / discord / matrix 能做。' },
      initialText: { type: 'string', description: '可选，第一条消息的正文。默认「正在处理…」。' },
      intervalMs: { type: 'string', description: '可选，两次编辑之间最少隔多少毫秒。默认 900，低于 300 按下限走、高于 10000 按上限走（会被夹紧并在 detail 里说明）。' },
      account: { type: 'string', description: '可选，账号名。留空用该通道第一个账号。' },
      chatId: { type: 'string', description: '可选，消息所在的聊天 / 频道 / 房间 id。留空用该账号配置里的发送目标。' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const outcome = await bus.openStream(loadCfg(), {
        channel: args?.channel,
        account: args?.account,
        initialText: args?.initialText,
        intervalMs: args?.intervalMs,
        chatId: args?.chatId,
      })
      return JSON.stringify(outcome, null, 2)
    },
  }), 'push-hub: stream open tool')

  // ── 工具 11：往流里送一次更新（v0.32.0 新增）────────────────────────
  ctx.effect(() => ctx.tools.register({
    name: 'push_hub_stream_update',
    description: '把当前进度送进一条流式会话。**这是合并刷新，不是立刻发**：同一个间隔窗口内多次调用只会用最后那份文本改一次，省得把平台编辑频控打穿。空文本会被忽略（不覆盖成空白）。返回 ok=false 不一定是出错，看 status 字段：open 之外的状态（finished / cancelled）就是这条流已经收尾了。',
    parameters: {
      streamId: { type: 'string', required: true, description: 'push_hub_stream_open 返回的 streamId。' },
      text: { type: 'string', required: true, description: '当前完整正文（不是增量片段）—— 每次都是把整条消息改成这个样子。' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const outcome = bus.updateStream(args?.streamId, args?.text)
      return JSON.stringify(outcome, null, 2)
    },
  }), 'push-hub: stream update tool')

  // ── 工具 12：定稿（v0.32.0 新增）───────────────────────────────────
  ctx.effect(() => ctx.tools.register({
    name: 'push_hub_stream_finish',
    description: '给一条流式会话定稿：把最后一份正文改上去，超长部分（超过该通道单条上限）另发新消息。**幂等** —— 重复调用返回第一次的结果，不会重复发。定稿后这条流就从活动列表消失，再 update 会拿回「没有这条流」。',
    parameters: {
      streamId: { type: 'string', required: true, description: 'push_hub_stream_open 返回的 streamId。' },
      text: { type: 'string', required: true, description: '最终完整正文。' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const outcome = await bus.finishStream(args?.streamId, args?.text)
      return JSON.stringify(outcome, null, 2)
    },
  }), 'push-hub: stream finish tool')

  // ── 工具 13：给一条已发出的消息挂「进行中」表情（v0.33.0 新增）───────
  ctx.effect(() => ctx.tools.register({
    name: 'push_hub_progress_begin',
    description: '给一条已经发出去的消息挂「进行中」表情（⏳ 之类），跑完用 push_hub_progress_end 换成成功/失败。适合让用户不用翻记录就知道任务到哪一步。只有 telegram / slack / discord / matrix 四个通道能做（与「能加表情」是同一批）。**best-effort**：挂不上不会让消息发送失败，原因写在 detail 里。也支持在 push_hub_send 时直接传 progress:true 一步做完。',
    parameters: {
      channel: { type: 'string', required: true, description: '通道名。只有 telegram / slack / discord / matrix 能做。' },
      messageId: { type: 'string', required: true, description: '要挂表情的消息 id（从 push_hub_sent 的 messageIds 或 push_hub_send 的返回里取）。' },
      account: { type: 'string', description: '可选，账号名。留空用该通道第一个账号。' },
      emojis: { type: 'string', description: '可选，自定义三态表情，JSON 形如 {"processing":"⏳","success":"✅","error":"❌"}。Slack 要填名字（hourglass_flowing_sand）不是字符。' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      let emojis
      if (typeof args?.emojis === 'string' && args.emojis.trim() !== '') {
        try { emojis = JSON.parse(args.emojis) } catch { emojis = undefined }
      } else if (args?.emojis && typeof args.emojis === 'object') {
        emojis = args.emojis
      }
      const outcome = await bus.beginProgress(loadCfg(), {
        channel: args?.channel,
        account: args?.account,
        messageId: args?.messageId,
        emojis,
      })
      return JSON.stringify(outcome, null, 2)
    },
  }), 'push-hub: progress begin tool')

  // ── 工具 14：进度表情收尾（v0.33.0 新增）───────────────────────────
  ctx.effect(() => ctx.tools.register({
    name: 'push_hub_progress_end',
    description: '给进度表情收尾：把「进行中」换成成功（✅）或失败（❌），或只清干净不留表情（outcome 留空）。**幂等**：收尾后条目就摘掉了，重复调用会回「没有这条进度」，不会来回改表情。表情操作失败不影响任何消息。',
    parameters: {
      progressId: { type: 'string', required: true, description: 'push_hub_progress_begin 返回的 progressId。' },
      outcome: { type: 'string', description: 'success 换成成功表情；error 换成失败表情；留空则只把「进行中」摘掉、不留新表情。' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const outcome = await bus.endProgress(args?.progressId, args?.outcome)
      return JSON.stringify(outcome, null, 2)
    },
  }), 'push-hub: progress end tool')

  // ── 工具 15：查看还挂着的进度表情（v0.33.0 新增）─────────────────────
  ctx.effect(() => ctx.tools.register({
    name: 'push_hub_progress_list',
    description: '看现在还有哪些进度表情挂着（没被 end 收尾的），以及哪几个通道能做、八家为什么不能。',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      return JSON.stringify(await bus.listProgress(), null, 2)
    },
  }), 'push-hub: progress list tool')

  // v0.35.0：每分钟配额的现状（只读）。配额的设置入口在账号的「高级」页，
  // 工具这边只回答「现在是几个桶、各自用掉多少、卡过几次」——
  // 一个能「悄悄让消息变慢」的东西，必须有地方能查到它在慢什么。
  ctx.effect(() => ctx.tools.register({
    name: 'push_hub_limits',
    description: [
      '查看每分钟发送配额的现状：几个「通道|账号|目标」桶、各自用掉多少、等过几次、卡过几次。',
      '配额默认 15 条/分钟（按「块」算，一条长消息切 10 块就扣 10 次），可在账号高级页改成 1~30，填 0 = 不限。',
      '桶是易失的 —— 插件重启后这里会是空数组，那是正确状态，不是故障。',
    ].join(''),
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      return JSON.stringify(bus.listLimits(), null, 2)
    },
  }), 'push-hub: limits tool')

  // ── 工具 18：入站附件下载（v0.36.0 新增）────────────────────────────
  ctx.effect(() => ctx.tools.register({
    name: 'push_hub_files',
    description: '入站附件下载：把对方发来的图片 / 文件 / 语音真正取回本地，落在 ~/.dsh/dsh-push-hub/files/<日期>/。支持 action=list（看硬盘上有什么）/ policy（看或改单文件上限、保留天数、总量上限）/ sweep（按策略清理）/ fetch（给某条收件箱消息补下）。三条纪律：下载失败绝不影响收消息；单文件上限在传输层生效（不是下完再量）；平台给的文件名一律洗过再落盘。QQ / 钉钉是本轮主动没做（平台给接口，但会拖长这版），企业微信智能机器人是链路本身不给原图 —— 四种取不到的情况都会如实说明原因，不假装成下载失败。',
    parameters: {
      action: { type: 'string', required: true, description: 'list=看已落盘的附件 / policy=看策略 / setPolicy=改策略 / sweep=清理 / fetch=给某条消息补下' },
      limit: { type: 'number', description: 'action=list 时列多少条，默认 200。' },
      maxFileMB: { type: 'number', description: 'action=setPolicy 时用：单文件上限（MB）。0 = 不限，留空 = 默认 10。' },
      retainDays: { type: 'number', description: 'action=setPolicy 时用：保留天数。0 = 不自动清，留空 = 默认 7。' },
      maxTotalMB: { type: 'number', description: 'action=setPolicy 时用：总量上限（MB）。0 = 不限，留空 = 默认 200。' },
      messageId: { type: 'string', description: 'action=fetch 时用：收件箱里那条消息的 id。' },
      index: { type: 'number', description: 'action=fetch 时可选：只补下第几个附件（从 0 起）。不传就全部补。' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const action = String(args?.action ?? '').trim()
      if (action === 'list') {
        const limit = Number(args?.limit) > 0 ? Number(args.limit) : 200
        return JSON.stringify(await download.listFiles({ limit }), null, 2)
      }
      if (action === 'policy') {
        return JSON.stringify(download.strategyOf(download.policyFromConfig(config.load() ?? {})), null, 2)
      }
      if (action === 'setPolicy') {
        const merged = { ...config.readUserConfig() }
        const before = merged[config.DOWNLOAD_KEY] && typeof merged[config.DOWNLOAD_KEY] === 'object' ? merged[config.DOWNLOAD_KEY] : {}
        const next = { ...before }
        for (const key of ['maxFileMB', 'retainDays', 'maxTotalMB']) {
          const given = args?.[key]
          if (given === undefined || given === null || String(given).trim() === '') continue
          const n = Number(given)
          if (Number.isFinite(n) && n >= 0) next[key] = Math.floor(n)
        }
        if (Object.keys(next).length === 0) delete merged[config.DOWNLOAD_KEY]
        else merged[config.DOWNLOAD_KEY] = next
        config.writeUserConfig(merged)
        return JSON.stringify(download.strategyOf(download.policyFromConfig(config.load() ?? {})), null, 2)
      }
      if (action === 'sweep') {
        const policy = download.policyFromConfig(config.load() ?? {})
        return JSON.stringify(await download.sweepFiles(policy), null, 2)
      }
      if (action === 'fetch') {
        const messageId = String(args?.messageId ?? '').trim()
        if (messageId === '') return JSON.stringify({ ok: false, detail: 'action=fetch 需要 messageId（先从 push_hub_receive action=inbox 里取）' }, null, 2)
        const rows = await inbox.recentMessages(200)
        const target = rows.find((item) => String(item?.id ?? '') === messageId)
        if (!target) return JSON.stringify({ ok: false, detail: '收件箱里找不到这条消息' }, null, 2)
        const list = Array.isArray(target?.attachments) ? target.attachments : []
        if (list.length === 0) return JSON.stringify({ ok: false, detail: '这条消息没有附件' }, null, 2)
        const index = Number(args?.index)
        const pick = Number.isInteger(index) && index >= 0 && index < list.length ? [list[index]] : list
        let acc = null
        try {
          acc = config.account(config.load() ?? {}, String(target.channel ?? ''), String(target.account ?? ''))
        } catch {
          acc = null
        }
        if (!acc) return JSON.stringify({ ok: false, detail: '这条消息的账号已从配置里删掉了，没有凭据可用' }, null, 2)
        const done = await download.downloadAll(pick, acc, download.policyFromConfig(config.load() ?? {}))
        const saved = done.filter((one) => one?.localPath)
        if (saved.length > 0) await inbox.updateAttachments(messageId, done)
        return JSON.stringify({
          ok: saved.length > 0,
          saved: saved.length,
          items: done.map((one) => ({
            name: one.name,
            localPath: one.localPath ?? '',
            state: one?.download?.state ?? '',
            detail: one?.download?.detail ?? '',
          })),
        }, null, 2)
      }
      return JSON.stringify({ ok: false, detail: 'action 只能是 list / policy / setPolicy / sweep / fetch' }, null, 2)
    },
  }), 'push-hub: files tool')
}
