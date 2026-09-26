---
name: nanoclaw-development
description: Develop, review, migrate, debug, and package NanoClaw v2 customizations, especially messaging channel adapters, provider integrations, host modules, container capabilities, and NanoClaw skills. Use when modifying a NanoClaw checkout or designing an integration that must follow NanoClaw's current architecture, security boundaries, registry patterns, skill model, tests, and upgrade-safe conventions.
---

# NanoClaw development

Use this skill for engineering work against NanoClaw v2. Treat the checked-out source as the API contract. NanoClaw evolves quickly, so never rely on remembered interface signatures when the local source can answer the question.

## Source-of-truth order

Resolve uncertainty in this order:

1. The user's local NanoClaw checkout at its current commit.
2. `CLAUDE.md`, `CONTRIBUTING.md`, `docs/architecture.md`, `docs/SECURITY.md`, `docs/skill-guidelines.md`, `docs/skills-model.md`, and `CHANGELOG.md` in that checkout.
3. The current implementation files named in `references/api-source-map.md`.
4. The matching NanoClaw release/tag and official repository documentation.
5. This skill's references as architectural guidance.

If source and prose documentation disagree, follow source and tests. Call out the discrepancy. In particular, do not blindly copy older `Channel`/`registerChannel()` examples without checking the checkout's current adapter registry.

## Start every task with preflight

From the NanoClaw repository root, run:

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/inspect-nanoclaw.sh" .
```

Then read the files relevant to the task. For any contribution or skill work, read `CONTRIBUTING.md` and `docs/skill-guidelines.md` before changing code.

Before coding, state internally which extension shape applies:

- messaging channel adapter
- agent provider
- utility skill
- operational skill
- container skill
- host module/capability
- Agent Plugin/template
- bug/security patch to core

Do not confuse a NanoClaw host skill with an Agent Plugin/template. See `references/skill-packaging.md`.

## Core architectural rules

NanoClaw's host is Node/TypeScript. Agent execution is isolated in per-session containers. Messaging integrations run on the trusted host side and feed normalized messages into NanoClaw's routing/session model; agents do not need direct access to messaging credentials.

Keep these boundaries intact:

- Platform SDKs, bot tokens, webhook verification, sockets, polling, and channel identity stay on the host side.
- Agent containers receive only the data and capabilities they actually need.
- Do not mount messaging credentials into agent containers to make an adapter easier to implement.
- Do not bypass NanoClaw's routing, authorization, approval, delivery, or session machinery unless the task explicitly requires a core change and there is no extension seam.
- Prefer registration hooks and additive files over edits to central switch statements.
- Keep channel-specific configuration in the channel module unless current source establishes a different pattern.

Read `references/architecture.md` for the message path and trust boundaries.

## Building a messaging channel

For a new messaging integration, first inspect:

```bash
ls src/channels
rg -n "register.*Channel|register.*Adapter|createChatSdkBridge|DeliveryAction|RawRoute|Question|Approval|setTyping|setThreadTitle|setSuggestedPrompts" src/channels src/modules src 2>/dev/null
```

Then inspect at least one simple current channel adapter and one feature-rich adapter from the `channels` registry branch or the user's installed channels. Use their shape, not an obsolete example.

Design the channel as a thin host adapter around the platform SDK:

1. Establish the platform connection on the host.
2. Verify/authenticate inbound events before accepting them.
3. Normalize the platform conversation into NanoClaw's platform/channel ID and optional thread ID.
4. Normalize sender identity in the form expected by the current router and identity model.
5. Pass inbound messages through the current channel callback/registry path.
6. Implement outbound delivery through the current delivery adapter/action seam.
7. Add attachments, reactions, edits, typing, thread metadata, cards, or prompts only when the platform supports them and the current contract has a seam for them.
8. Handle reconnects, deduplication, backpressure, SDK errors, and shutdown without blocking the host event loop.
9. Support channel instances if the current registry contract exposes them. Do not assume channel type and adapter instance are interchangeable.
10. Keep raw platform payloads out of persistent state unless NanoClaw explicitly requires them.

For a JavaScript/TypeScript SDK such as Wire's, prefer running the SDK directly in the Node host adapter. There is no benefit in forcing that SDK through WASM or into the agent container.

Read `references/channel-development.md` before implementing a channel.

## Chat SDK versus direct SDK

If NanoClaw's current Chat SDK bridge can represent the target platform cleanly and there is a maintained Chat SDK adapter, use it.

If the platform has its own mature JavaScript SDK and no suitable Chat SDK adapter, implement a direct host adapter against NanoClaw's current channel registry. Do not build a fake Chat SDK layer merely for aesthetic consistency.

Whichever path is chosen, preserve NanoClaw's platform ID, thread, identity, authorization, delivery, and lifecycle semantics.

## Packaging a channel or provider

NanoClaw's supported contribution model is skill-driven. For channel/provider work:

- implementation and integration tests normally live on the long-lived registry branch (`channels` or `providers`)
- the install `SKILL.md` lives on `main`
- installation fetches/copies the required files; it does not merge the registry branch into the user's fork
- the adapter self-registers
- the channel barrel gets the minimal import needed to trigger registration
- dependencies are pinned exactly
- apply is safe to re-run
- a registration/integration test proves the adapter is actually wired into the real registry
- `REMOVE.md` reverses every persistent change made by apply

Do not casually edit central routing or delivery code to add a channel. If that seems necessary, inspect existing extension registries first.

Read `references/skill-packaging.md`.

## Security review is mandatory for channel work

Before finishing any messaging adapter, explicitly review:

- credential location and lifetime
- webhook/event authenticity
- sender identity construction
- unknown-sender behavior
- owner/admin approval paths
- channel instance isolation
- DM versus group behavior
- attachment path handling
- raw payload persistence
- network timeouts and retry behavior
- shutdown and reconnect behavior
- log redaction
- dependency pinning and install scripts
- whether any new container mount is truly necessary

Never weaken the host/container boundary to make integration code simpler.

Read `references/security.md`.

## Current v2 concepts to expect

Recent NanoClaw v2 releases include concepts that older examples may omit:

- channel adapters installed via skills rather than shipped in trunk
- long-lived `channels` and `providers` registry branches
- multiple channel instances per channel kind
- raw HTTP route registration rather than patching a central route table
- typed delivery actions
- approval/question renderers and resolution callbacks
- optional adapter capabilities such as typing status and thread UI metadata
- three-level channel/session isolation and wiring policies
- DB-backed inbound/outbound session mailboxes
- credential gateways so agent containers do not hold raw provider credentials
- exact Chat SDK/adapter version coupling where the Chat SDK bridge is used

Verify every one of these against the checkout before using its API.

## API discovery instead of API guessing

When you need an interface or function signature, locate it in the repository. Useful searches:

```bash
rg -n "export (interface|type|function|class).*Channel|register.*Channel|Channel.*Adapter" src
rg -n "createChatSdkBridge|register.*Route|register.*Action|register.*Renderer|register.*Callback" src/channels src/modules
rg -n "MessagingGroup|Session|MessageIn|MessageOut|UnknownSender|EngageMode|session_mode" src/types.ts src/db src
rg -n "deliver\(|DeliveryAction|setTyping|thread_id|platform_id|instance" src/delivery.ts src/channels src/router.ts src
```

Use `references/api-source-map.md` to decide where to look.

## Testing gates

At minimum, after host-side TypeScript changes run the checkout's current equivalents of:

```bash
pnpm run build
pnpm test
```

For a channel, run its focused registration/integration test as well. If a skill carries `nc:` directives, lint/conformance-check those directives using the repository's current tooling.

If container agent-runner code changes, run its separate typecheck/test path too. If the container build context or dependencies change, rebuild the agent image using the checkout's documented path.

Never report success merely because TypeScript compiles. A channel should have a test proving real registration and focused tests around normalization/security-sensitive behavior where practical.

Read `references/testing-debugging.md`.

## Dependency rules

Before adding a package:

- check whether the existing dependency graph or platform SDK already provides the capability
- use pnpm, not an ad hoc npm install
- pin channel/provider dependencies to exact versions when NanoClaw's skill/contribution policy requires it
- respect minimum release age and build-script allowlists
- do not add or widen install-script exceptions without explicit human approval

For Chat SDK integrations, keep the `chat` package and `@chat-adapter/*` packages on the exact compatible version required by the checkout.

## Upgrade-safe change shape

Prefer this order:

1. new self-contained file
2. registration call in that file
3. one barrel import
4. exact dependency addition
5. focused test
6. only then, a minimal change to existing core code if no seam exists

If core must change, add a test for the integration seam so future upstream changes fail loudly.

## Completion checklist

Before handing work back:

- build/typecheck passes
- focused tests pass
- adapter is registered through the real barrel/registry path
- no secrets enter agent containers
- no unnecessary mount or privilege was added
- no central switch/router patch exists where a registry hook could be used
- dependency versions follow NanoClaw policy
- skill apply is idempotent
- `REMOVE.md` exists if apply leaves changes behind
- relevant troubleshooting/setup instructions exist
- user-facing setup identifies the exact credential/identity data needed
- diff is scoped to the requested integration

For contribution work, follow the checkout's PR hygiene instructions before creating or proposing a PR.

## References

Load only what the task needs:

- `references/architecture.md` — host/container architecture and message flow
- `references/channel-development.md` — channel adapter design, including external JS SDKs
- `references/api-source-map.md` — where to resolve current contracts
- `references/skill-packaging.md` — NanoClaw skill and registry-branch conventions
- `references/security.md` — security checklist and trust boundaries
- `references/testing-debugging.md` — build, test, debug and failure-mode guidance
- `references/sources.md` — upstream material this skill was researched against
