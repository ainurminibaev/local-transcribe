#!/usr/bin/env python3
"""Синхронизация самостоятельных ресурсов навыка с исходниками репозитория."""
import argparse
import shutil
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'bb-plugin/skills/local-transcribe'
PAIRS = [('docs/транскрибация-и-итоги.md', 'references/workflow.md'),
         ('docs/reliability.md', 'references/reliability.md'),
         ('docs/diarization.md', 'references/diarization.md'),
         ('templates/md2pdf.sh', 'templates/md2pdf.sh'),
         ('templates/normalize_md.py', 'templates/normalize_md.py'),
         ('templates/итоги.css', 'templates/итоги.css')]
DOWNLOADER = ROOT / 'skills/video-downloader'
DOWNLOADER_DEST = ROOT / 'bb-plugin/skills/video-downloader'
def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--check', action='store_true'); args = ap.parse_args()
    stale = []
    for source, target in PAIRS:
        src, dst = ROOT / source, DEST / target
        if args.check:
            if not dst.exists() or src.read_bytes() != dst.read_bytes(): stale.append(target)
        else:
            dst.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(src, dst)
    for src in DOWNLOADER.rglob('*'):
        if not src.is_file() or '__pycache__' in src.parts: continue
        dst = DOWNLOADER_DEST / src.relative_to(DOWNLOADER)
        if args.check:
            if not dst.exists() or src.read_bytes() != dst.read_bytes(): stale.append(str(dst.relative_to(ROOT)))
        else:
            dst.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(src, dst)
    if stale: raise SystemExit('Stale skill resources: ' + ', '.join(stale))
    print('Skill resources OK')
if __name__ == '__main__': main()
