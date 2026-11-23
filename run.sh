#!/usr/bin/env sh
# Starts Code Studio. Keep this terminal open while you use the IDE.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "Node.js was not found. The Code Studio launcher needs Node.js 18 or newer."
  echo "  macOS:   brew install node"
  echo "  Ubuntu:  sudo apt install nodejs     (or use https://nodejs.org)"
  echo
  exit 1
fi

exec node server.js "$@"
