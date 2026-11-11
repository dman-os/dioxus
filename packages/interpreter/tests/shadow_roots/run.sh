#!/usr/bin/env bash
# Runs the shadow-root browser harness in Chromium and WebKit (the engine behind wry on Linux), once with
# each bundle loaded as its own module and once pasted into a single script the way desktop does.
# Usage: PLAYWRIGHT_CORE=<playwright-core dir> tests/shadow_roots/run.sh
#   e.g. PLAYWRIGHT_CORE=$(nix build --no-link --print-out-paths nixpkgs#playwright-driver)
#        PLAYWRIGHT_BROWSERS_PATH=$(nix build --no-link --print-out-paths nixpkgs#playwright-driver.browsers)
set -euo pipefail
cd "$(dirname "$0")/../.."
python3 -m http.server 8765 --bind 127.0.0.1 >/dev/null 2>&1 &
srv=$!
trap 'kill $srv' EXIT
sleep 1
status=0
for engine in chromium webkit; do
  for query in "" "?mode=desktop"; do
    echo "== $engine ${query:-modules}"
    node tests/shadow_roots/run.mjs "$engine" "http://127.0.0.1:8765/tests/shadow_roots/index.html$query" || status=1
  done
done
exit $status
