#!/usr/bin/env bash
#
# w8rez — end-to-end test driver.
#
# Boots the local server, opens the app in a real Chrome tab through
# agent-browser, injects tests/e2e.browser.js and prints every check.
#
# Usage:  bash tests/e2e.sh [port]
# Exit:   0 when every check passes, 1 otherwise.
#
set -uo pipefail

PORT="${1:-8091}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIX="$ROOT/tests/fixtures"
URL="http://127.0.0.1:$PORT"
LOG=/tmp/w8rez-e2e-server.log
DOWNLOADS=/tmp/w8rez-e2e-downloads

cd "$ROOT" || exit 1

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# ── fixtures ────────────────────────────────────────────────────────────
say "1/5  fixtures → tests/fixtures/"
mkdir -p "$FIX"
# PDFs via Pillow (ImageMagick's policy usually blocks PDF/EPS writers).
if [ ! -f "$FIX/multipage.pdf" ] || [ ! -f "$FIX/test.pdf" ]; then
  python3 - "$ROOT" "$FIX" <<'PY' 2>/dev/null || true
import os, sys
from PIL import Image
root, fix = sys.argv[1], sys.argv[2]
im = Image.open(os.path.join(root, 'samples', 'demo.png')).convert('RGB')
im.save(os.path.join(fix, 'test.pdf'), 'PDF', resolution=150)
im.save(os.path.join(fix, 'multipage.pdf'), 'PDF', resolution=150, save_all=True, append_images=[im])
PY
fi
# EPS is a tiny hand-written PostScript program: no converter needed.
if [ ! -f "$FIX/test.eps" ]; then
  cat > "$FIX/test.eps" <<'EPS'
%!PS-Adobe-3.0 EPSF-3.0
%%Creator: w8rez test suite
%%BoundingBox: 0 0 200 150
%%Pages: 1
%%EndComments
%%Page: 1 1
0.85 setgray 0 0 200 150 rectfill
0 setgray 40 40 120 70 rectfill
0.4 setgray 60 60 80 30 rectfill
showpage
%%EOF
EPS
fi
if [ ! -f "$FIX/clip.mp4" ] && command -v ffmpeg >/dev/null; then
  # A moving pattern: playback and frame sampling must visibly change.
  ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc=size=320x240:rate=12 -t 4 \
    -pix_fmt yuv420p -c:v libx264 -movflags +faststart "$FIX/clip.mp4" 2>/dev/null
  ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc=size=320x240:rate=12 -t 3 \
    -c:v mpeg4 "$FIX/legacy.avi" 2>/dev/null
fi
ls -1 "$FIX" 2>/dev/null | sed 's/^/     /'
for need in test.pdf multipage.pdf test.eps clip.mp4 legacy.avi; do
  [ -f "$FIX/$need" ] || { echo "     ! missing $need (needs python3-Pillow and ffmpeg); related checks will fail"; RC_MISSING=1; }
done

# ── server ──────────────────────────────────────────────────────────────
say "2/5  server on $URL"
pkill -f "node server.js" >/dev/null 2>&1
sleep 1
(nohup env PORT="$PORT" W8REZ_TEST_FIXTURES=1 node server.js >"$LOG" 2>&1 &)
for _ in $(seq 1 25); do
  sleep 0.4
  if curl -fsS "$URL/api/status" >/tmp/w8rez-e2e-status.json 2>/dev/null; then break; fi
done
if ! curl -fsS "$URL/api/status" >/tmp/w8rez-e2e-status.json 2>/dev/null; then
  echo "     ! server did not start; see $LOG"; tail -5 "$LOG"; exit 1
fi
cat /tmp/w8rez-e2e-status.json | sed 's/^/     /'
echo

# ── browser ─────────────────────────────────────────────────────────────
say "3/5  browser session"
export AGENT_BROWSER_SESSION="${AGENT_BROWSER_SESSION:-w8rez-e2e-$$}"
agent-browser close >/dev/null 2>&1
agent-browser open "$URL/" >/dev/null
agent-browser wait 900 >/dev/null 2>&1
# Pin the viewport to the design canvas so the fidelity checks are exact.
agent-browser set viewport 1440 900 >/dev/null 2>&1
agent-browser wait 400 >/dev/null 2>&1
TITLE="$(agent-browser get title 2>/dev/null)"
echo "     session: $AGENT_BROWSER_SESSION  title: $TITLE"

# ── inject the harness ──────────────────────────────────────────────────
say "4/5  running the in-page suite"
agent-browser eval "$(cat tests/e2e.browser.js)" >/dev/null
STARTED="$(agent-browser eval "window.W8REZ_E2E.run(); 'started'" 2>&1 | tail -1)"
echo "     $STARTED"
REPORT=""
for _ in $(seq 1 300); do
  sleep 2
  REPORT="$(agent-browser get text '#w8rez-e2e-report' 2>/dev/null)"
  case "$REPORT" in *SUMMARY*) break ;; esac
done

if [ -z "$REPORT" ]; then
  echo "     ! the suite never finished"; exit 1
fi

# ── report ──────────────────────────────────────────────────────────────
say "5/5  results"
RC=0
while IFS=$'\t' read -r status name ms detail; do
  case "$status" in
    PASS) printf '  \033[32mPASS\033[0m  %-64s %8s  %s\n' "$name" "$ms" "$detail" ;;
    FAIL) printf '  \033[31mFAIL\033[0m  %-64s %8s  %s\n' "$name" "$ms" "$detail"; RC=1 ;;
    SUMMARY) printf '\n  %s\n' "$name" ;;
  esac
done <<< "$REPORT"

# ── explicit download checks (blob URLs need the CLI to capture them) ───
say "extra: real downloads"
mkdir -p "$DOWNLOADS"; rm -f "$DOWNLOADS"/*
for pair in "btn-txt:txt" "btn-png:png" "btn-html:html"; do
  id="${pair%%:*}"; ext="${pair##*:}"
  rm -f "$DOWNLOADS/out.$ext"
  ok=1
  for _ in 1 2; do
    agent-browser wait 400 >/dev/null 2>&1
    agent-browser download "#$id" "$DOWNLOADS/out.$ext" >/dev/null 2>&1 || true
    size=$(stat -c%s "$DOWNLOADS/out.$ext" 2>/dev/null || echo 0)
    if [ "$size" -gt 20 ]; then ok=0; break; fi
    sleep 1
  done
  if [ "$ok" = 0 ]; then echo "  PASS  download .$ext ($size bytes)"; else echo "  FAIL  download .$ext (not captured)"; RC=1; fi
done

agent-browser screenshot /tmp/w8rez-e2e-final.png >/dev/null 2>&1 && echo "  screenshot: /tmp/w8rez-e2e-final.png"
agent-browser close >/dev/null 2>&1
pkill -f "node server.js" >/dev/null 2>&1

say "exit $RC"
exit $RC
