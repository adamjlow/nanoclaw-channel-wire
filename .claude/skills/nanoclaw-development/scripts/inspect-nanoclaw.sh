#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-.}"
cd "$ROOT"

if [[ ! -f package.json ]]; then
  echo "error: package.json not found in $(pwd)" >&2
  exit 2
fi

if ! grep -q '"name"[[:space:]]*:[[:space:]]*"nanoclaw"' package.json; then
  echo "warning: package.json does not identify this checkout as nanoclaw" >&2
fi

echo "== NanoClaw development preflight =="
echo "root: $(pwd)"

if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "commit: $(git rev-parse --short HEAD)"
  echo "branch: $(git branch --show-current 2>/dev/null || true)"
  echo "dirty files: $(git status --porcelain | wc -l | tr -d ' ')"
fi

node -e '
const fs=require("fs");
const p=JSON.parse(fs.readFileSync("package.json","utf8"));
console.log(`package version: ${p.version || "unknown"}`);
console.log(`node engine: ${(p.engines&&p.engines.node)||"unspecified"}`);
console.log(`package manager: ${p.packageManager||"unspecified"}`);
console.log(`chat sdk: ${(p.dependencies&&p.dependencies.chat)||"not in root dependencies"}`);
'

echo
echo "Key docs present:"
for f in CLAUDE.md CONTRIBUTING.md CHANGELOG.md docs/architecture.md docs/SECURITY.md docs/skill-guidelines.md docs/skills-model.md docs/skill-directives.md; do
  [[ -f "$f" ]] && echo "  yes  $f" || echo "  no   $f"
done

echo
echo "Channel files:"
if [[ -d src/channels ]]; then
  find src/channels -maxdepth 1 -type f -print | sort | sed 's/^/  /'
else
  echo "  src/channels not found"
fi

echo
echo "Likely channel/API seams:"
if command -v rg >/dev/null 2>&1; then
  rg -n --no-heading \
    'register.*Channel|register.*Adapter|createChatSdkBridge|DeliveryAction|register.*Route|setTyping|setThreadTitle|setSuggestedPrompts' \
    src/channels src 2>/dev/null | head -n 120 || true
else
  grep -RInE \
    'register.*Channel|register.*Adapter|createChatSdkBridge|DeliveryAction|register.*Route|setTyping|setThreadTitle|setSuggestedPrompts' \
    src/channels src 2>/dev/null | head -n 120 || true
fi

echo
echo "Do not infer the adapter contract from this report alone. Open the matching source and tests before editing."
