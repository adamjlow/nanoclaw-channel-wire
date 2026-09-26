# NanoClaw v2 architecture reference

This file is a map, not a substitute for the checkout's source.

## Runtime split

NanoClaw is intentionally split into a trusted host plane and an isolated agent plane.

Typical message flow:

```text
messaging platform
    ↓
channel adapter on Node host
    ↓
router / identity / wiring
    ↓
session inbound.db
    ↓
agent runner inside container
    ↓
session outbound.db
    ↓
host delivery loop
    ↓
channel adapter
    ↓
messaging platform
```

The host owns messaging SDKs, platform credentials, identity mapping, channel wiring, delivery, approvals, lifecycle and container orchestration. The container owns agent execution and only receives the files/data/capabilities explicitly made available to it.

## Session mailboxes

Current v2 architecture uses two SQLite files per session, keeping a single-writer direction for each side:

- `inbound.db`: host writes work for the agent runner
- `outbound.db`: agent runner writes responses/actions for the host

The exact schema and status model are source-controlled and can evolve. Inspect the checkout's mailbox/session DB files before writing directly to them.

## Entity model

Expect separate concepts for:

- user/sender identity
- messaging group / platform conversation
- agent group
- wiring between a messaging group and an agent group
- session
- optional thread identity within a platform conversation
- channel type
- channel adapter instance

Do not collapse these into one opaque JID-like string unless the current adapter contract explicitly tells you to.

## Channel isolation / session modes

NanoClaw supports multiple ways to wire channels and agent groups. Recent v2 docs describe three broad isolation patterns:

- separate agent groups for full isolation
- shared agent with independent conversations
- multiple channels folded into an agent-shared session

The exact `session_mode` and wiring fields live in the DB/type definitions. A channel adapter should expose platform-level conversation/thread identity and leave agent-group/session decisions to NanoClaw.

## Host lifecycle

The Node host runs multiple responsibilities on one event loop: channel clients, delivery polling, host sweeping, routing and administration. A channel adapter must therefore avoid indefinite awaits and synchronous blocking work.

Use bounded network operations, reconnect logic and shutdown hooks compatible with current source. A hung platform SDK call can stall more than one channel if the host awaits it without a timeout.

## Channel responsibilities

A channel adapter should do platform work:

- authenticate/connect
- receive events
- verify event authenticity where relevant
- deduplicate or cooperate with the platform SDK's dedup layer
- identify conversation, thread and sender
- normalize content and attachment metadata
- invoke NanoClaw's inbound seam
- send/edit/react/indicate typing through NanoClaw's delivery seams
- reconnect and shut down cleanly

A channel adapter should not decide which agent group owns the conversation or invent its own parallel permissions database.

## Chat SDK bridge

NanoClaw can use a shared Chat SDK bridge for platforms with compatible adapters. The bridge can provide common parsing, API calls, content delivery and rich interaction plumbing. When using it, the `chat` package and platform adapter package may need exact matching versions because shared types cross package boundaries.

For a platform with a first-party JavaScript SDK but no suitable Chat SDK adapter, a direct Node host adapter is a legitimate design. Preserve NanoClaw's registry and lifecycle semantics.

## Current source landmarks

Common files in v2 include:

- `src/index.ts` — composition/startup
- `src/router.ts` — inbound routing
- `src/delivery.ts` — outbound delivery
- `src/host-sweep.ts` — periodic host work
- `src/session-manager.ts` — session resolution/mailboxes
- `src/container-runner.ts` — agent containers and mounts
- `src/db/` — central entity/config persistence
- `src/channels/` — channel registry, Chat SDK bridge, channel infrastructure
- `src/providers/` — provider infrastructure
- `container/agent-runner/` — code executing in agent containers

Names can move. Use `rg` from the skill preflight rather than assuming a path exists.
