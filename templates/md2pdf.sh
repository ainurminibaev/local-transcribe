#!/usr/bin/env bash
set -euo pipefail
if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo 'usage: md2pdf.sh INPUT.md [OUTPUT.pdf]' >&2
  exit 2
fi
MD="$1"
PDF="${2:-${MD%.md}.pdf}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
python3 "$DIR/normalize_md.py" "$MD" "$WORK/input.md"
if [[ "$(uname -s)" == Darwin ]]; then
  export DYLD_FALLBACK_LIBRARY_PATH="/opt/homebrew/lib${DYLD_FALLBACK_LIBRARY_PATH:+:$DYLD_FALLBACK_LIBRARY_PATH}"
fi
pandoc "$WORK/input.md" -o "$WORK/output.pdf" -s --pdf-engine=weasyprint -c "$DIR/итоги.css" -M lang=ru
[[ -s "$WORK/output.pdf" ]]
mv "$WORK/output.pdf" "$PDF"
echo "OK -> $PDF"
