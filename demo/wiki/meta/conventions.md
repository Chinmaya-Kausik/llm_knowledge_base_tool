---
created: '2026-04-07'
status: compiled
title: Conventions
type: structure-note
---

# Conventions

## Wiki Pages
- Every wiki page has full YAML frontmatter (title, type, status, created, tags, etc.)
- One concept per article. If a source covers multiple concepts, create multiple articles.
- Internal links use `[[wiki-style]]` double-bracket syntax with optional alias: `[[page|display text]]`
- Canonical terms live in the glossary. Consult it during compilation.

## Compilation
- Summaries go in `wiki/summaries/`, concept articles in `wiki/concepts/`
- Set confidence (high/medium/low) based on source quality
- Always link back to originating sources in `sources` frontmatter field
- Never generate `[[links]]` to pages not in the page registry

## Folder Pages
- Every folder is a page. Its ABOUT.md holds the content. README.md is a GitHub artifact, not special to loom.
- Folder ABOUT.md explains the folder's purpose, lists key children with descriptions, and shows relationships.
- Updated during `/compile`, not during normal conversation.

## Style
- Type hints everywhere. Docstrings on public functions.
- Prefer functions over classes. Composition over inheritance.
- Each MCP tool: structured input → deterministic output.
