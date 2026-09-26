# API source map

NanoClaw does not promise a frozen plugin ABI. Resolve current contracts from the checkout.

## Channel registry and lifecycle

Look in:

- `src/channels/`
- the channel barrel, commonly `src/channels/index.ts`
- files containing `register...Channel`, `register...Adapter`, `get...Adapter`, `start`, `stop`, `shutdown`
- `src/index.ts` and host lifecycle modules for startup behavior

Search:

```bash
rg -n "register.*Channel|register.*Adapter|get.*Channel|get.*Adapter|hot.*start|onShutdown" src/channels src
```

## Chat SDK bridge

Look for:

- `src/channels/chat-sdk-bridge.ts`
- `createChatSdkBridge`
- bridge config types
- channel-specific hooks such as raw text extraction, DM/thread normalization, actions and app-context handling

Search:

```bash
rg -n "createChatSdkBridge|ChatSdk|extractRawText|dm.*open|app.*context" src/channels src
```

## Message, identity and wiring types

Look in:

- `src/types.ts`
- `src/db/`
- router modules

Important concepts to locate:

- `MessagingGroup`
- `User`
- `MessagingGroupAgent`
- `Session`
- `MessageIn`
- `MessageOut`
- unknown sender policy
- engagement mode
- thread policy
- session mode
- adapter instance

Search:

```bash
rg -n "interface (MessagingGroup|User|Session|MessageIn|MessageOut)|UnknownSender|EngageMode|session_mode|thread.*policy|instance" src/types.ts src/db src
```

## Inbound route

Look in:

- `src/router.ts`
- session manager/mailbox code
- channel callbacks or bridge hooks

Search:

```bash
rg -n "route|inbound\.db|messages_in|onMessage|platform_id|thread_id" src/router.ts src/session-manager.ts src/channels src
```

## Delivery

Look in:

- `src/delivery.ts`
- channel delivery action registry
- message rendering/card helpers

Search:

```bash
rg -n "DeliveryAction|getDeliveryAction|register.*Delivery|deliver\(|messages_out|setTyping|setThreadTitle|setSuggestedPrompts" src/delivery.ts src/channels src
```

## Raw HTTP/webhook routes

Search:

```bash
rg -n "RawRoute|raw route|register.*Route|webhook" src/channels src
```

Use the registry seam if one exists. Avoid adding your channel name to a central HTTP switch.

## Questions, cards and approvals

Search:

```bash
rg -n "Question|Card|Approval|Renderer|Resolved|onAction|register.*question|register.*approval" src/channels src/modules src
```

Platform button payloads are security-sensitive. Follow current authorization/replay handling instead of invoking privileged actions directly.

## Channel registry branch

NanoClaw's supported channel implementations live on the long-lived `channels` branch. Inspect them without merging:

```bash
git fetch origin channels
git ls-tree -r --name-only origin/channels -- src/channels
```

Read a reference adapter with:

```bash
git show origin/channels:src/channels/<name>.ts
```

Do not `git merge origin/channels` just to inspect or install one adapter.

## Provider development

Inspect:

- `src/providers/`
- provider host config/registry
- `container/agent-runner/src/` provider abstraction
- existing provider files on the `providers` branch

Providers can span host and container trees, so expect more than one integration point and test each one.

## Container boundary

Inspect:

- `src/container-runner.ts`
- mount security helpers
- container config DB/materialization code
- `container/agent-runner/`
- current security docs

Any new mount, network access or credential path deserves explicit security review.

## Skill tooling

Look in:

- `.claude/skills/`
- `docs/skill-guidelines.md`
- `docs/skills-model.md`
- `docs/skill-directives.md`
- skill conformance/lint scripts under `scripts/`

Do not invent `nc:` directive syntax from memory. Read the current grammar before adding directive fences.
