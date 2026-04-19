---
title: Loom
type: project
tags: [loom, tools, workspace]
---

# Loom

A local-first workspace and knowledge management system on an infinite canvas. Agent-agnostic — works with Claude Code, OpenAI Codex, or any CLI coding agent. VM integration for remote compute. Markdown on disk, git-versioned.

## Architecture
- **Agent-agnostic**: adapter layer in `loom_mcp/agents/` supports Claude Code (Agent SDK), Codex (CLI), and generic CLI agents. Switch per chat panel.
- LLM reasoning happens in the agent. Python tooling is a local MCP server (39 tools) providing deterministic, non-LLM tools.
- **VM integration**: persistent SSH connections (asyncssh) in `loom_mcp/vm/`. Target dropdown switches Canvas/Files/Search between local and remote. MCP tools mirror built-in tools for remote execution.
- Modular context pipeline: `_permissions_block`, `_memory_block`, `_location_block_adaptive`, each configurable via `config.yaml`.
- **Remote access**: `LOOM_REMOTE=1` enables token-based auth, binds to 0.0.0.0, CORS.

## Key Files
- `loom_mcp/agents/` — Agent adapter layer (AgentAdapter base, Claude Code, Codex, Generic CLI)
- `loom_mcp/vm/` — VM integration (SSH pool, sync, metrics, jobs, port forwarding)
- `loom_mcp/notify.py` — Ntfy push notifications (agent done, job done, sync complete)
- `loom_mcp/sync_daemon.py` — Laptop↔VM bidirectional sync daemon (rsync, wake detection)
- `loom_mcp/chat.py` — Agent-agnostic chat bridge with modular context pipeline
- `loom_mcp/web.py` — FastAPI server, auth middleware, 15+ VM endpoints, ntfy settings, WebSocket routes
- `loom_mcp/server.py` — 39 MCP tools (stdio transport, including 9 VM tools)
- `loom_mcp/lib/pages.py` — folder-as-page model, visibility toggles (dotfiles, build artifacts, internals)
- `loom_mcp/static/app.js` — frontend (~7500 lines vanilla JS, endpoint switcher, PWA)

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

**330+ tests. Run them before merging.**
