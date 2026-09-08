#!/bin/sh
set -eu

# Keep the source checkout runnable on machines that have Node/npm but do not have Bun
# installed globally. The version stays aligned with package.json's packageManager field.
BUN_VERSION="1.4.0"
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
cd "$ROOT_DIR"

configured_bun="${CODEX_WEB_GPT_BUN:-${CODEX_CHATGPT_WEB_BUN:-}}"
if [ -n "$configured_bun" ]; then
  if [ ! -x "$configured_bun" ]; then
    echo "Configured Bun executable is not runnable: $configured_bun" >&2
    exit 1
  fi
  exec "$configured_bun" run scripts/start-launcher.ts "$@"
fi

if command -v bun >/dev/null 2>&1; then
  exec bun run scripts/start-launcher.ts "$@"
fi

if command -v npm >/dev/null 2>&1; then
  echo "Bun is not installed; using npm to run the pinned Bun $BUN_VERSION runtime." >&2
  exec npm exec --yes --package="bun@$BUN_VERSION" -- bun run scripts/start-launcher.ts "$@"
fi

echo "Bun is not installed and npm is unavailable. Install Node.js/npm or Bun, then rerun ./run-app.sh." >&2
exit 1
