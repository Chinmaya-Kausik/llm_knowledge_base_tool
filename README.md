# Vault

A local-first personal knowledge base with an infinite canvas UI and embedded Claude Code chat. Markdown files on disk, no cloud sync, no proprietary formats.

<!-- ![Vault screenshot](screenshot.png) -->

## Quick Start

```bash
git clone https://github.com/Chinmaya-Kausik/llm_knowledge_base_tool.git
cd llm_knowledge_base_tool

uv sync --extra web --extra dev

export VAULT_ROOT=~/my-vault   # or omit to use current dir

uv run --extra web python -m vault_mcp.web
# Open http://localhost:8420
```

Or double-click `vault-ui.command` to launch with auto browser open.

### Native App (macOS)

```bash
cargo install tauri-cli
cargo tauri build
ln -sf "$(pwd)/src-tauri/target/release/bundle/macos/Vault.app" /Applications/Vault.app
```

Produces a Tauri v2 binary that starts the Python server as a sidecar.

## Features

### Canvas and Views
- Infinite pan/zoom canvas with document cards (d3-zoom, WebCoLa layout)
- Files view with tree/tile toggle, Mac-style folder icons, breadcrumb navigation
- Provenance graph view (raw sources linked to wiki pages)
- Cards show rendered markdown, code with syntax highlighting, or PDF content
- Drill into folders, expand/collapse/resize/reposition cards, multi-select with Cmd+click
- Edges show `[[wiki-link]]` connections, aggregated at top level
- Filetype filter (Markdown, Code, Papers, Data, Misc)

### Chat
- Multiple concurrent chat panels -- floating, dockable, forkable
- Full Claude Code agent via Claude Agent SDK (bills to your Max subscription)
- Context levels: Page, Folder, or Global (master index)
- Streaming responses with collapsible thinking trace and tool use blocks
- Activity summaries ("Read 3 files, Searched 2 patterns")
- Subagent display with nested tool calls
- Redirect/checkpoint, message queue, interrupt prompt, fork with context
- Text selection in any card shows "Ask Claude" with context injection
- Auto-saves transcripts to `raw/chats/` on page close
- KaTeX LaTeX rendering in chat and fullpage views

### Permissions
- Programmatic permission system via ClaudeSDKClient's `can_use_tool` callback
- Per-category rules (file read, file write, shell, MCP tools, destructive git) set from the browser
- Three modes per category: allow, ask (interactive browser prompt), or deny
- Destructive command detection (rm, force push, hard reset) with separate category

### Editing and Terminal
- CodeMirror 6 editor with syntax highlighting (Cmd+E to edit, Cmd+S to save)
- Embedded terminal panels via xterm.js (Cmd+` to open)
- Plan mode -- interactive checklist panel for agent plans

### Search
- Content, name, and global search toggles with match highlighting in files
- Powered by ripgrep (vendored binary auto-detected)

### MCP Server (28 tools)
- **Ingestion**: `ingest_url`, `ingest_pdf`, `ingest_text`, `classify_inbox_item`
- **Reading**: `read_source`, `read_wiki_page`, `get_page_registry`, `get_glossary`
- **Compilation**: `write_wiki_page`, `mark_source_compiled`, `update_glossary`, `update_master_index`, `append_log`
- **Indexes**: `read_index`, `write_index`
- **Linting**: `validate_links`, `find_stale_pages`, `find_orphan_pages`, `find_missing_concepts`, `check_terminology`, `generate_health_report`
- **Search**: `ripgrep_search` with file glob and scope filtering
- **Maintenance**: `get_changed_sources`, `detect_changes`, `get_stale_readmes`, `save_chat_transcript`
- **Git**: `auto_commit`, `get_recent_changes`

### Slash Commands
- `/compile` -- incrementally compile changed sources into wiki pages
- `/ingest <url>` -- capture a URL into the vault
- `/query <question>` -- search and synthesize an answer
- `/lint` -- run health checks with scaling trigger monitoring
- `/file-answer` -- write the last answer back to the wiki

## Keyboard Shortcuts

All shortcuts are rebindable via Cmd+K.

| Shortcut | Action |
|----------|--------|
| Cmd+1/2/3/4 | Switch views |
| Cmd+J | Cycle chat focus |
| Cmd+/ | Solo cycle chats |
| Cmd+N | New chat |
| Cmd+Shift+N | Fork chat with context |
| Cmd+T | Toggle tree/tile |
| Cmd+B | Toggle sidebar |
| Cmd+E | Edit current file |
| Cmd+S | Save |
| Cmd+` | New terminal |
| Cmd+K | Show/edit shortcuts |
| Cmd+F | Focus search |
| Cmd+=/- | Zoom in/out |
| Cmd+0 | Fit view |
| Cmd+L | Auto layout |
| Cmd+[/] | Navigate back / drill in |
| Cmd+, | Open settings |
| Escape | Collapse or navigate back |

## Architecture

```
vault/
  wiki/                  <- LLM-maintained structured knowledge
  raw/                   <- Ingested sources + saved chat transcripts
  outputs/               <- Generated artifacts

vault_mcp/
  server.py              <- 28 MCP tools (stdio transport)
  web.py                 <- FastAPI server + WebSocket endpoints
  chat.py                <- Claude Agent SDK bridge with permission system
  lib/                   <- Core: pages, frontmatter, links, hashing
  tools/                 <- Ingest, compile, search, lint, git
  static/
    index.html           <- Single-page app shell
    style.css            <- Dark theme styles
    app.js               <- Frontend (~5100 lines, vanilla JS)
    vendor/              <- d3, WebCoLa, marked, pdf.js, CodeMirror 6, xterm.js, KaTeX

src-tauri/               <- Tauri v2 native app (optional)
```

**Key design decisions:**
- Every folder is a page (README.md = content). Files are subpages.
- All LLM reasoning routes through Claude Code. Python tooling is strictly deterministic.
- No API key needed -- Claude Code uses your Max subscription.
- No build step -- vanilla JS with vendored libraries.

## Tech Stack

- **Backend**: Python 3.12+, FastAPI, Claude Agent SDK, MCP Python SDK
- **Frontend**: Vanilla JS (~5100 lines), CodeMirror 6, xterm.js, d3-zoom, WebCoLa, marked.js, pdf.js, KaTeX
- **Native**: Tauri v2 (Rust)
- **Tools**: uv (package management), ripgrep (search), trafilatura (web extraction), PyMuPDF4LLM (PDF)
- **Tests**: pytest (293 tests across 25 files)

## Configuration

- `VAULT_ROOT` env var, `~/.vault-app-config.json`, or Settings dropdown in the UI
- `.claude/mcp.json` registers the vault MCP server for Claude Code (auto-created on startup)
- `config.yaml` for frontmatter schema and compilation settings

## Development

See [DEVELOPER.md](DEVELOPER.md) for detailed architecture, data model, API endpoints, chat backend internals, and contribution guidelines.

```bash
uv run pytest                    # All tests
uv run pytest -k "test_chat"     # Subset
```

## License

[Business Source License 1.1](LICENSE) -- free for non-commercial use. Converts to Apache 2.0 on 2030-04-06.
