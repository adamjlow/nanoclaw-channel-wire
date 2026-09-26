# Agent Operating Guide

## Repository overview
`nanoclaw-channel-wire`: a [NanoClaw](https://github.com/nanocoai/nanoclaw) v2 channel adapter (channel type
`wire`) for Wire, running as a Wire app on the public `@wireapp/wire-apps-js-sdk`. It's the NanoClaw
counterpart of the sibling `../openclaw-wire` OpenClaw plugin. Read [docs/design.md](docs/design.md)
before starting work, and check [docs/delivery-plan.md](docs/delivery-plan.md) for the current phase.

This repo isn't a standalone package. Its `src/` and `container/` files mirror NanoClaw paths. They're
copied into a NanoClaw checkout by the `add-wire` skill, then built and tested there.

## Skills
Load both repo skills before touching adapter code, and follow their rules:
- `.claude/skills/nanoclaw-development`: NanoClaw contracts, channel shape, skill packaging, security
- `.claude/skills/wire-apps-js-sdk-development`: Wire SDK lifecycle, identity, storage, crypto key

Don't write a NanoClaw identifier until you've seen it in the target NanoClaw checkout's source,
**on `main`** (the `channels` branch lags main). Don't write a Wire SDK identifier until you've seen
it in the installed `node_modules/@wireapp/wire-apps-js-sdk/build/*.d.ts`.

## Layout
| Path | Purpose |
|---|---|
| `src/channels/wire.ts` | Host-side adapter: registration, factory, lifecycle, inbound mapping, delivery. **Never imports the SDK.** |
| `src/channels/wire-worker.ts` | Child process that owns the SDK. **The only file that imports `@wireapp/wire-apps-js-sdk`.** |
| `src/channels/wire-protocol.ts` | IPC message types, qualified-id helpers and redaction, shared by both sides. Import-safe. |
| `src/channels/wire*.test.ts` | Registration (real barrel), adapter (fake worker; mocks the SDK to throw so a host-side import fails), worker (fake SDK), protocol |
| `container/skills/wire-formatting/` | Agent-side guidance on Wire's markdown rendering |
| `.claude/skills/add-wire/` | The install skill: `SKILL.md`, `REMOVE.md` (plus `apply-fixtures.json` once it uses `nc:prompt`) |
| `scripts/sync-to-nanoclaw.sh` | Dev loop: apply the channel into a NanoClaw checkout (idempotent) |
| `scripts/wire-register-app.mjs` | Registers a Wire app and writes its credentials (shipped to users by the skill) |
| `test/live/` | Debian 13 echo-bot harness: the real adapter, worker and SDK against a real backend (`run.sh up\|logs\|down\|reset`) |
| `docs/` | Design, delivery plan, operations |

## Development loop
Reference checkout: `../nanoclaw` (upstream clone; keep it pristine). The dev checkout is
`.dev/nanoclaw` (gitignored): `git clone --shared ../nanoclaw .dev/nanoclaw && (cd .dev/nanoclaw &&
pnpm install --frozen-lockfile)`. pnpm 10 comes via corepack (`corepack enable --install-directory
~/.local/bin`).
```bash
scripts/sync-to-nanoclaw.sh <nanoclaw-checkout>   # apply add-wire into the checkout (idempotent)
cd <nanoclaw-checkout>
pnpm run build && pnpm test                       # NanoClaw's own gates
pnpm exec vitest run src/channels/wire           # focused adapter tests
pnpm exec tsx scripts/skill-directives.ts .claude/skills/add-wire/SKILL.md
```
The Wire SDK's native CoreCrypto library loads only on Linux x86_64 with glibc 2.38 or newer, or on
macOS arm64. This WSL host (glibc 2.35) can't load it, so run live tests in `test/live/`. The
NanoClaw suite has upstream timing flakes (for example `delivery-poll`), which also fail on an
untouched checkout; re-run them in isolation before blaming Wire.

## Rules
- The NanoClaw host process must never load the SDK. `wire.ts` and `wire-protocol.ts` import
  nothing from it; `wire.test.ts` mocks the SDK to throw, which enforces this. Stock SDK 0.1.0 calls `process.exit` on
  SIGTERM, SIGINT and `unhandledRejection`, writes `./storage` relative to cwd, and uses a
  process-global container. It's only safe in its own process.
- **Addressed-only.** The worker forwards only messages addressed to the app: 1:1 messages, group
  @mentions of the app, replies quoting its own messages, and clicks on its own buttons. It
  discards everything else before any lookup, download, IPC or log line, and `wire.ts` re-checks.
  Never add a path that forwards group chatter or group files, or makes this configurable; see
  design Decision 7.
- Never log message text, file names, tokens, the crypto key, or raw user or conversation ids.
  NanoClaw's `log` has no redaction; use the helpers in `wire-protocol.ts`.
- `store/wire/` (SDK `apps.db`, CoreCrypto, and the rotated token) is the app's credential. It's one
  unit with `WIRE_CRYPTO_KEY`. Never mount it into agent containers or delete it as "recovery". One
  worker per app identity, enforced by a lock file.
- Secrets reach the worker over IPC only. Never pass them through argv or environment variables.
- Pin dependencies exactly. Never add `onlyBuiltDependencies` or `minimumReleaseAgeExclude`
  entries; those need human sign-off in NanoClaw.
- Never commit `.env`, `wire-app.env` or anything under `store/`.
- Don't alter SDK crypto behaviour.
