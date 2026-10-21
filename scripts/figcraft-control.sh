#!/bin/sh
# Start the FigCraft desktop app with its loopback control channel enabled, so the
# figcraft-app-mcp bridge can drive the running app.
#
# Usage:
#   scripts/figcraft-control.sh [port]        # default: the port in .control-port, else 7987
#
# Why the wrapper app instead of `open -n /Applications/FigCraft.app --args --control PORT`:
# on this machine `open --args` often does not hand the flag to the app, and an app started
# straight from a shell binds the port but gets no GUI session — its UI thread then never
# answers ("timed out waiting for the UI"). The wrapper .app is launched through
# LaunchServices and execs the real binary with the flag.
set -eu

HERE="$(cd "$(dirname "$0")/.." && pwd)"
WRAPPER="$HERE/tools/FigCraftControl.app"

PORT="${1:-}"
if [ -z "$PORT" ]; then
  if [ -f "$HERE/.control-port" ]; then
    IFS= read -r PORT < "$HERE/.control-port" || PORT=""
  fi
  PORT="${PORT:-7987}"
fi

if [ ! -d "$WRAPPER" ]; then
  echo "the wrapper app is missing: $WRAPPER" >&2
  exit 1
fi

if lsof -nP -iTCP:"$PORT" 2>/dev/null | grep -q LISTEN; then
  echo "a FigCraft instance already listens on 127.0.0.1:$PORT"
  exit 0
fi

echo "$PORT" > "$HERE/.control-port"
echo "launching FigCraft with --control $PORT (via $WRAPPER)"
open -n "$WRAPPER"

sleep 3
if lsof -nP -iTCP:"$PORT" 2>/dev/null | grep -q LISTEN; then
  echo "FigCraft control channel listening on 127.0.0.1:$PORT"
else
  echo "the control channel did not come up on port $PORT (see $HERE/figcraft-control.log)" >&2
  exit 1
fi
