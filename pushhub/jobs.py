# -*- coding: utf-8 -*-
"""把下载任务的状态拼成一段人看的中文报告（给 --from-job 用）。"""
import json
import os
import time

NL = chr(10)


def _read(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def build_job_report(state_dir, job="dl3"):
    sp = _read(os.path.join(state_dir, job + "_speed.json"))
    lines = ["【" + job + " 下载完成】"]
    if sp:
        lines.append("文件：%s / %s" % (sp.get("files_done", "?"), sp.get("files_total", "?")))
        if sp.get("session_mb") is not None:
            try:
                lines.append("本次累计：%.0f MB" % float(sp["session_mb"]))
            except (TypeError, ValueError):
                lines.append("本次累计：%s MB" % sp["session_mb"])
        lines.append("失败：%s" % sp.get("fail", "?"))
        if sp.get("current"):
            lines.append("最后文件：%s" % sp["current"])
        if sp.get("proxy"):
            lines.append("代理：%s" % sp["proxy"])
    else:
        lines.append("（没找到 %s_speed.json，任务可能没跑过）" % job)
    lines.append("时间：%s" % time.strftime("%Y-%m-%d %H:%M:%S"))
    return NL.join(lines)
