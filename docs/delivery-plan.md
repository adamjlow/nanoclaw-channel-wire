# nanoclaw-channel-wire delivery plan

The phases build on [design.md](design.md). Each phase ends with an exit check that has to pass
before the next phase starts.

## Decisions

| # | Decision | Recommendation |
|---|---|---|
| D1 | **Where it ships.** (a) Upstream: code PR'd onto NanoClaw's `channels` branch and the `add-wire` skill onto `main`. (b) Self-hosted: this repo acts as the registry, and the skill copies files from a tagged release here. | Build in this repo with the mirrored layout, which keeps both options open. Ship self-hosted first so we can iterate on an alpha SDK, and open an upstream discussion or issue with NanoClaw maintainers in parallel. Move to (a) once the SDK leaves alpha or they're happy with it. |

> **Status, 2026-09-26.** The adapter, worker, tests and install skill are built and verified
> offline, including the real worker process and a skill apply/re-apply/remove cycle. The spike
> (phase 1), the MVP (phase 2) and most of phase 3's code collapsed into one build. What remains
> before phase 4 is the **live matrix**, which needs a registered test app (see "Next step").

## Phase 0: foundation (done, except the commit)

- [x] Repo seeded; skills `wire-apps-js-sdk-development` and `nanoclaw-development` in place
- [x] `AGENTS.md`, design and plan
- [x] Upstream reference clone at `../nanoclaw` (main @ `d4ff64f4`); dev checkout at `.dev/nanoclaw`
- [x] `scripts/sync-to-nanoclaw.sh <checkout>`: applies the add-wire steps idempotently
- [x] `test/live/`: a Debian 13 echo-bot harness (the real adapter, worker and SDK, no NanoClaw host
      or agents). CoreCrypto loads there.
- [ ] Initial commit (the remote is added later by the owner)
- [ ] Register a dedicated test Wire app on the openclaw-wire backend and team. Don't reuse
      openclaw-wire's app: one client per app identity.

## Phases 1–3: worker model, MVP and rich messaging

Built and verified offline:
- [x] `wire-protocol.ts`: typed IPC, qualified-id helpers, redaction, key decoding
- [x] `wire-worker.ts`:
  - lock file, dynamic SDK import, failure classification
  - IPC-disconnect exit, logger filter, give-up watchdog
  - conversation and user-name caches, per-conversation FIFO
  - text, assets (with policy), buttons, joined/removed events
  - operations: send, edit (id chaining), react, composite buttons plus confirmation, `openDM`,
    conversation info
- [x] `wire.ts`:
  - factory (env validation, platform preflight, single-instance claim) and `WIRE_DEFAULTS`
  - supervisor (ready timeout, permanent vs transient failures, respawn backoff, teardown escalation)
  - inbound: dedupe, mention rewrite, quote context, attachments as base64
  - delivery: chunking, files, edit and reaction with suffix stripping, card fallback, questions as
    buttons with a `/option` fallback
  - `openDM`, `resolveConversation`
- [x] 62 tests: registration, protocol, adapter (fake worker, host-side SDK import forbidden), worker
      (fake SDK)
- [x] NanoClaw gates: typecheck, Prettier and ESLint (0 errors) clean. Full suite green apart from
      upstream timing flakes, which also fail on an untouched baseline and pass in isolation.
- [x] Real worker process: IPC, lock, and `platform` classification on glibc 2.35 (WSL); `network`
      classification, respawn backoff and SIGTERM teardown in Debian 13
- [x] `add-wire` skill (`SKILL.md`, `REMOVE.md`): directive lint and `skill-conformance` pass.
      Apply → re-apply → remove leaves a clean tree on a fresh checkout.
- [x] `container/skills/wire-formatting/`, checked against the webapp's markdown-it config
- [x] `scripts/wire-register-app.mjs` ported
- [ ] Removal or conversation deletion → detached handling. The event is logged; a seam for marking
      the messaging group detached isn't wired yet.

### Next step: live matrix (`test/live/run.sh up`, then message the app)

- [ ] `!ping` in a DM, an @mention in a group, and a reply quoting the app's message in a group
- [ ] Safe discard: plain group chatter and a file posted in a group produce no event and no log line
      at all (check with `LOG_LEVEL=debug`), and the group file is never downloaded
- [ ] Restart keeps the identity (no new device); warm and first-start time to ready
- [ ] `!long` (chunking), `!file` (outbound asset), sending the app a file (inbound download)
- [ ] `!edit` (two chained edits), `!react`, `!buttons` (buttons render, click → "you chose", and
      the confirmation shows), `/alpha` text reply
- [ ] `!dm` from a group (`openDM`, including creating a new 1:1)
- [ ] Replying to a message: is `quotedMessageId` populated?
- [ ] `docker kill` of the worker: respawn. Network loss: reconnect.

Then the full host: run NanoClaw with the channel in the container (needs agent containers and model
credentials) and check an unknown-sender approval reaching the owner DM, plus `ncl status`.

**Exit:** the live matrix passes, and the security checklist (below) is answered.

## Phase 4: setup and operations (2 days)

- [ ] Port `register-app.mjs` → `scripts/wire-register-app.mjs`; the skill offers "register a new
      app" or "use existing credentials"
- [ ] `nc:prompt` / `nc:env-set` credential flow plus `apply-fixtures.json` (conformance test green)
- [ ] `nc:run effect:check` platform preflight (arch, glibc ≥ 2.38, or macOS arm64)
- [ ] Skill Troubleshooting section: platform errors, a stale `worker.lock`, a rotated or expired
      token, "new device" after state loss, give-up/respawn loops
- [ ] `docs/operations.md`: backup and restore of `store/wire/` together with the key, migration to a
      new host, why never to run two hosts
- [ ] README with the data-exposure caution (ported from openclaw-wire) and the feature matrix
- [ ] Optional: a macOS arm64 smoke test

**Exit:** a fresh machine gets from zero to a working DM by following only the skill.

## Phase 5: release (1 day, plus upstream review time)

- [ ] Full security review: the NanoClaw skill's 12-question checklist, plus Wire's rules (no
      content or id logging, key handling, state unit)
- [ ] `/code-review` and `/security-review` over the full diff
- [ ] CHANGELOG, tag `v0.1.0`
- [ ] D1 path: publish self-hosted install instructions, and/or open NanoClaw PRs (code on
      `channels`, `add-wire` skill on `main`) after an issue or discussion with maintainers

## Security checklist (answered in the phase 2 and 5 reviews)

1. **Where is auth state stored?** In `store/wire/` plus `WIRE_CRYPTO_KEY` in `.env`, on the host
   only.
2. **Can it enter a container?** No. It's never in mounts, and core never mounts `.env` or the
   project root.
3. **How are inbound events authenticated?** The SDK's MLS decryption over an authenticated
   WebSocket. There are no webhooks.
4. **Where does sender identity come from?** The decrypted message's `QualifiedId`, never the text or
   display name.
5. **How are duplicates and replays handled?** A message-id LRU in the host.
6. **How are unknown senders handled?** Core policy `strict` by default. The adapter never
   authorises.
7. **How are button clicks authorised?** Through `onAction` → core response handlers, which check
   the message id and user.
8. **How are files handled?** They're capped, MIME-checked and staged by core's containment-checked
   inbox writer.
9. **Are network operations bounded?** Yes: IPC per-call timeouts, a setup timeout and teardown
   escalation.
10. **Are errors redacted?** Yes, every log and error goes through `redact()`.
11. **What about multiple instances?** Single instance in v1; a second one is refused.
12. **What does it add?** No mounts, routes or allowlist entries. It adds one child process.

## Rough total

About 10–13 engineering days to a self-hosted v0.1.0. Upstream review time is extra and outside our
control.
