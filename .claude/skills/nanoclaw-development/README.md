# NanoClaw development skill

A Claude Code-style development skill for engineering against NanoClaw v2, with an emphasis on messaging channels and security-preserving integrations.

## Install

Copy this directory into a Claude Code skills location, for example:

```text
<your-project>/.claude/skills/nanoclaw-development/
```

Keep the directory intact so `SKILL.md` can load the reference files and preflight script.

## Why the skill resolves APIs dynamically

NanoClaw v2 is evolving quickly. Channel registry features, lifecycle hooks, delivery capabilities and skill tooling have changed substantially across recent releases. Static interface snippets age badly, so this skill uses the local checkout as the primary source of truth and provides a curated source map to find the right contracts quickly.

## Designed for the Wire use case

For a Wire integration, the intended path is a direct host-side TypeScript adapter around the Wire JavaScript SDK unless NanoClaw gains a suitable Chat SDK adapter. The skill explicitly preserves Wire SDK/session credentials on the trusted host and keeps the agent-container boundary intact.
