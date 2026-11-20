/**
 * dsh-push-hub / lib/progressstore.js — 进度表情的落地存储（v0.34.0 新增）。
 *
 * 为什么要有它：v0.33.0 的 PROGRESS_HUB 是纯内存的 Map，进程一重启，
 * 所有 progressId 全失效 —— 一条挂着 ⏳ 的消息从此再没人收尾，用户看到的是
 * 一条永远「在跑」的任务。这不是小毛病：宿主插件本来就会随 DSH 重启。
 *
 * 落盘只解决「收尾」这一件事，不假装能把状态机整个复活：
 * 存的是「这条消息现在挂着什么表情、属于哪个通道哪个账号」，
 * 收尾时按这些信息重新造一台状态机，把 ⏳ 换成终态。
 * 中间那几次 transition 的计数（added / removed）不跨重启，重启后从 0 起算 ——
 * 那是量化的账，不是语义；编不出来就不编。
 *
 * 位置：~/.dsh/dsh-push-hub/progress.json（与 config / inbox / outbox 同目录，便于一起备份）
 * 结构：
 *   {
 *     "version": 1,
 *     "updatedAt": "2026-11-18T12:00:00.000Z",
 *     "records": [ { id, channel, account, messageId, emojis, emoji, createdAt }, ... ]
 *   }
 *
 * 只存**还没收尾的**。收完立刻删掉 —— 这份文件是「待办」，不是历史；
 * 历史在 outbox 里。
 * 写入走「临时文件 + rename」，进程被杀不会留半截 JSON。
 *
 * @module progressstore
 */

import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

/** 最多保留多少条待收尾的。超了丢最旧的 —— 丢的是「谁忘了收」的线索，不是数据。 */
export const MAX_KEEP = 200

/** 待收尾记录的文件位置（与 config.json 同一目录）。 */
export const PROGRESS_PATH = path.join(os.homedir(), '.dsh', 'dsh-push-hub', 'progress.json')

/** 空表结构。 */
function emptyStore() {
  return { version: 1, updatedAt: new Date().toISOString(), records: [] }
}

/**
 * 读待收尾记录。文件不存在 / 损坏 / 结构不对一律返回空表，**永不抛**。
 * 与 outbox 同理：这是辅助记录，读坏了不该让插件起不来。
 *
 * @param {string} [filePath]
 * @returns {Promise<{version: number, updatedAt: string, records: Array<object>}>}
 */
export async function readProgressStore(filePath = PROGRESS_PATH) {
  let text = ''
  try {
    text = await readFile(filePath, 'utf8')
  } catch {
    return emptyStore()
  }
  let data = null
  try {
    data = JSON.parse(text)
  } catch {
    return emptyStore()
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return emptyStore()
  const records = Array.isArray(data.records)
    ? data.records.filter((one) => one !== null && typeof one === 'object' && typeof one.id === 'string' && one.id !== '')
    : []
  return {
    version: Number.isSafeInteger(data.version) ? data.version : 1,
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : new Date().toISOString(),
    records,
  }
}

/**
 * 写待收尾记录。目录不存在就建；先写 .tmp-<pid> 再 rename —— 原子替换。
 *
 * 失败时返回 { ok: false, detail }，**不抛**：落盘失败不该让一次发送失败。
 * 代价是「跨重启收尾」这条能力暂时失效，而这件事在 detail 里说清楚了。
 *
 * @param {Array<object>} records
 * @param {string} [filePath]
 * @returns {Promise<{ok: boolean, detail: string, count: number}>}
 */
export async function writeProgressStore(records, filePath = PROGRESS_PATH) {
  const list = Array.isArray(records) ? records.slice(-MAX_KEEP) : []
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    records: list,
  }
  const tmp = filePath + '.tmp-' + process.pid
  try {
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, filePath)
    return { ok: true, detail: '', count: list.length }
  } catch (err) {
    try { await unlink(tmp) } catch { /* 清理失败就算了，反正下次会被覆盖 */ }
    return { ok: false, detail: '进度表情没能落盘：' + String(err?.message ?? err).slice(0, 160), count: list.length }
  }
}

/**
 * 把一条记录塞进列表：同 id 覆盖，其余保序。
 * 单独抽出来是为了让「先 remove 再 add」这条合并规则只有一份实现。
 */
export function upsertRecord(records, record) {
  const list = Array.isArray(records) ? records.filter((one) => one?.id !== record?.id) : []
  if (record === null || record === undefined || typeof record.id !== 'string' || record.id === '') return list
  list.push(record)
  return list.slice(-MAX_KEEP)
}

/** 按 id 删一条。 */
export function removeRecord(records, id) {
  const key = String(id ?? '')
  return (Array.isArray(records) ? records : []).filter((one) => one?.id !== key)
}
