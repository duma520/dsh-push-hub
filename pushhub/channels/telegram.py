# -*- coding: utf-8 -*-
"""Telegram Bot API。

实测要点（2026-11-15）：本机直连 api.telegram.org 超时，
必须用 dsh-bridge config 里该账号的 proxy 字段（http://host:port）。
"""
import time

from ..httpc import loads, post_json
from ..textutil import split_blocks

NAME = "telegram"
MAX_CHARS = 4096


def send(text, acc, cfg=None):
    token = acc.get("botToken")
    chat = (acc.get("allowFrom") or [None])[0]
    if not token or not chat:
        return False, "缺 botToken 或 allowFrom"
    url = "https://api.telegram.org/bot" + token + "/sendMessage"
    delay = (acc.get("sendChunkDelayMs") or 1500) / 1000.0
    ok, errs = 0, []
    for blk in split_blocks(text, acc.get("maxMessageChars") or MAX_CHARS):
        st, body = post_json(url, {"chat_id": chat, "text": blk,
                                   "disable_web_page_preview": True},
                             proxy=acc.get("proxy"))
        d = loads(body, {}) or {}
        if st != 200 or not d.get("ok"):
            errs.append("HTTP %s %s" % (st, body[:200]))
            break
        ok += 1
        time.sleep(delay)
    return (ok > 0), ("已发 %d 块" % ok) if not errs else "; ".join(errs)
