# Messaging channel development

## Goal

A NanoClaw channel is a host-side adapter between a messaging platform and NanoClaw's normalized routing/delivery model.

Keep the platform SDK on the host. This is especially important for JavaScript SDKs such as Wire's: the simplest and cleanest architecture is normally to run the SDK in the existing Node process and adapt its events/actions to NanoClaw's channel seams.

## First decision: bridge or direct adapter

### Use the Chat SDK bridge when

- a maintained `@chat-adapter/<platform>` exists
- its event model covers the platform features you need
- using it reduces platform-specific code rather than forcing workarounds
- its current version is compatible with NanoClaw's pinned `chat` version

### Use the platform SDK directly when

- there is no suitable Chat SDK adapter
- the platform's official SDK already handles auth, event streams, E2EE/session state, retries or attachments well
- bridging would add an unnecessary translation layer

A direct adapter should still self-register with NanoClaw and use the same normalized inbound/delivery contracts as other channels.

## Discover the live contract

Before writing code, inspect the local checkout:

```bash
rg -n "register.*Channel|register.*Adapter|createChatSdkBridge" src/channels src
rg -n "DeliveryAction|deliver\(|setTyping|setThreadTitle|setSuggestedPrompts" src/channels src/delivery.ts src
rg -n "raw.*route|RawRoute|register.*Route" src/channels src
rg -n "Question|Approval|Card|Renderer|on.*Resolved" src/channels src/modules src
```

Also inspect one currently supported channel from the `channels` branch. The branch is intentionally kept aligned with current core and is a better implementation reference than old blog posts.

## Inbound normalization

For each inbound platform event determine:

- channel type
- adapter instance, if the current registry supports instances
- platform conversation/channel ID
- optional platform thread ID
- sender platform identity
- sender display name if available and appropriate
- message timestamp / platform message ID
- text/content
- attachments or file handles
- mention/reply context only where the current host model supports it

Use stable platform-native identifiers. Do not use display names as IDs.

The adapter should not map directly to an agent group ID. It supplies platform identity; NanoClaw's router/wiring layer resolves ownership and session behavior.

## Threading

Treat a thread as a sub-context beneath the platform conversation. Preserve native thread IDs when the platform has them.

Do not fabricate thread IDs from timestamps or message text. If the platform has no thread concept, return the current contract's null/absent representation.

When sending a reply, preserve the thread associated with the message being answered. Modern NanoClaw releases explicitly handle thread-correct replies, including long turns and shared sessions.

## Channel instances

Recent v2 releases make adapter instance a first-class dimension. This allows multiple independent bots/accounts for one channel kind.

When the current contract exposes instance identity:

- keep instance stable across restarts
- namespace state and webhook routes by instance where necessary
- deliver through the exact instance that owns the conversation
- do not silently re-key persisted messaging groups when changing instance names
- test two-instance routing if the integration claims multi-instance support

## Outbound delivery

Implement the smallest set required by the live contract, then add optional capabilities deliberately.

Potential capabilities include:

- send message
- send file/attachment
- edit message
- reactions
- typing state, possibly with status metadata
- thread title
- suggested prompts
- rich cards / questions / approvals

Do not advertise a capability unless the implementation behaves correctly for the platform.

Apply platform limits such as maximum message size/chunking without breaking markdown, mentions or reply/thread context.

## Attachments

Treat filenames, MIME types and platform-provided paths/URLs as untrusted input.

- sanitize filenames
- prevent path traversal and symlink escape
- bound download sizes where the host has a convention for it
- use NanoClaw's established attachment staging path
- do not persist raw bearer URLs or auth headers into agent-visible text
- avoid placing platform session state in attachment directories

## Reconnects and shutdown

A production adapter must survive:

- network loss
- platform rate limits
- expired sessions/tokens
- host restart
- duplicate events after reconnect
- clean service shutdown

Prefer SDK reconnect support where robust. Make retries bounded and observable. Do not spin aggressively on permanent auth errors.

## Event authenticity

Webhook-based integrations must verify the platform's signature/token before converting a request into a NanoClaw event. A localhost callback is not automatically trusted merely because it binds to loopback.

For WebSocket/event-stream SDKs, make sure session/auth state cannot be supplied by untrusted message content.

## Unknown senders and permissions

Do not implement a second authorization system inside the adapter. Feed correct sender identity and platform context into NanoClaw's existing unknown-sender, owner/admin and approval mechanisms.

The adapter may need platform-specific prefilters, but those must not accidentally bypass NanoClaw authorization.

## Raw routes

Recent v2 releases added a raw-route registry so webhook channels do not patch a central route table. If your channel needs HTTP callbacks, locate and use the current route-registration seam.

## Delivery actions and interactions

Recent releases expose typed delivery-action lookup/registration and callback registries for questions/approvals. If the platform supports buttons/cards, integrate through those seams rather than branching on your channel name in central delivery code.

## Wire-specific mapping questions

When applying this to Wire, resolve these from the Wire SDK and NanoClaw checkout before coding:

- How are user IDs, client IDs and conversation IDs represented?
- Does the SDK event stream redeliver after reconnect, and what ID is suitable for dedup?
- How are threads/replies represented, if at all?
- Which attachment operations require asset upload/download credentials?
- Which SDK state contains cryptographic/session material that must remain host-only?
- Can multiple Wire bot identities run in one process cleanly, and how should NanoClaw instance names map to them?
- How are message edits/deletes/reactions surfaced?
- What is the correct way to detect own-message echoes?
- What timeout/cancellation controls exist on send/download operations?

Answer these explicitly in the implementation notes and tests.
