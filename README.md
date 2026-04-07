# Loom

An interactive workspace and knowledge base on an infinite canvas. Navigate, edit, compile, and run agents across all your files — with Claude Code as the built-in agent. Local-first, markdown on disk, git-versioned.

<!-- ![Loom screenshot](screenshot.png) -->

## Why

I kept running into the same problem: papers, code, notes, and half-finished ideas scattered across folders, with tools that don't talk to each other. Claude Code is great for working with files, but it's a terminal — you lose spatial context and can't see relationships between things. And file managers, editors, and AI chat are all separate applications with no shared state.

Loom is a single workspace that unifies all of this. Your files live on an infinite canvas where documents are cards you can arrange, connect, and drill into. Claude Code operates inside the UI — multiple chat panels, inline diffs, embedded terminals, and a programmatic permission system — with full read/write access to everything in the loom. A built-in knowledge base pipeline lets you ingest sources, compile them into structured wiki pages, and build up persistent context that every future conversation benefits from.

It started as a knowledge base tool, but it's grown into something closer to a workspace management system: a visual environment for navigating files, editing code, running agents, compiling papers, and accumulating structured knowledge — all in one place.

A demo loom is included in the `demo/` directory.

## Quick Start

```bash
git clone https://github.com/Chinmaya-Kausik/loom.git
cd loom

uv sync --extra web --extra dev

export LOOM_ROOT=~/my-loom   # or omit to use current dir

uv run --extra web python -m loom_mcp.web
# Open http://localhost:8420
```

Or double-click `loom-ui.command` to launch with auto browser open.

### Native App (macOS)

```bash
cargo install tauri-cli
cargo tauri build
ln -sf "$(pwd)/src-tauri/target/release/bundle/macos/Loom.app" /Applications/Loom.app
```

Produces a Tauri v2 binary that starts the Python server as a sidecar.

## How Loom extends Claude Code

Loom builds on top of Claude Code, adding a visual workspace layer and features that complement the CLI:

- **Selective tool call expansion.** Expand any individual tool call to see its details while the rest stay collapsed — and they stay open while the agent keeps working. Edit calls show inline diffs with colored removed/added text. Tool call details are preserved in saved chat transcripts.
- **Browsable chat transcripts.** Every conversation auto-saves to `raw/chats/` as a readable markdown file with collapsible activity blocks. You can browse them in the file explorer, open them, and hit Continue to pick up where you left off — your conversation history is just files in the loom.
- **Fork any conversation.** Branch a chat with full context injected into the new panel. Explore an alternative direction without losing the original thread.
- **Redirect with checkpoints.** Set breakpoints on specific tool calls and intervene at that point with corrective feedback. More granular than Escape — you choose *where* to redirect, and the agent resumes with your instructions as context.
- **Multiple concurrent agents.** Open several chat panels at once — floating, docked, or minimized. Each has its own session. Work on different parts of a project in parallel.
- **Spatial file navigation.** Your files are cards on a canvas with wiki-link edges. Drill into folders, arrange things spatially, see the structure of your project at a glance.
- **Browser-configurable permissions.** Per-category rules (allow/ask/deny) for file read, file write, shell, MCP tools, and destructive operations — configurable from a settings panel and enforced via the Agent SDK's `can_use_tool` callback.
- **Terminals alongside everything else.** Embedded xterm.js terminals in the same window as chat panels, the canvas, and the editor.
- **Knowledge base pipeline.** Ingest URLs and PDFs, compile them into structured wiki pages with cross-links and a master index. The accumulated knowledge becomes persistent context for every future conversation.
- **Selection-to-Claude.** Highlight text in any card or editor to get an "Ask Claude" tooltip that injects the selection as context.

## Features

### Canvas and Views
- Infinite pan/zoom canvas with document cards (d3-zoom, WebCoLa layout)
- Files view with tree/tile toggle, Mac-style folder icons, breadcrumb navigation
- Provenance graph view linking raw sources to wiki pages
- Cards show rendered markdown, syntax-highlighted code, or PDF content
- Drill into folders, expand/collapse/resize/reposition cards, multi-select with Cmd+click
- Edges show `[[wiki-link]]` connections, aggregated at top level
- Filetype filtering (Markdown, Code, Papers, Data, Misc)

### Chat
- Multiple concurrent chat panels — floating, dockable, forkable
- Full Claude Code agent via the Agent SDK (bills to your Max subscription, no API key)
- Context levels: Page, Folder, or Global (master index)
- Streaming responses with collapsible thinking trace and tool use blocks
- Inline diffs for Edit calls, command display for Bash, expandable tool details
- Activity summaries that count unique files ("Edited 1 file, Read 3 files")
- Subagent display with nested tool calls
- Redirect/checkpoint, message queue, interrupt prompt, fork with full context
- Text selection anywhere shows "Ask Claude" with context injection
- Auto-saves transcripts to `raw/chats/` on close
- KaTeX rendering in chat and fullpage views

### Permissions
- Programmatic enforcement via the Agent SDK's `can_use_tool` callback — not just system prompt instructions
- Per-category rules (file read, file write, shell, MCP tools, destructive operations) configurable from the browser
- Three modes: Allow, Ask (interactive prompt with Enter to confirm), Deny
- Destructive command detection (`rm`, `git push --force`, `git reset --hard`) with its own category

### Editing and Terminal
- CodeMirror 6 editor with syntax highlighting (Cmd+E to edit, Cmd+S to save)
- Embedded terminal panels via xterm.js (Cmd+` to open)
- Plan mode — interactive checklist panel for agent plans

### Search
- Content, name, and global search with match highlighting inside files
- Powered by ripgrep (vendored binary auto-detected)

### Knowledge Base Workflows
- `/ingest <url>` — capture a URL or PDF into `raw/`
- `/compile` — incrementally compile changed sources into structured wiki pages
- `/query <question>` — search the wiki and synthesize an answer
- `/lint` — run health checks with scaling trigger monitoring
- `/file-answer` — write the last answer back to the wiki

The compilation pipeline produces wiki pages with full YAML frontmatter, `[[wiki-link]]` cross-references, and a master index. The more you ingest, the better the context gets.

### MCP Server (28 tools)
- **Ingestion**: `ingest_url`, `ingest_pdf`, `ingest_text`, `classify_inbox_item`
- **Reading**: `read_source`, `read_wiki_page`, `get_page_registry`, `get_glossary`
- **Compilation**: `write_wiki_page`, `mark_source_compiled`, `update_glossary`, `update_master_index`, `append_log`
- **Indexes**: `read_index`, `write_index`
- **Linting**: `validate_links`, `find_stale_pages`, `find_orphan_pages`, `find_missing_concepts`, `check_terminology`, `generate_health_report`
- **Search**: `ripgrep_search` with file glob and scope filtering
- **Maintenance**: `get_changed_sources`, `detect_changes`, `get_stale_readmes`, `save_chat_transcript`
- **Git**: `auto_commit`, `get_recent_changes`

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
| Cmd+Shift+R | Restart server (full process restart) |
| Cmd+, | Open settings |
| Escape | Collapse or navigate back |

## Architecture

```
loom/                       <- A loom directory (user content)
  CLAUDE.md                 <- Project context for Claude (auto-created)
  MEMORY.md                 <- Global memory index (user-created)
  config.yaml               <- Loom-local config (context tuning)
  wiki/                     <- LLM-maintained structured knowledge
    meta/
      memory/               <- Cross-project memory files
      conventions.md        <- Editable project conventions
      index.md              <- Master page catalog
      glossary.md           <- Canonical terms
  raw/                      <- Ingested sources + saved chat transcripts
  projects/                 <- Active code repos, experiments
    my-project/
      MEMORY.md             <- Project-specific memory index
  outputs/                  <- Generated artifacts

loom_mcp/                   <- This repo (the tool)
  server.py                 <- 28 MCP tools (stdio transport)
  web.py                    <- FastAPI server + WebSocket endpoints
  chat.py                   <- Claude Agent SDK bridge with modular context pipeline
  lib/                      <- Core: pages, frontmatter, links, hashing
  tools/                    <- Ingest, compile, search, lint, git
  static/
    index.html              <- Single-page app shell
    style.css               <- Dark theme styles
    app.js                  <- Frontend (~5200 lines, vanilla JS)
    vendor/                 <- d3, WebCoLa, marked, pdf.js, CodeMirror 6, xterm.js, KaTeX

demo/                       <- Demo loom (included in repo)
src-tauri/                  <- Tauri v2 native app (optional)
```

**Key design decisions:**
- Every folder is a page (README.md = content). Files are subpages.
- All LLM reasoning routes through Claude Code. Python tooling is strictly deterministic — no API calls from the backend.
- No API key needed. Claude Code uses your Max subscription.
- No build step. ~5200 lines of vanilla JS with vendored libraries.
- The permission system is enforced programmatically via `can_use_tool`, not just via system prompt instructions.
- The chat backend uses Claude Code's preset system prompt with project-specific additions appended, and loads CLAUDE.md natively via `setting_sources=["project"]`.
- The system prompt is assembled from modular, independently configurable context blocks (permissions, memory, page/folder context). Each block can be tuned or disabled via loom-local `config.yaml`.
- Memory files live centrally in `wiki/meta/memory/`, tagged by project. Each project has a MEMORY.md index with one-liners that gets injected at session start. Cross-pollination happens through the wiki, not through memory.

## Tech Stack

- **Backend**: Python 3.12+, FastAPI, Claude Agent SDK, MCP Python SDK
- **Frontend**: Vanilla JS (~5100 lines), CodeMirror 6, xterm.js, d3-zoom, WebCoLa, marked.js, pdf.js, KaTeX
- **Native**: Tauri v2 (Rust)
- **Tools**: uv (package management), ripgrep (search), trafilatura (web extraction), PyMuPDF4LLM (PDF)
- **Tests**: pytest (300 tests across 25 files)

## Configuration

- `LOOM_ROOT` env var, `~/.loom-app-config.json`, or the Settings dropdown in the UI
- `.claude/mcp.json` registers the loom MCP server for Claude Code (auto-created on startup)
- `.claude/settings.json` hooks (e.g., mdformat after wiki page writes) — auto-copied on startup
- `CLAUDE.md` at loom root — project context loaded by the Agent SDK subprocess
- `config.yaml` at loom root — context pipeline tuning (memory caps, page content limits, enable/disable blocks)
- `wiki/meta/conventions.md` — detailed project conventions, editable from the canvas

## Development

See [DEVELOPER.md](DEVELOPER.md) for the full architecture, data model, API endpoints, chat backend internals, and how to add new features.

```bash
uv run pytest                    # All tests
uv run pytest -k "test_chat"     # Subset
```

## License

[Business Source License 1.1](LICENSE) — free for non-commercial use. Converts to Apache 2.0 on 2030-04-06.
