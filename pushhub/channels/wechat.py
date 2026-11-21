# -*- coding: utf-8 -*-
r"""微信个人号机器人（iLink 协议）。

协议常量与 dsh-bridge 的 lib/wechat/gateway.js:27-48 逐字一致。
端点：<baseUrl>/ilink/bot/sendmessage

★ 现状（2026-11-15 实测，9 个账号全试过）：
    服务端恒返 {"ret": -2, "errmsg": "prepare failed"}
  而同一个 token 的 getconfig（ret=0 且返 typing_ticket）与 sendtyping（ret=0）
  都正常 —— 说明 token 有效、peer 有效，是 sendmessage 这条 RPC 对该 bot 本身不通。
  因此本通道默认按 best-effort 处理：调用方可以把它的失败当非致命。
  修好需要重新扫码绑定机器人（人在客户端操作），不是参数问题。
"""
import base64
import json
import os
import random
import time

from ..httpc import post_json
from ..textutil import split_blocks

NAME = "wechat"

# ---- iLink 常量（与 gateway.js:27-48 一致）----
ILINK_APP_ID = "bot"
CHANNEL_VERSION = "2.2.0"
ILINK_APP_CLIENT_VERSION = (2 << 16) | (2 << 8) | 0   # 131584
EP_SEND_MESSAGE = "ilink/bot/sendmessage"
MSG_TYPE_BOT = 2
MSG_STATE_FINISH = 2
ITEM_TEXT = 1
MAX_CHARS = 2000

CTX_FILE = os.path.expanduser(r"~\.dsh\dsh-bridge\wechat-context-tokens.json")


def _b64url(n=4):
    return base64.urlsafe_b64encode(bytes(random.getrandbits(8) for _ in range(n))).decode().rstrip("=")


def _load_ctx(peer):
    try:
        with open(CTX_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
        v = d.get(peer)
        return v if isinstance(v, str) and v else None
    except Exception:
        return None


def _headers(token):
    return {"AuthorizationType": "ilink_bot_token",
            "iLink-App-Id": ILINK_APP_ID,
            "iLink-App-ClientVersion": str(ILINK_APP_CLIENT_VERSION),
            "X-WECHAT-UIN": _b64url(),
            "Authorization": "Bearer " + token}


def send(text, acc, cfg=None):
    base = (acc.get("baseUrl") or "https://ilinkai.weixin.qq.com").rstrip("/")
    token = acc.get("token")
    peer = (acc.get("allowFrom") or [None])[0]
    if not token or not peer:
        return False, "缺 token 或 allowFrom"
    ctx = _load_ctx(peer)
    url = base + "/" + EP_SEND_MESSAGE
    delay = (acc.get("sendChunkDelayMs") or 1500) / 1000.0
    ok, errs = 0, []
    for i, blk in enumerate(split_blocks(text, MAX_CHARS - 20)):
        msg = {"from_user_id": "", "to_user_id": peer,
               "client_id": "pushhub-%d-%d" % (int(time.time() * 1000), i),
               "message_type": MSG_TYPE_BOT, "message_state": MSG_STATE_FINISH,
               "item_list": [{"type": ITEM_TEXT, "text_item": {"text": blk}}]}
        if ctx:
            msg["context_token"] = ctx
        st, body = post_json(url, {"msg": msg, "base_info": {"channel_version": CHANNEL_VERSION}},
                             headers=_headers(token))
        try:
            r = json.loads(body)
        except Exception:
            r = {}
        # context_token 过期（-14）时按协议降级为不带 token 重试一次
        if r.get("ret") == -14 and ctx:
            msg.pop("context_token", None)
            st, body = post_json(url, {"msg": msg, "base_info": {"channel_version": CHANNEL_VERSION}},
                                 headers=_headers(token))
            try:
                r = json.loads(body)
            except Exception:
                r = {}
        if r.get("ret") not in (0, None):
            errs.append("ret=%s %s" % (r.get("ret"), r.get("errmsg")))
            break
        ok += 1
        time.sleep(delay)
    return (ok > 0), ("已发 %d 块" % ok) if not errs else "; ".join(errs)
