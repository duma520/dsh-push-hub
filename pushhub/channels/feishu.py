# -*- coding: utf-8 -*-
"""飞书 / Lark 自建应用机器人。

流程：tenant_access_token/internal -> im/v1/messages?receive_id_type=open_id
"""
import json
import time

from ..httpc import loads, post_json
from ..textutil import split_blocks

NAME = "feishu"
MAX_CHARS = 2000


def _base(acc):
    return "https://open.larksuite.com" if acc.get("domain") == "larksuite" else "https://open.feishu.cn"


def send(text, acc, cfg=None):
    base = _base(acc)
    st, body = post_json(base + "/open-apis/auth/v3/tenant_access_token/internal",
                         {"app_id": acc.get("appId"), "app_secret": acc.get("appSecret")})
    tk = (loads(body, {}) or {}).get("tenant_access_token")
    if st != 200 or not tk:
        return False, "取 token 失败 HTTP %s %s" % (st, body[:160])

    peer = (acc.get("allowFrom") or [None])[0]
    if not peer:
        return False, "缺 allowFrom"
    rtype = "chat_id" if peer.startswith("oc_") else "open_id"
    url = base + "/open-apis/im/v1/messages?receive_id_type=" + rtype
    delay = (acc.get("sendChunkDelayMs") or 1500) / 1000.0
    ok, errs = 0, []
    for blk in split_blocks(text, acc.get("maxMessageChars") or MAX_CHARS):
        st2, b2 = post_json(url, {"receive_id": peer, "msg_type": "text",
                                  "content": json.dumps({"text": blk}, ensure_ascii=False)},
                            headers={"Authorization": "Bearer " + tk})
        code = (loads(b2, {}) or {}).get("code")
        if st2 != 200 or code not in (0, None):
            errs.append("HTTP %s %s" % (st2, b2[:200]))
            break
        ok += 1
        time.sleep(delay)
    return (ok > 0), ("已发 %d 块" % ok) if not errs else "; ".join(errs)
