/**
 * lib/buttons.js — 交互按钮的通道无关中间表示。
 *
 * 为什么要有这一层：三家平台的按钮格式毫无交集 ——
 *   Telegram  reply_markup.inline_keyboard[[{text, callback_data}]]
 *   Slack     blocks[{type:"actions", elements:[{type:"button", text:{type:"plain_text",text}, action_id, value}]}]
 *   Discord   components[{type:1, components:[{type:2, style:2, label, custom_id}]}]
 * 如果让调用方直接写任意一家的 JSON，那「同一句话发给三个通道」就没法写了。
 * 所以这里定义一种最小中间表示，再各自翻译：
 *
 *   [{ text: "批准", callback: "ok" }, { text: "拒绝", callback: "no" }]   一行两个按钮
 *   [[{...}, {...}], [{...}]]                                             显式分行
 *
 * 校验放在这一层而不是各家通道里，是因为**约束最严的是 Telegram**：
 * callback_data 上限 64 字节。按最严的验，三家都能过；按最松的验，
 * Telegram 会在发出去的时候整条消息 400，而 Slack / Discord 照发成功 ——
 * 变成「同一个配置，一部分通道莫名其妙失败」，那种错最难查。
 *
 * @module buttons
 */

/** Telegram 的硬限制：callback_data 最多 64 字节。按它验，其余两家都够。 */
export const MAX_CALLBACK_BYTES = 64

/** 一条消息最多带多少个按钮。Slack 单个 actions block 上限 25，取交集。 */
export const MAX_BUTTONS = 25

/** Discord 一行最多 5 个；Slack 一行不限但多了会挤；Telegram 一行 8 个就换行。 */
export const MAX_PER_ROW = 5

/**
 * 把一个按钮对象归一化，坏的就抛错（调用方统一 try/catch 转成 detail）。
 *
 * @param {any} raw
 * @returns {{text: string, callback: string}}
 */
function normalizeOne(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('按钮必须是对象，形如 {"text":"批准","callback":"ok"}')
  }
  const text = String(raw.text ?? raw.label ?? "").trim()
  if (text === "") throw new TypeError("按钮要有文字（text）")
  const callback = String(raw.callback ?? raw.value ?? raw.custom_id ?? raw.callback_data ?? '').trim()
  if (callback === "") {
    throw new TypeError('按钮「' + text + '」没有 callback —— 按下去要回传什么全靠它')
  }
  const bytes = Buffer.byteLength(callback, "utf8")
  if (bytes > MAX_CALLBACK_BYTES) {
    throw new TypeError('按钮「' + text + '」的 callback 有 ' + bytes + ' 字节，超过 Telegram 的 ' + MAX_CALLBACK_BYTES + ' 字节上限（按最严的平台验，三家才都能发）')
  }
  return { text, callback }
}

/**
 * 解析调用方给的按钮规格。接受两种写法：
 *   - 一维数组：全部按钮排一行（超过 MAX_PER_ROW 自动折行）
 *   - 二维数组：外层是行，内层是这一行的按钮
 * 也接受 JSON 字符串（工具参数与 HTTP body 常常是字符串）。
 *
 * @param {any} input
 * @returns {{ok: true, rows: Array<Array<{text: string, callback: string}>>} | {ok: false, detail: string}}
 */
export function parseButtons(input) {
  if (input === undefined || input === null || input === "") return { ok: true, rows: [] }
  let value = input
  if (typeof value === "string") {
    try {
      value = JSON.parse(value)
    } catch {
      return { ok: false, detail: "按钮不是合法 JSON：" + String(input).slice(0, 120) }
    }
  }
  if (!Array.isArray(value)) return { ok: false, detail: "按钮要写成数组（一行一个对象，或二维数组分行）" }
  if (value.length === 0) return { ok: true, rows: [] }

  const nested = value.every((item) => Array.isArray(item))
  const rawRows = nested ? value : [value]
  const rows = []
  let total = 0
  for (const rawRow of rawRows) {
    if (!Array.isArray(rawRow) || rawRow.length === 0) {
      return { ok: false, detail: "按钮的每一行都要是非空数组" }
    }
    const row = []
    for (const item of rawRow) {
      try {
        row.push(normalizeOne(item))
      } catch (error) {
        return { ok: false, detail: String(error?.message ?? error) }
      }
    }
    // 一行超过 MAX_PER_ROW 就折开，不然 Discord 会整条拒绝。
    for (let i = 0; i < row.length; i += MAX_PER_ROW) {
      const chunk = row.slice(i, i + MAX_PER_ROW)
      rows.push(chunk)
      total += chunk.length
    }
  }
  if (total > MAX_BUTTONS) {
    return { ok: false, detail: "一条消息最多 " + MAX_BUTTONS + " 个按钮，给了 " + total + " 个" }
  }
  return { ok: true, rows }
}

/** 给人看的一句话：3 行 7 个按钮。 */
export function describeButtons(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return "无按钮"
  const total = rows.reduce((sum, row) => sum + row.length, 0)
  return rows.length + " 行 " + total + " 个按钮"
}

/**
 * Telegram：reply_markup.inline_keyboard。
 * 空数组是合法的 —— 那正是「把键盘收掉」的写法，所以这里不拦。
 */
export function toTelegram(rows) {
  return {
    inline_keyboard: (Array.isArray(rows) ? rows : []).map((row) =>
      row.map((b) => ({ text: b.text, callback_data: b.callback })),
    ),
  }
}

/**
 * Slack：一个 actions block 装全部按钮（每个 button 一个 element）。
 * action_id 必须唯一且稳定 —— 用按钮序号而不是文字，避免中文/空格进 id。
 */
export function toSlack(rows) {
  const elements = []
  let index = 0
  for (const row of Array.isArray(rows) ? rows : []) {
    for (const b of row) {
      elements.push({
        type: "button",
        text: { type: "plain_text", text: b.text, emoji: true },
        action_id: "dshb_" + index,
        value: b.callback,
      })
      index += 1
    }
  }
  if (elements.length === 0) return []
  return [{ type: "actions", elements }]
}

/**
 * Discord：每个 action row 一行，组件类型 2 = button，style 2 = secondary。
 * custom_id 就是回调值，Discord 靠它区分按了哪个。
 */
export function toDiscord(rows) {
  const out = []
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row.length === 0) continue
    out.push({
      type: 1,
      components: row.map((b) => ({ type: 2, style: 2, label: b.text, custom_id: b.callback })),
    })
  }
  return out
}

/** 按通道翻译。不认识的通道返回 null —— 调用方据此把「这个通道不支持按钮」讲清楚。 */
export function buttonsFor(channel, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null
  if (channel === "telegram") return toTelegram(rows)
  if (channel === "slack") return toSlack(rows)
  if (channel === "discord") return toDiscord(rows)
  return null
}

/** 支持按钮的通道（按实际实现了翻译函数来定，不是「我猜它能」）。 */
export const BUTTON_CHANNELS = Object.freeze(["telegram", "slack", "discord"])

/** 该通道不支持按钮时，给人看的原因。 */
export const NO_BUTTON_REASON = Object.freeze({
  feishu: "飞书要发互动卡片（interactive card），格式与消息体完全不同，本插件还没做",
  qq: "QQ 官方机器人按钮走 keyboard 字段，QQ 群与频道格式还不一样，本插件还没做",
  wechat: "微信 iLink 没有按钮消息类型",
  dingtalk: "钉钉群机器人只能发 markdown / text / link，没有可点的按钮",
  wecom: "企业微信群机器人只能发 markdown / text，没有可点的按钮",
  wecom_app: "企业微信自建应用发按钮要 templates/card，要额外申请模板，本插件还没做",
  synology_chat: "群晖 Chat 只收文本与附件（「传入的 Webhook」与「机器人」都不支持按钮）",
  matrix: "Matrix 按钮要 m.room.message 里塞自定义 HTML/组件，客户端支持不一致",
  email: "邮件里不能有按钮（只能写链接）",
})
