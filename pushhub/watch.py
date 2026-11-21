# -*- coding: utf-8 -*-
r"""通用完成哨兵：盯一个 speed.json，任务结束就推送一次。

判定（任一命中即推送并退出）：
  1. files_done >= files_total          -> 正常完成
  2. speed.json 超过 idle_min 分钟没更新 -> 进程大概率已退出/卡死，按当前进度推送
  3. 超过 max_hours 仍未结束            -> 退出码 3，不发（防止无限挂着）

为什么放在 Push_Hub 而不是各项目里：这是「通知」职责，跟具体哪个下载器无关。
speed.json 只要长这样就能用：
  {"files_done": 12, "files_total": 100, "session_mb": 345.6, "fail": 0,
   "current": "xxx.mp4", "proxy": "socks5 1.2.3.4:1080"}
"""
import json
import os
import time

from . import config as cfgmod
from . import jobs
from .api import send


def _read(p):
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _mtime(p):
    try:
        return os.path.getmtime(p)
    except OSError:
        return 0.0


def watch(state_dir, job="dl3", interval=30, idle_min=15.0, max_hours=6.0,
          channels=None, cfg=None, dry_run=False, quiet=False):
    """返回退出码：0 = 已推送，3 = 超时放弃。"""
    sp = os.path.join(state_dir, job + "_speed.json")
    cfg = cfg or cfgmod.load()
    deadline = time.time() + max_hours * 3600
    idle_limit = idle_min * 60
    if not quiet:
        print("[watch] 盯 " + sp + "，每 %ds，静止阈值 %.0f 分钟" % (interval, idle_min), flush=True)

    while time.time() < deadline:
        d = _read(sp)
        age = time.time() - _mtime(sp)
        done, total = d.get("files_done"), d.get("files_total")
        if not quiet:
            print("  %s done=%s/%s sess=%s fail=%s 静止=%.0fs"
                  % (time.strftime("%H:%M:%S"), done, total,
                     d.get("session_mb"), d.get("fail"), age), flush=True)

        reason = None
        if isinstance(done, int) and isinstance(total, int) and total > 0 and done >= total:
            reason = "正常完成 %d/%d" % (done, total)
        elif age > idle_limit:
            reason = "speed.json 已静止 %.0f 分钟（%s/%s）" % (idle_min, done, total)
        if reason:
            print("[watch] 触发：" + reason, flush=True)
            text = jobs.build_job_report(state_dir, job)
            if d.get("_watch_reason_hint"):
                pass
            if dry_run:
                print(text)
                return 0
            overall, res = send(text, channels=channels, cfg=cfg)
            for ch, (ok, detail) in res.items():
                print("  %-9s %s  %s" % (ch, "OK  " if ok else "FAIL", detail))
            return 0
        time.sleep(interval)

    print("[watch] 超过 %.1f 小时仍未结束，退出，不发通知" % max_hours, flush=True)
    return 3
