#!/usr/bin/env bash
# Live echo-bot harness (Debian 13 container, real Wire backend).
#   up      sync the channel into .dev/nanoclaw, build, start (detached)
#   logs    follow logs
#   status  is the channel connected? (last connection line)
#   kill-worker  SIGKILL the SDK worker to test crash recovery
#   down    stop; keep the state volume (identity survives)
#   reset   DELETE the state volume: the app registers as a new device and
#           needs a fresh token (scripts/wire-register-app.mjs refresh)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
compose=(docker compose -f "$here/compose.yaml")

case "${1:-}" in
  up)
    [ -f "$here/wire-app.env" ] || {
      echo "missing test/live/wire-app.env — create it with:" >&2
      echo "  node scripts/wire-register-app.mjs create --host <nginz-url> --email <admin> --name 'NanoClaw test' --out test/live/wire-app.env" >&2
      exit 1
    }
    [ -d "$root/.dev/nanoclaw" ] || { echo "missing .dev/nanoclaw (see AGENTS.md)" >&2; exit 1; }
    "$root/scripts/sync-to-nanoclaw.sh" "$root/.dev/nanoclaw"
    "${compose[@]}" up -d --build
    echo "started; follow with: test/live/run.sh logs"
    ;;
  logs) "${compose[@]}" logs -f echo ;;
  status) "${compose[@]}" logs echo 2>&1 | grep -E "echo: (setup done|connected=)|Wire (connected|reconnected|disconnected)" | tail -1 ;;
  kill-worker)
    "${compose[@]}" exec echo sh -c 'for p in /proc/[0-9]*; do pid=${p#/proc/}; [ "$pid" = "$$" ] && continue; case "$(tr "\0" " " < $p/cmdline 2>/dev/null)" in *node*wire-worker.*) kill -9 "$pid" && echo "killed worker pid $pid";; esac; done'
    ;;
  down) "${compose[@]}" down ;;
  reset)
    read -r -p "Delete the live app's device identity? [y/N] " ok
    [ "$ok" = "y" ] && "${compose[@]}" down -v
    ;;
  *) sed -n '2,9p' "$0"; exit 1 ;;
esac
