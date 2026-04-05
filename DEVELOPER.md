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
    index.html       Single-page app shell (includes settings dropdown, chat panel)
    style.css        All styles (dark theme, canvas, cards, chat, PDF)
    app.js           All frontend logic (~2100 lines)
    vendor/          Vendored JS libs (marked, d3-zoom, d3-drag, pdf.js, cola.min.js)

  tests/             pytest tests (180 total across 19 files)

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
| `/api/page/{path}` | PUT | Update page content (frontmatter + body) |
| `/api/tree` | GET | Folder tree for sidebar |
| `/api/search?q=&scope=&file_glob=` | GET | Ripgrep search |
| `/api/health` | GET | Health report with scaling alerts |
| `/api/glossary` | GET | Read glossary content |
| `/api/broken-links` | GET | Validate wiki-links, return broken ones |
| `/api/orphans` | GET | Find pages with no inbound links |
| `/api/stale` | GET | Find pages with changed sources |
| `/api/layout` | GET/PUT | Canvas card positions (persisted to JSON) |
| `/api/settings` | GET/PUT | Vault root, Claude auth status |
| `/api/claude-auth` | POST | Trigger Claude CLI OAuth login |
| `/api/chat/save` | POST | Save chat transcript to raw/chats/ |
| `/ws/chat` | WebSocket | Claude Code chat (streaming) |
| `/media/{path}` | GET | Serve files (PDFs, images) from vault |

### Bootstrap

On startup (`lifespan`), `bootstrap_vault()` creates the directory structure if `VAULT_ROOT` is empty:
`raw/{inbox,articles,papers,repos,media}`, `wiki/{concepts,summaries,indexes,answers,meta}`, `outputs/{slides,reports,visualizations}`, plus `page-registry.json` and `glossary.md`.

## Chat Backend

`vault_mcp/chat.py` bridges browser ↔ Claude Code:

1. Browser connects via WebSocket to `/ws/chat`
2. Sends `{type: "init", session_id, page_path}` to start a session
3. Sends `{type: "set_model", model}` to change model mid-session
4. Sends `{type: "message", text, context_level, context}` for each message
5. Sends `{type: "stop"}` to cancel generation
6. Server spawns Claude Code via `claude-agent-sdk` with `ClaudeAgentOptions`
7. Streams events back: `thinking`, `text`, `tool_use`, `tool_result`, `done`

### System Prompt

`build_system_prompt()` constructs a custom system prompt that **enhances** (does not replace) Claude Code's default behavior. It injects vault structure conventions, MCP tool references, and context from the current page/folder/index depending on the context level. Page content is truncated to 8K characters to avoid prompt overflow.

### Context Levels

| Level | What Claude receives |
|-------|---------------------|
| `page` | Current file content (truncated to 8K) + parent folder README |
| `folder` | Current folder README (lists children with summaries) |
| `global` | Full master index from wiki/meta/index.md |

### Session Management

Sessions track `page_path`, `history`, `model`, `sdk_session_id`, and `has_run` state. The SDK session ID enables resume across messages in the same session. Chat transcripts are auto-saved to `raw/chats/` via `navigator.sendBeacon` on page close (unless marked temporary).

## Frontend (Vanilla JS)

`vault_mcp/static/app.js` (~2100 lines) — no framework, no build step. Key modules:

- **Canvas Controller**: d3-zoom on `#infinite-canvas`, CSS transform on `#world`
- **Card Rendering**: `createDocCard()` — folder cards show README, file cards show summary (click to expand)
- **Canvas Stack**: `canvasStack[]` for drill-in navigation with breadcrumb
- **Layout Engine**: WebCoLa constraint-based layout (`cola.min.js`) with non-overlap constraints; falls back to grid if WebCoLa is unavailable
- **Edge Rendering**: SVG paths with rAF debouncing, straight lines at >100 edges
- **Multi-select**: Cmd+click adds/removes cards from `selectedCards` Set; drag moves entire group
- **Chat Panel**: WebSocket connection, streaming markdown, thinking trace, tool use blocks, model selection, Temp/New buttons
- **Selection Tooltip**: `mouseup` listener, shows "Ask Claude" on text selection with context injection
- **PDF Rendering**: Lazy-loaded pdf.js (`pdf.min.mjs` + worker) with text layer for selection
- **Settings Dropdown**: vault root path, Claude auth status/login trigger, code font size slider
- **Auto-save**: chat transcripts saved via `sendBeacon` on `beforeunload` to `/api/chat/save`

### Card Interaction Model

- **Single click body** (collapsed file): expand content (lazy fetch)
- **Double-click body** (expanded): enter edit mode (textarea)
- **Click outside**: save + exit edit mode
- **Double-click title bar**: full-page expand
- **Collapse button (-)**: cycles expanded → summary → hidden → expanded
- **Drag title bar**: reposition card
- **Drag border**: resize card
- **Cmd+click**: toggle multi-select

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd+= / Cmd+- | Zoom in / out |
| Cmd+[ | Navigate back (canvas stack) |
| Cmd+] | Drill into focused/selected folder |
| Enter | Drill into focused/selected folder |
| Escape | Collapse full-page view, or navigate back |
| Cmd+F | Focus search input |

## MCP Server

`vault_mcp/server.py` registers 28 tools for Claude Code. The server uses stdio transport and is registered in `.claude/mcp.json`. All tools are deterministic — no LLM calls from Python.

To test MCP tools:
```bash
uv run python -c "from vault_mcp.server import mcp; print(len(mcp._tool_manager._tools), 'tools')"
```

## Testing

```bash
uv run pytest                    # All 180 tests
uv run pytest vault_mcp/tests/test_pages.py -v  # Just page model
uv run pytest -k "test_chat"     # Just chat tests
```

Key test files (19 total):
- `test_pages.py` (28 tests) — folder-as-page model, walk, link resolution, graph building
- `test_chat.py` (8 tests) — context injection, prompt building
- `test_chat_comprehensive.py` (24 tests) — detailed chat backend coverage
- `test_chat_live.py` (6 tests) — live integration tests
- `test_web.py` (12 tests) — API endpoints
- `test_maintenance.py` (8 tests) — change detection, stale READMEs, transcripts
- `test_subdocs.py` (5 tests) — nesting, parent/child, edge aggregation
- `test_compile.py` (12 tests) — compilation, master index, log
- `test_lint.py` (11 tests) — link validation, orphans, health report
- `test_links.py` (10 tests) — wiki-link parsing
- `test_frontmatter.py` (6 tests) — YAML frontmatter read/write
- `test_ingest.py` (7 tests) — URL/PDF/text ingestion
- `test_image_ingest.py` (5 tests) — image downloading during ingestion
- `test_search.py` (5 tests) — ripgrep wrapper
- `test_write_index.py` (5 tests) — topic index read/write
- `test_index_and_log.py` (9 tests) — index generation and operation log
- `test_registry.py` (9 tests) — legacy page registry
- `test_hashing.py` (5 tests) — SHA-256 content hashing
- `test_git.py` (5 tests) — auto-commit, recent changes

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
