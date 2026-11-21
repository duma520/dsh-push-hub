# -*- coding: utf-8 -*-
"""极简 HTTP 客户端：只用标准库，失败一律变成返回值，不抛异常。

返回值统一是 (status, body_text)：
  status 为 None 表示连不上（超时 / DNS / 代理不通），body_text 是异常描述。
  status 为数字表示拿到了 HTTP 响应（含 4xx / 5xx）。
"""
import json
import urllib.error
import urllib.request

DEFAULT_TIMEOUT = 25


def post_json(url, payload, headers=None, proxy=None, timeout=DEFAULT_TIMEOUT):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    h = {"Content-Type": "application/json"}
    if headers:
        h.update(headers)
    return _send(url, body, h, proxy, timeout, "POST")


def get_json(url, headers=None, proxy=None, timeout=DEFAULT_TIMEOUT):
    h = {"Content-Type": "application/json"}
    if headers:
        h.update(headers)
    return _send(url, None, h, proxy, timeout, "GET")


def _send(url, body, headers, proxy, timeout, method):
    handlers = []
    if proxy:
        handlers.append(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
    opener = urllib.request.build_opener(*handlers)
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with opener.open(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        try:
            return e.code, e.read().decode("utf-8", "replace")
        except Exception:
            return e.code, ""
    except Exception as e:
        return None, "%s: %s" % (type(e).__name__, e)


def loads(text, default=None):
    """宽容 JSON 解析，失败返回 default。"""
    try:
        return json.loads(text)
    except Exception:
        return default
