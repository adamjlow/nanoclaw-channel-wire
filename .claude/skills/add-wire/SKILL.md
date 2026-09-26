---
name: add-wire
description: Add a Wire channel. NanoClaw joins end-to-end encrypted Wire conversations as a Wire app, using @wireapp/wire-apps-js-sdk in a supervised worker process. Native adapter, no Chat SDK bridge.
---

# Add Wire Channel

NanoClaw joins [Wire](https://wire.com) conversations as a Wire **app**, registered by a team admin. The adapter runs Wire's official SDK (`@wireapp/wire-apps-js-sdk`) in a separate worker process that NanoClaw supervises. The SDK's MLS encryption state and credentials stay on the host, in `store/wire/`, and are never mounted into agent containers.

> **Read before connecting.** Wire keeps conversations end-to-end encrypted. This channel deliberately gives an AI agent a seat in them. Every message the agent is allowed to see is decrypted and passed to your agent's model provider, which is outside Wire's encryption. The channel limits what reaches the agent: in groups it takes only messages addressed to the app and discards all other chatter before NanoClaw sees it, and unknown senders are refused. Even so, don't add the app to conversations that hold sensitive information, and tell people in a conversation when an assistant is present.

## Platform check

Wire's native crypto library (CoreCrypto) runs only on **Linux x86_64 with glibc 2.38 or newer** (Debian 13, Ubuntu 24.04 or later) or on **macOS on Apple Silicon**. Alpine/musl, Linux arm64, Intel Macs and Windows aren't supported.

```nc:run effect:check
node -e "const r=process.report.getReport().header,g=r.glibcVersionRuntime,[a,b]=(g||'0.0').split('.').map(Number);const ok=process.platform==='darwin'?process.arch==='arm64':process.platform==='linux'&&process.arch==='x64'&&(a>2||(a===2&&b>=38));console.log(ok?'Wire platform OK':'Wire is not supported here: '+process.platform+'/'+process.arch+(g?' glibc '+g:''));process.exit(ok?0:1)"
```

If this fails, stop: the channel would refuse to start on this host.

## Apply

### 1. Add the Wire channel source

The adapter is published on the `wire-channel` branch of the [nanoclaw-channel-wire](https://github.com/adamjlow/nanoclaw-channel-wire) repository. Add it as a git remote (skip if a `nanoclaw-channel-wire` remote already exists):

```nc:run effect:fetch
git remote get-url nanoclaw-channel-wire >/dev/null 2>&1 || git remote add nanoclaw-channel-wire https://github.com/adamjlow/nanoclaw-channel-wire.git
```

### 2. Copy the adapter, its tests, and the registration script

```nc:copy from-branch:wire-channel
src/channels/wire.ts
src/channels/wire-worker.ts
src/channels/wire-protocol.ts
src/channels/wire-registration.test.ts
src/channels/wire.test.ts
src/channels/wire-worker.test.ts
src/channels/wire-protocol.test.ts
scripts/wire-register-app.mjs
container/skills/wire-formatting/SKILL.md
container/skills/wire-formatting/instructions.md
```

### 3. Register the adapter

Append to `src/channels/index.ts` (skip if already present). This one line is the skill's only change to core:

```nc:append to:src/channels/index.ts
import './wire.js';
```

### 4. Install the SDK (pinned)

```nc:dep
@wireapp/wire-apps-js-sdk@0.1.0
```

The SDK needs no install scripts. Its `better-sqlite3` dependency shares NanoClaw's pinned prebuilt copy.

### 5. Build and validate

```nc:run effect:build
pnpm run build
```
```nc:run effect:test
pnpm exec vitest run src/channels/wire
```

Both must be clean before you continue. What the tests cover:
- `wire-registration.test.ts` imports the real channel barrel and asserts `wire` is registered and the SDK is installed.
- The other tests cover identity mapping, mentions, questions, delivery and the worker lifecycle, using a fake SDK.

Importing the adapter is safe: the SDK is only ever loaded inside the worker process, after the host starts.

## Register a Wire app

A **team admin** registers the app once. The script has no dependencies; it prompts for the admin password without echoing it and writes the credentials to a 0600 file:

```bash
node scripts/wire-register-app.mjs create \
  --host https://prod-nginz-https.wire.com \
  --email <team-admin-email> --name "NanoClaw" --out wire-app.env
```

- `https://prod-nginz-https.wire.com` is Wire's cloud. Self-hosted backends use their own nginz URL.
- If the admin account uses 2FA, run `send-code` first and pass `--code`.
- `list` shows the team's apps. `refresh --app-id <id>` issues a new token for an existing app.

## Credentials

Copy the values from `wire-app.env` into `.env`, then delete `wire-app.env`:

```bash
WIRE_API_HOST=https://prod-nginz-https.wire.com
WIRE_API_TOKEN=<token from wire-app.env>
WIRE_CRYPTO_KEY=<64 hex characters from wire-app.env>
```

| Variable | Required | Meaning |
|----------|----------|---------|
| `WIRE_API_HOST` | yes | The backend's `https://` nginz URL |
| `WIRE_API_TOKEN` | yes | App token. Used on the **first start only**: the backend rotates it, and the live token is kept in `store/wire/`. |
| `WIRE_CRYPTO_KEY` | yes | Encrypts the app's local crypto store. Must never change for an existing `store/wire/`. |
| `WIRE_MAX_ATTACHMENT_MB` | no | Largest inbound file to download (default 25) |

**`store/wire/` and `WIRE_CRYPTO_KEY` together are the app's device identity.**
- Back them up together, and restore them together.
- Never run two NanoClaw installs with the same app.
- Deleting `store/wire/` makes the app register as a brand-new device.

### Restart

```nc:run effect:restart
bash setup/lib/restart.sh --channel wire
```

On first start the worker registers the app's device and joins its conversations; this can take a little longer than later starts. Check `ncl status`: `wire` should show `connected: true`.

## Wiring

### Your DM

1. In Wire, start a conversation with the app (search for the name you gave it), and send it a message.
2. The message is dropped, because unknown senders are refused by default, but NanoClaw records the conversation and the sender:
   ```bash
   ncl messaging-groups list
   ncl dropped-messages list
   ```
   The `wire` messaging group's platform id is the conversation (`<uuid>@<domain>`). The dropped sender is your user id (`wire:<uuid>@<domain>`).
3. Wire the DM to a new agent and make yourself its owner:
   ```bash
   pnpm exec tsx scripts/init-first-agent.ts \
     --channel wire \
     --user-id "wire:<your-uuid>@<domain>" \
     --platform-id "<conversation-uuid>@<domain>" \
     --display-name "<your name>"
   ```

### Groups

Add the app to a Wire group, then @mention it. The group appears in `ncl messaging-groups list`. Wire it to an agent group, then grant members access:

```bash
ncl wirings create --messaging-group-id <mg-id> --agent-group-id <ag-id>
ncl members add --user "wire:<uuid>@<domain>" --group <ag-id>
```

In groups the channel only forwards messages addressed to the app: an @mention of it, a reply to one of its messages, or a click on its buttons. Everything else is discarded inside the channel, so no NanoClaw wiring setting can make the agent read group chatter; a catch-all engage pattern or the `accumulate` ignored-message policy has no effect. Files posted in groups are never downloaded; send files to the app by DM.

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now. Otherwise wire this channel with `/init-first-agent` (or `/manage-channels`).

## Channel Info

- **type**: `wire`
- **terminology**: Wire has 1:1 conversations and group conversations. NanoClaw takes part as a Wire *app*, not as a user account.
- **platform-id-format**: `<conversation-uuid>@<domain>` (lowercase), for both DMs and groups
- **user-id-format**: `wire:<user-uuid>@<domain>`
- **how-to-find-id**: Message or @mention the app, then run `ncl messaging-groups list` (conversations) and `ncl dropped-messages list` (senders not yet granted access)
- **supports-threads**: no
- **typical-use**: A team assistant in Wire DMs and small groups
- **default-isolation**: One Wire app per NanoClaw install. Give groups with other people their own agent group.

### Features

- Text in both directions, with Wire's Markdown subset. Replies longer than 8000 characters are split.
- @mentions of the app in groups. The mention is shown to the agent as `@<ASSISTANT_NAME>`.
- Quoted replies: the agent sees the quoted message when it's recent.
- Files in both directions, with a size cap. Inbound files are accepted in DMs only.
- Questions and approvals as Wire buttons, with `/option` text replies as a fallback.
- Message edits and reactions from the agent.
- Approvals reach approvers by DM: the adapter opens a 1:1 conversation when needed.

Not supported: typing indicators, threads, and acting on inbound edits, deletions or reactions.

## Troubleshooting

**`Wire channel not started: Wire requires glibc 2.38 or newer`.** The host can't load CoreCrypto. Use Debian 13 or Ubuntu 24.04+, or a Mac with Apple Silicon.

**`Wire channel cannot start (auth)` on the very first start.** The SDK saves the first token it's given in `store/wire/` before checking it, so correcting `WIRE_API_TOKEN` in `.env` has no effect on its own. Because the app has never connected, the directory holds nothing of value yet. Move it aside (`mv store/wire store/wire.failed`), fix the token, and restart.

**`Wire channel cannot start (auth)` after it has worked before.** The token was rejected or has expired. This happens when `store/wire/` was lost after the first start, or when the app was deleted. Issue a new token with `node scripts/wire-register-app.mjs refresh --app-id <id> ...`, put it in `WIRE_API_TOKEN`, and restart.

**`Wire channel cannot start (state)`.** Either `WIRE_CRYPTO_KEY` doesn't match the existing `store/wire/`, or `store/wire/` belongs to a different app. Restore the matching key and store together. Only as a last resort, move `store/wire/` aside: the app then registers as a new device and needs a fresh token.

**`another Wire worker owns the state directory`.** A previous worker is still shutting down, or another NanoClaw install uses the same directory. The channel retries automatically. If it persists, make sure only one NanoClaw runs, then check the pid in `store/wire/worker.lock`.

**`Wire worker exited; restarting` repeating.** The backend is unreachable, or the SDK stopped reconnecting. The channel backs off up to 5 minutes between attempts. Check network access to `WIRE_API_HOST`.

**Messages arrive but the agent doesn't answer.** Check `ncl dropped-messages list`. Unknown senders are dropped until you grant them access (`ncl members add`). In groups, the app must be @mentioned or replied to; other group messages are discarded by design.

**Logs.** Wire lines in `logs/nanoclaw.log` are prefixed `Wire`. They never contain message text or full ids. For more detail, set `LOG_LEVEL=debug` and restart.
