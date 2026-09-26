# nanoclaw-channel-wire

The secure way to give a [NanoClaw](https://github.com/nanocoai/nanoclaw) agent a seat in
[Wire](https://wire.com). It joins Wire conversations as a Wire app, built on Wire's JavaScript SDK
[`@wireapp/wire-apps-js-sdk`](https://www.npmjs.com/package/@wireapp/wire-apps-js-sdk). It's
designed around one question: **what is the least an agent needs to see, and how do we make sure
it sees no more?**

> [!CAUTION]
> Wire conversations are end-to-end encrypted. Any message the agent is allowed to read is
> decrypted and passed to NanoClaw, and from there to your agent's model provider: a third party
> outside Wire's encryption, with its own data handling, retention and jurisdiction. This channel
> keeps that set of messages as small as possible, but it can't make it empty. Don't add the app to
> conversations that hold sensitive information, choose your model provider as carefully as you
> would choose who else can read these messages, and tell people when an assistant is present.

**Status: pre-release.** Built and verified offline; live testing is next
([docs/delivery-plan.md](docs/delivery-plan.md)).

## Security model

### 1. It only hears what is said to it

The channel is a participant that listens only when addressed. This is enforced by the channel
itself, not by a NanoClaw setting an operator could loosen:

| In a Wire conversation… | Reaches NanoClaw? |
|---|---|
| a message in a 1:1 conversation with the app | yes |
| a group message that @mentions the app | yes |
| a group reply quoting one of the app's own messages | yes, once the SDK passes quotes on (SDK 0.1.0 doesn't, so today these are discarded: @mention the app instead) |
| a click on one of the app's own buttons | yes |
| **any other group message** | **no — discarded** |
| **a file posted in a group** | **no — discarded, never downloaded** |
| **edits, deletions, reactions, pings, locations, receipts** | **no — discarded** |

**Safe discard.** The decision is made first, inside the isolated worker process (below):
- before the sender is looked up, before any file is downloaded, and before anything crosses into
  NanoClaw;
- discarded messages are never forwarded, stored or logged, not even as a count;
- the NanoClaw side re-checks every forwarded message, as defence in depth.

As a result, no NanoClaw wiring can make the agent read group chatter. A catch-all engage pattern,
or the `accumulate` policy that keeps ignored messages as agent context, has nothing to act on.

### 2. Isolation, in three layers

- **Agent containers get messages, never Wire.**
  - No Wire credentials, no SDK, and no Wire state are mounted or passed into agent containers.
  - Agents receive only messages that were addressed to the app *and* admitted by NanoClaw's access
    policy: text, sender display name, sender id, and files sent by DM.
- **The Wire SDK runs in its own process.** The SDK, its MLS/CoreCrypto library and its database
  never load inside the NanoClaw host. They run in a worker process the channel supervises:
  - started with a minimal environment (`PATH`, `HOME`, `LANG`, `NODE_ENV`); the credentials are
    sent over a private IPC channel, never through arguments or environment variables;
  - a crash or native-library fault costs a worker restart, not the host;
  - the SDK can't terminate or reconfigure the NanoClaw process;
  - the worker exits on its own if the host goes away, so it can never linger as a second writer.
- **The app's identity stays in one locked directory.** `store/wire/` holds the SDK database and the
  CoreCrypto keystore. The keystore is encrypted with `WIRE_CRYPTO_KEY`.
  - The directory is created mode 0700, and a lock file ensures exactly one worker uses it.
  - NanoClaw never mounts the project root into containers.
  - The SDK database stores no messages, only conversations, members and the app's current token.
    Treat the directory as a credential anyway.

### 3. Nothing listens on the network

The channel opens **no ports, webhooks or HTTP endpoints**. Its only connection is an outbound TLS
WebSocket to your Wire backend.
- **Authenticity:** inbound messages are authenticated by MLS decryption.
- **Identity:** the sender's identity is the decrypted Wire qualified id (`uuid@domain`, domain
  included for federation), never message text or display names.

### 4. Access is refused by default

- **Unknown senders:** refused by NanoClaw's access gate before anything is stored. NanoClaw
  records who tried (sender id, name and a count) so the owner can grant access, but never the
  message.
- **Groups:** reply only to the addressed messages above.
- **Approvals and questions:** use Wire buttons, and only clicks on the app's own buttons are
  accepted.
  - For approvals, NanoClaw checks the clicking user's rights: only the named approver, or an owner
    or admin, can resolve one.
  - Answers to an agent's own question are passed to the agent with the answering user's id. In a
    group, any member can answer, so agents shouldn't treat a group answer as authorisation.
- **Approvers:** reached by DM, in a 1:1 conversation the channel opens.

### 5. What is kept, and where

| Data | Where | For how long |
|---|---|---|
| Admitted messages | the agent's NanoClaw session store, like any channel | per NanoClaw's session retention |
| Up to 500 recent addressed messages | channel memory, for quoted-reply context (used once the SDK passes quotes on) | until restart; never written to disk |
| Message ids of the app's own messages, display names | memory, bounded | until restart |
| Discarded messages | nowhere | — |
| App identity and current token | `store/wire/` (0700) | until you delete it |

### 6. Logs and supply chain

- **Logs:** the channel's logs never contain message text, file names, tokens or keys. Wire ids are
  masked to a 4-character prefix, and the SDK's debug output (raw event payloads) is dropped.
- **Supply chain:**
  - the SDK is pinned to an exact version;
  - nothing in its dependency tree runs install scripts;
  - installing needs no exceptions to NanoClaw's build-script allowlist or release-age gate.

### Operator responsibilities

- **Back up `store/wire/` and `WIRE_CRYPTO_KEY` together.** Together they are the app's device
  identity.
- **Run one NanoClaw install per Wire app.**
- **Don't widen mounts.** Never add a NanoClaw mount-allowlist root that contains the NanoClaw
  install; that would expose `store/wire/` and `.env` to agents.
- **Keep the strict defaults.** Grant access per person (`ncl members add`) rather than opening a
  group to everyone.

## Features

- 1:1 and group conversations; groups engage on an @mention of the app
- Files in both directions, with a size cap (inbound files by DM only)
- Questions and approvals as Wire buttons, with a `/option` text fallback
- Message edits and reactions from the agent
- Replies longer than a Wire message are split at paragraph boundaries

The channel doesn't support typing indicators or threads, and doesn't act on inbound edits,
deletions or reactions.

## Requirements

- NanoClaw v2 (`main` at or after v2.4.0)
- Linux x86_64 with glibc 2.38 or newer (Debian 13, Ubuntu 24.04+), or macOS on Apple Silicon.
  Wire's CoreCrypto native library doesn't run on Alpine/musl, Linux arm64 or Intel Macs, and the
  channel refuses to start there.
- A Wire team where you're an admin, so you can register the app

## Install

In your NanoClaw checkout, run the `/add-wire` skill
([.claude/skills/add-wire/SKILL.md](.claude/skills/add-wire/SKILL.md)). It:
1. copies the channel, registers it, pins the SDK, then builds and tests;
2. walks you through registering the Wire app;
3. wires your first DM.

[REMOVE.md](.claude/skills/add-wire/REMOVE.md) reverses every change.

## Design and development

- [docs/design.md](docs/design.md): the architecture and the reasoning behind each decision,
  including verified SDK behaviour.
- [AGENTS.md](AGENTS.md): how to build and test. In short, run
  `scripts/sync-to-nanoclaw.sh .dev/nanoclaw` and then NanoClaw's own gates. Live tests run in
  Debian 13 via `test/live/run.sh`.

## Licence note

The Wire SDK is GPL-3.0. This channel depends on it without vendoring it, and runs it in a
separate process.
