/**
 * lib/mentions.js — 「发给谁」与「@ 谁」的公共解析层。
 *
 * 为什么单独一层：五个通道的发送目标与 @ 语法各不相同，但**判断逻辑一致**——
 * 先看账号有没有显式 target，没有就回落到 allowFrom[0]（dsh-bridge 的老字段，
 * 不改它才不会破坏既有账号）。把这段判断集中在这里，通道实现里就只剩拼字符串。
 *
 * 账号可选的两个新字段（都非必填，缺了就是老行为）：
 *   target:  { kind: 'user' | 'group', id: '<平台侧 ID>' }
 *   mention: { mode: 'none' | 'user' | 'all', userIds: ['<平台侧用户 ID>'] }
 *
 * @module mentions
 */

/**
 * 解析这条消息该发到哪个会话。
 *
 * @param {Record<string,any>} acc 单个通道账号
 * @returns {{kind: 'user'|'group'|'auto', id: string} | null}
 */
export function targetOf(acc) {
  const t = acc?.target
  if (t !== null && typeof t === 'object') {
    const id = String(t.id ?? '').trim()
    if (id !== '') {
      const kind = t.kind === 'group' ? 'group' : t.kind === 'user' ? 'user' : 'auto'
      return { kind, id }
    }
  }
  const list = Array.isArray(acc?.allowFrom) ? acc.allowFrom : []
  const id = list.length > 0 ? String(list[0]).trim() : ''
  return id === '' ? null : { kind: 'auto', id }
}

/**
 * 解析这条消息要 @ 谁。
 *
 * @param {Record<string,any>} acc
 * @returns {{mode: 'none'|'user'|'all', ids: string[]}}
 */
export function mentionOf(acc) {
  const m = acc?.mention
  const mode = m?.mode
  if (mode !== 'user' && mode !== 'all') return { mode: 'none', ids: [] }
  const ids = Array.isArray(m?.userIds)
    ? m.userIds.map((v) => String(v).trim()).filter((v) => v !== '')
    : []
  if (mode === 'user' && ids.length === 0) return { mode: 'none', ids: [] }
  return { mode, ids }
}


/**
 * 解析这条消息要发给的所有会话（v0.14.0 起的多投递目标）。
 *
 * 兼容顺序（老配置一个字都没动也能跑）：
 *   1. acc.targets 是数组且里面有合法项 → 用数组里全部去重后的项
 *   2. 否则回落到 acc.target 单目标
 *   3. 再回落到 allowFrom[0]（dsh-bridge 老字段）
 *
 * 为什么保留 targetOf：12 个通道实现全都按「一次发一个会话」写的，
 * 扇出放在 bus 层做（见 lib/bus.js 的 fanOutTargets），通道一行都不用改。
 *
 * @param {Record<string,any>} acc 单个通道账号
 * @returns {Array<{kind: "user"|"group"|"auto", id: string}>}
 */
export function targetsOf(acc) {
  const list = Array.isArray(acc?.targets) ? acc.targets : []
  const out = []
  const seen = new Set()
  for (const item of list) {
    if (item === null || typeof item !== "object") continue
    const id = String(item.id ?? "").trim()
    if (id === "" || seen.has(id)) continue
    seen.add(id)
    const kind = item.kind === "group" ? "group" : item.kind === "user" ? "user" : "auto"
    out.push({ kind, id })
  }
  if (out.length > 0) return out
  const single = targetOf(acc)
  return single === null ? [] : [single]
}

/** 描述一组目标，给「已发送 N 块」这类回执用。 */
export function describeTargets(targets) {
  if (!Array.isArray(targets) || targets.length === 0) return "未设置发送目标"
  if (targets.length === 1) return describeTarget(targets[0])
  return targets.length + " 个目标：" + targets.map((t) => describeTarget(t)).join("、")
}
/** 让人一眼看懂这条账号会发去哪（给界面 / 错误提示用）。 */
export function describeTarget(target) {
  if (target === null) return '未设置发送目标'
  const label = target.kind === 'group' ? '群' : target.kind === 'user' ? '单聊' : '目标'
  return label + ' ' + target.id
}
