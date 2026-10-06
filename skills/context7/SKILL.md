---
name: context7
description: "Use when looking up library documentation, API references, framework patterns, or code examples for ANY library (React, Next.js, Vue, Django, Laravel, etc.). Fetches current docs via Context7 REST API. Triggers on: how to use library, API docs, framework pattern, import usage, library example."
license: "(MIT AND CC-BY-SA-4.0)"
compatibility: "Requires curl or fetch, jq."
metadata:
  version: "1.2.2"
  repository: "https://github.com/netresearch/context7-skill"
  author: "Netresearch DTT GmbH"
allowed-tools:
  - "Bash(curl:*)"
  - "Bash(jq:*)"
  - "Read"
---

# Context7 Documentation Lookup Skill

Fetch current library documentation, API references, and code examples without MCP context overhead.

## When to Use This Skill

When the user asks about library APIs or framework patterns, use this skill to fetch current documentation.

When encountering import statements (`import`, `require`, `from`), use this skill to provide accurate API information.

When the user asks about specific library versions or "How do I use X library?", use this skill to get official patterns.

## Core Workflow

To answer questions about library documentation, follow these steps. `<skill-dir>` is this skill's directory, the folder containing this SKILL.md.

1. Search for the library ID using `<skill-dir>/scripts/context7.sh search`
2. Fetch documentation using `<skill-dir>/scripts/context7.sh docs`
3. Apply returned documentation to provide accurate, version-specific answers

## Running Scripts

### Searching for Libraries

To find a library ID for documentation lookup:

```bash
<skill-dir>/scripts/context7.sh search "library-name"
```

This returns library IDs in the format `/vendor/library` (e.g., `/facebook/react`).

### Fetching Documentation

To fetch documentation for a specific library:

```bash
<skill-dir>/scripts/context7.sh docs "<library-id>" "[topic]" "[mode]"
```

Parameters:
- `library-id` (required): From search result (e.g., `/facebook/react`)
- `topic` (optional): Focus area (e.g., `hooks`, `routing`, `authentication`)
- `mode` (optional): `code` for API references (default) or `info` for conceptual guides

### Examples

To get React hooks documentation:

```bash
<skill-dir>/scripts/context7.sh search "react"
<skill-dir>/scripts/context7.sh docs "/facebook/react" "hooks" "code"
```

To get Next.js routing guide:

```bash
<skill-dir>/scripts/context7.sh search "nextjs"
<skill-dir>/scripts/context7.sh docs "/vercel/next.js" "routing" "info"
```

## Documentation Modes

When fetching API references, examples, or code patterns, use `code` mode (default).

When fetching conceptual guides, tutorials, or explanations, use `info` mode.

## Environment Configuration

To use authenticated requests (optional), set the `CONTEXT7_API_KEY` environment variable:

```bash
export CONTEXT7_API_KEY="your-api-key"
```

---

> **Contributing:** https://github.com/netresearch/context7-skill
>
> Adapted from [netresearch/context7-skill](https://github.com/netresearch/context7-skill) by Netresearch DTT GmbH. Scripts are MIT (`LICENSE-MIT`); this skill text is CC-BY-SA-4.0 (`LICENSE-CC-BY-SA-4.0`) and is shared under the same license. Changes: script paths were made relative to the skill directory.
