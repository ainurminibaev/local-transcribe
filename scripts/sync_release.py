#!/usr/bin/env python3
"""Generate the root Git-install manifest from the development plugin package."""
import argparse,json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def main():
 ap=argparse.ArgumentParser();ap.add_argument('--check',action='store_true');args=ap.parse_args()
 source=json.loads((ROOT/'bb-plugin/package.json').read_text());root=json.loads(json.dumps(source))
 for key in ['server','host','app']:root['bb'][key]='./bb-plugin/'+root['bb'][key].removeprefix('./')
 root['bb']['skills']=['bb-plugin/skills'];root['scripts']={'build':'bb plugin build .'}
 text=json.dumps(root,ensure_ascii=False,indent=2)+'\n';target=ROOT/'package.json'
 if args.check:
  if not target.exists() or target.read_text()!=text:raise SystemExit('Release manifest stale')
 else:target.write_text(text)
 print('Release manifest OK')
if __name__=='__main__':main()
