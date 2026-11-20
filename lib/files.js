/**
 * lib/files.js — 发文件的地基：读本地文件、猜 MIME、按通道上限把关。
 *
 * 为什么单独一个模块而不是塞进 http.js：读盘、判类型、判大小是「业务规则」
 * （每个平台的上限不一样），而 http.js 只该管「怎么把字节发出去」。分开之后
 * 探针可以只测这里，不用碰网络。
 *
 * 三条纪律：
 *   1. **永不抛**。读不到、太大、类型不认识，一律变成 { ok:false, detail }。
 *      通道实现按约定不该抛异常，这里先守住第一道。
 *   2. **不猜平台上限**。上限表写死在这里并注明来源；不认识的文件类型给
 *      application/octet-stream，不硬编一个看起来像对的。
 *   3. **只读绝对路径**。相对路径一律拒绝 —— 插件的 cwd 是 DSH 的，不是
 *      用户以为的那个目录，静默按 cwd 解析会读到一个同名但不相干的文件。
 *
 * @module files
 */

import fs from 'node:fs'
import path from 'node:path'

/** 各平台单文件上限（字节）。数值来自各家官方文档，注释里标了出处。 */
export const PLATFORM_LIMIT = Object.freeze({
  telegram: 50 * 1024 * 1024,      // Bot API sendDocument 上限 50 MB
  discord: 25 * 1024 * 1024,       // 未 Boost 服务器 25 MB（老服务器 8 MB，按宽的算）
  slack: 1024 * 1024 * 1024,       // files.getUploadURLExternal 上限 1 GB
  matrix: 50 * 1024 * 1024,        // 由 homeserver 的 maxUploadSize 决定，这里给保守值
  email: 25 * 1024 * 1024,         // 各家邮箱附件普遍 25 MB 封顶
})

/** 常见扩展名 → MIME。够用即可，认不出就 application/octet-stream。 */
const MIME_BY_EXT = Object.freeze({
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.log': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.ts': 'text/typescript',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.apk': 'application/vnd.android.package-archive',
})

/**
 * 按扩展名猜 MIME。认不出返回 application/octet-stream（不是空串）。
 * @param {string} filePath
 */
export function guessMime(filePath) {
  const ext = path.extname(String(filePath ?? '')).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

/** 图片类走「发图片」而不是「发文件」更符合平台习惯（Telegram 会渲染缩略图）。 */
export function isImageMime(mediaType) {
  return String(mediaType ?? '').toLowerCase().startsWith('image/')
}

/** 人话的大小：1536 → 1.5 KB。 */
export function humanSize(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return '?'
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}

/**
 * 读一个本地文件，准备发出去。
 *
 * @param {string} filePath 必须是绝对路径
 * @param {{channel?: string, maxBytes?: number}} [options] channel 用于查该平台上限
 * @returns {{ok: true, file: {fileName: string, bytes: Buffer, mediaType: string, size: number, path: string}}
 *          | {ok: false, detail: string}}
 */
export function readForSend(filePath, options = {}) {
  const raw = String(filePath ?? '').trim()
  if (raw === '') return { ok: false, detail: '没给文件路径' }
  if (!path.isAbsolute(raw)) {
    return { ok: false, detail: '要绝对路径（现在的相对路径是按 DSH 的工作目录算的，很容易读到一个同名但不相干的文件）：' + raw }
  }
  let stat
  try {
    stat = fs.statSync(raw)
  } catch (error) {
    return { ok: false, detail: '读不到这个文件：' + String(error?.message ?? error) }
  }
  if (!stat.isFile()) return { ok: false, detail: '这不是一个普通文件（目录 / 设备 / 符号链接？）：' + raw }
  if (stat.size === 0) return { ok: false, detail: '这个文件是空的（0 字节），发出去对方也看不到内容：' + raw }

  const platform = String(options.channel ?? '').trim()
  const platformLimit = PLATFORM_LIMIT[platform]
  const limit = Number.isFinite(Number(options.maxBytes)) && Number(options.maxBytes) > 0
    ? Number(options.maxBytes)
    : platformLimit
  if (Number.isFinite(limit) && stat.size > limit) {
    return {
      ok: false,
      detail: '文件太大：' + humanSize(stat.size) + '，' + (platform === '' ? '上限' : platform + ' 的上限') + '是 ' + humanSize(limit),
    }
  }

  let bytes
  try {
    bytes = fs.readFileSync(raw)
  } catch (error) {
    return { ok: false, detail: '读文件内容失败：' + String(error?.message ?? error) }
  }
  return {
    ok: true,
    file: {
      fileName: path.basename(raw),
      bytes,
      mediaType: guessMime(raw),
      size: bytes.byteLength,
      path: raw,
    },
  }
}
