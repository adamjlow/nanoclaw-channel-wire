# nanoclaw-channel-wire design

A NanoClaw v2 channel adapter that joins Wire conversations as a Wire app and connects them to
NanoClaw agents. This document records the target contracts, the architecture, and the decisions
and why they were made. [delivery-plan.md](delivery-plan.md) covers sequencing.

Verified on 2026-09-26 against NanoClaw `main` @ `d4ff64f4` (v2.4.0+9), `origin/channels` @
`224827b9`, `@wireapp/wire-apps-js-sdk` 0.1.0 (npm `latest`, 2026-09-14) and `@wireapp/core-crypto`
10.5.3. Both projects move fast, so re-verify before relying on a detail.

## 1. Targets

| Thing | Target | Notes |
|---|---|---|
| NanoClaw | `main` ≥ `d4ff64f4` | Write against main's `src/channels/adapter.ts`. It has the 4-arg `onAction` with `address`, plus `resolveConversation`. `origin/channels` is 422 commits behind. |
| Wire SDK | `0.1.0`, exact pin, from npm | No vendoring. SDK PRs #348 (storagePath) and #349 (exit-handler opt-out) are still open, and the worker design (§3) doesn't need them. |
| Node | 22 (NanoClaw's `.nvmrc`) | The SDK declares `engines: 22.22.1` exactly. That only warns, because NanoClaw isn't engine-strict. |
| Host OS | Linux x86_64 with glibc ≥ 2.38 (Debian 13, Ubuntu 24.04+), or macOS arm64 | CoreCrypto ships only `libcore_crypto_ffi.so` (x86_64) and `.dylib` (arm64). NanoClaw has no platform checks, so the adapter and the skill must add them. |
| Supply chain | No new build-script allowlist entries | The SDK tree has no install scripts. `better-sqlite3` 13.0.3 ships prebuilds and dedupes with NanoClaw's pin. 0.1.0 clears the 3-day `minimumReleaseAge`. |

## 2. How NanoClaw sees a channel (the contract we implement)

These points come from source. File references are to NanoClaw main.

- **Registration.** `registerChannelAdapter('wire', { factory, defaults })` runs at module top level
  in `src/channels/wire.ts`. It's triggered by one barrel line in `src/channels/index.ts`:
  `import './wire.js';`. Importing the module must have no side effects.
- **Factory.** The factory returns `null` to decline, which the host logs as "credentials missing,
  skipping". We return null when `.env` has no Wire credentials, when the platform can't load
  CoreCrypto, or when a second Wire instance claims the same app. Config comes from `.env` via
  `readEnvFile`; NanoClaw injects nothing.
- **`setup(ChannelSetup)`.** This blocks host boot: adapters start one at a time, before delivery
  starts. If it throws an error named `NetworkError`, the host retries after 2 s, 5 s and 10 s. Any
  other throw leaves the channel down until the next restart. `restart.sh --channel wire` waits
  30 s for `isConnected()`.
- **`teardown()`.** This is awaited during shutdown, and the host calls `process.exit(0)` right
  afterwards. The SDK state has to be closed before it resolves.
- **Inbound.** We call `onInbound(platformId, null, { id, kind: 'chat', content, timestamp,
  isMention, isGroup })`. Core reads these content fields: `text`, `sender`, `senderId`,
  `senderName`, `attachments[]` (base64 `data`, which core stages into the session inbox) and
  `replyTo`.
- **Routing policy isn't the adapter's job.** Unknown groups, unknown senders, engagement and
  approvals are decided by the router and the permissions module, using our declared
  `ChannelDefaults`. The adapter must report `isGroup` and `isMention` accurately, and must not
  build a second authorisation layer.
- **Delivery.** The host calls `deliver(platformId, threadId, { kind, content, files })`. We return
  the Wire message id, which is stored and used for later edits and reactions. A normal return means
  "delivered"; a throw is retried up to 3 times, then marked failed. There's no retryable/permanent
  distinction.
- **Health.** `isConnected()` is the only health seam, shown by `ncl status` and awaited by
  `restart.sh`.
- **DMs.** Approval cards go to approvers' DMs via `ensureUserDm`. Without `openDM` the host would
  use the user id as the DM platform id, which is wrong for Wire, so we implement `openDM`.

## 3. Architecture

```text
NanoClaw host process (untouched trust boundary)
┌───────────────────────────────────────────────────────────┐
│ router / permissions / delivery / session mailboxes       │
│        ▲ onInbound / onAction          │ deliver / openDM │
│ ┌──────┴───────────────────────────────▼─────────────┐    │
│ │ src/channels/wire.ts   (no SDK import)             │    │
│ │ factory · lifecycle · supervisor · dedupe · echo · │    │
│ │ mention · chunking · question fallback · caps      │    │
│ └──────────────────────┬─────────────────────────────┘    │
└────────────────────────┼──────────────────────────────────┘
                         │ Node IPC (fork, advanced serialization)
┌────────────────────────▼──────────────────────────────────┐
│ src/channels/wire-worker.ts  (child process, cwd=store/wire)│
│ WireAppSdk 0.1.0 · WireEventsHandler · manager calls      │
│ ./storage/apps.db + ./storage/cryptography (CoreCrypto)   │
└────────────────────────┬──────────────────────────────────┘
                         │ HTTPS + WebSocket, MLS
                   Wire backend
```

### Decision 1: run the SDK in a child process, not in the NanoClaw host

This is the central decision. Stock SDK 0.1.0 is hostile to a shared host process:

| SDK 0.1.0 behaviour | Effect if it ran in NanoClaw's process |
|---|---|
| `registerExitHandlers()` always runs in `create()`. It calls `process.exit` on SIGTERM and SIGINT, and on **any** `unhandledRejection` or `uncaughtException` | It would pre-empt NanoClaw's ordered shutdown (other adapters' teardown, `closeDb`). A stray rejection anywhere in the host would kill it, whereas NanoClaw's own policy is to log unhandled rejections and carry on. |
| `STORAGE_PATH = './storage'`, cwd-relative | It would write crypto state into the NanoClaw project root. |
| Process-global tsyringe container; `close()` clears it | One SDK per process. A crash can't be recovered without restarting the host. |
| Importing it loads the CoreCrypto native library (`@wireapp/core-crypto/native`) | On an unsupported host, the barrel import throws and **NanoClaw fails to boot entirely**. |

A forked worker process turns every one of these into an advantage:
- The worker's cwd is `store/wire/`, so `./storage` lands there with no patch.
- SIGTERM to the worker triggers the SDK's own clean close, and a crash only restarts the worker.
- Native faults stay out of the host.
- It works with the published npm package today. The `openclaw-wire` approach (vendoring an
  unreleased tgz) doesn't fit NanoClaw's exact-pin, skill-copied, pnpm model.

The cost is a small typed IPC protocol and one extra file. Once #348 and #349 ship we'll keep the
worker anyway, for crash and native isolation.

**Worker details:**
- `child_process.fork(workerPath, { cwd: <STORE_DIR>/wire, serialization: 'advanced', env: minimal,
  stdio: [ignore, pipe, pipe, ipc] })`. Advanced serialization carries `Uint8Array` for assets.
- The worker path is resolved from `import.meta.url` (`dist/channels/wire-worker.js`).
- Secrets travel in the first IPC `init` message only, never through argv or env. The env is
  reduced to PATH, HOME and NODE_ENV.
- **Single writer.** The worker takes `store/wire/worker.lock` with O_EXCL and its pid, and breaks
  the lock only if that pid is dead. NanoClaw restarts can overlap: the nohup launcher waits 10 s,
  and systemd uses `KillMode=process`, so the worker isn't killed with the host.
- **Orphan safety.** When the IPC channel disconnects (host died), the worker calls
  `stopListening()` and `close()`, then exits.
- **SDK logger.** An adapter forwards SDK log lines over IPC as level plus redacted message. Debug
  is dropped and info is demoted.
- **Give-up detection.** SDK 0.1.0 stops reconnecting after 10 failures and only logs it. We port
  `openclaw-wire`'s log-line match and 5-minute watchdog. On give-up, the worker exits non-zero and
  the host supervisor respawns it.

**Host supervisor (in `wire.ts`):**
- `setup()` forks the worker, sends `init`, and waits for `ready` (the SDK is created and
  `startListening()` has resolved), for up to about 20 s.
- If `ready` doesn't arrive in time, `setup()` resolves anyway and the worker keeps connecting in
  the background, with `isConnected()` false. One slow channel doesn't hold up host boot.
- The worker classifies every start failure (`classifyError`) and reports it before exiting:
  - **Permanent** failures need operator action: `auth` (`AuthenticationError`), `config` (bad
    parameters or key), `state` (`CryptographicSystemError`, `DatabaseError`, or stored state that
    belongs to a different app) and `platform` (the SDK can't load). `setup()` throws a plain
    `Error` with an actionable message, and the supervisor never respawns.
  - **Transient** failures retry on their own: `network`, `locked` (the previous worker still owns
    the state dir), `gave-up` and `unknown`. `setup()` resolves, and the supervisor respawns in the
    background.
  - We deliberately don't use NanoClaw's `NetworkError` setup retry (2 s, 5 s, 10 s). It blocks host
    boot and gives up after three tries; our own backoff does neither.
- After setup, an unexpected worker exit sets `isConnected()` false and triggers a respawn, with
  backoff from 5 s up to 5 min. The backoff resets after 5 min of uptime.
- `teardown()` sends `shutdown`, then waits up to 10 s for exit, then SIGTERM, then SIGKILL after
  another 5 s.

### Decision 2: identities

| NanoClaw concept | Wire value | Form |
|---|---|---|
| `platformId` | conversation `QualifiedId` | `<uuid>@<domain>`, lowercased. `namespacedPlatformId` passes `@`-ids through raw, so setup, the router and delivery all agree with no special case. |
| user id (`senderId`) | sender `QualifiedId` | `<uuid>@<domain>`, which the host namespaces as `wire:<uuid>@<domain>`. |
| message `id` | Wire message id | As provided by the SDK. |
| thread | none | `supportsThreads: false`; threadId is always null. |
| instance | `wire` | Single instance for v1 (§6). |

The domain is always kept (federation). Parsing uses one strict `id@domain` helper, ported from
`openclaw-wire`'s `parseQualifiedKey`, not ad hoc splitting.

### Decision 3: channel defaults

```ts
export const WIRE_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'strict' },
  group: { engageMode: 'mention', threads: false, unknownSenderPolicy: 'strict' },
  mentions: 'platform',
};
```
These are conservative, like Signal's, because every admitted message leaves Wire's E2EE boundary
and goes to a model provider. The operator loosens them per group with `ncl`/`/manage-channels`.
`threads` is required and must be `false`, because `supportsThreads` is false.

### Decision 4: inbound pipeline (in `wire.ts`, on plain data from the worker)

1. **Worker normalises SDK events to plain, serialisable records** and never blocks the SDK handler.
   The handler caches, posts over IPC and returns, because SDK handlers are awaited, a throw loses
   the message, and events can arrive concurrently.
2. **Echo filter.** Drop messages whose sender equals the app's own qualified id (domain compared).
3. **Dedupe.** A bounded LRU of about 2000 message ids. The SDK's own dedupe is weak.
4. **Conversation kind** comes from the worker's cache of `getAllConversations()`, refreshed on
   `onAppAddedToConversation` and on a cache miss. `ONE_TO_ONE` means `isGroup: false`. Unknown or
   self conversations are dropped.
5. **Addressed-only (Decision 7).** Only messages addressed to the app are forwarded, so
   `isMention` is always true. The app's own mention span is rewritten to `@<ASSISTANT_NAME>`.
6. **Per-conversation ordering.** A promise chain per `platformId` feeds `onInbound` in arrival
   order.
7. **Content:** `{ text, sender, senderId, senderName, attachments?, replyTo? }`. Display names come
   from `getUsers` with a bounded cache and are never used as ids. `replyTo` is added only if the
   SDK exposes quote data; `openclaw-wire` found 0.1.0 doesn't map inbound quotes.
8. **Attachments (phase 3).** The router admits a message only *after* `onInbound`, so we can't
   fetch after admission the way `openclaw-wire` does. Policy:
   - download in DMs only. Group files are discarded without downloading, because they can't be
     addressed (Decision 7);
   - enforce declared-size and actual-size caps (`WIRE_MAX_ATTACHMENT_MB`, default 25; core has no
     cap). There's no MIME allowlist: core stages files into the session inbox with containment
     checks, and the agent treats them as untrusted input;
   - emit `{ name, mimeType, size, data: base64 }` so core stages the file into the session inbox
     with its containment checks;
   - a skipped or failed download becomes a text note, not an error.
9. **Button clicks (phase 3).** `onButtonClicked` maps to `onAction(questionId, value, senderId,
   { messageId, platformId })`.
10. **Ignored in v1:** edits, deletes, inbound reactions, pings, locations and receipts. They're
    logged by kind only.
11. **Removal.** Being removed, or the conversation being deleted, calls `onMetadata`, and later
    marks the group detached (phase 3, if an adapter-safe seam exists).

### Decision 5: delivery (`deliver` dispatches on content shape)

| Content | Wire action | Phase |
|---|---|---|
| `{ text }` / `{ markdown }` | `TextMessage` via `sendMessage`. Wire clients render markdown, so no conversion. Chunked at 8000 characters (Wire's `MAXIMUM_MESSAGE_LENGTH`) on paragraph, then line, then space boundaries. Returns the first chunk's id. | 2 |
| `files[]` | `sendAsset` per file, with MIME from the extension. Text goes first as the caption message. | 3 |
| `{ operation: 'edit', messageId, text }` | `TextEditedMessage`. Strip the `:<agentGroupId>` suffix that core appends to inbound ids. Wire edits mint a new message id, so the worker keeps a bounded original-to-latest map for repeat edits. | 3 |
| `{ operation: 'reaction', messageId, emoji }` | `Reaction` with `emojiSet`. Strip the suffix too. | 3 |
| `{ type: 'ask_question' }` | A `CompositeMessage` with one button per option (ids `o0`, `o1`, …). `onButtonClicked` maps to `onAction`, then a button-action confirmation is sent. The text also lists `/option` commands, which inbound text matching accepts (WhatsApp pattern: resolved via `onAction`, not forwarded). If the composite send fails, it falls back to plain text. Always returns the message id, because gateway approvals check it. | 2 |
| `{ type: 'card' }` | `fallbackText` as text. | 2 |

Failure semantics:
- Worker offline, IPC timeout (30 s per send) or a backend error: throw, and the host retries 3
  times. We never queue in memory and return success the way WhatsApp does.
- Unknown conversation: throw; the host retries, then marks it failed.
- `setTyping` isn't implemented, because SDK 0.1.0 has no typing API.

**`openDM(userHandle)`:**
1. Parse `wire:<uuid>@<domain>` or `<uuid>@<domain>`.
2. Look for a 1:1 conversation with that user in the local store.
3. If there isn't one, call `createOneToOneConversation`.
4. Return its `platformId`.

Whether apps may create 1:1s in all team configurations is verified in the spike.

### Decision 6: configuration, state and secrets

| `.env` key | Required | Meaning |
|---|---|---|
| `WIRE_API_HOST` | yes | `https://` nginz URL of the backend |
| `WIRE_API_TOKEN` | yes | App token. **Used only on the first start.** The backend rotates it, and the live token lives in `apps.db`. |
| `WIRE_CRYPTO_KEY` | yes | 64 hex characters, which become the 32-byte `cryptographyStorageKey`. Validated with a regex, because `Buffer.from(hex)` silently drops invalid characters. |
| `WIRE_MAX_ATTACHMENT_MB` | no | Inbound file cap (DM files only) |

- State lives in `<STORE_DIR>/wire/` (NanoClaw `store/`, matching WhatsApp's `store/auth/`), mode
  0700: `storage/apps.db`, `storage/cryptography/` and `worker.lock`.
- The directory and `WIRE_CRYPTO_KEY` are one unit. They're backed up and restored together, and
  deleting them re-registers the app as a new device.
- The directory is never mounted into agent containers. `.env` and the project root already aren't,
  per NanoClaw's SECURITY.md.
- **Logging.** NanoClaw's `log` doesn't redact, so `wire-protocol.ts` provides `redact()`, which
  masks uuids, `uuid@domain` and emails. It's applied to every adapter and worker log line and
  every error message. Message text, file names, tokens, keys and raw ids are never logged; we log
  kinds, counts and MIME types.

### Decision 7: addressed-only intake (safe discard)

The channel is a participant that only hears what is said *to* it. That's a channel guarantee, not
a NanoClaw wiring default an operator can loosen:

| Message | Forwarded? |
|---|---|
| Anything in a 1:1 conversation with the app | yes (`addressed: 'dm'`) |
| Group text that @mentions the app (Wire mention metadata for the app's qualified id, domain included) | yes (`'mention'`) |
| Group text that quotes a message the app sent (tracked in memory, bounded) | yes (`'reply'`) |
| A click on a button the app sent | yes |
| Any other group text | **discarded in the worker** |
| Files posted in a group (Wire files carry no mention or quote) | **discarded, never downloaded** |
| Edits, deletions, reactions, pings, locations, receipts, member joins | **discarded** (explicit no-op handlers) |
| The app's own messages, and self or unknown conversations | **discarded** |

Why here rather than in NanoClaw's router:
- The router receives whatever an adapter hands it. A wiring can set `engage_pattern '.'` or
  `ignored_message_policy: 'accumulate'`, which stores non-engaging messages as agent context that
  later reaches the model provider. Discarding in the adapter makes both impossible for Wire.
- The decision is made first in the worker, before the sender-name lookup, any download or any IPC.
  Discarded plaintext never leaves the worker process and is never logged, not even as a count.
- `wire.ts` re-checks the `addressed` claim against `isGroup` and the mention spans, as defence in
  depth.
- Own-message ids live in memory only. After a restart, replies to older app messages, and clicks
  on older buttons, are discarded. That fails safe, and matches the host's in-memory open questions.

The cost: group engage modes other than `mention` behave like `mention` for Wire, and group files
must go by DM. Both are deliberate.

## 4. Packaging (NanoClaw skill model)

The files mirror NanoClaw paths so they copy verbatim.

- **Channel code.** In the upstream model this goes on NanoClaw's `channels` branch. Self-hosted, it's
  this repo's `wire-channel` branch: the skill adds this repo as the `nanoclaw-channel-wire` remote, and
  `nc:copy from-branch:wire-channel` resolves to the first remote carrying that branch. Moving
  upstream later is a one-word change to `from-branch`.
  - `src/channels/wire.ts`, `wire-worker.ts` and `wire-protocol.ts`
  - tests:
    - `wire-registration.test.ts`: real barrel, and asserts the SDK resolves
    - `wire.test.ts`: fake worker process. It also mocks the SDK module to throw, so any host-side
      import of the SDK fails the suite.
    - `wire-worker.test.ts`: fake SDK module
    - `wire-protocol.test.ts`
  - `scripts/wire-register-app.mjs`, `container/skills/wire-formatting/`
- **Install skill** `.claude/skills/add-wire/`:
  - `SKILL.md` (under 500 lines). Sections: Platform check → Apply (copy → barrel append → `nc:dep
    @wireapp/wire-apps-js-sdk@0.1.0` → build and registration test) → Register a Wire app →
    Credentials → Restart → Wiring → Next Steps → Channel Info (type, terminology,
    platform-id-format `<uuid>@<domain>`, user-id-format `wire:<uuid>@<domain>`, how-to-find-id,
    supports-threads: no, default-isolation) → Troubleshooting.
  - `REMOVE.md`: delete the barrel line, remove every copied file and test, `pnpm uninstall`, remove
    the `.env` keys, rebuild and restart. Optionally delete `store/wire/`, with a warning that this
    destroys the app's device identity.
  - `apply-fixtures.json`, required once the skill uses `nc:prompt` (phase 4).
- **App registration.** `scripts/wire-register-app.mjs` is ported from openclaw-wire. It's
  dependency-free and writes a 0600 env file with a freshly generated key. A `setup/` wizard step (a
  trunk reach-in via the `nanoclaw:setup-steps` marker) is optional and comes later.
- **Platform preflight.** An `nc:run effect:check` step, plus a factory-side check using
  `process.report` `glibcVersionRuntime` and `process.arch`, that returns null with a clear warning.

## 5. Reuse from `openclaw-wire` (same author, MIT)

We port these rather than rewrite them, adapting each to the worker split:

| From `openclaw-wire` | Used for |
|---|---|
| `sdk-runtime.ts` | SDK create and events handler → `wire-worker.ts` |
| `wire-api.ts` | Qualified-id helpers → `wire-protocol.ts` |
| `watchdog.ts`, `sdk-logger.ts` | Give-up detection and log filtering → worker |
| `redact.ts` | Redaction → `wire-protocol.ts` |
| `credentials.ts` | Hex key validation |
| `media.ts` | File policy (phase 3) |
| `scripts/register-app.mjs` | App registration |
| `test/docker/Dockerfile` | Debian 13 base image |
| README caution block, `docs/operations.md` | Backup and restore runbook |

Nothing OpenClaw-specific carries over: the ingress resolver, pairing, SecretRefs and the manifest
all have NanoClaw equivalents that live in core.

## 6. Out of scope for v1

- **Multiple Wire instances.** They're feasible later, one worker per instance with a
  `WIRE_INSTANCES` loop like Telegram's, but v1 claims a single `wire` instance and returns null for
  a second.
- Typing indicators and threads: the platform or SDK doesn't support them.
- Inbound edits, deletes and reactions; locations; read receipts.
- Creating group conversations or managing membership from the agent.

## 7. Findings and open risks

### Verified 2026-09-26

**From the code.** These were checked in the SDK source or with the real worker process:

1. **Importing the SDK loads CoreCrypto straight away.** On glibc 2.35 the real worker fails with
   "library open failed" and reports `platform`, and the host stays up. This confirms Decision 1.
2. **Only `./storage` depends on cwd.** The SDK finds its migrations relative to its own module, so
   running the worker with cwd set to the state dir is enough. In Debian 13 the state landed in
   `<state>/storage`.
3. **The serializer encodes everything we send.** 0.1.0 handles `TEXT_EDITED`, `REACTION`,
   `COMPOSITE`, `COMPOSITE_BUTTON_ACTION_CONFIRMATION`, `ASSET` and more. `onButtonClicked` is
   wired. `CompositeButtonActionConfirmation` isn't exported, so the worker builds the plain object
   its `create()` would build.
4. **Transient start failures behave as designed.** With an unreachable backend, the SDK retries 5
   times, the worker reports `network` and exits 75, setup resolves, and respawns back off 5 s,
   10 s, …. The lock is released between attempts, and SIGTERM during backoff tears down promptly.
5. **The give-up line in 0.1.0** is `WebSocket stopped after ${MAX} failed reconnect attempts`
   (`WebSocketClient.js`).
6. **The first token is stored before it's checked** (`saveBackendCookieIfMissing` runs ahead of
   identity setup). If a wrong token is used on the first start, fixing `.env` has no effect until
   the never-connected `store/wire/` is removed. This is documented in the skill's Troubleshooting.
7. **The skill works end to end.** On a fresh NanoClaw main checkout: apply works, re-apply is
   idempotent, and removal leaves a clean tree, both via the engine journal and via `REMOVE.md` by
   hand. It also passes `skill-conformance` and the directive linter.

**Licensing.** `@wireapp/wire-apps-js-sdk` is **GPL-3.0**, while NanoClaw is MIT. We depend on the
SDK, don't vendor it, and run it in a separate process over IPC. Even so, an upstream NanoClaw PR
has to raise this with the maintainers, and Wire should confirm the intended licensing for SDK
consumers. (openclaw-wire *bundles* the SDK tgz, which is a stronger form of distribution.)

### Still open (need the live test app)

1. `createOneToOneConversation` permissions for apps, and how new 1:1s appear in
   `getAllConversations`.
2. First-start time (key packages, joining existing MLS groups) against the 20 s `setup()` budget
   and `restart.sh`'s 30 s wait.
3. Whether Wire clients render composite buttons from an app, and whether the confirmation marks the
   selection.
4. Whether `quotedMessageId` is populated on inbound replies. openclaw-wire saw it unset.
5. Whether mention offsets are UTF-16 code units, matching JS string indices.
8. **Question answers aren't rights-checked by NanoClaw.** Approvals are (`isAuthorizedApprovalClick`),
   but `modules/interactive` records any user's answer to an agent's `ask_user_question`. In a
   group, any member could click. The adapter can't check agent-group membership without a core
   seam. It passes the true clicker id, and the README tells operators not to treat a group answer
   as authorisation. Candidate upstream hardening: an optional sender check in the interactive
   response handler.
6. **SDK churn.** 0.x has already had a breaking change on main (#344 removed `getUser`). We pin
   exactly and upgrade deliberately.
7. **Upstream acceptance.** NanoClaw maintainers own the `channels` branch, and an alpha GPL SDK
   with a native dependency and a glibc floor may need discussion first (see delivery plan,
   decision D1).
