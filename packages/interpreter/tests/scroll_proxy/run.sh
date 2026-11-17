#!/usr/bin/env bash
# Runs the scroll-proxy browser harness in Chromium and WebKit (the engine behind wry on Linux), once with
# each bundle loaded as its own module and once pasted into a single script the way desktop does.
# Same environment as ../shadow_roots/run.sh (PLAYWRIGHT_CORE, PLAYWRIGHT_BROWSERS_PATH).
set -euo pipefail
cd "$(dirname "$0")/../.."
python3 -m http.server 8766 --bind 127.0.0.1 >/dev/null 2>&1 &
srv=$!
trap 'kill $srv' EXIT
sleep 1
status=0
for engine in chromium webkit; do
  for query in "" "?mode=desktop"; do
    echo "== $engine ${query:-modules}"
    node tests/shadow_roots/run.mjs "$engine" "http://127.0.0.1:8766/tests/scroll_proxy/index.html$query" || status=1
  done
done
exit $status
