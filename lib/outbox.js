/**
 * lib/outbox.js — 发件箱（发送回执的落地存储）。
 *
 * 为什么要有它：v0.28.0 之前十二个通道的 send() 只回一句「已发送 N 块」，
 * 发完就忘了 —— 于是「改一条已发的消息」「撤回」「加表情」这三件事一件也做不了，
 * 因为它们都需要知道「发出去的那条消息，在平台上叫什么名字」。
 * 这个模块只干一件事：把每次成功的发送连同平台回执的 message id 记下来。
 *
 * 存放位置：~/.dsh/dsh-push-hub/outbox.json（与 config.json / inbox.json 同目录，
 * 便于一起备份与清理）。
 * 结构：
 *   {
 *     "version": 1,
 *     "updatedAt": "2026-11-18T06:00:00.000Z",
 *     "messages": [ { id, at, channel, account, target, kind, text, messageIds, detail }, ... ]
 *   }
 *
 * messageIds 是数组而不是字符串：本插件会把长消息切成多块发出去，
 * 每一块在平台上都是一条独立消息、各有各的 id。只留最后一个会让人
 * 「改第一条时改不到」，只留第一个又会「改最后一条时改不到」。
 *
 * places 是 v0.29.0 加的：一个账号可以同时发到多个目标（多投递目标），
 * 那时 messageIds 里混着几个聊天的 id，谁属于谁分不清 —— 而改 / 撤必须
 * 知道「这条 id 在哪个聊天里」。所以每组 id 连同它的目标一起存：
 *   "places": [ { "id": "群A", "messageIds": ["1001","1002"] }, ... ]
 * messageIds 仍然保留（摊平的总表），一是老数据兼容，二是「一共有几条」
 * 这种问题不用遍历 places。
 *
 * 只记成功的。失败的那次没有任何 message id —— 记进去既不能改也不能撤，
 * 只会把真正发出去的那些挤出保留窗口。
 *
 * 保留策略：只留最近 MAX_KEEP 条（默认 500），与 inbox 一致。
 * 所有写入走「读-改-写 + 原子替换」，进程被杀不会留下半截 JSON。
 *
 * @module outbox
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

/** 最多保留多少条。超出后丢最旧的。 */
export const MAX_KEEP = 500

/** 单个条目里正文最多留多长（只留个开头，够人认出「这是哪条」就行）。 */
export const TEXT_CLIP = 200

/** 发件箱文件位置（与 config.json 同一目录）。 */
export const OUTBOX_PATH = path.join(os.homedir(), '.dsh', 'dsh-push-hub', 'outbox.json')

/** 空发件箱的初始结构。 */
function emptyOutbox() {
  return { version: 1, updatedAt: new Date().toISOString(), messages: [] }
}

/**
 * 读发件箱。文件不存在 / 损坏 / 结构不对时返回空发件箱，**永不抛**。
 * 与 inbox 同理：这是日志性质的东西，读坏了不该让整个插件崩。
 */
export async function readOutbox(filePath = OUTBOX_PATH) {
  let text = ''
  try {
    text = await readFile(filePath, 'utf8')
  } catch {
    return emptyOutbox()
  }
  let data = null
  try {
    data = JSON.parse(text)
  } catch {
    return emptyOutbox()
  }
  if (data === null || typeof data !== 'object') return emptyOutbox()
  const messages = Array.isArray(data.messages)
    ? data.messages.filter((item) => item !== null && typeof item === 'object')
    : []
  return {
    version: Number.isSafeInteger(data.version) ? data.version : 1,
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : new Date().toISOString(),
    messages,
  }
}

/**
 * 把一批发送回执追加进发件箱。
 *
 * @param {Array<{channel: string, account?: string|null, target?: string, kind?: string,
 *   text?: string, messageIds?: string[], detail?: string}>} entries
 * @param {string} [filePath]
 * @returns {Promise<{ok: boolean, kept: number, detail?: string}>}
 */
export async function appendSent(entries, filePath = OUTBOX_PATH) {
  const list = Array.isArray(entries) ? entries.filter((one) => one !== null && typeof one === 'object') : []
  if (list.length === 0) return { ok: true, kept: 0 }

  const box = await readOutbox(filePath)
  const at = new Date().toISOString()
  for (const one of list) {
    const ids = Array.isArray(one?.messageIds)
      ? one.messageIds.map((v) => String(v ?? '').trim()).filter((v) => v !== '')
      : []
    box.messages.push({
      id: 'sent-' + at.replace(/[^0-9]/g, '').slice(0, 14) + '-' + Math.random().toString(36).slice(2, 8),
      at,
      channel: String(one?.channel ?? ''),
      account: one?.account === undefined || one?.account === null ? null : String(one.account),
      target: String(one?.target ?? ''),
      kind: one?.kind === 'file' ? 'file' : 'text',
      text: clipText(one?.text),
      messageIds: ids.slice(0, 50),
      places: cleanPlaces(one?.places),
      detail: String(one?.detail ?? ''),
    })
  }
  if (box.messages.length > MAX_KEEP) box.messages = box.messages.slice(-MAX_KEEP)
  box.updatedAt = at

  try {
    const dir = path.dirname(filePath)
    await mkdir(dir, { recursive: true })
    const tmp = filePath + '.tmp-' + process.pid
    await writeFile(tmp, JSON.stringify(box, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, filePath)
    return { ok: true, kept: list.length }
  } catch (error) {
    // 记不上不影响「已经发出去了」这个事实，所以只回 ok:false 不抛。
    return { ok: false, kept: 0, detail: String(error?.message ?? error).slice(0, 200) }
  }
}

/**
 * 规整 places：每组要 {id, messageIds}，id 空或 id 列表空的组直接丢掉。
 *
 * 丢掉而不是补默认值：一个「有位置但没有任何 id」的组既改不了也撤不了，
 * 留着只会让人在界面上看到一条点了没反应的目标。
 */
function cleanPlaces(input) {
  const list = Array.isArray(input) ? input : []
  const out = []
  for (const one of list) {
    if (one === null || typeof one !== 'object') continue
    const id = String(one?.id ?? '').trim()
    if (id === '') continue
    const ids = Array.isArray(one?.messageIds)
      ? one.messageIds.map((v) => String(v ?? '').trim()).filter((v) => v !== '')
      : []
    if (ids.length === 0) continue
    out.push({ id, messageIds: ids.slice(0, 50) })
  }
  return out.slice(0, 20)
}

/** 正文只留开头。空白折叠成单个空格，避免一条多行消息把列表撑开。 */
function clipText(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > TEXT_CLIP ? text.slice(0, TEXT_CLIP) + '…' : text
}

/**
 * 取最近 N 条（新的在前）。
 *
 * @param {number} [limit]
 * @param {string} [filePath]
 */
export async function recentSent(limit = 50, filePath = OUTBOX_PATH) {
  const box = await readOutbox(filePath)
  const want = Number.isSafeInteger(limit) && limit > 0 ? limit : 50
  return box.messages.slice(-want).reverse()
}
