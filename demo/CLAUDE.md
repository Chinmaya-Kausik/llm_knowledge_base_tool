# Loom

A knowledge base + project workspace on an infinite canvas.

## Structure
- `wiki/` — compiled knowledge (concepts, summaries, indexes, answers, meta)
- `raw/` — ingested sources, chat transcripts
- `projects/` — active code repos, experiments
- `outputs/` — generated artifacts

## Conventions
- Pages are folders with README.md. Files are subpages.
- Cross-reference with `[[wiki-links]]` (e.g. `[[Attention Mechanisms]]`)
- The master index at `wiki/meta/index.md` catalogs all pages
- Detailed conventions in `wiki/meta/conventions.md`

## Available context
Read these when relevant:
- `wiki/meta/conventions.md` — project conventions and style
- `wiki/meta/index.md` — master index of all pages
- `wiki/meta/glossary.md` — canonical terminology

## Memory
Memories live in `wiki/meta/memory/` as individual files, tagged by project.
Each project folder has a `MEMORY.md` index with one-liners for relevant memories.
A global `MEMORY.md` lives at the loom root for cross-project preferences.

When you learn something worth persisting:
1. Create a timestamped file in `wiki/meta/memory/` (e.g. `2026-04-07-uses-typescript.md`)
2. Add frontmatter with `type: memory` and `tags: [project-name]` (or `[global]`)
3. Update the relevant project's `MEMORY.md` with a one-liner
4. For global memories, update the root `MEMORY.md`

Use loom MCP tools (ripgrep_search, read_wiki_page, write_wiki_page, etc.) to find and modify content.
