---
title: Loom
type: project
tags: [loom, tools]
---

# Loom

A local-first workspace and knowledge management system. Infinite canvas UI with Claude Code as the built-in agent via the Agent SDK.

## Architecture
- All LLM reasoning routes through Claude Code (Max subscription). Python tooling is a local MCP server providing deterministic, non-LLM tools.
- Agent SDK subprocess uses `preset + append` with `setting_sources=["project"]`.
- Modular context pipeline: `_permissions_block`, `_memory_block`, `_location_block_adaptive`, each configurable via `config.yaml`.
- Split view for TeX compilation (editor + PDF side by side).
- Adaptive context budget: total char limit with priority trimming.

## Key Files
- `loom_mcp/chat.py` — Agent SDK bridge with modular context pipeline
- `loom_mcp/web.py` — FastAPI server, bootstrap, WebSocket endpoints, TeX compilation
- `loom_mcp/server.py` — 29 MCP tools (stdio transport)
- `loom_mcp/lib/pages.py` — folder-as-page model, ABOUT.md = page content, depth-limited walk
- `loom_mcp/static/app.js` — frontend (~5400 lines vanilla JS)

## Style
- Type hints everywhere. Docstrings on public functions.
- Prefer functions over classes. Composition over inheritance.
- ABOUT.md = folder page content. README.md is a GitHub artifact.

## Development — IMPORTANT

**Always develop on the `dev` branch. Never commit directly to `main`.**

1. `git checkout dev` before making ANY changes
2. Develop and test against the demo loom: `LOOM_PORT=8421 LOOM_ROOT=demo uv run --extra web python -m loom_mcp.web`
3. Run tests: `uv run pytest`
4. Commit and push to dev
5. When validated: `git checkout main && git merge dev && git push`
6. The stable server (real loom) runs from `main` — only gets changes after explicit merge

`loom-ui.command` checks out `main`. `loom-dev.command` checks out `dev`. Both can run simultaneously on different ports.

**300 tests. Run them before merging.**
