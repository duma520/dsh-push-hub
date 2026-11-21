# -*- coding: utf-8 -*-
"""QQ 官方机器人（QQ 开放平台 v2 单聊）。

取 token：POST https://bots.qq.com/app/getAppAccessToken {appId, clientSecret}
发消息 ：POST https://api.sgroup.qq.com/v2/users/<openid>/messages
         授权头是 "QQBot <token>"，注意前缀不是 Bearer。
"""
import time

from ..httpc import loads, post_json
from ..textutil import split_blocks

NAME = "qq"
MAX_CHARS = 1800


def send(text, acc, cfg=None):
    st, body = post_json("https://bots.qq.com/app/getAppAccessToken",
                         {"appId": str(acc.get("appId")), "clientSecret": acc.get("appSecret")})
    tk = (loads(body, {}) or {}).get("access_token")
    if st != 200 or not tk:
        return False, "取 token 失败 HTTP %s %s" % (st, body[:160])

    peer = (acc.get("allowFrom") or [None])[0]
    if not peer:
        return False, "缺 allowFrom(openid)"
    url = "https://api.sgroup.qq.com/v2/users/" + peer + "/messages"
    delay = (acc.get("sendChunkDelayMs") or 1500) / 1000.0
    ok, errs = 0, []
    for blk in split_blocks(text, MAX_CHARS):
        st2, b2 = post_json(url, {"content": blk, "msg_type": 0},
                            headers={"Authorization": "QQBot " + tk})
        if st2 not in (200, 201):
            errs.append("HTTP %s %s" % (st2, b2[:200]))
            break
        ok += 1
        time.sleep(delay)
    return (ok > 0), ("已发 %d 块" % ok) if not errs else "; ".join(errs)
