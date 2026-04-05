# Developer Guide

## Project Structure

```
vault_mcp/
  server.py          MCP server entrypoint (stdio transport, 28 tools)
  web.py             FastAPI web server (REST + WebSocket)
  chat.py            Chat backend — WebSocket bridge to Claude Code subprocess
  __main__.py        `python -m vault_mcp` → MCP server

  lib/
    pages.py         Folder-as-page abstraction (filesystem walk, link resolution)
    frontmatter.py   YAML frontmatter read/write/validate
    hashing.py       SHA-256 content hashing
    links.py         [[wiki-link]] parsing and resolution
    registry.py      Legacy page registry (kept for backward compat)

  tools/
    ingest.py        URL/PDF/text ingestion with image downloading
    compile.py       Compilation support, master index, log, maintenance tools
    search.py        Ripgrep wrapper, index read/write
    lint.py          Link validation, staleness, orphans, health report, scaling alerts
    git.py           Auto-commit, recent changes

  static/
    index.html       Single-page app shell
    style.css        All styles (dark theme, canvas, cards, chat, PDF)
    app.js           All frontend logic (~1000 lines)
    vendor/          Vendored JS libs (marked, d3-zoom, pdf.js)

  tests/             pytest tests (144 total)

src-tauri/           Tauri native app wrapper
  src/main.rs        Starts Python server sidecar, Tauri commands for settings
  tauri.conf.json    App config (window size, devUrl)
```

## Data Model: Folder as Page

The core abstraction is in `vault_mcp/lib/pages.py`:

- **A folder IS a page.** Its `README.md` holds the content (LLM-maintained summary).
- **A file IS a subpage** of its parent folder.
- **`walk_pages(vault_root)`** walks the filesystem and returns all pages as a flat list with parent/child relationships.
- **`build_page_graph(vault_root)`** adds edges from `[[wiki-links]]` and returns the full graph with top-level aggregation.
- **README.md files are hidden** from the page list (they're represented by their parent folder).
- **Hidden patterns** (`.git`, `__pycache__`, `node_modules`) are excluded by default.

### Link Resolution

`resolve_wiki_link(target, pages)` matches against:
1. Page title (from README frontmatter)
2. Folder/file name
3. Case-insensitive matching

### Edge Aggregation

For the top-level canvas view, edges between nested pages are "lifted" to their top-level ancestors. If `wiki/attention/query.py` links to `projects/my-app/src/main.py`, the top-level canvas shows `wiki → projects`.

## Web Server (FastAPI)

`vault_mcp/web.py` serves:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/graph` | GET | Full page graph (nodes, edges, top_nodes, top_edges) |
| `/api/page/{path}` | GET | Single page content + metadata |
| `/api/pages/bulk` | POST | Multiple pages in one request |
| `/api/page/{path}` | PUT | Update page content |
| `/api/tree` | GET | Folder tree for sidebar |
| `/api/search?q=&scope=&file_glob=` | GET | Ripgrep search |
| `/api/health` | GET | Health report with scaling alerts |
| `/api/layout` | GET/PUT | Canvas card positions |
| `/api/settings` | GET/PUT | Vault root configuration |
| `/ws/chat` | WebSocket | Claude Code chat |
| `/media/{path}` | GET | Serve files (PDFs, images) |

### Bootstrap

On startup (`lifespan`), `bootstrap_vault()` creates the directory structure if `VAULT_ROOT` is empty:
`raw/{inbox,articles,papers,repos,media}`, `wiki/{concepts,summaries,indexes,answers,meta}`, `outputs/{slides,reports,visualizations}`, plus `page-registry.json` and `glossary.md`.

## Chat Backend

`vault_mcp/chat.py` bridges browser ↔ Claude Code:

1. Browser connects via WebSocket to `/ws/chat`
2. Sends `{type: "init", session_id, page_path}` to start
3. Sends `{type: "message", text, context_level, context}` for each message
4. Server spawns Claude Code via `claude-agent-sdk` with context injection
5. Streams events back: `thinking`, `text`, `tool_use`, `tool_result`, `done`

### Context Levels

| Level | What Claude receives |
|-------|---------------------|
| `page` | Current file content + parent folder README |
| `folder` | Current folder README (lists children with summaries) |
| `global` | Full master index (all pages with summaries) |

## Frontend (Vanilla JS)

`vault_mcp/static/app.js` — no framework, no build step. Key modules:

- **Canvas Controller**: d3-zoom on `#infinite-canvas`, CSS transform on `#world`
- **Card Rendering**: `createDocCard()` — folder cards show README, file cards show summary (click to expand)
- **Canvas Stack**: `canvasStack[]` for drill-in navigation with breadcrumb
- **Edge Rendering**: SVG paths with rAF debouncing, straight lines at >100 edges
- **Chat Panel**: WebSocket connection, streaming markdown, thinking trace, tool use blocks
- **Selection Tooltip**: `mouseup` listener, shows "Ask Claude" on text selection
- **PDF Rendering**: Lazy-loaded pdf.js with text layer for selection

### Card Interaction Model

- **Single click body** (collapsed file): expand content (lazy fetch)
- **Double-click body** (expanded): enter edit mode (textarea)
- **Click outside**: save + exit edit mode
- **Double-click title bar**: full-page expand
- **Collapse button (-)**: cycles expanded → summary → hidden → expanded
- **Drag title bar**: reposition card
- **Drag border**: resize card

## MCP Server

`vault_mcp/server.py` registers 28 tools for Claude Code. The server uses stdio transport and is registered in `.claude/mcp.json`. All tools are deterministic — no LLM calls from Python.

To test MCP tools:
```bash
uv run python -c "from vault_mcp.server import mcp; print(len(mcp._tool_manager._tools), 'tools')"
```

## Testing

```bash
uv run pytest                    # All 144 tests
uv run pytest vault_mcp/tests/test_pages.py -v  # Just page model
uv run pytest -k "test_chat"     # Just chat tests
```

Key test files:
- `test_pages.py` — folder-as-page model, walk, link resolution, graph
- `test_chat.py` — context injection, prompt building
- `test_web.py` — API endpoints
- `test_maintenance.py` — change detection, stale READMEs, transcripts
- `test_subdocs.py` — nesting, parent/child, edge aggregation

## Scaling Triggers

The health report (`/lint`) monitors these automatically:

| Trigger | Threshold | Action |
|---------|-----------|--------|
| Master index too large | >30K tokens | Add sqlite-vec |
| Ripgrep too slow | >5s per query | Add FTS5 index |
| Too many edges | >200 visible | Edge bundling |
| PDF rendering slow | >50 pages | Pagination |
| Many stale READMEs | >50 per compile | Batch with priority |
| Chat context overflow | >100K tokens | Sliding window |
| Vault too large | >1GB | git-lfs |
| Slow startup | >3s first paint | Pre-cached graph |

## Building the Native App

```bash
# Prerequisites: Rust toolchain
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
cargo install tauri-cli

# Build
cargo tauri build

# Symlink to /Applications (auto-updates on rebuild)
ln -sf "$(pwd)/src-tauri/target/release/bundle/macos/Vault.app" /Applications/Vault.app
```

The Tauri app starts the Python server as a sidecar process and opens a native window pointing at `localhost:8420`. Settings (vault root) are persisted to `~/.vault-app-config.json`.

## Adding New MCP Tools

1. Write the function in the appropriate `vault_mcp/tools/*.py` file
2. Register it in `vault_mcp/server.py` with `@mcp.tool()` decorator
3. Write tests in `vault_mcp/tests/`
4. If it needs a web API endpoint, add it to `vault_mcp/web.py`
5. Run `uv run pytest` to verify
