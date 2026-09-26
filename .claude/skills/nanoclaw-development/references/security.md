# Security guidance for NanoClaw development

## Threat model

Treat inbound messages, attachments and platform metadata as untrusted input even when the sender is a known user. An authorized user can still forward hostile prompt content or malformed files.

Treat the agent container as sandboxed but not trusted. The point of NanoClaw's architecture is to limit what an exploited or manipulated agent can reach.

## Preserve the primary boundary

Do not move host secrets into the agent container.

For messaging channels, keep on the host:

- bot/session tokens
- OAuth refresh tokens
- Wire/Signal/etc. cryptographic session state
- webhook verification secrets
- platform SDK keystores
- privileged platform API clients

The agent should receive normalized message content and approved capabilities, not the transport's keys.

## Container hardening assumptions

Recent NanoClaw releases use non-root containers and hardened runtime options, and can use hardened prebuilt images. Do not assume that makes arbitrary mounts safe.

Every new mount expands the blast radius. Prefer no new mount for a messaging channel because the channel SDK already runs on the host.

## Credential gateways

NanoClaw's agent-side provider/tool credential story uses a credential gateway so raw keys need not live in containers. That is separate from host-side channel credentials.

Do not route a messaging SDK's own host credential through the agent just to reuse the gateway mechanism.

## Sender identity

Identity is security-critical.

- use stable platform IDs, not display names
- namespace/construct IDs exactly as current NanoClaw helpers expect
- do not trust an event body's claimed user ID until the event itself is authenticated
- make sure interaction callbacks cannot forge the identity of the approving user
- preserve adapter instance when identity/routing is instance-specific

## Webhooks and callbacks

Verify platform signatures/tokens before parsing a request into an action.

Binding to `127.0.0.1` is not authentication. Other local processes or SSRF-like paths can reach loopback services.

For approval/question callbacks, use NanoClaw's current authorized resolution path. Never execute a privileged action solely because a callback payload says an owner clicked a button.

## Unknown sender policies

Current NanoClaw supports configurable behavior for unknown senders at the messaging-group layer. Feed accurate sender identity into that system.

Do not silently auto-register arbitrary DMs or groups unless the requested design and current NanoClaw policy explicitly permits it.

## Attachments

For inbound files:

- sanitize names
- reject path traversal
- defend against symlink escapes
- enforce reasonable size limits
- use controlled staging locations
- avoid leaking platform-authenticated URLs into logs or agent prompts
- do not allow archive extraction to escape its target directory

## Network behavior

External SDK calls need timeouts/cancellation where possible. An indefinitely pending send can wedge a single-threaded host workflow.

Use bounded retries with backoff. Distinguish transient network failure from invalid credentials or rejected permissions.

## Logging

Never log:

- access tokens
- refresh tokens
- private keys
- bearer headers
- raw credential-bearing SDK objects
- sensitive approval payloads unnecessarily

Prefer structured error summaries and IDs needed for diagnosis.

## Supply chain

NanoClaw uses pnpm hardening including minimum package release age and an install/build-script allowlist.

When adding a dependency:

- pin as required by the current skill policy
- inspect transitive/native install behavior
- do not add a package to build-script exceptions without explicit human review
- do not bypass minimum-release-age protections to make CI green

## Security review checklist for a channel

Answer all of these before shipping:

1. Where is platform authentication state stored?
2. Can any of it enter an agent container?
3. How is each inbound event authenticated?
4. How is sender identity derived after authentication?
5. How are duplicate/replayed events handled?
6. How are unknown senders routed?
7. How are approval button interactions authorized?
8. How are files staged and path-checked?
9. Are outbound network operations bounded?
10. Are platform/API errors redacted?
11. Does multi-instance operation keep credentials and routes separate?
12. Did the change add a mount, capability, route or privileged host action? If so, why is it necessary?
