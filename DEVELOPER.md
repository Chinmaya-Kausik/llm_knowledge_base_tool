# Developer Guide

## Project Structure

```
loom_mcp/
  server.py          MCP server entrypoint (stdio transport, 28 tools)
  web.py             FastAPI web server (REST + WebSocket)
  chat.py            Chat backend — WebSocket bridge to Claude Agent SDK
  __main__.py        `python -m loom_mcp` -> MCP server

  lib/
    pages.py         Folder-as-page abstraction (filesystem walk, link resolution)
    frontmatter.py   YAML frontmatter read/write/validate
    hashing.py       SHA-256 content hashing
    links.py         [[wiki-link]] parsing and resolution
    registry.py      Legacy page registry (kept for backward compat)

  tools/
    ingest.py        URL/PDF/text ingestion with image downloading
    compile.py       Compilation support, master index, log, chat transcript saving
    search.py        Ripgrep wrapper, index read/write
    lint.py          Link validation, staleness, orphans, health report, scaling alerts
    git.py           Auto-commit, recent changes

  static/
    index.html       Single-page app shell (settings dropdown, chat panels, terminals)
    style.css        All styles (dark theme, canvas, cards, chat, PDF, terminals)
    app.js           All frontend logic (~5100 lines)
    vendor/          Vendored JS libs (marked, d3-zoom, d3-drag, pdf.js, cola.min.js,
                     CodeMirror 6, xterm.js, KaTeX)

  tests/             pytest tests (293 total across 25 files)

src-tauri/           Tauri native app wrapper
  src/main.rs        Starts Python server sidecar, Tauri commands for settings
  tauri.conf.json    App config (window size, devUrl)
```

## Data Model: Folder as Page

The core abstraction is in `loom_mcp/lib/pages.py`:

- **A folder IS a page.** Its `ABOUT.md` holds the content (LLM-maintained summary).
- **A file IS a subpage** of its parent folder.
- **`walk_pages(loom_root)`** walks the filesystem and returns all pages as a flat list with parent/child relationships.
- **`build_page_graph(loom_root)`** adds edges from `[[wiki-links]]` and returns the full graph with top-level aggregation.
- **ABOUT.md files are hidden** from the page list (they're represented by their parent folder).
- **Hidden patterns** (`.git`, `__pycache__`, `node_modules`) are excluded by default.

### Link Resolution

`resolve_wiki_link(target, pages)` matches against:
1. Page title (from README frontmatter)
2. Folder/file name
3. Case-insensitive matching

### Edge Aggregation

For the top-level canvas view, edges between nested pages are "lifted" to their top-level ancestors. If `wiki/attention/query.py` links to `projects/my-app/src/main.py`, the top-level canvas shows `wiki -> projects`.

## Web Server (FastAPI)

`loom_mcp/web.py` serves:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/graph` | GET | Full page graph (nodes, edges, top_nodes, top_edges) |
| `/api/provenance` | GET | Provenance graph (raw sources -> wiki pages) |
| `/api/registry` | GET | Legacy page registry |
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
| `/api/restart` | POST | Full process restart (re-exec for code changes) |
| `/api/chat/save` | POST | Save chat transcript to raw/chats/ |
| `/api/chat/append` | POST | Append messages to existing transcript |
| `/api/chat/generate-title` | POST | Generate title via Claude for a chat transcript |
| `/api/chat/update-title` | POST | Update heading in a saved transcript file |
| `/api/mkdir` | POST | Create directory (with ABOUT.md) |
| `/api/delete` | POST | Delete file or directory |
| `/api/plan` | GET/PUT/DELETE | Plan file for checklist panel |
| `/api/open-external` | POST | Open file in system default app |
| `/ws/chat` | WebSocket | Claude Code chat (streaming) |
| `/ws/terminal` | WebSocket | PTY terminal session |
| `/media/{path}` | GET | Serve files (PDFs, images) from loom |

### Bootstrap

On startup (`lifespan`), `bootstrap_loom()` creates (if missing):
- Directory structure: `raw/{inbox,articles,papers,repos,media}`, `wiki/{concepts,summaries,indexes,answers,meta,meta/memory}`, `outputs/{slides,reports,visualizations}`
- `page-registry.json` and `glossary.md`
- `.claude/mcp.json` — registers the MCP server so the Agent SDK subprocess can find loom tools
- `.claude/settings.json` — copies hooks (e.g., mdformat after wiki page writes) from the repo
- `CLAUDE.md` — project context loaded natively by the Agent SDK subprocess via `setting_sources=["project"]`. Includes loom structure, conventions pointers, and memory instructions.
- `wiki/meta/conventions.md` — detailed project conventions (editable from the canvas)
- `config.yaml` — loom-local context pipeline configuration (memory caps, page content limits, enable/disable blocks)

## Chat Backend

`loom_mcp/chat.py` bridges browser <-> Claude Code via the Agent SDK:

### Protocol

1. Browser connects via WebSocket to `/ws/chat`
2. Sends `{type: "init", session_id, page_path, permission_mode}` to start a session
3. Sends `{type: "set_model", model}` to change model mid-session
4. Sends `{type: "message", text, context_level, context}` for each user message
5. Sends `{type: "stop"}` to cancel generation
6. Sends `{type: "set_permissions", rules}` to update permission categories
7. Sends `{type: "permission_response", decision}` to respond to permission prompts
8. Server spawns/reuses a `ClaudeSDKClient` with `ClaudeAgentOptions`
9. Streams events back: `thinking`, `text`, `tool_use`, `tool_result`, `result`, `done`

### System Prompt (Modular Context Pipeline)

The Agent SDK subprocess uses Claude Code's preset system prompt with loom-specific context appended:

```python
system_prompt={"type": "preset", "preset": "claude_code", "append": system_prompt},
setting_sources=["project"],  # Loads CLAUDE.md from loom root
```

`build_system_prompt()` assembles the appended text from independent **context blocks**:

- **`_permissions_block(loom_root)`** — safety permissions + responsiveness guidelines. Always injected. Falls back to including full conventions if CLAUDE.md is missing.
- **`_memory_block(loom_root, page_path, config)`** — reads the current project's `MEMORY.md` (or root `MEMORY.md` if not in a project). Injects one-liner index, capped at `config.context.memory.max_chars`.
- **`_location_block(loom_root, page_path, context_level, config)`** — dynamic page/folder/global context (see table below).

Uses `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` to separate cached static content (permissions, memory) from per-request dynamic context. Configuration loaded from loom-local `config.yaml`.

### Context Levels

| Level | What Claude receives |
|-------|---------------------|
| `page` | Current file content (truncated, configurable max) + parent folder README |
| `folder` | Current folder README (lists children with summaries) |
| `global` | Full master index from wiki/meta/index.md |

### Memory System

Memories are individual files in `wiki/meta/memory/`, each with frontmatter including `type: memory` and `tags: [project-name]` (or `[global]`). Timestamped filenames prevent collisions.

Each project folder has a `MEMORY.md` index with one-liners for relevant memories. A root `MEMORY.md` holds global memories. The `_memory_block()` reads the appropriate index and injects it into the system prompt.

- **Single-project memories**: Claude manages autonomously (create, update, remove)
- **Cross-project/global memories**: managed via interactive `/memory` command
- **`/compile`**: read-only on memories — reports staleness, verifies index drift

### Permission System (ClaudeSDKClient `can_use_tool`)

The `_make_permission_handler()` function creates a `can_use_tool` callback for the Claude Agent SDK. Tool names are mapped to categories:

| Category | Tools |
|----------|-------|
| `file_read` | Read, Glob, Grep, WebSearch, WebFetch |
| `file_write` | Write, Edit, NotebookEdit |
| `shell` | Bash |
| `mcp_tools` | Any `mcp__*` tool |
| `destructive_git` | Bash commands containing rm, git push, git reset --hard, etc. |

Each category can be set to:
- **allow** -- tool runs immediately (default)
- **ask** -- sends a `permission_request` to the browser, waits up to 120s for user response
- **deny** -- tool is blocked with a message

Rules are sent from the browser via `{type: "set_permissions", rules: {...}}` and stored in the session. Changing rules disconnects the existing SDK client so the next query picks up the new callback.

### Session Management

Sessions track `page_path`, `history`, `model`, `sdk_client`, `sdk_session_id`, `has_run`, and `permission_rules`. The SDK session ID enables resume across messages in the same session. When the WebSocket disconnects, the SDK client is cleaned up.

## Frontend (Vanilla JS)

`loom_mcp/static/app.js` (~5100 lines) -- no framework, no build step. Key modules:

- **Keybindings**: Rebindable shortcuts stored in localStorage, all actions mapped via `matchesBinding()`
- **Canvas Controller**: d3-zoom on `#infinite-canvas`, CSS transform on `#world`
- **Card Rendering**: `createDocCard()` -- folder cards show README, file cards show summary (click to expand)
- **Canvas Stack**: `canvasStack[]` for drill-in navigation with breadcrumb
- **Layout Engine**: WebCoLa constraint-based layout (`cola.min.js`) with non-overlap constraints; falls back to grid if WebCoLa unavailable
- **Edge Rendering**: SVG paths with rAF debouncing, straight lines at >100 edges
- **Multi-select**: Cmd+click adds/removes cards from `selectedCards` Set; drag moves entire group
- **Chat Panel**: Multiple concurrent panels (floating, dockable, forkable). WebSocket connection, streaming markdown with KaTeX rendering, thinking trace, tool use blocks, model selection, Temp/New buttons. Redirect/checkpoint, message queue, interrupt prompt, fork with context.
- **Activity Summaries**: Displays counts of tool actions ("Read 3 files, Searched 2 patterns")
- **Subagent Display**: Nested tool calls shown inline with collapsible detail
- **Plan Mode**: Interactive checklist panel for agent plans (GET/PUT/DELETE via `/api/plan`)
- **Files View**: Tree/tile toggle with Mac-style folder icons, breadcrumb navigation
- **CodeMirror Editor**: CodeMirror 6 with syntax highlighting (Cmd+E to edit, Cmd+S to save)
- **Terminal Panels**: Embedded xterm.js terminals via PTY WebSocket endpoint (Cmd+` to open)
- **Selection Tooltip**: `mouseup` listener, shows "Ask Claude" on text selection with context injection
- **PDF Rendering**: Lazy-loaded pdf.js (`pdf.min.mjs` + worker) with text layer for selection
- **Search**: Content/name/global toggles with match highlighting in file cards
- **Settings Dropdown**: loom root path, Claude auth status/login trigger, code font size slider
- **Auto-save**: chat transcripts saved via `sendBeacon` on `beforeunload` to `/api/chat/save`

### Card Interaction Model

- **Single click body** (collapsed file): expand content (lazy fetch)
- **Double-click body** (expanded): enter edit mode (textarea)
- **Click outside**: save + exit edit mode
- **Double-click title bar**: full-page expand
- **Collapse button (-)**: cycles expanded -> summary -> hidden -> expanded
- **Drag title bar**: reposition card
- **Drag border**: resize card
- **Cmd+click**: toggle multi-select

### Keyboard Shortcuts

All shortcuts are rebindable via Cmd+K. Bindings are defined in `DEFAULT_KEYBINDINGS` at the top of app.js and persisted to `localStorage['loom-keybindings']`.

| Shortcut | Action |
|----------|--------|
| Cmd+1/2/3/4 | Switch views (canvas, files, tags, health) |
| Cmd+J | Cycle chat focus |
| Cmd+/ | Solo cycle chats |
| Cmd+N | New chat |
| Cmd+Shift+N | Fork chat with context |
| Cmd+T | Toggle tree/tile |
| Cmd+B | Toggle sidebar |
| Cmd+\\ | Toggle chat |
| Cmd+E | Edit current file |
| Cmd+S | Save |
| Cmd+` | New terminal |
| Cmd+K | Show/edit shortcuts |
| Cmd+F | Focus search |
| Cmd+0 | Fit view |
| Cmd+L | Auto layout |
| Cmd+, | Open settings |
| Cmd+O | Toggle tool details |
| Alt+P | Cycle model |
| Cmd+= / Cmd+- | Zoom in / out |
| Cmd+[ | Navigate back (canvas stack) |
| Cmd+] | Drill into focused/selected folder |
| Cmd+Shift+R | Restart server |
| Cmd+Backspace | Delete file |
| Enter | Drill into focused/selected folder |
| Escape | Collapse full-page view, or navigate back |

## MCP Server

`loom_mcp/server.py` registers 28 tools for Claude Code. The server uses stdio transport and is registered in `.claude/mcp.json`. All tools are deterministic -- no LLM calls from Python.

### Tool Categories

**Ingestion** (3 tools): `ingest_url`, `ingest_pdf`, `ingest_text` -- capture web pages, PDFs, and raw text into `raw/inbox/` with image downloading.

**Classification** (1 tool): `classify_inbox_item` -- move a source from inbox to its proper location.

**Reading** (4 tools): `read_source`, `read_wiki_page`, `get_page_registry`, `get_glossary` -- read loom content.

**Compilation** (5 tools): `write_wiki_page`, `mark_source_compiled`, `update_glossary`, `update_master_index`, `append_log` -- write and maintain wiki pages.

**Indexes** (2 tools): `read_index`, `write_index` -- topic-specific index files.

**Linting** (6 tools): `validate_links`, `find_stale_pages`, `find_orphan_pages`, `find_missing_concepts`, `check_terminology`, `generate_health_report` -- quality checks with scaling alerts.

**Search** (1 tool): `ripgrep_search` -- full-text search with scope filtering and file globs.

**Maintenance** (4 tools): `get_changed_sources`, `detect_changes`, `get_stale_readmes`, `save_chat_transcript` -- change tracking and housekeeping.

**Git** (2 tools): `auto_commit`, `get_recent_changes` -- version control.

To inspect registered tools:
```bash
uv run python -c "from loom_mcp.server import mcp; print(len(mcp._tool_manager._tools), 'tools')"
```

## Testing

```bash
uv run pytest                    # All 300 tests
uv run pytest loom_mcp/tests/test_pages.py -v  # Just page model
uv run pytest -k "test_chat"     # Just chat tests
```

Test files (25 total):
- `test_pages.py` -- folder-as-page model, walk, link resolution, graph building
- `test_chat.py` -- context injection, prompt building
- `test_chat_comprehensive.py` -- detailed chat backend coverage
- `test_chat_live.py` -- live integration tests
- `test_chat_save.py` -- chat transcript saving
- `test_web.py` -- API endpoints
- `test_web_comprehensive.py` -- extended web API coverage
- `test_maintenance.py` -- change detection, stale READMEs, transcripts
- `test_subdocs.py` -- nesting, parent/child, edge aggregation
- `test_compile.py` -- compilation, master index, log
- `test_lint.py` -- link validation, orphans, health report
- `test_links.py` -- wiki-link parsing
- `test_frontmatter.py` -- YAML frontmatter read/write
- `test_ingest.py` -- URL/PDF/text ingestion
- `test_image_ingest.py` -- image downloading during ingestion
- `test_search.py` -- ripgrep wrapper
- `test_write_index.py` -- topic index read/write
- `test_index_and_log.py` -- index generation and operation log
- `test_registry.py` -- legacy page registry
- `test_hashing.py` -- SHA-256 content hashing
- `test_git.py` -- auto-commit, recent changes
- `test_plan.py` -- plan file API
- `test_redirect_and_save.py` -- chat redirect and save flows
- `test_functional.py` -- end-to-end functional tests
- `test_recent_changes.py` -- recent changes detection

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

The Tauri app starts the Python server as a sidecar process and opens a native window pointing at `localhost:8420`. Settings (loom root) are persisted to `~/.loom-app-config.json`.

## Adding New Features

### New MCP Tool

1. Write the function in the appropriate `loom_mcp/tools/*.py` file
2. Register it in `loom_mcp/server.py` with `@mcp.tool()` decorator
3. Write tests in `loom_mcp/tests/`
4. If it needs a web API endpoint, add it to `loom_mcp/web.py`
5. Run `uv run pytest` to verify

### New API Endpoint

1. Add the route in `loom_mcp/web.py` with the appropriate decorator (`@app.get`, `@app.post`, etc.)
2. Follow the existing pattern: resolve paths relative to `VAULT_ROOT`, validate path traversal
3. Add tests in `loom_mcp/tests/test_web.py` or `test_web_comprehensive.py`

### New Frontend Feature

1. Add code to `loom_mcp/static/app.js` -- no build step needed
2. For new keyboard shortcuts, add to `DEFAULT_KEYBINDINGS` at the top of app.js
3. For new styles, add to `loom_mcp/static/style.css`
4. For new vendored libraries, add to `loom_mcp/static/vendor/`

### Key Conventions

- Type hints everywhere. Docstrings on public functions.
- Prefer functions over classes. Composition over inheritance.
- Each MCP tool: structured input -> deterministic output. No LLM calls from Python.
- No vector search at current scale. Ripgrep + LLM-maintained indexes + context windows.
- Every wiki page has full YAML frontmatter (see `config.yaml` for required fields).
- Internal links use `[[wiki-style]]` double-bracket syntax.
