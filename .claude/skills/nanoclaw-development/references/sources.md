# Upstream research sources

Researched on 2026-09-26 against NanoClaw's official repository and the latest published v2.4.0 release available at that time.

Use these for context, but always prefer the user's checked-out source for implementation details.

## Repository and release

- https://github.com/nanocoai/nanoclaw
- https://github.com/nanocoai/nanoclaw/releases
- latest release observed during research: v2.4.0, published 2026-09-23

## Core docs

- https://github.com/nanocoai/nanoclaw/blob/main/README.md
- https://github.com/nanocoai/nanoclaw/blob/main/CLAUDE.md
- https://github.com/nanocoai/nanoclaw/blob/main/CONTRIBUTING.md
- https://github.com/nanocoai/nanoclaw/blob/main/docs/architecture.md
- https://github.com/nanocoai/nanoclaw/blob/main/docs/SECURITY.md
- https://github.com/nanocoai/nanoclaw/blob/main/docs/customizing.md
- https://github.com/nanocoai/nanoclaw/blob/main/docs/skills-model.md
- https://github.com/nanocoai/nanoclaw/blob/main/docs/skill-guidelines.md
- https://github.com/nanocoai/nanoclaw/blob/main/docs/templates.md
- https://github.com/nanocoai/nanoclaw/blob/main/CHANGELOG.md

## Channel install reference

- https://github.com/nanocoai/nanoclaw/blob/main/.claude/skills/add-discord/SKILL.md

The current supported pattern shown there is: copy adapter + registration test from the `channels` branch, append one barrel import, install an exact-pinned adapter dependency, then build and run the registration test.

## Important version-drift note

Some indexed prose under `docs/SPEC.md` still exposes older channel factory/interface examples. Recent releases and architecture docs describe a richer v2 adapter system with channel instances, raw route registration, delivery actions and optional capabilities. Therefore this skill intentionally treats source/tests and recent release notes as higher priority than copied interface snippets from older docs.
