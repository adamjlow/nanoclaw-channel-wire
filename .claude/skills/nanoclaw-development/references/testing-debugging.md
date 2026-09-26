# Testing and debugging NanoClaw integrations

## Baseline host checks

Use the scripts defined by the checkout's `package.json`. Common current commands include:

```bash
pnpm run build
pnpm run typecheck
pnpm test
pnpm run lint
```

Do not assume all are required on every branch; inspect the current scripts and contribution guide.

## Channel test layers

### 1. Registration test

Import the real channel barrel and assert that the real registry contains the channel. This catches:

- missing barrel import
- module evaluation errors
- missing dependency
- changed registration API
- accidental removal during upstream merge/update

### 2. Normalization tests

Given representative platform events, assert stable conversion of:

- conversation ID
- thread ID
- sender ID
- text
- reply/mention metadata where relevant
- attachment descriptors
- own-message/echo behavior

Prefer fixture objects that do not contain real credentials or private conversations.

### 3. Security behavior

Test the channel's own security-sensitive logic:

- invalid webhook signature rejected
- forged interaction rejected or never reaches privileged path
- unknown sender remains unknown
- unsafe attachment name cannot escape staging directory
- wrong adapter instance cannot deliver to another instance's conversation

### 4. Lifecycle/recovery

Where practical test:

- connect/start
- reconnect after transient loss
- permanent auth failure behavior
- shutdown/disconnect
- duplicate event handling
- bounded send failure/timeout

### 5. Manual real-platform smoke test

After automated tests, verify with a real non-production bot/account:

- DM inbound/outbound
- group/channel inbound/outbound
- thread/reply behavior if supported
- attachment each direction if supported
- restart and reconnect
- permissions/unknown sender path
- multi-instance routing if supported

Document the exact manual matrix in the PR or implementation notes.

## Skill verification

For a skill:

- apply once to a clean compatible checkout
- apply again and ensure no duplicate imports/config/dependencies appear
- run its focused tests
- run the repository build/test gates
- execute REMOVE.md and verify persistent changes are reversed
- apply again after removal

If the skill uses `nc:` directives, run current directive lint/conformance tooling from the checkout.

## Container changes

The agent runner has its own package/runtime boundaries. If editing `container/agent-runner/`, run its current typecheck/tests as documented in the checkout.

If the container image or packages change, rebuild using NanoClaw's current build script. Be aware that Docker/BuildKit cache can hide stale content; use the repository's documented clean-rebuild procedure rather than improvising.

## Useful runtime diagnostics

Recent releases expose `ncl status` with host/channel state. Also inspect the actual per-install service name rather than assuming a global `nanoclaw.service` or old launchd label.

Use logs to correlate:

- channel connect/disconnect
- inbound event receipt
- router decision
- session creation/wake
- outbound row creation
- delivery attempt

Redact before sharing logs.

## Debugging a message that never replies

Trace in order:

1. Did the platform SDK receive the event?
2. Did the adapter accept or filter it?
3. Was sender/conversation/thread identity normalized correctly?
4. Did NanoClaw's router accept/authorize/wire it?
5. Did a `messages_in` row reach the expected session?
6. Did the container wake/process it?
7. Did a `messages_out` row appear?
8. Did host delivery resolve the correct adapter instance?
9. Did the platform API accept the send?

Do not jump straight to the LLM/provider when step 1-4 is broken.

## Debugging cross-channel or wrong-thread replies

Inspect:

- persisted `messaging_group_id`
- channel type
- adapter `instance`
- platform ID
- thread ID
- session mode
- wiring thread policy
- delivery lookup semantics

Wrong-thread bugs are often caused by treating “most recent thread” as equivalent to “thread of the message being answered.” Current NanoClaw releases intentionally preserve reply thread context, so follow the existing path rather than maintaining adapter-global thread state.
