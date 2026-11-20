/**
 * lib/ws.js — 走代理的 WebSocket（v0.19.0 新增）。
 *
 * 为什么需要单独一层：Slack Socket Mode 与 Discord Gateway 都是 WebSocket 长连接，
 * 而 **Node 内置的 WebSocket（undici 的 globalThis.WebSocket）不接受 dispatcher 参数**，
 * 直连 wss://gateway.discord.gg 在本机实测失败（error 事件、message 为空）。
 * 实测能通的做法是从 DSH profile 借 `undici`，自己给它一个 ProxyAgent：
 *
 *   new undici.WebSocket(url, { dispatcher: new undici.ProxyAgent('http://…') })
 *
 * 这与 lib/http.js 的取舍一致（那边为了走代理手写了 CONNECT 隧道），本质是同一个原因：
 * 本机出网必须走代理，而全局对象不给注入点。
 *
 * 依赖解析走 lib/deps.js（v0.31.0 起）：先查插件自身 node_modules，再回落 profile。
 * 取不到确实时返回 null + 中文原因，**不抛 ERR_MODULE_NOT_FOUND** ——
 * 与飞书取 SDK 的约定一致：取不到只回原因，界面照常显示。
 *
 * @module ws
 */

import { tryRequire } from './deps.js'

let cachedUndici = null
let cachedUndiciError = ''

/**
 * 取 undici（提供 WebSocket 与 ProxyAgent）。
 * @returns {object|null} 取不到返回 null，原因在 undiciError()
 */
export function loadUndici() {
  if (cachedUndici !== null) return cachedUndici
  if (cachedUndiciError !== '') return null
  try {
    const loaded = tryRequire('undici')
    if (!loaded.ok) {
      cachedUndiciError = '插件自身的 node_modules 与 DSH profile 里都没有 undici'
      return null
    }
    const mod = loaded.mod
    if (typeof mod?.WebSocket !== 'function' || typeof mod?.ProxyAgent !== 'function') {
      cachedUndiciError = '找到的 undici 缺少 WebSocket 或 ProxyAgent（版本不对）'
      return null
    }
    cachedUndici = mod
    return mod
  } catch (error) {
    cachedUndiciError = String(error?.message ?? error)
    return null
  }
}

/** 上一次 loadUndici() 失败的原因（成功时为空串）。 */
export function undiciError() {
  return cachedUndiciError
}

/**
 * 建一条 WebSocket。给了 proxy 就走代理，没给就直连（内网可能通）。
 *
 * @param {string} url wss:// 地址
 * @param {{proxy?: string}} [options]
 * @returns {{ok: true, socket: object, mode: string} | {ok: false, detail: string}}
 */
export function openSocket(url, options = {}) {
  const target = String(url ?? '')
  if (!/^wss:\/\//i.test(target)) {
    return { ok: false, detail: '只接受 wss:// 地址，收到：' + target.slice(0, 80) }
  }
  const undici = loadUndici()
  if (undici === null) {
    return { ok: false, detail: 'WebSocket 要用 profile 里的 undici，没借到：' + cachedUndiciError.slice(0, 160) }
  }
  const proxy = String(options?.proxy ?? '').trim()
  try {
    const socket = proxy === ''
      ? new undici.WebSocket(target)
      : new undici.WebSocket(target, { dispatcher: new undici.ProxyAgent(proxy) })
    return { ok: true, socket, mode: proxy === '' ? 'direct' : 'proxy' }
  } catch (error) {
    return { ok: false, detail: '建立 WebSocket 失败：' + String(error?.message ?? error).slice(0, 200) }
  }
}

/**
 * 把 undici WebSocket 的事件包一层，统一成 (data) => void。
 * undici 的 socket 同时支持 addEventListener 与 on，这里优先用前者。
 *
 * @returns {() => void} 解绑函数
 */
export function onSocket(socket, event, listener) {
  if (typeof socket?.addEventListener === 'function') {
    socket.addEventListener(event, listener)
    return () => { try { socket.removeEventListener(event, listener) } catch { /* 已关闭 */ } }
  }
  if (typeof socket?.on === 'function') {
    socket.on(event, listener)
    return () => { try { socket.off?.(event, listener) } catch { /* 已关闭 */ } }
  }
  return () => {}
}

/** 从 WebSocket 事件里取字符串载荷（undici 给 data 字符串，别的地方可能是 Buffer）。 */
export function eventText(event) {
  if (typeof event === 'string') return event
  if (typeof event?.data === 'string') return event.data
  if (Buffer.isBuffer(event)) return event.toString('utf8')
  if (Buffer.isBuffer(event?.data)) return event.data.toString('utf8')
  if (event?.data instanceof ArrayBuffer) return Buffer.from(event.data).toString('utf8')
  return ''
}

/** 安全关闭（未连上时 close 会抛）。 */
export function closeSocket(socket, code = 1000, reason = '') {
  try { socket?.close?.(code, reason) } catch { /* 忽略 */ }
}
