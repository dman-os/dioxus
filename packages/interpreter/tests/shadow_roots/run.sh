#!/usr/bin/env bash
# Runs the shadow-root browser harness headless in Chromium and prints its report.
# Usage: tests/shadow_roots/run.sh   (needs python3 and a `chromium` on PATH)
set -euo pipefail
cd "$(dirname "$0")/../.."
python3 -m http.server 8765 --bind 127.0.0.1 >/dev/null 2>&1 &
srv=$!
trap 'kill $srv' EXIT
sleep 1
chromium --headless --no-sandbox --disable-gpu --virtual-time-budget=5000 --dump-dom \
  http://127.0.0.1:8765/tests/shadow_roots/index.html 2>/dev/null \
  | sed -n '/<pre id="out">/,/<\/pre>/p' | sed 's/<[^>]*>//g'
