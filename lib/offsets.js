/**
 * dsh-push-hub / lib/offsets.js — 接收游标的落地存储（v0.38.0 新增）。
 *
 * 为什么要有它：Telegram getUpdates 的 offset 游标原来只存在内存的 `acc.__offset` 上，
 * 进程一重启就回到 0 —— 于是 Telegram 会把**全部未确认的历史消息再投一遍**。
 * 用户看到的是「同一条消息在收件箱里出现两次」，而平台侧认为自己在正常重投：
 * 对 Telegram 来说，没收到 offset 确认就等于「你还没收到，我再发一次」，完全合规。
 *
 * 这个缺陷不能靠「写入时去重」单独解决：去重只能挡住重复的**记录**，
 * 重复的 getUpdates 请求本身还会撞 409（另一个实例正在轮询）。两件事一起修才干净。
 *
 * 位置：~/.dsh/dsh-push-hub/offsets.json（与 config / inbox / outbox / progress 同目录）
 * 结构：
 *   {
 *     "version": 1,
 *     "updatedAt": "2026-11-19T00:00:00.000Z",
 *     "offsets": { "telegram/主账号": 123456789, "wechat/主账号": "..." }
 *   }
 *
 * 键是 `通道/账号名`，值是数字（不同平台的游标形态可能不同，这里按「什么都能存」设计，
 * 但 Telegram 明确要求它是整数，读取侧自己校验）。
 *
 * 写入走「临时文件 + rename」，与 inbox / outbox / progress 一致：
 * 进程被杀不会留半截 JSON，下次读到的要么是旧的完整版、要么是新的完整版。
 *
 * 读**永不抛**：游标坏了只是退回到「从头拉」，不该让接收循环起不来。
 *
 * @module offsets
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

/** 游标文件位置（与 config.json 同一目录）。 */
export const OFFSETS_PATH = path.join(os.homedir(), '.dsh', 'dsh-push-hub', 'offsets.json')

/** 空表结构。 */
function emptyStore() {
  return { version: 1, updatedAt: new Date().toISOString(), offsets: {} }
}

/** 通道 + 账号 拼成一个稳定的键。账号名可能含斜杠，所以只切第一个斜杠。 */
export function offsetKey(channel, account) {
  return String(channel ?? '').trim() + '/' + String(account ?? '').trim()
}

/**
 * 读全部游标。文件不存在 / 损坏 / 结构不对一律返回空表，**永不抛**。
 *
 * @param {string} [filePath]
 * @returns {Promise<{version: number, updatedAt: string, offsets: Record<string, unknown>}>}
 */
export async function readOffsets(filePath = OFFSETS_PATH) {
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
  const raw = data.offsets
  const offsets = {}
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (typeof key !== 'string' || key === '') continue
      if (typeof value === 'number' && Number.isFinite(value)) offsets[key] = value
      else if (typeof value === 'string' && value !== '') offsets[key] = value
    }
  }
  return {
    version: Number.isSafeInteger(data.version) ? data.version : 1,
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : new Date().toISOString(),
    offsets,
  }
}

/**
 * 写全部游标。目录不存在就建；先写 .tmp-<pid> 再 rename —— 原子替换。
 *
 * 失败时返回 { ok: false, detail }，**不抛**：游标写不进去只是这次重启会重拉，
 * 不该因此让正在跑的接收循环崩掉。
 *
 * @param {Record<string, unknown>} offsets
 * @param {string} [filePath]
 * @returns {Promise<{ok: boolean, count: number, detail: string}>}
 */
export async function writeOffsets(offsets, filePath = OFFSETS_PATH) {
  const source = offsets !== null && typeof offsets === 'object' ? offsets : {}
  const clean = {}
  for (const [key, value] of Object.entries(source)) {
    if (typeof key !== 'string' || key === '') continue
    if (typeof value === 'number' && Number.isFinite(value)) clean[key] = value
    else if (typeof value === 'string' && value !== '') clean[key] = value
  }
  // 关键：这里必须把已有的 owner 一起带上。setOffset 每轮都会调它，
  // 要是只写 offsets 段，接收权就会被自己每轮清空一次 —— 去重与抢占互相拆台。
  const owner = await readOwner(filePath)
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    ...(owner === null ? {} : { owner: { id: owner.id, pid: owner.pid, at: owner.at } }),
    offsets: clean,
  }
  const tmp = filePath + '.tmp-' + process.pid
  try {
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, filePath)
  } catch (error) {
    return { ok: false, count: Object.keys(clean).length, detail: '游标写盘失败：' + (error?.message ?? String(error)) }
  }
  return { ok: true, count: Object.keys(clean).length, detail: '' }
}

/**
 * 取某个通道某个账号的游标。没有就回 0 —— 0 在 Telegram 语义里正是「从头开始」，
 * 是安全默认值（最坏情况是重拉一遍历史，不是漏消息）。
 *
 * @param {string} channel
 * @param {string} account
 * @param {string} [filePath]
 * @returns {Promise<number>}
 */
export async function getOffset(channel, account, filePath = OFFSETS_PATH) {
  const data = await readOffsets(filePath)
  const value = data.offsets[offsetKey(channel, account)]
  const numeric = Number(value)
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0
}

/**
 * 写某个通道某个账号的游标（读-改-写）。返回写盘结果，不抛。
 *
 * @param {string} channel
 * @param {string} account
 * @param {number} value
 * @param {string} [filePath]
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
export async function setOffset(channel, account, value, filePath = OFFSETS_PATH) {
  const numeric = Number(value)
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    return { ok: false, detail: '游标必须是 >= 0 的整数，收到的是 ' + String(value) }
  }
  const data = await readOffsets(filePath)
  data.offsets[offsetKey(channel, account)] = numeric
  const written = await writeOffsets(data.offsets, filePath)
  return { ok: written.ok, detail: written.detail }
}

/**
 * 抢接收权（v0.38.0）。
 *
 * 要解决的问题：同一个 Bot Token 只允许一个 getUpdates 轮询者。插件热重载后，
 * 旧模块的接收循环还活着（它跑在旧模块的闭包里，内存 Map 已经是新的了），
 * 新模块又起一个 —— 两个都在调 getUpdates，Telegram 回 409 并互相踢，
 * 状态在 running / retrying 之间抖，日志里刷 "terminated by other getUpdates"。
 *
 * 内存里判不了这件事（旧循环看的是旧模块的 Map），只能落盘：
 * 启动时把自己的实例 id 写进 offsets.json 的 owner，每个循环每轮读一次，
 * 发现 owner 不是自己就主动退出 —— 后启动的赢，先启动的安静退场。
 *
 * 为什么不是「检测到冲突就拒绝启动」：用户刚点了「开始接收」，被拒绝会以为是坏了。
 * 让它赢、让旧的退，才是符合直觉的收敛方向。
 *
 * @param {string} ownerId
 * @param {string} [filePath]
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
export async function claimOwner(ownerId, filePath = OFFSETS_PATH) {
  const id = String(ownerId ?? '').trim()
  if (id === '') return { ok: false, detail: '实例 id 不能为空' }
  const data = await readOffsets(filePath)
  const current = data.owner !== null && typeof data.owner === 'object' ? data.owner : {}
  if (current.id === id) return { ok: true, detail: '' }
  return await writeOwner(id, filePath)
}

/**
 * 读当前接收权持有者。没有就回 null。永不抛。
 *
 * @param {string} [filePath]
 * @returns {Promise<{id: string, pid: number, at: string}|null>}
 */
export async function readOwner(filePath = OFFSETS_PATH) {
  let text = ''
  try {
    text = await readFile(filePath, 'utf8')
  } catch {
    return null
  }
  let data = null
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  const owner = data?.owner
  if (owner === null || typeof owner !== 'object') return null
  const id = typeof owner.id === 'string' ? owner.id : ''
  if (id === '') return null
  return {
    id,
    pid: Number.isSafeInteger(owner.pid) ? owner.pid : 0,
    at: typeof owner.at === 'string' ? owner.at : '',
  }
}

/** 写 owner（读-改-写，保留 offsets 段）。 */
async function writeOwner(ownerId, filePath) {
  const data = await readOffsets(filePath)
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    owner: { id: ownerId, pid: process.pid, at: new Date().toISOString() },
    offsets: data.offsets,
  }
  const tmp = filePath + '.tmp-' + process.pid
  try {
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, filePath)
  } catch (error) {
    return { ok: false, detail: '接收权写盘失败：' + (error?.message ?? String(error)) }
  }
  return { ok: true, detail: '' }
}
