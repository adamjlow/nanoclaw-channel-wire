# NanoClaw skill and packaging conventions

## Two different things called plugins/skills

Keep these concepts separate.

### Host development skill

A `.claude/skills/<name>/SKILL.md` teaches a coding agent how to modify or operate a NanoClaw checkout. Channel/provider install skills belong here.

### Container skill

A `container/skills/<name>/` skill is loaded by the agent running inside the sandbox and changes agent behavior/tool usage. It is not a host integration mechanism.

### Agent Plugin/template

NanoClaw can stamp portable Agent Plugin templates containing `plugin.json`, optional `mcp.json`, skills and NanoClaw-specific extension content. This configures an agent group. It is not the mechanism for adding a host messaging transport.

## Skill taxonomy

NanoClaw documents four broad skill types:

1. channel/provider install skills
2. utility skills with code files
3. operational instruction-only skills
4. container runtime skills

Classify the work before choosing a directory/layout.

## Channel/provider install model

For large integrations that track NanoClaw core:

- channel code lives on the `channels` registry branch
- provider code lives on the `providers` registry branch
- install instructions live in `.claude/skills/add-<name>/SKILL.md` on main
- apply fetches the registry branch and copies exact files into the user's fork
- apply does not merge the registry branch
- tests travel with the implementation files

This keeps a user's fork small and keeps adapter code forward-merged with core centrally.

## Expected change shape for a channel

A healthy channel integration usually needs:

- `src/channels/<name>.ts` or a small set of channel-owned files
- `src/channels/<name>-registration.test.ts` or equivalent focused test
- one self-registration import in the channel barrel
- exact package dependency/dependencies
- `.claude/skills/add-<name>/SKILL.md`
- `.claude/skills/add-<name>/REMOVE.md`
- troubleshooting/setup instructions if credentials or portal steps are interactive

Avoid edits to router, delivery and container runner unless the platform exposes a genuinely missing general-purpose seam.

## SKILL.md rules

Current NanoClaw contribution docs require the Claude Code skill frontmatter shape:

```yaml
---
name: my-skill
description: What this skill does and when to use it.
---
```

Keep the main SKILL.md below the repository's documented line limit and move detail into references or separate files.

Apply must be idempotent because upgrades can re-apply skills.

`REMOVE.md` is required when apply leaves anything behind. Removal should actually reverse apply: remove copied files and tests, remove barrel lines, uninstall dependencies and undo other persistent changes.

## `nc:` directives

NanoClaw has a deterministic skill-apply engine for some core skills. Directive fences can represent operations such as copy/append/dependency/env/run/prompt actions, but the grammar changes over time.

Rules:

- prose must remain sufficient for an agent to perform the operation
- directives must be idempotent
- if adding directive fences, read `docs/skill-directives.md` in the checkout and run its lint/conformance tooling
- do not make a contributed skill depend on undocumented parser behavior

## Dependencies

Channel/provider skills should follow NanoClaw's exact pinning and supply-chain policy. Avoid ranges and `latest` where the current policy requires exact pins.

If using Chat SDK, match the exact `chat`/`@chat-adapter/*` compatibility level used by the checkout.

## Tests are part of the skill

A test should cover each integration point that can drift during an upstream update.

For a channel this normally includes a registration test that imports the real channel barrel and verifies the adapter is present in the real registry. Add focused behavior tests for normalization, identity, threading or security-sensitive logic when appropriate.

## Upgrade behavior

A fork should be reproducible as a recipe of skills. Do not leave important customization as untracked manual edits.

When a direct edit is necessary during development, convert the finished change into the appropriate skill shape before treating it as complete.
