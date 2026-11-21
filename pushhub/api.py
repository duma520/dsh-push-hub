# -*- coding: utf-8 -*-
"""对外统一入口：send / send_all。

判定规则（踩过坑，写死在这里）：
  - 只要任一「硬通道」成功，整体就算成功，退出码 0。
  - 硬通道 = 非 wechat 的所有已配置通道。微信目前服务端不通（-2 prepare failed），
    按 best-effort 处理：失败只记录一行，不拖累其它通道。
"""
from . import config as cfgmod
from .channels import feishu, qq, telegram, wechat

SENDERS = {
    telegram.NAME: telegram,
    feishu.NAME: feishu,
    qq.NAME: qq,
    wechat.NAME: wechat,
}

BEST_EFFORT = {"wechat"}


def send_all(cfg, text, channels, accounts=None):
    """逐通道发。返回 {通道: (ok, detail)}。

    accounts: {通道: 账号 name}，用于在同通道多账号时指定用哪个。
    """
    accounts = accounts or {}
    result = {}
    for ch in channels:
        mod = SENDERS.get(ch)
        if not mod:
            result[ch] = (False, "未知通道")
            continue
        acc = cfgmod.account(cfg, ch, name=accounts.get(ch))
        if not acc:
            result[ch] = (False, "未配置该通道账号")
            continue
        try:
            result[ch] = mod.send(text, acc, cfg)
        except Exception as e:
            result[ch] = (False, "%s: %s" % (type(e).__name__, e))
    return result


def send(text, channels=None, cfg=None, accounts=None):
    """便捷入口。返回 (整体是否成功, {通道: (ok, detail)})。"""
    cfg = cfg or cfgmod.load()
    channels = tuple(channels or cfgmod.default_channels(cfg))
    res = send_all(cfg, text, channels, accounts)
    hard = [ch for ch in res if ch not in BEST_EFFORT]
    if hard:
        overall = any(res[ch][0] for ch in hard)
    else:
        overall = any(ok for ok, _ in res.values())
    return overall, res
