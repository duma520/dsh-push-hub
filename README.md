# dsh-push-hub · 推送中枢

**一句话**：一个装进 DeepSeek Harness（下称 DSH）的推送插件，让你在对话里一句话把消息推到 **微信 / 飞书 / 钉钉 / 企业微信 / QQ / Telegram / Slack / Discord / Matrix / 群晖 Chat / 邮件** 十二个地方。

**给谁用**：想让 AI 干活的结果（日报、告警、跑完的通知、长任务收尾）自动落到自己手机/群里的人。

**解决什么**：原来每个平台各写一套 HTTP 调用、各自管 token、各自处理分块和重试。现在收敛成一个工具 `push_hub_send`，凭据只存本插件自己的 `~/.dsh/dsh-push-hub/config.json`（0600），不入库、不回显。

> 当前版本 **v0.40.2**（2026-11-20）。插件名 `@duma520/dsh-push-hub`，纯 JS 零构建，装在本机 DSH 的 `desktop` profile 里。
**v0.40.2 删掉的机器人又自己回来了**：主人报「删除机器人、重新填写，名称改成原来一样的话，url 就自动恢复成之前的了 —— 删除后应该等于全新的」。查下来**不是后端在复活数据，是浏览器端那份「明码」缓存按名称索引**：点过「明码」之后，该字段的明文存在 `revealed` state 里，键是 `通道|名称|字段`（`lib/client.js:1462` `revealKeyOf`），渲染时按当前名称去查（`:1748`），命中就把明文塞进 `readOnly` 输入框（`:1756-1759`）。而旧的 `dropOwn` 只把行 filter 掉、**完全不碰 revealed**，于是「删掉 → 同名重建」时新行下标 0 + 名称「DSH 通知」正好撞上旧键，删之前的完整 Webhook URL 被原样顶回来，右侧按钮显示「隐藏」而不是「明码」，用户既改不掉也删不干净。能确定不是后端，是因为 `lib/index.js:677` 是 `const old = oldRows[i] ?? {}` —— 旧行按**下标**对齐、与名字无关；若复活来自后端，随便起什么名站到下标 0 都会拿到旧值，不会「只有同名才复活」。这版只动前端三处：`lib/client.js:847` 新增 `clearRevealed(channel,name)` 按 `通道|名称|` 前缀清缓存；`:885` `dropOwn` 在 filter **之前**先取名字再清（行没了就再没处反查它叫什么）；`:904` `patchOwn` 改到 `name` 且与旧值不同时清旧名（堵「A 点明码 → 改名 B → 改回 A」），只改别的字段不清（否则每换一次目标都得重点「明码」）；`:668-672` `reload()` 拿到配置后 `setRevealed({})` 整体作废。`probe_ownbot_delete.mjs` 19 → **34** 项，E 段 15 条全在真函数体上跑，E5/E6 复刻的就是这一幕。
**v0.40.1 群晖「测试失败」的两个真因被说清了**：主人报「传入的 Webhook 测试为什么要失败」，查下来是两件事叠在一起，之前的文案把两件都指错了方向 —— 一是 **404 有两种含义**。旧文案一律写「token 类型不对，请改用 bot token」，可发送路径上根本到不了这个分支：实测群晖对「webhook token 调只读接口」和「URL 里的令牌已失效」返回**一模一样**的 `{"error":{"code":404,"errors":"invalid token"}}`（拿垃圾令牌 `A×64` 与真实令牌试，回包完全相同；不带令牌才是 `code=105`）。也就是说 404 在发送时只可能是「整合被删/重建过，旧 URL 里的令牌不再匹配」，照旧文案去换 token 类型只会越改越错。这版给 `explainChatError` 加了 `context` 参数，发送语境改说「URL 里的令牌已失效 —— 回面板「整合 → 传入的 Webhook」重新复制整条 Webhook URL」，探测语境保留原文案，两条文案由探针断言必须不同。二是 **局域网 IP 的自签证书必然失败**，却要等到 `TypeError: fetch failed` / `ERR_TLS_CERT_ALTNAME_INVALID` 才报，看不出「换个地址就能通」。这版在发请求**之前**先认地址：`10/8`、`127/8`、`192.168/16`、`172.16-31` 这四个私有网段直接返回「群晖的自签证书不包含 IP，请换 QuickConnect 域名（形如 `https://192-168-1-10.xxxx.quickconnect.cn:5001…`）」，不再白跑一次 TLS。为什么不自动帮改：QuickConnect 后缀每台 NAS 都不同，猜不出来，只提示、不代改。`probe_synology.mjs` 45 → 53 项。
**v0.40.0 群晖 Chat 的「类型」改成三种，跟群晖面板一一对上**：以前这里只有「webhook / bot」两个选项，是把群晖的**协议**当成类型了 —— 用户在群晖面板上看到的是三种「整合」（传入的 Webhook / 发出的 Webhook / 机器人），选哪个决定他手里有几项要填、每一项是什么，跟协议名对不上号。这版把 `type` 改成 `incoming` / `outgoing` / `bot` 三值，字段跟着类型走：`incoming` 只留 **Webhook URL**（填了就用它，留空则用 NAS 地址 + 令牌自动拼），`outgoing` 留**传出 URL / 令牌 / 频道 / 触发字**，`bot` 留**传入 URL / 传出 URL / NAS 地址 / 令牌 / 用户 ID**。为什么 `outgoing` 只登记不发：它的方向是「群晖 → 你填的那个 URL」，令牌是给你这一侧验签用的，**不是发消息的凭据** —— 选它却按「发条测试消息」会被明确拒绝，并提示改成另两种。老配置里的 `type: "webhook"`、`type: "bot"` 与空值全部照旧可用（`webhook`/空/未知 → `incoming`），不需要手工迁移。
**v0.39.1 主面板下面看不见的内容，现在能滚到了**：v0.39.0 交付后主人报「进推送中枢往下滚不动，界面底部的保存按钮根本到不了」。查下来是三层的防溢出能力全都落空 —— 宿主 `.mainPanel` 有 `min-height:0` 但没有 `overflow`（超出即裁），本插件外层 `.dph-pageWrap` 只有留白没有高度，里层 `.dph-root` 虽然写了 `height:100%; overflow-y:auto`，但它爹没定高，`height:100%` 退化成 `auto`，于是 `overflow-y:auto` 永不触发。v0.26.1 那次只补了 `.dph-root`，改的正是那层不是元凶的地方。这版把滚动交给 `.dph-pageWrap`：`max-height:100%`（父级定高时封顶、不定高时不封顶，两种情况都不憋死内容）+ `overflow-y:auto` + 8px 可见滚动条，两处同源 CSS（`lib/client.js` 与 `lib/theme.js`）一起改。
**v0.39.0 抢不到接收权也不再哑火**：v0.38.0 交付后，那条 409 依然稳定复现，于是这版先去把它查清 —— 结论跟上一版写的**不一样**，必须更正。上一版认定「409 来自热重载后旧模块的接收循环」，实验把它推翻了：插件停着的时候，宿主进程到代理的连接恒为 **0 条**（8 次 × 7 秒采样），本机 8 个 node 进程逐个看过，没有一个在轮询 Telegram；`getWebhookInfo` 的 `url` 空、`pending` 0，也没有 webhook 在抢。真正决定性的一枪是 Bot API 的 `close`：先确认平台空闲（`getUpdates{timeout:0,offset:-1}` 回 200），`POST close` 回 "{ok:true,result:true}"，紧接着连发 5 次 `getUpdates{timeout:10}` —— 前两次立刻 `HTTP 500 Internal Server Error`（说明确实踢掉了一条在跑的轮询），**第 3、4、5 次又变回 409**。也就是：**存在一个不受本插件控制的轮询者，被踢掉后几百毫秒内就重连回来了**。旁证还有两条：连打 30 次短轮询只有 1 次 409（3.3%，不是 100%），而窗口越长冲突率越高（3 秒 1/12、8 秒 3/12、25 秒 3/6），这是「两个轮询者抢同一个 token」才会有的形态，不是「自己上一次请求没结算完」那种固定时序。**结论是插件治不了它 —— 只能让自己在抢不到的时候别哑火。** 这一版的落法是四条：①`lib/http.js` 支持 `AbortSignal`（`request()` 解构里加 `signal`，`direct` 把它汇进 fetch 自己的 `controller`，`viaProxy` 在 abort 时**真的 `connection.destroy()` 掐断隧道** —— 只让 Promise 提前 resolve 是不够的，平台侧那条 `getUpdates` 还会挂着，下次 start 照样撞）；②`TELEGRAM_POLL_TIMEOUT` 25 → **10**，窗口越短撞车概率越低（数据就在上面），代价是空闲时多几次空轮询；③409 单独标成 `conflict` 走**独立短退避**（首次 1.5 秒、上限 6 秒），绝不混进普通失败的指数退避 —— 按 60 秒退等于「一撞就哑火半分钟」，而对方随时可能退出，抢回来就归零；④启停不再赛跑：`startChannel` / `stopChannel` 一起改 async，`stopChannel` 会等旧循环真正 settle 才返回（超时 5 秒后如实回 `drained:false`，不假装成功），`startChannel` 起循环前先看同账号有没有旧 controller，有就先 abort 并等它收尾 —— 这正是原来那条「stop 只设标志、长轮询还在飞」的根。顺带把接收面板改准：以前循环活着就一直写「正在收 · 已收 0 条」，用户会以为只是没人发消息；现在识别 `retrying` 与冲突次数，写「正在抢回接收权 · 同一个机器人已被别的轮询者占用 N 次」并整行转黄。新建 `scaffold/probe_conflict.mjs` **48 项**：A 段钉 signal 一路传到底（9 项）、**B 段真起一个「接住就不说话」的回环服务端做行为验证**（不传 signal 等满 `timeoutMs` 才回 411ms、传 signal 150ms 就回 182ms 且回 `AbortError`、已 abort 的 signal 1ms 生效）、C 段钉冲突短退避与取消语义（12 项）、D 段钉启停不再赛跑（11 项）、E 段验接口真的是 Promise 且字段齐、F 段钉界面不再谎报「在收」、G 段版本与依赖。全量探针 **39 个全绿**。
**v0.38.0 同一条消息不再记两遍**：这一版是主人**真发了一条消息**撞出来的，不是读代码读出来的。发完「你好」，`GET /receive/inbox?limit=5` 回了两条记录 —— 除 id 后缀外每个字段都一模一样，同一条消息记了两遍；同时 `/receive/status` 里 telegram 从 `running` 掉进 `retrying`，错误是 `getUpdates 失败 HTTP 409: Conflict: terminated by other getUpdates request; make sure that only one bot instance is running`。**这两件事是同一个根的两个枝**，只看其中一个会修错地方：枝一是 `appendMessage` 没有任何去重，id 用 `Date.parse(at)` + 随机后缀生成，同一条平台消息重投时**必然**生成两个不同 id，写入侧毫无抵抗；枝二是 telegram 的 offset 只存在内存 `acc.__offset`，进程一重启就回 0，而 0 在 Telegram 语义里是「把还没确认的全部再发一遍」—— 平台按规矩重投，完全合规。所以「重启 → 重投 → 重复记录」是一条必然链路，不是偶发。409 则来自 `startChannel` 的互斥只看内存 Set：插件热重载后旧模块的接收循环还活着（跑在旧闭包里、看的是旧 Map），新模块这边 Map 是空的于是又起一个，两个循环同时 `getUpdates` 互相踢。**单修去重只挡重复记录挡不住重复请求，单修游标只减少重投挡不住双实例**，三件事必须一起做。这一版的落法是：①新建 `lib/offsets.js`（234 行）把接收游标与接收权一起落盘到 `~/.dsh/dsh-push-hub/offsets.json`，读写沿用 `.tmp-<pid>` + `rename` 原子替换、读坏一律回空表永不抛（游标坏了只是退回从头拉，不该让接收循环起不来）；②`appendMessage` 加 `platformId` 判重，判重键是**通道 + 账号 + 平台唯一键**三个一起 —— 绝不能按正文判重，同一个人连发两条「你好」是两条真消息，只有平台给的唯一键才分得清「重投」与「重发」，命中判重时 `ok` 仍为 `true`（东西确实在箱里，回失败会让调用方以为写崩了），没有唯一键（微信 iLink）照旧写入宁可偶发重复也不并掉真消息；③13 处 `ctx.onMessage` 各自补上平台唯一键（telegram 用 `update_id` 而不是 `message_id` —— 前者是每一次投递的序号、重投时不变，且同时覆盖消息与回调；另有飞书 `message_id`、Matrix `event_id`、Slack `ts`、Discord `id`、QQ `id`、邮件 `messageId`、钉钉 `messageId`、企微 `msgid`），重投**不重复计「已收 N 条」**免得界面数字虚高；④接收权抢占：每次模块求值生成新的 `INSTANCE_ID`，启动时 `claimOwner`，两条循环每轮读一次盘上的 owner，发现自己不是持有者就写 `已让位给新的接收实例` 并安静退场 —— 语义是**后启动的赢、先启动的退**，反过来（检测到冲突就拒绝启动）会让刚点了「开始接收」的用户以为坏了。新建 `scaffold/probe_dedupe.mjs` **46 项**（A 游标 11 / B 抢占 8 / C 去重 10 / D receiver 契约 10 / E inbox 契约 4 / F 版本一致性 3，全部用临时目录，绝不碰真实数据目录）。一个必须记住的坑：`writeOffsets` 最初只写 offsets 段，于是 `setOffset` 每轮都把 owner 段冲掉一次，去重与抢占互相拆台 —— 修法是写盘前先 `readOwner` 把 owner 一起带上，探针 B6/B7 就钉这条。
**v0.37.0 长连接通道连没连上，看得出来**：这一版把 v0.36.0 真实执行验证时抓出来的一个 UX 缺陷修掉，顺便把「取不到附件」的措辞改准。缺陷是这样的：飞书实测连接是通的，界面上却永远停在 `starting` —— 因为接收器只在**收到第一条消息之后**（`deliver()` 里 `appendMessage` 成功那一刻）才把状态推到 `running`，而长连接型 worker 的 `run()` 内部没有任何「我连上了」的汇报点。于是「已经在收」和「连都没连上」在界面上长得一模一样：都显示「正在收 · 已收 0 条」，唯一区别是时间戳冻住不动 —— 而这个区别没人看得出来。修法是给 `worker.run(acc, ctx)` 加第三个可选回调 `ctx.onReady`，六个长连接通道各自在**真实连接建立的那一刻**调它，`runLoop` 收到就 `setStatus(channel, accountName, { state: 'running', received, error: null })`。六个通道的就绪信号来源各不相同，但都不是猜的：飞书直接用 SDK 自己的 `onReady`（`@larksuiteoapi/node-sdk` 的 `WSClient` 构造函数本来就收这个回调）；Slack / Discord / QQ 三家是在 `onSocket(socket, "open", ...)` 上报（undici 的 WebSocket 支持 `addEventListener('open')`）；钉钉用 `client.connect()` 的 `.then()` —— 它内部是 `getEndpoint()` + `_connect()`，resolve 即 socket 已 open，而 `dingtalk-stream` 本身没有就绪事件；企微用 `client.on('connected', ...)`（`@wecom/aibot-node-sdk` 的 `setupWsEvents()` 里 `onConnected` 就 emit `connected`，另有 `authenticated` 但那个问的是认证过没过，不是连没连上）。每个回调都包了 `try/catch`，理由单一：**状态只是展示，绝不能因为一个回调抛错就把连接断掉**。没实现 `onReady` 的 worker 走可选链，行为与旧版完全一致；`telegram` / `wechat` / `matrix` / `email` 这些轮询型也不受影响 —— 它们本来就能在拉取成功时说话。另外把「取不到附件」的措辞改准：原来 QQ / 钉钉 / 企微一律写「平台不给」，这对 QQ 与钉钉**不是事实** —— 这两家平台是给接口的（QQ 有 `getFile`，只是 5 分钟窗口；钉钉有 `downloadCode` 换临时 URL），只是本轮主动没做。现在 `NO_DOWNLOAD_REASON` 写「这条本轮没做，所以取不到」，只有企微智能机器人保留「链路本身不给」（它的回调里确实没有 `media_id`）。`scaffold/probe_download.mjs` 补 K 段 10 项（96 → **106 项**）。
**v0.36.0 入站附件下载**：v0.27.0 把十个平台的附件形状统一记了下来，但**只记不取** —— 收件箱里能看到「一张图 12.3 KB」，点不开。这一版把它接上：对方发来的图片 / 文件 / 语音真正落到本机 `~/.dsh/dsh-push-hub/files/<日期>/`。第一道坎不在下载，在**句柄被丢了**：v0.27.0 的 `compact()` 只保留 `{kind,name,mediaType,size}`，Telegram 的 `file_id`、Slack 的 `url_private_download`、Discord 的 `url`、Matrix 的 `mxc://`、飞书的 `file_key` 一个都没留，事后无从下载 —— 所以先把 `lib/attachments.js` 从 263 行改到 440 行，每个解析函数都带上 `handle`。两条铁律：（一）**不落盘秘密**，Slack 的 `url_private_download` 带 token、Discord 的 url 是限时签名、钉钉的 `downloadCode` 是一次性票据，写进 `inbox.json` 等于把凭据摊在硬盘上；`safeHandle()` 只留 type 与非秘密 id（`fileId`/`id`/`mxc`/`fileKey`/`imageKey`/`messageId`/`reason`）+ 一个 `downloadable` 布尔；（二）**取不到就如实标记**，QQ（5 分钟窗口内要主动拉）、钉钉（要拿 downloadCode 换临时 URL）、企业微信智能机器人（链路本身不给文件）走 `{type:'none',reason}`，界面上不会挂一个点了没反应的按钮。新建 `lib/download.js` 504 行，三条纪律写进头注释：①**下载失败不影响收消息**（逐条吞异常，最坏全带 `download.state='failed'` 落盘，消息本体一个字不少）②**上限在传输层生效不是事后检查**（先比声明的 `item.size`，超限一个字节都不请求；`lib/http.js` 因此新增 `binary` 与 `maxBytes`，`viaProxy` 边收边累加、一超就 `response.destroy()`，免得把 500 MB 拉进内存才发现超限）③**落盘文件名不信任平台**（`safeName()` 洗掉 `\ / : * ? " < > |` 与控制符、折叠 `..`、去前导点、截 120 字，`../../etc/passwd` 变成 `_._etc_passwd`）。三个策略点都做成可配置且**放配置顶层**（是「本机硬盘怎么用」不是「某个通道的偏好」）：单文件上限默认 10 MB（0 = 不限）、保留天数默认 7（0 = 不按天数清）、总量上限默认 200 MB（0 = 不限），夹值必回 detail。清理是**两轮**：先按天数删过期、再按总量从最老的删到不超限 —— 只做天数一天收 500 MB 照样爆，只做总量十年前那个 1 KB 小文件也会被当垃圾清掉。五平台取文件：Telegram 两步（`getFile` → `file_path` → `api.telegram.org/file/bot<token>/<path>`，**file_id 不是 URL**）、Slack 自己带 `authorization: Bearer`（URL 本身不带鉴权）、Discord CDN 直取、Matrix `mxc://` → `/_matrix/media/v3/download`、飞书先换 `tenant_access_token` 再拉 `im/resources`、邮件 Buffer 已在内存不走网络。`lib/receiver.js` 里下载放在 `appendMessage` **之前**（记录一旦写下去这条消息就「已完成」，补下载得靠人回来点，而用户不会回来点），写进去的是 `forStore()` 剥过句柄的版本。`lib/inbox.js` 加 `updateAttachments()` **就地更新**而非补写新消息（补写会让同一张图出现两次，像收了两遍）。`lib/index.js` 加四条路由（`/receive/files`、`/receive/files/policy`、`/receive/files/sweep`、`/receive/files/fetch`）与第 18 个工具 `push_hub_files`；`lib/client.js` 加「入站附件」页（三件事必须分得开：取不到 / 超了上限 / 被策略清了）。新建 `scaffold/probe_download.mjs` **96 项**（v0.37.0 补了 K 段 10 项，现为 **106 项**）。
**v0.35.0 每分钟发送配额**：v0.34.0 修的是「忘了收尾」，这一版修的是「发得太快」。此前唯一能控速的手段是账号级 `chunkDelayMs`（块间隔），可它管的是**同一批块之间**等多久，管不了「一分钟内已经发了多少条」—— 连着调 20 次 `push_hub_send`，每次都是一块，`chunkDelayMs` 一次都不会触发，而平台的每分钟配额早爆了。新建 `lib/ratelimit.js` 246 行，三条纪律写进头注释：①**限流只让请求变慢，不让它失败**（超配额的正解是等；真等不了才报失败，且**一块都不发** —— 发一半比不发更糟：用户既没收到完整内容又白耗配额）②**计数单位是「块」不是「一次 send 调用」**（切 5 块就是 5 次 API 调用，按调用计数会低估 5 倍，这正是最容易写错的地方）③**预约制不是检查制**（`take(n)` 把 n 个槽位压到未来，调用方 `sleep` 完直接发；检查制的经典 bug 是两个请求同时检查通过、然后一起发出去）。配额默认 15 条/分钟，可填 **0 = 明确不限**（唯一关掉的写法），夹到 1~30 且**夹值必回 `detail`**（静默改用户给的值会骗人）。限流器**刻意不落盘**（窗口是易失状态，重启清空是正确行为，不是 bug）。闸门只放一处 `gatedSend`，`sendToTargets` 的三条扇出分支（零目标 / 单目标 / 多目标）全走它 —— 写在四个调用方里必然漏一处。桶键是「通道|账号|目标」三元组，不能只按通道算：同一个机器人往两个群发，两个群各有各的配额，合成一个桶会把 A 群的用量算到 B 群头上。踩到一个必现的 bug：`perMinute: 1` 且 `take(20)` 时 `slots[overflow - 1]` 取到 `undefined`，`waitMs` 变 `NaN` —— 修法是算 `waitMs` 之前先接住「这一条本身就超配额」的情况（切 20 块而配额 1 条，等多久都发不完，如实拒比让调用方干等更诚实），这也是 `overflow` 越界的唯一成因。新增 `GET /send/limits`、第 17 个工具 `push_hub_limits`、设置页「发送配额」只读页（配额是**悄悄生效**的，没这一页用户只会去调 `chunkDelayMs`，而那是块间隔、调它没用），账号高级字段加第三个 `perMinute`（`mergeUserConfig` 对它要特判 `>= 0`，否则填 0 会被当成「没填」）。新建 `scaffold/probe_ratelimit.mjs` **90 项**。
**v0.34.0 进度表治理（TTL 与落盘）**：进度表情挂上去之后，超时的自己清掉、上限到了说清楚、进程重启过还能收尾。v0.33.0 留下三条实证漏洞：①`/send/progress/list` 上真挂着一条 `status:running` 但 `emoji` 空串的僵尸记录 —— 忘了 `end` 的那条，用户看到一条永远「在跑」的消息；②`PROGRESS_HUB` 是 `new Map()`，唯一的 `delete` 在 `endProgress` 里，挂够 64 条就再也挂不上；③进度只活内存，进程一重启，重启前挂的 ⏳ 永远摘不掉、连 id 都查不到。这一版补三条：**TTL 自动清**（`PROGRESS_TTL_MS = 30 * 60 * 1000`，与 `lib/stream.js` 的 `STREAM_TTL_MS` 同数 —— 半小时还没收尾的真实含义是调用方忘了，不是任务还在跑；清理用纯函数 `expiredIds(records, ttlMs, now)` 算，三个参数全可注入，探针用固定时钟就能测完三条分支，**不开 `setInterval`**，理由是真开定时器既测不了又要管生命周期；清理时机沿用流式那条规矩，`listProgress()` 与 `beginProgress()` 都先 `sweepProgress()`）、**上限说清楚**（`MAX_ACTIVE_PROGRESS = 64` 是「忘了收尾」的探测阈值不是性能上限，撞上限的文案直接点明「当前 N 条，大多是忘了 end 的」）、**落盘跨重启**（新建 `lib/progressstore.js` 119 行，落 `~/.dsh/dsh-push-hub/progress.json`，`MAX_KEEP = 200`，写盘走 `mkdir -p` → `.tmp-<pid>`（mode `0o600`）→ `rename` 原子替换，读坏/不存在/结构不对一律回空表**永不抛**，写失败只把 detail 拼进返回**不判发送失败**）。一个必须说清的边界：**落盘解决的是收尾，不是「状态机复活」** —— 跨重启能恢复的只有「还挂着、id 是什么、该摘哪个表情」，凭据与中间计数恢复不了，所以恢复出来的状态机两个注入函数恒回失败，`endProgress` 会在 detail 补一句「这条是重启前挂的，凭据已失效，只能按记录摘」，**不假装能恢复得和没重启一样**。两个技术点：`initialEmoji` 不能省（按默认走会让平台先留原来那个 ⏳ 再挂 ✅，一条消息两个符号）、单次栅栏必须配测试钩子（`ensureProgressRestored()` 的 `restoredOnce` 只读一次盘是对的，但探针与被测代码同进程，「重启后恢复」这条路径永远返回 `size 0` —— 第一版真跑就这么挂了，加 `__resetProgressCache()` 才能测到；**任何「只做一次」的缓存都必须配测试钩子，否则依赖它的分支在自动化里就是不可达的**）。`listProgress()` 因此变成 async，三处调用点跟着改。新建 `scaffold/probe_progress.mjs` 从 92 项扩到 **116 项**（J 段 24 项）。
**v0.33.0 进度表情**：一条消息发出去之后，先在它上面挂 ⏳，跑完换成 ✅ / ❌（也可以只摘干净不留符号）—— 用户不用翻记录就知道跑到哪了。能挂的是 telegram / slack / discord / matrix 四家，`PROGRESS_CHANNELS` 从 `REACTION_CHANNELS` 派生，不另抄名单：能挂进度符号的前提就是能给这条消息加表情。三条纪律写进 `lib/progress.js` 头注释：①**best-effort 绝不影响发送结果**（消息已经在对方手机上了，表情挂不上是小事；把「加表情失败」升级成「发送失败」，用户会以为没发出去然后重发，对方收到两条）②**同一时刻只有一条 transition 在飞**（先摘旧的再挂新的两步有顺序，并发会出现「旧的摘了新的没挂上」或「同时挂两个」）③**终态只能进一次**（调用方重试是常态，重复收尾会来回改表情，比根本不挂更糟）。`finish` 里刻意不用 `this` —— 调用方把 `finish` 解构出来单独用时 `this` 是 `undefined`，会崩（施工时第一版就这么崩了）。Slack 认名字不认字符：`DEFAULT_SLACK` 是 `hourglass_flowing_sand` / `white_check_mark` / `x`，表外字符回落默认并在 `detail` 里说明，**不猜名字**。八家不能在 `NO_PROGRESS_REASON` 里各写平台级原因（email 单写「邮件没有给一封已经投递的信加个表情这回事」）。新建 `lib/progress.js` 254 行；`lib/bus.js` 加 `beginProgress` / `endProgress` / `listProgress` 并把 `progress: true` 接进 `send` 与 `sendOne`；`lib/index.js` 加三条路由与三个工具（13 → 16）；`lib/client.js` 加「进度表情」只读页（忘收尾的会一直挂着，这一页就是用来发现它的）。顺带补掉 v0.32.0 遗留：`listStreams()` 里调 `sweep()`，返回体多一个 `swept` 数组。新建 `scaffold/probe_progress.mjs` 92 项。
**v0.32.0 流式可编辑消息**：一条消息先发出去，之后边想边改它，想完了把剩下的接着发 —— 长回答不再刷屏，也不用盯着空白等。能流的前提是能改，所以 `STREAM_CHANNELS` 直接从 `EDIT_CHANNELS` 派生（telegram / slack / discord / matrix 四家），八家不能在 `NO_STREAM_REASON` 里各写清平台级原因。四条纪律都对应真实会踩的坑：①必须节流（平台对编辑同一条有频控，每来一个字就 edit 必然被限流，限流后界面停在半句话上，比不流式更难看）②同一时刻只有一个 edit 在飞（回来的顺序不保证，后发先到会让界面**退回**旧文本然后卡住，所以所有 edit 走一条 Promise 链）③中途失败不中断流（只记账继续收，定稿时再试）④finish 幂等（第二次调用原样返回第一次结果）。`normalizeInterval` 把间隔夹到 300~10000 毫秒，而且**夹值必回 detail** —— 静默改用户给的值会骗人。分块只编辑首块，`rest` 攒到定稿时逐块发，切法由调用方注入 `splitBlocks`（两处各写一份会出现「编辑到一半突然跳到别的地方」）。新建 `lib/stream.js` 385 行；`lib/bus.js` 加五个导出（openStream / updateStream / finishStream / cancelStream / listStreams）；`lib/index.js` 加五条路由与三个工具（10 → 13）；`lib/client.js` 加「流式会话」只读页。刻意**不开定时器**，`sweep()` 要调用方择机调 —— 不想在宿主进程里留一个永不停的心跳，代价是僵尸流占名额到重启。新建 `scaffold/probe_stream.mjs` 125 项。
> v0.31.0 起**飞书扫码与飞书接收恢复可用**，靠的是把「借宿主的依赖」改成**两级查找**。这一版不是加功能，是修一次环境事故：主人报「飞书原来都可以扫描接入的，怎么现在又不可以了？」—— 查下来本插件一行代码都没改，是宿主 DSH profile 里的 `@larksuiteoapi/node-sdk` 被清空了（`@larksuiteoapi/` 只剩一个**空目录壳**，mtime `2026-11-17 13:07:54`）。根因在 dsh-im 5.10.0 把这个包从 `dependencies` 挪进了 `devDependencies` —— 作为依赖被安装时不会再带上它；随后一次 npm 操作把它清成空壳。**影响面比扫码大**：`lib/receiver.js` 的 `loadLark()` 借的是同一个包，所以飞书**收消息也一起坏了**（只是 `/receive/status` 的 `receivable` 列表里飞书还在，那是声明层面可收，不反映依赖借不借得到 —— 这个信号会骗人）。修法是新建 `lib/deps.js` 统一所有第三方依赖的解析：**①先查插件自身的 `node_modules`、②再回落 DSH profile**，顺序不能反（反了用户装了插件自带版本也白装）。同时把原本四份各写一遍的 `createRequire` 全部收编（`lib/qr.js` 的 `profileCandidates`/`loadDepViaRequire`/`resolveEsmEntry` 整段删掉、`lib/receiver.js` 的 `loadLark` 与 `requireFromProfile`、`lib/ws.js` 的 `loadUndici`、`lib/channels/email.js` 的 `loadNodemailer`）—— 规则只留一份，否则迟早只有一处跟上。`package.json` 新增 `dependencies: {"@larksuiteoapi/node-sdk":"1.76.0"}`（**钉死精确版本、不带 `^`**），`node_modules` 已在 `.gitignore` 里不提交。另踩到两个坑并写进注释：**createRequire 的锚点不能拿 `package.json` 做存在性判据**（候选目录就是 `node_modules` 本身，npm 不会在它根下写 package.json，`existsSync` 会全部落空 —— 我第一版就是这么写的，装完 52 个包却报「找不到依赖」）；**纯 ESM 包**（`exports` 只有 `import`、没有 `require`/`default`，例如 `@tencent-connect/qqbot-nodejs@1.0.4`）会让 `req.resolve()` 抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`，必须退回「按目录直查」。新建 `scaffold/probe_deps.mjs` **59 项**。
> v0.30.0 起**能给发出去的消息加表情回应** —— 同样只限四个通道（telegram / slack / discord / matrix）。这一版最大的坑是 **Slack 认名字不认字符**：`reactions.add` 的 `name` 参数要的是 `thumbsup` 这种名字，你传 `👍` 它会回 `invalid_name`，而 **HTTP 依然是 200** —— 只看状态码会以为成功。所以新建 `lib/reactions.js` 带一张 Unicode → Slack 名字的对照表（34 个常用表情），**表里没有的直接拒绝并要求填名字，绝不猜一个名字发出去**（猜错名字比不映射更糟：用户会以为「这个表情 Slack 不支持」，实际是名字写错了）。四家语义差别很大，所以都写进注释了：Telegram 的 `reaction` 是 `[{type:'emoji',emoji:'👍'}]` 对象数组，**传空数组 = 清掉全部**（它没有「只删某一个」的接口）；Slack 走 `reactions.add` / `reactions.remove`，需要 `reactions:write` scope，`already_reacted` / `no_reaction` 都判成幂等成功（不是失败）；Discord 是 **PUT** `.../messages/:id/reactions/<emoji>/@me`（成功是 **204 且无响应体**，不能看 body），自定义表情必须写 `name:id`；Matrix 的表情是**一个独立事件**（`m.relates_to.rel_type = 'm.annotation'` + `m.reaction` 放 key），**所以「去掉」要的是「回应事件 id」而不是原消息 id** —— 只能撤回那个事件，这条在界面上直接写明，不假装传原消息 id 也能去掉。能力表跟改/撤一样由后端 `GET /edit/channels` 一并给出（新增 `react` / `reactReasons` 两个字段，界面一次加载把三种按钮都定好）。新增工具 `push_hub_react` / `push_hub_unreact`、路由 `POST /send/react` / `POST /send/unreact`。新建 `scaffold/probe_reactions.mjs` **94 项**。
> v0.29.0 起**发出去的消息可以改、可以撤了** —— 但只限**四个**通道：telegram / slack / discord / matrix。这一版的关键判断是**划清「有能力」与「有把握」的界线**：飞书的官方文档确实有 `PATCH`/`DELETE /open-apis/im/v1/messages/:id`，但本机没有任何飞书凭据、抓官方文档只回 25 字节（SPA 无正文），社区还有人碰到 `invalid msg_type` —— 所以**飞书不做**，理由写在代码注释里：「宁可没有，也不要一个按下去必然报错的按钮」。四家各自的坑都单独处理过：Telegram 只允许撤自己发的、48 小时内，且 `editMessageText` 返回 `message is not modified` 时要当成功（否则用户改成一个一模一样的字会被报失败）；Slack 用 `chat.delete`（dsh-im 里根本没实现，是按官方文档补的，需要 `chat:write`）；Discord 改消息必须显式带 `allowed_mentions: { parse: [] }`，不然改完带 `@everyone` 会真 ping 全频道，撤回成功是 **204 且无响应体**（不能看 body 判成败）；Matrix 的「改」不是编辑原事件，而是**再发一条 `m.replace` 新事件**，撤回是不可逆的 `redact`（客户端可能还留着本地缓存）。同时补上一个 v0.28.0 留下的内部缺口：发件箱以前只存一个摊平的 `messageIds`，多投递目标时**分不清哪条 id 属于哪个聊天**，改/撤无从定位 —— 现在每条按 `places: [{id, messageIds}]` 分组存。前端「发送记录」页每条 id 单独一行，能力表由后端 `/edit/channels` 给（不在前端写死，写死迟早过期，过期后就会给一个点了必然失败的按钮）。新增工具 `push_hub_edit` / `push_hub_delete`、路由 `POST /send/edit` / `POST /send/delete`、`GET /edit/channels`。新建 `scaffold/probe_edits.mjs` 79 项。
> v0.28.0 起**发出去的东西有据可查了**。此前十二个通道的 `send()` 一律只回 `{ ok: true, detail: "已发送 N 块" }` —— 消息确实发出去了，但**「那条消息在平台上是哪一条」这个信息从来没被记下来过**。这不是「没实现改消息/撤回」，而是它们的地基一直缺着：不知道 id，改谁、撤谁无从谈起。这一版只补地基：新建 `lib/outbox.js`（`~/.dsh/dsh-push-hub/outbox.json`，上限 500 条，原子替换写入 mode 600），十二个通道的 `send()` 各自把平台回包里的 id 收集成 `messageIds` 数组（**是数组不是字符串** —— 长消息分块后每块在平台上都是独立消息，只留最后一个会导致「改第一条改不到」），`bus` 逐目标透传，`doSend` 成功一条记一条。**七家给得出真 id**（telegram `result.message_id` / slack `ts` / discord 顶层 `id` / matrix `event_id` / feishu `message_id` / qq 解析后的 `id` / email `info.messageId`），**五家给不出**（微信、群晖、钉钉、企业微信两家：回包只有 errcode/success）—— 对这五家**不编造 id**，探针里反而断言它们源码中「不许出现 messageIds」。新增设置页「发送记录」与工具 `push_hub_sent`，每条明确标「有 id（以后能改能撤）」还是「这个通道不给 id」。**失败不进记录** —— 失败的消息没有 id，记进去既不能改也不能撤，只会把真发出去的挤出保留窗口。新建 `scaffold/probe_outbox.mjs` 64 项。
> v0.27.0 起**别人发来的图片与文件不再凭空消失**。这是本轮自查发现的空洞，不是主人报的：十个接收通道里，**每一个**都只取 `msg.text`，取不到就 `continue` —— 别人给机器人发一张图、一个 PDF、一段语音，收件箱里**一个字都没有**，用户会以为插件坏了。十个平台给附件的形状毫无交集（Telegram 是 `photo[]` 多档尺寸 + `document`，Slack 是 `files[]` 且 subtype 为 `file_share`，Discord 是 `attachments[]`，Matrix 把文件名塞在 `content.body` 里，飞书的 `content` 是一段 JSON 字符串，钉钉只给 `downloadCode` 不给文件名，邮件是 `parsed.attachments`），所以新建 `lib/attachments.js` 做一层归一化，压成统一的 `{kind,name,mediaType,size}`，再拼一句人读摘要进正文（`[图片 photo-a1b2.jpg 900 KB]`）。**刻意不做下载**：拉附件要处理单文件上限、落盘路径、清理策略、凭据泄漏（Slack 的 `url_private` 带 token），那是另一个量级的事 —— 这一版只做「准确记录收到了什么」。顺手修掉 Slack 的一个硬伤：`subtype !== undefined` 把 `file_share` 也挡掉了，等于「Slack 发来的文件永远收不到」。新建 `scaffold/probe_attachments.mjs` 60 项。
> v0.26.2 起**删掉的账号真的会消失**。这是主人实测反馈的缺陷：「QQ 账号我已经移除，再进去的时候为什么还在？」根因在前后端对「键不存在」的理解不一致：前端删掉最后一个账号时把整个通道的键 `delete` 掉了，提交给后端的 `own_bots` 里就没有这个通道；后端 `mergeUserConfig` 把「没有这个键」理解成**「前端这次没提到这个通道」**（这是老前端与局部提交的正常情形），于是走 `continue` 原样保留磁盘上的旧账号 —— 删除动作在前端生效了，落盘却被无视，一刷新又回来了。修法是把语义分开：前端删空时**保留键并传空数组**（明确的「这个通道我一条都不剩了」），后端收到空数组走 `delete own[channel]` 整条抹掉。**这不是 QQ 特有** —— telegram / feishu / wechat / 群晖四个通道走同一条 `own_bots` 路径，一起修好。新建 `scaffold/probe_ownbot_delete.mjs` 19 项（从源码里截出真函数体用 `new Function` 真跑，不是正则猜）。
│   ├── probe_attachments.mjs v0.27.0 新增：入站附件 60 项断言（九个平台的真实 payload 形状逐个喂进去 / 类型与体积 / 摘要 / 接线点 9 处 / Slack 放行 file_share / 收件箱空正文也能入库）
│   ├── probe_outbox.mjs v0.28.0 新增：发送回执 67 项断言（发件箱本体 18 / 十二通道回传 13 / bus 透传 10 / index 记账与路由 10 / 前端 8 / 五家不许编造 id）
│   ├── probe_edits.mjs  v0.29.0 新增：改消息与撤回 79 项断言（能力表 12 / id 归一 10 / 位置反查 8 / 四家通道实现 21 / bus 调度 8 / index 路由与工具 10 / 前端 9 / 能力表一致性 1）
│   ├── probe_reactions.mjs v0.30.0 新增：表情回应 94 项断言（能力表 11 / 表情归一 10 / Slack 名字映射 10 / 四家通道实现 22 / bus 调度 12 / index 路由与工具 9 / 前端 9 / 纪律 11）
│   ├── probe_deps.mjs   v0.31.0 新增：依赖解析 59 项断言（候选顺序 8 / 顺序纪律 3 / 解析能力 16 / 四个模块 10 / 行为 6 / 包声明 8 / 纪律 8）
│   ├── probe_stream.mjs v0.32.0 新增：流式可编辑消息 125 项断言（能力表 11 / 间隔归一化 9 / 分块 6 / createStream 26 / createStreamHub 17 / bus 调度 12 / index 路由与工具 11 / 前端 11 / 纪律 9）
│   ├── probe_progress.mjs v0.33.0 新增（v0.34.0 扩到 116）：进度表情 116 项断言（能力表 11 / 表情归一 11 / 状态机 12 / 幂等与 best-effort 10 / bus 调度 13 / index 路由与工具 10 / 前端 8 / send 链路透传 9 / 纪律 8）
│   ├── probe_ratelimit.mjs v0.35.0 新增：每分钟发送配额 90 项断言（常量与能力表 10 / 归一化 12 / 块数 5 / 状态机 14 / 预约制 6 / bus 接入 15 / 真调用闸门 10 / index 路由与工具 9 / 前端与纪律 9）
│   ├── probe_download.mjs v0.36.0 新增：入站附件下载 106 项断言（常量与能力表 12 / 落盘命名 7 / 策略归一 10 / 落盘与清理 16 / 句柄安全 14 / 对外接口 6 / 收件箱回填 7 / 路由与工具 8 / 接收链路与纪律 10 / HTTP 二进制 6 / 长连接就绪 10）
> v0.26.1 起**设置面板能滚了**。这是主人实测反馈的缺陷：从左上角点开的设置面板看不到下面的选项 —— 工具区只到「扫码接入」，「试发一条 / 代理通道 / 接收消息 / 通道显示 / 通道来源」全被裁掉。原因不是内容没渲染，是根节点 `.dph-root` **只写了 padding 没写高度与溢出**：宿主给的是定高容器，内容超出后直接被裁，浏览器没有滚动条可给。修法是同时补三样：`height: 100%`（撑满宿主的定高容器）、`overflow-y: auto`（超出就出滚动条）、`min-height: 0`（grid/flex 子项默认 `min-height: auto` 会被内容顶开，只写前两条仍不生效）。另加 `scrollbar-gutter: stable` 让滚动条出现时不把内容左右推一下、`overscroll-behavior: contain` 让滚到底不把整页带着滚。**只改 CSS，零逻辑改动**，两份同源样式表一起改。
> v0.26.0 起**通道列表可以自己决定显示什么了**。十二个通道全列在左边，常用的只有三五个 —— 每开一次设置都要在十几个里找。现在有两个旋钮：**「只显示已配置的」**（没填账号的通道直接不出现，就是「绑定了账号的就显示，没绑定就隐藏」）与**逐通道的显示开关**（这一条我暂时不想看到）。两档**叠加**：先按模式决定基础集合，再减去手动关掉的那几条。特别要说清一条纪律：**隐藏 ≠ 停用**。隐藏只改左边列表，发送、接收、默认推送、发文件、收件箱全都不受影响 —— 所以这个键只被 `lib/client.js` 读，`bus.js` 与 `receiver.js` 一个字都不读，隐藏一条通道绝不会让它的消息发不出去。配置存在 `channel_visibility`：`{"mode":"all","hidden":["wecom","wecom_app"]}`。手改配置写错大小写或拼错通道名都不怕：后端 `channelVisibility()` 会归一（mode 只认 `all` / `bound`，hidden 只留已知的 12 个通道名并去重）。
> v0.25.0 起**能引用回复了 —— 五家各自一种写法**。收件箱里看到一条消息、想回它一句，此前只能当新消息发：对方看到的是孤立的一句，上下文断了。现在 Telegram / Slack / Discord / Matrix / QQ 五个通道支持「回复某条消息」，另外七个照常发新消息并在结果里点名原因（**回复是通道能力，不是消息属性** —— 与按钮同一条纪律：不支持就降级，不能因为一句消息带了 replyTo 就整批失败）。五家写法毫无交集：Telegram 是 `reply_parameters`（必须带 `allow_sending_without_reply`，否则被引用那条被删了整条发送就失败）；Slack 是 `thread_ts`（**它不是引用，是开线程** —— 消息会挂在原消息下面的回复串里，频道主视图看不到）；Discord 是 `message_reference`（要 `channel_id`，且 `fail_if_not_exists:false`）；Matrix 要往 `content.m.relates_to['m.in_reply_to']` 塞 `event_id` **并且正文自己加 `> 原文` 前缀**（Matrix 的引用是客户端渲染出来的，服务端不替你拼）；QQ 是 `msg_id + msg_seq`（被动回复有窗口期）。所以又做了一层 `lib/reply.js` 中间表示，与 `lib/buttons.js` 同构。
> v0.24.0 起**钉钉与企业微信也能收了 —— 接收方向到 10 个通道**（Telegram / 微信 / 飞书 / Matrix / Slack / Discord / QQ / 邮件 / 钉钉 / 企业微信自建应用）。此前这两个被列为"收不了"，理由是"群机器人是纯发送 webhook"——**这句话本身没错，但它只是半个事实**：群机器人的 webhook 确实只能发，可两家都另有长连接型的收消息通道。钉钉有 **Stream 模式**（装 `dingtalk-stream` 的 `DWClient`，用**企业内部应用**的 AppKey/AppSecret 换一条 `wss`），企业微信有**智能机器人 WebSocket**（`@wecom/aibot-node-sdk` 的 `WSClient`，用 botId/secret）。两个包都已在 profile 里（dsh-im 在用），**零新增依赖**；两条连接也都是本机发起的，同样不需要公网地址。三个必须做对的点：① **收发是两套凭据**——钉钉群机器人的 webhook + 加签收不了消息，要另建企业内部应用拿 AppKey/AppSecret；企业微信自建应用的 corpId/corpSecret/agentId 也收不了，要另建智能机器人拿 botId/secret。界面上这些字段都标了「（接收才要）」，只发的人一个字不用填；② **钉钉必须先 `socketCallBackResponse` 再处理消息**，不应答钉钉会重投同一条，用户会看到重复回复；③ 钉钉话题名用 SDK 的 `TOPIC_ROBOT`（`/v1.0/im/bot/messages/get`），别手写字符串。真正收不了的只剩 **2 个**：群晖 Chat（只有"传出 URL"回调，NAS 连不进 `127.0.0.1`）与企业微信群机器人（纯发送，要收得换上面那套智能机器人凭据）。
> v0.23.0 起**邮件也能收了 —— 接收方向到 8 个通道**（Telegram / 微信 / 飞书 / Matrix / Slack / Discord / QQ / 邮件）。此前邮件被列为"收不了"，理由是"要 IMAP，与推送语义不同"。这次改主意了：IMAP 同样是**本机主动连出去**，与长轮询没有本质区别；而且"发出去的通知有人回了邮件"恰恰是推送中枢最该知道的事。实现用 profile 里已经装好的 `imapflow` 与 `mailparser`（dsh-im 的邮件通道在用），**零新增依赖**。四个必须做对的点：① **收发是两套服务器**，SMTP 地址不能拿来收信（`smtp.qq.com` 与 `imap.qq.com` 是不同域名），所以机器人卡多了 `imapHost` / `imapPort` 两个字段，只发信可以不填；② **先 `search` 再 `fetchOne`**，不能边取边数 —— 边取边数的话 20 封的批量上限一 `break`，剩下的未读就永远被跳过（游标已推到第 20 封，下一轮只查 `uid >` 游标，前面那些再也回不来）；③ **首次接入只取最新的 20 封**，不是最老的 20 封 —— 用户刚配好想看的是刚到的那封，不是三年前的；④ 没有游标时只查**未读**，否则第一次就把几千封历史全灌进收件箱。仍然明确收不了的是 4 个（群晖 / 钉钉 / 企业微信 / 企业微信自建应用），页面上逐条写原因。
> v0.22.0 起**按钮按下去也能收到了**。此前 v0.20.0 只做「发按钮」，按下之后平台推回来的回调没有任何人接 —— Telegram 的 `update` 会一直留在队列里、`offset` 推不动，Slack 与 Discord 的回调同样石沉大海。现在三个能带按钮的通道都把回调接进同一个收件箱，用 `kind: "callback"` 与普通消息区分（界面上打「按钮按下」标签、左侧一条蓝边）。三家的接法完全不同：**Telegram** 要把 `allowed_updates` 从 `['message']` 扩到 `['message','callback_query']`，且**必须先调 `answerCallbackQuery` 再记账**（不应答客户端会一直转圈）；**Slack** 认 `block_actions` 帧、回调值在 `action.value`；**Discord** 认 `INTERACTION_CREATE`、只处理 `type === 3`（`MESSAGE_COMPONENT`），并且**必须在 3 秒内回 `{ type: 6 }`**，否则客户端直接显示「交互失败」。新增 `GET /receive/inbox/callbacks` 与工具 `push_hub_receive action=callbacks` 只读回调。刻意没做的是「回调自动触发某些动作」——本插件只把回调落进收件箱，要不要据此做事由调用方决定。
> v0.21.0 起**QQ 也能收了 —— 接收方向到 7 个通道**（Telegram / 微信 / 飞书 / Matrix / Slack / Discord / QQ）。此前 QQ 被列为"收不了"，理由是官方要用 `@tencent-connect/qqbot-nodejs` 而这个包在 profile 里装坏了（`ERR_PACKAGE_PATH_NOT_EXPORTED`）。这次改用**官方 WebSocket 网关的裸协议**：`GET https://api.sgroup.qq.com/gateway` 拿 `wss` 地址 → `op:10` hello 起心跳 → `op:2` identify，收 `GROUP_AT_MESSAGE_CREATE`（群 @）与 `C2C_MESSAGE_CREATE`（单聊）两种事件。**连接还是本机发起的，所以同样不需要公网回调地址**。三个必须做对的点：① Authorization 与 identify 的 token 都要写成 `QQBot <token>` 带前缀，裸 token 会 401；② intents 必须含 `GROUP_AND_C2C_EVENT`（`1 << 25`），不带的话群里 @ 机器人的消息一条都收不到；③ 拿 token 复用发消息那条链路的 `appToken()`，不另写一套，避免两处逻辑漂移。仍然明确收不了的是 5 个（群晖 / 钉钉 / 企业微信 / 企业微信自建应用 / 邮件），页面上逐条写原因。
> v0.20.0 起**消息能带按钮了**：工具 `push_hub_send` 多一个 `buttons` 参数（JSON），试发页也多一个输入框。**能带按钮的是 3 个通道**：Telegram（`reply_markup.inline_keyboard`）、Slack（`actions` block）、Discord（`components` action row）。调用方只写一种「通道无关」的按钮（`[{text, callback}]`），翻译成三家格式由 `lib/buttons.js` 统一做 —— 否则同一句话发三个通道要写三份。callback 值**统一按 Telegram 最严的 64 字节验**（三家才都能过），一维数组自动每 5 个折行。其余 9 个通道**照常发文字、按钮丢弃并在结果里点名原因**（飞书要互动卡片、QQ 是 keyboard 字段、邮件只能写链接……）—— 按钮是「通道能力」不是「消息属性」，不能因为一条消息带按钮就整批失败。按钮**只挂在最后一块**，挂每块会变成按一次触发 N 个 callback。
> v0.19.0 起**接收又扩了两个通道：Slack 与 Discord**，一共 6 个通道能收（Telegram / 微信 / 飞书 / Matrix / Slack / Discord）。Slack 走 **Socket Mode**（本机主动连 `wss`，要 App Token `xapp-` 开头、scopes 含 `connections:write`，**不是**发消息那把 Bot Token）；每条带 `envelope_id` 的帧**立刻回 ack**，否则 Slack 会重投、用户会收到重复消息。Discord 走 **Gateway WebSocket**（`gateway/bot` 拿地址 → `op:10` hello 后按 `heartbeat_interval` 起心跳 → `op:2` identify），intents 里**必须带 MESSAGE_CONTENT**（不带不报错，只是 `content` 恒为空）。两个都是 WebSocket，实测**Node 内置的 `WebSocket` 不接受 `dispatcher`、直连必失败**，所以新增 `lib/ws.js` 从 DSH profile 借 `undici` 并挂 `ProxyAgent` —— 与 `lib/http.js` 手写 CONNECT 隧道是同一个原因。剩下 6 个通道（QQ / 群晖 / 钉钉 / 企业微信 / 企业微信自建应用 / 邮件）仍然明确收不了，页面上逐条写原因。
> v0.18.0 起**能发文件了**：新增工具 `push_hub_send_file` 与三个接口（`/send/file`、`/send/file/account`、`/send/file/channels`），机器人卡里凡支持附件的通道多一个「发个文件」按钮。**能发文件的是 5 个通道**：Telegram（图片走 `sendPhoto`、其余走 `sendDocument`）、Slack（`files.getUploadURLExternal` → 裸字节上传 → `files.completeUploadExternal` 三段式）、Discord（`payload_json` + `files[0]`）、Matrix（`/_matrix/media/v3/upload` 拿 `mxc://` 再发 `m.file`/`m.image`）、邮件（nodemailer 附件）。另外七个通道**明确不支持**，选中时会逐条点名而不是静默跳过。文件路径必须是**绝对路径**（相对路径会被拒绝——插件的 cwd 不是你以为的那个目录），文件**只读一次盘**、同一份字节发给所有目标；各平台单文件上限写在 `lib/files.js` 里（Telegram 50 MB / Discord 25 MB / Slack 1 GB / Matrix 50 MB / 邮件 25 MB）。
> v0.17.0 起**机器人卡多了第四页「高级」，十二个通道都补上四个账号级字段**：代理（`proxy`）、分块长度（`maxMessageChars`）、块间延迟（`chunkDelayMs`）、允许自签证书（仅邮件，`allowSelfSigned`）。这四个字段**通道实现本来就在读**，只是界面一直没给入口 —— 想给某个 Telegram 机器人单独走代理、想给某个 Slack 机器人把块间延迟调到 2 秒避开限流，以前只能改配置文件或改代码。分块长度与块间延迟**留空即用通道默认**（Telegram 4096 / 350ms、Slack 3800 / 1100ms 这类），不会因为多一个空字段就改变既有行为；只填了高级字段**不算「有账号」**，不会在列表里留空壳。
> v0.16.0 起**接收从 2 个通道扩到 4 个**：新增**飞书**（官方 `WSClient` 长连接，事件 `im.message.receive_v1`）与 **Matrix**（`/_matrix/client/v3/sync` 长轮询，带 `next_batch` 游标）。两者都是**借 DSH profile 里已装的依赖**（飞书 SDK 由 `createRequire` 从 `~/.dsh/profiles/desktop/node_modules` 解析），本插件仍然**零新增依赖、零构建**；借不到时不抛 `ERR_MODULE_NOT_FOUND`，而是回一句中文「profile 里没有 @larksuiteoapi/node-sdk」并停在那里。Matrix **不解密加密房间**——遇到 `m.room.encrypted` 就跳过并在状态里点出跳了几条，不假装收到。接收页会给每个通道标出收法（长轮询 / WSClient 长连接）。
> v0.15.0 起**能收消息了（Telegram / 微信两个通道）**：宿主只监听 `127.0.0.1`，平台回调进不来，所以接收方向不是 webhook，而是**本插件主动去平台拉**（Telegram `getUpdates` 长轮询、微信 `ilink/bot/getupdates` 带 `get_updates_buf` 游标）。收到的消息落盘到 `~/.dsh/dsh-push-hub/inbox.json`（最多 500 条），界面新增「接收消息」一页可逐通道启停、看收件箱、清空；新增工具 `push_hub_receive` 让对话里也能读收件箱。另外十个通道**明确不支持接收**，页面上逐条写清原因（飞书要装官方 SDK、QQ 是 WebSocket 网关、群晖只有回调……），不假装支持。
> v0.14.0 起**一个机器人可以配多个投递目标**：`own_bots.<通道>[i].targets` 是数组，界面「投递设置」页可以点「+ 再加一个目标」逐条加、逐条删；`target` 只保留第一条作为旧版回落值（老配置一个字不用改，行为与 v0.13.0 完全一致）。扇出放在 `lib/bus.js` 的 `sendToTargets()` 里，**十二个通道实现零改动**；部分目标失败时整体判失败并在回执里点名是哪个 ID 失败。
> v0.13.0 起**通道从 5 个补到 12 个**：新增钉钉（群机器人 Webhook）、企业微信（群机器人 + 自建应用两套）、Slack、Discord、Matrix、邮件。七个新通道全部只用 `lib/http.js` 与 Node 内置模块，**零新增依赖**（邮件借 DSH profile 里已有的 nodemailer）。六个老通道的请求逻辑一行未动，`probe_apply.mjs` 验 `registryCoversAll = true` 即新增通道已全部注册。
> v0.12.0 起**机器人卡的设置拆成标签页**：点蓝色齿轮展开后，顶部是「通用 / 投递设置 / 访问设置」三个标签（群晖只有前两个），此前十几个字段全平铺在一个折叠体里，展开后要滚半天才找得到「发送到」；「检查凭据 / 发条测试消息」不放进任何一页，永远常驻在标签下方。后端与 HTTP API 一行未动。
> v0.11.1 起**「发送到」不再二选一**：类型下拉与手填 ID 输入框**永远同时显示**，点过「获取会话」也不会把输入框藏掉（老版一有候选就把输入框换成下拉，飞书只列群、QQ 恒为空，单聊彻底没地方填）；候选下拉改成另起一行的可选补充，并给五个通道各自的占位文案与「还没填收件人」的醒目提示。
> v0.11.0 起**多了三个入口**：左侧栏「更多」里出现「推送中枢」（点一下整页打开，不再只能钻设置）、插件详情页多了「打开推送中枢」按钮。Client 半身注册的 slot 从 2 个变 5 个（新增 `main` / `sidebar.panellist` / `plugins.detail.actions`），**没有新增任何依赖包**（照 `@xmanrui/dsh-im` 的写法用 `ctx.inject(['layout'])` 懒取布局服务，拿不到就只丢侧栏入口、设置界面照旧可用）。
> v0.10.0 起**切断第三方凭据来源**（不再读 `dsh-bridge` / `dsh-im-connect`，避免账号混乱），密钥显示成**指纹**（`前6位…后4位`）并新增**「明码 / 隐藏」**按钮，群晖 NAS 地址按 QuickConnect 传入 URL 的填法重写文案。
> v0.9.0 起**界面换成 DSH-IM 风格**（左通道列表 + 右侧卡片，机器人收进可折叠卡片，点蓝色齿轮才展开表单），并把**群晖 Chat 两套协议补齐**（webhook / bot 按 `type` 切换、只填 token 自动拼 URL、错误码翻成人话）。请求逻辑与 API 契约一行未动。
> v0.8.0 起支持**通道级代理开关**：填一个代理地址，然后只给「要翻墙的通道」打开开关（Telegram 默认打开，微信/飞书/QQ/群晖默认直连）。**这不是全局代理**——关着的通道照旧直连，互不影响。
> v0.7.0 起**界面改成「左列表 + 右详情」**（对齐 DSH-IM 的分区方式，五套表单不再平铺一页），并且新增**「获取会话」**：点一下就从平台拉出可发目标的下拉，不用再对着空白框猜 `chat_id` / `open_id`。
> v0.5.0 起支持**扫码一键创建机器人**（飞书 / QQ / 微信）：点一下出二维码、手机扫一下，凭据自动填进「自有机器人」，不用再去开放平台翻页面。
> v0.6.0 起**全程自动保存**（改哪个字段就存哪个字段，没有「保存」按钮了），每个账号都能单独**探测凭据**与**测试发送**，并且支持**发到群聊 + @ 指定人/@所有人**（通道间能力不同，逐条如实标注）。
> v0.4.0 起**机器人可以自己填**：设置界面有「自有机器人」卡，自有账号自动置顶并被优先使用；同时修掉「默认通道取消不掉」的老缺陷。
> v0.3.0 起包名前缀从 `@lanbaolu` 改为 `@duma520`，HTTP 路由前缀同步变为 `/@duma520/dsh-push-hub/api`。
> v0.2.0 起带**自有设置界面**：DSH 设置里多一个「推送中枢」分区，插件详情页也能直接改。

---

## 界面截图

<img src="docs/screenshots/push-hub.png" width="880" alt="推送中枢主界面">

> 上图为真机实拍（本机 DSH 桌面版）。截图里的账号名、ID、发送记录已做像素化处理，只保留界面结构。

> 只想快点装起来？直接看根目录的 [INSTALL.txt](INSTALL.txt)：三步安装 + 三处验证 + 配置在哪 + 怎么卸。

---

## 目录

- [界面截图](#界面截图)
- [一、这是什么](#一这是什么)
- [二、零基础入门（照着做就行）](#二零基础入门照着做就行)
- [三、十二个通道逐项说明](#三十二个通道逐项说明)
- [四、三个会话内工具](#四三个会话内工具)
- [五、HTTP API（给外部脚本用）](#五http-api给外部脚本用)
- [六、配置文件详解](#六配置文件详解)
- [七、完整操作示例](#七完整操作示例)
- [八、工作原理（技术参考）](#八工作原理技术参考)
- [九、排错手册](#九排错手册)
- [十、FAQ](#十faq)
- [十一、已知限制与安全说明](#十一已知限制与安全说明)
- [十二、目录结构 / 开发与验证](#十二目录结构--开发与验证)
- [十三、版本更新简介](#十三版本更新简介)
- [十四、设置界面（v0.2.0 新增）](#十四设置界面v020-新增)
  - [14.6 通道级代理（v0.8.0 新增）](#146-通道级代理-v080-新增)
  - [14.7 界面改版为 DSH-IM 风格（v0.9.0）](#147-界面改版为-dsh-im-风格v090)
  - [14.8 切断第三方凭据 + 密钥明码（v0.10.0）](#148-切断第三方凭据--密钥明码v0100)
  - [14.9 侧栏入口与整页面板（v0.11.0）](#149-侧栏入口与整页面板v0110)
  - [14.10 「发送到」为什么改成输入框常驻（v0.11.1）](#1410-发送到为什么改成输入框常驻v0111)
  - [14.11 机器人卡拆成三个标签页（v0.12.0）](#1411-机器人卡拆成三个标签页v0120)
  - [14.12 七个新通道是怎么加的（v0.13.0）](#1412-七个新通道是怎么加的v0130)
  - [14.13 一个机器人发多个目标（v0.14.0）](#1413-一个机器人发多个目标v0140)
  - [14.14 接收消息：四条主动拉的路子（v0.15.0 / v0.16.0）](#1414-接收消息四条主动拉的路子v0150--v0160)
  - [14.15 账号级高级字段：那些一直存在但没入口的设置（v0.17.0）](#1415-账号级高级字段那些一直存在但没入口的设置v0170)
  - [14.16 发文件：五个通道、四种协议、一条读盘纪律（v0.18.0）](#1416-发文件五个通道四种协议一条读盘纪律v0180)
  - [14.17 WebSocket 长连接：Slack Socket Mode 与 Discord Gateway（v0.19.0）](#1417-websocket-长连接slack-socket-mode-与-discord-gatewayv0190)
  - [14.18 消息按钮：一种写法，三家翻译（v0.20.0）](#1418-消息按钮一种写法三家翻译v0200)
  - [14.19 QQ 接收：官方网关的裸协议（v0.21.0）](#1419-qq-接收官方网关的裸协议v0210)
  - [14.20 按钮回调接收：三家各自的应答义务（v0.22.0）](#1420-按钮回调接收三家各自的应答义务v0220)
  - [14.21 邮件接收：两套服务器与一个会漏信的写法（v0.23.0）](#1421-邮件接收两套服务器与一个会漏信的写法v0230)
  - [14.22 钉钉与企业微信：收发是两套凭据（v0.24.0）](#1422-钉钉与企业微信收发是两套凭据v0240)
  - [14.23 回复某条消息：五家一种写法（v0.25.0）](#1423-回复某条消息五家一种写法v0250)
  - [14.24 通道显示：隐藏不等于停用（v0.26.0）](#1424-通道显示隐藏不等于停用v0260)
  - [14.25 设置面板为什么必须自己滚（v0.26.1）](#1425-设置面板为什么必须自己滚v0261)
  - [14.26 删账号：前端留空数组，后端删整条（v0.26.2）](#1426-删账号前端留空数组后端删整条v0262)
  - [14.27 入站附件：十个平台，一层归一化（v0.27.0）](#1427-入站附件十个平台一层归一化v0270)
  - [14.28 发送回执：十二个通道，七家给得出 id（v0.28.0）](#1428-发送回执十二个通道七家给得出-idv0280)
  - [14.29 改消息与撤回：四家做得了，八家做不了（v0.29.0）](#1429-改消息与撤回四家做得了八家做不了v0290)
  - [14.30 表情回应：Slack 认名字，不认字符（v0.30.0）](#1430-表情回应slack-认名字不认字符v0300)
  - [14.31 依赖解析：先查插件自己，再回落宿主（v0.31.0）](#1431-依赖解析先查插件自己再回落宿主v0310)
  - [14.32 流式可编辑消息：一条消息反复改，长回答不再刷屏（v0.32.0）](#1432-流式可编辑消息一条消息反复改长回答不再刷屏v0320)
  - [14.33 进度表情：一条消息挂一个状态符号（v0.33.0）](#1433-进度表情一条消息挂一个状态符号v0330)
  - [14.34 进度表治理：超时的自己清掉，重启过还能收尾（v0.34.0）](#1434-进度表治理超时的自己清掉重启过还能收尾v0340)
  - [14.35 每分钟发送配额：管的是块，不是次（v0.35.0）](#1435-每分钟发送配额管的是块不是次v0350)
  - [14.36 入站附件下载：句柄、上限、清理（v0.36.0）](#1436-入站附件下载句柄上限清理v0360)
  - [14.37 长连接通道连没连上，看得出来（v0.37.0）](#1437-长连接通道连没连上看得出来v0370)
  - [14.38 同一条消息不再记两遍：入站去重、游标落盘、接收权抢占（v0.38.0）](#1438-同一条消息不再记两遍入站去重游标落盘接收权抢占v0380)
  - [14.39 抢不到接收权也不再哑火：可取消请求、冲突短退避、停等旧循环（v0.39.0）](#1439-抢不到接收权也不再哑火可取消请求冲突短退避停等旧循环v0390)
  - [14.40 主面板自己滚：三层容器谁都没管，于是被裁掉（v0.39.1）](#1440-主面板自己滚三层容器谁都没管于是被裁掉v0391)
  - [14.41 群晖三种整合类型：类型跟着面板走，字段跟着类型走（v0.40.0）](#1441-群晖三种整合类型类型跟着面板走字段跟着类型走v0400)
  - [14.42 删掉的机器人又回来了：一份按名字索引的明码缓存（v0.40.2）](#1442-删掉的机器人又回来了一份按名字索引的明码缓存v0402)

---

## 一、这是什么

DSH 是一个可以装插件的 AI 客户端。插件分两半：**Host 半身**（跑在 Node 进程里，能注册工具和 HTTP 路由）和 **Client 半身**（跑在浏览器里，出界面）。

`dsh-push-hub` 从 **v0.2.0** 起两半齐全。它的入口是四个：

| 入口 | 谁用 | 长什么样 |
|---|---|---|
| **设置界面** | 你（手点） | DSH 设置 → 「推送中枢」分区；或 设置 → 插件 → 本插件 → 配置 |
| 会话内工具 | 你和 AI | `push_hub_send` / `push_hub_channels` / `push_hub_selftest` |
| HTTP 路由 | 定时任务、Python 脚本、其它程序 | `POST http://127.0.0.1:<端口>/@duma520/dsh-push-hub/api/send` |
| **侧栏「更多」** | 你（手点） | 左侧栏底部「更多」→「推送中枢」，点一下整页打开（v0.11.0 新增） |
| 插件详情页按钮 | 你（手点） | 设置 → 插件 → 本插件 → 右上「打开推送中枢」（v0.11.0 新增） |
| Client 半身 | 浏览器 | `lib/client.js`，注册五个 slot：`settings.section` / `plugins.bundle.config` / `main` / `sidebar.panellist` / `plugins.detail.actions`（详见[十四节](#十四设置界面v020-新增)） |

它**不接管**收消息。收消息、管理会话不在本插件范围；本插件只管「主动推送」，凭据自持（v0.10.0 起不再借 `dsh-bridge` 的文件）。

---

## 二、零基础入门（照着做就行）

### 2.1 前置条件

1. 本机已装 DSH，并且**知道自己在用哪个 profile**（这一步是本项目踩过最大的坑，见 [九、排错手册](#九排错手册)）。
2. **不需要装 `dsh-bridge`**（v0.10.0 起已切断）。凭据全由本插件自己管：界面里填、或扫码一键创建，落盘在 `C:\Users\<你>\.dsh\dsh-push-hub\config.json`（权限 0600）。

### 2.2 确认 profile（必做）

打开 PowerShell：

```powershell
# 看当前 Web GUI 在哪个端口、哪个进程
netstat -ano | findstr "LISTENING" | findstr ":1"

# 假设上一步看到 PID=2952，那么看它的启动参数指向哪个 profile
Get-CimInstance Win32_Process -Filter "ProcessId=2952" | Select-Object -ExpandProperty CommandLine
```

如果输出里是 `...\.dsh\profiles\desktop\...`，那你的 profile 就是 **desktop**；是 `web` 就是 **web**。**后面一切安装动作都要写进这个 profile。**

> 真实教训：本插件第一次装时写进了 `profiles/web`，而运行的实例是 `profiles/desktop`，结果 loader entry 每次重启都换一个 8 位哈希、fiber 永远起不来、`/api/info` 永远 404。改到 desktop 后一次就通。

### 2.3 安装

插件目录：`<插件根目录>/dsh-push-hub`（就是本仓库）。

**方式 A：用注入器（推荐，可免重启）**

在 DSH 会话里让它执行：

```
dev_install_package({ dir: "<插件根目录>/dsh-push-hub", profile: "desktop" })
```

返回里应包含 `dependencies +=` / `bundles +=` / `node_modules link 已建立`。

然后再执行一次：

```
dev_inject_plugin({ dir: "<插件根目录>/dsh-push-hub" })
```

**必须看到 `host ✓`**。看到 `host ✗` 说明 fiber 没起来，看 [9.2](#92-注入后-host--apiinfo-404)。

> 注意顺序：`dev_reload_package` / `dev_inject_plugin` / `dev_install_package` 这三个**必须单独调用，不要和别的调用并行**。历史上把 `dev_reload_package` 和一次目录搜索放进同一个 `Promise.all`，会让整个会话僵死（reload 在 host 重建 fiber 时不返回）。

**方式 B：手工改 profile（等价，重启后生效）**

编辑 `C:\Users\<你>\.dsh\profiles\desktop\package.json`：

```json
{
  "dependencies": {
    "@duma520/dsh-push-hub": "link:<插件根目录>/dsh-push-hub"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@duma520/dsh-push-hub"
      ]
    }
  }
}
```

然后建 junction（Windows）：

```powershell
New-Item -ItemType Junction `
  -Path   "C:\Users\<你>\.dsh\profiles\desktop\node_modules\@duma520\dsh-push-hub" `
  -Target "<插件根目录>\dsh-push-hub"
```

重启 DSH 即生效。

### 2.4 三下验证（全过就等于装好了）

**第一下：看路由活着**

```powershell
curl.exe -s http://127.0.0.1:9429/@duma520/dsh-push-hub/api/info
```

期望：

```json
{"ok":true,"version":"0.11.1","root":"<插件根目录>\\dsh-push-hub","apiBase":"/@duma520/dsh-push-hub/api"}
```

**第二下：看通道全不全**

在 DSH 会话里：

```
push_hub_selftest()
```

期望 `ok: true`、`registryComplete: true`、`registered` 里五个名字齐。

**第三下：不真发，先预演**

```
push_hub_send({ text: "测试", channels: "feishu", dry_run: true })
```

期望返回里 `dryRun: true`，`plan.feishu = { maxChars: 2000, blocks: 1, bestEffort: false }`。

三下都过了，去掉 `dry_run` 就是真发。

---

## 三、十二个通道逐项说明

所有通道的发送函数签名一致：`send(text, acc, options) → { ok, detail }`，内部按各自上限自动分块，块之间 `sleep(350ms)`（群晖 1500ms）。

| 通道 | 名字 | 单块上限 | 硬/软 | 关键字段 |
|---|---|---|---|---|
| Telegram | `telegram` | 4096 | 硬 | `botToken`、`proxy`、`allowFrom` |
| 飞书 | `feishu` | 2000 | 硬 | `appId`、`appSecret`、`domain`、`allowFrom` |
| QQ | `qq` | 1800 | 硬 | `appId`、`appSecret`、`allowFrom` |
| 微信 | `wechat` | 2000（实际减 20 余量） | **软（best-effort）** | `token`、`baseUrl`、`allowFrom` |
| 群晖 Chat | `synology_chat` | 2000 | 硬 | `webhookUrl`（`incoming`）/ `incomingUrl` 或 `nasUrl`+`token`（`bot`） |
| 钉钉 | `dingtalk` | 3000 | **软（best-effort）** | `webhookUrl`、`secret`（加签，选填） |
| 企业微信（群机器人） | `wecom` | 600 | **软（best-effort）** | `webhookUrl`（key 为 UUID） |
| 企业微信（自建应用） | `wecom_app` | 600 | 硬 | `corpId`、`corpSecret`、`agentId`、`proxy` |
| Slack | `slack` | 3800 | 硬 | `botToken`（`xoxb-`） |
| Discord | `discord` | 1900 | 硬 | `botToken` |
| Matrix | `matrix` | 30000 | 硬 | `homeserver`、`accessToken` |
| 邮件 | `email` | 100000（不分块） | **软（best-effort）** | `smtpHost`、`smtpPort`、`user`、`pass`、`from`、`subject` |

「硬/软」决定整体成功判定：硬通道任一成功 → 整体 ok；只有软通道被选中时才看它自己的结果。

> **v0.13.0 新补的七个通道**里，钉钉 / 企业微信群机器人 / 邮件算**软通道**：它们要么只有 Webhook、没有只读探测接口，要么发送本身是尽力而为。理由与微信一样——它们失败不该把「同时发到 Telegram 群」那条成功的路判成整体失败。Slack / Discord / Matrix 有稳定的只读探测（`auth.test` / `GET /users/@me` / `whoami`），仍是硬通道。
>
> 七个新通道的完整协议细节（端点、body、成功判据、错误码翻译）见 [`docs/通道说明.md`](docs/通道说明.md)。其中三处**容易踩**的地方先在这里点一下：Slack 出业务错时 HTTP 仍是 200，成功判据必须是 `data.ok === true`；Discord 发消息成功是 **200 不是 201**；企业微信群机器人单条上限是 **2048 字节**而中文按 UTF-8 占 3 字节，所以 `MAX_CHARS` 只敢给 600。

### 3.1 Telegram

- 接口：`POST https://api.telegram.org/bot<token>/sendMessage`，body `{chat_id, text, disable_web_page_preview:true}`。
- **必须走代理**。本机直连 `api.telegram.org` 稳超时。代理有两个来源，**账号自己的优先**：①账号的 `proxy` 字段（形如 `http://192.168.x.x:20808`）；②v0.8.0 起可在「代理通道」页打开 Telegram 的开关，用全局那份地址（默认 `http://192.0.2.10:20808`）。详见 [14.6](#146-通道级代理-v080-新增)。
- 对端取 `allowFrom[0]` 当 `chat_id`。本机实测 `allowFrom: ["6317****92"]`。
- 成功判定：HTTP 200 **且** 返回体 `ok === true`。

### 3.2 飞书 / Lark

- 先换 `tenant_access_token`：`POST {host}/open-apis/auth/v3/tenant_access_token/internal`，body `{app_id, app_secret}`。
- 域：`acc.domain === "larksuite"` → `https://open.larksuite.com`，否则 `https://open.feishu.cn`。
- 发消息：`POST {host}/open-apis/im/v1/messages?receive_id_type=<类型>`，header `Authorization: Bearer <token>`。
- 两个必踩点：
  1. `content` 必须是**二次 JSON 字符串**：`content: JSON.stringify({ text: 块 })`，给对象会报参数错。
  2. `receive_id_type` 按 ID 前缀选：`oc_` 开头是 `chat_id`（群），否则 `open_id`（人）。
- 成功判定：HTTP 200 且 `code` 为 0 或不存在。

### 3.3 QQ（QQ 开放平台机器人）

- 先换 token：`POST https://bots.qq.com/app/getAppAccessToken`，body `{appId, clientSecret}`。
- 发消息：`POST https://api.sgroup.qq.com/v2/users/<openid>/messages`，body `{content, msg_type: 0}`。
- **最大的坑是授权头**：

  ```
  Authorization: QQBot <access_token>     ✅ 正确
  Authorization: Bearer <access_token>    ❌ 一律 401
  ```

- 成功判定：HTTP **200 或 201**（QQ 新消息有时回 201）。

### 3.4 微信（iLink 机器人）

- 接口：`POST {baseUrl}/ilink/bot/sendmessage`，默认 base `https://ilinkai.weixin.qq.com`。
- 必要头（少一个都不行）：

  ```
  AuthorizationType: ilink_bot_token
  iLink-App-Id: bot
  iLink-App-ClientVersion: 131584
  X-WECHAT-UIN: <每次随机的 base64url(4 字节)>
  Authorization: Bearer <token>
  ```

- **v0.10.0 起不再带 `context_token`**：实测不带也能发成功（直接打 `/ilink/bot/sendmessage` 得到 `200 {"message_id":…}`），所以不再读 `dsh-bridge` 的 `wechat-context-tokens.json`。改成把「成功发过的 peer」记在本插件自己的 `~/.dsh/dsh-push-hub/wechat-peers.json`（0600），供「获取会话」下拉用。
- **已知故障（2026-11-15 实测，9 个账号全部命中）**：服务端对这些 bot 的 sendmessage 恒返

  ```
  HTTP 200  {"ret": -2, "errmsg": "prepare failed"}
  ```

  同一 token 打 `getconfig` / `sendtyping` 却是 `ret=0`。说明不是参数错，是这个 bot 的发送 RPC 本身没就绪。**改任何参数都无效，唯一修法是人在微信客户端重新扫码绑定该 bot。**
- 因此微信被定为**尽力而为通道**：它失败不拖垮整条推送链（否则日报永远报"失败"）。

### 3.5 群晖 Chat（本项目新增）

- 协议取证来源：Home Assistant core 的 `homeassistant/components/synology_chat/notify.py`。
- 做法：`POST <用户自建 incoming webhook URL>`，body 是**表单编码**，只有一个字段：

  ```
  payload={"text":"消息正文"}
  ```

  即 `application/x-www-form-urlencoded`，不是 JSON。
- token 已嵌在 webhook URL 里（形如 `...&token=%22xxxx%22`），所以配置**只要 webhookUrl**，不用单独填 token。
- 成功判定：**只认 HTTP 200 / 201**（这点和别的通道不同，302 也算失败）。
- 块间隔默认 1500ms（比其他通道慢），因为自建 webhook 吞吐低。

**三种整合类型（v0.40.0 起 `type` 对齐群晖面板）**

群晖 Chat 的「整合」里能建三种东西，数据流向不一样。账号的 `type` 与之一一对应：

| `type` | 面板上的名字 | 方向 | 要填什么 | 本插件能不能发 |
|---|---|---|---|---|
| `incoming`（默认） | 传入的 Webhook | 插件 → 群晖 | `webhookUrl`（或 `nasUrl` + `token` 自动拼） | ✅ 发到该 webhook 绑定的频道 |
| `outgoing` | 发出的 Webhook | 群晖 → 你填的 URL | `outgoingUrl` + `token`（`channel` / `triggerWord` 选填） | ❌ 只登记，不发也不收 |
| `bot` | 机器人 | 传入 URL：插件 → 群晖；传出 URL：群晖 → 你 | `incomingUrl`（或 `nasUrl` + `token`）+ `userIds` | ✅ 只能点对点发数字用户 ID |

**为什么「发出的 Webhook」发不出消息**：面板上 URL 栏的提示是「Synology Chat 会在事件发生时向该 URL 发送请求」，令牌是**你这一侧验签**用的，不是「往群晖发」的凭据 —— 协议上不存在用它对群晖发消息的接口。它同时也是接收方向，而 DSH 宿主只监听 `127.0.0.1:9429`，NAS 连不进来，所以插件**既不发送也不接收**，只把 URL / 令牌 / 频道 / 触发字登记下来备查。`send()` 遇到 `outgoing` 不发任何网络请求，直接返回中文原因。

**兼容老配置**：`type` 是 `"webhook"` 或干脆没写（`undefined`），一律按 `incoming` 处理 —— 原本走的就是 incoming 那套协议，行为不变。归一函数 `normalizeType()` 在 `lib/channels/synology.js`。

**省略完整 URL 的兜底**：只拿到 64 位令牌很常见，所以 `resolveWebhookUrl()` 支持 `nasUrl` + `token` 自动拼 incoming URL；机器人走 `resolveBotUrl()`（优先 `incomingUrl`，否则 `nasUrl` + `token` 拼 chatbot 端点）。填了完整 URL 则原样使用，不重复拼 `entry.cgi`。

### 3.6 钉钉（群自定义机器人）

- 接口：`POST https://oapi.dingtalk.com/robot/send?access_token=<token>`，body `{msgtype:'text', text:{content}}`。
- **为什么只做群机器人、不做内部应用**：内部应用要先换 `access_token` 再调 `/v1.0/robot/oToMessages/batchSend`，还得给每个收件人算 `userid`——凭据面比一条 Webhook 大得多，而推送场景 90% 是「发到群里」。
- **加签**（机器人安全设置里勾了「加签」才需要）：`sign = base64(hmac_sha256(secret, timestamp + '\n' + secret))`，签名与 `timestamp` 一起作为查询参数追加到 URL。`secret` 必须以 `SEC` 开头。
- `accessTokenOf(acc)` 接受**整条 Webhook URL**（正则 `/[?&]access_token=([^&\s]+)/` 抽出 token）或**裸 token**，填哪种都行。
- 成功判定：HTTP 200 **且** `errcode === 0`。错误码翻译：`300001` token 无效 / `300005` 关键词不匹配 / `310000` 加签校验失败 / `130101` 触发频率限制（每分钟 20 条）。
- 与微信并列的软通道：钉钉没有只读探测接口，`probe()` 只校验地址与 secret 形状（secret 非空时必须以 `SEC` 开头），真通不通要看「发条测试消息」。

### 3.7 企业微信（群机器人）

- 接口：`POST https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<UUID>`，body `{msgtype:'text', text:{content, mentioned_list?}}`。
- `key` 是**群机器人 Webhook 里的 UUID**，不是企业 ID，也不是 corpsecret——`probe()` 会校验 UUID 形状（`/^[0-9a-fA-F-]{32,40}$/`）并在失败时提醒别把 corpsecret 填进来。
- **单块上限只给 600 字符**：企业微信群机器人单条上限是 **2048 字节**，中文按 UTF-8 占 3 字节，600 × 3 = 1800 留有富余。给 2000 会直接被服务端截断或报错。
- @ 提醒：只在**最后一块**带 `mentioned_list`（每块都带会让人被反复提醒）；`mention.mode === 'all'` → `['@all']`。
- 成功判定：HTTP 200 **且** `errcode === 0`。错误码：`93000` Webhook 地址无效 / `45009` 接口调用超过限制（每分钟 20 条）/ `40058` 参数不合法 / `40008` 消息类型不合法 / `40014` key 无效。
- 天然发到生成这条 Webhook 的那个群，**没有「发送到」**（`TARGET_META.wecom.kinds = []`）。

### 3.8 企业微信（自建应用）

- 两步：①`GET /cgi-bin/gettoken?corpid=<企业ID>&corpsecret=<应用Secret>` 换 `access_token`；②`POST /cgi-bin/message/send?access_token=<token>`，body `{touser, msgtype:'text', agentid, text:{content}}`。
- **每次发送都重新换 token、不缓存**：企业微信的 `access_token` 是全局单例（同一个应用只能有一个有效 token），别的程序换过一次就把你这颗顶掉；缓存反而更容易出「token 失效」。多一次网络请求换稳定，值。
- `touser` 填**成员账号**（例 `zhangsan`），多个用 `|` 分隔；`@all` 发全员。
- 成功判定：`errcode === 0`。此时还要看 `invaliduser`：部分成员无效也算成功，但会在 `detail` 里点出「这些账号没发出去」。
- 错误码：`40001` Secret 错 / `40013` corpId 错 / `40056` agentId 错 / `40014` token 失效 / `60020` IP 不在可信列表（**最常踩**：企业微信应用必须把本机公网 IP 加进「企业可信IP」）/ `81013` 成员不存在 / `45009` 超频。

### 3.9 Slack

- 接口：`POST https://slack.com/api/chat.postMessage`，头 `Authorization: Bearer xoxb-…`，body `{channel, text}`。
- **关键坑：Slack 出业务错时 HTTP 仍是 200**。`invalid_auth`、`channel_not_found` 全都回 200，成功判据必须是 `data.ok === true`——只看状态码会把失败当成功。
- 频道：`channel` 可以填 `#频道名` 或频道 ID（`C` 开头）。机器人必须被 `/invite` 进那个频道，否则 `not_in_channel`。
- 错误码翻译：`not_authed` / `invalid_auth` / `token_revoked`（重装 App 会换 token）/ `missing_scope`（缺 `chat:write`）/ `channel_not_found` / `not_in_channel` / `is_archived` / `ratelimited` / `msg_too_long`。
- `probe()` 走 `auth.test`：只验 token 与工作区，**不碰频道**（所以「凭据可用」不代表发得出去，还要看机器人有没有进频道）。

### 3.10 Discord

- 接口：`POST https://discord.com/api/v10/channels/<channelId>/messages`，头 `Authorization: Bot <token>`，body `{content}`。
- **成功是 200，不是 201**（REST 惯例里创建资源通常是 201，Discord 这里回 200）。
- 「发送到」要填**频道 ID（纯数字 Snowflake）**，不是频道名。取法：Discord 设置 → 高级 → 打开「开发者模式」，然后右键频道 → 复制频道 ID。
- 429 限流时读 `data.retry_after`（秒）并写进 `detail`，不自动重试（重试会越限越深）。
- 错误码翻译：`50001` 缺权限（`View Channel` / `Send Messages`）/ `50007` 发不到该用户 / `10003` 频道不存在 / `10004` 服务器不存在 / `40001` token 无效 / `50035` 内容格式不对。
- `probe()` 走 `GET /users/@me`，只验 token，不依赖任何服务器或频道。

### 3.11 Matrix

- 接口：`PUT https://<homeserver>/_matrix/client/v3/rooms/<roomId>/send/m.room.message/<txnId>`，头 `Authorization: Bearer <accessToken>`，body `{msgtype:'m.text', body}`。
- 用 `PUT` 而不是 `POST`：Matrix 的发送语义是幂等的，`txnId` 是去重键——同一个 `txnId` 重发不会在房间里落两条。本插件的 `txnId` 是 `'dsh' + Date.now() + '-' + <块序号>`，同一设备内唯一。
- 成功是 200 且回 `{event_id}`。错误码：`M_UNKNOWN_TOKEN` / `M_MISSING_TOKEN` / `M_FORBIDDEN`（不在房间）/ `M_NOT_FOUND`（房间不存在）/ `M_LIMIT_EXCEEDED` / `M_UNKNOWN` / `M_UNRECOGNIZED`。
- **刻意不支持加密房间**：加密房间要用房间的会话密钥加密每条消息，本插件不做这件事——遇到加密房间会**如实报错**，而不是把明文发出去假装成功。
- `accessToken` 取法：Element → 设置 → 帮助与关于 → 访问令牌。`homeserver` 例 `https://matrix.org`。

### 3.12 邮件（SMTP）

- **借 DSH profile 里已有的 `nodemailer`，不新增依赖**：`createRequire(path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'noop.js'))('nodemailer')`。解析不到时返回中文可执行说明，**不会抛 `ERR_MODULE_NOT_FOUND`**。结果缓存在模块级变量里（`cachedNodemailer` / `cachedError`），第二次起不再解析。
- 端口决定加密方式：`465` → `secure: true`（隐式 TLS）；`587` / `25` → STARTTLS。
- **邮件不分块**：长内容切成一堆碎片反而更难读，`MAX_CHARS` 给到 100000 只是防误发一整本书。
- `explainSmtp` 翻译常见 SMTP 错误：`EAUTH`（认证失败，多数邮箱要填「授权码」而不是登录密码）、`ESOCKET`、`ETIMEDOUT`、`EDNS`、`EENVELOPE`（收件人被拒）、`EMESSAGE`。**`535` = 认证失败**，几乎都是把登录密码当授权码填了。
- `probe()` 用 `transport.verify()`：只连服务器做握手与认证，**不发信**。
- 这是软通道：邮件失败不该把「同时发到 Telegram 群」的成功判成整体失败。

---

## 四、三个会话内工具

### 4.1 `push_hub_send`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `text` | string | ✅ | 正文，可多行，按通道上限自动分块 |
| `title` | string | | 会以 `【标题】\n` 加在正文最前 |
| `channels` | string | | 逗号分隔，如 `"feishu,qq"`；留空用 `default_channels` |
| `accounts` | string | | 指定账号，如 `"wechat=爸爸,qq=2"`（纯数字当序号） |
| `dry_run` | boolean | | `true` 只返回分块计划，不真发 |

通道别名：`tg`→telegram、`lark`/`feishu_lark`→feishu、`qqbot`→qq、`wx`/`weixin`→wechat、`chat`→synology_chat。名字里的 `-` 会被当 `_`。

返回示例（真实）：

```json
{
  "ok": true,
  "channels": ["telegram"],
  "summary": "telegram ✓ 已发送 1 块（chat_id=6317****92）",
  "results": {
    "telegram": {
      "ok": true,
      "detail": "已发送 1 块（chat_id=6317****92）",
      "account": "135",
      "title": "Telegram",
      "bestEffort": false
    }
  }
}
```

### 4.2 `push_hub_channels`

无参数。列出十二个通道、上限、是否默认、各有几个账号（**只给账号名，绝不给 token**）。排查「为什么没发出去」先看它。

### 4.3 `push_hub_selftest`

无参数。只看配置与装配，不发任何消息、不消耗配额：

```json
{
  "ok": true,
  "configLoaded": true,
  "registryComplete": true,
  "allChannels": ["telegram","feishu","qq","wechat","synology_chat"],
  "registered": ["telegram","feishu","qq","wechat","synology_chat"],
  "defaults": ["telegram","feishu","qq"]
}
```

---

## 五、HTTP API（给外部脚本用）

前缀 `/@duma520/dsh-push-hub/api`，端口就是当前 Web GUI 的端口（本机 `13623`）。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/send` | 推送。body `{text, title?, channels?, accounts?, dry_run?}`。成功 200，失败 502 |
| GET | `/channels` | 通道 + 账号全景 |
| GET | `/info` | 版本、包根、API 前缀、凭据路径 |
| GET | `/config` | **v0.2.0 新增**：读本插件自己的配置（webhook / token 一律掩码成 `<已配置 后4位>`）。v0.4.0 起额外返回 `ownBotFields`（每个通道可填哪些字段）与 `default_channels_explicit`；**v0.8.0 起额外返回 `proxy`**（已归一化的 `{url, channels:{telegram,feishu,qq,wechat,synology_chat}}`，界面直接拿去渲染开关，不用自己猜默认地址） |
| POST | `/config` | **v0.2.0 新增**：写 `~/.dsh/dsh-push-hub/config.json`。传回掩码值表示「不改」；v0.4.0 起支持 `own_bots`（自有机器人）；**v0.8.0 起支持 `proxy`**（只收 `url` 与 `channels`，未提到的通道保持原值，不会被重置成默认） |
| POST | `/test` | **v0.2.0 新增**：试发。body `{text?, title?, channels?, dry_run?}`，给设置界面的两个按钮用 |
| GET | `/qr/capabilities` | **v0.5.0 新增**：本机能扫哪些通道。返回 `{ok, channels:["feishu","qq","wechat"], capabilities:{feishu:{available,detail}, qq:{...}, wechat:{...}, qrCodeLib:{...}}}` |
| POST | `/qr/start` | **v0.5.0 新增**：起一次扫码会话。body `{channel}`，返回 `{ok, sessionId, channel, phase, message, qr, account}`；通道不支持 → 400 |
| GET | `/qr/poll?sessionId=` | **v0.5.0 新增**：轮询会话。`phase` ∈ `waiting / scanned / success / expired / error`；会话不存在 → 404 |
| POST | `/qr/cancel` | **v0.5.0 新增**：放弃会话（内存里的二维码与凭据一起释放） |
| POST | `/qr/apply` | **v0.5.0 新增**：把扫码拿到的凭据写进 `own_bots`。会话未 success → 404/409，**不会空手保存** |
| POST | `/reveal` | **v0.10.0 新增**：取某个密钥字段的**明文**，给界面上的「明码」按钮用。body `{channel, account, key}`。**白名单校验**：`key` 必须是 `OWN_BOT_FIELDS[channel]` 里 `secret === true` 的那几个，其余一律 400（`proxy` / `name` / `target` / `mention` 都取不到）；未知通道 400、账号不存在 404。明文**只进响应体，不落日志、不写磁盘** |
| POST | `/test/account` | **v0.6.0 新增**：只发**某一个账号**。body `{channel, account?, text?}`，返回 `{ok, channel, account, title, detail, chars}`；成功 200、发送失败 502。**找不到该账号就明确报错，绝不偷换别的账号发** |
| POST | `/probe/account` | **v0.6.0 新增**：只读探测凭据（不发消息）。body `{channel, account?}`，返回 `{ok, supported, detail}`；通道没有只读接口时 `supported:false` 并提示改用测试发送。恒 200 |
| POST | `/targets` | **v0.7.0 新增**：列出该账号「能发到哪些会话」，给界面的「获取会话」下拉用。body `{channel, account?}`，返回 `{ok, items:[{id, kind, label, detail}], note}`；账号不存在 → 404。详见[14.2](#142-界面结构-v070-起改成左列表--右详情)按通道差异 |
| 其它 | — | 404 `{"ok":false,"error":"未知路由 <route>"}` |

示例：

```powershell
curl.exe -X POST http://127.0.0.1:13623/@duma520/dsh-push-hub/api/send `
  -H "Content-Type: application/json" `
  -d '{"text":"构建完成","title":"CI","channels":"feishu,qq"}'
```

注意 `/channels` 与 `/info` 不要求 `POST`；`/send` 必须是 `POST`，否则落到 404 分支。

---

## 六、配置文件详解

### 6.1 加载优先级（低 → 高，同通道账号按字段级合并）

**v0.10.0 起只剩五层**（按你的要求硬切断 `dsh-bridge` / `dsh-im-connect`，避免账号混乱）：

1. 环境变量 `PUSH_HUB_CONFIG` 指向的文件
2. 本插件根目录的 `config.json` —— **只放覆盖项**（手工维护）
3. **`~/.dsh/dsh-push-hub/config.json`** —— 设置界面写的就是这一份（`default_channels` / `synology_chat` / `proxy`）
4. **同一份文件里的 `own_bots`** —— **v0.4.0 新增，自有机器人，优先级最高**
5. 调用方显式传入的 `configPath`（插件 config 里的 `configPath`）

**为什么用字段级合并**：旧的「顶层键整体替换」有个致命问题——用户在设置界面填一个自有 telegram 机器人，`telegram` 这个键就被整体换掉，下层同通道的账号连 `botToken` 一起消失。改成字段级后，上层只填了什么就覆盖什么，没填的字段回落下层。

**自有账号会被提到同通道列表最前面**：`account(cfg, channel)` 在不指定名字时取第一个账号，不置顶的话「自有优先」只是文案，实际发消息仍会取到下层账号。

**每个账号来自哪一层**可以查：`GET /channels` 的每行带 `sources`（`own` / `env` / `local` / `user` / `explicit`）与 `ownCount`。v0.10.0 起 `bridge` / `imconnect` 两个来源值不会再出现。

> **v0.10.0 之前的两层已被删除**：本插件曾额外读 `~/.dsh/dsh-bridge/config.json` 与 `~/.dsh/dsh-im-connect/channels.json`，并有一条 `/import/bridge` 路由把它们搬进自有层。按你的要求（避免账号混乱）已全部切掉——现在删光 `own_bots` 之后**不会再有账号冒出来**，`probe_config.mjs` 的 H 段就是这条断言。

`loadCfg()` **每次调用都重新读盘**，所以改完 `config.json` 不必重启 DSH。

### 6.2 覆盖文件长什么样

`config.example.json` 是占位样例（不含真实凭据）；复制成 `config.json` 再改。`config.json` 已在 `.gitignore` 里。

```json
{
  "default_channels": ["feishu", "qq", "wechat", "synology_chat"],
  "synology_chat": {
    "accounts": [
      {
        "name": "群晖 Chat",
        "webhookUrl": "https://你的NAS:5001/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming&version=2&token=%22你的TOKEN%22",
        "sendChunkDelayMs": 1500,
        "maxMessageChars": 2000
      }
    ]
  }
}
```

### 6.3 字段表

| 字段 | 类型 | 默认 | 取值范围 | 改错会怎样 |
|---|---|---|---|---|
| `default_channels` | string[] | `["telegram","feishu","qq"]` | 十二个通道名 | 写不存在的名字 → 该通道被忽略；**空数组 + `default_channels_explicit: true` → 一个都不默认**（见下方说明） |
| `default_channels_explicit` | boolean | `false` | `true` / `false` | **v0.4.0 新增**。设为 `true` 且 `default_channels` 为空数组时，表示「我确实一个默认通道都不要」。缺这个判别位时空数组会被当成「没配」而回落内置三通道，导致取消不掉（v0.3.0 及以前的缺陷） |
| `own_bots.<通道>` | object[] | 空 | 见「自有机器人」小节 | **v0.4.0 新增**。本插件自己填的凭据，优先级最高；空数组 = 删掉该通道的全部自有账号（**v0.10.0 起不再回落任何第三方文件，该通道就是没有账号**） |
| `<通道>.accounts` | object[] | 空 | — | **v0.10.0 起不再从 dsh-bridge 读**；只有你自己在包内 `config.json` 或用户级文件里手写时才存在，按 `name` 对齐 + 字段级合并 |
| `accounts[].name` | string | `#N` | 任意 | 重名时 `account()` 只认第一个 |
| `accounts[].allowFrom` | string[] | 空 | 对端 ID | 空 → 报「账号 allowFrom 为空，没地方发」 |
| `accounts[].maxMessageChars` | number | 见上表 | > 0 | 传 0/负数/字符串 → 回落通道默认；设太小会把消息切很碎 |
| `accounts[].proxy` | string | 空 | `http://host:port` | 空就是直连（telegram 会超时） |
| `proxy.url` | string | `http://192.0.2.10:20808` | `http(s)://host:port` | **v0.8.0 新增**。通道级代理的地址。不写协议会自动补 `http://`，末尾斜杠会被去掉；留空或写非法值 → 回落内置默认地址（不会变成「无代理」） |
| `proxy.channels.<通道>` | boolean | `telegram: true`，其余 `false` | `true` / `false` | **v0.8.0 新增**。`true` = 该通道走代理，`false` = 直连。写非布尔值（字符串 `"yes"` 之类）会被忽略并保持原值；未提到的通道保持原样 |
| `synology_chat.accounts[].webhookUrl` | string | 空 | `http(s)://...` | 空 → 报「账号缺少 webhookUrl」；不以 http 开头 → 直接拒 |
| `sendChunkDelayMs` | number | 1500 | ≥ 0 | 只影响群晖块间隔 |

### 6.4 自有机器人（v0.4.0 新增）

设置界面「自有机器人（优先级最高）」卡里填的凭据，写在 `~/.dsh/dsh-push-hub/config.json` 的 `own_bots` 键下。**不需要任何第三方插件**（v0.10.0 起 `dsh-bridge` 也已切断），本插件自己用。

**每个通道能填哪些字段**（与 `lib/channels/*.js` 真正读的键一致，别按平台文档另起名字）：

| 通道 | 必填 | 可选 | 说明 |
|---|---|---|---|
| telegram | `botToken` | `proxy` | proxy 只在本机直连超时时需要，形如 `http://127.0.0.1:7890` |
| feishu | `appId`、`appSecret` | `domain` | `domain` 留空 = 飞书，填 `larksuite` = Lark 国际版 |
| qq | `appId`、`appSecret` | — | 授权头是 `QQBot <token>`，不是 Bearer |
| wechat | `token`、`accountId` | `baseUrl` | iLink；`baseUrl` 留空用内置默认 |
| synology_chat | `type` | `webhookUrl` / `nasUrl` / `token` / `userIds` | `type: "webhook"` 填整条传入 URL（含 token）；`type: "bot"` 填 NAS 地址 + 令牌 + 数字用户 ID。**NAS 地址必须 https，且优先用 QuickConnect 传入 URL 的域名**（局域网 IP + 自签证书会撞 `ERR_TLS_CERT_ALTNAME_INVALID`） |

**完整 JSON 形态**：

```json
{
  "default_channels": ["telegram", "qq"],
  "default_channels_explicit": true,
  "own_bots": {
    "telegram": [
      { "name": "我的机器人", "botToken": "123456:ABC-DEF...", "proxy": "http://127.0.0.1:7890" }
    ],
    "feishu": [
      { "name": "公司应用", "appId": "cli_xxx", "appSecret": "xxx" }
    ]
  }
}
```

**三条行为约定**：

1. **优先级最高**：同通道下的自有账号会被提到列表最前面，`push_hub_send` 不指定 `accounts` 时用的就是它。
2. **空数组 = 删掉该通道全部自有账号**（不是把整个通道删掉）。v0.10.0 起不再有下层可回落，删完这个通道就是 0 个账号。
3. **指纹回传 = 不改**：界面显示成 `ABCDEF…7890`（前 6 位 + 后 4 位指纹，v0.10.0 起）时原样保存表示保留旧凭据；把输入框清空（空串）才是**明确清空该字段**。空行（所有字段都没值且没有旧名）不会落盘。点字段右侧的「明码」会向 `POST /reveal` 要一次原文，原文只活在浏览器内存里，**不回写配置文件**。

**为什么微信也允许填**：iLink 主动发消息需要知道对方的 `user id`（形如 `o9cq…@im.wechat`），而这个 ID 只能从收到过消息或手动输入里拿到。所以微信做不到「凭空推给陌生人」（见[十一、已知限制](#十一已知限制与安全说明)），但**能发给指定且已知的 peer**；`context_token` 实测不是必需的（v0.10.0 起已不再带）。

---

## 七、完整操作示例

### 7.1 最简单：给飞书发一句

```
push_hub_send({ text: "跑完了，共处理 128 条" })
```

走默认三通道（telegram/feishu/qq）。想只发飞书：

```
push_hub_send({ text: "跑完了，共处理 128 条", channels: "feishu" })
```

### 7.2 常见组合：日报发两个地方 + 微信兜底

```
push_hub_send({
  title: "每日汇总",
  text: "新增 12 条\n已处理 10 条\n待人工 2 条",
  channels: "feishu,wechat"
})
```

因为微信是软通道、飞书是硬通道，**只要飞书成功整体就是 ok**，微信失败会在 `results.wechat.detail` 里写明 `ret=-2`。

### 7.3 进阶：指定账号 + 先预演再真发

```
# 1) 先看会给谁发、切成几块
push_hub_send({ text: 长文, channels: "qq,wechat", accounts: "qq=2,wechat=<你的微信ID>", dry_run: true })

# 2) 确认 plan 对了再真发
push_hub_send({ text: 长文, channels: "qq,wechat", accounts: "qq=2,wechat=<你的微信ID>" })
```

### 7.4 从外部脚本触发（Python 版 pushhub 常用）

```python
import requests

r = requests.post(
    "http://127.0.0.1:13623/@duma520/dsh-push-hub/api/send",
    json={"text": "定时任务完成", "title": "cron", "channels": "feishu,qq"},
    timeout=60,
)
print(r.status_code, r.json()["summary"])
```

---

## 八、工作原理（技术参考）

### 8.1 装配路径

```
profile/package.json 的 dsh.profile.bundles
        ↓ 启动时装配
cordis.patch.yml  →  - insert: { id: push-hub, name: '@duma520/dsh-push-hub', config: {} }
        ↓
lib/index.js  export const inject = ['webServer', 'tools']
        ↓
apply(ctx, config)  →  ctx.effect(() => ctx.webServer.register(...))
                    →  ctx.effect(() => ctx.tools.register(...)) × 3
```

`ctx.effect(fn, label)` 的返回值会在 fiber 卸载时执行，所以重载/卸载不会残留路由和工具。

### 8.2 一次发送的数据流

```
doSend(input)
  ├ composeBody(title, text)          → 拼标题
  ├ loadCfg()                          → 读盘（每次重读）
  ├ bus.resolveChannels(list, cfg)     → 空则用 default_channels；逐个 normalizeChannel
  ├ dryRun? → planBlocks() 返回计划     ← 到此为止
  └ bus.send(cfg, body, {channels, accounts})
        └ 每个通道：config.account() 取账号 → 通道模块 send() → 内部 splitBlocks + 循环发
        └ 汇总：hardOk || (!hardTried && softOk)
```

### 8.3 代理实现（本项目最硬的一块）

Node 的全局 `fetch`（undici）不暴露 dispatcher，没法在不引入依赖的前提下挂代理。所以 `lib/http.js` 自己实现了 CONNECT 隧道：

```
net/http 连代理 → 发 CONNECT host:443 → 拿回裸 socket
   → tls.connect({ socket, servername: host }) 做 TLS
   → 把这条已加密的 socket 交给 node:http 的报文解析
```

**关键坑（v0.1.1 修复）**：把加密 socket 交给 `http.request` 时 **不能写 `agent: false`**。`agent: false` 的语义是「为这个请求新建一个 Agent」，于是 `createConnection` 被忽略、Node 回落到直连目标 IP，表现为：

```
第 1/1 块连不上: Error: connect ETIMEDOUT 107.181.166.244:443
```

正确写法：

```js
const agent = new http.Agent({ keepAlive: false })
agent.createConnection = () => connection
http.request({ host, port, method, path, headers, agent }, handler)
```

### 8.4 分块算法

`splitBlocks(text, limit)`：按行累积，超过 `limit` 就结块；单行本身超限才硬切。不会把一句话从中间劈开（除单行超长）。

微信额外留 20 字余量：`limit = max(200, configured - 20)`，避免贴上限被判超长。

### 8.5 性能与并发

- 通道之间**串行**发送（`for...of`），块之间 `sleep`。不做并发，避免触发对方限流。
- 单请求超时 `DEFAULT_TIMEOUT = 25000ms`。
- 群晖块间隔 1500ms 是保守值；想快可改 `sendChunkDelayMs`。

---

## 九、排错手册

### 9.1 工具根本不存在（会话里看不到 `push_hub_send`）

**现象**：`push_hub_send` 未定义。
**原因**：插件没装配上，或装到了别的 profile。
**解决**：跑 `dev_plugin_status`，看条目里有没有 `[active] push-hub (@duma520/dsh-push-hub)`。只有 `[no-fiber]` / `[disposed]` / `[failed]` 都不算成功。

### 9.2 注入后 host ✗、`/api/info` 404

**现象**：

```
OK: @duma520/dsh-push-hub 已注入 … - host ✗
```

或 `curl /api/info` → `HTTP=404 bytes=0`。

**三个原因，按顺序查**：

1. **profile 装错**（最常见）。运行的实例是 `desktop`，包却只登记在 `web`。查 [2.2](#22-确认-profile必做)，然后把 link 依赖 + bundle 写进正确的 profile。
2. **entry 只是被 disabled 了**。`dev_plugin_status` 里看到 `[disposed] … [disabled]` 时，**再跑一次 `dev_inject_plugin({dir})**，它会 purgeCache + 重建 junction + `loader.create`，这一次才会 `host ✓`。
3. **旧的幽灵 entry 还在**。同名的 `[failed] 8位哈希` 条目每次重启换哈希、无 `entry` 行 —— 是「create 成功但 fiber 从未起」。它不阻塞新 entry，但看到它说明历史上装配上下文是错的。

### 9.3 `connect ETIMEDOUT 107.181.166.244:443`

**现象**：telegram 报这个 IP 超时。
**原因**：`agent: false` 让 Node 丢弃了代理隧道、回落到直连（见 [8.3](#83-代理实现本项目最硬的一块)）。
**解决**：v0.1.1 已修。自查：`lib/http.js` 的 `viaProxy` 里不应再出现 `agent: false`。

### 9.4 代理明明能用，Node 却超时

排查顺序（本机实测可用）：

```powershell
# 1) 裸 TCP 到代理
Test-NetConnection 192.168.x.x -Port 20808

# 2) curl 走代理打一个已知通的地址
curl.exe -s -o NUL -w "%{http_code}" -x http://192.168.x.x:20808 https://www.google.com/generate_204
# 期望 204
```

> 注意：`curl -x <代理> https://api.telegram.org/` 在本机会返回 `HTTP=000`，`-v` 里是 schannel 的 `CRYPT_E_REVOCATION_OFFLINE` —— 这是 **curl 自己的证书吊销检查**问题，不代表代理坏。Node 侧不受影响。

### 9.5 微信恒返 `ret=-2 prepare failed`

**这不是 bug，是账号状态问题。** 同 token 的 `getconfig` 是 `ret=0` 就证明参数没错。
**解决**：在微信客户端重新扫码绑定该 bot；在此之前把微信当兜底通道用。

### 9.6 QQ 报 401

**现象**：`Authorization: Bearer ...` 被拒。
**解决**：必须是 `Authorization: QQBot <token>`。

### 9.7 飞书发出去是空消息 / 参数错

**原因**：`content` 给了对象而不是字符串。
**解决**：`content: JSON.stringify({ text: 块 })`。

### 9.8 群晖 webhook 一直失败

- 只认 **200 / 201**，302 也算失败（先 `curl -v` 看是不是被重定向到登录页）。
- body 必须是**表单编码**的 `payload=<json>`，不是 JSON body。
- URL 里的 `token=%22xxxx%22` 那段不能改（`%22` 是双引号）。

### 9.9 `改完 config.json 不生效`

`loadCfg()` 每次调用都重读，理论上立即生效。若没生效：①确认改的是 `~/.dsh/dsh-push-hub/config.json`（v0.10.0 起只认这个和包内 `config.json`），②确认没被更高优先级的覆盖项盖住（见 [6.1](#61-加载优先级低--高同通道账号按字段级合并)），③**宿主 ESM 缓存不刷新**时改了 `lib/*.js` 需要「禁用→启用」插件或重启 DSH 才生效（改 JSON 配置不需要）。

### 9.10 删掉的机器人，同名重建后旧 Webhook URL 又回来了

**现象**：在「推送中枢 → 群晖 Chat」里点「移除」删掉一个机器人（比如叫 `DSH 通知`），再点「+ 再接入一个机器人」把名称填成同样的 `DSH 通知` —— Webhook URL 输入框里**立刻出现删之前那条完整地址**，右侧按钮显示「隐藏」而不是「明码」，而且输入框是**只读**的，改不掉、也清不干净。看起来像「删除没删掉、后端又把旧数据吐回来了」。

**原因**：不是后端，是**浏览器端那份「明码」缓存按名称索引**。点过「明码」之后，该字段的明文存在前端的 `revealed` state 里，键是 `通道|名称|字段`（`lib/client.js:1462` `revealKeyOf`），只跟名称有关，跟行号、唯一 ID 都无关。渲染时按当前名称去查（`:1748`），命中就把 `value` 换成明文并置 `readOnly`（`:1756-1759`）。

删掉再同名重建时，新行落到下标 0、名称又是 `DSH 通知`，键正好撞上上一轮留下的那条，于是明文被原样顶回只读框。

> **怎么确认不是后端**：后端 `lib/index.js:677` 是 `const old = oldRows[i] ?? {}` —— 旧行按**数组下标**对齐，与名称毫无关系。若复活来自后端，那么随便起什么名字站到下标 0 都会拿到旧值，不会「只有同名才复活」。这一行把两种假设彻底分开。

**解决**：v0.40.2 已修，只动前端三处 —— `lib/client.js:847` 新增 `clearRevealed(channel,name)`；`:885` `dropOwn` 在删行**之前**先取名字再清缓存；`:904` `patchOwn` 改到 `name` 且与旧值不同时清旧名；`:668-672` `reload()` 拿到配置后 `setRevealed({})` 整体作废。

仍在旧版本上时的手工绕过：删完机器人后**刷新一次页面**（`Ctrl+R`）。刷新会重建整个前端 state，`revealed` 本来就是内存态、从不落盘，刷完就是空的。

**顺带纠正一个直觉**：「移除」在 v0.26.2 之后确实是真删 —— 前端提交 `[channel]: []` 空数组，后端 `index.js:769` `if (accounts.length === 0) delete own[channel]` 整条从磁盘抹掉。所以磁盘上不会有残留，`config.json` 里也查不到旧值；`grep` 磁盘找不到任何痕迹是**正常**的，因为问题从来不在磁盘上。

### 9.11 会话卡死

历史教训：把 `dev_reload_package` 和别的调用放进同一个 `Promise.all` 并行 await，会在 host 重建 fiber 时僵死。
**铁律**：`dev_reload_package` / `dev_inject_plugin` / `dev_install_package` **单独调用**。

---

## 十、FAQ

**Q1：为什么微信是「尽力而为」通道？**
因为服务端对这些 bot 恒返 `ret=-2`，若算硬失败，任何含微信的组合都会整体报失败，日报永远红。软通道语义是「发了就好，没发不拖累」。

**Q2：能同时发到同一个通道的多个账号吗？**
当前不行，一次调用每个通道只取一个账号（`accounts` 里指定哪个）。要发多个账号就调用两次。

**Q3：凭证会不会被插件写到别的地方？**
不会复制到第二处。凭据只存 `~/.dsh/dsh-push-hub/config.json`（0600）这一份；`GET /config` 一律回指纹（`ABCDEF…7890`），真要原文必须显式 `POST /reveal` 且只进响应体，不落日志、不写盘。

**Q4：`push_hub_send` 返回 `ok: true` 但微信没收到？**
看 `results.wechat.ok`。软通道失败不影响整体 `ok`，这是设计而非 bug。

**Q5：消息太长会怎样？**
按通道上限自动分块，块之间 sleep。telegram 4096 / 飞书 2000 / QQ 1800 / 微信 1980 / 群晖 2000。

**Q6：能发图片/文件吗？**
不能。当前十二个通道都只发纯文本。Slack 的 Block Kit、飞书的卡片、Discord 的 embed 都能发富文本，但本插件刻意不做——推送场景要的是「文字可靠送达」，富文本会让分块、转义、@ 提醒三件事同时变复杂。

**Q7：可以不装 dsh-bridge 吗？**
可以，而且 v0.10.0 起**它装不装都跟本插件无关**——本插件只读自己那一份 `~/.dsh/dsh-push-hub/config.json`。「靠 bridge 提供凭据」这条链路已彻底切断（你要求避免账号混乱），删光自己的账号之后**不会再有账号冒出来**。

**Q8：改了 `default_channels` 要重启吗？**
不用，每次发送都重读配置。

**Q9：`/api/send` 为什么是 502 而不是 400？**
沿用 Python 版口径：只要 `outcome.ok !== true` 就回 502（上游推送失败），业务参数错的描述在 body 的 `error` 里。

**Q10：插件会不会自己定时发消息？**
不会。它没有 timer，只在被调用时发。定时靠外部（DSH 的 schedule 或系统计划任务）来触发 `/api/send`。

**Q11：`host ✗` 是不是代码有 bug？**
不一定是。本机用 20 行的最小探针插件也复现 `host ✗`，说明那是装配层问题（profile 装错/entry 被 disabled），跟业务代码无关。

**Q12：怎么彻底卸载？**
`dev_uninject_plugin("push-hub")` 卸 entry，再从 profile 的 `package.json` 删掉 dependency 与 bundles 条目、删 junction，重启。

**Q13：删掉的机器人为什么同名重建就回来了？换个别名就不会？**
因为复活的是**浏览器内存里的「明码」缓存**，它的键是 `通道|名称|字段`（`lib/client.js:1462`），只认名字。同名 → 键撞上 → 旧明文被塞回只读输入框；换个名字 → 键不同 → 自然是干净的。这跟后端无关：后端按下标对齐旧行（`lib/index.js:677`），压根不看名字。v0.40.2 起删除 / 改名 / 重新拉配置三处都会清这份缓存，同名重建也是全新的。旧版本上删完刷一次页面即可。详见 [9.10](#910-删掉的机器人同名重建后旧-webhook-url-又回来了)。

---

## 十一、已知限制与安全说明

**限制**

1. 只发文本，不支持图片/文件/富文本卡片。
2. 一次调用每通道只用一个账号。
3. 微信通道在账号重新扫码前基本不可用（服务端 `ret=-2`）。
4. 群晖 Chat 需要你自己在 NAS 上建 incoming webhook，插件不代建。
5. 无内置重试退避：块失败即整通道失败（`context_token` 失效那一处例外，会去 token 重试一次）。
6. 不做消息去重/幂等，重复调用就是重复发送。
7. **设置界面只在本机 Web GUI 里可用**：client 半身要浏览器加载 bundle，桌面 App 与 Web 版都是同一套；但如果 DSH 版本太老、不认 `dsh.client` 声明，界面不会出现（此时插件仍能用工具与 HTTP 路由）。
8. **本机无法做可视化实测**：开发机没有 Chrome，`mcp__chrome-devtools__*` 报 `Could not find Google Chrome executable for channel 'stable'`，只有 Edge。界面验证靠两条替代证据链（见 [12.4](#124-v020-新增的验证)），**视觉与交互仍需人工点一次确认**。

9. **自有机器人覆盖十二个通道（v0.13.0 起）**：此前只有五个通道能填自有机器人，钉钉 / 企业微信 / Slack / Discord / Matrix / 邮件的账号填了也看不到。v0.13.0 补齐后，十二个通道都能在界面里各自加账号；`lib/index.js` 的 `OWN_BOT_FIELDS` 与 `TARGET_META` 各十二段，`maskedUserConfig()` 按字段表自动遍历，不需要为每个新通道再写一遍掩码逻辑。
10. **第三方凭据来源已全部切断（v0.10.0）**：`dsh-im` / `dsh-bridge` / `dsh-im-connect` 三种来源一个都不再读。此前 `im-connect` 走 DSH 凭据库时本插件读不到密文（`inject` 里没有 `credentials` 服务），这类「预期降级」随着整条链路被删掉而一并消失。
11. **删光账号就真没号了（v0.10.0）**：以前把 `own_bots` 清空后，列表还会从 `dsh-bridge` 回落出一堆别人的账号；现在不会。`probe_config.mjs` 的 H 段就是这条断言（实测 `telegram` 账号 `= []`、来源 `= undefined`）。
12. **扫码只支持飞书 / QQ / 微信**：Telegram 的机器人只能在 BotFather 对话里创建（官方没有二维码授权协议），所以那张卡里 Telegram 只给指路文案，仍要手填 token。
13. **QQ 扫码依赖不随包分发**：`@tencent-connect/qqbot-connector` 的 license 是 `UNLICENSED`，不能随本插件发布。本机装了就能扫（本机实测可用），换了机器没装时按钮会置灰并显示原因，可退回手填。
14. **扫码链路只验证到「二维码出得来」**：真机扫码 → 平台确认 → 回调落盘这一整段没有自动化测试（需要人拿手机扫），代码按各平台官方 SDK 的回调契约实现。
15. **没有第二份凭据可以「比对吧」（v0.10.0）**：以前自有层盖住 `dsh-bridge` 的旧值会静默失败；现在只有自有这一份，不存在两边不一致。换个说法：**你填什么就是什么，填错了不会有别的层来兜底**。
16. **@ 能力各通道不同，不能承诺一致的「@所有人」**：

    | 通道 | @ 指定人 | @ 所有人 | 说明 |
    |---|---|---|---|
    | Telegram | ✅ `entities:text_mention`（必须数字 user id） | ❌ | Bot API **没有** @所有人 的协议；选了「@所有人」会退化成正文 `@all`，实际是否提醒取决于客户端解析，**不可靠** |
    | 飞书 | ✅ `<at open_id="ou_x"></at>` | ✅ `<at user_id="all">所有人</at>` | 需把成员 open_id 填进「@ 指定人」 |
    | QQ | ✅ `<qqbot-at-user id="member_openid" />` | ⚠️ `<qqbot-at-everyone />` | @所有人 要求机器人是群管理员，且**每群每天仅 1 次** |
    | 微信 | ❌ | ❌ | iLink 私有协议没有群、也没有 @ 概念 |
    | 群晖 | ❌ | ❌ | 「传入的 Webhook」发到绑定频道；「机器人」只能点对点；「发出的 Webhook」不参与发送 |

17. **不接管「接收方向」**：群晖的「发出的 Webhook / 斜杠命令 / 应用程序整合」、以及「机器人被 @ 才回复 / 不 @ 也回复」这类**接收侧**语义，都需要公网回调 + 签名校验 + 重试幂等，属于双向桥（dsh-bridge / dsh-im-connect）的职责。本插件 `inject` 只有 `webServer` 与 `tools`，不建收消息链路。
18. **自动保存不是「同步事务」**：600ms 防抖 + 单飞合并，网络抖动时可能晚几秒落盘；连续快速改动只保证**最后一次**被写入。界面状态行会如实显示 `保存失败：<原因>`，不会假装成功。
19. **QQ 的「获取会话」永远是空的**：QQ 开放平台的 `openid` / `group_openid` 是「用户 × 机器人」维度的不透明 ID，机器人没被 @ 过就拿不到任何会话，官方**没有任何 API 能列出可发会话**。界面会如实说明，并指路「先在群里 @ 一次机器人 → 开放平台后台『消息推送』日志里复制」。这不是没实现，是协议没有。
20. **「获取会话」只能看到「机器人收得到的东西」**：Telegram 只从 `getUpdates` 里拿（最多 100 条更新）；飞书只列机器人**已在的群**（需 `im:chat:readonly` 权限）；微信只从本插件自己记的 `wechat-peers.json` 读（v0.10.0 起不再读 dsh-bridge 的 `context-tokens` 缓存）。想让某人/某群出现在下拉里，得先让它跟机器人有过一次交互。想直接发到没交互过的新对象，仍然手填 ID。
21. **代理是「按通道开关」，不是「自动翻墙」**（v0.8.0）：只有你在「代理通道」页打开了某个通道的开关，该通道的请求才会走代理；**直连失败不会自动重试走代理**——那样会把「token 错了」伪装成「网络问题」，掩盖真实故障。所以 Telegram 这类必超时的通道，必须手动把开关打开。
22. **代理只支持 HTTP CONNECT 隧道**：`http://host:port`（含需要认证的 `http://user:pass@host:port`）。**不支持** SOCKS5 / SOCKS4，填 `socks5://` 会连接失败（`http.js` 走的是 `CONNECT` + 自建 TLS，不是 SOCKS 握手）。填了不带协议的 `192.0.2.10:20808` 会自动补成 `http://`。
23. **群晖「机器人」发不了频道（v0.9.0）**：机器人令牌只有 `chatbot` 一个写接口，参数是**数字用户 ID**，所以它只能点对点发私聊；想发到频道只能用 `type: "incoming"`（传入的 Webhook 天然绑定生成它的那个频道）。另外群晖**没有「发私聊」API**——DM 其实是「成员恰好 2 人的私有频道」，要用 DSM 账号密码走 `SYNO.Chat.Post.create`，不在机器人令牌的能力范围内。
24. **群晖「传入的 Webhook」没有只读探测（v0.9.0）**：`SYNO.Chat.External` 对 webhook token 只实现 `incoming` 一个方法，拿它去调 `channel_list` / `user_list` **恒返回 404**。所以 `type: "incoming"` 点「检查凭据」只会告诉你「地址已就绪」，真通不通要看「发条测试消息」——这不是探测没写，是协议没有只读接口。
25. **群晖「发出的 Webhook」不参与发送（v0.40.0）**：它的方向是「群晖 → 你填的 URL」，令牌用于你这一侧验签。`send()` 遇到 `type: "outgoing"` **不发任何网络请求**，直接返回「要发消息请把类型改成「传入的 Webhook」或「机器人」」。同时它也是接收方向（宿主只监听 `127.0.0.1:9429`，NAS 连不进来），所以插件对它是「只登记、发也不收」，不是漏实现。
26. **群晖自签证书 + 局域网 IP 必然连不上（v0.40.1）**：Webhook URL 填局域网地址（`https://192.0.2.65/…`）时，Node 的 fetch 会因证书 SAN 不含 IP 直接拒绝（`ERR_TLS_CERT_ALTNAME_INVALID`；curl 同址报 `(60) SEC_E_WRONG_PRINCIPAL`）。插件会在发请求前识别 `10/8` / `127/8` / `192.168/16` / `172.16-31` 并当场提示换 QuickConnect 域名，但**只认 IPv4 字面量** —— `localhost`、IPv6、内网域名（如 `nas.lan`）都不会被预检命中，仍会走到 TLS 报错。也不提供 `NODE_TLS_REJECT_UNAUTHORIZED=0` 之类开关：自签证书的正解是换域名或把证书装进系统信任链，不是关校验。
27. **「明码」缓存按名称索引，同一时刻两条同名行分不清谁是谁（v0.40.2）**：浏览器的 `revealed` 键是 `通道|名称|字段`（`lib/client.js:1462`），不掺行号也不掺唯一 ID。v0.40.2 已经把「删除」「改名」「重新拉配置」三条会串味的路径全堵上（`clearRevealed` 三处调用 + `reload` 整体作废），但**同时存在两条同名行**时，点「明码」看到的是这个名字下的那一份，不能保证是你正看的那一行。换个说法：名字在插件里承担了「行的身份」这一职责，重名就是自己放弃了这个身份。要根治得给每行发稳定 uuid（`revealKeyOf` / 渲染 / `toggleReveal` 三处一起动），风险大于收益，暂不做。另：`revealed` 是纯内存态，**从不落盘**（明文不该进任何持久载体），所以刷新页面天然清空。

**安全**

- 凭据只有一个来源（v0.10.0）：`~/.dsh/dsh-push-hub/config.json` 的 `own_bots`，本插件自己写，mode `0600`，在 `.gitignore` 里，不入库。`dsh-bridge` / `dsh-im-connect` 的文件一行都不再读。
- 插件根目录的 `config.json` 在 `.gitignore` 里，绝不入库。
- 所有诊断输出（`push_hub_channels` / `push_hub_selftest` / `/channels`）只给账号名与来源分层，不给任何 token 片段。
- `/config` 对自有机器人同样走掩码：secret 字段一律返回**指纹**（≥12 位给 `前6位…后4位`，更短回落 `<已配置 后4位>`），非 secret 字段（`appId` / `accountId`）原样返回（它们本来就不是密文，掩起来反而没法核对）。
- **明文只在点「明码」那一刻存在**：`POST /reveal` 返回原文后只进浏览器内存，不写日志、不写磁盘、不回写 `own_bots`。刷新页面或点「隐藏」即消失。
- `config.redact()` 会把键名匹配 `token|secret|password|key|cookie|hash|salt` 的值替换成 `<N 字符，已隐藏>`，写日志前应先过它。
- HTTP 路由默认只监听本机回环（与 DSH Web GUI 同端口），不要把它暴露到公网 —— `/send` 没有鉴权。

---

## 十二、目录结构 / 开发与验证

> **开源仓库说明**：本仓库只放插件本体（`lib/`、`cordis.patch.yml`、`package.json`、`README.md`、`docs/`、`LICENSE`、`config.example.json`、迭代记录与界面截图）。**`scaffold/`（开发探针与回归脚本）和 `version/`（历次备份快照）不在仓库里** —— 它们绑定本机路径、本机真实账号与历史数据，公开即泄露。下文凡是 `node scaffold/...` 之类的命令都只在作者本机跑得通，clone 本仓库后这些文件并不存在。

```
dsh-push-hub/
├── package.json            版本 0.40.2，纯 ESM，无构建步骤；含 dsh.client 声明
├── cordis.patch.yml        bundle patch（一行 insert 挂载）
├── config.example.json     覆盖项样例（占位符，无真实凭据）
├── config.json             你自己的覆盖项（.gitignore，不入库）
├── .gitignore
├── LICENSE                 BSD-3-Clause
├── README.md               本文件
├── docs/
│   └── 通道说明.md          十二个通道的协议细节与字段对照
├── lib/
│   ├── index.js            Host 半身：5 个工具 + 22 条 API 路由
│   ├── client.js           Client 半身：DSH-IM 风格左列表 + 右卡片界面（手写 ModuleLoader，零构建）+ 自动保存 + 代理通道页（v0.9.0 重写渲染层，v0.12.0 卡片内加三页标签，v0.14.0 投递目标可加多条）
│   ├── theme.js            v0.9.0 新增：dph- 前缀样式表 + installTheme() 幂等注入（照抄 dsh-im 的视觉语言）
│   ├── qr.js               v0.5.0 新增：三平台官方扫码（飞书 / QQ / 微信）+ 会话状态机
│   ├── targets.js          v0.7.0 新增：按通道拉「能发到哪些会话」，给界面的「获取会话」下拉用
│   ├── mentions.js         v0.6.0 新增：发送目标解析（单聊/群聊）+ @ 提醒拼装；v0.14.0 加 targetsOf / describeTargets 支持多目标
│   ├── bus.js              通道注册表 + 群发调度 + 单账号发送/探测 + 成功判定；v0.14.0 加 sendToTargets 多目标扇出
│   ├── config.js           配置分级合并（字段级）+ 自有账号置顶 + 账号选择 + redact + **v0.8.0 通道级代理策略（proxyPolicy / proxyForChannel）**
│   ├── http.js             直连 fetch / 代理 CONNECT+TLS / 表单编码；v0.18.0 加手写 multipart 与裸字节 POST
│   ├── files.js            v0.18.0 新增：读盘（七种拒绝）/ 猜 MIME / 平台上限 / 可读大小
│   ├── ws.js               v0.19.0 新增：借 profile 的 undici 建走代理的 WebSocket（Node 内置的不接受 dispatcher）
│   ├── buttons.js          v0.20.0 新增：通道无关的按钮中间表示（一种写法三家翻译，callback 按 Telegram 的 64 字节验）
│   ├── inbox.js            v0.15.0 新增：收件箱读写（~/.dsh/dsh-push-hub/inbox.json，最多 500 条，坏文件不抛）
│   ├── receiver.js         v0.15.0 新增、v0.16.0 扩到 4 通道、v0.19.0 扩到 6 通道、v0.21.0 扩到 7 通道：接收引擎（长轮询 + 长连接 + 指数退避 + 逐账号状态）
│   ├── text.js             splitBlocks / clip / sleep
│   └── channels/
│       ├── telegram.js
│       ├── feishu.js
│       ├── qq.js
│       ├── wechat.js
│       ├── synology.js
│       ├── dingtalk.js     v0.13.0 新增：群自定义机器人 Webhook（支持加签）
│       ├── wecom.js        v0.13.0 新增：企业微信群机器人 Webhook
│       ├── wecom_app.js    v0.13.0 新增：企业微信自建应用（gettoken → message/send）
│       ├── slack.js        v0.13.0 新增：Web API chat.postMessage（成功判据 data.ok）
│       ├── discord.js      v0.13.0 新增：v10 /channels/{id}/messages（成功是 200）
│       ├── matrix.js       v0.13.0 新增：PUT /rooms/{id}/send（带 txnId，不支持加密房间）
│       └── email.js        v0.13.0 新增：借 profile 的 nodemailer，零新增依赖
├── scaffold/               开发期探针，不参与运行
│   ├── probe_apply.mjs     假 ctx 调 apply，验证工具/路由注册
│   ├── probe_client.mjs    假 __ModuleLoader__，验证 client 两处 slot 注册
│   ├── probe_render.mjs    真跑组件函数，验证树里无 undefined 组件
│   ├── probe_config.mjs    **v0.4.0 新增**：端到端驱动 /config，验自有机器人合并与默认通道清空（测完自动恢复用户配置）
│   ├── probe_reveal.mjs    v0.10.0 新增：端到端验 /reveal 白名单（23 项断言：只放行 secret 字段、其余 400、明文等值、GET 不泄漏）
│   ├── probe_qr.mjs        v0.5.0 新增：真网络起三条扫码会话，验能力探测与二维码渲染
│   ├── probe_qr2.mjs       v0.5.0 新增：飞书 / QQ 二维码 dataURL 长度回归
│   ├── probe_targets.mjs   v0.7.0 新增：真凭据跑一遍 lib/targets.js，看各通道能列出什么（不打印凭据）
│   ├── probe_wechat_peer.mjs  v0.7.0 新增：用真实 peer 复现微信 sendmessage 的 ret 码，定位「填错 ID」还是「服务端故障」
│   ├── probe_proxy.mjs     v0.8.0 新增：代理策略 17 项断言（归一化 / 默认值 / 非法值忽略 / 能力位）
│   ├── probe_proxy_ui.mjs  v0.8.0 新增：强制渲染「代理通道」页，验 5 个开关与四条提示都在
│   ├── probe_newui.mjs     v0.9.0 新增：React 替身 + 假数据，逐个渲染 8 个视图，验 dph- 结构无错
│   ├── probe_synology.mjs  v0.9.0 新增：群晖 20 项断言（URL 自动拼 / 错误码翻译 / 本地拒绝 / 探测）
│   ├── probe_synology_ui.mjs v0.9.0 新增：验群晖按 type 过滤字段（webhook 三格 / bot 四格）与折叠态
│   ├── probe_sidebar.mjs   v0.11.0 新增：侧栏入口 41 项断言（main.key / sidebar id / 图标缩放 / 详情页按钮 / 三种降级宿主）
│   ├── probe_target_ui.mjs v0.11.1 新增：「发送到」19 项断言（有候选时输入框仍在 / 空列表也出输入框 / 占位随通道变 / 未填收件人提示）
│   ├── probe_tabs.mjs      v0.12.0 新增：机器人卡标签页 22 项断言（默认停通用 / 三页互斥 / 群晖只有两页 / 测试按钮常驻 / 脏值回落）
│   ├── probe_multi_target.mjs v0.14.0 新增：多投递目标 37 项断言（targetsOf 去重与回落 / bus 扇出 / 部分失败点名 / 老配置零迁移 / 四组样式）
│   ├── probe_buttons.mjs    v0.20.0 新增：消息按钮 52 项断言（解析校验 / 三家翻译 / 能力表 / 三通道接入 / 与 dsh-im 的取舍）
│   ├── probe_reply.mjs      v0.25.0 新增：引用回复 62 项断言（五家翻译形状 / ID 归一与超长拒绝 / 能力表七条原因 / Matrix 前缀 / 五通道真接了 / bus 透传与降级 / index 校验与路由 / 前端输入框）
│   ├── probe_visibility.mjs v0.26.0 新增：通道显示 37 项断言（归一化七项 / 合并语义 / 发送与接收一个字都不读 / 三道过滤的顺序 / 隐藏≠停用 / 不许第二个真值来源）
│   ├── probe_scroll.mjs     v0.26.1 新增：设置面板滚动 13 项断言（根节点必须同时有 height 与 overflow-y / min-height:0 / 两份 CSS 同源 / 不许用 hidden 掩盖）
│   ├── probe_ownbot_delete.mjs  v0.26.2 新增：删账号 19 项断言（截真函数体用 new Function 真跑：删空后键仍在且为空数组 / 后端空数组走 delete / 十二通道同路径 / 不许退回 delete 键）
│   ├── probe_receive.mjs    v0.15.0 新增、v0.16.0 扩到 62 项、v0.19.0 扩到 91 项、v0.21.0 扩到 100 项、v0.22.0 扩到 112 项、v0.23.0 扩到 131 项、v0.24.0 扩到 152 项：接收方向（收件箱读写与损坏容错 / 能力声明 / 启停 / 五条路由与工具注册 / 前端接收视图 / 两份 CSS 同源 / 飞书长连接与 Matrix 加密跳过 / Slack ack 顺序与 events_api 过滤 / Discord intents 位与心跳确认 / ws.js 借 undici 走代理 / QQ 网关地址与 QQBot 前缀 / 三家按钮回调与各自应答义务 / IMAP 取信不许边取边数）
│   ├── probe_advanced.mjs  v0.17.0 新增：账号级高级字段 36 项断言（五个字段定义 / 数字不当字符串 / 布尔往返 / 清空能删 / 只填高级不算账号 / bus 的块间延迟真覆盖）
│   ├── probe_file.mjs      v0.18.0 新增：发文件能力 88 项断言（读盘七拒 / MIME 猜法 / 平台上限 / multipart 拼装十二项 / 通道清单与拒绝 / 五个 sendFile 实现 / 三条路由与工具 / 前端按钮只在支持处出现）
│   ├── probe_telegram.mjs  读配置打 getMe，验证代理链路
│   └── scan*.mjs           在 app.asar 里分块搜宿主源码串（一次性取证用）
└── version/
    ├── 20261116-v3/        v0.1.1 收尾备份（17 个文件）
    ├── 20261116-v4/        v0.2.0 设置界面备份
    ├── 20261116-v5/        v0.3.0 包名改 @duma520 备份
    ├── 20261116-v6/        v0.4.0 自有机器人来源优先级 + 默认通道显式清空
    ├── 20261116-v7/        v0.5.0 扫码一键创建机器人 + dsh-bridge 一键导入
    ├── 20261116-v8/        v0.6.0 自动保存 + 逐账号探测/测试 + 群聊 @
    ├── 20261116-v9/        v0.7.0 界面重做（左列表 + 右详情）+ 获取会话
    ├── 20261116-v10/       v0.8.0 通道级代理开关（配置策略 + bus 注入 + 代理通道页）
    ├── 20261116-v11/       v0.9.0 DSH-IM 风格界面重写 + 群晖协议补齐
    ├── 20261116-v12/       v0.10.0 硬切断第三方凭据 + 密钥明码按钮 + 群晖传入 URL 文案
    ├── 20261117-v13/       v0.11.0 侧栏「更多」入口 + 整页面板 + 插件详情页按钮
    ├── 20261117-v14/       v0.11.1 「发送到」输入框常驻 + 五通道占位文案 + 收件人提示
    ├── 20261117-v15/       v0.12.0 机器人卡设置拆成 通用 / 投递设置 / 访问设置 三页
    ├── 20261117-v16/       v0.13.0 通道从 5 补到 12（钉钉/企微/企微应用/Slack/Discord/Matrix/邮件）
    ├── 20261117-v17/       v0.14.0 一个机器人可配多个投递目标（targets 数组 + 扇出 + 逐条增删）
    ├── 20261117-v18/       v0.15.0 接收方向：Telegram / 微信长轮询 + 收件箱 + 「接收消息」页
    ├── 20261117-v19/       v0.16.0 接收扩到 4 个通道：飞书 WSClient 长连接 + Matrix /sync 长轮询
    ├── 20261117-v20/       v0.17.0 机器人卡第四页「高级」+ 十二通道的代理 / 分块长度 / 块间延迟 / 自签证书
    ├── 20261117-v21/       v0.18.0 发文件：五个通道的 sendFile + multipart 地基 + 「发个文件」按钮
    ├── 20261117-v22/       v0.19.0 接收扩到 6 通道：Slack Socket Mode + Discord Gateway + lib/ws.js（借 undici 走代理）
    ├── 20261117-v23/       v0.20.0 消息按钮：lib/buttons.js + 三通道翻译 + bus 降级点名 + 试发页按钮输入
    ├── 20261117-v24/       v0.21.0 QQ 接收：官方 WebSocket 网关裸协议（复用 appToken + QQBot 前缀 + GROUP_AND_C2C_EVENT intent）
    ├── 20261117-v25/       v0.22.0 按钮回调接收：Telegram callback_query / Slack block_actions / Discord INTERACTION_CREATE 三家接进同一收件箱
    ├── 20261117-v26/       v0.23.0 邮件接收：IMAP 拉未读（收发两套服务器 + search 后逐封取，不许边取边数）
    ├── 20261117-v27/       v0.24.0 钉钉 Stream 与企业微信智能机器人接收（收发两套凭据）
    ├── 20261117-v28/       v0.25.0 引用回复：lib/reply.js + 五通道接入 + bus 降级点名
    ├── 20261117-v29/       v0.26.0 通道显示：channel_visibility（mode + hidden）+ 通道显示页 + 隐藏≠停用
    ├── 20261117-v30/       v0.26.1 设置面板滚动修复：根节点补 height / overflow-y / min-height:0
    ├── 20261118-v31/       v0.26.2 删账号删不掉：前端删空改传空数组、后端空数组删整条
    ├── 20261118-v32/       v0.27.0 入站附件：十个平台各自形状压成 {kind,name,mediaType,size}
    ├── 20261118-v33/       v0.28.0 发送回执：lib/outbox.js + 十二通道 messageIds + 发送记录页
    ├── 20261118-v34/       v0.29.0 改消息与撤回：lib/edits.js + 四家通道 edit/delete + places 分组
    ├── 20261118-v35/       v0.30.0 表情回应：lib/reactions.js + 四家通道 add/removeReaction + Slack 名字映射
    ├── 20261118-v36/       v0.31.0 依赖解析：lib/deps.js 统一四级回落 + 飞书 SDK 装进插件目录
    ├── 20261118-v37/       v0.32.0 流式可编辑消息：lib/stream.js + bus 五个流式导出 + 五条路由与三个工具
    ├── 20261118-v38/       v0.33.0 进度表情：lib/progress.js + bus 三个进度导出 + send/sendOne 透传 progress + 三条路由与三个工具
    ├── 20261118-v39/       v0.34.0 进度表治理：lib/progressstore.js + progress TTL/MAX + bus 恢复与 sweep + listProgress 变 async
    ├── 20261118-v40/       v0.35.0 每分钟发送配额：lib/ratelimit.js + bus gatedSend 闸门 + 账号级 perMinute + /send/limits 与配额页
    ├── 20261118-v41/       v0.36.0 入站附件下载：attachments 保句柄 + lib/download.js + 四条 files 路由 + push_hub_files + 入站附件页
    ├── 20261119-v42/       v0.37.0 长连接就绪可见：ctx.onReady 六处埋点 + 取不到附件的措辞改准 + probe_download 补 K 段
    ├── 20261119-v43/       v0.38.0 入站去重 + 游标落盘 + 接收权抢占：lib/offsets.js + inbox 判重 + 13 处唯一键 + probe_dedupe
    ├── 20261119-v44/       v0.39.0 409 韧性：http signal 可取消 + 冲突短退避 + 启停不再赛跑 + 界面显示重试次数
    ├── 20261119-v45/       v0.39.1 主面板能滚：.dph-pageWrap 补 max-height/overflow + 8px 可见滚动条（client.js 与 theme.js 两处）
    ├── 20261120-v46/       v0.40.0 群晖三种整合类型：type 改 incoming/outgoing/bot + 字段跟类型走 + 空行不算账号
    ├── 20261120-v47/       v0.40.1 群晖发送失败的两个真因：404 说清两种含义 + 局域网 IP 提前拦（不用等 TLS 报错）
    └── 20261120-v48/       v0.40.2 删掉的机器人又回来了：明码缓存按名称索引 + clearRevealed 三处清理
```

### 12.1 基础验证

```powershell
cd <插件根目录>\dsh-push-hub

# 语法检查（零依赖，最常用）
Get-ChildItem lib\*.js, lib\channels\*.js | ForEach-Object { node --check $_.FullName }

# 用假 ctx 跑一遍 apply，确认三个工具与路由都能注册上
node scaffold\probe_apply.mjs

# 用真配置打 telegram getMe，验证代理链路
node scaffold\probe_telegram.mjs

# 质量红线（需要联网拉校验器）
npx --yes dsh-plugin-standard@2 . --json
```

**改代码后必做**：`node --check` 全绿 → 重载插件 → `curl /api/info` 看版本号变了 → `push_hub_selftest()` → 一次 `dry_run` → 一次真发。

重载的优先路径是 `dev_reload_package({packageName:'push-hub'})`（必须**单独调用**，和别的工具放进 `Promise.all` 会让宿主重建 fiber 时不返回，整个会话僵死）。某些会话里 `dev_*` 系列工具不存在（`TypeError: tools.dev_reload_package is not a function`），这时只能人工重载：**设置 → 插件 → dsh-push-hub → 禁用 → 启用**，或重启 DSH。

> 判断「宿主到底加载的是哪份代码」只看一个证据：`GET /api/info` 的 `version`。它是每次请求现读磁盘的 `package.json`，**看到新版本号不代表宿主内存里是新模块** —— 还要看新路由是否命中（例如 v0.5.0 的 `GET /api/qr/capabilities` 返回 404 就说明内存里还是 v0.4.0）。

### 12.2 v0.5.0 新增的验证（扫码）

```powershell
# 端到端：扫码路由挂载 / 扫码落盘 / 同名覆盖 / 守卫
node scaffold\probe_qr.mjs
# 期望：capabilities 里 feishu/qq/wechat 全 true；/qr/apply 未知会话 404；/qr/start telegram 400
# 注意：v0.10.0 起 /import/bridge 路由与 probe_import.mjs 已删除（bridge 链路整体切断）

# 真网络：起三条扫码会话（不会真的扫，只验二维码能出来）
node scaffold\probe_qr.mjs
# 期望：wechat 的 qr 以 data:image/png;base64,iVBORw0KGgo 开头，长度 ~4900

node scaffold\probe_qr2.mjs
# 期望：feishu / qq 的 qr 长度各 ~4800 / ~5300
```

一个容易踩的点：**QQ 那个包在 ESM 语境下不能直接 `createRequire`**。`@tencent-connect/qqbot-connector` 的 package.json 是 `"type":"module"`，而 `exports.require` 又指向 `.js`；`createRequire` 会拿到 `dist/cjs/index.js` 再被当成 ESM 解析，抛 `exports is not defined in ES module scope`。`lib/qr.js` 的 `loadDep()` 因此是两段式：先 require，失败再按 `exports.import → module → main` 找到 ESM 入口用 `import()` 加载（解析基准用 `pathToFileURL` 钉成绝对路径，因为裸包名在本插件目录根本解析不了）。

### 12.3 v0.6.0 新增的验证（自动保存 + 逐账号）

```powershell
node scaffold\probe_config.mjs     # A~H：自有账号合并 / 指纹回传 / 空串清空 / 默认通道显式清空 / 删自有不回落
node scaffold\probe_reveal.mjs     # 23 项：/reveal 白名单 + 指纹格式 + GET 不泄漏明文
node scaffold\probe_render.mjs     # 两 slot 各 6 张 Card，渲染零错误（缺 useRef 会让它误报）
```

三条与 v0.6.0 直接相关的检查点：

1. **自动保存不能把空值写盘**：`lib/client.js` 有 `hydrated` 闸门，首次 `reload()` 完成前任何 state 变化都不触发保存。改这段时先确认 `hydrated.current = true` 仍在 `reload()` 末尾。
2. **保存要单飞**：`applySave()` 用 `savingRef` 判在飞、`pendingRef` 存最新一次待发载荷。不要改成「每次改动都直接 fetch」——连续输入会打出一串并发 `POST /config`，后到的旧载荷可能盖掉新值。
3. **测试发送绝不能偷换账号**：`bus.sendOne()` 找不到指定账号时必须明确报「没有名为 X 的账号」，不能回落到第一个账号。这条有真实风险 —— 用户以为自己测的是群 A，实际发到了群 B。

```powershell
# 单账号试发 / 只读探测（换成本机真实通道与账号名）
curl.exe -s -X POST http://127.0.0.1:<端口>/@duma520/dsh-push-hub/api/probe/account -H "Content-Type: application/json" -d "{\"channel\":\"telegram\",\"account\":\"135\"}"
curl.exe -s -X POST http://127.0.0.1:<端口>/@duma520/dsh-push-hub/api/test/account  -H "Content-Type: application/json" -d "{\"channel\":\"telegram\",\"account\":\"135\",\"text\":\"ping\"}"
```

### 12.4 v0.2.0 新增的验证

改 `lib/client.js` 后除了 `node --check`，还要跑两个探针（都在 `scaffold/` 下，零依赖）：

```powershell
# 假 __ModuleLoader__ 截获 factory，验证两处 slot 是否注册
node scaffold\probe_client.mjs
# 期望：apply 抛错 = (无)；依次出现
#   inject:settings.section  → register:settings.section id=push-hub order=38 labelFn=function
#   inject:plugins.bundle.config → register:plugins.bundle.config id=@duma520/dsh-push-hub

# 真跑组件函数、递归展开元素树，验证没有 undefined 组件
node scaffold\probe_render.mjs
# 期望：子组件 = PushHubSettings, Progress；渲染错误 = (无)（v0.7.0 起顶层不再用 Card 平铺）
```

**确认 client 半身真的进了宿主 boot graph**（这是唯一能证明 bundle 被宿主接纳的运行时证据）：

```powershell
curl.exe -s -N http://127.0.0.1:<端口>/plugins/events | Select-String "@duma520/dsh-push-hub"
```

`/plugins/events` 是一条 SSE 流，首帧是 `{"type":"graph","graph":{...entries:[...]}}`。本机实测 114 个 entry，本插件在其中，形态是：

```json
{"id":"@duma520/dsh-push-hub","url":"plugins/…/@duma520/dsh-push-hub/client.js&rev=<hash>","rev":"<hash>","inject":["slots"]}
```

不在图里 = `dsh.client` 声明没被识别，界面不会出现。此时依次查 `package.json` 的 `exports['./client']`、`dsh.client`、`dsh.bundle.patch` 三样是否齐全。

> 注：直接 `curl /plugins/@duma520/dsh-push-hub/client.js` 会 404，**这是正常的** —— bundle 路由带 revision 查询串，且对未知 resource 一律 404。判断依据只能是 `/plugins/events` 的图。

**改 `lib/config.js` / `lib/index.js` 后的路由验证**：

```powershell
# 三条新路由
curl.exe -s http://127.0.0.1:<端口>/@duma520/dsh-push-hub/api/config
curl.exe -s -X POST http://127.0.0.1:<端口>/@duma520/dsh-push-hub/api/test -H "Content-Type: application/json" -d "{\"text\":\"ping\",\"dry_run\":true}"
```

`/config` 返回里 `webhookUrl` 必须是 `<已配置 XXXX>` 形式（掩码），**不能是完整 URL**；若看到完整 URL，说明 `maskedUserConfig()` 没生效，是缺陷。

---

### 12.5 v0.7.0 新增的验证（界面重做 + 获取会话）

四条与 v0.7.0 直接相关的检查点：

1. **「获取会话」前必须先 flush 保存**：`loadTargets()` 里第一句是 `await applySave(buildPayload(), false)`，然后才 `POST /targets`。`/targets` 走的是 `config.load()`（读磁盘），600ms 防抖还没落盘时会「找不到账号」，用户看到的提示会完全无法理解。删掉这句 flush 就等于把这个坑重新挖开。
2. **下拉选中的 kind 要跟着走**：从下拉里选一个群时，`patchOwn` 同时写 `target.kind = pickedItem.kind`。只写 id 不写 kind 会导致「选了群却按单聊发」——QQ/飞书是两个不同端点，直接发不出去。
3. **左栏一次只渲染一个通道**：`mainBody` 里 `view === 'channel'` 时才取 `channelDetail(selectedChannel)`。不要把五个通道的卡片同时 map 出来，那会退回 v0.6.0 的「五套表单平铺」。
4. **首次进入要自动选中**：`reload()` 末尾的 `setSelectedChannel` 只在前值为空时生效（`prev !== '' ? prev : ...`），否则每次自动保存后 reload 都会把用户手动切的通道跳回去。

```powershell
cd <插件根目录>\dsh-push-hub

# 真凭据跑一遍 lib/targets.js：看每个通道到底能列出什么（不打印任何凭据值）
node scaffold\probe_targets.mjs
# 本机实测（2026-11-16）：
#   telegram       ok=false items=0  note=机器人还没收到过任何消息…
#   feishu         ok=false items=0  note=机器人还没被拉进任何群…
#   qq             ok=false items=0  note=QQ 开放平台不提供「列出可发会话」接口…
#   wechat         ok=true  items=3  （从 context-tokens 缓存读出 3 个互动过的 peer）
#   synology_chat  ok=false items=0  note=webhook 类型不需要填发送目标…

# 复现微信 sendmessage 的 ret 码（区分「填错 ID」与「服务端故障」）
node scaffold\probe_wechat_peer.mjs
# 本机实测：用真实 peer（o9cq…@im.wechat）发，服务端回 ret=-2 prepare failed；
# 用户在界面里手填 <你的微信ID> 时回 ret=-3 invalid arguments。
# 结论：ret=-3 是 ID 格式错（不是故障），ret=-2 才是服务端已知故障。
```

---

### 12.6 v0.8.0 新增的验证（通道级代理开关）

五条与 v0.8.0 直接相关的检查点：

1. **代理策略必须归一化后再用**：`proxyPolicy(cfg)` 是唯一的读入口，界面与 `bus.js` 都走它。直接读 `cfg.proxy.url` 会在「用户从没配过」时拿到 `undefined`，请求带着空串走进 `http.request()` 的直连分支——Telegram 就稳超时，而界面上开关明明是开着的。
2. **注入必须浅拷贝，不能就地改**：`bus.js` 的 `withChannelProxy()` 返回 `{ ...acc, proxy }`。`config.account(cfg, channel, name)` 返回的是 `cfg` 里的**共享对象引用**，就地写 `acc.proxy = ...` 会污染整份配置，下一次读到的账号已经带着代理了。
3. **账号自填的 proxy 优先于通道开关**：`withChannelProxy()` 第一句就是「账号自己有值就直接返回」。调换这个顺序，会让用户在账号卡里填的具体地址被通道开关悄悄盖掉。
4. **`buildPayload()` 必须带上 `proxy`**，且 `useCallback` 依赖数组要补 `proxy`。漏了依赖 → 改了开关但 debounce 里用的还是旧闭包 → 界面显示已保存、磁盘上没变。
5. **前端不猜默认值**：`GET /config` 返回的 `proxy` 是**后端归一化后**的完整对象（地址已补协议、五个通道都是布尔）。界面直接渲染，不在前端重复实现一遍默认值表——两处各写一份必然漂移。

```powershell
cd <插件根目录>\dsh-push-hub

# 代理策略 17 项断言（归一化 / 默认值 / 非法值忽略 / 能力位）
node scaffold\probe_proxy.mjs
# 期望：PROXY_PROBE_ALL_OK

# 强制渲染「代理通道」页，验 5 个开关与四条提示都在
node scaffold\probe_proxy_ui.mjs
# 期望：PROXY_UI_OK

# 回归：界面两处 slot + 两个 view 能渲染
node scaffold\probe_client.mjs
node scaffold\probe_render.mjs
```

### 12.7 v0.9.0 新增的验证（界面重写 + 群晖补齐）

五条与 v0.9.0 直接相关的检查点：

1. **渲染层不许碰业务逻辑**：这次只把 `h('div', { style: S.xxx })` 换成 `h('div', { className: 'dph-xxx' })`。`buildPayload()` / `applySave()` / `reload()` / 扫码 / 导入 / 获取会话的代码**一行没改**——如果 refactor 时顺手"优化"了它们，就等于把已经验证过的行为重新引入风险。
2. **样式必须走 `ctx.effect` 注入**：`apply(ctx)` 第一行是 `ctx.effect(() => installTheme(), 'push-hub: 样式表')`。`installTheme()` 返回 disposer（`() => style.remove()`），插件卸载时样式自动清掉；不返回 disposer 会在反复禁启用后堆出多个 `<style>`。
3. **`dsh.client.inject` 绝不能再加包**：只有 `dsh-client-runtime` + `dsh-client-ui-slots` 两个。加 `ui-settings` / `locale` / `connection` 里任何一个而本机 profile 没装，**整个客户端插件不激活、设置面板直接消失**（dsh-im 的做法在这里行不通，这正是「只搬界面不搬宿主」的原因）。
4. **折叠用 `data-open` 表达状态**：卡片详情是 `grid-template-rows: 0fr → 1fr` 过渡，**DOM 里字段一直在**，只是被 `visibility: hidden` 藏住。任何"文本里有没有某个字段名"的断言都会误判 —— 必须看 `data-open` 属性或字段标签节点（这个坑在写 `probe_synology_ui.mjs` 时踩过，4 条断言假红）。
5. **群晖按 `type` 过滤字段，webhook 也要留 `nasUrl` + `token`**：只给完整 URL 是最直觉的做法，但很多人手里只有一个 64 位 token。`visibleFields` 对 webhook 保留三格（`webhookUrl` / `nasUrl` / `token`），`resolveWebhookUrl()` 才能在其缺 URL 时自动拼出 `?api=SYNO.Chat.External&method=incoming&version=2&token=…`。

```powershell
cd <插件根目录>\dsh-push-hub

# 界面：React 替身 + 假数据，逐个渲染 8 个视图（通道/扫码/代理/试发/来源/摘要等）
node scaffold\probe_newui.mjs
# 期望：NEWUI_OK 全部 8 个视图渲染通过

# 群晖通道纯逻辑：URL 自动拼 / 错误码翻译 / 本地拒绝 / 探测（不发网络）
node scaffold\probe_synology.mjs
# 期望：SYNOLOGY_CHANNEL_OK 群晖通道 20 项断言全通过

# 群晖界面：按 type 过滤字段 + 折叠态
node scaffold\probe_synology_ui.mjs
# 期望：SYNOLOGY_UI_OK 群晖两种类型的字段过滤与折叠态都正确

# 全量回归（13 条）
node scaffold\probe_apply.mjs; node scaffold\probe_client.mjs; node scaffold\probe_config.mjs
node scaffold\probe_render.mjs; node scaffold\probe_proxy.mjs; node scaffold\probe_proxy_ui.mjs
node scaffold\probe_targets.mjs; node scaffold\probe_reveal.mjs; node scaffold\probe_newui.mjs
node scaffold\probe_synology.mjs; node scaffold\probe_synology_ui.mjs; node scaffold\probe_sidebar.mjs
node scaffold\probe_target_ui.mjs; node scaffold\probe_tabs.mjs
```

### 12.8 v0.10.0 新增的验证（硬切断 + 明码）

```powershell
cd <插件根目录>\dsh-push-hub

# /reveal 白名单 23 项断言（只放行 secret 字段 / 其余 400 / 明文等值 / GET 不泄漏）
node scaffold\probe_reveal.mjs
# 期望：REVEAL_OK

# 配置层：H 段断言「删光自有账号后不再回落第三方文件」
node scaffold\probe_config.mjs
# 期望：A~H 全绿，H 段 telegram 账号 = []、来源 = undefined
```

四条与 v0.10.0 直接相关的检查点：

1. **`resolveLayers()` 里不能还有 bridge / imconnect 层**：v0.10.0 把 `lib/config.js` 里的两个 label 段整段删了。任何后续改动若重新 `push({ label: 'bridge' })`，都会让「删光账号不会再有号冒出来」这条保证失效 —— `probe_config.mjs` 的 H 段是它的守门断言。
2. **`/reveal` 必须白名单**：只允许 `OWN_BOT_FIELDS[channel]` 里 `secret === true` 的 key，其余一律 400；未知账号 404。不加白名单的话它就是个「任意字段读取器」，`proxy` / `name` / `target` 都会被读出去（`probe_reveal.mjs` 的 C 段验这四个）。
3. **明文绝不回写 `ownBots`**：前端把 `/reveal` 的返回值放在独立的 `revealed` state 里，**不能** merge 回 `ownBots` —— 否则 600ms 防抖自动保存会把掩码覆盖成明文，等于把密钥永久落盘在「可回显」状态。这条一旦改错，表现是「点一次明码，之后一直是明码」。
4. **微信 probe 的判据是「有没有 `ret` 字段」**：真 token 返 `ret`（`-2` 缺 `ilink_user_id` / `-4` 上游 typing 服务故障），假 token 返 `errcode: -14`（`session timeout`）。别改成「`ret === 0` 才算可用」，那样 9 个账号会全变红。


### 12.9 v0.11.0 新增的验证（侧栏入口）

```powershell
cd <插件根目录>\dsh-push-hub

# 侧栏入口：41 项断言（面板 id 一致 / 图标随 size / 详情页按钮 / 三种降级宿主）
node scaffold\probe_sidebar.mjs
# 期望：SIDEBAR_OK 侧栏入口 41 项断言全通过
```

五条与 v0.11.0 直接相关的检查点：

1. **`main` 的 key 与 `sidebar.panellist` 的 id 必须是同一个常量**：两处都写死字符串也能跑，但改名时漏一处，表现是「侧栏有条目、点进去空白」或「面板能开、侧栏没图标」。代码里统一用 `PANEL_ID`，探针 B1/C1 就是守这条。
2. **`main` 的键不能是保留字 `conversation`**：那是会话面板的键，占用会让会话页渲染成推送中枢。`probe_sidebar.mjs` 的 B2 直接断言 `key !== 'conversation'`。
3. **`dsh.client.inject` 仍然只有两个包**：布局服务靠 `ctx.inject(['layout'])` **懒取**，不进 inject 数组。写进 inject 而宿主 profile 没装，客户端插件整体不激活 —— 与 12.7 第 3 条是同一个坑。
4. **拿不到 layout 必须静默降级**：`ctx.inject` 不存在（老宿主）、抛错（没这个服务）、`pageCtx.slots` 缺失，三种情况都只跳过侧栏入口，**设置分区与插件详情页照旧可用**。宁可少一个入口，也不能让插件激活失败（探针 F/G 段各覆盖一遍）。
5. **主面板是整页，不是弹窗**：`PushHubPanel` 用 `dph-pageWrap` 包一层（`padding: 20px 24px 28px; max-width: 1180px; margin: 0 auto`），因为 `main` slot 渲染的是整个内容区，没有外层的设置弹窗容器给它撑边距。改样式时两边 CSS（`lib/theme.js` 与 `lib/client.js` 内联的 `THEME_CSS`）必须一起改。


### 12.10 v0.11.1 新增的验证（「发送到」输入框常驻）

```powershell
cd <插件根目录>\dsh-push-hub

# 「发送到」字段：19 项断言（有候选时输入框仍在 / 空列表也出输入框 / 占位随通道变 / 未填时提示）
node scaffold\probe_target_ui.mjs
# 期望：TARGETUI_OK  「发送到」字段 19 项断言全通过
```

四条与 v0.11.1 直接相关的检查点：

1. **输入框必须无条件渲染**：`dph-inline` 那一行永远是「类型下拉 + 手填 ID」，候选下拉（`dph-targetPicker`）只在 `tl.items.length > 0` 时**另起一行**追加。老版把两者写成三目运算符的二选一 —— 一旦点过「获取会话」拿到候选，输入框就永久消失，而飞书只列群、QQ 恒为空列表，单聊就彻底没地方填。`probe_target_ui.mjs` 的 A 段守这条（有候选时仍必须找到 `ou_` 占位的 input）。
2. **占位文案按通道走，不能只剩「对方 ID」**：`TARGET_PLACEHOLDERS` 五通道各两条（user / group），取值走 `targetPlaceholder(channel, kind)`。切到群时文案要跟着换（`group_openid` 不能出现在单聊态），探针 C/E 段各验一遍。
3. **未填收件人要当场说清**：`kinds.length === 0 || String(target.id ?? '').trim() !== ''` 时不出提示，否则渲染一行 `data-tone="warn"` 的「还没填「发送到」—— 现在点「发条测试消息」会直接失败。凭据本身没问题，缺的只是收件人 ID。」 不写这句，用户会把「缺收件人」误判成「凭据失效」。
4. **群晖不受影响**：`TARGET_META.synology_chat.kinds` 是空数组，整块「发送到」本来就不渲染（探针 F 段断言群晖页不出现这句提示）。新增提示行必须与这块的 `kinds.length === 0 ? null : …` 同步短路。


### 12.11 v0.12.0 新增的验证（机器人卡标签页）

```powershell
cd <插件根目录>\dsh-push-hub

# 标签页：22 项断言（默认停通用 / 三页互斥 / 群晖只有两页 / 测试按钮常驻 / 脏值回落）
node scaffold\probe_tabs.mjs
# 期望：TABS_OK  机器人卡标签页 22 项断言全通过
```

五条与 v0.12.0 直接相关的检查点：

1. **同一时刻只渲染一个面板**：`tabId === 'general' / 'delivery' / 'access'` 三个三目各自返回 `h('div', { className: 'dph-tabPanel' }, …)` 或 `null`。探针 A 段断言 `dph-tabPanel` 计数恒为 1 —— 多于 1 说明三目写漏了 `: null`，字段会串页重复出现。
2. **默认页必须是「通用」**：`const tabId = tabList.some((tab) => tab.id === cardTab[cardKey]) ? cardTab[cardKey] : 'general'`。`cardTab` 是空对象时、存了别的卡的 key 时、存了不存在的页 id 时，都要回落 `general`（探针 E 段三条）。
3. **群晖不给「访问设置」**：`botTabsForChannel(channel)` 把 `access` 页过滤掉，因为它没有 `@` 概念、`kinds` 也是空数组。探针 D 段断言群晖标签只剩 `通用|投递设置`。
4. **两个测试按钮不属于任何一页**：`dph-testRow`（检查凭据 / 发条测试消息 / 结果行）渲染在三个三目**之外**，任何一页都能看到。探针 C 段在 `access` 页与 `general` 页各断言一次 —— 把它塞进某页是很容易犯的错，塞进去就等于「切到别的页就没法验凭据」。
5. **`cardTab` 是 useState 下标 24**：`revealed` 是 23、`openCard` 是 22。加新 state 时**只能往后追加**，插在中间会让所有探针的 seed 下标错位、静默种错值。


### 12.12 v0.13.0 新增的验证（七个新通道）

```powershell
cd <插件根目录>\dsh-push-hub

# 注册表：12 个通道全在、断言 registryCoversAll = true
node scaffold\probe_apply.mjs
# 期望：listChannels = ["telegram","feishu","qq","wechat","synology_chat","dingtalk","wecom","wecom_app","slack","discord","matrix","email"]
#       registryCoversAll = true

# 语法：15 个 lib 文件逐个 node --check
node scaffold\probe_dbg.mjs
```

五条与 v0.13.0 直接相关的检查点：

1. **三处注册必须同时改齐**：`lib/bus.js` 的 `REGISTRY`、`lib/config.js` 的 `ALL_CHANNELS`、`lib/index.js` 的 `OWN_BOT_FIELDS` + `TARGET_META`。少改 `ALL_CHANNELS` → 通道能发但界面里 `proxyPolicy` 不认它的代理开关；少改 `OWN_BOT_FIELDS` → 界面里压根出不了账号卡。`probe_apply.mjs` 的 `registryCoversAll` 就是这条断言。
2. **成功判据不能只看 HTTP 状态**：Slack 出业务错仍是 200（必须 `data.ok === true`），Discord 成功是 200 而非 201，钉钉 / 企业微信 / 群晖看 `errcode`/`error.code`。写新通道时先想清楚「这个平台怎么表达失败」。
3. **`MAX_CHARS` 要按字节算，不是字符**：企业微信群机器人单条上限 2048 字节，中文 UTF-8 占 3 字节，所以给 600 而不是 2000。给大了会被服务端截断或直接报错。
4. **软通道集合要显式登记**：`lib/bus.js` 的 `BEST_EFFORT` 现在是 5 个（wechat / dingtalk / wecom / wecom_app / email）。漏登记 → 一个只有 Webhook 的通道失败会把整批推送判成全失败；多登记 → 真失败被吞掉不报。判定标准是「有没有稳定的只读探测接口」。
5. **邮件不许抛异常**：`email.js` 里 nodemailer 解析失败必须返回中文可执行说明，不能 `throw`。`lib/http.js` 的 `request()` 永不抛、各通道 `send()` 也只回 `{ok, detail}`——整条链上任何一处抛异常都会让 `bus.send()` 的循环断掉，后面的通道一个都发不出去。
### 12.13 v0.14.0 新增的验证（多投递目标）

```powershell
cd <插件根目录>\dsh-push-hub

# 多目标：37 项断言，A 解析 / B 描述 / C 扇出 / D 收发 / E 老配置 / F 界面样式
node scaffold\probe_multi_target.mjs
# 期望：MULTITARGET_OK

# 回归：界面上「发送到」仍能渲染、占位文案仍随通道变
node scaffold\probe_target_ui.mjs
node scaffold\probe_tabs.mjs
```

五条与 v0.14.0 直接相关的检查点：

1. **单目标也必须显式钉 `target`**：`sendToTargets()` 在 `targets.length === 1` 时同样传 `{ ...acc, target: targets[0] }`。不这么做的话，手改配置只写了 `targets` 没写 `target` 的用户会被 `targetOf()` 回落到 `allowFrom[0]`，**发到完全不相干的人**——这种错不会报错、只会静默发错。
2. **合并不许清空老值**：`mergeUserConfig()` 里 `targets` 用 `if (Array.isArray(item?.targets))` 判断；老前端根本不传这个键，若写成无条件赋值就会把用户配好的多目标在一次自动保存里清空。反过来，传了空数组 `[]` 是「我确实要清空」，照写。
3. **首条同步写回 `target`**：写 `targets` 的同时把 `account.target = targets[0]` 一起更新。只写 `targets` 会让「旧代码读 `target`」的路径看到过期值——本插件里 `describeTarget()`、群晖 `userIds` 兜底都还在读它。
4. **扇出必须在 bus 层，不许下沉到通道**：12 个通道的 `send()` 都只认 `acc.target` 一个值。把扇出放进通道意味着改 12 个文件、每个文件各写一遍分块与失败统计——改一次要验 12 次。放 bus 层则「通道实现零改动」，`probe_telegram` / `probe_synology` 等老探针一个断言都不用改。
5. **部分失败要能点名**：全成功才回 `ok: true`；有失败时 detail 形如 `'3 个目标里 1 个失败：-1001234567890 → 第 1/1 块失败 HTTP 400: ...'`，同时 `deliveries` 数组逐条给 `{kind, id, ok, detail}`。只说「发送失败」等于让用户自己一个个试。

### 12.14 v0.15.0 新增的验证（接收方向）

```powershell
cd <插件根目录>\dsh-push-hub

# 接收方向：62 项断言，A 收件箱 / B 能力声明 / C 启停 / D 路由与工具 / E 前端视图与两份 CSS / F 飞书与 Matrix
node scaffold\probe_receive.mjs
# 期望：RECEIVE_OK

# 回归：界面上原有的四页工具不受影响
node scaffold\probe_newui.mjs
node scaffold\probe_sidebar.mjs
```

五条与 v0.15.0 直接相关的检查点（v0.16.0 把可收列表扩到四个，原则不变）：

1. **不许假装能收**：`receiver.RECEIVABLE` 是 `['telegram','wechat','feishu','matrix']`。其余八个通道全部登记在 `NOT_RECEIVABLE_REASON` 里，`receiveBlocker("通道名")` 返回中文原因，`POST /receive/start` 见到非空 blocker 直接 400。给一个收不了的通道加「能收」的开关，比没有这个功能更糟 —— 用户会等一个永远不来的消息。
2. **收件箱永不抛**：`lib/inbox.js` 的 `readInbox()` 遇到文件不存在、JSON 损坏、字段缺失一律回空收件箱。接收循环在后台跑，任何一次抛异常都会让 `while (!signal.aborted)` 整条断掉，**接收静默停止而界面还显示「正在收」**。
3. **退避必须真实生效**：`lib/receiver.js` 失败后 `backoff = Math.min(backoff * 2, 60000)`，成功则重置回 2000。写死固定间隔会在平台限流时把 key 打废（Telegram 429、微信 ret 频控）；退避没有上限则恢复后要等一小时才重连。
4. **stop 要在检查点退出，不留悬挂定时器**：`stopChannel()` 只做 `ctrl.abort()`，`runLoop` 每轮开头检查 `signal.aborted`，`interruptibleSleep()` 用 `signal.addEventListener("abort", done, { once: true })` 提前唤醒。直接 clearInterval 或强杀 Promise 会留下悬挂的 await fetch，进程退不干净。
5. **切页才拉数据**：前端 `useEffect(() => { if (view !== "receive") return; loadReceive() }, [view])`。进设置面板不额外打两个请求 —— `/receive/status` 与 `/receive/inbox` 都读磁盘，默认进面板就拉会让首屏变慢。

### 12.15 v0.16.0 新增的验证（飞书 / Matrix 接收）

```powershell
cd <插件根目录>\dsh-push-hub

# 接收方向：62 项断言（F 段是 v0.16.0 新增的 12 项）
node scaffold\probe_receive.mjs
# 期望：RECEIVE_OK

# 只验借依赖这件事（不联网、不建连接）
node -e "import('./lib/receiver.js').then(m => console.log(m.__test.loadLark() === null ? 'NO_SDK（会回中文原因，不抛）' : 'SDK_OK'))"
```

五条与 v0.16.0 直接相关的检查点：

1. **借不到依赖不许抛**：`loadLark()` 解析失败只把原因写进 `cachedLarkError` 并返回 `null`，`run()` 第一行就判断并回 `{ok:false, detail:'…profile 里没有 @larksuiteoapi/node-sdk：<原因>'}`。让 `ERR_MODULE_NOT_FOUND` 冒到界面上，用户只会看到一坨英文栈，不知道该装什么。探针 F9 断言「要么借到 `WSClient`，要么返回 `null`」，两种机器上都过。
2. **长连接型 worker 必须能被 stop 掉**：飞书走 `mode: 'longconn'` 的 `run()`，`run()` 内部返回一个 `Promise`，`signal` 的 `abort` 事件触发时才 `wsClient.close({ force: true })` 并 resolve。写完不 close 会让 SDK 的 WS 自己重连，界面显示「已停止」但实际还在收 —— 这比不做更糟。
3. **只认文本消息**：飞书只认 `message_type === 'text'` 且 `content` 能 `JSON.parse` 出 `.text`；Matrix 只认 `m.room.message` 的 `content.body`。图片、语音、卡片回调一律不进收件箱 —— 收件箱的每条都要能原样读给人看，塞进一堆 `[object Object]` 等于把收件箱变成日志垃圾场。
4. **加密房间必须如实说**：Matrix 遇到 `m.room.encrypted` 就跳过，并在 `poll()` 的 `detail` 里写「跳过 N 条加密消息（本插件不解密）」。解密要设备密钥 + 房间密钥共享，那是另一套工程；假装收到（把密文当正文写进收件箱）是明确禁止的。探针 F12 就是守这条。
5. **轮询型 worker 不许被改坏**：`runLoop` 加了 longconn 分支，但 `telegram` / `wechat` / `matrix` 走的还是原来的 `while (!signal.aborted) { worker.poll(...) }`。探针 F3 断言 `telegram.mode === undefined` 且 `poll` 是函数 —— 加一种新形态不许顺手改掉旧的三种。

### 12.16 v0.17.0 新增的验证（账号级高级字段）

```powershell
cd <插件根目录>\dsh-push-hub

# 高级字段：36 项断言
node scaffold\probe_advanced.mjs
# 期望：ADVANCED_OK

# 标签页仍是四页（v0.12.0 的 29 项，v0.17.0 改成 4 页 / 群晖 3 页）
node scaffold\probe_tabs.mjs
# 期望：TABS_OK
```

五条与 v0.17.0 直接相关的检查点：

1. **数字字段不能当字符串回传**：`maskedUserConfig()` 原来一律 `String(item?.[field.key] ?? '')`，空值会变成 `''` 但写回时 `Number('')` 是 `0` —— 用户把「分块长度」清空，反而被写成 0，下次发送时 `maxMessageChars = 0` 让分块逻辑直接失效。现在按 `field.type` 分派：数字字段空值给 `''`、有值给 `Number`，布尔给真布尔。探针 B3 守这条。
2. **清空要能真的删掉**：合并时数字字段遇到空值必须 `continue`（不沿用旧值）。若沿用，用户把块间延迟从 2000 改回「用默认」就永远改不掉，只能改配置文件。探针 C1 守这条。
3. **只填高级字段不算「有账号」**：`hasCredential` 判定里过滤掉 `group === 'advanced'` 的字段。否则用户在空行里随手点了个「允许自签证书」，保存后列表里多出一个只有布尔值、没有任何凭据的空壳账号。探针 C5 守这条。
4. **账号级块间延迟必须盖过全局**：`lib/bus.js` 的 `sendToTargets()` 一进来就把 `acc.chunkDelayMs` 折成 `effective`，三条发送分支（0 目标 / 单目标 / 多目标扇出）全部改用它。用户给某个 Slack 账号单独调到 2 秒，就是想让这个账号慢一点避免被限流，不能被上层全局 `delayMs` 盖掉。探针 D3 断言三处都用 `effective`、D4 断言没有任何分支还在直接用 `options`。
5. **`0` 是合法值**：判据是 `ownDelay >= 0` 不是 `> 0`。「块间延迟 = 0」是有意义的配置（单条消息不分块时立刻发），当成无效值会被静默忽略。

### 12.17 v0.18.0 新增的验证（发文件）

```powershell
cd <插件根目录>\dsh-push-hub

# 发文件：88 项断言（含读盘、multipart 拼装、五个 sendFile、三条路由、前端）
node scaffold\probe_file.mjs
# 期望：FILE_OK

# 顺带回归：发文件的按钮不能把发文字的结果挤掉
node scaffold\probe_target_ui.mjs
# 期望：TARGETUI_OK
```

五条与 v0.18.0 直接相关的检查点：

1. **相对路径必须当场拒绝，不许「大概能读到」**：`readForSend()` 第一道判据是 `path.isAbsolute()`。插件的 cwd 是 DSH 进程的目录，不是用户心里的那个目录 —— 用户填 `报告.pdf` 时，如果恰好同名文件存在，就会**静默发出去一份无关文件**。这比报错危险得多：报错用户会改，静默发错的消息收不回来。探针 A2 断言 detail 里含「要绝对路径」。
2. **multipart 必须手写，不能用全局 `FormData`**：`lib/http.js` 有两条发送路径 —— 直连走 `fetch`、走代理走「CONNECT 隧道 + `http.request` 自拼 headers」。`FormData` 对象在第二条路上拿不到「已经序列化好的字节」，结果就是「直连能发、走代理发出 0 字节文件」，而且平台还回 200。`buildMultipart()` 返回 `Buffer`，两条路吃同一份字节。探针 C1-C12 逐项守 boundary、中文文件名、文件部分自带的 Content-Type、数组字段重复、null 跳过、结束 boundary。
3. **Discord 少了 `attachments` 描述会被静默丢弃**：`payload_json` 里必须写 `attachments: [{id:0, filename}]`，且文件字段名是 `files[0]`。少了这段，Discord 照回 200，但消息里没有文件 —— 这是最容易「测试通过、用户投诉」的一条。探针 E4/E5 守这两个字面量。
4. **文件只读一次盘，`sendFile` 里不许就地改 `bytes`**：`bus.sendFile()` 在循环外调一次 `readForSend`，同一份 `Buffer` 交给所有通道与所有目标。若某个通道实现为了补文件头而就地改 `file.bytes`，多目标扇出时第二个目标收到的是坏文件。探针 D6 守「`readForSend` 只被调一次」，E 段逐个 `sendFile` 断言没有 `file.bytes =` 之类的重新赋值。
5. **不支持附件的通道要逐条点名，不能静默跳过**：十二个通道里只有 `telegram / slack / discord / matrix / email` 能发文件。选中其余通道时回错误「「飞书」这个通道还不支持发文件（只有文字）。能发文件的是：…」，并把能发的全列出来 —— 静默跳过会让用户以为发出去了。探针 D3/D4 守这条，D2 断言 `FILE_CHANNELS` 恰好是这五个。

### 12.18 v0.19.0 新增的验证（Slack Socket Mode / Discord Gateway）

```powershell
cd <插件根目录>\dsh-push-hub

# 接收方向：91 项断言（含 Slack ack 顺序、Discord intents、ws.js 走代理）
node scaffold\probe_receive.mjs
# 期望：RECEIVE_OK
```

五条与 v0.19.0 直接相关的检查点：

1. **Slack 的 ack 必须在处理业务之前**：每帧带 `envelope_id` 就要立刻回 `{"envelope_id":"…"}`，Slack 三秒内收不到就重投 —— 重投到的还是同一个事件，用户会看到重复消息。所以代码里 ack 写在 `if (packet.type === 'hello')` **之前**，而不是「处理完再回」。探针 G12 断言 `rx.indexOf('envelope_id') < rx.indexOf('events_api')` —— 顺序反了这行就假红。
2. **Slack 的两把钥匙不能混**：发消息用 Bot Token（`xoxb-`），接收要用 App Token（`xapp-`，scopes 含 `connections:write`）。拿 Bot Token 去调 `apps.connections.open` 会失败，但报错信息很含糊（`not_allowed_token_type`）。探针 G7/G8 守「没填」与「填错前缀」两种情形都给中文原因。
3. **Discord 的 intents 不带 MESSAGE_CONTENT，`content` 恒为空且不报错**：Gateway 连得上、心跳正常、事件也收得到，只是每条消息的正文字段是空串。这是最像「代码没问题」的失败。探针 G17 断言源码里既有 `MESSAGE_CONTENT` 又有 `1 << 15`。
4. **WebSocket 必须走代理，Node 内置的不给注入点**：`new WebSocket(url)` 用的是全局对象，**不接受 `dispatcher`**，本机直连 `wss://gateway.discord.gg` 实测直接 error（message 为空）。所以 `lib/ws.js` 从 DSH profile 借 `undici`，自己 `new undici.ProxyAgent(proxy)` 塞进 `{ dispatcher }`。探针 G23/G24 断言不填代理走 `direct`、填了走 `proxy`。
5. **心跳没被确认必须主动断开**：Discord 的 `op:11` 是心跳回执，收了 `op:10` 起定时器后，如果下一次要到点时上一次还没回执（`acked` 仍是 `false`），说明连接已经半死 —— 这时候不主动断，连接会挂着不报错但一条消息都收不到。探针 G19 断言源码里有 `acked` 与「心跳没被确认」这条文案。

### 12.19 v0.20.0 新增的验证（消息按钮）

```powershell
$api = 'http://127.0.0.1:3082/@duma520/dsh-push-hub/api'
# 1) 谁能带按钮
Invoke-RestMethod "$api/buttons/channels" | ConvertTo-Json -Depth 4

# 2) 伪发送：坏格式在这一步就该被拦，不用等真发 400
$body = @{ text='带按钮的测试'; dry_run=$true; buttons='[{"text":"通过","callback":"ok"}]' } | ConvertTo-Json
Invoke-RestMethod "$api/test" -Method Post -ContentType 'application/json; charset=utf-8' -Body $body | ConvertTo-Json -Depth 6

# 3) 真发一条到 Telegram（唯一的硬通道）
$body = @{ text='带按钮的测试'; channels='telegram'; buttons='[{"text":"通过","callback":"ok"},{"text":"拒绝","callback":"no"}]' } | ConvertTo-Json
Invoke-RestMethod "$api/send" -Method Post -ContentType 'application/json; charset=utf-8' -Body $body | ConvertTo-Json -Depth 6
```

五条检查点：

1. **按钮只挂最后一块**（`telegram.js` / `slack.js` / `discord.js` 都判 `i === blocks.length - 1`）。挂每块的话，用户按一下会触发 N 个 callback（N = 消息块数），每条都是一次真实副作用。
2. **callback 按 64 字节验，不是 64 字符**。`"中".repeat(22)` 是 66 字节 → 拒；21 个才是 63 字节 → 过。按字符数验会让 Telegram 侧 400 而 Slack/Discord 侧通过，同一份配置「有的通道能发有的不能」。
3. **不支持按钮的通道不能整批失败**。`bus.send` 里对 `!BUTTON_CHANNELS.includes(name)` 的通道照常发文字，只在 `detail` 追加「该通道不支持按钮，按钮已丢弃（原因）」。判据是 `ok === true` 且 `detail` 含这句。
4. **空数组不是「没按钮」而是「收键盘」**。`toTelegram([])` 返回 `{inline_keyboard: []}` —— 显式传空才是清键盘，`parseButtons('')` 返回 `rows: []` 时调用方**不该**发 `reply_markup`（否则会把已有键盘清掉）。
5. **坏格式在 dry_run 就报**。`doSend` 在 `input.dryRun` 分支**之前**调 `buttons.parseButtons` —— 用户点「只看分块（不发）」时就该看到「按钮「X」没有 callback」，而不是等真发出去 400。

### 12.20 v0.21.0 新增的验证（QQ 接收）

`powershell`
$api = 'http://127.0.0.1:3082/@duma520/dsh-push-hub/api'
# 1) 现在能收的通道（应为 7 个，含 qq）
Invoke-RestMethod "$api/receive/status" | ConvertTo-Json -Depth 4

# 2) 收不了的只剩 5 个
(Invoke-RestMethod "$api/receive/status").blocked.PSObject.Properties.Name

# 3) 开 QQ 接收（先在机器人卡里填 appId 与 clientSecret）
$body = @{ channel = 'qq' } | ConvertTo-Json
Invoke-RestMethod "$api/receive/start" -Method Post -ContentType 'application/json; charset=utf-8' -Body $body | ConvertTo-Json -Depth 6

# 4) 看它有没有真的连上（state 应为 running；失败时 error 里有原因）
(Invoke-RestMethod "$api/receive/status").status
``

五条检查点：

1. **两个地方的 token 都要 `QQBot ` 前缀**。`GET /gateway` 的 `Authorization` 与 `op:2 identify` 的 `d.token` 都是 `QQBot <accessToken>`；裸 token 会 401，且报错只说「连不上」看不出原因。探针 G33 断言源码里有 `"QQBot " + got.token`。
2. **intents 必须含 `GROUP_AND_C2C_EVENT`（`1 << 25`）**。不带的话不会报错 —— 连接正常、心跳正常、就是群里 @ 机器人的消息一条都收不到。这是 QQ 与 Discord 最容易踩反的一处（Discord 缺 MESSAGE_CONTENT 的表现也一样：`content` 恒为空）。探针 G31 断言。
3. **拿 token 必须复用 `qq.appToken()`，不能另写一套**。发消息那条链路已经在做缓存与过期处理，接收再写一份就会出现「发得出去收不进来」或反过来。探针 G28/G29 断言节点在本地就拒（没 appId 直接返回，不许先连出去再失败）。
4. **群消息与单聊消息的 `from` 含义不同**。群用 `group_openid`（用户要看的是哪个群发来的），单聊用 `author.user_openid`。两者混用会让收件箱里一半条目看不出是谁。
5. **时间戳统一走 `qqTime()`**。QQ 给的是 RFC3339，`Date.parse` 拿不准时返回 `undefined` —— `inbox.appendMessage` 会自己填当前时间，绝不写 `Invalid Date`。探针 G34 断言。
### 12.21 v0.22.0 新增的验证（按钮回调接收）

```powershell
# 1) 只读按钮回调（Telegram 的 callback_query / Slack 的 block_actions / Discord 的 INTERACTION_CREATE 都落在这里）
Invoke-RestMethod http://127.0.0.1:3082/@duma520/dsh-push-hub/api/receive/inbox/callbacks?limit=20 | ConvertTo-Json -Depth 5

# 2) 普通收件箱不变（回调也在里面，用 kind 区分）
Invoke-RestMethod http://127.0.0.1:3082/@duma520/dsh-push-hub/api/receive/inbox?limit=5 | ConvertTo-Json -Depth 5

# 3) 契约探针（112 项，含 H 段 12 项回调断言）
node scaffold/probe_receive.mjs
```

五条检查点：

1. **Telegram 的 `allowed_updates` 必须含 `callback_query`**。只订阅 `message` 的话，按钮按下之后 Telegram 会把那条 update 一直留在队列里 —— `offset` 推不动，之后所有消息都收不到。这个故障是「整条链路静默死掉」，不是「回调丢了」。
2. **应答必须在记账之前**。`answerCallbackQuery` 是告诉客户端「收到了，别转圈」；先记账后应答，一旦记账抛错（比如磁盘满），客户端会一直转圈。探针 H3 断言 `await answerCallback(` 出现在 `kind: 'callback'` 之前。
3. **Discord 只有 3 秒**。`INTERACTION_CREATE` 必须在 3 秒内回 `{ type: 6 }`（`DEFERRED_UPDATE_MESSAGE`），否则客户端显示「交互失败」。本插件用 `void answerInteraction(d, acc)` 不等待（失败也不影响落盘），但绝不能串在落盘之后。
4. **Slack 取 `action.value` 不是 `action.text`**。`text` 是按钮上显示的字，`value` 才是 `custom_id` 对应的回调值 —— 取错会把「确认」这种显示文案当成业务值。
5. **`kind` 只在 `callback` 时写**。`inbox.appendMessage` 里是 `if (message?.kind === 'callback') row.kind = 'callback'`，普通消息不写这个键 —— 老收件箱文件（v0.21.0 之前）没有这个键也能正常读。

### 12.22 v0.23.0 新增的验证（邮件接收）

```powershell
# 1) 8 个通道可收，剩 4 个带原因
$st = Invoke-RestMethod http://127.0.0.1:3082/@duma520/dsh-push-hub/api/receive/status
$st.receivable
$st.blocked.PSObject.Properties.Name

# 2) 邮件账号多了两个字段（只发信可以不填）
(Invoke-RestMethod http://127.0.0.1:3082/@duma520/dsh-push-hub/api/config).ownBotFields.email.key

# 3) 契约探针（131 项，含 I 段 17 项邮件断言）
node scaffold/probe_receive.mjs
```

五条检查点：

1. **SMTP 地址不能拿来收信**。`smtp.qq.com` 与 `imap.qq.com` 是两个不同域名，端口也不同（465/587 vs 993/143）。只发信的用户不该被迫填 IMAP，所以 `imapHost` 是可选的；但一旦点了"开始接收"，没填就直接拒并说清缺的是 IMAP。
2. **先 `search` 再 `fetchOne`**。这是本版最容易写错的一处：边取边数（`for await … { if (fetched >= 20) break }`）看起来更省一次请求，但 `break` 之后游标已经推到第 20 封，下一轮只查 `uid >` 游标 —— 第 21 封之后的未读**永远回不来**。而"未读"标记在取信时会被清掉，用户以为它们在收件箱里。
3. **首次接入取最新的 20 封**，不是最老的 20 封。`uidList.slice(-EMAIL_BATCH)` —— 用户刚配好想看的是刚到的那封。
4. **无游标时只查未读**（`{ seen: false }`）。查 `1:*` 的话第一次接入就会把几千封历史全灌进收件箱（上限 500 条，灌完把新的挤掉）。
5. **自签证书与发信共用一个开关**。`allowSelfSigned === true` 时 `tls.rejectUnauthorized = false` —— 同一台自建服务器的收发应该一致，不能发得出收不进。

### 12.23 v0.24.0 新增的验证（钉钉与企业微信接收）

```powershell
$st = Invoke-RestMethod http://127.0.0.1:3082/@duma520/dsh-push-hub/api/receive/status
$st.receivable
$st.blocked | ConvertTo-Json
(Invoke-RestMethod http://127.0.0.1:3082/@duma520/dsh-push-hub/api/config).ownBotFields.dingtalk.key
(Invoke-RestMethod http://127.0.0.1:3082/@duma520/dsh-push-hub/api/config).ownBotFields.wecom_app.key
```

要盯的五条：

1. `receivable` 里必须出现 `dingtalk` 与 `wecom_app`，且 `blocked` 只剩 `synology_chat` 与 `wecom` 两条 —— 这一条直接检验「原因表」与「worker 表」是否同步改了。两边不同步的典型症状是：通道明明能收了，接收页还在说「它只有回调」。

2. **新字段必须带「（接收才要）」后缀**。两条通道的收发凭据完全不同：钉钉发送用群机器人 `webhookUrl` + 加签 `secret`，接收要企业内部应用的 `clientId` / `clientSecret`；企业微信发送用 `corpId` / `corpSecret` / `agentId`，接收要智能机器人的 `botId` / `botSecret`。标签上不写清，用户会以为要再填一遍同样的东西。

3. **只填高级字段不会凭空生成账号**。v0.17.0 给 `hasCredential` 加的 `field.group !== 'advanced'` 过滤在这里同样生效 —— 只填 `maxMessageChars` 不会让界面上冒出一个空壳账号。

4. **钉钉应答顺序**。源码里 `socketCallBackResponse` 必须在处理消息之前，顺序反了会重投：用户收到两条一样的回复。`probe_receive.mjs` 的 J7 用 `indexOf(...) < lastIndexOf(...)` 守这条（注意是 `lastIndexOf` —— `dingtalkTextOf` 的函数定义在 worker 之前，用 `indexOf` 会抓到定义处而假红）。

5. **两个 SDK 借不到时不能抛**。`loadDingtalk()` / `loadWecomBot()` 都是「取不到记错误、返 `null`、由 worker 回一句中文原因」。profile 换机器后包可能不在，抛 `ERR_MODULE_NOT_FOUND` 会让整个接收页白屏。

### 12.24 v0.25.0 新增的验证（引用回复）

```powershell
$api = 'http://127.0.0.1:3082/@duma520/dsh-push-hub/api'
(Invoke-RestMethod "$api/reply/channels").channels
(Invoke-RestMethod "$api/reply/channels").reasons | ConvertTo-Json
# 伪发送看被丢弃的通道，不真发
$body = @{ text = '验证引用回复'; replyTo = '123456'; dry_run = $true } | ConvertTo-Json
(Invoke-RestMethod "$api/send" -Method Post -ContentType 'application/json' -Body $body).replyTo
```

要盯的五条：

1. `reply/channels` 必须只回 `telegram / slack / discord / matrix / qq` 五个，且 `reasons` 有七条 —— 这一条直接检验「能力表」与「原因表」是否成对。只改一边的典型症状是：某个通道明明翻译函数返回 `null`（发不出去引用），界面却还允许你填。

2. **被丢弃的通道要能在伪发送里看见，不能等真发**。`dry_run` 的返回体里有 `replyTo.droppedChannels`。写了 `replyTo` 却群发到 12 个通道时，七个不支持的要被点名，而不是静默降级 —— 用户以为整句带引用，实际只有五个带。

3. **空 `replyTo` 不算「不支持」**。`options.replyTo` 为 `undefined` / `null` / 空白串时，`bus` 的那段降级判断必须整段跳过（条件里三个都判了）。少判一个的后果：每次普通发送都在 `detail` 里挂一句「该通道不支持引用回复」，日志全是噪音。

4. **只挂最后一块**。三处都判 `last`（`i === blocks.length - 1`）。不判的后果：一条被切成 3 块的长消息带上 3 个 `reply_parameters`，Telegram 会把同一句引用三遍，Matrix 会把 `> 原文` 前缀拼三遍。

5. **Matrix 的正文前缀不能丢**。Matrix 与另外四家不同：引用关系放在 `m.relates_to` 里，但**客户端不一定会渲染**，所以正文必须自己带 `> 原文` 一行。`matrixQuotePrefix` 用 `String.fromCharCode(10)` 拼换行 —— 直接写含换行的字符串字面量会让 `node --check` 报 `SyntaxError: Invalid or unexpected token`。

### 12.25 v0.26.0 新增的验证（通道显示）

```powershell
# 1. 归一化：没有配置时必须是「全部显示」
node -e "import('./lib/config.js').then(m=>console.log(JSON.stringify(m.channelVisibility({}))))"
# 期望 {"mode":"all","hidden":[]}

# 2. 手改配置写错大小写与拼错通道名，都要被归一
node -e "import('./lib/config.js').then(m=>console.log(JSON.stringify(m.channelVisibility({channel_visibility:{mode:'Bound',hidden:['wecom','乱写','wecom']}}))))"
# 期望 {"mode":"all","hidden":["wecom"]}

# 3. 探针（37 项）
node scaffold/probe_visibility.mjs
```

五条检查点：

1. **隐藏一条通道之后，它必须还能发消息**。这是这个功能唯一真正危险的地方 —— 用户很容易以为「左边看不见 = 停用了」。验证方式不是看界面，是看代码：`bus.js` 与 `receiver.js` 里 `grep channel_visibility` 必须 0 命中。探针 C1/C2 就是在钉这一条。
2. **两档必须叠加，且 hidden 先判**。先按 mode 决定基础集合，再减 hidden。顺序反了会出现「手动隐藏一条本来就没账号的通道，切到 bound 模式后它又冒出来」。探针 D3 用 `indexOf` 的位置关系钉死顺序。
3. **账号数只许有一个算法**。左栏的「N 个账号」与「通道显示」页里的「N 个账号」必须是同一个 `accountCountOf()`，否则同一个通道在两页显示不同数字，用户会以为哪边是错的。探针 D4/D5 钉这一条。
4. **不许把「隐藏」实现成从 channels 数组里删掉**。那样账号数统计、默认推送校验、保存回传都会跟着少一条 —— 一个界面偏好会污染配置。探针 F3 专门禁止 `setChannels((prev) => prev.filter(`。
5. **选中项被隐藏时不能停在幽灵通道上**。左侧列表已经没有它了，右侧还渲染它的详情，用户会以为界面卡住。探针 D7 要求有 `effectiveSelected` 兜底。

### 12.26 v0.26.1 新增的验证（设置面板滚动）

```powershell
# 1. 根节点必须同时有高度与纵向溢出（缺一都不成立）
node -e "const fs=require('fs');const s=fs.readFileSync('lib/theme.js','utf8');for(const k of ['height: 100%','overflow-y: auto','min-height: 0','scrollbar-gutter: stable'])console.log(k+' => '+s.includes(k))"
# 期望四条全 true

# 2. 两份同源样式表必须逐字节一致（只改了 theme.js 而漏改内联那份 = 界面不变）
node scaffold/probe_scroll.mjs
# 期望 SCROLL_OK  设置面板滚动 13 项断言全通过

# 3. 改动范围：这一版只碰 CSS，零逻辑改动
git -C . diff --stat 2>$null | Select-String 'lib/'
```

五条检查点：

1. **`height` 与 `overflow-y` 必须同时有，`min-height: 0` 是第三个必要条件**。只写 `overflow-y: auto` 时，父容器定高会让内容溢出父级而不产生滚动条（因为块级子元素的高默认由内容决定，父级裁不裁它由父级决定）；只写 `height: 100%` 时超出部分被直接裁掉；`height` + `overflow-y` 都写了但漏了 `min-height: 0` 时，元素作为 grid/flex 子项默认 `min-height: auto`，会被内容顶开到比 `height` 更大，滚动条仍然不出现。探针 A2 / A3 / B1 分别钉这三条。
2. **不许用 `overflow: hidden` 掩盖**。`hidden` 会让「看不到」变成真的不可达 —— 内容既不在视口里也滚不到。探针 D1 专门禁止根节点出现 `overflow: hidden`。
3. **不许用 `max-height: 100vh`**。宿主可能是内嵌面板而不是整窗口，`vh` 参照的是视口不是容器，会算出比可用空间更大或更小的高度。探针 B2 禁止这一条。
4. **两份 CSS 必须同源**。`lib/theme.js` 的 `THEME_CSS` 与 `lib/client.js` 里内联的那份是两份拷贝（ModuleLoader 不能 import 相对路径，只能各写一份）。只改一份的后果是「探针绿但界面没变」，最难查。探针 C1 逐字节比对，C3 额外确认内联那份也带滚动声明。
5. **`scrollbar-gutter: stable` 与 `overscroll-behavior: contain` 是体验项不是必需项**，但少了会有两个可见副作用：前者省掉「滚动条一出现内容左右横跳一下」，后者省掉「滚到底把整个设置页带着一起滚」。

### 12.27 v0.26.2 新增的验证（删账号）

```powershell
# 1. 前端删空后必须留下空数组键，而不是把这个键删掉
node scaffold/probe_ownbot_delete.mjs
# 期望 OWNBOT_DELETE_OK  删账号 共 19 项断言，通过 19，失败 0

# 2. 后端两个分支必须都在：空数组删整条、没这个键就跳过
node -e "const fs=require('fs');const s=fs.readFileSync('lib/index.js','utf8');console.log('空数组删整条 =>',s.includes('if (accounts.length === 0) delete own[channel]'));console.log('没这个键就跳过 =>',s.includes('if (!Object.hasOwn(incomingOwn, channel)) continue'))"
# 期望两条都 true
```

五条检查点：

1. **前后端对「键不存在」的约定必须写清**。这一次的缺陷完全来自语义歧义：前端把「删空」表达成「这个键不存在」，后端把「键不存在」理解成「这次没提到它」。两边各自都「合理」，合起来就丢了删除动作。现在约定是：**空数组 = 明确删掉；键不存在 = 这次没提到，保留旧值**。探针 A7 / A8 钉前端，B1 / B2 / B3 钉后端。
2. **不许把后端的 `continue` 删掉**。看起来它才是「保留旧账号」的元凶，实际上它是老前端与局部提交的兼容层：任何只提交部分通道的客户端（命令行、脚本、旧版界面）都依赖它，删了之后「只改一个通道」会把其它通道全清空 —— 那是更严重的缺陷。探针 B2 专门守住它。
3. **这不是 QQ 一个通道的问题**。`own_bots` 是一个以通道名为键的对象，十二个通道共用同一段合并逻辑，所以 telegram / feishu / wechat / 群晖四个都同病同修。探针 C1 确认后端是按 `OWN_BOT_FIELDS` 遍历而不是逐通道手写，C3 确认前端只有一个删除入口。
4. **探针要真跑函数体，不能只 grep 源码**。这一版探针从 `lib/client.js` 里按花括号配对截出 `dropOwn` 的真函数体，再用 `new Function` 配一个假的 `setOwnBots` 真调一次 updater —— 只 grep `delete next[channel]` 有没有出现是抓不到「键被删掉了但代码里没有那个字面量」这类回退的。A5~A10 就是真跑出来的结果。
5. **前端改动必须让用户重载一次插件**。后端 `lib/index.js` 改动可以用 `unlag_refresh` 即时生效，但 `lib/client.js` 属前端 bundle，界面要「禁用→启用」插件或重启 DSH 才会重新加载 —— 也就是说磁盘上的账号已经删干净了，界面上那条要等重载后才消失，这中间不要误报成「还没修好」。

### 12.28 v0.27.0 新增的验证（入站附件）

装上 v0.27.0 后，下面这些应当都能过。

```powershell
cd <插件根目录>\dsh-push-hub

# 1) 六十项断言全过
node scaffold\probe_attachments.mjs
#    期望最后一行：ATTACHMENTS_OK  入站附件 共 60 项断言，通过 60，失败 0

# 2) 九个平台解析器都在
node -e "import('./lib/attachments.js').then(a=>console.log(Object.keys(a).join(' ')))"
#    期望含 fromTelegram fromSlack fromDiscord fromMatrix fromFeishu fromQQ fromDingtalk fromWecomBot fromEmail

# 3) Telegram 一张图的多档尺寸只算一个附件
node -e "import('./lib/attachments.js').then(a=>console.log(JSON.stringify(a.fromTelegram({photo:[{file_id:'s',width:90,height:90,file_size:1000},{file_id:'b',width:1280,height:1280,file_size:900000}]}))))"
#    期望长度 1、size 900000

# 4) 收件箱：正文空但有附件仍然入库
node -e "import('./lib/inbox.js').then(i=>i.appendMessage({channel:'telegram',account:'a',from:'1',text:'',attachments:[{kind:'image',name:'x.jpg'}]},require('os').tmpdir()+'/t.json')).then(r=>console.log(r))"
#    期望 ok: true（正文与附件**同时**为空才会被拒）

# 5) 运行时：附件路由在
node -e "fetch('http://127.0.0.1:3082/@duma520/dsh-push-hub/api/receive/inbox/attachments').then(r=>r.json()).then(j=>console.log(j.ok, Array.isArray(j.messages)))"
#    期望 true true
```

检查点（任何一条不成立就是没装上）：

1. **一张图的多档尺寸不许算成多个附件**。Telegram 的 `photo[]` 里 3 个元素是**同一张图的 3 个分辨率**，照数组长度记账会让「发一张图」变成「收到 3 张图」。判据是取 `file_size` 最大的那一档，只算 1 个。
2. **飞书的 `content` 必须当 JSON 字符串解析**。它是 `'{"file_key":"k1","file_name":"a.pdf"}'` 这样的字符串，不是对象；直接 `content.file_name` 永远是 undefined。
3. **Slack 的 `file_share` 必须放行**。旧代码 `if (message.subtype !== undefined) return` 把「发文件」这个 subtype 一起挡掉了，等于 Slack 发来的文件永远收不到。
4. **钉钉只有 `downloadCode` 没有文件名**。不要假装能拿到文件名，写「(钉钉 picture)」之类的占位，比编一个假名强。
5. **收件箱的「空」判据要连着附件一起判**。`text.trim() === ''` 单独判会把「只发了张图、没配文字」的消息整条丢掉。

### 12.29 v0.28.0 新增的验证（发送回执）

装上 v0.28.0 后，下面这些应当都能过。

```powershell
# 1. 发件箱本体与十二通道回传（64 项）
node scaffold\probe_outbox.mjs
# 期望 OUTBOX_OK  发送回执 共 64 项断言，通过 64，失败 0

# 2. 发件箱文件在不在、能不能读
node -e "const o=require('./lib/outbox.js');console.log('path =>',o.OUTBOX_PATH);console.log('recent =>',o.recentSent(3).length)"
# 期望 path 指向 C:\Users\<你>\.dsh\dsh-push-hub\outbox.json；recent 是数字

# 3. 五家不该有 messageIds（防以后有人编造 id）
node -e "const fs=require('fs');for(const n of ['wechat','synology','dingtalk','wecom','wecom_app']){const s=fs.readFileSync('lib/channels/'+n+'.js','utf8');console.log(n,'=>',s.includes('messageIds'))}"
# 期望五条全是 false
```

五条检查点：

1. **`messageIds` 必须是数组，不是字符串**。长消息会按平台上限分块发送，**每一块在平台上都是一条独立消息、各有自己的 id**。只留最后一个 → 「改第一条改不到」；只留第一个 → 「改最后一条改不到」。发件箱里 `messageIds: string[]`，多目标时还要**逐目标**挂（`deliveries[].messageIds`），摊平成一个数组就分不清哪个 id 属于哪个聊天。
2. **失败绝不进发件箱**。失败的消息没有 id，记进去既不能改也不能撤，只会把真发出去的那几条挤出 500 条的保留窗口。判据是 `if (one?.ok !== true) continue` —— 逐条判，不是看整批的 `ok`。
3. **五家给不出 id 就不许编**。微信 / 群晖 / 钉钉 / 企业微信两家，回包里只有 `errcode` / `success`，没有任何消息 id。假装有会让人点「撤回」时打到一个不存在的 id 上 —— 探针里那条「这五家源码里不许出现 `messageIds`」就是守这个。
4. **查历史必须走 `readQuery(req)`**。`req.url` 在 `lib/index.js` 里是**字符串**（`const url = String(req.url ?? '')`），对它调 `url.searchParams.get()` 会在运行时崩 `TypeError: Cannot read properties of undefined (reading 'get')`。
5. **记账失败不改 `ok`**。消息真的发出去了，写盘失败只是「没留痕」，不能反过来说「没发成功」。

### 12.30 v0.29.0 新增的验证（改消息与撤回）

装上 v0.29.0 后，下面这些应当都能过。

```powershell
cd <插件根目录>\dsh-push-hub
node scaffold\probe_edits.mjs        # 期望 EDITS_OK  改消息与撤回 79 项断言全通过
node scaffold\probe_outbox.mjs       # 期望 OUTBOX_OK 发送回执 67 项断言全通过
```

五条检查点：

1. **能改能撤只有四个通道**。`GET /edit/channels` 必须回 `edit: ["telegram","slack","discord","matrix"]`、`del` 同四个。飞书**故意不在里面** —— 官方文档确有 `PATCH`/`DELETE /open-apis/im/v1/messages/:id`，但本机没有飞书凭据、抓文档只回 25 字节（SPA 无正文），社区还有人碰到 `invalid msg_type`。没实测过就不给按钮，理由写在 `lib/edits.js` 的 `NO_EDIT_REASON.feishu` 里。
2. **改消息不许分成两条发**。`send()` 会按平台上限把长正文切块，但 `editMessage()` **不能**：改的是「那一条」，拆成两条就成了「原来是 A，现在变成 B 和 C 两条」—— 用户会以为消息重复了。所以四家统一在超长时直接拒，文案是「改消息不能分块，只能缩短」。
3. **Telegram 的 `message is not modified` 必须当成功**。用户把「你好」改成「你好 」（多个空格）或原样再按一次，Telegram 回 400 `Bad Request: message is not modified`。那是「已经是你要的样子了」，不是失败。
4. **Discord 改消息必须显式带 `allowed_mentions`**。不写这个字段，改完的正文里带 `@everyone` 会**真 ping 全频道**。撤回反过来：成功是 **204 且响应体为空**，判 `status === 204 || status === 200`，看 `body` 永远判不出来。
5. **多目标条目要按 `places` 分组**。v0.28.0 的发件箱把一条消息的 id 摊平成一个数组、把目标 join 成「A、B」字符串 —— 那样**分不清哪条 id 属于哪个聊天**，改/撤根本无从定位。现在每条目标一组 `places: [{id, messageIds}]`；老条目只有单值 `target` 时仍可反查（向后兼容），多目标老条目直接返回空 —— 定位不了就不猜。
### 12.31 v0.30.0 新增的验证（表情回应）

装上 v0.30.0 后，下面这些应当都能过。

```powershell
cd <插件根目录>\dsh-push-hub
node scaffold\probe_reactions.mjs   # 期望 REACTIONS_OK 表情回应 94 项断言全通过
node scaffold\probe_edits.mjs       # 期望 EDITS_OK 改消息与撤回 79 项断言全通过（未回归）
node scaffold\probe_outbox.mjs      # 期望 OUTBOX_OK 发送回执 67 项断言全通过（未回归）
```

五条检查点：

1. **Slack 不认 Unicode，只认名字 —— 而且它失败时 HTTP 也是 200**。`reactions.add` 的 `name` 参数要 `thumbsup`；传 `👍` 会回 `{"ok":false,"error":"invalid_name"}` 而状态码仍是 200。所以判据是 `data.ok === true`，不是状态码。转换在 `lib/reactions.js` 的 `slackNameOf` 里做，**表里没有的直接拒**，绝不猜名字 —— 猜错名字比不映射更糟：用户会以为「这个表情 Slack 不支持」，实际是名字写错了。
2. **Discord 加表情是 PUT、去是 DELETE，成功率 204 无响应体**。`PUT /channels/:cid/messages/:mid/reactions/<emoji>/@me`，判 `status === 204 || status === 200`；自定义表情必须写 `name:id`（`blob:1234567890`），只写名字找不到。
3. **Telegram 传空数组 = 清掉全部，不是「什么都不做」**。它没有「只删某一个」的接口，`reaction: []` 是把机器人挂过的表情一次性清空 —— 这一点在返回文案里明说了，免得用户以为只删了你指定的那个。
4. **Matrix 的表情是一个独立事件，「去掉」要的是回应事件 id**。加表情是发一条 `m.annotation` 事件，要去掉只能撤回那个事件（`redact`）。所以 `removeReaction(reactionEventId, acc)` 收的**不是原消息 id** —— 界面上直接写明，不假装传原消息 id 也能去掉。加表情的返回里会给出回应事件 id。
5. **四家之外一律不给按钮**。`GET /edit/channels` 除 `edit` / `del` 外新增 `react`（四个通道）与 `reactReasons`（八家各自的原因）。探针里反过来断言：那八家的通道源码中**不许出现** `addReaction` —— 平台没有这个能力，编一个出来就是骗人。

### 12.32 v0.31.0 新增的验证（依赖解析）

```powershell
cd <插件根目录>\dsh-push-hub

# 1) 依赖探针（59 项）
node scaffold\probe_deps.mjs
#    期望 DEPS_OK  依赖解析 59 项断言全通过

# 2) 四个借依赖的模块都不再自己 createRequire
findstr /S /N "createRequire" lib\*.js lib\channels\*.js
#    期望：只剩 lib\deps.js 里的那些（实现本体），qr / receiver / ws / email 一处不许有

# 3) 候选顺序：插件自身必须排第一
node -e "import('./lib/deps.js').then(m=>console.log(m.depCandidates()[0]===m.PLUGIN_NODE_MODULES))"
#    期望 true

# 4) 飞书 SDK 从插件目录解析出来，且带 registerApp / WSClient
node -e "import('./lib/deps.js').then(async m=>{const r=await m.loadDep('@larksuiteoapi/node-sdk');console.log(r.ok, String(r.from).includes('dsh-push-hub'), typeof r.mod.registerApp, typeof r.mod.WSClient)})"
#    期望 true true function function

# 5) 纯 ESM 包不会报 ERR_PACKAGE_PATH_NOT_EXPORTED
node -e "import('./lib/deps.js').then(async m=>{const r=await m.loadDep('@tencent-connect/qqbot-nodejs');console.log(r.ok, r.via)})"
#    期望 true import

# 6) 运行时：飞书扫码能力恢复
node -e "fetch('http://127.0.0.1:3082/@duma520/dsh-push-hub/api/qr/capabilities').then(r=>r.json()).then(j=>console.log(j.capabilities.feishu))"
#    期望 { available: true, detail: '' }
```

检查点（任何一条不成立就是没修好）：

1. **候选顺序不能反**。`depCandidates()` 的第 0 项必须是 `PLUGIN_NODE_MODULES`。反过来（profile 优先）的话，用户装了插件自带的版本，也会被 profile 里那个「碰巧还在、但版本不同」的包盖掉 —— 这次事故正是这么发生的。
2. **createRequire 的锚点不能拿 `package.json` 当存在性判据**。候选目录本身就是 `node_modules`，npm 不会在它根下写 package.json，`existsSync` 会全部落空 —— 症状是「52 个包明明装好了，却报找不到依赖」。锚点用 `path.join(dir, 'noop.js')`，文件不必存在，只用它所在目录当解析基准。
3. **纯 ESM 包要退回目录直查**。`exports` 只有 `import`、没有 `require`/`default` 的包（`@tencent-connect/qqbot-nodejs@1.0.4` 就是）会让 `req.resolve()` 抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`。这种包不可能被 require 到，但也确实装着，所以要能按 `node_modules/<包名>` 直查它的 package.json。
4. **找不到依赖不许抛裸 `ERR_MODULE_NOT_FOUND`**。`loadDep` 回 `{ok:false, error:<中文 + 修复命令>}`、`tryRequire` 回 `{ok:false}`、`requireDep` 抛但抛的是中文原因。界面要照常显示，只在用到该能力的按钮上给原因 —— 这是从 v0.15.0 起就有的约定。
5. **`missingText()` 不许带绝对路径**。那会把用户名泄进界面与日志，而且对排查没帮助；只写「插件自身 `node_modules` 与 DSH profile 里都没有」+ `npm install` 两条。


### 12.33 v0.32.0 新增的验证（流式可编辑消息）

```powershell
cd <插件根目录>\dsh-push-hub

# 1) 流式探针（125 项）
node scaffold\probe_stream.mjs
#    期望 STREAM_OK  流式会话 125 项断言全通过

# 2) 能流的通道必须是能编辑的通道的子集（不另抄一份名单）
node -e "Promise.all([import('./lib/stream.js'),import('./lib/edits.js')]).then(([s,e])=>console.log(s.STREAM_CHANNELS.join(',')===e.EDIT_CHANNELS.join(',')))"
#    期望 true

# 3) 间隔夹值必须回话，不许静默改
node -e "import('./lib/stream.js').then(m=>console.log(JSON.stringify(m.normalizeInterval(50))))"
#    期望 {"ok":true,"ms":300,"detail":"间隔 50 毫秒太密，按下限 300 毫秒走"}

# 4) 运行时：活动流列表
node -e "fetch('http://127.0.0.1:3082/@duma520/dsh-push-hub/api/send/stream/list').then(r=>r.json()).then(j=>console.log(j.ok, j.channels, j.size))"
#    期望 true [ 'telegram', 'slack', 'discord', 'matrix' ] 0
```

检查点（任何一条不成立就是没做对）：

1. **必须节流，不能每来一个字就改一次**。平台对「编辑同一条消息」有频控（Telegram 约 1 次/秒/聊天，Slack 的 `chat.update` 是 Tier 3）。逐字 edit 必然被限流，限流之后界面停在半句话上 —— 比不流式更难看。`flush()` 里用 `timer !== null || inFlight` 双闸挡住。
2. **同一时刻只允许一个 edit 在飞**。上一条还没回来就发下一条，回来的顺序不保证；后发先到会让界面**退回**旧文本然后卡住。所以所有 edit 走同一条 Promise 链（`chain = chain.then(task).catch(...)`）。
3. **中途失败不能中断流**。单次 edit 失败只记进 `failures` 继续收，定稿时再试 —— 一次网络抖动就整条流作废是不可接受的。
4. **`finish` 必须幂等**。第二次调用原样返回第一次的结果，不重复发。已 `finished` / `cancelled` 时直接返回 `closedResult`。
5. **`update('')` 不能把消息清空**。把「还没想好」当成「清空」是很糟的默认值，空文本直接返回 `false` 不覆盖。
6. **`cancel` 不删消息**。已经发出去那条留在那里 —— 删是 `deleteMessage` 的语义，两件事不能混。
7. **`sweep()` 由调用方择机跑**。本模块刻意不开定时器（库不自己制造后台定时器），`bus.js` 目前也还没为它开一个，这是已知的未做完处。

### 12.34 v0.33.0 新增的验证（进度表情）

```powershell
cd <插件根目录>\dsh-push-hub

# 1) 探针：当时 92 项，v0.34.0 扩到 116 项（这一节是 v0.33.0 的记录）
node scaffold/probe_progress.mjs
#    期望 PROGRESS_OK  进度表情 116 项断言全通过

# 2) 能力表必须从 REACTION_CHANNELS 派生，不许另抄一份
node -e "import('./lib/progress.js').then(async(p)=>{const r=await import('./lib/reactions.js');console.log(p.PROGRESS_CHANNELS.join()===r.REACTION_CHANNELS.join()?'DERIVED_OK':'DERIVED_FAIL')})"
#    期望 DERIVED_OK

# 3) 状态机真跑一遍：先挂、再换、重复收尾同一结果
node -e "import('./lib/progress.js').then(async(m)=>{const c=[];const p=m.createProgress({messageId:'M1',emojis:{processing:'P',success:'S',error:'E'},addReaction:async(e)=>{c.push(['add',e]);return{ok:true}},removeReaction:async(e)=>{c.push(['del',e]);return{ok:true}}});await p.start();const a=await p.finish('success');const b=await p.finish('error');console.log(c.map(x=>x.join(':')).join('>'));console.log(a===b?'IDEMPOTENT_OK':'IDEMPOTENT_FAIL')})"
#    期望 add:P>del:P>add:S  然后  IDEMPOTENT_OK

# 4) 运行时：列表接口与两个「必然会失败」的入口
node -e "const B='http://127.0.0.1:3082/@duma520/dsh-push-hub/api';const j=async(p,o)=>{const r=await fetch(B+p,o);return{s:r.status,d:await r.json()}};(async()=>{console.log((await j('/send/progress/list')).d.channels.join());console.log((await j('/send/progress/begin',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({channel:'feishu',messageId:'x'})})).s);console.log((await j('/send/progress/begin',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({channel:'telegram',messageId:''})})).s)})()"
#    期望 telegram,slack,discord,matrix  然后  502  502
```

检查点（任何一条不成立就是没做对）：

1. **挂表情失败不许把发送判成失败**。`lib/bus.js` 里 `beginProgress` 失败时只在 `base` 上加 `progressId: ''` 与 `progressDetail`，`base.ok` 原样保留。理由：消息已经到对方手机上了，表情是锦上添花 —— 把「加表情 500」升级成「发送失败」，用户会以为消息没发出去，然后重发一遍。
2. **同一时刻只有一条 transition 在飞**。`transition()` 里 `chain = chain.then(...)`，先 `remove` 旧的再 `add` 新的。并发不串行会出现「旧的摘了新的没挂上」（界面上什么表情都没有）或「同时挂两个」（一个消息两个符号，比不挂更难看）。
3. **终态只能进一次**。`finish` 用 `closedResult` 兜住，第二次调用原样返回第一次的结果。调用方重试是常态，重复收尾会来回改表情 —— 用户看到「成功」被改回「进行中」，比根本不挂更糟。
4. **Slack 认名字不认字符**。`normalizeEmojiSet(input, 'slack')` 走 `slackNameOf`，表外字符回落 `DEFAULT_SLACK` 并在 `detail` 里说明；不要「猜一个名字」发出去（v0.30.0 踩过：传 `👍` 回 `invalid_name`，而 HTTP 依然是 200）。
5. **不传 outcome 时按失败处理，传 null 时只清干净**。`finish(undefined)` → ❌；`finish(null)` → 摘掉不留表情。这两个语义不能合并：一个说「跑完了但结果不好」，一个说「这条消息不该带任何状态」。
6. **`sweep()` 有调用点了**。v0.32.0 留的坑是「`sweep()` 谁都不调，僵尸流占满 64 个名额只能靠重启」。v0.33.0 在 `listStreams()` 里顺手清一次，返回体多一个 `swept` 数组；`probe_progress.mjs` 的 E13 断言它是个数组。


### 12.35 v0.34.0 新增的验证（进度表治理：TTL 与落盘）

```powershell
cd <插件根目录>\dsh-push-hub

# 1) 探针：116 项断言全过（原 92 + 落盘与 TTL 的 J 段 24）
node scaffold/probe_progress.mjs
#    期望 PROGRESS_OK  进度表情 116 项断言全通过

# 2) 落盘模块：上限 200，路径落在 ~/.dsh/dsh-push-hub/progress.json
node -e "import('./lib/progressstore.js').then(m=>{console.log(m.MAX_KEEP, m.PROGRESS_PATH.endsWith('progress.json'))})"
#    期望 200 true

# 3) TTL 纯函数：固定时钟测，不用真等 30 分钟；没有 createdAt 的不算超时
node -e "import('./lib/progress.js').then(m=>{const NOW=1700000000000;const r=[{id:'a',createdAt:NOW-1000},{id:'b',createdAt:NOW-9000000},{id:'c'}];console.log(m.expiredIds(r,1800000,NOW).join())})"
#    期望 b

# 4) 写一份再读回：结构没走样，emoji 也带回来了
node -e "import('./lib/progressstore.js').then(async m=>{const os=await import('node:os');const path=await import('node:path');const f=path.join(os.tmpdir(),'ph-34.json');const rec={id:'pg1',channel:'telegram',account:'A',messageId:'M1',emojis:{processing:'P'},emoji:'P',createdAt:Date.now()};const w=await m.writeProgressStore([rec],f);const back=await m.readProgressStore(f);console.log(w.ok, back.records.length, back.records[0].id, back.records[0].emoji)})"
#    期望 true 1 pg1 P

# 5) 运行时：列表要多带 swept 与 maxActive，且读列表顺手清超时
node -e "const B='http://127.0.0.1:3082/@duma520/dsh-push-hub/api';fetch(B+'/send/progress/list').then(r=>r.json()).then(d=>{console.log(Array.isArray(d.swept), d.maxActive, d.channels.join())})"
#    期望 true 64 telegram,slack,discord,matrix
```

检查点（任何一条不成立就是没做对）：

1. **落盘只存还没收尾的，不存历史**。`lib/progressstore.js` 写的是「待办清单」不是流水账 —— 历史在 `outbox.json`。两份文件职责分开，才不会一块儿长到几 MB 然后每次收尾都要重写一遍。
2. **写盘失败不许让发送失败**。`writeProgressStore` 出错回 `{ok:false, detail:'进度表情没能落盘：…'}`，`beginProgress` 只是把这段 detail 拼进返回文案，消息照样算发成功。理由同 v0.33.0：消息已经到对方手机上了。
3. **恢复必须先读盘、再 sweep、最后才造新 id**。`beginProgress` 的顺序是 `ensureProgressRestored()` → `sweepProgress()` → 造 id。反过来的话，第一次挂表情就会把磁盘上别人的记录整份冲掉（`PROGRESS_RECORDS` 初值是空数组）。
4. **恢复出来的状态机不会重新挂一次**。`createProgress({initialEmoji})` 传进去后 `status` 直接是 `running`、`current` 就是那个 emoji，`finish` 时先摘旧的再挂新的。如果恢复时又 `addReaction` 一次，平台上就是两个符号叠着。
5. **重启后只能摘、不能算**。恢复出来的 machine 的 `addReaction` / `removeReaction` 都回 `{ok:false, detail:'进程重启过，缺账号凭据…'}` —— 凭据不在内存里，装也装不回来。所以 `endProgress` 对 `meta.restored === true` 的条目在 detail 里补一句「这条是重启前挂的，凭据已失效，只能按记录摘」。
6. **「只读一次盘」的缓存必须配测试钩子**。`ensureProgressRestored()` 用 `restoredOnce` 做单次栅栏，同进程里第二次调用不会再读盘 —— 这是对的（每次挂表情都读一遍盘是白费），但它让「重启」这条路径在同进程里永远测不到。所以导出 `__resetProgressCache()`，只在探针里模拟重启前调。**这条是实际踩到的**：第一版真跑「恢复」返回 `size 0`，就是因为探针和被测代码在同一个进程里。
7. **TTL 用纯函数算，不用定时器**。`expiredIds(records, ttlMs, now)` 三个参数全可注入，探针用固定时钟 `NOW=1700000000000` 就能测「超时被掐 / 没超时不掐 / 没有 createdAt 的不算」。真开一个 `setInterval` 去扫，既测不了又得管生命周期。




### 12.36 v0.35.0 新增的验证（每分钟发送配额）

```powershell
cd <插件根目录>\dsh-push-hub

# 1) 探针：90 项断言全过
node scaffold/probe_ratelimit.mjs
#    期望 RATELIMIT_OK  每分钟配额 90 项断言全通过

# 2) 常量与能力表：11 个通道适用，只有 email 不适用
node -e "import("./lib/ratelimit.js").then(m=>{console.log(m.DEFAULT_PER_MINUTE,m.MIN_PER_MINUTE,m.MAX_PER_MINUTE,m.canLimit('telegram'),m.canLimit('email'),Object.keys(m.NO_LIMIT_REASON).length)})"
#    期望 15 1 30 true false 1

# 3) 0 是「明确不限」，不是「没填」—— 这是唯一关掉的写法
node -e "import("./lib/ratelimit.js").then(m=>{const a=m.normalizePerMinute(0),b=m.normalizePerMinute(99),c=m.normalizePerMinute(-1);console.log(a.perMinute,JSON.stringify(a.detail),b.perMinute,c.perMinute)})"
#    期望 0 "该账号不限每分钟条数（填 0 即关闭）" 30 15

# 4) 预约制：第二个 take 在第一个还没 sleep 完时就看到未来槽位
node -e "import("./lib/ratelimit.js").then(m=>{let t=1700000000000;const l=m.createLimiter({perMinute:2,now:()=>t});const a=l.take(2),b=l.take(2);console.log(a.waitMs,b.waitMs,b.used)})"
#    期望 0 60000 4

# 5) 切 20 块而配额 1：直接拒，不许 waitMs 变 NaN
node -e "import("./lib/ratelimit.js").then(m=>{const l=m.createLimiter({perMinute:1});const r=l.take(20);console.log(r.ok,r.waitMs,String(r.waitMs).includes('NaN'),r.detail.includes('永远发不完'))})"
#    期望 false 60000 false true

# 6) 运行时：11 个通道适用、1 条不适用原因、桶是空的（易失）
node -e "fetch('http://127.0.0.1:3082/@duma520/dsh-push-hub/api/send/limits').then(r=>r.json()).then(j=>console.log(j.size,j.defaults.perMinute,j.channels.length,Object.keys(j.reasons).length))"
#    期望 0 15 11 1
```

检查点（任何一条不成立就是没做对）：

1. **计数单位是「块」，不是「一次 send 调用」。** `countBlocks(body, limit)` 用的是通道内部同一个 `splitBlocks`，切 5 块就记 5 条。按调用计数会低估 5 倍 —— 这正是最容易写错的地方，也是这一版最重要的一条。
2. **超配额时要么全等完再发，要么一块都不发。** `gatedSend` 在 `slot.ok !== true` 时直接返回 `{ok:false, detail}`，此时一个字节都还没出网。发一半比不发更糟：用户既没收到完整内容，又白耗了配额。
3. **闸门只放一处。** `sendToTargets` 的三条扇出分支（零目标 / 单目标 / 多目标）全部走 `gatedSend`；写在四个调用方里必然漏一处。`probe_ratelimit.mjs` 的 F8 断言 `gatedSend(` 至少 4 处，F9/F10/F11 逐条断言三个分支的调用形状。
4. **桶键是「通道|账号|目标」三元组，不能只按通道算。** 同一个机器人往两个群发，两个群各有各的配额；合成一个桶会把 A 群的用量算到 B 群头上，看起来没超、实际上超了。G9 断言桶键里能看见两个目标 id。
5. **0 = 明确不限，这是唯一关掉的写法。** `normalizePerMinute(0)` 回 `perMinute: 0` 且 `detail` 说清「填 0 即关闭」；`mergeUserConfig` 必须特判 `>= 0`，否则填 0 会被 `n > 0` 吃掉、保存不上、看着像 bug。前端数字框的 `min` 也要对 `perMinute` 放行 0（写死 1 会把这个唯一能关掉的写法拦在门外）。
6. **夹值 / 回落必须回 `detail`。** 99 夹到 30、-3 回落 15、`abc` 回落 15、0.4 抬到 1 —— 四种都要在 `detail` 里说清发生了什么并给出正规写法。静默改用户给的值会骗人。
7. **限流器不落盘。** 窗口是易失状态，重启清空是正确行为，不是 bug。同步地，`LIMITERS` 也不主动清桶（清空窗口等于偷偷放宽限流）。I6 / I7 两条反断言守着这两点。
8. **`perMinute: 1` 且 `take(20)` 不许出现 `NaN`。** `slots[overflow - 1]` 在 `want > perMinute` 时必然越界取到 `undefined`，`waitMs` 会变 `NaN` —— 这是施工时真踩到的 bug，修法是算 `waitMs` 之前先接住「这一条本身就超配额」：等多久都发不完，如实拒比让调用方干等更诚实。D8 断言 `waitMs` 是个数、不是 `NaN`。

### 12.37 v0.36.0 新增的验证（入站附件下载）

在真实机器上按顺序跑这几条，每条都有可看的结果（不是「应该能行」）：

```powershell
# 1. 看策略：三值 + 默认值 + 哪些通道下不了
curl.exe -s "http://127.0.0.1:3082/@duma520/dsh-push-hub/api/receive/files/policy"

# 2. 改策略（只改单文件上限，另两个键保持不动）
curl.exe -s -X POST "http://127.0.0.1:3082/@duma520/dsh-push-hub/api/receive/files/policy" -H "content-type: application/json" -d "{\"maxFileMB\":20}"

# 3. 看硬盘上落了什么
curl.exe -s "http://127.0.0.1:3082/@duma520/dsh-push-hub/api/receive/files?limit=20"

# 4. 按策略清一次
curl.exe -s -X POST "http://127.0.0.1:3082/@duma520/dsh-push-hub/api/receive/files/sweep" -H "content-type: application/json" -d "{}"

# 5. 给收件箱里某条消息补下（messageId 从 /receive/inbox 取）
curl.exe -s -X POST "http://127.0.0.1:3082/@duma520/dsh-push-hub/api/receive/files/fetch" -H "content-type: application/json" -d "{\"messageId\":\"telegram-xxx-yyy\"}"

# 6. 探针全绿
node scaffold/probe_download.mjs
```

检查点：

1. **策略默认值是 10 / 7 / 200**，一次都没配过也应该看到这三个数 —— 不是 0，因为「没配」不等于「不限」。
2. **只改一个键不会把另两个重置**。这是最容易写错的一处：`POST` 只带 `maxFileMB` 时，`retainDays` 与 `maxTotalMB` 必须还是原值。
3. **填 0 能存上**。0 是「明确不限」的唯一写法，被当成「没填」就等于界面上怎么点都没反应。
4. **清单和策略一次给全**。`/receive/files` 的返回里既有 `items` 也有 `policy` —— 分两次请求会让页面先显示空目录再蹦出文件，看起来像刚被清过。
5. **超上限的文件一个字节都不请求**。把单文件上限设成 0.001（或设成 1 然后发一个 5 MB 的文件），日志里不该出现下载请求，只该有一条 `skipped` 的理由。
6. **落盘名被洗过**。让对方发一个名字带 `../` 或 `:` 的文件，落地后文件名里不该有能穿越目录的成分。
7. **收件箱里补下不产生第二条记录**。补下前后 `/receive/inbox` 的条数必须一样，只是那条的 `attachments[].localPath` 从空变成路径。
8. **QQ / 钉钉 / 企微的附件显示为「取不到」而不是「下载失败」**。这两种要分开：前者重试一万次也没用，后者过一会儿可以重试。措辞上别写「平台不给」—— QQ 与钉钉是**本轮主动没做**（平台有接口，但会拖长这版），只有企微智能机器人是链路本身不给原图。
### 12.38 v0.37.0 新增的验证（长连接就绪可见）

这一版的验证有个麻烦：六个通道里只有飞书和 telegram 有账号，Slack / Discord / QQ / 钉钉 / 企微**一个账号都没有**，所以「真的连上以后状态会不会跳」没法逐个真连。分成两层验：**逻辑层**用探针把六处埋点与回调契约钉死（结构对了，真连上时必然被调）；**行为层**用飞书真连一次，看时间戳会不会动。

```powershell
# 1) 结构层：六处埋点都在、都走可选链、都包了 try
node scaffold/probe_download.mjs        # K 段 10 项

# 2) 行为层：重启插件后启动飞书接收，等 30 秒看 updatedAt 有没有动
Invoke-RestMethod -Uri 'http://127.0.0.1:3082/@duma520/dsh-push-hub/api/receive/start' `
  -Method Post -ContentType 'application/json' -Body '{"channel":"feishu"}'
Start-Sleep -Seconds 30
(Invoke-RestMethod -Uri 'http://127.0.0.1:3082/@duma520/dsh-push-hub/api/receive/status').status `
  | Where-Object { $_.channel -eq 'feishu' } | Format-List

# 3) 措辞：NO_DOWNLOAD_REASON 里不该再有含糊的「平台不给」
Select-String -Path lib/download.js -Pattern '本轮没做'
```

**检查点（6 条，任何一条不过都算这版没做完）**

1. **飞书 30 秒内从 `starting` 变 `running`**。这是这一版存在的唯一理由 —— 变不了就是没修好。
2. **`updatedAt` 在连接建立那一刻跳一次**。状态名对但时间戳不动，说明 `setStatus` 没被调到（或被调到别处去了）。
3. **没收到任何消息也会变 `running`**。这条最关键：旧版的行为正是「收到第一条才 running」，如果只在发消息后才变，等于没改。
4. **回调抛错不断连**。六处全包了 `try/catch`，探针 K8 钉住这条；真断连的后果是收消息悄悄停了，比状态不准严重得多。
5. **没实现 `onReady` 的 worker 不受影响**。`ctx.onReady?.()` 全走可选链（探针 K7），旧通道行为与 v0.36.0 完全一致。
6. **`NO_DOWNLOAD_REASON` 不再含糊**。QQ / 钉钉必须能读出「本轮没做」，企微必须能读出「链路本身不给」—— 这两件事对用户的意义完全不同：前者的正确反应是「要就催作者做」，后者是「换通道」。

### 12.39 v0.38.0 新增的验证（入站去重 + 游标落盘 + 接收权抢占）

这一版的验证有个绕不过去的短板：**触发它的场景需要真的重载插件再发一条消息**，而「重投」本身不是我能命令平台去做的。所以照旧分两层：**契约层**用探针把每一处逻辑钉死（去重键怎么比、游标怎么存、owner 怎么抢），**行为层**只验能验的（重启后游标还在、状态不再掉进 retrying 的自我修复路径存在）。

```powershell
# 1) 契约层：52 项全绿才算这版做完
node scaffold/probe_dedupe.mjs       # 期望 PASS 52 / fail 0

# 2) 源码契约：14 处 onMessage 必须配 14 处 platformId
Select-String -Path lib/receiver.js -Pattern 'ctx.onMessage\(' | Measure-Object | % Count
Select-String -Path lib/receiver.js -Pattern 'platformId:' | Measure-Object | % Count

# 3) 抢占点：轮询型与长连接型各一处，必须恰好 2 处
(Select-String -Path lib/receiver.js -Pattern '\.id !== INSTANCE_ID' -AllMatches).Matches.Count

# 4) 游标与接收权的落盘目录（与 config / inbox 同级，便于一起备份）
Get-Content $env:USERPROFILE\.dsh\dsh-push-hub\offsets.json -Raw

# 4b) 老记录认领：升级后第一次重投不该把历史重复一遍
#     做法是造一条无 platformId 的老记录，再用同一个 at/from/text 带键写一次，看它是否回 adopted:true 且条数不变

# 5) 运行时版本
(Invoke-RestMethod -Uri 'http://127.0.0.1:3082/@duma520/dsh-push-hub/api/info').version
```

**检查点（6 条，任何一条不过都算这版没做完）**

1. **同一条平台消息重投后，收件箱里仍然只有一条**。这是这版存在的唯一理由。判据是 `total` 不变且返回里带 `duplicate:true` —— 只要 total 涨了就是没修好。
2. **两条「你好」仍然收两条**。去重不能过头：按正文判重会把真消息吞了，这比重复记录难查得多（用户以为对方没发）。
3. **重启插件后 offset 从盘上恢复**，不是回 0。回 0 的话即便去重挡住了记录，平台侧仍会被要求重发全部历史 —— 请求量没减，只是看不见。
4. **`received` 不因重投而虚高**。`duplicate:true` 的那次不进 `received += 1`。
5. **后启动的实例能拿到接收权，先启动的安静退场**。这是 409 的收敛方向；如果反过来（先启动的不让位），用户点第二次「开始接收」会以为没生效。
6. **写游标不会把 owner 冲掉**。`setOffset` 与 `claimOwner` 共用一个文件，写整文件时漏掉 owner 段会让抢占形同不存在 —— 这条踩过，探针 B6/B7 钉着。
### 12.40 v0.39.0 新增的验证（409 韧性）

这一版要证明的不是「409 没了」——它还在，来源在插件之外。要证明的是**抢不到的时候不会哑火**：请求能被停掉、退避是秒级不是分钟级、停完再开不会自己撞自己。

```powershell
cd <插件根目录>\dsh-push-hub

# 1) 契约 + 行为：48 项全绿
node scaffold\probe_conflict.mjs      # 期望 PASS 48 / fail 0

# 2) 全量回归（39 个探针，按退出码判，别 grep 输出）
Get-ChildItem scaffold\probe_*.mjs | ForEach-Object { node $_.FullName *> $null; if ($LASTEXITCODE -ne 0) { $_.Name } }

# 3) 真实行为：起来一个「接住就不说话」的服务端，验 abort 真能提前返回
#    这一步探针 B 段已经自动做了（411ms vs 182ms vs 1ms 三个样本）

# 4) 运行时版本
(Invoke-RestMethod -Uri 'http://127.0.0.1:3082/@duma520/dsh-push-hub/api/info').version

# 5) 界面：点「开始接收」后如果撞上 409，那一行应该转黄并写「正在抢回接收权 · …占用 N 次」
#    而不是继续写「正在收 · 已收 0 条」
```

真机跑过一遍（`curl` 打本机 API，不是探针模拟）：

| 观察点 | 实测 |
| --- | --- |
| 冲突后能不能自己回来 | `start` → t=6s `retrying` `conflicts:1` → t=18s `conflicts:2` → **t=36s `running`、`error:null`** |
| `stop` 是不是真等干净了 | 回 `{"ok":true,"stopped":1,"drained":true}`，耗时 **1226ms**（不是 5 秒超时兜底） |
| 停完立刻开会不会自撞 | `start` → `stop` → 立刻 `start`，t=6s / t=12s **连续两次 `running`**，没有立刻 409 |
| 接收权与游标落盘 | `offsets.json` 里 `owner.id` 与 `offsets['telegram/DSH_Push_Hub']` 都在 |

最后一项的读法要注意：t=18s 之后仍会冒出 409 —— 那是**外部那个轮询者**，不是自己撞自己。本版能保证的只是「撞了会自己抢回来」，不能保证「不撞」。

**检查点（5 条）**

1. **abort 真能让请求提前返回**。这是整版的根 —— 探针 B3 实测 150ms 就回，没被 30000ms 的 `timeoutMs` 拖住。只把 Promise 提前 resolve 而不掐隧道是不合格的（`getUpdates` 还挂在平台上，下次 start 照样 409），所以 `viaProxy` 里必须有 `connection.destroy()`。
2. **409 不再是 60 秒哑火**。退避首次 1.5 秒、上限 6 秒，且**不涨**普通退避（普通退避是给真故障的，两者混用会让一次冲突把整体拖慢半分钟）。
3. **`stop` 会等循环真退出才回**。回 `drained:true` 表示退干净了；回 `drained:false` 表示 5 秒内没退完 —— 这是如实报告，不是失败。
4. **`start` 前会先停同账号的旧循环**。这是原来「stop 只设标志、长轮询还在飞」的直接修法。
5. **界面不再谎报「正在收」**。循环活着但一直在重试时，用户必须能看出来是「抢不到」而不是「没人发消息」—— 这两种情况该采取的行动完全不同。

### 12.41 v0.39.1 新增的验证（主面板滚动）

这一版要证明的不是「样式更好看」，而是**内容超出后真的能被滚到**。容器归属先查清，再动 CSS —— 否则会像 v0.26.1 那样改错层。

```powershell
cd <插件根目录>\dsh-push-hub

# 1) 语法：两处同源 CSS 都要过
node --check lib\client.js
node --check lib\theme.js

# 2) 规范校验
npx --yes dsh-plugin-standard@2 . --json      # 期望 fail 0 / warn 1 / info 0（warn 是 6.1 scripts 缺失，SHOULD 级；本插件零构建，未为消 warn 造空脚本）

# 3) 确认两处 CSS 真的一致（改一处漏另一处是这类改动的经典翻车点）
Select-String -Path lib\client.js,lib\theme.js -Pattern 'dph-pageWrap'

# 4) 运行时版本
(Invoke-RestMethod -Uri 'http://127.0.0.1:3082/@duma520/dsh-push-hub/api/info').version
```

**检查点（3 条）**

1. **滚动条挂在 `.dph-pageWrap` 上，不是 `.dph-root`**。宿主 `.mainPanel` 是 `flex:1; min-height:0;` 且**没有 overflow** —— 它不替插件滚。所以插件自有的根节点必须自己声明 `overflow-y`，并且**不能只靠 `height:100%`**（父级没定高时它退化成 `auto`，`overflow` 就永远不触发，v0.26.1 就是这么踩的）。
2. **用 `max-height` 而不是 `height`**。父级定高时 `max-height:100%` 按父级封顶；父级不定高时它不生效，内容自然撑开、边界交回外层 —— 两种情况都不会把内容憋死。
3. **两处同源 CSS 必须同时改**。`lib/client.js` 里的内联样式与 `lib/theme.js` 注入的主题样式是两份副本，只改一处会在某些加载路径上回到旧样式。


## 十三、版本更新简介

> **开源发布**：本仓库于 2026-11-21 首次公开，内容与 v0.40.2 一致（版本号未变，仅做脱敏与发布动作，按归档号记录）。详见[软件升级迭代记录](软件升级迭代记录.md)最新一段。

| 版本 | 日期 | 一句话变更 |
|---|---|---|
| **v0.40.2** | 2026-11-20 | **删掉的机器人又自己回来了**。主人删掉群晖机器人「DSH 通知」再用同名重建，删之前那条完整 Webhook URL 自动回到输入框、还是只读的，改不掉也删不干净。根因不在后端 —— `lib/index.js:677` 的 `const old = oldRows[i] ?? {}` 是按下标对齐旧行、与名字无关，若复活来自后端那么随便什么名站到下标 0 都会拿到旧值；真凶是**浏览器端「明码」缓存按名称索引**（`lib/client.js:1462` `revealKeyOf = 通道|名称|字段`，`:1748` 按当前名称查，`:1756-1759` 命中即填明文并锁只读），而旧 `dropOwn` 只 filter 行、完全不碰缓存，于是同名重建时键正好撞上。这版只动前端三处：`:847` 新增 `clearRevealed` 按前缀清；`:885` `dropOwn` 在删行前先取名字再清；`:904` `patchOwn` 改到 name 且与旧值不同时清旧名（只改别的字段不清，免得每换一次目标都要重点「明码」）；`:668-672` `reload()` 后 `setRevealed({})` 整体作废。`probe_ownbot_delete.mjs` 19 → 34 项，E5/E6 复刻的就是这一幕。 |
| **v0.40.1** | 2026-11-20 | **群晖「测试失败」的两种真因说清了**。旧文案把 404 一律解释成「token 类型不对」，可发送路径上根本到不了这个分支 —— 实测群晖对「webhook token 调只读接口」与「URL 里令牌已失效」返回**完全相同**的 `{"error":{"code":404,"errors":"invalid token"}}`（垃圾令牌 `A×64` 与真令牌回包一致，不带令牌才是 `code=105`），所以发送时只可能是「整合被删/重建过」，照旧文案换 token 类型只会越改越错。这版给 `explainChatError` 加 `context`，发送语境改说「令牌已失效 → 回面板重新复制整条 Webhook URL」，探测语境保留原文案，探针断言两条必须不同。另一件是局域网 IP 的自签证书必然失败，却要等 `ERR_TLS_CERT_ALTNAME_INVALID` 才报；现在发请求前先认 `10/8`、`127/8`、`192.168/16`、`172.16-31`，命中直接提示换 QuickConnect 域名，不再白跑一次 TLS（不自动代改 —— 后缀每台 NAS 都不同，猜不出来）。`probe_synology.mjs` 45 → 53 项。 |
| **v0.40.0** | 2026-11-20 | **群晖 Chat 的类型跟面板对上了**。原来只有「webhook / bot」两项 —— 那是**协议**，不是群晖面板上的**整合类型**；用户在面板看到的是「传入的 Webhook / 发出的 Webhook / 机器人」三种，选哪个决定要填几项、填什么。这版把 `type` 改成 `incoming` / `outgoing` / `bot`，字段跟着类型走：`incoming` 只留 Webhook URL（填了就用，留空用 NAS 地址 + 令牌自动拼）；`outgoing` 留传出 URL / 令牌 / 频道 / 触发字，**只登记、不参与发送**（它的方向是群晖回调你，令牌是给你验签的，不是发消息的凭据 —— 选它点「发条测试消息」会明确拒绝并提示改另一种）；`bot` 留传入 URL / 传出 URL / NAS 地址 / 令牌 / 用户 ID。老值 `webhook`、`bot` 与空值全部照旧（`webhook`/空/未知 → `incoming`），无需手工迁移。顺带修掉一个空行被当成账号的问题：`type` 是有默认值的下拉，不能算进「hasCredential」，否则只选了类型、什么都没填的空行会被落盘。`probe_synology.mjs` 45 项 + `probe_synology_ui.mjs` 全新重写。 |
| **v0.39.1** | 2026-11-19 | **主面板终于能滚了**。主人报「进推送中枢往下滚不动，底部保存按钮到不了」。根因是三层防溢出全落空：宿主 `.mainPanel` 有 `min-height:0` 但**没有 overflow**（超出即裁）；本插件外层 `.dph-pageWrap` 只有留白、没有高度；里层 `.dph-root` 写了 `height:100%; overflow-y:auto`，可它爹没定高 → `height:100%` 退化成 `auto` → `overflow-y:auto` **永不触发**。v0.26.1 只补了 `.dph-root`，改的正是那层不是元凶的地方。这版把滚动交给 `.dph-pageWrap`：`max-height:100%` + `overflow-y:auto` + 8px 可见滚动条，`lib/client.js` 与 `lib/theme.js` 两处同源 CSS 一起改 |
| **v0.39.0** | 2026-11-19 | **抢不到接收权也不再哑火**。v0.38.0 交付后 409 依然稳定复现，这版先去查清，结论跟上一版**不一样**：不是「热重载后的旧循环」，而是**一个不受本插件控制、被踢掉后几百毫秒内就重连回来的持久轮询者**。证据链：插件停着时宿主到代理的连接恒为 0 条（8 次 × 7 秒采样）；本机 8 个 node 进程逐个看过，没一个在轮询 Telegram；`getWebhookInfo` 的 `url` 空、`pending` 0；决定性的一枪是 `POST close` —— 回 `{ok:true}` 后连发 5 次 `getUpdates`，前两次立刻 `HTTP 500`（确实踢掉了一条），第 3/4/5 次又回到 409。旁证：30 次短轮询只有 1 次 409（3.3%），而窗口越长冲突率越高（3s 1/12、8s 3/12、25s 3/6），是「两个轮询者抢同一 token」的形态。**插件治不了它，只能让自己抢不到时别哑火**，四条：①`lib/http.js` 支持 `AbortSignal`，`direct` 汇进 fetch 自己的 controller，`viaProxy` 在 abort 时**真的 `connection.destroy()`**（只 resolve Promise 的话平台侧那条请求还挂着，下次 start 照样撞）②`TELEGRAM_POLL_TIMEOUT` 25 → **10**，窗口越短撞车概率越低③409 单独标 `conflict` 走**独立短退避**（首次 1.5s、上限 6s），绝不混进普通失败的指数退避（按 60s 退等于一撞哑火半分钟），抢回来即归零④`startChannel` / `stopChannel` 一起改 async：stop 等旧循环真 settle 才返回（超时 5s 后如实回 `drained:false`，不假装成功），start 起循环前先 abort 同账号旧 controller 并等它收尾。顺带把接收面板改准：以前循环活着就一直写「正在收 · 已收 0 条」，现在识别 `retrying` 与冲突次数，写「正在抢回接收权 · 同一个机器人已被别的轮询者占用 N 次」并整行转黄。新建 `scaffold/probe_conflict.mjs` **48 项**，其中 B 段真起一个「接住就不说话」的回环服务端做行为验证（411ms / 182ms / 1ms 三个样本）。全量探针 **39 个全绿**。 |
| **v0.38.0** | 2026-11-19 | **同一条消息不再记两遍**。这版不是读代码读出来的，是主人真发了一条「你好」撞出来的：收件箱里同一条消息记了两条（除 id 后缀外字段全同），同时 telegram 从 `running` 掉进 `retrying`，错误 `getUpdates 失败 HTTP 409: Conflict: terminated by other getUpdates request`。两个症状一个根：**重复写入**（`appendMessage` 无去重，id 用时间戳 + 随机后缀，重投必然生成两个不同 id）与**游标没落地**（telegram offset 只在内存 `acc.__offset`，重启回 0，而 0 在平台语义里是「把未确认的全部再发一遍」，重投完全合规）—— 所以「重启 → 重投 → 重复记录」是必然链路。409 则来自互斥只看内存 Set：热重载后旧模块的接收循环还活着，新模块又起一个，两处同时 `getUpdates` 互相踢。**单修去重挡不住重复请求，单修游标挡不住双实例**，三件事一起做：①新建 `lib/offsets.js` 把接收游标与接收权一起落盘（`.tmp-<pid>` + `rename`，读坏回空表永不抛）②`appendMessage` 加 `platformId` 判重，键是**通道 + 账号 + 平台唯一键**三合一，绝不按正文判重（同一人连发两条「你好」是两条真消息），命中判重仍回 `ok:true`，无唯一键的微信照旧写入 ③13 处 `onMessage` 各补平台唯一键，重投不重复计「已收 N 条」④接收权抢占：每轮读盘上 owner，不是持有者就写「已让位给新的接收实例」安静退场（后启动的赢）。新建 `probe_dedupe.mjs` **46 项**。踩坑：`writeOffsets` 起初只写 offsets 段，`setOffset` 每轮把 owner 冲掉 → 去重与抢占互相拆台，修法是写盘前先 `readOwner` 一起带上。 |
| **v0.37.0** | 2026-11-19 | **能看出长连接通没通了**。v0.36.0 做真实验证时发现：飞书连接明明是通的，界面却永远停在 `starting` —— 接收器只在收到第一条消息之后才把状态推到 `running`，长连接 worker 内部没有任何「我连上了」的汇报点，于是「已经在收」和「连都没连上」长得一模一样（都显示「正在收 · 已收 0 条」，只有时间戳不动）。修法是给 `worker.run` 加可选回调 `ctx.onReady`，六个长连接通道在真实连接建立那一刻调它：飞书用 SDK 自己的 `onReady`、Slack/Discord/QQ 用 socket 的 `open` 事件、钉钉用 `connect()` 的 resolve（内部 `getEndpoint()` + `_connect()`，resolve 即 open，而 `dingtalk-stream` 本身没有就绪事件）、企微用 `connected` 事件。每处都包 `try/catch` —— 状态只是展示，绝不因为回调抛错就断连；没实现的 worker 走可选链，行为与旧版一致。顺带把「取不到附件」的措辞改准：原来 QQ / 钉钉写「平台不给」不是事实，这两家平台是给接口的（QQ 的 5 分钟窗口、钉钉的 `downloadCode` 换临时 URL），只是本轮主动没做，现在写「这条本轮没做，所以取不到」；只有企微智能机器人保留「链路本身不给」。`probe_download.mjs` 补 K 段 10 项（96 → 106）。 |
| **v0.36.0** | 2026-11-18 | **对方发来的图片与文件真的存下来了**。v0.27.0 把十个平台的附件形状统一记了下来，但**只记不取** —— 收件箱里看得到「一张图 12.3 KB」，点不开。这一版接上：真正落到 `~/.dsh/dsh-push-hub/files/<日期>/`。第一道坎不在下载，在**句柄被丢了**：旧的 `compact()` 只留 `{kind,name,mediaType,size}`，Telegram 的 `file_id`、Slack 的 `url_private_download`、Discord 的 `url`、Matrix 的 `mxc://`、飞书的 `file_key` 一个都没留，事后无从下载 —— 所以先把 `lib/attachments.js` 从 263 行改到 440 行，每个解析函数都带上 `handle`。两条铁律：**①不落盘秘密**（Slack 的 `url_private_download` 带 token、Discord 的 url 是限时签名、钉钉的 `downloadCode` 是一次性票据，写进 `inbox.json` 等于把凭据摊在硬盘上；`safeHandle()` 只留 type 与非秘密 id + 一个 `downloadable` 布尔）**②取不到就如实标记**（QQ 的 5 分钟窗口、钉钉要换临时 URL、企微智能机器人链路本身不给文件，一律 `{type:'none',reason}`，不挂点了没反应的按钮）。新建 `lib/download.js` 504 行，三条纪律：**下载失败不影响收消息**（逐条吞异常，最坏全带 `download.state='failed'` 落盘，消息本体一个字不少）／**上限在传输层生效不是事后检查**（先比声明大小，超限一个字节都不请求；`lib/http.js` 因此新增 `binary` 与 `maxBytes`，`viaProxy` 边收边累加、一超就 `response.destroy()`，免得把 500 MB 拉进内存才发现超限）／**落盘文件名不信任平台**（`../../etc/passwd` → `_._etc_passwd`）。三个策略点放**配置顶层**（是「本机硬盘怎么用」不是「某个通道的偏好」）：单文件 10 MB / 保留 7 天 / 总量 200 MB，都可填 0 关闭，夹值必回 detail。清理是**两轮**：先按天数删过期、再按总量从最老的删到不超限 —— 只做天数一天收 500 MB 照样爆，只做总量十年前那个 1 KB 小文件也会被当垃圾清掉。`receiver.js` 里下载放在 `appendMessage` **之前**（记录一旦写下这条消息就「已完成」，补下载得靠人回来点，而用户不会回来点）。`inbox.js` 加 `updateAttachments()` **就地更新**而非补写新消息（补写会让同一张图出现两次）。新增四条路由与第 18 个工具 `push_hub_files`、「入站附件」页。新建 `scaffold/probe_download.mjs` **96 项**（v0.37.0 补到 106）。 |
| **v0.35.0** | 2026-11-18 | **发得太快会被限流 —— 现在按「块」记账，超了就等**。此前唯一能控速的手段是账号级 `chunkDelayMs`（块间隔），可它管的是**同一批块之间**等多久，管不了「一分钟内已经发了多少条」：连着调 20 次 `push_hub_send`，每次都是一块，`chunkDelayMs` 一次都不会触发，而平台的每分钟配额早爆了。新建 `lib/ratelimit.js` 246 行，三条纪律写进头注释：**①限流只让请求变慢，不让它失败**（超配额的正解是等；真等不了才报失败，且**一块都不发** —— 发一半比不发更糟：用户既没收到完整内容又白耗配额）**②计数单位是「块」不是「一次 send 调用」**（切 5 块就是 5 次 API 调用，按调用计数会低估 5 倍，这正是最容易写错的地方）**③预约制不是检查制**（`take(n)` 把 n 个槽位压到未来、调用方 `sleep` 完直接发；检查制的经典 bug 是两个请求同时检查通过、然后一起发出去）。配额默认 15 条/分钟，**填 0 = 明确不限**（唯一关掉的写法），夹到 1~30 且**夹值必回 `detail`**（静默改用户给的值会骗人）。限流器**刻意不落盘**（窗口是易失状态，重启清空是正确行为）。闸门只放一处 `gatedSend`，`sendToTargets` 的三条扇出分支（零目标 / 单目标 / 多目标）全走它 —— 写在四个调用方里必然漏一处。桶键是「通道|账号|目标」三元组，不能只按通道算：同一个机器人往两个群发，两个群各有各的配额，合成一个桶会把 A 群的用量算到 B 群头上。踩到一个必现 bug：`perMinute: 1` 且 `take(20)` 时 `slots[overflow - 1]` 取到 `undefined`、`waitMs` 变 `NaN` —— 修法是算 `waitMs` 之前先接住「这一条本身就超配额」（切 20 块而配额 1 条，等多久都发不完，如实拒比让调用方干等更诚实），这也是 `overflow` 越界的唯一成因。新增 `GET /send/limits`、第 17 个工具 `push_hub_limits`、设置页「发送配额」只读页（配额是悄悄生效的，没这一页用户只会去调 `chunkDelayMs`，而那是块间隔、调它没用），账号高级字段加第三个 `perMinute`（`mergeUserConfig` 要特判 `>= 0`，否则填 0 会被当成「没填」）。新建 `scaffold/probe_ratelimit.mjs` **90 项**。 |
| **v0.34.0** | 2026-11-18 | **进度表会自己清、也记得住 —— 挂着忘收的不再赖着不放**。v0.33.0 把「发送后」那一段填上了，但进度表本身没有任何治理，三条实证的漏洞：①`/send/progress/list` 上真挂着 `{id:'pgmwm27iit-1', channel:'telegram', messageId:'999999', status:'running', emoji:''}` —— 忘了 `end` 的那条，用户看到一条永远「在跑」的消息；②`PROGRESS_HUB` 是 `new Map()`，唯一的 `delete` 在 `endProgress` 里，挂够 64 条就再也挂不上；③进度只活在内存，进程一重启，重启前挂的 ⏳ 永远摘不掉、连 id 都查不到。这一版补三条：**TTL 自动清**（`PROGRESS_TTL_MS = 30 * 60 * 1000`，与 `lib/stream.js` 的 `STREAM_TTL_MS` 同数 —— 半小时还没收尾的真实含义是调用方忘了，不是任务还在跑；清理用纯函数 `expiredIds(records, ttlMs, now)` 算，三个参数全可注入，探针用固定时钟就能测完三条分支，**不开 `setInterval`**，理由是真开定时器既测不了（要真等 30 分钟）又得管生命周期；清理时机沿用流式那条规矩 —— `listProgress()` 与 `beginProgress()` 都先 `sweepProgress()`）、**上限说清楚**（`MAX_ACTIVE_PROGRESS = 64` 是「忘了收尾」的探测阈值不是性能上限，撞上限的文案直接点明「当前 N 条，大多是忘了 end 的」）、**落盘跨重启**（新建 `lib/progressstore.js` 119 行，落 `~/.dsh/dsh-push-hub/progress.json`，`MAX_KEEP = 200`，写盘走 `mkdir -p` → `.tmp-<pid>`（mode `0o600`）→ `rename` 原子替换，读坏/不存在/结构不对一律回空表**永不抛**，写失败只把 detail 拼进返回**不判发送失败**）。一个必须说清的边界：**落盘解决的是收尾，不是「状态机复活」** —— 跨重启能恢复的只有「还挂着、id 是什么、该摘哪个表情」，凭据与中间计数恢复不了，所以恢复出来的状态机 `addReaction` / `removeReaction` 恒回 `{ok:false, detail:'进程重启过，缺账号凭据…'}`，`endProgress` 会在 detail 补一句「这条是重启前挂的，凭据已失效，只能按记录摘」，**不假装能恢复得和没重启一样**（那会让调用方以为重启后还能正常换表情，然后收到一串失败）。两个技术点：`initialEmoji` 不能省（恢复时按默认走 `status` 从 `new` 起步，`finish` 的语义是「挂成功表情」，平台会先留原来那个 ⏳ 再挂 ✅，一条消息两个符号；传了之后一上来就是 `running` 且 `current` 就是它，`finish` 走「先摘旧再挂新」）、单次栅栏必须配测试钩子（`ensureProgressRestored()` 用 `restoredOnce` 只读一次盘是对的，但同进程里第二次不再读，而探针与被测代码本来就同进程 —— 「重启后恢复」这条路径永远返回 `size 0`，第一版真跑就这么挂了；加 `__resetProgressCache()`（双下划线，与 `receiver.js` 的 `__test` 同一套约定）才能测到，**教训：任何「只做一次」的缓存都必须配测试钩子，否则依赖它的分支在自动化里就是不可达的**）。`listProgress()` 因此变成 async（要先读盘恢复再顺手清超时），三处调用点全部跟着改（路由、工具、探针 E4）。探针 `scaffold/probe_progress.mjs` 从 92 项扩到 **116 项**（新增 J 段 24 项）。 |
| **v0.33.0** | 2026-11-18 | **一条消息挂一个状态符号 —— 不用翻记录就知道跑到哪了**。此前「发出去了」是终点：用户只能等最终结果，中间没有任何可观察的信号。这一版加「进度表情」：发完先在消息上挂 ⏳，跑完换成 ✅ / ❌（也可以只摘干净不留符号）。能挂的是 **telegram / slack / discord / matrix** 四家（`PROGRESS_CHANNELS` 从 `REACTION_CHANNELS` 派生，不另抄名单 —— 能挂进度符号的前提就是能加表情）。三条纪律写进 `lib/progress.js` 头注释：**①best-effort 绝不影响发送结果**（消息已经在对方手机上了，表情挂不上是小事；把「加表情失败」升级成「发送失败」会让用户以为没发出去然后重发）**②同一时刻只有一条 transition 在飞**（先摘旧的再挂新的两步有顺序，并发会出现「旧的摘了新的没挂上」或「同时挂两个」）**③终态只能进一次**（调用方重试是常态，重复收尾会来回改表情，比根本不挂更糟）。`finish` 里刻意不用 `this`（调用方把 `finish` 解构出来单独用时 `this` 是 `undefined`，会崩）。Slack 认名字不认字符：`DEFAULT_SLACK` 是 `hourglass_flowing_sand` / `white_check_mark` / `x`，表外字符回落默认并在 `detail` 里说明，不猜名字。八家不能在 `NO_PROGRESS_REASON` 里各写平台级原因（`email` 单写「邮件没有给一封已经投递的信加个表情这回事」）。新建 `lib/progress.js` 254 行；`lib/bus.js` 加 `beginProgress` / `endProgress` / `listProgress` 并把 `progress: true` 接进 `send` 与 `sendOne`；`lib/index.js` 加三条路由与三个工具（13 → 16）；`lib/client.js` 加「进度表情」只读页（忘收尾的会一直挂着，这一页就是用来发现它的）。顺带补掉 v0.32.0 遗留：`listStreams()` 里调 `sweep()`，返回体多一个 `swept` 数组。新建 `scaffold/probe_progress.mjs` 92 项。 |
| **v0.32.0** | 2026-11-18 | **一条消息反复改 —— 长回答不再刷屏**。此前长回答是一次性切块发完：跑得久就很久没有任何动静，用户盯着空白不知道是在干活还是卡了。这一版加「流式可编辑消息」：先发一条「正在处理…」，之后按节流改写**同一条**，定稿时把剩下的段落另发。能流的是 **telegram / slack / discord / matrix** 四家（从 `EDIT_CHANNELS` 派生，不另抄一份名单 —— 能流的前提是能编辑，名单一旦分叉就必然有一条路是死的）。四条纪律写进 `lib/stream.js` 头注释：**①必须节流**（平台对编辑同一条有频控，Telegram 约 1 次/秒/聊天、Slack `chat.update` 是 Tier 3；逐字 edit 必被限流，限流后界面停在半句话上比不流式更难看）**②同一时刻只有一个 edit 在飞**（回来的顺序不保证，后发先到会让界面退回旧文本然后卡住，所以全部走一条 Promise 链）**③中途失败不中断流**（只记 `failures`，定稿再试）**④`finish` 幂等**。分块复用 `splitBlocks`，只把**首块**塞进被编辑那条、余块 `finish` 时另发；`update('')` 直接返回 `false` 不覆盖（把「还没想好」当「清空」是很糟的默认值），`cancel` 也不删消息（删是 `deleteMessage` 的语义）。上限 `MAX_ACTIVE_STREAMS = 64`、`STREAM_TTL_MS` 30 分钟、间隔夹在 300–10000 毫秒且**夹值必回 detail**（静默改值会骗人）。新增 `openStream` / `updateStream` / `finishStream` / `cancelStream` / `listStreams`、五条路由 `/send/stream/*`、三个工具 `push_hub_stream_open` / `update` / `finish`、设置页「流式会话」（只读，开流在工具侧）。新建 `scaffold/probe_stream.mjs` 125 项。 |
| **v0.31.0** | 2026-11-18 | **飞书扫码与飞书接收恢复可用 —— 修的不是代码，是环境**。主人报「飞书原来都可以扫描接入的，怎么现在又不可以了？」，查下来本插件一行没改：宿主 DSH profile 里的 `@larksuiteoapi/node-sdk` 被清空了（只剩**空目录壳**，mtime `2026-11-17 13:07:54`），根因是 dsh-im 5.10.0 把它从 `dependencies` 挪进了 `devDependencies`。**影响面比扫码大**：`loadLark()` 借同一个包，飞书**收消息也一起坏了**（但 `/receive/status` 的 `receivable` 里飞书还在 —— 那是声明层面可收，会骗人）。修法是新建 `lib/deps.js` 统一依赖解析：**①先查插件自身 `node_modules`、②再回落 DSH profile**，顺序不能反（反了用户装了自带版本也白装）；并把原本四份各写一遍的 `createRequire` 全部收编（qr 的 `profileCandidates/loadDepViaRequire/resolveEsmEntry` 整段删掉、receiver 的 `loadLark/requireFromProfile`、ws 的 `loadUndici`、email 的 `loadNodemailer`）。`package.json` 加 `dependencies:{"@larksuiteoapi/node-sdk":"1.76.0"}`（**钉死精确版本、不带 ^**）。两个踩到的坑写进注释：**锚点不能拿 `package.json` 当存在性判据**（候选目录就是 node_modules，npm 不在它根下写 package.json，`existsSync` 全落空 → 52 个包装好了却报找不到）；**纯 ESM 包**（`exports` 只有 `import`，如 `@tencent-connect/qqbot-nodejs@1.0.4`）会让 `req.resolve()` 抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`，必须退回按目录直查。新建 `scaffold/probe_deps.mjs` 59 项。 |
| **v0.30.0** | 2026-11-18 | **能给发出去的消息加表情回应了 —— 同样只四个通道**：telegram / slack / discord / matrix。最大的坑是 **Slack 认名字不认字符**：`reactions.add` 要 `thumbsup`，传 `👍` 回 `invalid_name` 而 **HTTP 仍是 200**，只看状态码会当成功。所以新建 `lib/reactions.js` 带 34 个 Unicode → Slack 名字的对照表，**表里没有的直接拒并要求填名字，绝不猜**。四家语义各不相同：Telegram 的 `reaction` 是对象数组、**空数组 = 清掉全部**（没有「只删某一个」）；Slack 的 `already_reacted` / `no_reaction` 判幂等成功；Discord 是 PUT/DELETE `.../reactions/<emoji>/@me`、**成功 204 无响应体**、自定义表情要 `name:id`；Matrix 的表情是**独立事件**，所以「去掉」要的是**回应事件 id**、只能撤回那个事件。能力表加进 `GET /edit/channels` 的 `react` / `reactReasons`；新增 `push_hub_react` / `push_hub_unreact`、`POST /send/react` / `POST /send/unreact`；新建 `scaffold/probe_reactions.mjs` 94 项。 |
| **v0.29.0** | 2026-11-18 | **发出去的消息可以改、可以撤了 —— 但只四个通道**：telegram / slack / discord / matrix。关键判断是**划清「有能力」与「有把握」的界线**：飞书官方文档确有 `PATCH`/`DELETE /open-apis/im/v1/messages/:id`，但本机没凭据、抓文档只回 25 字节、社区有 `invalid msg_type`，所以**不做**，理由写进代码注释「宁可没有，也不要一个按下去必然报错的按钮」。四家的坑各自处理：Telegram 只允许撤自己发的、48 小时内，且 `message is not modified` 当成功；Slack 用 `chat.delete`（dsh-im 里没实现，按官方文档补的）；Discord 改消息必须带 `allowed_mentions:{parse:[]}`（不然改完带 `@everyone` 真 ping 全频道），撤回成功是 204 无响应体；Matrix 的「改」是再发一条 `m.replace` 新事件、撤回是不可逆 `redact`。同时补上 v0.28.0 的内部缺口：发件箱以前把 id 摊平、把目标 join 成「A、B」，多目标时**分不清哪条 id 属于哪个聊天** —— 现在按 `places:[{id,messageIds}]` 分组。前端能力表由 `/edit/channels` 给，不在前端写死。新增 `push_hub_edit` / `push_hub_delete`、`POST /send/edit` / `POST /send/delete`、`GET /edit/channels`；新建 `scaffold/probe_edits.mjs` 79 项。 |
| **v0.28.0** | 2026-11-18 | **发出去的东西有据可查了**。此前十二个通道的 `send()` 只回「已发送 N 块」，**「那条消息在平台上是哪一条」从来没记下来过** —— 这不是「没实现改消息/撤回」，是它们的地基一直缺着。新建 `lib/outbox.js`（`outbox.json`，上限 500 条，原子替换 mode 600），十二通道各自把平台回包里的 id 收成 `messageIds` 数组（**数组不是字符串**：长消息分块后每块都是独立消息，只留最后一个会导致「改第一条改不到」），bus 逐目标透传，doSend 成功一条记一条。**七家给得出真 id**（telegram/slack/discord/matrix/feishu/qq/email），**五家给不出**（微信/群晖/钉钉/企业微信两家）—— 对这五家不编造，探针反而断言它们源码里不许出现 `messageIds`。新增「发送记录」页与工具 `push_hub_sent`。**失败不进记录**：失败的消息没有 id，记进去只会把真发出去的挤出保留窗口。 |
| **v0.27.0** | 2026-11-18 | **别人发来的图片与文件不再凭空消失**。自查发现的空洞：十个接收通道每一个都只取 `msg.text`，取不到就 `continue`，用户发图发文件收件箱里一个字都没有。新建 `lib/attachments.js` 把十个平台各自的形状（Telegram `photo[]` 多档尺寸、Slack `files[]` + `file_share`、Discord `attachments[]`、Matrix 文件名在 `content.body`、飞书 `content` 是 JSON 字符串、钉钉只给 `downloadCode`、邮件 `parsed.attachments`）压成统一的 `{kind,name,mediaType,size}`，再拼人读摘要进正文；收件箱正文为空但有附件时仍然入库；顺手修 Slack `subtype !== undefined` 把 `file_share` 挡掉（等于 Slack 发来的文件永远收不到）。刻意不做下载。 |
| **v0.26.2** | 2026-11-18 | **删掉的账号真的会消失**。主人实测反馈：「QQ 账号我已经移除，再进去的时候为什么还在？」根因是前后端对「键不存在」理解不一致：前端删掉最后一个账号时把通道键 `delete` 了，payload 里就没有这个通道；后端把「没这个键」当成「这次没提到它」，走 `continue` 保留旧账号 —— 删除在前端生效、落盘被无视，刷新又回来。修法把语义分开：前端删空**保留键传空数组**，后端收空数组走 `delete own[channel]`。**不是 QQ 特有**，telegram / feishu / wechat / 群晖同路径一起修好。新建 `probe_ownbot_delete.mjs` 19 项（截真函数体真跑） |
| **v0.26.1** | 2026-11-18 | **设置面板能滚了**。主人实测反馈：从左上角点开的面板看不到下面 —— 工具区只到「扫码接入」，试发一条 / 代理通道 / 接收消息 / 通道显示 / 通道来源全被裁掉。不是没渲染，是根节点只写了 padding、没写高度与溢出，宿主给的定高容器把超出部分直接裁了。修法补三样：`height: 100%` + `overflow-y: auto` + `min-height: 0`（grid/flex 子项默认 `min-height: auto`，只写前两条仍不生效）；另加 `scrollbar-gutter: stable` 与 `overscroll-behavior: contain`。纯 CSS 改动，两份同源样式表一起改。新建 `scaffold/probe_scroll.mjs` 13 项 |
| **v0.26.0** | 2026-11-18 | **通道列表能自己决定显示什么了**。十二个通道全列在左侧，常用的只有三五个 —— 每开一次设置都要在十几个里找。两个旋钮：**「只显示已配置的」**（没填账号的通道直接不出现，就是「绑定了账号的就显示，没绑定就隐藏」）与**逐通道显示开关**，两档**叠加**。关键纪律：**隐藏 ≠ 停用** —— 只改左侧列表，发送 / 接收 / 默认推送 / 发文件 / 收件箱全都不受影响，所以 `channel_visibility` 只被 `lib/client.js` 读，`bus.js` 与 `receiver.js` 一个字都不读。后端 `channelVisibility()` 会把 `mode:"Bound"` 与拼错的通道名归一（mode 只认 `all`/`bound`，hidden 只留已知 12 个并去重）。另加两处兜底：选中项被隐藏时自动落到第一个可见通道、全被隐藏时左右两侧都给专门说明而不是空白页。新建 `scaffold/probe_visibility.mjs` 37 项 |
| **v0.25.0** | 2026-11-17 | **能引用回复了：五个通道，五家一种写法**。收件箱里看到一条消息想回它一句，此前只能当新消息发，对方看到孤立一句、上下文断了。加法与按钮同一条纪律：**回复是通道能力不是消息属性** —— 不支持回复的七个通道照常发新消息，只在结果里点名原因，绝不因为一句消息带了 `replyTo` 就整批失败。五家写法毫无交集：Telegram `reply_parameters`（必须带 `allow_sending_without_reply`）、Slack `thread_ts`（**是开线程不是引用条**）、Discord `message_reference`（要 `channel_id` 与 `fail_if_not_exists:false`）、Matrix `m.relates_to` **且正文要自己加 `> 原文` 前缀**、QQ `msg_id + msg_seq`。所以又加了一层 `lib/reply.js` 中间表示（与 `lib/buttons.js` 同构），五家翻译集中在一处，通道里只留一行 `...(replyTo !== '' && last ? replyFor(...) : {})`。新建 `scaffold/probe_reply.mjs` 62 项 |
| **v0.24.0** | 2026-11-17 | **钉钉与企业微信也能收了：接收方向到 10 个通道**。此前把这两个列为「收不了」，理由是「群机器人是纯发送 webhook」—— 没错，但只是半个事实：两家都另有长连接型收消息通道。钉钉有 **Stream 模式**（`dingtalk-stream` 的 `DWClient`，用**企业内部应用**的 AppKey/AppSecret 换 `wss`），企业微信有**智能机器人 WebSocket**（`@wecom/aibot-node-sdk` 的 `WSClient`，用 botId/secret）。两个包 profile 里都有（dsh-im 在用），**零新增依赖**；连接同样由本机发起，不需要公网地址。三个必须做对的点：① **收发是两套凭据** —— 群机器人 webhook / 自建应用 corpId 都收不了消息，界面上新字段都标「（接收才要）」；② **钉钉先 `socketCallBackResponse` 再处理**，不应答会重投同一条；③ 话题名用 SDK 的 `TOPIC_ROBOT` 别手写。真正收不了的只剩 2 个。`probe_receive.mjs` 从 131 项扩到 152 项 |
| **v0.23.0** | 2026-11-17 | **邮件也能收了：接收方向到 8 个通道**。此前把邮件列为「收不了」，理由「要 IMAP，与推送语义不同」——改主意是因为 IMAP 同样是本机主动连出去，与长轮询没本质区别。用 profile 已装的 `imapflow` + `mailparser`（零新增依赖）。四个必须做对的点：① **收发是两套服务器**，SMTP 地址不能拿来收信，机器人卡加 `imapHost`/`imapPort`；② **先 `search` 再 `fetchOne`**，边取边数会让 `break` 掉的信永远漏掉（游标已推过它们）；③ 首次接入取**最新** 20 封不是最老 20 封；④ 无游标时只查未读，不灌历史。原因表从 5 条降到 4 条。`probe_receive.mjs` 从 112 项扩到 131 项 |
| **v0.22.0** | 2026-11-17 | **按钮按下去也能收到了**。v0.20.0 只做「发按钮」，按下后的回调没人接（Telegram 的 `update` 一直留在队列、`offset` 推不动）。三个能带按钮的通道把回调接进同一个收件箱，用 `kind:"callback"` 与普通消息区分：Telegram 需把 `allowed_updates` 扩到含 `callback_query` 且**先 `answerCallbackQuery` 再记账**；Slack 认 `block_actions` 取 `action.value`；Discord 认 `INTERACTION_CREATE` 只处理 `type===3` 并**3 秒内回 `{type:6}`**。新增 `GET /receive/inbox/callbacks` 与 `push_hub_receive action=callbacks`。不做「回调自动触发动作」——只落收件箱。`probe_receive.mjs` 从 100 项扩到 112 项 |
| **v0.21.0** | 2026-11-17 | **QQ 也能收了：接收方向到 7 个通道**。此前 QQ 被列为「收不了」，因为官方 SDK `@tencent-connect/qqbot-nodejs` 在 profile 里装坏了（`ERR_PACKAGE_PATH_NOT_EXPORTED`）；这次改走**官方 WebSocket 网关的裸协议**——`GET https://api.sgroup.qq.com/gateway` 拿 `wss` → `op:10` hello 起心跳 → `op:2` identify，收 `GROUP_AT_MESSAGE_CREATE`（群 @）与 `C2C_MESSAGE_CREATE`（单聊）。连接由本机发起，**仍然不需要公网回调**。三个必须做对的点：Authorization 与 identify token 都要 `QQBot <token>` 带前缀（裸 token 401）、intents 必须含 `GROUP_AND_C2C_EVENT`（`1 << 25`，不带则群里 @ 机器人一条都收不到）、拿 token 复用 `qq.appToken()` 不另写一套。仍然收不了的是 5 个（群晖/钉钉/企业微信/企业微信自建/邮件）。`probe_receive.mjs` 从 91 项扩到 100 项 |
| **v0.20.0** | 2026-11-17 | **消息能带按钮了：一种写法，三家翻译**。新增 `lib/buttons.js`（通道无关的按钮中间表示）：调用方只写 `[{text, callback}]`，三家格式（Telegram `reply_markup.inline_keyboard` / Slack `actions` block / Discord `components` action row）由它翻译。**callback 统一按 Telegram 最严的 64 字节验**（按字符验会让 Telegram 400 而另两家通过），一维数组自动每 5 个折行，总数上限 25。工具 `push_hub_send` 多一个 `buttons` 参数，新增 `GET /buttons/channels`，试发页多一个按钮 JSON 输入框。**能带按钮的只有 telegram / slack / discord**，其余 9 个通道照常发文字、按钮丢弃并在结果里点名原因（按钮是通道能力不是消息属性，不能因一个通道不支持就整批失败）。坏格式在 dry_run 阶段就报。`probe_buttons.mjs` 52 项断言 |
| **v0.19.0** | 2026-11-17 | **接收扩到 6 个通道：Slack Socket Mode + Discord Gateway**。`lib/ws.js` 从 DSH profile 借 `undici` 建走代理的 WebSocket（Node 内置的不接受 `dispatcher`，直连实测失败）。Slack 走 `apps.connections.open` 换一次性 `wss` 地址，**每帧带 `envelope_id` 立刻 ack**（否则重投导致重复消息），只认 `events_api` / `event_callback` 且 `api_app_id` 是自己；发消息那把 `xoxb-` Bot Token 不够，要 `xapp-` App Token。Discord 走 `gateway/bot` → `op:10` hello 起心跳 + `op:2` identify，intents 必带 `MESSAGE_CONTENT`（不带则 `content` 恒为空、不报错），心跳未确认主动重连。机器人自己发的消息两边都过滤掉。`NOT_RECEIVABLE_REASON` 从 8 条降到 6 条。`probe_receive.mjs` 从 62 项扩到 91 项 |
| **v0.18.0** | 2026-11-17 | **能发文件了：五个通道的附件投递**。新增工具 `push_hub_send_file` 与三条路由（`/send/file`、`/send/file/account`、`/send/file/channels`）；Telegram 走 `sendDocument`/`sendPhoto`（图片自动选后者，客户端会渲染预览）、Slack 走 2025 年后的三段式（`getUploadURLExternal` → 裸字节 → `completeUploadExternal`）、Discord 走 `payload_json` + `files[0]`、Matrix 先 `media/v3/upload` 拿 `mxc://` 再发 `m.file`、邮件用 nodemailer 附件。`lib/http.js` 新增手写 multipart（直连与代理吃同一份 Buffer，避免「走代理发出空文件」）与裸字节 POST。`lib/files.js` 负责读盘、猜 MIME、按平台上限把关，**相对路径直接拒绝**。另外七个通道不支持附件，选中时逐条点名。新增 `probe_file.mjs` 88 项断言 |
| **v0.17.0** | 2026-11-17 | **机器人卡第四页「高级」+ 十二个通道都补上四个账号级字段**：代理（`proxy`）、分块长度（`maxMessageChars`）、块间延迟（`chunkDelayMs`）、允许自签证书（仅邮件 `allowSelfSigned`）。这四个字段通道实现本来就在读，只是界面一直没入口；分块长度与块间延迟**留空即用通道默认**，不会因为多一个空字段就改变既有行为；只填高级字段**不算「有账号」**，不留空壳。后端把数字 / 布尔字段从「一律当字符串」改成按 `type` 分派（否则清空会变成 0），`lib/bus.js` 让账号级块间延迟盖过全局。新增 `probe_advanced.mjs` 36 项断言 |
| **v0.16.0** | 2026-11-17 | **接收扩到 4 个通道**：新增飞书（官方 `WSClient` 长连接，事件 `im.message.receive_v1`）与 Matrix（`/sync` 长轮询，`next_batch` 游标）。两者都借 DSH profile 里已装的依赖，本插件仍**零新增依赖、零构建**；借不到只回中文原因，不抛 `ERR_MODULE_NOT_FOUND`。Matrix **不解密加密房间**，遇到 `m.room.encrypted` 跳过并在状态里报数。接收页给每个通道标出收法。 |
| **v0.15.0** | 2026-11-17 | **能收消息了（Telegram / 微信）**：宿主只听 127.0.0.1，回调进不来，所以接收走「本插件主动去平台拉」——Telegram `getUpdates` 长轮询、微信 `ilink/bot/getupdates` 带游标。收到的东西落盘 `~/.dsh/dsh-push-hub/inbox.json`（最多 500 条），界面新增「接收消息」页可逐通道启停 / 看收件箱 / 清空，并新增工具 `push_hub_receive`。其余十个通道逐条写清为什么收不了，不假装支持。 |
| **v0.14.0** | 2026-11-17 | **一个机器人可以配多个投递目标**：`own_bots.<通道>[i].targets` 变成数组，界面「投递设置」页可点「+ 再加一个目标」逐条加、逐条删；`target` 只保留第一条作为旧版回落值（老配置一个字不用改）。扇出放在 `lib/bus.js` 的 `sendToTargets()`——**十二个通道实现零改动**；部分目标失败时整体判失败并在回执里点名是哪个 ID 失败（`deliveries` 数组逐条给 ok/detail）。新增 `probe_multi_target.mjs` 37 项断言 |
| **v0.13.0** | 2026-11-17 | **通道从 5 个补到 12 个**：新增钉钉（群机器人 Webhook，支持加签）、企业微信（群机器人 + 自建应用两套协议）、Slack（`chat.postMessage`）、Discord（v10 REST）、Matrix（带 `txnId` 的幂等 PUT）、邮件（SMTP）。**零新增依赖**——七个通道只用 `lib/http.js` 与 Node 内置模块，邮件借 DSH profile 里已有的 `nodemailer`。`BEST_EFFORT` 从 1 个扩到 5 个（微信 / 钉钉 / 企微群机器人 / 企微应用 / 邮件），它们失败不再拖垮整体。六个老通道的请求逻辑一行未动 |
| **v0.12.0** | 2026-11-17 | **机器人卡拆成三个标签页**：点蓝色齿轮展开后，顶部是「通用 / 投递设置 / 访问设置」（群晖只有前两个，它没有 `@` 概念），一个页面只放一类字段——以前名称、五六个凭据、发送到、`@` 提醒全平铺在一个折叠体里，展开要滚十几行才找得到「发送到」；「检查凭据 / 发条测试消息」不进任何一页，永远常驻在标签下方（任何时候都可能想验一下）。后端与 HTTP API 一行未动，新增 `probe_tabs.mjs` 22 项断言 |
| **v0.11.1** | 2026-11-17 | **「发送到」不再二选一**：类型下拉 + 手填 ID 输入框永远同时在场（老版一旦「获取会话」拿到候选就把输入框换成下拉，飞书只列群、QQ 恒为空列表 → 单聊根本没法填）；候选列表降级为另起一行的**可选**补充下拉；五通道各给专属占位文案（`chat_id` / `ou_` / `openid` / `o9cq…@im.wechat` / 数字 user_id），未填收件人时多一行醒目提示说明「凭据没问题，缺的只是 ID」。后端与 HTTP API 一行未动 |
| **v0.11.0** | 2026-11-17 | **侧栏「更多」入口 + 整页面板**：左侧栏底部「更多」里多一项「推送中枢」，点一下整页打开，不用再钻「设置 → 推送中枢」；插件详情页右上多一个「打开推送中枢」按钮。Client 半身注册的 slot 从 2 个变 5 个（新增 `main` / `sidebar.panellist` / `plugins.detail.actions`），`dsh.client.inject` **一个包都没加**（用 `ctx.inject(['layout'])` 懒取布局服务）；拿不到 layout 时只丢侧栏入口、设置界面照旧可用。后端与 HTTP API 一行未动 |
| **v0.10.0** | 2026-11-16 | **硬切断第三方凭据 + 密钥明码**：不再读 `dsh-bridge` / `dsh-im-connect` 的任何文件（`resolveLayers` 只剩自有这一份，删光账号不会再有号冒出来），`/import/bridge` 路由与界面导入页一并删除；密钥字段改成**指纹**显示（`前6位…后4位`），想看全文点「明码」——新增 `POST /reveal`，白名单只放行 `secret` 字段，明文只进浏览器内存、不落盘不写日志；微信改用自记的 `wechat-peers.json`、probe 判据改成「有没有 `ret` 字段」；群晖字段改名「传入 URL / 令牌」并解释 QuickConnect 地址为何不能用局域网 IP |
| **v0.9.0** | 2026-11-16 | **界面换成 DSH-IM 风格 + 群晖协议补齐**：渲染层整体重写（新增 `lib/theme.js`，`dph-` 前缀样式，通道卡 48px/14px 圆角、机器人 38×38 头像、蓝色齿轮点开才展开表单），请求逻辑与 API 契约**一行未动**；群晖 `type` 分 webhook/bot 两套协议，只填 NAS 地址 + token 自动拼 incoming URL，`error.code` 翻成人话（404 = token 类型不对，不是地址错）；同时查清 2026-11-15 会话卡死根因（super-injector `reloadPackage` 8 个无界 await） |
| **v0.8.0** | 2026-11-16 | **通道级代理开关**：设置界面新增「代理通道」工具页，一个地址 + 每通道一个开关（Telegram 默认开、其余默认关、群晖在局域网必须关）；后端 `proxyPolicy`/`proxyForChannel` 归一化配置，`lib/bus.js` 在三处派发前**浅拷贝注入**（绝不改共享对象），五通道与「获取会话」自动生效；明确**不做**「全局代理」与「直连失败偷偷重试走代理」 |
| **v0.7.0** | 2026-11-16 | **界面重做 + 获取会话**：设置界面从「六张卡平铺」改成**左列表（通道 + 工具）+ 右详情**，一次只看一个通道；新增 `POST /api/targets` 与每行「获取会话」按钮（Telegram getUpdates / 飞书群列表 / 微信群聊缓存 / 群晖 user_list 下拉可选，QQ 明说无法列出）；四个通道的「没有发送目标」报错改成可操作指引 |
| **v0.6.0** | 2026-11-16 | **自动保存 + 逐账号测试 + 群聊 @**：改任何字段自动落盘（去掉「保存」按钮，扫码成功即自动写入）；每个账号行内可「探测凭据」「测试发送」；账号新增「发送到（单聊/群聊）+ @ 提醒（不@/指定人/@所有人）」；群晖补齐 webhook 与 bot 两种类型；修群晖 userIds 逗号串解析 |
| **v0.5.0** | 2026-11-16 | **扫码一键创建机器人**：设置界面新增「扫码创建机器人」卡（飞书 / QQ / 微信直连官方扫码授权，扫完点一下即写入自有层）与「从 dsh-bridge 导入已有机器人」卡（只读搬账号，同名重复导入是更新）；后端新增 `lib/qr.js` 与 7 条扫码/导入路由；自有账号带来源徽章与 30 天过期提示 |
| **v0.4.0** | 2026-11-16 | **自有机器人 + 来源优先级**：设置界面新增「自有机器人」卡，按 `自有 → dsh-bridge → dsh-im-connect` 回落且自有账号置顶；配置合并从「整键替换」改为**字段级合并**；修掉「默认通道取消不掉」（新增 `default_channels_explicit` 判别位） |
| **v0.3.0** | 2026-11-16 | **包名前缀统一改为 `@duma520`**：`@lanbaolu/dsh-push-hub` → `@duma520/dsh-push-hub`，HTTP 路由前缀同步变更（旧路由 404）；profile 依赖与 junction 一并重建 |
| **v0.2.0** | 2026-11-16 | **新增自有设置界面**：DSH 设置多一个「推送中枢」分区 + 插件详情页配置；群晖 webhook 可在界面里填；带试发按钮；配置写独立用户级文件，webhook 掩码回传 |
| v0.1.1 | 2026-11-16 | 修 telegram 走代理必超时（`agent:false` 丢弃隧道）；版本号改为读 `package.json`；补全文档 |
| v0.1.0 | 2026-11-16 | 首个可用版本：五通道（telegram/飞书/QQ/微信/群晖 Chat）、3 个工具、3 条 HTTP 路由 |

---

## 十四、设置界面（v0.2.0 新增）

### 14.1 两个入口，同一套界面

| 入口 | 怎么走 | 什么时候用 |
|---|---|---|
| **DSH 设置分区** | 设置 → 左侧栏往下找「**推送中枢**」（order 38） | 专门来配推送，屏幕大、看得全 |
| **插件详情页** | 设置 → 插件 → 找到 `@duma520/dsh-push-hub` → 点开配置 | 刚装完、顺手在插件页里看摘要 |

插件详情页会按场景给两种视图：**摘要卡**里只显示「已配账号」「默认通道」两行 + 一个刷新按钮（铺满整页太吵）；**完整页**和设置分区一模一样。

### 14.2 界面结构（v0.7.0 起「左列表 + 右详情」，v0.9.0 换成 DSH-IM 视觉，v0.12.0 卡片内加三页标签）

> **v0.9.0 变更摘要**：分区方式不变（仍是左列表 + 右详情），变的是**视觉与卡片形态**——颜色/圆角/间距对齐 [dsh-im](https://github.com/xmanrui/dsh-im)，通道卡带方形 logo 且选中态是浅蓝底 + 蓝边框，机器人收进卡片（logo + 名称 + 打码 ID + 绿点 + 最近检查时间），**点蓝色齿轮才展开详细表单**。详见 [14.7](#147-界面改版为-dsh-im-风格v090)。下面这张 ASCII 图仍准确描述分区关系。

v0.6.0 及以前是**六张卡平铺一页**。实测反馈很直接：五套表单同时铺开时，用户分不清哪一行的按钮属于哪个通道，滚动半天找不到刚填的那格。v0.7.0 按 DSH-IM 的分区方式重排：

```
┌──────────────┬──────────────────────────────────────────┐
│ 通道          │  当前选中那一项的内容                       │
│  ● Telegram 1 │  ┌────────────────────────────────────┐  │
│  ● 飞书 1      │  │ 账号卡（凭据 / 发送到 / @ / 测试）      │  │
│  ○ QQ 0       │  └────────────────────────────────────┘  │
│  ○ 微信 0     │  ┌ + 再添加一个机器人 ────────────────┐  │
│  ○ 群晖 0     │  └────────────────────────────────────┘  │
│ ───────────  │                                          │
│ 工具          │                                          │
│  扫码创建机器人 │                                          │
│  试发一条      │                                          │
│  来源与回落顺序 │                                          │
└──────────────┴──────────────────────────────────────────┘
```

左栏每行 = 状态点（有账号就绿）+ 通道名 + 账号数。**一次只渲染一个通道的账号**，新增的账号卡长在下面，不会挤到别的通道里去。

**通道详情里，每个账号是一张卡**。v0.12.0 起点开蓝色齿轮后，卡片里的字段分成**三个标签页**（通用 / 投递设置 / 访问设置，群晖只有前两个），一个页面只放一类字段；「检查凭据 / 发条测试消息」不进任何一页，永远常驻在标签下方。详见 [14.11](#1411-机器人卡拆成三个标签页v0120)。下表按「字段属于哪个页」标注：

| 控件 | 作用 | 说明 |
|---|---|---|
| 账号名（**通用**） | 给人看的名字（如 `家庭群`） | 发消息时可以用它指定账号 |
| 来源徽章 | `扫码`（绿） | 只有扫码创建的账号才有；v0.10.0 起不再有「导入」来源（bridge 已切断） |
| 凭据字段（**通用**） | 该通道要填的字段，随通道而变 | secret 字段显示成密码框 + 「明码 / 隐藏」按钮；非 secret（AppID/账号 ID）明文显示便于核对 |
| **发送到**（**投递设置**） | 类型下拉（单聊/群聊）+ 手填目标 ID（**v0.11.1 起输入框常驻**），列表能列出候选时下面再多一个可选下拉 | 决定发单聊还是发群。**QQ/飞书在协议层是两个不同端点**，选错就发不出去；占位文案按通道与类型变化，见 [14.10](#1410-发送到为什么改成输入框常驻v0111) |
| **获取会话** | 点一下，从平台拉出可发目标的下拉 | v0.7.0 新增，见下表。不知道填什么就点它 |
| **@ 提醒**（**访问设置**） | 不@ / 指定人 / @所有人 | 每通道能力不同，见[已知限制 16](#十一已知限制与安全说明)；群晖没有 @ 概念，这一页整个不出现（只剩两个页签） |
| 检查凭据（**常驻**） | 只读调一次平台接口验证 token 有效 | 不发消息，不打扰任何人。不在任何页签里，三个页都能点 |
| 发条测试消息（**常驻**） | 真的发一条到这个账号 | 行内显示 ✓ 成功简述 / ✗ 失败原因，逐账号独立。同样常驻，改完收件人立刻能验 |

**「获取会话」按通道的实际能力**（v0.7.0，全部实测过）：

| 通道 | 后端怎么取 | 取不到时的提示 |
|---|---|---|
| Telegram | `getUpdates` 拉最近 100 条更新，从 `message.chat` 里去重出会话；`chat.type==='private'` 判为单聊，其余判为群 | 「机器人还没收到过任何消息。在 Telegram 里找到它，随便发一句『你好』，再点一次『获取』。」 |
| 飞书 | `im/v1/chats` 列出机器人所在的群（需 `im:chat:readonly` 权限） | 无群时提示「机器人还没被拉进任何群」；权限不足时提示改手填 `oc_` 开头的 chat_id |
| 微信 | 读本插件自己记的 `~/.dsh/dsh-push-hub/wechat-peers.json`，key 形如 `o9cq…@im.wechat` 的就是本插件成功发过消息的人（v0.10.0 起不再读 dsh-bridge 的缓存） | 「本插件还没成功给谁发过消息…先用『发条测试消息』发成功一次，这里就会记住他」 |
| 群晖「机器人」 | `SYNO.Chat.External / user_list` 拉出数字 user_id + 昵称 | 「传入的 Webhook」直接说明「不需要填发送目标，它天然发到生成这条 webhook 的那个频道」；「发出的 Webhook」明确说明「本插件不会用它发消息」 |
| QQ | **官方不提供列出可发会话的接口** | 如实告知：需要先在群里 @ 一次机器人，再到 QQ 开放平台后台「消息推送」日志里复制 `group_openid` / `openid` |

> QQ 那条不是偷懒：QQ 开放平台的 openid 是「用户 × 机器人」维度的不透明 ID，机器人没被 @ 过就拿不到任何会话，没有任何 API 能列出来。这里选择直接说清，而不是给一个假按钮。

**「发送到」和旧版的区别**：v0.6.0 只有手填输入框。v0.7.0 点过「获取会话」后，同一格会变成下拉（选项形如 `家庭群 · 群 · -1001234567890`），选中时**连 kind 一起带出来**，不会出现「选了群但类型还是单聊」这种错配。

**「@ 提醒」只在发送时生效**：它拼的是消息正文里的 @ 段（Telegram `entities:text_mention`、飞书 `<at open_id>`、QQ `<qqbot-at-user>`），**不影响机器人收不收消息**。要让机器人「被 @ 才回复」，那是 `dsh-im-connect` 的事，见下面的工具面板说明。

**四个工具面板**（左栏下半部分）：

| 面板 | 内容 |
|---|---|
| 扫码创建机器人 | 飞书 / QQ / 微信三行「扫码创建」。扫完**自动保存**，卡片里写「已完成，已自动保存」，顶部出现「撤销刚加的账号」。依赖缺失时按钮置灰并写明原因（QQ 那个包是 `UNLICENSED`，不随包分发） |
| 试发一条 | 输入框 + 「只看分块（不发）」/「真发一条」，按左侧勾选的「设为默认推送」通道群发。只想测某一个账号就用账号卡里那个按钮 |
| **代理通道** | **v0.8.0 新增**。一个代理地址 + 五个通道各一个开关。只给定死走不通的通道打开（Telegram 必开），关着的照旧直连。详见 [14.6](#146-通道级代理-v080-新增) |
| 来源与回落顺序 | 说明 v0.10.0 起**只有一个来源**（`~/.dsh/dsh-push-hub/config.json` 的 `own_bots`）+ 一个文件路径，并**明写「收消息不在本插件范围」**、指路 `dsh-im-connect`（它有 Telegram getUpdates 长轮询、飞书 WebSocket 长连接、`addressed`/`always` 两档 @ 策略） |

**「设为默认推送」勾选框**在通道详情的标题行右侧。勾上 = 进 `default_channels`；`push_hub_send` 不传 `channels` 时就发这些。全部取消勾选会被当成「显式清空」（记 `default_channels_explicit: true`），不会又跳回内置的三个默认通道。

**底部状态行**（顶部右侧，紧跟标题）：

| 元素 | 含义 |
|---|---|
| 状态文字 | `读取中…` / `正在保存…` / `已自动保存 15:42:07` / `保存失败：<原因>` / `所有改动自动保存` |
| 「重新读取」 | 丢掉本地改动，从磁盘重读一遍 |
| 「撤销刚加的账号」 | 只在刚刚扫码成功时出现 |
| 进度条 | 读取 / 保存 / 扫码 / 试发时显示，符合「所有界面都要有进度指示」的约定 |

自动保存的行为约定（v0.6.0 起，v0.7.0 不变）：

- 任何字段改动 → **600ms 后自动 `POST /api/config`**，不需要你点任何按钮
- 同一时刻只允许一个保存请求在飞，后续改动合并到下一次（不会排队打爆后端）
- 首次加载**不会**把空值写盘（`hydrated` 闸门），避免一打开界面就把配置清空
- 掩码字段（`<已配置 9999>`）原样回传 = 保留旧值；只有你真输了新值才覆盖
- 点「获取会话」前会**先 flush 一次保存**：`/targets` 读的是磁盘上的账号，600ms 防抖还没落盘会「找不到账号」，那提示非常费解

### 14.3 配置写在哪

**`C:\Users\<你>\.dsh\dsh-push-hub\config.json`**（v0.2.0 起新建的独立文件，权限 `0600`）。

**为什么用独立文件**（历史原因）：`@wenbin_wb/dsh-bridge` 的 `writeConfig(data)` 是整表重写，本插件若往里写会把用户在 bridge 面板手填的内容冲掉 —— 所以从 v0.2.0 起就写自己这份。**v0.10.0 起更进一步：连读都不读 bridge 了**，这条文件彻底独立，`dsh-bridge` 装不装、改什么都不影响本插件。

### 14.4 webhook 的掩码机制（重要）

界面上看到的群晖 webhook 是 `<已配置 9999>` 这种形式（后四位是真实 token 的尾巴）。这是刻意的：

- `GET /api/config` **从不返回完整 webhook**
- 你只改了账号名、没动 webhook 那一栏 → 前端把 `<已配置 9999>` 原样 POST 回来
- 后端 `mergeUserConfig()` 认这个前缀，判定为「保留旧值」，**不会把掩码当成新 URL 存进去**
- 只有你真正输入了一条新 URL，才会覆盖

已实测：存 `...token=FAKE-TEST-9999` → 返回 `<已配置 9999>` → 再提交这个掩码并改别的字段 → 盘上原文仍是完整 URL。**这一条是防止「点一下保存就把 webhook 清空」的关键。**

### 14.5 界面技术细节（给维护者）

- `lib/client.js` 是**手写的 ModuleLoader bundle，零构建**：`window.__ModuleLoader__.load({ id, factory })`，factory 里只 `require('react')`。没有 JSX、没有 tsc、没有打包器。
- 组件全用 `h()` 手写，```const { createElement: h } = React```。
- 只 `inject = ['slots']`，不需要任何其它宿主服务。
- 两处挂载：

```js
// 设置分区
ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section', id: 'push-hub', order: 38, label: () => '推送中枢',
}, () => h(PushHubSettings, null))), 'push-hub: 设置分区')

// 插件详情页（key 是裸包名，官方按 props.view 分 'summary' / 'page'）
ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
  name: 'plugins.bundle.config', key: '@duma520/dsh-push-hub',
}, (props) => h(PushHubSettings, { view: props?.view }))), 'push-hub: 插件配置')
```

- `package.json` 必须同时有三样才认：`exports['./client']`、`dsh.client = { platform:'web', immediately:true, inject:[...] }`、`dsh.bundle.patch`。少一样 bundle 就不进 boot graph。
- 样式全走 CSS 变量兜底（`var(--dsh-border, #d8dee4)`），浅色/深色主题都能看；字体用 HarmonyOS Sans SC / Source Han Sans SC 等免费可商用字体，不用微软雅黑。
- 界面带**进度条**（`Progress` 组件，读取/保存/试发时显示），符合项目「所有界面都要有进度指示」的约定。

---

### 14.6 通道级代理（v0.8.0 新增）

**先说结论：这不是「全局代理」。** 每个通道一个开关，只给真正走不通的通道打开，关着的通道照旧直连。

为什么必须这样：`api.telegram.org` 在国内直连必然超时，**Telegram 一定要走代理**；微信 iLink、飞书开放平台、QQ 开放平台国内都能直连，走代理反而更慢甚至被风控；群晖 Chat 就在你自己的局域网里（`192.168.x.x`），走代理**直接连不上**。做成一个全局开关，等于逼用户为了 Telegram 把群晖也一起弄坏。

**默认值（装上就是能用的状态）**：

| 通道 | 默认 | 理由 |
|---|---|---|
| Telegram | **走代理** | 国内直连必超时，这是唯一确定需要代理的 |
| 飞书 | 直连 | 开放平台国内可直连 |
| QQ | 直连 | 开放平台国内可直连 |
| 微信 | 直连 | iLink 国内可直连 |
| 群晖 Chat | 直连 | NAS 在局域网，走代理连不上 |

默认代理地址是 `http://192.0.2.10:20808`（用户本机的局域网代理）。**换机器/换网络必须改这一格**，否则 Telegram 会一直连不通。

**怎么用（三步）**：

1. 左栏点「代理通道」。
2. 「代理地址」填你的 HTTP 代理，形如 `http://127.0.0.1:7890`。不写 `http://` 会自动补；末尾带不带斜杠都行。
3. 给需要的通道打勾。右侧文字会在「走代理 / 直连」之间切换。**改完立刻自动保存**，不用点任何按钮。

**怎么验证代理是通的**：回到通道页，点某个账号的「检查凭据」。它会带着当前代理设置真连一次平台接口——返回 `✓` 就说明这条链路通；如果是 `✗ connect ETIMEDOUT` / `ECONNREFUSED`，那是代理地址或端口不对，不是 token 的问题。

**配置长这样**（`~/.dsh/dsh-push-hub/config.json`）：

```json
{
  "proxy": {
    "url": "http://192.0.2.10:20808",
    "channels": {
      "telegram": true,
      "feishu": false,
      "qq": false,
      "wechat": false,
      "synology_chat": false
    }
  }
}
```

**几个容易踩的点**：

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 改了地址但 Telegram 还是超时 | 宿主 ESM 缓存没刷新，后端还是旧模块 | 设置 → 插件 → dsh-push-hub「禁用」再「启用」，或重启 DSH |
| 群晖发不出去了 | 有人为了 Telegram 把这个也勾上了 | 取消勾选。群晖在局域网，必须直连 |
| 账号自己填的 `proxy` 和这里不一致 | **账号自己填的优先** | 要么清空账号那格让它跟随通道开关，要么就以账号为准（这是有意的：单账号可以单独走别的出口） |
| 填了 `socks5://` 不生效 | 只支持 HTTP CONNECT 隧道 | 换成 HTTP 代理；SOCKS5 未实现 |

**明确不做的两件事**（都是刻意的，不是漏了）：

1. **不做全局代理**。用户原话：「不是全局代理，比如tg要代理才可以，微信，飞书 直通就可以，所以是看看哪些需要代理的，才打开开关，使用代理通道。」
2. **不做「直连失败自动偷偷重试走代理」**。理由是它会掩盖真实故障：代理没配好时，你会看到「有时能发有时不能发」这种极难排查的状态。要代理就显式打勾，要直连就关掉，行为可预期。

**技术实现（维护者看）**：`lib/http.js` 的 CONNECT 隧道本来就有（`CAPABILITIES.proxyTunnel = true`），此前取 proxy 的唯一来源是「账号自己填的那个字段」，所以除非每个账号手填一遍，隧道永远走不到。v0.8.0 在 `lib/bus.js` 的三处派发点（send ×2、probe ×1）前用 `withChannelProxy()` **浅拷贝注入**——`config.account()` 返回的是 cfg 内的共享对象引用，就地改会污染整个配置对象。通道文件本身**一行没改**，`lib/targets.js`（获取会话）也自动受益。

---

### 14.7 界面改版为 DSH-IM 风格（v0.9.0）

**一句话**：v0.9.0 把设置界面从「内联样式的表单堆叠」换成 **[xmanrui/dsh-im](https://github.com/xmanrui/dsh-im) 的视觉语言**（MIT），但**只搬界面不搬宿主**。

**为什么只搬界面**：dsh-im 的前端通过 `dsh.client.inject` 依赖 5 个 `@deepseek-ai/dsh-client-*` 包（connection / runtime / ui-settings / ui-slots / locale）。本机 profile 的 `node_modules/@deepseek-ai` 下只有 cosmokit / dsh-brand / dsh-sdk-protocol / 3 个 subagent / schemastery —— **缺任何一个，整个客户端插件都不会激活，设置面板直接消失**。所以 push-hub 保持 `inject = ['slots']` 与 `dsh.client.inject = [runtime, ui-slots]` 两个不变，一行都没加。

**怎么搬的**：新建 `lib/theme.js`（260 行），里面是一张 `THEME_CSS` 字符串 + `installTheme()`。注入方式与 dsh-im 的 `installImStyles()` 完全一致——查 `<style>` 是否已存在（幂等），没有就 `document.head.appendChild`，返回 `() => style.remove()` 交给 `ctx.effect` 管生命周期。**类名全部加 `dph-` 前缀**（dsh-im 用 `dim-`），避免与宿主或其它插件撞样式。

**照抄过来的视觉锚点**：

| 元素 | 数值 |
|---|---|
| 主色 | `#3370ff`（`--dsw-alias-state-business-primary`） |
| 主要文字 / 次要 / 三级 | `#1f2329` / `#646a73` / `#8f959e` |
| 分隔线 | `#e5e6eb` |
| 成功 / 警告 / 错误 | `#20a162` / `#d97706` / `#d54941` |
| 通道卡 | `min-height:48px`、左 30px logo + 右文字、圆角 `14px` |
| 通道卡选中态 | **`[aria-selected="true"]`** → 12% 蓝底 + 43% 蓝边框（用属性选择器，不是 className） |
| 机器人头像 | `38×38`、圆角 `11px`、内部 svg `27×27` |
| 蓝色齿轮按钮 | 高 `32px`、`color:#3370ff`、hover 转 `#1f2329` |
| 左侧栏 | `grid-template-columns: 174px 1px minmax(0,1fr)`，gap 24px |
| 卡片列表 | 单列 grid、gap 8px |

**结构变化**：

- 左栏分两段：**通道**（五个，带方形 logo + 名称 + 「N 个账号 / 未配置」）与 **工具**（扫码 / 代理 / 试发 / 来源；v0.10.0 起「导入」已删）。
- 通道详情页顶部是标题 + 说明 + 「N / N 在线」胶囊 + 问号圆点。
- 每个机器人一张卡：logo + 名称 + 铅笔图标 + 打码 ID → 下一行绿点「运行正常」+ 「最近检查 17:01:51」→ 右侧蓝色齿轮 + 下拉箭头。
- **点齿轮才展开详细表单**（`grid-template-rows: 0fr → 1fr` 做高度动画），同一时刻只展开一张卡。表单没被删，只是收起来了。
- 群晖按 `type` 过滤字段（v0.40.0 起三种）：`incoming` 只留「Webhook URL / NAS 地址 / 令牌」（后两个用于自动拼 URL），`outgoing` 留「传出 URL / 令牌 / 频道 / 触发字」，`bot` 留「传入 URL / 传出 URL / NAS 地址 / 令牌 / 用户 ID」。

**没改的东西**（重要）：所有请求逻辑、API 契约、自动保存、扫码、代理、获取会话**一行都没动**。这次是纯渲染层重写——同一份 `buildPayload()` / `applySave()` / `reload()`，只是把 `h('div', { style: S.xxx })` 换成 `h('div', { className: 'dph-xxx' })`。

**怎么自查**：

```powershell
cd <插件根目录>\dsh-push-hub
node scaffold\probe_newui.mjs        # 期望：NEWUI_OK 全部 8 个视图渲染通过
node scaffold\probe_synology_ui.mjs  # 期望：SYNOLOGY_UI_OK
node scaffold\probe_proxy_ui.mjs     # 期望：PROXY_UI_OK
```

---

### 14.8 切断第三方凭据 + 密钥明码（v0.10.0）

**一句话**：v0.10.0 只做两件事 —— 把「借别人凭据」这条链路彻底切掉，把密钥从「一串看不出是谁的掩码」改成「能认人的指纹 + 想看全文再点一下」。

**为什么要切**：用户原话「push_hub 取消连接 @wenbin_wb/dsh-bridge 插件，避免账号混乱。」三种做法（硬切断 / 先搬后断 / 只隐藏）里选的是**硬切断**：`lib/config.js` 的 `resolveLayers()` 里 `imconnect` 与 `bridge` 两层直接删除，`/import/bridge` 路由、界面「从 bridge 导入」整页、`readBridgeAccounts()` 一并删掉。代价很明确：**切断前 24 个账号，切断后剩 6 个**（telegram 2→1、feishu 2→1、qq 8→1、wechat 10→1、群晖 2→2），而且这 6 个里当时只有 2 个真能用。这是用户知情后选的。

**为什么要明码**：用户原话「Token 现在显示 明码 按键，否则都不知道token 是谁的」。此前 `GET /config` 对所有 secret 字段统一返回 `<已配置 后4位>`，一串账号全长得差不多，认不出哪个 token 属于哪个 bot。

**改成了什么**：

| 层 | 改动 |
|---|---|
| `lib/config.js` | 新增 `fingerprintSecret(value)`：≥12 位返回 `前6位…后4位`（Telegram token 前 6 位正是 bot ID，一眼认人），更短回落老的 `<已配置 后4位>`；新增 `isSecretPlaceholder()` 同时认掩码与指纹 |
| `lib/index.js` | secret 字段改用指纹；新增 `POST /reveal`，**白名单只放行 `OWN_BOT_FIELDS[channel]` 里 `secret === true` 的 key**，其余 400，未知账号 404，明文不落日志 |
| `lib/client.js` | 每个密钥输入框右侧多一个「明码 / 隐藏」按钮；明文存独立的 `revealed` state，**绝不回写 `ownBots`** |
| `lib/channels/wechat.js` | 不再读 dsh-bridge 的 `context-tokens`（实测不带 `context_token` 也能发成功），改记自己的 `~/.dsh/dsh-push-hub/wechat-peers.json`；probe 判据改成「有没有 `ret` 字段」 |
| `lib/targets.js` | 微信「获取会话」改读 `wechat-peers.json` |
| `lib/index.js` 群晖字段 | 文案改成群晖面板上的原话：「类型 / **传入 URL** / NAS 地址 / **令牌** / 用户 ID」，NAS 地址 placeholder 直接写明「别用局域网 IP，NAS 是自签证书会连不上」 |
| `lib/channels/synology.js` | 新增 `explainNet()`，把 `plain HTTP request was sent to HTTPS port` 与 `ERR_TLS_CERT_ALTNAME_INVALID` 翻成可操作的下一步 |

**`.dsh.client.inject` 一个包都没加**（仍是 `runtime` + `ui-slots`）。这是硬约束：加任何一个本机 profile 没装的包，整个客户端插件不激活、设置面板直接消失。

**安全代价（要知情）**：有了 `/reveal` 之后，**本机上任何进程**都能 POST 拿到明文。宿主只监听 `127.0.0.1:9429`，外网进不来，本机不限。这个风险换的是「能在界面上确认自己填的是哪个 token」。明文不写日志、不回显终端、不改写配置文件、不进入 `own_bots`。

**怎么自查**：

```powershell
cd <插件根目录>\dsh-push-hub
node scaffold\probe_reveal.mjs    # 期望：REVEAL_OK（23 项）
node scaffold\probe_config.mjs    # 期望：A~H 全绿，H 段验「删光不再回落」
```

---

### 14.9 侧栏入口与整页面板（v0.11.0）

**一句话**：v0.11.0 让推送中枢从「必须钻进 设置 → 推送中枢」变成「左侧栏底部『更多』里一点就开」，界面本身一行没重画——同一个 `PushHubSettings` 组件，只是多套了两层壳。

**为什么加**：用户截图左侧栏底部有「插件 / 记忆 / 更多」三行，问「可以在这里增加设置吗？」。查过宿主源码后确认：那个「更多」不是独立分组，是**面板列表的溢出菜单**（`dsh-client-ui-sidebar` 的 `PanelMoreMenu`，文案来自 `locales.ts:13` 的 `panels.more`），只有注册了 `sidebar.panellist.actions` 才会出现。所以想进去，就得按宿主的面板契约注册一个真正的 main 面板，而不是在设置里再塞一页。

**怎么做的**（照 `@xmanrui/dsh-im` 的 `plugin-src/client/plugin-page.js`，本机已验证可行）：

```js
// 侧栏与 main 面板属于 layout 服务，不在设置服务的 slots 命名空间里
const stop = ctx.inject(['layout'], (pageCtx) => {
  const stops = []
  stops.push(pageCtx.slots.inject('main', () => pageCtx.slots.register({ name: 'main', key: PANEL_ID }, PushHubPanel)))
  stops.push(pageCtx.slots.inject('sidebar.panellist', () => pageCtx.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => '推送中枢',
  }, PushHubSidebarIcon)))
  stops.push(pageCtx.slots.inject('plugins.detail.actions', () => pageCtx.slots.register({
    name: 'plugins.detail.actions', id: PANEL_ID + '-open', order: 20,
    inject: () => ({ packageName: '@duma520/dsh-push-hub', onOpen: () => pageCtx.layout.selectPanel(PANEL_ID) }),
  }, OpenPanelAction)))
  return () => { for (const s of stops) { try { if (typeof s === 'function') s() } catch {} } }
})
```

**三个 slot 各自的用处**：

| slot | 作用 | 参数 |
|---|---|---|
| `main` | 注册整页面板，`key` 就是面板 id | `PANEL_ID = 'duma520-dsh-push-hub'`（**不能是保留键 `conversation`**） |
| `sidebar.panellist` | 左侧栏那条可点条目，`id` 必须与 `main.key` 一致 | `order: 40`（排在插件 / 记忆之后）、`label: () => '推送中枢'` |
| `plugins.detail.actions` | 插件详情页右上那颗按钮 | `inject` 带裸包名，组件在 `subject.pkg.name` 不匹配时返回 `null` |

**降级策略（关键）**：`ctx.inject` 不存在（老宿主）、抛错（宿主没这个服务）、`pageCtx.slots` 缺失，三种情况都**只跳过侧栏入口**，`settings.section` 与 `plugins.bundle.config` 照旧注册。宁可少一个入口，也不能让整个插件激活失败——设置界面比侧栏重要。

**`dsh.client.inject` 仍然只有两个包**：布局服务是 `ctx.inject(['layout'])` **懒取**的，不进 inject 数组。写进数组而宿主 profile 没装，客户端插件整体不激活（这是 v0.9.0 就踩定的硬约束）。

**整页的边距要自己给**：`main` slot 渲染的是整个内容区，外面没有设置弹窗容器撑边距，所以 `PushHubPanel` 包了一层 `.dph-pageWrap`（`padding: 20px 24px 28px; max-width: 1180px; margin: 0 auto`，窄屏降到 `12px`）。

**没改的东西**：后端路由、五个通道的请求逻辑、自动保存、扫码、代理、获取会话——**一行都没动**。`PushHubPanel` 里就是 `h(PushHubSettings, null)`。

**怎么自查**：

```powershell
cd <插件根目录>\dsh-push-hub
node scaffold\probe_sidebar.mjs   # 期望：SIDEBAR_OK 侧栏入口 41 项断言全通过
```

**已知限制**：① 面板 id 一旦改动，用户已固定在侧栏的那一条会丢（宿主按 id 记 pin 状态）；② 侧栏条目与设置分区是两份 UI 入口，改界面时两边都会变，不存在「只改一处」的捷径。


### 14.10 「发送到」为什么改成输入框常驻（v0.11.1）

**一句话**：v0.11.0 及以前，`发送到` 那一格是**二选一**——列表里有候选就渲染一个下拉，列表为空才渲染输入框。结果就是「点过一次『获取会话』，手填输入框就永久消失」，而五个通道里只有 Telegram 和群晖能真的列出候选，**飞书只列群、QQ 恒为空、微信列的是自己发过的人**，于是单聊根本没地方填 ID。v0.11.1 把输入框改成常驻，候选下拉降级为另起一行的可选补充。

**用户是怎么撞上的**（m04872「QQ和飞书的群聊 和 单聊 发送测试 都不成功」）：

- 飞书页点过「获取会话」，列出 1 个群 → 输入框被换成下拉 → 想填单聊 `ou_` 开头的 open_id，界面上根本没有输入框，只能从群里选。
- QQ 页「获取会话」恒返回空列表 → 虽然出了输入框，但占位只有干巴巴的「对方 ID」，用户不知道要填 `openid` 还是 `group_openid`，也不知道这两个 ID 只能去开放平台后台「消息推送」日志里复制。

**改了什么**（三处，都在客户端，后端与 HTTP API 一行未动）：

| 位置 | 改动 |
|---|---|---|
| `lib/client.js` `TARGET_PLACEHOLDERS` / `targetPlaceholder()` | 新增五通道 × 两类型的占位文案表（`telegram` → `chat_id` 纯数字；`feishu` → `ou_` / `oc_`；`qq` → `openid` / `group_openid` 并说明去哪复制；`wechat` → `o9cq…@im.wechat`；`synology_chat` → 数字 user_id） |
| `lib/client.js` 账号卡的「发送到」块 | `<div class="dph-targetBox">` 里第一行永远是「类型下拉 + 手填 input」，第二行才是候选下拉（`dph-targetPicker`，首项文案「— 也可以直接从这 N 个已列出的会话里挑 —」） |
| `lib/client.js` + `lib/theme.js` | 未填收件人时追加一行 `data-tone="warn"` 的提示；新增 `.dph-targetBox`（`display:grid; gap:6px`）与 `.dph-targetPicker`（`width:100%`）两条样式 |

**为什么候选下拉要另起一行**：候选的文案是「标签 · 详情」（如 `技术（项目组） · 群（group）`），挤在与类型下拉同一行会把 ID 输入框压到只剩几十像素。放第二行既保住输入框，又不丢「点一下就能选」的便利。

**为什么不干脆把「获取会话」删了**：它在 Telegram 与群晖上是真的好用（一次点出所有聊过天的对象 / 所有 NAS 用户），删掉是拿掉能力去治布局缺陷。

**新增的探针**：`scaffold/probe_target_ui.mjs`（19 项断言），分六段守：A 有候选时输入框仍在 + 恰好 1 个候选下拉；B 空列表时出输入框且不出候选下拉；C 默认单聊态不出现 `group_openid` 占位；D 未填 ID 时出提示、填了就不再出；E 三个通道的占位文案各自命中关键词；F 群晖（`kinds` 为空）整块不渲染、也不出提示。

**没改的东西**：五个通道的 `send()` / `probe()`、`lib/mentions.js` 的 `targetOf()`、`/targets` 路由、自动保存节流——**一行都没动**。这次只动了「用户怎么把 ID 填进去」这一层。


### 14.11 机器人卡拆成三个标签页（v0.12.0）

**一句话**：点蓝色齿轮展开设置后，顶部多了一条标签栏——「通用 / 投递设置 / 访问设置」三个页签，一个页面只放一类字段。v0.11.x 及以前是**一个折叠体里平铺全部字段**：名称、五六个凭据、发送到、`@` 提醒、两个测试按钮一口气排下去十几行，展开后想找「发送到」得往下滚，滚动过程中还会误点到别的输入框。

**三个页各放什么**：

| 页签 | 放什么 | 为什么放这一页 |
|---|---|---|
| 通用 | 账号名、移除按钮、该通道的全部凭据字段（secret 字段带「明码 / 隐藏」按钮）、群晖的 `type` 下拉 | 这些是「这个机器人是谁」的身份信息，填一次就不再动 |
| 投递设置 | 「发送到」（类型下拉 + 手填 ID + 可选候选列表）、「获取会话」按钮、通道 hint、候选列表 note、未填收件人的醒目提示 | 这些是「发给谁」，排查发不出去时第一个要看的就是这一页 |
| 访问设置 | 「@ 提醒」（不@ / 指定人 / @所有人 + 成员 ID 输入框） | 它只影响消息正文里的 @ 段，不影响机器人收不收消息，跟投递是两件事 |

**不放进任何一页的**：「检查凭据」与「发条测试消息」这两个按钮 + 结果行，渲染在三个页签**之外**、标签栏下方，任何一页都看得见。理由很直接——你切到「投递设置」改完 ID，下一件事一定是点「发条测试消息」验一下；如果这按钮藏在「通用」页里，等于每次验证都要来回切页。

**群晖只有两个页签**：`botTabsForChannel()` 对 `synology_chat` 过滤掉「访问设置」，因为它 `KINDS` 为空（没有单聊/群之分）、也没有 `@` 概念。`@` 提醒那一格本来就在群晖上渲染成 `null`，留着空白页签只会让人误以为有东西没加载出来。

**状态存在哪**：`const [cardTab, setCardTab] = useState({})`，键是 `cardKey`（形如 `telegram|0`），值是页 id。**按卡分别记**，不是全局一个值——切到另一个机器人时它停在什么页，跟这一张无关。脏值兜底在渲染时做：

```js
const tabList = botTabsForChannel(channel)
const tabId = tabList.some((tab) => tab.id === cardTab[cardKey]) ? cardTab[cardKey] : 'general'
```

存了不存在的页 id、或这个键还没被点过，都落回 `general`，不会渲染出空白面板。

**标签栏的 DOM 与无障碍**：外层 `div.dph-tabsBar`，内层 `div.dph-tabsStrip` 带 `role="tablist"` 和 `aria-label="<机器人名> 的设置"`，每个页签是 `<button role="tab" aria-selected="true|false">`。样式走 `.dph-tab[aria-selected="true"]`——选中的用 `color-mix(in srgb, var(--dph-blue) 11%, #fff)` 浅蓝底 + 主色文字，跟通道卡的选中态同一套色。条子支持横向滚动（`overflow-x:auto` + 隐藏滚动条），窄屏下页签多了也不会把卡片撑破。

**视觉上少了什么**：页与页之间的分隔是一根 `1px` 的 `border-top`（`.dph-tabPanel`），标签栏本身没有下划线指示器——dsh-im 那边用的是浅色胶囊，这里照抄胶囊，不再多画一条线，否则胶囊 + 下划线双指示会显得脏。

**新增的探针**：`scaffold/probe_tabs.mjs`（22 项断言），分五段守：A 默认停「通用」+ 三个标签文案与顺序 + 同一时刻只有一个选中态与一个面板；B 切「投递设置」后出现「发送到」且凭据字段消失；C 切「访问设置」后出现「@ 提醒」，且两个测试按钮在任意页都在；D 群晖只有两个页签；E 脏值（不存在的页 id / 别的卡的键 / 空对象）一律回落「通用」。

**没改的东西**：五个通道的 `send()` / `probe()`、`lib/bus.js` 的派发、`lib/config.js` 的合并、`/config` 与 `/targets` 路由、自动保存节流——**一行都没动**。这次只动了「用户怎么看这些字段」这一层，`lib/client.js` 与 `lib/theme.js` 各加样式与渲染分支。

### 14.12 七个新通道是怎么加的（v0.13.0）

**一句话**：v0.13.0 把通道从 5 个补到 12 个——新增钉钉、企业微信（群机器人 + 自建应用两套）、Slack、Discord、Matrix、邮件。七个通道**零新增依赖**，全部只用 `lib/http.js` 与 Node 内置模块；邮件借 DSH profile 里已有的 `nodemailer`。

**为什么之前只有五个**：早先把「国内常用 + 有明确机器人 API」排完了就停手，钉钉 / 企微 / Slack / Discord 一直挂在[已知限制第 9 条](#十一已知限制与安全说明)里。用户看了 dsh-im 的设置界面后要求「完全克隆」，于是补齐。

**每个通道都遵守同一份契约**（`lib/channels/telegram.js` 当模板，一字不改）：

| 导出 | 类型 | 说明 |
|---|---|---|
| `NAME` | string | 与 `ALL_CHANNELS` 里的名字一致 |
| `TITLE` | string | 界面上显示的中文名 |
| `MAX_CHARS` | number | 单块上限（**按平台字节限制折算过**，见下） |
| `send(text, acc, options)` | async → `{ok, detail}` | 内部用 `splitBlocks` 切块、块间 `sleep(delay)` |
| `probe(acc)` | async → `{ok, detail}` | 只读端点，**绝不依赖收件人** |

**七个通道的入站/出站方式与成功判据**：

| 通道 | 出站端点 | 成功判据 | 只读探测 |
|---|---|---|---|
| 钉钉 | `POST oapi.dingtalk.com/robot/send?access_token=` | `errcode === 0` | ❌ 没有，只校验形状 |
| 企业微信（群机器人） | `POST qyapi.weixin.qq.com/cgi-bin/webhook/send?key=` | `errcode === 0` | ❌ 没有，只校验 key 是 UUID |
| 企业微信（自建应用） | `gettoken` → `POST cgi-bin/message/send` | `errcode === 0`（再看 `invaliduser`） | ✅ 换 token 即验 |
| Slack | `POST slack.com/api/chat.postMessage` | **`data.ok === true`**（HTTP 恒 200） | ✅ `auth.test` |
| Discord | `POST discord.com/api/v10/channels/{id}/messages` | HTTP 200（**不是 201**） | ✅ `GET /users/@me` |
| Matrix | `PUT /_matrix/client/v3/rooms/{id}/send/m.room.message/{txnId}` | 回 `{event_id}` | ✅ `whoami` |
| 邮件 | SMTP（`nodemailer`） | 无异常即成功 | ✅ `transport.verify()` |

**三处必须同时改齐的注册点**（漏一处就会「能发但界面没有」或「界面有但没注册」）：

1. `lib/bus.js`：`import` + `REGISTRY`（12 项，顺序即展示顺序）+ `BEST_EFFORT`（软通道集合）。
2. `lib/config.js`：`ALL_CHANNELS`（12 项，`proxyPolicy` 按它遍历代理开关）+ `DEFAULT_PROXY.channels`（12 个布尔）。
3. `lib/index.js`：`TARGET_META`（「发送到」的类型与提示）+ `OWN_BOT_FIELDS`（账号卡的字段表，`maskedUserConfig()` 按它自动掩码）。

前端还要同步四张表：`CHANNEL_TITLES` / `CHANNEL_ORDER` / `LOGO_CLASS` + `LOGO_TEXT` / `OWN_HINTS` / `TARGET_PLACEHOLDERS`，以及两份 CSS 里的 7 行 logo 配色（`.dph-logoDingtalk` 等）——`lib/theme.js` 与 `lib/client.js` 内联的 `THEME_CSS` **必须字节级同源**。

**软通道为什么是这五个**：`BEST_EFFORT = new Set([wechat.NAME, dingtalk.NAME, wecom.NAME, wecomApp.NAME, email.NAME])`。判定标准是「**有没有稳定的只读探测接口**」——钉钉 / 企微群机器人 / 邮件都没有（前者只有 Webhook，邮件要真连 SMTP），它们天然只能尽力而为。它们失败不该把「同时发到 Telegram 群」那条成功的路判成整体失败。Slack / Discord / Matrix 有 `auth.test` / `users/@me` / `whoami`，仍是硬通道。

**「按字节折算」是什么意思**：企业微信群机器人单条上限是 **2048 字节**，中文按 UTF-8 占 3 字节 → `MAX_CHARS` 给 600（600×3 = 1800，留富余）。给 2000 会直接被服务端截断或报错。同理 Discord 的 2000 字符、Slack 的 4000 字符都是**字符**不是字节，所以那两处可以直接用平台的数字减一点余量。

**刻意没做的三件事**：

- **Matrix 加密房间**：要用房间的会话密钥加密每条消息，本插件不做。遇到加密房间**如实报错**，不把明文发出去假装成功。
- **富文本**：Slack 的 Block Kit、飞书卡片、Discord embed 都能发，但分块 / 转义 / @ 提醒三件事会同时变复杂。推送场景要的是「文字可靠送达」。
- **Discord / Slack 的自动重试**：429 时只把 `retry_after` 写进 `detail`，不自动重试——重试会越限越深。

**没改的东西**：六个老通道（telegram / feishu / qq / wechat / synology_chat + 它们的 probe）一行未动；`lib/http.js` 的代理隧道、`lib/text.js` 的分块、自动保存节流、`/config` 与 `/targets` 路由全部原样。这次只做了「加通道」这一件事。

**自查命令**：`node scaffold\probe_apply.mjs` 看 `registryCoversAll = true` 与 12 个通道名；`node scaffold\probe_proxy.mjs` 看 17 项代理断言仍全过（它现在遍历 12 个通道）。

### 14.13 一个机器人发多个目标（v0.14.0）

**一句话**：v0.14.0 起一个机器人可以同时发到多个会话——配置里多了 `targets` 数组，界面上「投递设置」页多了一个「+ 再加一个目标」按钮。`target` 仍然保留，只当第一条的回落值。

**为什么要做**：日报这种消息，用户常常想同时丢到「自己的单聊」和「项目群」，以前只能建两个账号、填两份一模一样的 token。dsh-im 那边一直是 `targets` 数组，用户要求对齐。

**配置长这样**：

```json
{
  "own_bots": {
    "telegram": [
      {
        "name": "我的机器人",
        "botToken": "123456789:AAH-...",
        "targets": [
          { "kind": "user",  "id": "6317****92" },
          { "kind": "group", "id": "-1001234567890" }
        ],
        "target": { "kind": "user", "id": "6317****92" }
      }
    ]
  }
}
```

**三条回落规则**（`lib/mentions.js` 的 `targetsOf()`，按顺序）：

1. 有 `targets` 数组 → 用它。途中过滤掉：非对象项、`id` 为空的、`id` 重复的；`kind` 不合法的归一成 `auto`。
2. 数组为空或没这个键 → 回落 `target`（v0.6.0 以来的单目标）。
3. `target` 也没有 → 回落 `allowFrom[0]`（老的 @ 白名单首项）。

三条都没有 → 返回 `[]`，`sendToTargets()` 不拦截，直接交给通道自己报「还没填发送到」——**错误文案由通道给，因为每个通道要填的 ID 形态不一样**。

**扇出发生在哪**：`lib/bus.js` 的 `sendToTargets(mod, body, acc, options)`，三处派发（`send` / `sendOne`）都经过它。

| 目标数 | 行为 |
|---|---|
| 0 | 原样调 `mod.send`，让通道报它自己的「没填发送到」 |
| 1 | `mod.send(body, { ...acc, target: targets[0] })` —— **仍然显式钉住**，防 `allowFrom` 回落发错人 |
| ≥2 | 逐个调 `mod.send`，收集 `deliveries`；全成功才 `ok: true` |

**为什么不下沉到通道**：12 个通道的 `send()` 都只认 `acc.target` 一个值。放通道里要改 12 个文件、每个各写一遍分块与失败统计，改一次得验 12 次。放 bus 层的结果是**通道实现零改动**——`probe_telegram` / `probe_synology` / `probe_wechat_peer` 这些老探针一个断言都没动。

**界面怎么改**：「投递设置」页的「发送到」从一个 `inline` 行变成 `targetList.map()` 多行，每行是「类型下拉 + ID 输入框」，行数大于 1 时每行右侧多一个「删」按钮；底部 `div.dph-targetFoot` 里是「+ 再加一个目标」和一个仍然可选的「从已有会话里挑」下拉。候选下拉 `defaultValue` 固定为 `''`，选中后调用 `addTarget()` 并把 `selectedIndex` 复位——不复位的话同一个候选第二次选不动。

**逐条增删的四个 helper**（都在 `lib/client.js`）：

| 函数 | 干什么 |
|---|---|
| `targetsOfRow(item)` | 读 `targets`；为空则把单 `target` 包成一条，保证界面上永远至少有一行可填 |
| `patchTarget(channel, rowIndex, idx, patch)` | 改某一条的 `kind` 或 `id`，同时把第一条写回 `target` |
| `addTarget(channel, rowIndex, preset)` | 追加一条；`id` 相同则不重复加（避免同一个群发两遍） |
| `dropTarget(channel, rowIndex, idx)` | 删某一条；**至少留一条空行**——全删光界面上就再也没有输入框了 |

**未填完的提示改了文案**：「还有目标没填收件人 —— 现在点『发条测试消息』会直接失败。凭据本身没问题，缺的只是收件人 ID。」（v0.11.1 那句「还没填『发送到』」说的是「一个都没有」，多目标后真实情况常常是「填了几个、漏了一个」，原文案会误导。）

**没改的东西**：12 个通道的 `send()` / `probe()`、`lib/http.js`、`lib/text.js`、`/config` 与 `/targets` 路由、自动保存节流——一行未动。本次只动 `mentions.js`（加两个导出）、`bus.js`（加一个私有函数）、`index.js`（合并且 targets 字段）、`client.js`（多行渲染与四个 helper）、两份 CSS（5 条）。

**新增的探针**：`scaffold/probe_multi_target.mjs`（37 项断言，`MULTITARGET_OK`），六段守：A `targetsOf` 解析与去重回落；B `describeTargets` 文案；C bus 扇出（源码含 `sendToTargets`、两处派发都走它、`deliveries` 回传、部分失败能数出来、每个目标各调一次）；D `index.js` 的收与发；E 老配置零迁移；F 五个 class 与四个 helper 在 theme 与 client 里各一处。

### 14.14 接收消息：四条主动拉的路子（v0.15.0 / v0.16.0）

**一句话**：v0.15.0 起本插件能收消息了，v0.16.0 把能收的通道从 2 个扩到 **4 个**（Telegram / 微信 / 飞书 / Matrix）。四条路的共同点是**本插件主动去平台拉**，不是给平台一个回调地址。

**为什么不能做 webhook**：DSH 宿主只监听 `127.0.0.1:9429`，没有公网地址、没有端口映射、没有反向代理。飞书 / QQ / 群晖官方的消息推送都要「填一个能被公网访问的回调 URL」，这个 URL 我们给不出来。所以接收方向只有一条路：**各平台自己的客户端拉取能力**。这也是 `dsh-im` 的做法（v0.10.0 起本插件已与它完全脱钩，只是参考了它的协议用法）。

**四个能收的通道，两种拉法**：

长轮询（本插件问平台「有新消息吗」，平台挂住不答直到有消息或超时）：

| 通道 | 拉法 | 端点 | 游标 | 一次最长挂多久 |
|---|---|---|---|---|
| Telegram | `getUpdates` 长轮询 | `https://api.telegram.org/bot<token>/getUpdates` | `offset = update_id + 1` | 25 秒（`timeout: 25`，本地超时 40 秒） |
| 微信 | `ilink/bot/getupdates` 长轮询 | `<baseUrl>/ilink/bot/getupdates` | `get_updates_buf` 字符串 | 服务端决定 |
| Matrix | `/_matrix/client/v3/sync` 长轮询 | `<homeserver>/_matrix/client/v3/sync` | `next_batch` 字符串 | 25 秒（`timeout=25000`，本地超时 40 秒） |

长连接（本插件先连上去，平台沿这条连接把事件推下来）：

| 通道 | 拉法 | 端点 | 收取的事件 | 断开后 |
|---|---|---|---|---|
| 飞书 | 官方 `WSClient`（`@larksuiteoapi/node-sdk`） | 由 SDK 自己向飞书换取长连接地址 | `im.message.receive_v1` | `run()` 返回 → 外层按指数退避重连 |

**为什么飞书算「主动拉」**：长连接的 TCP 是**本插件发起的**（SDK 主动向飞书要连接地址然后连上去），飞书没有反过来访问本机任何端口，所以同样不需要公网地址。这是它和 webhook 的本质区别。

**为什么另外八个收不了**：这不是"还没做"，是"做不了"或"代价不对"，页面上逐条写清：

| 通道 | 真实原因 |
|---|---|
| QQ | 官方是 WebSocket 网关（`@tencent-connect/qqbot-nodejs`）。实测 profile 里这个包 **`ERR_PACKAGE_PATH_NOT_EXPORTED`**（没有 exports 主入口），换 `qqbot-connector` 又在 ESM 下报 `exports is not defined in ES module scope` —— 不是"懒得接"，是这两个包在本机都装不成可用的导入路径。 |
| 群晖 Chat | 面板只给「传出 URL」做回调，DSH 宿主只监听 `127.0.0.1`，NAS 连不进来。 |
| 钉钉 / 企业微信群机器人 | 群自定义机器人是**纯发送 webhook**，平台根本没提供读取接口。 |
| 企业微信自建应用 | 可以收，但要配置「接收消息服务器」回调 URL，同样需要公网。 |
| Slack / Discord | 官方推荐 Events API 回调；Socket Mode 与 Gateway 都要额外依赖。 |
| 邮件 | 收邮件要 IMAP 客户端，与「推送」是两套语义（且要常驻连接）。 |

**收到的消息去哪**：`~/.dsh/dsh-push-hub/inbox.json`，最多留 500 条，原子写（`.tmp` + `rename`）。进程重启不丢，也不要求接收时有人开着界面。结构：

```json
{
  "version": 1,
  "updatedAt": "2026-11-17T06:00:00.000Z",
  "messages": [
    { "id": "telegram-lx9k2a-7f3d1c", "channel": "telegram", "account": "我的机器人",
      "at": "2026-11-17T05:58:11.000Z", "from": "6317****92", "text": "跑完了吗" }
  ]
}
```

`id = channel + "-" + Date.parse(at).toString(36) + "-" + 随机6位` —— 同一条消息重复拉到也不会覆盖别人。

**界面怎么用**：左栏「工具」下多一项「接收消息」。进来先看到「能收的通道」四张卡（每张一个「开始接收 / 停止接收」按钮；未开启时右侧标出它的收法 `长轮询` 或 `WSClient 长连接`，运行中显示已收条数与最近时间），下面是「为什么另外这些收不了」逐条列出原因，最下面「收件箱」按时间正序列出最近 100 条，带「清空」按钮。

**后端五个路由 + 一个工具**：

| 接口 | 方法 | 作用 |
|---|---|---|
| `/receive/status` | GET | 回 `{receivable, status, blocked}` —— 哪些能收、每个账号的运行态、每个收不了的通道为什么 |
| `/receive/start` | POST | `{channel}`；先查 blocker（非空直接 400），再取 `own_bots[channel]`，注入通道代理后逐账号起循环 |
| `/receive/stop` | POST | `{channel}`；`channel` 为空则停全部 |
| `/receive/inbox` | GET | `?limit=N`，默认 50，最多按 `MAX_KEEP` 截断 |
| `/receive/inbox/clear` | POST | 清空收件箱 |
| `push_hub_receive` | 工具 | `action` = `start` / `stop` / `status` / `inbox`，让对话里也能操作 |

**循环与退避**（`lib/receiver.js`）：每个账号一个 `AbortController`，一个循环；失败后 `backoff = Math.min(backoff * 2, 60000)` 且用 `interruptibleSleep()` 等待（`abort` 时立刻醒），成功重置回 2000。`stop()` 只做 `ctrl.abort()`，循环在下一轮开头自己退出 —— 不留悬挂定时器。

**刻意没做的三件事**：

1. **不做「收到就自动回一句」**：那需要一个把消息变成 DSH 会话回合的桥（dsh-im 走的是宿主的 `typertGateway` 服务）。本机 desktop profile 的 `cordis.patch.yml` 里搜不到这个服务，装了也用不起来 —— 所以只把消息落到收件箱，让界面与工具去读。
2. **不做「启动即自动接收」**：接收是常驻网络请求，默认关着。要开就点按钮，重启后也不自动恢复（避免用户忘了它在耗流量）。
3. **不给收不了的通道加假开关**：见上表。

**v0.16.0 新增的两条路怎么实现的**（都在 `lib/receiver.js`）：

| 项 | 飞书 | Matrix |
|---|---|---|
| worker 形态 | `mode: 'longconn'`，走 `run()` 而不是 `poll()` | 普通 `poll()`，和其它长轮询一样 |
| 依赖来源 | `createRequire(~/.dsh/profiles/desktop/node_modules/noop.js)('@larksuiteoapi/node-sdk')` | 无，只用 `lib/http.js` 的 `getJson` |
| 断了怎么办 | `run()` resolve 后由外层 `runLoop` 的 longconn 分支按指数退避重连 | 与 Telegram 同一套退避 |
| 停止怎么生效 | 外层 `abort` → `run()` 内部的 `Promise` 收到 abort → `wsClient.close({ force: true })` | `signal` 传给 `getJson` 的 `timeoutMs`，下一轮检查点退出 |
| 只取什么 | 只认 `message_type === 'text'` 且 `content` 是合法 JSON 的 `im.message.receive_v1` | 只认 `m.room.message` 的 `content.body` |
| 明确不做 | 不做卡片回调（`card.action.trigger`）、不做图片/语音 | **不解密加密房间**：遇到 `m.room.encrypted` 就跳过并在状态里写「跳过 N 条加密消息（本插件不解密）」 |

**借不到依赖时怎么办**：`loadLark()` 返回 `null` 并把原因记在 `cachedLarkError`；`run()` 第一行就判断，返回 `{ok:false, detail:'飞书接收要用官方 SDK，profile 里没有 @larksuiteoapi/node-sdk：<原因>'}`，绝不让 `ERR_MODULE_NOT_FOUND` 冒到界面上。探针 F9 断言的就是这条：要么借到 `WSClient`，要么老实返回 `null`。

**新增的探针**：`scaffold/probe_receive.mjs`（62 项断言，`RECEIVE_OK`），六段守：A 收件箱读写与损坏容错（9 项）；B 能力声明与 blocker 文案（8 项）；C 启停与 stop 不炸（6 项）；D `lib/index.js` 的五条路由与工具注册（6 项）；E `lib/client.js` 的接收视图（15 项）与两份 `THEME_CSS` 逐字节同源（2 项）；F 飞书 / Matrix 的接收实现（12 项：长连接形态、文本提取、非文本不认、坏 JSON 不抛、借不到 SDK 也不抛、不假装解密）。
### 14.15 账号级高级字段：那些一直存在但没入口的设置（v0.17.0）

**一句话**：v0.17.0 之前，**十二个通道的实现全都在读** `acc.proxy` / `acc.maxMessageChars` / `options.delayMs`，但界面上只有 Telegram 与企业微信应用给了一个「代理」输入框，分块长度与块间延迟**一个入口都没有** —— 想给某个账号单独调，只能去改 `~/.dsh/dsh-push-hub/config.json` 或改代码。v0.17.0 把机器人卡加了第四页「高级」，把四个字段摆出来。

**为什么要做**：这不是「补几个输入框」，是补一类**静默失效**。举两个真实场景：

- 公司内网只有某个代理能出网，你给 Telegram 填了代理、给 Slack 也想填一个不同的（走另一条线路）。以前 Slack 只能跟着通道级「代理通道」的全局开关走，一开全通、一关全关。
- 某台机器的出口 IP 被 Slack 限流，你想把这个账号的块间延迟从默认 1100ms 调到 2500ms 让消息发得慢一点。以前没有任何地方能改，只能改 `lib/channels/slack.js:54` 那行写死的默认值。

**四个字段是什么**：

| 字段 | 界面文案 | 类型 | 谁在读 | 留空会怎样 |
|---|---|---|---|---|
| `proxy` | 代理 | 文本 | 全部 12 个通道（`lib/bus.js:73` 与各 `channels/*.js`） | 用通道级「代理通道」的开关决定 |
| `maxMessageChars` | 分块长度 | 数字 | 全部 12 个通道 | 用该通道写死的上限 |
| `chunkDelayMs` | 块间延迟（毫秒） | 数字 | `lib/bus.js` 折进 `options.delayMs` | 用该通道的默认值 |
| `allowSelfSigned` | 允许自签证书 | 布尔（仅邮件） | `lib/channels/email.js` | 正常校验 TLS 证书 |

各通道写死的上限与默认延迟（留空时就是这些值）：

| 通道 | 分块长度上限 | 块间延迟默认 |
|---|---|---|
| telegram | 4096 | 350ms |
| feishu | 2000 | 350ms |
| qq | 1800 | 350ms |
| wechat | 2000 | 350ms |
| matrix | 30000 | 500ms |
| discord | 1900 | 600ms |
| slack | 3800 | 1100ms |
| dingtalk | 3000 | 1200ms |
| wecom | 600 | 1200ms |
| wecom_app | 600 | 1200ms |
| synology_chat | 2000 | 1500ms |
| email | 100000 | —（不分块，一封一封发） |

**为什么「允许自签证书」只给邮件**：`lib/channels/email.js:91` 与 `:141` 是 `tls: acc?.allowSelfSigned === true ? { rejectUnauthorized: false } : undefined` —— 全十二个通道里**只有邮件这一处**能关证书校验。其它通道走的是 `lib/http.js` 的 `fetch`，Node 的 `fetch` 不给单请求关证书校验的口子，加了开关也是假的，所以干脆不加。

**后端怎么处理这三种类型**（`lib/index.js`）：

- **掩码**（`maskedUserConfig`）：原来是一刀切 `String(item?.[field.key] ?? '')`。这对文本没问题，对数字是灾难 —— 用户把「分块长度」清空，`Number('')` 是 `0`，回写后这个账号的分块逻辑直接失效。现在按 `field.type` 三路分派：数字空值给 `''`、有值给 `Number`；布尔给真布尔（不是 `'true'` 字符串）。
- **合并**（`mergeUserConfig`）：数字字段遇到空值必须 `continue` —— 不沿用旧值。若沿用，用户把块间延迟从 2000 改回「用默认」就永远改不掉。数字还要求 `Number.isFinite(n) && n > 0` 才写（负数、NaN、0 一律丢弃）。布尔字段未传时只在旧值是 `true` 时才保留。
- **算不算「有账号」**（`hasCredential`）：判定时过滤掉 `group === 'advanced'` 的字段。否则用户在空行里随手勾了个「允许自签证书」，保存后列表里多出一个只有布尔值、没有任何凭据的空壳账号。

**账号级延迟怎么盖过全局**（`lib/bus.js` 的 `sendToTargets()`）：

```js
const ownDelay = Number(acc?.chunkDelayMs)
const effective = Number.isFinite(ownDelay) && ownDelay >= 0 ? { ...options, delayMs: ownDelay } : options
```

三条发送分支（0 个目标 / 1 个目标 / 多个目标扇出）**全部**用 `effective`，没有任何一条还在直接用 `options`。注意判据是 `>= 0` 不是 `> 0` —— 「块间延迟 = 0」是合法配置（不分块时立刻发），当成无效值会被静默忽略。

**界面怎么用**：点蓝色齿轮展开机器人卡 → 顶部第四个标签「高级」→ 三个字段（邮件多一个复选框）。**留空就是「用通道默认」**，页面上有一句提示写清这一点。填了数字要按回车或点别处触发保存（全界面自动保存，没有保存按钮）。

**刻意没做的三件事**：

1. **不做「全局默认高级字段」**：每个账号各填各的，不提供「所有通道统一用这个代理」的一键设置 —— 那本质上是通道级代理开关已经做的事，再加一层只会让优先级更难解释。
2. **不做「块间延迟按目标分别设」**：延迟是账号级（一个机器人一个值），不是「发给 A 用 300ms、发给 B 用 2s」。多目标扇出时逐条发送之间用的是同一个值。
3. **不给所有通道都加「允许自签证书」**：只有邮件能真生效，见上。

**新增的探针**：`scaffold/probe_advanced.mjs`（36 项断言，`ADVANCED_OK`），六段守：A 五个字段定义齐全且归入 `advanced` 组（9 项）；B 掩码按 `type` 分派、数字不返字符串、布尔 false 不算已填（4 项）；C 合并三路分派、清空能删、只填高级不算账号（5 项）；D `bus` 的块间延迟真覆盖三条分支（5 项）；E 前端第四页、数字输入转 `Number`、布尔用 checkbox（10 项）；F 两份 `THEME_CSS` 逐字节同源且没引入未定义的新样式类（3 项）。另外 `probe_tabs.mjs` 同步从 22 项扩到 29 项（断言标签栏变成四页、群晖三页、高级页不出现凭据字段、通用页不再出现高级字段）。

### 14.16 发文件：五个通道、四种协议、一条读盘纪律（v0.18.0）

**一句话**：同一个文件可以发到 Telegram / Slack / Discord / Matrix / 邮件，但四个平台的「怎么把字节传上去」完全不一样 —— 这一版把四套都实现了，而不是假装它们一样。

#### 为什么不能「一个 multipart 打天下」

十二个通道里能发附件的只有五个，而它们上传的方式各不相同：

| 通道 | 上传方式 | 关键细节 |
|---|---|---|
| Telegram | 单个 multipart 请求 | 图片走 `sendPhoto`（客户端渲染预览），其余走 `sendDocument`；`caption` 上限 1024 字符 |
| Discord | 单个 multipart 请求 | 必须带 `payload_json` 里的 `attachments: [{id:0, filename}]`，**少了这段描述文件会被丢弃但照样回 200** |
| Slack | 三段式 | `files.getUploadURLExternal` 拿一次性地址 → **裸字节** POST 那个地址（不是 multipart，也不能带 Authorization）→ `files.completeUploadExternal` 绑频道 |
| Matrix | 两段式 | 先 `/_matrix/media/v3/upload` 拿 `mxc://`，再发一条 `m.room.message`（`msgtype` 是 `m.file` 或 `m.image`） |
| 邮件 | nodemailer 附件 | 走 SMTP，与 HTTP 无关；自签证书要显式开 `allowSelfSigned` |

Slack 那条最容易踩：老教程里的 `files.upload` 已经停用，而且**第 1 步成功不代表发成了** —— 只有第 3 步回来能查到自己的 `file_id` 才算到了频道里。中途断掉时状态是「文件已上传但没进频道」，这里如实这么报，不谎称成功。

#### 三个必须做对的地方

**1. multipart 得手写，不能用全局 `FormData`。**
`lib/http.js` 有两条发送路径：直连走 `fetch`、走代理走「CONNECT 隧道 + `http.request`」。`FormData` 对象在后一条路上拿不到「已经序列化好的字节」。手写一份 `Buffer` 之后两条路吃的是同一份 body，不会出现「直连能发、走代理发出去是空文件」这种只有部分用户踩得到的分裂。这也是 `buildMultipart()` 存在的理由。

**2. 相对路径必须拒绝。**
插件的 cwd 是 DSH 的，不是用户以为的那个目录。`readForSend('报告.pdf')` 会静默读到一个同名但不相干的文件 —— 这比报错危险得多。所以 `lib/files.js` 第一道就拦 `path.isAbsolute`，报错里写清为什么。

**3. 文件只读一次盘。**
`bus.sendFile()` 在循环外调一次 `readForSend`，同一份 `Buffer` 交给所有通道和所有目标。由此得到一条通道实现必须遵守的约定：**`sendFile` 里不能就地改 `bytes`**（比如补文件头），否则第二个目标收到的文件是坏的。

#### 界面怎么用

机器人卡里凡支持附件的通道，「发条测试消息」旁边会多一个「发个文件」按钮。点了会弹一个输入框让你填**绝对路径** —— 路径不写进配置，因为它是「这一次要发什么」，不是账号级设置；写进 `config.json` 只会让配置里堆满一次性参数。结果单独一行显示（✓ / ✗），与发文字的结果互不覆盖 —— 一个账号可能「文字能发、文件发不了」（缺 `files:write` 这类 scope），混在一行会让用户以为既然文字通了文件当然也通。

#### 没做的三件事

1. **不给另外七个通道硬凑附件**：飞书 / 钉钉 / 企业微信 / QQ / 微信 / 群晖 / 飞书都没有现成的附件路径。选中它们时**逐条点名**「这个通道还不支持发文件（只有文字）。能发文件的是：telegram / slack / discord / matrix / email」，而不是静默跳过让用户以为发出去了。
2. **不做断点续传**：文件一次性读进内存再发。50 MB 以内没问题，再大的应该走网盘链接而不是这个工具。
3. **不做「发完自动删除」**：本插件不管理你的文件，只把它读出来发出去。

#### 新增的探针

`scaffold/probe_file.mjs`（88 项断言，`FILE_OK`），六段守：A 读盘的七种拒绝情形（相对路径 / 空 / 不存在 / 0 字节 / 目录）与 MIME 猜测（18 项）；B 平台上限表与超限拒绝（4 项）；C `buildMultipart` 的拼装正确性 —— boundary、中文文件名、文件部分自带 Content-Type、数组字段重复、null 跳过、结束 boundary（12 项）；D `bus.FILE_CHANNELS` 内容与「只选不支持通道」时的整体失败（12 项）；E 五个通道实现都有 `sendFile` 且各自的关键分支在（20 项，含逐个通道的存在性检查）；F 三条路由、工具注册、前端只从后端取清单（22 项）。另外顺带修了一个 v0.13.0 就存在的坑：`resolveChannels()` 以前只认数组，传逗号字符串会被静默当成「没指定」而回落到 `default_channels` —— 用户以为只发了飞书，实际群发到了所有默认通道。

### 14.17 WebSocket 长连接：Slack Socket Mode 与 Discord Gateway（v0.19.0）

到 v0.18.0 为止能收的四个通道里有三个是**长轮询**（Telegram / 微信 / Matrix）、一个是 SDK 封装的长连接（飞书 WSClient）。v0.19.0 补的这两个是**裸 WebSocket**：Slack 与 Discord。

#### 为什么说「裸」

飞书的连接由官方 SDK 的 `WSClient` 管，重连、握手、心跳都在 SDK 里。Slack 与 Discord 没有这一层 —— 平台给的就是一个 `wss://` 地址和一串 JSON 帧，握手/心跳/重连全得自己写。所以新增了 `lib/ws.js` 做两件最小的事：建连接、把帧读成字符串。

#### 本机实测过的三件事

| 实测 | 结果 | 影响 |
|---|---|---|
| `typeof globalThis.WebSocket` | `'function'`（Node 24 内置） | 看起来能直接用 |
| `new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json')` | **error 事件，message 为空** | 直连不通，且报错信息什么都没说 |
| `new undici.WebSocket(url, { dispatcher: new undici.ProxyAgent(p) })` | **收到 `{"op":10,"d":{"heartbeat_interval":41250}}`** | 走代理才通 |

关键结论：**Node 内置的 `WebSocket` 不接受 `dispatcher`**。它是全局对象，不给注入点 —— 这与 `lib/http.js` 里为什么要手写 CONNECT 隧道是同一个原因（v0.13.0 就踩过：`fetch` 在代理环境下也不吃注入的 agent）。所以 `lib/ws.js` 从 DSH profile 借 `undici`（与借飞书 SDK 同一套 `createRequire` 手法），自己造 `ProxyAgent`。借不到时返回 `null` + 中文原因，不抛 `ERR_MODULE_NOT_FOUND`。

#### Slack Socket Mode 的协议要点

```text
POST https://slack.com/api/apps.connections.open    要 App Token（xapp-）
  -> { ok: true, url: 'wss://wss-primary.slack.com/link/?ticket=...' }
连上 wss 后：
  <- { type: 'hello', connection_info: { app_id: 'A123' } }
  <- { type: 'events_api', envelope_id: 'e1', payload: { type:'event_callback', event:{...} } }
  -> { envelope_id: 'e1' }        必须回，且要快
```


三件必须做对：

1. **两把钥匙不能混**。发消息用 Bot Token（`xoxb-`），Socket Mode 用 App Token（`xapp-`，Basic Information → App-Level Tokens，scopes 勾 `connections:write`）。拿 `xoxb-` 去调 `apps.connections.open` 会回 `not_allowed_token_type`，这句报错完全看不出是「钥匙用错了」。
2. **每条带 `envelope_id` 的帧立刻 ack**。Slack 等不到 ack 会重投同一个事件，用户就看到重复消息。代码里 ack 写在业务分支**之前** —— 探针 G12 就是守这个顺序（`indexOf('envelope_id') < indexOf('events_api')`）。
3. **只认自己 app 的事件**。同一个 app 可能被多个 workspace 安装，帧里的 `payload.api_app_id` 要等于 hello 里拿到的 `app_id`，否则会把别人的消息收进自己的收件箱。

正文还原也做了：Slack 传的是 `a &amp; b`、`<@U123>`、`<#C1|general>` 这种，`slackTextOf()` 把实体还原并把提及/频道占位换成 `U123` / `general` 的短形式（拿不到显示名 —— 查名字要再调 `users.info`，为一条只读记事本消息多打一次 API 不划算）。

#### Discord Gateway 的协议要点

```text
GET https://discord.com/api/v10/gateway/bot      Bot Token
  -> { url: 'wss://gateway.discord.gg' }
连上 wss 后：
  <- { op: 10, d: { heartbeat_interval: 41250 } }    hello
  -> { op: 2, d: { token, intents, properties } }    identify
  -> { op: 1, d: <sequence> }                        心跳（按 interval 定时）
  <- { op: 11 }                                      心跳回执
  <- { op: 0, t: 'MESSAGE_CREATE', s: 7, d: {...} }  消息
```


三件必须做对：

1. **intents 里必须有 `MESSAGE_CONTENT`（`1 << 15`）**。不带的后果极其难查：连接正常、心跳正常、`MESSAGE_CREATE` 也收得到，只是 `d.content` 是空串。它会伪装成「代码没问题，平台没给内容」。
2. **心跳没被确认要主动断开**。收到 `op:10` 后按 `heartbeat_interval` 起定时器，每轮先检查上轮是否收到 `op:11`；没收到的连接是「半死」状态 —— 不报错、不收消息、一直挂着。这时主动 `close` 让外层退避重连，比等平台踢掉更快恢复。
3. **过滤机器人消息**（`d.author.bot === true`）。本插件自己也会往 Discord 发消息，不过滤就会把自己推的内容收回收件箱，形成循环。

这里**不做 resume**（`op:6` + `session_id` + `sequence` 续接）：收件箱是记事本，断线重连丢几条不致命，而 resume 要维护一整套会话状态，代价与收益不成比例。断线统一走「整条重连 + 指数退避（2s→4s→…→60s 上限）」。

#### 现在能收 / 收不了的全表

| 通道 | 收法 | 是否需要公网地址 | 要什么凭据 |
|---|---|---|---|
| Telegram | `getUpdates` 长轮询 | 否 | Bot Token |
| 微信 | `ilink/bot/getupdates` 长轮询 | 否 | token |
| 飞书 | 官方 `WSClient` | 否 | App ID + App Secret |
| Matrix | `/_matrix/client/v3/sync` 长轮询 | 否 | Homeserver + Access Token |
| **Slack** | **Socket Mode（`wss`）** | 否 | **App Token（`xapp-`）** |
| **Discord** | **Gateway（`wss`）** | 否 | **Bot Token** |

收不了的六个（页面上逐条写原因，不假装支持）：**QQ**（要 `tencent-connect/qqbot-nodejs`，profile 里只有 connector）、**群晖 Chat**（只有传出回调，宿主只听 `127.0.0.1`）、**钉钉**（群机器人纯发送 webhook）、**企业微信**（同上）、**企业微信自建应用**（要配接收消息服务器回调）、**邮件**（接收要 IMAP，与推送语义不同）。

#### 界面上的变化

接收页里每个通道后面标出收法：`长轮询` / `WSClient 长连接` / `Socket Mode` / `Gateway 长连接`。顶部那句从「两种拉法」改成「三种接法」，并补一句：**三种都不需要公网地址，但都要求本机能出网**（Telegram / Discord 通常要走代理，机器人在「高级」页单独填代理）。

Slack 的机器人卡多了一个字段「App Token（接收才要）」—— 只发消息的人不用填。文案里写清了它从哪拿（Basic Information → App-Level Tokens），因为 Slack 后台把 Bot Token 和 App Token 放在两个不同页面，第一次配的人十有八九会拿错。

#### 新增的探针

`scaffold/probe_receive.mjs` 从 62 项扩到 **91 项**，新增的 G 段 29 项守：两个 worker 都是 `longconn` 型（G1/G2）、`slackTextOf` 的四种输入（G3-G6）、缺 App Token / 拿错前缀 / 缺 Bot Token 三种本地拒绝（G7-G9）、ack 顺序（G10-G12）、`events_api` 与 `api_app_id` 过滤（G13/G14）、机器人消息过滤（G15/G20）、Discord 的 `gateway/bot` 与 intents 位（G16/G17）、hello 与心跳确认（G18/G19）、`lib/ws.js` 的 `undici` 借用、`wss` 校验、直连/代理两种模式、`eventText` 兼容性、`closeSocket` 容错（G21-G26）。


### 14.18 消息按钮：一种写法，三家翻译（v0.20.0）

#### 为什么要中间这一层

三家的按钮格式毫无交集：

| 平台 | 字段 | 形状 |
| --- | --- | --- |
| Telegram | `reply_markup.inline_keyboard` | `[[{text, callback_data}]]`，二维行 |
| Slack | `blocks[]` | `[{type:"actions", elements:[{type:"button", text:{type:"plain_text",text}, action_id, value}]}]` |
| Discord | `components[]` | `[{type:1, components:[{type:2, style:2, label, custom_id}]}]` |

如果让调用方直写任意一家，那「同一句话发三个通道」就不可能了 —— 你得为三个通道各准备一份按钮 JSON，还得记住 15 与 2 这些魔法数字。所以 v0.20.0 加了一层 `lib/buttons.js`：**调用方只写一种通道无关的形状**，翻译由它统一做。

#### 调用方写什么

一维数组（自动每 5 个折行）：

```json
[{"text":"通过","callback":"ok"},{"text":"拒绝","callback":"no"}]
```

二维数组（显式分行）：

```json
[[{"text":"通过","callback":"ok"}], [{"text":"详情","callback":"more"}]]
```

也接受 `label` / `value` / `custom_id` 作为 `text` / `callback` 的别名 —— 从三家文档抄过来的字段名直接能用，不用手改。

#### 三条硬约束（都是按最严的那家定的）

| 约束 | 值 | 为什么是这个值 |
| --- | --- | --- |
| callback 字节数 | **64** | Telegram 的 `CALLBACK_DATA_MAX_BYTES`。Slack / Discord 都更宽松，按最严的验三家才都能过 |
| 按钮总数 | **25** | Slack 单个 `actions` block 的上限 |
| 每行个数 | **5** | Discord 一行 action row 的上限 |

`"中".repeat(22)` 是 66 字节（UTF-8 一个中文字 3 字节）会被拒；21 个才是 63 字节通过。**按字符数验是错的** —— 会让 Telegram 侧 400 而 Slack / Discord 侧通过，同一份配置「有的通道能发有的不能」，排查起来极难。

#### 九个通道为什么不能带按钮

| 通道 | 原因 |
| --- | --- |
| 飞书 | 要互动卡片（interactive card），不是消息上挂按钮 |
| QQ | `keyboard` 字段，群与频道的格式还不同 |
| 微信 | iLink 没有按钮消息类型 |
| 钉钉 | 只能 markdown / text / link |
| 企业微信 | 只能 markdown / text |
| 企业微信自建应用 | 要 templates / card，且需先在后台申请模板 |
| 群晖 Chat | webhook 只收文本与附件 |
| Matrix | 要自定义 HTML / 组件，各家客户端支持不一致 |
| 邮件 | 邮件不能有按钮，只能写链接 |

这些通道**照常把文字发出去**，只在结果里点名「该通道不支持按钮，按钮已丢弃（原因）」。理由：按钮是**通道能力**，不是**消息属性**。如果按「消息属性」处理，那条消息发到 12 个通道就会因为 9 个不支持而整批失败 —— 群发功能直接废掉。

#### 按钮只挂最后一块

`telegram.js` / `slack.js` / `discord.js` 三个 `send()` 里都有同一句判据：`i === blocks.length - 1`。

长文本会被切成多块。如果每块都挂按钮，用户按一下「通过」，客户端会认为那是 N 个不同按钮；用户可能误以为「每块都要单独确认」而按 N 次，副作用就发生 N 次。

#### 空数组的语义差别（容易踩）

| 输入 | `parseButtons` 返回 | 调用方该做什么 |
| --- | --- | --- |
| `undefined` / `''` / `[]` | `{ok:true, rows:[]}` | **不发** `reply_markup` —— 消息原样发 |
| 显式 `toTelegram([])` | `{inline_keyboard: []}` | 发送它 —— 这才**清掉**已有的键盘 |

Telegram 的注释写得很明白：*An empty inline_keyboard is accepted: that is how Telegram removes a keyboard*。把「没按钮」和「清键盘」混成一种，用户会发现「加了按钮之后再发不带按钮的消息，旧键盘还在」。

#### 界面怎么用

试发页（左侧「试发一条」）多一个输入框：**按钮（可选，JSON）**，粘贴上面那种 JSON 即可。下方提示会显示当前**哪几个通道支持按钮**（从 `GET /buttons/channels` 拿，不写死）。

点「只看分块（不发）」也会校验按钮格式 —— 坏格式在这一步就报「按钮「X」没有 callback」，不用等真发出去 400。返回体里有 `buttons.acceptedChannels`（谁会带上）与 `buttons.droppedChannels`（谁会丢弃）。

#### 工具参数

工具 `push_hub_send` 的 `buttons` 参数收 JSON 字符串，例如两个按钮（确认 / 回滚），`callback` 分别写 `ok` 与 `rollback`。

#### 刻意没做的三件事

1. **不做回调接收**。按钮按下后 Telegram 发 `callback_query`、Slack 发 `block_actions`、Discord 发 `INTERACTION_CREATE`，三家都要额外订阅与 `answerCallbackQuery` 之类的应答。v0.20.0 只做「发出去」，按下后**没有程序在听** —— 需要真处理的话，用 Telegram 的 `getUpdates`（接收页已支持 `message`，要扩 `callback_query`）。
2. **不做 disabled 按钮**。Bot API 10.3 有 `{text, disabled:{}}` 且**不许带 callback_data**，三家语义不一致，先不统一。
3. **不做按钮去重 / 防重放**。dsh-im 的 `approval-card.mjs` 做了「首次点击原子抢占 + 版本化命名空间（`ap1`）」，那是审批卡场景必需的；本插件只发出不接收，没有这条链路的落点。

#### 探针

`scaffold/probe_buttons.mjs`，**52 项断言**，分五段：A 解析与校验 14 项 / B 三家翻译 12 项 / C 能力表与原因 8 项 / D 三个通道真的接了 12 项 / E 与 dsh-im 的取舍 6 项。跑法：`node scaffold/probe_buttons.mjs`，通过时打印 `BUTTONS_OK  52 项断言全通过`。
### 14.19 QQ 接收：官方网关的裸协议（v0.21.0）

#### 为什么之前说「QQ 收不了」

v0.16.0 把 QQ 列进 `NOT_RECEIVABLE_REASON` 时写的是：*QQ 官方是 WebSocket 网关，要用 `@tencent-connect/qqbot-nodejs`，profile 里只装了 connector*。理由是实测两件事：

```
@larksuiteoapi/node-sdk      → OK（飞书能用就是靠它）
@tencent-connect/qqbot-nodejs → ERR_PACKAGE_PATH_NOT_EXPORTED（No "exports" main defined）
@tencent-connect/qqbot-connector → exports is not defined in ES module scope
```

**那个判断错在「没有 SDK 就收不了」**。QQ 的网关是**公开的裸 WebSocket 协议**，SDK 只是把它包了一层；只要知道 `op` 码与地址怎么拿，用本插件自己的 `lib/ws.js` 就能连。这和飞书不一样 —— 飞书的事件是加密信封（`encrypt` + `verification_token`），必须用官方 SDK 解，所以飞书只能借 profile 的依赖。

#### 三个必须做对的点

| 点 | 怎么做 | 做错了会怎样 |
|---|---|---|
| 两个地方都要 `QQBot ` 前缀 | `GET /gateway` 的 `Authorization`、`op:2 identify` 的 `d.token` 都写 `QQBot <accessToken>` | 裸 token 直接 401，报错只说连不上，看不出原因 |
| intents 必须含 `GROUP_AND_C2C_EVENT`（`1 << 25`） | `const QQ_INTENTS = 1 << 25` | **不报错**，连接与心跳全正常，就是群里 @ 机器人的消息一条都收不到 |
| 拿 token 复用 `qq.appToken()` | `const got = await qq.appToken(acc, proxy)` | 另写一份就会出现「发得出去收不进来」，两处还会各自缓存、各自过期 |

第三条尤其重要：`lib/channels/qq.js` 里 `appToken()`（`:46`）已经在做取票与过期，`send()`（`:61`）与 `probe()`（`:104`）都走它。接收端再写一份就是三处逻辑。

#### 收哪两种事件

| 事件 | 什么时候来 | `from` 取哪个字段 | 为什么 |
|---|---|---|---|
| `GROUP_AT_MESSAGE_CREATE` | 群里 @ 机器人 | `d.group_openid` | 用户要看「哪个群发来的」，不是谁 @ 的 |
| `C2C_MESSAGE_CREATE` | 单聊 | `d.author.user_openid` | 单聊没有群，只能取发送者 |

两种事件的正文都是 `d.content`（纯字符串，不带 @ 占位）。`d.timestamp` 是 RFC3339，统一走 `qqTime()` 转 ISO；`Date.parse` 拿不准就返回 `undefined`，`inbox.appendMessage` 会自己填当前时间，绝不写 `Invalid Date`。

#### 与 Discord 的一处对照

两家都是 `op:10` hello → 起心跳 → `op:2 identify`，代码形状几乎一样，但**两个 intent 的失效表现都是「静默收不到」**：Discord 缺 `MESSAGE_CONTENT` 是 `content` 恒为空（有事件但正文空），QQ 缺 `GROUP_AND_C2C_EVENT` 是事件根本不来。两者的排查手感完全不同 —— 前者至少能看到事件在来，后者只能靠「群里 @ 了但收件箱空着」。

#### 不走 resume 的理由

Discord 与 QQ 都支持 `op:6 resume`（带 `session_id` 与 `sequence` 续传），本插件**不做**。收件箱是记事本不是审计日志，断几条不致命；而 resume 要维护两个状态并处理「resume 失败要退回 identify」，复杂度不值得。断了就整条重连，退避从 2 秒起翻倍，上限 60 秒。

#### 现在还剩几个收不了

5 个：群晖（只有「传出 URL」回调，宿主只听 `127.0.0.1`）、钉钉（纯发送 webhook，没有读取接口）、企业微信（同上）、企业微信自建应用（要配「接收消息服务器」回调）、邮件（要 IMAP，与「推送」语义不同）。接收页里逐条写原因，不假装支持。

#### 探针

`scaffold/probe_receive.mjs` 从 91 项扩到 **100 项**。新增的都是 QQ：G27 worker 是长连接型 / G28 没 appId 在本地就拒 / G29 假凭据返回失败不抛 / G30 源码含 `api.sgroup.qq.com/gateway` / G31 intents 含 `1 << 25` 与 `GROUP_AND_C2C_EVENT` / G32 两种事件都收 / G33 有 `"QQBot " + got.token` / G34 有 `qqTime`。B 段同步加 B7d（qq 可收）并把原因表门槛从 6 改成 5。

### 14.20 按钮回调接收：三家各自的应答义务（v0.22.0）

#### 一句话

v0.20.0 只做了「发按钮」，按下去之后平台推回来的东西**没有任何人接**。这一版把三家的回调接进同一个收件箱。

#### 为什么这是必须补的洞

| 通道 | v0.20.0 之后的实际状态 |
|---|---|
| Telegram | `allowed_updates` 只订阅 `message`，`callback_query` 根本不下发。按钮按下去之后那条 update **一直留在队列里**，`offset` 推不动 —— 后果不是「回调丢了」，而是**之后所有消息都收不到**，链路静默死掉 |
| Slack | `block_actions` 帧照常推到 Socket Mode 连接，但没有 `action.value` 的解析分支，帧被当成「不认识的事件」忽略（不报错） |
| Discord | `INTERACTION_CREATE` 照常推到 Gateway，同样被忽略。**顺带还有个更糟的后果**：Discord 要求 3 秒内应答，不应答的话客户端显示「交互失败」——用户以为插件坏了 |

三家的共同点是**都不报错**。Telegram 是整条接收链路死掉，Slack 与 Discord 是回调静默丢失 + Discord 还多一个客户端可见的失败提示。

#### 三家的接法

| 通道 | 订阅/事件 | 回调值在哪 | 应答义务 |
|---|---|---|---|
| Telegram | `allowed_updates: ['message','callback_query']` | `cq.data` | `POST answerCallbackQuery`（`callback_query_id`），**必须在记账之前** |
| Slack | 帧内 `payload.type === 'event_callback'` 且 `event.type === 'block_actions'` | `actions[0].value` | 无需额外应答（Socket Mode 的 `envelope_id` ack 已在 v0.19.0 做掉） |
| Discord | `packet.t === 'INTERACTION_CREATE'` 且 `d.type === 3` | `d.data.custom_id` | `POST /interactions/{id}/{token}/callback` body `{ type: 6 }`，**3 秒内** |

Discord 的 `type` 必须是 `3`（`MESSAGE_COMPONENT`）。`2` 是 `APPLICATION_COMMAND`（斜杠命令）、`5` 是 `MODAL_SUBMIT`（表单提交），都不是按钮，跳过。

#### 收件箱怎么区分

`inbox.json` 的每条记录多了可选的 `kind` 字段：

```json
{
  "id": "telegram-m8x2k1-a3f9c2",
  "channel": "telegram",
  "account": "主号",
  "kind": "callback",
  "at": "2026-11-17T11:20:33.000Z",
  "from": "6317****92",
  "text": "ok",
  "raw": { "callbackId": "4382...", "data": "ok", "messageId": 512, "userId": 6317****92, "userName": "<你>" }
}
```

- 普通消息**没有** `kind` 这个键（不是 `kind: "message"`），老文件不用迁移。
- 界面上回调条目左侧一条蓝边、右上角一枚「按钮按下」标签 —— 因为回调的「正文」是 `ok` / `yes` 这种业务值，不是人说的话，混在消息里会被误读。
- `GET /receive/inbox/callbacks` 与 `push_hub_receive action=callbacks` 只返回 `kind === 'callback'` 的条目。

#### 刻意没做：回调不触发任何动作

这一版**只把回调落进收件箱**，不会因为按下 `ok` 就去执行什么、也不会自动改消息（`editMessageReplyMarkup` 收键盘）。理由：一旦插件自己按回调做事，就得回答「同一回调按两次怎么办」「按的人是不是发起人」「按完键盘要不要收」—— 那是 dsh-im `approval-card.mjs` 那套审批卡的复杂度（它有一条完整的四步处理顺序：先应答 → 校验 actor → 同步占位防重 → 提交后改消息收键盘）。本插件只负责「把回调送到你手上」，要不要据此做事由调用方决定。

#### 探针

`scaffold/probe_receive.mjs` 从 100 项扩到 **112 项**，新增 H 段 12 项：H1 订阅 `callback_query` / H2 有 `answerCallbackQuery` / H3 应答在记账之前 / H4 `kind='callback'` 落盘 / H5 Slack 认 `block_actions` / H6 取 `action.value` / H7 Slack 回调也标 `kind` / H8 Discord 认 `INTERACTION_CREATE` / H9 只认 `type=3` / H10 回 `{ type: 6 }` / H11 `kind` 只在 callback 时写 / H12 `deliver` 透传 `kind`。

### 14.21 邮件接收：两套服务器与一个会漏信的写法（v0.23.0）

#### 一句话

邮件通道从"只能发"变成"能发也能收"，接收方向到 **8 个通道**。用 profile 里已装的 `imapflow` + `mailparser`，零新增依赖。

#### 为什么之前不做，这次做了

v0.15.0 到 v0.22.0 一直把邮件列在"收不了"里，理由写的是"要 IMAP，与推送语义不同"。这个理由经不起推敲：

- **IMAP 同样是本机主动连出去**，和 Telegram 的 `getUpdates`、Matrix 的 `/sync` 没有本质区别 —— 都不需要公网地址、都不需要端口映射。之前把所有"要额外协议"的东西都归到"收不了"，是把"宿主没有公网地址"这个真限制扩大解释了。
- **"发出去的通知有人回了邮件"恰恰是推送中枢最该知道的事**。日报发出去、老板直接回一句"这个数不对"，这条回复比任何一条群消息都重要。

#### 收发是两套服务器

这是本版加字段的直接原因：

| | 发信 | 收信 |
|---|---|---|
| 协议 | SMTP | IMAP |
| QQ 邮箱 | `smtp.qq.com:465` | `imap.qq.com:993` |
| 163 邮箱 | `smtp.163.com:465` | `imap.163.com:993` |
| Gmail | `smtp.gmail.com:587` | `imap.gmail.com:993` |

**域名和端口都不一样**，不是"同一个地址换个端口"。所以 `imapHost` 与 `imapPort` 是两个独立字段，且都是可选的 —— 只发信的用户一个字都不用填。

#### 那个会漏信的写法

这是本节存在的理由。想当然的写法是这样：

```js
// ❌ 别这么写
for await (const msg of client.fetch({ seen: false }, { source: true })) {
  if (fetched >= 20) break
  // …处理
}
```

看起来比"先 search 再逐封取"省一次请求。但它有个**静默丢信**的后果：

1. 取到第 20 封时 `break`，游标（`acc.__imapUid`）已经推到了第 20 封的 UID。
2. 下一轮查询条件是 `uid > 游标` —— **第 21 封之后的未读全部落在查询范围外**。
3. 更糟的是：IMAP 在 `fetch` 时默认会把 `Seen` 标记打上，所以那些信在邮箱里也不再是"未读"了。
4. 结果是：**它们既不在收件箱里，也不在未读列表里**，用户永远不会知道有这些信。

正确写法是先问"有哪些信"，再按名单逐封取：

```js
const uidList = since > 0
  ? await client.search({ uid: String(since + 1) + ':*' }, { uid: true })
  : await client.search({ seen: false }, { uid: true })
// 没有游标时取最新的 20 封 —— 第一次接入想看的是刚到的那封，不是三年前的
const picked = (since > 0 ? uidList : uidList.slice(-EMAIL_BATCH)).slice(0, EMAIL_BATCH)
for (const uid of picked) {
  const msg = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true })
  // …处理
}
```

两处细节：

- **有游标时取最老的 20 封**（`slice(0, EMAIL_BATCH)`）—— 顺着时间往前推，不跳号，剩下的下一轮接着来。
- **没有游标时取最新的 20 封**（`slice(-EMAIL_BATCH)`）—— 首次接入的语义与追进度完全不同。

#### 其余四条实现要点

| 要点 | 做法 | 不这么做会怎样 |
|---|---|---|
| 只查未读（无游标时） | `{ seen: false }` | 第一次接入把几千封历史灌进收件箱，上限 500 条把新信挤掉 |
| 加 INBOX 锁 | `await client.getMailboxLock('INBOX')` | 同一账号两个循环并发取信会撞，IMAP 直接断连 |
| 主题拼进正文 | `'【' + subject + '】' + text` | 收件箱里一堆没有上下文的正文，看不出是哪件事的回复 |
| 自签证书共用开关 | `allowSelfSigned === true` → `tls.rejectUnauthorized = false` | 同一台自建服务器的信发得出去收不进来 |

#### 轮询间隔为什么是 30 秒

邮件不是即时通讯，30 秒一次的短连接对任何邮箱都不算负担（`EMAIL_POLL_MS = 30_000`），而且"每次开一条连接 → 查 → 关掉"比 IMAP `IDLE` 简单得多：IDLE 要在同一条连接上等服务器推，断线重连、`NOOP` 保活、读信时不能并发取信这些细节都得自己兜。

一轮取到东西时**不等 30 秒**，立刻再来一轮（可能还有下一批）；取不到才睡。

#### 现在还剩几个收不了

写这一节时是 4 个（群晖 / 钉钉 / 企业微信 / 企业微信自建应用）。**v0.24.0 之后只剩 2 个** —— 钉钉与企业微信都另有长连接型接收通道（钉钉 Stream、企业微信智能机器人），详见 [14.22](#1422-钉钉与企业微信收发是两套凭据v0240)。现在收不了的只有群晖（只有「传出 URL」回调，宿主只听 `127.0.0.1`）与企业微信群机器人（纯发送 webhook，要收得换智能机器人，那是另一套凭据）。

#### 探针

`scaffold/probe_receive.mjs` 从 112 项扩到 **131 项**，新增 I 段 17 项 + B7e：I1 轮询型 worker / I2 没填 IMAP 直接拒且说清不是 SMTP / I3 缺授权码拒 / I4 借 imapflow 与 mailparser / I5 两个依赖都有缓存与错误兜底 / I6 锁 INBOX / I7 UID 游标 / I8 无游标取最新 20 封 / I9 simpleParser / I10 两个常量 / I11–I13 `emailTextOf` 三种输入 / I14 主题拼正文 / I15 原因表无 email / I16 自签证书开关 / I17 先 search 再 fetchOne / I18 逐封再判 uid。

### 14.22 钉钉与企业微信：收发是两套凭据（v0.24.0）

#### 那句话只是半个事实

v0.15.0 到 v0.23.0 一直把钉钉与企业微信列在「收不了」，理由写的是：

> 钉钉群机器人是纯发送 webhook，没有读取接口。
> 企业微信群机器人是纯发送 webhook，没有读取接口。

**这句话本身没错。** 群机器人的 webhook 确实只能往那个群发消息，没有读的接口。但它是半个事实 —— 两家都另有长连接型的收消息通道，只是不叫「群机器人」：

| 通道 | 发送用什么 | 接收用什么 | 是同一套凭据吗 |
|---|---|---|---|
| 钉钉 | 群机器人 `webhookUrl` + 加签 `secret` | **Stream 模式**：企业内部应用的 `AppKey` / `AppSecret` | 不是 |
| 企业微信 | 群机器人 `webhookUrl` | **智能机器人 WebSocket**：`botId` / `secret` | 不是 |
| 企业微信（自建应用发送） | `corpId` / `corpSecret` / `agentId` | 仍是智能机器人的 `botId` / `secret` | 不是 |

所以界面上新加的四个字段全都标了「（接收才要）」—— 只发消息的人一个字都不用填，看到「接收才要」就知道与自己无关。

#### 两条路怎么走

**钉钉 Stream 模式**：

```js
const { DWClient, TOPIC_ROBOT } = require('dingtalk-stream')
const client = new DWClient({ clientId, clientSecret, endpoint: 'https://api.dingtalk.com', autoReconnect: false, keepAlive: true })
client.registerCallbackListener(TOPIC_ROBOT, (response) => {
  // 先应答，不应答钉钉会重投同一条消息
  client.socketCallBackResponse(response.headers.messageId, { success: true })
  // 再处理
  const message = JSON.parse(response.data)
})
client.connect()
```

**企业微信智能机器人**：

```js
const { WSClient } = require('@wecom/aibot-node-sdk')
const client = new WSClient({ botId, secret, maxReconnectAttempts: 10 })
client.on('message', (frame) => {
  const body = frame.body
  if (body.msgtype === 'text') handle(body.text.content)
})
client.connect()
```

两条都是 `wss` 长连接、都由**本机发起**，所以同样不需要公网地址、不需要端口映射 —— 这正是它们能进「接收」这一栏的原因。

#### 三个必须做对的点

| 点 | 做法 | 不这么做会怎样 |
|---|---|---|
| 收发凭据分开 | 界面上标「（接收才要）」，只发不填 | 用户拿群机器人 webhook 去「接收」，一直报错却不知道为什么 |
| 钉钉先应答再处理 | `socketCallBackResponse` 在 `onMessage` 之前 | 钉钉重投同一条 → 用户收到两条一样的回复 |
| 话题名用常量 | `TOPIC_ROBOT`（`/v1.0/im/bot/messages/get`） | 手写字符串拼错，订阅不上，一条都收不到且不报错 |

#### 现在能收 / 收不了

能收 **10 个**：telegram / wechat / feishu / matrix / slack / discord / qq / email / **dingtalk** / **wecom_app**。

收不了 **2 个**：

| 通道 | 为什么 |
|---|---|
| `synology_chat` | 群晖 Chat 只有「传出 URL」回调，NAS 要主动连进来，而 DSH 宿主只监听 `127.0.0.1:3082` |
| `wecom` | 企业微信群机器人是纯发送 webhook。同一个通道名字下其实有另一条路（智能机器人），但那需要另一套凭据，所以走的是 `wecom_app` 这条 |

#### 刻意没做

| 没做 | 理由 |
|---|---|
| 钉钉的卡片回调（`TOPIC_CARD`） | 那是互动卡片的按钮回调，本插件还没做钉钉侧的卡片发送 |
| 企业微信的模板卡片 | 要申请模板、填模板 ID，是另一条独立链路 |
| 群消息 @ 过滤 | 群里机器人被 @ 才推消息是平台侧行为，本插件不额外过滤，收到什么记什么 |
| 自己写重连 | 两个 SDK 都自带重连；本插件只在外层 `runLoop` 兜一层指数退避（2s 起、60s 封顶） |

#### 探针

`scaffold/probe_receive.mjs` 从 131 项扩到 **152 项**，新增 J 段 21 项 + B7f / B7g：J1 两个 worker 都是长连接型 / J2 钉钉没填 AppKey 时拒绝且说清群机器人收不了 / J3 企微没填 BotId 时拒绝且说清自建应用凭据收不了 / J4 借两个 SDK 不新增依赖 / J5 两个依赖都有缓存与错误兜底 / J6 钉钉靠 `registerCallbackListener` 注册话题 / J7 **先应答再处理**（用 `lastIndexOf` 定位，否则会抓到函数定义处假红）/ J8 话题用 `TOPIC_ROBOT` / J9 企微靠 `WSClient.on('message')` / J10 群消息按 `chatid` 归会话 / J11–J15 两个文本提取函数的输入边界 / J16–J17 企微 from 的群聊与单聊两种取法 / J18 原因表里不再有这两个 / J19 群机器人 `wecom` 仍收不了且点明要换智能机器人。

同时 B 段把「原因表门槛」从 `>= 4` 改成 `>= 2`，并把 B7c 从「逐个点名四个通道」改成 `RECEIVABLE.every(...) === ''` —— 后面每加一个能收的通道都不用再回来改这一行。

### 14.23 回复某条消息：五家一种写法（v0.25.0）

#### 一句话

收件箱里看到一条消息，想回它一句 —— 现在能在五个通道上真正做到「挂在原消息下面」，另外七个照常发新消息并在结果里点名。

#### 为什么要做

v0.18.0 做完接收之后，闭环差最后一段：**看得到、回不了。** 用户点开「接收消息」页，看到 Telegram 里有人问了一句，想回，只能当新消息发出去 —— 在对方的聊天窗口里，那是一句孤立的话，上面什么都不挂，上下文完全断了。而 Telegram / Slack / Discord / Matrix / QQ 五家都原生支持「回复」，push-hub 却一个都没接。

选 reply 而不是 reaction / typing，是因为 reply 对这条闭环是必需的，另外几个是锦上添花：在 dsh-im 里 grep 得 reaction 散在 10 个通道、typing 在 9 个、editMessage 只在 discord/telegram，但 push-hub 侧 grep `reply` / `thread_ts` / `reply_markup` 时**只命中了 buttons 的 `reply_markup`，真正的引用回复是零实现**。

#### 五家写法毫无交集

| 通道 | 字段 | 必须注意 |
|---|---|---|
| Telegram | `reply_parameters: { message_id, allow_sending_without_reply: true }` | 少了 `allow_sending_without_reply`，被引用那条被删了整条发送就失败 |
| Slack | `thread_ts` | **不是引用，是开线程** —— 消息挂在原消息下面的回复串里，频道主视图看不到 |
| Discord | `message_reference: { message_id, channel_id, fail_if_not_exists: false }` | 必须带 `channel_id`；`fail_if_not_exists` 不设 `false` 时被引用消息没了会 400 |
| Matrix | `content.m.relates_to['m.in_reply_to'].event_id` | **正文要自己加 `> 原文` 前缀** —— 客户端不一定会渲染引用关系 |
| QQ | `msg_id` + `msg_seq` | 被动回复有窗口期，超时发不出去 |

所以又做了一层中间表示 `lib/reply.js`，与 `lib/buttons.js` 完全同构：

```js
export function replyFor(channel, messageId, extra = {})  // 空 ID 或不认识返回 null
export function normalizeReplyId(input)                   // {ok:true,id} 或 {ok:false,detail}
export function describeReply(id)                         // '不引用' / '引用 12345678…ghij'
export function matrixQuotePrefix(text, messageId)        // Matrix 专用的 > 原文 前缀
export const REPLY_CHANNELS                               // 五个能回复的
export const NO_REPLY_REASON                              // 七个不支持的，逐条中文原因
```

通道实现里只剩一行：

```js
...(replyTo !== '' && last ? replyFor('telegram', replyTo) : {})
```

#### 三个必须做对的点

| 点 | 做法 | 不这么做会怎样 |
|---|---|---|
| 只挂最后一块 | 三处都判 `last`（`i === blocks.length - 1`） | 切成 3 块的长消息带 3 个 `reply_parameters`，同一句被引用三遍 |
| Matrix 正文自带前缀 | `matrixQuotePrefix` 拼 `> 原文` | 引用关系在 `m.relates_to` 里，客户端不渲染时看着就是一句平白的话 |
| 空 ID 不算不支持 | `bus` 里 `undefined` / `null` / 空白串三个都判 | 每次普通发送都挂一句「该通道不支持引用回复」，日志全是噪音 |

#### 为什么不下沉到通道、而要在 bus 层降级

与按钮同一个理由：**回复是「通道能力」不是「消息属性」**。

如果按消息属性处理（「这条消息带 `replyTo`，所以只发支持回复的通道」），那么用户一旦群发到 12 个通道，就会因为 7 个不支持而**整批失败** —— 群发功能直接废掉。所以 `bus.js` 的处理是：不支持的那 7 个照常把文字发出去，只在 `detail` 里挂一句「该通道不支持引用回复，这句是当新消息发的（原因）」，`ok` 仍是 `true`。

#### 怎么用

**界面**：试发页多了「回复某条消息（可选，填消息 ID）」输入框，下面一行提示会列出当前哪些通道支持（从 `GET /reply/channels` 取，不是前端写死）。留空 = 当新消息发。

**接口**：`POST /send` 与 `POST /test` 都接受 `replyTo`（也接受 `reply_to` 这种写法）：

```json
{
  "text": "收到，我这就看",
  "replyTo": "12345",
  "channels": ["telegram", "slack"]
}
```

**工具**：`push_hub_send` 的参数叫 `reply_to`（下划线，与 `dry_run` 一致）。

**伪发送先验**：`dry_run: true` 时返回体里有 `replyTo.droppedChannels`，写了 `replyTo` 却群发到 12 个通道时，被丢弃的 7 个会在这里点名 —— 不用真发就知道会丢。

#### 刻意没做的三件事

| 没做 | 理由 |
|---|---|
| 从收件箱一键回复 | 收件箱是只读展示，没有任何「对某条消息发起发送」的交互；要做需要把「收件箱里的 raw 字段」与「发送时的 replyTo」打通，还要处理「不同通道的 ID 格式不同」这件事 |
| 飞书 / 企业微信的引用 | 飞书要走 `/messages/:id/reply` 端点（不是发消息时加字段），企业微信自建应用的 `quote` 参数也另有一套语义 —— 都不是加个字段的事 |
| 邮件 `In-Reply-To` | 技术上可行，但 push-hub 的发信是「一次性 SMTP 连接」，没有「这条消息属于哪个线程」的状态，加了也只能造出一个断头的 References 链 |

#### 探针

新建 `scaffold/probe_reply.mjs`，**62 项断言**（`REPLY_OK`），九段守：

- **A 段（10）** 五家翻译的形状 —— 每个都验到「没有这个具体字段就不算接上」的程度：Telegram 的 `allow_sending_without_reply`、Discord 的 `fail_if_not_exists:false`、QQ 的 `msg_seq`、Matrix 的嵌套 `m.relates_to['m.in_reply_to']`
- **B 段（6）** ID 归一：`undefined` / `null` 是「不回复」不报错，数字当字符串收，对象要拒，超长要拒并说清「大概是正文」
- **C 段（4）** 能力表与原因表**必须成对**：能回复的不许出现在原因表里
- **D 段（3）** Matrix 前缀只取原文第一行、原文整段保留在前缀之后、没有 ID 时原样返回
- **E 段（16）** 五个通道真的接了：每个三条（导入 / 解析 `options.replyTo` / 调 `replyFor`），再加两条「只挂最后一块」
- **F 段（6）** bus 透传与降级：不许因为不支持回复就 `throw`
- **G 段（8）** index 的校验、伪发送报丢弃、两条路由都收、工具参数名
- **H 段（5）** 前端从后端取能力、不是写死
- **I 段（3）** 与 buttons 同构但能力表分开（能发按钮 ≠ 能回复）

### 14.24 通道显示：隐藏不等于停用（v0.26.0）

**一句话**：左侧那列通道，你可以决定显示哪些 —— 也可以干脆让它只显示「已经填了账号」的。

#### 为什么做这个

十二个通道全列在左边，实际常用的只有三五个。每开一次设置都要在十几个里找自己要的那一个。用户在 v0.26.0 提的原话是：

> 增加一个设置，就是可以设置哪些通道显示还是隐藏，还有一个选择就是绑定了账号的就显示，没有绑定账号的就隐藏。

所以这不是一个旋钮，是两个：

| 旋钮 | 取值 | 作用 |
|---|---|---|
| 模式 | `all` | 十二个都列出来，不常用的单独关掉 |
| 模式 | `bound` | 只列「有账号」的 —— 就是原话里的第二句 |
| 逐通道 | 显示 / 隐藏 | 这一条我暂时不想看到 |

两档**叠加**：先按模式决定基础集合，再减去手动关掉的那几条。

#### 最重要的那条纪律：隐藏 ≠ 停用

这是整个功能唯一真正危险的地方。用户看到「左边没有这个通道了」，很自然会以为「它停用了」。如果真是这样，那这个设置在不知不觉中会让消息发不出去 —— 一个纯界面偏好变成了功能开关。

所以 v0.26.0 划了一条硬线：

> `channel_visibility` 只被 `lib/client.js` 读。`bus.js`（发送）、`receiver.js`（接收）**一个字都不读**。

隐藏一个通道之后，下面这些全都不变：

- 默认推送照旧发给它的账号（如果它是 `default_channels` 之一）
- 接收照旧在跑（如果之前开过）
- 「发个文件」「引用回复」「带按钮」照旧按它的能力走
- 收件箱照旧收它的消息
- 它照旧出现在「代发通道」「通道显示」等页面的完整清单里

探针 C1/C2 就是在钉这一条：`grep channel_visibility` 在 `bus.js` 与 `receiver.js` 里必须 0 命中。

#### 配置长什么样

存在 `~/.dsh/dsh-push-hub/config.json`：

```json
{
  "channel_visibility": {
    "mode": "all",
    "hidden": ["wecom", "wecom_app"]
  }
}
```

- `mode` 省略 = `"all"`
- `hidden` 省略 = `[]`（全都不隐藏）
- 想看「只看已配置的」：`"mode": "bound"`

#### 后端会归一，手改配置不容易坏

`lib/config.js` 的 `channelVisibility(cfg)` 做三件事：

1. `mode` 只认 `'bound'`，其它一切值（`'Bound'`、`'BOUND'`、拼错的、数字、null）全部归一成 `'all'` —— **写错方向是「多显示」而不是「少显示」**，不会因为手滑把通道弄丢
2. `hidden` 必须是数组，元素按字符串收，只留 `ALL_CHANNELS` 里真实存在的名字 —— 拼错的通道名被丢掉，不会在界面上留一个幽灵开关
3. `[...new Set(...)]` 去重

归一而不是原样透传的理由写在代码注释里：手改配置文件时很容易写出 `{"mode":"Bound"}` 或 hidden 里塞一个拼错的通道名，原样透传会让界面对着一个不存在的 key 空转。

#### 三道过滤，顺序不能反

`lib/client.js` 里算可见通道的那一段：

```js
const visibleChannelKeys = channelKeys.filter((channel) => {
  if (hiddenSet.has(channel)) return false                            // 2'
  if (visMode === 'bound' && accountCountOf(channel) === 0) return false // 3'
  return true
})
```

完整的三道：

1. `channelKeys` —— 存在哪些通道（后端返回了字段的，或内置顺序兜底）
2. `mode === 'bound'` 时只留「有账号」的
3. 最后统一减去 `hidden`

**第 3 步必须在最后**。顺序反了会出现这个 bug：用户手动隐藏一条「本来就没账号」的通道 → 它被 hidden 去掉 → 但 bound 模式又把它当成「没账号的本来就不显示」→ 一旦用户把模式切回 `all`，这条本来手动隐藏的通道会**冒出来**，因为 hidden 的判定已经被 mode 的判定吃掉了。写在代码里的注释原话：

> 第 3 步必须在最后：用户手动隐藏一条「本来就没账号」的通道时，顺序反了会让它在 bound 模式下又冒出来。

#### 账号数只许有一个算法

左栏每个通道下面写「3 个账号 / 未配置」，「通道显示」页里也写同一句话。这两处必须是同一个 `accountCountOf()`：

```js
const accountCountOf = (channel) => {
  const info = channels.find((c) => String(c?.name) === channel)
  const fromServer = Array.isArray(info?.accounts) ? info.accounts.length : -1
  return fromServer >= 0 ? fromServer : ownRows(channel).length
}
```

优先用后端 `/config` 返回的 `channels[].accounts.length`（那是落盘后的真值），取不到再回落本地的 `ownRows(channel)`（账号刚加上、还没 reload 的那一瞬间）。两处各写一份的话，同一个通道在左栏写「3 个账号」、在通道显示页写「2 个账号」，用户会以为哪边坏了。

#### 两处兜底，不让界面停在幽灵状态

**兜底一：选中项被隐藏**。用户正停在「企业微信」详情页，然后去「通道显示」把它关了 —— 左侧列表已经没有它了，右侧要是还渲染它的详情，用户会以为界面卡住。所以：

```js
const effectiveSelected = visibleChannelKeys.includes(selectedChannel)
  ? selectedChannel
  : (visibleChannelKeys[0] ?? '')
```

`mainBody` 与左栏的高亮都用 `effectiveSelected`，不用 `selectedChannel`。

**兜底二：全被隐藏**。左栏给一句「通道都被隐藏了。去「通道显示」里放开几条，或把模式切回「全部显示」。」，右侧给一段专门说明而不是空白页。

#### 不许把「隐藏」做成从 channels 里删

最省事的写法是 `setChannels((prev) => prev.filter(...))` —— 左侧自然就少了。但这会连带污染：

- 账号数统计（少一个通道 = 少一批账号）
- 默认推送校验（原本有账号的通道突然「不在列表里」）
- 保存回传（`buildPayload` 里 `picked` 依赖 channels）
- 「代发通道」「通道显示」等页面的完整清单

**一个纯界面偏好绝不能改配置本身**。探针 F3 专门禁止这个写法。

#### 界面怎么用

1. 左侧工具区 → 「通道显示」
2. 顶部两档二选一：**全部显示** / **只显示已配置的**
3. 下面十二行逐通道勾「显示」；关掉的会显示「已隐藏」徽章并说明原因（是你手动隐藏的，还是被 bound 模式自动藏起来的）
4. 改完即保存（`buildPayload` 带 `channel_visibility`，POST `/config`），不需要点保存按钮

#### 合并语义：整组替换

`lib/index.js` 的 `mergeUserConfig()` 里：

```js
next[config.VISIBILITY_KEY] = {
  mode: raw?.mode === 'bound' ? 'bound' : 'all',
  hidden: Array.isArray(raw?.hidden) ? [...new Set(...)] : [],
}
```

前端给什么就整组替换，**不逐项累加**。理由：这是「用户此刻想让列表长什么样的快照」，不是可以逐项打开的开关。留着旧值反而会复活用户刚放开的那条。

#### 新增探针

`scaffold/probe_visibility.mjs`，**37 项断言**（`VISIBILITY_OK`），六段守：

- **A 段（9）** 归一化 —— 没配置 / 大小写写错 / hidden 不是数组 / 值是 null / 拼错通道名 / 重复项，全都要安安稳稳
- **B 段（4）** 合并语义 —— 掩码带出、整组替换、剔除未知名、mode 只认 bound
- **C 段（4）** 发送与接收一个字都不读 —— `bus.js` / `receiver.js` 里 `grep channel_visibility` 必须 0 命中；归一化函数必须是纯函数
- **D 段（13）** 三道过滤的顺序、账号数唯一算法、选中项兜底、全隐藏兜底、界面四处接线
- **E 段（4）** 语义 —— 界面上明确写了「隐藏 ≠ 停用」、默认全显示、有「只显示已配置的」、说明了叠加
- **F 段（3）** 不许有第二个真值来源 —— 不能混进 `ownBotFields`、不能在 `/info` 之后才准备、不能用 `filter` 实现隐藏

### 14.25 设置面板为什么必须自己滚（v0.26.1）

#### 一句话

宿主给设置分区的是**定高容器**，插件自己的根节点不声明高度与溢出，超出的部分就被裁掉 —— 看起来像「界面只有半截」，实际是内容都在 DOM 里、只是滚不到。

#### 实测现象

主人从左上角点开设置面板后截图反馈，原话：

> 通过左上角点开的界面，没有滚动，看不到下面的选项了。

截图里工具区只到「扫码接入」，下面五项（试发一条 / 代理通道 / 接收消息 / 通道显示 / 通道来源）一个都看不见，也没有滚动条。这个现象有一个很典型的特征：**页面看起来「干净地结束」了，不像加载失败**。加载失败会有空白、有「读取中…」、有报错横幅；这里内容是完整渲染的，只是被容器裁掉 —— 所以第一反应不应该是「数据没回来」，而是「滚动在哪」。

#### 为什么原先没有滚动

`.dph-root` 的原样式只有这些：

```css
.dph-root {
  --dph-blue: ...;   /* 一堆色板变量 */
  box-sizing: border-box;
  padding: 2px 0 24px;
  color: var(--dph-label-1);
  font-family: ...;
  font-size: 13px;
  line-height: 1.55;
}
```

没有任何高度与溢出声明。于是：

1. `.dph-root` 作为普通块级元素，高度**由内容决定**（auto）；
2. 宿主的容器是定高（`height: 100%` + 自己 `overflow` 由宿主决定，多数是 `hidden` 或 `auto`）；
3. 内容高度 > 宿主容器高度时，多出来的部分被宿主容器裁掉；`.dph-root` 自身没有滚动条，因为它没有高度约束、它「以为」自己有足够空间。

**关键点**：问题出在「高度从哪来」。插件没声明高度，就无法知道自己的滚动边界在哪。

#### 修法

```css
.dph-root {
  ...
  height: 100%;          /* ① 撑满宿主的定高容器 */
  min-height: 0;         /* ② grid/flex 子项的救命属性 */
  padding: 2px 0 28px;
  overflow-y: auto;      /* ③ 超出就出滚动条 */
  overflow-x: hidden;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}
```

三样缺一都不成立，原因各不相同：

| 声明 | 漏了会怎样 |
|---|---|
| `height: 100%` | 根节点高度仍由内容决定，宿主容器直接裁掉溢出部分，永远不出滚动条 |
| `overflow-y: auto` | 高度被钉死成容器高，但超出部分是**裁**不是**滚**，用户看到的还是一半 |
| `min-height: 0` | 作为 grid/flex 子项时默认 `min-height: auto`，会被内容顶到比 `height` 更大，滚动条不出现（这是最隐蔽的一条） |

另外两条是体验项：

- `scrollbar-gutter: stable` —— 提前给滚动条留槽位，否则滚动条一出现/消失，内容会左右横跳一下（在窄面板上特别明显）。
- `overscroll-behavior: contain` —— 滚到底时不要把手势传递给外层页面，否则用户想滚面板结果整页跟着动了。

#### 为什么 `padding` 要跟着改

原来 `padding: 2px 0 24px` 左右是 0，右侧没有留白。加了 `scrollbar-gutter: stable` 之后浏览器已经在右侧预留了滚动条槽位，如果再加 `padding-right` 就会变成双份空隙（内容离右边缘一大段）。所以这里保持 `padding: 2px 0 28px`（把底部从 24 提到 28，给最后一行留点呼吸），右侧留白完全交给 `scrollbar-gutter`。

#### 为什么不用 `max-height: 100vh`

`vh` 参照的是**视口**，不是容器。宿主可能把设置面板嵌在侧边抽屉或分栏里，那时 `100vh` 会算出比实际可用高度大得多的高度 —— 结果是要么滚动条永远不出来（容器被撑开），要么出现比容器更大的一页。

同样的理由，也不使用 `height: 100vh`。

#### 为什么不用 `position: fixed`

页面里没有任何绝对定位/粘性元素（`grep position: absolute|sticky|fixed` 在 `lib/theme.js` 里 0 命中），所以不需要担心 `overflow` 把浮层裁掉。如果将来加了浮层（下拉、气泡），记住一条：**`overflow: auto` 的祖先会裁掉 `position: absolute` 的后代**，那时浮层要么 portal 到 `body`，要么改用 `position: fixed`。

#### 两份样式表，一起改

`lib/theme.js` 导出 `THEME_CSS`，`lib/client.js` 里又内联了一份同名常量（ModuleLoader 只能 require 宿主给的模块，不能 `import` 相对路径，所以只能各写一份）。**只改一份的后果是「探针绿但界面没变」** —— `lib/theme.js` 那份甚至不在浏览器里生效，实际注入的是 `lib/client.js` 里那份。

所以每次改样式必须：

1. 两个文件同时改同样的 CSS；
2. 跑 `node scaffold/probe_scroll.mjs`，C1 逐字节比对，C3 额外确认内联那份也带新声明。

v0.26.1 的实测同源结果：`len=25171` / `hash=75b81801` / `same=true`。

#### 探针怎么守

`scaffold/probe_scroll.mjs`，**13 项断言**（`SCROLL_OK`）：

- **A 段（6）** 根节点规则块能不能找到、有没有 `height: 100%` / `overflow-y: auto` / `overflow-x: hidden` / `box-sizing: border-box` / `overscroll-behavior: contain`
- **B 段（2）** 有没有 `min-height: 0`；**不许**出现 `max-height: 100vh`
- **C 段（3）** 两份 CSS 逐字节相同、样式表不是空壳、内联那份也带滚动声明
- **D 段（2）** **不许**退化成 `overflow: hidden` 或 `display: none` 来「掩盖」内容

#### 这一版改了什么、没改什么

- **改了**：两份 CSS 里 `.dph-root` 一条规则块。
- **没改**：任何 JS 逻辑、任何通道实现、任何接口、任何配置键。整个 v0.26.1 的 diff 只有 CSS。

所以升级后**不需要迁移配置、不需要重新填凭据**，只是界面能滚了。

### 14.26 删账号：前端留空数组，后端删整条（v0.26.2）

#### 一句话

「没有这个键」与「这个键是空数组」在合并逻辑里是**两件不同的事**：前者是「这次没提到这个通道」（保留旧值），后者是「我明确把它清空了」（删掉）。前端原先把删除表达成前者，于是删除动作在前端生效、落盘被忽略。

#### 实测现象

主人反馈的原话：

> QQ账号我已经移除，再进去的时候为什么还在？其他通道看看是不是也有这个问题。

复现路径很短：界面上删掉一个通道的最后一条账号 → 那条立刻从界面消失（前端 state 变了）→ 自动保存提交 → 刷新 → **它又回来了**。

#### 根因：两边的理解各自都对，合起来就丢动作

前端原来的 `dropOwn`：

```js
const dropOwn = (channel, index) => {
  setOwnBots((prev) => {
    const list = (Array.isArray(prev?.[channel]) ? prev[channel] : []).filter((_, i) => i !== index)
    const next = { ...prev }
    if (list.length === 0) delete next[channel]   // ← 就是这一行
    else next[channel] = list
    return next
  })
}
```

后端 `lib/index.js` 的 `mergeUserConfig`：

```js
const own = { ...oldOwn }                                    // 起点是磁盘旧值
for (const [channel, fields] of Object.entries(OWN_BOT_FIELDS)) {
  if (!Object.hasOwn(incomingOwn, channel)) continue          // ← 「没提到」= 保留
  ...
  if (accounts.length === 0) delete own[channel]              // ← 「空数组」= 删掉
  else own[channel] = accounts
}
```

两边单独看都合理：前端认为「一条都不剩了，键留着也是空的，干脆删干净」；后端认为「提交里没这个通道，说明这次不改它」（这是老前端与命令行局部提交的正常情形，必须兼容）。合起来的结果是 **前端表达了「删空」，后端读成了「没提到」**。

#### 修法：把两种语义分开，各走各的分支

前端删空时**保留键并写空数组**：

```js
const dropOwn = (channel, index) => {
  setOwnBots((prev) => {
    const list = (Array.isArray(prev?.[channel]) ? prev[channel] : []).filter((_, i) => i !== index)
    return { ...prev, [channel]: list }   // 空数组是明确的「这个通道我一条都不剩了」
  })
}
```

于是后端那条 `if (accounts.length === 0) delete own[channel]` 才真正被执行到 —— 这条分支其实一直写着，只是以前前端从来不会送出空数组，它等于死代码。

| 前端提交的形状 | 后端理解 | 磁盘结果 |
|---|---|---|
| `own_bots` 里没有 `qq` 键 | 这次没提到 qq | 保留旧账号（**这是老行为的合理语义**） |
| `own_bots: { qq: [] }` | 明确清空 qq | 删掉整个 qq 键 |
| `own_bots: { qq: [{...}] }` | 设置 / 更新 qq | 落盘一行或多行 |

#### 为什么不是 QQ 一个通道的问题

`own_bots` 是一个**以通道名为键的对象**，十二个通道共用同一段合并逻辑：

```js
for (const [channel, fields] of Object.entries(OWN_BOT_FIELDS)) { ... }
```

前端也只有 `dropOwn` 一个删除入口。所以 telegram / feishu / wechat / 群晖 四个通道（本次实测时磁盘上已有的五个通道）**同病同修** —— 改这一处，十二个通道全部生效。实测确认：提交 `qq: []` 之后磁盘 `own_bots` 的键从 `telegram,feishu,qq,wechat,synology_chat` 变成 `telegram,feishu,wechat,synology_chat`，其余通道的账号数一个没变。

#### 不许把后端的 `continue` 删掉

看到 `if (!Object.hasOwn(incomingOwn, channel)) continue` 很容易想「就是它保住了旧账号，删了不就完了」。**不能删**，三个理由：

1. 命令行与脚本只会提交它想改的那个通道（例如只发 `{own_bots:{telegram:[...]}}`），删了 `continue` 会把其它十一个通道全清空。
2. 旧版界面（升级过程中同时打开的标签页）提交的 payload 不含新加的通道，同理。
3. 「只改一个通道」是常态操作，把它变成「必须每次提交全部通道」是接口设计的倒退。

正确做法是让前端把「删空」表达清楚（空数组），而不是让后端猜。

#### 探针守什么

`scaffold/probe_ownbot_delete.mjs`，**19 项断言**（`OWNBOT_DELETE_OK`）：

- **A 段（10）** 从 `lib/client.js` 里按**花括号配对**截出 `dropOwn` 的真函数体，用 `new Function` 配一个假的 `setOwnBots` 真跑：两条删一条、只剩一条删掉后键仍在、值是空数组、不动其它通道、不就地改入参。**不是 grep 源码** —— 只查 `delete next[channel]` 有没有出现，抓不到「键被删掉了但代码里没写那几个字」的回退。
- **B 段（3）** 后端两个分支必须都在（空数组删整条、没这个键就跳过），且顺序是先判键再判删。
- **C 段（3）** 十二通道同一条路径：合并按 `OWN_BOT_FIELDS` 遍历、起点是磁盘旧值、前端只有 `dropOwn` 一个删除入口。
- **D 段（3）** 不许退回旧写法：没有 `if (list.length === 0) delete` 残留、代码里写清了空数组语义、用 `filter` 而不是 `splice` 就地改。

#### 改了什么、没改什么

- **改了**：`lib/client.js` 的 `dropOwn` 一个函数、`package.json` 版本号、三份文档、一个新探针。
- **没改**：`lib/index.js` 的合并逻辑一个字都没动（那条空数组分支本来就在）、任何通道实现、任何接口签名、任何配置键形状、任何已落盘的凭据。

所以升级后**不需要迁移配置、不需要重新填凭据**；只是「删掉的东西真的会消失」了。

#### 一条操作提醒

`lib/client.js` 是前端 bundle，改完要让界面「禁用→启用」插件（或重启 DSH）才加载新版。也就是说：**磁盘上的账号在网络请求返回时就已经删干净了**，界面上那条要等重载后才消失。这中间别误判成「还没修好」。

### 14.27 入站附件：十个平台，一层归一化（v0.27.0）

#### 为什么做这一节

v0.26.x 之前我这个插件有个**很大的洞，而且是我自己没发现的**：十个接收通道里，**每一个**都只从事件里取正文文本，取不到就 `continue`。别人给机器人发一张截图、一个 PDF、一段语音，收件箱里**一个字都没有** —— 用户会以为插件坏了，去查代理、查 token，其实消息早收到了，只是被「没有文字」这个判据丢掉了。

这一版补的就是它。关键判断：**不做下载，只做准确的记录**。拉附件要处理单文件上限、落盘路径、清理策略、凭据泄漏（Slack 的 `url_private` 带 token），那是另一个量级的事；而「谁在什么时候给我发了个什么文件」这件事，记录本身就已经解决了大半问题。

#### 十个平台长什么样（这就是必须做归一化层的原因）

| 通道 | 附件字段 | 反直觉的地方 |
|---|---|---|
| Telegram | `message.photo[]` / `document` / `voice` / `audio` | `photo[]` 是**同一张图的多档分辨率**，不是多张图。照数组长度记账 = 发一张图记成 3 张 |
| Slack | `event.files[]` | 发文件时 `subtype === 'file_share'`；旧代码 `if (subtype !== undefined) return` 把它一起挡掉了 |
| Discord | `message.attachments[]` | 与 Slack 结构最像，但字段名是 `filename` / `content_type`（下划线）不是 `name` / `mimetype` |
| Matrix | `content.msgtype` = `m.image`/`m.file`/`m.audio`/`m.video` | **`content.body` 在这里是文件名，不是正文** —— 照「body 就是消息文字」的直觉读会把它当正文发进收件箱 |
| 飞书 | `message.content`（按 `message_type` 分 file/image/audio/media） | `content` 是一段 **JSON 字符串**，不是对象；`content.file_name` 永远是 undefined，要先 `JSON.parse` |
| QQ | `d.attachments[]` | **必须在 5 分钟内用 `msg_id` 主动拉**，过了窗口取不到。所以只记元数据，不假装能下载 |
| 钉钉 | `msgtype` = picture/file/audio | picture **只给 `downloadCode`，没有文件名**；file 才有 `fileName` + `fileSize` |
| 企微智能机器人 | `body.mixed.msg_item[]` | 推不了文件与图片，只有 mixed 里才可能带东西 |
| 邮件 | `parsed.attachments[]` | 内联图片也在里面，照记不误 |

九种形状压成一个：`{ kind: 'image' | 'file' | 'voice', name, mediaType, size }`。类型判定 `kindOf(name, mediaType)` **mime 优先于扩展名**（`.bin` 配 `image/png` 应该算图片）。

#### 三个必须做对的点

**1. 正文空判定要连着附件一起判。**

旧：`if (text.trim() === '') continue` → 「只发了张图、没配文字」的消息整条丢掉。
新：`if (caption.trim() === '' && attachments.length === 0) return` → 正文和附件**同时**为空才拒。

**2. 摘要要拼进正文，但前端不许再拼一遍。**

后端 `deliver` 里把摘要拼上（`[图片 photo-a1b2.jpg 900.0 KB]`），前端只渲染 `msg.text`。两边都拼会出现「[图片 x.jpg] [图片 x.jpg]」。探针 H3 就是守这个。

**3. 附件个数的上限在两层都要有。**

`compact()` 里 `slice(0, 10)`、`inbox.appendMessage` 里也 `slice(0, 10)`。前者防一个事件里带 50 个附件把一条消息撑爆，后者防老数据/手工写入绕过。

#### 刻意没做的三件事

| 没做 | 为什么 |
|---|---|
| **下载附件到本地** | 要处理单文件上限、落盘路径、清理策略、凭据泄漏（Slack `url_private` 带 token）。这是另一个量级的功能，硬塞进这一版只会做坏 |
| **图片缩略图 / 预览** | 收件箱是纯文本列表，没有渲染管线；要预览得先把文件拉下来，又回到上一条 |
| **附件去重** | 同一个人连发两张一样的图，本来就该记两条 —— 那是两次发送行为 |

#### 探针守什么

`scaffold/probe_attachments.mjs`，**60 项断言**（`ATTACHMENTS_OK`）：

- A/B 段：`kindOf` 的 mime 优先、`humanSize` 的边界、`summarize` 的拼接格式、`compact` 的空项跳过与 10 条截断
- C 段：Telegram 多档尺寸只算 1 个（**这是最容易写错的一条**）
- D/E 段：九个平台各自的真实 payload 形状逐个喂进去
- F 段：九个 `fromXxx(` 都真的在 `lib/receiver.js` 里被调用（不是写了没用）；`attachments,` 出现 11 处；旧的 `if (text.trim() === '') continue` 已经不在
- G 段：`inbox` 三项 + `/receive/inbox/attachments` 路由两项 + 前端徽标两项
- H 段：摘要不重复渲染

查：
```powershell
node scaffold\probe_attachments.mjs
```

#### 改了哪些文件

| 文件 | 改了什么 |
|---|---|
| `lib/attachments.js` | **新建**，263 行：九个解析函数 + `kindOf` / `humanSize` / `summarize` / `hasAttachments` |
| `lib/receiver.js` | `deliver` 重写（正文空判据 + 摘要拼接）；十个 worker 全部接上 `attachments`；Slack 放行 `file_share`；Matrix 不再把 `body` 当正文 |
| `lib/inbox.js` | 接收 `attachments`（截 10 条）；空判据连着附件一起判；只在有时写键 |
| `lib/index.js` | 新增 `GET /receive/inbox/attachments` |
| `lib/client.js` + `lib/theme.js` | 收件箱加附件徽标与左边框色（两份 CSS 同源，len=25519 / hash=b318c3f15f71fd9a） |
| `scaffold/probe_attachments.mjs` | **新建**，60 项断言 |

**没改**：任何发送路径、任何配置键形状、任何已落盘的凭据。升级不需要迁移。

### 14.28 发送回执：十二个通道，七家给得出 id（v0.28.0）

#### 为什么先做这一件，而不是直接做「改消息 / 撤回 / 表情」

那三件事都要先回答同一个问题：**「我要改的那条，在平台上是哪一条？」** 而在此之前，十二个通道的 `send()` 一律只回一句 `{ ok: true, detail: '已发送 N 块（…）' }` —— 消息确实发出去了，**id 一个都没留**。所以不是「改消息没实现」，是它的地基一直缺着。先把 id 记下来，后面三件事才有落点。

#### 十二个通道，谁能给 id

| 通道 | 回包里的字段 | 给得出？ |
|---|---|---|
| Telegram | `data.result.message_id` | ✅ |
| Slack | `data.ts`（时间戳当 id 用） | ✅ |
| Discord | `data.id`（顶层） | ✅ |
| Matrix | `data.event_id` | ✅ |
| 飞书 | `data.message_id` | ✅ |
| QQ | 回包 `.id`（要自己 `parseJson`） | ✅ |
| 邮件 | `info.messageId`（SMTP 的 Message-ID 头） | ✅ |
| 微信 | 只有 `ret` / `errcode` | ❌ |
| 群晖 | 只有 `success` | ❌ |
| 钉钉 | 只有 `errcode` | ❌ |
| 企业微信群机器人 | 只有 `errcode` | ❌ |
| 企业微信智能机器人 | 只有 `errcode` | ❌ |

**七家给得出，五家给不出。** 给不出的那五家，回包里真的没有 —— 这一版**不编造**，探针里反过来断言这五个文件里**不许出现** `messageIds`，防以后有人「顺手补一个」。

#### 三个必须做对的点

| 点 | 做错会怎样 |
|---|---|
| `messageIds` 是**数组** | 长消息分块后每块都是独立消息。只留最后一个 → 改第一条改不到；只留第一个 → 改最后一条改不到 |
| 多目标要**逐目标**挂 | `deliveries[].messageIds` 与摊平的总数组并存。只留摊平的，就分不清哪个 id 属于哪个聊天 |
| **失败不进发件箱** | 失败的消息没有 id，记进去既不能改也不能撤，还占掉 500 条窗口，把真发出去的挤掉 |

#### 发件箱长什么样

存 `~/.dsh/dsh-push-hub/outbox.json`，上限 **500** 条（`MAX_KEEP`），正文截 **200** 字（`TEXT_CLIP`），写入走**原子替换**（先写 `outbox.json.tmp-<pid>` 再 `rename`，mode `0o600` —— 里面有聊天位置，不该被同机其他用户读到）。单条：

```json
{
  "id": "sent-20261117211747-nkzq8c",
  "at": "2026-11-17T21:17:47.236Z",
  "channel": "telegram",
  "account": "主号",
  "target": "-100123",
  "kind": "text",
  "text": "端到端自检",
  "messageIds": ["9001", "9002"],
  "detail": "ok"
}
```

#### 界面怎么用

左侧「工具」区多一项 **发送记录**。每条显示通道中文名 + 「文字 / 文件」标签 + 账号 + 时间 + 正文摘要，最后一行是两种之一：

- `消息 id：9001、9002` —— 绿边，这条以后能改能撤
- `这个通道的回包不给消息 id —— 这条以后改不了也撤不回。` —— 普通边，说清边界

工具侧对应 `push_hub_sent`（`action=recent` 看记录、`action=path` 看文件在哪），返回值里 `withIds` 单独数出来 —— 免得看到 `count: 40` 就以为四十条都能改。

#### 刻意没做的三件事

| 没做 | 为什么 |
|---|---|
| 改消息 / 撤回 / 表情 | 本轮授权范围只到「回执」。地基补完了，但那三件各自还有平台差异（Matrix 改消息是**再发一条 `m.replace` 事件**不是编辑原事件、Slack 撤回要 `chat:write` + 时间窗、表情要额外 scope），单独一轮做 |
| 发件箱 UI 的筛选与搜索 | 500 条按时间倒序看够用；加筛选要定「按通道/按账号/按有无 id」三套语义，不是这一版该塞的 |
| 失败记录 | 见上：没有 id 的失败记录只有负作用 |

#### 查

```powershell
node scaffold\probe_outbox.mjs
```

### 14.29 改消息与撤回：四家做得了，八家做不了（v0.29.0）

这一节讲清楚三件事：为什么只做四家、四家各自的协议差在哪、以及 v0.28.0 留下的那个「多目标定位不到」的缺口是怎么补的。

#### 14.29.1 为什么只做四家（这个决定比代码重要）

官方文档写着支持 ≠ 我们敢做。飞书就是典型：

| 项 | 实际情况 |
|---|---|
| 官方文档 | 确有 `PATCH /open-apis/im/v1/messages/:message_id`（编辑）与 `DELETE` 同路径（撤回） |
| 本机凭据 | **没有**。feishu 通道配的是一把机器人 token，从未做过改/撤的真实调用 |
| 抓官方文档 | `web_fetch` 只回 25 字节，SPA 页面正文全靠 JS 渲染，拿不到「哪些 msg_type 可改」的细则 |
| 社区反馈 | 有 `invalid msg_type` 的实测报错，说明不是所有消息类型都能改 |
| 决定 | **不做**。理由是代码注释里那句：「宁可没有，也不要一个按下去必然报错的按钮」 |

这条判断的标准是**「能不能为失败负责」**：写在文档里、用户照着按、按下去报错 —— 那比「这个功能暂时没有」更糟。所以 `NO_EDIT_REASON.feishu` 里直接写明「本机无凭据实测」，而不是含糊地说「暂不支持」。

其余七家更直接：

| 通道 | 做不做 | 原因 |
|---|---|---|
| qq | ❌ | 官方开放平台没有消息编辑/撤回接口 |
| email | ❌ | 邮件发出去就在对方服务器上，没有可撤回这回事 |
| wechat | ❌ | iLink 协议没有编辑/撤回消息类型 |
| dingtalk | ❌ | 只能发新消息，机器人不能改/撤历史消息 |
| wecom | ❌ | 群机器人 webhook 是单向投递，无消息管理接口 |
| wecom_app | ❌ | 自建应用接口无消息编辑/撤回 |
| synology_chat | ❌ | webhook 只收文本与附件，无管理接口 |

#### 14.29.2 四家各自的协议（没有一家是一样的）

| 通道 | 改消息 | 撤回 | 位置怎么给 |
|---|---|---|---|
| telegram | `POST /editMessageText`，body `{chat_id, message_id, text, disable_web_page_preview:true}` | `POST /deleteMessage`，body `{chat_id, message_id}` | `chat_id` = 目标 id，`message_id` = `result.message_id` |
| slack | `POST chat.update`，body `{channel, ts, text}` | `POST chat.delete`，body `{channel, ts}` | `channel` + `ts`（Slack 的消息 id 就是时间戳） |
| discord | `PATCH /channels/:cid/messages/:mid`，body `{content, allowed_mentions:{parse:[],replied_user:false}}` | `DELETE` 同路径，**204 无响应体** | `channel_id` 在路径里，`message_id` 也在路径里 |
| matrix | **再发一条新事件**：`PUT /rooms/:rid/send/m.room.message/:txn`，content 里 `m.new_content` 放新正文、`m.relates_to:{event_id,rel_type:"m.replace"}`，外层 `body` 加 `"* "` 前缀 | `PUT /rooms/:rid/redact/:eid/:txn`（**三段路径 + PUT**，body `{}`） | `room_id` 在路径里，`event_id` 是要撤的那条 |

四家都不写死「位置从哪来」：统一走 `String(options?.chatId ?? "").trim() !== "" ? options.chatId : targetOf(acc).id` —— 因为发件箱里存着**当时那条消息发去的目标**，比「现在这个账号的默认目标」准（用户可能改过配置）。

#### 14.29.3 三个必须做对的细节

| 细节 | 不做会怎样 | 代码在哪 |
|---|---|---|
| Telegram 的 `message is not modified` 判成功 | 用户把「你好」改成「你好 」（多个空格）或原样再按一次，Telegram 回 400，界面报「改失败」但实际已经是目标状态 | `lib/channels/telegram.js` 的 `editMessage` |
| Discord 改消息带 `allowed_mentions:{parse:[]}` | 改完的正文里带 `@everyone` 会**真 ping 全频道** | `lib/channels/discord.js` 的 `editMessage` |
| Discord 撤回按状态码判（204/200），不看 body | 撤回成功返回 204 且**响应体为空**，`parseJson(body)` 拿到 `{}`，按「有没有返回 obj」判会把成功判成失败 | `lib/channels/discord.js` 的 `deleteMessage` |

另外两条跨通道纪律：

- **改消息不许分块**。`send()` 会按平台上限切块，但 `editMessage()` 不能：改的是「那一条」，拆成两条就成了「原来是 A，现在变成 B 和 C」。四家统一超长直接拒，文案「改消息不能分块，只能缩短」。
- **空正文拒在本地**。Telegram/Slack/Discord/Matrix 都不接受把消息改成空 —— 那是「撤回」的语义，不是「编辑」。四家统一拒，文案「改成的正文不能为空（要清掉请用撤回）」。

#### 14.29.4 补 v0.28.0 的缺口：`places` 分组

v0.28.0 的发件箱把一条消息的 id 摊平成一个数组：

```json
{ "channel": "telegram", "account": "主号", "target": "聊天A、聊天B",
  "messageIds": ["101", "102", "201", "202"] }
```

问题：**分不清 101/102 是聊天A 的还是聊天B 的**。改/撤需要「哪个聊天里的哪一条」，摊平之后无从定位。v0.29.0 改成逐目标分组：

```json
{ "channel": "telegram", "account": "主号", "target": "聊天A、聊天B",
  "places": [ { "id": "聊天A", "messageIds": ["101","102"] },
              { "id": "聊天B", "messageIds": ["201","202"] } ],
  "messageIds": ["101","102","201","202"] }
```

`messageIds` 保留（老代码与统计还在用），`places` 是新增的**结构化真相**。`lib/edits.js` 的 `placesOf(entry)` 优先取 `places`，没有则退回老条目：`target` 为空或含「、」（多目标 join）时返回 `[]` —— **定位不了就不猜**，多目标老条目撤不回去，这是可接受的降级，总比对错聊天下手强。

#### 14.29.5 界面与接口

「发送记录」页每条 id 单独一行，右边两个按钮：「改这条」（`window.prompt` 问新正文，默认填原文）与「撤回」（`window.confirm` 先问，文案明确写「不可撤销」）。按钮显隐**由后端能力表决定**：

```powershell
Invoke-RestMethod http://127.0.0.1:3082/@duma520/dsh-push-hub/api/edit/channels
```

返回 `edit` / `del` 各四个通道名 + 八条原因。前端不在代码里写死「哪几个通道支持」—— 写死迟早过期，过期后就会给一个点了必然失败的按钮。

接口与工具：

| 入口 | 用途 |
|---|---|
| `GET /edit/channels` | 能力表 + 每家不能做的原因 |
| `POST /send/edit` | `{channel, messageId, text, account?, chatId?}`（驼峰与下划线都认） |
| `POST /send/delete` | `{channel, messageId, account?, chatId?}` |
| 工具 `push_hub_edit` | `channel` / `messageId` / `text` / `account` / `chatId` |
| 工具 `push_hub_delete` | `channel` / `messageId` / `account` / `chatId` |

#### 14.29.6 刻意没做的

| 没做 | 为什么 |
|---|---|
| **表情回应**（reaction） | 四家里只有 Discord/Matrix 顺手（Telegram 要 `setMessageReaction` 且 bot 有额外限制），Slack 要 `reactions:write` scope。而且「发消息」不依赖它，属锦上添花。**v0.30.0 已补上**（见 14.30） |
| **批量改/撤** | 现在一次一条，逐条按。批量要先定义「部分失败怎么报」，还没想清楚 |
| **改文件消息的说明文字** | Telegram 能改 `caption`，但 Slack/Discord/Matrix 的文件消息改法与文本不同（Matrix 要改 `m.file` 的 `m.new_content`）。先把文本这一层做扎实 |
| **飞书改/撤** | 见 14.29.1 —— 没实测过就不做 |

#### 14.29.7 探针

`scaffold/probe_edits.mjs` 79 项：能力表 12 / 消息 id 归一化 10 / 位置反查 8 / 四家通道实现 21（每家的三条入口 + 协议级断言）/ bus 调度 8 / index 路由与工具 10 / 前端 9 / 能力表一致性 1。

其中几条「防退步」的：

- A8 断言 `editBlocker("feishu")` 的文案里**必须含「凭据」** —— 诚实说明「没实测」，不许含糊成「暂不支持」。
- D5 断言 Discord 的 `editMessage` 源码里必须有 `allowed_mentions`。
- D6 断言 Discord 的 `deleteMessage` 判 `204`。
- G8 断言前端按钮显隐**由能力表决定**，源码里不许出现通道名硬编码。
- C4 断言多目标但没有 `places` 的老条目返回空数组（定位不了就不猜）。

另外 `probe_outbox.mjs` 从 64 项同步扩到 67 项（新增 C5b/C5c/C5d 守 `places` 在三处都不丢）。

#### 14.29.8 实测命令

```powershell
# 能力表
Invoke-RestMethod http://127.0.0.1:3082/@duma520/dsh-push-hub/api/edit/channels | ConvertTo-Json -Depth 4

# 撤回一条（把 12345 换成发件箱里真实的 messageId）
$body = '{ "channel": "telegram", "messageId": "12345" }'
Invoke-RestMethod -Method Post -ContentType application/json -Body $body `
  http://127.0.0.1:3082/@duma520/dsh-push-hub/api/send/delete
```

注意：本机 telegram 只有一把 bot token、一个账号，**没有可撤回的历史消息**，所以撤回真链路没有实测过 —— 协议是按 dsh-im 的实现（Telegram/Slack/Discord/Matrix 四家都有现成代码）对照官方文档核的，但**没有一次真实的成功回包**。这一点在迭代记录里也写明了。
### 14.30 表情回应：Slack 认名字，不认字符（v0.30.0）

#### 14.30.1 为什么这一版全是坑

加个表情回应听起来是最简单的一件事 —— 不就是「给某条消息挂个 👍」？实际做下来，四家的语义**没有一处是一样的**，而且每家都有一个「照着直觉写必然错」的点：

| 家 | 参数长什么样 | 最容易踩的那一脚 |
|---|---|---|
| Telegram | `reaction: [{type:'emoji', emoji:'👍'}]` | **空数组 = 清掉全部**，没有「只删某一个」的接口 |
| Slack | `name: 'thumbsup'` | **认名字不认字符**；传 `👍` 回 `invalid_name` 而 **HTTP 仍是 200** |
| Discord | URL 里塞 emoji（URL 编码） | 自定义表情必须 `name:id`；成功是 **204 无响应体**，看 body 永远判不出来 |
| Matrix | 一个 `m.annotation` **新事件** | 「去掉」要的是**回应事件 id**，不是原消息 id |

其中 **Slack 那条最阴**：`reactions.add` 的失败是「业务层失败、HTTP 层成功」—— 状态码 200、响应体里 `{"ok":false,"error":"invalid_name"}`。只看 `res.ok` 的代码会把它当成功，用户看到的是「我点了加表情，界面说成功了，但表情没出现」。

#### 14.30.2 所以先立一条纪律：宁可拒绝，不猜名字

新建 `lib/reactions.js`，核心不是那四个函数的胶水，而是 `slackNameOf()` 的策略：

- 纯 ASCII 的输入（`thumbsup` / `rocket`）**原样放行** —— 用户已经填对了名字，不该拦。
- `+1` → `thumbsup`、`-1` → `thumbsdown` 两个特例（这是 Slack 自己的别名）。
- Unicode 字符查一张 **34 个常用表情**的对照表（👍→thumbsup、🎉→tada、❤️→heart、😂→joy ……）。
- **表里没有的，返回失败并让用户填名字**，不做任何「近似匹配」或「猜一个最像的」。

拒绝的文案是：

> Slack 认的是表情名字（例如 thumbsup），不是这个字符。这个表情不在内置对照表里，请直接填 Slack 的名字，别填 emoji。

为什么不做「猜」：猜错名字比不映射**更糟**。不映射时用户知道「这个表情要我自己填名字」；猜错时用户会以为「这个表情 Slack 不支持」，于是在别的地方继续碰壁。而且 Slack 的表情名字表有几千个，内置 34 个只是「最常见的那些」，硬猜等于编造。

#### 14.30.3 四家各自的实现要点

**Telegram** `POST /bot<token>/setMessageReaction`

```js
body = {
  chat_id: target.id,
  message_id: messageId,
  reaction: key === '' ? [] : [{ type: 'emoji', emoji: key }],
}
```

`reaction: []` 是「清空机器人挂过的所有表情」。所以 `removeReaction()` 恒传空数组，返回文案里直接写「Telegram 没有「只删某一个」的接口，一次清空」。它不是「不支持去表情」，是「去表情的粒度比别的家粗」—— 这个差别必须让用户看见。

**Slack** `reactions.add` / `reactions.remove`

```js
body = { channel: target.id, timestamp: ts, name }
```

需要 `reactions:write` scope。两个错误码判**幂等成功**而不是失败：`already_reacted`（已经挂过了）与 `no_reaction@@（本来就没有，去表情时遇到）。用户点两次加表情 / 点两次去表情，不该报错。

**Discord** `PUT` / `DELETE .../messages/:mid/reactions/<emoji>/@me`

emoji 要 `encodeURIComponent`。判据是 `status === 204 || status === 200` —— 成功**没有响应体**，`await res.json()` 会直接抛。自定义表情要写 `name:id`（例如 `blob:1234567890`），只写名字找不到。

**Matrix** 发一条 `m.annotation` 事件

```js
content = {
  'm.relates_to': { event_id: messageId, rel_type: 'm.annotation' },
  'm.reaction': key,
}
// PUT /rooms/:rid/send/m.reaction/:txnId
```

**这是本版结构上最不一样的一家**：表情不是「挂在原消息上的属性」，而是一个独立事件。所以「去掉」只能撤回那个事件（`redact`），于是 `removeReaction(reactionEventId, acc)` 收的**不是原消息 id**。这一点界面上直接写明，不假装传原消息 id 也能去掉。加表情的返回里会给回应事件 id，用户拿它去去表情。

#### 14.30.4 能力表：三种能力一次给全

能力表从 v0.29.0 的 `GET /edit/channels` 扩展，**不新增接口**：

```json
{
  "edit": ["telegram", "slack", "discord", "matrix"],
  "del":  ["telegram", "slack", "discord", "matrix"],
  "react":["telegram", "slack", "discord", "matrix"],
  "editReasons":   { "feishu": "...", "qq": "...", "...": "..." },
  "deleteReasons": { "feishu": "...", "...": "..." },
  "reactReasons":  { "feishu": "飞书开放平台没有「给消息加表情回应」的接口（本机也没飞书凭据实测过）", "...": "..." }
}
```

前端 `editCaps` 一次加载把三种按钮都定好，**代码里不写死任何通道名** —— 写死迟早过期，过期后就会给一个点了必然失败的按钮。

八家为什么没有：

| 通道 | 原因 |
|---|---|
| 飞书 | 开放平台就没有「给消息加表情回应」的接口（本机也没飞书凭据实测过） |
| QQ | 官方机器人 API 没有表情回应接口 |
| 微信 | 公众号 / 客服消息接口只能收发文本图文，没有回应概念 |
| 群晖 Chat | webhook 只有 incoming 一种，服务端不存消息 |
| 钉钉 | 自定义机器人只能发不能改，回应接口仅内网应用可用 |
| 企业微信 | 应用消息接口没有回应维度 |
| 企业微信自建应用 | 同上，走的是同一套消息接口 |
| 邮件 | SMTP 是只写协议，没人能改已投递的邮件 |

#### 14.30.5 接口与工具

| 入口 | 用途 |
|---|---|
| `GET /edit/channels` | 能力表（现在是 edit / del / react 三组 + 三份原因） |
| `POST /send/react` | `{channel, messageId, emoji, account?, chatId?}`（驼峰与下划线都认） |
| `POST /send/unreact` | 同上；Matrix 的 `messageId` 填**回应事件 id** |
| 工具 `push_hub_react` | `channel` / `messageId` / `emoji` / `account` / `chatId` |
| 工具 `push_hub_unreact` | 同上，`emoji` 可选（Telegram 忽略它） |

界面上「发送记录」页每条 id 右边从两个按钮变成四个：**改这条 / 撤回 / 加表情 / 去表情**。加表情的 `window.prompt` 默认值按通道给 —— Slack 给 `thumbsup`，其余给 `👍`，并在 Slack 的提示文案里写明「认的是表情名字，不是字符」。

#### 14.30.6 刻意没做的

| 没做 | 为什么 |
|---|---|
| **表情的「读取」** | 想知道某条消息现在挂了哪些表情，四家要分别查（Telegram `getMessage` 不含 reaction、Slack 要 `reactions.get`、Discord 要拉 `reactions/<emoji>` 用户列表、Matrix 要翻事件）。这是「统计」而非「操作」，且四家形状毫无共性。先把「加/去」做扎实 |
| **Slack 全量表情名字表** | 内置 34 个常用。全量几千个要一张随 Slack 更新的表 —— 表过期反而更糟（用户填了名字却报不存在）。缺的直接让用户填，比维护一张会烂的表诚实 |
| **自定义 emoji 上传** | Slack/Discord 都支持上传自定义表情，但那是 workspace 级管理动作，不是「给消息加回应」 |
| **批量加表情** | 同 v0.29.0 的批量改/撤，要先定义「部分失败怎么报」，还没想清楚 |
| **飞书 / QQ / 微信等八家** | 见 14.30.4 —— 平台没有这个能力，不编造 |

#### 14.30.7 探针

`scaffold/probe_reactions.mjs` **94 项**：

| 段 | 项数 | 覆盖 |
|---|---|---|
| A 能力表 | 11 | 四个通道、八条原因、feishu 原因里必须有「凭据」 |
| B 表情归一 | 10 | 剪空白、去两端冒号、空串、超长拒 |
| C Slack 名字映射 | 10 | ASCII 原样、+1/-1 别名、Unicode 查表、表外拒 |
| D 四家通道实现 | 22 | 每家两个入口 + 协议级断言（Telegram 空数组、Slack 判 ok 不判 200、Discord PUT/DELETE 与 204、Matrix 独立事件） |
| E bus 调度 | 12 | 含 4 条**真调用**断言（无账号 / 空 id / 飞书平台原因 / Slack 表外字符） |
| F index 路由与工具 | 9 | 两条路由 + 两个工具 + 能力表字段 |
| G 前端 | 9 | 四个按钮、能力表驱动显隐、默认值按通道给 |
| H 纪律 | 11 | **八家通道源码里不许出现 `export async function addReaction`**；不许有 `guessEmoji` / `fallbackName` 兜底 |

H 段那两条是这一版最该守的：一条防「以后有人给不支持的通道编一个函数出来」，一条防「以后有人给 Slack 加个猜名字的兜底」。

#### 14.30.8 实测命令

```powershell
# 能力表（现在有 edit / del / react 三组）
Invoke-RestMethod http://127.0.0.1:3082/@duma520/dsh-push-hub/api/edit/channels | ConvertTo-Json -Depth 4

# 给某条加表情（把 12345 换成发件箱里真实的 messageId）
$body = '{ "channel": "telegram", "messageId": "12345", "emoji": "👍" }'
Invoke-RestMethod -Method Post -ContentType application/json -Body $body ``
  http://127.0.0.1:3082/@duma520/dsh-push-hub/api/send/react

# 故意给不支持的家发一次，应当拿到平台级原因而不是笼统失败
$bad = '{ "channel": "feishu", "messageId": "1", "emoji": "👍" }'
Invoke-RestMethod -Method Post -ContentType application/json -Body $bad ``
  http://127.0.0.1:3082/@duma520/dsh-push-hub/api/send/react
```

注意：本机 telegram 只有一把 bot token、一个账号，**没有一条可加表情的真实历史消息**，所以加/去表情的真链路没有实测过 —— 协议是按 dsh-im 的实现（四家都有现成代码）对照官方文档核的，但**没有一次真实的成功回包**。已实测的是「本地拒绝路径」与「能力表」：飞书回平台原因、空消息 id 回「要给消息 id」、Slack 传 🦄 回「请直接填 Slack 的名字」、Matrix 去表情空 id 回「要给回应事件 id」。

### 14.31 依赖解析：先查插件自己，再回落宿主（v0.31.0）

#### 14.31.1 这一版不是加功能，是修事故

主人的原话是：「飞书原来都可以扫描接入的，怎么现在又不可以了？」

第一反应会以为是代码退化。**不是。** 本插件一行代码都没改，飞书的扫码入口也一直躺在 `QR_CHANNELS = ['feishu', 'qq', 'wechat']` 里。失效的是它脚下那块地基 —— 宿主 DSH profile 里的 `@larksuiteoapi/node-sdk` 不见了。

实测证据（不是推测）：

| 检查 | 结果 |
|---|---|
| `~/.dsh/profiles/desktop/node_modules/@larksuiteoapi/` | **空目录**（`ls -la` 只有 `.` 与 `..`），mtime `2026-11-17 13:07:54` |
| dsh-im 5.10.0 的 package.json | `@larksuiteoapi/node-sdk: 1.73.0` 在 **devDependencies**，不在 dependencies |
| `npm ls @larksuiteoapi/node-sdk` | `(empty)` |
| profile 自己的 package.json | 40 个 dependencies，**没有一个**声明它 |

也就是说：**11-16** dsh-im 升到 5.10.0，把这个包从 `dependencies` 挪进 `devDependencies` —— 作为被依赖方安装时不再带上它；**11-17 13:07** 一次 npm 操作把残留的目录清成了空壳。

#### 14.31.2 影响面比「扫码按钮置灰」大得多

这是这一节最该记住的一点：

```
lib/qr.js:237          loadDep('@larksuiteoapi/node-sdk')   ← 扫码建机器人
lib/receiver.js:374    req('@larksuiteoapi/node-sdk')      ← 飞书收消息
```

**同一个包**。所以扫码坏的同时，飞书**收消息也一起坏了**。

⚠️ 而且有一个会骗人的信号：`GET /receive/status` 返回的 `receivable` 列表里**飞书还在**（实测 10 个：telegram, wechat, feishu, matrix, slack, discord, qq, email, dingtalk, wecom_app；blocked 2 个：wecom / synology_chat）。那个列表说的是「声明层面可收」，**不反映依赖借不借得到**。跑起来才知道是 `{ok:false, detail:"飞书接收要用官方 SDK，profile 里没有…"}`。

#### 14.31.3 修法：两级查找，顺序不能反

新建 `lib/deps.js`，把「一个第三方依赖从哪来」这件事收敛成唯一实现：

```
depCandidates() = [
  <插件根>/node_modules,                      ← ① 插件自身，优先
  $DSH_PROFILE_DIR/node_modules,              ← ② 环境变量指定的 profile
  ~/.dsh/profiles/desktop/node_modules,       ← ③ 三个常见 profile
  ~/.dsh/profiles/web/node_modules,
  ~/.dsh/profiles/cli/node_modules,
]   （去重后的）
```

**为什么顺序不能反**：反过来的话，用户明明在插件目录 `npm install` 了，解析时却先撞上 profile 里那个「碰巧还在、但版本不同」的包 —— 装了等于白装。这次事故正是「唯一那份依赖在别人手里」的直接后果。

导出四个东西，各管一类调用方：

| 导出 | 返回 | 给谁用 |
|---|---|---|
| `loadDep(name)` | `{ok:true,mod,from,via}` / `{ok:false,error}` | 要渲染成界面提示的（扫码、发送） |
| `tryRequire(name)` | `{ok:true,...}` / `{ok:false}` | 外面已有 try/catch 的（ws、email） |
| `requireDep(name)` | 直接返回 mod，失败**抛中文原因** | 接收 worker 的五个 loader |
| `probeDep(name)` | `{available,from,detail}` | 能力表 |

#### 14.31.4 被收编的四处（规则只留一份）

| 文件 | 原来 | 现在 |
|---|---|---|
| `lib/qr.js` | 自己写了 `profileCandidates()` / `loadDepViaRequire()` / `resolveEsmEntry()` / `loadDep()` **四个函数共 113 行** | 整段删掉，改成 `const loadDep = sharedLoadDep` |
| `lib/receiver.js` | `loadLark()` 与 `requireFromProfile()` 各自 `createRequire(PROFILE_NODE_MODULES)` | 改调 `requireDep()`（名字保留，五个 loader 调用点不动） |
| `lib/ws.js` | `loadUndici()` 自己 createRequire | 改调 `tryRequire("undici")` |
| `lib/channels/email.js` | `loadNodemailer()` 自己 createRequire | 改调 `tryRequire("nodemailer")` |

删完 `lib/qr.js` 从 526 行降到 420 行。**这一步是必须的**：规则写两份，迟早只有一处跟上（这次就是这么坏的）。

#### 14.31.5 两个坑（都是实际踩到的，不是设想）

**坑一：createRequire 的锚点不能拿 package.json 当存在性判据。**

我第一版写的是：

```js
const anchor = path.join(dir, 'package.json')
if (!existsSync(anchor)) continue      // ← 这里全落空
const req = createRequire(anchor)
```

症状很怪：`npm install` 明明装好了 52 个包、`node_modules/@larksuiteoapi/node-sdk/package.json` 也在，`loadDep` 却回「找不到依赖」。

原因是候选目录**本身就是 node_modules**，而 npm 不会在 `node_modules/` 根下写 package.json。所以每一轮都 `continue` 掉了。正确写法是：

```js
if (!existsSync(dir)) continue
const anchor = path.join(dir, 'noop.js')   // 文件不必存在，只用它所在目录
```

**坑二：纯 ESM 包会让 `req.resolve()` 抛 ERR_PACKAGE_PATH_NOT_EXPORTED。**

`@tencent-connect/qqbot-nodejs@1.0.4` 的 package.json：

```json
{ "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } } }
```

只有 `import`、没有 `require` 也没有 `default`，所以 `createRequire` 的 `resolve()` 直接抛。这种包**不可能被 require 到，但确实装着**，于是退回「按目录直查」：

```js
try { entry = req.resolve(specifier) }
catch (resolveError) {
  const direct = path.join(dir, specifier)
  if (!existsSync(path.join(direct, 'package.json'))) throw resolveError
  entry = path.join(direct, 'package.json')
}
```

#### 14.31.6 包声明与安装

```json
"dependencies": { "@larksuiteoapi/node-sdk": "1.76.0" }
```

三条纪律：

1. **版本钉死精确值，不带 `^`**。`registerApp` 是 1.76 才有的（代码里原本就写着「需 1.76+」），带 `^` 就可能被自动升到不兼容的次版本。
2. **只装这一个**。`react` / `@deepseek-ai/*` 仍在 `peerDependencies` —— 那些必须用宿主那份，装成本地副本会让 client 端出现两份 React。
3. **`node_modules` 不提交**。`.gitignore` 里早就有 `node_modules/` 与 `version/*/node_modules/`，B 方案装上后不需要改。

实测装完 52 个包（含 axios / protobufjs / ws / form-data 等传递依赖）、41 MB。`package-lock.json` 一并落盘，保证别人装到同一棵依赖树。

#### 14.31.7 探针

`scaffold/probe_deps.mjs` **59 项**：候选顺序 8 / 顺序纪律 3 / 解析能力 16 / 四个模块 10 / 行为 6 / 包声明 8 / 纪律 8。

几条「防退步」的：

- **A2**：`depCandidates()[0] === PLUGIN_NODE_MODULES` —— 顺序反了直接红。
- **B2**：从源码里找两个 `list.push` 的位置比大小，保证插件自身写在 profile 之前。
- **C15/C16**：纯 ESM 包必须走 `import` 兜底，并断言注释里写着那个错误码 —— 免得以后有人「顺手简化」掉。
- **D2/D5/D7/D9**：qr / receiver / ws / email **四个文件里都不许再出现 `createRequire`**。
- **D10**：三个模块里不许残留 `PROFILE_NODE_MODULES` 常量 —— 删了常量却还留引用，会运行时崩，这种错最隐蔽。
- **E1/E5**：真调 `qr.capabilities()` 与 `receiver.__test.loadLark()`，断言飞书**真的**恢复（不是只看源码字符串）。
- **G4**：`missingText()` 不许出现 `C:\Users` —— 别把用户名泄进界面与日志。

#### 14.31.8 实测命令

```powershell
cd <插件根目录>\dsh-push-hub
node scaffold\probe_deps.mjs       # 期望 DEPS_OK 59 项
node scaffold\probe_receive.mjs    # 期望 RECEIVE_OK 152 项（依赖换了实现，收信逻辑未回归）
node scaffold\probe_qr.mjs         # 期望能真拿到二维码（微信通道，无凭据也能走）

# 运行时
node -e "fetch('http://127.0.0.1:3082/@duma520/dsh-push-hub/api/qr/capabilities').then(r=>r.json()).then(j=>console.log(j.capabilities.feishu))"
#    期望 { available: true, detail: '' }
```

#### 14.31.9 已知边界

| 边界 | 说明 |
|---|---|
| **只补了飞书这一个依赖** | QQ 连接器、undici、imapflow、mailparser、nodemailer、dingtalk-stream、@wecom/aibot-node-sdk 仍从 profile 借。它们今天都还在，但**同样的风险依然存在** —— 只是这次没轮到它们。要彻底自包含，得把它们全装进插件目录，那是另一个量级的体积与维护成本 |
| **飞书扫码/收信未做真实连网验证** | 本机没有可用的飞书 App 凭据。已验到的是：SDK 能加载、`registerApp` / `WSClient` 都是 function、`/qr/capabilities` 回 `available:true`。真去扫一次、真去收一条，这一步没做 |
| **`requireDep` 对纯 ESM 包会抛** | 它只能同步 require；纯 ESM 包走不同步，所以它会抛一个说明清楚的错误。目前没有人用 `requireDep` 加载纯 ESM 包（那几处都走 `loadDep`），所以没影响，但**别拿去加载** |


### 14.32 流式可编辑消息：一条消息反复改，长回答不再刷屏（v0.32.0）

> 一句话：**先发一条「正在处理…」，之后按节流改写同一条，定稿时把剩下的段落另发**。适用于长回答、跑很久的任务、需要边想边给结果的场景。

#### 14.32.1 为什么做这件事

在 v0.32.0 之前，push-hub 只有两种发送方式：

1. **一次性发完** —— 文本按 `MAX_CHARS` 切块，一块一块发出去。回答长的时候，聊天窗口被十几条消息刷屏。
2. **发完再改** —— v0.29.0 的 `editMessage` 能改一条已发出的消息，但那是「事后修改」，发送的那一刻你还不知道正文是什么。

中间缺的是「发送过程中」这一段：**正文还没定，但用户需要立刻看到反馈**。没有它，用户面对的是几秒钟到几分钟的空白；有了它，用户看到文字在长出来。

这三段正好补成了一个完整生命周期：

| 阶段 | 能力 | 版本 |
|---|---|---|
| 发送中 | `openStream` / `updateStream` / `finishStream` | v0.32.0 |
| 发送后（留痕） | `lib/outbox.js` 发件箱 | v0.28.0 |
| 发送后（改 / 撤 / 表情） | `lib/edits.js` + `lib/reactions.js` | v0.29.0 / v0.30.0 |

#### 14.32.2 只有四个通道能流

流式消息的前提是「能改自己刚发的那条」。所以 `STREAM_CHANNELS` **直接从 `EDIT_CHANNELS` 派生**，不另抄一份名单：

```js
export const STREAM_CHANNELS = Object.freeze([...EDIT_CHANNELS])  // lib/stream.js:36
```

这样做的理由很直接：**名单抄两份，迟早有一份过期**。哪天 `EDIT_CHANNELS` 加了飞书，`STREAM_CHANNELS` 忘了改，界面就会给一个「点了必然报错」的按钮 —— 这条纪律在 v0.29.0 与 v0.30.0 都踩过同一次。

八家做不了的原因写在 `NO_STREAM_REASON` 里，前七条直接引用 `NO_EDIT_REASON` 的同名字段（原因本来就一样），只有邮件单写一条：

| 通道 | 原因 |
|---|---|
| feishu | 飞书官方有 PATCH 改消息的接口，但本机无凭据实测过它的参数形态，暂时不做（宁可没有，也不要一个按下去必然报错的按钮） |
| qq | 官方没有编辑已发消息的接口 |
| wechat | 微信没有编辑接口 |
| synology_chat | 群晖只有 webhook，发出去就管不了 |
| dingtalk | 钉钉没有编辑消息的接口 |
| wecom | 企业微信群机器人没有编辑接口 |
| wecom_app | 企业微信自建应用没有编辑接口 |
| email | **邮件发出去就到对方信箱了，没有「改一封已经投递的邮件」这回事** |

#### 14.32.3 四条必须做对的纪律

这四条写进了 `lib/stream.js` 的模块头注释，因为每一条弄错都会让「流式」比「不流式」更难看。

**① 必须节流。** 平台对编辑同一条消息有频控：Telegram 大约 1 次/秒/聊天，Slack 的 `chat.update` 是 Tier 3。每来一个字就 `edit` 一次，必然被限流；被限流后界面停在半句话上，比根本不做流式还糟。默认间隔 `DEFAULT_INTERVAL_MS = 900`，下限 `MIN_INTERVAL_MS = 300`，上限 `MAX_INTERVAL_MS = 10000`。

```js
export function normalizeInterval(input) {
  // 返回 { ok, ms, detail }
  // 非数字 → 按默认 900
  // < 300 → 夹到 300，detail 写「间隔 N 毫秒太密，按下限 300 毫秒走」
  // > 10000 → 夹到 10000
  // 静默改值会骗人，所以夹了必回 detail
}
```

**② 同一时刻只有一个 edit 在飞。** 上一条还没回就发下一条，回来顺序不保证；后发先到会让界面**退回**旧文本然后卡住。所以所有 `edit` 走同一条 Promise 链：

```js
function enqueue(task) {
  chain = chain.then(task).catch((err) => {
    failures.push({ at: Date.now(), detail: String(err?.message ?? err).slice(0, 200) })
    onLog('warn', ...)
  })
}
```

**③ 中途失败不能中断流。** 单次 `edit` 挂了（网络抖动、平台 5xx）只记账，继续收后续文本，定稿时再试。把「一次编辑失败」升级成「整条流废掉」是过度反应。

**④ `finish` 必须幂等。** 第二次调用原样返回第一次的结果，不重复发余块。调用方（工具 / HTTP 路由）可能在重试，重复发是用户能直接看到的错。

#### 14.32.4 分块规则：流式与普通发送必须同一套

`splitBlocks` 来自 `lib/text.js`（v0.11.0 起就有），普通发送与流式共用。**流式只在「首块」上做编辑，余块定稿时才发**：

```js
export function planChunks(split, text, limit) {
  const chunks = split(text, limit)
  return { first: chunks[0] ?? '', rest: chunks.slice(1) }
}
```

为什么只编辑首块：**一条消息改内容能改，但改不了长度上限**。超出 `MAX_CHARS` 的部分必须在定稿时作为新消息发出去。四家的 `MAX_CHARS` 差别很大 —— telegram 4096 / slack 3800 / discord 1900 / matrix 30000 —— 所以 `limit` 从通道模块取，不写死。

#### 14.32.5 五个 API

调度层在 `lib/bus.js`，`index.js` 只做薄薄一层转换。

| 函数 | 位置 | 作用 |
|---|---|---|
| `openStream(cfg, input)` | `lib/bus.js:851` | 开一条流，返回 `{ ok, streamId, messageId, intervalMs }` |
| `updateStream(streamId, text)` | `lib/bus.js:924` | 送一份进度快照（合并刷新，不是立刻发） |
| `finishStream(streamId, text)` | `lib/bus.js:938` | 定稿，发余块，从活动列表移除 |
| `cancelStream(streamId)` | `lib/bus.js:952` | 放弃（**已发那条留在那里**，不删） |
| `listStreams()` | `lib/bus.js:961` | 当前活动流 + 能力表 + 八家原因 |

HTTP 路由（`lib/index.js`，全部插在 `/reply/channels` 之前）：

| 方法 | 路径 | 入参 |
|---|---|---|
| GET | `/send/stream/list` | — |
| POST | `/send/stream/open` | `channel` / `initialText` / `intervalMs` / `account` / `chatId` |
| POST | `/send/stream/update` | `streamId` / `text` |
| POST | `/send/stream/finish` | `streamId` / `text` |
| POST | `/send/stream/cancel` | `streamId` |

工具（`ctx.tools.register`，编号 11–13）：`push_hub_stream_open` / `push_hub_stream_update` / `push_hub_stream_finish`。

#### 14.32.6 上限与回收

| 常量 | 值 | 为什么 |
|---|---|---|
| `MAX_ACTIVE_STREAMS` | 64 | 满时 `open` 返回 `ok:false` 并说明当前几条，不静默丢弃 |
| `STREAM_TTL_MS` | 30 分钟 | 开了流却忘了定稿，会把消息永远停在「正在处理…」 |

`createStreamHub().sweep()` **本模块不开定时器**，由调用方择机调，返回被掐掉的流 id 数组。理由与 v0.31.0 的 `sleep` 一致：**库不该自己制造后台定时器**，那会让进程无法自然退出，也让人不知道谁在跑。

#### 14.32.7 界面

左侧栏新增「流式会话」一项（`EXTRA_NAV` 的 `stream` 键）。它是**只读**的：

- 「开一条流」在界面上没有意义 —— 没有东西往里送进度，开了只会停在「正在处理…」。
- 但得让人看见**现在有几条在跑**、每条改了几次、失败了几次。

每行显示：`streamId` / 状态（新开 / 开流中 / 进行中 / 已定稿 / 已放弃 / 失败）/ 开启时间 / 「改过 N 次，收过 N 份进度」，`failures > 0` 时追加「失败 N 次」。底部汇总当前能流的四个通道，以及八家做不了的原因。

#### 14.32.8 实测命令

```powershell
# 1) 看版本（第一次常返 applying，等 5-7 秒再调一次）
node -e "fetch('http://127.0.0.1:3082/@duma520/dsh-push-hub/api/info').then(r=>r.json()).then(j=>console.log(j.version))"

# 2) 看能力表与当前活动流
node -e "fetch('http://127.0.0.1:3082/@duma520/dsh-push-hub/api/send/stream/list').then(r=>r.json()).then(j=>console.log(j.channels, j.size))"
```

```js
// 3) 开一条流（telegram 有账号时）
fetch('http://127.0.0.1:3082/@duma520/dsh-push-hub/api/send/stream/open', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ channel: 'telegram', initialText: '正在处理…' })
}).then(r => r.json()).then(j => console.log(j.streamId, j.messageId))
```

#### 14.32.9 已知边界

1. **只四个通道**。飞书那家没实测过参数形态，宁可没有。
2. **首块被编辑、余块另发**。超长回答定稿时仍然是多条消息，只是比一次性发完少了中间过程。
3. **流在内存里**。进程重启后活动流全丢，`updateStream` 会返回 `ok:false` 并说明「可能已经收尾，或进程重启过」。
4. **`cancel` 不删消息**。已发那条留在那里，删是 `deleteMessage` 的语义。
5. **`sweep()` 要调用方择机跑**。`bus.js` 目前没有为它开定时器 —— 这是个已知的未做完处，与「库不自己制造后台定时器」的纪律相冲突，留待后续判断。

### 14.33 进度表情：一条消息挂一个状态符号（v0.33.0）

#### 14.33.1 为什么做这件事

在 v0.33.0 之前，一条消息的可见生命周期只有两端：

| 阶段 | 有什么可观察的信号 | 对应版本 |
|---|---|---|
| 发送前 | 分块预览（dry_run） | v0.06 起 |
| 发送中 | 一条消息反复改正文 | v0.32.0 流式 |
| **发送后** | **什么都没有** | —— |
| 发送后改 / 撤 / 加表情 | 手动动作 | v0.29.0 / v0.30.0 |

第三行那个空档是最难受的：消息发出去了，接下来跑了几分钟，用户只能盯着那条静止的消息猜「它还在干活吗」。dsh-im 用 status-reaction.mjs 填的就是这个空档 —— 先在消息上挂一个「进行中」，跑完换掉。

#### 14.33.2 只有四个通道能挂

PROGRESS_CHANNELS 是 Object.freeze([...REACTION_CHANNELS]) —— **从能加表情的名单派生，不另抄一份**。

理由和 v0.32.0 的流式一样：能挂进度符号的前提就是能给这条消息加表情。名单一旦分叉，就必然有一条路是死的（要么「能挂进度」的通道加不上表情，要么反过来），而探针也测不出来。

八家不能在 NO_PROGRESS_REASON 里各写平台级原因：

| 通道 | 原因 |
|---|---|
| feishu | 飞书开放平台没有「给消息加表情回应」的接口（本机也没飞书凭据实测过） |
| qq | QQ 机器人开放接口没有表情回应能力 |
| wechat | 微信通道连发送都恒返 ret=-2（服务端故障），谈表情没有意义 |
| synology_chat | 群晖 Chat 只有 webhook 送出，回包不带消息 id |
| dingtalk | 钉钉群机器人只有 webhook，没有表情回应接口 |
| wecom / wecom_app | 企业微信机器人只有 send，没有 reaction |
| email | 邮件没有「给一封已经投递的信加个表情」这回事；发送结果看返回的 messageId 与日志 |

#### 14.33.3 三条纪律（每条都对应一个真实会踩的坑）

写进 lib/progress.js 头注释的那三条：

**① best-effort，绝不影响发送结果。** 消息已经到对方手机上了，表情挂不上是小事。把「加表情失败」升级成「发送失败」的后果是：用户以为没发出去，然后重发一遍 —— 对方收到两条。所以 lib/bus.js 里 beginProgress 失败时只在结果里加 progressId 空串与 progressDetail，base.ok 原样保留。

**② 同一时刻只有一条 transition 在飞。** 换一个表情是两步：先摘旧的、再挂新的。并发发出去会出现两种坏结果 —— 「旧的摘了新的没挂上」（界面上什么符号都没有，比不挂更让人困惑）或「同时挂着两个」（一条消息两个符号）。落点是一条 Promise 链：

```js
const transition = (emoji) => {
  chain = chain.then(async () => {
    if (current !== "") { const previous = current; current = ""; await safely("remove", previous) }
    if (emoji === "") return
    const outcome = await safely("add", emoji)
    if (outcome.ok === true) current = emoji
  })
  return chain
}
```

**③ 终态只能进一次。** 调用方重试是常态，重复 finish 会来回改表情 —— 用户看到「成功」被改回「进行中」，比根本不挂更糟。落点是 closedResult：第二次 finish 原样返回第一次的对象，一次 provider 调用都不发。

#### 14.33.4 一个容易崩的写法：finish 里不能用 this

```js
// 错误：调用方写 const { finish } = p 时，this 是 undefined，直接崩
closedResult = { ok: true, stats: this.stats }

// 正确：先取局部快照
closedResult = { ok: true, stats: { added, removed, errors: errors.length, status, emoji: current } }
```

这不是理论问题 —— 施工时第一版就是这么写的，scaffold/_tprog.mjs 一跑就崩。把方法解构出来单独传是 JS 里太常见的用法，任何用到 this 的方法都该先问一遍「它会不会被解构」。

#### 14.33.5 五个 API + 三条路由 + 三个工具

| 导出 / 路由 / 工具 | 作用 | 返回 |
|---|---|---|
| beginProgress(cfg, input) | 挂「进行中」 | {ok, detail, progressId, emoji, emojis, channel, account, messageId} |
| endProgress(progressId, outcome) | 收尾 | {ok, detail, progressId, emoji, stats, failures} |
| listProgress() | 看还挂着哪些 | {ok, channels, reasons, items, size} |
| POST /send/progress/begin | 同上（HTTP） | 200 / 502 |
| POST /send/progress/end | 同上（HTTP） | 200 / 502 |
| GET /send/progress/list | 同上（HTTP） | 200 |
| push_hub_progress_begin | 同上（工具） | JSON 字符串 |
| push_hub_progress_end | 同上（工具） | JSON 字符串 |
| push_hub_progress_list | 同上（工具） | JSON 字符串 |

另外 push_hub_send 与 POST /send 都多了 progress / emojis 两个入参 —— 一步做完，不用发一次再挂一次。

#### 14.33.6 outcome 的三种取值不能合并
### 14.34 进度表治理：超时的自己清掉，重启过还能收尾（v0.34.0）

#### 14.34.1 为什么做这件事

v0.33.0 把「发送后那一段」填上了，但进度表本身没有任何治理。三条实证的漏洞：

| 漏洞 | 证据 | 后果 |
|---|---|---|
| 挂上去的不会自己消失 | `/send/progress/list` 上真挂着 `{id:'pgmwm27iit-1', channel:'telegram', messageId:'999999', status:'running', emoji:''}` | 忘了 `end` 的那条，用户看到一条永远「在跑」的消息 |
| 表只增不减 | `PROGRESS_HUB` 是 `new Map()`，唯一的 `delete` 在 `endProgress` 里 | 挂够 64 条就再也挂不上，只能重启进程 |
| 重启即失忆 | 进度只活在内存的 Map 里 | 重启前挂的 ⏳ 永远摘不掉，连 id 都查不到 |

这一版就补这三条：**TTL 自动清**、**上限说清楚**、**落盘跨重启**。

#### 14.34.2 TTL 是 30 分钟，和流式一致

`PROGRESS_TTL_MS = 30 * 60 * 1000`，与 `lib/stream.js` 的 `STREAM_TTL_MS` 取同一个数。理由不是「抄一个省事」，而是这两个东西描述的是同一种情况：一条长任务最多跑多久。半小时还没收尾的进度，真实含义是**调用方忘了**，不是「任务还在跑」——真有跑半小时的任务，调用方应该在中间持续轮询并更新，而不是挂上就不管。

`MAX_ACTIVE_PROGRESS = 64` 同样是探测阈值不是性能上限：正常用不到两位数，能堆到 64 说明有东西在漏。撞上限时的文案直接点明这个意思 —— 「同时最多挂 64 条进度表情，先把不用的收尾掉（当前 N 条，大多是忘了 end 的）」。

#### 14.34.3 清理用纯函数算，不开定时器

```js
export function expiredIds(records, ttlMs = PROGRESS_TTL_MS, now = Date.now()) {
  const edge = now - (Number.isFinite(ttlMs) ? ttlMs : PROGRESS_TTL_MS)
  const out = []
  for (const one of Array.isArray(records) ? records : []) {
    const at = Number(one?.createdAt)
    if (!Number.isFinite(at) || at <= 0) continue   // 没有时间的不算超时：宁可留着，不可误删
    if (at < edge) out.push(String(one.id))
  }
  return out
}
```

三个参数全可注入（`records` / `ttlMs` / `now`），探针用固定时钟 `NOW = 1700000000000` 就能测完三条分支：超时被掐、没超时不掐、没有 `createdAt` 的不算。真开一个 `setInterval` 去扫的后果是：既测不了（要真等 30 分钟），又得管它的生命周期（进程退出前要 clear，忘了就泄漏）。

清理时机沿用 v0.33.0 给流式定的规矩 —— **读列表时顺手清**。`listProgress()` 与 `beginProgress()` 都先 `sweepProgress()`。前者的意思是「你看到的数字就是清理后的真实数字」，后者是为了在挂新的一条之前先把位置腾出来。

#### 14.34.4 落盘解决的是收尾，不是「状态机复活」

必须先把话说清楚：`progress.json` 落的是**待办清单**，不是完整状态。跨重启能恢复的只有「这条还挂着、id 是什么、该摘哪个表情」，恢复不了的是「凭据」与「中间 transition 计数」。

所以恢复出来的状态机，两个注入函数都是这样：

```js
createProgress({
  messageId: one.messageId,
  emojis,
  initialEmoji: one.emoji,          // 关键：直接就是 running，不会再挂一次
  addReaction: async () => ({ ok: false, detail: '进程重启过，缺账号凭据…' }),
  removeReaction: async () => ({ ok: false, detail: '进程重启过，缺账号凭据…' }),
})
```

`endProgress` 对这类条目会在 detail 里补一句「这条是重启前挂的，凭据已失效，只能按记录摘」。**不假装能恢复得和没重启一样** —— 那会让调用方以为重启后还能正常换表情，然后收到一串失败的 failures。

#### 14.34.5 initialEmoji 为什么不能省

恢复时如果按默认走（`status` 从 `new` 起步），`finish` 的语义是「挂成功表情」，于是平台上会先留着原来那个 ⏳、再挂一个 ✅ —— 一条消息两个符号。传了 `initialEmoji` 之后，状态机一上来就是 `running` 且 `current` 就是它，`finish` 走的是「先摘旧的、再挂新的」，符号数始终是一个。

这条与 v0.33.0 的 `transition` 是同一个机制，但触发路径完全不同（一个来自正常 start、一个来自磁盘恢复），所以恢复路径必须单独测 —— 探针 J 段里 `restored` 那条断言查的就是 `status === 'running'` 与 `emoji === 'P'`。

#### 14.34.6 五个导出 + 一次缓存栅栏

| 导出 | 返回 | 谁用 |
|---|---|---|
| `MAX_KEEP = 200` | 数字 | 落盘文件最多留多少条（与 outbox 的 500 不同：进度是待办，200 已经远超正常量） |
| `PROGRESS_PATH` | 绝对路径 | `~/.dsh/dsh-push-hub/progress.json` |
| `readProgressStore(filePath?)` | `{ok, records, detail}` | 读坏 / 不存在 / 结构不对一律回空表，**永不抛** |
| `writeProgressStore(records, filePath?)` | `{ok, detail}` | `mkdir -p` → 写 `.tmp-<pid>`（mode `0o600`）→ `rename` 原子替换 |
| `upsertRecord` / `removeRecord` | 新数组 | 纯函数，不改入参 |

`DSH_PUSH_HUB_PROGRESS_PATH` 环境变量可以覆盖路径 —— 探针跑测试不污染真实文件，同时这也是唯一能让「重启」在同一个进程里被测出来的办法（见 14.34.7）。

#### 14.34.7 一个实际踩到的坑：单次栅栏让跨重启路径测不到

`ensureProgressRestored()` 用 `restoredOnce` 做栅栏，只读一次盘 —— 这是对的，每次挂表情都读一遍盘是白费。但它带来一个副作用：**同进程里第二次调用不会再读**，而探针和被测代码本来就跑在同一个进程里，于是「重启后恢复」这条路径永远返回 `size 0`。

第一版真跑就是这么挂的：

```js
// 错误：写完文件再 list，读到的是第一次的缓存（空）
await writeProgressStore([rec], file)
console.log((await bus.listProgress()).size)   // 0 —— 看起来像恢复功能坏了
```

修法是加一个只给测试用的钩子：

```js
export function __resetProgressCache() {   // 双下划线，与 receiver.js 的 __test 同一套约定
  PROGRESS_HUB.clear(); PROGRESS_RECORDS = []; restoredOnce = null; progressCounter = 0
}
```

教训比这个 bug 本身重要：**任何「只做一次」的缓存都必须配一个测试钩子**，否则依赖它的分支在自动化里就是不可达的。真实进程不需要这个钩子 —— 重启天然就是新进程。

#### 14.34.8 接口变化：listProgress 变成 async

因为它现在要先读盘恢复、再顺手清超时，两件事都是 `await` 的。三处调用点全部跟着改了：

| 位置 | 改动 |
|---|---|
| `lib/index.js` 路由 `/send/progress/list` | `sendJson(res, 200, await bus.listProgress())` |
| `lib/index.js` 工具 `push_hub_progress_list` | `JSON.stringify(await bus.listProgress(), null, 2)` |
| `scaffold/probe_progress.mjs` E4 | `const e4 = await bus.listProgress()` |

返回体多了三个字段：`swept`（这次顺手清掉的 id 数组）、`maxActive`（64）、以及每条 item 上的 `restored` 与 `ttlMs`。界面据此显示「，**重启前挂的**」与「，还有 N 分钟会被自动清掉」。

#### 14.34.9 实测命令

```powershell
cd <插件根目录>\dsh-push-hub
node scaffold/probe_progress.mjs
```

期望：PROGRESS_OK  进度表情 116 项断言全通过（原 92 + 落盘与 TTL 的 J 段 24）。

落盘与 TTL 单独跑一遍：

```powershell
node -e "import('./lib/progressstore.js').then(m=>{console.log(m.MAX_KEEP, m.PROGRESS_PATH.endsWith('progress.json'))})"
```

期望：200 true。

```powershell
node -e "import('./lib/progress.js').then(m=>{const NOW=1700000000000;const r=[{id:'a',createdAt:NOW-1000},{id:'b',createdAt:NOW-9000000},{id:'c'}];console.log(m.expiredIds(r,1800000,NOW).join())})"
```

期望：b（没有 createdAt 的 c 不算超时）。

#### 14.34.10 已知边界

| 边界 | 说明 |
|---|---|
| 重启后只能摘、不能挂 | 凭据不在内存里，恢复出来的状态机 `addReaction` 恒回失败。`endProgress` 能把它从记录里清掉，但清不掉平台上那个符号 —— 得人工去删，或者等平台自己过期（Telegram 的表情不会过期）。 |
| 中间计数不跨重启 | `stats.updates` / `stats.edits` 重启后从 0 起算。这份文件是待办不是历史，历史在 outbox。 |
| 落盘失败不重试 | `writeProgressStore` 出错只把 detail 拼进返回，不排队重试。理由：进度是锦上添花，为它搞一套重试队列不值得。代价是磁盘满的时候进度表会丢，重启后那些符号摘不掉。 |
| MAX_KEEP 200 会截断 | 超过 200 条时保留最近的 200 条（`slice(-200)`）。正常用不到两位数，真撞上说明有东西在大规模泄漏 —— 这时候丢老记录反而是对的。 |



| 传什么 | 挂什么 | 什么时候用 |
|---|---|---|
| success | ✅（Slack 是 white_check_mark） | 任务成功 |
| error 或**不传** | ❌（Slack 是 x） | 任务失败 |
| null | **什么都不留**，只把 ⏳ 摘掉 | 这条消息不该带任何状态 |

不传当失败、传 null 当清空 —— 这两个语义不能合并。一个是「跑完了但结果不好」，一个是「这条消息本来就不该有符号」。合并之后调用方就没法表达后者了。

#### 14.33.7 界面：这一页只做一件有用的事

lib/client.js 加了「进度表情」页，**只读**。挂与收尾都是发送方的动作，界面上开一个进度没有任何意义（没有东西去收它）。

但只读也得有 —— 它的用处是**发现忘了收尾的**。一条忘了 end 的进度会一直挂着 ⏳，用户看到的是一条永远「在跑」的消息。这一页把「通道 / progressId / 挂上时间 / 当前表情 / 挂了几次摘了几次」列出来，一眼就能看出哪条该收。

#### 14.33.8 实测命令

```powershell
cd <插件根目录>\dsh-push-hub
node scaffold/probe_progress.mjs
```

期望：PROGRESS_OK  进度表情 116 项断言全通过（v0.34.0 扩了 J 段 24 项）。

状态机单独跑一遍（看先摘后挂的顺序与幂等）：

```powershell
node -e "import('./lib/progress.js').then(async(m)=>{const c=[];const p=m.createProgress({messageId:'M1',emojis:{processing:'P',success:'S',error:'E'},addReaction:async(e)=>{c.push(['add',e]);return{ok:true}},removeReaction:async(e)=>{c.push(['del',e]);return{ok:true}}});await p.start();const a=await p.finish('success');const b=await p.finish('error');console.log(c.map(x=>x.join(':')).join('>'));console.log(a===b?'IDEMPOTENT_OK':'IDEMPOTENT_FAIL')})"
```

期望：add:P>del:P>add:S 然后 IDEMPOTENT_OK。

#### 14.33.9 已知边界

| 边界 | 说明 |
|---|---|
| Telegram 默认表情没实测 | ⏳ ✅ ❌ 是常理推断，不在它的 reaction 集里会回 ok:false 并记进 failures —— 不崩，但用户看不到符号。要稳妥就自己传三个已知可用的。 |
| progressId 不落盘 | 进程重启后老 id 全失效，endProgress 回「没有这条进度（可能已经收尾，或进程重启过）」。要跨重启收尾得把进度表落盘 —— **v0.34.0 已补上**（见 14.34；落盘解决的是收尾，不是状态机复活）。 |
| 只给首块挂 | 长消息分块后每块各有 id，只有第一块有符号。多块各挂一个符号反而更乱，所以选了后者。 |
| 状态机不碰网络 | lib/progress.js 没有任何 fetch / http.js 依赖，能力全靠注入。好处是探针能纯本地测完；代价是「这个通道到底支不支持某个表情」只有真发一次才知道。 |


### 14.35 每分钟发送配额：管的是块，不是次（v0.35.0）

#### 14.35.1 为什么做这件事

v0.34.0 修的是「忘了收尾」，这一版修的是「发得太快」。在此之前，唯一能控速的手段是账号级的 `chunkDelayMs`（块间隔）。它管的是**同一批块之间**等多久，管不了「一分钟内已经发了多少条」。

差别在哪儿，看一个具体场景就清楚：连着调 20 次 `push_hub_send`，每次正文都很短、**每次只有一块**。`chunkDelayMs` 是块与块之间的间隔，一次都没触发；而平台的每分钟配额早爆了。

| 手段 | 管的是什么 | 管不了什么 |
|---|---|---|
| `chunkDelayMs`（v0.17.0） | 同一批块之间的间隔 | 一分钟内一共发了多少条 |
| `perMinute`（v0.35.0） | 一分钟内最多发几块 | 块与块之间隔多久（那是 chunkDelayMs） |

两者是正交的：一个管「相邻多快」，一个管「总量多快」。以为调 `chunkDelayMs` 就能避开每分钟配额，是最容易犯的错 —— 因为它在最常见的用法（短消息、每次一块）里**一次都不会生效**。

#### 14.35.2 三条纪律

写进 `lib/ratelimit.js` 头注释，每一条都对应一个真会踩的坑：

1. **限流只让请求变慢，不让它失败。** 超配额的正解是等；真等不了（单次要等超过 60 秒）才报失败，而且**一块都不发**。发一半比不发更糟：用户既没收到完整内容，又白耗了配额，还得自己判断「到底发出去多少」。
2. **计数单位是「块」，不是「一次 send 调用」。** 切 5 块就是 5 次 API 调用。按调用计数会**低估 5 倍** —— 这是这一版最容易写错的地方。
3. **预约制不是检查制。** `take(n)` 把 n 个槽位压到未来，调用方 `sleep` 完直接发。检查制的经典 bug 是两个请求同时检查通过、然后一起发出去 —— 它只在并发下出错，本地一个人测永远测不出来。

第 3 条的具体形状：

```js
// 检查制（错）：同时进两个请求，都看到「还有空位」，然后一起发
if (used < perMinute) { used += 1; send() }

// 预约制（对）：槽位一压到未来就算用掉，后来的人看到的是压完之后的数
const at = now() + waitMs
for (let i = 0; i < want; i += 1) slots.push(at)
```

#### 14.35.3 配额怎么填：0 是「明确不限」

| 填什么 | 结果 | detail |
|---|---|---|
| 留空 / 空串 | 默认 15 条/分钟 | 空（不啰嗦） |
| `0` | **不限**，一次都不等 | 「该账号不限每分钟条数（填 0 即关闭）」 |
| `1`~`30` | 就是它 | 空 |
| `>30` | 夹到 30 | 「…真想关掉请填 0」 |
| 负数 / 非数字 | 回落 15 | 如实说「负数」「不是数字」 |

有两条不能省：**0 与「留空」必须是两种语义**（留空 = 用默认，0 = 明确关掉）；**任何夹值 / 回落都要回 `detail`**（静默改用户给的值会骗人，用户以为设了 99 就真是 99）。

30 这个上限不是平台真实配额，是**本插件愿意跑的最快速度**。写死在注释里，免得以后有人把它当成「Telegram 的官方上限」去引用。

#### 14.35.4 闸门只放一处，桶键必须是三元组

闸门函数 `gatedSend(mod, body, acc, options)` 只存在一份，被 `sendToTargets` 的三条扇出分支全走一遍：

| 分支 | 调用形状 |
|---|---|
| 零目标 | `await gatedSend(mod, body, acc, effective)` |
| 单目标 | `await gatedSend(mod, body, { ...acc, target: targets[0] }, effective)` |
| 多目标 | `await gatedSend(mod, body, { ...acc, target: t }, effective)` |

为什么不能四个调用方（send / sendOne / 流式开流 / 流式补发）各写一遍：**多写三处必然漏一处**，而漏的那一处平时不报错，只在被限流时才暴露 —— 那时候已经晚了。

桶键也不能只按通道算：

```js
// 错：同一个机器人往两个群发，两个群各有各的配额，合成一个桶会互相顶
const bucketKey = channel

// 对：通道 | 账号 | 目标 三元组
const bucketKey = channel + '|' + String(acc?.name ?? '') + '|' + String(acc?.target?.id ?? '')
```

合成一个桶的后果很具体：A 群刚发满 15 条，B 群明明一条没发也要跟着等 —— 用户看到的是「换个群发也被卡住」，完全找不到原因。

#### 14.35.5 一个必现的 bug：perMinute 1 且切 20 块

施工时真踩到的：

```js
// 错误：want > perMinute 时 overflow 必然大于 slots.length，slots[overflow - 1] 是 undefined
const overflow = slots.length + want - perMinute
const bottleneck = slots[overflow - 1]
waitMs = Math.max(0, Math.round(bottleneck + windowMs - now()))   // NaN
```

症状是 `take(20)` 返回 `{ ok: true, waitMs: NaN }` —— 调用方 `sleep(NaN)` 立刻返回（等于没等），于是**在超配额的情况下照发不误**。这是「限流器自己把限流放开了」，比不装限流器更糟：装了就以为有保护。

修法是算 `waitMs` **之前**先接住这种情况：

```js
if (want > perMinute) {
  blocked += 1
  return { ok: false, waitMs: windowMs, used: slots.length, perMinute,
    detail: '这条要切成 ' + want + ' 块，但配额是 ' + perMinute + ' 条/分钟 ——' +
            ' 永远发不完，一块都没发。请调高配额、或把分块长度调大让它少切几块。' }
}
```

切 20 块而配额 1 条/分钟，等多久都发不完 —— **如实拒比让调用方干等 20 分钟更诚实**，而且这也是 `overflow` 越界的唯一成因。

#### 14.35.6 刻意不落盘

限流窗口是**易失状态**，进程重启即清空 —— 这是正确行为，不是 bug。理由：

- 落盘会让「重启」变成一次绕过限流的机会，反而更危险；
- 限流窗口只有 60 秒，落盘再读回来的收益近乎为零；
- 写盘失败要不要判发送失败？判了就是「磁盘满导致消息发不出去」，不判就是白写一次盘。不值得。

同理，`LIMITERS` 这个 Map 也**不主动清桶**：清空窗口等于偷偷放宽限流。桶会随进程结束一起消失，这就够了。

#### 14.35.7 接口、字段与页面

| 类型 | 名字 | 说明 |
|---|---|---|
| 路由 | `GET /send/limits` | 返回 `{ ok, defaults, reasons, channels, buckets, size }` |
| 工具 | `push_hub_limits` | 同上，第 17 个工具 |
| 账号字段 | `perMinute` | 高级分组，`type: 'number'`，placeholder 写明 0 = 不限 |
| 页面 | 设置页「发送配额」 | 只读：哪些通道适用、默认多少、各桶已用几条 |

页面必须有的理由：配额是**悄悄生效**的 —— 用户只会感觉「怎么变慢了」，不会感觉「我被限流了」。没这一页，他能找到的唯一旋钮是 `chunkDelayMs`，而那是块间隔、调它没用，越调越困惑。

#### 14.35.8 实测命令

```powershell
cd <插件根目录>\dsh-push-hub
node scaffold/probe_ratelimit.mjs
#    期望 RATELIMIT_OK  每分钟配额 90 项断言全通过

node -e "fetch('http://127.0.0.1:3082/@duma520/dsh-push-hub/api/send/limits').then(r=>r.json()).then(j=>console.log(j.size,j.defaults.perMinute,j.channels.length))"
#    期望 0 15 11
```

#### 14.35.9 已知边界

| 边界 | 说明 |
|---|---|
| **30 条/分钟不是平台真实上限** | 是本插件愿意跑的最快速度。Telegram 的真实配额按聊天算、且随账号权重浮动，写死一个「官方值」反而会误导。 |
| **只在同一进程内计数** | 重启清空。多进程部署（同机起两个宿主）会各自记账，合起来可能仍超平台配额。 |
| **email 不适用** | 一次 `send` 就是一封、且不分块，平台限制的是每天几百封这种量级。用每分钟配额去卡它反而会挡住正常的日报。 |
| **超配额时阻塞的是调用方** | `sleep` 在请求链路里。工具调用会变慢（最长 60 秒），不是后台排队 —— 没有队列，也不打算加。 |
| **桶只在第一次发送时创建** | 没发过的目标不会出现在 `/send/limits` 里。这不是遗漏：没有用量就没有可看的数字。 |

### 14.36 入站附件下载：句柄、上限、清理（v0.36.0）

#### 14.36.1 一句话

对方发来的图片 / 文件 / 语音，真的落到你自己硬盘上了 —— 不再是收件箱里一行「一张图 12.3 KB」的文字。

#### 14.36.2 为什么 v0.27.0 只记不取，这一版才敢取

v0.27.0 把十个平台的附件形状统一记了下来，头注释里写得很明白：

> **刻意不做下载**：拉附件要处理单个文件上限、落盘路径、清理策略、凭据泄漏（Slack 的 url_private 带 token），这些是另一个量级的事。本轮只做「记录」。

那三条理由今天依然成立，只是现在有答案了：上限做成配置（10 MB 默认 / 0 关闭）、落盘路径固定 `~/.dsh/dsh-push-hub/files/<日期>/`、清理两轮（天数 + 总量）、凭据**根本不落盘**（下面 14.36.4 详述）。

但真正拦住的不是这三条，是第四件当时没注意的事：**句柄被丢了**。

旧的 `compact()` 这样收尾（`lib/attachments.js:63` 附近）：

```js
const out = []
for (const one of list) {
  const name = String(one?.name ?? '')
  const mediaType = String(one?.mediaType ?? '')
  const size = Number(one?.size) > 0 ? Number(one.size) : 0
  if (name === '' && mediaType === '') continue
  out.push({ kind: one.kind, name, mediaType, size })
  if (out.length >= MAX_ATTACHMENTS) break
}
```

四个字段进、四个字段出。Telegram 的 `file_id`、Slack 的 `url_private_download`、Discord 的 `url`、Matrix 的 `mxc://…`、飞书的 `file_key` —— 一个都没留下。等到你想下载的时候，手上只有一个文件名，没有任何能定位到文件的东西。

这不是「补一个字段」那么简单：**这些句柄里有一半是秘密**。所以这一版先做的是「保留，但只保留不危险的部分」。

#### 14.36.3 handle 长什么样

每个附件项多一个 `handle` 字段，`type` 决定谁来下载：

| type | 关键字段 | 还留着什么 | 秘密怎么处理 |
| --- | --- | --- | --- |
| `telegram` | `fileId` `fileName` | file_id（本身不是凭据） | token 在 `fetchTelegram` 里现取 |
| `slack` | `id` `fileName` | 文件 id | `url_private_download` **被剥掉**，下载时由 `fetchSlack` 用 `acc.botToken` 重新拼 |
| `discord` | `id` `fileName` | 附件 id | `url` **被剥掉**，它是限时签名 |
| `matrix` | `mxc` `fileName` | `mxc://server/mediaid`（不是凭据，是资源坐标） | accessToken 在 `fetchMatrix` 里现取 |
| `feishu` | `messageId` `fileKey` 或 `imageKey` `kind` | 两个都要，缺一个下不了 | tenant token 在 `fetchFeishu` 里现换 |
| `email` | `buffer` | 文件本体已在内存 | 不走网络 |
| `none` | `reason` | 一句话原因 | —— |

`safeHandle()` 干的就是这件事：只留白名单键（`type` / `fileId` / `id` / `mxc` / `fileKey` / `imageKey` / `messageId` / `reason`），再补一个 `downloadable: true|false`。

#### 14.36.4 两条铁律

**第一条：不落盘秘密。**

`appendMessage` 会把 `attachments` 原样写进 `~/.dsh/dsh-push-hub/inbox.json`。也就是说，凡是留在 handle 里的东西，最终都会变成硬盘上的明文。Slack 的 `url_private_download` 长这样：

```text
https://files.slack.com/files-pri/T01ABCDEF-F01XYZ/download/report.pdf
```

它本身不带 token —— token 要**另外**放 `Authorization` 头。所以严格说它不是凭据。但它是「不需要鉴权就能被识别出属于哪个 workspace、哪个文件」的定位串，而且一旦有人把 `inbox.json` 发给别人（做故障排查很常见），里面就多了一串能直接定位到你工作区文件的 URL。Discord 的 `url` 更糟：CDN 签名带 `?ex=…&is=…&hm=…`，四小时过期，但四小时内拿到就是拿到。钉钉的 `downloadCode` 是一次性票据，用完即弃，写进硬盘纯属给自己埋雷。

结论：**能重新算出来的，就不要存**。Slack 的 URL 由「文件 id + botToken」算出来，那就存 id；Discord 的 URL 在拿到消息那一刻就在 `message.attachments[].url` 里，用它现取即可；Matrix 的 `mxc://` 是**资源坐标**不是凭据，可以存 —— 访问它仍然需要 accessToken。

**第二条：取不到就如实标记。**

| 通道 | 为什么下不了 |
| --- | --- |
| QQ | 官方要求 5 分钟窗口内主动拉，过期链接失效；本插件不是常驻拉取进程 |
| 钉钉 | 只给 `downloadCode`，要调 `robot/messageFiles/download` 换临时 URL，本轮不做 |
| 企业微信（智能机器人） | 平台链路本身推不了文件，不是我们没实现 |
| `none` | 兜底：未知形状一律标这一档 |

这四档在界面上跟「下载失败」是**两回事**：前者重试一万次也没用，后者过一会儿可以重试。混在一起会让用户以为网络不稳定，去反复点。

措辞上刻意不用「平台不给」这个说法，因为它对 QQ 与钉钉**不是事实**：

| 通道 | 准确说法 |
| --- | --- |
| QQ | 平台**给**接口（`getFile`），但只有 5 分钟窗口 —— **本轮主动没做** |
| 钉钉 | 平台**给**接口（`downloadCode` 换临时 URL）—— **本轮主动没做** |
| 企业微信（智能机器人） | 回调里没有 `media_id`，**链路本身不给**，换谁来写都拿不到 |

所以 `NO_DOWNLOAD_REASON` 里写的是「这条本轮没做，所以取不到」而不是「平台不给」。既不夸大平台的限制，也不用「暂不支持」敷衍。
#### 14.36.5 三条纪律（写进 lib/download.js 头注释）

**① 下载失败不影响收消息。**

`downloadAll()` 逐条吞异常。最坏情况是所有附件都带 `download.state = 'failed'` 落盘，但**消息本体一个字不少** —— 文本、来源、时间全都照常进收件箱。理由很直白：用户最需要的是「有人给我发了东西」，附件能不能取是第二位的。把下载失败升级成收消息失败，等于因为一张图没下来就把那条通知也弄丢了。

**② 上限在传输层生效，不是事后检查。**

```js
// lib/download.js 的 saveAttachment 里，先比声明大小
const declared = Number(item?.size) > 0 ? Number(item.size) : 0
if (maxFileMB > 0 && declared > maxFileMB * 1024 * 1024) {
  return { ok: false, skipped: true, detail: '文件 ' + humanSize(declared) + ' 超过单文件上限 ' + maxFileMB + ' MB，没有下载' }
}
```

「先下完再检查大小」等于把 500 MB 拉进内存、拉完再告诉你超限了 —— 白耗流量、白占内存、还真有可能把进程弄崩。声明大小不一定是真的（平台可以撒谎），所以**声明值过了这道闸之后，传输层还有第二道**：

```js
// lib/http.js 里 viaProxy 的 data 事件
total += chunk.length
if (maxBytes > 0 && total > maxBytes) {
  response.destroy()
  finish({ status: 200, body: '', bytes: null, tooLarge: true })
  return
}
```

`direct()` 走全局 fetch，靠 `content-length` 先看、`binary` 时用 `arrayBuffer()` 收。两条路都加上了 `binary` 与 `maxBytes` 参数，默认 `binary=false` —— 12 个通道发消息全走文本，改默认值会波及所有既有调用。

**③ 落盘文件名不信任平台。**

```js
// 实测值
safeName('../../etc/passwd')  // '_._etc_passwd'
safeName('a:b*c?.pdf')        // 'a_b_c_.pdf'
safeName('')                  // 'attachment'
safeName('图片 一.jpg')        // '图片 一.jpg'（中文与空格保留）
```

洗掉 `\ / : * ? " < > |` 与控制符、折叠连续 `..`、去前导点、截 120 字。`../../etc/passwd` 变成 `_._etc_passwd`，即使有 bug 也穿越不出去。中文与空格**不洗** —— 洗了反而让用户看不懂自己存的什么。

#### 14.36.6 三个策略点与两轮清理

三值都放**配置顶层**（`config.DOWNLOAD_KEY = 'download'`），不放账号层。理由：这是「本机硬盘怎么用」，不是「某个通道的偏好」。放账号层意味着 12 个通道各配一遍，而你只有一块硬盘。

| 键 | 默认 | 范围 | 0 的含义 | 超范围怎么处理 |
| --- | --- | --- | --- | --- |
| `maxFileMB` | 10 | 0–200 | 不限（多大都下） | 夹到范围内，**必回 detail** |
| `retainDays` | 7 | 0–365 | 不按天数清 | 夹到范围内，**必回 detail** |
| `maxTotalMB` | 200 | 0–10240 | 不限总量 | 夹到范围内，**必回 detail** |

归一化函数的三种语义**不合并**：留空 → 默认；`0` → 明确关闭（唯一关掉的写法）；数字 → 夹值且**夹值必回 detail**（静默改用户给的值会骗人）。合法值（含 0）的 `detail` 恒为空串，不啰嗦。非数字回默认并带原值：

```text
normalizeMaxFileMB('abc')   -> { value: 10, detail: '单文件上限「abc」不是有效数字，已按默认 10 MB 处理。' }
normalizeRetainDays(-1)     -> { value: 7,  detail: '保留天数「-1」不是有效数字，已按默认 7 天处理。' }
```

清理是**两轮**，顺序不能换：第一轮按天数删过期，第二轮按总量从最老的删到不超限。

只做天数：一天收 500 MB，七天就是 3.5 GB，天数管不住。只做总量：十年前存的那个 1 KB 小文件也会被当成垃圾清掉，因为它「最老」。两轮一起才完整。删完顺手把空的日期目录清掉，免得 `files/` 下面堆一串空文件夹。

两个值填 0 时对应那一轮直接跳过 —— 用户明确关掉的策略不该被「顺手做一点」复活。

#### 14.36.7 五个平台怎么取 + 邮件为何不走网络

**Telegram（两步，不能省）**

```text
POST https://api.telegram.org/bot<token>/getFile   {"file_id": "..."}
  -> {"result": {"file_path": "photos/file_1.jpg"}}
GET  https://api.telegram.org/file/bot<token>/photos/file_1.jpg
```

`file_id` **不是 URL**，它是个不透明的标识，必须先用 `getFile` 换出 `file_path`，再拼到 `api.telegram.org/file/bot<token>/` 后面。而且那个 `file_path` **会过期**，所以换出来要立刻用。

**Slack（自己带 Bearer）** —— `url_private_download` 本身不带 token，必须自己加头 `authorization: Bearer <botToken>`。漏了这一步会拿到一个 200 状态、内容是 HTML 登录页的响应 —— 不是 401，所以不能靠状态码判断，得看 `content-type`。

**Discord（CDN 直取）** —— `cdn.discordapp.com` 的签名 URL 不需要鉴权头，直接 GET。签名四小时过期，所以实现里是「拿到消息时就地取」而不是「先存 URL 稍后再取」。

**Matrix（mxc -> HTTP）**

```text
mxc://example.org/AbCdEf123
  -> https://example.org/_matrix/media/v3/download/example.org/AbCdEf123?allow_redirect=true
```

`allow_redirect=true` 不能漏：很多 homeserver 把实际字节放在 S3 之类的后端，不给重定向就只回 302 而不跟。请求要带 `Authorization: Bearer <accessToken>`。

**飞书（先换 tenant token）**

```text
POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal
     {"app_id": "...", "app_secret": "..."}
  -> {"tenant_access_token": "t-..."}
GET  https://open.feishu.cn/open-apis/im/v1/messages/<message_id>/resources/<file_key>?type=image|file
```

这里刻意**没有**去导出 `lib/channels/feishu.js:52` 那个私有的 `tenantToken()`。理由：导它等于让 `channels/feishu.js` 承担「给 download 用」的额外职责，而这里只有一个 POST 要写。为省 8 行代码去动别人的导出面，是给自己未来埋一个耦合。

**邮件（不走网络）** —— `simpleParser(msg.source)` 已经把附件解成 Buffer 放在 `parsed.attachments[].content` 里了。再走一遍 HTTP 是绕远路。但也正因为如此，`forStore()` 必须把 Buffer 剥掉 —— 不剥的话 `inbox.json` 里会出现 Buffer 的序列化结果，几十 MB 的 JSON，下次读收件箱直接卡死。
#### 14.36.8 下载在接收链路里的位置

`lib/receiver.js` 的 `deliver(row)` 里，下载发生在 `appendMessage` **之前**：

```js
const withFiles = attachments.length === 0 ? attachments : await downloadAll(attachments, acc, policyOf())
appendMessage({ channel, account, from, text, at, kind, attachments: forStore(withFiles), raw })
```

顺序不能换。记录一旦写下去，这条消息在系统眼里就「已完成」了 —— 补下载得靠人回「入站附件」页点一下，而用户根本不会回来点。

`policyOf()` 每次重读配置**不缓存**：用户改完「单文件上限」应当立刻生效，而不是重启后才生效。读失败回 `{}`（走默认），不让一个配置读不出来就把整条消息堵死。

#### 14.36.9 补下为什么是「就地更新」

`lib/inbox.js` 新增 `updateAttachments(messageId, attachments, filePath)`，找到那条消息就改它的 `attachments` 字段，找不到回 `{ ok: false, total, detail: '这条消息已经不在收件箱里了' }`。

**不补写新消息**的理由：补写会让同一张图在收件箱里出现两次，用户会以为自己收了两遍。找不到 id 时**不静默成功** —— 静默成功会让界面显示「已补下」，然后清单里什么都没有，比报错更难查。

写盘前统一过一道剥 Buffer 的处理，跟 `forStore()` 是同一个目的。

#### 14.36.10 接口与页面

| 路由 | 方法 | 作用 | 关键返回 |
| --- | --- | --- | --- |
| `/receive/files` | GET | 列已落盘 + 带策略 | `{ ok, root, count, totalBytes, totalHuman, items:[{path,name,day,bytes,human,at}], policy }` |
| `/receive/files/policy` | GET / POST | 看 / 改策略 | `{ ok, maxFileMB, retainDays, maxTotalMB, notes }` |
| `/receive/files/sweep` | POST | 按策略清一次 | `{ ok, removed, freed, totalBytes }` |
| `/receive/files/fetch` | POST | 给某条消息补下 | `{ ok, messageId, done, failed }` |

`/receive/files` 把 `policy` 一起塞进返回体，是刻意的：分两次请求会让页面先渲染一个空目录、再蹦出文件，看起来像刚被清过一次。

`/receive/files/policy` 的 POST **只在真的给了那个键时才写**。不这么写的话，用户只改单文件上限，另两个会被当成 `undefined` 落盘成默认值 —— 表现为「我明明没动保留天数，它怎么回 7 了」。

前端 `lib/client.js` 加了「入站附件」页（`EXTRA_NAV` 的 `files` 项）：落盘路径与总量、三行磁盘策略（`min: 0`，`onChange` 立即 POST，没有保存按钮）、「按策略清理一次」、「刷新清单」、已下载清单、以及「这些通道不给文件本体」的说明段。

**三类状态在页面上必须分得开**：

| 状态 | 页面显示 | 用户该做什么 |
| --- | --- | --- |
| 取不到（none） | 具体原因（「本轮没做」还是「链路不给」） | 换通道让对方发，别重试 |
| 超了上限（skipped） | 「超过 X MB 没下」 | 调大单文件上限后补下 |
| 下载失败（failed） | 「下载失败」+ 平台错误 | 稍后补下（链接可能已过期） |

#### 14.36.11 已知边界

1. **只有 6 类能下**（telegram / slack / discord / matrix / feishu / email）。剩下四类如实标 `none`，但原因分两种：**企业微信智能机器人是链路本身不给**（回调没有 `media_id`）；**QQ 与钉钉是平台有接口但本轮主动没做**（QQ 只有 5 分钟窗口、钉钉要换一次性票据，都会拖长这版）。别把这两种混成一句「平台不给」（理由见 14.36.4）。
2. **Matrix 的 `allow_redirect=true` 不一定被所有 homeserver 支持**。不支持的会直接回字节而不是 302，两种都能处理；但如果某个 homeserver 既不给字节也不给重定向，就会失败 —— 这时 `detail` 里会有实际状态码。
3. **飞书资源 URL 需要 `message_id`**。所以飞书的附件在**收消息那一刻**才记得下 `messageId`，事后从别处拿不到。
4. **Telegram 官方限 20 MB**。补下时如果过了很久，`getFile` 会重新换一次，通常没问题；但 bot 不能下载超过 20 MB 的文件是平台硬限制，不是本插件的上限。
5. **落盘没有并发保护**。同一秒收到两个同名文件，后一个会覆盖前一个。实际发生率极低（同名且同秒），真要防需要加 `-1` `-2` 后缀 —— 留着，等真撞上再加。
6. **清理不会在后台自动跑**。它只在两处触发：收到新附件时（`downloadAll` 之前）与手动点「清一次」。没有常驻定时器，因为本插件不应该在你没开 DSH 的时候偷偷动硬盘。
### 14.37 长连接通道连没连上，看得出来（v0.37.0）

#### 14.37.1 一句话

**飞书连接是通的，界面却永远停在 `starting`** —— 这一版把「我连上了」这件事让 worker 自己说出来，而不是等第一条消息替它说。

#### 14.37.2 缺陷是怎么被发现的

不是读代码读出来的，是 v0.36.0 做真实执行验证时撞上的：启动飞书接收，`POST /receive/start` 回 200，`/receive/status` 显示 `state: 'starting'`；等了 2 分钟再查，还是 `'starting'`，`updatedAt` 停在 `2026-11-18T15:50:20.633Z` 一动不动。同一时间 telegram 与 wechat 已经变成 `'running'`。

第一反应是「飞书没连上」，去查 SDK 才发现连接是好的 —— SDK 的 `WSClient` 一直在正常收发心跳。问题出在**状态汇报**：`lib/receiver.js` 里唯一把状态推到 `running` 的地方是 `deliver()` 内部（`appendMessage` 成功之后），而 `deliver()` 只在收到消息时被调。于是长连接型通道在**收到第一条消息之前**永远是 `starting`，哪怕它连得再好。

为什么这不是小毛病：前端 `lib/client.js:2493` 的 `receivingOf` 判据是「status 里有没有非 stopped 的项」，所以 `starting` 与 `running` **在界面上显示成同一句话**（「正在收 · 已收 0 条 · 时间」）。唯一的区别是时间戳冻住不动 —— 而这个区别没人会盯着看。结果就是：图标写着「正在收」，实际可能根本没连上，你要等到对方发消息且没反应才知道。

#### 14.37.3 修法：给 worker.run 加一个可选回调

`runLoop` 调用 worker 的地方原本只有两样东西：

```js
const result = await worker.run(acc, { signal, onMessage: deliver })
```

加第三样：

```js
const result = await worker.run(acc, {
  signal,
  onMessage: deliver,
  onReady: () => setStatus(channel, accountName, { state: 'running', received, error: null }),
})
```

三个设计取舍：

1. **可选回调，不是必需**。`ctx.onReady?.()` 全部走可选链 —— 没实现它的 worker（以及将来新加的通道）行为与旧版一模一样。若做成必需，加一个通道就得多写一段样板，迟早有人漏。
2. **`received` 一起写回**。`setStatus` 的语义是「合并补丁」，只传 `state` 会把已有的 `received` 保留下来；这里显式带上是为了让返回体永远是完整的一行，而不是「有时候有 received 有时候没有」。
3. **不新增状态名**。没有引入 `'connected'` 之类的中间态 —— 前端只认 `stopped` / 非 `stopped`，多一个状态名等于要改前端判据，而用户也不需要知道「连上了但没在收」。

#### 14.37.4 六个通道的就绪信号从哪来

这是这一版最需要小心的地方：**就绪信号必须是平台真的给的，不能自己猜一个 `setTimeout(2000)`**。

| 通道 | 就绪信号 | 为什么是它 |
| --- | --- | --- |
| 飞书 | SDK 的 `onReady` | `@larksuiteoapi/node-sdk` 的 `WSClient` 构造函数本来就收 `onReady` / `onError` / `onReconnecting` / `onReconnected`，这是官方给的回调，不是我们拼的 |
| Slack | `onSocket(socket, 'open', ...)` | undici 的 WebSocket 支持 `addEventListener('open')`；`lib/ws.js` 的 `onSocket` 已经封装了 addEventListener / on 两种写法 |
| Discord | 同上 | 同上 |
| QQ | 同上 | 同上 |
| 钉钉 | `client.connect()` 的 `.then()` | `dingtalk-stream` **没有**就绪事件（dist 里只有 `emit(message.headers.topic, ...)` 一种），但 `connect()` 内部是 `await getEndpoint()` + `await _connect()` —— resolve 的那一刻 socket 已经 open，用它是准的 |
| 企微 | `client.on('connected', ...)` | `@wecom/aibot-node-sdk` 的 `setupWsEvents()` 里 `onConnected = () => this.emit('connected')`；另有 `authenticated` 事件，但那是「认证过了没」，不是「连上了没」 |

**为什么不用固定延时**：`setTimeout(2000)` 在网快时是「明明连上了还显示 starting」，在网慢时是「明明没连上却显示 running」—— 两头都错，而且错得看不出来。用平台给的事件，唯一的失败模式是「事件没来」，而那本来就该显示 `starting`。

#### 14.37.5 每处都包 try/catch，理由只有一条

六个回调全部写成这样：

```js
onSocket(socket, "open", () => { try { ctx.onReady?.() } catch { /* 只是展示 */ } })
```

理由是**状态只是展示，绝不能因为一个展示回调抛错就把连接断掉**。如果这里不包 try，`setStatus` 内部任何一次意外（比如 statusMap 结构不对）都会顺着回调栈冒到 socket 的事件处理器里，而 Node 里事件处理器抛未捕获异常就是进程级事故 —— 一条消息都收不到的代价，换一个「界面上时间戳不准」，完全不值。

#### 14.37.6 行为层怎么验（只有飞书有账号）

六个通道里只有飞书与 telegram 有账号，所以真连只能验飞书。判据不是「状态字符串对」，而是**「没收到任何消息的情况下，时间戳会不会动」**：

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:3082/@duma520/dsh-push-hub/api/receive/start' `
  -Method Post -ContentType 'application/json' -Body '{"channel":"feishu"}'
Start-Sleep -Seconds 30
(Invoke-RestMethod -Uri 'http://127.0.0.1:3082/@duma520/dsh-push-hub/api/receive/status').status `
  | Where-Object { $_.channel -eq 'feishu' } | Format-List
```

这条之所以是这一版的**唯一验收标准**：旧版行为正是「收到第一条才 running」，如果只在你发消息之后才变 `running`，说明根本没改到点上。

#### 14.37.7 结构层怎么验（六个通道全验，靠探针）

`scaffold/probe_download.mjs` 补了 K 段 10 项（96 → 106）。它做的是「钉死契约」而不是「模拟连接」—— 因为模拟连接验不出「信号是不是真的平台给的」，而钉死契约能保证：只要平台真的发了那个事件，状态就会被更新。

K 段钉住的六件事：`onReady` 接到了 `setStatus(running)`（K1）／六处埋点数量（K2）／飞书用的是 SDK 自己的 `onReady` 而不是自造的（K3）／三家 socket 通道都在 `open` 上报（K4）／钉钉用 `connect()` 的 resolve（K5）／企微用 `connected`（K6）／全走可选链（K7）／六处都包 try（K8）／注释写明了理由（K9）／`received` 一起写回（K10）。

#### 14.37.8 顺带改准的措辞：QQ 与钉钉不是「平台不给」

v0.36.0 里 `NO_DOWNLOAD_REASON` 对 QQ / 钉钉 / 企微一律用了「平台不给」这个说法。企微是对的（智能机器人的回调里确实没有 `media_id`，换谁来写都拿不到），但 **QQ 与钉钉不是** —— 这两家平台都给了接口：

| 通道 | 平台给什么 | 真实状态 |
| --- | --- | --- |
| QQ | `getFile` 接口，但只有 5 分钟窗口 | 能写，本轮没做 |
| 钉钉 | `downloadCode` 换一次性临时 URL | 能写，本轮没做 |
| 企微（智能机器人） | 回调里没有 `media_id` | 链路本身不给 |

所以现在的文案是：QQ「…要在 5 分钟内主动调接口拉 —— 这条本轮没做，所以取不到」、钉钉「…要先用 downloadCode 换一个几分钟就失效的临时 URL —— 这条本轮没做，所以取不到」、企微「…这条链路本身就不给原图」。

**为什么要较这个真**：这不是措辞问题，是**给用户的信息不同**。「平台不给」意味着「换通道吧，这里永远没戏」；「本轮没做」意味着「催作者还能有」。把后者写成前者，等于替用户提前放弃了一个做得到的选项。反过来也不能写「暂不支持」—— 那是敷衍，没说清到底是平台不给还是没做。

#### 14.37.9 已知边界

1. **只验了飞书**。Slack / Discord / QQ / 钉钉 / 企微五家全无账号，六处埋点靠探针钉契约，真连一次没做过。这是这版最诚实的一句话。
2. **就绪 ≠ 健康**。`running` 只说明「连上过一次」。之后 socket 断了会走 worker 自己的重连循环，状态可能停在 `running` 而实际在重连 —— 断连时 `runLoop` 的 catch 会写 `error`，界面上能看到，但不会自动退回 `starting`。
3. **飞书的 onReady 与真正能收消息之间还有一步**。SDK 的 onReady 表示长连接建好了，理论上之后立刻就能收；如果 SDK 内部还有鉴权/订阅步骤，那段时间状态是 `running` 但消息可能还没开始来。

### 14.38 同一条消息不再记两遍：入站去重、游标落盘、接收权抢占（v0.38.0）

#### 14.38.1 一句话

同一件事的平台重投只写一条记录；重启插件不再让平台重发全部历史；两个接收实例不会互踢。

#### 14.38.2 缺陷是怎么被发现的

不是读代码读出来的。主人从手机发了一条「你好」，然后看收件箱：

```
id: telegram-mwmbzp3k-f4oa7i   at: 2026-11-18T16:24:02.000Z  from: 6317****92  text: 你好
id: telegram-mwmbzp3k-8zctwi   at: 2026-11-18T16:24:02.000Z  from: 6317****92  text: 你好
```

除 id 后缀外每个字段都相同。同时 `/receive/status` 里 telegram 从 `running` 掉进 `retrying`：

```
getUpdates 失败 HTTP 409: Conflict: terminated by other getUpdates request; make sure that only one bot instance is running
```

**这两件事是同一个根的两个枝**，只看其中一个会修错地方。

#### 14.38.3 为什么「重启一次就会重复」是必然

`lib/inbox.js:73 appendMessage` 没有任何去重，id 是：

```js
const row = {
  id: channel + '-' + Date.parse(at).toString(36) + '-' + Math.random().toString(36).slice(2, 8),
  // ...
}
```

随机后缀意味着同一条平台消息重投时**必然**得到两个不同 id，写入侧毫无抵抗。而 Telegram 的 offset 只存在内存（`acc.__offset`），进程一重启就回 0 —— 0 在它的语义里是「把还没确认的全部再发一遍」。平台按规矩重投，完全合规。**「重启 → 重投 → 重复记录」是一条必然链路，不是偶发。**

#### 14.38.4 为什么单修一头都不够

| 只修 | 结果 |
| --- | --- |
| 只修去重 | 记录干净了，但平台侧仍被要求重发全部历史，请求量与耗电一点没减，只是看不见 |
| 只修游标 | 重投少了，但双实例仍在，409 会让 telegram 在 `running` / `retrying` 之间反复抖 |
| 只修双实例 | 重启后照样回 0，历史照样重投一遍，去重不修就又记两遍 |

所以三件事一起做。

#### 14.38.5 判重键为什么是三个而不是一个

键 = **通道 + 账号 + 平台唯一键**。理由逐条：

1. **不能用正文判重**。同一个人连发两条「你好」是两条真消息，必须都留下。按 text 判重会把第二条吞掉 —— 这比重复记录难查得多，用户会以为对方没发。
2. **必须带通道**。两家平台的 id 空间互不相干，telegram 的 `update_id=1` 与 QQ 的 `id=1` 不是一回事。
3. **必须带账号**。两个机器人各自收到 id 相同的消息是合法的（尤其是被转发到多个群时），少一个字段就会互相顶掉。

命中判重时返回 **`ok: true`** + `duplicate: true`，不是 `ok:false` —— 东西确实在收件箱里，回失败会让调用方以为写崩了去重试，反而放大问题。

没有平台唯一键的（微信 iLink）**照旧写入**，宁可偶发重复也不要把两条真消息并成一条。

#### 14.38.6 13 处唯一键分别是什么

| 通道 | 唯一键 | 行 |
| --- | --- | --- |
| Telegram 消息 | `update_id` → `tg-<id>` | 413 |
| Telegram 回调 | `callback_query.id` → `tg-cb-<id>` | 386 |
| 飞书 | `event.message.message_id` | 528 |
| Matrix | `event.event_id` | 622 |
| Slack 回调 | `trigger_id` 或 `action.action_ts` | 733 |
| Slack 消息 | `message.ts` | 764 |
| Discord 交互 | `d.id` | 899 |
| Discord 消息 | `message.id` | 926 |
| QQ 群 / 单聊 | `d.id` | 1055 / 1069 |
| 邮件 | `parsed.messageId` | 1229 |
| 钉钉 | 闭包 `messageId` | 1345 |
| 企微 | `frame.body.msgid` | 1440 |

**Telegram 为什么用 `update_id` 而不是 `message_id`**：`update_id` 是每一次投递的序号，重投时它不变，而且它同时覆盖消息与回调两种 update；`message_id` 只覆盖消息。`update_id` 在原有代码里本来就拿到了（用来推进 offset），不用额外取。

#### 14.38.7 游标与接收权为什么放在同一个文件

放在 `~/.dsh/dsh-push-hub/offsets.json`，与 `config.json` / `inbox.json` / `outbox.json` 同级 —— 备份时一个目录全带走，不用记第二个位置。结构：

```json
{ "version": 1, "updatedAt": "...", "owner": { "id": "r-mabc-xy", "pid": 1234, "at": "..." }, "offsets": { "telegram/主号": 123456789 } }
```

写盘沿用全项目既有规矩：`mkdir -p` → 写 `.tmp-<pid>`（mode `0o600`）→ `rename` 原子替换。读坏 / 不存在 / 结构不对一律回空表**永不抛** —— 游标坏了最坏只是退回从头拉一遍再被去重挡住，不该让接收循环起不来。

> **踩过的坑**：`writeOffsets` 一开始只写 `offsets` 段，于是 `setOffset` 每轮都把 `owner` 段冲掉一次 —— 去重与抢占互相拆台，抢占形同不存在。修法是写盘前先 `readOwner` 把 owner 一起带上。探针 B6/B7 就是钉这条的。

#### 14.38.8 接收权抢占为什么是「后启动的赢」

每次模块求值生成一个新的 `INSTANCE_ID`；`startChannel` 启动时 `claimOwner`；轮询型与长连接型两条循环**每轮**读一次盘上的 owner，发现自己不是持有者就写 `已让位给新的接收实例` 并 `return`。

方向是刻意选的：**后启动的赢、先启动的安静退场**。反过来（检测到冲突就拒绝启动）会让刚点了「开始接收」的用户以为是坏了 —— 而用户点了按钮就该有反应。让它赢、让旧的退，才是符合直觉的收敛方向。

#### 14.38.9 为什么还要「认领」老记录

这是代码写完、探针全绿之后自查发现的坑，值得单独留一节 —— 因为它修的是**升级动作本身引入的新缺陷**。

`platformId` 是 v0.38.0 才出现的字段，v0.37.0 及以前写进 `inbox.json` 的记录**全都没有它**。升级后第一次重启，Telegram 从游标 0 把未确认的历史重投一遍，精确判重（比 `channel + account + platformId`）一条都命中不了 —— 结果是**历史全体重复一遍**，比最初那个 bug 更难看。用户升级完看到收件箱翻倍，会直接判定「这版更糟」。

所以精确判重 miss 之后还要再走一步：找一条「通道 + 账号相同、没有 `platformId`、且 `at` / `from` / `text` 全同」的老记录，命中就**把键补进那条老记录**（不是新写一条），回 `{ duplicate: true, adopted: true }`。

三个约束，缺一条就会出事：

| 约束 | 缺了会怎样 |
| --- | --- |
| 只在 `platformId` 为空的老记录上认领 | 认领过一次的记录还带键，会来回改写、每轮都写盘一次 |
| 只在新消息带键时才走这条路 | 微信这种没有唯一键的通道会开始按正文合并，把两条真消息并成一条 |
| `at` 必须严格相同 | 同一句话隔十分钟再发是**新消息**，会被认领吞掉 |

探针 G 段六项钉的就是这些：G1/G2 认领后条数不变、G3/G4 键补进老记录且 `id` 不被换掉、G5 第二次重投走精确判重不二次认领、G6 换时间的同文仍是两条。

#### 14.38.10 已知边界

1. **真实重投路径没有真实验证**。去重与游标是探针钉的契约；要复现 409 得真把插件重载一次再发消息，本轮只做到「代码路径与断言齐全」，没做到「亲眼看见它不重复」。这是这版最诚实的一句话。
2. **只覆盖 Telegram 的游标**。微信 iLink 的 `get_updates_buf` 同样只在内存（`acc.__buf`），但它的重投行为没验过，这版没动 —— 动它得先能拿到真实微信消息，否则是盲改。
3. **接收权是整个插件一份，不是按账号**。两个不同 Bot Token 各跑一个循环其实是合法的（平台限制的是「同一个 token 只能一个轮询者」），按现在的实现，第二个模块实例仍会让第一个退场。多数情况够用，但「两个 DSH 实例共用一个 config」的用法会少收。
4. **群晖没有去重**。它根本不支持接收，无需处理。
5. **409 的真实来源已查明，但插件管不到它**。干净重启（stop 后再 start）仍然稳定复现那条 `Conflict: terminated by other getUpdates request`，而插件自身这两个循环已经被接收权抢占压在同一个实例里、且 stop 后 12 秒×3 复查状态不再动 —— 说明**本机还有一个插件之外的 `getUpdates` 轮询者**在抢同一个 Bot Token。插件能做的是「自己不起第二个轮询者」，做不了「别人不抢」。取证时想用直连 `api.telegram.org` 排除这个可能也被网络挡住（直连 `fetch` 直接 `ERR fetch failed`，插件走的是 `proxy` 配置里的代理）。

> **v0.39.0 更正**：这条当时把来源猜成「旧进程残留或另一份实例」，**猜错了**。v0.39.0 用 Bot API 的 `close` 做了决定性实验（踢掉后立刻 500、几百毫秒内又回到 409），证明那是一个**会立刻重连的持久轮询者**，不是本机残留（插件停着时宿主到代理的连接恒为 0 条）。它不是本插件的进程，也不是 dsh-im（未加载、无同 token）。插件侧能做的只有韧性，具体见 14.39。

### 14.39 抢不到接收权也不再哑火：可取消请求、冲突短退避、停等旧循环（v0.39.0）

#### 14.39.1 一句话

409 的来源在插件之外，插件治不了；但**抢不到的时候不能哑火** —— 请求要能被真的停掉，退避要按秒而不是按分钟，停了再开不能自己撞自己，界面上要能看出是「抢不到」而不是「没人发消息」。

#### 14.39.2 上一版的结论为什么错了

v0.38.0 把 409 归因于「热重载后旧模块的接收循环还活着」。这个解释很顺：旧的 Set 在旧闭包里、新的 Map 是空的，于是两个循环同时 `getUpdates`。但它有一个可证伪的点 —— 如果真是本机第二个轮询者，那么**插件停掉之后，本机到代理就不该再有那条连接**。实测：stop 之后采样 8 次 × 7 秒，宿主进程（pid 61248）到 `192.0.2.10:20808` 的连接数**恒为 0**。这一条就把「本机有第二个循环」判死了。

再把本机所有 node 进程逐个看过（8 个：memory-eternal 两个、billion-context 一个、chrome-devtools-mcp 三个、cloudbase-mcp 两个），没有一个跟 Telegram 有关；`Telegram.exe` 是桌面客户端，走 MTProto，不是 Bot API。`getWebhookInfo` 的 `url` 是空串、`pending_update_count` 是 0 —— 也没有 webhook 在抢。

#### 14.39.3 决定性的一枪：`close` 把人踢掉，它立刻回来

Bot API 有一个 `close` 方法，作用是「让这个 bot 当前的轮询停下来」。它的正确用法是配合迁移；在这里正好可以当探测器：

1. 先确认平台此刻空闲：`getUpdates{timeout:0, offset:-1}` → `200 / ok:true / result:[]`。
2. `POST https://api.telegram.org/bot<token>/close` → "{"ok":true,"result":true}"。
3. 立刻连发 5 次 `getUpdates{timeout:10}`。

结果：**#1、#2 立刻回 `HTTP 500 Internal Server Error`**（1.3s / 1.2s），**#3、#4、#5 又回到 409**（4.5s / 6.5s / 11.0s）。

500 说明确实有一条轮询被我们踢掉了（否则平台不会在处理层出错）；而紧接着又出 409，说明**它几百毫秒内就重连回来了**。这一下把「本机残留」和「另一份实例」两个假设都排掉了 —— 残留进程不会这么快、也不会这么顽强。

#### 14.39.4 旁证：冲突是零星的，但窗口越长越容易撞

如果 409 是「自己上一次请求还没结算完」，那它应该跟**自己请求的时长**强相关，而且时序固定。实测不是：

| 实验 | 做法 | 结果 |
| --- | --- | --- |
| 单次时长相关性 | `timeout` 分别取 2 / 6 / 10 / 16 / 25 秒 | 2 秒的短轮询照样 409，25 秒的也能跑满 → **与自身时长无关** |
| 并发语义 | A 先发、2 秒后 B 再发 | **A 和 B 双双 409** → 不是「后来者踢前者」，是双方都判冲突 |
| 无自我并发 | 30 次 `timeout:0`，每次都 await 完才发下一次 | OK=29 / 409=1（**3.3%**）→ 零星，不是必然 |
| 窗口长度 | 3s × 12、8s × 12、25s × 6 | 1/12、3/12、**3/6** → **窗口越长冲突率越高** |

最后一条是关键：窗口越长，两条轮询**重叠**的时间段就越长，撞上的概率自然越高。这正是「两个轮询者在抢同一个 token」的形态。它也直接推出了本版的第一条改动 —— 把窗口从 25 秒缩到 10 秒。

#### 14.39.5 为什么 `abort()` 以前根本停不掉请求

`stopChannel` 以前只做一件事：`controller.abort()`。但 `lib/http.js` 的 `request()` 从来不看这个 signal —— 它没有 `signal` 参数。所以 abort 只是把 `signal.aborted` 这个布尔量设成了 true，**在飞的那条请求一个字节都没被打断**，它会一直挂到 `timeoutMs`（`(25+15) * 1000 = 40 秒`）。

于是「停止 → 立刻开始」的真实时序是：新循环开始发 `getUpdates` 时，旧的那条还在平台上挂着，Telegram 判定两个轮询者 → 409。这不是巧合，是必然。

修法要分两条路，因为直连与代理的取消机制不一样：

| 路径 | 取消方式 | 为什么要这样 |
| --- | --- | --- |
| 直连（`direct`） | 把外层 signal 汇进 fetch 自己的 `AbortController` | fetch 只认一个 signal，超时与上层取消必须汇到同一个 controller |
| 代理（`viaProxy`） | 在 abort 时 **`connection.destroy()`** | **只让 Promise 提前 resolve 是不够的** —— Promise 结束了，隧道还开着，平台侧那条 `getUpdates` 仍在跑，下次 start 照样撞 |

第二条是本版最容易写错的地方。一个「看起来能用」的写法是在 abort 时直接 `finish({status:null, body:'AbortError'})`，调用方立刻拿到结果、循环立刻退出、界面立刻变 `stopped` —— 一切都对，除了平台上那条请求还在。然后用户点「开始接收」，409。

#### 14.39.6 为什么 409 要用独立短退避

普通失败（网络断、平台 5xx）用指数退避到 60 秒是对的：那是真故障，退得越久越省事。409 完全不是这类 —— 对方的轮询者随时可能退出，我们退 60 秒等于「一撞就哑火半分钟」，而真正的机会窗口在几秒内。

| 参数 | 值 | 理由 |
| --- | --- | --- |
| `CONFLICT_BACKOFF_MS` | 1500 | 首次重试 1.5 秒，够平台上那条请求结算 |
| `CONFLICT_BACKOFF_MAX_MS` | 6000 | 连续撞的上限，不退化成高频轰炸（对平台也不礼貌） |
| 抢回来后 | `conflictBackoff = 0` | 机会随时会再来，不能累积成「越撞越慢」 |

另外 409 **不涨**手上的普通 `backoff`。两者混用会出现这种糟糕情况：一次无关的冲突把普通退避推到 60 秒，之后真遇到网络故障就变成「一次冲突 + 一次断网 = 哑火一分钟」。

#### 14.39.7 启停为什么必须 async

`stopChannel` 以前是同步函数，`return` 的那一刻只代表「我已经调了 abort」，不代表「循环已经退出」。`startChannel` 的互斥又只看内存 Set —— 而 `set.delete(accountName)` 在旧循环的 `.finally` 里，`.finally` 要等循环真正结束才跑。

所以「停完立刻开」会遇到：新 start 走到 `set.has(accountName)` 时，旧循环还没 settle，`set` 里还留着 → 旧实现直接 `continue`（以为已经在跑，其实什么都没起），新实现则会 abort 并等它收尾。两者都比「再起一个」好。

| 改动 | 旧行为 | 新行为 |
| --- | --- | --- |
| `stopChannel` | 同步返回，循环还在跑 | async，等所有循环 settle 才返回；超时 5 秒后如实回 `drained:false` |
| `startChannel` | 同步返回，`set.has` 就 `continue` | async，先 `await claimOwner`，再 abort 同账号旧 controller 并等它收尾 |
| `LOOP_DONE` | 无 | 新增：键是 `通道/账号`，值是 runLoop 的完成 Promise，stop 靠它知道该等谁 |
| `.finally` | 无脑 `set.delete` | 只删自己那条登记（`if (LOOP_DONE.get(key) === done)`），否则会把新循环的登记抹掉 |

#### 14.39.8 界面为什么也必须改

这条容易被当成「顺手优化」，其实不做的话这版等于没做。旧文案的判断依据是「循环还活着」，所以只要循环在跑（哪怕一直在 409 里打转）就写「正在收 · 已收 0 条」。用户看到这个文案的正确理解是「插件在正常工作，只是没人发消息」—— **而真相是接收权被别人占着，一条都收不到**。两种情况该做的事完全不同（前者等，后者要么关掉对面、要么换 token）。

新文案分三态：

| 状态 | 文案 | 样式 |
| --- | --- | --- |
| 未开启 | `未开启 · <接收方式>` | 灰（muted） |
| 循环在跑但 `state === 'retrying'` | `正在抢回接收权 · 同一个机器人已被别的轮询者占用 N 次` | 黄（warn） |
| 正常在收 | `正在收 · 已收 N 条`（抢回过就补 `· 抢回 N 次`） | 默认 |

#### 14.39.9 已知边界（这版之后仍然成立的）

| 边界 | 说明 | 能不能修 |
| --- | --- | --- |
| **409 的来源在插件之外** | `close` 实验已证明那是一个会立刻重连的外部轮询者。插件能做的是「自己不起第二个」+「抢不到时不哑火」 | 插件侧到此为止 |
| **缩窗口只能降低概率** | 3 秒窗口实测仍有 3/19 冲突（成功率 78.9%），不是 100% | 不能消除，只能降 |
| **外部轮询者是谁仍未知** | 已排除：本机残留进程、dsh-im（未加载、无同 token）、webhook（url 空）、Telegram 桌面客户端（走 MTProto） | 需用户侧排查是否有别的设备/机器在用同一个 Bot Token |
| **其他通道的取消没验证** | `signal` 是通用能力，但只有 telegram 的 `poll` 真的接了 `ctx.signal`；飞书 / Slack / Discord 等长连接走的是 `run()`，还没接 | 下一版可按需扩 |
| **`drained:false` 的含义** | 5 秒内没退完只是「没等完」，不代表失败；循环会在后台继续收尾 | 属如实报告，不是缺陷 |

### 14.40 主面板自己滚：三层容器谁都没管，于是被裁掉（v0.39.1）

#### 14.40.1 一句话

主面板内容一超屏，底部就永远到不了 —— 因为**没有任何一层在滚**：宿主的外框不滚（它只负责裁），本插件的外层没有高度，里层的 `overflow-y:auto` 因为父级没有定高而永不触发。修法是把滚动交给最外层那个插件自有的容器。

#### 14.40.2 症状

主人原话：「进推送中枢，往下滚不动，界面底部的保存按钮根本到不了。」截图里右侧设置区只露出上半截，滚动条不存在。同一个症状也出现在另一个插件的主面板上，说明这不是某个插件的偶发问题，而是**宿主 `main` 槽位的通用契约**。

#### 14.40.3 三层的防溢出能力，逐层查

| 层 | 归属 | 关键样式 | 它滚不滚 |
| --- | --- | --- | --- |
| `.mainPanel` | 宿主 `dsh-client-ui-layout` | `display:flex; flex-direction:column; flex:1; min-width:0; min-height:0;` | **不滚**，且**没有 overflow** → 超出即被裁 |
| `.centerCol`（它的祖先） | 同上 | `overflow:hidden` | 不滚，只裁 |
| `.dph-pageWrap` | 本插件（`PushHubPanel` 的根） | v0.39.0 时：只有 `padding` 与 `max-width` | **不滚**，也没有高度 |
| `.dph-root` | 本插件（`PushHubSettings` 的根） | `height:100%; min-height:0; overflow-y:auto;` | **想滚但滚不起来** |

链条是这样断的：`.dph-root` 的 `height:100%` 需要父级有确定高度才生效；`.dph-pageWrap` 没有高度 → `.dph-root` 的 `height:100%` 退化为 `auto` → 它的高度就等于内容高度 → 永远不溢出 → `overflow-y:auto` 一次都不触发 → 内容伸到 `.mainPanel` 之外被裁掉。

#### 14.40.4 为什么 v0.26.1 那次没修好

v0.26.1 的注释写得很清楚：「宿主给的容器有定高，但本插件原先没声明高度与溢出，于是内容超出后被直接裁掉」，然后它给 `.dph-root` 补了 `height:100%` 与 `overflow-y:auto`。

**它补的那层不是元凶**。真正没有高度的是它的爹 `.dph-pageWrap`。补在 `.dph-root` 上，等于让一个「百分比高度」去依赖一个不存在的基准，反倒把那层原本能随内容撑开的能力也封住了。

#### 14.40.5 修法

改 `lib/client.js` 与 `lib/theme.js` 两处同源 CSS（**必须同时改**）：

```css
.dph-pageWrap {
  box-sizing: border-box;
  flex: 1 1 auto;          /* 父级是 flex column 时能长高 */
  min-height: 0;           /* 允许在 flex 里被压缩，不撑破父级 */
  max-height: 100%;        /* 父级定高时封顶；不定高时不生效，交回外层 */
  padding: 20px 24px 28px;
  max-width: 1180px;
  margin: 0 auto;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: var(--dsh-scrollbar-thumb, rgba(128, 128, 128, .45)) transparent;
}
```

三个决定，每个都有理由：

1. **`max-height:100%` 而不是 `height:100%`**。`height:100%` 在父级高度不确定时退化成 `auto`（正是老 bug 的成因）；`max-height:100%` 只在父级**确实有高度**时封顶，没有时就不生效、内容自然撑开让外层去滚 —— 两种情况都不会把内容憋死。
2. **`flex:1 1 auto` + `min-height:0`**。宿主 `.mainPanel` 是 `display:flex; flex-direction:column`，我们要能在这个 flex 里长高，同时不被内容顶破。`min-height:0` 是 flex 子项能收缩的前提，缺了它 `overflow` 同样不触发。
3. **滚动条显式做成 8px**。宿主的 `scrollbar.css` 把滚动条做成 **5px 细条**（源码注释：「Without it every scrolling region renders the UA scrollbar, which ignores the theme」），在深色背景上几乎看不见 —— 用户会以为「没有滚动条」。这里显式给 8px 且颜色跟主题变量 `--dsh-scrollbar-thumb`。

#### 14.40.6 为什么不去改宿主

`main` 槽位的容器是宿主的 `AppFrame.module.css`。在插件里改宿主样式属于越界（会污染所有面板，而且宿主升级就失效）。正确的边界是：**宿主决定「给你多大」，插件决定「我怎么在你的盒子里面滚」**。

#### 14.40.7 已知边界

| 边界 | 说明 | 能不能修 |
| --- | --- | --- |
| **无法自动化验证** | 本机 Electron 没有 `--remote-debugging-port`、也没有 stable Chrome，界面 DOM 取不到 | 只能靠源码推断 + 用户肉眼确认 |
| **`max-height:100%` 依赖父级定高** | 宿主若改成完全不定高，`max-height` 不生效，滚动交回外层（不会出错，但滚动条可能不在本插件上） | 属可接受的降级 |
| **两处同源 CSS 是手工同步** | `lib/client.js` 与 `lib/theme.js` 各存一份，没有构建期校验 | 加一条探针可以防漏，但这版没做 |


### 14.41 群晖三种整合类型：类型跟着面板走，字段跟着类型走（v0.40.0）

#### 14.41.1 问题不在代码，在分类口径

主人给的截图很直接：群晖 Chat 的「整合」页面上，**建一个整合**时会让你选一种，共三种：

| 群晖面板上的名字 | 面板让你填什么 | 方向 | 本插件能不能发 |
| --- | --- | --- | --- |
| **传入的 Webhook** | 只有一条 **Webhook URL**（建完就给你一条含 token 的整条地址） | 你 → 群晖 | **能**（这就是最常用的那条） |
| **发出的 Webhook** | **URL**（你自己的回调地址）、**令牌**、**频道**、**触发字** | 群晖 → 你 | **不能**（方向就是反的） |
| **机器人** | **传入 URL**（往它发消息）、**传出 URL**（群晖回调你）、**令牌** | 双向 | **能**（走「传入 URL」） |

而本插件原来的类型下拉只有两项：`webhook`（整合 → 传入的 Webhook）与 `bot`（整合 → 机器人）。**这是把协议名当成了类型名**。`webhook` / `bot` 描述的是「用哪个 API 方法发出去」（`method=incoming` 还是 `method=chatbot`），而用户在面板上做的选择是「我要建哪一种整合」。「发出的 Webhook」在旧模型里根本无处安放 —— 它既不是 `webhook` 也不是 `bot`，用户按面板选了它，回到插件界面却找不到对应的选项，只能硬塞一个相近的，然后字段对不上。

#### 14.41.2 改法：三个值，字段随类型切换

`type` 取值改为 `incoming` / `outgoing` / `bot`：

```jsonc
// incoming：填了整条 Webhook URL 就用它；留空则用 NAS 地址 + 令牌自动拼
{ "type": "incoming", "webhookUrl": "https://…/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming&version=2&token=…" }

// outgoing：只登记，不发送。令牌是给你验签用的
{ "type": "outgoing", "outgoingUrl": "https://你的服务器/hooks/synology", "token": "……", "channel": "任何公共频道", "triggerWord": "" }

// bot：消息走「传入 URL」；「传出 URL」只登记
{ "type": "bot", "incomingUrl": "https://…method=chatbot…token=…", "token": "……", "userIds": "12,34" }
```

界面上只渲染当前类型相关的几格（`lib/client.js` 的 `SYN_FIELDS` + `visibleFields`）—— 九格全铺开没人知道该填哪几个，这也是主人最初提这件事的直接动因。

#### 14.41.3 「发出的 Webhook」为什么只登记不发

方向是 **群晖 → 你填的 URL**。也就是说：

- 那个 URL 是**你**的接收端地址，不是群晖的发送端；
- 那串令牌是群晖放进请求体里给你**验签**的（面板提示原文：「令牌会包含在 Synology Chat 发送的请求中，将用于验证。」），**不是**调群晖 API 的凭据；
- 所以选 `outgoing` 时点「发条测试消息」，插件不发任何网络请求，直接回：

```
「发出的 Webhook」是群晖往你填的 URL 发请求（接收方向），不能用来发消息。
要往外发，请把类型改成「传入的 Webhook」或「机器人」。
```

这条是刻意的：如果它默默按 `webhook` 去拼 URL，用户会看到一个 404 或 401，然后以为是自己填错了 —— 而实际上是他选的类型根本不用于发送。

**它同时也收不了**。DSH 宿主只监听 `127.0.0.1:9429`，NAS 在另一台机器上，回调打不进来（这一点在「已知限制」里长期写着）。所以插件对 `outgoing` 的完整语义是：**只登记、发也不收**。这不是漏实现，是这条链路在本架构下就是这样。

#### 14.41.4 老配置不用动

`normalizeType()`（`lib/channels/synology.js:66`）与前端 `normalizeSynType()`（`lib/client.js:462`）同口径：

| 磁盘上的值 | 归一结果 |
| --- | --- |
| `"incoming"` / `"webhook"` / 空 / `undefined` / 任何认不出的值 | `incoming` |
| `"outgoing"` | `outgoing` |
| `"bot"` | `bot` |

空值落到 `incoming` 是必须的：本机当前那个「DSH 通知」账号 `type` 就是 `undefined`，它一直在用 `webhookUrl` 正常发消息，升级后必须继续正常。探针里专门钉了这一条（`probe_synology_ui.mjs` 的「老配置 type 缺省落 incoming」）。

#### 14.41.5 顺手修掉的空行 bug

`lib/index.js:764-767` 的 `hasCredential` 现在这样写：

```js
const hasCredential = fields
  .filter((field) => field.group !== 'advanced' && field.key !== 'type')
  .some((field) => String(account?.[field.key] ?? '') !== '')
```

`field.key !== 'type'` 是这一版加的。原因：`type` 是**有默认值的下拉**，它永远非空；算进 `hasCredential` 的话，用户点了「+ 再接一个机器人」、只在类型下拉里选了一下、什么都没填，这一行就会被当成「已配好的账号」落盘。加完这个条件，空行照旧不落盘。

#### 14.41.6 验证

| 探针 | 项数 | 钉住什么 |
| --- | --- | --- |
| `scaffold/probe_synology.mjs` | 45 | `TYPES` 三项；`normalizeType` 九种入参（含 `webhook` / 空 / 未知值 / 大小写）；`resolveWebhookUrl` 八种（填整条 URL、只有 NAS+token、带 `/webapi/entry.cgi` 前缀、缺 token 等）；`resolveBotUrl` 四种；`explainChatError` 五种错误码；`send()` 遇到 `outgoing` **拒绝且不发任何请求**、且文案给出路；`bot` 缺令牌 / 缺 userIds 各自的报错；`probe()` 三分支 |
| `scaffold/probe_synology_ui.mjs` | 全新重写 | `incoming` 渲染三字段（Webhook URL / NAS 地址 / 令牌）、**不渲染**用户 ID 与传出 URL；`outgoing` 渲染传出 URL / 令牌 / 频道 / 触发字、**不渲染** Webhook URL；`bot` 渲染五字段；老配置 `type` 缺省落 `incoming`；折叠态 `data-open` 全 `false` |

```
$ node scaffold/probe_synology.mjs
SYNOLOGY_CHANNEL_OK  群晖三种整合类型共 45 项断言全通过
$ node scaffold/probe_synology_ui.mjs
SYNOLOGY_UI_OK  群晖三种整合类型的字段过滤与折叠态都正确
```

#### 14.41.7 已知边界

| 边界 | 说明 |
| --- | --- |
| **`outgoing` 发也不收** | 发：方向反了；收：宿主只监听 `127.0.0.1:9429`，NAS 连不进来。插件对它是「只登记」 |
| **频道 / 触发字只是登记** | 群晖侧的筛选条件，插件不参与判断，也不会因为它们不匹配就不发 |
| **`bot` 仍只能点对点** | `method=chatbot` 只收 `user_ids`，发不进频道 —— 这是群晖 API 的边界，不是本插件的选择 |
| **界面改动靠探针与源码，不靠肉眼** | 本机 Electron 无调试端口，DOM 取不到；字段过滤逻辑由 `probe_synology_ui.mjs` 逐条断言 |

### 14.42 删掉的机器人又回来了：一份按名字索引的明码缓存（v0.40.2）

这是本项目里极少数**根因不在后端**的缺陷。它值得单独写一节，因为它示范了一种很容易被误判的排查方向：用户看到「删掉的数据自己回来了」，第一反应必然是「删除没生效 / 后端又把旧数据吐回来了」，于是去翻 `config.json`、去查磁盘残留 —— 而这一次磁盘上真的什么都没有。

#### 14.42.1 现象

在「推送中枢 → 群晖 Chat」里点「移除」删掉机器人 `DSH 通知`，再点「+ 再接入一个机器人」把名称填成同样的 `DSH 通知`：

1. Webhook URL 输入框里**立刻出现删之前那条完整地址**（`https://192-168-104-65.…quickconnect.cn:65001/chat/webapi/entry.cgi?api=SYNO.Chat.External&…&token=%22sOKRx…%22`）；
2. 该字段右侧按钮显示的是「隐藏」而不是「明码」—— 说明这一格当前处于明码态；
3. 输入框是**只读**的，点不动、改不了、也清不干净。

主人的原话（2026-11-20）：「删除机器人，重新填写，但是名称改成原来一样的话，url 就自动恢复成之前的了。这还怎么改？删除后，等于应该是全新的，怎么会恢复之前填的资料呢？」

#### 14.42.2 根因

真凶是**浏览器端那份「明码」缓存 `revealed`，它的键只认名称**。

```js
// lib/client.js:1462
const revealKeyOf = (channel, name, key) => channel + '|' + name + '|' + key
```

点一次「明码」，该字段的明文就按这个键存进前端 state（`:1474` `setRevealed((prev) => ({ ...prev, [k]: String(data.value ?? '') }))`）。渲染时按**当前名称**去查（`:1748`），命中就替换值并锁只读（`:1756-1759`）：

```js
const shownSecret = revealed[revealKeyOf(channel, item?.name ?? '', f.key)]
// …
type: f.secret === true && shownSecret === undefined ? 'password' : 'text',
value: String(f.secret === true && shownSecret !== undefined ? shownSecret : (item[f.key] ?? '')),
readOnly: f.secret === true && shownSecret !== undefined,
```

而旧的 `dropOwn`（v0.40.1 及以前）只把行 filter 掉，**完全不碰 `revealed`**：

```js
const dropOwn = (channel, index) => {
  setOwnBots((prev) => {
    const list = (Array.isArray(prev?.[channel]) ? prev[channel] : []).filter((_, i) => i !== index)
    return { ...prev, [channel]: list }
  })
}
```

于是「删掉 → 同名重建」这个序列里：新行落到下标 0、名称又是 `DSH 通知`，键正好撞上上一轮留下的那条，明文被原样顶回只读框。

#### 14.42.3 为什么能确定不是后端

后端合并旧配置时是**按数组下标**对齐的：

```js
// lib/index.js:677
const old = oldRows[i] ?? {}
```

下标，不是名字。这一行把两种假设彻底分开：

| 假设 | 若为真的可观测后果 |
|---|---|
| 复活来自后端 | 随便起什么名字，只要站到下标 0，就会拿到旧值 |
| 复活来自前端缓存 | **只有同名**才复活；换个名字就是干净的 |

主人的观察是「名称改成原来一样的话就恢复」，正落在第二种上。另外后端删除路径本身是干净的（`lib/index.js:769` `if (accounts.length === 0) delete own[channel]`），磁盘 `~/.dsh/dsh-push-hub/config.json` 里也确实查不到旧值 —— 用 `grep` 在磁盘上找不到任何痕迹是**正常**的。

#### 14.42.4 修法

只动前端，后端一个字没改。四处：

| 位置 | 动作 | 为什么必须在这儿 |
|---|---|---|
| `lib/client.js:847` 新增 `clearRevealed(channel, name)` | 拼 `通道\|名称\|` 前缀，删掉 `revealed` 里所有以它开头的键；零命中时原样返回 `prev` | 一处工具函数，三处复用；空名称也照清（空名行的键是 `通道\|\|字段`，同样是共享命名空间） |
| `lib/client.js:885` `dropOwn` | 在 filter **之前**先取 `list[index]` 的 `name`，调 `clearRevealed` | 必须**先取名字再删行** —— 缓存键里带着名称，行没了就再没处反查「刚才那条叫什么」 |
| `lib/client.js:904` `patchOwn` | `patch` 带 `name` 且与旧值不同时，清旧名的缓存 | 堵「A 点明码 → 改名 B → 改回 A」；只改别的字段**不清**，否则每换一次目标都得重新点「明码」 |
| `lib/client.js:668-672` `reload()` | 拿到 `GET /config` 之后 `setRevealed({})` 整体作废 | 明码是「这一刻这个名称下的字段值」的快照，配置一换就不再成立 |

`clearRevealed` 的实现（三条纪律都在注释里写清了）：

```js
const clearRevealed = (channel, name) => {
  const prefix = channel + '|' + String(name ?? '') + '|'
  setRevealed((prev) => {
    const hits = Object.keys(prev).filter((k) => k.startsWith(prefix))
    if (hits.length === 0) return prev
    const next = { ...prev }
    for (const k of hits) delete next[k]
    return next
  })
}
```

**副作用只有一个，且是期望行为**：重新拉配置后明码自动收回指纹，想再看要重新点「明码」。这本来就是「重新拉配置」该有的语义。

#### 14.42.5 验证

`scaffold/probe_ownbot_delete.mjs` 从 19 项扩到 **34** 项，新增 E 段 15 条。手法与前四段一致：从源码按花括号配对**截出真函数体**，用 `new Function` 真跑，`setRevealed` 换成能立刻套用 updater 的假实现，直接断言缓存键集合。

| 断言 | 钉住什么 |
|---|---|
| E5 / E6 | 复刻主人那一幕：`synology_chat\|DSH 通知\|webhookUrl` + `\|token` 两条，删行后该前缀条目必须为 0 |
| E7 | 别的通道的明码不受牵连 |
| E8 / E9 | 删 A 不能误清同通道的 B |
| E11 | 改名后旧名条目清空 |
| E12 | 只改别的字段时明码必须保留（防过度清理） |
| E13 | 空名称行也清 |
| E14 | `reload()` 里确实有 `setRevealed({})` |
| E15 | 后端仍是 `const old = oldRows[i] ?? {}` —— 防有人把它改成按 name 对齐（那会把「同名复活」变成「随便什么名都复活」，症状更糟） |

```
$ node scaffold/probe_ownbot_delete.mjs
OWNBOT_DELETE_OK  删账号/改名字 共 34 项断言，通过 34，失败 0
```

#### 14.42.6 已知边界

| 边界 | 说明 |
| --- | --- |
| **缓存键仍是名称，没换 uuid** | 同时存在两条同名行时，点「明码」看到的是这个名字下的那一份，不能保证是你正看的那一行。根治要动 `revealKeyOf` / 渲染 / `toggleReveal` 三处，风险大于收益；本版只堵「删除 / 改名 / 重拉」三条会串味的路径 |
| **只在内存里清** | `revealed` 从不落盘（明文不该进任何持久载体），所以修复解决的是**同一页面会话内**的串味；刷新页面天然清空 |
| **界面改动靠探针，不靠肉眼** | 本机 Electron 无调试端口，DOM 取不到；E5/E6 复刻的就是主人遇到的那一幕 |
## 许可

BSD-3-Clause，见 [LICENSE](./LICENSE)。
