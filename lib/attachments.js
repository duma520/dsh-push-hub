/**
 * lib/attachments.js — 入站附件（对方发来的图片 / 文件 / 语音）的归一化。
 *
 * 为什么要有它：v0.26.x 之前，四个接收 worker 都只取 `msg.text`，
 * 取不到就 `continue` —— 别人发一张图给机器人，收件箱里**一个字都没有**，
 * 用户以为插件坏了。所以先把「收到了什么」记准确。
 *
 * v0.36.0 起多了一件事：**把「怎么把文件取回来」也记下来**（`handle`）。
 * 在此之前 compact() 只留 `{kind,name,mediaType,size}` 四个字段，把 Telegram 的
 * file_id、Slack 的 url_private_download、Discord 的 url、Matrix 的 mxc://、
 * 飞书的 file_key 全丢了 —— 等到要做下载时才发现**没有任何线索能再拿到那个文件**。
 * 所以句柄必须在解析这一层就留下来，事后补是补不回来的。
 *
 * 四个平台给的东西长得完全不一样：
 *   Telegram  photo[{file_id,width,height,file_size}] / document{file_name,mime_type,file_size}
 *   Slack     files[{id,name,mimetype,size,url_private_download}]
 *   Discord   attachments[{id,filename,content_type,size,url}]
 *   Matrix    content{msgtype:'m.image'|'m.file', body:filename, url:'mxc://…', info:{mimetype,size}}
 *
 * 这一层的职责：
 *   1. 把上面四种形状压成同一个 `{ kind, name, mediaType, size, handle }`；
 *   2. 决定「这条消息还算不算纯文字」（有附件就不是）；
 *   3. 生成一句人能读的摘要，塞进收件箱正文。
 *
 * ## handle 的两条铁律
 *   1. **不落盘秘密**。handle 最终会被写进 inbox.json（明文文件）。Slack 的
 *      url_private_download 带 token、Discord 的 url 是限时签名、钉钉的 downloadCode
 *      是一次性票据 —— 这些只能活在内存里，下载完立刻换成 `{type, id}`。
 *   2. **取不到就如实标记**。QQ 的附件只有元数据、企业微信智能机器人根本推不了文件，
 *      这种 `downloadable: false` + `reason`，而不是让界面上挂个点了没反应的按钮。
 *
 * handle 形状（`type` 决定谁来下载）：
 *   {type:'telegram', fileId, fileName}   {type:'slack', url, id}
 *   {type:'discord', url, id}             {type:'matrix', mxc, name}
 *   {type:'feishu', messageId, fileKey, imageKey, kind}
 *   {type:'email', buffer}                ← Buffer 只在内存里，落盘前会被剥掉
 *   {type:'dingtalk', downloadCode}
 *   {type:'none', reason}                 ← 取不到（平台本身不给，或本轮没做）
 *
 * @module attachments
 */

/** 单条消息最多记多少个附件；超过截断（防止一条消息塞 200 张图撑爆收件箱）。 */
export const MAX_ATTACHMENTS = 10

/** 三种归一化后的类型。 */
export const ATTACHMENT_KINDS = Object.freeze(['image', 'file', 'voice'])

/** 能真下载的 handle 类型（`none` 与 `dingtalk` 不算：前者没线索，后者要额外换票）。 */
export const DOWNLOADABLE_HANDLES = Object.freeze(['telegram', 'slack', 'discord', 'matrix', 'feishu', 'email'])

/** 常见图片 mime，用于把「没有 msgtype 但扩展名是 .jpg」的兜底成 image。 */
const IMAGE_MIME = /^image\//i
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|heic|heif|tiff?|svg)$/i
const VOICE_EXT = /\.(ogg|oga|opus|mp3|m4a|wav|amr|aac|flac)$/i

/**
 * 按扩展名 / mime 猜类型。
 * 顺序很重要：先看 mime（平台声明的权威），猜不出再看扩展名。
 */
export function kindOf(name, mediaType) {
  const mime = String(mediaType ?? '').toLowerCase()
  const lower = String(name ?? '').toLowerCase()
  if (mime !== '') {
    if (IMAGE_MIME.test(mime)) return 'image'
    if (mime.startsWith('audio/')) return 'voice'
    return 'file'
  }
  if (IMAGE_EXT.test(lower)) return 'image'
  if (VOICE_EXT.test(lower)) return 'voice'
  return 'file'
}

/** 体积转人读。未知返回空串（不写「0 B」误导人）。 */
export function humanSize(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}

/** handle 是否指向一个真能取的文件。 */
export function isDownloadable(handle) {
  return typeof handle === 'object' && handle !== null && DOWNLOADABLE_HANDLES.includes(String(handle.type ?? ''))
}

/**
 * 把 handle 压成**可以安全落盘**的形状：只留 type 与非秘密 id。
 * 秘密字段（url / downloadCode / buffer / token）一律丢弃 —— 见文件头「铁律 1」。
 * 落盘之后仍想知道「这个附件本来能不能下」，靠 `downloadable` 布尔值。
 */
export function safeHandle(handle) {
  if (typeof handle !== 'object' || handle === null) return null
  const type = String(handle.type ?? '')
  if (type === '') return null
  const out = { type }
  if (type === 'telegram') {
    if (handle.fileId) out.fileId = String(handle.fileId)
  } else if (type === 'slack') {
    if (handle.id) out.id = String(handle.id)
  } else if (type === 'discord') {
    if (handle.id) out.id = String(handle.id)
  } else if (type === 'matrix') {
    // mxc:// 不是秘密（它只是媒体坐标，取的时候仍要 access token），留着能重下。
    if (handle.mxc) out.mxc = String(handle.mxc)
  } else if (type === 'feishu') {
    if (handle.fileKey) out.fileKey = String(handle.fileKey)
    if (handle.imageKey) out.imageKey = String(handle.imageKey)
    if (handle.messageId) out.messageId = String(handle.messageId)
  } else if (type === 'none') {
    if (handle.reason) out.reason = String(handle.reason)
  }
  out.downloadable = DOWNLOADABLE_HANDLES.includes(type)
  return out
}

/** 收口：把一批候选压成归一化数组，超过 MAX_ATTACHMENTS 截断。 */
function compact(list) {
  const out = []
  for (const item of list) {
    if (item === null || item === undefined) continue
    const name = String(item.name ?? '').trim()
    const mediaType = String(item.mediaType ?? '').trim()
    if (name === '' && mediaType === '') continue
    const size = Number(item.size)
    const handle = typeof item.handle === 'object' && item.handle !== null ? item.handle : null
    out.push({
      kind: String(item.kind ?? kindOf(name, mediaType)),
      name: name !== '' ? name : '(未命名)',
      ...(mediaType !== '' ? { mediaType } : {}),
      ...(Number.isFinite(size) && size > 0 ? { size: Math.floor(size) } : {}),
      ...(handle === null ? {} : { handle }),
    })
    if (out.length >= MAX_ATTACHMENTS) break
  }
  return out
}
/**
 * Telegram：`message.photo` 是**同一张图的多档尺寸**，不是多张图。
 * 取最大那一档（按 file_size，没有就按 宽×高）。
 * 下载走 getFile(file_id) → file_path → `https://api.telegram.org/file/bot<token>/<path>`，
 * 所以这里只需要留住 file_id。
 */
export function fromTelegram(message) {
  const photo = message?.photo
  if (Array.isArray(photo) && photo.length > 0) {
    const score = (p) => Number(p?.file_size) || (Number(p?.width) || 0) * (Number(p?.height) || 0)
    const best = photo.reduce((a, b) => (score(b) > score(a) ? b : a))
    const fileId = String(best?.file_id ?? '')
    return compact([{
      kind: 'image',
      name: 'photo-' + String(best?.file_unique_id ?? best?.file_id ?? 'x').slice(0, 16) + '.jpg',
      mediaType: 'image/jpeg',
      size: best?.file_size,
      handle: fileId !== '' ? { type: 'telegram', fileId } : { type: 'none', reason: 'Telegram 没给 file_id' },
    }])
  }
  if (message?.document) {
    const doc = message.document
    const name = String(doc?.file_name ?? doc?.file_unique_id ?? 'document')
    const mediaType = String(doc?.mime_type ?? '')
    const fileId = String(doc?.file_id ?? '')
    return compact([{
      kind: kindOf(name, mediaType),
      name,
      mediaType,
      size: doc?.file_size,
      handle: fileId !== '' ? { type: 'telegram', fileId, fileName: name } : { type: 'none', reason: 'Telegram 没给 file_id' },
    }])
  }
  if (message?.voice) {
    const v = message.voice
    const fileId = String(v?.file_id ?? '')
    return compact([{
      kind: 'voice',
      name: 'voice-' + String(v?.file_unique_id ?? 'x').slice(0, 16) + '.ogg',
      mediaType: String(v?.mime_type ?? 'audio/ogg'),
      size: v?.file_size ?? v?.duration,
      handle: fileId !== '' ? { type: 'telegram', fileId } : { type: 'none', reason: 'Telegram 没给 file_id' },
    }])
  }
  if (message?.audio) {
    const a = message.audio
    const fileId = String(a?.file_id ?? '')
    const name = String(a?.file_name ?? 'audio')
    return compact([{
      kind: 'voice',
      name,
      mediaType: String(a?.mime_type ?? 'audio/mpeg'),
      size: a?.file_size,
      handle: fileId !== '' ? { type: 'telegram', fileId, fileName: name } : { type: 'none', reason: 'Telegram 没给 file_id' },
    }])
  }
  return []
}

/**
 * Slack：`event.files[]`，每个都带 name / mimetype / size。
 * 下载要用 `url_private_download` **且带 Bot Token**（那个 URL 自己不带鉴权），
 * 所以它属于「秘密字段」，只在内存里流转，落盘前被 safeHandle 剥掉。
 */
export function fromSlack(event) {
  const files = event?.files
  if (!Array.isArray(files)) return []
  return compact(files.map((file) => {
    const url = String(file?.url_private_download ?? file?.url_private ?? '')
    const name = String(file?.name ?? file?.title ?? file?.id ?? '')
    return {
      kind: kindOf(name, file?.mimetype),
      name,
      mediaType: String(file?.mimetype ?? ''),
      size: file?.size,
      handle: url !== ''
        ? { type: 'slack', url, id: String(file?.id ?? ''), fileName: name }
        : { type: 'none', reason: 'Slack 这条没有 url_private_download（可能被工作区策略禁了）' },
    }
  }))
}

/**
 * Discord：`message.attachments[]`，带 filename / content_type / size / url。
 * url 是**带签名的 CDN 直链**，会过期（默认 24 小时）；不需要额外鉴权头。
 * 因为会过期，落盘只留 id 不留 url。
 */
export function fromDiscord(message) {
  const list = message?.attachments
  if (!Array.isArray(list)) return []
  return compact(list.map((item) => {
    const url = String(item?.url ?? item?.proxy_url ?? '')
    const name = String(item?.filename ?? '')
    return {
      kind: kindOf(name, item?.content_type),
      name,
      mediaType: String(item?.content_type ?? ''),
      size: item?.size,
      handle: url !== ''
        ? { type: 'discord', url, id: String(item?.id ?? ''), fileName: name }
        : { type: 'none', reason: 'Discord 没给附件 URL' },
    }
  }))
}

/**
 * Matrix：附件信息在 `content` 里，msgtype 是 `m.image` / `m.file` / `m.audio`。
 * `body` 在这里就是文件名（不是消息正文）—— 这是 Matrix 的一个反直觉之处。
 * 下载要把 `mxc://server/mediaid` 拆成
 * `https://<homeserver>/_matrix/media/v3/download/<server>/<mediaid>?allow_redirect=true`，
 * 而 mxc 坐标本身不是秘密（取的时候仍要 access token），所以可以留着重下。
 */
export function fromMatrix(content) {
  const type = String(content?.msgtype ?? '')
  if (!type.startsWith('m.image') && !type.startsWith('m.file') && !type.startsWith('m.audio') && !type.startsWith('m.video')) return []
  const kind = type.startsWith('m.image') ? 'image' : type.startsWith('m.audio') ? 'voice' : 'file'
  const mxc = String(content?.url ?? '')
  const name = String(content?.body ?? '')
  return compact([{
    kind,
    name,
    mediaType: String(content?.info?.mimetype ?? ''),
    size: content?.info?.size,
    handle: mxc.startsWith('mxc://')
      ? { type: 'matrix', mxc, fileName: name }
      : { type: 'none', reason: 'Matrix 这条没有 mxc:// 媒体地址' },
  }])
}

/** 摘要：`[图片 photo-a1b2.jpg 12.3 KB]` 或 `[文件 报告.pdf 1.2 MB, 截图.png 88 KB]`。 */
export function summarize(list) {
  const items = Array.isArray(list) ? list : []
  if (items.length === 0) return ''
  const one = (item) => {
    const kindText = item.kind === 'image' ? '图片' : item.kind === 'voice' ? '语音' : '文件'
    const size = humanSize(item.size)
    return kindText + ' ' + item.name + (size !== '' ? ' ' + size : '')
  }
  return '[' + items.map(one).join(', ') + ']'
}

/** 有附件就不是纯文字 —— 调用方据此决定要不要写 `plainText: false`。 */
export function hasAttachments(list) {
  return Array.isArray(list) && list.length > 0
}
/**
 * 飞书：`message.content` 是**JSON 字符串**（不是对象），类型由 `message_type` 决定。
 *   file  → {"file_key":"file_v3_...","file_name":"报告.pdf"}
 *   image → {"image_key":"img_v3_..."}       ← **没有文件名**，飞书不给
 *   audio → {"file_key":"...","duration":3000}
 *   media → {"file_key":"...","file_name":"...","duration":...}
 *
 * 下载要用 `GET /open-apis/im/v1/messages/{message_id}/resources/{file_key}?type=image|file`，
 * 且要 tenant_access_token。所以 handle 里必须同时留住 message_id —— 只留 file_key 取不回来。
 */
export function fromFeishu(event) {
  const message = event?.message
  const type = String(message?.message_type ?? '')
  if (type !== 'file' && type !== 'image' && type !== 'audio' && type !== 'media') return []
  const messageId = String(message?.message_id ?? '')
  const raw = message?.content
  const parsed = typeof raw === 'string' && raw !== '' ? (() => { try { return JSON.parse(raw) } catch { return null } })() : null
  if (parsed === null || typeof parsed !== 'object') {
    // content 解析不了也要留痕：至少记下平台声明的类型，比整条丢掉强。
    const kind = type === 'image' ? 'image' : type === 'audio' ? 'voice' : 'file'
    return compact([{ kind, name: '(飞书 ' + type + '，content 解析失败)', handle: { type: 'none', reason: 'content 解析失败，拿不到 file_key' } }])
  }
  const name = String(parsed?.file_name ?? '')
  const fileKey = String(parsed?.file_key ?? '')
  const imageKey = String(parsed?.image_key ?? '')
  const key = type === 'image' ? imageKey : fileKey
  const handle = key !== '' && messageId !== ''
    ? { type: 'feishu', messageId, ...(fileKey !== '' ? { fileKey } : {}), ...(imageKey !== '' ? { imageKey } : {}), kind: type === 'image' ? 'image' : 'file', fileName: name }
    : { type: 'none', reason: key === '' ? '飞书这条没有 file_key/image_key' : '飞书这条没有 message_id（拉资源必须两个都有）' }
  if (type === 'image') {
    return compact([{ kind: 'image', name: name !== '' ? name : 'feishu-' + String(parsed?.image_key ?? 'image').slice(-8) + '.jpg', handle }])
  }
  if (type === 'audio') {
    return compact([{ kind: 'voice', name: name !== '' ? name : 'feishu-voice', size: parsed?.file_size, handle }])
  }
  return compact([{ kind: kindOf(name, ''), name: name !== '' ? name : 'feishu-' + String(parsed?.file_key ?? 'file').slice(-8), size: parsed?.file_size, handle }])
}

/**
 * QQ 官方机器人：消息体里 `attachments[]` 只有一组元数据，
 * 而且**必须在 5 分钟内用 msg_id 主动拉**（`/v2/groups/{id}/files`）——
 * 过了窗口附件就取不到了。所以这里只记元数据 + 明确标 `none`，不假装能下载。
 */
export function fromQQ(d) {
  const list = d?.attachments
  if (!Array.isArray(list)) return []
  return compact(list.map((item) => ({
    kind: kindOf(item?.filename, item?.content_type),
    name: String(item?.filename ?? ''),
    mediaType: String(item?.content_type ?? ''),
    size: item?.size,
    handle: { type: 'none', reason: 'QQ 官方机器人只推附件元数据，真正的文件要在 5 分钟内主动调接口拉，本条已过期' },
  })))
}

/**
 * 钉钉：Stream 推来的 robot 消息体里，`msgtype` 决定一切。
 *   text        → { text: { content } }
 *   picture     → { picture: { downloadCode } }              ← **没有文件名**
 *   file        → { file: { downloadCode, fileName, fileSize } }
 *   audio/voice → { audio: { downloadCode, duration } }
 * 图片与文件都要拿 downloadCode 再换临时 URL。downloadCode 是一次性票据、
 * 有效期几分钟，所以不落盘，只标记「本来能下但我们没下」。
 */
export function fromDingtalk(message) {
  const type = String(message?.msgtype ?? '').toLowerCase()
  if (type === 'picture') {
    const code = String(message?.picture?.downloadCode ?? '').slice(-8)
    return compact([{
      kind: 'image',
      name: 'dingtalk-' + (code !== '' ? code : 'picture') + '.jpg',
      handle: { type: 'none', reason: '钉钉要用 downloadCode 换临时 URL，票据几分钟就失效' },
    }])
  }
  if (type === 'file') {
    const file = message?.file
    const name = String(file?.fileName ?? '')
    return compact([{
      kind: kindOf(name, ''),
      name: name !== '' ? name : 'dingtalk-file',
      size: file?.fileSize,
      handle: { type: 'none', reason: '钉钉要用 downloadCode 换临时 URL，票据几分钟就失效' },
    }])
  }
  if (type === 'audio' || type === 'voice') {
    return compact([{
      kind: 'voice',
      name: 'dingtalk-' + type + '-' + String(message?.audio?.downloadCode ?? 'x').slice(-6),
      handle: { type: 'none', reason: '钉钉要用 downloadCode 换临时 URL，票据几分钟就失效' },
    }])
  }
  return []
}

/**
 * 企业微信智能机器人：`msgtype` 只有 text / voice / mixed / event。
 * **它推不了图片和文件** —— 想要附件得自己拿 media_id 去 `/cgi-bin/media/get` 下载，
 * 而智能机器人这条链路本来就不给 media_id。所以这里只处理 mixed（图文混排）。
 */
export function fromWecomBot(body) {
  const type = String(body?.msgtype ?? '').toLowerCase()
  if (type !== 'mixed') return []
  const list = body?.mixed?.msg_item
  if (!Array.isArray(list)) return []
  return compact(list.map((item) => ({
    kind: kindOf('', item?.image?.content_type ?? ''),
    name: String(item?.image?.filename ?? 'wecom-image'),
    mediaType: String(item?.image?.content_type ?? ''),
    handle: { type: 'none', reason: '企业微信智能机器人这条链路不给 media_id，取不到原图' },
  })))
}

/**
 * 邮件：`parsed.attachments` 每项有 filename / contentType / size，**还有 content（Buffer）**。
 * 它是唯一一个「不需要再走一次网络」的通道 —— 邮件在收的时候就已经把
 * 整个 MIME 体读进内存了，附件字节就在手上。所以 handle 直接带 buffer。
 *
 * 注意内联图片（content-disposition: inline）也会出现在这个数组里 ——
 * 它们通常是正文里的图标，但既然对方发了、也占体积，照记不误。
 */
export function fromEmail(parsed) {
  const list = parsed?.attachments
  if (!Array.isArray(list)) return []
  return compact(list.map((item) => ({
    kind: kindOf(item?.filename, item?.contentType),
    name: String(item?.filename ?? ''),
    mediaType: String(item?.contentType ?? ''),
    size: item?.size,
    handle: Buffer.isBuffer(item?.content)
      ? { type: 'email', buffer: item.content }
      : { type: 'none', reason: '邮件解析器没留附件字节（可能被流式省内存了）' },
  })))
}

/**
 * 把附件数组压成**可写进 inbox.json 的**形状：handle 走 safeHandle，Buffer 会被剥掉。
 * 调用方（receiver.deliver）在 appendMessage 之前必须先过这一步，
 * 否则 email 的 Buffer 会以 `{type:'Buffer',data:[...]}` 的形式把 inbox.json 撑爆几十 MB。
 */
export function forStore(list) {
  const items = Array.isArray(list) ? list : []
  if (items.length === 0) return []
  return items.map((item) => {
    const out = { kind: String(item?.kind ?? 'file'), name: String(item?.name ?? '(未命名)') }
    if (item?.mediaType) out.mediaType = String(item.mediaType)
    if (Number.isFinite(Number(item?.size)) && Number(item.size) > 0) out.size = Math.floor(Number(item.size))
    const handle = safeHandle(item?.handle)
    if (handle !== null) out.handle = handle
    if (item?.localPath) {
      out.localPath = String(item.localPath)
      if (item.localBytes) out.localBytes = Math.floor(Number(item.localBytes))
      if (item.localAt) out.localAt = String(item.localAt)
    }
    // 下载结果必须留下来 —— 只留 localPath 的话，「没下下来」和「还没试过」在
    // 收件箱里长得一模一样，用户会以为插件漏了，实际是取不到、本轮没做、或者超了上限。
    if (item?.download && typeof item.download === 'object') {
      out.download = { state: String(item.download.state ?? ''), detail: String(item.download.detail ?? '') }
    }
    return out
  })
}