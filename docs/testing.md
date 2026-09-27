# Testing the Wire channel

A step-by-step guide for someone who hasn't used NanoClaw before. There are two stages:

1. **The echo bot** needs no NanoClaw knowledge. It runs the real channel, worker and Wire SDK
   against Wire, and replies to test commands. It proves the Wire side works.
2. **Full NanoClaw.** You install NanoClaw, add the channel with its `/add-wire` skill, and talk to
   a real agent over Wire. It proves the install path, routing, access control and approvals.

Use a test team and throwaway conversations: in stage 2, messages go to your model provider.

## What you need

- A team on Wire **staging** (`https://staging-nginz-https.zinfra.io`, domain `staging.zinfra.io`) where you're an admin, and a second staging account in the team
  for the "unknown sender" and group tests
- Docker. For stage 1 the existing Docker on this machine is enough.
- For stage 2, a host where Wire's crypto library loads: Linux x86_64 with glibc 2.38 or newer, or a
  Mac with Apple Silicon. This WSL (Ubuntu 22.04, glibc 2.35) can't run it natively; a second WSL
  distro with Ubuntu 24.04 can (see stage 2).
- For stage 2, a Claude subscription or an Anthropic API key for the agent

## Stage 1: the echo bot

### 1.1 Register a test app

A Wire *app* is how NanoClaw joins Wire: it's like a bot account, registered by a team admin. From
the repo root:

```bash
node scripts/wire-register-app.mjs create \
  --host https://staging-nginz-https.zinfra.io \
  --email <your-team-admin-email> --name "NanoClaw echo test" \
  --out test/live/wire-app.env
```

- It prompts for your admin password without echoing it. With 2FA, run `send-code` with the same
  `--host` and `--email` first, then add `--code <code>`.
- `test/live/wire-app.env` holds the token and crypto key. It's gitignored and created with mode
  0600; don't share it.

### 1.2 Start it

```bash
test/live/run.sh up       # builds and starts the container
test/live/run.sh logs     # follow the log; Ctrl-C stops following, not the bot
```

Wait for `Wire connected` and `echo: setup done, connected=true`. The first start registers the
app's device and can take a little longer.

### 1.3 Talk to it

In Wire, search for "NanoClaw echo test" and start a conversation with it. Then work through this
table, noting anything that doesn't match.

| Send (DM) | Expect |
|---|---|
| `hello` | `echo: 5 chars, group=false, mention=true` |
| `!ping` | `pong` |
| `!long` | the reply arrives split across 3 messages |
| `!file` | a message "here is a file" plus `hello.txt` |
| send it any small file | `…attachments: downloaded <n> bytes` |
| `!edit` | "version 1", which then changes twice, ending "version 3 (edited twice)" |
| `!react` | a 👍 on your message |
| `!buttons` | a "Live test" question with two buttons. Tap one: `you chose: …`, and Wire shows your choice |
| `!buttons`, then type `/alpha` | `you chose: Alpha` |
| reply to one of its messages (Wire's reply action) | an echo (in a DM everything is addressed). The quote itself isn't passed on by SDK 0.1.0. |

Then groups: create a group with the app and your second account.

| In the group | Expect |
|---|---|
| a message that doesn't mention the app | **nothing**, and no `echo: inbound` line in the log |
| a file posted in the group | **nothing**; it's not downloaded |
| `@NanoClaw echo test !ping` (use Wire's @mention picker) | `pong` |
| reply (Wire's reply action) to one of the app's messages | an echo with `mention=true` |
| `@NanoClaw echo test !dm` from a second account **in the app's team** | the app writes to that account in a new 1:1 conversation. From another team it can't: apps can't use connection requests. |

### 1.4 Resilience

| Do | Expect |
|---|---|
| `test/live/run.sh down`, then `up` | it reconnects and still answers in existing conversations (the same device, not a new one) |
| `test/live/run.sh kill-worker` | `Wire worker exited; restarting` in the log, then `Wire connected`, and it answers again |
| turn the network off for about a minute, then back on | `Wire disconnected…` then `Wire reconnected` |
| `LOG_LEVEL=debug test/live/run.sh up`, then send group chatter | still no line at all about the chatter |

`test/live/run.sh status` shows the latest connection state at any time.

### 1.5 Report back

Tell me what matched and what didn't. Log lines are safe to paste: they never contain message text,
and ids are masked. When you're done, `test/live/run.sh down`. Keep the state volume if you'll
test again; `reset` deletes the device identity.

## Stage 2: full NanoClaw

### 2.1 A host that can run it

On Windows, the simplest option is a second WSL distro with Ubuntu 24.04. From PowerShell:

```powershell
wsl --install -d Ubuntu-24.04
```

Open it (`wsl -d Ubuntu-24.04`) and create your user when asked. Everything below runs inside that
distro. On a Mac with Apple Silicon, use Terminal instead.

### 2.2 Install NanoClaw

```bash
git clone https://github.com/nanocoai/nanoclaw.git nanoclaw
cd nanoclaw
bash nanoclaw.sh
```

The script installs Node, pnpm and Docker if they're missing, sets up NanoClaw's credential gateway
with your Anthropic credential, builds the agent container, and pairs a first channel.

- **When it asks for a channel, pick the local CLI.** That gives you a working agent without any
  messaging account. Wire comes next.
- If a step fails, it hands over to Claude Code to fix it.
- Check it works: `pnpm run chat`, then say hello to your agent.

### 2.3 Add the Wire channel

Register a **second** test app for NanoClaw ("NanoClaw agent test"). The echo bot's app can't also
run here: each app is one device, in one place. Then fetch the skill and run it:

```bash
git clone https://github.com/adamjlow/nanoclaw-channel-wire.git ~/nanoclaw-channel-wire
mkdir -p .claude/skills && cp -R ~/nanoclaw-channel-wire/.claude/skills/add-wire .claude/skills/
claude            # Claude Code, inside the nanoclaw folder
```

In Claude Code, type `/add-wire`. It checks the platform, installs and tests the channel, then walks
you through registering the app, putting credentials in `.env`, restarting, and wiring your DM to
an agent. Afterwards `ncl status` should list `wire` as `connected: true`. (`ncl` is at `bin/ncl`
in the checkout if it isn't on your PATH.)

### 2.4 Test matrix

| Do | Expect |
|---|---|
| DM the app | your agent answers |
| add the app to a group with your second account and wire it (see the skill); chat without mentioning it | the agent never sees it: no answer, nothing in `ncl dropped-messages list` |
| @mention the app in the group from **your** account | the agent answers |
| @mention the app from your **second** account (not yet a member) | no answer. `ncl dropped-messages list` shows that sender and a reason, never the message. |
| grant that account access (`ncl members add …`, see the skill), @mention again | it answers |
| ask the agent to send you a file, or send it one by DM | the file arrives / the agent can read it |
| ask the agent a question it has to put to you as choices | Wire buttons, and your tap reaches the agent |
| restart NanoClaw (`bash setup/lib/restart.sh`) | Wire reconnects; `ncl status` shows `connected: true` |

Approvals, where the agent needs an owner's OK, are the last check. We'll trigger one together once
the basics work.

### 2.5 If something goes wrong

- `logs/nanoclaw.log` in the NanoClaw folder. Wire lines start with `Wire`.
- The skill's Troubleshooting section covers the known failure messages.
- Paste what you see; logs don't contain message text.
