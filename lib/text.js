/**
 * lib/text.js — 按通道字数上限切块。
 *
 * 行为与 Python 版 pushhub/textutil.py 的 split_blocks 一致：
 * 按行切，单行超长再硬切，不会把一句话从中间劈开（除单行本身就超限的情况）。
 *
 * @module text
 */

/**
 * 把文本切成若干块，每块不超过 limit 个字符。
 * @param {string} text 原始文本
 * @param {number} limit 单块上限
 * @returns {string[]}
 */
export function splitBlocks(text, limit) {
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 2000
  const source = String(text ?? '')
  if (source === '') return ['']
  if (source.length <= max) return [source]

  const blocks = []
  let current = ''
  for (const line of source.split('\n')) {
    // 单行本身就超限：先结掉当前块，再把这一行硬切。
    if (line.length > max) {
      if (current !== '') {
        blocks.push(current)
        current = ''
      }
      for (let index = 0; index < line.length; index += max) blocks.push(line.slice(index, index + max))
      continue
    }
    const candidate = current === '' ? line : current + '\n' + line
    if (candidate.length > max) {
      blocks.push(current)
      current = line
    } else {
      current = candidate
    }
  }
  if (current !== '') blocks.push(current)
  return blocks.length === 0 ? [''] : blocks
}

/** 截断到 limit 个字符，超出补省略号。 */
export function clip(text, limit = 200) {
  const source = String(text ?? '')
  return source.length <= limit ? source : source.slice(0, limit) + '…'
}

/** 毫秒延时。 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}
