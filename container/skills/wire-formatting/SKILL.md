---
name: wire-formatting
description: Format messages for Wire. Use when replying in a Wire conversation (channel type wire; platform id looks like <uuid>@<domain>).
---

# Wire Message Formatting

Wire clients render a limited subset of Markdown. The host's Wire adapter sends your text as-is, with no conversion, so write in the subset below.

## How to detect Wire context

You're in a Wire conversation when the channel type is `wire`, or when the platform id is a UUID followed by `@` and a domain (for example `0b9f3c2e-…@wire.com`).

## What renders

| Style | Syntax |
|-------|--------|
| Bold | `**bold**` |
| Italic | `*italic*` or `_italic_` |
| Strikethrough | `~~strike~~` |
| Inline code | `` `code` `` |
| Code block | ```` ``` ```` fences, optionally with a language |
| Heading | `# Heading` (levels 1–6) |
| Lists | `- item` or `1. item` |
| Quote | `> quoted` |
| Link | `[text](https://…)`; bare URLs are linked automatically |

A single newline is a line break, so you don't need blank lines between short lines.

## What doesn't render

- **Tables** show as raw pipes. Use a list, or a code block for aligned columns.
- **Images** (`![alt](url)`) show as text. Send an image as a file attachment instead.
- **HTML** is shown literally.

## Limits

- A single Wire message holds at most 8000 characters. The adapter splits longer replies at paragraph boundaries, but a shorter answer reads better than several messages.
- `@name` in your text is plain text, not a real Wire mention.
- Messages are end-to-end encrypted in transit. Don't restate sensitive content back to people unless they need it.
