---
title: Loom
type: project
tags: [loom, tools]
---

# Loom

A local-first workspace and knowledge management system. Infinite canvas UI with Claude Code as the built-in agent via the Agent SDK.

## Architecture
- All LLM reasoning routes through Claude Code (Max subscription). Python tooling is a local MCP server providing deterministic, non-LLM tools.
- Agent SDK subprocess uses `preset + append` (preserves Claude Code defaults) with `setting_sources=["project"]` (loads CLAUDE.md from loom root).
- Modular context pipeline: system prompt assembled from independent blocks (`_permissions_block`, `_memory_block`, `_location_block`), each configurable via loom-local `config.yaml`.

## Key Files
- `loom_mcp/chat.py` — Agent SDK bridge with modular context pipeline
- `loom_mcp/web.py` — FastAPI server, bootstrap, WebSocket endpoints
- `loom_mcp/server.py` — 29 MCP tools (stdio transport)
- `loom_mcp/lib/pages.py` — folder-as-page model, ABOUT.md = page content
- `loom_mcp/static/app.js` — frontend (~5200 lines vanilla JS)
- `demo/` — demo loom included in repo
- `TODO.md` — current task list

## Style
- Type hints everywhere. Docstrings on public functions.
- Prefer functions over classes. Composition over inheritance.
- Each MCP tool: structured input → deterministic output.
- No vector search at current scale. Ripgrep + LLM-maintained indexes + `search_by_tags`.

## Development
- `main` branch = stable (real loom runs from this). `dev` = experimental.
- Test against demo loom: `LOOM_PORT=8421 LOOM_ROOT=.../loom/demo uv run --extra web python -m loom_mcp.web`
- 300 tests: `uv run pytest`
