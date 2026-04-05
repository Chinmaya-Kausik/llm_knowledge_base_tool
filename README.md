# Vault — Personal Knowledge Base

A local-first workspace that combines a knowledge wiki, code projects, papers, and an embedded Claude Code chat — all in an infinite canvas UI. Inspired by [Karpathy's LLM wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

## What It Does

- **Everything is a page.** Folders, code files, PDFs, markdown articles — they all appear as cards on an infinite canvas with edges showing connections.
- **LLM-maintained wiki.** Claude writes and maintains summaries (folder READMEs) and a master index. You read; Claude writes.
- **Embedded chat.** A Claude Code chat panel with full agent capabilities — file access, tool use, subagents. Bills to your Max subscription.
- **Cross-project knowledge.** The wiki connects standalone knowledge to active projects. Insights flow between them.
- **No cloud, no vendor lock-in.** All data is plain files on your machine. The vault is a git repo.

## Quick Start

```bash
# Clone
git clone https://github.com/Chinmaya-Kausik/llm_knowledge_base_tool.git
cd llm_knowledge_base_tool

# Install dependencies
uv sync --extra web --extra dev

# Set your vault directory (or omit to use current dir)
export VAULT_ROOT=~/my-vault

# Launch the web UI
uv run --extra web python -m vault_mcp.web
# Open http://localhost:8420
```

Or double-click `vault-ui.command` to launch with auto browser open.

### Native App (macOS)

```bash
# Install Rust (one-time)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Build the app
cargo install tauri-cli
cargo tauri build

# Symlink to Applications (auto-updates on rebuild)
ln -sf "$(pwd)/src-tauri/target/release/bundle/macos/Vault.app" /Applications/Vault.app
```

## Features

### Canvas
- Infinite pan/zoom canvas with document cards
- WebCoLa constraint-based layout (replaces force-directed) with non-overlap constraints
- Cards show rendered markdown, code, or PDF content (pdf.js with text layer for selection)
- Click to expand file content, double-click to edit
- Drag title bar to reposition, drag borders to resize
- Multi-select cards with Cmd+click, drag selected group together
- Drill into folders to see subpages
- Edges show `[[wiki-link]]` connections between pages, aggregated at top level
- Filetype filter (Markdown, Code, Papers, Data, Misc)
- Keyboard shortcuts: Cmd+=/- zoom, Cmd+[/] back/drill, Enter drill, Escape back/collapse, Cmd+F search

### Chat Panel
- Full Claude Code agent via claude-agent-sdk subprocess (your Max subscription)
- Context levels: Page (current file + parent README), Folder (folder README with children), Global (master index)
- Custom system prompt that enhances Claude Code with vault conventions (does not replace its default behavior)
- Streaming responses with thinking trace (collapsible, configurable budget)
- Tool use display (collapsible blocks showing MCP tool calls)
- Text selection in any card → "Ask Claude" floating button with context injection
- Stop generation, highlight partial response, give feedback
- Auto-saves chat transcripts to raw/chats/ on page close (toggle with Temp button)
- Model selection per session

### MCP Server (28 tools)
- Ingestion: `ingest_url`, `ingest_pdf`, `ingest_text` (with image downloading)
- Compilation: `write_wiki_page`, `update_master_index`, `write_index`
- Linting: `validate_links`, `find_stale_pages`, `find_orphan_pages`, health report with scaling alerts
- Search: `ripgrep_search` with file glob and scope filtering
- Maintenance: `detect_changes`, `get_stale_readmes`, `save_chat_transcript`
- Git: `auto_commit`, `get_recent_changes`

### Slash Commands
- `/compile` — incrementally compile changed sources into wiki pages
- `/ingest <url>` — capture a URL into the vault
- `/query <question>` — search and synthesize an answer
- `/lint` — run health checks with scaling trigger monitoring
- `/file-answer` — write the last answer back to the wiki

## Architecture

```
vault/
  wiki/                  ← Standalone knowledge (LLM-maintained)
    attention/
      README.md          ← "Attention Mechanisms" article
  projects/              ← Active work (code, papers)
    my-app/
      README.md          ← Project overview
      src/main.py
  raw/                   ← Ingested sources
    chats/               ← Saved chat transcripts

vault_mcp/               ← MCP server + web UI code
  server.py              ← 28 MCP tools (stdio transport)
  web.py                 ← FastAPI server + WebSocket chat
  chat.py                ← Claude Code subprocess bridge
  lib/pages.py           ← Folder-as-page abstraction
  static/                ← Web UI (vanilla JS, no build step)

src-tauri/               ← Native app wrapper (optional)
```

**Key design**: every folder is a page (README.md = content). Files are subpages. The canvas shows folders as cards with wiki content, files as compact cards expandable on click. Edges connect pages via `[[wiki-links]]`.

## Configuration

- **`VAULT_ROOT`** env var, `~/.vault-app-config.json`, or Settings dropdown in the UI
- **Settings dropdown**: vault root path, Claude auth status/login, code font size slider
- **`.claude/mcp.json`** registers the vault MCP server for Claude Code
- **`config.yaml`** for frontmatter schema and compilation settings
- **Demo vault** at `~/Documents/vault-demo` is created by bootstrap if no vault exists

## Tests

```bash
uv run pytest  # 180 tests across 19 test files
```
