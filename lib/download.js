/**
 * lib/download.js — 把别人发来的附件真正取回本地（v0.36.0 新增）。
 *
 * ## 为什么这件事要单独一个模块
 * v0.26 起 `attachments.js` 只做「记录」：收件箱里能看到「图片 photo-a1b2.jpg 12.3 KB」，
 * 但文件本身在平台那边。用户点不开、转存不了、也留不住 —— 群里发来的合同，
 * 过两天平台链接过期就彻底没了。所以「记录」只是半步，取回来才是完整。
 *
 * 但取文件不是加个 fetch 就完事，它有四个必须做决定的地方：
 *   1. **单文件上限** —— 别人发一个 2 GB 的镜像给你，你下不下？内存放不下。
 *   2. **落盘在哪** —— 放插件代码目录会被下次升级覆盖，放临时目录会被系统清掉。
 *   3. **留多久** —— 只增不删，一年后占满硬盘；删太狠，用户回头找就没了。
 *   4. **凭据泄漏** —— Slack 的下载 URL 自带 token，把它写进 inbox.json 等于
 *      把 token 写到明文文件里。这四条都不是「顺手」能解决的，所以单独一层。
 *
 * ## 三条纪律
 *   1. **下载失败不影响收消息**。附件下不下来是次要的：消息正文已经记下了，
 *      收件箱里那条记录仍然在。绝不能因为下载 404 就把整条消息丢掉。
 *   2. **上限在传输层生效，不是事后检查**。`maxBytes` 传给 http.getBytes，
 *      边收边计数、一超就断流 —— 「先下完再量大小」等于白拉 2 GB 进内存。
 *   3. **落盘文件名不信任平台**。平台给的 fileName 可能带 `../`、可能含冒号，
 *      直接用会写出目录或失败（Windows 禁止 `:*?"<>|`）。
 *
 * ## 三个策略点都可配
 *   maxFileMB（单文件上限，默认 10 MB）/ retainDays（保留天数，默认 7）
 *   / maxTotalMB（总量上限，默认 200 MB，超了先清最老）。
 *
 * @module download
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { getBytes, getJson, request } from './http.js'
import { humanSize } from './attachments.js'

/** 单文件上限默认 10 MB。多数 IM 的图片/文档都在这个量级内。 */
export const DEFAULT_MAX_FILE_MB = 10
/** 保留天数默认 7 天。够用户回头找，又不至于把硬盘堆死。 */
export const DEFAULT_RETAIN_DAYS = 7
/** 总量上限默认 200 MB。超了按 mtime 从老到新删。 */
export const DEFAULT_MAX_TOTAL_MB = 200

/** 三个可配项的合法区间（夹值必须回 detail，不能静默改用户的值）。 */
export const LIMITS = Object.freeze({
  maxFileMB: Object.freeze({ min: 0, max: 200, fallback: DEFAULT_MAX_FILE_MB }),
  retainDays: Object.freeze({ min: 0, max: 365, fallback: DEFAULT_RETAIN_DAYS }),
  maxTotalMB: Object.freeze({ min: 0, max: 10240, fallback: DEFAULT_MAX_TOTAL_MB }),
})

/** 下载超时。附件比文本大得多，25 秒不够，给 3 分钟。 */
export const DOWNLOAD_TIMEOUT_MS = 180000

/** 哪些 handle 能下 —— 与 attachments.DOWNLOADABLE_HANDLES 保持一致。 */
export const CAN_DOWNLOAD = Object.freeze(['telegram', 'slack', 'discord', 'matrix', 'feishu', 'email'])

/**
 * 不能下的原因（一句话，直接展示给用户）。
 *
 * 这里必须分清两件完全不同的事 —— 混在一起会让用户去反复重试没用的事：
 *   · wecom：**平台链路本身不给**。企业微信智能机器人的回调里没有 media_id，
 *     拿不到原图不是实现问题，换谁来写都拿不到。
 *   · qq / dingtalk：**平台给，但本轮主动没做**。QQ 有拉文件的接口（但只有 5 分钟
 *     窗口）、钉钉能用 downloadCode 换一次性 URL —— 两条都是「能写，只是会拖长这版」，
 *     所以这版先如实标出来，不假装下载失败。
 * 措辞上刻意不写「平台不给」，因为那不是事实；也不写「暂不支持」，那是敷衍。
 */
export const NO_DOWNLOAD_REASON = Object.freeze({
  qq: 'QQ 官方机器人只推附件元数据，真文件要在 5 分钟内主动调接口拉 —— 这条本轮没做，所以取不到',
  dingtalk: '钉钉要先用 downloadCode 换一个几分钟就失效的临时 URL —— 这条本轮没做，所以取不到',
  wecom: '企业微信智能机器人的回调里没有 media_id，这条链路本身就不给原图',
  none: '这条记录里没有可用的下载线索',
})

/** 附件落盘根目录：`~/.dsh/dsh-push-hub/files`，可用环境变量覆盖（探针要用）。 */
export function filesRoot() {
  const override = String(process.env.DSH_PUSH_HUB_FILES_DIR ?? '').trim()
  if (override !== '') return override
  return path.join(os.homedir(), '.dsh', 'dsh-push-hub', 'files')
}

/** 日期子目录名，`20261118` 这种。按天分目录，清理时能整目录删。 */
export function dayFolder(now = Date.now()) {
  const d = new Date(now)
  const p = (n) => String(n).padStart(2, '0')
  return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate())
}

/**
 * 把平台给的文件名洗成安全文件名。
 * Windows 禁止 `: * ? " < > |`，另外 `/` 与 `\` 会切目录，`..` 能跳出目录。
 * 空名 / 全是非法字符 → 回落到 fallback（不给空文件名，否则落盘必失败）。
 */
export function safeName(name, fallback = 'attachment') {
  let out = String(name ?? '').trim()
  out = out.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
  out = out.replace(/\.{2,}/g, '.')
  out = out.replace(/^[.\s]+/, '').slice(0, 120)
  if (out === '' || out === '.' || out === '_') return fallback
  return out
}

/** 同名文件不覆盖：`报告.pdf` → `报告(1).pdf`。 */
function uniquePath(dir, name) {
  const ext = path.extname(name)
  const base = ext === '' ? name : name.slice(0, -ext.length)
  let candidate = path.join(dir, name)
  let i = 1
  while (fs.existsSync(candidate) && i < 1000) {
    candidate = path.join(dir, base + '(' + i + ')' + ext)
    i += 1
  }
  return candidate
}

/** 归一化单文件上限：留空 = 默认；0 = 不限；其它夹 0~200 并回 detail。 */
export function normalizeMaxFileMB(input) {
  const { min, max, fallback } = LIMITS.maxFileMB
  if (input === undefined || input === null || String(input).trim() === '') return { value: fallback, detail: '' }
  const raw = String(input).trim()
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return { value: fallback, detail: '单文件上限「' + raw + '」不是有效数字，已按默认 ' + fallback + ' MB 处理。' }
  if (n > max) return { value: max, detail: '单文件上限最大 ' + max + ' MB，已从 ' + raw + ' 收到 ' + max + '。' }
  return { value: Math.floor(n), detail: '' }
}

/** 归一化保留天数：0 = 不自动清（用户自己管）。 */
export function normalizeRetainDays(input) {
  const { max, fallback } = LIMITS.retainDays
  if (input === undefined || input === null || String(input).trim() === '') return { value: fallback, detail: '' }
  const raw = String(input).trim()
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return { value: fallback, detail: '保留天数「' + raw + '」不是有效数字，已按默认 ' + fallback + ' 天处理。' }
  if (n > max) return { value: max, detail: '保留天数最大 ' + max + ' 天，已从 ' + raw + ' 收到 ' + max + '。' }
  return { value: Math.floor(n), detail: '' }
}

/** 归一化总量上限：0 = 不限。 */
export function normalizeMaxTotalMB(input) {
  const { max, fallback } = LIMITS.maxTotalMB
  if (input === undefined || input === null || String(input).trim() === '') return { value: fallback, detail: '' }
  const raw = String(input).trim()
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return { value: fallback, detail: '总量上限「' + raw + '」不是有效数字，已按默认 ' + fallback + ' MB 处理。' }
  if (n > max) return { value: max, detail: '总量上限最大 ' + max + ' MB，已从 ' + raw + ' 收到 ' + max + '。' }
  return { value: Math.floor(n), detail: '' }
}
/** 遍历 filesRoot 下所有文件（只走两层：日期目录 + 文件，够用且不会误删别的东西）。 */
async function walkFiles(root) {
  const out = []
  let days = []
  try {
    days = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const day of days) {
    if (!day.isDirectory()) continue
    const dir = path.join(root, day.name)
    let entries = []
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const full = path.join(dir, entry.name)
      try {
        const st = await fsp.stat(full)
        out.push({ path: full, bytes: st.size, mtimeMs: st.mtimeMs, day: day.name })
      } catch {
        /* 文件刚好被删了，跳过 */
      }
    }
  }
  return out
}

/**
 * 清理：先按天数删过期，再按总量从最老的删到不超限。
 *
 * 为什么是两轮而不是一轮：两个策略管的是不同的事。天数管「太旧的没意义」，
 * 总量管「新的太多也放不下」。只做天数，一天收 500 MB 照样爆；
 * 只做总量，十年前那个 1 KB 的小文件也会被当成垃圾清掉。
 *
 * 返回删了什么，便于汇报与探针断言 —— 不静默删。
 */
export async function sweepFiles(options = {}) {
  const retain = normalizeRetainDays(options.retainDays)
  const total = normalizeMaxTotalMB(options.maxTotalMB)
  const now = Number(options.now) > 0 ? Number(options.now) : Date.now()
  const root = String(options.root ?? '').trim() !== '' ? String(options.root) : filesRoot()
  const files = await walkFiles(root)
  const removed = []
  let kept = []
  // 第一轮：过期删。retain 为 0 表示用户明确关掉了自动清理。
  if (retain.value > 0) {
    const cutoff = now - retain.value * 24 * 60 * 60 * 1000
    for (const item of files) {
      if (item.mtimeMs < cutoff) removed.push({ path: item.path, bytes: item.bytes, why: '超过 ' + retain.value + ' 天' })
      else kept.push(item)
    }
  } else {
    kept = files
  }
  // 第二轮：总量删，从最老的开始。
  if (total.value > 0) {
    const limitBytes = total.value * 1024 * 1024
    let sum = kept.reduce((acc, item) => acc + item.bytes, 0)
    if (sum > limitBytes) {
      const ordered = kept.slice().sort((a, b) => a.mtimeMs - b.mtimeMs)
      const still = []
      for (const item of ordered) {
        if (sum > limitBytes) {
          removed.push({ path: item.path, bytes: item.bytes, why: '总量超 ' + total.value + ' MB，清最老的' })
          sum -= item.bytes
        } else {
          still.push(item)
        }
      }
      kept = still
    }
  }
  // 真删。单个删失败不影响其它（可能被占用）。
  let failed = 0
  for (const item of removed) {
    try {
      await fsp.unlink(item.path)
    } catch {
      failed += 1
    }
  }
  // 顺手清空的日期目录。
  const days = new Set(files.map((item) => item.day))
  for (const day of days) {
    const dir = path.join(root, day)
    try {
      const left = await fsp.readdir(dir)
      if (left.length === 0) await fsp.rmdir(dir)
    } catch {
      /* 目录不在或非空，都无需处理 */
    }
  }
  const keptBytes = kept.reduce((acc, item) => acc + item.bytes, 0)
  return {
    ok: true,
    root,
    scanned: files.length,
    removed: removed.length,
    failed,
    kept: kept.length,
    keptBytes,
    keptHuman: humanSize(keptBytes),
    retainDays: retain.value,
    maxTotalMB: total.value,
    details: removed.map((item) => ({ path: item.path, bytes: item.bytes, why: item.why })),
  }
}

/* ── 各平台的「怎么把文件取回来」 ───────────────────────────────────── */

/**
 * Telegram：两步。getFile 换 file_path，再从 /file/bot<token>/<path> 下字节。
 * 为什么不能一步：file_id 不是 URL，Telegram 不暴露直接地址。
 */
async function fetchTelegram(handle, acc) {
  const token = String(acc?.botToken ?? acc?.token ?? '')
  if (token === '') return { ok: false, detail: '这个 Telegram 账号没配 botToken，取不了文件' }
  const fileId = String(handle?.fileId ?? '')
  if (fileId === '') return { ok: false, detail: 'Telegram 附件没有 file_id' }
  const api = 'https://api.telegram.org/bot' + token
  const meta = await getJson(api + '/getFile?file_id=' + encodeURIComponent(fileId), { proxy: acc?.proxy })
  if (meta?.status !== 200 || !meta?.body?.ok) {
    return { ok: false, detail: 'Telegram getFile 失败：' + String(meta?.body?.description ?? meta?.status ?? '无响应') }
  }
  const filePath = String(meta?.body?.result?.file_path ?? '')
  if (filePath === '') return { ok: false, detail: 'Telegram 没给 file_path（文件可能太大或已过期）' }
  const got = await getBytes(api + '/' + filePath, { proxy: acc?.proxy })
  if (!got?.bytes) return { ok: false, detail: 'Telegram 下载失败：HTTP ' + String(got?.status ?? '无响应') }
  return { ok: true, bytes: got.bytes, detail: '' }
}

/** Slack：url_private_download 要自己带 Bearer，URL 本身不带鉴权。 */
async function fetchSlack(handle, acc) {
  const token = String(acc?.botToken ?? acc?.token ?? '')
  if (token === '') return { ok: false, detail: '这个 Slack 账号没配 botToken，取不了文件' }
  const url = String(handle?.url ?? '')
  if (url === '') return { ok: false, detail: 'Slack 附件没有下载地址' }
  const got = await getBytes(url, { headers: { authorization: 'Bearer ' + token }, proxy: acc?.proxy })
  if (!got?.bytes) return { ok: false, detail: 'Slack 下载失败：HTTP ' + String(got?.status ?? '无响应') }
  return { ok: true, bytes: got.bytes, detail: '' }
}

/** Discord：CDN 直链带签名，不需要额外鉴权头。 */
async function fetchDiscord(handle, acc) {
  const url = String(handle?.url ?? '')
  if (url === '') return { ok: false, detail: 'Discord 附件没有下载地址' }
  const got = await getBytes(url, { proxy: acc?.proxy })
  if (!got?.bytes) return { ok: false, detail: 'Discord 下载失败：HTTP ' + String(got?.status ?? '无响应') }
  return { ok: true, bytes: got.bytes, detail: '' }
}

/** Matrix：mxc://server/mediaid → /_matrix/media/v3/download/server/mediaid，带 access token。 */
async function fetchMatrix(handle, acc) {
  const token = String(acc?.accessToken ?? acc?.token ?? '')
  if (token === '') return { ok: false, detail: '这个 Matrix 账号没配 accessToken，取不了文件' }
  const mxc = String(handle?.mxc ?? '')
  if (!mxc.startsWith('mxc://')) return { ok: false, detail: 'Matrix 附件地址不是 mxc:// 形式' }
  const rest = mxc.slice('mxc://'.length)
  const cut = rest.indexOf('/')
  if (cut <= 0) return { ok: false, detail: 'Matrix mxc 地址格式不对：' + mxc }
  const server = rest.slice(0, cut)
  const mediaId = rest.slice(cut + 1)
  let home = String(acc?.homeserver ?? acc?.baseUrl ?? '').trim().replace(/\/+$/, '')
  if (home === '') return { ok: false, detail: '这个 Matrix 账号没配 homeserver' }
  if (!/^https?:\/\//i.test(home)) home = 'https://' + home
  const url = home + '/_matrix/media/v3/download/' + encodeURIComponent(server) + '/' + encodeURIComponent(mediaId) + '?allow_redirect=true'
  const got = await getBytes(url, { headers: { authorization: 'Bearer ' + token }, proxy: acc?.proxy })
  if (!got?.bytes) return { ok: false, detail: 'Matrix 下载失败：HTTP ' + String(got?.status ?? '无响应') }
  return { ok: true, bytes: got.bytes, detail: '' }
}

/**
 * 飞书：两步。先换 tenant_access_token（有效期 2 小时），再
 * GET /open-apis/im/v1/messages/{message_id}/resources/{file_key}?type=image|file。
 *
 * 为什么自己换 token 而不用 feishu.js 里那个：那个是私有的（没 export），
 * 而把它导出来会让 channels/feishu.js 承担「给 download 用」的额外职责。
 * 这里只有一个 POST，重复两次不值得改别人的导出面。
 */
async function fetchFeishu(handle, acc) {
  const appId = String(acc?.appId ?? acc?.app_id ?? '')
  const appSecret = String(acc?.appSecret ?? acc?.app_secret ?? acc?.secret ?? '')
  if (appId === '' || appSecret === '') return { ok: false, detail: '这个飞书账号没配 appId / appSecret，取不了文件' }
  const host = String(acc?.domain ?? '') === 'larksuite' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'
  // 换 token 必须 POST（getJson 只做 GET），所以用 request 而不是 getJson。
  const tok = await request(host + '/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    proxy: acc?.proxy,
  })
  const token = String(tok?.body?.tenant_access_token ?? '')
  if (token === '') {
    const why = String(tok?.body?.msg ?? tok?.body?.code ?? tok?.status ?? '换 token 失败')
    return { ok: false, detail: '飞书换 tenant_access_token 失败：' + why }
  }
  const messageId = String(handle?.messageId ?? '')
  const key = String(handle?.fileKey ?? handle?.imageKey ?? '')
  if (messageId === '' || key === '') return { ok: false, detail: '飞书附件缺 message_id 或 file_key' }
  const kind = String(handle?.kind ?? 'file') === 'image' ? 'image' : 'file'
  const url = host + '/open-apis/im/v1/messages/' + encodeURIComponent(messageId) + '/resources/' + encodeURIComponent(key) + '?type=' + kind
  const got = await getBytes(url, { headers: { authorization: 'Bearer ' + token }, proxy: acc?.proxy })
  if (!got?.bytes) return { ok: false, detail: '飞书下载失败：HTTP ' + String(got?.status ?? '无响应') }
  return { ok: true, bytes: got.bytes, detail: '' }
}
/** 邮件：字节已经在内存里了（收信时整个 MIME 体都读过了），不需要再走网络。 */
function fetchEmail(handle) {
  if (!Buffer.isBuffer(handle?.buffer)) return { ok: false, detail: '邮件附件没有留下字节（解析时可能被省内存丢了）' }
  return { ok: true, bytes: handle.buffer, detail: '' }
}

/**
 * 取回一个附件的字节（**不落盘**）。
 *
 * 分流表就是一张 type → 函数的映射。加新通道只要在这里加一行 + 写一个 fetchXxx。
 * 每个 fetchXxx 都返回同一个 `{ok, bytes, detail}` 形状 —— 调用方不需要知道
 * 十条链路各自长什么样。
 */
export async function fetchAttachment(handle, acc) {
  const type = String(handle?.type ?? '')
  if (!CAN_DOWNLOAD.includes(type)) {
    const reason = NO_DOWNLOAD_REASON[type] ?? NO_DOWNLOAD_REASON.none
    return { ok: false, detail: reason, skipped: true }
  }
  try {
    if (type === 'telegram') return await fetchTelegram(handle, acc)
    if (type === 'slack') return await fetchSlack(handle, acc)
    if (type === 'discord') return await fetchDiscord(handle, acc)
    if (type === 'matrix') return await fetchMatrix(handle, acc)
    if (type === 'feishu') return await fetchFeishu(handle, acc)
    if (type === 'email') return fetchEmail(handle)
    return { ok: false, detail: '未知的附件类型：' + type }
  } catch (error) {
    // 一条链路的意外异常不该把整条消息的下载都搞挂。
    return { ok: false, detail: '下载出错：' + String(error?.message ?? error) }
  }
}

/**
 * 取回 + 落盘。返回的 `localPath` 会被写进 inbox 记录，用户在界面上能直接点开。
 *
 * 顺序上有讲究：**先查上限再下载**。拿得到 file_size 就不该先把文件拉下来再嫌它大 ——
 * 所以 size 已知且超限时直接回 skipped，一个字节都不请求。
 */
export async function saveAttachment(item, acc, options = {}) {
  const handle = item?.handle ?? null
  const limit = normalizeMaxFileMB(options.maxFileMB)
  const maxBytes = limit.value > 0 ? limit.value * 1024 * 1024 : 0
  const declared = Number(item?.size)
  if (maxBytes > 0 && Number.isFinite(declared) && declared > maxBytes) {
    return {
      ok: false,
      skipped: true,
      detail: '文件 ' + humanSize(declared) + ' 超过单文件上限 ' + limit.value + ' MB，没有下载',
    }
  }
  const got = await fetchAttachment(handle, acc)
  if (!got.ok) return { ok: false, skipped: Boolean(got.skipped), detail: got.detail }
  const bytes = got.bytes
  if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0) return { ok: false, detail: '取回来的是空文件' }
  if (maxBytes > 0 && bytes.byteLength > maxBytes) {
    return { ok: false, skipped: true, detail: '实际大小 ' + humanSize(bytes.byteLength) + ' 超过上限 ' + limit.value + ' MB，已丢弃' }
  }
  const root2 = String(options.root ?? '').trim() !== '' ? String(options.root) : filesRoot()
  const at = Number(options.now) > 0 ? Number(options.now) : Date.now()
  const dir = path.join(root2, dayFolder(at))
  try {
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
  } catch (error) {
    return { ok: false, detail: '建目录失败：' + String(error?.message ?? error) }
  }
  const name = safeName(item?.name, 'attachment')
  const target = uniquePath(dir, name)
  try {
    await fsp.writeFile(target, bytes, { mode: 0o600 })
  } catch (error) {
    return { ok: false, detail: '写文件失败：' + String(error?.message ?? error) }
  }
  return {
    ok: true,
    localPath: target,
    localBytes: bytes.byteLength,
    localAt: new Date(at).toISOString(),
    detail: '',
  }
}

/**
 * 给一批附件补上下载结果。
 *
 * **失败不抛** —— 这是本模块最重要的一条纪律。收件箱里那条消息已经记下了，
 * 附件下不下来只影响「能不能点开」，不能让接收链路跟着挂。
 * 每个附件都带上 `download` 字段说明结果，前端据此显示「已下载 / 太大跳过 / 取不到」。
 */
export async function downloadAll(list, acc, options = {}) {
  const items = Array.isArray(list) ? list : []
  const out = []
  for (const item of items) {
    const one = { ...item }
    const res = await saveAttachment(one, acc, options)
    if (res.ok) {
      one.localPath = res.localPath
      one.localBytes = res.localBytes
      one.localAt = res.localAt
      one.download = { state: 'saved', detail: '' }
    } else {
      one.download = { state: res.skipped ? 'skipped' : 'failed', detail: String(res.detail ?? '') }
    }
    out.push(one)
  }
  return out
}

/**
 * 列出现已落盘的附件（按天分组），给「附件」页用。
 * 只读文件系统，不碰 inbox.json —— 界面要的是「硬盘上有什么」，
 * 而不是「记录里说过什么」。两者可能不一致（比如手工删过文件），这很正常。
 */
export async function listFiles(options = {}) {
  const root3 = String(options.root ?? '').trim() !== '' ? String(options.root) : filesRoot()
  const files = await walkFiles(root3)
  const totalBytes = files.reduce((acc, item) => acc + item.bytes, 0)
  const ordered = files.slice().sort((a, b) => b.mtimeMs - a.mtimeMs)
  const limit = Number(options.limit) > 0 ? Math.floor(Number(options.limit)) : 200
  return {
    ok: true,
    root: root3,
    count: files.length,
    totalBytes,
    totalHuman: humanSize(totalBytes),
    items: ordered.slice(0, limit).map((item) => ({
      path: item.path,
      name: path.basename(item.path),
      day: item.day,
      bytes: item.bytes,
      human: humanSize(item.bytes),
      at: new Date(item.mtimeMs).toISOString(),
    })),
  }
}

/**
 * 从用户配置里读出下载策略。
 *
 * 三个键放**配置顶层**而不是账号层：它们是「本机硬盘怎么用」，
 * 不是「某个通道的偏好」。放账号层会让 12 个通道各配一遍，
 * 而实际上你只有一块硬盘。
 *
 * 读不到就给默认值 —— 这是可选项，缺了不该让收消息失败。
 */
export function policyFromConfig(cfg) {
  const raw = cfg?.download && typeof cfg.download === 'object' ? cfg.download : {}
  return {
    maxFileMB: normalizeMaxFileMB(raw.maxFileMB).value,
    retainDays: normalizeRetainDays(raw.retainDays).value,
    maxTotalMB: normalizeMaxTotalMB(raw.maxTotalMB).value,
  }
}

/** 策略快照：三个可配项归一化后的值 + 夹值说明，给界面与工具展示。 */
export function strategyOf(options = {}) {
  const file = normalizeMaxFileMB(options.maxFileMB)
  const retain = normalizeRetainDays(options.retainDays)
  const total = normalizeMaxTotalMB(options.maxTotalMB)
  return {
    ok: true,
    root: filesRoot(),
    maxFileMB: file.value,
    retainDays: retain.value,
    maxTotalMB: total.value,
    defaults: { maxFileMB: DEFAULT_MAX_FILE_MB, retainDays: DEFAULT_RETAIN_DAYS, maxTotalMB: DEFAULT_MAX_TOTAL_MB },
    notes: [file.detail, retain.detail, total.detail].filter((one) => one !== ''),
    canDownload: CAN_DOWNLOAD,
    reasons: NO_DOWNLOAD_REASON,
  }
}