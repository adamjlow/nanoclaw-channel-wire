#!/usr/bin/env bash
# Apply the Wire channel into a NanoClaw checkout, the way the add-wire skill
# does: copy files, add the barrel import, pin the SDK. Idempotent.
# Usage: scripts/sync-to-nanoclaw.sh <nanoclaw-checkout>
set -euo pipefail

SDK_SPEC="@wireapp/wire-apps-js-sdk@0.1.0"
here="$(cd "$(dirname "$0")/.." && pwd)"
target="${1:?usage: $0 <nanoclaw-checkout>}"
target="$(cd "$target" && pwd)"

grep -q '"name": "nanoclaw"' "$target/package.json" || { echo "not a NanoClaw checkout: $target" >&2; exit 1; }

files=(
  src/channels/wire.ts
  src/channels/wire-worker.ts
  src/channels/wire-protocol.ts
  src/channels/wire-registration.test.ts
  src/channels/wire.test.ts
  src/channels/wire-worker.test.ts
  src/channels/wire-protocol.test.ts
  scripts/wire-register-app.mjs
)
for f in "${files[@]}"; do
  [ -f "$here/$f" ] || continue
  install -D -m 0644 "$here/$f" "$target/$f"
done
if [ -d "$here/container/skills/wire-formatting" ]; then
  mkdir -p "$target/container/skills/wire-formatting"
  cp -R "$here/container/skills/wire-formatting/." "$target/container/skills/wire-formatting/"
fi
if [ -d "$here/.claude/skills/add-wire" ]; then
  mkdir -p "$target/.claude/skills/add-wire"
  cp -R "$here/.claude/skills/add-wire/." "$target/.claude/skills/add-wire/"
fi

barrel="$target/src/channels/index.ts"
grep -qxF "import './wire.js';" "$barrel" || echo "import './wire.js';" >> "$barrel"

if ! grep -q '"@wireapp/wire-apps-js-sdk": "0.1.0"' "$target/package.json"; then
  (cd "$target" && pnpm add "$SDK_SPEC")
fi
echo "Wire channel synced into $target"
