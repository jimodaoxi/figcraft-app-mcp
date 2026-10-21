#!/bin/sh
# (Re)prepare the wrapper app that starts FigCraft with its control channel.
#
# The wrapper is checked in, but its ad-hoc code signature is machine-local: run this
# script after cloning (or after changing the port) to re-sign it and set the port.
#
# Usage: scripts/install-control-app.sh [port]
set -eu

HERE="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HERE/tools/FigCraftControl.app"
PORT_FILE="$HERE/.control-port"

PORT="${1:-}"
if [ -z "$PORT" ] && [ -f "$PORT_FILE" ]; then
  IFS= read -r PORT < "$PORT_FILE" || PORT=""
fi
PORT="${PORT:-7987}"

if [ ! -f "$APP/Contents/MacOS/FigCraftControl" ]; then
  echo "the wrapper app is missing: $APP" >&2
  exit 1
fi

printf '%s\n' "$PORT" > "$PORT_FILE"
chmod +x "$APP/Contents/MacOS/FigCraftControl"

if command -v codesign >/dev/null 2>&1; then
  codesign -s - --force "$APP" >/dev/null 2>&1 ||
    echo "codesign failed; the app still runs locally after a right-click > Open"
fi

echo "wrapper ready: $APP  (control port $PORT)"
echo "start it with: open -n $APP"
