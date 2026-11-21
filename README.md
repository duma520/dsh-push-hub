# Push_Hub —— 把消息推到手机的通用通知库

一句话：**一条命令，把一段中文消息同时推到 Telegram、飞书、QQ（微信视情况），跨平台、只用标准库、凭据不外泄。**

- 适合谁：任何需要在长任务结束时给自己发个提醒的人——跑下载、跑编译、跑爬虫、跑备份。
- 解决什么问题：机器跑一晚上，人不在跟前，结束或卡死没人知道。Push_Hub 就是那条「叫醒你」的通道。

---

## 目录

- [一、这是什么](#一这是什么)
- [二、零基础：5 分钟跑通](#二零基础5-分钟跑通)
- [三、命令行逐项说明](#三命令行逐项说明)
- [四、三个真实场景](#四三个真实场景)
- [五、配置文件详解](#五配置文件详解)
- [六、工作原理](#六工作原理)
- [七、排错手册](#七排错手册)
- [八、FAQ](#八faq)
- [九、已知限制](#九已知限制)
- [十、目录结构与开发](#十目录结构与开发)

---

## 一、这是什么

Push_Hub 是一段可以直接 import 或命令行调用的 Python 代码，把「发消息」抽象成四个通道：

| 通道 | 状态 | 走什么协议 | 实测延迟 |
|---|---|---|---|
| Telegram | 稳定 | Bot API sendMessage（必须带代理） | 1–3 秒 |
| 飞书 | 稳定 | 自建应用 im/v1/messages | 1–2 秒 |
| QQ | 稳定 | QQ 开放平台 v2 单聊 | 1–2 秒 |
| 微信 | 部分可用 | iLink ilink/bot/sendmessage | 见第七节 |

**核心设计取舍**：凭据不复制到本仓库，运行时直接从 dsh-bridge 的 config.json 读。这样同一台机器上 dsh-bridge 改了机器人配置，Push_Hub 自动跟着变，不会出现「两份配置对不上」。

---

## 二、零基础：5 分钟跑通

### 第 1 步：确认 Python 能跑

```bash
D:/tg_fetch_venv/Scripts/python.exe --version
```

应输出 Python 3.10.x。没有的话任何 3.8+ 都行，Push_Hub 只用标准库（urllib、json、ssl、base64）。

### 第 2 步：看有哪些账号

```bash
cd G:/Python_Code/Push_Hub
D:/tg_fetch_venv/Scripts/python.exe -m pushhub --list
```

正常输出：

```
凭据来源：C:\Users\<你>\.dsh\dsh-bridge\config.json
通道            账号数    已就绪  账号名
telegram        1      1  135
feishu          1      1  135
qq              7      7  14386306, 406910967, 15654155, 2909458939 …
wechat          9      9  duma640, duma7654, duma185, duma4445 …  (best-effort)
默认通道：telegram,feishu,qq
```

**看到这张表就说明凭据读到了。** 如果全是 0，跳到第七节。

### 第 3 步：发一条试试

```bash
D:/tg_fetch_venv/Scripts/python.exe -m pushhub --selftest
```

期望输出：

```
telegram  OK    已发 1 块
feishu    OK    已发 1 块
qq        OK    已发 1 块
整体：成功
```

手机应该在三秒内连续震三下。

---

## 三、命令行逐项说明

| 参数 | 作用 | 取值 | 推荐 |
|---|---|---|---|
| --text | 正文 | 任意字符串 | 短消息直接用 |
| --title | 标题，拼在正文第一行 | 任意字符串 | 需要区分来源时用 |
| --from-job | 从 state/<job>_speed.json 自动拼完成报告 | job 名，如 dl3 | 长任务收尾用 |
| --state-dir | --from-job / --watch 用的 state 目录 | 路径 | 默认当前目录下 state/ |
| --channels | 只发哪些通道 | 逗号分隔，如 telegram,qq | 默认读配置 |
| --account | 指定某通道用哪个账号 | 通道=账号名，可重复 | 多账号时才用 |
| --config | 额外的覆盖配置文件 | 路径 | 一般不用 |
| --selftest | 发一条自检消息（自带时间戳） | 开关 | 首次配置后必跑 |
| --list | 列出账号与就绪情况 | 开关 | 排查凭据问题 |
| --watch JOB | 当哨兵：盯任务，结束后自动推 | job 名 | 长任务必用 |
| --idle-min | --watch：静止多少分钟算结束 | 浮点，默认 15 | 网络差时调到 25 |
| --max-hours | --watch：最多盯多少小时 | 浮点，默认 6 | 按任务规模调 |
| --interval | --watch：轮询间隔秒 | 整数，默认 30 | 不用改 |
| --quiet | --watch：不打每轮心跳 | 开关 | 后台跑时用 |
| --dry-run | 只打印不发 | 开关 | 调格式时用 |
| --json | JSON 输出 | 开关 | 被别的程序调用时用 |

**退出码**：0 = 至少一条硬通道成功；1 = 全失败；3 = 参数错误。

> 「硬通道」= 除微信外的所有通道。微信因服务端问题按 best-effort 处理，它失败不会让整体判失败。

---

## 四、三个真实场景

### 场景 A：最简单——编译完了告诉我

```bash
make build && D:/tg_fetch_venv/Scripts/python.exe -m pushhub --title "编译完成" --text "耗时 4 分 12 秒"
```

失败也要知道：

```bash
make build; D:/tg_fetch_venv/Scripts/python.exe -m pushhub --title "编译结束" --text "见上一条日志"
```

### 场景 B：常见组合——长任务跑完自动通知

```bash
cd G:/Python_Code/Push_Hub
D:/tg_fetch_venv/Scripts/python.exe -u -m pushhub --watch dl3 --state-dir "G:/Python_Code/TG_Batch_Download/state" --idle-min 15 --max-hours 8 --quiet
```

它每 30 秒读一次 dl3_speed.json：

- files_done >= files_total → 判定完成，推送
- 文件 15 分钟没更新 → 判定进程已死或卡住，**也推送**（这条比第一条重要，卡死才是真正需要人介入的情况）
- 超过 8 小时 → 退出码 3，不发（防止永远挂着）

### 场景 C：进阶——只推 QQ，指定账号，要 JSON

```bash
D:/tg_fetch_venv/Scripts/python.exe -m pushhub --text "备份完成" --channels qq --account qq=14386306 --json
```

输出形如：

```json
{"ok": true, "result": {"qq": {"ok": true, "detail": "已发 1 块"}}}
```

脚本里可直接 json.loads() 后判 ok。

---

## 五、配置文件详解

### 5.1 配置读取顺序

```
1. ~/.dsh/dsh-bridge/config.json        ← 主来源（dsh-bridge 维护的机器人配置）
2. 环境变量 PUSH_HUB_CONFIG 指向的文件   ← 可选，用于 CI 或多环境
3. <Push_Hub>/config.json                ← 本地覆盖（自己写，进 .gitignore）
```

合并规则是**浅合并**：后一个文件的顶层键**整体替换**前一个。你写 "telegram": {...} 会整个替掉 bridge 里的 telegram 段，不做字段级合并。这样行为可预测，不会出现「改了半截却不生效」。

### 5.2 每个通道要哪些字段

| 通道 | 必需字段 | 说明 |
|---|---|---|
| telegram | botToken、allowFrom[0]、proxy | **proxy 不可省，直连必超时** |
| feishu | appId、appSecret、allowFrom[0]、domain | domain 是 feishu 或 larksuite |
| qq | appId、appSecret、allowFrom[0]（openid） | **appId 必须是字符串** |
| wechat | token、allowFrom[0]、baseUrl | baseUrl 一般 https://ilinkai.weixin.qq.com |

### 5.3 完整配置示例

见仓库里的 config.example.json。**里面有占位符，真实值不要提交进来。**

### 5.4 改坏了会怎样

| 改错的地方 | 现象 |
|---|---|
| 少了 proxy | telegram 卡 25 秒后报连不上 |
| appId 写成数字 | qq 取 token 报 invalid appid |
| allowFrom 为空数组 | 该通道直接返回「缺 allowFrom」 |
| JSON 语法错（多逗号） | load() 静默回落到上一级配置，表现为「改了没生效」 |

**JSON 写错是静默失败**，这是本库唯一会「吞错误」的地方，故意的：宁可回落到可用配置，也不要因为多一个逗号导致整个通知发不出去。

---

## 六、工作原理

### 6.1 数据流

```
调用方（CLI 或 import）
      │
      ▼
   api.send()
      │  读 config（bridge → env → 本地，浅合并）
      ▼
   api.send_all()
      │  按 channels 顺序逐个调
      ▼
 channels/{telegram,feishu,qq,wechat}.send(text, acc, cfg)
      │  内部：split_blocks() 按通道上限切块 → post_json() 发 → 判定成功
      ▼
   {通道: (ok, detail)}  ──►  整体判定（硬通道任一成功 = True）
```

### 6.2 关键实现点

**httpc.post_json 不抛异常。** 返回 (status, body_text)，status=None 表示连不上。这样上层不用写 try/except，所有失败都能统一包装成 (False, 原因) 返回给用户看。

**分块（split_blocks）。** 每个通道有字数上限（TG 4096 / 飞书 2000 / QQ 1800 / 微信 2000），超了要切。切法按行切，单行超长再硬切——不会把一句话从中间劈开。块之间按 sendChunkDelayMs 间隔发，避免触发频控。

**QQ 的授权头是 QQBot <token>，不是 Bearer。** 这是最容易写错的地方，写成 Bearer 会返回 401。

**微信的 context_token。** 从 dsh-bridge 的 wechat-context-tokens.json 读，按 peer 前缀匹配。协议规定过期返 ret=-14，此时去 token 重试一次。

### 6.3 为什么微信是 best-effort

2026-11-15 对 9 个微信账号逐个实测，sendmessage 一律返回：

```json
{"ret": -2, "errmsg": "prepare failed"}
```

但同一个 token 的 getconfig 返回 ret=0 且给得出 typing_ticket（600 秒 TTL），sendtyping 也返回 ret=0。

**结论：token 有效、peer 有效，是 sendmessage 这条 RPC 对该 bot 本身不通。** 不是参数问题，改参数无解。

dsh-bridge 内部把 -2 + prepare failed 判为「会话过期」，在这个场景下是误判。修法只能是**重新扫码绑定机器人**（人在微信客户端操作）。

所以 Push_Hub 把微信标成 best-effort：它失败只记录一行，不拖累其它通道。

---

## 七、排错手册

### 症状 A：--list 显示全部 0 个账号

| 检查 | 命令 |
|---|---|
| 配置文件在不在 | ls ~/.dsh/dsh-bridge/config.json |
| JSON 能否解析 | python -c "import json;json.load(open(r'C:/Users/<你>/.dsh/dsh-bridge/config.json',encoding='utf-8'))" |
| 里面有没有 accounts | 用记事本打开搜 accounts |

**原因**：dsh-bridge 没装或没配置过机器人。去 DSH 设置页「IM 机器人」里扫码连接。

### 症状 B：telegram 卡很久然后 FAIL

**原因**：没配 proxy，或代理挂了。

```bash
python -c "import socket;s=socket.create_connection(('***已脱敏***-内网IP',20808),timeout=5);print('OK');s.close()"
```

**解决**：改 dsh-bridge config.json 里 telegram 账号的 proxy 字段，或在本地 config.json 里覆盖。

### 症状 C：qq 返回 401

**原因**：授权头写错，或 appSecret 被重置。

```bash
D:/tg_fetch_venv/Scripts/python.exe -m pushhub --text test --channels qq --json
```

如果 detail 里有 HTTP 401，去 QQ 开放平台后台确认 clientSecret。

### 症状 D：feishu 返回 code 99991663

**原因**：tenant_access_token 无效，通常是 appId 与 appSecret 不配对。

### 症状 E：微信 ret=-2 prepare failed

**这是已知的、无解的**。见 6.3。需要人重新扫码绑定机器人。

### 症状 F：--watch 一直不触发

```bash
stat -c "%y" G:/Python_Code/TG_Batch_Download/state/dl3_speed.json
```

**原因 1**：任务根本没在写 speed.json（--watch 只能盯这种格式）。
**原因 2**：--state-dir 指错了目录。

先干跑看它读到了什么：

```bash
python -m pushhub --watch dl3 --state-dir "正确路径" --dry-run --idle-min 0.02 --interval 2
```

---

## 八、FAQ

**Q1：必须装 dsh-bridge 吗？**
不必须。你可以写一份自己的 config.json（参考 config.example.json），Push_Hub 一样能用。dsh-bridge 只是「现成的凭据来源」。

**Q2：能不能只推微信？**
可以 --channels wechat，但当前微信通道大概率失败。只发微信时整体按 best-effort 判，失败返回 1。

**Q3：消息太长会怎样？**
自动按通道上限分块，块之间间隔 1.5 秒。不丢内容，但手机会连收好几条。

**Q4：会不会被限流？**
飞书/QQ/TG 的机器人都有频控。默认每块间隔 1.5 秒，正常使用不会触发。不要写循环一秒发一条，那是自己撞墙。

**Q5：能发图片或文件吗？**
不能，只发纯文本。要发文件用各平台的上传 API，本库没封装。

**Q6：多台机器能共用一套配置吗？**
可以，把 dsh-bridge 的 config.json 同步过去。但那个文件含明文 token，别放公开网盘。

**Q7：--watch 会不会重复推送？**
不会。触发一次后进程立刻退出（返回 0）。要再推就重新启动。

**Q8：任务卡住但文件还在每 30 秒更新，--watch 会察觉吗？**
不会。--watch 只看 speed.json 的 mtime，不看内容。如果任务自己还在写心跳但实际卡在某个文件上，--watch 认为一切正常。这种情况要看 bps/mbps 字段——但那需要任务自己写进去。

**Q9：退出码 3 是什么意思？**
--watch 超过 --max-hours 还没结束，主动放弃（不发通知）。防止后台永远挂着一个进程。

**Q10：能不能在 CI 里用？**
能。把凭据放 CI 的 Secret 里，写进 PUSH_HUB_CONFIG 指向的临时文件即可。

---

## 九、已知限制

1. **微信通道当前不通**（服务端 -2 prepare failed），已按 best-effort 处理。
2. **只支持文本**，不支持图片、文件、Markdown 富文本。
3. **凭据是明文**，存在 dsh-bridge 的 config.json 里。本库不加密、不托管。
4. **没有内置重试**。发失败就是失败，返回 (False, 原因)。需要重试请在外面包一层。
5. **--watch 依赖任务写 speed.json**，不是通用进程监控。
6. **单进程单线程**，并发发送会让频控更容易触发。

---

## 十、目录结构与开发

```
Push_Hub/
├── pushhub/
│   ├── __init__.py         包入口，__version__ + 对外导出
│   ├── __main__.py         python -m pushhub 入口
│   ├── cli.py              命令行参数解析与分发
│   ├── api.py              send / send_all，整体成功判定
│   ├── config.py           三级配置合并、账号查找
│   ├── httpc.py            HTTP 封装，永不抛异常
│   ├── textutil.py         按通道上限分块
│   ├── jobs.py             把 speed.json 拼成中文报告
│   ├── watch.py            完成哨兵
│   └── channels/
│       ├── telegram.py
│       ├── feishu.py
│       ├── qq.py
│       └── wechat.py
├── docs/
│   └── 通道说明.md          各通道协议细节与实测记录
├── config.example.json     配置样例（占位符）
└── README.md
```

### 加一个新通道要做的事

1. 在 pushhub/channels/ 下新建 xxx.py，暴露 NAME、MAX_CHARS、send(text, acc, cfg) -> (ok, detail)；
2. 在 pushhub/api.py 的 SENDERS 里注册；
3. 如果它的失败不该拖累整体，加进 BEST_EFFORT；
4. 在 cli.py 的 _list_channels 元组里加上名字。

### 自检命令

```bash
cd G:/Python_Code/Push_Hub
D:/tg_fetch_venv/Scripts/python.exe -m pushhub --list            # 凭据
D:/tg_fetch_venv/Scripts/python.exe -m pushhub --selftest        # 实发
D:/tg_fetch_venv/Scripts/python.exe -m pushhub --text x --dry-run  # 不发只看
```

---

## 版本更新简介

| 版本 | 日期 | 一句话变更 |
|---|---|---|
| 1.0.0 | 2026-11-15 | 从 TG_Batch_Download 的 notify.py 抽出来独立成库，四通道 + 完成哨兵 |

---

## 许可

个人自用工具，未附许可文件。要用请自行 fork。
