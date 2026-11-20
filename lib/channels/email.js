/**
 * lib/channels/email.js — 邮件（SMTP 发送）。
 *
 * 为什么不在本插件里手写 SMTP：要正确实现 STARTTLS、AUTH LOGIN/PLAIN/XOAUTH2、
 * 多收件人、中文主题的 MIME 编码、长正文的 quoted-printable，工作量远大于收益，
 * 而且稍微漏一点就会被各家邮箱判成垃圾邮件。所以用现成的 nodemailer。
 *
 * 取依赖走 lib/deps.js（v0.31.0 起）：先查插件自身的 node_modules，再回落 DSH
 * profile。顺序不能反 —— 反了的话用户装了插件自带版本也白装。解析不到时如实
 * 报错并告诉你装什么，而不是抛一个看不懂的 ERR_MODULE_NOT_FOUND。
 *
 * 只做发送，不做接收：收信要 IMAP 长连接 + 邮件线程归并 + 附件落盘，
 * 那是 dsh-im 那套「对话式机器人」的活，不属于推送中枢。
 *
 * @module channels/email
 */

import { tryRequire, missingText } from '../deps.js'

export const NAME = 'email'
export const MAX_CHARS = 100000
export const TITLE = '邮件'

/** 记住已解析过的 nodemailer，避免每次发信都走一遍依赖解析。 */
let cachedNodemailer = null
let cachedError = ''

/**
 * 取 nodemailer；取不到时返回 null 并把原因记在 cachedError。
 *
 * v0.31.0 起走 lib/deps.js：先查插件自身的 node_modules，再回落 DSH profile。
 * 顺序不能反 —— 反了的话用户装了插件自带版本也白装。
 */
function loadNodemailer() {
  if (cachedNodemailer !== null) return cachedNodemailer
  if (cachedError !== '') return null
  try {
    const loaded = tryRequire('nodemailer')
    if (!loaded.ok) {
      cachedError = '插件自身的 node_modules 与 DSH profile 里都没有 nodemailer'
      return null
    }
    cachedNodemailer = loaded.mod?.default ?? loaded.mod
    return cachedNodemailer
  } catch (error) {
    cachedError = String(error?.message ?? error)
    return null
  }
}

/** 端口对应的默认加密方式：465 直连 TLS，587/25 用 STARTTLS。 */
function securityOf(port, explicit) {
  if (explicit === true || explicit === 'ssl' || explicit === 'tls') return { secure: true }
  if (explicit === false || explicit === 'starttls') return { secure: false }
  return { secure: port === 465 }
}

/**
 * 发一条消息。
 *
 * 邮件跟别的通道不同：一封就是一封，不做分块 —— 正文长一点完全没问题，
 * 把它切成几封反而会让收件人收到一堆碎片。
 *
 * @param {string} text
 * @param {Record<string,any>} acc
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
export async function send(text, acc) {
  const nodemailer = loadNodemailer()
  if (nodemailer === null) {
    return { ok: false, detail: '找不到 nodemailer：' + missingText('nodemailer') + '原始错误：' + cachedError.slice(0, 160) }
  }
  const host = String(acc?.smtpHost ?? acc?.host ?? '').trim()
  if (host === '') return { ok: false, detail: '账号缺少 SMTP 服务器地址（例 smtp.qq.com）' }
  const port = Number(acc?.smtpPort ?? acc?.port ?? 465)
  const user = String(acc?.user ?? acc?.username ?? acc?.from ?? '').trim()
  const pass = String(acc?.pass ?? acc?.password ?? acc?.smtpPassword ?? '').trim()
  const from = String(acc?.from ?? user).trim()
  if (from === '') return { ok: false, detail: '账号缺少发件人地址（From）' }
  const to = String(acc?.target?.id ?? acc?.to ?? '').trim()
  if (to === '') {
    return { ok: false, detail: '还没填「发送到」。邮件要收件人地址（形如 someone@example.com）。凭据本身没问题。' }
  }
  const subject = String(acc?.subject ?? '来自推送中枢的消息')
  const { secure } = securityOf(port, acc?.secure)

  const transport = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user === '' ? undefined : { user, pass },
    // 自签证书的内网邮件服务器很常见，但默认不放行 —— 要放行得显式打开。
    tls: acc?.allowSelfSigned === true ? { rejectUnauthorized: false } : undefined,
    connectionTimeout: 20000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  })

  try {
    const info = await transport.sendMail({ from, to, subject, text })
    // v0.28.0：邮件的 messageId 是 RFC 5322 的 Message-ID（形如 <xxx@host>），
    // 它只能用来在邮箱里查这封信，不能改也不能撤 —— 但留痕仍然有用。
    const mid = String(info?.messageId ?? '').trim()
    return { ok: true, detail: '已发送 1 封（收件人 ' + to + '，messageId ' + (mid === '' ? '?' : mid) + '）', messageIds: mid === '' ? [] : [mid] }
  } catch (error) {
    return { ok: false, detail: '发送失败: ' + explainSmtp(error) }
  } finally {
    try { transport.close() } catch {}
  }
}

/**
 * 发一封带附件的邮件。
 *
 * 为什么不做成「先发正文再发附件」两封：邮件客户端会把它们拆成两个线程，
 * 收件人看到的是「一条消息 + 一个孤立附件」，不如一封带附件清楚。
 * caption 当正文，没给 caption 就用文件名当正文，保证正文非空（空正文的邮件
 * 很容易被当垃圾邮件）。
 *
 * @param {{fileName: string, bytes: Buffer|Uint8Array, mediaType?: string}} file
 * @param {Record<string,any>} acc
 * @param {{caption?: string}} [options]
 */
export async function sendFile(file, acc, options = {}) {
  const nodemailer = loadNodemailer()
  if (nodemailer === null) {
    return { ok: false, detail: '找不到 nodemailer：' + missingText('nodemailer') + '原始错误：' + cachedError.slice(0, 160) }
  }
  if (!file || typeof file !== 'object' || typeof file.fileName !== 'string' || file.fileName === '') {
    return { ok: false, detail: '没有可发的文件（缺少文件名）' }
  }
  const host = String(acc?.smtpHost ?? acc?.host ?? '').trim()
  if (host === '') return { ok: false, detail: '账号缺少 SMTP 服务器地址（例 smtp.qq.com）' }
  const port = Number(acc?.smtpPort ?? acc?.port ?? 465)
  const user = String(acc?.user ?? acc?.username ?? acc?.from ?? '').trim()
  const pass = String(acc?.pass ?? acc?.password ?? acc?.smtpPassword ?? '').trim()
  const from = String(acc?.from ?? user).trim()
  if (from === '') return { ok: false, detail: '账号缺少发件人地址（From）' }
  const to = String(acc?.target?.id ?? acc?.to ?? '').trim()
  if (to === '') {
    return { ok: false, detail: '还没填「发送到」。邮件要收件人地址（形如 someone@example.com）。凭据本身没问题。' }
  }
  const subject = String(acc?.subject ?? '来自推送中枢的消息')
  const { secure } = securityOf(port, acc?.secure)

  const transport = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user === '' ? undefined : { user, pass },
    tls: acc?.allowSelfSigned === true ? { rejectUnauthorized: false } : undefined,
    connectionTimeout: 20000,
    greetingTimeout: 15000,
    socketTimeout: 60000,
  })

  const caption = String(options.caption ?? '').trim()
  try {
    const info = await transport.sendMail({
      from,
      to,
      subject,
      text: caption === '' ? '附件：' + file.fileName : caption,
      attachments: [{
        filename: file.fileName,
        content: Buffer.isBuffer(file.bytes) ? file.bytes : Buffer.from(file.bytes ?? []),
        contentType: file.mediaType || 'application/octet-stream',
      }],
    })
    return { ok: true, detail: '已发送 1 封带附件「' + file.fileName + '」（收件人 ' + to + '，messageId ' + String(info?.messageId ?? '?') + '）' }
  } catch (error) {
    return { ok: false, detail: '发送失败: ' + explainSmtp(error) }
  } finally {
    try { transport.close() } catch {}
  }
}

/** 把 SMTP 的常见错误翻成人话（nodemailer 的 error.code 是标准 SMTP 码）。 */
function explainSmtp(error) {
  const code = String(error?.code ?? '')
  const raw = String(error?.response ?? error?.message ?? error)
  const known = new Map([
    ['EAUTH', '登录被拒：账号或授权码不对（多数邮箱要求填「授权码」而不是登录密码）'],
    ['ESOCKET', '连不上 SMTP 服务器：地址/端口错了，或者被防火墙/代理挡住'],
    ['ETIMEDOUT', '连 SMTP 服务器超时（20 秒）'],
    ['EDNS', '域名解析失败，检查 SMTP 服务器地址'],
    ['EENVELOPE', '收件人地址被服务器拒了（格式错或对方不存在）'],
    ['EMESSAGE', '邮件内容被服务器拒了'],
  ])
  const hit = known.get(code)
  if (hit !== undefined) return hit + '（' + code + '）' + (raw.includes('535') ? '；535 = 认证失败' : '')
  return code === '' ? raw.slice(0, 200) : raw.slice(0, 200) + '（' + code + '）'
}

/** 探测：连上 SMTP 并 verify() 一次，不真的发信。 */
export async function probe(acc) {
  const nodemailer = loadNodemailer()
  if (nodemailer === null) {
    return { ok: false, detail: '找不到 nodemailer（借用 DSH profile 里的那份），错误：' + cachedError.slice(0, 160) }
  }
  const host = String(acc?.smtpHost ?? acc?.host ?? '').trim()
  if (host === '') return { ok: false, detail: '缺少 SMTP 服务器地址（例 smtp.qq.com）' }
  const port = Number(acc?.smtpPort ?? acc?.port ?? 465)
  const user = String(acc?.user ?? acc?.username ?? acc?.from ?? '').trim()
  const pass = String(acc?.pass ?? acc?.password ?? acc?.smtpPassword ?? '').trim()
  const { secure } = securityOf(port, acc?.secure)
  const transport = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user === '' ? undefined : { user, pass },
    tls: acc?.allowSelfSigned === true ? { rejectUnauthorized: false } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  })
  try {
    await transport.verify()
    return { ok: true, detail: 'SMTP 登录可用（' + host + ':' + port + (secure ? ' TLS' : ' STARTTLS') + '）' }
  } catch (error) {
    return { ok: false, detail: 'SMTP 不可用: ' + explainSmtp(error) }
  } finally {
    try { transport.close() } catch {}
  }
}