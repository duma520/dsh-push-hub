/**
 * lib/http.js — 极简 HTTP 客户端，失败一律变返回值、绝不抛异常。
 *
 * 契约与 Python 版 pushhub/httpc.py 完全一致：
 *   { status: 200, body: '...' }   拿到了 HTTP 响应（含 4xx / 5xx）
 *   { status: null, body: '...' }  连不上（超时 / DNS / 代理不通），body 是异常描述
 *
 * 为什么要自己处理代理：
 *   本机直连 api.telegram.org 必然超时，telegram 通道必须走 dsh-bridge 配置里
 *   该账号的 proxy 字段（形如 http://192.168.x.x:20808）。
 *   而 Node 的全局 fetch（undici）不暴露 dispatcher，没法在不引入额外依赖的
 *   前提下挂代理。所以这里做了两条路：
 *     直连 → 全局 fetch
 *     代理 → 先向代理发 CONNECT 打通隧道，再在隧道上做 TLS，最后把这条
 *            已经加密的 socket 交给 node:http 的客户端 —— HTTP 报文解析、
 *            chunked 解码、超时全部复用 Node 自己的实现。
 *
 * @module http
 */

import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'

/** 默认超时（毫秒），与 Python 版 DEFAULT_TIMEOUT = 25 秒一致。 */
export const DEFAULT_TIMEOUT = 25000

/**
 * POST 一个 JSON 请求体。
 * @param {string} url
 * @param {unknown} payload 会被 JSON.stringify；传 null / undefined 表示无请求体
 * @param {{headers?: Record<string,string>, proxy?: string, timeoutMs?: number}} [options]
 * @returns {Promise<{status: number|null, body: string}>}
 */
export function postJson(url, payload, options = {}) {
  const body = payload === undefined || payload === null ? null : JSON.stringify(payload)
  return request(url, { ...options, method: 'POST', body, contentType: 'application/json; charset=utf-8' })
}

/**
 * POST 一个 application/x-www-form-urlencoded 请求体。
 * 群晖 Chat 的 incoming webhook 吃这个格式：payload=<json 字符串>。
 */
export function postForm(url, fields, options = {}) {
  const body = new URLSearchParams(fields).toString()
  return request(url, { ...options, method: 'POST', body, contentType: 'application/x-www-form-urlencoded; charset=utf-8' })
}

/** GET 一个 URL。 */
export function getJson(url, options = {}) {
  return request(url, { ...options, method: 'GET' })
}

/**
 * 统一入口。任何异常都会被收敛成 { status: null, body: 描述 }。
 */
export async function request(url, options = {}) {
  const {
    method = 'POST',
    body = null,
    contentType = 'application/json; charset=utf-8',
    headers = {},
    proxy = '',
    timeoutMs = DEFAULT_TIMEOUT,
    // v0.36.0：下载附件要的是字节，不是 utf8 文本。
    // 默认 false 保持不变 —— 12 个通道发消息全走文本，改默认值会波及所有既有调用。
    binary = false,
    // 超过这个字节数就不收（0 = 不限）。放在传输层而不是调用方事后判断，
    // 是因为「先下完再检查大小」等于白白把 500 MB 拉进内存才发现超限。
    maxBytes = 0,
    // v0.39.0：外部取消。接收循环 stop 时要能立刻掐断还挂在平台上的长轮询，
    // 否则 abort() 只是设了个标志，请求照样在飞 —— 重新 start 时新旧两条并存，
    // Telegram 就回 409。传进来的是 AbortSignal。
    signal = null,
  } = options

  let target
  try {
    target = new URL(url)
  } catch {
    return { status: null, body: 'URL 非法: ' + String(url) }
  }

  const finalHeaders = { ...headers }
  if (body !== null && body !== undefined) {
    const hasType = Object.keys(finalHeaders).some((key) => key.toLowerCase() === 'content-type')
    if (!hasType) finalHeaders['Content-Type'] = contentType
    finalHeaders['Content-Length'] = String(Buffer.byteLength(body, 'utf8'))
  }

  try {
    const useProxy = typeof proxy === 'string' && proxy.trim() !== ''
    if (!useProxy) return await direct(target, method, body, finalHeaders, timeoutMs, binary, maxBytes, signal)
    return await viaProxy(target, method, body, finalHeaders, proxy.trim(), timeoutMs, binary, maxBytes, signal)
  } catch (error) {
    return { status: null, body: (error?.name ?? 'Error') + ': ' + (error?.message ?? String(error)) }
  }
}

/** 宽容 JSON 解析：失败返回 fallback，永不抛。 */
export function parseJson(text, fallback = null) {
  try {
    const value = JSON.parse(text)
    return value === undefined ? fallback : value
  } catch {
    return fallback
  }
}

/* ------------------------------------------------------------------ *
 * 直连：Node 18+ 的全局 fetch，超时用 AbortController 控。
 * ------------------------------------------------------------------ */
async function direct(target, method, body, headers, timeoutMs, binary = false, maxBytes = 0, outerSignal = null) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  // v0.39.0：外部取消也接到同一个 controller 上 —— fetch 只认一个 signal，
  // 两个来源（超时 / 上层 abort）必须汇到一处，否则上层 abort 打不断请求。
  const onOuterAbort = () => controller.abort()
  if (outerSignal !== null && outerSignal !== undefined) {
    if (outerSignal.aborted) controller.abort()
    else outerSignal.addEventListener('abort', onOuterAbort, { once: true })
  }
  try {
    const response = await fetch(target, {
      method,
      headers,
      body: body === null || body === undefined ? undefined : body,
      signal: controller.signal,
      redirect: 'follow',
    })
    if (!binary) return { status: response.status, body: await response.text() }
    // 先看声明的大小：有 Content-Length 且超限时一个字节都不读。
    const declared = Number(response.headers.get('content-length') ?? '0')
    const type = String(response.headers.get('content-type') ?? '')
    if (maxBytes > 0 && Number.isFinite(declared) && declared > maxBytes) {
      try {
        await response.body?.cancel()
      } catch {
        /* 已取消或本来就没有 body */
      }
      return { status: response.status, bytes: null, tooLarge: true, declared, contentType: type }
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (maxBytes > 0 && buffer.byteLength > maxBytes) {
      return { status: response.status, bytes: null, tooLarge: true, declared: buffer.byteLength, contentType: type }
    }
    return { status: response.status, bytes: buffer, tooLarge: false, declared: buffer.byteLength, contentType: type }
  } catch (error) {
    return { status: null, body: (error?.name ?? 'Error') + ': ' + (error?.message ?? String(error)) }
  } finally {
    clearTimeout(timer)
    if (outerSignal !== null && outerSignal !== undefined) {
      outerSignal.removeEventListener?.('abort', onOuterAbort)
    }
  }
}

/* ------------------------------------------------------------------ *
 * 走代理：CONNECT 隧道 + TLS + 复用 node:http 的报文解析。
 * ------------------------------------------------------------------ */
async function viaProxy(target, method, body, headers, proxyUrl, timeoutMs, binary = false, maxBytes = 0, outerSignal = null) {
  const proxy = new URL(proxyUrl.includes('://') ? proxyUrl : 'http://' + proxyUrl)
  const host = target.hostname
  const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80))

  // 只有 https 目标需要 TLS；http 目标直接走裸隧道。
  const isHttps = target.protocol === 'https:'
  const socket = await openTunnel(proxy, host, port, timeoutMs)
  const connection = isHttps ? await wrapTls(socket, host, timeoutMs) : socket

  // 关键：绝不能传 agent: false —— node:http 会把 "新建一个 Agent" 当成默认行为，
  // 于是忽略 createConnection，回落到直连目标 IP（实测报 connect ETIMEDOUT <目标IP>:443）。
  // 正确做法：自建一个不 keep-alive 的 Agent，把 createConnection 钉在它身上。
  const agent = new http.Agent({ keepAlive: false })
  agent.createConnection = () => connection

  return await new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (outerSignal !== null && outerSignal !== undefined) {
        outerSignal.removeEventListener?.('abort', onAbort)
      }
      resolve(value)
    }
    const timer = setTimeout(() => {
      connection.destroy()
      finish({ status: null, body: 'TimeoutError: 请求超时 ' + timeoutMs + 'ms' })
    }, timeoutMs)

    // v0.39.0：外部取消。**必须真的把隧道掐掉**，不是只让 Promise 提前 resolve ——
    // 后者会让平台侧那条 getUpdates 继续挂着（最长 10 秒），下次 start 进来就撞 409。
    // 返回体用固定串，调用方据此知道不是平台回的错误。
    const onAbort = () => {
      connection.destroy()
      finish({ status: null, body: 'AbortError: 请求已被上层取消' })
    }
    if (outerSignal !== null && outerSignal !== undefined) {
      if (outerSignal.aborted) onAbort()
      else outerSignal.addEventListener('abort', onAbort, { once: true })
    }

    const request = http.request(
      {
        host,
        port,
        method,
        path: (target.pathname || '/') + (target.search || ''),
        headers: { ...headers, Host: host, Connection: 'close' },
        agent,
      },
      (response) => {
        const chunks = []
        const type = String(response.headers?.['content-type'] ?? '')
        let total = 0
        let overLimit = false
        response.on('data', (chunk) => {
          const piece = Buffer.from(chunk)
          total += piece.byteLength
          // 数据边到边算：不能等都收完再比，那样内存已经被撑爆了。
          if (maxBytes > 0 && total > maxBytes) {
            overLimit = true
            response.destroy()
            finish({ status: response.statusCode ?? null, bytes: null, tooLarge: true, declared: total, contentType: type })
            return
          }
          chunks.push(piece)
        })
        response.on('end', () => {
          if (overLimit) return
          const buffer = Buffer.concat(chunks)
          if (!binary) return finish({ status: response.statusCode ?? null, body: buffer.toString('utf8') })
          finish({ status: response.statusCode ?? null, bytes: buffer, tooLarge: false, declared: buffer.byteLength, contentType: type })
        })
        response.on('error', (error) => finish({ status: null, body: String(error?.message ?? error) }))
      },
    )
    request.on('error', (error) => finish({ status: null, body: (error?.name ?? 'Error') + ': ' + (error?.message ?? String(error)) }))
    request.end(body === null || body === undefined ? undefined : body)
  })
}

/** 向代理发 CONNECT，成功后拿回裸 socket。 */
function openTunnel(proxy, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const headers = {}
    if (proxy.username) {
      const user = decodeURIComponent(proxy.username)
      const pass = decodeURIComponent(proxy.password || '')
      headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(user + ':' + pass, 'utf8').toString('base64')
    }
    const request = http.request({
      host: proxy.hostname,
      port: Number(proxy.port || 80),
      method: 'CONNECT',
      path: host + ':' + port,
      headers,
      timeout: timeoutMs,
    })
    request.once('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        reject(new Error('代理 CONNECT 返回 ' + response.statusCode))
        return
      }
      resolve(socket)
    })
    request.once('timeout', () => request.destroy(new Error('代理 CONNECT 超时')))
    request.once('error', reject)
    request.end()
  })
}

/** 在已打通的隧道上做 TLS 握手。 */
function wrapTls(socket, host, timeoutMs) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: host }, () => resolve(secure))
    secure.setTimeout(timeoutMs, () => reject(new Error('TLS 握手超时')))
    secure.once('error', reject)
  })
}

/* ------------------------------------------------------------------ *
 * multipart/form-data：发文件要用。
 *
 * 为什么手写而不用全局 FormData：走代理那条路最后是 http.request + 自己拼
 * headers，FormData 对象拿不到「已经序列化好的字节」。手写一份 Buffer 之后，
 * 直连（fetch）和代理（http.request）两条路吃的是同一个 body，不会出现
 * 「直连能发、走代理发出去的是空文件」这种只有特定用户才踩得到的分裂。
 * ------------------------------------------------------------------ */

/** 生成一个足够随机的 boundary；碰撞概率可忽略，不追求密码学强度。 */
function makeBoundary() {
  return '----dshpushhub' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

/**
 * 把一个字段值转成 multipart 里的字节。Buffer / Uint8Array 原样，其余按 UTF-8 文本。
 * @param {unknown} value
 */
function toBytes(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  return Buffer.from(String(value ?? ''), 'utf8')
}

/** RFC 7578：文件名里的引号与换行必须转义，否则会把 header 撕开。 */
function escapeFilename(name) {
  return String(name ?? 'file').replace(/["\r\n]/g, '_')
}

/**
 * 拼一个 multipart/form-data 请求体。
 *
 * @param {Record<string, unknown>} fields 普通文本字段，值为数组时重复出现
 * @param {{field: string, fileName: string, bytes: Buffer|Uint8Array, mediaType?: string}} file 单个文件
 * @returns {{body: Buffer, contentType: string}}
 */
export function buildMultipart(fields, file) {
  const boundary = makeBoundary()
  const chunks = []
  for (const [key, raw] of Object.entries(fields ?? {})) {
    if (raw === undefined || raw === null) continue
    const values = Array.isArray(raw) ? raw : [raw]
    for (const value of values) {
      chunks.push(Buffer.from('--' + boundary + '\r\n', 'utf8'))
      chunks.push(Buffer.from('Content-Disposition: form-data; name="' + key + '"\r\n\r\n', 'utf8'))
      chunks.push(toBytes(value))
      chunks.push(Buffer.from('\r\n', 'utf8'))
    }
  }
  if (file && typeof file === 'object') {
    chunks.push(Buffer.from('--' + boundary + '\r\n', 'utf8'))
    chunks.push(Buffer.from(
      'Content-Disposition: form-data; name="' + file.field + '"; filename="' + escapeFilename(file.fileName) + '"\r\n',
      'utf8',
    ))
    chunks.push(Buffer.from('Content-Type: ' + (file.mediaType || 'application/octet-stream') + '\r\n\r\n', 'utf8'))
    chunks.push(toBytes(file.bytes))
    chunks.push(Buffer.from('\r\n', 'utf8'))
  }
  chunks.push(Buffer.from('--' + boundary + '--\r\n', 'utf8'))
  return { body: Buffer.concat(chunks), contentType: 'multipart/form-data; boundary=' + boundary }
}

/**
 * POST 一个 multipart/form-data 请求（一个文本字段集 + 一个文件）。
 *
 * @param {string} url
 * @param {Record<string, unknown>} fields
 * @param {{field: string, fileName: string, bytes: Buffer|Uint8Array, mediaType?: string}} file
 * @param {{headers?: Record<string,string>, proxy?: string, timeoutMs?: number}} [options]
 * @returns {Promise<{status: number|null, body: string}>}
 */
export function postMultipart(url, fields, file, options = {}) {
  const { body, contentType } = buildMultipart(fields, file)
  // 发文件比发文本慢得多，默认超时给到 3 分钟；调用方仍可显式覆盖。
  return request(url, { ...options, method: 'POST', body, contentType, timeoutMs: options.timeoutMs ?? 180000 })
}

/** 裸字节 POST（Slack 的 upload_url 要的是原始文件内容，不是 multipart）。 */
export function postBytes(url, bytes, contentType, options = {}) {
  return request(url, {
    ...options,
    method: 'POST',
    body: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []),
    contentType: contentType || 'application/octet-stream',
    timeoutMs: options.timeoutMs ?? 180000,
  })
}

/**
 * GET 一个 URL 并拿回**字节**（v0.36.0：下载附件用）。
 *
 * 为什么不复用 getJson：它会 body.toString('utf8')。一张 JPEG 这样转一遍，
 * 落盘出来的文件百分百打不开 —— 二进制里的 0x80~0xFF 会被替换成 U+FFFD。
 *
 * @param {string} url
 * @param {{headers?: Record<string,string>, proxy?: string, timeoutMs?: number, maxBytes?: number}} [options]
 * @returns {Promise<{status: number|null, bytes: Buffer|null, tooLarge?: boolean, declared?: number, contentType?: string, body?: string}>}
 */
export function getBytes(url, options = {}) {
  return request(url, { ...options, method: 'GET', binary: true, timeoutMs: options.timeoutMs ?? 180000 })
}

/** 仅供调试：列出本文件导出的能力。 */
export const CAPABILITIES = { direct: true, proxyTunnel: true, form: true, multipart: true, bytes: true, binary: true }
