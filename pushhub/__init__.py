# -*- coding: utf-8 -*-
"""PushHub —— 把消息推到手机的通用通知库。

通道：telegram / feishu / qq / wechat。
凭据不落在本仓库内，运行时从 dsh-bridge 的 config.json 读（见 pushhub.config）。

最小用法：
    from pushhub import send
    send("下载完成", channels=("telegram", "feishu", "qq"))
"""

from .api import send, send_all, SENDERS          # noqa: F401
from .config import (load, save_local, account,    # noqa: F401
                     default_channels, bridge_config_path, local_config_path)

from .watch import watch                # noqa: F401

__version__ = "1.0.0"
__all__ = ["send", "send_all", "SENDERS", "load", "save_local", "account",
           "default_channels", "bridge_config_path", "local_config_path",
           "watch", "__version__"]
