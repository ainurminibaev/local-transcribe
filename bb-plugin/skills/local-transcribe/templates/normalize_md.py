#!/usr/bin/env python3
"""Нормализатор markdown перед сборкой PDF (pandoc/weasyprint).

Чинит самую частую поломку вёрстки: список (`- `, `* `, `1. `), идущий
сразу за строкой-абзацем без пустой строки. Pandoc в этом случае приклеивает
пункты к абзацу и они не переносятся. Скрипт вставляет недостающую пустую
строку. Идемпотентен: повторный прогон ничего не портит.

Использование:
    python3 normalize_md.py IN.md OUT.md      # записать в OUT
    python3 normalize_md.py IN.md             # печать в stdout
"""
import sys, re

ITEM = re.compile(r"^(\s*)([-*]\s|\d+[.)]\s)")

def normalize(text: str) -> str:
    lines = text.split("\n")
    out = []
    in_fence = False
    for ln in lines:
        stripped = ln.lstrip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_fence = not in_fence
            out.append(ln)
            continue
        if not in_fence and ITEM.match(ln) and out:
            prev = out[-1]
            prev_is_item = bool(ITEM.match(prev))
            prev_is_heading = prev.lstrip().startswith("#")
            # пустую строку ставим, только если сверху непустой абзац
            if prev.strip() and not prev_is_item and not prev_is_heading:
                out.append("")
        out.append(ln)
    return "\n".join(out)

def main():
    if len(sys.argv) < 2:
        sys.exit("usage: normalize_md.py IN.md [OUT.md]")
    src = open(sys.argv[1], encoding="utf-8").read()
    res = normalize(src)
    if len(sys.argv) >= 3:
        open(sys.argv[2], "w", encoding="utf-8").write(res)
    else:
        sys.stdout.write(res)

if __name__ == "__main__":
    main()
