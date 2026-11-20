/**
 * lib/receiver.js — 入站接收引擎（v0.15.0 新增）。
 *
 * 为什么需要它：DSH 宿主只监听 127.0.0.1:9429，没有公网回调地址，
 * 飞书 / QQ / 微信群晖的「推送式回调」进不来。所以接收方向**不能**做 webhook，
 * 只能让本插件主动去平台拉 —— 这也是 dsh-im 的做法：
 *
 *   Telegram  getUpdates 长轮询（timeout=25s，带 offset 游标）
 *   微信       ilink/bot/getupdates 长轮询（带 get_updates_buf 游标）
 *   飞书       官方 WSClient 长连接（@larksuiteoapi/node-sdk，事件 im.message.receive_v1）
 *   QQ        官方 WebSocket 网关（@tencent-connect/qqbot-nodejs，profile 里只有 connector，暂不接）
 *   群晖 Chat  只有回调，宿主没有公网地址 → 明确不支持，不假装支持
 *
 * 收到的东西一律先落盘到 lib/inbox.js（~/.dsh/dsh-push-hub/inbox.json），
 * 界面与工具再去读。这样进程重启不会丢，也不要求接收时有人盯着界面。
 *
 * 设计取舍：
 *  - 每个账号一个循环，互不影响；一个账号挂了不许拖垮别的。
 *  - 循环失败按指数退避（2s→4s→8s…上限 60s），避免打爆平台限流。
 *  - stop() 之后所有循环在下一轮检查点退出，不会留悬挂定时器。
 *
 * @module receiver
 */

import { appendMessage } from './inbox.js'
import { getOffset, setOffset, claimOwner, readOwner } from './offsets.js'
import { requireDep } from './deps.js'
import { getJson, postJson, parseJson } from './http.js'
import { sleep } from './text.js'
import { openSocket, onSocket, eventText, closeSocket } from './ws.js'
import { summarize, fromTelegram, fromSlack, fromDiscord, fromMatrix, fromFeishu, fromQQ, fromDingtalk, fromWecomBot, fromEmail, forStore } from './attachments.js'
import { downloadAll, policyFromConfig } from './download.js'
import { load as loadConfig } from './config.js'
import * as qq from './channels/qq.js'

/** 记住已解析过的飞书 SDK，避免每次重启接收都走一遍依赖解析。 */
let cachedLark = null
let cachedLarkError = ''

/**
 * 一次 getUpdates 最长挂多久（秒）。Telegram 允许 0-50。
 *
 * v0.39.0：25 → 10。实测（409 专项实验 H）同一台机器上，窗口越长撞上
 * 另一个轮询者的概率越高：3 秒窗口 1/12 冲突、8 秒 3/12、25 秒 3/6。
 * 窗口不是我们独占的资源 —— 别人也在这个 bot 上轮询，挂得越久越容易被撞。
 * 代价是空闲时多几次空请求，换的是「撞上之后几秒内就自愈」。
 */
const TELEGRAM_POLL_TIMEOUT = 10

/** 退避上限（毫秒）。 */
const MAX_BACKOFF = 60_000

/**
 * 冲突（HTTP 409）后的重试间隔（毫秒）。v0.39.0 新增。
 *
 * 409 的含义是「同一个 botToken 上还有别的 getUpdates 在跑」，不是我们坏了。
 * 用一个独立的小退避而不是复用手上那个指数退避（2s→60s）：
 * 后者会把一次瞬时冲突放大成「半分钟到一分钟收不到消息」，
 * 而对方是个随时会退出的短命轮询者 —— 抢回来要快。
 */
const CONFLICT_BACKOFF_MS = 1500

/** 冲突后退避的上限（毫秒）。连续撞也不能退化成高频轰炸。 */
const CONFLICT_BACKOFF_MAX_MS = 6000

/** 单条入站正文最多留多少字符（防超长消息把 inbox 撑爆）。 */
const MAX_INBOUND_CHARS = 8000

/**
 * 本模块实例的唯一 id（v0.38.0）。
 *
 * 每次模块被重新求值（插件热重载）都会生成一个新的 —— 这正是我们要的：
 * 新实例抢到接收权，旧实例下一轮读盘发现 owner 换了人，自己安静退出。
 * 用随机串而不是时间戳：同一毫秒内重载两次也不能撞。
 */
const INSTANCE_ID = 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)

/** 运行态：channel -> Set<accountName> 的循环控制器。 */
const loops = new Map()

/** 每个账号最近一次的状态（给界面显示）。 */
const statusMap = new Map()

function keyOf(channel, account) {
  return String(channel) + '/' + String(account ?? '')
}

function setStatus(channel, account, patch) {
  const key = keyOf(channel, account)
  const prev = statusMap.get(key) ?? { channel, account, state: 'idle', received: 0 }
  const next = { ...prev, ...patch, updatedAt: new Date().toISOString() }
  statusMap.set(key, next)
  return next
}

/** 读全部账号的接收状态（界面用）。 */
export function receiveStatus() {
  return [...statusMap.values()].map((row) => ({ ...row }))
}

/** 某个通道当前是否正在收。 */
export function isReceiving(channel) {
  const set = loops.get(String(channel))
  return Boolean(set && set.size > 0)
}

/** 等待 ms，但可被 signal 提前打断。 */
function interruptibleSleep(ms, signal) {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

/**
 * 启动一个通道的所有账号接收循环。
 *
 * @param {string} channel
 * @param {Array<{name: string, acc: Record<string, any>}>} accounts
 * @param {{onMessage?: (row: Record<string, any>) => void}} [options]
 * @returns {{ok: boolean, started: number, detail: string}}
 */
export async function startChannel(channel, accounts, options = {}) {
  const name = String(channel ?? '').trim()
  const worker = WORKERS[name]
  if (!worker) {
    return { ok: false, started: 0, detail: '「' + name + '」没有接收实现 —— 它只有平台回调，DSH 宿主没有公网地址，收不了' }
  }
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return { ok: false, started: 0, detail: '「' + name + '」还没有账号，先加一个再开接收' }
  }

  // v0.38.0：给自己一个实例 id，并抢下接收权。
  //
  // 内存里的 set 判不了「另一个模块实例正在收」—— 插件热重载后旧循环还活着，
  // 但它看的是旧闭包里的 Map，新模块这边的 set 是空的。两个都去调 getUpdates，
  // Telegram 就回 409 并互相踢。只能靠落盘的 owner 让先启动的那个自己退出。
  //
  // v0.39.0：**要等它写完盘再往下走**。以前这里是 void 掉不等的 ——
  // 于是「抢接收权」和「第一轮轮询」在赛跑，抢慢了一步的实例会把
  // 已经拿到权的自己打断（实测：重启后头几秒里 owner 反复换手）。
  try {
    await claimOwner(INSTANCE_ID)
  } catch {
    /* 抢不到就照常跑，最坏是老行为 */
  }

  const set = loops.get(name) ?? new Set()
  loops.set(name, set)
  let started = 0
  let stopped = 0

  for (const entry of accounts) {
    const accountName = String(entry?.name ?? '')
    const key = keyOf(name, accountName)

    // v0.39.0：同一个账号已经有循环时，先把它真正停掉再起新的。
    //
    // 原来这里只判内存集合里有没有该账号，有就 skip。
    // 但循环处于 retrying 时它确实还在集合里，于是「再点一次开始接收」什么也没发生；
    // 而如果集合里那条刚从 finally 里删掉、平台上那条 getUpdates 还没结算，
    // 新循环立刻又发一条 —— Telegram 判第二个实例，回 409，两边互踢。
    // 现在改成「abort 旧的 → 等它退出 → 再起新的」，不留窗口。
    const prev = CTRLS.get(key)
    if (prev !== undefined) {
      prev.abort()
      const prevDone = LOOP_DONE.get(key)
      if (prevDone !== undefined) {
        await Promise.race([prevDone.catch(() => {}), sleep(STOP_SETTLE_MS)])
      }
      stopped += 1
    }

    const controller = new AbortController()
    CTRLS.set(key, controller)
    set.add(accountName)
    started += 1
    setStatus(name, accountName, { state: 'starting', error: null })
    const done = runLoop(name, accountName, entry?.acc ?? {}, worker, controller.signal, options)
      .catch((error) => setStatus(name, accountName, { state: 'failed', error: String(error?.message ?? error) }))
      .finally(() => {
        set.delete(accountName)
        // 只清理自己那条：起新循环时旧 promise 的 finally 可能后到，
        // 无条件删会把新循环的登记抹掉，之后 stop 就等不到它了。
        if (LOOP_DONE.get(key) === done) LOOP_DONE.delete(key)
        setStatus(name, accountName, { state: 'stopped' })
      })
    LOOP_DONE.set(key, done)
  }

  return {
    ok: true,
    started,
    stopped,
    detail: started === 0
      ? '「' + name + '」已经在收了'
      : '「' + name + '」已开始接收（' + started + ' 个账号' + (stopped > 0 ? '，先停掉 ' + stopped + ' 个旧循环' : '') + '）',
  }
}

/**
 * 停掉一个通道（或全部）的接收。
 *
 * v0.39.0：改成 async，并且**等循环真的退出**再返回。
 *
 * 原来只调 abort() 就立刻返回 —— abort 只是设个标志，循环下一轮检查点才退，
 * 而挂在线上的那条 getUpdates 更是要等超时才结束。于是「停止 → 立刻开始」
 * 会让平台同时看到两条轮询，Telegram 回 409。等它退干净，这个窗口就没了。
 * 等不到也不会永远卡住：最多 STOP_SETTLE_MS，超时就照常返回并如实说明。
 */
export async function stopChannel(channel) {
  const name = String(channel ?? '').trim()
  const targets = name === '' ? [...loops.keys()] : [name]
  let stopped = 0
  const waitFor = []
  for (const ch of targets) {
    const set = loops.get(ch)
    if (!set) continue
    for (const accountName of [...set]) {
      const key = keyOf(ch, accountName)
      const ctrl = CTRLS.get(key)
      if (ctrl) ctrl.abort()
      const done = LOOP_DONE.get(key)
      if (done !== undefined) waitFor.push(done.catch(() => {}))
      stopped += 1
    }
  }
  let drained = true
  if (waitFor.length > 0) {
    const raced = await Promise.race([
      Promise.all(waitFor).then(() => true),
      sleep(STOP_SETTLE_MS).then(() => false),
    ])
    drained = raced === true
  }
  if (name === '') statusMap.clear()
  if (stopped === 0) return { ok: true, stopped, drained, detail: '没有在跑的接收' }
  return {
    ok: true,
    stopped,
    drained,
    detail: '已停止 ' + stopped + ' 个接收循环' + (drained ? '' : '（其中有的还没退干净，等它自己收尾）'),
  }
}

/** 每个账号的 AbortController（stopChannel 要用）。 */
const CTRLS = new Map()

/**
 * 每个账号那条 runLoop 的完成 Promise（v0.39.0）。
 *
 * 光有 CTRLS 只能「请求」它停，停没停不知道。真正的退出时刻在这条 promise 上：
 * stopChannel 等它、startChannel 起新循环前也等它。键与 CTRLS 相同（通道/账号）。
 */
const LOOP_DONE = new Map()

/** 等一个循环自己收尾最多等多久（毫秒）。超时就照常返回，不把界面卡死。 */
const STOP_SETTLE_MS = 5000

// 等待用 text.js 已经导出的 sleep（不响应 abort，专门兜底），
// 与 interruptibleSleep（响应 abort，循环里用）分工不同。

/**
 * 读一次下载策略。
 *
 * 每次都重读配置而不是启动时缓存一份：用户改完「单文件上限」立刻生效，
 * 不用重启接收。配置读取本身有缓存层（config.load），代价可以忽略。
 * 读失败就回默认值 —— 附件策略不该成为收消息的前置条件。
 */
function policyOf() {
  try {
    return policyFromConfig(loadConfig() ?? {})
  } catch {
    return {}
  }
}

/** 循环主体：失败退避，成功重置退避。 */
async function runLoop(channel, accountName, acc, worker, signal, options) {
  let backoff = 2000
  // v0.39.0：冲突专用退避，与上面那个普通的互不干扰。
  let conflictBackoff = 0
  let received = 0

  // 收到一条就落盘再上报；落盘失败不算收到（宁可少记也不虚报）。
  const deliver = async (row) => {
    if (row === null || typeof row !== 'object') return
    // v0.27.0：附件。对方只发一张图时正文是空的，旧逻辑在这里 return，
    // 整条消息蒸发 —— 收件箱里一个字都没有，用户以为插件没在收。
    const attachments = Array.isArray(row.attachments) ? row.attachments : []
    const caption = String(row.text ?? '').slice(0, MAX_INBOUND_CHARS)
    if (caption.trim() === '' && attachments.length === 0) return
    // 正文 = 原话 + 附件摘要。摘要只加在缺文字时才有意义？
    // 不 —— 带文字又带图的也常有（图片 + 一句说明），两者都要留下。
    const summary = summarize(attachments)
    const text = (caption.trim() === '' ? summary : summary === '' ? caption : caption + ' ' + summary).slice(0, MAX_INBOUND_CHARS)
    const kind = row.kind === 'callback' ? 'callback' : 'message'
    // v0.36.0：先把文件真正取回来，再落盘记录。
    //
    // 顺序不能反：记录一旦写下去，这条消息就「已完成」了 —— 之后再补下载
    // 就得靠人回来点，而用户根本不会回来点。所以下载必须在 appendMessage 之前。
    //
    // 失败也绝不 return：downloadAll 内部逐条吞异常，最坏情况是所有附件都
    // 带着 download.state = failed 落盘 —— 消息本体一个字都不会少。
    const withFiles = attachments.length === 0 ? attachments : await downloadAll(attachments, acc, policyOf())
    const saved = await appendMessage({
      channel,
      account: accountName,
      from: String(row.from ?? ''),
      text,
      at: typeof row.at === 'string' ? row.at : undefined,
      kind,
      // 落盘走 forStore：它会把 handle 里的秘密（Slack 带 token 的 URL、
      // Discord 限时签名、邮件 Buffer）剥成只含 type 与 id 的安全形状，
      // 同时保留 localPath。原始 bytes 留在内存里的 withFiles 上，不写磁盘。
      attachments: forStore(withFiles),
      // v0.38.0：平台唯一键，去重就靠它。没有的平台传空串，inbox 会按老路照写。
      platformId: typeof row.platformId === 'string' ? row.platformId : '',
      raw: row.raw,
    })
    if (saved.ok) {
      // v0.38.0：重投不重复计数 —— 平台把同一条再送一遍时，收件箱没多一条，
      // received 也不该 +1，否则界面上的「已收 N 条」会虚高。
      if (saved.duplicate !== true) {
        received += 1
        setStatus(channel, accountName, { state: 'running', received, error: null })
        options.onMessage?.({ channel, account: accountName, from: row.from, text, kind, attachments })
      } else {
        setStatus(channel, accountName, { state: 'running', received, error: null })
      }
    }
  }

  // 长连接型（飞书 WSClient）：run() 自己维持连接，断了才返回，由外层退避重连。
  if (worker.mode === 'longconn') {
    while (!signal.aborted) {
      const ownerNow = await readOwner().catch(() => null)
      if (ownerNow !== null && ownerNow.id !== '' && ownerNow.id !== INSTANCE_ID) {
        setStatus(channel, accountName, { state: 'stopped', error: '已让位给新的接收实例' })
        CTRLS.delete(keyOf(channel, accountName))
        return
      }
      try {
        // v0.37.0：把「连上了」这件事单独报出来。
        //
        // 原来只有 deliver 里收到消息才 setStatus(running)，于是长连接型通道
        // 在收到第一条消息之前永远显示 starting —— 用户看不出「已经在收」和
        // 「连都没连上」的区别，只能干等。飞书实测就是这样：连接其实是通的，
        // 界面却一直停在 starting。
        //
        // 所以给 worker 一个 onReady 回调：它连上就调，状态立刻变 running。
        // 没实现 onReady 的 worker 不受影响（可选链），行为与旧版一致。
        const result = await worker.run(acc, {
          signal,
          // v0.38.0：把「这是哪个通道哪个账号」一起交给 worker ——
          // Telegram 要用它把自己唯一的 getUpdates 游标落盘（见 offsets.js）。
          channel,
          account: accountName,
          onMessage: deliver,
          onReady: () => setStatus(channel, accountName, { state: 'running', received, error: null }),
        })
        if (signal.aborted) break
        setStatus(channel, accountName, { state: 'retrying', error: String(result?.detail ?? '长连接已断开') })
      } catch (error) {
        if (signal.aborted) break
        setStatus(channel, accountName, { state: 'retrying', error: String(error?.message ?? error) })
      }
      await interruptibleSleep(backoff, signal)
      backoff = Math.min(backoff * 2, MAX_BACKOFF)
    }
    CTRLS.delete(keyOf(channel, accountName))
    return
  }

  // 循环由 signal 控制：stopChannel 调 abort()，这里下一轮检查点就退出。
  while (!signal.aborted) {
    // v0.38.0：每轮读一次盘上的接收权。发现自己已经不是持有者就主动退场 ——
    // 这是唯一能看见「另一个模块实例也在收」的通道，内存里看不见。
    const owner = await readOwner().catch(() => null)
    if (owner !== null && owner.id !== '' && owner.id !== INSTANCE_ID) {
      setStatus(channel, accountName, { state: 'stopped', error: '已让位给新的接收实例' })
      CTRLS.delete(keyOf(channel, accountName))
      return
    }
    try {
      const result = await worker.poll(acc, {
        signal,
        // 同上：轮询型也要知道自己是谁，才能读写自己的游标。
        channel,
        account: accountName,
        onMessage: deliver,
      })
      if (result?.ok === false) {
        // v0.39.0：被上层停掉。这不是失败，别设 retrying、别退避 —— 直接退场。
        // （旧实现里 abort 打不断在飞的请求，只能等它超时，于是下一轮才 break，
        //   期间状态已经先被写成 retrying，界面看着像「自己坏了」。）
        if (result.aborted === true || signal.aborted) break
        // v0.39.0：冲突（409）走独立的小退避，且**不涨**手上的普通退避。
        // 实测同机存在另一个 getUpdates 轮询者时冲突是零星的（30 次里 1 次），
        // 按普通失败退到 60 秒等于「一撞就哑火半分钟」，而对方随时会退出。
        if (result.conflict === true) {
          conflictBackoff = conflictBackoff === 0
            ? CONFLICT_BACKOFF_MS
            : Math.min(conflictBackoff * 2, CONFLICT_BACKOFF_MAX_MS)
          setStatus(channel, accountName, {
            state: 'retrying',
            error: result.detail ?? '另一个轮询者正在抢这个 botToken',
            conflicts: (statusMap.get(keyOf(channel, accountName))?.conflicts ?? 0) + 1,
          })
          await interruptibleSleep(conflictBackoff, signal)
          continue
        }
        setStatus(channel, accountName, { state: 'retrying', error: result.detail ?? '未知错误' })
        await interruptibleSleep(backoff, signal)
        backoff = Math.min(backoff * 2, MAX_BACKOFF)
        continue
      }
      // 拿到数据就说明抢回来了：两个退避都归零。
      conflictBackoff = 0
      backoff = 2000
      setStatus(channel, accountName, { state: 'running', received, error: null })
    } catch (error) {
      if (signal.aborted) break
      setStatus(channel, accountName, { state: 'retrying', error: String(error?.message ?? error) })
      await interruptibleSleep(backoff, signal)
      backoff = Math.min(backoff * 2, MAX_BACKOFF)
    }
  }
  CTRLS.delete(keyOf(channel, accountName))
}

// ── Telegram：getUpdates 长轮询 ──────────────────────────────────────────
/**
 * 应答一次按钮按下。**不发的话 Telegram 客户端会一直转圈**，用户以为没生效会反复按。
 * 失败也不抛：回调已经收到了，转圈转完最多是体验差，不该让整个循环挂掉。
 */
async function answerCallback(token, callbackId, proxy) {
  if (callbackId === '') return
  try {
    await postJson('https://api.telegram.org/bot' + token + '/answerCallbackQuery', { callback_query_id: callbackId }, {
      proxy,
      timeoutMs: 15_000,
    })
  } catch {
    /* 应答失败不影响已经记下的回调 */
  }
}

const telegramWorker = {
  async poll(acc, ctx) {
    const token = String(acc?.botToken ?? acc?.token ?? '').trim()
    if (token === '') return { ok: false, detail: '账号缺少 Bot Token' }
    const proxy = String(acc?.proxy ?? '').trim()
    // v0.38.0：offset 先看内存，内存没有就回落到落盘值。
    //
    // 原来只存在 acc.__offset 上，进程一重启就是 0 —— 而 0 在 Telegram 语义里
    // 是「请把还没确认的全部再发一遍」。于是重启一次，收件箱里就多一份历史。
    // 缺陷的根不在写入侧去重，而在这个游标没落地：平台是按规矩重投的。
    let offset = Number(acc?.__offset ?? 0)
    if (!Number.isSafeInteger(offset) || offset <= 0) {
      offset = await getOffset(ctx?.channel ?? 'telegram', ctx?.account ?? '')
      if (offset > 0) acc.__offset = offset
    }

    const url = 'https://api.telegram.org/bot' + token + '/getUpdates'
    const payload = {
      timeout: TELEGRAM_POLL_TIMEOUT,
      limit: 100,
      // callback_query 是「按钮被按下」（v0.20.0 发出去的按钮，v0.22.0 才有人听）。
      // 只订阅 message 的话，按钮按了 Telegram 会把 update 一直留着，offset 推不动。
      allowed_updates: ['message', 'callback_query'],
      ...(Number.isSafeInteger(offset) && offset > 0 ? { offset } : {}),
    }
    const { status, body } = await postJson(url, payload, {
      proxy,
      timeoutMs: (TELEGRAM_POLL_TIMEOUT + 15) * 1000,
      // v0.39.0：把上层 signal 接进来。stopChannel 的 abort 现在能真的把
      // 挂在平台上的这条长轮询掐断，而不是等它自己超时 ——
      // 否则「停止 → 立刻开始」会让两条轮询同时在平台上，Telegram 回 409。
      signal: ctx?.signal ?? null,
    })
    if (status === null) {
      // 被上层取消（停止接收 / 换新循环）：不是平台的错，也不该触发退避重试。
      // 标 aborted 让外层直接退出循环。
      if (ctx?.signal?.aborted === true) return { ok: false, aborted: true, detail: '已被停止' }
      return { ok: false, detail: '连不上 Telegram: ' + body }
    }
    const data = parseJson(body, {}) ?? {}
    if (status !== 200 || data?.ok !== true) {
      const detail = 'getUpdates 失败 HTTP ' + status + ': ' + String(data?.description ?? body).slice(0, 200)
      // v0.39.0：409 单独标出来。它的含义不是「我们坏了」，而是「同一个 botToken
      // 上还有一条 getUpdates 在跑」—— 对方多半是热重载前的旧循环，或者被代理
      // 重发出来的重复请求。这种情况用短退避抢回来，别按普通失败堆指数退避。
      if (status === 409) return { ok: false, conflict: true, detail }
      return { ok: false, detail }
    }
    for (const update of Array.isArray(data.result) ? data.result : []) {
      if (Number.isSafeInteger(update?.update_id)) offset = update.update_id + 1
      const cq = update?.callback_query
      if (cq) {
        // 先应答再记账：不应答的话 Telegram 客户端那个小转圈会一直转，
        // 用户会以为没生效而反复按，同一件事被确认 N 次。
        await answerCallback(token, String(cq?.id ?? ''), proxy)
        const data = String(cq?.data ?? '')
        if (data !== '') {
          await ctx.onMessage({
            kind: 'callback',
            from: String(cq?.message?.chat?.id ?? cq?.from?.id ?? ''),
            text: data,
            // 回调的唯一键：同一次按下的重投不该记成两条。
            platformId: String(cq?.id ?? '') === '' ? '' : 'tg-cb-' + String(cq?.id ?? ''),
            at: Number.isFinite(cq?.message?.date) ? new Date(cq.message.date * 1000).toISOString() : undefined,
            raw: {
              callbackId: String(cq?.id ?? ''),
              data,
              messageId: cq?.message?.message_id ?? null,
              userId: String(cq?.from?.id ?? ''),
              userName: String(cq?.from?.username ?? cq?.from?.first_name ?? ''),
            },
          })
        }
        continue
      }
      const msg = update?.message
      if (!msg) continue
      const text = String(msg?.text ?? msg?.caption ?? '')
      // v0.27.0：图片 / 文件 / 语音。以前这里 `if (text === '') continue`，
      // 别人发一张图给机器人 → 收件箱里什么都没有。
      const attachments = fromTelegram(msg)
      if (text.trim() === '' && attachments.length === 0) continue
      await ctx.onMessage({
        from: String(msg?.chat?.id ?? ''),
        text,
        attachments,
        at: Number.isFinite(msg?.date) ? new Date(msg.date * 1000).toISOString() : undefined,
        // update_id 是 Telegram 给每一次投递的唯一序号，重投时它不变 ——
        // 正是判重该用的键（message_id 在重投场景下也稳定，但 update_id 覆盖回调之外的全部）。
        platformId: Number.isSafeInteger(update?.update_id) ? 'tg-' + update.update_id : '',
      })
    }
    acc.__offset = offset
    // v0.38.0：把游标落盘。写失败不抛也不中断 —— 这一轮的消息已经收下了，
    // 最坏的代价只是下次重启重拉一遍（再被去重挡住），不该因此让接收循环失败。
    const persisted = await setOffset(ctx?.channel ?? 'telegram', ctx?.account ?? '', offset)
    if (persisted.ok !== true) acc.__offsetPersistError = persisted.detail
    else delete acc.__offsetPersistError
    return { ok: true }
  },
}

// ── 微信：ilink/bot/getupdates 长轮询 ────────────────────────────────────
const wechatWorker = {
  async poll(acc, ctx) {
    const token = String(acc?.token ?? '').trim()
    if (token === '') return { ok: false, detail: '账号缺少 token' }
    const base = String(acc?.baseUrl ?? 'https://ilinkai.weixin.qq.com').replace(/\/+$/, '')
    const buf = String(acc?.__buf ?? '')
    const { status, body } = await postJson(
      base + '/ilink/bot/getupdates',
      { get_updates_buf: buf, base_info: { channel_version: '2.2.0' } },
      { headers: { Authorization: 'Bearer ' + token }, timeoutMs: 40_000 },
    )
    if (status === null) return { ok: false, detail: '连不上微信服务: ' + body }
    const data = parseJson(body, {}) ?? {}
    if (Number(data?.ret ?? 0) !== 0) {
      return { ok: false, detail: 'getupdates ret=' + data.ret + ' errmsg=' + String(data?.errmsg ?? '') }
    }
    if (typeof data?.get_updates_buf === 'string' && data.get_updates_buf !== '') acc.__buf = data.get_updates_buf
    for (const msg of Array.isArray(data?.msgs) ? data.msgs : []) {
      const text = extractWechatText(msg)
      if (text === '') continue
      await ctx.onMessage({ from: String(msg?.from_user_name ?? msg?.from ?? ''), text })
    }
    return { ok: true }
  },
}

/** 从微信 iLink 消息体里挖出文本（结构随版本变，这里做保守提取）。 */
function extractWechatText(msg) {
  const direct = msg?.content ?? msg?.text
  if (typeof direct === 'string' && direct.trim() !== '') return direct
  const items = Array.isArray(msg?.item_list) ? msg.item_list : Array.isArray(msg?.items) ? msg.items : []
  for (const item of items) {
    const t = item?.text?.text ?? item?.text?.content ?? item?.content
    if (typeof t === 'string' && t.trim() !== '') return t
  }
  return ''
}

// ── 飞书：官方 WSClient 长连接（事件 im.message.receive_v1）─────────────
/**
 * 取飞书 SDK。
 *
 * v0.31.0 起走 lib/deps.js：先查插件自身的 node_modules，再回落 DSH profile。
 * 这次改动的原因写在 docs/通道说明.md 第三十二节 —— 宿主把 profile 里的这个包
 * 挪成 devDependencies 后又清空，飞书扫码与接收同时失效，本插件一行没改。
 * 取不到时返回 null + 中文原因，不抛 ERR_MODULE_NOT_FOUND。
 */
function loadLark() {
  if (cachedLark !== null) return cachedLark
  if (cachedLarkError !== '') return null
  try {
    cachedLark = requireDep('@larksuiteoapi/node-sdk')
    return cachedLark
  } catch (error) {
    cachedLarkError = String(error?.message ?? error)
    return null
  }
}

/** 飞书事件里的正文：message.content 是 JSON 字符串，text 类型取 .text。 */
function feishuTextOf(event) {
  const message = event?.message
  if (message?.message_type !== 'text') return ''
  const raw = message?.content
  if (typeof raw !== 'string' || raw === '') return ''
  const parsed = parseJson(raw, null)
  const text = parsed?.text
  return typeof text === 'string' ? text : ''
}

const feishuWorker = {
  mode: 'longconn',
  /**
   * 建立长连接并一直挂着，直到 signal 中断或 SDK 自己断开。
   * 返回值只表示「连接结束」，事件通过 onMessage 实时回调。
   */
  async run(acc, ctx) {
    const lark = loadLark()
    if (lark === null) {
      return { ok: false, detail: '飞书接收要用官方 SDK，profile 里没有 @larksuiteoapi/node-sdk：' + cachedLarkError.slice(0, 160) }
    }
    const appId = String(acc?.appId ?? '').trim()
    const appSecret = String(acc?.appSecret ?? '').trim()
    if (appId === '' || appSecret === '') return { ok: false, detail: '账号缺少 App ID 或 App Secret' }
    const isLark = String(acc?.domain ?? '').trim().toLowerCase() === 'larksuite'

    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': (event) => {
        // 群聊里没有 @ 到机器人时平台也会推过来，这里全收进收件箱，
        // 是否 @ 由正文自己判断（推送中枢是记事本，不做自动回复）。
        const text = feishuTextOf(event)
        // v0.27.0：飞书的图片 / 文件 / 语音。`feishuTextOf` 只认 message_type === 'text'，
        // 其余类型返回空串 —— 以前这里 `if (text === '') return`，附件消息整条丢。
        const attachments = fromFeishu(event)
        if (text === '' && attachments.length === 0) return undefined
        const ms = Number(event?.message?.create_time)
        void ctx.onMessage({
          from: String(event?.sender?.sender_id?.open_id ?? event?.message?.chat_id ?? ''),
          text,
          attachments,
          at: Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined,
          platformId: String(event?.message?.message_id ?? ''),
        })
        return undefined
      },
    })

    const wsClient = new lark.WSClient({
      appId,
      appSecret,
      domain: isLark ? lark.Domain.Lark : lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.warn,
      // v0.37.0：SDK 建连成功会回调 onReady（lib/index.js 里 safeInvoke('onReady')）。
      // 不接这个回调的话，本插件的接收状态只能等第一条消息才变 running ——
      // 而用户此刻最想知道的恰恰是「到底连上没有」。
      onReady: () => { try { ctx.onReady?.() } catch { /* 状态只是展示，不能因此断连 */ } },
    })

    return await new Promise((resolve) => {
      let settled = false
      const finish = (detail) => {
        if (settled) return
        settled = true
        ctx.signal.removeEventListener('abort', onAbort)
        try { wsClient.close({ force: true }) } catch { /* 关闭失败无所谓，连接已经没了 */ }
        resolve({ ok: true, detail })
      }
      const onAbort = () => finish('已停止')
      if (ctx.signal.aborted) { finish('已停止'); return }
      ctx.signal.addEventListener('abort', onAbort, { once: true })
      try {
        // start() 返回 Promise 且在连接期间不 resolve，所以不 await 它。
        void Promise.resolve(wsClient.start({ eventDispatcher: dispatcher })).catch((error) => {
          finish(String(error?.message ?? error))
        })
      } catch (error) {
        finish(String(error?.message ?? error))
      }
    })
  },
}

// ── Matrix：/sync 长轮询（只用自带的 http.js，零依赖）─────────────────
/**
 * 为什么 Matrix 不用装 SDK：它的客户端 API 就是普通 HTTP，
 * /sync?since=<batch>&timeout=25 会一直挂到有事件或超时，
 * 返回的 next_batch 就是游标 —— 和 Telegram 的 offset 一个道理。
 *
 * 只做明文房间。加密房间里的事件是 m.room.encrypted，解开需要设备密钥
 * 与房间密钥共享，那是另一套工程；这里遇到就跳过，并在状态里点出来，
 * 不假装收到。
 */
const matrixWorker = {
  async poll(acc, ctx) {
    const homeserver = String(acc?.homeserver ?? '').trim().replace(/\/+$/, '')
    const token = String(acc?.accessToken ?? '').trim()
    if (homeserver === '') return { ok: false, detail: '账号缺少 Homeserver' }
    if (token === '') return { ok: false, detail: '账号缺少 Access Token' }
    const since = String(acc?.__since ?? '')
    const query = new URLSearchParams({ timeout: '25000' })
    if (since !== '') query.set('since', since)

    const { status, body } = await getJson(
      homeserver + '/_matrix/client/v3/sync?' + query.toString(),
      { headers: { Authorization: 'Bearer ' + token }, proxy: String(acc?.proxy ?? '').trim(), timeoutMs: 40_000 },
    )
    if (status === null) return { ok: false, detail: '连不上 Matrix: ' + body }
    const data = parseJson(body, {}) ?? {}
    if (status !== 200) {
      return { ok: false, detail: 'sync 失败 HTTP ' + status + ': ' + String(data?.error ?? body).slice(0, 200) }
    }
    if (typeof data?.next_batch === 'string' && data.next_batch !== '') acc.__since = data.next_batch

    let encrypted = 0
    const rooms = data?.rooms?.join
    for (const [roomId, room] of Object.entries(rooms ?? {})) {
      const events = Array.isArray(room?.timeline?.events) ? room.timeline.events : []
      for (const event of events) {
        if (event?.type === 'm.room.encrypted') { encrypted += 1; continue }
        if (event?.type !== 'm.room.message') continue
        // v0.27.0：m.image / m.file / m.audio 的 `body` 是**文件名**不是正文，
        // 所以它永远非空 —— 以前这些消息会被当成一条只有文件名的文字消息入库。
        const contentType = String(event?.content?.msgtype ?? '')
        const attachments = fromMatrix(event?.content)
        const rawText = typeof event?.content?.body === 'string' ? event.content.body : ''
        // m.image / m.file 的 body 是文件名，不能当正文用（否则收件箱里出现一行
        // 「photo.jpg」再跟一句「[图片 photo.jpg]」，同一件事说两遍）。
        // 只有 m.text 的 body 才是人写的话。
        const text = contentType === 'm.text' || attachments.length === 0 ? rawText : ''
        if (text.trim() === '' && attachments.length === 0) continue
        await ctx.onMessage({
          from: String(roomId),
          text,
          attachments,
          at: Number.isFinite(event?.origin_server_ts) ? new Date(event.origin_server_ts).toISOString() : undefined,
          platformId: String(event?.event_id ?? ''),
        })
      }
    }
    return encrypted > 0
      ? { ok: true, detail: '跳过 ' + encrypted + ' 条加密消息（本插件不解密）' }
      : { ok: true }
  },
}

// ── Slack：Socket Mode（apps.connections.open → wss → 逐帧 ack）──────────
/**
 * Slack 有两种收法：Events API 回调（要公网地址）与 Socket Mode（本机主动连 wss）。
 * 这里只能做后者，它需要 App Token（xapp- 开头、scopes 含 connections:write），
 * 与发消息用的 Bot Token 是两把不同的钥匙。
 *
 * 协议上有一件必须做对的事：**每条带 envelope_id 的帧要立刻回 ack**，
 * 不回 Slack 会当成没送到而重投，用户就会收到重复消息。
 */
function slackTextOf(event) {
  const raw = typeof event?.text === "string" ? event.text : ""
  if (raw === "") return ""
  return raw
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/<@([A-Z0-9]+)>/g, "@$1")
    .replace(/<#(C[A-Z0-9]+)\|([^>]+)>/g, "#$2")
    .replace(/<([^>|]+)\|([^>]+)>/g, "$2")
}

const slackWorker = {
  mode: "longconn",
  async run(acc, ctx) {
    const appToken = String(acc?.appToken ?? "").trim()
    if (appToken === "") {
      return { ok: false, detail: "Socket Mode 要用 App Token（xapp- 开头，scopes 里要有 connections:write），现在没填" }
    }
    if (!appToken.startsWith("xapp-")) {
      return { ok: false, detail: "App Token 应该以 xapp- 开头；现在这把看起来是 Bot Token，发消息够用但接收不够" }
    }
    const proxy = String(acc?.proxy ?? "").trim()

    // 第一步：换一个一次性的 wss 地址。这个接口要 App Token，不是 Bot Token。
    const opened = await postForm(
      "https://slack.com/api/apps.connections.open",
      {},
      { headers: { Authorization: "Bearer " + appToken }, proxy, timeoutMs: 30_000 },
    )
    if (opened.status === null) return { ok: false, detail: "连不上 Slack: " + opened.body }
    const ticket = parseJson(opened.body, {}) ?? {}
    if (ticket?.ok !== true) {
      return { ok: false, detail: "apps.connections.open 失败: " + String(ticket?.error ?? opened.body).slice(0, 200) }
    }
    const url = String(ticket?.url ?? "")
    if (!/^wss:\/\//i.test(url)) return { ok: false, detail: "Slack 返回的不是 wss 地址：" + url.slice(0, 80) }

    const conn = openSocket(url, { proxy })
    if (!conn.ok) return { ok: false, detail: conn.detail }
    const socket = conn.socket
    // v0.37.0：Socket Mode 的握手是 wss 建连，open 事件就是「通了」。
    onSocket(socket, "open", () => { try { ctx.onReady?.() } catch { /* 只是展示 */ } })
    let ownAppId = ""

    return await new Promise((resolve) => {
      let settled = false
      const unbinds = []
      const finish = (detail) => {
        if (settled) return
        settled = true
        for (const off of unbinds) { try { off() } catch { /* 已解绑 */ } }
        try { ctx.signal.removeEventListener("abort", onAbort) } catch { /* 忽略 */ }
        closeSocket(socket, 1000, "bye")
        resolve({ ok: true, detail })
      }
      const onAbort = () => finish("已停止")
      if (ctx.signal.aborted) { finish("已停止"); return }
      ctx.signal.addEventListener("abort", onAbort, { once: true })

      unbinds.push(onSocket(socket, "message", (event) => {
        const packet = parseJson(eventText(event), null)
        // 解析不动就丢这一帧；协议里没要求回 ack，所以不影响别的消息。
        if (packet === null || typeof packet !== "object") return
        // 先 ack 再处理：慢在处理上也不会触发重投。
        if (typeof packet.envelope_id === "string" && packet.envelope_id !== "") {
          try { socket.send(JSON.stringify({ envelope_id: packet.envelope_id })) } catch { /* 连接已断 */ }
        }
        if (packet.type === "hello") {
          ownAppId = String(packet?.connection_info?.app_id ?? "")
          return
        }
        if (packet.type === "disconnect") { finish("Slack 要求重连：" + String(packet?.reason ?? "")); return }
        if (packet.type !== "events_api") return
        const payload = packet.payload
        if (payload?.type !== "event_callback") return
        // 同一个 app 可能被多个 workspace 安装，只认自己那条。
        if (ownAppId !== "" && String(payload?.api_app_id ?? "") !== ownAppId) return
        const slackEvent = payload?.event
        // Slack 的按钮按下走 interactive：type=block_actions，action 的 value 才是我们要的 callback。
        // 只在 events_api 里收（Socket Mode 下 interactive 也走这条通道）。
        if (slackEvent?.type === "block_actions") {
          const action = Array.isArray(slackEvent?.actions) ? slackEvent.actions[0] : null
          const data = String(action?.value ?? "")
          if (data !== "") {
            const seconds = Number(slackEvent?.message?.ts)
            void ctx.onMessage({
              kind: "callback",
              from: String(slackEvent?.channel?.id ?? ""),
              text: data,
              at: Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : undefined,
              // trigger_id 是一次交互的唯一键；个别事件没有它时退回 action_ts。
              platformId: String(slackEvent?.trigger_id ?? action?.action_ts ?? ""),
              raw: {
                actionId: String(action?.action_id ?? ""),
                data,
                userId: String(slackEvent?.user?.id ?? ""),
                userName: String(slackEvent?.user?.username ?? slackEvent?.user?.name ?? ""),
              },
            })
          }
          return
        }
        const message = payload?.event
        if (message?.type !== "message") return
        // 机器人自己发的、以及编辑/删除/加入频道这类系统事件都不进收件箱。
        // v0.27.0：`file_share` 必须放行 —— 它就是「这条消息带文件」的标记，
        // 挡掉它等于「Slack 发来的文件永远收不到」。其余 subtype 仍然挡。
        if (message.bot_id !== undefined) return
        if (message.subtype !== undefined && message.subtype !== 'file_share') return
        const text = slackTextOf(message)
        // v0.27.0：Slack 的文件消息 subtype 是 'file_share'，上面那条
        // `subtype !== undefined` 会把它整条挡掉 —— 别人发文件过来一条都收不到。
        // 现在单独放行 file_share，其余 subtype（编辑/删除/加入频道…）照旧挡。
        const attachments = fromSlack(message)
        if (text.trim() === "" && attachments.length === 0) return
        const seconds = Number(message.ts)
        void ctx.onMessage({
          from: String(message.channel ?? ""),
          text,
          attachments,
          at: Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : undefined,
          // Slack 的 ts 是消息唯一时间戳（同一条消息重发事件时它不变）。
          platformId: String(message.ts ?? ""),
        })
      }))
      unbinds.push(onSocket(socket, "error", (event) => {
        finish("Socket 出错：" + String(event?.message ?? "").slice(0, 160))
      }))
      unbinds.push(onSocket(socket, "close", (event) => {
        finish("连接关闭 code=" + String(event?.code ?? "?"))
      }))
    })
  },
}

// ── Discord：Gateway WebSocket（hello → identify → 心跳 → MESSAGE_CREATE）──
/**
 * Discord 的 Gateway 是长期 WebSocket，收消息要依次做对四件事：
 *   1. GET /gateway/bot 拿 wss 地址（顺带验证 token 有效）
 *   2. 收到 op:10 hello 后按 heartbeat_interval 起心跳，并立刻发 op:2 identify
 *   3. 每收到 op:11 说明上一次心跳被确认；没确认就该主动断开重连
 *   4. intents 里必须带 MESSAGE_CONTENT，否则 content 字段是空的（不是报错，是空）
 *
 * 本插件只读不写：不做 resume，断了就整条重连 —— 收件箱是记事本，丢几条不致命，
 * 而 resume 要维护 session_id 与 sequence，复杂度不值得。
 */
const DISCORD_INTENTS = (1 << 9) | (1 << 12) | (1 << 15) // GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT

/**
 * 应答一次 Discord 交互。**不回的话 3 秒后 Discord 会在客户端显示「交互失败」**，
 * 用户以为按钮坏了会反复按。type:6 是 deferred update（先确认收到，稍后可再改消息）。
 * 失败不抛：交互已经记下了。
 */
async function answerInteraction(interaction, acc) {
  const id = String(interaction?.id ?? '')
  const token = String(interaction?.token ?? '')
  if (id === '' || token === '') return
  try {
    await postJson('https://discord.com/api/v10/interactions/' + id + '/' + token + '/callback', { type: 6 }, {
      proxy: String(acc?.proxy ?? '').trim(),
      timeoutMs: 10_000,
    })
  } catch {
    /* 应答失败不影响已经记下的交互 */
  }
}

const discordWorker = {
  mode: "longconn",
  async run(acc, ctx) {
    const token = String(acc?.botToken ?? "").trim()
    if (token === "") return { ok: false, detail: "账号缺少 Bot Token" }
    const proxy = String(acc?.proxy ?? "").trim()

    const me = await getJson("https://discord.com/api/v10/gateway/bot", {
      headers: { Authorization: "Bot " + token },
      proxy,
      timeoutMs: 30_000,
    })
    if (me.status === null) return { ok: false, detail: "连不上 Discord: " + me.body }
    const info = parseJson(me.body, {}) ?? {}
    if (me.status !== 200) {
      return { ok: false, detail: "gateway/bot 失败 HTTP " + me.status + ": " + String(info?.message ?? me.body).slice(0, 200) }
    }
    const base = String(info?.url ?? "")
    if (!/^wss:\/\//i.test(base)) return { ok: false, detail: "Discord 没返回 wss 地址：" + base.slice(0, 80) }

    const conn = openSocket(base.replace(/\/+$/, "") + "/?v=10&encoding=json", { proxy })
    if (!conn.ok) return { ok: false, detail: conn.detail }
    const socket = conn.socket
    // v0.37.0：网关 wss 建连成功即视为就绪（identify 还没发，但通路已经通了）。
    onSocket(socket, "open", () => { try { ctx.onReady?.() } catch { /* 只是展示 */ } })

    return await new Promise((resolve) => {
      let settled = false
      let heartbeat = null
      let acked = true
      let sequence = null
      const unbinds = []
      const stopTimer = () => { if (heartbeat !== null) { clearInterval(heartbeat); heartbeat = null } }
      const finish = (detail) => {
        if (settled) return
        settled = true
        stopTimer()
        for (const off of unbinds) { try { off() } catch { /* 已解绑 */ } }
        try { ctx.signal.removeEventListener("abort", onAbort) } catch { /* 忽略 */ }
        closeSocket(socket, 1000, "bye")
        resolve({ ok: true, detail })
      }
      const onAbort = () => finish("已停止")
      const send = (payload) => { try { socket.send(JSON.stringify(payload)) } catch { /* 连接已断 */ } }
      const beat = () => {
        if (!acked) { finish("心跳没被确认，主动断开重连"); return }
        acked = false
        send({ op: 1, d: sequence })
      }
      if (ctx.signal.aborted) { finish("已停止"); return }
      ctx.signal.addEventListener("abort", onAbort, { once: true })

      unbinds.push(onSocket(socket, "message", (event) => {
        const packet = parseJson(eventText(event), null)
        if (packet === null || typeof packet !== "object") return
        if (Number.isFinite(packet.s)) sequence = packet.s
        if (packet.op === 10) {
          const interval = Number(packet?.d?.heartbeat_interval)
          if (!Number.isFinite(interval) || interval <= 0) { finish("hello 里的 heartbeat_interval 不合法"); return }
          stopTimer()
          heartbeat = setInterval(beat, interval)
          heartbeat.unref?.()
          send({
            op: 2,
            d: {
              token,
              intents: DISCORD_INTENTS,
              properties: { os: process.platform, browser: "dsh-push-hub", device: "dsh-push-hub" },
            },
          })
          return
        }
        if (packet.op === 11) { acked = true; return }
        if (packet.op === 1) { beat(); return }
        if (packet.op === 7) { finish("Discord 要求重连"); return }
        if (packet.op === 9) { finish("session 无效，需要重新 identify"); return }
        if (packet.op !== 0) return
        // Discord 的按钮按下是 INTERACTION_CREATE，type=3 是 MESSAGE_COMPONENT。
        // **必须在 3 秒内回 HTTP 应答（type:6 deferred update），否则 Discord 会显示「交互失败」。**
        if (packet.t === "INTERACTION_CREATE") {
          const d = packet.d
          if (Number(d?.type) !== 3) return
          void answerInteraction(d, acc)
          const data = String(d?.data?.custom_id ?? "")
          if (data !== "") {
            void ctx.onMessage({
              kind: "callback",
              from: String(d?.channel_id ?? ""),
              text: data,
              at: new Date().toISOString(),
              platformId: String(d?.id ?? ""),
              raw: {
                interactionId: String(d?.id ?? ""),
                data,
                componentType: Number(d?.data?.component_type ?? 0),
                userId: String(d?.member?.user?.id ?? d?.user?.id ?? ""),
                userName: String(d?.member?.user?.username ?? d?.user?.username ?? ""),
              },
            })
          }
          return
        }
        if (packet.t === "MESSAGE_CREATE") {
          const message = packet.d
          // 机器人（包括自己）发的消息不进收件箱，否则自己推送的内容会被收回来。
          if (message?.author?.bot === true) return
          const text = typeof message?.content === "string" ? message.content : ""
          // v0.27.0：attachments。Discord 的附件是独立数组，
          // 只发文件不带一句话时 content 是空串 —— 以前这里直接 return。
          const attachments = fromDiscord(message)
          if (text.trim() === "" && attachments.length === 0) return
          const ms = Date.parse(String(message?.timestamp ?? ""))
          void ctx.onMessage({
            from: String(message?.channel_id ?? ""),
            text,
            attachments,
            at: Number.isFinite(ms) ? new Date(ms).toISOString() : undefined,
            platformId: String(message?.id ?? ""),
          })
        }
      }))
      unbinds.push(onSocket(socket, "error", (event) => {
        finish("Socket 出错：" + String(event?.message ?? "").slice(0, 160))
      }))
      unbinds.push(onSocket(socket, "close", (event) => {
        finish("连接关闭 code=" + String(event?.code ?? "?"))
      }))
    })
  },
}

// ── QQ：官方 WebSocket 网关（hello → identify → 心跳 → GROUP_AT_MESSAGE_CREATE）──
/**
 * QQ 官方机器人没有「拉取」接口，只有 WebSocket 推送网关 —— 但**连接是本机发起的**，
 * 所以不需要公网回调地址，与飞书 / Slack / Discord 同一类。
 *
 * 四件事必须做对：
 *   1. GET https://api.sgroup.qq.com/gateway 拿 wss 地址（Authorization: QQBot <token>）
 *   2. 收到 op:10 hello 后按 heartbeat_interval 起心跳，并立刻发 op:2 identify
 *      注意 identify 的 d.token 要写成 "QQBot <accessToken>"（带前缀），不是裸 token
 *   3. intents 必须含 GROUP_AND_C2C_EVENT(1<<25)，否则群里 @ 机器人的消息收不到；
 *      频道（guild）消息是另一套 intents，本插件不发频道消息，故不订阅
 *   4. 每收到 op:11 说明上一次心跳被确认；没确认就该主动断开重连
 *
 * 去重：官方文档明确「相同 msg_id 可能重复推送」，本插件收件箱只做记事本，
 * 不做 msg_seq 去重 —— 宁可重复也不漏，重复与否由下游按 id 自行判断。
 */
const QQ_INTENTS = 1 << 25 // GROUP_AND_C2C_EVENT

/** RFC3339 → ISO；拿不准就用 undefined（inbox 会自己填当前时间）。 */
function qqTime(value) {
  const ms = Date.parse(String(value ?? ""))
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

const qqWorker = {
  mode: "longconn",
  async run(acc, ctx) {
    const appId = String(acc?.appId ?? acc?.app_id ?? "").trim()
    const secret = String(acc?.appSecret ?? acc?.clientSecret ?? acc?.secret ?? "").trim()
    if (appId === "" || secret === "") return { ok: false, detail: "账号缺少 appId / clientSecret" }
    const proxy = String(acc?.proxy ?? "").trim()

    // 复用发消息那条链路的 token 获取，避免两处逻辑漂移。
    const got = await qq.appToken(acc, proxy)
    if (got.ok !== true) return { ok: false, detail: got.detail }
    const authToken = "QQBot " + got.token

    const gw = await getJson("https://api.sgroup.qq.com/gateway", {
      headers: { Authorization: authToken },
      proxy,
      timeoutMs: 30_000,
    })
    if (gw.status === null) return { ok: false, detail: "连不上 QQ 网关: " + gw.body }
    const info = parseJson(gw.body, {}) ?? {}
    if (gw.status !== 200) {
      return { ok: false, detail: "取网关地址失败 HTTP " + gw.status + ": " + String(info?.message ?? gw.body).slice(0, 200) }
    }
    const base = String(info?.url ?? "")
    if (!/^wss:\/\//i.test(base)) return { ok: false, detail: "QQ 没返回 wss 地址：" + base.slice(0, 80) }

    const conn = openSocket(base, { proxy })
    if (!conn.ok) return { ok: false, detail: conn.detail }
    const socket = conn.socket
    // v0.37.0：QQ 网关同样是 wss，open 即通路就绪。
    onSocket(socket, "open", () => { try { ctx.onReady?.() } catch { /* 只是展示 */ } })

    return await new Promise((resolve) => {
      let settled = false
      let heartbeat = null
      let acked = true
      let sequence = null
      const unbinds = []
      const stopTimer = () => { if (heartbeat !== null) { clearInterval(heartbeat); heartbeat = null } }
      const finish = (detail) => {
        if (settled) return
        settled = true
        stopTimer()
        for (const off of unbinds) { try { off() } catch { /* 已解绑 */ } }
        try { ctx.signal.removeEventListener("abort", onAbort) } catch { /* 忽略 */ }
        closeSocket(socket, 1000, "bye")
        resolve({ ok: true, detail })
      }
      const onAbort = () => finish("已停止")
      const send = (payload) => { try { socket.send(JSON.stringify(payload)) } catch { /* 连接已断 */ } }
      const beat = () => {
        if (!acked) { finish("心跳没被确认，主动断开重连"); return }
        acked = false
        send({ op: 1, d: sequence })
      }
      if (ctx.signal.aborted) { finish("已停止"); return }
      ctx.signal.addEventListener("abort", onAbort, { once: true })

      unbinds.push(onSocket(socket, "message", (event) => {
        const packet = parseJson(eventText(event), null)
        if (packet === null || typeof packet !== "object") return
        if (Number.isFinite(packet.s)) sequence = packet.s
        if (packet.op === 10) {
          const interval = Number(packet?.d?.heartbeat_interval)
          if (!Number.isFinite(interval) || interval <= 0) { finish("hello 里的 heartbeat_interval 不合法"); return }
          stopTimer()
          heartbeat = setInterval(beat, interval)
          heartbeat.unref?.()
          send({
            op: 2,
            d: {
              token: authToken,
              intents: QQ_INTENTS,
              shard: [0, 1],
              properties: { os: process.platform, browser: "dsh-push-hub", device: "dsh-push-hub" },
            },
          })
          return
        }
        if (packet.op === 11) { acked = true; return }
        if (packet.op === 1) { beat(); return }
        if (packet.op === 7) { finish("QQ 要求重连"); return }
        if (packet.op === 9) { finish("session 无效，需要重新 identify"); return }
        if (packet.op !== 0) return
        if (packet.t === "GROUP_AT_MESSAGE_CREATE") {
          const d = packet.d ?? {}
          const text = typeof d.content === "string" ? d.content : ""
          // v0.27.0：QQ 的图片/文件在 d.attachments 里，只发图时 content 是空串。
          const attachments = fromQQ(d)
          if (text.trim() === "" && attachments.length === 0) return
          // 群消息的 from 用 group_openid：用户要看的是「哪个群发来的」，不是谁发的。
          void ctx.onMessage({ from: String(d.group_openid ?? ""), text, attachments, at: qqTime(d.timestamp), platformId: String(d?.id ?? "") })
          return
        }
        if (packet.t === "C2C_MESSAGE_CREATE") {
          const d = packet.d ?? {}
          const text = typeof d.content === "string" ? d.content : ""
          const attachments = fromQQ(d)
          if (text.trim() === "" && attachments.length === 0) return
          // 单聊没有群，from 用发送者 openid。
          void ctx.onMessage({
            from: String(d?.author?.user_openid ?? d?.author?.id ?? ""),
            text,
            attachments,
            at: qqTime(d.timestamp),
            platformId: String(d?.id ?? ""),
          })
        }
      }))
      unbinds.push(onSocket(socket, "error", (event) => {
        finish("Socket 出错：" + String(event?.message ?? "").slice(0, 160))
      }))
      unbinds.push(onSocket(socket, "close", (event) => {
        finish("连接关闭 code=" + String(event?.code ?? "?"))
      }))
    })
  },
}
/**
 * 邮件接收（v0.23.0）：IMAP 拉最近未读。
 *
 * 为什么不是 IMAP IDLE 长连接：IDLE 要在同一条连接上等服务器推，
 * 断线重连、NOOP 保活、读信时不能并发取信这些细节都要自己兜。
 * 这里用「每次 poll 开一条连接 → 查 UID 大于游标的信 → 关掉」，
 * 简单、失败可重试，代价是每 30 秒一次短连接（多数邮箱都能接受）。
 *
 * 游标存 acc.__imapUid（进程内），不落盘 —— 重启后从头取最近 N 封，
 * 收件箱有 MAX_KEEP 上限，重复几条不会撑爆，也不会漏掉新信。
 */
const EMAIL_POLL_MS = 30_000
const EMAIL_BATCH = 20

let cachedImap = null
let cachedImapError = ''
let cachedMailParser = null
let cachedMailParserError = ''

/**
 * 取一个第三方依赖（同步，取不到就抛 —— 外面已有 try/catch 记原因）。
 *
 * 名字保留 requireFromProfile 是为了不动下面 5 个 loader 的调用点；
 * 但它现在**不再只查 profile**，实现见 lib/deps.js。
 */
function requireFromProfile(name) {
  return requireDep(name)
}

/** 从 profile 取 imapflow；取不到返回 null 并把原因记下来（不抛）。 */
function loadImap() {
  if (cachedImap !== null) return cachedImap
  if (cachedImapError !== '') return null
  try {
    const mod = requireFromProfile('imapflow')
    cachedImap = mod?.ImapFlow ?? mod?.default?.ImapFlow ?? null
    return cachedImap
  } catch (error) {
    cachedImapError = String(error?.message ?? error)
    return null
  }
}

/** 从 profile 取 mailparser；取不到返回 null。 */
function loadMailParser() {
  if (cachedMailParser !== null) return cachedMailParser
  if (cachedMailParserError !== '') return null
  try {
    const mod = requireFromProfile('mailparser')
    cachedMailParser = mod?.simpleParser ?? mod?.default?.simpleParser ?? null
    return cachedMailParser
  } catch (error) {
    cachedMailParserError = String(error?.message ?? error)
    return null
  }
}

/** 把一封原始邮件转成一句可读正文：优先纯文本，退回 HTML 去标签。 */
function emailTextOf(parsed) {
  const plain = typeof parsed?.text === 'string' ? parsed.text.trim() : ''
  if (plain !== '') return plain
  const html = typeof parsed?.html === 'string' ? parsed.html : ''
  if (html === '') return ''
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

const emailWorker = {
  async poll(acc, ctx) {
    const ImapFlow = loadImap()
    if (ImapFlow === null) {
      return { ok: false, detail: '邮件接收要用 imapflow，profile 里没有：' + cachedImapError.slice(0, 160) }
    }
    const simpleParser = loadMailParser()
    if (simpleParser === null) {
      return { ok: false, detail: '邮件接收要用 mailparser 解析正文，profile 里没有：' + cachedMailParserError.slice(0, 160) }
    }
    const host = String(acc?.imapHost ?? '').trim()
    const user = String(acc?.user ?? acc?.username ?? acc?.from ?? '').trim()
    const pass = String(acc?.pass ?? acc?.password ?? acc?.smtpPassword ?? '')
    if (host === '') return { ok: false, detail: '邮件接收要填 IMAP 服务器（例 imap.qq.com），发信的 SMTP 地址不能拿来收信' }
    if (user === '' || pass === '') return { ok: false, detail: '邮件接收要用登录账号与授权码（与发信是同一套）' }
    const port = Number(acc?.imapPort) > 0 ? Math.floor(Number(acc.imapPort)) : 993

    const client = new ImapFlow({
      host,
      port,
      secure: port !== 143,
      auth: { user, pass },
      logger: false,
      // 自建 IMAP 用自签证书时，与发信那边同一个开关。
      ...(acc?.allowSelfSigned === true ? { tls: { rejectUnauthorized: false } } : {}),
    })

    const since = Number(acc?.__imapUid) > 0 ? Number(acc.__imapUid) : 0
    let highest = since
    let fetched = 0
    try {
      await client.connect()
      const lock = await client.getMailboxLock('INBOX')
      try {
        // 先问「有哪些信」再逐封取，而不是边取边数。
        // 边取边数的话，20 封的批量上限一 break，剩下的未读就永远被跳过 ——
        // 游标已经推到第 20 封，下一轮只查 uid > 游标，前面那些漏掉的信再也回不来。
        //
        //  没有游标：只查未读，取**最新**的 20 封（不是最老的 20 封 ——
        //            第一次接入时用户想看的显然是刚收到的，不是三年前的）。
        //  有游标：  查 uid > 游标，取最老的 20 封（顺着时间往前推，不跳号）。
        const uidList = since > 0
          ? await client.search({ uid: String(since + 1) + ':*' }, { uid: true })
          : await client.search({ seen: false }, { uid: true })
        const picked = (since > 0 ? uidList : uidList.slice(-EMAIL_BATCH)).slice(0, EMAIL_BATCH)
        for (const uid of picked) {
          const target = Number(uid)
          if (!Number.isFinite(target) || target <= since) continue
          if (target > highest) highest = target
          const msg = await client.fetchOne(String(target), { uid: true, source: true }, { uid: true })
          if (!msg?.source) continue
          let parsed = null
          try {
            parsed = await simpleParser(msg.source)
          } catch {
            continue
          }
          const text = emailTextOf(parsed)
          // v0.27.0：邮件附件。只发附件不写字时正文是空的，旧逻辑在这里 continue，
          // 整封信不进收件箱 —— 而「发了个附件」恰恰是最该知道的事。
          const attachments = fromEmail(parsed)
          if (text === '' && attachments.length === 0) continue
          fetched += 1
          const fromAddr = String(parsed?.from?.value?.[0]?.address ?? parsed?.from?.text ?? '')
          const subject = String(parsed?.subject ?? '').trim()
          void ctx.onMessage({
            from: fromAddr === '' ? host : fromAddr,
            // 主题带上，否则收件箱里一堆没有上下文的正文。
            text: subject === '' ? text : '【' + subject + '】' + text,
            attachments,
            at: parsed?.date instanceof Date && !Number.isNaN(parsed.date.getTime()) ? parsed.date.toISOString() : undefined,
            // Message-ID 是邮件在协议层就带的唯一标识，重投时不变。
            platformId: String(parsed?.messageId ?? ''),
          })
        }
      } finally {
        lock.release()
      }
      await client.logout()
    } catch (error) {
      try {
        await client.close()
      } catch {
        /* 连接可能压根没建起来 */
      }
      return { ok: false, detail: 'IMAP 取信失败：' + String(error?.message ?? error).slice(0, 200) }
    }

    acc.__imapUid = highest
    if (fetched > 0) {
      // 这一轮已经取到东西，立刻再来一轮（可能还有下一批）；否则等 30 秒。
      return { ok: true, detail: '取到 ' + fetched + ' 封' }
    }
    await interruptibleSleep(EMAIL_POLL_MS, ctx.signal)
    return { ok: true }
  },
}

// ── 钉钉（企业内部应用 + Stream 模式）─────────────────────────────
// 群机器人（webhookUrl + 加签 secret）只能发不能收；要收必须建「企业内部应用」，
// 拿 AppKey/AppSecret 走 Stream 模式长连接。两者是两套完全不同的凭据，不能混用。
let cachedDingtalk = null
let cachedDingtalkError = ''

function loadDingtalk() {
  if (cachedDingtalk !== null) return cachedDingtalk
  if (cachedDingtalkError !== '') return null
  try {
    const mod = requireFromProfile('dingtalk-stream')
    if (!mod || typeof mod.DWClient !== 'function') {
      cachedDingtalkError = '包里没有 DWClient'
      return null
    }
    cachedDingtalk = mod
    return mod
  } catch (error) {
    cachedDingtalkError = String(error?.message ?? error).slice(0, 200)
    return null
  }
}

function dingtalkTextOf(message) {
  if (!message || typeof message !== 'object') return ''
  const type = String(message.msgtype ?? '').toLowerCase()
  if (type !== 'text') return ''
  const text = message?.text?.content
  return typeof text === 'string' ? text.trim() : ''
}

const dingtalkWorker = {
  mode: 'longconn',
  async run(acc, ctx) {
    const lark = null // 占位，避免与飞书的命名冲突
    const clientId = String(acc?.clientId ?? acc?.appKey ?? '').trim()
    const clientSecret = String(acc?.clientSecret ?? acc?.appSecret ?? '').trim()
    if (clientId === '' || clientSecret === '') {
      return { ok: false, detail: '钉钉接收要建「企业内部应用」拿 AppKey 与 AppSecret（群机器人的 webhook 只能发不能收），现在没填' }
    }
    const mod = loadDingtalk()
    if (mod === null) {
      return { ok: false, detail: '钉钉接收要用 dingtalk-stream，profile 里没有：' + cachedDingtalkError.slice(0, 160) }
    }
    const { DWClient, TOPIC_ROBOT } = mod
    const proxy = String(acc?.proxy ?? '').trim()
    let client
    try {
      client = new DWClient({
        clientId,
        clientSecret,
        endpoint: 'https://api.dingtalk.com',
        autoReconnect: false,
        keepAlive: true,
        debug: false,
      })
    } catch (error) {
      return { ok: false, detail: '钉钉 Stream 客户端建不起来：' + String(error?.message ?? error).slice(0, 200) }
    }
    if (typeof client.registerCallbackListener !== 'function' || typeof client.connect !== 'function') {
      return { ok: false, detail: '钉钉 Stream 客户端缺 registerCallbackListener / connect，版本不对' }
    }
    const topic = TOPIC_ROBOT ?? '/v1.0/im/bot/messages/get'
    return new Promise((resolve) => {
      let done = false
      const finish = (detail) => {
        if (done) return
        done = true
        try { client.disconnect() } catch { /* 可能压根没连上 */ }
        resolve({ ok: true, detail: detail ?? '已停止' })
      }
      ctx.signal.addEventListener('abort', () => finish(), { once: true })
      client.registerCallbackListener(topic, (response) => {
        const messageId = response?.headers?.messageId
        // 先应答再处理：不应答钉钉会重投同一条消息。
        if (messageId) {
          try { client.socketCallBackResponse(messageId, { success: true }) } catch { /* 应答失败不影响记账 */ }
        }
        let message = response?.data
        if (typeof message === 'string') {
          try { message = JSON.parse(message) } catch { return }
        }
        if (!message || typeof message !== 'object') return
        const text = dingtalkTextOf(message)
        // v0.27.0：picture / file / audio。dingtalkTextOf 只认 msgtype === 'text'，
        // 其余返回空串 —— 以前这里 `if (text === '') return`，附件消息整条丢。
        const attachments = fromDingtalk(message)
        if (text === '' && attachments.length === 0) return
        const from = String(message.senderStaffId ?? message.senderId ?? message.conversationId ?? 'unknown')
        const at = typeof message.createAt === 'number' ? new Date(message.createAt).toISOString() : undefined
        void ctx.onMessage({ from, text, attachments, at, platformId: String(messageId ?? ''), raw: { messageId, conversationType: message.conversationType, senderNick: message.senderNick } })
      })
      // v0.37.0：DWClient.connect() 内部是 getEndpoint() 再 _connect()，
      // resolve 就代表 socket 已经 open 了 —— 这里报就绪是准的，不是猜的。
      void Promise.resolve(client.connect())
        .then(() => { try { ctx.onReady?.() } catch { /* 只是展示 */ } })
        .catch((error) => {
          finish('钉钉 Stream 连不上：' + String(error?.message ?? error).slice(0, 200))
        })
    })
  },
}

// ── 企业微信自建应用（智能机器人 WebSocket）───────────────────────
// 自建应用发消息走 corpId + corpSecret + agentId；收消息要用「智能机器人」的 botId + secret。
// 两者同属一个企业，但是两套凭据 —— 只发不填 botId 也能用。
let cachedWecomBot = null
let cachedWecomBotError = ''

function loadWecomBot() {
  if (cachedWecomBot !== null) return cachedWecomBot
  if (cachedWecomBotError !== '') return null
  try {
    const mod = requireFromProfile('@wecom/aibot-node-sdk')
    if (!mod || typeof mod.WSClient !== 'function') {
      cachedWecomBotError = '包里没有 WSClient'
      return null
    }
    cachedWecomBot = mod
    return mod
  } catch (error) {
    cachedWecomBotError = String(error?.message ?? error).slice(0, 200)
    return null
  }
}

function wecomBotTextOf(frame) {
  const body = frame?.body && typeof frame.body === 'object' ? frame.body : {}
  if (body.msgtype === 'text') {
    const text = body?.text?.content
    return typeof text === 'string' ? text.trim() : ''
  }
  if (body.msgtype === 'voice') {
    const text = body?.voice?.content
    return typeof text === 'string' ? text.trim() : ''
  }
  return ''
}

function wecomBotFromOf(frame) {
  const body = frame?.body && typeof frame.body === 'object' ? frame.body : {}
  if (body.chattype === 'group') return String(body.chatid ?? 'unknown')
  return String(body?.from?.userid ?? body?.from?.name ?? 'unknown')
}

const wecomAppWorker = {
  mode: 'longconn',
  async run(acc, ctx) {
    const botId = String(acc?.botId ?? acc?.remoteBotId ?? '').trim()
    const secret = String(acc?.botSecret ?? '').trim()
    if (botId === '' || secret === '') {
      return { ok: false, detail: '企业微信接收要用「智能机器人」的 BotId 与 Secret（自建应用的 corpId/corpSecret 只能发不能收），现在没填' }
    }
    const mod = loadWecomBot()
    if (mod === null) {
      return { ok: false, detail: '企业微信接收要用 @wecom/aibot-node-sdk，profile 里没有：' + cachedWecomBotError.slice(0, 160) }
    }
    const { WSClient } = mod
    const quiet = { debug() {}, info() {}, warn() {}, error() {} }
    let client
    try {
      client = new WSClient({ botId, secret, logger: quiet, maxReconnectAttempts: 10 })
    } catch (error) {
      return { ok: false, detail: '企业微信 WS 客户端建不起来：' + String(error?.message ?? error).slice(0, 200) }
    }
    if (typeof client.connect !== 'function' || typeof client.on !== 'function') {
      return { ok: false, detail: '企业微信 WS 客户端缺 connect / on，版本不对' }
    }
    return new Promise((resolve) => {
      let done = false
      const finish = (detail) => {
        if (done) return
        done = true
        try { client.disconnect() } catch { /* 可能压根没连上 */ }
        resolve({ ok: true, detail: detail ?? '已停止' })
      }
      ctx.signal.addEventListener('abort', () => finish(), { once: true })
      client.on('message', (frame) => {
        const text = wecomBotTextOf(frame)
        // v0.27.0：智能机器人只推 text / voice / mixed，文件与图片要另走 media 下载，
        // 这条链路拿不到。mixed（图文混排）里的图能记个名。
        const attachments = fromWecomBot(frame?.body)
        if (text === '' && attachments.length === 0) return
        const from = wecomBotFromOf(frame)
        const at = typeof frame?.body?.create_time === 'number' ? new Date(frame.body.create_time).toISOString() : undefined
        void ctx.onMessage({ from, text, attachments, at, platformId: String(frame?.body?.msgid ?? ''), raw: { msgtype: frame?.body?.msgtype, msgid: frame?.body?.msgid } })
      })
      // v0.37.0：SDK 在 WebSocket 建连成功时 emit('connected')，认证成功另有
      // 'authenticated'。这里用前者 —— 用户问的是「连上没有」，不是「认证过了没」。
      try { client.on('connected', () => { try { ctx.onReady?.() } catch { /* 只是展示 */ } }) } catch { /* 老版本没有 on */ }
      void Promise.resolve(client.connect()).catch((error) => {
        finish('企业微信 WS 连不上：' + String(error?.message ?? error).slice(0, 200))
      })
    })
  },
}
/** 通道 → worker。没有列进来的就是「只有回调，收不了」。 */
const WORKERS = {
  telegram: telegramWorker,
  wechat: wechatWorker,
  feishu: feishuWorker,
  matrix: matrixWorker,
  slack: slackWorker,
  discord: discordWorker,
  qq: qqWorker,
  email: emailWorker,
  dingtalk: dingtalkWorker,
  wecom_app: wecomAppWorker,
}

/** 哪些通道能被接收（界面据此决定显不显示「开始接收」）。 */
export const RECEIVABLE = Object.freeze(Object.keys(WORKERS))

/** 各通道不能接收的原因（说明白，不假装支持）。 */
export const NOT_RECEIVABLE_REASON = Object.freeze({
  synology_chat: '群晖 Chat 只有「传出 URL」回调，DSH 宿主只监听 127.0.0.1:9429，NAS 连不进来',
  wecom: '企业微信群机器人是纯发送 webhook，没有读取接口（要收得改用自建应用的智能机器人，那是另一套凭据）',
})

/** 测试钩子：只给 scaffold 探针用，不对外承诺稳定性。 */
export const __test = {
  feishuTextOf, slackTextOf, emailTextOf, dingtalkTextOf, wecomBotTextOf, wecomBotFromOf,
  loadLark, loadImap, loadMailParser, loadDingtalk, loadWecomBot, WORKERS,
  // v0.27.0：附件解析，供 scaffold/probe_attachments.mjs 逐家验形状。
  attachments: { summarize, fromTelegram, fromSlack, fromDiscord, fromMatrix, fromFeishu, fromQQ, fromDingtalk, fromWecomBot, fromEmail },
}

/** 读一个通道为什么收不了（能收的返回空串）。 */
export function receiveBlocker(channel) {
  const name = String(channel ?? '').trim()
  if (RECEIVABLE.includes(name)) return ''
  return NOT_RECEIVABLE_REASON[name] ?? '「' + name + '」没有接收实现'
}
