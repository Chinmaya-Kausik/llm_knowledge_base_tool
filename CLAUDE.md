# Loom — Personal Knowledge Base & Workspace

## What This Is

A local-first workspace and knowledge management system. Infinite canvas UI with Claude Code as the built-in agent via the Agent SDK. Markdown on disk, git-versioned.

## Architecture

- **All LLM reasoning routes through Claude Code** (Max subscription). Python tooling is a local MCP server providing deterministic, non-LLM tools.
- **No Anthropic SDK calls from Python.** No API key needed. Claude Code calls MCP tools, does the thinking, writes wiki pages.
- **MCP server**: `loom_mcp/` — stdio transport, registered in `.claude/mcp.json`.
- **Agent SDK**: web chat spawns a Claude Code subprocess with `preset + append` (preserves Claude Code defaults) and `setting_sources=["project"]` (loads CLAUDE.md from loom root).
- **Modular context pipeline**: system prompt assembled from independent blocks (`_permissions_block`, `_memory_block`, `_location_block`), each configurable via loom-local `config.yaml`.

## Directory Layout

```
loom_mcp/              ← MCP server code (tools + lib)
  server.py            ← 29 MCP tools (stdio transport)
  web.py               ← FastAPI server + WebSocket endpoints + bootstrap
  chat.py              ← Agent SDK bridge with modular context pipeline
  lib/                 ← Core: pages, frontmatter, links, hashing
  tools/               ← Ingest, compile, search, lint, git
  static/              ← Frontend (~5200 lines vanilla JS)
  tests/               ← 331 tests across 26 files

demo/                  ← Demo loom (included in repo)
src-tauri/             ← Tauri v2 native app (optional)
```

A loom directory (user content) has:
```
CLAUDE.md              ← Project context loaded by Agent SDK subprocess
MEMORY.md              ← Global memory index (one-liners, injected at session start)
config.yaml            ← Context pipeline config (memory caps, page content limits)
wiki/                  ← Compiled knowledge
  pages/               ← All wiki pages (flat, type in frontmatter)
  meta/
    indexes/           ← Per-topic catalogs (LLM-maintained)
    memory/            ← Memory files (timestamped, tagged by project)
    conventions.md     ← Editable project conventions
    index.md           ← Master page catalog
    glossary.md        ← Canonical terms
raw/                   ← Ingested sources + saved chat transcripts
projects/              ← Active code repos, experiments
outputs/               ← Generated artifacts
```

## Key Design Decisions

- **ABOUT.md** is the loom page file for folders. README.md is a GitHub artifact, not special to loom.
- **Memory files** live centrally in `wiki/meta/memory/`, tagged by project. Per-project `MEMORY.md` indexes in project folders. Root `MEMORY.md` for global memories. Memory index one-liners injected at session start; individual files read on demand.
- **READMEs update during `/compile`** (structural snapshots). **Memories update during conversation** (operational context). Write path determines destination.
- **Chat transcripts** get mechanical tags from context_path (project name). Saved with frontmatter.
- **Claude should proactively write to wiki during chats** when new insights emerge — don't wait for `/compile`. `/compile` only processes ingested raw sources.
- **Memory = how to work here. Wiki = what things mean.**
- **Single-project memories**: Claude manages autonomously. **Cross-project/global**: interactive `/memory` cleanup.
- **`/compile` is read-only on memories** — reports staleness, verifies index drift, never modifies.

## Conventions

- Type hints everywhere. Docstrings on public functions.
- Prefer functions over classes. Composition over inheritance.
- Each MCP tool: structured input → deterministic output.
- Every wiki page has full YAML frontmatter.
- Internal links use `[[wiki-style]]` double-bracket syntax.
- No vector search at current scale. Ripgrep + LLM-maintained indexes + `search_by_tags`.
- See `wiki/meta/conventions.md` for full compilation and style rules.

## Workflows

- `/ingest <url>` — capture a URL into `raw/inbox/`
- `/compile` — incrementally compile changed raw sources into wiki pages
- `/query <question>` — search wiki + synthesize answer
- `/lint` — run health checks
- `/file-answer` — write last synthesized answer back to `wiki/answers/`

## Configuration

- `LOOM_ROOT` env var, `~/.loom-app-config.json`, or Settings dropdown
- Bootstrap auto-creates: `.claude/mcp.json`, `.claude/settings.json` (hooks), `CLAUDE.md`, `config.yaml`, `wiki/meta/conventions.md`, `wiki/meta/memory/`
- `config.yaml` context section controls memory caps, page content limits, enable/disable per block
- `LOOM_PORT` env var for running multiple servers (stable on 8420, experimental on 8421)

## Tauri App

The native app (`src-tauri/`) is a self-contained wrapper:
- Finds the loom project dir (checks `~/Documents/loom/projects/loom` then `~/Documents/GitHub/loom`)
- Resolves `uv` binary (GUI apps don't inherit shell PATH — checks `~/.local/bin`, `~/.cargo/bin`, `/usr/local/bin`, `/opt/homebrew/bin`)
- Spawns `uv run --extra web python -m loom_mcp.web` with correct `current_dir` and `LOOM_ROOT`
- Waits for server readiness (TCP poll, 15s timeout) before showing window
- Shows styled error pages for: missing project dir, missing `uv`, spawn failure, server timeout
- Kills server on window close
- Rejects stale config paths (pytest temp dirs) in `~/.loom-app-config.json`

## Current State

See `TODO.md` for remaining work. Key items: wiki/code review agents, memory e2e, bug reporting, git visualization.
