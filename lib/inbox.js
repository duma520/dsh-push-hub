/**
 * lib/inbox.js — 收件箱（入站消息的落地存储）。
 *
 * 为什么要有它：v0.15.0 起 push-hub 开始「收」消息（Telegram / 飞书 / 微信长轮询与长连接），
 * 而 DSH 宿主只监听 127.0.0.1:9429，外部平台的推送进不来。收下来的消息必须先落盘，
 * 再由界面或工具读取 —— 否则进程一重启就全丢。
 *
 * 存放位置：~/.dsh/dsh-push-hub/inbox.json（与 config.json 同目录，便于一起备份/清理）。
 * 结构：
 *   {
 *     "version": 1,
 *     "updatedAt": "2026-11-17T06:00:00.000Z",
 *     "messages": [ { id, channel, account, at, from, text, kind?, raw? }, ... ]   // 新的在最后
 *
 * kind：'message'（默认，普通文字消息）或 'callback'（按钮被按下，v0.22.0 新增）。
 * 按钮回调不是「一条文字消息」，混成一种会让收件箱里看不出哪些是需要回应的。
 *   }
 *
 * 保留策略：只留最近 MAX_KEEP 条（默认 500），避免长跑之后文件无限膨胀。
 * 所有写入走「读-改-写 + 原子替换」，进程被杀不会留下半截 JSON。
 *
 * @module inbox
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

/** 最多保留多少条。超出后丢最旧的。 */
export const MAX_KEEP = 500

/** 收件箱文件位置（与 config.json 同一目录）。 */
export const INBOX_PATH = path.join(os.homedir(), '.dsh', 'dsh-push-hub', 'inbox.json')

/** 空收件箱的初始结构。 */
function emptyInbox() {
  return { version: 1, updatedAt: new Date().toISOString(), messages: [] }
}

/**
 * 读收件箱。文件不存在 / 损坏 / 结构不对时返回空收件箱，**永不抛**。
 * 收件箱是日志性质的东西，读坏了不该让整个插件崩。
 */
export async function readInbox(filePath = INBOX_PATH) {
  let text = ''
  try {
    text = await readFile(filePath, 'utf8')
  } catch {
    return emptyInbox()
  }
  let data = null
  try {
    data = JSON.parse(text)
  } catch {
    return emptyInbox()
  }
  if (data === null || typeof data !== 'object') return emptyInbox()
  const messages = Array.isArray(data.messages) ? data.messages.filter((item) => item !== null && typeof item === 'object') : []
  return {
    version: Number.isSafeInteger(data.version) ? data.version : 1,
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : new Date().toISOString(),
    messages,
  }
}

/**
 * 追加一条入站消息。
 *
 * v0.38.0：新增 platformId 去重。
 *
 * 为什么必须有：id 的后缀是 Math.random()，同一条平台消息被重投时必然生成两个不同的 id，
 * 于是收件箱里出现两条一模一样的记录（实测：Telegram 进程重启后 offset 回到 0，
 * 平台把未确认的历史再投一遍，用户看到「同一条消息收了两遍」）。
 *
 * 判重键是 `channel + account + platformId`，不是 `text`：同一个人连发两条「你好」，
 * 那是两条真消息，必须都留下。只有平台自己给的唯一键（Telegram 的 update_id、
 * 飞书的 message_id、Discord 的 message.id…）才能区分「重投」与「重发」。
 *
 * 没有 platformId 的平台（微信 iLink 不给稳定 id）照旧按老路写入 —— 宁可偶发重复，
 * 也不要把两条真消息并成一条。
 *
 * @param {{channel: string, account?: string, from?: string, text: string, at?: string, kind?: string, platformId?: string, attachments?: Array<object>, raw?: unknown}} message
 * @param {string} [filePath]
 * @returns {Promise<{ok: boolean, kept: number, total: number, duplicate?: boolean, detail?: string}>}
 */
export async function appendMessage(message, filePath = INBOX_PATH) {
  const text = String(message?.text ?? '')
  const channel = String(message?.channel ?? '').trim()
  if (channel === '') return { ok: false, kept: 0, total: 0, detail: '入站消息缺少 channel' }
  // v0.27.0：带附件的消息正文可能是空的（对方只发了一张图）。
  // 只看 text 会把这种消息整条丢掉 —— 收件箱里一个字都没有，用户以为插件坏了。
  const attachments = Array.isArray(message?.attachments)
    ? message.attachments.filter((item) => item !== null && typeof item === 'object').slice(0, 10)
    : []
  if (text.trim() === '' && attachments.length === 0) {
    return { ok: false, kept: 0, total: 0, detail: '入站消息正文为空' }
  }

  const data = await readInbox(filePath)
  const at = typeof message?.at === 'string' && message.at !== '' ? message.at : new Date().toISOString()
  const account = String(message?.account ?? '')
  const platformId = typeof message?.platformId === 'string' ? message.platformId.trim() : ''

  // v0.38.0：同一平台消息重投时不写第二条。命中就直接返回 duplicate:true ——
  // 调用方据此知道「东西已经在收件箱里了」，不必当失败处理。
  if (platformId !== '') {
    const sameMsg = (item) => String(item?.channel ?? '') === channel
      && String(item?.account ?? '') === account
    const hit = data.messages.find((item) => sameMsg(item) && String(item?.platformId ?? '') === platformId)
    if (hit !== undefined) {
      return { ok: true, kept: data.messages.length, total: data.messages.length, duplicate: true, detail: '' }
    }
    // v0.38.0：认领「升级前写下的老记录」。
    // 老记录没有 platformId（那个键是这一版才有的），所以升级后第一次重启，平台把未确认
    // 的历史重投一遍时，上面那条精确判重一条都命中不了 —— 结果是「历史全体重复一遍」，
    // 比升级前那个 bug 更难看。这里按「通道 + 账号 + 时间 + 发送者 + 正文」找一条没键的老记录，
    // 认下来：把 platformId 补进那条老记录（而不是再写一条），并照样回 duplicate。
    // 只在老记录上发生，且认领后它就带键了，不会第二次认领。
    const legacy = data.messages.find((item) => sameMsg(item)
      && String(item?.platformId ?? '') === ''
      && String(item?.at ?? '') === at
      && String(item?.from ?? '') === String(message?.from ?? '')
      && String(item?.text ?? '') === text)
    if (legacy !== undefined) {
      legacy.platformId = platformId
      data.updatedAt = new Date().toISOString()
      try {
        await mkdir(path.dirname(filePath), { recursive: true })
        const tmp = filePath + '.tmp'
        await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
        await rename(tmp, filePath)
      } catch (error) {
        return { ok: false, kept: 0, total: data.messages.length, detail: '收件箱写盘失败：' + (error?.message ?? String(error)) }
      }
      return { ok: true, kept: data.messages.length, total: data.messages.length, duplicate: true, adopted: true, detail: '' }
    }
  }

  const row = {
    id: channel + '-' + Date.parse(at).toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    channel,
    account,
    at,
    from: String(message?.from ?? ''),
    text,
  }
  // kind 只在不是普通消息时写，老数据没有这个键也能照常读。
  if (message?.kind === 'callback') row.kind = 'callback'
  // v0.38.0：平台唯一键。只在有时写键 —— 老数据没有这个键，读侧一律按「无」处理。
  if (platformId !== '') row.platformId = platformId
  // v0.27.0：附件。只在有时写键 —— 老数据没有这个键，读侧一律按「无附件」处理。
  if (attachments.length > 0) row.attachments = attachments
  if (message?.raw !== undefined) row.raw = message.raw

  data.messages.push(row)
  if (data.messages.length > MAX_KEEP) data.messages = data.messages.slice(-MAX_KEEP)
  data.updatedAt = new Date().toISOString()

  try {
    await mkdir(path.dirname(filePath), { recursive: true })
    const tmp = filePath + '.tmp'
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    await rename(tmp, filePath)
  } catch (error) {
    return { ok: false, kept: 0, total: data.messages.length, detail: '收件箱写盘失败：' + (error?.message ?? String(error)) }
  }
  return { ok: true, kept: data.messages.length, total: data.messages.length }
}

/**
 * 取最近若干条（默认 50），按时间正序返回。
 * @param {number} limit
 * @param {string} [filePath]
 */
export async function recentMessages(limit = 50, filePath = INBOX_PATH) {
  const data = await readInbox(filePath)
  const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50
  return data.messages.slice(-n)
}

/**
 * 就地更新某条消息的附件数组（v0.36.0：下载完成后回填 localPath）。
 *
 * 为什么是「就地更新」而不是「补写一条新消息」：用户看到的是「这条图片消息」，
 * 下载成功只是它多了一个本地路径，不是又来了一条新消息。补写会让收件箱里
 * 同一张图出现两次，看起来像收了两遍。
 *
 * 找不到 id 就回 ok:false —— 不静默成功。消息可能已经因为 MAX_KEEP 被挤掉了，
 * 那种情况下前端该知道「补下成功了但记录没了」，而不是以为写进去了。
 */
export async function updateAttachments(messageId, attachments, filePath = INBOX_PATH) {
  const id = String(messageId ?? '').trim()
  if (id === '') return { ok: false, total: 0, detail: '缺少消息 id' }
  const data = await readInbox(filePath)
  const index = data.messages.findIndex((item) => String(item?.id ?? '') === id)
  if (index < 0) return { ok: false, total: data.messages.length, detail: '这条消息已经不在收件箱里了' }
  const list = Array.isArray(attachments) ? attachments.filter((one) => one !== null && typeof one === 'object') : []
  // 写盘前统一过一道：调用方可能传来带 Buffer 的 handle，直接写会把 inbox.json 撑爆。
  data.messages[index].attachments = list.map((one) => {
    const out = { kind: String(one?.kind ?? 'file'), name: String(one?.name ?? '(未命名)') }
    if (one?.mediaType) out.mediaType = String(one.mediaType)
    if (Number.isFinite(Number(one?.size)) && Number(one.size) > 0) out.size = Math.floor(Number(one.size))
    const handle = one?.handle && typeof one.handle === 'object' ? one.handle : null
    if (handle !== null) {
      const safe = { type: String(handle.type ?? 'none') }
      for (const key of ['fileId', 'id', 'mxc', 'fileKey', 'imageKey', 'messageId', 'reason']) {
        if (handle[key]) safe[key] = String(handle[key])
      }
      out.handle = safe
    }
    if (one?.localPath) {
      out.localPath = String(one.localPath)
      if (one.localBytes) out.localBytes = Math.floor(Number(one.localBytes))
      if (one.localAt) out.localAt = String(one.localAt)
    }
    if (one?.download && typeof one.download === 'object') {
      out.download = { state: String(one.download.state ?? ''), detail: String(one.download.detail ?? '') }
    }
    return out
  })
  data.updatedAt = new Date().toISOString()
  try {
    await mkdir(path.dirname(filePath), { recursive: true })
    const tmp = filePath + '.tmp'
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    await rename(tmp, filePath)
  } catch (error) {
    return { ok: false, total: data.messages.length, detail: '收件箱写盘失败：' + (error?.message ?? String(error)) }
  }
  return { ok: true, total: data.messages.length, index }
}

/** 清空收件箱。 */
export async function clearInbox(filePath = INBOX_PATH) {
  const data = emptyInbox()
  try {
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify(data, null, 2), 'utf8')
    return { ok: true }
  } catch (error) {
    return { ok: false, detail: '清空失败：' + (error?.message ?? String(error)) }
  }
}
