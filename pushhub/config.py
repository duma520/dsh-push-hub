# -*- coding: utf-8 -*-
"""凭据与偏好加载。

来源优先级（后者覆盖前者）：
  1. dsh-bridge 的 config.json      ~\.dsh\dsh-bridge\config.json   —— 凭据的真实来源
  2. 环境变量指定文件               PUSH_HUB_CONFIG=<path>
  3. 本包根目录 config.json         只放覆盖项（默认通道、换 peer 之类）

取舍：凭据只有一份（dsh-bridge 里那份），本库不复制、不落盘、不打印。
"""
import json
import os
import tempfile

PKG_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCAL_CONFIG = os.path.join(PKG_ROOT, "config.json")
BRIDGE_CONFIG = os.path.expanduser(r"~\.dsh\dsh-bridge\config.json")

DEFAULT_CHANNELS = ("telegram", "feishu", "qq")


def _read(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def _merge(base, over):
    out = dict(base or {})
    for k, v in (over or {}).items():
        out[k] = v
    return out


def bridge_config_path():
    return BRIDGE_CONFIG


def local_config_path():
    return LOCAL_CONFIG


def load(path=None):
    """按优先级合并出最终配置。"""
    cfg = _read(BRIDGE_CONFIG)
    env_path = os.environ.get("PUSH_HUB_CONFIG")
    if env_path:
        cfg = _merge(cfg, _read(os.path.expanduser(env_path)))
    if path:
        cfg = _merge(cfg, _read(os.path.expanduser(path)))
    else:
        cfg = _merge(cfg, _read(LOCAL_CONFIG))
    return cfg


def save_local(cfg):
    """把偏好写回本包 config.json（原子写）。"""
    d = os.path.dirname(LOCAL_CONFIG)
    if d and not os.path.isdir(d):
        os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d or ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
        os.replace(tmp, LOCAL_CONFIG)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
    return LOCAL_CONFIG


def account(cfg, channel, name=None, index=0):
    """取某个通道的账号：给了 name 按 name 找，否则取第 index 个。"""
    accs = ((cfg or {}).get(channel) or {}).get("accounts") or []
    if name:
        for a in accs:
            if a.get("name") == name:
                return a
        return None
    return accs[index] if len(accs) > index else None


def default_channels(cfg):
    ch = (cfg or {}).get("default_channels")
    if isinstance(ch, list) and ch:
        return tuple(ch)
    return DEFAULT_CHANNELS
