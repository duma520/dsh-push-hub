# -*- coding: utf-8 -*-
"""文本切块：各通道有单条字数上限，超了要拆。"""

NL = chr(10)


def split_blocks(text, limit):
    """按行切成不超过 limit 字符的块；单行超长时硬切。"""
    if limit <= 0:
        return [text] if text else []
    blocks, cur = [], ""
    for line in (text or "").split(NL):
        if len(cur) + len(line) + 1 > limit:
            if cur:
                blocks.append(cur)
            while len(line) > limit:
                blocks.append(line[:limit])
                line = line[limit:]
            cur = line
        else:
            cur = (cur + NL + line) if cur else line
    if cur:
        blocks.append(cur)
    return blocks


def clip(text, limit):
    """截断到 limit 字符（用于标题之类不需要分块的场景）。"""
    text = text or ""
    return text if len(text) <= limit else text[:max(0, limit - 1)] + "…"
