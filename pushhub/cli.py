# -*- coding: utf-8 -*-
"""命令行入口：python -m pushhub ...

常见用法：
    python -m pushhub --selftest
    python -m pushhub --title "下载完成" --text "正文"
    python -m pushhub --selftest --channels telegram,feishu,qq
    python -m pushhub --list
    python -m pushhub --text x --dry-run
    python -m pushhub --text x --json
退出码：0 = 至少一条硬通道成功；1 = 全失败；3 = 参数/环境错误。
"""
import argparse
import json
import sys
import time

from . import __version__
from . import config as cfgmod
from .api import BEST_EFFORT, send


def _list_channels(cfg):
    rows = []
    for ch in ("telegram", "feishu", "qq", "wechat"):
        accs = ((cfg.get(ch) or {}).get("accounts") or [])
        names = [a.get("name") or "(无名)" for a in accs]
        ready = sum(1 for a in accs if a.get("token") or a.get("appId") or a.get("botToken"))
        rows.append((ch, len(accs), ready, ", ".join(names[:4]) + (" …" if len(names) > 4 else "")))
    return rows


def main(argv=None):
    ap = argparse.ArgumentParser(prog="pushhub", description="把消息推到手机（TG / 飞书 / QQ / 微信）")
    ap.add_argument("--title", default="", help="标题，会拼在正文第一行")
    ap.add_argument("--text", default="", help="正文")
    ap.add_argument("--from-job", default="", help="从下载任务的 state/<job>_speed.json 拼一份完成报告")
    ap.add_argument("--state-dir", default="", help="--from-job / --watch 用的 state 目录，默认当前目录下 state/")
    ap.add_argument("--channels", default="", help="逗号分隔，默认取 config 的 default_channels")
    ap.add_argument("--account", action="append", default=[],
                    metavar="通道=账号名", help="指定某通道用哪个账号，可重复")
    ap.add_argument("--config", default="", help="额外的覆盖配置文件")
    ap.add_argument("--dry-run", action="store_true", help="只打印不发")
    ap.add_argument("--selftest", action="store_true", help="发一条通道自检消息")
    ap.add_argument("--list", action="store_true", help="列出各通道账号与就绪情况")
    ap.add_argument("--watch", default="", metavar="JOB",
                    help="当哨兵：盯 state/<JOB>_speed.json，任务结束后自动推送一次")
    ap.add_argument("--idle-min", type=float, default=15.0, help="--watch：静止多少分钟算结束")
    ap.add_argument("--max-hours", type=float, default=6.0, help="--watch：最多盯多少小时")
    ap.add_argument("--interval", type=int, default=30, help="--watch：轮询间隔秒")
    ap.add_argument("--quiet", action="store_true", help="--watch：不打每一轮心跳")
    ap.add_argument("--json", action="store_true", help="以 JSON 输出结果")
    ap.add_argument("--version", action="version", version="pushhub " + __version__)
    a = ap.parse_args(argv)

    cfg = cfgmod.load(a.config or None)

    if a.list:
        rows = _list_channels(cfg)
        if a.json:
            print(json.dumps([dict(zip(("channel", "accounts", "ready", "names"), r)) for r in rows],
                             ensure_ascii=False, indent=2))
        else:
            print("凭据来源：" + cfgmod.bridge_config_path())
            print("%-10s %6s %6s  %s" % ("通道", "账号数", "已就绪", "账号名"))
            for ch, n, ready, names in rows:
                flag = "" if ch not in BEST_EFFORT else "  (best-effort)"
                print("%-10s %6d %6d  %s%s" % (ch, n, ready, names or "-", flag))
            print("默认通道：" + ",".join(cfgmod.default_channels(cfg)))
        return 0

    channels = tuple(c.strip() for c in a.channels.split(",") if c.strip()) or cfgmod.default_channels(cfg)

    # --watch 是「哨兵」模式，不需要正文，必须在正文判空之前处理
    if a.watch:
        from .watch import watch as _watch
        return _watch(a.state_dir or "state", a.watch,
                      interval=a.interval, idle_min=a.idle_min, max_hours=a.max_hours,
                      channels=channels, cfg=cfg, dry_run=a.dry_run, quiet=a.quiet)

    text = a.text
    if a.from_job:
        from .jobs import build_job_report
        text = build_job_report(a.state_dir or "state", a.from_job)
    if a.title:
        text = (a.title + chr(10) + text).strip()
    if a.selftest and not text:
        text = "【通道自检】pushhub %s  %s" % (__version__, time.strftime("%Y-%m-%d %H:%M:%S"))
    if not text:
        ap.print_help()
        return 3

    accounts = {}
    for spec in a.account:
        if "=" in spec:
            k, v = spec.split("=", 1)
            accounts[k.strip()] = v.strip()

    if a.dry_run:
        print("[dry-run] 通道 %s" % (channels,))
        print(text)
        return 0

    overall, res = send(text, channels=channels, cfg=cfg, accounts=accounts)
    if a.json:
        print(json.dumps({"ok": overall,
                          "result": {k: {"ok": v[0], "detail": v[1]} for k, v in res.items()}},
                         ensure_ascii=False, indent=2))
    else:
        for ch, (ok, detail) in res.items():
            tag = "OK  " if ok else "FAIL"
            note = "  (best-effort)" if ch in BEST_EFFORT and not ok else ""
            print("%-9s %s  %s%s" % (ch, tag, detail, note))
        print("整体：" + ("成功" if overall else "失败"))
    return 0 if overall else 1


if __name__ == "__main__":
    sys.exit(main())
